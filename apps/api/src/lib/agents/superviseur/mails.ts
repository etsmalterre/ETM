// Agent « Superviseur » — the mail side: who wrote, who answered, and Mistral
// triage of the conversations that wait for us.
//
// Cost control: headers first (boites.ts, no body), the code decides which
// conversations wait for us (reponses.ts), and ONLY those reach Mistral — once
// per message and prompt version (cache data/agents/superviseur-mails.json),
// so a conversation waiting three evenings is triaged once.
//
// Privacy: the run stores Mistral's one-line summary, never the mail body.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { query } from '../../hfsql-auto.js'
import { chatJson } from '../../mistral.js'
import { AGENTS_DIR } from '../store.js'
import { collecterEntetes, lireFil, type EnteteMessage } from './boites.js'
import { construireAnnuaire, type AnnuaireClients } from './reponses.js'
import { noms } from './controles/noms.js'
import { SUPERVISEUR_BOITES } from './boites-liste.js'
import type { TypeDocument } from './verifications-etm.js'

// ── Address book (clients vs suppliers) ──────────────────

const normNom = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()

/** A client whose name is a carrier's (client #346 « SCHENKER » vs carrier
 *  « DB SCHENKER Internationale Lille ») is a carrier: its invoice disputes are
 *  not clients waiting for an answer (replay 2026-09-23: 7 of 106 alerts). */
export function estNomTransporteur(nomClient: string, transporteurs: string[]): boolean {
  const c = normNom(nomClient)
  if (c.length < 4) return false
  return transporteurs.some((t) => {
    const n = normNom(t)
    return n.length >= 4 && (n === c || ` ${n} `.includes(` ${c} `) || ` ${c} `.includes(` ${n} `))
  })
}

export async function chargerAnnuaire(): Promise<AnnuaireClients> {
  const [contacts, internes, transporteurs] = await Promise.all([
    query<{ mail: string | null; IDclient: number | null; IDfournisseur: number | null; IDsous_traitant: number | null }>(
      `SELECT mail, IDclient, IDfournisseur, IDsous_traitant FROM contact WHERE mail <> ''`,
    ),
    // client_interne: the group's own companies (Tricotage Malterre, Malterre Confection…).
    query<{ IDclient: number }>(`SELECT IDclient FROM client WHERE client_interne = 1`),
    query<{ IDtransporteur: number; mail: string | null }>(`SELECT IDtransporteur, mail FROM transporteur`),
  ])
  const nomsTransporteurs = [...(await noms('transporteur', transporteurs.map((t) => Number(t.IDtransporteur)))).values()]
    .filter((n) => !/definir|divers/i.test(normNom(n)))
  const exclusClients = new Set(internes.map((c) => Number(c.IDclient)))
  const cl0 = contacts.filter((c) => Number(c.IDclient) > 0 && !exclusClients.has(Number(c.IDclient)))
  const nomsClients = await noms('client', cl0.map((c) => Number(c.IDclient)))
  const cl = cl0.filter((c) => !estNomTransporteur(nomsClients.get(Number(c.IDclient)) ?? '', nomsTransporteurs))
  return construireAnnuaire(
    cl.map((c) => ({ mail: String(c.mail ?? ''), idClient: Number(c.IDclient), nomClient: nomsClients.get(Number(c.IDclient)) || `Client #${c.IDclient}` })),
    [
      ...contacts.filter((c) => Number(c.IDfournisseur) > 0 || Number(c.IDsous_traitant) > 0).map((c) => String(c.mail ?? '')),
      ...transporteurs.map((t) => String(t.mail ?? '')),
    ],
  )
}

// ── Headers of the four mailboxes, once per run ──────────

/** Conversations whose last client message is older than this are stale. */
export const FENETRE_JOURS = 14

let memo: { nowMs: number; entetes: Promise<{ entetes: EnteteMessage[]; erreurs: string[] }> } | null = null

/** Every mailbox since the window start (+1 day of margin for the replies'
 *  context). A mailbox that fails is reported, the others still count. */
export function entetesDuRun(nowMs: number): Promise<{ entetes: EnteteMessage[]; erreurs: string[] }> {
  if (!memo || memo.nowMs !== nowMs) {
    memo = {
      nowMs,
      entetes: (async () => {
        const depuis = nowMs - (FENETRE_JOURS + 1) * 86_400_000
        const entetes: EnteteMessage[] = []
        const erreurs: string[] = []
        for (const b of SUPERVISEUR_BOITES) {
          try {
            entetes.push(...(await collecterEntetes(b, depuis)))
          } catch (err) {
            erreurs.push(`${b} : ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return { entetes, erreurs }
      })(),
    }
  }
  return memo.entetes
}

// ── Conversation text for Mistral ────────────────────────

/** Drop the quoted history a reply carries (it is in the earlier messages). */
export function sansCitation(texte: string): string {
  const lignes = texte.split(/\r?\n/)
  const out: string[] = []
  for (const l of lignes) {
    if (/^\s*(Le .{3,120} a écrit\s*:|On .{3,120} wrote\s*:|-{2,}\s*(Original|Message d'origine|Forwarded)|De\s*:\s|From\s*:\s|_{8,})/i.test(l)) break
    if (/^\s*>/.test(l)) continue
    out.push(l)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** `jusquaMs`: only the messages that existed then (replay of a past evening). */
export async function texteConversation(boite: string, threadId: string, maxMessages = 6, maxParMessage = 1500, jusquaMs = Infinity): Promise<string> {
  const msgs = (await lireFil(boite, threadId, 20_000)).filter((m) => Date.parse(m.date) <= jusquaMs).slice(-maxMessages)
  return msgs
    .map((m) => {
      const corps = sansCitation(m.texte)
      const pj = m.piecesJointes.length ? `\nPièces jointes : ${m.piecesJointes.map((p) => p.nom).join(', ')}` : ''
      return `--- ${m.envoye ? 'NOUS (ETS Malterre)' : 'EXTÉRIEUR'} · ${m.date.slice(0, 16).replace('T', ' ')} · De : ${m.de}\nObjet : ${m.sujet}\n${corps.length > maxParMessage ? `${corps.slice(0, maxParMessage)}…` : corps}${pj}`
    })
    .join('\n\n')
}

// ── Triage ───────────────────────────────────────────────

// Property order = generation order: the model writes its summary and the
// action it sees BEFORE the yes/no verdict, so the verdict follows its own
// reading (first draft asked the verdict first and contradicted its summary
// on 1 of 7 real conversations, 2026-09-23).
export const TRI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    client: { type: 'string' },
    numeros_cites: { type: 'array', items: { type: 'string' } },
    resume: { type: 'string' },
    // v2 (2026-09-25): what ETM can confirm is already done — an address
    // entered, a document emailed (verifications-etm.ts). Empty when absent.
    changement_adresse: {
      type: 'object',
      additionalProperties: false,
      properties: { cp: { type: 'string' }, ville: { type: 'string' } },
      required: ['cp', 'ville'],
    },
    documents_demandes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['facture', 'avoir', 'proforma', 'confirmation', 'bl', 'devis', 'autre'] },
          numero: { type: 'string' },
        },
        required: ['type', 'numero'],
      },
    },
    categorie: { type: 'string', enum: ['commande', 'devis', 'reclamation', 'suivi', 'facture', 'technique', 'autre', 'bruit'] },
    action_attendue: { type: 'string' },
    urgence: { type: 'string', enum: ['basse', 'normale', 'haute'] },
    attend_reponse: { type: 'boolean' },
  },
  required: ['client', 'numeros_cites', 'resume', 'changement_adresse', 'documents_demandes', 'categorie', 'action_attendue', 'urgence', 'attend_reponse'],
} as const

/** Does this conversation call for an answer from us? The model's verdict —
 *  NOT « any action named »: it names trivial ones (« archiver la réponse »)
 *  and that turned a thanked, answered question into an alarm (2026-09-23). */
export function appelleReponse(t: Tri): boolean {
  // « technique » (machines, spare parts, maintenance) is the workshop's
  // business, never the office's (v2 — the JVC4 cams thread, 2026-09-24).
  return t.categorie !== 'bruit' && t.categorie !== 'technique' && t.attend_reponse
}

export interface Tri {
  categorie: 'commande' | 'devis' | 'reclamation' | 'suivi' | 'facture' | 'technique' | 'autre' | 'bruit'
  attend_reponse: boolean
  urgence: 'basse' | 'normale' | 'haute'
  client: string
  numeros_cites: string[]
  resume: string
  action_attendue: string
  /** v2 — absent on triages cached by v1. */
  changement_adresse?: { cp: string; ville: string }
  documents_demandes?: Array<{ type: TypeDocument; numero: string }>
}

const CACHE = path.join(AGENTS_DIR, 'superviseur-mails.json')
interface EntreeCache { le: string; version: number; model: string; tri: Tri; usd: number }

async function lireCache(): Promise<Record<string, EntreeCache>> {
  try {
    return JSON.parse(await fs.readFile(CACHE, 'utf8')) as Record<string, EntreeCache>
  } catch {
    return {}
  }
}

async function ecrireCache(c: Record<string, EntreeCache>, nowMs: number): Promise<void> {
  // Keep two windows' worth: older conversations are never looked at again.
  const limite = nowMs - 2 * FENETRE_JOURS * 86_400_000
  for (const [k, v] of Object.entries(c)) if (Date.parse(v.le) < limite) delete c[k]
  await fs.mkdir(path.dirname(CACHE), { recursive: true })
  const tmp = `${CACHE}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(c), 'utf8')
  await fs.rename(tmp, CACHE)
}

/** Triage every message of `aTrier` not yet triaged with this version. */
export async function trier(
  aTrier: Array<{ cle: string; boite: string; threadId: string }>,
  version: { version: number; model: string; prompt: string },
  nowMs: number,
  cout: (usd: number) => void,
): Promise<Map<string, Tri | { erreur: string }>> {
  const cache = await lireCache()
  const out = new Map<string, Tri | { erreur: string }>()
  let modifie = false
  for (const t of aTrier) {
    const k = `${t.cle}@v${version.version}`
    const c = cache[k]
    if (c) { out.set(t.cle, c.tri); continue }
    try {
      const texte = await texteConversation(t.boite, t.threadId, 6, 1500, nowMs)
      const r = await chatJson({ model: version.model, system: version.prompt, user: texte, schemaName: 'tri_mail', schema: TRI_SCHEMA })
      cout(r.usd)
      const tri = r.data as Tri
      cache[k] = { le: new Date(nowMs).toISOString(), version: version.version, model: version.model, tri, usd: r.usd }
      modifie = true
      out.set(t.cle, tri)
    } catch (err) {
      out.set(t.cle, { erreur: err instanceof Error ? err.message : String(err) })
    }
  }
  if (modifie) await ecrireCache(cache, nowMs)
  return out
}
