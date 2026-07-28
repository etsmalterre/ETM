// "Calcul de la valeur" — cost valuation of the stock pieces attached to a
// donation commande client. Port of the legacy WinDev report
// `ETAT_ValeurDonation` (printed as DON<numero>.pdf), reconstructed from the
// live data behind commande numero 3693 (all four of its pieces reproduce to
// the cent — see apps/api/src/scripts/verify-donation-valeur.ts).
//
// Per piece (an écru roll or a fini roll attached via IDcommande_donation):
//
//   €/kg = Σ (composition % × yarn lot purchase price)   ← fil
//        + ref_ecru.prix                                  ← tricotage
//        + teinture band price      (dyed fini only)
//        + Σ traitement band prices (fini only)
//   valeur = €/kg × the piece's own weight
//
// Notes on each term:
//  - **fil**: the yarn lines come from the piece's OF (`asso_fil_of`), which
//    gives the affected lot (`stock_fil`) and its share (`pourcentage`). The
//    price is the lot's *purchase* price — `ref_fil_commande.prix_unitaire` of
//    the commande fil line it was received on — NOT `ref_fil.prix_kg`. The
//    label follows the LOT's coloris, which can differ from the composition's
//    (OF 988 knits ref 003 "ecru" from a *noir* lot of 167/48/1 PES FR).
//  - **uncovered composition rows**: a `composition_ecru` row with no matching
//    affected lot prints as a "?" line and makes the whole piece unpriceable
//    (legacy prints "?" for its €/kg and valeur, and leaves it out of the
//    document total). Same when an affected lot has no purchase price.
//  - **weights**: yarn and operation lines are computed on the *écru* weight
//    (for a fini piece: its source `stock_ecru.poids`, i.e. before the finishing
//    weight change), while the piece valeur uses the piece's own weight.
//  - **ennoblissement**: prices come from the company tariff grid
//    (`tranche_tarif_ennoblissement` with `IDsous_traitant = 0`), NOT from what
//    the ennoblisseur was actually paid on its commande line. Bands are read at
//    a fixed reference weight (see TARIF_BAND_WEIGHT_KG).
//
// HFSQL: flat queries + JS merge (no JOIN + CONVERT), only ASCII columns named,
// `fixEncoding` on every label, ids interpolated after parseInt.

import { query, fixEncoding } from './hfsql-auto.js'

/** Weight (kg) the ennoblissement tariff bands are read at. The legacy report
 *  prices every treatment / dye at one fixed reference quantity rather than the
 *  piece's own weight: piece 2381/10 (15,3 kg) and 2114/194 (20,8 kg) both come
 *  out on the 181-200 kg band in DON3693. Do not swap this for the piece weight
 *  — it would change every valuation. */
const TARIF_BAND_WEIGHT_KG = 200

/** Legacy resolves a fini piece's dye from `ref_fini_colori` keyed on
 *  `stock_fini.IDColoris` without checking `ref_fini.avec_teinture` first. For a
 *  wash reference (`avec_teinture = 0`) that id is a `colori_ecru` id, and the
 *  two id spaces collide: piece 2381/10 (ref 007A, wash, coloris 895) picks up
 *  the teinture of `ref_fini_colori` 895, which belongs to ref_fini 4 — adding
 *  6,17 €/kg of dyeing to a fabric that is never dyed (+55 % on that piece).
 *  We keep the dye term only when the coloris row really belongs to the piece's
 *  own reference. Set to `true` to reproduce the legacy figures verbatim. */
const LEGACY_TEINTURE_COLLISION = false

/** Round to cents the way the legacy report does (half-up on the exact decimal
 *  value). A plain `Math.round(v * 100)` rounds 20,5 × 2,07 down to 42,43
 *  because the float lands on 4243.4999999999995; `toPrecision(12)` snaps that
 *  back to 4243.5 first, giving legacy's 42,44. Exported so the PDF formats
 *  every figure through the same rule. */
export function roundEuro(v: number): number {
  return Math.round(Number((v * 100).toPrecision(12))) / 100
}

function formatHfsqlDateFr(raw: string | null | undefined): string {
  const s = (raw ?? '').toString().trim()
  if (!/^\d{8}$/.test(s)) return ''
  return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`
}

function todayHfsql(): string {
  const d = new Date()
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

const MONTHS_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
]

function formatHfsqlDateLongFr(raw: string): string {
  if (!/^\d{8}$/.test(raw)) return ''
  return `${Number(raw.slice(6, 8))} ${MONTHS_FR[Number(raw.slice(4, 6)) - 1]} ${raw.slice(0, 4)}`
}

// ── Public shapes ─────────────────────────────────────────

/** One cost line of a piece — a yarn component or a production operation. */
export interface DvLine {
  /** 'fil' rows carry a lot + commande fil, 'operation' rows a date. */
  kind: 'fil' | 'operation'
  /** "167/48/1 PES FR - noir" or "Tricotage de la référence" / "Vaporisage". */
  label: string
  /** Middle column: "Lot 8807" (fil) or "Le 28/07/2026" (operation). */
  detail: string
  /** Right-of-middle column: "Commande fil N° 418" (fil only). */
  detail2: string
  /** kg — null when unknown (rendered "?"). */
  poids: number | null
  /** €/kg — null when unknown. */
  prixKg: number | null
  /** € — null when unknown. */
  total: number | null
}

export interface DvPiece {
  kind: 'ecru' | 'fini'
  /** "003 - ecru" (reference · coloris). */
  refLabel: string
  /** stock_ecru.numero / stock_fini.numero, e.g. "988/10". */
  numero: string
  /** The piece's own weight (kg) — the valeur is €/kg × this. */
  poids: number
  /** null when any component is unknown — legacy prints "?" and skips it. */
  prixKg: number | null
  total: number | null
  lines: DvLine[]
}

export interface DonationValeurPdfData {
  /** commande_client.numero — the "Donation N° X" the legacy report prints. */
  numero: string
  /** commande_client.donation — the document only makes sense when set; the
   *  route refuses to print it otherwise (a normal order carries lignes, not
   *  attached pieces, so the valuation would come out empty). */
  isDonation: boolean
  /** Generation date, long French form, for the document header. */
  dateLong: string
  clientNom: string
  pieces: DvPiece[]
  /** Σ of the priceable pieces' valeur. */
  totalValeur: number
}

// ── Internal row shapes ───────────────────────────────────

interface CompRow { IDref_fil: number; IDcolori_fil: number; pourcentage: number }
interface AssoRow { IDref_fil: number; IDcolori_fil: number; pourcentage: number; IDstock_fil: number }
interface LotRow { IDstock_fil: number; IDref_fil: number; IDcolori_fil: number; IDref_fil_commande: number; lot: string }
interface CmdFilRow { IDcommande_fil: number; prix_unitaire: number }
interface BandRow { IDtraitement: number; IDteinture: number; quantite_mini: number; quantite_maxi: number; prix: number }

/** Tariff band covering `poids` (mini ≤ poids ≤ maxi), 0 when none does —
 *  legacy treats an unpriced treatment as free, and several really are
 *  (Vaporisage, Rame). */
function bandPrix(bands: BandRow[], poids: number): number {
  for (const b of bands) {
    if (Number(b.quantite_mini) <= poids && Number(b.quantite_maxi) >= poids) return Number(b.prix) || 0
  }
  return 0
}

async function labelMap(
  table: string, pk: string, ids: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const uniq = Array.from(new Set(ids.filter((n) => n > 0)))
  if (uniq.length === 0) return out
  const rows = await query<any>(`SELECT ${pk}, reference FROM ${table} WHERE ${pk} IN (${uniq.join(',')})`)
  const fixed = await fixEncoding(rows as any[], table, pk, ['reference'])
  for (const r of fixed as any[]) out.set(Number(r[pk]), (r.reference ?? '').toString().trim())
  return out
}

// ── Builder ───────────────────────────────────────────────

export async function buildDonationValeurData(commandeId: number): Promise<DonationValeurPdfData | null> {
  const id = Math.trunc(commandeId)
  if (!(id > 0)) return null

  const hdr = await query<{ numero: number | null; IDclient: number; donation: number | null }>(
    `SELECT numero, IDclient, donation FROM commande_client WHERE IDcommande_client = ${id}`,
  )
  if (hdr.length === 0) return null
  const numero = String(hdr[0].numero ?? id)
  const IDclient = Number(hdr[0].IDclient) || 0

  let clientNom = ''
  if (IDclient > 0) {
    const cli = await query<{ IDclient: number; nom: string | null }>(
      `SELECT IDclient, nom FROM client WHERE IDclient = ${IDclient}`,
    )
    const fixedCli = await fixEncoding(cli, 'client', 'IDclient', ['nom'])
    clientNom = ((fixedCli[0] as any)?.nom ?? '').toString().trim()
  }

  // ── Attached pieces ────────────────────────────────────
  const [ecruPieces, finiPieces] = await Promise.all([
    query<{ IDstock_ecru: number; numero: string | null; poids: number | null; IDref_ecru: number; IDcolori_ecru: number; IDordre_fabrication: number }>(
      `SELECT IDstock_ecru, numero, poids, IDref_ecru, IDcolori_ecru, IDordre_fabrication
         FROM stock_ecru WHERE IDcommande_donation = ${id}`,
    ),
    query<{ IDstock_fini: number; numero: string | null; poids: number | null; IDref_fini: number; IDColoris: number; IDstock_ecru: number }>(
      `SELECT IDstock_fini, numero, poids, IDref_fini, IDColoris, IDstock_ecru
         FROM stock_fini WHERE IDcommande_donation = ${id}`,
    ),
  ])

  // Source écru rolls of the fini pieces — they carry the OF (yarn lots) and
  // the pre-finishing weight the cost lines are computed on.
  const srcIds = finiPieces.map((f) => Number(f.IDstock_ecru) || 0).filter((n) => n > 0)
  const srcById = new Map<number, { poids: number; IDref_ecru: number; IDcolori_ecru: number; IDordre_fabrication: number }>()
  if (srcIds.length > 0) {
    const rows = await query<any>(
      `SELECT IDstock_ecru, poids, IDref_ecru, IDcolori_ecru, IDordre_fabrication
         FROM stock_ecru WHERE IDstock_ecru IN (${Array.from(new Set(srcIds)).join(',')})`,
    )
    for (const r of rows) {
      srcById.set(Number(r.IDstock_ecru), {
        poids: Number(r.poids) || 0,
        IDref_ecru: Number(r.IDref_ecru) || 0,
        IDcolori_ecru: Number(r.IDcolori_ecru) || 0,
        IDordre_fabrication: Number(r.IDordre_fabrication) || 0,
      })
    }
  }

  // ── Reference-level context (batched) ──────────────────
  const finiRefIds = Array.from(new Set(finiPieces.map((f) => Number(f.IDref_fini) || 0).filter((n) => n > 0)))
  const finiRefById = new Map<number, { reference: string; avec_teinture: number; IDref_ecru: number; IDcolori_ecru: number }>()
  if (finiRefIds.length > 0) {
    const rows = await query<any>(
      `SELECT IDref_fini, reference, avec_teinture, IDref_ecru, IDcolori_ecru
         FROM ref_fini WHERE IDref_fini IN (${finiRefIds.join(',')})`,
    )
    const fixed = await fixEncoding(rows as any[], 'ref_fini', 'IDref_fini', ['reference'])
    for (const r of fixed as any[]) {
      finiRefById.set(Number(r.IDref_fini), {
        reference: (r.reference ?? '').toString().trim(),
        avec_teinture: Number(r.avec_teinture) || 0,
        IDref_ecru: Number(r.IDref_ecru) || 0,
        IDcolori_ecru: Number(r.IDcolori_ecru) || 0,
      })
    }
  }

  // Every écru reference involved: pieces + the fini pieces' source rolls
  // (falling back to ref_fini.IDref_ecru when a fini has no source roll).
  const ecruRefIds = new Set<number>()
  for (const e of ecruPieces) ecruRefIds.add(Number(e.IDref_ecru) || 0)
  for (const f of finiPieces) {
    const src = srcById.get(Number(f.IDstock_ecru) || 0)
    ecruRefIds.add(src ? src.IDref_ecru : (finiRefById.get(Number(f.IDref_fini) || 0)?.IDref_ecru ?? 0))
  }
  const ecruRefById = new Map<number, { reference: string; prix: number }>()
  const ecruRefList = Array.from(ecruRefIds).filter((n) => n > 0)
  if (ecruRefList.length > 0) {
    const rows = await query<any>(
      `SELECT IDref_ecru, reference, prix FROM ref_ecru WHERE IDref_ecru IN (${ecruRefList.join(',')})`,
    )
    const fixed = await fixEncoding(rows as any[], 'ref_ecru', 'IDref_ecru', ['reference'])
    for (const r of fixed as any[]) {
      ecruRefById.set(Number(r.IDref_ecru), {
        reference: (r.reference ?? '').toString().trim(),
        prix: Number(r.prix) || 0,
      })
    }
  }

  // Compositions for every (ref_ecru, colori_ecru) pair in play, plus the base
  // (colori 0) rows used as the legacy fallback when a coloris has none.
  const compByKey = new Map<string, CompRow[]>()
  if (ecruRefList.length > 0) {
    const rows = await query<any>(
      `SELECT IDref_ecru, IDcolori_ecru, IDref_fil, IDcolori_fil, pourcentage
         FROM composition_ecru WHERE IDref_ecru IN (${ecruRefList.join(',')})`,
    )
    for (const r of rows) {
      const key = `${Number(r.IDref_ecru) || 0}:${Number(r.IDcolori_ecru) || 0}`
      const arr = compByKey.get(key) ?? []
      arr.push({
        IDref_fil: Number(r.IDref_fil) || 0,
        IDcolori_fil: Number(r.IDcolori_fil) || 0,
        pourcentage: Number(r.pourcentage) || 0,
      })
      compByKey.set(key, arr)
    }
  }
  const composition = (refEcru: number, coloriEcru: number): CompRow[] => {
    const own = compByKey.get(`${refEcru}:${coloriEcru}`)
    if (own && own.length > 0) return own
    return compByKey.get(`${refEcru}:0`) ?? []
  }

  // Yarn affectations of every OF in play → lots → purchase lines.
  const ofIds = new Set<number>()
  for (const e of ecruPieces) ofIds.add(Number(e.IDordre_fabrication) || 0)
  for (const f of finiPieces) {
    const src = srcById.get(Number(f.IDstock_ecru) || 0)
    if (src) ofIds.add(src.IDordre_fabrication)
  }
  const ofList = Array.from(ofIds).filter((n) => n > 0)
  const assoByOf = new Map<number, AssoRow[]>()
  if (ofList.length > 0) {
    const rows = await query<any>(
      `SELECT IDordre_fabrication, IDref_fil, IDcolori_fil, pourcentage, IDstock_fil
         FROM asso_fil_of WHERE IDordre_fabrication IN (${ofList.join(',')})`,
    )
    for (const r of rows) {
      const of = Number(r.IDordre_fabrication) || 0
      const arr = assoByOf.get(of) ?? []
      arr.push({
        IDref_fil: Number(r.IDref_fil) || 0,
        IDcolori_fil: Number(r.IDcolori_fil) || 0,
        pourcentage: Number(r.pourcentage) || 0,
        IDstock_fil: Number(r.IDstock_fil) || 0,
      })
      assoByOf.set(of, arr)
    }
  }

  const lotIds = Array.from(new Set([...assoByOf.values()].flat().map((a) => a.IDstock_fil).filter((n) => n > 0)))
  const lotById = new Map<number, LotRow>()
  if (lotIds.length > 0) {
    // stock_fil: never SELECT * and never name the certif_* block — either
    // silently returns 0 rows on Windows (project-stock-fil-poisoned-select).
    const rows = await query<any>(
      `SELECT IDstock_fil, IDref_fil, IDcolori_fil, IDref_fil_commande, lot
         FROM stock_fil WHERE IDstock_fil IN (${lotIds.join(',')})`,
    )
    const fixed = await fixEncoding(rows as any[], 'stock_fil', 'IDstock_fil', ['lot'])
    for (const r of fixed as any[]) {
      lotById.set(Number(r.IDstock_fil), {
        IDstock_fil: Number(r.IDstock_fil),
        IDref_fil: Number(r.IDref_fil) || 0,
        IDcolori_fil: Number(r.IDcolori_fil) || 0,
        IDref_fil_commande: Number(r.IDref_fil_commande) || 0,
        lot: (r.lot ?? '').toString().trim(),
      })
    }
  }

  const cmdLineIds = Array.from(new Set([...lotById.values()].map((l) => l.IDref_fil_commande).filter((n) => n > 0)))
  const cmdFilByLine = new Map<number, CmdFilRow>()
  if (cmdLineIds.length > 0) {
    const rows = await query<any>(
      `SELECT IDref_fil_commande, IDcommande_fil, prix_unitaire
         FROM ref_fil_commande WHERE IDref_fil_commande IN (${cmdLineIds.join(',')})`,
    )
    for (const r of rows) {
      cmdFilByLine.set(Number(r.IDref_fil_commande), {
        IDcommande_fil: Number(r.IDcommande_fil) || 0,
        prix_unitaire: Number(r.prix_unitaire) || 0,
      })
    }
  }

  // Labels: yarn refs / yarn coloris / écru coloris / fini coloris.
  const filIds: number[] = []
  const coloriFilIds: number[] = []
  for (const rows of compByKey.values()) {
    for (const c of rows) { filIds.push(c.IDref_fil); coloriFilIds.push(c.IDcolori_fil) }
  }
  for (const l of lotById.values()) { filIds.push(l.IDref_fil); coloriFilIds.push(l.IDcolori_fil) }

  const coloriEcruIds: number[] = []
  for (const e of ecruPieces) coloriEcruIds.push(Number(e.IDcolori_ecru) || 0)
  const coloriFiniIds: number[] = []
  for (const f of finiPieces) {
    const ref = finiRefById.get(Number(f.IDref_fini) || 0)
    const colId = Number(f.IDColoris) || 0
    if (ref && ref.avec_teinture !== 0) coloriFiniIds.push(colId)
    else coloriEcruIds.push(colId)
  }

  const [filNames, coloriFilNames, coloriEcruNames, coloriFiniNames] = await Promise.all([
    labelMap('ref_fil', 'IDref_fil', filIds),
    labelMap('colori_fil', 'IDcolori_fil', coloriFilIds),
    labelMap('colori_ecru', 'IDcolori_ecru', coloriEcruIds),
    labelMap('ref_fini_colori', 'IDref_fini_colori', coloriFiniIds),
  ])

  // Treatments of every fini reference, in the legacy print order (the order
  // they were attached to the reference, i.e. IDtraitement_ref_fini ascending).
  const trtByRefFini = new Map<number, number[]>()
  const traitementIds = new Set<number>()
  if (finiRefIds.length > 0) {
    const rows = await query<any>(
      `SELECT IDtraitement_ref_fini, IDref_fini, IDtraitement
         FROM traitement_ref_fini WHERE IDref_fini IN (${finiRefIds.join(',')})
         ORDER BY IDtraitement_ref_fini`,
    )
    for (const r of rows) {
      const ref = Number(r.IDref_fini) || 0
      const trt = Number(r.IDtraitement) || 0
      if (trt <= 0) continue
      const arr = trtByRefFini.get(ref) ?? []
      arr.push(trt)
      trtByRefFini.set(ref, arr)
      traitementIds.add(trt)
    }
  }

  const traitementNames = new Map<number, string>()
  const bandsByTraitement = new Map<number, BandRow[]>()
  if (traitementIds.size > 0) {
    const ids = Array.from(traitementIds).join(',')
    const [trtRows, bandRows] = await Promise.all([
      query<any>(`SELECT IDtraitement, designation FROM traitement WHERE IDtraitement IN (${ids})`),
      query<BandRow>(
        `SELECT IDtraitement, IDteinture, quantite_mini, quantite_maxi, prix
           FROM tranche_tarif_ennoblissement WHERE IDsous_traitant = 0 AND IDtraitement IN (${ids})`,
      ),
    ])
    const fixedTrt = await fixEncoding(trtRows as any[], 'traitement', 'IDtraitement', ['designation'])
    for (const r of fixedTrt as any[]) traitementNames.set(Number(r.IDtraitement), (r.designation ?? '').toString().trim())
    for (const b of bandRows) {
      const k = Number(b.IDtraitement) || 0
      const arr = bandsByTraitement.get(k) ?? []
      arr.push(b)
      bandsByTraitement.set(k, arr)
    }
  }

  // Dye of each fini coloris (dyed references only — see
  // LEGACY_TEINTURE_COLLISION for the wash-reference id collision).
  const teintureByColoris = new Map<number, number>()
  const teintureIds = new Set<number>()
  const colorisLookupIds = LEGACY_TEINTURE_COLLISION
    ? Array.from(new Set(finiPieces.map((f) => Number(f.IDColoris) || 0).filter((n) => n > 0)))
    : coloriFiniIds.filter((n) => n > 0)
  if (colorisLookupIds.length > 0) {
    const rows = await query<any>(
      `SELECT IDref_fini_colori, IDref_fini, IDteinture
         FROM ref_fini_colori WHERE IDref_fini_colori IN (${Array.from(new Set(colorisLookupIds)).join(',')})`,
    )
    for (const r of rows) {
      const t = Number(r.IDteinture) || 0
      if (t <= 0) continue
      teintureByColoris.set(Number(r.IDref_fini_colori), t)
      teintureIds.add(t)
    }
  }
  const teintureNames = new Map<number, string>()
  const bandsByTeinture = new Map<number, BandRow[]>()
  if (teintureIds.size > 0) {
    const ids = Array.from(teintureIds).join(',')
    const [teRows, bandRows] = await Promise.all([
      query<any>(`SELECT IDteinture, designation_externe FROM teinture WHERE IDteinture IN (${ids})`),
      query<BandRow>(
        `SELECT IDtraitement, IDteinture, quantite_mini, quantite_maxi, prix
           FROM tranche_tarif_ennoblissement WHERE IDsous_traitant = 0 AND IDteinture IN (${ids})`,
      ),
    ])
    const fixedTe = await fixEncoding(teRows as any[], 'teinture', 'IDteinture', ['designation_externe'])
    for (const r of fixedTe as any[]) teintureNames.set(Number(r.IDteinture), (r.designation_externe ?? '').toString().trim())
    for (const b of bandRows) {
      const k = Number(b.IDteinture) || 0
      const arr = bandsByTeinture.get(k) ?? []
      arr.push(b)
      bandsByTeinture.set(k, arr)
    }
  }

  // ── Line assembly ─────────────────────────────────────
  const opDate = `Le ${formatHfsqlDateFr(todayHfsql())}`

  /** Yarn lines for one piece: one per affected lot (biggest share first),
   *  then one "?" line per composition row no lot covers. */
  function filLines(refEcru: number, coloriEcru: number, ofId: number, basisWeight: number): DvLine[] {
    const asso = (assoByOf.get(ofId) ?? []).slice().sort((a, b) => b.pourcentage - a.pourcentage)
    const covered = new Set<string>()
    const lines: DvLine[] = []

    for (const a of asso) {
      const lot = lotById.get(a.IDstock_fil) ?? null
      const refFilId = lot && lot.IDref_fil > 0 ? lot.IDref_fil : a.IDref_fil
      const coloriId = lot && lot.IDcolori_fil > 0 ? lot.IDcolori_fil : a.IDcolori_fil
      covered.add(`${refFilId}:${coloriId}`)
      const cmd = lot ? cmdFilByLine.get(lot.IDref_fil_commande) ?? null : null
      const poids = basisWeight * (a.pourcentage / 100)
      const prixKg = cmd ? cmd.prix_unitaire : null
      lines.push({
        kind: 'fil',
        label: [filNames.get(refFilId) ?? '', coloriFilNames.get(coloriId) ?? ''].filter((s) => s).join(' - '),
        detail: lot && lot.lot ? `Lot ${lot.lot}` : '?',
        detail2: cmd ? `Commande fil N° ${cmd.IDcommande_fil}` : '?',
        poids: a.pourcentage > 0 ? poids : null,
        prixKg,
        total: prixKg !== null && a.pourcentage > 0 ? poids * prixKg : null,
      })
    }

    for (const c of composition(refEcru, coloriEcru)) {
      if (covered.has(`${c.IDref_fil}:${c.IDcolori_fil}`)) continue
      lines.push({
        kind: 'fil',
        label: [filNames.get(c.IDref_fil) ?? '', coloriFilNames.get(c.IDcolori_fil) ?? ''].filter((s) => s).join(' - '),
        detail: '?', detail2: '?', poids: null, prixKg: null, total: null,
      })
    }
    return lines
  }

  function operationLine(label: string, prixKg: number, basisWeight: number): DvLine {
    return {
      kind: 'operation', label, detail: opDate, detail2: '',
      poids: basisWeight, prixKg, total: basisWeight * prixKg,
    }
  }

  /** €/kg + valeur from the assembled lines. Any unknown component makes the
   *  whole piece unpriceable, exactly like the legacy "?" rows. */
  function pricePiece(lines: DvLine[], basisWeight: number, piecePoids: number): { prixKg: number | null; total: number | null } {
    if (!(basisWeight > 0)) return { prixKg: null, total: null }
    let sum = 0
    for (const l of lines) {
      if (l.total === null) return { prixKg: null, total: null }
      sum += l.total
    }
    const prixKg = sum / basisWeight
    return { prixKg, total: prixKg * piecePoids }
  }

  const pieces: DvPiece[] = []

  for (const e of ecruPieces) {
    const refEcru = Number(e.IDref_ecru) || 0
    const coloriEcru = Number(e.IDcolori_ecru) || 0
    const poids = Number(e.poids) || 0
    const ref = ecruRefById.get(refEcru)
    const lines = filLines(refEcru, coloriEcru, Number(e.IDordre_fabrication) || 0, poids)
    // An écru roll stops at the knitting stage — no ennoblissement.
    lines.push(operationLine('Tricotage de la référence', ref?.prix ?? 0, poids))
    const { prixKg, total } = pricePiece(lines, poids, poids)
    pieces.push({
      kind: 'ecru',
      refLabel: [ref?.reference ?? '', coloriEcruNames.get(coloriEcru) ?? ''].filter((s) => s).join(' - '),
      numero: (e.numero ?? '').toString().trim() || String(e.IDstock_ecru),
      poids, prixKg, total, lines,
    })
  }

  for (const f of finiPieces) {
    const refFiniId = Number(f.IDref_fini) || 0
    const ref = finiRefById.get(refFiniId)
    const colorisId = Number(f.IDColoris) || 0
    const src = srcById.get(Number(f.IDstock_ecru) || 0) ?? null
    const piecePoids = Number(f.poids) || 0
    // Cost lines run on the écru weight (before the finishing weight change);
    // without a source roll we fall back to the piece's own weight.
    const basisWeight = src && src.poids > 0 ? src.poids : piecePoids
    const refEcru = src ? src.IDref_ecru : (ref?.IDref_ecru ?? 0)
    const coloriEcru = src ? src.IDcolori_ecru : (ref?.IDcolori_ecru ?? 0)

    const lines = filLines(refEcru, coloriEcru, src?.IDordre_fabrication ?? 0, basisWeight)
    lines.push(operationLine('Tricotage de la référence', ecruRefById.get(refEcru)?.prix ?? 0, basisWeight))

    const teintureId = teintureByColoris.get(colorisId) ?? 0
    if (teintureId > 0) {
      lines.push(operationLine(
        teintureNames.get(teintureId) ?? 'Teinture',
        bandPrix(bandsByTeinture.get(teintureId) ?? [], TARIF_BAND_WEIGHT_KG),
        basisWeight,
      ))
    }
    for (const trt of trtByRefFini.get(refFiniId) ?? []) {
      lines.push(operationLine(
        traitementNames.get(trt) ?? '',
        bandPrix(bandsByTraitement.get(trt) ?? [], TARIF_BAND_WEIGHT_KG),
        basisWeight,
      ))
    }

    const { prixKg, total } = pricePiece(lines, basisWeight, piecePoids)
    const colorisLabel = ref && ref.avec_teinture !== 0
      ? coloriFiniNames.get(colorisId) ?? ''
      : coloriEcruNames.get(colorisId) ?? ''
    pieces.push({
      kind: 'fini',
      refLabel: [ref?.reference ?? '', colorisLabel].filter((s) => s).join(' - '),
      numero: (f.numero ?? '').toString().trim() || String(f.IDstock_fini),
      poids: piecePoids, prixKg, total, lines,
    })
  }

  // Écru rolls first, then fini rolls, each by reference then piece number —
  // mirrors the order of the donation pieces list in the app.
  const byRefThenNumero = (a: DvPiece, b: DvPiece) =>
    a.refLabel.localeCompare(b.refLabel, 'fr') || a.numero.localeCompare(b.numero, 'fr', { numeric: true })
  const ordered = [
    ...pieces.filter((p) => p.kind === 'ecru').sort(byRefThenNumero),
    ...pieces.filter((p) => p.kind === 'fini').sort(byRefThenNumero),
  ]

  return {
    numero,
    isDonation: Number(hdr[0].donation) === 1,
    dateLong: formatHfsqlDateLongFr(todayHfsql()),
    clientNom,
    pieces: ordered,
    totalValeur: roundEuro(ordered.reduce((s, p) => s + (p.total ?? 0), 0)),
  }
}
