// Agent « Superviseur » — « every client gets an answer »: the pure rules
// (tested in reponses.test.ts). Input = headers of every message of the four
// factory mailboxes (boites.ts collecterEntetes), no body.
//
// A CONVERSATION is keyed by its root Message-ID (first References entry, else
// In-Reply-To, else its own id), so a client writing to contact@ and Laetitia
// answering from l.tellier@ is ONE conversation even though Gmail gives each
// mailbox its own threadId. A conversation waits for us when its last message
// comes from a client and nothing internal followed — neither in the same
// conversation, nor any later internal mail addressed to that client (a reply
// written as a new mail).

import type { EnteteMessage } from './boites.js'

/** Mail from these domains is ours. */
export const DOMAINES_INTERNES: readonly string[] = ['etsmalterre.com', 'etsmalterre.fr', 'tricotage-malterre.fr', 'tricotagemalterre.fr']

/** Webmail domains never identify a company: only an exact contact address does. */
export const DOMAINES_GENERIQUES: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.fr', 'yahoo.com', 'hotmail.fr', 'hotmail.com', 'outlook.fr', 'outlook.com',
  'live.fr', 'live.com', 'msn.com', 'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'neuf.fr', 'laposte.net',
  'icloud.com', 'me.com', 'aol.com', 'gmx.fr', 'gmx.com', 'bbox.fr', 'numericable.fr', 'protonmail.com', 'proton.me',
])

export const domaine = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase()
export const estInterne = (email: string) => DOMAINES_INTERNES.includes(domaine(email))
const estNoReply = (email: string) => /^(no-?reply|ne-?pas-?repondre|donotreply|mailer-daemon|postmaster|notification)/i.test(email)

export interface ClientConnu {
  idClient: number
  nom: string
}

/** Contact addresses of clients → who writes. */
export interface AnnuaireClients {
  parEmail: Map<string, ClientConnu>
  /** Company domain → client, only when a single client uses it. */
  parDomaine: Map<string, ClientConnu>
  /** Supplier / sub-contractor addresses and company domains: never a client,
   *  even when the same company also sits in the client table (the dyers MATEL
   *  and FRANCE TEINTURE, the carrier SCHENKER — measured 2026-09-23). */
  exclus: Set<string>
}

const adressesValides = (v: string) => v.toLowerCase().split(/[;,\s]+/).filter((x) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(x))

export function construireAnnuaire(
  contacts: Array<{ mail: string; idClient: number; nomClient: string }>,
  fournisseurs: string[] = [],
): AnnuaireClients {
  const exclus = new Set<string>()
  for (const f of fournisseurs) {
    for (const mail of adressesValides(f)) {
      exclus.add(mail)
      if (!DOMAINES_GENERIQUES.has(domaine(mail))) exclus.add(domaine(mail))
    }
  }
  const parEmail = new Map<string, ClientConnu>()
  const domaines = new Map<string, Map<number, ClientConnu>>()
  for (const c of contacts) {
    for (const mail of adressesValides(c.mail)) {
      const cl = { idClient: c.idClient, nom: c.nomClient }
      if (!parEmail.has(mail)) parEmail.set(mail, cl)
      const d = domaine(mail)
      if (DOMAINES_GENERIQUES.has(d) || DOMAINES_INTERNES.includes(d)) continue
      if (!domaines.has(d)) domaines.set(d, new Map())
      domaines.get(d)!.set(c.idClient, cl)
    }
  }
  const parDomaine = new Map<string, ClientConnu>()
  for (const [d, m] of domaines) if (m.size === 1) parDomaine.set(d, [...m.values()][0])
  return { parEmail, parDomaine, exclus }
}

export function identifierClient(email: string, annuaire: AnnuaireClients): ClientConnu | null {
  if (annuaire.exclus.has(email) || annuaire.exclus.has(domaine(email))) return null
  return annuaire.parEmail.get(email) ?? annuaire.parDomaine.get(domaine(email)) ?? null
}

/** Hours between two instants that fall on Monday–Friday (Paris wall clock
 *  is close enough: a weekend is what must not count). */
export function heuresOuvrees(debutMs: number, finMs: number): number {
  if (finMs <= debutMs) return 0
  let h = 0
  const pas = 3_600_000
  for (let t = debutMs; t < finMs; t += pas) {
    const j = new Date(t).getUTCDay()
    if (j !== 0 && j !== 6) h += Math.min(pas, finMs - t) / pas
  }
  return h
}

export const racine = (m: EnteteMessage) => m.references[0] || m.inReplyTo || m.messageId || `${m.boite}:${m.threadId}`

export interface ConversationEnAttente {
  cle: string
  client: ClientConnu
  /** The client's last message (the one waiting). */
  dernier: EnteteMessage
  /** Mailboxes that received it. */
  boites: string[]
  heuresAttente: number
  /** Every address seen on the conversation (senders, To, Cc), lowercased. */
  participants: string[]
}

/** « le 24/09 à 14h05 » (Paris). */
export function leA(ms: number): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  )
  return `le ${p.day}/${p.month} à ${p.hour}h${p.minute}`
}
const qui = (m: EnteteMessage) => m.de.split('@')[0] || m.boite.split('@')[0]

/** Conversations whose last word is a client's and that nobody answered.
 *  `depuisMs`: older client messages are stale and ignored. `raison` hears why
 *  every other conversation is not waiting (an answer, a stale message…) —
 *  what the report says when a « sans réponse » point closes. */
export function conversationsSansReponse(
  msgs: EnteteMessage[],
  annuaire: AnnuaireClients,
  nowMs: number,
  depuisMs: number,
  raison: (cle: string, texte: string) => void = () => {},
): ConversationEnAttente[] {
  // One copy per Message-ID (a mail sent to contact@ and cc Laetitia arrives twice).
  const parId = new Map<string, EnteteMessage & { boites: string[] }>()
  for (const m of msgs) {
    const k = m.messageId || `${m.boite}:${m.id}`
    const d = parId.get(k)
    if (d) { if (!d.boites.includes(m.boite)) d.boites.push(m.boite) } else parId.set(k, { ...m, boites: [m.boite] })
  }
  const uniques = [...parId.values()]
  const interne = (m: EnteteMessage) => m.envoye || estInterne(m.de)
  // Gmail threads glue conversations whose headers lost their References.
  const racineDeFil = new Map<string, string>()
  for (const m of uniques) {
    const k = `${m.boite}:${m.threadId}`
    if (!racineDeFil.has(k)) racineDeFil.set(k, racine(m))
  }
  const conv = new Map<string, Array<EnteteMessage & { boites: string[] }>>()
  for (const m of uniques) {
    const r = m.references[0] || m.inReplyTo ? racine(m) : racineDeFil.get(`${m.boite}:${m.threadId}`) ?? racine(m)
    if (!conv.has(r)) conv.set(r, [])
    conv.get(r)!.push(m)
  }
  const internes = uniques.filter(interne)
  const out: ConversationEnAttente[] = []
  for (const [cle, ms] of conv) {
    ms.sort((a, b) => a.date - b.date)
    const dernier = ms[ms.length - 1]
    if (interne(dernier)) { raison(cle, `Réponse de ${qui(dernier)} ${leA(dernier.date)}.`); continue }
    if (dernier.automatique || estNoReply(dernier.de)) { raison(cle, `Dernier message automatique (${dernier.de}) ${leA(dernier.date)}.`); continue }
    if (dernier.date < depuisMs) { raison(cle, `Dernier message du client ${leA(dernier.date)} : plus vieux que la fenêtre surveillée.`); continue }
    const client = identifierClient(dernier.de, annuaire)
    if (!client) { raison(cle, `Dernier message de ${dernier.de} ${leA(dernier.date)}, qui n’est pas un contact client.`); continue }
    // Answered by a new mail to the same person (not a reply in the thread)?
    const reponse = internes.find((x) => x.date > dernier.date && (x.a.includes(dernier.de) || x.cc.includes(dernier.de)))
    if (reponse) { raison(cle, `Réponse de ${qui(reponse)} par un nouveau mail ${leA(reponse.date)} (« ${reponse.sujet || 'sans objet'} »).`); continue }
    const participants = [...new Set(ms.flatMap((x) => [x.de, ...x.a, ...x.cc]).map((x) => x.toLowerCase()).filter(Boolean))]
    out.push({ cle, client, dernier, boites: dernier.boites, heuresAttente: heuresOuvrees(dernier.date, nowMs), participants })
  }
  return out.sort((a, b) => b.heuresAttente - a.heuresAttente)
}
