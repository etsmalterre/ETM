// Applies the pending schema migrations of the `mps` PostgreSQL database
// (lib/mps-schema.ts). Dry run by default: lists what is applied / pending.
//
//   npx tsx src/scripts/mps-migrate.ts            # status
//   npx tsx src/scripts/mps-migrate.ts --write    # apply
//
// Connection: MPS_PG_OWNER_URL (production: the owner of the tables — the API
// role cannot ALTER them), else PG_CONNECTION_STRING (dev: `mps_dev` owns its
// copy). Env from .env.<NODE_ENV> like the API.
import '../load-env.js'
import postgres from 'postgres'
import { MIGRATIONS, applyMigrations, migrationStatus } from '../lib/mps-schema.js'

const write = process.argv.includes('--write')
const url = process.env.MPS_PG_OWNER_URL || process.env.PG_CONNECTION_STRING
if (!url) {
  console.error('Neither MPS_PG_OWNER_URL nor PG_CONNECTION_STRING is set.')
  process.exit(1)
}
const dbName = new URL(url).pathname.replace(/^\//, '')
const sql = postgres(url, { max: 1, onnotice: () => {}, connection: { application_name: 'mps-migrate' } })

try {
  const before = await migrationStatus(sql)
  console.log(`Database ${dbName}: ${before.applied.length} applied, ${before.pending.length} pending (of ${MIGRATIONS.length}).`)
  for (const n of before.pending) console.log(`  pending  ${n}`)
  if (before.unknown.length) console.warn(`  ⚠️ applied but unknown to this code: ${before.unknown.join(', ')}`)
  if (!write) {
    if (before.pending.length) console.log('Dry run — re-run with --write to apply.')
  } else {
    const applied = await applyMigrations(sql)
    for (const n of applied) console.log(`  applied  ${n}`)
    console.log(`Done: ${applied.length} applied.`)
  }
} catch (err) {
  console.error('Migration failed:', err)
  process.exitCode = 1
} finally {
  await sql.end()
}
