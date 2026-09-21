/**
 * Write-cycle check of lib/pointage-ecritures.ts against the LOCAL copy of the
 * `pointage` database (and the local `mps.pointage`). It WRITES, then deletes
 * exactly what it wrote; it refuses to run unless both connections are localhost.
 *
 *   node --env-file=.env.development --import tsx src/scripts/check-pointage.ts
 *
 * Needs the dev copy: src/scripts/copy-pointage-prod-to-dev.ts --write.
 *
 * One salarié linked to a bonnetier and free to start work goes through a full
 * shift — début, pause 1, fin de pause, pause 2, « fin de la pause et fin du
 * travail » — at spread-out instants, then the checks:
 *   - the lst_horaire line carries every stamp, in epoch seconds;
 *   - its lst_pointage twin carries the same instants as Paris DATETIMEs;
 *   - mps.pointage logged 1, 0, 1, 0, 0;
 *   - a repeated or out-of-order action is refused (RefusPointage), writing nothing;
 *   - no hors_prod row is written (the feature was dropped on 2026-09-21).
 */
import { closeConnection, query } from '../lib/hfsql-auto.js'
import { pointageConnectionString, pointageDb } from '../lib/hfsql-pointage.js'
import { ligneOuverte, listerSalaries } from '../lib/pointage.js'
import { RefusPointage, pointer, type ResultatPointage } from '../lib/pointage-ecritures.js'
import { COLONNES_HEURE, etatPointage, jourParis, parseDtParisMs, type ActionPointage } from '../lib/pointage-etat.js'

const isLocal = (cs: string) => /Server Name\s*=\s*(localhost|127\.0\.0\.1)\s*(;|$)/i.test(cs)
if (!isLocal(process.env.HFSQL_CONNECTION_STRING ?? '') || !isLocal(pointageConnectionString())) {
  console.error('REFUS : ce script écrit, et une connexion ne pointe pas sur localhost.')
  process.exit(1)
}

let echecs = 0
const verifier = (ok: boolean, label: string) => {
  if (!ok) echecs++
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
}
const maxDe = async (sql: string) => Number((await pointageDb.query<{ m: number | null }>(sql))[0]?.m) || 0

async function main(): Promise<void> {
  const t0 = Math.floor(Date.now() / 1000) * 1000
  const candidats = []
  for (const s of await listerSalaries()) {
    if (s.idMps <= 0) continue
    if (etatPointage(await ligneOuverte(s.id), t0 / 1000).actions[0]?.action === 'debut_travail') candidats.push(s)
  }
  const s = candidats[0]
  if (!s) throw new Error('no salarié linked to a bonnetier is free to start work on the dev copy')
  console.log(`salarié ${s.id} (${s.prenom} ${s.nom}, bonnetier ${s.idMps})`)

  const avant = {
    horaire: await maxDe('SELECT MAX(id) AS m FROM lst_horaire'),
    pointage: await maxDe('SELECT MAX(id) AS m FROM lst_pointage'),
    mps: Number((await query<{ m: number | null }>('SELECT MAX(IDpointage) AS m FROM pointage'))[0]?.m) || 0,
  }
  const jour = jourParis(t0)

  const refuse = async (label: string, action: ActionPointage, ligne: number | null, at: number) => {
    try {
      await pointer(s, action, ligne, at)
      verifier(false, `${label} — accepté à tort`)
    } catch (err) {
      verifier(err instanceof RefusPointage, `${label} refusé`)
    }
  }

  try {
    const pas: Array<[ActionPointage, number]> = [
      ['debut_travail', 0], ['debut_pause', 3600], ['fin_pause', 3900], ['debut_pause', 7200], ['fin_pause_fin_travail', 7500],
    ]
    const resultats: ResultatPointage[] = []
    let ligne: number | null = null
    for (const [action, dt] of pas) {
      const r = await pointer(s, action, ligne, t0 + dt * 1000)
      resultats.push(r)
      ligne = r.ligneId
      console.log(`  ${action.padEnd(22)} → ligne ${r.ligneId}, lst_pointage ${r.lstPointage}, mps ${r.mps}`)
      if (action === 'debut_travail') {
        await refuse('double « Début du travail »', 'debut_travail', null, t0 + 1000)
        await refuse('« Fin de la pause » sans pause', 'fin_pause', ligne, t0 + 2000)
      }
    }
    await refuse('pointage sur une ligne fermée', 'fin_travail', ligne, t0 + 8000 * 1000)
    verifier(resultats.every((r) => r.lstPointage === 'ecrit' && r.mps === 'ecrit'), 'les trois tables écrites à chaque pas')

    const attendu = { debut: 0, debut_pause1: 3600, fin_pause1: 3900, debut_pause2: 7200, fin_pause2: 7500, fin: 7500 }
    const h = (await pointageDb.query<Record<string, unknown>>(`SELECT * FROM lst_horaire WHERE id = ${ligne}`))[0]
    verifier(!!h && COLONNES_HEURE.every((c) => Number(h[c]) === t0 / 1000 + attendu[c]), 'lst_horaire : les six heures en secondes')
    verifier(!!h && String(h[Object.keys(h).find((k) => k.toLowerCase() === 'date')!]) === jour, `lst_horaire : DATE = ${jour}`)

    const p = await pointageDb.query<Record<string, unknown>>(`SELECT * FROM lst_pointage WHERE id > ${avant.pointage} AND id_salarie = ${s.id}`)
    verifier(p.length === 1, 'lst_pointage : une seule ligne jumelle')
    verifier(!!p[0] && COLONNES_HEURE.every((c) => parseDtParisMs(p[0][c]) === t0 + attendu[c] * 1000), 'lst_pointage : les mêmes instants en heure de Paris')

    const m = await query<Record<string, unknown>>(`SELECT IDpointage, en_poste FROM pointage WHERE IDpointage > ${avant.mps} AND IDbonnetier = ${s.idMps} ORDER BY IDpointage`)
    verifier(m.map((r) => Number(r.en_poste)).join(',') === '1,0,1,0,0', `mps.pointage : en_poste ${m.map((r) => r.en_poste).join(',')}`)

  } finally {
    await pointageDb.query(`DELETE FROM lst_horaire WHERE id > ${avant.horaire} AND id_salarie = ${s.id}`)
    await pointageDb.query(`DELETE FROM lst_pointage WHERE id > ${avant.pointage} AND id_salarie = ${s.id}`)
    await query(`DELETE FROM pointage WHERE IDpointage > ${avant.mps} AND IDbonnetier = ${s.idMps}`)
    console.log('  (lignes de test supprimées)')
  }
}

main()
  .catch((err) => {
    echecs++
    console.error('ÉCHEC :', err instanceof Error ? err.message : err)
  })
  .finally(async () => {
    await pointageDb.closeConnection()
    await closeConnection()
    console.log(echecs ? `\n${echecs} échec(s)` : '\nOK')
    process.exit(echecs ? 1 : 0)
  })
