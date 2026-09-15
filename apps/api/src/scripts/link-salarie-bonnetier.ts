/**
 * Link a pointage salarié to his MPS bonnetier: `pointage.lst_salarie.id_mps`.
 *
 * Two things hang off that id: the photo on the pointage tablet
 * (routes/pointage.ts → bonnetier.photo) and the presence journal the TRS read
 * (`mps.pointage`, written only when id_mps > 0 — by the tablet, and by the
 * old WinDev pointeuse as well).
 *
 *   node --env-file=.env.development --import tsx src/scripts/link-salarie-bonnetier.ts --salarie 46 --bonnetier 30          # dry run
 *   … --write
 *
 * Target = HFSQL_CONNECTION_STRING (the pointage database is derived from it,
 * lib/hfsql-pointage.ts). For production, set it in the shell before the
 * command — `--env-file` never overrides a variable already set.
 *
 * Refuses when: the salarié or the bonnetier does not exist; the two surnames
 * differ; the salarié is already linked to ANOTHER bonnetier; another salarié
 * is already linked to this bonnetier. Undo = the same UPDATE back to 0.
 *
 * First use (2026-09-15): MARIE BOURSIER, lst_salarie 46 → bonnetier 30 — the
 * one active salarié with id_mps = 0 found during the pointage investigation.
 */
import { closeConnection } from '../lib/hfsql-auto.js'
import { pointageConnectionString, pointageDb } from '../lib/hfsql-pointage.js'
import { selectBonnetiers } from '../lib/production-trm.js'
import { photoBonnetier } from '../lib/bonnetier-photo.js'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const entier = (name: string): number => {
  const i = args.indexOf(`--${name}`)
  const v = i >= 0 ? parseInt(args[i + 1] ?? '', 10) : NaN
  if (!Number.isInteger(v) || v <= 0) throw new Error(`--${name} <id> is required`)
  return v
}
const pli = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase()

async function main(): Promise<void> {
  const idSalarie = entier('salarie')
  const idBonnetier = entier('bonnetier')
  console.log(`${WRITE ? '── ÉCRITURE' : '── DRY RUN (--write pour écrire)'} — ${pointageConnectionString().replace(/PWD=[^;]*/i, 'PWD=***')}`)

  const raw = await pointageDb.query<Record<string, unknown>>(
    `SELECT id, nom, prenom, is_deleted, id_mps FROM lst_salarie WHERE id = ${idSalarie}`,
  )
  const [s] = await pointageDb.fixEncoding(raw, 'lst_salarie', 'id', ['nom', 'prenom'])
  if (!s) throw new Error(`lst_salarie ${idSalarie} n'existe pas`)
  const idMps = Number(s.id_mps) || 0
  console.log(`salarié  ${idSalarie} : ${String(s.prenom).trim()} ${String(s.nom).trim()}  (is_deleted ${s.is_deleted}, id_mps ${idMps})`)

  const b = (await selectBonnetiers()).find((x) => x.id === idBonnetier)
  if (!b) throw new Error(`bonnetier ${idBonnetier} n'existe pas`)
  const photo = await photoBonnetier(idBonnetier, 96)
  console.log(`bonnetier ${idBonnetier} : ${b.prenom} ${b.nom}  (archivé ${b.archive}, régleur ${b.regleur}, photo ${photo ? 'oui' : 'NON'})`)

  if (pli(String(s.nom)) !== pli(b.nom)) throw new Error(`les noms diffèrent (« ${s.nom} » / « ${b.nom} ») — vérifier l'id`)
  if (idMps === idBonnetier) {
    console.log('Déjà lié. Rien à faire.')
    return
  }
  if (idMps > 0) throw new Error(`le salarié est déjà lié au bonnetier ${idMps}`)
  const autres = await pointageDb.query<Record<string, unknown>>(
    `SELECT id FROM lst_salarie WHERE id_mps = ${idBonnetier} AND id <> ${idSalarie}`,
  )
  if (autres.length) throw new Error(`le bonnetier ${idBonnetier} est déjà lié au salarié ${autres.map((r) => r.id).join(', ')}`)

  if (!WRITE) {
    console.log(`OK : lst_salarie ${idSalarie}.id_mps passerait de ${idMps} à ${idBonnetier}.`)
    return
  }
  await pointageDb.query(`UPDATE lst_salarie SET id_mps = ${idBonnetier} WHERE id = ${idSalarie} AND id_mps = ${idMps}`)
  const relu = Number((await pointageDb.query<Record<string, unknown>>(`SELECT id_mps FROM lst_salarie WHERE id = ${idSalarie}`))[0]?.id_mps)
  if (relu !== idBonnetier) throw new Error(`relu id_mps = ${relu}, attendu ${idBonnetier}`)
  console.log(`Écrit : lst_salarie ${idSalarie}.id_mps = ${idBonnetier} (relu).`)
}

main()
  .then(() => 0, (err) => {
    console.error(`ÉCHEC : ${err instanceof Error ? err.message : String(err)}`)
    return 1
  })
  .then(async (code) => {
    await pointageDb.closeConnection()
    await closeConnection()
    process.exit(code)
  })
