// Guard for Clients › Commandes › Donation — « attacher une pièce = sortie de
// stock » (LIVA #1154, « Donation ne sortent pas des stocks »).
//
//   pnpm --filter @mps/api exec tsx src/scripts/check-donation-etat.ts
//   pnpm --filter @mps/api exec tsx src/scripts/check-donation-etat.ts --repair
//
// On the prod API host: cd /home/debian/mps_api && node --env-file=.env
// --import tsx src/scripts/check-donation-etat.ts [--repair]
//
// WHY THIS EXISTS — order 3868 (id 7174) had six fini rolls attached through
// the NG picker, 3041/4 among them, and Isabelle still saw them in Finis ›
// Stock. Finis › Stock (legacy FI_Stock_Fini and stock-fini.ts alike) defines
// "in stock" as IDligne_expedition = 0 AND état 3; the legacy
// FEN_Ligne_Donation stamped état 4 « Expédié » on attach (877 of 888 legacy
// donation rolls: état 4, no expedition), the NG picker wrote the FK alone.
//
// Invariant asserted here: every fini roll with IDcommande_donation > 0 and
// no IDligne_expedition is in état 4. --repair stamps état 4 on the rolls
// still in état 3 (the shape of the ten stranded rolls of orders 3840/3868),
// nothing else — a roll in états 1/2 is the magasin's own classification.
import dotenv from 'dotenv'
const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' })
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { DONATION_FINI_STRANDED_WHERE, ETAT_FINI_EXPEDIE, repairStrandedDonationSql } from '../lib/donation-pieces.js'

const REPAIR = process.argv.includes('--repair')
const n = (v: unknown) => Number(v) || 0

interface Row { IDstock_fini: number; numero: string | null; IDcommande_donation: number; IDetat_stock_fini: number }

async function stranded(): Promise<Row[]> {
  return query<Row>(
    `SELECT IDstock_fini, numero, IDcommande_donation, IDetat_stock_fini FROM stock_fini
      WHERE ${DONATION_FINI_STRANDED_WHERE} ORDER BY IDcommande_donation, IDstock_fini`,
  )
}

async function main() {
  console.log(REPAIR ? 'mode: RÉPARATION' : 'mode: contrôle (--repair pour corriger)')
  const dist = await query<{ IDetat_stock_fini: number; nb: number }>(
    `SELECT IDetat_stock_fini, COUNT(*) AS nb FROM stock_fini
      WHERE IDcommande_donation > 0 AND (IDligne_expedition IS NULL OR IDligne_expedition = 0)
      GROUP BY IDetat_stock_fini`,
  )
  console.log('donation fini rolls (no avis) by état:', dist.map((d) => `${n(d.IDetat_stock_fini)} → ${n(d.nb)}`).join(' · '))

  const before = await stranded()
  if (before.length === 0) {
    console.log('OK — no donation fini roll left in état 3.')
    await closeConnection()
    return
  }
  const byOrder = new Map<number, Row[]>()
  for (const r of before) {
    const k = n(r.IDcommande_donation)
    byOrder.set(k, [...(byOrder.get(k) ?? []), r])
  }
  const orders = await query<{ IDcommande_client: number; numero: number | string }>(
    `SELECT IDcommande_client, numero FROM commande_client WHERE IDcommande_client IN (${Array.from(byOrder.keys()).join(',')})`,
  )
  const numero = new Map(orders.map((o) => [n(o.IDcommande_client), String(o.numero)]))
  console.log(`${before.length} stranded roll(s) — attached to a donation, never shipped, still état 3:`)
  for (const [id, rows] of byOrder) {
    console.log(`  commande ${numero.get(id) ?? '?'} (id ${id}): ${rows.map((r) => (r.numero ?? '').toString().trim()).join(', ')}`)
  }

  if (!REPAIR) {
    console.log('FAIL — relancer avec --repair.')
    await closeConnection()
    process.exit(1)
  }
  await query(repairStrandedDonationSql())
  const after = await stranded()
  const check = await query<{ nb: number }>(
    `SELECT COUNT(*) AS nb FROM stock_fini WHERE IDstock_fini IN (${before.map((r) => n(r.IDstock_fini)).join(',')}) AND IDetat_stock_fini = ${ETAT_FINI_EXPEDIE}`,
  )
  console.log(`repaired: ${n(check[0]?.nb)} / ${before.length} now in état ${ETAT_FINI_EXPEDIE}; still stranded: ${after.length}`)
  await closeConnection()
  if (after.length > 0 || n(check[0]?.nb) !== before.length) process.exit(1)
}

main().catch(async (e) => {
  console.error(e)
  await closeConnection().catch(() => {})
  process.exit(1)
})
