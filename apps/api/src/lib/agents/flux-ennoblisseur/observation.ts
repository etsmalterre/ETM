// The BL in observation (skill in essai, claude_doc/agents_autonomie.md §2).
//
// A skill in observation is transparent: it writes nothing and shows nothing.
// What makes it worth watching is the comparison with what people really do.
// The BL is read on arrival (nothing is received yet, so nothing leaks) and
// compared, once an hour (`passeObservation`, scheduler.ts), with the rolls a
// person received since (bl-observation.ts). This file: that pass, and what
// the Score shows of it.
//
// Until 2026-11-27 the pass also read the replies to our Point for the skills
// Délais and Contrôles, once a person had reacted to them (PG observation_mail
// and observation_saisie, no longer read nor written).

import { BL_ENNOBLISSEUR_SLUG } from '../bl-ennoblisseur.js'
import { aComparer as aComparerBl, comparerObservationsBl } from '../bl-observation.js'
import type { AgentRun } from '../store.js'

// ── The hourly pass ──────────────────────────────────────

let dernierePasse: string | null = null
let enCours = false

/** Compare the BLs read in observation with the rolls received since. Never throws. */
export async function passeObservation(): Promise<void> {
  if (enCours) return
  enCours = true
  try {
    const bl = await comparerObservationsBl(BL_ENNOBLISSEUR_SLUG)
    dernierePasse = new Date().toISOString()
    if (bl) console.log('[observation] pass:', JSON.stringify({ bl }))
  } catch (e) {
    console.error('[observation] pass failed:', e)
  } finally {
    enCours = false
  }
}

// ── What the Score shows in observation ──────────────────

/** One gap between the reading and what a person received, for the Score tab. */
export interface EcartObservation {
  le: string
  /** The BL's summary. */
  quoi: string
  /** 'desaccord': another value. */
  type: 'desaccord'
  /** What the reading gave, and what the person typed (null for a BL: its gaps are counted, not listed). */
  agent: string | null
  personne: string | null
  citation: string
}

/** Observation, as it is worth watching (Vincent 2026-11-09): how much ran,
 *  how it compares with what people did, and the gaps. No autonomie, no discernement. */
export interface BilanObservation {
  /** BLs read while in observation: all of them, still to compare, never received. */
  mails: { recus: number; lus: number; attente: number; sansReaction: number }
  /** The points of the reading on the version: compared, and how. */
  points: { compares: number; accords: number; desaccords: number; omissions: number; aides: number; enAttente: number }
  ecarts: EcartObservation[]
  /** The last pass of this process (null since a restart). */
  dernierePasse: string | null
}

const ECARTS_MAX = 20

/** The BL in observation: read on arrival, compared once its rolls are received. */
export function bilanObservationBl(runs: readonly AgentRun[], version: number | null): BilanObservation {
  const lus = runs.filter((r) => (r.competence ?? 'bl') === 'bl' && r.mode === 'essai' && r.source !== 'essai_manuel'
    && (r.statut === 'simule' || r.statut === 'a_verifier') && (version === null || r.version === version))
  const p = { compares: 0, accords: 0, desaccords: 0, omissions: 0, aides: 0, enAttente: 0 }
  const ecarts: EcartObservation[] = []
  let attente = 0
  let sansReaction = 0
  for (const r of [...lus].sort((a, b) => (b.observation?.le ?? b.createdAt).localeCompare(a.observation?.le ?? a.createdAt))) {
    const o = r.observation
    if (!o) {
      p.enAttente++
      if (aComparerBl(r)) attente++
      else sansReaction++
      continue
    }
    p.compares++
    if (o.statut === 'validee') p.accords++
    else if (o.statut === 'corrigee') {
      p.desaccords++
      if (ecarts.length < ECARTS_MAX) ecarts.push({ le: o.le, quoi: r.resume, type: 'desaccord', agent: `${o.ecarts} écart${o.ecarts > 1 ? 's' : ''} avec la réception`, personne: null, citation: '' })
    } else p.aides++
  }
  return { mails: { recus: lus.length, lus: lus.length, attente, sansReaction }, points: p, ecarts, dernierePasse }
}
