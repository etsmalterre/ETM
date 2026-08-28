/**
 * HTTP guard for Production › Visitage (routes/visitage-trm.ts).
 *
 *   API_BASE=http://localhost:8087/api pnpm --filter @mps/api exec tsx src/scripts/check-visitage-trm.ts
 *
 * `probe-visitage-trm.ts` checks the RULES against the whole history; this one
 * checks the ROUTES, which is the other half of the risk. `/valider` is the
 * only write of the feature and it has no transaction behind it: it creates
 * stock, converts defects, traces an event AND moves the yarn ledger. So what
 * is guarded here is everything that must be refused BEFORE the first write,
 * plus the shape of the plan itself.
 *
 * ⚠️ This script never writes. Every /valider call goes through `?dry_run=1`,
 * which returns the exact plan — numbering, defect moves, yarn decrements —
 * without touching a row. That is why the endpoint has the flag; do not
 * "improve" this guard by letting it validate for real, or a check run would
 * leave phantom production rows behind (they are not deletable from the app:
 * Tombé Métier › Stock is read-only by design).
 */
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })

import crypto from 'node:crypto'
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { getAllTrmPermissions } from '../lib/permissions-trm.js'
import { round2 } from '../lib/production-trm.js'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const API = process.env.API_BASE ?? 'http://localhost:8080/api'

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
const ADMIN = `mps_uid=${sign(1)}; mps_uid_admin=${sign(1)}`

async function api(
  path: string,
  init: RequestInit = {},
  cookie: string = ADMIN,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(init.headers ?? {}) },
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

let failures = 0
let skipped = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  OK   ${label}`)
  else { failures++; console.error(`  FAIL ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`) }
}
function skip(label: string, why: string) {
  skipped++
  console.log(`  SKIP ${label} — ${why}`)
}

const n = (v: unknown) => (v == null ? 0 : Number(v) || 0)

/** A visiteur the API will accept as the signer. */
async function anyBonnetier(): Promise<number> {
  const rows = await query<any>('SELECT IDbonnetier FROM bonnetier ORDER BY IDbonnetier ASC LIMIT 1')
  return n(rows[0]?.IDbonnetier)
}

/** Étiquettes (Dymo) — read-only, so this runs before the worklist gate and
 *  is safe against any environment, prod included (which is the one place the
 *  real printer lives). */
async function checkEtiquettes(): Promise<void> {
  const raw = async (path: string, cookie?: string) => {
    const res = await fetch(`${API}${path}`, cookie === undefined ? {} : { headers: { Cookie: cookie } })
    const buf = Buffer.from(await res.arrayBuffer())
    return { status: res.status, type: res.headers.get('content-type') ?? '', buf }
  }
  /** Pages in a react-pdf document: object dictionaries stay uncompressed, so
   *  `/Type /Page` (never `/Type /Pages`) counts them. Returns -1 if the
   *  shape ever changes, which the caller treats as "cannot tell". */
  const pageCount = (buf: Buffer) => {
    const m = buf.toString('latin1').match(/\/Type\s*\/Page(?![s])/g)
    return m === null ? -1 : m.length
  }

  const demo = await raw('/visitage-trm/etiquettes?demo=3')
  check('etiquettes?demo=3 → 200 application/pdf',
    demo.status === 200 && demo.type.includes('application/pdf') && demo.buf.subarray(0, 4).toString() === '%PDF',
    { status: demo.status, type: demo.type })
  const n3 = pageCount(demo.buf)
  if (n3 < 0) skip('etiquettes?demo=3 → 3 pages', 'page dictionaries not readable in this PDF')
  else check('etiquettes?demo=3 → 3 pages (one label per roll)', n3 === 3, n3)

  check('etiquettes without ids → 400', (await raw('/visitage-trm/etiquettes')).status === 400)
  check('etiquettes with unknown ids → 404', (await raw('/visitage-trm/etiquettes?ids=999999999')).status === 404)

  // Real TRM rolls. No IDsociete filter on purpose (a delivered roll is
  // société 1 and must stay reprintable) — the partition guard is the OF.
  const trmRolls = await query<any>(
    'SELECT IDstock_ecru FROM stock_ecru WHERE IDordre_fabrication > 0 ORDER BY IDstock_ecru DESC LIMIT 2',
  )
  const ids = trmRolls.map((r: any) => n(r.IDstock_ecru)).filter((x: number) => x > 0)
  if (ids.length < 2) skip('etiquettes for real rolls', 'fewer than two knitted rolls in this base')
  else {
    const real = await raw(`/visitage-trm/etiquettes?ids=${ids.join(',')}`)
    check('etiquettes for two real rolls → 200 PDF',
      real.status === 200 && real.buf.subarray(0, 4).toString() === '%PDF', real.status)
    const n2 = pageCount(real.buf)
    if (n2 >= 0) check('…and exactly two pages', n2 === 2, n2)
    // Reading a tag is as open as consulting the poste.
    check('etiquettes without a cookie → 200', (await raw(`/visitage-trm/etiquettes?ids=${ids[0]}`, undefined)).status === 200)
  }

  // An ETM roll has no OF — it was bought, not knitted — so it is out of this
  // router's perimeter and must 404 rather than print a TRM tag.
  const etmRolls = await query<any>(
    'SELECT IDstock_ecru FROM stock_ecru WHERE IDordre_fabrication = 0 ORDER BY IDstock_ecru DESC LIMIT 1',
  )
  const etmId = n(etmRolls[0]?.IDstock_ecru)
  if (etmId <= 0) skip('etiquettes on an ETM roll → 404', 'no roll without an OF in this base')
  else check('etiquettes on an ETM roll (no OF) → 404',
    (await raw(`/visitage-trm/etiquettes?ids=${etmId}`)).status === 404)
}

async function main(): Promise<void> {
  console.log(`TRM visitage routes against ${API}\n`)

  await checkEtiquettes()

  // ── The worklist ────────────────────────────────────
  const metiers = await api('/visitage-trm/lookups/metiers')
  check('GET /lookups/metiers → 200', metiers.status === 200, metiers.status)
  if (metiers.status !== 200 || !Array.isArray(metiers.json) || metiers.json.length === 0) {
    console.error('\nNo métier is offering a piece — the write path cannot be exercised.')
    console.error('On a stale dev copy, widen VISITAGE_PIECE_MAX_AGE_DAYS in .env.development.')
    process.exitCode = 1
    return
  }

  // ── The 7-day rule on stranded pieces (ORPHAN_MAX_AGE_DAYS) ──
  // The queue-head OF's pieces may be widened in dev; a stray never is. This is
  // the guard for that asymmetry — it is invisible in the payload otherwise.
  let orphansChecked = 0
  let orphansTooOld = 0
  for (const m of metiers.json) {
    const poste = await api(`/visitage-trm/poste?metier=${m.id}`)
    if (poste.status !== 200) { check(`GET /poste?metier=${m.id} → 200`, false, poste.status); continue }
    const offered = [
      ...(poste.json.piece ? [{ id: poste.json.piece.id, orpheline: poste.json.piece.orpheline }] : []),
      ...(poste.json.autres_pieces ?? []).map((p: any) => ({ id: p.id, orpheline: p.orpheline })),
    ]
    for (const p of offered.filter((x) => x.orpheline)) {
      orphansChecked++
      const rows = await query<any>(
        `SELECT date_fin FROM piece_production WHERE IDpiece_production = ${p.id}`,
      )
      const ms = Date.parse(String(rows[0]?.date_fin ?? '').replace(/^(\d{4})(\d{2})(\d{2})/, '$1-$2-$3T').slice(0, 19))
      const age = Number.isFinite(ms) ? Math.floor((Date.now() - ms) / 86_400_000) : 0
      if (age > 7) orphansTooOld++
    }
  }
  check(
    `no stranded pièce older than 7 days is offered (${orphansChecked} checked)`,
    orphansTooOld === 0,
    { orphansTooOld },
  )

  // ── Pick a real piece to plan against ───────────────
  const metier = metiers.json.find((m: any) => n(m.pieces_en_attente) > 0) ?? metiers.json[0]
  const poste = await api(`/visitage-trm/poste?metier=${metier.id}`)
  check('GET /poste → 200', poste.status === 200, poste.status)
  const piece = poste.json?.piece
  const of = poste.json?.of
  if (!piece || !of) {
    console.error('\nNo piece on the first métier — cannot exercise /valider.')
    process.exitCode = 1
    return
  }
  const visiteur = await anyBonnetier()
  console.log(`  ..   planning against pièce ${piece.id} (${piece.label}), OF ${of.id}\n`)

  const rouleau = (poids: number, second: 0 | 1, defauts: any[] = []) =>
    ({ poids, second_choix: second, observations: '', defauts })
  const carried = (piece.defauts ?? []).map((d: any) => ({
    id: d.id, type_defaut: d.type_defaut, taille_cm: d.taille_cm, nombre: d.nombre, recupere: 0,
  }))
  const body = (over: Record<string, unknown> = {}) => JSON.stringify({
    IDpiece_production: piece.id,
    IDbonnetier: visiteur,
    visitage_complet: true,
    rouleaux: [rouleau(12.5, 0, carried), rouleau(7.25, 1)],
    ...over,
  })
  const plan = (over?: Record<string, unknown>) =>
    api('/visitage-trm/valider?dry_run=1', { method: 'POST', body: body(over) })

  // ── The plan itself ─────────────────────────────────
  const dry = await plan()
  check('POST /valider?dry_run=1 → 200', dry.status === 200, dry.json ?? dry.status)

  // ── The lock ────────────────────────────────────────
  // /valider is serialised process-wide (validerLock) since the 2026-08-28
  // double POST. What can go wrong with a mutex is that it never releases —
  // and then every poste de visitage hangs on its next validation. Three
  // concurrent plans must all come back, and agree (nothing was written
  // between them, so they see the same numbering).
  const burst = await Promise.all([plan(), plan(), plan()])
  check('3 concurrent /valider?dry_run=1 all answer 200 (lock releases)',
    burst.every((r) => r.status === 200), burst.map((r) => r.status))
  check('…and agree on the numbering',
    new Set(burst.map((r) => JSON.stringify((r.json?.rouleaux ?? []).map((x: any) => x.numero)))).size === 1,
    burst.map((r) => r.json?.rouleaux?.map((x: any) => x.numero)))
  if (dry.status === 200) {
    const p = dry.json
    check('dry run writes nothing (dry_run echoed)', p.dry_run === true)
    check('two rolls planned', (p.rouleaux ?? []).length === 2, p.rouleaux)

    // Numbering: the 1er choix roll takes the < 1000 sequence, the déclassé the
    // 1000+ one. Both are recomputed at validation time, never sent by the web.
    const first = p.rouleaux?.find((r: any) => r.second_choix === 0)
    const second = p.rouleaux?.find((r: any) => r.second_choix === 1)
    const seq = await query<any>(
      `SELECT num_piece_OF FROM stock_ecru WHERE IDordre_fabrication = ${of.id}`,
    )
    let maxFirst = 0
    // The déclassé sequence opens at 1001, not 1000: 438 live OFs start there
    // against 167 at 1000 (probe-visitage-trm.ts). Mirror the route exactly.
    let maxSecond = 1000
    for (const r of seq) {
      const v = n(r.num_piece_OF)
      if (v >= 1000 && v < 2000) maxSecond = Math.max(maxSecond, v)
      else if (v > 0 && v < 1000) maxFirst = Math.max(maxFirst, v)
    }
    check('1er choix takes MAX(<1000)+1', n(first?.num_piece_OF) === maxFirst + 1,
      { got: first?.num_piece_OF, expected: maxFirst + 1 })
    check('déclassé takes the 1000+ sequence', n(second?.num_piece_OF) === maxSecond + 1,
      { got: second?.num_piece_OF, expected: maxSecond + 1 })
    check('numéro is OF/num', first?.numero === `${of.id}/${first?.num_piece_OF}`, first?.numero)

    // Yarn: every roll consumes, déclassés included, weighted by pourcentage.
    // This is the riskiest write of the feature — a wrong basis drifts the
    // ledger silently, and nothing downstream would ever flag it.
    const total = round2(12.5 + 7.25)
    const fil = p.fil ?? []
    if (fil.length === 0) skip('yarn decrement', 'this OF has no asso_fil_of lot')
    for (const f of fil) {
      check(`fil lot ${f.lot} — delta = total × ${f.pourcentage}%`,
        f.delta === round2(total * (f.pourcentage / 100)), f)
      check(`fil lot ${f.lot} — après = avant − delta`,
        f.apres === round2(f.avant - f.delta), f)
    }

    check('event is the visitage one when visitage_complet',
      p.evenement === 'Visitage tombé métier', p.evenement)
    check('carried defects are all reported',
      (first?.defauts_reportes ?? []).length === carried.length,
      { got: first?.defauts_reportes, expected: carried.map((d: any) => d.id) })
    check('nothing is planned for deletion when every defect is carried',
      (p.defauts_supprimes ?? []).length === 0, p.defauts_supprimes)
  }

  // Pesée simple writes the other event — the two are how the history tells a
  // full visitage from a weighing years later.
  const pesee = await plan({ visitage_complet: false })
  check('event is the pesage one when not visitage_complet',
    pesee.json?.evenement === 'Pesage tombé métier', pesee.json?.evenement)

  // ── Everything that must be refused before a write ──
  const zero = await plan({ rouleaux: [rouleau(0, 0)] })
  check('poids 0 → 400', zero.status === 400, zero.status)

  const noVisiteur = await plan({ IDbonnetier: 999999 })
  check('unknown visiteur → 400 visiteur_inconnu',
    noVisiteur.status === 400 && noVisiteur.json?.error === 'visiteur_inconnu', noVisiteur.json)

  const ghost = await api('/visitage-trm/valider?dry_run=1', {
    method: 'POST',
    body: JSON.stringify({
      IDpiece_production: 99999999, IDbonnetier: visiteur, visitage_complet: true,
      rouleaux: [rouleau(10, 0)],
    }),
  })
  check('unknown pièce → 404 piece_introuvable',
    ghost.status === 404 && ghost.json?.error === 'piece_introuvable', ghost.json)

  // A defect belonging to ANOTHER piece must not be re-parentable onto this
  // roll — the only thing standing between a crafted payload and a stolen
  // defect row.
  const foreign = await query<any>(
    `SELECT IDdefaut_qualite FROM defaut_qualite
     WHERE Type_Reference = 1 AND reference <> '${piece.id}' ORDER BY IDdefaut_qualite DESC LIMIT 1`,
  )
  const foreignId = n(foreign[0]?.IDdefaut_qualite)
  if (foreignId === 0) skip('foreign defect refused', 'no other piece defect in base')
  else {
    const stolen = await plan({
      rouleaux: [rouleau(10, 0, [{ id: foreignId, type_defaut: 'Trou', taille_cm: 0, nombre: 1, recupere: 0 }])],
    })
    check("a defect from another pièce → 409 defaut_hors_piece",
      stolen.status === 409 && stolen.json?.error === 'defaut_hors_piece', stolen.json)
  }

  // An already-weighed piece: the race between two postes, and the only guard
  // against it (stock_ecru has no unique key to lean on).
  const done = await query<any>(
    `SELECT IDpiece_production FROM stock_ecru
     WHERE IDpiece_production > 0 ORDER BY IDstock_ecru DESC LIMIT 1`,
  )
  const doneId = n(done[0]?.IDpiece_production)
  if (doneId === 0) skip('already-weighed pièce refused', 'no weighed piece in base')
  else {
    const twice = await api('/visitage-trm/valider?dry_run=1', {
      method: 'POST',
      body: JSON.stringify({
        IDpiece_production: doneId, IDbonnetier: visiteur, visitage_complet: true,
        rouleaux: [rouleau(10, 0)],
      }),
    })
    check('already-weighed pièce → 409 piece_deja_visitee',
      twice.status === 409 && twice.json?.error === 'piece_deja_visitee', twice.json)
  }

  // ── The permission gate ─────────────────────────────
  // Reading the poste is open; creating stock is not. Admins bypass, so the
  // test needs a real non-admin who has not been granted the key.
  const perms = await getAllTrmPermissions()
  const users = await query<any>('SELECT IDutilisateur FROM utilisateur ORDER BY IDutilisateur ASC')
  const outsider = users
    .map((u: any) => n(u.IDutilisateur))
    .find((id: number) => id > 1 && !(perms[id] ?? []).includes('saisie_visitage'))
  if (!outsider) skip('saisie_visitage gate', 'every user holds the key')
  else {
    const cookie = `mps_uid=${sign(outsider)}`
    const denied = await api('/visitage-trm/valider?dry_run=1', { method: 'POST', body: body() }, cookie)
    check(`/valider without saisie_visitage → 403 (user ${outsider})`, denied.status === 403, denied.json)
    const open = await api(`/visitage-trm/poste?metier=${metier.id}`, {}, cookie)
    check('reading the poste stays open without the key', open.status === 200, open.status)
  }

  const anon = await fetch(`${API}/visitage-trm/valider?dry_run=1`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(),
  })
  check('/valider unauthenticated → 401', anon.status === 401, anon.status)

  console.log(
    `\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`}` +
    `${skipped > 0 ? ` (${skipped} skipped)` : ''}.`,
  )
  if (failures > 0) process.exitCode = 1
}

await main()
await closeConnection()
