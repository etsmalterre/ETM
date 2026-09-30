/**
 * Grandfathering step for TRM's screen-access feature.
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/seed-screen-access-trm.ts          # dry run
 *   pnpm --filter @mps/api exec tsx src/scripts/seed-screen-access-trm.ts --write  # persist
 *   … --menu screen_pointage [--menu …] --write   # ONLY that menu: how a NEW menu rolls out
 *
 * ⚠️ Without --menu it hands out EVERY menu a user lacks — and once the admin has
 * removed menus by hand, that means silently giving them back. 2026-09-22: run
 * bare on prod for the new « Pointage » menu, it re-granted 16 removed menus to
 * five accounts (the Visitage station got Clients, Atelier, Qualité, Rapports),
 * undone by hand within the hour. So the bare form is the FIRST-TIME
 * grandfathering only: it now refuses when the store already holds menu keys,
 * unless --all is passed on purpose.
 *
 * Menu access is a GRANT, default closed (see lib/screen-keys-trm.ts), so the
 * day this ships every non-admin would lose every TRM menu. This hands each
 * existing user the menu keys they don't already have, which keeps them exactly
 * where they were; the admin then removes the menus a given person doesn't need.
 *
 * Writes the `permission` table of the database PG_CONNECTION_STRING names —
 * run it on the API host for production (was data/permissions-trm.json until 2026-09-30).
 *
 * Idempotent: re-running adds nothing. After a new menu ships, re-run it WITH
 * `--menu screen_<menu>` to hand that one menu to everyone at once.
 *
 * Notes:
 *  - Screens are NOT seeded. Granting a menu already means all of its screens
 *    (they are removed one by one via `hide_*` keys), so there is nothing to
 *    hand out per screen.
 *  - Every `utilisateur` row is seeded, NOT TRM's staff allowlist (one row per
 *    person since the account merge of scripts/comptes-import.ts).
 *  - Existing TRM action permissions are untouched, and a user who already
 *    holds some menus keeps whatever hide keys they have.
 */
import '../load-env.js'
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { closeMpsPg } from '../lib/mps-pg.js'
import { getAllTrmPermissions, getTrmUserPermissions, setTrmUserPermissions } from '../lib/permissions-trm.js'
import { TRM_SCREEN_MENUS, trmMenuAccessKey } from '../lib/screen-keys-trm.js'


async function main() {
  const write = process.argv.includes('--write')
  const argv = process.argv.slice(2)
  const onlyMenus = argv.flatMap((a, i) => (a === '--menu' && argv[i + 1] ? [argv[i + 1]] : []))
  // `seed: false` menus (Paramètres) are granted person by person, never to all.
  const allMenuKeys = TRM_SCREEN_MENUS.filter((m) => m.seed !== false).map((m) => trmMenuAccessKey(m.href))
  for (const k of onlyMenus) {
    if (!allMenuKeys.includes(k)) {
      console.error(`--menu ${k} : clé inconnue. Menus TRM : ${allMenuKeys.join(', ')}`)
      process.exit(1)
    }
  }
  const menuKeys = onlyMenus.length ? onlyMenus : allMenuKeys
  if (onlyMenus.length === 0 && !argv.includes('--all')) {
    // Bare run = first-time grandfathering. Once the store carries menu keys the
    // admin has been trimming them, and a bare run would hand the trimmed ones back.
    const stored = Object.values(await getAllTrmPermissions()).flat()
    if (stored.some((k) => k.startsWith('screen_'))) {
      console.error('REFUS : le store porte déjà des menus. Un nouveau menu se déploie avec --menu screen_<menu> ;')
      console.error('        --all force la distribution de TOUS les menus (rend ceux que l’admin a retirés).')
      process.exit(1)
    }
  }

  const users = await query<{ IDutilisateur: number; prenom: string | null; nom: string | null }>(
    'SELECT IDutilisateur, prenom, nom FROM utilisateur ORDER BY IDutilisateur',
  )
  console.log(`${users.length} utilisateur(s), ${menuKeys.length} menu(s) TRM à accorder`)
  console.log(write ? 'mode: ÉCRITURE\n' : 'mode: simulation (--write pour appliquer)\n')

  const plan: Array<{ id: number; label: string; missing: string[]; had: number }> = []
  for (const u of users) {
    const id = Number(u.IDutilisateur)
    if (!Number.isInteger(id) || id <= 0) continue
    const current = await getTrmUserPermissions(id)
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
    const current = await getTrmUserPermissions(p.id)
    await setTrmUserPermissions(p.id, [...current, ...p.missing])
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
