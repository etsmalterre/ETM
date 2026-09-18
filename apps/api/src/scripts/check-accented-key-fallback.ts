/**
 * Static guard: an accented HFSQL column read off a `SELECT *` row must be
 * resolved by PREFIX (`pickVal(r, /^archiv/i)` from lib/accented-keys.ts, or
 * `pick(r, 'archivé', 'archiv')` from lib/clients-common.ts, whose second
 * pass is a prefix match), never by an exact fallback list.
 *
 * Why: the Linux bridge returns the key truncated at the accent PLUS a
 * garbage trailing byte (`archiv?`, `archivt`, …), so `r.archiv ??
 * r['archivé']` matches nothing in production and the flag reads 0 on every
 * row — a silent wrong number. Shipped five times (#1090, diamètre in
 * pricing-trm, #1177: archived designations listed on Clients › Gestion and
 * every archived client shown « En cours »).
 *
 * Flags, outside comments, tests and scripts:
 *   - `?? x['…é…']` / `?? x.…é…`   — exact accented fallback
 *   - `x.<stem>` where <stem> is a known truncated name (`archiv`, `cach`,
 *     `termin`, `recycl`, `fil_non_factur`, `diam`, `certif_recycl`, `contro`)
 *     read as a bare property (not followed by a word char or `(`).
 *
 * Run: node --import tsx src/scripts/check-accented-key-fallback.ts
 * Exit 1 on any hit.
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

const STEMS = ['archiv', 'cach', 'termin', 'recycl', 'fil_non_factur', 'diam', 'certif_recycl', 'contro']
const exactFallback = /\?\?\s*[\w.]+(?:\[['"][^'"]*[^\x00-\x7F][^'"]*['"]\]|\.\w*[^\x00-\x7F]\w*)/
const bareStem = new RegExp(`\\b[a-zA-Z_]\\w*\\.(${STEMS.join('|')})\\b(?![\\w(]|[^\\x00-\\x7F])`)

const hits: string[] = []
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n')
  lines.forEach((raw, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(raw)) return
    // SQL template literals name the real column on the Windows branch
    // (`sf.terminé AS termine`), and `req.query.terminé` is a URL param.
    if (raw.includes('`') || raw.includes('req.query')) return
    const l = raw.replace(/\s\/\/.*$/, '')
    if (exactFallback.test(l) || bareStem.test(l)) hits.push(`${path.relative(root, f)}:${i + 1}  ${l.trim().slice(0, 120)}`)
  })
}

if (hits.length === 0) {
  console.log(`OK — no exact accented-key fallback in ${files.length} files`)
} else {
  console.log(`FAIL — ${hits.length} exact accented-key read(s); resolve by prefix (pickVal / pick):`)
  for (const h of hits) console.log('  ' + h)
  process.exit(1)
}
