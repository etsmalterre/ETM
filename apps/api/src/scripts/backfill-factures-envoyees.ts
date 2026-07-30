// One-shot backfill: mark every definitive facture/avoir (IDsociete = 1) that
// has no envoi_email log row as "envoyée".
//
// The Clients › Facturation list derives est_envoye from the envoi_email audit
// log (IDtype_doc = 19, IDreference = IDfacture). Invoices issued before the
// ETM email feature (or sent outside the app) have no log row and show the
// red "non envoyée" border. This script inserts ONE marker row per unsent
// facture so they all read as sent. Idempotent — factures that already have a
// log row (real or marker) are skipped.
//
// The marker rows are identifiable and reversible via their notes value:
//   DELETE FROM envoi_email WHERE IDtype_doc = 19 AND notes = '<MARKER>'
//
// Usage (from apps/api, point HFSQL_CONNECTION_STRING at the TARGET server —
// the prod HFSQL server is 10.10.20.2, dev localhost is a separate copy):
//   pnpm exec tsx src/scripts/backfill-factures-envoyees.ts            # dry run
//   pnpm exec tsx src/scripts/backfill-factures-envoyees.ts --apply    # insert
import dotenv from 'dotenv'
const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' })
import { query, closeConnection } from '../lib/hfsql-auto.js'

const APPLY = process.argv.includes('--apply')
const TYPE_DOC_FACTURE = 19
// ASCII only — keeps the INSERT a plain quoted literal on every platform.
const MARKER = 'backfill marque envoyee 2026-07-23'

function nowHfsqlDatetime(): string {
  const d = new Date()
  const pad = (x: number, w = 2) => String(x).padStart(w, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  )
}

async function main() {
  const mode = APPLY ? 'APPLY' : 'DRY-RUN'
  const conn = process.env.HFSQL_CONNECTION_STRING ?? '(default localhost)'
  console.log(`[${mode}] backfill facture "envoyée" flags`)
  console.log(`HFSQL: ${conn.replace(/PWD=[^;]*/i, 'PWD=****')}\n`)

  // DATE / TYPE are reserved words — they come back uppercase on SELECT *-less
  // reads too, so read them as row.DATE / row.TYPE.
  const factures = await query<any>(
    `SELECT IDfacture, numero, DATE, TYPE FROM facture WHERE IDsociete = 1`,
  )
  console.log(`Definitive factures (IDsociete=1): ${factures.length}`)

  const sentRows = await query<{ IDreference: number }>(
    `SELECT DISTINCT IDreference FROM envoi_email WHERE IDtype_doc = ${TYPE_DOC_FACTURE}`,
  )
  const sent = new Set(sentRows.map((r) => Number(r.IDreference)))
  console.log(`Already logged as sent (envoi_email type 19): ${sent.size}`)

  const unsent = factures
    .map((f: any) => ({
      id: Number(f.IDfacture) || 0,
      numero: Number(f.numero) || 0,
      date: (f.DATE ?? '').toString(),
      type: Number(f.TYPE) || 1,
    }))
    .filter((f) => f.id > 0 && !sent.has(f.id))
    .sort((a, b) => a.id - b.id)

  const byYear = new Map<string, number>()
  for (const f of unsent) {
    const y = f.date.slice(0, 4) || '????'
    byYear.set(y, (byYear.get(y) ?? 0) + 1)
  }
  console.log(`\nUnsent (to backfill): ${unsent.length}`)
  for (const [y, c] of Array.from(byYear.entries()).sort()) console.log(`  ${y}: ${c}`)
  const avoirs = unsent.filter((f) => f.type === 2).length
  console.log(`  (factures: ${unsent.length - avoirs}, avoirs: ${avoirs})`)
  if (unsent.length > 0) {
    const first = unsent[0]
    const last = unsent[unsent.length - 1]
    console.log(`  range: n°${first.numero} (${first.date || 'no date'}) → n°${last.numero} (${last.date || 'no date'})`)
  }

  if (!APPLY) {
    console.log(`\nDry run — nothing written. Re-run with --apply to insert ${unsent.length} marker row(s).`)
    return
  }

  const ts = nowHfsqlDatetime()
  let done = 0
  let failed = 0
  for (const f of unsent) {
    try {
      // Same column set as the prod (Linux) send-log insert — omitted columns
      // (société, invalidé…) take the same defaults as real send logs.
      await query(
        `INSERT INTO envoi_email (DATE, adresse, IDreference, notes, IDtype_doc)
         VALUES ('${ts}', '', ${f.id}, '${MARKER}', ${TYPE_DOC_FACTURE})`,
      )
      done++
    } catch (e) {
      failed++
      console.error(`  INSERT failed for IDfacture=${f.id} (n°${f.numero}):`, (e as Error).message)
    }
    if ((done + failed) % 200 === 0) console.log(`  ...${done + failed}/${unsent.length}`)
  }
  console.log(`\nInserted ${done}/${unsent.length} marker row(s), ${failed} failure(s).`)
  console.log(`Undo: DELETE FROM envoi_email WHERE IDtype_doc = ${TYPE_DOC_FACTURE} AND notes = '${MARKER}'`)
}

main()
  .then(async () => { await closeConnection(); process.exit(0) })
  .catch(async (e) => { console.error(e); await closeConnection(); process.exit(1) })
