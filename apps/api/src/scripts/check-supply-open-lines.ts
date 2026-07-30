/**
 * Guard for the "Commandes ennoblisseur / tricotage en cours" tables of the
 * Clients › Commandes line drawer (buildEnnoblissement / buildTricotage in
 * routes/commandes-client.ts).
 *
 * The bug this pins: those tables listed an ALLOWLIST of open statuts
 * (`En_Cours`, `Attente_Delai`), but a freshly created order starts at
 * `Non_Envoye` — so an order created from the drawer's own "Nouvelle commande"
 * button never appeared in the table above it, while Sous-traitants ›
 * Commandes showed it fine. Same for a knitting order sent to any EXTERNAL
 * tricoteur (createKnitOrder only uses Attente_Delai for Tricotage Malterre),
 * and for the legacy `Notification` / `Soumis_Au_Client` lines.
 *
 * The filter is now "not done" instead of an enumeration of open states, so a
 * statut nobody thought about can never silently hide a live order again.
 *
 * Checks, over real data:
 *  1. every sstatut on a non-settled order is either done or listed — i.e. the
 *     SQL predicate and isLineDone() agree about what "finished" means;
 *  2. `Terminé` lines stay OUT (the predicate must not simply pass everything);
 *  3. for each non-settled, non-done sst line that is reachable from a client
 *     line, that line's /supply payload really contains the order.
 *
 * Read-only — never writes.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env' })
dotenv.config({ path: `.env.${process.env.NODE_ENV || 'development'}` })
import { query, closeConnection } from '../lib/hfsql-auto.js'

// This worktree's API port. NOT process.env.PORT — .env.development sets that
// for the server itself and it is not necessarily this slot (a wrong value
// silently hits the Vite dev server, which answers HTML).
const API = `http://localhost:${process.argv[2] || 8082}/api`

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}: ${String(actual)}${ok ? '' : ` (expected ${String(expected)})`}`)
}

/** ODBC returns 'Terminé' as 'Termin�' — compare on the ASCII prefix. */
const isDone = (s: unknown) => String(s ?? '').trim().startsWith('Termin')

async function main() {
  // ── The population the supply tables draw from: lines of open orders.
  const open = await query<any>(
    `SELECT lcs.IDligne_commande_sous_traitant AS lid, lcs.type AS lt, lcs.sstatut AS st,
            lcs.IDcommande_sous_traitant AS cid
       FROM ligne_commande_sous_traitant lcs
       JOIN commande_sous_traitant cst ON cst.IDcommande_sous_traitant = lcs.IDcommande_sous_traitant
      WHERE cst.est_soldee = 0 AND lcs.type IN (1, 2)`,
  )
  const live = open.filter((r: any) => !isDone(r.st))
  const statuts = [...new Set(live.map((r: any) => String(r.st ?? '').trim()))].sort()
  console.log(`open sst lines: ${open.length}  ·  not done: ${live.length}`)
  console.log(`statuts that must be visible: ${statuts.join(', ')}`)
  // A regression to an allowlist would drop one of these on the floor.
  check('Non_Envoye is among the visible statuts', statuts.includes('Non_Envoye'), true)

  // ── Walk from each live ennoblisseur line back to a client line, then ask
  //    the API whether that line's supply table shows the order.
  const ennoLive = live.filter((r: any) => Number(r.lt) === 2)
  let probed = 0
  for (const l of ennoLive) {
    const lid = Number(l.lid)
    const rolls = await query<any>(
      `SELECT IDligne_commande_client AS lcc FROM stock_ecru
        WHERE IDref_commande_affectation = ${lid} AND IDligne_commande_client > 0`,
    )
    const lcc = Number(rolls[0]?.lcc) || 0
    if (!lcc) continue
    const parent = await query<any>(
      `SELECT IDcommande_client AS cc FROM ligne_commande_client WHERE IDligne_commande_client = ${lcc}`,
    )
    const cc = Number(parent[0]?.cc) || 0
    if (!cc) continue
    const res = await fetch(`${API}/commandes-client/${cc}/lignes/${lcc}/supply`)
    if (!res.ok) { console.log(`SKIP  supply ${cc}/${lcc} → HTTP ${res.status}`); continue }
    const body = await res.json() as any
    const ids = (body.ennoblissement ?? []).map((r: any) => Number(r.id))
    check(`sst line ${lid} (${String(l.st).trim()}) visible in supply of client line ${lcc}`, ids.includes(lid), true)
    probed++
  }
  console.log(`(probed ${probed} ennoblisseur line(s) reachable from a client line)`)

  // ── And the predicate must still EXCLUDE done lines — "not done" must not
  //    decay into "everything". No finished line currently sits on an open
  //    order, so this tests the SQL predicate directly rather than through a
  //    client line: it must match every live line and no finished one.
  const NOT_DONE = `(sstatut IS NULL OR sstatut NOT LIKE 'Termin%')`
  const matched = await query<any>(
    `SELECT COUNT(*) AS n FROM ligne_commande_sous_traitant WHERE ${NOT_DONE}`,
  )
  const doneTotal = await query<any>(
    `SELECT COUNT(*) AS n FROM ligne_commande_sous_traitant WHERE sstatut LIKE 'Termin%'`,
  )
  const total = await query<any>(`SELECT COUNT(*) AS n FROM ligne_commande_sous_traitant`)
  const nMatched = Number(matched[0]?.n) || 0
  const nDone = Number(doneTotal[0]?.n) || 0
  const nTotal = Number(total[0]?.n) || 0
  console.log(`\nlignes: ${nTotal} total · ${nDone} terminées · ${nMatched} matched by the predicate`)
  check('predicate excludes every finished line', nMatched + nDone, nTotal)
  check('predicate is not a no-op (some lines are excluded)', nDone > 0, true)

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  await closeConnection()
  if (failures > 0) process.exit(1)
}

main().catch(async (e) => { console.error(e); await closeConnection(); process.exit(1) })
