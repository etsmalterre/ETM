// How does the LEGACY WinDev app record "confirmation de commande envoyée"?
// The ETM historique tab only reads envoi_email IDtype_doc=7, which legacy
// apparently never writes. Probe the local DB (prod snapshot) for the real shape.
import { query } from '../lib/hfsql-auto.js'

async function main() {
  console.log('\n=== type_doc catalogue ===')
  try {
    const rows = (await query(`SELECT * FROM type_doc`)) as any[]
    for (const r of rows) console.log('  ', JSON.stringify(r))
  } catch (e) { console.log('  ERR:', (e as Error).message) }

  console.log('\n=== envoi_email: count per IDtype_doc ===')
  try {
    const rows = (await query(
      `SELECT IDtype_doc, COUNT(*) AS n FROM envoi_email GROUP BY IDtype_doc ORDER BY IDtype_doc`,
    )) as any[]
    for (const r of rows) console.log('  ', JSON.stringify(r))
  } catch (e) { console.log('  ERR:', (e as Error).message) }

  console.log('\n=== commande_client columns (TOP 1 *) ===')
  try {
    const rows = (await query(`SELECT TOP 1 * FROM commande_client WHERE IDcommande_client = 6899`)) as any[]
    if (rows.length > 0) console.log('  keys:', Object.keys(rows[0]).join(', '))
    for (const r of rows) console.log('  ', JSON.stringify(r))
  } catch (e) { console.log('  ERR:', (e as Error).message) }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
