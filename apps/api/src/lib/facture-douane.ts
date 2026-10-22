// « Facturation douanière » (client switch, LIVA #1311, 2026-10-22): the customs
// facts Pierre-Emmanuel used to add by hand on AGAPE's invoices (Morocco) —
// an origin declaration under the totals and, per avis d'expédition, the HS
// code, the incoterm and the gross / net weights. Pure rules here; the loader
// is lib/facture-douane-data.ts.
//
// Sources (Vincent asked for an independent check, 2026-10-22):
// • Combined Nomenclature heading 6006 — knitted fabrics > 30 cm wide: the
//   chief fibre picks the family (10 wool, 2x cotton, 3x synthetic,
//   4x artificial, 90 other), the finish the last digit (1 unbleached or
//   bleached, 2 dyed, 3 yarns of different colours, 4 printed).
// • WCO HS Section XI subheading note 1 (e)/(f), applicable to knitted
//   fabrics: « bleached … or dyed white » — a fabric dyed WHITE is « blanchie »,
//   not « teinte ». Isabelle: a coloris whose name says « Blanc » is always a
//   white. Washed (lavé, avec_teinture = 0) keeps the fibres' natural colour:
//   « écrue ».
// • Heading 6004 takes knitted fabrics with 5 % or more elastomeric yarn.
// • Section XI note 2: a mixture is classified as the material that
//   predominates by weight; chapters 54 and 55 (synthetic + artificial) count
//   as one; on a tie, the heading last in numerical order wins.
// • The origin declaration is the standard wording (douane.gouv.fr, PEM
//   convention), without the approved-exporter number ETS Malterre does not
//   hold — valid for a consignment up to 6 000 €.
// Not handled (no data in ETM): yarn-dyed (x3) and printed (x4) fabrics.

/** Gross = fabric + tube + packaging; net = fabric alone. One kilo per piece,
 *  never 900 g (Isabelle, 2026-10-22). */
export const TARE_PAR_PIECE_KG = 1

export const INCOTERM = 'EXW'

export const MENTION_ORIGINE =
  "L'exportateur des produits couverts par le présent document déclare que, sauf indication claire du contraire, ces produits ont l'origine préférentielle UE."

export type GroupeMatiere = 'coton' | 'laine' | 'synthetique' | 'artificielle' | 'elasthanne' | 'autre'

/** matiere_premiere.libelle → its customs family. null = unknown label: the
 *  code is not printed rather than guessed. */
export function groupeMatiere(libelle: string): GroupeMatiere | null {
  const s = libelle.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
  if (/elasth/.test(s)) return 'elasthanne'
  if (/^coton/.test(s)) return 'coton'
  if (/laine|merinos/.test(s)) return 'laine'
  if (/viscose|bambou|tencel|modal|lyocell/.test(s)) return 'artificielle'
  if (/polyester|polyamide|acryl|nomex|kevlar|polypropyl|protex|mais/.test(s)) return 'synthetique'
  if (/^(lin|chanvre|cuivre|inox)$/.test(s)) return 'autre'
  return null
}

export type Finition = 'ecrue' | 'blanchie' | 'teinte'

/** What the customs code calls the finish of a shipped line. An écru line or
 *  a washed fini is « écrue »; a dyed fini is « teinte » unless its coloris
 *  says « Blanc ». */
export function finitionDe(p: { kind: 'ecru' | 'fini'; avecTeinture: number; coloris: string }): Finition {
  if (p.kind === 'ecru' || p.avecTeinture === 0) return 'ecrue'
  return /blanc/i.test(p.coloris) ? 'blanchie' : 'teinte'
}

// Chapter of each family, for the « last in numerical order » tie-break:
// 51 wool, 52 cotton, 53 other vegetable (lin, chanvre — metal threads
// ride along), 54/55 man-made.
const ORDRE: Record<'laine' | 'coton' | 'autre' | 'chimique', number> = { laine: 51, coton: 52, autre: 53, chimique: 54 }

/** The 8-digit CN code (« 60062200 ») of a fabric from its matière shares (in
 *  %, any order) and its finish. null when the composition is empty or holds
 *  a matière this table does not know. */
export function codeHs(matieres: ReadonlyArray<{ matiere: string; pourcentage: number }>, finition: Finition): string | null {
  const parGroupe = new Map<GroupeMatiere, number>()
  let total = 0
  for (const m of matieres) {
    const g = groupeMatiere(m.matiere)
    if (g === null) return null
    const p = Number(m.pourcentage) || 0
    parGroupe.set(g, (parGroupe.get(g) ?? 0) + p)
    total += p
  }
  if (!(total > 0)) return null
  const part = (g: GroupeMatiere) => (parGroupe.get(g) ?? 0) / total
  if (part('elasthanne') >= 0.05 - 1e-9) return '60041000'

  const synthetique = part('synthetique') + part('elasthanne')
  const artificielle = part('artificielle')
  const familles: Array<[keyof typeof ORDRE, number]> = [
    ['laine', part('laine')], ['coton', part('coton')], ['autre', part('autre')], ['chimique', synthetique + artificielle],
  ]
  // Largest share; a tie goes to the later chapter.
  familles.sort((a, b) => (Math.abs(b[1] - a[1]) > 1e-9 ? b[1] - a[1] : ORDRE[b[0]] - ORDRE[a[0]]))
  const chiffre = finition === 'teinte' ? '2' : '1'
  switch (familles[0][0]) {
    case 'laine': return '60061000'
    case 'autre': return '60069000'
    case 'coton': return `60062${chiffre}00`
    case 'chimique':
      // Synthetic (5402/5503) before artificial (5403/5504): a tie goes to artificial.
      return synthetique > artificielle + 1e-9 ? `60063${chiffre}00` : `60064${chiffre}00`
  }
}

/** « 60062200 » → « 6006 22 00 », the way the nomenclature prints it. */
export function formatCodeHs(code: string): string {
  return /^\d{8}$/.test(code) ? `${code.slice(0, 4)} ${code.slice(4, 6)} ${code.slice(6)}` : code
}

export interface PieceDouane {
  /** Avis d'expédition number (= IDexpedition). */
  avis: number
  poids: number
  hs: string | null
}

export interface LigneDouane { hs: string | null; pieces: number; brut: number; net: number }
export interface BlocDouane { avis: number; lignes: LigneDouane[] }

const r2 = (v: number) => Math.round(v * 100) / 100

function ligne(hs: string | null, pieces: number, brut: number): LigneDouane {
  const b = r2(brut)
  return { hs, pieces, brut: b, net: Math.max(0, r2(b - TARE_PAR_PIECE_KG * pieces)) }
}

/** One block per avis (ascending), one row per HS code inside it: gross =
 *  Σ the pieces' weights, net = gross − 1 kg per piece. */
export function blocsDouane(pieces: readonly PieceDouane[]): BlocDouane[] {
  const parAvis = new Map<number, Map<string, { hs: string | null; n: number; poids: number }>>()
  for (const p of pieces) {
    const m = parAvis.get(p.avis) ?? new Map()
    const k = p.hs ?? ''
    const acc = m.get(k) ?? { hs: p.hs, n: 0, poids: 0 }
    acc.n += 1
    acc.poids += Number(p.poids) || 0
    m.set(k, acc)
    parAvis.set(p.avis, m)
  }
  return [...parAvis.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([avis, m]) => ({
      avis,
      lignes: [...m.values()].sort((a, b) => (a.hs ?? '~').localeCompare(b.hs ?? '~')).map((x) => ligne(x.hs, x.n, x.poids)),
    }))
}

/** The invoice's totals, summed from the rows (each already rounded). */
export function totalDouane(blocs: readonly BlocDouane[]): { pieces: number; brut: number; net: number } {
  let pieces = 0, brut = 0, net = 0
  for (const b of blocs) for (const l of b.lignes) { pieces += l.pieces; brut += l.brut; net += l.net }
  return { pieces, brut: r2(brut), net: r2(net) }
}
