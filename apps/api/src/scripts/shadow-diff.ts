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

import { createHash } from 'crypto'

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
  paths?: string[]
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

  // ── The heavy screens (windev_migration docs/plan.md § C6) ──────────────
  // Each suite is « the lists and lookups a screen loads », then a sample of
  // its detail pages spread over the whole list (see LIMIT / step below).

  'stock-ecru': {
    paths: [
      '/api/stock/ecru', '/api/stock/ecru?second_choix=1', '/api/stock/ecru?statut=dispo',
      '/api/stock/ecru/suivi',
      '/api/stock/ecru/lookups/refs', '/api/stock/ecru/lookups/coloris', '/api/stock/ecru/lookups/magasins',
    ],
    details: [{
      list: '/api/stock/ecru', id: 'IDstock_ecru',
      paths: id => [`/api/stock/ecru/${id}`, `/api/stock/ecru/${id}/provenance`],
    }],
  },

  'stock-fini': {
    paths: [
      '/api/stock/fini', '/api/stock/fini?expedie=1',
      '/api/stock/fini/lookups/etats', '/api/stock/fini/lookups/refs',
      '/api/stock/fini/lookups/coloris', '/api/stock/fini/lookups/magasins',
    ],
    details: [{
      list: '/api/stock/fini', id: 'IDstock_fini',
      paths: id => [`/api/stock/fini/${id}`, `/api/stock/fini/${id}/provenance`, `/api/stock/fini/${id}/label`],
    }],
  },

  'stock-fil': {
    paths: ['/api/stock/fil', '/api/stock/fil/etat', '/api/stock/fil/la-gentle-stale'],
    details: [{ list: '/api/stock/fil', id: 'IDstock_fil', paths: id => [`/api/stock/fil/${id}`] }],
  },

  'commandes-client': {
    paths: [
      '/api/commandes-client', '/api/commandes-client?status=en-cours', '/api/commandes-client/du-jour',
      '/api/commandes-client/urgency-counts',
      '/api/commandes-client/lookups/clients', '/api/commandes-client/lookups/adresses',
      '/api/commandes-client/lookups/refs-ecru', '/api/commandes-client/lookups/colori-ecru',
      '/api/commandes-client/lookups/refs-fini', '/api/commandes-client/lookups/colori-fini',
      '/api/commandes-client/lookups/refs-divers', '/api/commandes-client/lookups/modes-paiement',
      '/api/commandes-client/lookups/echeances', '/api/commandes-client/lookups/type-doc',
    ],
    details: [{
      list: '/api/commandes-client', id: 'IDcommande_client',
      paths: id => [
        `/api/commandes-client/${id}`,
        `/api/commandes-client/${id}/historique`,
        `/api/commandes-client/${id}/documents`,
        `/api/commandes-client/${id}/factures`,
        `/api/commandes-client/${id}/expeditions-divers`,
        `/api/commandes-client/${id}/donation-pieces`,
      ],
    }],
  },

  'commandes-fil': {
    paths: [
      '/api/commandes-fil',
      '/api/commandes-fil/lookups/refs-fil', '/api/commandes-fil/lookups/adresses',
      '/api/commandes-fil/lookups/modes-paiement', '/api/commandes-fil/lookups/echeances',
      '/api/commandes-fil/lookups/type-doc',
    ],
    details: [{
      list: '/api/commandes-fil', id: 'IDcommande_fil',
      paths: id => [`/api/commandes-fil/${id}`, `/api/commandes-fil/${id}/documents`],
    }],
  },

  'commandes-sst': {
    paths: [
      '/api/commandes-sous-traitant', '/api/commandes-sous-traitant/urgency-counts',
      '/api/commandes-sous-traitant/lookups/sous-traitants', '/api/commandes-sous-traitant/lookups/magasins',
      '/api/commandes-sous-traitant/lookups/refs-ecru', '/api/commandes-sous-traitant/lookups/refs-fini',
      '/api/commandes-sous-traitant/lookups/colori-ecru', '/api/commandes-sous-traitant/lookups/colori-fini',
      '/api/commandes-sous-traitant/lookups/adresses', '/api/commandes-sous-traitant/lookups/type-doc',
    ],
    details: [{
      list: '/api/commandes-sous-traitant', id: 'IDcommande_sous_traitant',
      paths: id => [
        `/api/commandes-sous-traitant/${id}`,
        `/api/commandes-sous-traitant/${id}/historique`,
        `/api/commandes-sous-traitant/${id}/documents`,
        `/api/commandes-sous-traitant/${id}/mentions-qualite`,
      ],
    }],
  },

  facturation: {
    paths: ['/api/factures', '/api/rapports/factures'],
    details: [{ list: '/api/factures', id: 'IDfacture', paths: id => [`/api/factures/${id}`] }],
  },

  expeditions: {
    paths: [
      '/api/expeditions',
      '/api/expeditions/lookups/transporteurs', '/api/expeditions/lookups/clients',
      '/api/expeditions/lookups/commandes', '/api/expeditions/lookups/adresses',
      '/api/expeditions/lookups/contacts',
      '/api/expeditions/divers/lookups/refs', '/api/expeditions/divers/lookups/prix',
    ],
    details: [{
      list: '/api/expeditions', id: 'IDexpedition',
      paths: id => [`/api/expeditions/formelle/${id}`],
    }],
  },

  devis: {
    paths: [
      '/api/devis', '/api/devis/urgency-counts',
      '/api/devis/lookups/clients', '/api/devis/lookups/adresses', '/api/devis/lookups/refs-fini',
      '/api/devis/lookups/refs-ecru', '/api/devis/lookups/refs-divers', '/api/devis/lookups/colori-fini',
      '/api/devis/lookups/modes-paiement', '/api/devis/lookups/echeances', '/api/devis/lookups/type-doc',
    ],
    details: [{
      list: '/api/devis', id: 'IDdevis',
      paths: id => [`/api/devis/${id}`, `/api/devis/${id}/historique`, `/api/devis/${id}/documents`],
    }],
  },

  atelier: {
    paths: ['/api/atelier/bonnetiers', '/api/atelier/machines', '/api/atelier/lookups/defauts'],
    details: [{
      list: '/api/of-trm', id: 'IDordre_fabrication',
      paths: id => [
        `/api/atelier/of/${id}`, `/api/atelier/of/${id}/reglage`, `/api/atelier/of/${id}/messages`,
        `/api/atelier/of/${id}/historique`, `/api/atelier/of/${id}/fils`,
      ],
    }],
  },

  of: {
    paths: [
      '/api/of-trm', '/api/of-trm?all=1',
      '/api/of-trm/lookups/machines', '/api/of-trm/lookups/lignes-commande', '/api/of-trm/lookups/composition',
      '/api/of-trm/lookups/observations', '/api/of-trm/lookups/coloris-ecru', '/api/of-trm/lookups/fils',
      '/api/of-trm/lookups/lots',
    ],
    details: [{
      list: '/api/of-trm', id: 'IDordre_fabrication',
      paths: id => [
        `/api/of-trm/${id}`, `/api/of-trm/${id}/production`, `/api/of-trm/${id}/qualite`,
        `/api/of-trm/${id}/performance`, `/api/of-trm/${id}/visitage`,
        `/api/of-trm/${id}/observations`, `/api/of-trm/${id}/observations-ref`,
      ],
    }],
  },

  trs: { paths: ['/api/trs/atelier', '/api/trs/equipe'] },

  pointage: {
    paths: [
      '/api/pointage-admin/salaries', '/api/pointage-admin/bonnetiers', '/api/pointage-admin/en-poste',
      '/api/pointage-admin/horaires', '/api/pointage-admin/lissage/semaines',
      '/api/pointage-admin/previsionnel', '/api/pointage-admin/paie',
      '/api/pointage/en-poste', '/api/pointage/salaries',
    ],
    details: [{
      list: '/api/pointage-admin/salaries', id: 'IDsalarie',
      paths: id => [`/api/pointage-admin/salaries/${id}/messages`, `/api/pointage/salaries/${id}/etat`],
    }],
  },

  rapports: {
    paths: [
      '/api/rapports/factures', '/api/rapports/commandes-clients', '/api/rapports/commandes-fil',
      '/api/rapports/commandes-sst', '/api/rapports/stock/valorisation',
      '/api/rapports/commandes-clients?soldees=1', '/api/rapports/commandes-sst?terminees=1',
      '/api/rapports-trm/factures',
    ],
  },

  dashboard: {
    paths: [
      '/api/dashboard-trm/poids-pieces', '/api/dashboard-trm/pieces-a-visiter',
      '/api/dashboard-trm/rapport-production',
      '/api/user-profiles/me/dashboard',
      '/api/commandes-client/urgency-counts', '/api/commandes-sous-traitant/urgency-counts',
      '/api/devis/urgency-counts',
    ],
  },

  qualite: {
    paths: ['/api/dossiers-qualite', '/api/dossiers-qualite/lookups', '/api/actions-qualite',
            '/api/actions-qualite/lookups/coloris', '/api/actions-qualite/lookups/references',
            '/api/actions-qualite/lookups/sous-traitants', '/api/suivi-lots'],
    details: [{
      list: '/api/dossiers-qualite', id: 'IDdossier_qualite',
      paths: id => [`/api/dossiers-qualite/${id}`, `/api/dossiers-qualite/${id}/tracabilite`,
                    `/api/dossiers-qualite/${id}/documents`],
    }],
  },

  // PDFs: compared as binary (see the binary branch in get()). @react-pdf stamps
  // a creation date into every file, so only the status and a stable size band
  // can match — a PDF built from different data changes size well beyond that.
  pdf: {
    details: [
      { list: '/api/commandes-client', id: 'IDcommande_client',
        paths: id => [`/api/commandes-client/${id}/pdf`, `/api/commandes-client/${id}/proforma/pdf`] },
      { list: '/api/devis', id: 'IDdevis', paths: id => [`/api/devis/${id}/pdf`] },
      { list: '/api/commandes-sous-traitant', id: 'IDcommande_sous_traitant',
        paths: id => [`/api/commandes-sous-traitant/${id}/pdf`] },
      { list: '/api/expeditions', id: 'IDexpedition',
        paths: id => [`/api/expeditions/formelle/${id}/pdf`] },
    ],
    paths: ['/api/commandes-client/cgv/pdf'],
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

/** ⚠️ A PDF from @react-pdf is NOT reproducible: the same document fetched twice
 *  from the SAME server gives different bytes at an identical size (measured on
 *  prod 2026-09-23, /api/commandes-client/7202/pdf, 47271 bytes both times).
 *  Stripping /CreationDate, /ModDate and /ID is not enough — something else in
 *  the generator varies per run. So a digest would report a difference on every
 *  single PDF, which is worse than useless.
 *
 *  PDFs are therefore compared on BYTE LENGTH alone. It is a proxy, not a proof:
 *  same size means the same text ran through the same layout, and a PDF built
 *  from different data almost always changes size. A PDF that must be checked
 *  properly is opened by hand (claude_doc/pdf_email.md § how to verify a PDF). */
const isPdf = (type: string) => /pdf/.test(type)

async function get(base: string, path: string, cookie: string): Promise<{ status: number; body: Json; ms: number }> {
  const t0 = Date.now()
  const r = await fetch(base + path, { headers: cookie ? { cookie } : {} })
  const type = r.headers.get('content-type') ?? ''
  // Binary answers (PDF, label images, stored documents) never parse as JSON:
  // compare a content digest and the size instead of the bytes themselves, so
  // the report stays readable.
  if (!/json|text\//.test(type)) {
    const buf = Buffer.from(await r.arrayBuffer())
    const body: Record<string, Json> = { binary: type.split(';')[0], bytes: buf.length }
    // Everything that is not a PDF (images, labels as PNG) IS reproducible:
    // compare it byte for byte through a digest.
    if (!isPdf(type)) body.digest = createHash('sha1').update(buf).digest('hex')
    return { status: r.status, body, ms: Date.now() - t0 }
  }
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

// ── Known harmless classes (windev_migration docs/plan.md § Steps 3–4) ─────
// A difference is only « real » when none of these explains it.

/** HFSQL computes some sums in 4-byte floats: 41.60000038147 or 26.92924642563
 *  vs PostgreSQL's 41.6 and 26.92928 (7 significant digits, errors accumulate). */
const floatNoise = (a: Json, b: Json) =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(a))

/** The HFSQL read path decodes cp1252 as Latin-1, so the 32 cp1252-only
 *  characters reach the apps as invisible C1 controls (€ → U+0080, ’ → U+0092,
 *  – → U+0096, œ → U+009C), and a few as U+FFFD. PostgreSQL returns the real
 *  characters: an HFSQL-side defect, not a migration difference. */
const CP1252_C1 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ'
const fromC1 = (s: string) => s.replace(/[\u0080-\u009F]/g, c => CP1252_C1[c.charCodeAt(0) - 0x80])
const typographyOnly = (a: Json, b: Json) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const fixed = fromC1(a)
  if (fixed === b) return true
  if (!fixed.includes('�')) return false
  const re = new RegExp('^' + fixed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/�/g, '.') + '$', 's')
  return re.test(b)
}

/** Same rows, other order: HFSQL sorts text per its index options (case, spaces,
 *  punctuation vary by column), PostgreSQL in one French order — the open
 *  decision « text sort order » in docs/plan.md § Review agenda.
 *
 *  Compared as MULTISETS of whole rows, not by an id key. An id key only works
 *  when it is unique in the list, and several lookups return one row per
 *  (ref, colori) pair, so `IDref_ecru` repeats and the id match collapsed rows
 *  onto each other — 1543 « real » differences on one lookup that were only a
 *  different ORDER BY. Each row is canonicalised (keys sorted, C1 typography
 *  repaired, floats rounded) and the two bags of rows are compared. */
function canonicalRow(r: Json): string {
  const norm = (v: Json): Json => {
    if (typeof v === 'number') return Math.round(v * 1e5) / 1e5
    if (typeof v === 'string') return fromC1(v)
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') {
      const o = v as Record<string, Json>
      return Object.fromEntries(Object.keys(o).sort().map(k => [k, norm(o[k])]))
    }
    return v
  }
  return JSON.stringify(norm(r))
}

function sameRowsOtherOrder(a: Json, b: Json): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return false
  const bag = new Map<string, number>()
  for (const r of b) bag.set(canonicalRow(r), (bag.get(canonicalRow(r)) ?? 0) + 1)
  for (const r of a) {
    const k = canonicalRow(r)
    const n = bag.get(k)
    if (!n) return false
    bag.set(k, n - 1)
  }
  return true
}

type Verdict = 'identical' | 'order' | 'harmless' | 'different'

function verdict(ra: { status: number; body: Json }, rb: { status: number; body: Json }, diffs: Diff[]): Verdict {
  if (!diffs.length) return 'identical'
  if (ra.status === rb.status && diffs.every(d => floatNoise(d.a, d.b) || typographyOnly(d.a, d.b))) return 'harmless'
  if (ra.status === rb.status && sameRowsOtherOrder(ra.body, rb.body)) return 'order'
  return 'different'
}

/** Collapse array indexes so 300 rows with the same problem read as one line. */
const pattern = (p: string) => p.replace(/\[\d+\]/g, '[]')

// ── Main ─────────────────────────────────────────────────────

async function main() {
  // --suite=stock-ecru, several at once (--suite=stock-ecru,stock-fini) or =all.
  const names = arg('suite') === 'all' ? Object.keys(SUITES) : (arg('suite') ?? '').split(',').filter(Boolean)
  for (const n of names) {
    if (!SUITES[n]) throw new Error(`unknown suite ${n}. Known: ${Object.keys(SUITES).join(', ')}`)
  }
  const suite: Suite = names.length
    ? { paths: names.flatMap(n => SUITES[n].paths ?? []), details: names.flatMap(n => SUITES[n].details ?? []) }
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

  const paths = [...(suite.paths ?? [])]
  for (const d of suite.details ?? []) {
    const list = await get(A, d.list, ca)
    const ids = Array.isArray(list.body) ? (list.body as Record<string, Json>[]).map(r => Number(r[d.id])).filter(Number.isFinite) : []
    // spread the sample over the whole list, not only the first rows
    const step = Math.max(1, Math.floor(ids.length / LIMIT))
    for (let i = 0; i < ids.length && paths.length < 1000; i += step) paths.push(...d.paths(ids[i]))
  }

  const counts: Record<Verdict, number> = { identical: 0, order: 0, harmless: 0, different: 0 }
  const byPattern = new Map<string, { n: number; example: Diff; url: string }>()
  for (const p of paths) {
    const [ra, rb] = await Promise.all([get(A, p, ca), get(B, p, cb)])
    const diffs: Diff[] = []
    if (ra.status !== rb.status) diffs.push({ path: '<status>', a: ra.status, b: rb.status })
    diff(ra.body, rb.body, '$', diffs)
    const v = verdict(ra, rb, diffs)
    counts[v]++
    if (v === 'identical') continue
    const real = diffs.filter(d => !floatNoise(d.a, d.b) && !typographyOnly(d.a, d.b))
    console.log(`${v === 'different' ? '✗' : '~'} ${p}  ${v === 'order' ? 'same rows, other order' : v === 'harmless' ? 'float noise / HFSQL encoding defect only' : `${real.length} real diff(s)`}`)
    if (v !== 'different') continue
    for (const d of real) {
      const key = pattern(p.replace(/\/\d+/g, '/:id')) + '  ' + pattern(d.path)
      const e = byPattern.get(key)
      if (e) e.n++
      else byPattern.set(key, { n: 1, example: d, url: p })
    }
  }

  console.log(`\n${paths.length} compared: ${counts.identical} identical, ${counts.order} same rows in another order, ` +
    `${counts.harmless} float noise / HFSQL encoding defect only, ${counts.different} REALLY different`)
  if (byPattern.size) {
    console.log(`\nReal differences by shape (${byPattern.size}):`)
    for (const [key, { n, example, url }] of [...byPattern].sort((x, y) => y[1].n - x[1].n).slice(0, MAX_DIFFS)) {
      console.log(`  ×${n}  ${key}\n        e.g. ${url} ${example.path}: A ${show(example.a)}  B ${show(example.b)}`)
    }
  }
  process.exitCode = counts.different ? 1 : 0
}

main().catch(e => { console.error(e); process.exitCode = 2 })
