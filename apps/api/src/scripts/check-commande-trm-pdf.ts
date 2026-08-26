/**
 * HTTP guard for the confirmation de commande TRM (PDF + email) that
 * `/api/commandes-trm` grew for the TRM screen's Imprimer / Envoyer buttons.
 *
 *   API_BASE=http://localhost:8082/api pnpm --filter @mps/api exec tsx src/scripts/check-commande-trm-pdf.ts
 *
 * What is actually at risk here is the PARTITION. `commande_client` holds both
 * sociétés in one id space, and these three routes reach a row by an id taken
 * straight from the URL - so an ETM commande id must come back 404 on every one
 * of them, or the TRM screen would happily print an ETS Malterre order under
 * Tricotage Malterre's letterhead (wrong SIRET on a commercial document).
 *
 * Read-only: the POST is only exercised on paths that refuse BEFORE sending, so
 * nothing is mailed and no envoi_email row is written.
 */
import crypto from 'node:crypto'
import { query, closeConnection } from '../lib/hfsql-auto.js'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const API = process.env.API_BASE ?? 'http://localhost:8080/api'

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
const COOKIE = `mps_uid=${sign(1)}; mps_uid_admin=${sign(1)}`

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  OK   ${label}`)
  else { failures++; console.error(`  FAIL ${label}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ''}`) }
}

async function getRaw(path: string): Promise<{ status: number; type: string; buf: Buffer }> {
  const res = await fetch(`${API}${path}`, { headers: { Cookie: COOKIE } })
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: res.status, type: res.headers.get('content-type') ?? '', buf }
}

async function getJson(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, { headers: { Cookie: COOKIE } })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: COOKIE },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** A société-2 commande that has at least one line, `mirror` picking between an
 *  ETM-owned one and a natively-created one (both must print). */
async function pickCommande(mirror: boolean): Promise<{ id: number; numero: number } | null> {
  const rows = await query<{ IDcommande_client: number; numero: number | null }>(
    `SELECT c.IDcommande_client, c.numero
     FROM commande_client c
     WHERE c.IDsociete = 2 AND c.IDcommande_ETM ${mirror ? '> 0' : '= 0'}
       AND EXISTS (SELECT 1 FROM ligne_commande_client l WHERE l.IDcommande_client = c.IDcommande_client)
     ORDER BY c.IDcommande_client DESC`,
  )
  const r = rows[0]
  return r ? { id: Number(r.IDcommande_client), numero: Number(r.numero) || 0 } : null
}

async function main() {
  console.log(`\nConfirmation de commande TRM - ${API}\n`)

  for (const mirror of [false, true]) {
    const cmd = await pickCommande(mirror)
    const label = mirror ? 'commande miroir ETM' : 'commande native TRM'
    if (!cmd) { check(`${label}: aucune en base`, false); continue }
    console.log(`${label} #${cmd.id} (N°${cmd.numero})`)

    const pdf = await getRaw(`/commandes-trm/${cmd.id}/pdf`)
    check('  PDF 200', pdf.status === 200, pdf.status)
    check('  PDF content-type', pdf.type.includes('application/pdf'), pdf.type)
    check('  PDF magic bytes', pdf.buf.subarray(0, 4).toString() === '%PDF', pdf.buf.subarray(0, 8).toString())
    check('  PDF non trivial (> 10 ko)', pdf.buf.length > 10_000, pdf.buf.length)

    const def = await getJson(`/commandes-trm/${cmd.id}/email-defaults`)
    check('  email-defaults 200', def.status === 200, def.status)
    check('  objet porte le numéro', typeof def.json?.subject === 'string' && def.json.subject.includes(String(cmd.numero)), def.json?.subject)
    check('  émetteur = Tricotage Malterre', (def.json?.body ?? '').includes('Tricotage Malterre'), null)
    check('  destinataires présents', def.json?.recipients != null, null)
  }

  // ── The partition guard ──
  const etm = await query<{ IDcommande_client: number }>(
    `SELECT IDcommande_client FROM commande_client WHERE IDsociete = 1 ORDER BY IDcommande_client DESC`,
  )
  const etmId = Number(etm[0]?.IDcommande_client) || 0
  console.log(`\ncommande ETM #${etmId} (société 1) - doit être refusée partout`)
  const p = await getRaw(`/commandes-trm/${etmId}/pdf`)
  check('  PDF 404', p.status === 404, p.status)
  const d = await getJson(`/commandes-trm/${etmId}/email-defaults`)
  check('  email-defaults 404', d.status === 404, d.status)
  const e = await post(`/commandes-trm/${etmId}/email`, {
    to: ['guard@example.com'], subject: 'guard', body: 'guard', dev_skip_send: true,
  })
  check('  email 404 (refus avant tout envoi)', e.status === 404, e.status)

  // Validation refuses before the sender/attachment work too.
  const trm = await pickCommande(false)
  if (trm) {
    const bad = await post(`/commandes-trm/${trm.id}/email`, { to: [], subject: '', body: '' })
    check('  email 400 sur payload vide', bad.status === 400, bad.status)
  }

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
  await closeConnection()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error(err)
  await closeConnection()
  process.exit(1)
})
