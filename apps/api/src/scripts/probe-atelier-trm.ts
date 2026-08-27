// Read-only probe for the Atelier PWA (routes/atelier.ts).
//
// Two jobs, both about things that are easy to get silently wrong:
//
//  1. Print the RUNTIME column order of the three tables the commit path
//     touches. The `.xdd` analysis listing disagrees with the runtime
//     `SELECT *` order on some tables (it already bit controle_titrage and
//     retour_client), so the only trustworthy source is the driver itself. If
//     one of the positional INSERTs' tables drifts, routes/atelier.ts writes
//     into the wrong columns SILENTLY.
//
//     Measured 2026-08-27 — the two positional ones, both as expected:
//       evenement_piece  IDevenement_piece, evenement, IDpiece_production,
//                        DATE, IDbonnetier, observation, IDstock_ecru, appareil
//       defaut_qualite   IDdefaut_qualite, reference, description, DATE,
//                        Type_Spotteur, IDSpotteur, Type_Reference,
//                        type_defaut, traité, taille_cm, récuperé, nombre
//
//     ⚠️ And one that is NOT as expected — `piece_production`. Runtime order:
//       IDpiece_production, IDordre_fabrication, bonnetier_debut,
//       bonnetier_controle, bonnetier_fin, date_debut, date_controle,
//       date_fin, observations, poids, visiteur, date_visitage,
//       bonnetier_interruption, date_interruption, numero
//     The .xdd claims a completely different order (numero third, the dates
//     grouped, poids last). A positional INSERT built from the .xdd would have
//     written `numero` into `bonnetier_debut` and the date into `date_controle`
//     — silently, on real production rows. This is exactly why
//     routes/atelier.ts inserts piece_production with a NAMED column list: the
//     table carries no reserved and no accented column, so nothing forces the
//     positional form. Keep it that way.
//
//  2. Show what the atelier has actually written lately, so a bad shape is
//     visible as data rather than as a 500.
//
// Re-runnable against prod after an /etm_deploy — it writes nothing.
//
//   node --env-file=.env.development --import tsx src/scripts/probe-atelier-trm.ts
//
// `--purge-test` is the ONE exception: it deletes rows whose appareil is
// exactly 'Terminal test', i.e. what this project's manual curl checks leave
// behind. It refuses to run against anything but a localhost connection.
//
// ⚠️ It cannot clean up a test DÉFAUT: `defaut_qualite` has no `appareil`
// column, so a defect written by a check is indistinguishable from a real one.
// Delete those by id, by hand, and read the id off section 3 below.
import { query } from '../lib/hfsql-auto.js'
import { parseDtMs } from '../lib/production-trm.js'

const PURGE = process.argv.includes('--purge-test')
const TEST_APPAREIL = 'Terminal test'

function isLocal(): boolean {
  const cs = process.env.HFSQL_CONNECTION_STRING ?? ''
  return /Server Name\s*=\s*(localhost|127\.0\.0\.1)/i.test(cs)
}

async function colonnes(table: string, where: string): Promise<void> {
  const rows = await query<Record<string, unknown>>(`SELECT TOP 1 * FROM ${table} ${where}`)
  if (rows.length === 0) {
    console.log(`  ${table}: aucune ligne — ordre non vérifiable`)
    return
  }
  console.log(`  ${table}:`)
  console.log(`    ${Object.keys(rows[0]).join(', ')}`)
}

async function main(): Promise<void> {
  console.log('── 1. Ordre physique des colonnes (runtime SELECT *) ──')
  console.log('   Les INSERT positionnels de routes/atelier.ts en dépendent.')
  await colonnes('piece_production', 'ORDER BY IDpiece_production DESC')
  await colonnes('evenement_piece', 'ORDER BY IDevenement_piece DESC')
  await colonnes('defaut_qualite', 'ORDER BY IDdefaut_qualite DESC')

  console.log('\n── 2. Derniers évènements écrits ──')
  const evts = await query<Record<string, unknown>>(
    `SELECT TOP 10 IDevenement_piece, evenement, IDpiece_production, DATE AS d, IDbonnetier, appareil
     FROM evenement_piece ORDER BY IDevenement_piece DESC`,
  )
  for (const e of evts) {
    const ms = parseDtMs(e.d)
    console.log(
      `  #${e.IDevenement_piece}  ${String(e.evenement ?? '').padEnd(22)} ` +
        `pièce ${e.IDpiece_production}  bonnetier ${e.IDbonnetier}  ` +
        `${ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—'}  ` +
        `[${String(e.appareil ?? '')}]`,
    )
  }

  console.log('\n── 3. Derniers défauts déclarés au métier (Type_Spotteur = 1) ──')
  const dfs = await query<Record<string, unknown>>(
    `SELECT TOP 10 IDdefaut_qualite, reference, description, type_defaut, taille_cm, nombre,
            Type_Reference, Type_Spotteur, IDSpotteur
     FROM defaut_qualite WHERE Type_Spotteur = 1 ORDER BY IDdefaut_qualite DESC`,
  )
  for (const d of dfs) {
    console.log(
      `  #${d.IDdefaut_qualite}  ref=${d.reference} (TypeRef ${d.Type_Reference})  ` +
        `type="${d.type_defaut}"  taille_cm=${d.taille_cm}  nombre=${d.nombre}  ` +
        `desc="${d.description}"  spotteur ${d.IDSpotteur}`,
    )
  }
  // The trailing-space spelling the legacy window still writes. This app
  // writes the clean one; the count should stop growing, never shrink.
  const sales = await query<{ t: number | null }>(
    `SELECT COUNT(*) AS t FROM defaut_qualite WHERE type_defaut = 'Autre Barrure '`,
  )
  console.log(`\n  « Autre Barrure » avec espace final (héritage legacy) : ${Number(sales[0]?.t) || 0}`)

  if (PURGE) {
    console.log('\n── 4. Purge des lignes de test ──')
    if (!isLocal()) {
      console.log('  REFUSÉ : la connexion ne pointe pas sur localhost.')
      return
    }
    const cibles = await query<{ IDevenement_piece: number }>(
      `SELECT IDevenement_piece FROM evenement_piece WHERE appareil = '${TEST_APPAREIL}'`,
    )
    for (const c of cibles) {
      await query(`DELETE FROM evenement_piece WHERE IDevenement_piece = ${c.IDevenement_piece}`)
      console.log(`  supprimé evenement_piece #${c.IDevenement_piece}`)
    }
    if (cibles.length === 0) console.log('  rien à supprimer')
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
