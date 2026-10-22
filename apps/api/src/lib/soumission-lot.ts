// The two soumissions of a dyed lot (LIVA #1313, decision Vincent 2026-10-22).
//
//   coloris     after the dye, BEFORE the stenter: MATEL (Perrine) writes « on
//               peut soumettre le lot MAxxxxx » in her answer to the point (§3),
//               we send MATEL the soumission sheet, MATEL prints it, staples a
//               sample and ships it to the client. The client's « ok » is the
//               « coloris validé »: we mail MATEL to put the lot on the stenter. A
//               refusal sends the lot back to the dye — same lot number.
//               Empreinte, Simone Pérèle, Agape, Allande, Séduction Santoul.
//   stabilites  the received rolls, BEFORE shipping: the client checks the
//               dimensional stability himself. A refusal = « Reprendre » (the
//               lot goes back on the stenter). Le Slip Français, La Fabrique,
//               Lemahieu, Thuasne…
//
// A client may ask both, per reference: designation_client.soumettre is a bit
// set (SOUMETTRE). In prod (2025 → 2026-10) no client did both, and no client
// of the coloris kind ever submitted after the reception: the history (one
// envoi_email type 15 per send, which cannot tell the two apart) is classified
// by date against the lot's reception — natureInferee().
//
// The lot exists before its reception once its coloris is submitted: the
// soumission creates its suivilot row without a reception date, and the BL
// completes that row (upsertSuivilot in routes/commandes-sous-traitant.ts).

import { mpsPg } from './mps-pg.js'

export type NatureSoumission = 'coloris' | 'stabilites'

/** designation_client.soumettre bits. */
export const SOUMETTRE = { stabilites: 1, coloris: 2 } as const

export const NATURE_LIBELLE: Record<NatureSoumission, string> = {
  coloris: 'coloris',
  stabilites: 'stabilités',
}

/** What a designation_client.soumettre value asks. Pure. */
export function naturesDemandees(soumettre: unknown): NatureSoumission[] {
  const v = Number(soumettre) || 0
  const out: NatureSoumission[] = []
  if (v & SOUMETTRE.coloris) out.push('coloris')
  if (v & SOUMETTRE.stabilites) out.push('stabilites')
  return out
}

/** The bit set for the two switches. Pure. */
export function valeurSoumettre(coloris: boolean, stabilites: boolean): number {
  return (coloris ? SOUMETTRE.coloris : 0) | (stabilites ? SOUMETTRE.stabilites : 0)
}

/** A send logged only in envoi_email (before 2026-10-22): the one the
 *  reference asks when it asks only one; else sent before the lot came back
 *  from the dyer it was a coloris soumission, after it a stabilités one.
 *  `envoi` / `reception` 'YYYY-MM-DD'. Pure. */
export function natureInferee(envoi: string, reception: string | null, demandees: NatureSoumission[] = []): NatureSoumission {
  if (demandees.length === 1) return demandees[0]
  return !reception || envoi < reception ? 'coloris' : 'stabilites'
}

// ── Writes (native PostgreSQL) ───────────────────────────

export async function enregistrerSoumission(opts: {
  nature: NatureSoumission
  idcommande: number
  ligneId: number
  idsuivilot: number
  lot: string
  idcommandeClient: number
  par: { id: number; nom: string }
  destinataires: string[]
}): Promise<void> {
  await mpsPg()`
    INSERT INTO soumission_lot (nature, idcommande_sous_traitant, idligne_commande_sous_traitant, idsuivilot, lot,
                                idcommande_client, envoyee_par_id, envoyee_par, destinataires)
    VALUES (${opts.nature}, ${opts.idcommande}, ${opts.ligneId}, ${opts.idsuivilot}, ${opts.lot.trim()},
            ${opts.idcommandeClient}, ${opts.par.id}, ${opts.par.nom}, ${opts.destinataires.join(', ')})`
}

export async function enregistrerOkRamer(opts: {
  idsuivilot: number
  idcommande: number
  lot: string
  par: { id: number; nom: string }
  destinataires: string[]
}): Promise<void> {
  await mpsPg()`
    INSERT INTO ok_a_ramer_envoi (idsuivilot, idcommande_sous_traitant, lot, envoye_par_id, envoye_par, destinataires)
    VALUES (${opts.idsuivilot}, ${opts.idcommande}, ${opts.lot.trim()}, ${opts.par.id}, ${opts.par.nom}, ${opts.destinataires.join(', ')})`
}
