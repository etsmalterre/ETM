// Agent « Factures Ennoblisseur » — the scores people give on Sous-traitants ›
// Factures (ligne_facture_sst.avis_*), copied onto the run that read the
// invoice, so Agents IA shows them read-only (Retours, version score) through
// the same `avisPoints` the Superviseur's points use. The database row is the
// truth; the run is rewritten from it after every decision.

import { mpsPg } from '../../mps-pg.js'
import { modifierRun, type Evaluation, type Note } from '../store.js'
import { FACTURES_SST_SLUG, OPTION_CONFIRMATION, FACTURES_SST_VERSION_INITIALE } from './agent.js'
import { clePoint } from './points.js'
import { lireEtat, optionDe } from '../store.js'

/** Rewrite the invoice's line scores on its run (a run that no longer exists,
 *  or an invoice written before runs kept ids, is left alone). */
export async function reporterAvisSurRun(idFacture: number): Promise<void> {
  const sql = mpsPg()
  const [f] = await sql<{ run_id: string | null; numero: string }[]>`
    SELECT run_id, numero FROM facture_sst WHERE idfacture_sst = ${idFacture}`
  if (!f?.run_id) return
  const lignes = await sql<{ ordre: number; lot: string; avis_note: Note | null; avis_commentaire: string | null; avis_par: number | null; avis_par_nom: string | null; avis_le: Date | null }[]>`
    SELECT ordre, lot, avis_note, avis_commentaire, avis_par, avis_par_nom, avis_le
    FROM ligne_facture_sst WHERE idfacture_sst = ${idFacture} AND genre = 'lot'`
  const avis: Record<string, Evaluation> = {}
  for (const l of lignes) {
    if (!l.avis_note || !l.avis_le) continue
    avis[clePoint(f.numero, Number(l.ordre) - 1, l.lot)] = {
      note: l.avis_note,
      commentaire: l.avis_commentaire ?? '',
      par: { id: Number(l.avis_par ?? 0), nom: l.avis_par_nom ?? '' },
      le: new Date(l.avis_le).toISOString(),
    }
  }
  await modifierRun(FACTURES_SST_SLUG, f.run_id, (x) => { x.avisPoints = avis })
}

/** The agent option: does every invoice wait for a person, or only those with a gap? */
export async function confirmationSystematique(): Promise<boolean> {
  return optionDe(await lireEtat(FACTURES_SST_SLUG, FACTURES_SST_VERSION_INITIALE), OPTION_CONFIRMATION, true)
}
