// Fibre families and the « reprendre un coloris » rule (LIVA #1359, Vincent +
// Isabelle 2026-11-10).
//
// A dyer's recipe (« 0212 marine 61508/1 ») is worked out by its lab once, on
// one finished reference. Isabelle: it holds on another reference as long as
// the FIBRES are of the same families — a jersey in 1/28 combed cotton and a
// jersey in 1/26 open-end cotton take the same recipe; cotton and viscose do
// not (viscose takes more dye), nor cotton and cotton/polyester (two dyes).
//
// - The family belongs to the MATIÈRE (`matiere_premiere.famille`), never to a
//   yarn: a yarn's families follow from its matières (asso_fil_matiere).
// - The families are FIXED here, not editable on a screen: the rule that
//   offers coloris rests on them, so a new one is a business decision.
// - A recipe is offered only for an écru with the same SET of families, each
//   counted when it weighs at least SEUIL_FAMILLE of the écru; élasthanne never
//   counts (it hardly changes the dye). A matière with no family yet makes the
//   écru's signature unknown — nothing is offered rather than a wrong recipe.
// - Measured on 2026-11-10 (dev = prod copy): of the 334 recipes already shared
//   between references with a known composition, 323 stayed within one
//   signature; the 11 others are mostly cotton passed onto cotton/polyester.
// - The contexture (jersey, molleton…) only ORDERS the list: Isabelle shares
//   recipes across contextures (283 of the 351 shared recipes do).

import { mpsPg } from './mps-pg.js'

export const FAMILLES_FIBRES = [
  { code: 'vegetale', libelle: 'Fibres végétales', ignoree: false },
  { code: 'artificielle', libelle: 'Fibres artificielles', ignoree: false },
  { code: 'animale', libelle: 'Fibres animales', ignoree: false },
  { code: 'polyester', libelle: 'Polyester', ignoree: false },
  { code: 'polyamide', libelle: 'Polyamide', ignoree: false },
  { code: 'elasthanne', libelle: 'Élasthanne', ignoree: true },
  { code: 'metallique', libelle: 'Fibres métalliques', ignoree: false },
  { code: 'autre', libelle: 'Autres fibres', ignoree: false },
] as const

export type FamilleFibre = (typeof FAMILLES_FIBRES)[number]['code']

/** A family below this share of the écru does not count (10 %). */
export const SEUIL_FAMILLE = 0.1

const PAR_CODE = new Map<string, (typeof FAMILLES_FIBRES)[number]>(FAMILLES_FIBRES.map((f) => [f.code, f]))

export function estFamille(v: unknown): v is FamilleFibre {
  return typeof v === 'string' && PAR_CODE.has(v)
}

export function libelleFamille(code: string): string {
  return PAR_CODE.get(code)?.libelle ?? code
}

/** One matière's weight in an écru: its family (null = not classified). */
export interface PartMatiere {
  matiere: string
  famille: FamilleFibre | null
  part: number
}

export type Signature =
  | { connue: true; familles: FamilleFibre[]; cle: string }
  | { connue: false; raison: 'sans_composition' | 'matiere_non_classee'; matieres: string[] }

/** The écru's families that count, sorted — or why it cannot be known. */
export function signatureFamilles(parts: readonly PartMatiere[]): Signature {
  const total = parts.reduce((s, p) => s + (p.part > 0 ? p.part : 0), 0)
  if (!(total > 0)) return { connue: false, raison: 'sans_composition', matieres: [] }
  const parFamille = new Map<FamilleFibre, number>()
  const nonClassees = new Map<string, number>()
  for (const p of parts) {
    if (!(p.part > 0)) continue
    if (p.famille === null) nonClassees.set(p.matiere, (nonClassees.get(p.matiere) ?? 0) + p.part)
    else parFamille.set(p.famille, (parFamille.get(p.famille) ?? 0) + p.part)
  }
  const bloquantes = [...nonClassees].filter(([, part]) => part / total >= SEUIL_FAMILLE).map(([m]) => m)
  if (bloquantes.length > 0) return { connue: false, raison: 'matiere_non_classee', matieres: bloquantes.sort() }
  const familles = [...parFamille]
    .filter(([f, part]) => !PAR_CODE.get(f)!.ignoree && part / total >= SEUIL_FAMILLE)
    .map(([f]) => f)
    .sort((a, b) => FAMILLES_FIBRES.findIndex((x) => x.code === a) - FAMILLES_FIBRES.findIndex((x) => x.code === b))
  if (familles.length === 0) return { connue: false, raison: 'sans_composition', matieres: [] }
  return { connue: true, familles, cle: familles.join('+') }
}

export function libelleSignature(s: Signature): string {
  return s.connue ? s.familles.map(libelleFamille).join(' + ') : ''
}

/** The parts of every écru given (or of all écrus): the generic recipe
 *  (`idcolori_ecru = 0`) when it has rows, else every row of the écru. A yarn's
 *  matière fractions are 0..1 (asso_fil_matiere.pourcentage). */
export async function partsParEcru(idsEcru?: readonly number[]): Promise<Map<number, PartMatiere[]>> {
  const sql = mpsPg()
  const filtre = idsEcru ? sql`AND ce.idref_ecru = ANY(${idsEcru as number[]})` : sql``
  const rows = await sql<{ idref_ecru: number; generique: boolean; matiere: string; famille: string | null; part: number }[]>`
    SELECT ce.idref_ecru, ce.idcolori_ecru = 0 AS generique, mp.libelle::text AS matiere, mp.famille,
           SUM(ce.pourcentage * afm.pourcentage)::float8 AS part
    FROM composition_ecru ce
    JOIN asso_fil_matiere afm ON afm.idref_fil = ce.idref_fil
    JOIN matiere_premiere mp ON mp.idmatiere_premiere = afm.idmatiere
    WHERE ce.idref_ecru > 0 ${filtre}
    GROUP BY 1, 2, 3, 4`
  const generiques = new Map<number, PartMatiere[]>()
  const toutes = new Map<number, PartMatiere[]>()
  for (const r of rows) {
    const p: PartMatiere = { matiere: r.matiere.trim(), famille: estFamille(r.famille) ? r.famille : null, part: Number(r.part) || 0 }
    const cible = r.generique ? generiques : toutes
    if (!cible.has(r.idref_ecru)) cible.set(r.idref_ecru, [])
    cible.get(r.idref_ecru)!.push(p)
  }
  // An écru whose coloris carry the only composition rows: their sum gives the
  // same proportions as long as every coloris shares the recipe, which is the
  // case for the ones measured; the generic rows win whenever they exist.
  for (const [id, parts] of toutes) if (!generiques.has(id)) generiques.set(id, parts)
  return generiques
}
