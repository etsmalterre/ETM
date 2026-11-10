// A finished reference's « teinture » (ref_fini.avec_teinture): 0 = écru / lavage,
// 1 = simple teinture, 2 = double teinture. LIVA #1365 (2026-11-10): a new
// reference was born « lavage » and no screen could change it, so ETM could not
// create a dyed reference from scratch (only « Dupliquer » a dyed one).
//
// The value is not cosmetic: it decides WHICH catalog every coloris id of the
// reference points into (CLAUDE.md « Per-table polymorphism », #1158):
//   0     → colori_ecru of the écru (the wash keeps the écru's colours),
//   1 / 2 → ref_fini_colori of the reference itself (dyed colours).
// Switching between lavage and teinture on a reference that already holds a
// coloris anywhere (a roll, an order, a devis, a dyer line, a lot, a client
// coloris, an étude with its coloris, a photo, a dyed coloris in its own
// catalog) would leave those ids pointing into the wrong catalog. So that
// switch is refused once the reference is used; simple ↔ double never changes
// the catalog and stays free (it only weighs on the price).
//
// Ids are polymorphic, so a usage is counted only on the FINI kind of each
// line (type 2 on client, devis and sst lines — lib/sst-line-kind.ts).

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'

export type Teinture = 0 | 1 | 2

export const LIBELLE_TEINTURE: Record<Teinture, string> = {
  0: 'Écru / lavage',
  1: 'Simple teinture',
  2: 'Double teinture',
}

/** Does going from `avant` to `apres` move the coloris to another catalog? Pure. */
export function changeDeCatalogue(avant: number, apres: number): boolean {
  return (Number(avant) === 0) !== (Number(apres) === 0)
}

export interface UsageRefFini {
  /** What holds a coloris of the reference, plural French label. */
  quoi: string
  n: number
}

/** French sentence explaining why the switch is refused. Pure. */
export function messageTeintureVerrouillee(avant: number, usages: UsageRefFini[]): string {
  const parts = usages.map((u) => `${u.quoi} : ${u.n}`).join(' ; ')
  const vers = Number(avant) === 0 ? 'une teinture' : 'un lavage'
  return `Cette référence est déjà utilisée (${parts}). Ses coloris ne peuvent plus passer en ${vers} : `
    + 'créez une nouvelle référence, ou dupliquez une référence du bon type.'
}

/** Everything that already holds a coloris of fini reference `idRefFini`.
 *  Empty = the reference is still free to switch between lavage and teinture. */
export async function usagesColorisRefFini(idRefFini: number, sql?: Sql): Promise<UsageRefFini[]> {
  const s = sql ?? mpsPg()
  const id = idRefFini
  const [r] = await s<Record<string, number>[]>`
    SELECT
      (SELECT COUNT(*) FROM ref_fini_colori WHERE idref_fini = ${id})::int AS coloris,
      (SELECT COUNT(*) FROM stock_fini WHERE idref_fini = ${id})::int AS rouleaux,
      (SELECT COUNT(*) FROM ligne_commande_client WHERE type = 2 AND idreference = ${id})::int AS commandes,
      (SELECT COUNT(*) FROM ligne_devis_etm WHERE type = 2 AND idreference = ${id})::int AS devis,
      (SELECT COUNT(*) FROM ligne_commande_sous_traitant WHERE type = 2 AND idreference = ${id})::int AS sst,
      (SELECT COUNT(*) FROM suivilot WHERE idref_fini = ${id})::int AS lots,
      (SELECT COUNT(*) FROM ref_client_colori r
         JOIN designation_client d ON d.iddesignation_client = r.iddesignation_client
        WHERE d.idref_fini = ${id})::int AS clients,
      (SELECT COUNT(*) FROM etude_col WHERE idref_fini = ${id} AND COALESCE(idref_fini_colori, 0) > 0)::int AS etudes,
      (SELECT COUNT(*) FROM photo_produit WHERE idref_fini = ${id} AND COALESCE(idcoloris, 0) > 0)::int AS photos`
  const lignes: [string, number][] = [
    ['Coloris teints', r?.coloris],
    ['Rouleaux finis', r?.rouleaux],
    ['Lignes de commande client', r?.commandes],
    ['Lignes de devis', r?.devis],
    ['Lignes de commande sous-traitant', r?.sst],
    ['Suivis de lot', r?.lots],
    ['Coloris de désignations client', r?.clients],
    ['Études coloris acceptées', r?.etudes],
    ['Photos de coloris', r?.photos],
  ].map(([q, n]) => [q as string, Number(n) || 0])
  return lignes.filter(([, n]) => n > 0).map(([quoi, n]) => ({ quoi, n }))
}
