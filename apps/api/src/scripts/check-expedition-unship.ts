// Guard for Clients › Expéditions « Supprimer l'expédition » and « retirer un
// rouleau » (DELETE /api/expeditions/formelle/:id and
// DELETE /api/expeditions/formelle/:id/lignes/:lccId/rolls/:stockId).
//
//   pnpm --filter @mps/api exec tsx src/scripts/check-expedition-unship.ts
//
// Writes, then restores — refuses anything but a localhost HFSQL (the dev copy).
//
// WHY THIS EXISTS — follow-up of ticket #1086 found while handling AE 9698
// (Save Futur, 2026-09-08). "A roll is shipped" is TWO facts,
// `IDligne_expedition > 0` AND `IDetat_stock_fini = 4`, and the delete route
// used to clear only the first. The roll it left behind — état « Expédié »,
// no expedition — is hidden by Finis › Stock (`IDetat_stock_fini <> 4`), gone
// from Clients › Gestion › Marchandise (INNER JOIN on the expedition line) and
// never offered back by the line's roll picker: a ghost reachable from no
// screen. `unshipFiniRolls` now undoes both facts and KEEPS the commande-line
// affectation (deleting an avis undoes a shipment, not the order it was
// picked for — the retour-stock route is the one that releases the line).
//
// This script replays the route's own helper on real rows of the dev copy and
// asserts, with the screens' predicates as SQL, that the roll is visible again
// and offerable to its own line, that a roll shipped in another état keeps it,
// and that a sibling roll on the same expedition line is untouched. Every row
// is restored afterwards.
import dotenv from 'dotenv'
const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' })
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { unshipFiniRolls } from '../routes/expeditions.js'

const CONN = process.env.HFSQL_CONNECTION_STRING ?? ''
if (CONN && !/Server Name=(localhost|127\.0\.0\.1)\b/i.test(CONN)) {
  console.error(`Refusing to run against ${CONN.replace(/PWD=[^;]*/i, 'PWD=***')}: this guard writes, localhost only.`)
  process.exit(2)
}

const ETAT_EXPEDIE = 4
const ETAT_VALIDE = 3
const n = (v: unknown) => Number(v) || 0
const s = (v: unknown) => (v ?? '').toString().replace(/\u0000/g, '').trim()

interface Roll { id: number; numero: string; etat: number; le: number; lcc: number }

async function readRoll(id: number): Promise<Roll> {
  const r = (await query<Record<string, unknown>>(
    `SELECT IDstock_fini, numero, IDetat_stock_fini, IDligne_expedition, IDligne_commande_client FROM stock_fini WHERE IDstock_fini = ${id}`,
  ))[0]
  return { id, numero: s(r?.numero), etat: n(r?.IDetat_stock_fini), le: n(r?.IDligne_expedition), lcc: n(r?.IDligne_commande_client) }
}

async function restore(r: Roll): Promise<boolean> {
  await query(`UPDATE stock_fini SET IDligne_expedition = ${r.le}, IDligne_commande_client = ${r.lcc}, IDetat_stock_fini = ${r.etat} WHERE IDstock_fini = ${r.id}`)
  const back = await readRoll(r.id)
  const ok = back.etat === r.etat && back.le === r.le && back.lcc === r.lcc
  console.log(`  ${ok ? '✓' : '✗'} ${r.numero} restored to état=${r.etat} ligne_exp=${r.le} ligne_cmd=${r.lcc}`)
  return ok
}

/** Finis › Stock predicate (stock-fini.ts « Masquer les rouleaux expédiés »). */
async function visibleInStock(id: number): Promise<boolean> {
  const r = (await query<{ nb: number }>(
    `SELECT COUNT(*) AS nb FROM stock_fini WHERE IDstock_fini = ${id}
       AND (IDligne_expedition IS NULL OR IDligne_expedition = 0)
       AND (IDetat_stock_fini IS NULL OR IDetat_stock_fini <> ${ETAT_EXPEDIE})`,
  ))[0]
  return n(r?.nb) > 0
}

/** The expedition roll picker's "affected to this line, not shipped" pool
 *  (expeditions.ts buildRollPayload). */
async function offerableToItsLine(id: number, lcc: number): Promise<boolean> {
  const r = (await query<{ nb: number }>(
    `SELECT COUNT(*) AS nb FROM stock_fini WHERE IDstock_fini = ${id}
       AND IDligne_commande_client = ${lcc}
       AND (IDligne_expedition IS NULL OR IDligne_expedition = 0)`,
  ))[0]
  return n(r?.nb) > 0
}

let bad = 0
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) bad++ }

/** Case 1: a roll shipped with état 4, on a line holding at least one sibling —
 *  unship this roll only. */
async function caseExpedie(): Promise<void> {
  console.log('\n── 1. shipped roll (état 4) with a sibling on the same expedition line ──')
  const pick = await query<Record<string, unknown>>(
    `SELECT TOP 1 IDstock_fini, IDligne_expedition FROM stock_fini
     WHERE IDligne_expedition > 0 AND IDetat_stock_fini = ${ETAT_EXPEDIE} AND IDligne_commande_client > 0
     ORDER BY IDstock_fini DESC`,
  )
  if (pick.length === 0) { console.log('  (no candidate — skipped)'); return }
  const roll = await readRoll(n(pick[0].IDstock_fini))
  const siblings = await query<{ IDstock_fini: number }>(
    `SELECT IDstock_fini FROM stock_fini WHERE IDligne_expedition = ${roll.le} AND IDstock_fini <> ${roll.id}`,
  )
  const sibling = siblings.length > 0 ? await readRoll(n(siblings[0].IDstock_fini)) : null
  console.log(`  roll ${roll.numero} (id ${roll.id}) before: état=${roll.etat} ligne_exp=${roll.le} ligne_cmd=${roll.lcc}` +
    (sibling ? `; sibling ${sibling.numero} (id ${sibling.id})` : '; no sibling on this line'))
  check(!(await visibleInStock(roll.id)) && !(await offerableToItsLine(roll.id, roll.lcc)), 'before: hidden from Finis › Stock and from the line picker')
  try {
    await unshipFiniRolls([roll.le], roll.id)
    const after = await readRoll(roll.id)
    check(after.le === 0, 'after: IDligne_expedition = 0')
    check(after.etat === ETAT_VALIDE, `after: état ${after.etat} = Validé (was Expédié)`)
    check(after.lcc === roll.lcc, `after: still affected to commande line ${roll.lcc}`)
    check(await visibleInStock(roll.id), 'after: visible in Finis › Stock')
    check(await offerableToItsLine(roll.id, roll.lcc), 'after: offered back by its line\'s roll picker')
    if (sibling) {
      const sib = await readRoll(sibling.id)
      check(sib.le === sibling.le && sib.etat === sibling.etat && sib.lcc === sibling.lcc, `sibling ${sibling.numero} untouched (stockId scope)`)
    }
  } finally {
    if (!(await restore(roll))) bad++
  }
}

/** Case 2: a roll shipped in another état keeps it — only état 4 is demoted. */
async function caseAutreEtat(): Promise<void> {
  console.log('\n── 2. shipped roll in an état other than 4 keeps its état ──')
  const pick = await query<Record<string, unknown>>(
    `SELECT TOP 1 IDstock_fini FROM stock_fini
     WHERE IDligne_expedition > 0 AND IDetat_stock_fini > 0 AND IDetat_stock_fini <> ${ETAT_EXPEDIE}
     ORDER BY IDstock_fini DESC`,
  )
  if (pick.length === 0) { console.log('  (no candidate — skipped)'); return }
  const roll = await readRoll(n(pick[0].IDstock_fini))
  console.log(`  roll ${roll.numero} (id ${roll.id}) before: état=${roll.etat} ligne_exp=${roll.le} ligne_cmd=${roll.lcc}`)
  try {
    await unshipFiniRolls([roll.le], roll.id)
    const after = await readRoll(roll.id)
    check(after.le === 0, 'after: IDligne_expedition = 0')
    check(after.etat === roll.etat, `after: état ${after.etat} unchanged`)
    check(after.lcc === roll.lcc, `after: still affected to commande line ${roll.lcc}`)
  } finally {
    if (!(await restore(roll))) bad++
  }
}

/** Case 3: whole-line scope (no stockId) — every roll on the line, and only
 *  those, is unshipped. Uses the smallest line with 2+ rolls to keep the write
 *  short. */
async function caseLigneEntiere(): Promise<void> {
  console.log('\n── 3. whole expedition line (the delete-expedition path) ──')
  const lines = await query<{ le: number; nb: number }>(
    `SELECT IDligne_expedition AS le, COUNT(*) AS nb FROM stock_fini
     WHERE IDligne_expedition > 0 AND IDetat_stock_fini = ${ETAT_EXPEDIE}
     GROUP BY IDligne_expedition HAVING COUNT(*) >= 2 AND COUNT(*) <= 5`,
  )
  if (lines.length === 0) { console.log('  (no candidate line — skipped)'); return }
  const le = n(lines[lines.length - 1].le)
  const ids = (await query<{ IDstock_fini: number }>(`SELECT IDstock_fini FROM stock_fini WHERE IDligne_expedition = ${le}`)).map((r) => n(r.IDstock_fini))
  const before = await Promise.all(ids.map(readRoll))
  const otherBefore = n((await query<{ nb: number }>(`SELECT COUNT(*) AS nb FROM stock_fini WHERE IDligne_expedition > 0`))[0]?.nb)
  console.log(`  line ${le}: ${ids.length} rolls (${before.map((r) => r.numero).join(', ')})`)
  try {
    await unshipFiniRolls([le])
    const after = await Promise.all(ids.map(readRoll))
    check(after.every((r) => r.le === 0 && r.etat === ETAT_VALIDE), 'after: every roll on the line unshipped and Validé')
    check(after.every((r, i) => r.lcc === before[i].lcc), 'after: affectations kept')
    const otherAfter = n((await query<{ nb: number }>(`SELECT COUNT(*) AS nb FROM stock_fini WHERE IDligne_expedition > 0`))[0]?.nb)
    check(otherBefore - otherAfter === ids.length, `exactly ${ids.length} roll(s) left a shipment, no other line touched`)
  } finally {
    for (const r of before) if (!(await restore(r))) bad++
  }
}

async function main() {
  console.log(`\nDB: ${(CONN || '(default localhost)').replace(/PWD=[^;]*/i, 'PWD=***')}`)
  await caseExpedie()
  await caseAutreEtat()
  await caseLigneEntiere()
  console.log(bad === 0 ? '\n✓ unship: all checks passed' : `\n✗ unship: ${bad} check(s) failed`)
  await closeConnection()
  process.exit(bad === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await closeConnection(); process.exit(1) })
