// Write testing — step B5 of the HFSQL → PostgreSQL migration (sibling repo
// windev_migration, docs/plan.md). The shadow diff proves that READS match;
// this proves that WRITES work on PostgreSQL, which the diff can never do
// because it is GET-only.
//
// Each scenario creates a row through a real API route, reads it back through
// another route, edits it, reads again, deletes it and checks it is gone —
// so what is exercised is the SQL the routes actually emit, not a rewrite of it.
// Every scenario cleans up after itself, including after a failure.
//
// ⚠️ It writes. Three guards, all of which must pass:
//   1. the target API answers `backend: pg` on /api/health?db=1;
//   2. its `database` is a rehearsal copy (name contains « rehearsal »);
//   3. the base URL is local (the worktree API), unless --i-know is passed.
// It therefore cannot touch production HFSQL or the real `mps` database.
//
//   node scripts/worktree/up.mjs pg-backend --restart   # from ETM, if :8083 is down
//   npx tsx src/scripts/pg-write-test.ts
//   npx tsx src/scripts/pg-write-test.ts --only=accented-composition --verbose
//   options: --b=<url> --user=<IDutilisateur> --only=<name,name> --verbose

const args = process.argv.slice(2)
const arg = (n: string) => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const B = arg('b') ?? 'http://localhost:8083'
const USER = arg('user') ?? '1'
const ONLY = (arg('only') ?? '').split(',').filter(Boolean)
const VERBOSE = args.includes('--verbose')
const FORCE = args.includes('--i-know')

/** Everything this script creates is named with this, so a leftover is obvious. */
const TAG = `ZZTEST-${Date.now().toString(36).toUpperCase()}`

let cookie = ''

interface Res { status: number; body: any; text: string }

async function req(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(B + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) } catch { /* keep text */ }
  if (VERBOSE) console.log(`      ${method} ${path} → ${r.status}`)
  return { status: r.status, body: parsed, text }
}

const GET = (p: string) => req('GET', p)
const POST = (p: string, b?: unknown) => req('POST', p, b ?? {})
const PUT = (p: string, b?: unknown) => req('PUT', p, b ?? {})
const DEL = (p: string) => req('DELETE', p)

// ── assertions ───────────────────────────────────────────────

class Failed extends Error {}

function ok(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Failed(what)
}
function eq(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Failed(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
/** 2xx, or a readable failure carrying the body the API sent back. */
function okStatus(r: Res, what: string) {
  if (r.status < 200 || r.status >= 300) throw new Failed(`${what}: HTTP ${r.status} ${r.text.slice(0, 200)}`)
}

// ── scenarios ────────────────────────────────────────────────

interface Scenario {
  name: string
  what: string
  run(): Promise<void>
}

const SCENARIOS: Scenario[] = [
  {
    name: 'entreprise',
    what: 'plain create / edit / delete, and the « no RETURNING » re-read by max(id)',
    async run() {
      // Create. The route inserts without the key and finds the row back by the
      // highest IDentreprise — which only works if PostgreSQL numbered it (R8).
      const created = await POST('/api/entreprises', { nom: `${TAG} entreprise`, commentaire: 'créé par le test' })
      okStatus(created, 'create')
      const id = Number(created.body?.IDentreprise)
      ok(Number.isFinite(id) && id > 0, `create returned no usable IDentreprise: ${JSON.stringify(created.body)}`)
      try {
        // Read back through the detail route.
        const read = await GET(`/api/entreprises/${id}`)
        okStatus(read, 'read back')
        eq(read.body?.nom, `${TAG} entreprise`, 'nom after create')
        eq(read.body?.commentaire, 'créé par le test', 'accented text survived the insert')

        // Edit.
        okStatus(await PUT(`/api/entreprises/${id}`, { nom: `${TAG} modifié`, commentaire: 'à jour' }), 'edit')
        const after = await GET(`/api/entreprises/${id}`)
        eq(after.body?.nom, `${TAG} modifié`, 'nom after edit')
        eq(after.body?.commentaire, 'à jour', 'commentaire after edit')

        // A child row on its own table (contact), then the parent's delete.
        okStatus(await POST(`/api/entreprises/${id}/contacts`, { nom: `${TAG}`, prenom: 'Hélène', tel: '', mail: '' }), 'add contact')
        const withChild = await GET(`/api/entreprises/${id}`)
        ok(Array.isArray(withChild.body?.contacts) && withChild.body.contacts.some((c: any) => c.prenom === 'Hélène'),
           'the contact just created is not in the detail payload')
      } finally {
        await DEL(`/api/entreprises/${id}`)
      }
      const gone = await GET(`/api/entreprises/${id}`)
      ok(gone.status === 404 || gone.body?.est_visible === 0 || gone.body?.est_visible === false,
         `after delete the entreprise is still readable: HTTP ${gone.status}`)
    },
  },

  {
    name: 'two-inserts-in-a-row',
    what: 'R8: two creates in a row get two different keys (the sequence, not max+1 racing)',
    async run() {
      const a = await POST('/api/entreprises', { nom: `${TAG} A`, commentaire: '' })
      const b = await POST('/api/entreprises', { nom: `${TAG} B`, commentaire: '' })
      okStatus(a, 'create A'); okStatus(b, 'create B')
      const ida = Number(a.body?.IDentreprise), idb = Number(b.body?.IDentreprise)
      try {
        ok(Number.isFinite(ida) && Number.isFinite(idb), 'one of the creates returned no key')
        ok(ida !== idb, `both creates got the same key ${ida}`)
        eq(idb, ida + 1, 'the second key does not follow the first')
      } finally {
        if (Number.isFinite(ida)) await DEL(`/api/entreprises/${ida}`)
        if (Number.isFinite(idb)) await DEL(`/api/entreprises/${idb}`)
      }
    },
  },

  {
    name: 'accented-composition',
    what: 'R10 + positional INSERT: asso_fil_matiere is written with no column names, key by hand',
    async run() {
      // references-fil writes the composition rows positionally (the table has an
      // accented key, IDasso_fil_matière, which the Linux bridge cannot name) and
      // computes the key itself as max+1. On PostgreSQL that key would collide
      // with the identity's next value without the R10 trigger.
      const list = await GET('/api/references-fil')
      okStatus(list, 'list refs fil')
      const ref = (list.body as any[])?.[0]
      ok(ref, 'no reference fil to test with')
      const refId = Number(ref.IDref_fil)

      const before = await GET(`/api/references-fil/${refId}`)
      okStatus(before, 'read ref fil')
      const countBefore = ((before.body?.composition ?? []) as any[]).length
      const matieres = await GET('/api/references-fil/lookups/matieres')
      okStatus(matieres, 'lookup matieres')
      const mat = (matieres.body as any[])?.[0]
      ok(mat?.IDmatiere_premiere, 'no matiere to compose with')

      // Add one composition row — a positional INSERT whose key the route
      // computes itself, then read it back and remove it again.
      const created = await POST(`/api/references-fil/${refId}/compositions`, {
        IDmatiere: Number(mat.IDmatiere_premiere), pourcentage: 7, bio: false, recycle: false,
      })
      okStatus(created, 'add composition')
      const after = await GET(`/api/references-fil/${refId}`)
      const comps = (after.body?.composition ?? []) as any[]
      eq(comps.length, countBefore + 1, 'composition count after the positional insert')
      const mine = comps.find(c => Number(c.pourcentage) === 7)
      ok(mine, 'the composition just added is not in the detail payload')
      const assoId = Number(mine.IDasso_fil_matiere)
      ok(Number.isFinite(assoId) && assoId > 0, `no usable IDasso_fil_matiere: ${JSON.stringify(mine)}`)
      try {
        eq(Number(mine.IDmatiere), Number(mat.IDmatiere_premiere), 'IDmatiere after the positional insert')
      } finally {
        await DEL(`/api/references-fil/${refId}/compositions/${assoId}`)
      }
      const restored = await GET(`/api/references-fil/${refId}`)
      eq(((restored.body?.composition ?? []) as any[]).length, countBefore, 'composition count after cleanup')
    },
  },

  {
    name: 'blob-ged',
    what: 'bytea: a document is stored as x\'hex\' and comes back byte for byte',
    async run() {
      const list = await GET('/api/commandes-fil')
      okStatus(list, 'list commandes fil')
      const cmd = (list.body as any[])?.[0]
      ok(cmd, 'no commande fil to attach a document to')
      const id = Number(cmd.IDcommande_fil)
      const types = await GET('/api/commandes-fil/lookups/type-doc')
      const typeDoc = Number((types.body as any[])?.[0]?.IDtype_doc ?? 1)

      // A small PNG, so the bytes are binary and not accidentally valid text.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64')
      const form = new FormData()
      form.append('nom', `${TAG}.png`)
      form.append('commentaire', 'blob test')
      form.append('IDtype_doc', String(typeDoc))
      form.append('fichier', new Blob([png], { type: 'image/png' }), `${TAG}.png`)
      const up = await fetch(`${B}/api/commandes-fil/${id}/documents`, { method: 'POST', headers: { cookie }, body: form })
      const upBody: any = await up.json().catch(() => ({}))
      ok(up.ok, `upload: HTTP ${up.status}`)
      const idged = Number(upBody?.IDged)
      ok(Number.isFinite(idged), `upload returned no IDged: ${JSON.stringify(upBody)}`)
      try {
        const back = await fetch(`${B}/api/commandes-fil/${id}/documents/${idged}/fichier`, { headers: { cookie } })
        ok(back.ok, `download: HTTP ${back.status}`)
        const got = Buffer.from(await back.arrayBuffer())
        eq(got.length, png.length, 'stored blob length')
        ok(got.equals(png), 'the bytes that came back differ from the bytes sent')
      } finally {
        await DEL(`/api/commandes-fil/${id}/documents/${idged}`)
      }
    },
  },

  {
    name: 'prospect',
    what: 'the MAX(ID)+1 create path, and a status edit',
    async run() {
      const created = await POST('/api/prospects', { nom: `${TAG} prospect`, ville: 'Moreuil', commentaire: 'créé' })
      okStatus(created, 'create prospect')
      const id = Number(created.body?.IDprospect ?? created.body?.id)
      ok(Number.isFinite(id), `create returned no IDprospect: ${JSON.stringify(created.body)}`)
      try {
        const read = await GET(`/api/prospects/${id}`)
        okStatus(read, 'read prospect')
        eq(read.body?.nom, `${TAG} prospect`, 'nom after create')
      } finally {
        await DEL(`/api/prospects/${id}`)
      }
    },
  },

  {
    name: 'client',
    what: 'create / edit / archive on the most-read table of the base',
    async run() {
      const created = await POST('/api/clients', { nom: `${TAG} client`, compte: '', client_interne: 0 })
      okStatus(created, 'create client')
      const id = Number(created.body?.IDclient)
      ok(Number.isFinite(id), `create returned no IDclient: ${JSON.stringify(created.body)}`)
      try {
        const read = await GET(`/api/clients/${id}`)
        okStatus(read, 'read client')
        eq(read.body?.nom, `${TAG} client`, 'nom after create')
        okStatus(await POST(`/api/clients/${id}/archive`), 'archive')
        const archived = await GET(`/api/clients/${id}`)
        ok(Number(archived.body?.archive ?? archived.body?.archivé) === 1, 'client not archived after the call')
        okStatus(await POST(`/api/clients/${id}/unarchive`), 'unarchive')
      } finally {
        await DEL(`/api/clients/${id}`)
      }
    },
  },
]

// ── main ─────────────────────────────────────────────────────

async function main() {
  // Guard 1 + 2: the target must be a PostgreSQL API on a rehearsal database.
  const health = await GET('/api/health?db=1')
  const backend = health.body?.backend
  const database = health.body?.database
  if (backend !== 'pg') {
    throw new Error(`${B} runs on « ${backend ?? 'hfsql'} », not PostgreSQL. This script writes: refusing.`)
  }
  if (!/rehearsal/i.test(String(database ?? ''))) {
    throw new Error(`${B} is on database « ${database ?? '?'} », which is not a rehearsal copy. Refusing to write.`)
  }
  // Guard 3: local only, unless explicitly overridden.
  if (!FORCE && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(B)) {
    throw new Error(`${B} is not local. Pass --i-know if that is really intended.`)
  }
  const login = await POST('/api/auth/login', { IDutilisateur: Number(USER) })
  okStatus(login, 'login')
  cookie = ((login as any).raw?.getSetCookie?.() ?? []).join('; ')
  // fetch() hides Set-Cookie behind getSetCookie on the Response; redo it plainly.
  if (!cookie) {
    const r = await fetch(`${B}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ IDutilisateur: Number(USER) }),
    })
    cookie = (r.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
  }

  console.log(`B ${B}  (backend ${backend}, database ${database})`)
  console.log(`tag ${TAG}, user ${USER}\n`)

  const chosen = ONLY.length ? SCENARIOS.filter(s => ONLY.includes(s.name)) : SCENARIOS
  for (const n of ONLY) {
    if (!SCENARIOS.some(s => s.name === n)) throw new Error(`unknown scenario ${n}. Known: ${SCENARIOS.map(s => s.name).join(', ')}`)
  }

  let passed = 0
  const failures: { name: string; err: unknown }[] = []
  for (const s of chosen) {
    process.stdout.write(`  ${s.name.padEnd(24)} ${s.what}\n`)
    try {
      await s.run()
      passed++
      console.log(`  ${''.padEnd(24)} ✓ ok\n`)
    } catch (err) {
      failures.push({ name: s.name, err })
      const msg = err instanceof Failed ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      console.log(`  ${''.padEnd(24)} ✗ ${msg}\n`)
    }
  }

  console.log(`${chosen.length} scenario(s): ${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log('\nFailed:')
    for (const f of failures) console.log(`  ${f.name}`)
  }
  console.log(`\nAnything left behind is named ${TAG} — nothing should be, and mps_rehearsal is rebuilt at 02:00 anyway.`)
  process.exitCode = failures.length ? 1 : 0
}

main().catch(e => { console.error(String(e?.message ?? e)); process.exitCode = 2 })
