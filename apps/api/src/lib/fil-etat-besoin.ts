// « Besoin » of the État des stocks de fil widget — LIVA #1139.
//
// The reservation (`asso_fil_lignecmdsst.quantite`) is written once, when the
// yarn is affected to a tricoteur line, and never reduced while the order
// runs. But visitage decrements `stock_fil.stock` at every pesage (poids ×
// the lot's `asso_fil_of.pourcentage`), so a knitted kilo leaves « En stock »
// immediately while still sitting in « Besoin » → counted twice. Measured on
// prod 2026-09-10: lot 10553 had consumed 6 692 kg, the widget still needed
// 11 336 kg and announced a 1 349 kg rupture where ~8 600 kg were available.
//
// Fix: per open line, remaining = max(0, reserved − produced), where produced
// is what the line's OFs already knitted, apportioned to THIS fil/coloris by
// the OF's own composition (`asso_fil_of`). The chain is the ETM↔TRM bridge:
// sst line → mirror `ligne_commande_client.IDligne_commande_ETM` →
// `ordre_fabrication.IDligne_commande_client` → `stock_ecru.IDordre_fabrication`.
//
// Only lines with a TRM mirror are tracked (`suivi`): an external tricoteur's
// consumption never touches `stock_fil.stock` in this app, so deducting its
// received pieces would under-count — its reservation stays whole.
//
// LIVA #1159 (2026-09-14): the affectation is an ETM planning step the TRM
// side does not depend on — the OF dialog picks its lots on its own
// (`asso_fil_of`), and visitage decrements them all the same. On prod that
// day 9 of the 16 (line, fil) pairs being knitted on open Tricotage Malterre
// orders had NO reservation at all (sst 9032: 3 000 kg launched on three OFs,
// invisible to the widget). So a line with OFs consuming this fil but no
// affectation still needs it: its reserve is DERIVED — line quantity × the
// OFs' share of this fil (weighted by OF quantity), which is exactly what
// « Affecter » would have written — and flagged `source: 'of'`.
//
// Pure: the route feeds it flat query results, the test feeds it the #1139
// and #1159 prod figures.

export interface AssoRow {
  ligne: number
  commande_sst: number
  lot: string
  quantite: number
}

export interface MirrorLine {
  IDligne_commande_client: number
  IDligne_commande_ETM: number
}

export interface OfRow {
  IDordre_fabrication: number
  IDligne_commande_client: number
  /** OF quantity (kg) — weights the OF's share when the reserve is derived. */
  quantite?: number
}

/** Open tricoteur lines whose OFs consume this fil (#1159) — the derived
 *  reserve applies to those without an `asso` row. */
export interface LineRow {
  ligne: number
  commande_sst: number
  /** Line quantity (kg). */
  quantite: number
}

export interface PieceRow {
  IDordre_fabrication: number
  poids: number
}

/** `asso_fil_of` rows of the OFs, already filtered on this fil/coloris. */
export interface OfFilRow {
  IDordre_fabrication: number
  pourcentage: number
  /** Lot named on the OF — shown when the reserve is derived from the OF. */
  lot?: string
}

export interface BesoinRow {
  commande_sst: number
  ligne: number
  /** Lots of this fil/coloris reserved on the line, in reservation order. */
  lot: string
  /** Σ reserved kg on the line for this fil/coloris. */
  reserve: number
  /** kg already knitted on the line's OFs, apportioned to this fil/coloris. */
  produit: number
  /** Whether a TRM mirror line exists — false = external tricoteur, untracked. */
  suivi: boolean
  /** Remaining need = max(0, reserve − produit). Named `kg` like the other rows. */
  kg: number
  /** 'affectation' = reserve read from asso_fil_lignecmdsst; 'of' = no
   *  affectation on this fil, reserve derived from the line's OFs (#1159). */
  source: 'affectation' | 'of'
}

const round1 = (n: number) => Math.round(n * 10) / 10

function addLot(row: BesoinRow, raw: string) {
  const lot = raw.trim() || '—'
  if (!row.lot.split(', ').includes(lot)) row.lot = row.lot ? `${row.lot}, ${lot}` : lot
}

export function computeBesoin(input: {
  asso: AssoRow[]
  mirrors: MirrorLine[]
  ofs: OfRow[]
  pieces: PieceRow[]
  ofFil: OfFilRow[]
  lines?: LineRow[]
}): { rows: BesoinRow[]; besoin: number; reserve: number; produit: number } {
  // Produced kg per OF, then × the OF's share of this fil (several lots of the
  // same fil on one OF each carry their own pourcentage → summed).
  const poidsByOf = new Map<number, number>()
  for (const p of input.pieces) {
    poidsByOf.set(p.IDordre_fabrication, (poidsByOf.get(p.IDordre_fabrication) ?? 0) + (Number(p.poids) || 0))
  }
  const pctByOf = new Map<number, number>()
  for (const f of input.ofFil) {
    pctByOf.set(f.IDordre_fabrication, (pctByOf.get(f.IDordre_fabrication) ?? 0) + (Number(f.pourcentage) || 0))
  }
  // Consumed per TRM line = Σ over its OFs.
  const consumedByTrmLine = new Map<number, number>()
  for (const of of input.ofs) {
    const kg = (poidsByOf.get(of.IDordre_fabrication) ?? 0) * ((pctByOf.get(of.IDordre_fabrication) ?? 0) / 100)
    consumedByTrmLine.set(of.IDligne_commande_client, (consumedByTrmLine.get(of.IDligne_commande_client) ?? 0) + kg)
  }
  // TRM line(s) per sst line.
  const trmLinesBySst = new Map<number, number[]>()
  for (const m of input.mirrors) {
    const arr = trmLinesBySst.get(m.IDligne_commande_ETM) ?? []
    arr.push(m.IDligne_commande_client)
    trmLinesBySst.set(m.IDligne_commande_ETM, arr)
  }

  // One row per sst line, lots merged.
  const byLine = new Map<number, BesoinRow>()
  for (const a of input.asso) {
    let row = byLine.get(a.ligne)
    if (!row) {
      const trm = trmLinesBySst.get(a.ligne) ?? []
      const produit = trm.reduce((s, l) => s + (consumedByTrmLine.get(l) ?? 0), 0)
      row = { commande_sst: a.commande_sst, ligne: a.ligne, lot: '', reserve: 0, produit: round1(produit), suivi: trm.length > 0, kg: 0, source: 'affectation' }
      byLine.set(a.ligne, row)
    }
    row.reserve = round1(row.reserve + (Number(a.quantite) || 0))
    addLot(row, a.lot)
  }

  // Lines knitting this fil without any affectation on it (#1159): reserve
  // derived from the OFs — share of this fil per OF, weighted by the OF
  // quantity across the line's OFs (OFs without quantity weigh 1 each).
  const ofQty = new Map<number, number>()
  for (const of of input.ofs) ofQty.set(of.IDordre_fabrication, Number(of.quantite) || 0)
  const ofLots = new Map<number, string[]>()
  for (const f of input.ofFil) {
    if (f.lot === undefined) continue
    const arr = ofLots.get(f.IDordre_fabrication) ?? []
    arr.push(f.lot)
    ofLots.set(f.IDordre_fabrication, arr)
  }
  for (const l of input.lines ?? []) {
    if (byLine.has(l.ligne)) continue
    const trm = trmLinesBySst.get(l.ligne) ?? []
    const lineOfs = input.ofs.filter((o) => trm.includes(o.IDligne_commande_client) && pctByOf.has(o.IDordre_fabrication))
    if (lineOfs.length === 0) continue
    const weighted = lineOfs.some((o) => (ofQty.get(o.IDordre_fabrication) ?? 0) > 0)
    let wsum = 0
    let psum = 0
    for (const o of lineOfs) {
      const w = weighted ? (ofQty.get(o.IDordre_fabrication) ?? 0) : 1
      wsum += w
      psum += w * (pctByOf.get(o.IDordre_fabrication) ?? 0)
    }
    const pct = wsum > 0 ? psum / wsum : 0
    const produit = trm.reduce((s, t) => s + (consumedByTrmLine.get(t) ?? 0), 0)
    const row: BesoinRow = {
      commande_sst: l.commande_sst, ligne: l.ligne, lot: '',
      reserve: round1((Number(l.quantite) || 0) * pct / 100),
      produit: round1(produit), suivi: true, kg: 0, source: 'of',
    }
    for (const o of lineOfs) for (const lot of ofLots.get(o.IDordre_fabrication) ?? []) addLot(row, lot)
    byLine.set(l.ligne, row)
  }
  const rows = Array.from(byLine.values())
  for (const r of rows) r.kg = Math.max(0, round1(r.reserve - r.produit))
  rows.sort((x, y) => y.kg - x.kg || y.reserve - x.reserve)

  return {
    rows,
    besoin: round1(rows.reduce((s, r) => s + r.kg, 0)),
    reserve: round1(rows.reduce((s, r) => s + r.reserve, 0)),
    produit: round1(rows.reduce((s, r) => s + r.produit, 0)),
  }
}
