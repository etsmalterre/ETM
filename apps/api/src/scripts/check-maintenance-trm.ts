/**
 * HTTP guard for Atelier > Maintenance (/api/maintenance-trm).
 *
 *   API_BASE=http://localhost:8084/api pnpm --filter @mps/api exec tsx src/scripts/check-maintenance-trm.ts
 *
 * Exercises the whole surface against the dev API and puts everything back:
 *   - GET /metiers            list shape, archived rows excluded, urgency order
 *   - GET /metiers/:id/production   the OFs behind the rouloir counter, and that
 *                             their sum IS the counter (the auditable claim)
 *   - PUT /metiers/:id        round-trip with an ACCENTED comment (the hex
 *                             Latin-1 literal path) + a date, then restore
 *   - PUT on an archived métier            → 409 machine_archivee
 *   - PUT / reset without edit_maintenance → 403
 *   - POST /operations/:id/reset           stamps today, then restores
 *
 * The dev database is a stale copy of prod — safe for scratch writes, same
 * assumption as every other check script here.
 */
import crypto from 'node:crypto'
import { query, queryB64Text, fixEncoding, closeConnection } from '../lib/hfsql-auto.js'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const API = process.env.API_BASE ?? 'http://localhost:8084/api'
const IS_WINDOWS = process.platform === 'win32'

/** A user id that is NOT the admin and holds no TRM permission — used to prove
 *  the write routes are actually gated. 999 999 does not exist in `utilisateur`,
 *  which is exactly right: the gate must refuse before it looks anything up. */
const NOBODY_ID = 999_999

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
const ADMIN_COOKIE = `mps_uid=${sign(1)}; mps_uid_admin=${sign(1)}`
const NOBODY_COOKIE = `mps_uid=${sign(NOBODY_ID)}`

async function api(
  path: string,
  init: RequestInit = {},
  cookie: string = ADMIN_COOKIE,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(init.headers ?? {}) },
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  OK   ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ''}`)
  }
}

/** Read a métier's maintenance columns straight from HFSQL, so the restore at
 *  the end is verified against the base and not against the API's own echo. */
async function readRaw(id: number): Promise<Record<string, unknown>> {
  const sql = 'SELECT * FROM machine'
  const rows = IS_WINDOWS
    ? await fixEncoding(await query<Record<string, unknown>>(sql), 'machine', 'IDmachine', [
        'commentaire',
        'observation_maintenace',
      ])
    : await queryB64Text<Record<string, unknown>>(sql)
  const row = rows.find((r) => Number(r.IDmachine) === id)
  if (!row) throw new Error(`machine ${id} introuvable`)
  return row
}

async function main() {
  console.log(`Atelier > Maintenance check against ${API}\n`)

  // ── GET /metiers ─────────────────────────────────────
  const list = await api('/maintenance-trm/metiers')
  check('GET /metiers 200', list.status === 200, list.status)
  const metiers: any[] = list.json?.metiers ?? []
  check('seuil is 15 000 Kg', list.json?.seuilRouloirKg === 15000, list.json?.seuilRouloirKg)
  check('métiers returned', metiers.length > 0, metiers.length)
  check('no archived métier in the list', metiers.every((m) => m.archive === false))
  check(
    'sorted by kg remaining, ascending',
    metiers.every((m, i) => i === 0 || metiers[i - 1].rouloir.restantKg <= m.rouloir.restantKg),
  )
  const shapeOk = metiers.every(
    (m) =>
      typeof m.emplacement === 'string' &&
      m.rouloir &&
      ['due', 'proche', 'ok'].includes(m.rouloir.etat) &&
      m.garniture?.nettPlatines !== undefined &&
      m.garniture?.pulsonique !== undefined &&
      m.caracteristiques?.jauge !== undefined,
  )
  check('payload shape (rouloir + 6 garniture slots + caractéristiques)', shapeOk)

  // The counter must never go negative, and `due` must mean "seuil reached".
  check(
    'restantKg is clamped at 0 and etat=due iff ratio >= 1',
    metiers.every(
      (m) =>
        m.rouloir.restantKg >= 0 &&
        (m.rouloir.derniereVisite === null || (m.rouloir.ratio >= 1) === (m.rouloir.etat === 'due')),
    ),
  )

  // ── GET /metiers/:id/production ──────────────────────
  // Pick a métier that has actually produced since its visit, so the sum is
  // non-trivial.
  const withProd = metiers.find((m) => m.rouloir.produitKg > 0 && m.rouloir.derniereVisite)
  check('a métier with production since its visit exists', !!withProd)
  if (withProd) {
    const prod = await api(`/maintenance-trm/metiers/${withProd.id}/production`)
    check('GET /metiers/:id/production 200', prod.status === 200, prod.status)
    check('OFs returned', (prod.json?.ofs ?? []).length > 0, prod.json?.ofs?.length)
    // THE auditable claim: the drawer's rows add up to the list's counter.
    const delta = Math.abs((prod.json?.totalKg ?? 0) - withProd.rouloir.produitKg)
    check(
      `production total matches the rouloir counter (${withProd.emplacement})`,
      delta < 0.02,
      { drawer: prod.json?.totalKg, list: withProd.rouloir.produitKg },
    )
    check(
      'every OF is dated after the last visit',
      (prod.json?.ofs ?? []).every((o: any) => !o.dateCreation || o.dateCreation > withProd.rouloir.derniereVisite),
    )
  }

  // ── Permission gate ──────────────────────────────────
  const target = metiers[0]
  const denied = await api(
    `/maintenance-trm/metiers/${target.id}`,
    { method: 'PUT', body: JSON.stringify({ doubleFonture: true, rouloir: {}, garniture: {} }) },
    NOBODY_COOKIE,
  )
  check('PUT /metiers/:id without edit_maintenance → 403', denied.status === 403, denied.status)
  const deniedReset = await api(
    '/maintenance-trm/operations/1/reset',
    { method: 'POST' },
    NOBODY_COOKIE,
  )
  check('POST /operations/:id/reset without edit_maintenance → 403', deniedReset.status === 403, deniedReset.status)

  // ── PUT round-trip on a real métier ──────────────────
  const before = await readRaw(target.id)
  const restore = {
    description: target.description,
    doubleFonture: target.doubleFonture,
    rouloir: { ...target.rouloir },
    garniture: JSON.parse(JSON.stringify(target.garniture)),
  }
  console.log(`\n  scratch métier: ${target.emplacement} (#${target.id})`)

  // Accented text on purpose — this is the hex Latin-1 literal path, the one
  // that breaks on the Linux bridge when it is not taken. Everything here is
  // representable in Latin-1, so it must survive byte-for-byte.
  const ACCENTED = 'Contrôle graissage, poignée révisée côté opérateur'
  // The shared sqlText() helper deliberately folds typographic punctuation to
  // ASCII first (an em dash is U+2014, outside Latin-1). Asserted rather than
  // avoided, so the day someone "fixes" the folding this test says so.
  const FOLDED_IN = 'Jeu d’aiguilles — révisé'
  const FOLDED_OUT = "Jeu d'aiguilles - révisé"
  const put = await api(`/maintenance-trm/metiers/${target.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      description: target.description,
      doubleFonture: target.doubleFonture,
      rouloir: { derniereVisite: target.rouloir.derniereVisite, commentaire: ACCENTED },
      garniture: {
        ...target.garniture,
        nettPlatines: { date: '20260101', commentaire: 'Vérifié' },
        chgAiguilles: { date: target.garniture.chgAiguilles.date, commentaire: FOLDED_IN },
      },
    }),
  })
  check('PUT /metiers/:id 200', put.status === 200, put.status)
  check('accented rouloir comment round-trips', put.json?.metier?.rouloir?.commentaire === ACCENTED, put.json?.metier?.rouloir?.commentaire)
  check(
    'typographic punctuation folds to ASCII, accents survive',
    put.json?.metier?.garniture?.chgAiguilles?.commentaire === FOLDED_OUT,
    put.json?.metier?.garniture?.chgAiguilles?.commentaire,
  )
  check('garniture date written', put.json?.metier?.garniture?.nettPlatines?.date === '20260101', put.json?.metier?.garniture?.nettPlatines)
  check('garniture comment written', put.json?.metier?.garniture?.nettPlatines?.commentaire === 'Vérifié')
  // The columns this route must NEVER name keep their stored values.
  const after = await readRaw(target.id)
  const untouched = ['nom', 'Jauge', 'nb_chutes', 'nb_chutes_max', 'elasthanne', 'vitesse', 'adresse_automate']
  check(
    'FEN_Gestion_des_machines columns untouched',
    untouched.every((c) => String(before[c] ?? '') === String(after[c] ?? '')),
    untouched.filter((c) => String(before[c] ?? '') !== String(after[c] ?? '')),
  )
  const accentedKeys = Object.keys(after).filter((k) => /^(archiv|connect|diam)/i.test(k))
  check(
    'accented columns (archivé / connecté / diamètre) untouched',
    accentedKeys.every((k) => String(before[k] ?? '') === String(after[k] ?? '')),
    accentedKeys,
  )

  // Restore.
  const back = await api(`/maintenance-trm/metiers/${target.id}`, { method: 'PUT', body: JSON.stringify(restore) })
  check('restore PUT 200', back.status === 200, back.status)
  const restored = await readRaw(target.id)
  check(
    'métier restored to its original state',
    String(restored.observation_maintenace ?? '') === String(before.observation_maintenace ?? '') &&
      String(restored.nett_platines ?? '') === String(before.nett_platines ?? '') &&
      String(restored.comm_nett_platines ?? '') === String(before.comm_nett_platines ?? '') &&
      String(restored.comm_chg_aiguilles ?? '') === String(before.comm_chg_aiguilles ?? ''),
    {
      obs: [before.observation_maintenace, restored.observation_maintenace],
      nett: [before.nett_platines, restored.nett_platines],
      aig: [before.comm_chg_aiguilles, restored.comm_chg_aiguilles],
    },
  )

  // ── 409 on an archived métier ────────────────────────
  const sql = 'SELECT * FROM machine'
  const allRows = IS_WINDOWS
    ? await query<Record<string, unknown>>(sql)
    : await queryB64Text<Record<string, unknown>>(sql)
  const archivedKey = Object.keys(allRows[0] ?? {}).find((k) => /^archiv/i.test(k))
  const archived = allRows.find((r) => Number(r[archivedKey as string]) === 1)
  check('an archived métier exists to test the 409', !!archived)
  if (archived) {
    const arch = await api(`/maintenance-trm/metiers/${Number(archived.IDmachine)}`, {
      method: 'PUT',
      body: JSON.stringify(restore),
    })
    check('PUT on an archived métier → 409', arch.status === 409, arch.status)
    check('409 body names the reason', arch.json?.error === 'machine_archivee', arch.json)
  }

  // ── Operations ───────────────────────────────────────
  const ops = await api('/maintenance-trm/operations')
  check('GET /operations 200', ops.status === 200, ops.status)
  const operations: any[] = ops.json?.operations ?? []
  check('the three atelier operations are returned', operations.length >= 3, operations.length)
  check(
    'operations carry frequenceMois + moisEcoules + ratio',
    operations.every((o) => o.frequenceMois > 0 && o.moisEcoules !== undefined && 'ratio' in o),
  )

  const op = operations[0]
  const opBefore = op.derniereMaintenance
  const reset = await api(`/maintenance-trm/operations/${op.id}/reset`, { method: 'POST' })
  check('POST /operations/:id/reset 200', reset.status === 200, reset.status)
  const d = new Date()
  const today = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const resetOp = (reset.json?.operations ?? []).find((o: any) => o.id === op.id)
  check('reset stamps today', resetOp?.derniereMaintenance === today, resetOp?.derniereMaintenance)
  check('reset zeroes moisEcoules', resetOp?.moisEcoules === 0, resetOp?.moisEcoules)

  // Restore the operation's original date directly (there is no API for an
  // arbitrary date — the only write is "done today", by design).
  await query(
    `UPDATE operation_maintenance SET date_derniere = '${opBefore ?? ''}' WHERE IDoperation_maintenance = ${op.id}`,
  )
  const opsAfter = await api('/maintenance-trm/operations')
  check(
    'operation restored',
    (opsAfter.json?.operations ?? []).find((o: any) => o.id === op.id)?.derniereMaintenance === opBefore,
  )

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  await closeConnection()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
