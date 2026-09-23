// Probe for LIVA #1188: client-line « Affecté » gauge vs Ennoblissement tab « Affecté » column (commande 3762, 029A marine).
import { query, closeConnection } from '../lib/hfsql-auto.js'
const CC = Number(process.argv[2] || 3762)
const SST = (process.argv[3] || '8944,8970,8991,8992').split(',').map(Number)
async function main() {
  const hdr = await query<any>(`SELECT IDcommande_client, numero, IDclient, est_soldee FROM commande_client WHERE numero = ${CC} OR IDcommande_client = ${CC} ORDER BY numero DESC`)
  console.log('header', JSON.stringify(hdr))
  const ccId = Number(hdr[0]?.IDcommande_client)
  const lines = await query<any>(`SELECT IDligne_commande_client AS id, TYPE AS t, IDreference AS ref, IDcolori AS col, unite, quantite AS q, date_livraison AS dl FROM ligne_commande_client WHERE IDcommande_client = ${ccId}`)
  const refIds = [...new Set(lines.map((l: any) => Number(l.ref)))].filter((x) => x > 0)
  const refs = refIds.length ? await query<any>(`SELECT IDref_fini AS id, reference AS r, rendement AS rdt FROM ref_fini WHERE IDref_fini IN (${refIds.join(',')})`) : []
  const refName = new Map(refs.map((r: any) => [Number(r.id), r]))
  const colIds = [...new Set(lines.map((l: any) => Number(l.col)))].filter((x) => x > 0)
  const cols = colIds.length ? await query<any>(`SELECT IDref_fini_colori AS id, reference AS r FROM ref_fini_colori WHERE IDref_fini_colori IN (${colIds.join(',')})`) : []
  const colName = new Map(cols.map((c: any) => [Number(c.id), c.r]))
  console.log('\nLINES of', ccId)
  for (const l of lines) console.log(' ', l.id, 't', l.t, 'ref', l.ref, refName.get(Number(l.ref))?.r, 'rdt', refName.get(Number(l.ref))?.rdt, 'col', l.col, colName.get(Number(l.col)), 'q', l.q, 'u', l.unite, 'dl', l.dl)
  const lineIds = lines.map((l: any) => Number(l.id))
  // gauge inputs per line
  const fini = await query<any>(`SELECT IDstock_fini AS id, IDligne_commande_client AS lcc, IDstock_ecru AS se, IDref_commande_source AS src, numero, metrage, poids, IDligne_expedition AS exp, IDetat_stock_fini AS etat, IDcommande_donation AS don FROM stock_fini WHERE IDligne_commande_client IN (${lineIds.join(',')})`)
  const ecru = await query<any>(`SELECT IDstock_ecru AS id, IDligne_commande_client AS lcc, IDref_commande_affectation AS aff, IDref_commande_source AS src, numero, lot, poids, metrage, IDligne_expedition_ETM AS exp, IDcommande_donation AS don, IDmagasin AS mag FROM stock_ecru WHERE IDligne_commande_client IN (${lineIds.join(',')})`)
  const trico = await query<any>(`SELECT IDligne_commande_client AS lcc, IDligne_commande_sous_traitant AS lid, poids_affecte AS p FROM affectation_cmd_tricotage WHERE IDligne_commande_client IN (${lineIds.join(',')})`)
  const ecruIds = ecru.map((e: any) => Number(e.id))
  const children = ecruIds.length ? await query<any>(`SELECT IDstock_fini AS f, IDstock_ecru AS e, IDligne_commande_client AS lcc, metrage, poids, IDetat_stock_fini AS etat, IDligne_expedition AS exp FROM stock_fini WHERE IDstock_ecru IN (${ecruIds.join(',')})`) : []
  const childOf = new Map(children.map((c: any) => [Number(c.e), c]))
  for (const lid of lineIds) {
    const f = fini.filter((r: any) => Number(r.lcc) === lid)
    const e = ecru.filter((r: any) => Number(r.lcc) === lid)
    const t = trico.filter((r: any) => Number(r.lcc) === lid)
    if (!f.length && !e.length && !t.length) continue
    const l = lines.find((x: any) => Number(x.id) === lid)
    const rdt = Number(refName.get(Number(l.ref))?.rdt) || 0
    console.log(`\n== LINE ${lid} ${refName.get(Number(l.ref))?.r} ${colName.get(Number(l.col))} q=${l.q} rdt=${rdt}`)
    let gm = 0, xm = 0
    for (const r of f) { const m = Number(r.metrage) || 0; gm += m; if (Number(r.etat) === 4 || Number(r.exp) > 0) xm += m }
    console.log('  fini reserved:', f.length, 'Σ metrage', gm.toFixed(1), 'shipped', xm.toFixed(1), 'don>0', f.filter((r: any) => Number(r.don) > 0).length)
    console.log('   by src sst line:', JSON.stringify([...f.reduce((m: Map<number, number>, r: any) => m.set(Number(r.src), (m.get(Number(r.src)) ?? 0) + (Number(r.metrage) || 0)), new Map())].map(([k, v]) => [k, +v.toFixed(1)])))
    let em = 0, emLive = 0, emDead = 0
    for (const r of e) { const m = Number(r.poids) * rdt; em += m; if (childOf.has(Number(r.id))) emDead += m; else emLive += m }
    console.log('  ecru reserved:', e.length, 'Σ poids×rdt', em.toFixed(1), 'still écru', emLive.toFixed(1), 'already dyed (fini child)', emDead.toFixed(1))
    for (const r of e) console.log('    ', r.id, r.numero, 'lot', r.lot, 'poids', r.poids, 'aff', r.aff, 'src', r.src, 'mag', r.mag, 'don', r.don, 'exp', r.exp, childOf.has(Number(r.id)) ? '→ fini ' + childOf.get(Number(r.id)).f + ' ' + childOf.get(Number(r.id)).metrage + 'Ml lcc ' + childOf.get(Number(r.id)).lcc : '')
    console.log('  trico allocs:', JSON.stringify(t))
    console.log('  GAUGE (code) =', (gm + emLive + t.reduce((s: number, x: any) => s + Number(x.p) * rdt, 0)).toFixed(1), '/', l.q)
  }
  // sst side
  const sl = await query<any>(`SELECT IDligne_commande_sous_traitant AS lid, IDcommande_sous_traitant AS cid, TYPE AS t, IDreference AS ref, IDColoris AS col, quantite AS q, sstatut AS st, date_livraison AS dl FROM ligne_commande_sous_traitant WHERE IDcommande_sous_traitant IN (${SST.join(',')})`)
  console.log('\nSST LINES', JSON.stringify(sl))
  const slIds = sl.map((x: any) => Number(x.lid))
  const aff = slIds.length ? await query<any>(`SELECT IDstock_ecru AS id, IDref_commande_affectation AS aff, IDligne_commande_client AS lcc, IDcommande_donation AS don, numero, lot, poids, IDmagasin AS mag FROM stock_ecru WHERE IDref_commande_affectation IN (${slIds.join(',')})`) : []
  const affIds = aff.map((e: any) => Number(e.id))
  const ch2 = affIds.length ? await query<any>(`SELECT IDstock_fini AS f, IDstock_ecru AS e, metrage, IDligne_commande_client AS lcc, IDetat_stock_fini AS etat FROM stock_fini WHERE IDstock_ecru IN (${affIds.join(',')})`) : []
  const ch2Of = new Map(ch2.map((c: any) => [Number(c.e), c]))
  for (const s of sl) {
    const rows = aff.filter((r: any) => Number(r.aff) === Number(s.lid))
    const rdt = Number(refName.get(Number(s.ref))?.rdt) || 0
    const by = new Map<string, { n: number; kg: number; dyed: number; dyedKg: number }>()
    for (const r of rows) { const k = 'lcc=' + r.lcc + (Number(r.don) > 0 ? ' don' : ''); const a = by.get(k) ?? { n: 0, kg: 0, dyed: 0, dyedKg: 0 }; a.n++; a.kg += Number(r.poids) || 0; if (ch2Of.has(Number(r.id))) { a.dyed++; a.dyedKg += Number(r.poids) || 0 } by.set(k, a) }
    console.log(`\n-- sst cde ${s.cid} line ${s.lid} ref ${refName.get(Number(s.ref))?.r ?? s.ref} col ${s.col} q=${s.q} st=${s.st} rdt=${rdt}: ${rows.length} écru affected`)
    for (const [k, a] of by) console.log(`    ${k}: ${a.n} rolls ${a.kg.toFixed(1)} kg = ${(a.kg * rdt).toFixed(1)} Ml | of which dyed ${a.dyed} rolls ${(a.dyedKg * rdt).toFixed(1)} Ml`)
  }
  await closeConnection()
}
main().catch((e) => { console.error(e); process.exit(1) })
