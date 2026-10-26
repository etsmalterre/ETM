// Freinte de tricotage of a tombé de métier (decision Vincent 2026-10-26).
//
// What it is: the yarn that goes into the knitting and does not come out as écru, in % of the
// yarn in — kg in, kg out. It replaces ref_ecru.rendement, which nobody could explain (a length,
// while nobody measures the length of a tombé de métier) and which only ever served 5 écru lines
// sold in Ml. The Ml becomes the unit once the matter is set at the stenter: ref_fini.rendement.
//
// The yarn a line needs = its écru kg ÷ (1 − freinte). Tarifs do NOT count it yet (a separate
// reform): the fini tariff only prints « freinte tricotage x % · non comptée (y €/Kg) ».
//
// One value per écru, by precedence:
//   forcee   typed on the Tombé Métier fiche (ref_ecru.freinte_tricotage, NULL = not forced)
//   mesuree  ≥ MESURES_MIN valid measures: median of the last MESURES_RETENUES
//   defaut   median of the measured écrus of the same dominant matière, else of all of them
//
// A MEASURE is a group of TRM yarn lots and the OFs that knitted them, closed under « a lot fed an
// OF » (asso_fil_of, fil_incorpore): an OF fed by two lots of the same yarn, a lot spread over
// several OFs — only the whole group balances. It counts once every lot of the group is archived
// (TRM Fils › Stock, its rapport de freinte): yarn in = Σ stock_initial − what stayed on the lots,
// écru out = Σ weight of the group's pieces (2e choix included — produced, not lost). A lot still
// open never counts: its stock only moves by the knitted weight, so it would read 0 %.
// Study 2026-10-26 (489 groups): before 2023 the data is too noisy (a lot knitted without its
// asso row reads −22 000 % or +96 %); since 2023 the median is 3,4 % (p25 1,5 — p75 6,0) and the
// band below drops 16 % of the groups whatever its exact bounds. Medians by matière (écrus with
// ≥ 3 measures): coton 2,2 %, synthétique 3,2 %, lin/chanvre 7,1 %, all 3,2 %; leave-one-out the
// matière default misses a measured écru by 1,9 points vs 2,0 for the global one.

import { mpsPg } from './mps-pg.js'

/** Measures before this day are not used (data quality, see above). */
export const FREINTE_DEPUIS = '2023-01-01'
/** Outside this band a measure is a data error, not a freinte. */
export const FREINTE_MIN = -0.05
export const FREINTE_MAX = 0.25
export const MESURES_MIN = 3
export const MESURES_RETENUES = 10
/** A matière default needs this many measured écrus, else the global one applies. */
export const REFS_MIN_DEFAUT = 3
/** Last resort when nothing is measured at all. */
export const FREINTE_REPLI = 0.03
/** A measure is credited to an écru whose OFs made at least this share of the group's écru. */
const PART_MIN_ECRU = 0.25

export type GroupeMatiere = 'coton' | 'synthetique' | 'lin_chanvre' | 'autre'
export const LIBELLE_GROUPE: Record<GroupeMatiere, string> = {
  coton: 'coton', synthetique: 'synthétique', lin_chanvre: 'lin / chanvre', autre: 'autres matières',
}

export interface MesureFreinte {
  /** YYYY-MM-DD: the latest OF of the group */
  date: string
  entree: number
  sortie: number
  /** 1 − sortie / entree */
  taux: number
  lots: string[]
  ofs: number[]
  /** inside the band and since FREINTE_DEPUIS */
  valide: boolean
}

export type SourceFreinte = 'forcee' | 'mesuree' | 'defaut'

export interface FreinteEcru {
  /** the value every reader uses, 0..1 */
  taux: number
  source: SourceFreinte
  /** median of the retained measures, null under MESURES_MIN */
  mesuree: number | null
  nbMesures: number
  /** what a missing measure falls back to */
  defaut: number
  groupe: GroupeMatiere | null
  /** how many measured écrus the default is the median of (0 = FREINTE_REPLI) */
  defautNbRefs: number
  defautGlobal: boolean
}

const round4 = (x: number) => Math.round(x * 10000) / 10000

export function mediane(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  if (s.length === 0) return NaN
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** The yarn that makes `kgEcru` of écru. */
export function filPourEcru(kgEcru: number, taux: number): number {
  return taux < 1 ? kgEcru / (1 - taux) : kgEcru
}

/** Safety margin on top of the freinte when yarn is reserved or ordered for a client line
 *  (decision Vincent 2026-10-26: the old practice was +10 % ≈ freinte 3 % + 7 % margin). */
export const MARGE_SECURITE_FIL = 0.05
/** A yarn need is rounded up to a multiple of this (kg). */
export const ARRONDI_FIL_KG = 10

export interface BesoinFil {
  /** écru × part ÷ (1 − freinte) */
  fil: number
  /** × (1 + MARGE_SECURITE_FIL) */
  avecMarge: number
  /** rounded up to ARRONDI_FIL_KG — what is shown, reserved and ordered */
  besoin: number
}

/** The yarn to reserve / order so a line makes `kgEcru` of écru, for a yarn that is `part`
 *  (0..1) of the recipe: freinte, then safety margin, then rounded up to 10 kg.
 *  Launching a knitting order checks the freinte alone (filPourEcru), never this. */
export function besoinFil(kgEcru: number, taux: number, part = 1): BesoinFil {
  const fil = filPourEcru(Math.max(0, kgEcru) * part, taux)
  const avecMarge = fil * (1 + MARGE_SECURITE_FIL)
  // round4 first: 649.9999999 must not become 650 + one step.
  const besoin = avecMarge > 0 ? Math.ceil(round4(avecMarge) / ARRONDI_FIL_KG) * ARRONDI_FIL_KG : 0
  return { fil, avecMarge, besoin }
}

/** The écru `kgFil` of yarn makes. */
export function ecruPourFil(kgFil: number, taux: number): number {
  return kgFil * (1 - taux)
}

export function groupeDeMatiere(libelle: string): GroupeMatiere {
  const l = libelle.toLowerCase()
  if (/coton/.test(l)) return 'coton'
  if (/polyester|polyamide|polypropyl|elasthanne|élasthanne/.test(l)) return 'synthetique'
  if (/\blin\b|chanvre/.test(l)) return 'lin_chanvre'
  return 'autre'
}

// ── Pure: groups and measures ─────────────────────────────

export interface LotFreinte { id: number; lot: string; stockInitial: number; stock: number; termine: boolean }
export interface OfFreinte { id: number; ecru: number; date: string; sortie: number }
export interface LienFreinte { lot: number; of: number }

/** Every closed group of lots and OFs whose lots are all archived, as a measure, with the écrus it
 *  is credited to. */
export function mesurerGroupes(
  lots: readonly LotFreinte[], ofs: readonly OfFreinte[], liens: readonly LienFreinte[],
): { mesure: MesureFreinte; ecrus: number[] }[] {
  const parent = new Map<string, string>()
  const trouver = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    let c = x
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n }
    return r
  }
  const unir = (a: string, b: string) => {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = trouver(a), rb = trouver(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const l of liens) if (l.lot > 0 && l.of > 0) unir(`L${l.lot}`, `O${l.of}`)

  const groupes = new Map<string, { lots: number[]; ofs: number[] }>()
  for (const k of parent.keys()) {
    const r = trouver(k)
    const g = groupes.get(r) ?? { lots: [], ofs: [] }
    ;(k[0] === 'L' ? g.lots : g.ofs).push(Number(k.slice(1)))
    groupes.set(r, g)
  }
  const lotParId = new Map(lots.map((l) => [l.id, l]))
  const ofParId = new Map(ofs.map((o) => [o.id, o]))
  const out: { mesure: MesureFreinte; ecrus: number[] }[] = []
  for (const g of groupes.values()) {
    const ls = g.lots.map((id) => lotParId.get(id))
    if (ls.some((l) => !l || !l.termine)) continue
    const os = g.ofs.map((id) => ofParId.get(id)).filter((o): o is OfFreinte => !!o)
    const entree = ls.reduce((s, l) => s + l!.stockInitial - Math.max(0, l!.stock), 0)
    const sortie = os.reduce((s, o) => s + o.sortie, 0)
    if (!(entree > 0) || !(sortie > 0)) continue
    const taux = 1 - sortie / entree
    const date = os.reduce((m, o) => (o.date > m ? o.date : m), '')
    const parEcru = new Map<number, number>()
    for (const o of os) if (o.ecru > 0) parEcru.set(o.ecru, (parEcru.get(o.ecru) ?? 0) + o.sortie)
    const ecrus = [...parEcru].filter(([, kg]) => kg >= sortie * PART_MIN_ECRU).map(([e]) => e)
    out.push({
      mesure: {
        date, entree: round4(entree), sortie: round4(sortie), taux: round4(taux),
        lots: ls.map((l) => l!.lot).sort(), ofs: os.map((o) => o.id).sort((a, b) => a - b),
        valide: taux >= FREINTE_MIN && taux <= FREINTE_MAX && date >= FREINTE_DEPUIS,
      },
      ecrus,
    })
  }
  return out
}

/** The median of an écru's last valid measures, null under MESURES_MIN. */
export function freinteMesuree(mesures: readonly MesureFreinte[]): { taux: number | null; nb: number } {
  const valides = mesures.filter((m) => m.valide).sort((a, b) => b.date.localeCompare(a.date))
  if (valides.length < MESURES_MIN) return { taux: null, nb: valides.length }
  return { taux: round4(mediane(valides.slice(0, MESURES_RETENUES).map((m) => m.taux))), nb: valides.length }
}

/** Defaults per matière group and overall, from the measured écrus. */
export function defautsFreinte(mesurees: readonly { groupe: GroupeMatiere | null; taux: number }[]) {
  const global = mesurees.length >= REFS_MIN_DEFAUT
    ? { taux: round4(mediane(mesurees.map((m) => m.taux))), nb: mesurees.length }
    : { taux: FREINTE_REPLI, nb: 0 }
  const parGroupe = new Map<GroupeMatiere, { taux: number; nb: number }>()
  for (const g of Object.keys(LIBELLE_GROUPE) as GroupeMatiere[]) {
    const xs = mesurees.filter((m) => m.groupe === g).map((m) => m.taux)
    if (xs.length >= REFS_MIN_DEFAUT) parGroupe.set(g, { taux: round4(mediane(xs)), nb: xs.length })
  }
  return { global, parGroupe }
}

export function resoudreFreinte(p: {
  forcee: number | null
  mesures: readonly MesureFreinte[]
  groupe: GroupeMatiere | null
  defauts: ReturnType<typeof defautsFreinte>
}): FreinteEcru {
  const m = freinteMesuree(p.mesures)
  const dg = p.groupe ? p.defauts.parGroupe.get(p.groupe) : undefined
  const defaut = dg ?? p.defauts.global
  const base = {
    mesuree: m.taux, nbMesures: m.nb, defaut: defaut.taux, groupe: p.groupe,
    defautNbRefs: defaut.nb, defautGlobal: !dg,
  }
  if (p.forcee != null && Number.isFinite(p.forcee)) return { ...base, taux: p.forcee, source: 'forcee' }
  if (m.taux != null) return { ...base, taux: m.taux, source: 'mesuree' }
  return { ...base, taux: defaut.taux, source: 'defaut' }
}

// ── Reads (measures cached one hour: they move when a TRM lot is archived) ──

interface Etat {
  mesures: Map<number, MesureFreinte[]>
  groupes: Map<number, GroupeMatiere>
  defauts: ReturnType<typeof defautsFreinte>
}

const CACHE_MS = 60 * 60 * 1000
let cache: { le: number; etat: Promise<Etat> } | null = null

/** Drops the cache (tests, or after a manual check). */
export function oublierFreintes(): void { cache = null }

function etat(): Promise<Etat> {
  const now = Date.now()
  if (cache && now - cache.le < CACHE_MS) return cache.etat
  const p = chargerEtat()
  cache = { le: now, etat: p }
  p.catch(() => { if (cache?.etat === p) cache = null })
  return p
}

const jour = (d: unknown): string => {
  if (d instanceof Date) return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
  return String(d ?? '').slice(0, 10)
}

async function chargerEtat(): Promise<Etat> {
  const sql = mpsPg()
  const [lots, ofs, liens, matieres] = await Promise.all([
    sql<{ id: number; lot: string | null; stock_initial: number; stock: number; termine: number }[]>`
      SELECT idstock_fil AS id, lot, COALESCE(stock_initial, 0)::float8 AS stock_initial,
             COALESCE(stock, 0)::float8 AS stock, termine
        FROM stock_fil`,
    sql<{ id: number; ecru: number; date_creation: unknown; sortie: number }[]>`
      SELECT o.idordre_fabrication AS id, o.idref_ecru AS ecru, o.date_creation, COALESCE(p.kg, 0)::float8 AS sortie
        FROM ordre_fabrication o
        LEFT JOIN (SELECT idordre_fabrication, SUM(poids) AS kg FROM stock_ecru
                    WHERE idordre_fabrication > 0 GROUP BY idordre_fabrication) p
               ON p.idordre_fabrication = o.idordre_fabrication`,
    sql<{ lot: number; of: number }[]>`
      SELECT idstock_fil AS lot, idordre_fabrication AS of FROM asso_fil_of WHERE idstock_fil > 0 AND idordre_fabrication > 0
      UNION
      SELECT idstock_fil, idordre_fabrication FROM fil_incorpore WHERE idstock_fil > 0 AND idordre_fabrication > 0`,
    // The écru's matière mix: its yarns' shares × each yarn's matières (asso_fil_matiere is a 0..1 fraction).
    sql<{ ecru: number; libelle: string | null; part: number }[]>`
      SELECT c.idref_ecru AS ecru, m.libelle, SUM(c.pourcentage / 100.0 * a.pourcentage)::float8 AS part
        FROM (SELECT DISTINCT ON (idref_ecru, idref_fil) idref_ecru, idref_fil, pourcentage
                FROM composition_ecru WHERE idref_fil > 0 AND pourcentage > 0
               ORDER BY idref_ecru, idref_fil, idcolori_ecru) c
        JOIN asso_fil_matiere a ON a.idref_fil = c.idref_fil
        JOIN matiere_premiere m ON m.idmatiere_premiere = a.idmatiere
       GROUP BY c.idref_ecru, m.libelle`,
  ])
  const groupes = mesurerGroupes(
    lots.map((l) => ({
      id: Number(l.id), lot: String(l.lot ?? '').trim(), stockInitial: Number(l.stock_initial) || 0,
      stock: Number(l.stock) || 0, termine: Number(l.termine) === 1,
    })),
    ofs.map((o) => ({ id: Number(o.id), ecru: Number(o.ecru) || 0, date: jour(o.date_creation), sortie: Number(o.sortie) || 0 })),
    liens.map((l) => ({ lot: Number(l.lot), of: Number(l.of) })),
  )
  const mesures = new Map<number, MesureFreinte[]>()
  for (const g of groupes) {
    for (const e of g.ecrus) {
      const arr = mesures.get(e) ?? []
      arr.push(g.mesure)
      mesures.set(e, arr)
    }
  }
  for (const arr of mesures.values()) arr.sort((a, b) => a.date.localeCompare(b.date))

  const parts = new Map<number, Map<GroupeMatiere, number>>()
  for (const r of matieres) {
    const e = Number(r.ecru)
    const m = parts.get(e) ?? new Map<GroupeMatiere, number>()
    const g = groupeDeMatiere(String(r.libelle ?? ''))
    m.set(g, (m.get(g) ?? 0) + (Number(r.part) || 0))
    parts.set(e, m)
  }
  const groupesEcru = new Map<number, GroupeMatiere>()
  for (const [e, m] of parts) {
    const top = [...m].sort((a, b) => b[1] - a[1])[0]
    if (top && top[1] > 0) groupesEcru.set(e, top[0])
  }

  const mesurees: { groupe: GroupeMatiere | null; taux: number }[] = []
  for (const [e, arr] of mesures) {
    const m = freinteMesuree(arr)
    if (m.taux != null) mesurees.push({ groupe: groupesEcru.get(e) ?? null, taux: m.taux })
  }
  return { mesures, groupes: groupesEcru, defauts: defautsFreinte(mesurees) }
}

async function forcees(ids: readonly number[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>()
  if (ids.length === 0) return out
  const rows = await mpsPg()<{ id: number; f: number | null }[]>`
    SELECT idref_ecru AS id, freinte_tricotage::float8 AS f FROM ref_ecru WHERE idref_ecru = ANY(${ids as number[]})`
  for (const r of rows) out.set(Number(r.id), r.f == null ? null : Number(r.f))
  return out
}

/** The freinte of each écru (0 or a missing id → the overall default, never an error). */
export async function freintesTricotage(ids: readonly number[]): Promise<Map<number, FreinteEcru>> {
  const uniq = [...new Set(ids.filter((x) => x > 0))]
  const [e, f] = await Promise.all([etat(), forcees(uniq)])
  const out = new Map<number, FreinteEcru>()
  for (const id of uniq) {
    out.set(id, resoudreFreinte({
      forcee: f.get(id) ?? null, mesures: e.mesures.get(id) ?? [], groupe: e.groupes.get(id) ?? null, defauts: e.defauts,
    }))
  }
  return out
}

export async function freinteTricotage(id: number): Promise<FreinteEcru> {
  if (id > 0) {
    const m = await freintesTricotage([id])
    const f = m.get(id)
    if (f) return f
  }
  const e = await etat()
  return resoudreFreinte({ forcee: null, mesures: [], groupe: null, defauts: e.defauts })
}

/** The fiche's « Freinte tricotage » drawer: the value and every measure behind it. */
export async function detailFreinteTricotage(id: number): Promise<FreinteEcru & { mesures: MesureFreinte[] }> {
  const [f, e] = await Promise.all([freinteTricotage(id), etat()])
  return { ...f, mesures: e.mesures.get(id) ?? [] }
}

/** One line to say where the value comes from (fiche, Fil tab, tarif). */
export function origineFreinte(f: FreinteEcru): string {
  const pct = (x: number) => `${(x * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`
  if (f.source === 'forcee') return 'valeur forcée sur la fiche'
  if (f.source === 'mesuree') return `mesurée sur ${f.nbMesures} bilan${f.nbMesures > 1 ? 's' : ''} de lots`
  if (f.defautNbRefs === 0) return `valeur par défaut (${pct(f.defaut)})`
  return f.defautGlobal || !f.groupe
    ? `par défaut : médiane de ${f.defautNbRefs} réf. mesurées`
    : `par défaut : médiane des réf. ${LIBELLE_GROUPE[f.groupe]} (${f.defautNbRefs})`
}
