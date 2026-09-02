/**
 * Grandfathering step for the TRM `edit_expeditions` permission.
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/seed-edit-expeditions-trm.ts          # dry run
 *   pnpm --filter @mps/api exec tsx src/scripts/seed-edit-expeditions-trm.ts --write  # persist
 *
 * Clients › Expéditions had **no write gate at all** until 2026-09-02 (LIVA
 * #1109): whoever could open the screen could create, edit or delete an avis
 * and move pieces on and off it. `edit_expeditions` closes that and also gates
 * the new « Expédier » of the Affectation tab — and like every TRM key it is
 * **closed by default**, so the day it ships nobody but the admins could ship a
 * roll. This hands the key to everyone who already had the ability, which keeps
 * them exactly where they were.
 *
 * MUST RUN ON THE SERVER — apps/api/data/permissions-trm.json is gitignored and
 * lives next to the running API, so a local run seeds the local file only.
 *
 * ⚠️ **Station accounts are excluded** (`STATIONS` below), same rule as
 * `seed-edit-of-trm.ts`: the visitage poste weighs rolls, it does not ship
 * them. Grant one by hand from Paramètres › Utilisateurs if that ever changes.
 *
 * Idempotent: re-running adds nothing.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { getTrmUserPermissions, setTrmUserPermissions } from '../lib/permissions-trm.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FILE_PATH = path.resolve(__dirname, '../../data/permissions-trm.json')

const KEY = 'edit_expeditions'

/** Legacy shared-PC accounts — a person never logs in as one of these.
 *  Matched on `prenom` alone: they carry no surname. */
const STATIONS = new Set(['visitage', 'regleur', 'eloise'])

async function main() {
  const write = process.argv.includes('--write')

  const users = await query<{ IDutilisateur: number; prenom: string | null; nom: string | null }>(
    'SELECT IDutilisateur, prenom, nom FROM utilisateur ORDER BY IDutilisateur',
  )
  console.log(`${users.length} utilisateur(s) — droit « ${KEY} »`)
  console.log(write ? 'mode: ÉCRITURE\n' : 'mode: simulation (--write pour appliquer)\n')

  const grant: Array<{ id: number; label: string }> = []
  for (const u of users) {
    const id = Number(u.IDutilisateur)
    if (!Number.isInteger(id) || id <= 0) continue
    const label = [u.prenom ?? '', u.nom ?? ''].join(' ').trim() || `#${id}`
    const isStation = STATIONS.has((u.prenom ?? '').trim().toLowerCase()) && !(u.nom ?? '').trim()

    if (isStation) {
      console.log(`  · ${label} (#${id}) — poste partagé, laissé en lecture seule`)
      continue
    }
    const current = await getTrmUserPermissions(id)
    if (current.includes(KEY)) {
      console.log(`  = ${label} (#${id}) — l'a déjà`)
      continue
    }
    console.log(`  + ${label} (#${id})`)
    grant.push({ id, label })
  }

  console.log(`\n${grant.length} utilisateur(s) à modifier`)
  if (!write || grant.length === 0) {
    if (!write && grant.length > 0) console.log('Rien écrit — relancer avec --write.')
    return
  }

  // Backup before the first write. The lib writes atomically per user, but this
  // script touches many in a row.
  try {
    const raw = await fs.readFile(FILE_PATH, 'utf8')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${FILE_PATH}.bak-${stamp}`
    await fs.writeFile(backup, raw, 'utf8')
    console.log(`Sauvegarde: ${backup}`)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') console.log('Pas de permissions-trm.json existant — création.')
    else throw err
  }

  for (const g of grant) {
    const current = await getTrmUserPermissions(g.id)
    await setTrmUserPermissions(g.id, [...current, KEY])
    console.log(`  ✓ ${g.label} (#${g.id})`)
  }
  console.log('\nTerminé.')
}

await main()
await closeConnection()
