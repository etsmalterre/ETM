// « Relancer l'ennoblisseur » for its controls (Vincent 2026-11-27).
//
// A received lot has RELANCE_J.controle working days (5) for the dyer's
// measures. Beyond, the lot is red on Qualité › Suivi lots; the relance is an
// e-mail sent from there to the dyer's contacts, recorded in relance_controle
// (migration 0088). The lot is then calm for RELANCE_J.relance_controle
// working days, and red again (lib/cycle-ennoblissement.ts `relanceControleDue`).
// The twin of « Relancer le client » (lib/soumission-lot.ts). The colour waits
// for a person's own mail (decision of 2026-11-03).

import { mpsPg } from './mps-pg.js'

/** What the relance mail names. Dates 'YYYY-MM-DD'. */
export interface LotControleARelancer {
  lot: string
  /** The lot's reception (BL). */
  recuLe: string
  /** Our relances since, sorted. */
  relances: string[]
  /** The dyer's measures still missing (« laize », « poids », « stabilités »…). */
  manque: string[]
  reference: string
  coloris: string
  /** Our order at the dyer; 0 = unknown. */
  commande: number
}

const jjmmaaaa = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

/** « laize, poids et stabilités ». */
const liste = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} et ${xs.at(-1)}`)

/** The relance mail as it opens: short, the person reads it before it leaves. Pure. */
export function mailRelanceEnnoblisseur(l: LotControleARelancer): { subject: string; body: string } {
  const article = [l.reference, l.coloris].filter(Boolean).join(' - ')
  const derniere = l.relances.at(-1)
  const precisions = [article, l.commande > 0 ? `notre commande ${l.commande}` : ''].filter(Boolean).join(', ')
  return {
    subject: `Relance - Contrôles du lot ${l.lot}${article ? ` - ${article}` : ''}`,
    body:
      `Bonjour,\n\n` +
      `Nous avons reçu le lot ${l.lot}${precisions ? ` (${precisions})` : ''} le ${jjmmaaaa(l.recuLe)}` +
      `${derniere ? ` et, malgré notre relance du ${jjmmaaaa(derniere)}, nous` : ' et'} n’avons pas encore vos contrôles` +
      `${l.manque.length > 0 ? ` : ${liste(l.manque)}` : ''}.\n\n` +
      `Nous en avons besoin pour valider le lot.\n\n` +
      `Pouvez-vous nous les transmettre ?\n\n` +
      `Cordialement,`,
  }
}

/** The relance e-mail left: the fact the cycle reads to push OUR next chase
 *  (lib/cycle-ennoblissement.ts `relanceControleDue`). Append-only. */
export async function enregistrerRelanceControle(opts: {
  idsuivilot: number
  idcommande: number
  lot: string
  par: { id: number; nom: string }
  destinataires: string[]
}): Promise<void> {
  await mpsPg()`
    INSERT INTO relance_controle (idsuivilot, idcommande_sous_traitant, lot, relance_par_id, relance_par, destinataires)
    VALUES (${opts.idsuivilot}, ${opts.idcommande}, ${opts.lot.trim()}, ${opts.par.id}, ${opts.par.nom}, ${opts.destinataires.join(', ')})`
}
