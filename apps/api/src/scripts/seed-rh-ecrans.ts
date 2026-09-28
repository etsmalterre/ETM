/**
 * Grandfathering step for the RH menu joining the Écrans axis (2026-09-28).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/seed-rh-ecrans.ts          # dry run
 *   pnpm --filter @mps/api exec tsx src/scripts/seed-rh-ecrans.ts --write  # persist
 *   (server: cd ~/mps_api && NODE_ENV=production npx tsx src/scripts/seed-rh-ecrans.ts --write)
 *
 * Until now RH opened for a fixed list of two names (Vincent, Isabelle). The
 * list is gone: the menu grant `screen_rh` decides (lib/rh-acces.ts). This
 * hands that grant to EVERY `utilisateur` row of those two people — Isabelle
 * has home + bureau, Vincent #1 and #18 — so nobody loses RH the day it ships.
 * The menu is `seed: false`: seed-screen-access.ts never hands it to anyone.
 *
 * MUST RUN ON THE SERVER — apps/api/data/permissions.json lives next to the
 * running API. Then RESTART mps-api (module-load cache, etm_deploy § Step 0).
 *
 * Idempotent: re-running adds nothing.
 */
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })

import { query, closeConnection } from '../lib/hfsql-auto.js'
import { getUserPermissions, setUserPermissions } from '../lib/permissions.js'
import { menuAccessKey } from '../lib/screen-keys.js'

const KEY = menuAccessKey('/rh')
const PERSONNES = [['vincent', 'malterre'], ['isabelle', 'malterre']]

async function main() {
  const write = process.argv.includes('--write')
  const users = await query<{ IDutilisateur: number; prenom: string | null; nom: string | null }>(
    'SELECT IDutilisateur, prenom, nom FROM utilisateur ORDER BY IDutilisateur',
  )
  console.log(`droit « ${KEY} » — ${write ? 'ÉCRITURE' : 'simulation (--write pour appliquer)'}\n`)

  let changed = 0
  for (const u of users) {
    const p = (u.prenom ?? '').trim().toLowerCase()
    const n = (u.nom ?? '').trim().toLowerCase()
    if (!PERSONNES.some(([pp, nn]) => pp === p && nn === n)) continue
    const id = Number(u.IDutilisateur)
    const label = `${(u.prenom ?? '').trim()} ${(u.nom ?? '').trim()} (#${id})`
    const current = await getUserPermissions(id)
    if (current.includes(KEY)) {
      console.log(`  = ${label} — l'a déjà`)
      continue
    }
    console.log(`  + ${label}`)
    changed += 1
    if (write) await setUserPermissions(id, [...current, KEY])
  }

  console.log(`\n${changed} utilisateur(s) ${write ? 'modifié(s)' : 'à modifier'}`)
  if (write && changed > 0) console.log('⚠️  Redémarrer mps-api maintenant (sudo systemctl restart mps-api).')
  await closeConnection()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
