// Who reads contact@ for the agents behind the Triage (BL Ennoblisseur,
// Factures Ennoblisseur) — decision Vincent 2026-10-07, replacing their
// per-agent switch « Mails transmis par le Triage »: one fact, never set twice.
//
//   - Triage « actif » and healthy → the agents only process what it hands
//     them (transmission.ts), their own poll reads nothing;
//   - Triage « off » or « essai » (it hands nothing over in essai) → the
//     agents read the mailbox themselves, as before the Triage;
//   - Triage « actif » but failing → the same fallback, until it recovers:
//     no successful poll for SILENCE_MAX_MS (Gmail down, a poll stuck under
//     its lock), or its last ECHECS_MAX triages all failed (Mistral down).
//
// Reading the same mail twice is harmless: an agent never processes a message
// it has a run for, and the Triage's hand-off then says « déjà traité ». An
// agent's own poll also skips every mail the Triage sorted while « actif »
// (triesParTriage) — those were handed over, or deliberately not (a dyer's
// mail that is no BL) — so the fallback only picks up what the Triage missed.
//
// Imports the store only (no catalog / scheduler / triage agent: the BL and
// invoice agents import this module, and the catalog imports them).

import { lireEtat, lireRuns, type AgentMode, type AgentRun } from '../store.js'
import { TRIAGE_SLUG } from './constantes.js'

/** No successful Triage poll for this long → the agents read the mailbox themselves. */
export const SILENCE_MAX_MS = 15 * 60_000
/** This many failed triages in a row → same. */
export const ECHECS_MAX = 3

/** Only used if the Triage has no state yet (then it is « off »). */
const ETAT_INITIAL = { model: '', prompt: '', note: '' }

/** Process start: a fresh API counts as « heard from the Triage » until its first poll. */
const demarrage = Date.now()
let dernierReleveReussi: number | null = null

/** Called by the Triage at the end of every poll that went through. */
export function noterReleveTriage(now = Date.now()): void {
  dernierReleveReussi = now
}

export type SourceMails = 'triage' | 'boite' | 'secours'

export interface Relais {
  /** triage = handed by the Triage; boite = the agent reads the mailbox (Triage
   *  not in service); secours = it does too, because the Triage is failing. */
  source: SourceMails
  /** For the screen, in French. */
  raison: string
}

const heure = (ms: number) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })

/** Pure (tests). `runs` = the Triage's runs, in any order. */
export function evaluerRelais(e: {
  mode: AgentMode
  dernierReleve: number
  runs: ReadonlyArray<Pick<AgentRun, 'statut' | 'createdAt' | 'message'>>
  now: number
}): Relais {
  if (e.mode === 'off') return { source: 'boite', raison: 'Le Triage est à l’arrêt : l’agent relève la boîte lui-même.' }
  if (e.mode === 'essai') return { source: 'boite', raison: 'Le Triage est en essai (il ne transmet rien) : l’agent relève la boîte lui-même.' }
  if (e.now - e.dernierReleve > SILENCE_MAX_MS) {
    return { source: 'secours', raison: `Le Triage n’a pas relevé la boîte depuis ${heure(e.dernierReleve)} : l’agent la relève lui-même en attendant.` }
  }
  const derniers = e.runs
    .filter((r) => r.message?.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, ECHECS_MAX)
  if (derniers.length === ECHECS_MAX && derniers.every((r) => r.statut === 'erreur')) {
    return { source: 'secours', raison: `Les ${ECHECS_MAX} derniers tris du Triage ont échoué (depuis ${heure(Date.parse(derniers[ECHECS_MAX - 1].createdAt))}) : l’agent relève la boîte lui-même en attendant.` }
  }
  return { source: 'triage', raison: 'Le Triage est en service : l’agent traite les mails qu’il lui transmet, il ne relève plus la boîte lui-même.' }
}

export async function relaisTriage(now = Date.now()): Promise<Relais> {
  const etat = await lireEtat(TRIAGE_SLUG, ETAT_INITIAL)
  if (etat.mode !== 'actif') return evaluerRelais({ mode: etat.mode, dernierReleve: now, runs: [], now })
  return evaluerRelais({ mode: etat.mode, dernierReleve: dernierReleveReussi ?? demarrage, runs: await lireRuns(TRIAGE_SLUG), now })
}

/** Mails the Triage sorted while « actif »: an agent's own poll never reads them. */
export async function triesParTriage(): Promise<Set<string>> {
  const ids = (await lireRuns(TRIAGE_SLUG))
    .filter((r) => r.mode === 'actif' && r.statut === 'trie')
    .map((r) => r.message?.id)
  return new Set(ids.filter((x): x is string => !!x))
}
