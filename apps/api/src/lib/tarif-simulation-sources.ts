// Finis › Tarifs — what a new simulation is seeded with, from a client's
// reference or from a sample (LIVA #1298). Shared by the route and by
// check-ref-tarif-parity.ts, which proves that a reference's copy starts at
// the reference's catalogue price.

import type { Sql } from 'postgres'
import { achatDepuisPrixBase } from './fil-frais-gestion.js'
import { rendementDepuisMesures } from './tarif-simulation.js'

/** Roll weight of a simulation without an écru behind it — the legacy default. */
export const POIDS_ROULEAU_DEFAUT = 20

function money(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

function num4(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0
}

export type NewFil = { idref_fil: number; idcolori_fil: number; pourcentage: number; prix_achat: number }

/** The header columns a source fills in (the rest keeps its defaults). */
export interface SeedParams {
  laize?: number
  poids?: number
  rendement?: number
  freinte?: number
  prix_tricotage?: number
  poids_rouleau?: number
  idteinture?: number
  gots?: number
  idclient?: number
  idref_echantillon?: number
}

/** Purchase price of each (yarn, coloris): the coloris' own base price when
 *  set, else the yarn's — minus the frais de gestion it holds. */
export async function prixAchatCatalogue(
  sql: Sql,
  lines: Array<{ idref_fil: number; idcolori_fil: number }>,
): Promise<(l: { idref_fil: number; idcolori_fil: number }) => number> {
  const filIds = [...new Set(lines.map((l) => l.idref_fil).filter((n) => n > 0))]
  const colIds = [...new Set(lines.map((l) => l.idcolori_fil).filter((n) => n > 0))]
  const fil = new Map<number, number>()
  const col = new Map<number, number>()
  if (filIds.length > 0) {
    for (const r of await sql<{ idref_fil: number; prix_kg: number | null }[]>`
      SELECT idref_fil, prix_kg FROM ref_fil WHERE idref_fil IN ${sql(filIds)}`) fil.set(Number(r.idref_fil), money(r.prix_kg))
  }
  if (colIds.length > 0) {
    for (const r of await sql<{ idcolori_fil: number; prix_kg: number | null }[]>`
      SELECT idcolori_fil, prix_kg FROM colori_fil WHERE idcolori_fil IN ${sql(colIds)}`) col.set(Number(r.idcolori_fil), money(r.prix_kg))
  }
  return (l) => {
    const c = col.get(l.idcolori_fil) ?? 0
    return achatDepuisPrixBase(c !== 0 ? c : (fil.get(l.idref_fil) ?? 0))
  }
}

/** A copy of a client's reference: geometry from ref_fini, knitting price and
 *  roll weight from its écru, the coloris' yarn composition at today's
 *  purchase prices, the ref's treatments, and the coloris' dye + GOTS — i.e.
 *  exactly what the catalogue prices, so the study starts at its price. */
export async function seedFromRefFini(sql: Sql, IDref_fini: number, IDcoloris: number): Promise<{ v: SeedParams; fils: NewFil[]; traitements: number[] } | null> {
  const [r] = await sql<{
    idref_ecru: number | null; idcolori_ecru: number | null; rendement: number | null; freinte: number | null
    laizeutile_moy: number | null; laizeht_moy: number | null; poids_moy: number | null; avec_teinture: number | null
  }[]>`
    SELECT idref_ecru, idcolori_ecru, rendement, freinte, laizeutile_moy, laizeht_moy, poids_moy, avec_teinture
      FROM ref_fini WHERE idref_fini = ${IDref_fini}`
  if (!r) return null
  const idEcru = Number(r.idref_ecru) || 0
  const avecTeinture = Number(r.avec_teinture) || 0

  const [ecru] = idEcru > 0
    ? await sql<{ prix: number | null; poids: number | null }[]>`SELECT prix, poids FROM ref_ecru WHERE idref_ecru = ${idEcru}`
    : []

  // The coloris decides the dye (dyed ref) or the écru coloris whose yarn
  // recipe is used (wash-only ref) — same branching as calcTarifRefFini.
  let idteinture = 0
  let gots = 0
  let colorisEcru = Number(r.idcolori_ecru) || 0
  if (avecTeinture !== 0) {
    const [c] = IDcoloris > 0
      ? await sql<{ idteinture: number | null; gots: number | null }[]>`
          SELECT idteinture, gots FROM ref_fini_colori WHERE idref_fini_colori = ${IDcoloris}`
      : []
    idteinture = Number(c?.idteinture) || 0
    gots = Number(c?.gots) === 1 ? 1 : 0
  } else if (IDcoloris > 0) {
    colorisEcru = IDcoloris
  }

  let comp = idEcru > 0
    ? await sql<{ idref_fil: number; idcolori_fil: number; pourcentage: number | null }[]>`
        SELECT idref_fil, idcolori_fil, pourcentage FROM composition_ecru
         WHERE idref_ecru = ${idEcru} AND idcolori_ecru = ${colorisEcru} ORDER BY idcomposition_ecru`
    : []
  if (comp.length === 0 && idEcru > 0 && colorisEcru !== 0) {
    comp = await sql<{ idref_fil: number; idcolori_fil: number; pourcentage: number | null }[]>`
      SELECT idref_fil, idcolori_fil, pourcentage FROM composition_ecru
       WHERE idref_ecru = ${idEcru} AND idcolori_ecru = 0 ORDER BY idcomposition_ecru`
  }
  const lines = comp.map((c) => ({ idref_fil: Number(c.idref_fil) || 0, idcolori_fil: Number(c.idcolori_fil) || 0 }))
  const achat = await prixAchatCatalogue(sql, lines)
  const fils = comp.map((c, i) => ({ ...lines[i], pourcentage: num4(c.pourcentage), prix_achat: achat(lines[i]) }))

  const trt = await sql<{ idtraitement: number }[]>`
    SELECT trf.idtraitement FROM traitement_ref_fini trf
      JOIN traitement t ON t.idtraitement = trf.idtraitement
     WHERE trf.idref_fini = ${IDref_fini} ORDER BY t.ordre`

  const poidsRouleau = num4(ecru?.poids)
  return {
    v: {
      laize: num4(r.laizeutile_moy) || num4(r.laizeht_moy),
      poids: num4(r.poids_moy),
      // Raw, never rounded: the catalogue rounds the RAW rendement to 2 dp for
      // the Ml price, so 2.6449999 must stay 2.6449999 (num4 → 2.645 → 2.65).
      rendement: Number(r.rendement) || 0,
      freinte: num4(r.freinte),
      prix_tricotage: num4(ecru?.prix),
      poids_rouleau: poidsRouleau > 0 ? poidsRouleau : POIDS_ROULEAU_DEFAUT,
      idteinture,
      gots,
    },
    fils,
    traitements: trt.map((t) => Number(t.idtraitement)).filter((n) => n > 0),
  }
}

/** A sample's estimate: its yarns at today's purchase prices, the rendement
 *  from its WASHED measures (the « pré-industriel » finished-fabric estimate),
 *  its client. Knitting and ennoblissement are left for the user to set — a
 *  sample has no écru behind it, unless it already became one. */
export async function seedFromEchantillon(sql: Sql, id: number): Promise<{ v: SeedParams; fils: NewFil[] } | null> {
  const [e] = await sql<{
    idclient: number | null; idref_ecru: number | null
    laize_lave: number | null; poids_m2_lave: number | null; laize_tbm: number | null; poids_m2_tbm: number | null
  }[]>`
    SELECT idclient, idref_ecru, laize_lave, poids_m2_lave, laize_tbm, poids_m2_tbm
      FROM ref_echantillon WHERE idref_echantillon = ${id}`
  if (!e) return null
  const comp = await sql<{ idref_fil: number; idcolori_fil: number; pourcentage: number | null }[]>`
    SELECT idref_fil, idcolori_fil, pourcentage FROM fil_ref_echantillon
     WHERE idref_echantillon = ${id} ORDER BY idfil_ref_echantillon`
  const lines = comp.map((c) => ({ idref_fil: Number(c.idref_fil) || 0, idcolori_fil: Number(c.idcolori_fil) || 0 }))
  const achat = await prixAchatCatalogue(sql, lines)
  // fil_ref_echantillon.pourcentage is a 0..1 FRACTION (lib/echantillons.ts).
  const fils = comp.map((c, i) => ({ ...lines[i], pourcentage: num4((Number(c.pourcentage) || 0) * 100), prix_achat: achat(lines[i]) }))

  const laize = Number(e.laize_lave) || 0
  const poids = Number(e.poids_m2_lave) || 0
  const idEcru = Number(e.idref_ecru) || 0
  const [ecru] = idEcru > 0
    ? await sql<{ prix: number | null; poids: number | null }[]>`SELECT prix, poids FROM ref_ecru WHERE idref_ecru = ${idEcru}`
    : []
  return {
    v: {
      laize,
      poids,
      rendement: num4(rendementDepuisMesures(laize, poids)),
      prix_tricotage: num4(ecru?.prix),
      poids_rouleau: num4(ecru?.poids) > 0 ? num4(ecru?.poids) : POIDS_ROULEAU_DEFAUT,
      idclient: Number(e.idclient) || 0,
      idref_echantillon: id,
    },
    fils,
  }
}

