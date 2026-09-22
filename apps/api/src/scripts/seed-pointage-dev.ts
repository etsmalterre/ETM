/**
 * Seed a « normal working day » into the LOCAL `pointage` database, so the
 * pointage tablet (TRM/apps/pointage) shows every state at once. DEV ONLY: it
 * refuses to run unless the pointage connection is localhost.
 *
 *   node --env-file=.env.development --import tsx src/scripts/seed-pointage-dev.ts            # dry run
 *   node --env-file=.env.development --import tsx src/scripts/seed-pointage-dev.ts --write    # seed
 *   node --env-file=.env.development --import tsx src/scripts/seed-pointage-dev.ts --write --replace
 *     # first deletes what a previous run seeded for today (today's lines,
 *     # the reference week's lissage rows, the seeded message), then seeds again
 *
 * Needs the dev copy (copy-pointage-prod-to-dev.ts --write). Instants are
 * RELATIVE TO NOW so the picture is right whenever the script runs: at 16:00 the
 * morning team clocked out at 13:00, the day team is at work, the afternoon
 * team just went on break. What the tablet then shows (lst_salarie ids):
 *
 *   1  NICOLAS    day, at work, one pause done          → « Début de la pause » / « Fin du travail »
 *   5  OLIVIER    day, at work, both pauses done        → « Fin du travail » alone
 *   20 MICKAEL    day, at work, no pause yet            → « Début de la pause » / « Fin du travail »
 *   33 ANAIS      afternoon, ON BREAK right now         → « Fin de la pause » / « Fin de la pause et fin du travail »
 *   44 DAUNOVAN   morning, clocked out                  → « Début du travail »
 *   46 MARIE      morning, clocked out                  → « Début du travail »
 *   35 ANGELIQUE  her open line of 15/09 is KEPT        → amber « non fermé » row + « Commencer aujourd'hui »
 *
 * Other stale open lines (fin = 0, older than 14 h) are closed so they stop
 * cluttering « En poste ». Each lst_horaire line gets its lst_pointage twin and
 * (no hors_prod row: « temps hors prod » was dropped on 2026-09-21). The
 * reference week (last ISO week, lib/pointage-etat.ts semaineDeReference) gets a
 * lst_lissage row per salarié, copied from the latest week on file, so
 * « Semaine N » and « Cumul » appear. NICOLAS gets a message for a week.
 * mps.pointage (the TRS presence journal) is NOT written: the tablet never reads it.
 *
 * Column orders (lib/pointage-ecritures.ts, copy-pointage-prod-to-dev.ts):
 *   lst_horaire   id, id_salarie, DATE, debut, debut_pause1, fin_pause1, debut_pause2, fin_pause2, fin, is_deleted
 *   lst_pointage  same, DATETIMEs
 *   lst_lissage   id, id_salarie, annee, num_semaine, <jour>_type/<jour>_total ×7, cumul_semaine, is_deleted
 *   lst_message   id, id_salarie, MESSAGE, date_fin, is_deleted
 */
import { pointageConnectionString, pointageDb } from '../lib/hfsql-pointage.js'
import { POSTE_OUVERT_MAX_S, dtParis, jourParis, semaineDeReference } from '../lib/pointage-etat.js'
import { sqlTextCp1252 } from '../lib/sql-cp1252.js'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const REPLACE = args.includes('--replace')

if (!/Server Name\s*=\s*(localhost|127\.0\.0\.1)\s*(;|$)/i.test(pointageConnectionString())) {
  console.error('REFUS : ce script écrit, et la base pointage n’est pas sur localhost.')
  process.exit(1)
}

const KEEP_NON_FERME = 35 // ANGELIQUE keeps her forgotten line as the « non fermé » example
const MESSAGE_POUR = 1 // NICOLAS
const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'] as const

type Poste = { salarie: string; id: number; debut: number; p1?: [number, number | null]; p2?: [number, number]; fin?: number }
// Offsets in minutes before now.
const m = (h: number, mi = 0) => h * 60 + mi
const POSTES: Poste[] = [
  { salarie: 'NICOLAS', id: 1, debut: m(7, 50), p1: [m(4, 0), m(3, 30)] },
  { salarie: 'OLIVIER', id: 5, debut: m(7, 45), p1: [m(3, 58), m(3, 33)], p2: [m(0, 50), m(0, 35)] },
  { salarie: 'MICKAEL', id: 20, debut: m(7, 40) },
  { salarie: 'ANAIS', id: 33, debut: m(2, 55), p1: [m(0, 10), null] },
  { salarie: 'DAUNOVAN', id: 44, debut: m(11, 0), p1: [m(7, 0), m(6, 40)], fin: m(3, 0) },
  { salarie: 'MARIE', id: 46, debut: m(10, 55), p1: [m(7, 5), m(6, 45)], fin: m(3, 5) },
]

const sql = async (label: string, statement: string): Promise<void> => {
  console.log(`  ${WRITE ? '→' : '(dry)'} ${label}`)
  if (WRITE) await pointageDb.query(statement)
}
const maxId = async (table: string): Promise<number> =>
  Number((await pointageDb.query<{ m: number | null }>(`SELECT MAX(id) AS m FROM ${table}`))[0]?.m) || 0
const jourPlus = (ms: number, jours: number) => jourParis(ms + jours * 86_400_000)

async function main(): Promise<void> {
  const nowS = Math.floor(Date.now() / 1000)
  const nowMs = nowS * 1000
  const today = jourParis(nowMs)
  const semaine = semaineDeReference(nowMs)
  console.log(`Base : ${pointageConnectionString().replace(/PWD=[^;]*/, 'PWD=***')}`)
  console.log(`Aujourd'hui ${today}, semaine de référence ${semaine ? `${semaine.annee}-S${semaine.numero}` : 'aucune (semaine 1)'}`)
  console.log(WRITE ? 'MODE ÉCRITURE' : 'Simulation — ajouter --write pour écrire')

  if (REPLACE) {
    console.log('\nNettoyage du seed précédent :')
    await sql(`lst_horaire du ${today}`, `DELETE FROM lst_horaire WHERE DATE = '${today}'`)
    await sql(`lst_pointage du ${today}`, `DELETE FROM lst_pointage WHERE DATE = '${today}'`)
    if (semaine) {
      await sql(`lst_lissage S${semaine.numero}`, `DELETE FROM lst_lissage WHERE annee = ${semaine.annee} AND num_semaine = ${semaine.numero}`)
    }
    await sql(`message de ${MESSAGE_POUR}`, `DELETE FROM lst_message WHERE id_salarie = ${MESSAGE_POUR} AND date_fin >= '${today}'`)
  }

  const dejaLa = await pointageDb.query<{ n: number }>(`SELECT COUNT(*) AS n FROM lst_horaire WHERE DATE = '${today}'`)
  if (Number(dejaLa[0]?.n) > 0) {
    console.error(`\nREFUS : ${dejaLa[0].n} ligne(s) lst_horaire existent déjà pour ${today} — relancer avec --replace.`)
    process.exit(1)
  }

  // ── 1. Stale open lines: close them, except the one kept as the example. ──
  console.log('\nLignes ouvertes oubliées :')
  const ouvertes = await pointageDb.query<{ id: number; id_salarie: number; debut: number }>(
    'SELECT id, id_salarie, debut FROM lst_horaire WHERE fin = 0 AND is_deleted = 0 ORDER BY id',
  )
  for (const l of ouvertes) {
    const age = nowS - Number(l.debut)
    if (age <= POSTE_OUVERT_MAX_S) continue
    if (Number(l.id_salarie) === KEEP_NON_FERME) {
      console.log(`  ligne ${l.id} (salarié ${l.id_salarie}) gardée ouverte — exemple « non fermé »`)
      continue
    }
    const fin = Number(l.debut) + 8 * 3600
    // a pause still running on that line ends at the same instant — a closed
    // shift with an open pause reads as « en pause » forever (2026-09-22)
    await sql(
      `ligne ${l.id} (salarié ${l.id_salarie}) fermée à debut + 8 h`,
      `UPDATE lst_horaire SET fin = ${fin},
         fin_pause1 = CASE WHEN debut_pause1 > 0 AND fin_pause1 = 0 THEN ${fin} ELSE fin_pause1 END,
         fin_pause2 = CASE WHEN debut_pause2 > 0 AND fin_pause2 = 0 THEN ${fin} ELSE fin_pause2 END
       WHERE id = ${l.id}`,
    )
    await sql(`  jumelle lst_pointage`, `UPDATE lst_pointage SET fin = '${dtParis(fin * 1000)}' WHERE id_salarie = ${l.id_salarie} AND fin IS NULL AND is_deleted = 0`)
  }

  // ── 2. Today's lines. ──
  console.log('\nPostes du jour :')
  let idH = await maxId('lst_horaire')
  let idP = await maxId('lst_pointage')
  const at = (minAgo: number | null | undefined) => (minAgo == null ? 0 : nowS - minAgo * 60)
  for (const p of POSTES) {
    const t = {
      debut: at(p.debut),
      debut_pause1: at(p.p1?.[0]),
      fin_pause1: at(p.p1?.[1]),
      debut_pause2: at(p.p2?.[0]),
      fin_pause2: at(p.p2?.[1]),
      fin: at(p.fin),
    }
    const jour = jourParis(t.debut * 1000)
    const dt = (s: number) => (s ? `'${dtParis(s * 1000)}'` : 'NULL')
    const etat = t.fin ? 'terminé' : t.debut_pause1 && !t.fin_pause1 ? 'en pause' : t.debut_pause2 && !t.fin_pause2 ? 'en pause' : 'au travail'
    idH++
    await sql(
      `${p.salarie.padEnd(9)} lst_horaire ${idH} (${jour}, ${etat})`,
      `INSERT INTO lst_horaire VALUES (${idH}, ${p.id}, '${jour}', ${t.debut}, ${t.debut_pause1}, ${t.fin_pause1}, ${t.debut_pause2}, ${t.fin_pause2}, ${t.fin}, 0)`,
    )
    idP++
    await sql(
      `          lst_pointage ${idP}`,
      `INSERT INTO lst_pointage VALUES (${idP}, ${p.id}, '${jour}', ${dt(t.debut)}, ${dt(t.debut_pause1)}, ${dt(t.fin_pause1)}, ${dt(t.debut_pause2)}, ${dt(t.fin_pause2)}, ${dt(t.fin)}, 0)`,
    )
  }

  // ── 3. Worked hours of the reference week, so « Semaine N » and « Cumul » show. ──
  if (semaine) {
    console.log(`\nlst_lissage ${semaine.annee}-S${semaine.numero} :`)
    const salaries = await pointageDb.query<{ id: number; nom: string }>('SELECT id, nom FROM lst_salarie WHERE is_deleted = 0 ORDER BY id')
    let idL = await maxId('lst_lissage')
    for (const s of salaries) {
      const deja = await pointageDb.query(
        `SELECT id FROM lst_lissage WHERE id_salarie = ${s.id} AND annee = ${semaine.annee} AND num_semaine = ${semaine.numero} AND is_deleted = 0`,
      )
      if (deja.length > 0) {
        console.log(`  ${s.nom.padEnd(9)} déjà là`)
        continue
      }
      const modele = (await pointageDb.query<Record<string, unknown>>(
        `SELECT TOP 1 * FROM lst_lissage WHERE id_salarie = ${s.id} AND is_deleted = 0 ORDER BY annee DESC, num_semaine DESC`,
      ))[0]
      const cells: string[] = []
      let cumul = 0
      for (const j of JOURS) {
        const type = String(modele?.[`${j}_type`] ?? 'J').replace(/'/g, '') || 'J'
        const total = modele ? Number(modele[`${j}_total`]) || 0 : j === 'samedi' || j === 'dimanche' ? 0 : 420
        cells.push(`'${type}', ${total}`)
        cumul += total
      }
      idL++
      await sql(
        `${s.nom.padEnd(9)} ${cumul} min${modele ? ` (copie de S${modele.num_semaine})` : ' (défaut 5 × 7 h)'}`,
        `INSERT INTO lst_lissage VALUES (${idL}, ${s.id}, ${semaine.annee}, ${semaine.numero}, ${cells.join(', ')}, ${cumul}, 0)`,
      )
    }
  }

  // ── 4. One message, shown on NICOLAS's screen for a week. ──
  console.log('\nMessage :')
  const texte = '<P>Réunion sécurité jeudi à 14 h 00 en salle de pause. Merci d’être à l’heure.</P>'
  const idM = (await maxId('lst_message')) + 1
  await sql(
    `lst_message ${idM} pour le salarié ${MESSAGE_POUR}, jusqu'au ${jourPlus(nowMs, 7)}`,
    `INSERT INTO lst_message VALUES (${idM}, ${MESSAGE_POUR}, ${sqlTextCp1252(texte)}, '${jourPlus(nowMs, 7)}', 0)`,
  )

  console.log(WRITE ? '\nOK — recharger la tablette.' : '\nRien écrit.')
}

main()
  .catch((err) => {
    console.error('ÉCHEC :', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => pointageDb.closeConnection())
