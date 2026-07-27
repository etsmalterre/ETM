// Validates the Linux-path positional row rewrite of dossier_qualite against a
// scratch row: read → DELETE → positional INSERT → read back → compare.
// A column-order mistake in DQ_COLUMNS would silently scramble the row in prod,
// so this runs the exact literal-building code the route uses.
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { esc, n } from '../lib/sst-shared.js'

const DQ_COLUMNS = [
  'IDdossier_qualite', 'action', 'description', 'DATE', 'echéance', 'résolution',
  'IDclient', 'IDsuivilot', 'defaut_qualité', 'terminé', 'IDaction_qualité',
  'Type_Reference', 'IDreference', 'journal', 'reference', 'IDSociétéFNC',
  'messageFNC', 'reponseFNC', 'envoiFNC', 'IDdefaut_textile',
] as const

const DQ_TEXT_COLUMNS = new Set<string>([
  'action', 'description', 'DATE', 'echéance', 'résolution', 'defaut_qualité',
  'Type_Reference', 'journal', 'reference', 'messageFNC', 'reponseFNC', 'envoiFNC',
])
const DQ_NULLABLE_DATE_COLUMNS = new Set<string>(['echéance', 'envoiFNC'])

function sqlText(value: string | null | undefined): string {
  const v = (value ?? '').toString()
  if (v === '') return "''"
  if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(v)) return `'${esc(v)}'`
  const bytes = Buffer.from(Array.from(v, (ch) => {
    const c = ch.codePointAt(0) ?? 0x3f
    return c <= 0xff ? c : 0x3f
  }))
  return `x'${bytes.toString('hex')}'`
}
function dateDigits8(value: unknown): string {
  const s = (value ?? '').toString().replace(/\D/g, '')
  return s.length === 8 ? s : ''
}
function dqLiteral(column: string, value: unknown): string {
  if (DQ_TEXT_COLUMNS.has(column)) {
    const s = value == null ? '' : value.toString()
    if (DQ_NULLABLE_DATE_COLUMNS.has(column) && dateDigits8(s) === '') return 'NULL'
    return sqlText(s)
  }
  return String(n(value))
}

const TEXT_FIELDS = ['description', 'action', 'journal', 'messageFNC', 'reponseFNC', 'reference', 'defaut_qualité', 'résolution']

async function readRow(id: number): Promise<Record<string, unknown>> {
  const rows = await query<Record<string, unknown>>(`SELECT * FROM dossier_qualite WHERE IDdossier_qualite = ${id}`)
  const fixed = await fixEncoding(rows, 'dossier_qualite', 'IDdossier_qualite', TEXT_FIELDS)
  return fixed[0]
}

async function main() {
  const id = Number(process.argv[2])
  if (!id) { console.error('usage: test-dq-positional-rewrite <id>'); process.exit(1) }

  const before = await readRow(id)
  if (!before) { console.error(`dossier ${id} not found`); process.exit(1) }
  console.log('BEFORE:', JSON.stringify(before))

  // Column-order sanity: the driver's key order must match DQ_COLUMNS.
  const keys = Object.keys(before)
  console.log('driver key order matches DQ_COLUMNS:', JSON.stringify(keys) === JSON.stringify([...DQ_COLUMNS]))

  const literals = DQ_COLUMNS.map((c) => dqLiteral(c, before[c]))
  await query(`DELETE FROM dossier_qualite WHERE IDdossier_qualite = ${id}`)
  await query(`INSERT INTO dossier_qualite VALUES (${literals.join(', ')})`)

  const after = await readRow(id)
  console.log('AFTER: ', JSON.stringify(after))

  let ok = true
  for (const c of DQ_COLUMNS) {
    const a = before[c] == null ? '' : String(before[c]).trim()
    const b = after[c] == null ? '' : String(after[c]).trim()
    if (a !== b) { ok = false; console.log(`  MISMATCH ${c}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`) }
  }
  console.log(ok ? '\n✅ positional rewrite round-trips exactly' : '\n❌ positional rewrite LOST DATA')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
