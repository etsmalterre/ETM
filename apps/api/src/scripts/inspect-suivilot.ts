import dotenv from 'dotenv'
dotenv.config({ path: '.env' })
dotenv.config({ path: `.env.${process.env.NODE_ENV || 'development'}` })

import { query } from '../lib/hfsql.js'

// suivilot: legacy lot-tracking table. We need to understand which
// columns it has, how rows are linked to a réception (which event/object
// creates a suivilot row), and the typical content of those rows so we
// can port the auto-creation logic to ETM's batch-reception flow.

async function main() {
  console.log('=== suivilot — first 3 rows ===')
  const rows = await query<Record<string, unknown>>(`SELECT TOP 3 * FROM suivilot`)
  if (rows.length === 0) { console.log('  (empty)'); return }
  console.log('  columns:', Object.keys(rows[0]).join(', '))
  for (const r of rows) {
    console.log(' ', JSON.stringify(r, (_k, v) => typeof v === 'bigint' ? Number(v) : v).slice(0, 800))
  }

  console.log('\n=== row count ===')
  const cnt = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM suivilot`)
  console.log('  total rows:', cnt[0]?.n)

  // Probe: how do suivilot rows relate to stock_fini? Look for FK-like
  // columns by name pattern.
  const cols = Object.keys(rows[0])
  const linkCandidates = cols.filter((c) => /stock|fini|ecru|fil|ligne|commande|piece|sous|ennobl|magasin/i.test(c))
  console.log('\n=== link-like columns ===')
  console.log(' ', linkCandidates.join(', ') || '(none)')

  // If stock_fini-like FK exists, test by picking a known stock_fini and
  // looking up its suivilot trail.
  console.log('\n=== sample joins on common FK names ===')
  for (const fk of ['IDstock_fini', 'IDstock_fil', 'IDpiece_production', 'IDligne_commande_sous_traitant', 'IDcommande_sous_traitant']) {
    if (!cols.includes(fk)) continue
    const stats = await query<{ has: number; total: number }>(
      `SELECT COUNT(${fk}) AS has, COUNT(*) AS total FROM suivilot WHERE ${fk} > 0`,
    )
    const distinct = await query<{ n: number }>(
      `SELECT COUNT(DISTINCT ${fk}) AS n FROM suivilot WHERE ${fk} > 0`,
    )
    console.log(`  ${fk}: ${stats[0]?.has}/${stats[0]?.total} rows have it > 0 · distinct=${distinct[0]?.n}`)
  }

  console.log('\n=== a sample suivilot row tied to a stock_fini ===')
  if (cols.includes('IDstock_fini')) {
    const sample = await query<Record<string, unknown>>(
      `SELECT TOP 5 * FROM suivilot WHERE IDstock_fini > 0 ORDER BY IDsuivilot DESC`,
    )
    for (const r of sample) console.log(' ', JSON.stringify(r, (_k, v) => typeof v === 'bigint' ? Number(v) : v))
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
