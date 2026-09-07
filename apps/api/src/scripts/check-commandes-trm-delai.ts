/**
 * HTTP guard for the TRM délai write (LIVA #1123) —
 * `PUT /commandes-trm/lignes/:id/delai`, routes/commandes-trm.ts.
 *
 *   API_BASE=http://localhost:8081/api pnpm --filter @mps/api exec tsx src/scripts/check-commandes-trm-delai.ts
 *
 * The route is the second write a mirrored commande accepts from TRM (the
 * état is the first) and the only TRM write that crosses into ETM's ledger:
 * it sets `ligne_commande_client.date_livraison` AND, through the line's
 * back-pointer, `ligne_commande_sous_traitant.date_livraison` with ETM's own
 * two rules — capture-once `date_delai`, `Attente_Delai` → `En_Cours`. What is
 * guarded here is that both ledgers move together, that the rules fire on
 * the sst side exactly as they do from ETM's screen, and that the gates
 * (permission, soldée) hold.
 *
 * ⚠️ This script WRITES — there is no dry run on this route, the write is
 * the thing under test. It therefore refuses anything but a localhost API
 * (the dev base is a snapshot), and it restores every row it touched, in a
 * `finally`, whatever happened. Never point it at prod.
 */
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })

import crypto from 'node:crypto'
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { getAllTrmPermissions } from '../lib/permissions-trm.js'
import { STATUT_ATTENTE_DELAI, STATUT_OPEN, STATUT_NON_ENVOYE } from '../lib/sst-shared.js'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const API = process.env.API_BASE ?? 'http://localhost:8080/api'
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(API)) {
  console.error(`Refusing to run against ${API}: this guard writes, localhost only.`)
  process.exit(1)
}

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
const ADMIN = `mps_uid=${sign(1)}; mps_uid_admin=${sign(1)}`

async function api(path: string, init: RequestInit = {}, cookie: string = ADMIN): Promise<{ status: number; json: any }> {
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
function skip(label: string, why: string) { skipped++; console.log(`  SKIP ${label} — ${why}`) }

const n = (v: unknown) => (v == null ? 0 : Number(v) || 0)
const s = (v: unknown) => (typeof v === 'string' ? v : '')

type Pair = {
  IDcommande_client: number
  IDligne_commande_client: number
  cc_liv: string
  sst_id: number
  sst_liv: string
  sst_delai: string
  sstatut: string
}

/** Open mirror lines with the sst line behind them, one per statut of interest. */
async function pickPairs(): Promise<Pair[]> {
  const rows = await query<any>(
    `SELECT cc.IDcommande_client, lcc.IDligne_commande_client, lcc.date_livraison AS cc_liv,
            lcs.IDligne_commande_sous_traitant AS sst_id, lcs.date_livraison AS sst_liv, lcs.date_delai AS sst_delai, lcs.sstatut
     FROM commande_client cc
     INNER JOIN ligne_commande_client lcc ON lcc.IDcommande_client = cc.IDcommande_client
     INNER JOIN ligne_commande_sous_traitant lcs ON lcs.IDligne_commande_sous_traitant = lcc.IDligne_commande_ETM
     WHERE cc.IDsociete = 2 AND cc.IDcommande_ETM > 0 AND cc.est_soldee = 0
     ORDER BY cc.IDcommande_client DESC`,
  )
  return rows.map((r: any) => ({
    IDcommande_client: n(r.IDcommande_client),
    IDligne_commande_client: n(r.IDligne_commande_client),
    cc_liv: s(r.cc_liv),
    sst_id: n(r.sst_id),
    sst_liv: s(r.sst_liv),
    sst_delai: s(r.sst_delai),
    sstatut: s(r.sstatut).trim(),
  }))
}

async function readPair(p: Pair): Promise<{ cc_liv: string; sst_liv: string; sst_delai: string; sstatut: string }> {
  const cc = await query<any>(`SELECT date_livraison FROM ligne_commande_client WHERE IDligne_commande_client = ${p.IDligne_commande_client}`)
  const sst = await query<any>(`SELECT date_livraison, date_delai, sstatut FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant = ${p.sst_id}`)
  return { cc_liv: s(cc[0]?.date_livraison), sst_liv: s(sst[0]?.date_livraison), sst_delai: s(sst[0]?.date_delai), sstatut: s(sst[0]?.sstatut).trim() }
}

const touched: Pair[] = []
async function restore() {
  for (const p of touched) {
    await query(`UPDATE ligne_commande_client SET date_livraison = '${p.cc_liv}' WHERE IDligne_commande_client = ${p.IDligne_commande_client}`)
    await query(
      `UPDATE ligne_commande_sous_traitant SET date_livraison = '${p.sst_liv}', date_delai = '${p.sst_delai}', sstatut = '${p.sstatut}'
       WHERE IDligne_commande_sous_traitant = ${p.sst_id}`,
    )
  }
  if (touched.length > 0) console.log(`\n  ..   ${touched.length} ligne(s) restaurée(s)`)
}

const setDelai = (lineId: number, date: string, cookie?: string) =>
  api(`/commandes-trm/lignes/${lineId}/delai`, { method: 'PUT', body: JSON.stringify({ date_livraison: date }) }, cookie)

async function main(): Promise<void> {
  console.log(`TRM délai route against ${API}\n`)
  const pairs = await pickPairs()
  if (pairs.length === 0) {
    console.error('No open mirrored line with a sst line behind it — nothing to exercise.')
    process.exitCode = 1
    return
  }

  // ── Attente_Delai: first date → both ledgers dated, flip to En_Cours ──
  const waiting = pairs.find((p) => p.sstatut === STATUT_ATTENTE_DELAI)
  if (!waiting) skip('Attente_Delai → En_Cours', 'no open line waiting on a délai in this base')
  else {
    touched.push(waiting)
    const before = await api(`/commandes-trm/${waiting.IDcommande_client}`)
    const lineBefore = (before.json?.lignes ?? []).find((l: any) => l.IDligne_commande_client === waiting.IDligne_commande_client)
    check('detail flags the line attente_delai before the write', lineBefore?.attente_delai === true, lineBefore)

    const r = await setDelai(waiting.IDligne_commande_client, '2026-10-15')
    check('PUT /delai on a mirrored Attente_Delai line → 200', r.status === 200, r.json ?? r.status)
    check('…sst_status updated', r.json?.sst_status === 'updated', r.json)
    const after = await readPair(waiting)
    check('TRM line carries the date', after.cc_liv === '20261015', after)
    check('sst line carries the same date', after.sst_liv === '20261015', after)
    check('sst line flipped to En_Cours', after.sstatut === STATUT_OPEN, after)
    check('date_delai untouched when there was no previous date', after.sst_delai === waiting.sst_delai, after)

    const detail = await api(`/commandes-trm/${waiting.IDcommande_client}`)
    const lineAfter = (detail.json?.lignes ?? []).find((l: any) => l.IDligne_commande_client === waiting.IDligne_commande_client)
    check('detail no longer flags attente_delai', lineAfter?.attente_delai === false, lineAfter)
    check('detail shows no initial délai (never rescheduled)', lineAfter?.date_delai_initiale === null, lineAfter)
  }

  // ── En_Cours, never rescheduled: capture-once freezes the original ──
  const fresh = pairs.find((p) => p.sstatut === STATUT_OPEN && p.sst_liv && p.sst_liv === p.sst_delai)
  if (!fresh) skip('capture-once on first reschedule', 'no En_Cours line with date_delai = date_livraison')
  else {
    touched.push(fresh)
    const r = await setDelai(fresh.IDligne_commande_client, '20261120')
    check('PUT /delai on an En_Cours line → 200', r.status === 200, r.json ?? r.status)
    const after = await readPair(fresh)
    check('TRM date moved', after.cc_liv === '20261120', after)
    check('sst date moved', after.sst_liv === '20261120', after)
    check('original date frozen into date_delai', after.sst_delai === fresh.sst_liv, { after, original: fresh.sst_liv })
    check('sstatut stays En_Cours', after.sstatut === STATUT_OPEN, after)
    const detail = await api(`/commandes-trm/${fresh.IDcommande_client}`)
    const line = (detail.json?.lignes ?? []).find((l: any) => l.IDligne_commande_client === fresh.IDligne_commande_client)
    check('detail exposes the initial délai', line?.date_delai_initiale === fresh.sst_liv, line)

    // Second reschedule: the frozen original must not move.
    const r2 = await setDelai(fresh.IDligne_commande_client, '20261201')
    check('second reschedule → 200', r2.status === 200, r2.status)
    const after2 = await readPair(fresh)
    check('frozen original survives the second reschedule', after2.sst_delai === fresh.sst_liv, after2)
  }

  // ── Non_Envoye keeps its status ──
  const draft = pairs.find((p) => p.sstatut === STATUT_NON_ENVOYE)
  if (!draft) skip('Non_Envoye keeps its status', 'no Non_Envoye mirrored line')
  else {
    touched.push(draft)
    const r = await setDelai(draft.IDligne_commande_client, '20261015')
    check('PUT /delai on a Non_Envoye line → 200', r.status === 200, r.status)
    const after = await readPair(draft)
    check('Non_Envoye is not flipped (bon de commande not sent)', after.sstatut === STATUT_NON_ENVOYE, after)
    check('…but both dates are written', after.cc_liv === '20261015' && after.sst_liv === '20261015', after)
  }

  // ── Validation ──
  const any = pairs[0]
  check('garbage date → 400', (await setDelai(any.IDligne_commande_client, '15/10/2026')).status === 400)
  check('extra field → 400 (strict body)',
    (await api(`/commandes-trm/lignes/${any.IDligne_commande_client}/delai`, { method: 'PUT', body: JSON.stringify({ date_livraison: '20261015', quantite: 5 }) })).status === 400)
  check('unknown line → 404', (await setDelai(999999999, '20261015')).status === 404)

  // ── Gates ──
  const soldee = await query<any>(
    `SELECT lcc.IDligne_commande_client FROM commande_client cc
     INNER JOIN ligne_commande_client lcc ON lcc.IDcommande_client = cc.IDcommande_client
     WHERE cc.IDsociete = 2 AND cc.est_soldee = 1 ORDER BY cc.IDcommande_client DESC LIMIT 1`,
  )
  const soldeeLine = n(soldee[0]?.IDligne_commande_client)
  if (soldeeLine === 0) skip('soldée refused', 'no soldée TRM commande')
  else {
    const r = await setDelai(soldeeLine, '20261015')
    check('soldée commande → 409 commande_soldee', r.status === 409 && r.json?.error === 'commande_soldee', r.json)
  }

  const perms = await getAllTrmPermissions()
  const users = await query<any>('SELECT IDutilisateur FROM utilisateur ORDER BY IDutilisateur ASC')
  const outsider = users.map((u: any) => n(u.IDutilisateur)).find((id: number) => id > 1 && !(perms[id] ?? []).includes('edit_commandes_client'))
  if (!outsider) skip('edit_commandes_client gate', 'every user holds the key')
  else check(`without edit_commandes_client → 403 (user ${outsider})`,
    (await setDelai(any.IDligne_commande_client, '20261015', `mps_uid=${sign(outsider)}`)).status === 403)
  const anon = await fetch(`${API}/commandes-trm/lignes/${any.IDligne_commande_client}/delai`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date_livraison: '20261015' }),
  })
  check('unauthenticated → 401', anon.status === 401, anon.status)

  console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`}${skipped > 0 ? ` (${skipped} skipped)` : ''}.`)
  if (failures > 0) process.exitCode = 1
}

try {
  await main()
} finally {
  await restore()
  await closeConnection()
}
