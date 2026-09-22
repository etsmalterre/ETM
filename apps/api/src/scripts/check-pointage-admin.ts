/**
 * Write-cycle check of the Admin Pointage corrections (lib/pointage-ecritures.ts
 * creerLigneAdmin / corrigerLigneAdmin / supprimerLigneAdmin and
 * lib/pointage-admin-ecritures.ts) against the LOCAL copy of the `pointage`
 * database and the local `mps.pointage`. It WRITES, then deletes exactly what
 * it wrote; it refuses to run unless both connections are localhost.
 *
 *   node --env-file=.env.development --import tsx src/scripts/check-pointage-admin.ts
 *
 * Needs the dev copy: src/scripts/copy-pointage-prod-to-dev.ts --write.
 *
 * Scenario (decision A of 2026-09-21: the office's corrections move the twin
 * and the presence journal with them):
 *   1. a night shift typed by hand (21:00 → pause 01:00–01:20 → open) — the
 *      pauses land on the next day, the twin is inserted, the journal gets
 *      1 / 0 / 1;
 *   2. the forgotten shift is closed at 05:00 — `fin` on the next day, twin
 *      updated, one departure row (0) added;
 *   3. the start is moved to 21:10 — twin found on the OLD start, journal row
 *      moved;
 *   4. pause 1 is cleared — twin NULLs, the two journal rows removed;
 *   5. an out-of-order correction is refused (SaisieInvalide), nothing written;
 *   6. the shift is deleted — truth and twin flagged, journal kept;
 *   7. a salarié and a message go through create / update / soft delete, the
 *      duplicate login refused.
 */
import { closeConnection, query } from '../lib/hfsql-auto.js'
import { pointageConnectionString, pointageDb } from '../lib/hfsql-pointage.js'
import { listerSalaries, trouverLigne, trouverMessage, trouverSalarieMemeSupprime } from '../lib/pointage.js'
import { corrigerLigneAdmin, creerLigneAdmin, supprimerLigneAdmin } from '../lib/pointage-ecritures.js'
import { creerMessage, creerSalarie, modifierMessage, modifierSalarie, supprimerMessage, supprimerSalarie } from '../lib/pointage-admin-ecritures.js'
import { SaisieInvalide, heureDe } from '../lib/pointage-admin.js'
import { dtParis, msHeureParis, parseDtParisMs } from '../lib/pointage-etat.js'

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
const s = (y: number, mo: number, d: number, h: number, mi: number) => Math.floor(msHeureParis(y, mo, d, h, mi) / 1000)

/** The journal rows of the test window (the day after `depuisS` included) —
 *  the test day sits in 2001, before every real row of the copy. */
async function journal(idMps: number, depuisS: number): Promise<Array<{ dt: number; enPoste: number }>> {
  const rows = await query<Record<string, unknown>>(`SELECT * FROM pointage WHERE IDbonnetier = ${idMps} ORDER BY IDpointage`)
  return rows
    .map((r) => ({ dt: (parseDtParisMs(r.DATE ?? r.date) ?? 0) / 1000, enPoste: Number(r.en_poste) }))
    .filter((r) => r.dt >= depuisS && r.dt < depuisS + 2 * 86_400)
}

async function jumelleDe(idSalarie: number, debutS: number) {
  const rows = await pointageDb.query<Record<string, unknown>>(
    `SELECT TOP 30 * FROM lst_pointage WHERE id_salarie = ${idSalarie} AND is_deleted = 0 ORDER BY id DESC`,
  )
  return rows.find((r) => Math.abs((parseDtParisMs(r.debut) ?? 0) - debutS * 1000) <= 2000) ?? null
}

async function main(): Promise<void> {
  const salarie = (await listerSalaries()).find((x) => x.idMps > 0)
  if (!salarie) throw new Error('no salarié linked to a bonnetier on the dev copy')
  console.log(`salarié ${salarie.id} (${salarie.prenom} ${salarie.nom}, bonnetier ${salarie.idMps})`)

  // A day far in the past nobody pointed on: 2 January 2001, a Tuesday.
  const jour = '20010102'
  const t21 = s(2001, 1, 2, 21, 0)
  const avant = {
    horaire: await maxDe('SELECT MAX(id) AS m FROM lst_horaire'),
    pointage: await maxDe('SELECT MAX(id) AS m FROM lst_pointage'),
    mps: Number((await query<{ m: number | null }>('SELECT MAX(IDpointage) AS m FROM pointage'))[0]?.m) || 0,
    salarie: await maxDe('SELECT MAX(id) AS m FROM lst_salarie'),
    message: await maxDe('SELECT MAX(id) AS m FROM lst_message'),
  }

  let ligneId = 0
  let salarieCreeId = 0
  try {
    console.log('\n1. poste de nuit saisi à la main')
    const r1 = await creerLigneAdmin(salarie, jour, { debut: '21:00', debut_pause1: '01:00', fin_pause1: '01:20' })
    ligneId = r1.ligneId
    const l1 = await trouverLigne(ligneId)
    verifier(!!l1 && l1.debut === t21, 'début à 21:00 le soir')
    verifier(!!l1 && l1.debut_pause1 === s(2001, 1, 3, 1, 0) && l1.fin_pause1 === s(2001, 1, 3, 1, 20), 'pause 1 le lendemain 01:00–01:20')
    verifier(!!l1 && l1.fin === 0 && l1.jour === jour, 'poste ouvert, date = le soir')
    verifier(r1.lstPointage === 'ecrit' && r1.mps === 'ecrit', `jumelle ${r1.lstPointage}, journal ${r1.mps}`)
    const j1 = await jumelleDe(salarie.id, t21)
    verifier(!!j1 && parseDtParisMs(j1.fin_pause1) === s(2001, 1, 3, 1, 20) * 1000 && j1.fin === null, 'jumelle : mêmes instants, fin NULL')
    const jn1 = await journal(salarie.idMps, t21)
    verifier(jn1.map((x) => x.enPoste).join('') === '101', `journal 1/0/1 (${jn1.map((x) => `${heureDe(x.dt)}:${x.enPoste}`).join(' ')})`)

    console.log('\n2. fermeture du poste oublié à 05:00')
    const r2 = await corrigerLigneAdmin(salarie, ligneId, { fin: '05:00' })
    const l2 = await trouverLigne(ligneId)
    verifier(!!l2 && l2.fin === s(2001, 1, 3, 5, 0), 'fin le lendemain 05:00')
    verifier(r2.lstPointage === 'ecrit' && r2.mps === 'ecrit', 'jumelle et journal suivis')
    const j2 = await jumelleDe(salarie.id, t21)
    verifier(!!j2 && parseDtParisMs(j2.fin) === s(2001, 1, 3, 5, 0) * 1000, 'jumelle : fin posée')
    const jn2 = await journal(salarie.idMps, t21)
    verifier(jn2.map((x) => x.enPoste).join('') === '1010' && jn2[3].dt === s(2001, 1, 3, 5, 0), 'journal : départ ajouté à 05:00')

    console.log('\n3. début déplacé à 21:10')
    const r3 = await corrigerLigneAdmin(salarie, ligneId, { debut: '21:10' })
    const l3 = await trouverLigne(ligneId)
    verifier(!!l3 && l3.debut === s(2001, 1, 2, 21, 10) && l3.fin === s(2001, 1, 3, 5, 0), 'début 21:10, le reste inchangé')
    verifier(r3.lstPointage === 'ecrit', 'jumelle retrouvée sur l’ancien début')
    const j3 = await jumelleDe(salarie.id, s(2001, 1, 2, 21, 10))
    verifier(!!j3, 'jumelle : début déplacé')
    const jn3 = await journal(salarie.idMps, t21)
    verifier(jn3.length === 4 && jn3.some((x) => x.dt === s(2001, 1, 2, 21, 10) && x.enPoste === 1) && !jn3.some((x) => x.dt === t21), 'journal : ligne d’arrivée déplacée, pas dupliquée')

    console.log('\n4. pause 1 effacée')
    const r4 = await corrigerLigneAdmin(salarie, ligneId, { debut_pause1: null, fin_pause1: null })
    const l4 = await trouverLigne(ligneId)
    verifier(!!l4 && l4.debut_pause1 === 0 && l4.fin_pause1 === 0, 'stamps à 0')
    verifier(r4.mps === 'ecrit', 'journal suivi')
    const j4 = await jumelleDe(salarie.id, s(2001, 1, 2, 21, 10))
    verifier(!!j4 && j4.debut_pause1 === null && j4.fin_pause1 === null, 'jumelle : pause NULL')
    const jn4 = await journal(salarie.idMps, t21)
    verifier(jn4.map((x) => x.enPoste).join('') === '10', `journal : les deux lignes de pause retirées (${jn4.length} lignes)`)

    console.log('\n5. correction incohérente refusée')
    try {
      await corrigerLigneAdmin(salarie, ligneId, { debut_pause1: '23:00', fin_pause1: '22:00' })
      verifier(false, 'acceptée à tort')
    } catch (err) {
      verifier(err instanceof SaisieInvalide, `refusée : ${(err as Error).message}`)
    }
    const l5 = await trouverLigne(ligneId)
    verifier(!!l5 && l5.debut_pause1 === 0, 'rien écrit')

    console.log('\n6. suppression du poste')
    const r6 = await supprimerLigneAdmin(salarie, ligneId)
    verifier((await trouverLigne(ligneId)) === null, 'vérité flaguée')
    verifier(r6.lstPointage === 'ecrit', 'jumelle flaguée')
    const jn6 = await journal(salarie.idMps, t21)
    verifier(jn6.length === 2, 'journal conservé')

    console.log('\n7. salarié + message')
    const cree = await creerSalarie({ nom: 'Zz-Contrôle', prenom: 'Éric', login: 'ZZ9', idMps: 0 })
    salarieCreeId = cree.id
    verifier(cree.nom === 'Zz-Contrôle' && cree.prenom === 'Éric' && cree.login === 'ZZ9', 'créé, accents intacts')
    try {
      await creerSalarie({ nom: 'Autre', prenom: 'A', login: 'zz9', idMps: 0 })
      verifier(false, 'login en double accepté à tort')
    } catch (err) {
      verifier(err instanceof SaisieInvalide, 'login en double refusé')
    }
    const modif = await modifierSalarie(cree.id, { nom: 'Zz-Contrôle', prenom: 'Éric', login: 'ZZ8', idMps: 0 })
    verifier(modif.login === 'ZZ8', 'modifié')
    const msg = await creerMessage(cree.id, { texte: 'Bonjour « Éric » — 1er test', dateFin: '20010109' })
    verifier(msg.texte === 'Bonjour « Éric » — 1er test' && msg.dateFin === '20010109', 'message créé, texte intact')
    const msg2 = await modifierMessage(msg.id, { texte: 'Modifié', dateFin: '20010110' })
    verifier(msg2.texte === 'Modifié' && msg2.dateFin === '20010110', 'message modifié')
    await supprimerMessage(msg.id)
    verifier((await trouverMessage(msg.id)) === null, 'message flagué')
    await supprimerSalarie(cree.id)
    verifier((await trouverSalarieMemeSupprime(cree.id))?.supprime === true, 'salarié flagué')
  } finally {
    console.log('\nnettoyage')
    await pointageDb.query(`DELETE FROM lst_horaire WHERE id > ${avant.horaire}`)
    await pointageDb.query(`DELETE FROM lst_pointage WHERE id > ${avant.pointage}`)
    await pointageDb.query(`DELETE FROM lst_message WHERE id > ${avant.message}`)
    await pointageDb.query(`DELETE FROM lst_salarie WHERE id > ${avant.salarie}`)
    await query(`DELETE FROM pointage WHERE IDpointage > ${avant.mps}`)
    // rows moved by step 3 keep their id: remove by instant too
    await query(`DELETE FROM pointage WHERE IDbonnetier = ${salarie.idMps} AND DATE >= '${dtParis(t21 * 1000)}' AND DATE <= '${dtParis(s(2001, 1, 3, 6, 0) * 1000)}'`)
    verifier((await maxDe('SELECT MAX(id) AS m FROM lst_horaire')) === avant.horaire, 'lst_horaire rendu')
    verifier((await maxDe('SELECT MAX(id) AS m FROM lst_salarie')) === avant.salarie, `lst_salarie rendu (${salarieCreeId ? 'créé puis supprimé' : 'rien créé'})`)
    verifier((await journal(salarie.idMps, t21)).filter((x) => x.dt < s(2001, 1, 4, 0, 0)).length === 0, 'journal rendu')
  }

  console.log(echecs === 0 ? '\nOK' : `\n${echecs} ÉCHEC(S)`)
  process.exitCode = echecs === 0 ? 0 : 1
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeConnection().catch(() => undefined)
    await pointageDb.closeConnection().catch(() => undefined)
  })
