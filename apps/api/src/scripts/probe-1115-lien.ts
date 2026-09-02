// Probe for LIVA #1115: how legacy links ennoblisseur-affected rolls to client lines.
import { query, closeConnection } from '../lib/hfsql-auto.js'
async function main() {
  // (a) header back-pointers on ennoblisseur orders (orders holding a type-2 line)
  const hdr = await query<any>(`SELECT cst.IDcommande_sous_traitant AS id, cst.IDcommande_client AS cc, cst.IDligne_commande_client AS lcc, cst.date_commande AS dc
    FROM commande_sous_traitant cst WHERE cst.IDcommande_sous_traitant IN (SELECT DISTINCT IDcommande_sous_traitant FROM ligne_commande_sous_traitant WHERE type = 2)`)
  const withCc = hdr.filter((h: any) => Number(h.cc) > 0).length
  const withLcc = hdr.filter((h: any) => Number(h.lcc) > 0).length
  console.log('enno headers', hdr.length, 'IDcommande_client>0', withCc, 'IDligne_commande_client>0', withLcc)
  const recent = hdr.filter((h: any) => String(h.dc).startsWith('2026')).sort((a: any, b: any) => Number(b.id) - Number(a.id)).slice(0, 15)
  console.log('recent 2026 headers (id, cc, lcc, date):'); for (const h of recent) console.log(' ', h.id, h.cc, h.lcc, h.dc)
  // (b) rolls affected to a type-2 line: linked vs not
  const rolls = await query<any>(`SELECT se.IDstock_ecru AS id, se.IDref_commande_affectation AS aff, se.IDligne_commande_client AS lcc, se.date_saisie AS ds, se.IDligne_expedition_ETM AS exp
    FROM stock_ecru se WHERE se.IDsociete = 1 AND se.IDref_commande_affectation > 0`)
  const type2 = new Set((await query<any>(`SELECT IDligne_commande_sous_traitant AS id FROM ligne_commande_sous_traitant WHERE type = 2`)).map((r: any) => Number(r.id)))
  const r2 = rolls.filter((r: any) => type2.has(Number(r.aff)))
  const linked = r2.filter((r: any) => Number(r.lcc) > 0).length
  console.log('rolls affected to enno lines', r2.length, 'linked to a client line', linked, 'unlinked', r2.length - linked)
  for (const y of ['2024', '2025', '2026']) {
    const yy = r2.filter((r: any) => String(r.ds).startsWith(y))
    console.log(' ', y, 'total', yy.length, 'linked', yy.filter((r: any) => Number(r.lcc) > 0).length)
  }
  // (c) per enno line: mixed lines (some linked, some not) — the case Pierrot describes
  const byLine = new Map<number, { l: number; u: number }>()
  for (const r of r2) { const k = Number(r.aff); const e = byLine.get(k) ?? { l: 0, u: 0 }; if (Number(r.lcc) > 0) e.l++; else e.u++; byLine.set(k, e) }
  let mixed = 0, allL = 0, allU = 0
  for (const e of byLine.values()) { if (e.l && e.u) mixed++; else if (e.l) allL++; else allU++ }
  console.log('enno lines', byLine.size, 'all linked', allL, 'all unlinked', allU, 'mixed', mixed)
  // (d) does the linked client line match the header's IDligne_commande_client? sample of mixed lines in 2026
  const mixedIds = [...byLine.entries()].filter(([, e]) => e.l && e.u).map(([k]) => k).slice(-8)
  for (const lid of mixedIds) {
    const rr = r2.filter((r: any) => Number(r.aff) === lid)
    const lccs = [...new Set(rr.map((r: any) => Number(r.lcc)))]
    console.log('  mixed line', lid, 'rolls', rr.length, 'lcc values', lccs.join('/'))
  }
  await closeConnection()
}
main().catch((e) => { console.error(e); process.exit(1) })
