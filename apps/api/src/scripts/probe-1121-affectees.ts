// LIVA #1121: are affected pieces (IDref_commande_affectation > 0) transferred, and to whom?
import { query, closeConnection } from '../lib/hfsql-auto.js'
const num = (v: any) => Number(v) || 0
async function main() {
  const names = new Map<number, string>([[0, 'Ets Malterre']])
  for (const r of await query<any>(`SELECT IDsous_traitant AS id, nom FROM sous_traitant`)) names.set(num(r.id), String(r.nom))
  const rows = await query<any>(`SELECT bt.IDbon_transfert AS bon, bt.DATE AS d, bt.IDmagasin_source AS src, bt.IDmagasin_destination AS dst, pt.IDpiece_ecru AS e FROM bon_transfert bt JOIN piece_transfert pt ON pt.IDbon_transfert = bt.IDbon_transfert WHERE bt.DATE >= '20250101' AND pt.IDpiece_ecru > 0`)
  const eIds = [...new Set(rows.map((r: any) => num(r.e)))]
  const aff = new Map<number, number>()
  for (let i = 0; i < eIds.length; i += 400) {
    for (const r of await query<any>(`SELECT IDstock_ecru AS id, IDref_commande_affectation AS a FROM stock_ecru WHERE IDstock_ecru IN (${eIds.slice(i, i + 400).join(',')})`)) aff.set(num(r.id), num(r.a))
  }
  const lineIds = [...new Set([...aff.values()].filter((x) => x > 0))]
  const lineSst = new Map<number, number>()
  for (let i = 0; i < lineIds.length; i += 400) {
    for (const r of await query<any>(`SELECT lcs.IDligne_commande_sous_traitant AS l, cst.IDsous_traitant AS s FROM ligne_commande_sous_traitant lcs JOIN commande_sous_traitant cst ON cst.IDcommande_sous_traitant = lcs.IDcommande_sous_traitant WHERE lcs.IDligne_commande_sous_traitant IN (${lineIds.slice(i, i + 400).join(',')})`)) lineSst.set(num(r.l), num(r.s))
  }
  let free = 0, toOwner = 0, toOther = 0
  const other = new Map<string, number>()
  for (const r of rows) {
    const a = aff.get(num(r.e)) ?? 0
    if (a === 0) { free++; continue }
    const owner = lineSst.get(a) ?? -1
    if (owner === num(r.dst)) toOwner++
    else { toOther++; const k = `${names.get(num(r.src))} → ${names.get(num(r.dst))} (affectée à ${names.get(owner) ?? owner})`; other.set(k, (other.get(k) ?? 0) + 1) }
  }
  console.log(`pièces écru transférées depuis 2025 : ${rows.length}`)
  console.log(`  non affectées : ${free}`)
  console.log(`  affectées, transférées VERS l'ennoblisseur de leur commande : ${toOwner}`)
  console.log(`  affectées, transférées AILLEURS : ${toOther}`)
  for (const [k, v] of [...other.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log('    ', v, k)
  await closeConnection()
}
main().catch((e) => { console.error(e); process.exit(1) })
