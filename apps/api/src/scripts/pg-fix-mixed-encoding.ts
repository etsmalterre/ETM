// PG migration review 2026-09-23 (windev_migration docs/plan.md § Review log):
// transporteur 6 (TEMPO ONE).COMMENTAIRE mixes both encodings in one value.
// « Séverine » is stored as the two bytes C3 A9 — which in cp1252 are the
// characters « Ã » and « © » — while « être », « régler », « siège », « à »
// in the same note are stored as the normal single cp1252 bytes EA E9 E8 E0.
// Someone pasted text that was already displaying as « SÃ©verine » (a badly
// encoded mail) into the WinDev comment box, and WinDev stored what it was given.
//
// Because the value as a whole is not valid UTF-8, every reader falls back to
// cp1252 and shows « SÃ©verine »: WinDev and the web apps are garbled alike, and
// so is the PostgreSQL copy (faithfully — the migration is not at fault here).
// Retyping the word fixes all three at once.
//
// What this repairs, and only this: a run of bytes that is a valid multi-byte
// UTF-8 sequence AND decodes to a character cp1252 can hold on its own becomes
// that single cp1252 byte (C3 A9 -> E9). Every other byte is copied untouched,
// so the rest of the note — including its CR/LF and any real accent — is
// preserved to the byte. A sequence decoding to anything cp1252 cannot store is
// reported and left alone rather than guessed at.
//
// Reads go through queryB64Text (one JS char per stored byte, lossless); writes
// go out as an x'…' hex literal of the cp1252 bytes, the same form sqlText uses
// — the Linux iODBC bridge corrupts raw multi-byte UTF-8 embedded in a SQL line.
// Column names are the catalog's (SQLColumns), verified 2026-09-23: naming a
// column HFSQL does not have takes the server down on Linux.
//
//   npx tsx src/scripts/pg-fix-mixed-encoding.ts           # dry run: list, change nothing
//   npx tsx src/scripts/pg-fix-mixed-encoding.ts --write   # apply (prod: NODE_ENV=production, on the API host)

import dotenv from 'dotenv'
const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' })
import { query, queryB64Text, closeConnection } from '../lib/hfsql-auto.js'

const WRITE = process.argv.includes('--write')
/** Refuse to write more than this: the 2026-09-23 run measured 1 value in 781657 rows. */
const MAX_ROWS = 3

// Scope. `keys` is the review's decision, not a search result — a value is only ever
// written because the review looked at it. Two cases were in front of Vincent on
// 2026-09-23 and he took both:
//   6  mixed (register: possible_double_encoding) — garbled for every reader today.
//   2, 4  whole-value UTF-8 (register R6, utf8_value) — garbled only in WinDev.
// Repairing an R6 row is safe HERE only because no web app reads transporteur.COMMENTAIRE.
// It is NOT safe in general before the cutover: the web apps read through query(), which
// decodes the stored bytes as UTF-8, so a row rewritten to cp1252 comes back as U+FFFD and
// the screen showing it regresses. Never widen `keys` to a column a web app reads.
// Anything else the scan turns up is listed, never written.
/** Columns the nightly run flagged as possible_double_encoding / utf8_value. Names from the catalog. */
const TARGETS = [
  { table: 'transporteur', id: 'IDTRANSPORTEUR', col: 'COMMENTAIRE', keys: [2, 4, 6] },
] as const

/** cp1252 0x80-0x9F -> Unicode (the 32 positions Latin-1 leaves undefined). */
const CP1252_HI = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0, 0x017d, 0, 0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc,
  0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
]
/** Unicode -> the single cp1252 byte holding it, or undefined. */
const TO_CP1252 = new Map<number, number>()
for (let i = 0; i < 32; i++) if (CP1252_HI[i]) TO_CP1252.set(CP1252_HI[i], 0x80 + i)
for (let c = 0x20; c <= 0xff; c++) if (c < 0x80 || c >= 0xa0) TO_CP1252.set(c, c)

/** The UTF-8 sequence starting at i: its length and code point, or null. */
function utf8At(b: Buffer, i: number): { len: number; cp: number } | null {
  const c = b[i]
  let len: number, cp: number
  if (c >= 0xc2 && c <= 0xdf) { len = 2; cp = c & 0x1f }
  else if (c >= 0xe0 && c <= 0xef) { len = 3; cp = c & 0x0f }
  else if (c >= 0xf0 && c <= 0xf4) { len = 4; cp = c & 0x07 }
  else return null
  if (i + len > b.length) return null
  for (let k = 1; k < len; k++) {
    if ((b[i + k] & 0xc0) !== 0x80) return null
    cp = (cp << 6) | (b[i + k] & 0x3f)
  }
  // Reject overlong encodings and surrogates: they are not what a re-encode produces.
  if ((len === 2 && cp < 0x80) || (len === 3 && cp < 0x800) || (len === 4 && cp < 0x10000)) return null
  if (cp >= 0xd800 && cp <= 0xdfff) return null
  return { len, cp }
}

interface Repair { bytes: Buffer; fixed: number; skipped: string[] }

/** Collapse every UTF-8 sequence that encodes a cp1252 character back to its byte. */
function repair(b: Buffer): Repair {
  const out: number[] = []
  const skipped: string[] = []
  let fixed = 0
  for (let i = 0; i < b.length;) {
    const seq = b[i] > 0x7f ? utf8At(b, i) : null
    if (seq) {
      const byte = TO_CP1252.get(seq.cp)
      if (byte !== undefined && byte > 0x7f) {
        out.push(byte)
        fixed++
        i += seq.len
        continue
      }
      skipped.push(`U+${seq.cp.toString(16).toUpperCase().padStart(4, '0')}`)
    }
    out.push(b[i])
    i++
  }
  return { bytes: Buffer.from(out), fixed, skipped }
}

/** SQL literal for exact cp1252 bytes (the form sqlText uses for accented text). */
const cp1252Literal = (b: Buffer) => `x'${b.toString('hex')}'`

/** Show a value on one line, with the repaired stretch in context. */
function excerpt(b: Buffer, around: number): string {
  const s = b.toString('latin1').replace(/[\r\n]+/g, ' ⏎ ')
  const i = Math.max(0, around - 30)
  return (i ? '…' : '') + s.slice(i, around + 45).trim() + '…'
}

interface Found { table: string; id: string; col: string; key: number; before: Buffer; after: Buffer; at: number; skipped: string[]; inScope: boolean }

async function findFixes(): Promise<Found[]> {
  const out: Found[] = []
  for (const t of TARGETS) {
    const rows = await queryB64Text<Record<string, unknown>>(
      `SELECT ${t.id} AS k, ${t.col} AS v FROM ${t.table}`,
    )
    for (const r of rows) {
      if (r.v == null) continue
      const before = Buffer.from(String(r.v), 'latin1')
      const { bytes: after, fixed, skipped } = repair(before)
      if (!fixed && !skipped.length) continue
      let at = 0
      while (at < before.length && before[at] === after[at]) at++
      const key = Number(r.k)
      if (fixed) out.push({ table: t.table, id: t.id, col: t.col, key, before, after, at, skipped, inScope: (t.keys as readonly number[]).includes(key) })
      else console.log(`  note ${t.table} ${r.k}: UTF-8 sequence(s) cp1252 cannot hold, left alone: ${skipped.join(', ')}`)
    }
  }
  return out
}

function show(f: Found) {
  console.log(`\n  ${f.table} ${f.key} (${f.col}), ${f.before.length} bytes -> ${f.after.length}`)
  console.log(`    before: ${excerpt(f.before, f.at)}`)
  console.log(`    after : ${excerpt(f.after, f.at)}`)
  if (f.skipped.length) console.log(`    left alone: ${f.skipped.join(', ')}`)
}

async function main() {
  const found = await findFixes()
  const fixes = found.filter(f => f.inScope)
  const others = found.filter(f => !f.inScope)
  const where = TARGETS.map(t => `${t.table}.${t.col}`).join(', ')

  console.log(`${fixes.length} value(s) in scope in ${where}`)
  fixes.forEach(show)
  if (others.length) {
    console.log(`\n${others.length} value(s) NOT in scope — found by the scan but not decided in a review. ` +
      `Listed, never written; take them to the next review:`)
    others.forEach(show)
  }
  if (!fixes.length) { console.log('\nnothing in scope to repair'); return }
  if (!WRITE) { console.log('\ndry run: nothing written (pass --write)'); return }
  if (fixes.length > MAX_ROWS) throw new Error(`${fixes.length} rows > MAX_ROWS ${MAX_ROWS}: look before writing`)

  let done = 0
  for (const f of fixes) {
    await query(`UPDATE ${f.table} SET ${f.col} = ${cp1252Literal(f.after)} WHERE ${f.id} = ${f.key}`)
    done++
  }
  const left = (await findFixes()).filter(f => f.inScope)
  console.log(`\nwritten: ${done}; in-scope mixed values left: ${left.length}`)
  if (left.length) process.exitCode = 1
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => closeConnection().catch(() => {}).then(() => process.exit()))
