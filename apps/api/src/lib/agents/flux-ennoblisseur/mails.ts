// « Flux Ennoblisseur », the level above its skills (Vincent 2026-11-11): the
// mails the agent received and where each one went. The agent itself reads
// nothing: it recognises the dyer and hands the mail to its skills by rule (the
// PDFs to the BL). A mail can feed a skill, or none: this is the one place that
// shows it.
//
// The agents shown in its group (catalog.ts `groupe`: « Factures », 2026-11-11) read the
// same mailbox on their own: the Triage, or their own poll, hands them their mails. Their
// runs are listed here too, one column each, so a dyer's mail is found in one place
// whichever agent had it.
//
// Pure: read from the stored runs, nothing else.

import type { AgentRun, RunStatut } from '../store.js'
import { competenceDuRun, SANS_COMPETENCE } from './competences-flux.js'

/** One run a mail gave to a skill. */
export interface RunDuMail {
  id: string
  statut: RunStatut
  /** What it read, in a few words: « BL 109547A ». */
  titre: string
  le: string
  /** The agent the run belongs to, when it is not the flux itself (an agent of its group). */
  agent?: string
}

/** An agent shown in the flux's group: its runs are a column of the mails list, keyed by its slug. */
export interface MembreFlux {
  slug: string
  runs: readonly AgentRun[]
  /** What one of its runs read, in a few words. */
  titre(r: AgentRun): string
}

export interface MailFlux {
  messageId: string
  date: string
  de: string
  sujet: string
  /** Its runs, by skill (a skill it gave nothing to is absent). */
  runs: Record<string, RunDuMail[]>
  /** Why it went to no skill (« Aucun PDF à lire… »); null when it went to one. */
  sansSuite: string | null
}

/** What a BL run read, as the mails list prints it. */
export function titreDuRun(r: AgentRun): string {
  const res = r.resultat as { typeDocument?: string | null; extraction?: { numero_bordereau?: string; numero_of?: string } }
  if (r.statut === 'ignore') return 'Pas un BL'
  if (res.typeDocument === 'mise_a_dispo') return `Mise à dispo${res.extraction?.numero_of ? ` OF ${res.extraction.numero_of}` : ''}`
  return res.extraction?.numero_bordereau ? `BL ${res.extraction.numero_bordereau}` : 'BL illisible'
}

/** Why a mail went to no skill, from the run that says so. The summary repeats the subject
 *  (« Aucun PDF à lire dans « … » »): the list already shows it. Until 2026-11-27 a reply to
 *  our Point was held by the skills Délais and Contrôles (removed since) and its run says
 *  so: it had no PDF to read either. */
const raisonSansSuite = (r: AgentRun): string =>
  Array.isArray((r.resultat as { enAttente?: unknown }).enAttente) || /en observation : lu une fois/.test(r.resume)
    ? 'Aucun PDF à lire'
    : r.resume.replace(/ (dans|à) « .* »$/, '')

/** The mails of the agent, newest first, each with the runs it gave per skill. A run read
 *  again (« Retraiter ») is replaced by its re-run. `cles`: the agent's skills. `membres`:
 *  the agents of its group, each one more column (its slug is the key). */
export function mailsDuFlux(runs: readonly AgentRun[], cles: readonly string[], membres: readonly MembreFlux[] = []): MailFlux[] {
  const membreDe = new Map(membres.map((m) => [m.slug, m]))
  const tous = [...runs, ...membres.flatMap((m) => m.runs)]
  const retraites = new Set(tous.map((r) => r.retraiteDe).filter((x): x is string => !!x))
  const parMail = new Map<string, AgentRun[]>()
  for (const r of tous) {
    if (!r.message?.id || retraites.has(r.id)) continue
    const xs = parMail.get(r.message.id)
    if (xs) xs.push(r)
    else parMail.set(r.message.id, [r])
  }
  // The column of a run: its skill, or its agent for a run of the group. A mail no file was
  // read from went nowhere, whoever looked at it.
  const colonneDe = (r: AgentRun) => {
    if (!membreDe.has(r.slug)) return competenceDuRun(r)
    return r.statut === 'ignore' && r.fichiers.length === 0 ? SANS_COMPETENCE : r.slug
  }
  const colonnes = [...cles, ...membreDe.keys()]
  const mails: MailFlux[] = []
  for (const [messageId, xs] of parMail) {
    const tries = [...xs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const m = tries[0].message!
    const parCle: Record<string, RunDuMail[]> = {}
    for (const r of tries) {
      const cle = colonneDe(r)
      if (!colonnes.includes(cle)) continue
      const membre = membreDe.get(r.slug)
      ;(parCle[cle] ??= []).push({
        id: r.id, statut: r.statut, titre: membre ? membre.titre(r) : titreDuRun(r), le: r.createdAt,
        ...(membre ? { agent: r.slug } : {}),
      })
    }
    const sans = tries.filter((r) => colonneDe(r) === SANS_COMPETENCE)
    const aucunRun = Object.keys(parCle).length === 0
    mails.push({
      messageId, date: m.date, de: m.de, sujet: m.sujet, runs: parCle,
      sansSuite: aucunRun && sans.length ? raisonSansSuite(sans[sans.length - 1]) : null,
    })
  }
  return mails.sort((a, b) => b.date.localeCompare(a.date))
}
