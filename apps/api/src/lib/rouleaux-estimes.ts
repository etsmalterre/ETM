/**
 * How many rolls a client order line represents — an ESTIMATE, shown on hover
 * of the line's « Commandé » (Clients › Commandes, 2026-10-26).
 *
 * Same roll as the Fiche tarif (decision Vincent 2026-10-26): one roll =
 * `ref_ecru.poids` kg of écru, and on a fini `poids × ref_fini.rendement` Ml
 * (the UNROUNDED rendement, as the tarif's « Qté » column — pricing-fini-tarif.ts).
 * Never an average of past rolls: cuts for one-off reasons would skew it.
 * No estimate when the catalogue has no roll weight (or no rendement for Ml),
 * exactly where the Fiche tarif prices nothing.
 */
import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'

export interface LigneRouleaux {
  id: number
  /** 1 = écru, 2 = fini (ligne_commande_client.TYPE). */
  typeKind: number
  refId: number
  /** 3 = Ml, else Kg (lineDim). */
  unite: number
  quantite: number
}

export interface RouleauxEstimes {
  /** Rolls, one decimal (the tarif's « simulation libre » rounding). */
  nb: number
  /** One roll in the line's unit. */
  taille: number
  /** One roll in Kg of écru (ref_ecru.poids). */
  poids_rouleau: number
  /** Ml/Kg used for a Ml line (ref_fini.rendement), 0 on a Kg line. */
  rendement: number
  /** The écru whose roll weight is used. */
  ref_ecru: string | null
}

export interface RefRouleau {
  /** ref_ecru.poids, 0 when unknown. */
  poids: number
  /** ref_fini.rendement (Ml/Kg) for a fini, 0 for an écru. */
  rendement: number
  ref_ecru: string | null
}

/** Pure: the estimate for one line, null when the catalogue cannot size a roll. */
export function estimerRouleaux(quantite: number, unite: number, ref: RefRouleau | undefined): RouleauxEstimes | null {
  if (!ref || !(ref.poids > 0) || !(quantite > 0)) return null
  const taille = unite === 3 ? ref.poids * ref.rendement : ref.poids
  if (!(taille > 0)) return null
  return {
    nb: Math.round((quantite / taille) * 10) / 10,
    taille: Math.round(taille * 10) / 10,
    poids_rouleau: ref.poids,
    rendement: unite === 3 ? ref.rendement : 0,
    ref_ecru: ref.ref_ecru,
  }
}

/** Estimates by line id; lines that are neither écru nor fini are left out. */
export async function rouleauxEstimesParLigne(lignes: LigneRouleaux[], sql: Sql = mpsPg()): Promise<Map<number, RouleauxEstimes | null>> {
  const out = new Map<number, RouleauxEstimes | null>()
  const finiIds = [...new Set(lignes.filter((l) => l.typeKind === 2 && l.refId > 0).map((l) => l.refId))]
  const finis = finiIds.length > 0
    ? await sql<{ idref_fini: number; idref_ecru: number | null; rendement: number | null }[]>`
        SELECT idref_fini, idref_ecru, rendement FROM ref_fini WHERE idref_fini = ANY(${finiIds})`
    : []
  const finiById = new Map(finis.map((f) => [Number(f.idref_fini), f]))
  const ecruIds = [...new Set([
    ...lignes.filter((l) => l.typeKind === 1 && l.refId > 0).map((l) => l.refId),
    ...finis.map((f) => Number(f.idref_ecru) || 0).filter((n) => n > 0),
  ])]
  const ecrus = ecruIds.length > 0
    ? await sql<{ idref_ecru: number; reference: string | null; poids: number | null }[]>`
        SELECT idref_ecru, reference, poids FROM ref_ecru WHERE idref_ecru = ANY(${ecruIds})`
    : []
  const ecruById = new Map(ecrus.map((e) => [Number(e.idref_ecru), e]))

  for (const l of lignes) {
    let ref: RefRouleau | undefined
    if (l.typeKind === 1) {
      const e = ecruById.get(l.refId)
      if (e) ref = { poids: Number(e.poids) || 0, rendement: 0, ref_ecru: e.reference ?? null }
    } else if (l.typeKind === 2) {
      const f = finiById.get(l.refId)
      const e = f ? ecruById.get(Number(f.idref_ecru) || 0) : undefined
      if (f && e) ref = { poids: Number(e.poids) || 0, rendement: Number(f.rendement) || 0, ref_ecru: e.reference ?? null }
    } else continue
    out.set(l.id, estimerRouleaux(l.quantite, l.unite, ref))
  }
  return out
}
