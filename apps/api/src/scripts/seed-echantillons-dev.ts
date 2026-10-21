// Seed the dev copy (mps_dev) so Tombé Métier › Échantillons shows every
// state of the relance follow-up and the measures, dated from TODAY so it
// stays meaningful whenever it is run:
//   E055 red   — relance 12 days late, two relances already journaled
//   E050 red   — relance due today
//   E054 amber — relance in 2 days
//   E053 amber — relance in 5 days
//   E049 amber — relance in 7 days (the amber edge)
//   the other open samples keep their migration date (today + 30 at the time).
// Measures: tombé métier from what Nico wrote in the comments (E054 165 cm /
// 414 g, E053 162 cm, E050 260 g), « après lavage » simulated (laize −5 %,
// poids +6 %).
//
// Re-runnable: journal rows are written by « Seed dev » and replaced on each
// run. `--reset` puts the seeded samples back to today + 30, clears their
// measures and the seeded journal rows.
//
// Refuses any database but mps_dev (lib/dev-login.ts nomBase).
// Usage: tsx --env-file=.env.development src/scripts/seed-echantillons-dev.ts [--reset]
import type { Sql } from 'postgres'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'
import { nomBase } from '../lib/dev-login.js'
import { DELAI_RELANCE_JOURS, ajouterJours, aujourdhuiParis } from '../lib/echantillons.js'

const AUTEUR = 'Seed dev'

const DATES: Record<number, number> = { 55: -12, 50: 0, 54: 2, 53: 5, 49: 7 }

const MESURES: Record<number, { tbm: [number, number] }> = {
  54: { tbm: [165, 414] },
  53: { tbm: [162, 0] },
  50: { tbm: [0, 260] },
}

const lave = (v: number, f: number) => (v > 0 ? Math.round(v * f * 10) / 10 : 0)

async function main() {
  const base = nomBase(process.env.PG_CONNECTION_STRING)
  if (base !== 'mps_dev') throw new Error(`refusé : base « ${base} », seulement mps_dev`)
  const reset = process.argv.includes('--reset')
  const today = aujourdhuiParis()
  const ids = Object.keys(DATES).map(Number)

  await mpsPg().begin(async (t) => {
    const tx = t as unknown as Sql
    // Only open samples: a seeded date on a kept / archived one would never show.
    const ouverts = await tx<{ idref_echantillon: number }[]>`
      SELECT idref_echantillon FROM ref_echantillon
       WHERE idref_echantillon IN ${tx(ids)} AND COALESCE(archive, 0) = 0 AND COALESCE(idref_ecru, 0) = 0`
    const open = new Set(ouverts.map((r) => r.idref_echantillon))
    for (const id of ids) if (!open.has(id)) console.warn(`E0${id} n'est pas en cours — ignoré`)

    await tx`DELETE FROM echantillon_relance WHERE auteur = ${AUTEUR}`
    const [u] = await tx<{ idutilisateur: number }[]>`SELECT idutilisateur FROM utilisateur WHERE identifiant = 'vincent' LIMIT 1`
    const idUser = u?.idutilisateur ?? 0

    for (const id of open) {
      const date = reset ? ajouterJours(today, DELAI_RELANCE_JOURS) : ajouterJours(today, DATES[id])
      await tx`UPDATE ref_echantillon SET date_relance = ${date} WHERE idref_echantillon = ${id}`
      const m = MESURES[id]
      if (m) {
        const [laize, poids] = reset ? [0, 0] : m.tbm
        await tx`
          UPDATE ref_echantillon SET
            laize_tbm = ${laize}, poids_m2_tbm = ${poids},
            laize_lave = ${lave(laize, 0.95)}, poids_m2_lave = ${lave(poids, 1.06)}
          WHERE idref_echantillon = ${id}`
      }
    }

    if (!reset && open.has(55)) {
      // E055: two relances done, the last one set the date that is now 12 days past.
      const relances: [number, string, number][] = [
        [-72, 'Échantillon envoyé à Kenny, attend son avis sur la main.', -42],
        [-42, 'Kenny relancé par mail : toucher OK, veut un essai plus lourd. Relancer pour l\'essai.', -12],
      ]
      for (const [jour, note, prochaine] of relances) {
        await tx`
          INSERT INTO echantillon_relance (idref_echantillon, le, idutilisateur, auteur, note, prochaine_relance)
          VALUES (55, ${`${ajouterJours(today, jour)}T09:30:00+02:00`}, ${idUser}, ${AUTEUR}, ${note}, ${ajouterJours(today, prochaine)})`
      }
    }
  })

  const rows = await mpsPg()<{ idref_echantillon: number; date_relance: string | null; laize_tbm: number; poids_m2_tbm: number }[]>`
    SELECT idref_echantillon, to_char(date_relance, 'YYYY-MM-DD') AS date_relance, laize_tbm, poids_m2_tbm
      FROM ref_echantillon WHERE idref_echantillon IN ${mpsPg()(ids)} ORDER BY idref_echantillon DESC`
  console.log(reset ? 'Remis à zéro :' : `Seed du ${today} :`)
  for (const r of rows) console.log(`  E0${r.idref_echantillon}  relance ${r.date_relance ?? '—'}  TBM ${r.laize_tbm || '—'} cm / ${r.poids_m2_tbm || '—'} g`)
  await closeMpsPg()
}

main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
