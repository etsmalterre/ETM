/**
 * Read-only probe for the TRM Fils › Stock port (routes/stock-fil-trm.ts).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/probe-stock-fil-trm.ts
 *
 * Verifies, against the live/snapshot DB, the assumptions the new router
 * relies on:
 *   1. certif-blob count on AVAILABLE lots (sizes the Linux archive limitation:
 *      the positional reinsert can only re-emit empty blob slots).
 *   2. physical column order of stock_fil from SELECT * (the positional
 *      reinsert depends on it; expected order comes from MPS.xdd).
 *   3. freinte formula parity on recently archived lots:
 *      produit = Σ over OFs [Σ(stock_ecru.poids) × asso_fil_of.pourcentage/100]
 *      freinte = stock_initial − produit  (validated vs observation_freinte
 *      annotations, e.g. the "90kg de freinte négative" lot).
 *   4. lot allocation: MAX numeric lot computed in JS (CAST support unverified
 *      on the bridge — the router will do the JS fold too).
 *   5. IDclient coverage → client table (names for the Client column).
 */
import { query, closeConnection } from '../lib/hfsql-auto.js'

function pickVal(row: Record<string, unknown>, re: RegExp): unknown {
  const k = Object.keys(row).find((key) => re.test(key))
  return k === undefined ? undefined : row[k]
}

const hasBlob = (v: unknown): boolean => {
  if (v == null || v === '' || v === '\x00') return false
  if (Buffer.isBuffer(v)) return v.length > 0 && !(v.length === 1 && v[0] === 0)
  if (v instanceof ArrayBuffer) return v.byteLength > 0
  return String(v).length > 0
}

const IS_WINDOWS = process.platform === 'win32'

// SELECT * FROM stock_fil returns 0 rows on the Windows ODBC driver (same quirk
// as `client`), and so does ANY select naming a memo-binary column — blob
// presence is probed via LENGTH() instead (works on both platforms). On Windows
// accented identifiers can be named directly; on Linux only SELECT * works and
// its runtime key order IS the positional-reinsert order.
const ALL_COLS_WINDOWS =
  'IDstock_fil, IDclient, IDref_fil, IDfournisseur, stock, stock_initial, lot, ' +
  'emplacement, date_entree, commentaire, IDcolori_fil, IDref_fil_commande, ' +
  'lot_frs, IDMagasin, terminé AS termine, niveau, dernier_pointage, ' +
  'dernier_mouvement, controlé AS controle, observation_freinte, ' +
  'LENGTH(certif_bio) AS len_bio, LENGTH(certif_recyclé) AS len_recycle'

async function main() {
  // ── 1 + 2 + 4: one full pass over stock_fil ──
  const rows = await query<Record<string, unknown>>(
    IS_WINDOWS
      ? `SELECT ${ALL_COLS_WINDOWS} FROM stock_fil`
      : `SELECT * FROM stock_fil`,
  )
  console.log(`stock_fil rows: ${rows.length}`)
  if (rows.length === 0) throw new Error('stock_fil full select returned 0 rows on this platform')

  console.log(`\n[2] row key order (Linux = positional-reinsert order; Windows = as named):`)
  console.log('    ' + Object.keys(rows[0]).join(', '))

  const blobLens = await query<{ IDstock_fil: number; lb: number; lr: number }>(
    IS_WINDOWS
      ? `SELECT IDstock_fil, LENGTH(certif_bio) AS lb, LENGTH(certif_recyclé) AS lr FROM stock_fil`
      : `SELECT IDstock_fil, LENGTH(certif_bio) AS lb FROM stock_fil`,
  )
  const blobById = new Map(blobLens.map((r) => [Number(r.IDstock_fil), (Number(r.lb) || 0) + (Number((r as any).lr) || 0)]))

  const termine = (r: Record<string, unknown>) => Number(pickVal(r, /^termin/i)) || 0
  const avail = rows.filter((r) => termine(r) === 0)
  const availWithBlob = avail.filter((r) => (blobById.get(Number(r.IDstock_fil)) ?? 0) > 1)
  const allWithBlob = rows.filter((r) => (blobById.get(Number(r.IDstock_fil)) ?? 0) > 1)
  console.log(`\n[1] available lots (terminé=0): ${avail.length}`)
  console.log(`    available lots WITH a certif blob: ${availWithBlob.length}`)
  for (const r of availWithBlob.slice(0, 20))
    console.log(`      lot ${r.lot} (id ${r.IDstock_fil}) blobLen=${blobById.get(Number(r.IDstock_fil))}`)
  console.log(`    all lots with a certif blob: ${allWithBlob.length}`)

  const lots = rows.map((r) => parseInt(String(r.lot ?? ''), 10)).filter((x) => Number.isFinite(x))
  const maxLot = lots.reduce((a, b) => Math.max(a, b), 0)
  console.log(`\n[4] numeric lots: ${lots.length}/${rows.length}; MAX = ${maxLot} → next = ${maxLot + 1}`)

  // ── 5: client coverage ──
  const clientIds = Array.from(new Set(rows.map((r) => Number(r.IDclient) || 0).filter((x) => x > 0)))
  const clients = clientIds.length
    ? await query<{ IDclient: number; nom: string | null; IDsociete: number }>(
        `SELECT IDclient, nom, IDsociete FROM client WHERE IDclient IN (${clientIds.join(',')})`,
      )
    : []
  const noClient = rows.filter((r) => (Number(r.IDclient) || 0) === 0).length
  console.log(`\n[5] distinct IDclient on stock_fil: ${clientIds.length}; rows with IDclient=0: ${noClient}`)
  for (const c of clients) console.log(`      ${c.IDclient}  soc=${c.IDsociete}  ${String(c.nom ?? '').trim()}`)

  // ── 3: freinte parity on archived lots that carry an observation ──
  const annotated = rows
    .filter((r) => termine(r) === 1 && String(r.observation_freinte ?? '').trim().length > 0)
    .sort((a, b) => Number(b.IDstock_fil) - Number(a.IDstock_fil))
    .slice(0, 5)
  console.log(`\n[3] freinte parity on ${annotated.length} annotated archived lots:`)
  for (const r of annotated) {
    const id = Number(r.IDstock_fil)
    const assos = await query<{ IDordre_fabrication: number; pourcentage: number }>(
      `SELECT IDordre_fabrication, pourcentage FROM asso_fil_of WHERE IDstock_fil = ${id}`,
    )
    let produit = 0
    let poidsTotal = 0
    let poids2e = 0
    for (const a of assos) {
      const pieces = await query<{ poids: number; second_choix: number }>(
        `SELECT poids, second_choix FROM stock_ecru WHERE IDordre_fabrication = ${Number(a.IDordre_fabrication)}`,
      )
      const sum = pieces.reduce((s, p) => s + (Number(p.poids) || 0), 0)
      produit += (sum * (Number(a.pourcentage) || 0)) / 100
      poidsTotal += sum
      poids2e += pieces.filter((p) => Number(p.second_choix) === 1).reduce((s, p) => s + (Number(p.poids) || 0), 0)
    }
    const init = Number(r.stock_initial) || 0
    const freinte = init - produit
    const pct = init > 0 ? (freinte / init) * 100 : 0
    const pct2e = poidsTotal > 0 ? (poids2e / poidsTotal) * 100 : 0
    console.log(
      `      lot ${r.lot} (id ${id}) init=${init.toFixed(1)}kg produit=${produit.toFixed(1)}kg ` +
        `freinte=${freinte.toFixed(1)}kg (${pct.toFixed(2)}%) 2e_choix=${pct2e.toFixed(2)}% ` +
        `obs="${String(r.observation_freinte).trim().slice(0, 60)}"`,
    )
  }

  await closeConnection()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
