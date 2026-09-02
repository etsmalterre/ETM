// LIVA #1120 audit (read-only): transfer bons since the ETM Transferts screen
// shipped (2026-07-24), with the signals that a Valider carried pieces the user
// no longer saw — mixed references / lots in one bon — and the #1122 hole:
// société-2 (TRM) pieces the picker offered at magasin 0 and moved to a dyer,
// where neither stock screen lists them.
//   HFSQL_CONNECTION_STRING="DRIVER={HFSQL};Server Name=10.10.20.2;..." npx tsx --env-file=.env.development src/scripts/probe-1120-transferts-audit.ts [--since 20260724] [--detail]
import { query, closeConnection } from '../lib/hfsql-auto.js'
const argv = process.argv.slice(2)
const since = argv.includes('--since') ? argv[argv.indexOf('--since') + 1] : '20260724'
const detail = argv.includes('--detail')
const num = (v: any) => Number(v) || 0
async function main() {
  const cols = await query<any>(`SELECT TOP 1 * FROM bon_transfert`)
  console.log('bon_transfert columns:', Object.keys(cols[0] ?? {}).join(', '))
  const names = new Map<number, string>([[0, 'Ets Malterre']])
  for (const r of await query<any>(`SELECT IDsous_traitant AS id, nom FROM sous_traitant`)) names.set(num(r.id), String(r.nom))
  const bons = await query<any>(`SELECT * FROM bon_transfert WHERE DATE >= '${since}' AND type_matiere = 1 ORDER BY IDbon_transfert`)
  console.log(`\n${bons.length} bons rouleaux depuis ${since}`)
  const ids = bons.map((b: any) => num(b.IDbon_transfert))
  if (ids.length === 0) { await closeConnection(); return }
  const pts = await query<any>(`SELECT IDpiece_transfert AS id, IDbon_transfert AS bon, IDpiece_ecru AS e, IDpiece_fini AS f FROM piece_transfert WHERE IDbon_transfert IN (${ids.join(',')})`)
  const eIds = [...new Set(pts.map((p: any) => num(p.e)).filter((x: number) => x > 0))]
  const fIds = [...new Set(pts.map((p: any) => num(p.f)).filter((x: number) => x > 0))]
  const ecru = new Map<number, any>()
  for (let i = 0; i < eIds.length; i += 400) {
    const rows = await query<any>(`SELECT se.IDstock_ecru AS id, se.numero, se.lot, se.poids, se.IDmagasin AS mag, se.IDsociete AS soc, se.second_choix AS sc, se.IDref_commande_affectation AS aff, se.IDligne_commande_client AS lcc, re.reference AS ref FROM stock_ecru se LEFT JOIN ref_ecru re ON re.IDref_ecru = se.IDref_ecru WHERE se.IDstock_ecru IN (${eIds.slice(i, i + 400).join(',')})`)
    for (const r of rows) ecru.set(num(r.id), r)
  }
  const fini = new Map<number, any>()
  for (let i = 0; i < fIds.length; i += 400) {
    const rows = await query<any>(`SELECT sf.IDstock_fini AS id, sf.numero, sf.lot, sf.poids, sf.IDmagasin AS mag, sf.second_choix AS sc, sf.IDetat_stock_fini AS etat, rf.reference AS ref FROM stock_fini sf LEFT JOIN ref_fini rf ON rf.IDref_fini = sf.IDref_fini WHERE sf.IDstock_fini IN (${fIds.slice(i, i + 400).join(',')})`)
    for (const r of rows) fini.set(num(r.id), r)
  }
  type Row = { bon: number; date: string; src: string; dst: string; valide: number; n: number; kg: number; refs: Map<string, number>; lots: Map<string, number>; soc2: number; sc: number; aff: number; pieces: any[] }
  const rows: Row[] = []
  for (const b of bons) {
    const bid = num(b.IDbon_transfert)
    const mine = pts.filter((p: any) => num(p.bon) === bid)
    const r: Row = { bon: bid, date: String(b.DATE ?? b.date ?? ''), src: names.get(num(b.IDmagasin_source)) ?? String(b.IDmagasin_source), dst: names.get(num(b.IDmagasin_destination)) ?? String(b.IDmagasin_destination), valide: num(b.est_valide), n: 0, kg: 0, refs: new Map(), lots: new Map(), soc2: 0, sc: 0, aff: 0, pieces: [] }
    for (const p of mine) {
      const s = num(p.e) > 0 ? ecru.get(num(p.e)) : fini.get(num(p.f))
      if (!s) continue
      r.n++; r.kg += num(s.poids)
      const ref = String(s.ref ?? '?'); r.refs.set(ref, (r.refs.get(ref) ?? 0) + 1)
      const lot = String(s.lot ?? ''); r.lots.set(lot, (r.lots.get(lot) ?? 0) + 1)
      if (num(p.e) > 0 && num(s.soc) === 2) r.soc2++
      if (num(s.sc)) r.sc++
      if (num(p.e) > 0 && num(s.aff) > 0) r.aff++
      r.pieces.push({ kind: num(p.e) > 0 ? 'écru' : 'fini', ...s })
    }
    rows.push(r)
  }
  const fmtGroups = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k || '—'}×${v}`).join(' ')
  console.log('\nbon · date · src → dst · valide · pièces · kg · réfs (×pièces) · lots · [soc2 TRM] [2e choix] [affectées sst]')
  for (const r of rows) {
    const flags = [r.soc2 ? `TRM:${r.soc2}` : '', r.sc ? `2e:${r.sc}` : '', r.aff ? `aff:${r.aff}` : ''].filter(Boolean).join(' ')
    const mixed = r.refs.size > 1 ? ' ⚠ MIXTE' : ''
    console.log(`#${r.bon} ${r.date} ${r.src} → ${r.dst} v=${r.valide} ${r.n}p ${r.kg.toFixed(1)}kg · ${fmtGroups(r.refs)} · lots:${r.lots.size} ${flags}${mixed}`)
    if (detail && (mixed || r.soc2)) for (const p of r.pieces) console.log(`    ${p.kind} ${p.numero} ${p.ref} lot=${p.lot} ${num(p.poids).toFixed(1)}kg mag=${names.get(num(p.mag)) ?? p.mag} soc=${p.soc ?? '-'}`)
  }
  const mixed = rows.filter((r) => r.refs.size > 1)
  console.log(`\nRésumé : ${rows.length} bons · ${mixed.length} mixtes (≥2 réfs) · ${rows.filter((r) => r.soc2).length} bons portant des pièces TRM (soc=2)`)
  // The #1122 hole, whole base: TRM pieces sitting at a dyer/factory magasin ≠ 0.
  const hole = await query<any>(`SELECT se.IDstock_ecru AS id, se.numero, se.IDmagasin AS mag, se.poids, se.date_saisie AS ds FROM stock_ecru se WHERE se.IDsociete = 2 AND se.IDmagasin > 0 AND (se.IDligne_expedition_TRM IS NULL OR se.IDligne_expedition_TRM = 0)`)
  console.log(`\nPièces TRM (IDsociete=2) à un magasin ≠ 0, non expédiées : ${hole.length}`)
  for (const h of hole.slice(0, 40)) console.log(`   ${h.numero} mag=${names.get(num(h.mag)) ?? h.mag} ${num(h.poids).toFixed(1)}kg saisie=${h.ds}`)
  await closeConnection()
}
main().catch((e) => { console.error(e); process.exit(1) })
