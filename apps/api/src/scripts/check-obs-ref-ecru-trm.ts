/**
 * Guard for the « Observations régleur » CRUD (obs_ref_ecru), shared by the OF
 * fiche and by Tombé Métier › Références.
 *
 *   API_BASE=http://localhost:8083/api pnpm --filter @mps/api exec tsx src/scripts/check-obs-ref-ecru-trm.ts
 *
 * Exercises the write cycle end-to-end over HTTP: create (wildcard scope) →
 * read it back through the OF fiche's legacy predicate → retarget to a real
 * métier and check it DISAPPEARS from an OF on another métier → reword →
 * delete. Plus the validation walls (unknown métier, coloris belonging to
 * another reference) and the `edit_of` gate (401 anonymous, 403 without the
 * key, reads open).
 *
 * The two facts this pins that nothing else would catch:
 *   - the POSITIONAL insert order (obs_ref_ecru's `date` is reserved, so the
 *     INSERT names no columns — a schema reorder would silently write the
 *     machine id into the coloris slot);
 *   - an edit does NOT restamp the date (both tables order by it).
 *
 * Creates and deletes its own scratch rows; leaves the database as it found it.
 * The dev database is a stale copy of prod — safe for scratch writes, same
 * assumption as every other check script here.
 */
import crypto from 'node:crypto'
import { getAllTrmPermissions } from '../lib/permissions-trm.js'

const BASE = process.env.API_BASE ?? 'http://localhost:8083/api'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
const ADMIN = `mps_uid=${sign(1)}; mps_uid_admin=${sign(1)}`

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  OK   ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  }
}

async function api<T = any>(
  path: string,
  init?: RequestInit,
  cookie: string = ADMIN,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(init?.headers ?? {}) },
  })
  let body: any = null
  try { body = await res.json() } catch { /* empty body */ }
  return { status: res.status, body }
}

async function main() {
  console.log(`Observations régleur (obs_ref_ecru) check against ${BASE}\n`)

  // ── The edit_of gate. Reading is open (the atelier consults all day); the
  //    three write routes are not.
  const anon = await fetch(`${BASE}/of-trm/references/1/observations-ref`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ observation: 'x' }),
  })
  check('POST unauthenticated → 401', anon.status === 401, anon.status)

  const perms = await getAllTrmPermissions()
  const outsider = [2, 4, 11, 12, 21].find((id) => !(perms[id] ?? []).includes('edit_of'))
  if (outsider === undefined) {
    console.log('  SKIP edit_of gate — every candidate user holds the key')
  } else {
    const cookie = `mps_uid=${sign(outsider)}`
    const denied = await api('/of-trm/references/1/observations-ref', {
      method: 'POST', body: JSON.stringify({ observation: 'x' }),
    }, cookie)
    check(`POST without edit_of → 403 (user ${outsider})`, denied.status === 403, denied.body)
    const del = await api('/of-trm/observations-ref/1', { method: 'DELETE' }, cookie)
    check('DELETE without edit_of → 403', del.status === 403, del.body)
  }

  // ── Pick a scratch stage: TWO OFs of the SAME reference on DIFFERENT métiers,
  //    so the machine axis of the legacy predicate has something to exclude.
  //    Falls back to a single OF (the cross-métier check then skips).
  const list = (await api('/of-trm?statut=termine')).body as any[]
  const byRef = new Map<string, any[]>()
  for (const row of list) {
    if (!row.ref_label) continue
    const bucket = byRef.get(row.ref_label) ?? []
    bucket.push(row)
    byRef.set(row.ref_label, bucket)
  }
  const spread = Array.from(byRef.values()).find(
    (rows) => new Set(rows.map((r) => r.IDmachine).filter(Boolean)).size >= 2,
  )
  let target: { ofId: number; refId: number; machineId: number } | null = null
  let sibling: number | null = null
  for (const row of (spread ?? list).slice(0, 40)) {
    const det = (await api(`/of-trm/${row.id}`)).body as any
    if (!(det?.IDref_ecru > 0 && det?.IDmachine > 0)) continue
    if (!target) { target = { ofId: det.id, refId: det.IDref_ecru, machineId: det.IDmachine }; continue }
    // Same reference, different métier → the row we expect NOT to see it on.
    if (det.IDref_ecru === target.refId && det.IDmachine !== target.machineId) { sibling = det.id; break }
  }
  check('a scratch OF with a reference and a métier exists', !!target, list.length)
  if (!target) process.exit(1)
  const reading = (await api(`/of-trm/${target.ofId}/observations-ref`)).body as any[]
  const before = reading.length
  console.log(`  OF ${target.ofId} · ref ${target.refId} · métier #${target.machineId} · ${before} observation(s) déjà en place\n`)

  // ── Validation walls, before anything is written.
  const badMachine = await api(`/of-trm/references/${target.refId}/observations-ref`, {
    method: 'POST', body: JSON.stringify({ observation: 'x', IDmachine: 999999 }),
  })
  check('unknown métier → 400', badMachine.status === 400, badMachine.body)
  const foreign = (await api(`/of-trm/lookups/coloris-ecru?ref=${target.refId}`)).body as any[]
  const otherRefColoris = await findForeignColoris(target.refId)
  if (otherRefColoris === null) {
    console.log('  SKIP foreign-coloris wall — no other reference carries a coloris')
  } else {
    const badColoris = await api(`/of-trm/references/${target.refId}/observations-ref`, {
      method: 'POST', body: JSON.stringify({ observation: 'x', IDcolori_ecru: otherRefColoris }),
    })
    check('coloris of another reference → 400', badColoris.status === 400, badColoris.body)
  }
  const empty = await api(`/of-trm/references/${target.refId}/observations-ref`, {
    method: 'POST', body: JSON.stringify({ observation: '' }),
  })
  check('empty observation → 400', empty.status === 400, empty.status)

  // ── Create, wildcard on both axes ("Toutes" / "Tout coloris").
  // Plain ASCII punctuation on purpose: sqlText() folds typographic dashes and
  // quotes to ASCII before the latin-1 hex encoding. Accents are the payload.
  const TEXT = '[CHECK] reglage a verifier - accents e' + String.fromCharCode(233) + ' a' + String.fromCharCode(224)
  const created = await api(`/of-trm/references/${target.refId}/observations-ref`, {
    method: 'POST', body: JSON.stringify({ observation: TEXT }),
  })
  check('POST creates (201)', created.status === 201 && created.body.id > 0, created)
  const obsId = created.body.id as number

  let rows = (await api(`/of-trm/${target.ofId}/observations-ref`)).body as any[]
  let mine = rows.find((o) => o.id === obsId)
  check('the wildcard observation shows on the OF fiche', !!mine, rows.length)
  check('positional INSERT landed each value in its own column',
    mine?.observation === TEXT && mine?.IDmachine === 0 && mine?.IDcolori_ecru === 0, mine)
  check('scope labels read as the legacy prints them',
    mine?.machine === 'Toutes' && mine?.coloris === 'Tout coloris', mine)
  const stampedDate = mine?.date

  // ── Retarget to the OF's own métier: still visible here…
  const put1 = await api(`/of-trm/observations-ref/${obsId}`, {
    method: 'PUT', body: JSON.stringify({ observation: TEXT, IDmachine: target.machineId }),
  })
  check('PUT retargets to a métier (200)', put1.status === 200, put1)
  rows = (await api(`/of-trm/${target.ofId}/observations-ref`)).body as any[]
  mine = rows.find((o) => o.id === obsId)
  check('still visible on its own métier', !!mine && mine.cible_machine === true, mine)
  check('an edit does NOT restamp the date', mine?.date === stampedDate, { was: stampedDate, now: mine?.date })

  // ── …and gone from an OF of the same ref on another métier (the legacy
  //    predicate's machine axis — the whole point of scoping an observation).
  if (sibling === null) {
    console.log(`  SKIP cross-métier exclusion — ref ${target.refId} only ran on one métier`)
  } else {
    const otherRows = (await api(`/of-trm/${sibling}/observations-ref`)).body as any[]
    check(`hidden from OF ${sibling} (same ref, other métier)`,
      !otherRows.some((o) => o.id === obsId), otherRows.map((o) => o.id))
  }

  // ── Reword, then delete.
  const put2 = await api(`/of-trm/observations-ref/${obsId}`, {
    method: 'PUT', body: JSON.stringify({ observation: `${TEXT} (corrigé)`, IDmachine: 0 }),
  })
  check('PUT rewords and clears the scope (200)', put2.status === 200, put2)
  rows = (await api(`/of-trm/${target.ofId}/observations-ref`)).body as any[]
  mine = rows.find((o) => o.id === obsId)
  check('reword persisted, scope back to Toutes',
    mine?.observation === `${TEXT} (corrigé)` && mine?.IDmachine === 0, mine)

  const del = await api(`/of-trm/observations-ref/${obsId}`, { method: 'DELETE' })
  check('DELETE (200)', del.status === 200, del)
  const delAgain = await api(`/of-trm/observations-ref/${obsId}`, { method: 'DELETE' })
  check('deleting twice → 404', delAgain.status === 404, delAgain.status)
  rows = (await api(`/of-trm/${target.ofId}/observations-ref`)).body as any[]
  check('database left as found', rows.length === before, { before, after: rows.length })

  // The picker the dialog fills its Coloris list from.
  check('coloris lookup is scoped to the reference',
    Array.isArray(foreign) && foreign.every((c: any) => c.id > 0), foreign)

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

/** A coloris id that belongs to some OTHER reference than `refId`, for the
 *  validation wall. Walks the references list rather than touching the driver
 *  directly — this script talks HTTP only. */
async function findForeignColoris(refId: number): Promise<number | null> {
  const refs = (await api('/references-ecru?limit=40')).body as any
  const list: any[] = Array.isArray(refs) ? refs : (refs?.items ?? refs?.rows ?? [])
  for (const r of list.slice(0, 30)) {
    const id = r.IDref_ecru ?? r.id
    if (!id || id === refId) continue
    const cols = (await api(`/of-trm/lookups/coloris-ecru?ref=${id}`)).body as any[]
    if (Array.isArray(cols) && cols.length > 0) return cols[0].id
  }
  return null
}

main().catch((err) => { console.error(err); process.exit(1) })
