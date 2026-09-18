// Guard for Clients › Commandes — « une pièce donnée ne reste pas affectée à
// une commande client » (LIVA #1173, « Total affecté incorrect »).
//
//   pnpm --filter @mps/api exec tsx src/scripts/check-donation-lien-client.ts
//   pnpm --filter @mps/api exec tsx src/scripts/check-donation-lien-client.ts --repair
//
// On the prod API host: cd /home/debian/mps_api && node --env-file=.env
// --import tsx src/scripts/check-donation-lien-client.ts [--repair]
// (or from a dev machine with HFSQL_CONNECTION_STRING pointed at the prod
// server — the script only needs the database).
//
// WHY THIS EXISTS — commande 3795 (Thuasne) showed « Affecté 192,6 / 200 Ml »
// while its three fini rolls summed to 162,8. The 29,8 Ml were piece 1448/17:
// a 10 kg second-choice écru of 2022, attached to the standing donation order
// 2071 (client « Missing ») AND still carrying IDligne_commande_client = the
// Thuasne line. 10 × rendement 2,97767 = 29,8. Every stock reader hides a
// donated piece since #1154, so nothing on the screen could show it.
//
// stock_ecru.IDcommande_donation and .IDligne_commande_client are independent
// columns; HFSQL enforces nothing between them and the legacy WinDev windows
// write each one alone. ETM's pickers refuse both directions since July 2026,
// `attachDonationSql()` now releases the reservation on attach, and the gauge
// excludes donated pieces — this script finds and repairs what is already
// there (24 écru pieces on the dev copy of 2026-09-18, 0 fini).
//
// Invariant asserted here: no piece of either catalog has IDcommande_donation
// > 0 together with IDligne_commande_client > 0. --repair clears the client
// FK on those pieces — the donation FK is the stock exit and stays.
import dotenv from 'dotenv'
const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' })
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { DONATION_LINKED_CLIENT_WHERE, repairDonationClientLinkSql, type DonationKind } from '../lib/donation-pieces.js'

const REPAIR = process.argv.includes('--repair')
const n = (v: unknown) => Number(v) || 0

interface Row { id: number; numero: string | null; poids: number | null; don: number; lid: number }

const CATALOG: Record<DonationKind, { table: string; pk: string }> = {
  ecru: { table: 'stock_ecru', pk: 'IDstock_ecru' },
  fini: { table: 'stock_fini', pk: 'IDstock_fini' },
}

async function linked(kind: DonationKind): Promise<Row[]> {
  const { table, pk } = CATALOG[kind]
  return query<Row>(
    `SELECT ${pk} AS id, numero, poids, IDcommande_donation AS don, IDligne_commande_client AS lid
       FROM ${table} WHERE ${DONATION_LINKED_CLIENT_WHERE} ORDER BY IDligne_commande_client, ${pk}`,
  )
}

/** commande numero + client for each client line, so the report reads like the screen. */
async function describeLines(lids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(lids.filter((x) => x > 0)))
  if (u.length === 0) return out
  const lines = await query<{ lid: number; cid: number }>(
    `SELECT IDligne_commande_client AS lid, IDcommande_client AS cid FROM ligne_commande_client WHERE IDligne_commande_client IN (${u.join(',')})`,
  )
  const cids = Array.from(new Set(lines.map((l) => n(l.cid)).filter((x) => x > 0)))
  const cmds = cids.length === 0 ? [] : await query<{ cid: number; numero: number | string; IDclient: number }>(
    `SELECT IDcommande_client AS cid, numero, IDclient FROM commande_client WHERE IDcommande_client IN (${cids.join(',')})`,
  )
  const clientIds = Array.from(new Set(cmds.map((c) => n(c.IDclient)).filter((x) => x > 0)))
  const clients = clientIds.length === 0 ? [] : await query<{ IDclient: number; nom: string | null }>(
    `SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`,
  )
  const clientNom = new Map(clients.map((c) => [n(c.IDclient), (c.nom ?? '').toString().trim()]))
  const cmdLabel = new Map(cmds.map((c) => [n(c.cid), `commande ${c.numero} · ${clientNom.get(n(c.IDclient)) ?? '?'}`]))
  for (const l of lines) out.set(n(l.lid), cmdLabel.get(n(l.cid)) ?? `commande id ${n(l.cid)}`)
  return out
}

async function main() {
  console.log(REPAIR ? 'mode: RÉPARATION' : 'mode: contrôle (--repair pour corriger)')
  const before: Record<DonationKind, Row[]> = { ecru: await linked('ecru'), fini: await linked('fini') }
  const total = before.ecru.length + before.fini.length
  if (total === 0) {
    console.log('OK — no donated piece holds a client-line reservation.')
    await closeConnection()
    return
  }
  const labels = await describeLines([...before.ecru, ...before.fini].map((r) => n(r.lid)))
  for (const kind of ['ecru', 'fini'] as const) {
    if (before[kind].length === 0) continue
    console.log(`${before[kind].length} ${kind} piece(s) attached to a donation AND reserved to a client line:`)
    const byLine = new Map<number, Row[]>()
    for (const r of before[kind]) byLine.set(n(r.lid), [...(byLine.get(n(r.lid)) ?? []), r])
    for (const [lid, rows] of byLine) {
      const pieces = rows.map((r) => `${(r.numero ?? '').toString().trim()} (${n(r.poids)} kg, don ${n(r.don)})`).join(', ')
      console.log(`  ${labels.get(lid) ?? `line ${lid}`} [ligne ${lid}]: ${pieces}`)
    }
  }

  if (!REPAIR) {
    console.log('FAIL — relancer avec --repair.')
    await closeConnection()
    process.exit(1)
  }
  for (const kind of ['ecru', 'fini'] as const) {
    if (before[kind].length > 0) await query(repairDonationClientLinkSql(kind))
  }
  let ok = true
  for (const kind of ['ecru', 'fini'] as const) {
    if (before[kind].length === 0) continue
    const { table, pk } = CATALOG[kind]
    const ids = before[kind].map((r) => n(r.id)).join(',')
    const check = await query<{ nb: number }>(
      `SELECT COUNT(*) AS nb FROM ${table} WHERE ${pk} IN (${ids}) AND (IDligne_commande_client IS NULL OR IDligne_commande_client = 0) AND IDcommande_donation > 0`,
    )
    const after = await linked(kind)
    console.log(`${kind}: repaired ${n(check[0]?.nb)} / ${before[kind].length}; still linked: ${after.length}`)
    if (after.length > 0 || n(check[0]?.nb) !== before[kind].length) ok = false
  }
  await closeConnection()
  if (!ok) process.exit(1)
}

main().catch(async (e) => {
  console.error(e)
  await closeConnection().catch(() => {})
  process.exit(1)
})
