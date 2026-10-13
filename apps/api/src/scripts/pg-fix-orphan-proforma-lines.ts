// LIVA #1290 — 2020 shipments of other clients on the 13/10/2026 proformas.
// The legacy deleted converted proformas without their lines: 2 180
// ligne_facture_prov rows still pointed at IDfacture_prov 67…4439, headers long
// gone. Since the cutover the facture_prov identity restarted at 55 and hands
// those ids out again, so a new proforma inherited the dead one's lines
// (28 on proformas 59–66, e.g. Atelier Bulle's NEO03 on Unicycle's 65).
//
// Deletes, in one transaction:
//   1. every line whose header does not exist (true orphans);
//   2. every legacy line (id <= LEGACY_LAST_LINE) sitting on a header the API
//      created — the API's first line is 16002, the legacy's last 15782, and no
//      header older than the cutover survives (lowest live id was 55).
// The 2020 shipments themselves stay est_facture = 1: they were invoiced then.
// Every deleted row is written to a JSON backup first.
//
//   npx tsx src/scripts/pg-fix-orphan-proforma-lines.ts           # dry run: list, change nothing
//   npx tsx src/scripts/pg-fix-orphan-proforma-lines.ts --write   # apply (prod: NODE_ENV=production)
//
// The API also clears any line under a header it just created
// (purgeInheritedLines() in routes/factures.ts), so this is a one-shot cleanup.

import dotenv from 'dotenv'
const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' })
import { writeFileSync } from 'node:fs'
import type { Sql } from 'postgres'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'

const WRITE = process.argv.includes('--write')
/** Highest ligne_facture_prov id written by WinDev (measured 2026-10-13). */
const LEGACY_LAST_LINE = 15782
/** Refuse to delete more than this: 2 208 measured on 2026-10-13. */
const MAX_ROWS = 2300

interface Line {
  idligne_facture_prov: number
  idfacture_prov: number
  idligne_expedition: number
  designation: string | null
  quantite: number
  unite: string | null
  prix: number
  orphan: boolean
}

async function main() {
  const sql = mpsPg()
  const rows = await sql<Line[]>`
    SELECT l.idligne_facture_prov, l.idfacture_prov, l.idligne_expedition,
           l.designation::text AS designation, l.quantite, l.unite::text AS unite, l.prix,
           (f.idfacture_prov IS NULL) AS orphan
      FROM ligne_facture_prov l
      LEFT JOIN facture_prov f ON f.idfacture_prov = l.idfacture_prov
     WHERE f.idfacture_prov IS NULL OR l.idligne_facture_prov <= ${LEGACY_LAST_LINE}
     ORDER BY l.idfacture_prov, l.idligne_facture_prov`

  const orphans = rows.filter((r) => r.orphan)
  const inherited = rows.filter((r) => !r.orphan)
  console.log(`${env}: ${orphans.length} orphan line(s) on ${new Set(orphans.map((r) => r.idfacture_prov)).size} missing header(s)`)
  console.log(`${inherited.length} legacy line(s) on live proformas:`)
  for (const r of inherited) {
    const avis = /Avis : \d+/.exec(r.designation ?? '')?.[0] ?? ''
    console.log(`  proforma ${r.idfacture_prov}  line ${r.idligne_facture_prov}  ${(r.designation ?? '').split(/\r?\n/)[0]}  ${avis}`)
  }

  if (!WRITE) { console.log('\nDry run — nothing changed. Re-run with --write.'); return }
  if (rows.length === 0) { console.log('Nothing to do.'); return }
  if (rows.length > MAX_ROWS) throw new Error(`${rows.length} rows > MAX_ROWS ${MAX_ROWS} — check before raising it`)

  const backup = `orphan-proforma-lines-${env}-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}.json`
  writeFileSync(backup, JSON.stringify(rows, null, 1))
  console.log(`\nBackup: ${backup}`)

  const ids = rows.map((r) => r.idligne_facture_prov)
  const deleted = await sql.begin(async (t) => {
    const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
    const res = await tx`DELETE FROM ligne_facture_prov WHERE idligne_facture_prov IN ${tx(ids)}`
    if (res.count !== ids.length) throw new Error(`deleted ${res.count}, expected ${ids.length} — rolled back`)
    return res.count
  })
  console.log(`Deleted ${deleted} line(s).`)
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => closeMpsPg())
