// LIVA #1119: how many 2nd-choix rolls sit in the transfer picker's pool, per magasin.
import { query, closeConnection } from '../lib/hfsql-auto.js'
async function main() {
  const ecru = await query<any>(`SELECT IDmagasin AS m, second_choix AS sc, COUNT(*) AS n FROM stock_ecru WHERE (IDligne_expedition_ETM IS NULL OR IDligne_expedition_ETM = 0) AND IDsociete = 1 GROUP BY IDmagasin, second_choix`)
  const fini = await query<any>(`SELECT IDmagasin AS m, second_choix AS sc, COUNT(*) AS n FROM stock_fini WHERE (IDligne_expedition IS NULL OR IDligne_expedition = 0) AND destockage = 0 GROUP BY IDmagasin, second_choix`)
  const names = new Map<number, string>()
  for (const r of await query<any>(`SELECT IDsous_traitant AS id, nom FROM sous_traitant`)) names.set(Number(r.id), String(r.nom))
  names.set(0, 'Ets Malterre')
  const agg = (rows: any[]) => {
    const m = new Map<number, { first: number; second: number }>()
    for (const r of rows) { const k = Number(r.m); const e = m.get(k) ?? { first: 0, second: 0 }; if (Number(r.sc)) e.second += Number(r.n); else e.first += Number(r.n); m.set(k, e) }
    return [...m.entries()].sort((a, b) => (b[1].first + b[1].second) - (a[1].first + a[1].second)).slice(0, 8)
  }
  console.log('ECRU (unshipped, société 1) per magasin: 1er / 2e choix')
  for (const [k, e] of agg(ecru)) console.log('  ', names.get(k) ?? k, e.first, '/', e.second)
  console.log('FINI (unshipped, not destocké) per magasin: 1er / 2e choix')
  for (const [k, e] of agg(fini)) console.log('  ', names.get(k) ?? k, e.first, '/', e.second)
  // how often do transfer bons actually carry 2nd-choix rolls?
  const pt = await query<any>(`SELECT IDpiece_ecru AS e, IDpiece_fini AS f FROM piece_transfert`)
  const eIds = pt.map((r: any) => Number(r.e)).filter((x: number) => x > 0)
  const fIds = pt.map((r: any) => Number(r.f)).filter((x: number) => x > 0)
  let e2 = 0, f2 = 0
  for (let i = 0; i < eIds.length; i += 500) { const rows = await query<any>(`SELECT COUNT(*) AS n FROM stock_ecru WHERE second_choix = 1 AND IDstock_ecru IN (${eIds.slice(i, i + 500).join(',')})`); e2 += Number(rows[0]?.n) || 0 }
  for (let i = 0; i < fIds.length; i += 500) { const rows = await query<any>(`SELECT COUNT(*) AS n FROM stock_fini WHERE second_choix = 1 AND IDstock_fini IN (${fIds.slice(i, i + 500).join(',')})`); f2 += Number(rows[0]?.n) || 0 }
  console.log('piece_transfert: écru', eIds.length, 'of which 2e choix', e2, '· fini', fIds.length, 'of which 2e choix', f2)
  // recent bons (2026) carrying 2nd choix
  const recent = await query<any>(`SELECT bt.IDbon_transfert AS id, bt.DATE AS d, pt.IDpiece_ecru AS e, pt.IDpiece_fini AS f FROM bon_transfert bt JOIN piece_transfert pt ON pt.IDbon_transfert = bt.IDbon_transfert WHERE bt.DATE >= '20260101'`)
  const re = recent.map((r: any) => Number(r.e)).filter((x: number) => x > 0)
  const rf = recent.map((r: any) => Number(r.f)).filter((x: number) => x > 0)
  let re2 = 0, rf2 = 0
  for (let i = 0; i < re.length; i += 500) { const rows = await query<any>(`SELECT COUNT(*) AS n FROM stock_ecru WHERE second_choix = 1 AND IDstock_ecru IN (${re.slice(i, i + 500).join(',')})`); re2 += Number(rows[0]?.n) || 0 }
  for (let i = 0; i < rf.length; i += 500) { const rows = await query<any>(`SELECT COUNT(*) AS n FROM stock_fini WHERE second_choix = 1 AND IDstock_fini IN (${rf.slice(i, i + 500).join(',')})`); rf2 += Number(rows[0]?.n) || 0 }
  console.log('2026 bons: écru pieces', re.length, '2e choix', re2, '· fini pieces', rf.length, '2e choix', rf2)
  await closeConnection()
}
main().catch((e) => { console.error(e); process.exit(1) })
