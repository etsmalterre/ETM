/**
 * Guard for the grouped-shipment carton editor
 * (PUT /api/expeditions/divers/lignes/:id/contenu — tickets #1098 / #1099).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/check-divers-carton-contenu.ts
 *   pnpm --filter @mps/api exec tsx src/scripts/check-divers-carton-contenu.ts --roundtrip
 *
 * The editor keys on the (ref × variation1 × variation2) **combo**, not on
 * `IDref_divers_expedie`, because that is the row the user reads and the row
 * the invoice groups on. Three live-data facts make that safe, and this script
 * pins all three — if any of them stops holding, the editor starts writing to
 * rows the user cannot see:
 *
 *   1. Cartons holding two rows for the same combo are essentially nonexistent
 *      (1 carton). They must survive an unchanged save untouched.
 *   2. Order-linked cartons DO hold items whose combo is not on the order
 *      (61 of 1 589). The editor lists those too, or they become uneditable.
 *   3. Nothing leaves without stock (Vincent 2026-11-27, lib/stock-divers-dispo.ts):
 *      a carton that takes more than the stock on hand is refused whole. So no
 *      `stock_divers` row may be negative, and the articles of the OPEN orders
 *      that have no stock row are listed (they cannot ship until stock is
 *      entered). Until then stock was a warning, because 584 order-line combos
 *      had no row at all.
 *
 * `--roundtrip` drives the real `setDiversCartonContenu` against a scratch
 * carton on an unbilled shipment — add, change, remove, and one attempt beyond
 * the stock — asserting the stock ledger moves by exactly the opposite of the
 * quantity each time, then deletes the carton it created. Read-only without
 * the flag.
 */
// Env first (.env.<NODE_ENV>, like the API): without it the script read a stale local HFSQL copy while
// the stock check (lib/stock-divers-dispo.ts, native PostgreSQL) had no connection at all.
import '../load-env.js'
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { setDiversCartonContenu } from '../routes/expeditions.js'
import { StockDiversInsuffisant } from '../lib/stock-divers-dispo.js'

const ROUNDTRIP = process.argv.includes('--roundtrip')

const combo = (ref: unknown, v1: unknown, v2: unknown) =>
  `${Number(ref) || 0}|${Number(v1) || 0}|${Number(v2) || 0}`
const r2 = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100

let problems = 0
const fail = (msg: string) => { console.log(`  ✗ ${msg}`); problems++ }
const ok = (msg: string) => console.log(`  ✓ ${msg}`)

/** 1 · Duplicate combos inside one carton stay rare and identifiable. */
async function checkDuplicates(): Promise<void> {
  console.log('\n1. Duplicate (ref, v1, v2) inside a single carton')
  const items = await query<any>(
    `SELECT IDref_divers_expedie, IDligne_expedition_divers, IDref_divers, IDVariation1, IDVariation2, quantite FROM ref_divers_expedie`,
  )
  const byKey = new Map<string, number>()
  for (const it of items as any[]) {
    const k = `${it.IDligne_expedition_divers}|${combo(it.IDref_divers, it.IDVariation1, it.IDVariation2)}`
    byKey.set(k, (byKey.get(k) ?? 0) + 1)
  }
  const dups = [...byKey.values()].filter((v) => v > 1).length
  console.log(`     ${items.length} items, ${dups} carton/combo pair(s) holding more than one row`)
  // The editor collapses duplicates onto the lowest id ONLY when the total
  // actually changes. A sudden crop of them would mean something else started
  // writing per-row and the collapse would begin destroying real data.
  if (dups > 5) fail(`${dups} duplicated combos — the collapse-on-change rule needs re-examining`)
  else ok('duplicates stay marginal; an unchanged save leaves them alone')
}

/** 2 · Off-order items exist, so the editor must merge them into its list. */
async function checkOffOrderItems(): Promise<void> {
  console.log('\n2. Items sitting in an order-linked carton but not on the order')
  const [exps, cartons, lignes, items] = await Promise.all([
    query<any>(`SELECT IDexpedition_divers, IDcommande_client FROM expedition_divers WHERE IDcommande_client > 0`),
    query<any>(`SELECT IDligne_expedition_divers, IDexpedition_divers FROM ligne_expedition_divers`),
    query<any>(`SELECT IDcommande_client, TYPE AS tk, IDreference, IDVariation1, IDVariation2 FROM ligne_commande_client`),
    query<any>(`SELECT IDligne_expedition_divers, IDref_divers, IDVariation1, IDVariation2 FROM ref_divers_expedie`),
  ])
  const expOfCarton = new Map<number, number>()
  for (const c of cartons as any[]) expOfCarton.set(Number(c.IDligne_expedition_divers), Number(c.IDexpedition_divers))
  const cmdOfExp = new Map<number, number>()
  for (const e of exps as any[]) cmdOfExp.set(Number(e.IDexpedition_divers), Number(e.IDcommande_client))
  const orderCombos = new Set<string>()
  for (const l of lignes as any[]) {
    if (Number(l.tk) !== 3) continue
    orderCombos.add(`${Number(l.IDcommande_client)}|${combo(l.IDreference, l.IDVariation1, l.IDVariation2)}`)
  }
  let checked = 0, offOrder = 0
  for (const it of items as any[]) {
    const cmd = cmdOfExp.get(expOfCarton.get(Number(it.IDligne_expedition_divers)) ?? -1)
    if (cmd === undefined) continue
    checked++
    if (!orderCombos.has(`${cmd}|${combo(it.IDref_divers, it.IDVariation1, it.IDVariation2)}`)) offOrder++
  }
  console.log(`     ${checked} items in order-linked cartons, ${offOrder} off-order`)
  if (offOrder === 0) {
    ok('none right now — the merge is harmless, keep it (they reappear)')
  } else {
    ok(`${offOrder} item(s) exist only because the editor merges them in`)
    console.log('     → ClientsCommandes.tsx `contentRows` must keep unioning carton items')
  }
}

/** 3 · Stock blocks a shipment: no row may be negative, and the open orders' articles without a row are named. */
async function checkStockCoverage(): Promise<void> {
  console.log('\n3. stock_divers — nothing leaves without stock')
  const [lignes, stock] = await Promise.all([
    query<any>(
      `SELECT l.TYPE AS tk, l.IDreference, l.IDVariation1, l.IDVariation2 FROM ligne_commande_client l ` +
        `INNER JOIN commande_client c ON c.IDcommande_client = l.IDcommande_client WHERE c.est_soldee = 0 AND c.IDsociete = 1`,
    ),
    query<any>(`SELECT IDref_divers, IDVariation1, IDVariation2, quantite FROM stock_divers`),
  ])
  const negatives = (stock as any[]).filter((s) => r2(s.quantite) < 0).length
  if (negatives > 0) fail(`${negatives} stock_divers row(s) below zero — a writer shipped without asking refusStockDivers()`)
  else ok('no stock row below zero')
  const have = new Set((stock as any[]).map((s) => combo(s.IDref_divers, s.IDVariation1, s.IDVariation2)))
  const want = new Set(
    (lignes as any[]).filter((l) => Number(l.tk) === 3).map((l) => combo(l.IDreference, l.IDVariation1, l.IDVariation2)),
  )
  let tracked = 0, untracked = 0
  for (const k of want) { if (have.has(k)) tracked++; else untracked++ }
  console.log(`     open orders: ${tracked} article(s) with a stock row, ${untracked} without (stock to enter before they ship)`)
}

/** 4 · Round-trip the real writer, asserting the stock ledger stays in step. */
async function roundtrip(): Promise<void> {
  console.log('\n4. Round-trip on a scratch carton (--roundtrip)')

  // An unbilled divers shipment whose order has at least one divers line that
  // stock_divers actually tracks — so the ledger assertions have something to
  // read. `est_facture = 1` shipments are locked and must never be touched.
  const exps = await query<any>(
    `SELECT IDexpedition_divers, IDcommande_client, est_facture FROM expedition_divers WHERE IDcommande_client > 0 AND est_facture = 0`,
  )
  const stockRows = await query<any>(`SELECT IDref_divers, IDVariation1, IDVariation2, quantite FROM stock_divers`)
  const stockOf = new Map<string, number>()
  for (const s of stockRows as any[]) stockOf.set(combo(s.IDref_divers, s.IDVariation1, s.IDVariation2), r2(s.quantite))

  let target: { expId: number; ref: number; v1: number; v2: number } | null = null
  for (const e of exps as any[]) {
    const lignes = await query<any>(
      `SELECT TYPE AS tk, IDreference, IDVariation1, IDVariation2 FROM ligne_commande_client WHERE IDcommande_client = ${Number(e.IDcommande_client)}`,
    )
    // …holding at least the 2 units the round-trip ships (nothing leaves without stock).
    const hit = (lignes as any[]).find(
      (l) => Number(l.tk) === 3 && (stockOf.get(combo(l.IDreference, l.IDVariation1, l.IDVariation2)) ?? 0) >= 2,
    )
    if (hit) {
      target = { expId: Number(e.IDexpedition_divers), ref: Number(hit.IDreference), v1: Number(hit.IDVariation1) || 0, v2: Number(hit.IDVariation2) || 0 }
      break
    }
  }
  // No order line with stock to spare (the usual case: stock is entered to be shipped): any article
  // holding stock will do — the writer does not need the article to be on the order.
  if (!target && exps.length > 0) {
    const nbRows = new Map<string, number>()
    for (const s of stockRows as any[]) {
      const k = combo(s.IDref_divers, s.IDVariation1, s.IDVariation2)
      nbRows.set(k, (nbRows.get(k) ?? 0) + 1)
    }
    const best = (stockRows as any[])
      .filter((s) => r2(s.quantite) >= 2 && nbRows.get(combo(s.IDref_divers, s.IDVariation1, s.IDVariation2)) === 1)
      .sort((a, b) => r2(b.quantite) - r2(a.quantite))[0]
    if (best) {
      target = { expId: Number((exps as any[])[0].IDexpedition_divers), ref: Number(best.IDref_divers), v1: Number(best.IDVariation1) || 0, v2: Number(best.IDVariation2) || 0 }
    }
  }
  if (!target) { fail('no unbilled divers shipment, or no article holding 2 units of stock — cannot round-trip'); return }

  const key = combo(target.ref, target.v1, target.v2)
  const readStock = async (): Promise<number> => {
    const rows = await query<any>(
      `SELECT quantite FROM stock_divers WHERE IDref_divers = ${target!.ref} AND IDVariation1 = ${target!.v1} AND IDVariation2 = ${target!.v2}`,
    )
    return r2(rows[0]?.quantite)
  }
  const readQty = async (cartonId: number): Promise<number> => {
    const rows = await query<any>(
      `SELECT quantite FROM ref_divers_expedie WHERE IDligne_expedition_divers = ${cartonId}`,
    )
    return r2((rows as any[]).reduce((s, r) => s + (Number(r.quantite) || 0), 0))
  }

  const stock0 = await readStock()
  console.log(`     exp ${target.expId} · article ${key} · stock ${stock0}`)
  // Two quantities within the stock on hand: a first one, then a raise.
  const [q1, q2] = stock0 >= 5 ? [3, 5] : [1, 2]

  // Scratch carton — created here, deleted at the end whatever happens.
  await query(
    `INSERT INTO ligne_expedition_divers (IDexpedition_divers, detail_ligne) VALUES (${target.expId}, 'CHECK-CONTENU')`,
  )
  const created = await query<any>(
    `SELECT IDligne_expedition_divers FROM ligne_expedition_divers WHERE IDexpedition_divers = ${target.expId} ORDER BY IDligne_expedition_divers DESC`,
  )
  const cartonId = Number(created[0]?.IDligne_expedition_divers) || 0
  if (cartonId === 0) { fail('could not create the scratch carton'); return }

  const item = (q: number) => [{ IDref_divers: target!.ref, IDVariation1: target!.v1, IDVariation2: target!.v2, quantite: q }]
  try {
    // add q1 → stock must drop by q1
    let res = await setDiversCartonContenu(cartonId, item(q1))
    let stock = await readStock()
    if (res.created !== 1) fail(`add: expected created=1, got ${JSON.stringify(res)}`)
    else if (stock !== r2(stock0 - q1)) fail(`add: stock ${stock}, expected ${r2(stock0 - q1)}`)
    else if ((await readQty(cartonId)) !== q1) fail(`add: carton quantity is not ${q1}`)
    else ok(`add ${q1} → one row created, stock −${q1}`)

    // raise to q2 → stock must drop by the difference
    res = await setDiversCartonContenu(cartonId, item(q2))
    stock = await readStock()
    if (res.updated !== 1) fail(`raise: expected updated=1, got ${JSON.stringify(res)}`)
    else if (stock !== r2(stock0 - q2)) fail(`raise: stock ${stock}, expected ${r2(stock0 - q2)}`)
    else ok(`raise to ${q2} → row updated, stock −${q2 - q1} more`)

    // unchanged → no write at all, stock untouched
    res = await setDiversCartonContenu(cartonId, item(q2))
    stock = await readStock()
    if (res.created + res.updated + res.removed !== 0) fail(`no-op: expected no write, got ${JSON.stringify(res)}`)
    else if (stock !== r2(stock0 - q2)) fail(`no-op: stock moved to ${stock}`)
    else ok('same quantity again → nothing written (this is what protects duplicate rows)')

    // an unnamed combo is left alone
    const other = await query<any>(`SELECT IDref_divers FROM ref_divers WHERE IDref_divers <> ${target.ref}`)
    if (other.length > 0) {
      res = await setDiversCartonContenu(cartonId, [
        { IDref_divers: Number(other[0].IDref_divers), IDVariation1: 0, IDVariation2: 0, quantite: 0 },
      ])
      if ((await readQty(cartonId)) !== q2) fail('unnamed combo: the existing article was disturbed')
      else ok('a payload naming other combos leaves this one untouched')
    }

    // beyond the stock → refused whole, nothing written
    let refusedStock = false
    try {
      await setDiversCartonContenu(cartonId, item(r2(stock0 + 1)))
    } catch (e) { refusedStock = e instanceof StockDiversInsuffisant }
    stock = await readStock()
    if (!refusedStock) fail('a carton taking more than the stock on hand was accepted')
    else if (stock !== r2(stock0 - q2) || (await readQty(cartonId)) !== q2) fail('a refused carton still wrote something')
    else ok(`asking for ${r2(stock0 + 1)} with ${stock0} on hand → refused, nothing written`)

    // drop to 0 → row deleted, stock fully restored
    res = await setDiversCartonContenu(cartonId, item(0))
    stock = await readStock()
    if (res.removed !== 1) fail(`remove: expected removed=1, got ${JSON.stringify(res)}`)
    else if (stock !== stock0) fail(`remove: stock ${stock}, expected the original ${stock0}`)
    else if ((await readQty(cartonId)) !== 0) fail('remove: carton is not empty')
    else ok('drop to 0 → row deleted, stock back to its starting value')

    // duplicate combo in one payload is refused
    let refused = false
    try {
      await setDiversCartonContenu(cartonId, [...item(1), ...item(2)])
    } catch { refused = true }
    if (refused) ok('a payload naming the same combo twice is refused')
    else fail('duplicate combo in one payload was accepted')
  } finally {
    // Always clean up: restore stock for anything left, then drop the carton.
    const leftovers = await query<any>(
      `SELECT IDref_divers_expedie FROM ref_divers_expedie WHERE IDligne_expedition_divers = ${cartonId}`,
    )
    if (leftovers.length > 0) await setDiversCartonContenu(cartonId, item(0))
    await query(`DELETE FROM ref_divers_expedie WHERE IDligne_expedition_divers = ${cartonId}`)
    await query(`DELETE FROM ligne_expedition_divers WHERE IDligne_expedition_divers = ${cartonId}`)
    const stockEnd = await readStock()
    if (stockEnd !== stock0) fail(`cleanup: stock left at ${stockEnd}, started at ${stock0}`)
    else ok(`scratch carton ${cartonId} removed, stock back to ${stock0}`)
  }
}

async function main(): Promise<void> {
  console.log('Guard — expédition groupée, contenu d\'un carton')
  console.log(`DB: ${(process.env.HFSQL_CONNECTION_STRING ?? '(default localhost)').replace(/PWD=[^;]*/i, 'PWD=***')}`)
  await checkDuplicates()
  await checkOffOrderItems()
  await checkStockCoverage()
  if (ROUNDTRIP) await roundtrip()
  else console.log('\n4. Round-trip skipped (pass --roundtrip to exercise the writer)')

  console.log(problems === 0 ? '\nOK' : `\n${problems} problem(s)`)
  await closeConnection()
  process.exit(problems === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await closeConnection().catch(() => {}); process.exit(1) })
