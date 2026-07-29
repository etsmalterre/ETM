/**
 * Guard for the Notifications widget (lib/abonnements.ts).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/check-abonnements.ts
 *   pnpm --filter @mps/api exec tsx src/scripts/check-abonnements.ts --write
 *
 * Read-only by default: prints the subscription catalog, runs EVERY detector
 * (including ones nobody is subscribed to) and shows a sample of each one's
 * cards, so a detector that silently returns nothing — or floods — is visible.
 *
 * `--write` additionally round-trips the subscriptions of a scratch user
 * through `abonnement_user` and restores the previous value. The PK there is
 * computed as max+1 rather than auto-assigned, so this exercises the path where
 * a bad PK would overwrite a real row.
 */
import {
  getAbonnementCatalog,
  getUserAbonnementIds,
  setUserAbonnementIds,
  detectForUser,
  invalidateDetectionCache,
} from '../lib/abonnements.js'
import { query, closeConnection } from '../lib/hfsql-auto.js'

const WRITE = process.argv.includes('--write')

/** Volumes above this are legitimate (unaffected écru rolls run to four
 *  figures) but worth flagging — the widget caps its rendering, and a detector
 *  that suddenly jumps here usually means a lost WHERE clause. */
const LOUD_THRESHOLD = 2000

async function main() {
  const catalog = await getAbonnementCatalog()
  console.log(`Catalog (IDsociete = 1): ${catalog.length} abonnement(s)`)
  for (const a of catalog) {
    console.log(`  ${a.id}. ${a.nom}${a.implemented ? '' : '  [NO DETECTOR]'}`)
    console.log(`      ${a.description}`)
  }

  const missing = catalog.filter((a) => !a.implemented)
  if (missing.length > 0) {
    console.log(`\n⚠ ${missing.length} catalog row(s) have no detector: ${missing.map((a) => a.nom).join(', ')}`)
  }

  // Run every detector, subscribed or not.
  console.log('\nDetector output (all subscriptions, not just a user\'s):')
  const allIds = catalog.map((a) => a.id)
  invalidateDetectionCache()
  const t0 = Date.now()
  const rows = await detectForUser(allIds, catalog)
  const elapsed = Date.now() - t0

  const byAbo = new Map<number, typeof rows>()
  for (const r of rows) {
    const arr = byAbo.get(r.abonnementId) ?? []
    arr.push(r)
    byAbo.set(r.abonnementId, arr)
  }
  let problems = 0
  for (const a of catalog) {
    if (!a.implemented) continue
    const list = byAbo.get(a.id) ?? []
    const loud = list.length > LOUD_THRESHOLD ? '  ⚠ LOUD' : ''
    console.log(`\n  [${a.id}] ${a.nom}: ${list.length} card(s)${loud}`)
    if (list.length > LOUD_THRESHOLD) problems++
    for (const r of list.slice(0, 3)) {
      console.log(`      key=${r.key}  "${r.titre}" :: "${r.description}"`)
    }
    // A card whose key or title is empty means the source row lost its id or
    // its label — the mute store would then collide across records.
    for (const r of list) {
      if (!/^\d+:.+$/.test(r.key) || r.titre.trim() === '') {
        console.log(`      ✗ malformed card: ${JSON.stringify(r)}`)
        problems++
        break
      }
    }
  }
  console.log(`\nTotal: ${rows.length} card(s) in ${elapsed} ms`)

  const dupes = rows.length - new Set(rows.map((r) => r.key)).size
  if (dupes > 0) {
    console.log(`✗ ${dupes} duplicate key(s) — the mute store cannot distinguish those cards`)
    problems++
  } else {
    console.log('✓ every key is unique')
  }

  if (WRITE) {
    console.log('\n── subscription round-trip ──')
    const users = await query<{ IDutilisateur: number }>(
      `SELECT IDutilisateur FROM utilisateur ORDER BY IDutilisateur LIMIT 1`,
    )
    const uid = Number(users[0]?.IDutilisateur ?? 0)
    const catalogIds = new Set(catalog.map((a) => a.id))
    if (uid <= 0) {
      console.log('✗ no utilisateur row to test with')
      problems++
    } else {
      const before = await getUserAbonnementIds(uid)
      // The regression this exists for: `abonnement_notif` is partitioned by
      // IDsociete, so a user can be subscribed to a row this app's catalog
      // never shows (user 1 → "FNC", société 2). The dialog cannot send it
      // back, so a naive rewrite silently unsubscribes them in the WinDev app.
      const foreign = before.filter((x) => !catalogIds.has(x))
      console.log(`  out-of-catalog subscriptions to preserve: [${foreign.join(', ')}]`)
      if (foreign.length === 0) {
        console.log('  ⓘ this user has none — the carry-over path is NOT covered by this run')
      }
      const totalBefore = (await query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM abonnement_user`,
      ))[0].n
      console.log(`  user ${uid} before: [${before.join(', ')}] (${totalBefore} rows total)`)

      const target = catalog.slice(0, 2).map((a) => a.id)
      await setUserAbonnementIds(uid, target)
      const after = await getUserAbonnementIds(uid)
      console.log(`  after write: [${after.join(', ')}]`)
      const expected = Array.from(new Set([...target, ...foreign])).sort((a, b) => a - b)
      if (after.join(',') !== expected.join(',')) {
        console.log(`✗ round-trip mismatch — expected [${expected.join(', ')}]`)
        problems++
      }
      const lost = foreign.filter((x) => !after.includes(x))
      if (lost.length > 0) {
        console.log(`✗ out-of-catalog subscription(s) dropped: [${lost.join(', ')}]`)
        problems++
      }

      await setUserAbonnementIds(uid, before)
      const restored = await getUserAbonnementIds(uid)
      const totalAfter = (await query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM abonnement_user`,
      ))[0].n
      console.log(`  restored: [${restored.join(', ')}] (${totalAfter} rows total)`)
      if (restored.join(',') !== before.join(',')) {
        console.log('✗ restore mismatch — user subscriptions were NOT put back')
        problems++
      }
      // Other users' rows must be untouched: only this user's rows change, so
      // the total must come back to where it started.
      if (totalAfter !== totalBefore) {
        console.log(`✗ abonnement_user row count drifted ${totalBefore} → ${totalAfter}`)
        problems++
      } else {
        console.log('✓ no collateral rows touched')
      }
    }
  }

  await closeConnection()
  console.log(problems === 0 ? '\n✓ all checks passed' : `\n✗ ${problems} problem(s)`)
  process.exit(problems === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
