/**
 * Grandfathering step for the per-subscription sub-permissions of the
 * dashboard « Notifications » widget (`dashboard_notif_*`, children of
 * `dashboard_notifications`).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/seed-notif-permissions.ts          # dry run
 *   pnpm --filter @mps/api exec tsx src/scripts/seed-notif-permissions.ts --write  # persist
 *   (server: cd ~/mps_api && npx tsx src/scripts/seed-notif-permissions.ts --write)
 *
 * Until now any holder of `dashboard_notifications` was offered every legacy
 * subscription, and the Superviseur one went to holders of `evaluer_agents_ia`.
 * The day the sub-keys ship, a user without them would be offered nothing —
 * so this hands each user exactly what they were offered before:
 *   - every legacy sub-key to each holder of `dashboard_notifications`;
 *   - `dashboard_notif_superviseur` only to holders of BOTH
 *     `dashboard_notifications` and `evaluer_agents_ia`.
 *
 * MUST RUN ON THE SERVER — apps/api/data/permissions.json is gitignored and
 * lives next to the running API. Then RESTART mps-api: the API caches the file
 * at module load, and the next admin save would write the stale copy back
 * over the seed (etm_deploy § Step 0, 2026-08-27).
 *
 * Idempotent: re-running adds nothing.
 */
import { PERMISSION_KEYS } from '../lib/permission-keys.js'
import { getAllPermissions, setUserPermissions } from '../lib/permissions.js'

const PARENT = 'dashboard_notifications'
const SUPERVISEUR = 'dashboard_notif_superviseur'
const LEGACY = PERMISSION_KEYS
  .filter((k) => 'parent' in k && k.parent === PARENT && k.key !== SUPERVISEUR)
  .map((k) => k.key as string)

async function main() {
  const write = process.argv.includes('--write')
  const all = await getAllPermissions()
  console.log(write ? 'mode: ÉCRITURE\n' : 'mode: simulation (--write pour appliquer)\n')
  console.log(`sous-droits hérités : ${LEGACY.join(', ')}\n`)

  let changed = 0
  for (const [idText, keys] of Object.entries(all)) {
    const id = Number(idText)
    if (!keys.includes(PARENT)) continue
    const wanted = [...LEGACY, ...(keys.includes('evaluer_agents_ia') ? [SUPERVISEUR] : [])]
    const missing = wanted.filter((k) => !keys.includes(k))
    if (missing.length === 0) {
      console.log(`  = #${id} — déjà à jour`)
      continue
    }
    console.log(`  + #${id} — ${missing.join(', ')}`)
    changed += 1
    if (write) await setUserPermissions(id, [...keys, ...missing])
  }

  console.log(`\n${changed} utilisateur(s) ${write ? 'modifié(s)' : 'à modifier'}`)
  if (write && changed > 0) console.log('⚠️  Redémarrer mps-api maintenant (sudo systemctl restart mps-api).')
  else if (!write && changed > 0) console.log('Rien écrit — relancer avec --write.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
