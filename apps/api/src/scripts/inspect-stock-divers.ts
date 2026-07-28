import { query } from '../lib/hfsql-auto.js'

async function main() {
  console.log('\n=== stock_divers schema (TOP 1 *) ===')
  try {
    const r = (await query(`SELECT TOP 1 * FROM stock_divers`)) as any[]
    if (!r.length) console.log('empty')
    else console.log(JSON.stringify(r[0], null, 2))
  } catch (e) { console.log('err:', (e as Error).message) }

  console.log('\n=== stock_divers count ===')
  try {
    console.log(await query(`SELECT COUNT(*) AS n FROM stock_divers`))
  } catch (e) { console.log('err:', (e as Error).message) }

  console.log('\n=== stock_divers sample 25 ===')
  try {
    const r = (await query(`SELECT TOP 25 * FROM stock_divers ORDER BY IDstock_divers DESC`)) as any[]
    for (const row of r) console.log(JSON.stringify(row))
  } catch (e) { console.log('err:', (e as Error).message) }

  console.log('\n=== distinct unite values in stock_divers ===')
  try {
    console.log(await query(`SELECT unite, COUNT(*) AS n FROM stock_divers GROUP BY unite`))
  } catch (e) { console.log('err:', (e as Error).message) }

  console.log('\n=== how many stock rows per ref (top 15) ===')
  try {
    const r = (await query(
      `SELECT IDref_divers, COUNT(*) AS n, SUM(quantite) AS q FROM stock_divers GROUP BY IDref_divers ORDER BY n DESC`,
    )) as any[]
    console.log(r.slice(0, 15))
    console.log('total refs with stock:', r.length)
  } catch (e) { console.log('err:', (e as Error).message) }

  console.log('\n=== ref_divers schema (TOP 1 *) ===')
  try {
    const r = (await query(`SELECT TOP 1 * FROM ref_divers`)) as any[]
    console.log(JSON.stringify(r[0], null, 2))
  } catch (e) { console.log('err:', (e as Error).message) }

  console.log('\n=== ref_divers_variation schema (TOP 3 *) ===')
  try {
    const r = (await query(`SELECT TOP 3 * FROM ref_divers_variation`)) as any[]
    for (const row of r) console.log(JSON.stringify(row))
  } catch (e) { console.log('err:', (e as Error).message) }

  console.log('\n=== any mouvement/histo table for divers? ===')
  for (const t of ['mouvement_divers', 'mouvement_stock_divers', 'histo_stock_divers', 'stock_divers_histo']) {
    try {
      const r = (await query(`SELECT COUNT(*) AS n FROM ${t}`)) as any[]
      console.log(`${t}: ${r[0]?.n}`)
    } catch (e) { console.log(`${t}: -- (${(e as Error).message.slice(0, 60)})`) }
  }

  console.log('\n=== ref_divers_expedie schema (TOP 3 *) ===')
  try {
    const r = (await query(`SELECT TOP 3 * FROM ref_divers_expedie`)) as any[]
    for (const row of r) console.log(JSON.stringify(row))
  } catch (e) { console.log('err:', (e as Error).message) }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
