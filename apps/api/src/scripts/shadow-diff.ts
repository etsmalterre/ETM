// Shadow diff — step 4 of the HFSQL → PostgreSQL migration (windev_migration
// docs/plan.md, decision D4): a route counts as ported only when the SAME GET
// answers the SAME JSON on the HFSQL API and on the PostgreSQL one.
//
//   A = the reference, the production MPS API on HFSQL (default
//       https://etm.intra.etsmalterre.com)
//   B = an API running with DB_BACKEND=pg against mps_rehearsal (default the
//       pg-backend worktree, http://localhost:8083)
//
// GET only: nothing is ever written on either side. mps_rehearsal is last
// night's copy, so refresh the tables a suite reads right before diffing
// (`pg_migrate.py --only t1,t2` on the PG VM takes seconds) or rows edited
// since will show up as differences.
//
//   npx tsx src/scripts/shadow-diff.ts --suite=entreprises
//   npx tsx src/scripts/shadow-diff.ts --paths=/api/entreprises,/api/entreprises/7
//   options: --a=<url> --b=<url> --user=<IDutilisateur> --max-diffs=20 --limit=<ids per detail route>

const args = process.argv.slice(2)
const arg = (n: string) => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const A = arg('a') ?? 'https://etm.intra.etsmalterre.com'
const B = arg('b') ?? 'http://localhost:8083'
const USER = arg('user')
const MAX_DIFFS = Number(arg('max-diffs') ?? 12)
const LIMIT = Number(arg('limit') ?? 25)

type Json = unknown

/** A suite: fixed paths, plus detail paths built from the ids a list returns. */
interface Suite {
  paths: string[]
  details?: { list: string; id: string; paths: (id: number) => string[] }[]
}

const SUITES: Record<string, Suite> = {
  entreprises: {
    paths: ['/api/entreprises'],
    details: [{
      list: '/api/entreprises',
      id: 'IDentreprise',
      paths: id => [`/api/entreprises/${id}`, `/api/entreprises/${id}/competences/available`],
    }],
  },
}

// ── HTTP ─────────────────────────────────────────────────────

async function login(base: string): Promise<string> {
  if (!USER) return ''
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ IDutilisateur: Number(USER) }),
  })
  if (!r.ok) throw new Error(`login on ${base}: HTTP ${r.status}`)
  return (r.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
}

async function get(base: string, path: string, cookie: string): Promise<{ status: number; body: Json; ms: number }> {
  const t0 = Date.now()
  const r = await fetch(base + path, { headers: cookie ? { cookie } : {} })
  const text = await r.text()
  let body: Json = text
  try { body = JSON.parse(text) } catch { /* keep text */ }
  return { status: r.status, body, ms: Date.now() - t0 }
}

// ── Diff ─────────────────────────────────────────────────────

interface Diff { path: string; a: Json; b: Json }

const show = (v: Json) => {
  const s = JSON.stringify(v)
  return s === undefined ? 'undefined' : s.length > 90 ? s.slice(0, 87) + '…' : s
}

function diff(a: Json, b: Json, path: string, out: Diff[]) {
  if (a === b) return
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    out.push({ path, a, b })
    return
  }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push({ path, a, b }); return }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push({ path: `${path}.length`, a: a.length, b: b.length })
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out)
    return
  }
  const ao = a as Record<string, Json>, bo = b as Record<string, Json>
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    if (!(k in bo)) out.push({ path: `${path}.${k}`, a: ao[k], b: '<missing>' })
    else if (!(k in ao)) out.push({ path: `${path}.${k}`, a: '<missing>', b: bo[k] })
    else diff(ao[k], bo[k], `${path}.${k}`, out)
  }
}

/** Collapse array indexes so 300 rows with the same problem read as one line. */
const pattern = (p: string) => p.replace(/\[\d+\]/g, '[]')

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const suiteName = arg('suite')
  const suite: Suite = suiteName
    ? SUITES[suiteName] ?? (() => { throw new Error(`unknown suite ${suiteName}: ${Object.keys(SUITES).join(', ')}`) })()
    : { paths: (arg('paths') ?? '').split(',').filter(Boolean) }
  // Refuse to compare unless B really runs on PostgreSQL and A does not: on
  // 2026-09-22 the first "diff" compared HFSQL with dev HFSQL because the
  // worktree API never saw DB_BACKEND (fixed in hfsql-auto.ts, checked here).
  const backendOf = async (base: string) =>
    ((await get(base, '/api/health?db=1', '')).body as { backend?: string })?.backend ?? 'hfsql (no backend field)'
  const [ka, kb] = await Promise.all([backendOf(A), backendOf(B)])
  if (kb !== 'pg' || ka === 'pg') throw new Error(`backends are A=${ka}, B=${kb}: need A on HFSQL and B on pg`)
  const [ca, cb] = await Promise.all([login(A), login(B)])
  console.log(`A ${A}  (${ka})\nB ${B}  (${kb})\n`)

  const paths = [...suite.paths]
  for (const d of suite.details ?? []) {
    const list = await get(A, d.list, ca)
    const ids = Array.isArray(list.body) ? (list.body as Record<string, Json>[]).map(r => Number(r[d.id])).filter(Number.isFinite) : []
    // spread the sample over the whole list, not only the first rows
    const step = Math.max(1, Math.floor(ids.length / LIMIT))
    for (let i = 0; i < ids.length && paths.length < 1000; i += step) paths.push(...d.paths(ids[i]))
  }

  let same = 0, differ = 0
  const byPattern = new Map<string, { n: number; example: Diff; url: string }>()
  for (const p of paths) {
    const [ra, rb] = await Promise.all([get(A, p, ca), get(B, p, cb)])
    const diffs: Diff[] = []
    if (ra.status !== rb.status) diffs.push({ path: '<status>', a: ra.status, b: rb.status })
    diff(ra.body, rb.body, '$', diffs)
    if (!diffs.length) { same++; continue }
    differ++
    console.log(`✗ ${p}  (${diffs.length} diff${diffs.length > 1 ? 's' : ''}, A ${ra.ms} ms, B ${rb.ms} ms)`)
    for (const d of diffs) {
      const key = pattern(p.replace(/\/\d+/g, '/:id')) + '  ' + pattern(d.path)
      const e = byPattern.get(key)
      if (e) e.n++
      else byPattern.set(key, { n: 1, example: d, url: p })
    }
  }

  console.log(`\n${same}/${paths.length} identical, ${differ} different`)
  if (byPattern.size) {
    console.log(`\nDifferences by shape (${byPattern.size}):`)
    for (const [key, { n, example, url }] of [...byPattern].sort((x, y) => y[1].n - x[1].n).slice(0, MAX_DIFFS)) {
      console.log(`  ×${n}  ${key}\n        e.g. ${url} ${example.path}: A ${show(example.a)}  B ${show(example.b)}`)
    }
  }
  process.exitCode = differ ? 1 : 0
}

main().catch(e => { console.error(e); process.exitCode = 2 })
