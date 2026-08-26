/**
 * Guard for the Gestion des OF write cycle (/api/of-trm).
 *
 *   API_BASE=http://localhost:8083/api pnpm --filter @mps/api exec tsx src/scripts/check-of-trm.ts
 *
 * Exercises the FIRST write path to ordre_fabrication/asso_fil_of/
 * fil_incorpore/message_of end-to-end over HTTP against the dev API:
 * create ×2 on an idle métier → reorder → update (accented consigne) →
 * composition/incorpore replace → observation → 409 guards (delete with
 * production, activer on a busy métier) → activer → terminer with
 * auto-activation handoff → delete both. Leaves the database as it found it
 * (the scratch OFs are deleted; the terminé one never produced anything).
 *
 * Also guards the `edit_of` gate the write routes sit behind: anonymous → 401,
 * a signed-in user without the key → 403, and reading stays open to them. Until
 * that key existed these nine routes took **no cookie at all** — this script
 * used to pass without sending one, which is how that was noticed.
 *
 * The dev database is a stale copy of prod — safe for scratch writes, same
 * assumption as every other check script here.
 */
import crypto from 'node:crypto'
import { getAllTrmPermissions } from '../lib/permissions-trm.js'

const BASE = process.env.API_BASE ?? 'http://localhost:8083/api'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
/** The write cycle below runs as the effective admin, who bypasses edit_of. */
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
  console.log(`Gestion des OF write-cycle check against ${BASE}\n`)

  // ── The edit_of gate ────────────────────────────────
  // Reading an OF is open to whoever holds the Production menu; the nine write
  // routes are not. Asserted before the write cycle so a broken gate is the
  // first thing reported, not a casualty of a failed scratch write.
  const anon = await fetch(`${BASE}/of-trm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ IDligne_commande_client: 1, IDmachine: 1, quantite: 1 }),
  })
  check('POST / unauthenticated → 401', anon.status === 401, anon.status)

  const perms = await getAllTrmPermissions()
  const outsider = Object.keys(perms).length >= 0
    ? [2, 4, 11, 12, 21].find((id) => !(perms[id] ?? []).includes('edit_of'))
    : undefined
  if (outsider === undefined) {
    console.log('  SKIP edit_of gate — every candidate user holds the key')
  } else {
    const cookie = `mps_uid=${sign(outsider)}`
    const denied = await api('/of-trm', {
      method: 'POST',
      body: JSON.stringify({ IDligne_commande_client: 1, IDmachine: 1, quantite: 1 }),
    }, cookie)
    check(`POST / without edit_of → 403 (user ${outsider})`, denied.status === 403, denied.body)
    const list = await api('/of-trm', {}, cookie)
    check('reading the OF list stays open without edit_of', list.status === 200, list.status)
  }

  // ── Pick a scratch stage: an open line with a seedable composition, and an
  //    idle métier (no open OF at all so we can activer/terminer freely).
  const lignes = (await api('/of-trm/lookups/lignes-commande')).body as any[]
  const ligne = lignes.find((l) => l.restant > 0 && l.IDreference > 0) ?? lignes[0]
  check('an open ligne is available', !!ligne, lignes?.length)
  if (!ligne) process.exit(1)

  const seed = (await api(`/of-trm/lookups/composition?ligne=${ligne.id}`)).body as any
  check('composition seed has components', seed.components?.length >= 1, seed)
  const composition = (seed.components ?? []).map((c: any) => ({
    IDref_fil: c.IDref_fil,
    IDcolori_fil: c.IDcolori_fil,
    IDstock_fil: c.defaultLot ?? 0,
    pourcentage: c.pourcentage,
  }))
  if (composition.length === 0) process.exit(1)

  const machines = (await api('/of-trm/lookups/machines')).body as any[]
  const encours = (await api('/of-trm?statut=encours')).body as any[]
  const attente = (await api('/of-trm?statut=attente')).body as any[]
  const busyMachines = new Set([...encours, ...attente].map((o) => o.IDmachine))
  const idle = machines.find((m) => !busyMachines.has(m.id))
  check('an idle métier exists', !!idle, machines.length)
  if (!idle) process.exit(1)
  console.log(`  ligne ${ligne.id} (cmd ${ligne.commande_numero}, ${ligne.ref_label}) · métier ${idle.nom} (#${idle.id})\n`)

  // ── Create two scratch OFs on the idle métier.
  const mkBody = { IDligne_commande_client: ligne.id, IDmachine: idle.id, quantite: 10, composition }
  const a = await api('/of-trm', { method: 'POST', body: JSON.stringify(mkBody) })
  check('POST / creates OF A (201)', a.status === 201 && a.body.id > 0, a)
  const b = await api('/of-trm', { method: 'POST', body: JSON.stringify(mkBody) })
  check('POST / creates OF B (201)', b.status === 201 && b.body.id > 0, b)
  const idA = a.body.id as number
  const idB = b.body.id as number

  let detA = (await api(`/of-trm/${idA}`)).body as any
  let detB = (await api(`/of-trm/${idB}`)).body as any
  check('A created in attente with priorite 1', detA.est_actif === 0 && detA.priorite === 1, detA)
  check('B queued behind A (priorite 2)', detB.priorite === 2, detB.priorite)
  check('A nb_pieces derived (ceil 10/poids)', detA.nb_pieces === Math.max(1, Math.ceil(10 / detA.poids_piece)), detA.nb_pieces)
  check('A composition persisted', detA.composition.length === composition.length, detA.composition)

  // ── Reorder: move B up, then verify, then move it back down.
  const up = await api(`/of-trm/${idB}/reorder`, { method: 'POST', body: JSON.stringify({ direction: 'up' }) })
  check('reorder B up (200)', up.status === 200, up)
  detB = (await api(`/of-trm/${idB}`)).body
  detA = (await api(`/of-trm/${idA}`)).body
  check('after reorder: B=1, A=2', detB.priorite === 1 && detA.priorite === 2, { a: detA.priorite, b: detB.priorite })
  await api(`/of-trm/${idB}/reorder`, { method: 'POST', body: JSON.stringify({ direction: 'down' }) })

  // ── Update the form — accented consigne goes through sqlText.
  const consigne = 'Consigne d’essai — vérifier les accents éàç'
  const put = await api(`/of-trm/${idA}`, {
    method: 'PUT',
    body: JSON.stringify({ visitage: 2, nettoyage: 2, finir_fil: 1, observations: consigne, quantite: 12 }),
  })
  check('PUT /:id (200)', put.status === 200, put)
  detA = (await api(`/of-trm/${idA}`)).body
  check('visitage/nettoyage/finir_fil stored', detA.visitage === 2 && detA.nettoyage === 2 && detA.finir_fil === 1, detA)
  check('accented consigne round-trips', detA.observations.includes('vérifier les accents éàç'), detA.observations)
  check('quantite editable pre-production + nb_pieces follows', detA.quantite === 12 && detA.nb_pieces === Math.ceil(12 / detA.poids_piece), detA)

  // ── Composition replace + incorpore.
  const newRows = composition.map((c: any) => ({ ...c }))
  const cput = await api(`/of-trm/${idA}/composition`, { method: 'PUT', body: JSON.stringify({ rows: newRows }) })
  check('PUT composition (200)', cput.status === 200, cput)
  const lot0 = composition[0].IDstock_fil
  if (lot0 > 0) {
    const iput = await api(`/of-trm/${idA}/incorpore`, {
      method: 'PUT', body: JSON.stringify({ rows: [{ IDstock_fil: lot0, poids: 5.5 }] }),
    })
    check('PUT incorpore (200)', iput.status === 200, iput)
    detA = (await api(`/of-trm/${idA}`)).body
    check('incorpore persisted with lot label', detA.incorpore.length === 1 && detA.incorpore[0].poids === 5.5, detA.incorpore)
  }

  // ── Observation (positional insert into message_of).
  const obs = await api(`/of-trm/${idA}/observations`, {
    method: 'POST', body: JSON.stringify({ observation: 'Essai bureau — à supprimer' }),
  })
  check('POST observation (201)', obs.status === 201 && obs.body.id > 0, obs)
  const obsList = (await api(`/of-trm/${idA}/observations`)).body as any[]
  check('observation listed with date', obsList.length === 1 && !!obsList[0].date && obsList[0].observation.includes('Essai bureau'), obsList)

  // ── 409 guards.
  const delProd = await api('/of-trm/3378', { method: 'DELETE' })
  check('DELETE an OF with production → 409 production_lancee', delProd.status === 409 && delProd.body.error === 'production_lancee', delProd)

  // ── Activer A, then B must be refused (one active OF per métier).
  const act = await api(`/of-trm/${idA}/activer`, { method: 'POST' })
  check('activer A (200)', act.status === 200, act)
  detA = (await api(`/of-trm/${idA}`)).body
  check('A active with priorite 1', detA.est_actif === 1 && detA.priorite === 1, detA)
  const actB = await api(`/of-trm/${idB}/activer`, { method: 'POST' })
  check('activer B while A runs → 409 machine_occupee', actB.status === 409 && actB.body.error === 'machine_occupee', actB)

  // ── Terminer A with B flagged auto_activation → B takes the métier.
  await api(`/of-trm/${idB}`, { method: 'PUT', body: JSON.stringify({ auto_activation: 1 }) })
  const term = await api(`/of-trm/${idA}/terminer`, { method: 'POST' })
  check('terminer A (200) and auto-activates B', term.status === 200 && term.body.activated === idB, term)
  detA = (await api(`/of-trm/${idA}`)).body
  detB = (await api(`/of-trm/${idB}`)).body
  check('A terminé (est_termine=1, priorite=0, arret_prod set)', detA.est_termine === 1 && detA.priorite === 0 && !!detA.arret_prod, detA)
  check('B active with priorite 1', detB.est_actif === 1 && detB.priorite === 1, detB)
  const putTerm = await api(`/of-trm/${idA}`, { method: 'PUT', body: JSON.stringify({ visitage: 1 }) })
  check('PUT on a terminé OF → 409 of_termine', putTerm.status === 409 && putTerm.body.error === 'of_termine', putTerm)

  // ── Cleanup: delete both scratch OFs (neither produced anything).
  const delB = await api(`/of-trm/${idB}`, { method: 'DELETE' })
  const delA = await api(`/of-trm/${idA}`, { method: 'DELETE' })
  check('cleanup: both scratch OFs deleted', delA.status === 200 && delB.status === 200, { delA, delB })
  const gone = await api(`/of-trm/${idA}`)
  check('deleted OF is 404', gone.status === 404, gone.status)
  const attAfter = (await api('/of-trm?statut=attente')).body as any[]
  check('métier queue left empty', !attAfter.some((o: any) => o.IDmachine === idle.id), attAfter.filter((o: any) => o.IDmachine === idle.id))

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
