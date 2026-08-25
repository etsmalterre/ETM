/**
 * HTTP guard for the two compte routes that TRM's Rapports > Finance screen
 * turned on (`FINANCE_SCOPE_TRM.editComptesKey`).
 *
 *   API_BASE=http://localhost:8081/api pnpm --filter @mps/api exec tsx src/scripts/check-finance-comptes-trm.ts
 *
 * `probe-finance-trm.ts` checks the FIGURES against the database; this one
 * checks the ROUTES, which is a different risk: `releve_compta` and
 * `compte_compta` are reached by an id supplied in the URL, and `releve_compta`
 * carries no `id_societe` of its own. The partition therefore lives entirely in
 * the ownership check both handlers make - so the thing worth guarding is that
 * an id from the OTHER societe is refused, on read as well as on write.
 *
 * Also exercises the PATCH round-trip (description + fixe/variable) and puts
 * the compte back as it found it. The dev database is a stale copy of prod -
 * same scratch-write assumption as every other check script here.
 */
import crypto from 'node:crypto'
import { query, closeConnection } from '../lib/hfsql-auto.js'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const API = process.env.API_BASE ?? 'http://localhost:8080/api'

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
const COOKIE = `mps_uid=${sign(1)}; mps_uid_admin=${sign(1)}`

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: COOKIE, ...(init.headers ?? {}) },
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  OK   ${label}`)
  else { failures++; console.error(`  FAIL ${label}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ''}`) }
}

const n = (v: unknown) => (v == null ? 0 : Number(v) || 0)

async function firstCompteOf(societe: number): Promise<number> {
  const rows = await query<{ IDcompte_compta: number }>(
    `SELECT IDcompte_compta FROM compte_compta WHERE id_societe = ${societe}`,
  )
  return n(rows[0]?.IDcompte_compta)
}

async function main() {
  console.log(`TRM finance compte routes against ${API}\n`)

  const mine = await firstCompteOf(2)
  const theirs = await firstCompteOf(1)
  if (!mine || !theirs) {
    console.error('  FAIL no compte_compta rows to test with')
    process.exitCode = 1
    return
  }

  // The list the screen opens on.
  const list = await api('/rapports-trm/finance')
  check('GET /rapports-trm/finance -> 200', list.status === 200, list.status)
  const target = (list.json?.lignes ?? [])[0]
  check('the payload carries lignes', !!target, list.json?.lignes?.length)

  // Historique - mounted only because editComptesKey is set.
  console.log('\nhistorique')
  const own = await api(`/rapports-trm/finance/comptes/${mine}/historique`)
  check('own compte -> 200', own.status === 200, own.status)
  check('one point per year with an upload', Array.isArray(own.json) && own.json.length > 0, own.json?.length)
  const foreign = await api(`/rapports-trm/finance/comptes/${theirs}/historique`)
  check(`ETM compte ${theirs} -> 404 (partition guard)`, foreign.status === 404, foreign.status)

  // PATCH round-trip.
  console.log('\nPATCH round-trip')
  if (target) {
    const before = { description: String(target.description ?? ''), variable: n(target.variable) }
    const probe = `Sondage ${new Date(0).toISOString()} - check-finance-comptes-trm`
    const flipped = before.variable === 1 ? 0 : 1
    const wrote = await api(`/rapports-trm/finance/comptes/${target.IDcompte_compta}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: probe, variable: flipped }),
    })
    check('PATCH -> 200', wrote.status === 200, wrote.status)
    check('description round-trips', wrote.json?.description === probe, wrote.json?.description)
    check('variable flipped', wrote.json?.variable === flipped, wrote.json?.variable)
    const back = await api(`/rapports-trm/finance/comptes/${target.IDcompte_compta}`, {
      method: 'PATCH',
      body: JSON.stringify(before),
    })
    check(
      'restored to its stored value',
      back.status === 200 && back.json?.description === before.description && back.json?.variable === before.variable,
      back.json,
    )
  }
  const foreignWrite = await api(`/rapports-trm/finance/comptes/${theirs}`, {
    method: 'PATCH',
    body: JSON.stringify({ description: 'nope' }),
  })
  check(`PATCH on ETM compte ${theirs} -> 404 (partition guard)`, foreignWrite.status === 404, foreignWrite.status)

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().then(() => closeConnection()).catch((e) => { console.error(e); process.exitCode = 1; return closeConnection() })
