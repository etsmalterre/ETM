/**
 * Grandfathering step for the screen-access feature.
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/seed-screen-access.ts          # dry run
 *   pnpm --filter @mps/api exec tsx src/scripts/seed-screen-access.ts --write  # persist
 *
 * Menu access is a GRANT, default closed (see lib/screen-keys.ts), so the day
 * this ships every non-admin would lose every menu. This hands each existing
 * user the menu keys they don't already have, which keeps them exactly where
 * they were; the admin then removes the menus a given person doesn't need.
 *
 * Writes the `permission` table of the database PG_CONNECTION_STRING names —
 * run it on the API host for production (was data/permissions.json until 2026-09-30).
 *
 * Idempotent: re-running adds nothing. Safe to re-run after a new menu ships,
 * which is the intended way to hand that menu to everyone at once.
 *
 * Notes:
 *  - Screens are NOT seeded. Granting a menu already means all of its screens
 *    (they are removed one by one via `hide_*` keys), so there is nothing to
 *    hand out per screen.
 *  - Every `utilisateur` row is seeded (one per person since the account merge
 *    of scripts/comptes-import.ts).
 *  - Existing action permissions are untouched, and a user who already holds
 *    some menus keeps whatever hide keys they have.
 */
import '../load-env.js'
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { closeMpsPg } from '../lib/mps-pg.js'
import { getUserPermissions, setUserPermissions } from '../lib/permissions.js'
import { SCREEN_MENUS, menuAccessKey } from '../lib/screen-keys.js'


async function main() {
  const write = process.argv.includes('--write')
  // `seed: false` menus (Paramètres) are granted person by person, never to all.
  const menuKeys = SCREEN_MENUS.filter((m) => m.seed !== false).map((m) => menuAccessKey(m.href))

  const users = await query<{ IDutilisateur: number; prenom: string | null; nom: string | null }>(
    'SELECT IDutilisateur, prenom, nom FROM utilisateur ORDER BY IDutilisateur',
  )
  console.log(`${users.length} utilisateur(s), ${menuKeys.length} menu(s) à accorder`)
  console.log(write ? 'mode: ÉCRITURE\n' : 'mode: simulation (--write pour appliquer)\n')

  const plan: Array<{ id: number; label: string; missing: string[]; had: number }> = []
  for (const u of users) {
    const id = Number(u.IDutilisateur)
    if (!Number.isInteger(id) || id <= 0) continue
    const current = await getUserPermissions(id)
    const set = new Set(current)
    const missing = menuKeys.filter((k) => !set.has(k))
    const label = [u.prenom ?? '', u.nom ?? ''].join(' ').trim() || `#${id}`
    plan.push({ id, label, missing, had: current.length })
  }

  for (const p of plan) {
    if (p.missing.length === 0) {
      console.log(`  = ${p.label} (#${p.id}) — déjà à jour (${p.had} droit(s))`)
    } else {
      console.log(`  + ${p.label} (#${p.id}) — ${p.missing.length} menu(s): ${p.missing.join(', ')}`)
    }
  }

  const toChange = plan.filter((p) => p.missing.length > 0)
  console.log(`\n${toChange.length} utilisateur(s) à modifier, ${plan.length - toChange.length} inchangé(s)`)

  if (!write || toChange.length === 0) {
    if (!write && toChange.length > 0) console.log('Rien écrit — relancer avec --write.')
    return
  }

  for (const p of toChange) {
    const current = await getUserPermissions(p.id)
    await setUserPermissions(p.id, [...current, ...p.missing])
    console.log(`  ✓ ${p.label} (#${p.id})`)
  }
  console.log('\nTerminé.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => Promise.all([closeConnection(), closeMpsPg()]))
