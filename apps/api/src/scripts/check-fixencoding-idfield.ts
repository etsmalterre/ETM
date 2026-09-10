/**
 * Static guard: every `fixEncoding(rows, '<table>', '<idField>', …)` /
 * `repairAliased(…)` call must be fed by a SELECT that returns `<idField>`.
 *
 * Why: the helper re-reads each broken value with
 * `SELECT CONVERT(col USING 'UTF-8') FROM <table> WHERE <idField> = <id>`.
 * When the feeding query does not select the id, `row[idField]` is undefined,
 * the NaN backstop skips the repair and the U+FFFD glyph survives — harmless
 * on screen, but `sqlText()` then writes it back as a literal `?` the day the
 * value is re-saved (études coloris acceptance, #1137 / #1146), and every PDF
 * or email built from such a read prints `?` for `é` (#1145).
 *
 * Heuristic, no DB: for each call, the nearest preceding SELECT on the same
 * table (within 40 lines) must name the id column or use `*`. Template column
 * lists (`SELECT ${cols} …`) are reported separately for a human look.
 *
 * Run: node --import tsx src/scripts/check-fixencoding-idfield.ts
 * Exit 1 when a call is missing its id.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const files: string[] = []
;(function walk(d: string) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.ts$/.test(p) && !/\.test\.ts$/.test(p) && !p.includes(`${path.sep}scripts${path.sep}`)) files.push(p)
  }
})(root)

const missing: string[] = []
const templated: string[] = []

for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n')
  lines.forEach((l, i) => {
    const m = l.match(/(?:fixEncoding|repairAliased)\([^,]+,\s*'([^']+)'\s*,\s*'([^']+)'/)
    if (!m) return
    const table = m[1]
    const id = m[2]
    // Comments talk about SELECTs too — drop them before looking for the query.
    const prev = lines
      .slice(Math.max(0, i - 40), i)
      .filter((x) => !/^\s*(\/\/|\*|\/\*)/.test(x))
      .map((x) => x.replace(/\s\/\/.*$/, ''))
      .join('\n')
    // SQL in this codebase is upper-case: case-sensitive on purpose, so prose
    // like `selected:` or `selectProspectRows(` is not mistaken for a query.
    const sels = [...prev.matchAll(/\bSELECT\s[\s\S]*?\bFROM\s+(\w+)/g)]
    const s = sels.filter((x) => x[1].toLowerCase() === table.toLowerCase()).pop()
    if (!s) return
    const q = s[0].replace(/\s+/g, ' ')
    if (q.includes('${')) {
      templated.push(`${path.relative(root, f)}:${i + 1}  ${id} | ${q.slice(0, 110)}`)
      return
    }
    const ok =
      /SELECT (DISTINCT )?(TOP \d+ )?\*/i.test(q) ||
      new RegExp('(^|[^A-Za-z0-9_])' + id + '([^A-Za-z0-9_]|$)', 'i').test(q)
    if (!ok) missing.push(`${path.relative(root, f)}:${i + 1}  ${id} | ${q.slice(0, 110)}`)
  })
}

if (templated.length) {
  console.log('Template column lists (check by hand that the list names the id):')
  for (const t of templated) console.log('  ' + t)
}
if (missing.length) {
  console.log(`\n✗ ${missing.length} fixEncoding call(s) whose feeding SELECT does not return the id column:`)
  for (const t of missing) console.log('  ' + t)
  process.exit(1)
}
console.log('\n✓ every fixEncoding / repairAliased call is fed its id column')
