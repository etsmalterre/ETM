/**
 * Seed the last worked days of the seven active salariés into the LOCAL
 * `pointage` database, plus the matching `planning_bonnetier` rows in the LOCAL
 * MPS database, so Pointage › Salariés « 7 derniers jours travaillés » (and the
 * daily email preview) show clean days next to every fault the report rules
 * flag. DEV ONLY: refuses unless both connections are localhost.
 *
 *   node --env-file=.env.development --import tsx src/scripts/seed-journees-pointage-dev.ts            # dry run
 *   node --env-file=.env.development --import tsx src/scripts/seed-journees-pointage-dev.ts --write    # seed
 *
 * Window = the weekdays of the last 10 days, today excluded. Before writing, it
 * DELETES these salariés' lst_horaire / lst_pointage lines and their bonnetiers'
 * planning rows over that window, so it can be re-run at will.
 *
 * Scenarios (i = weekday index, 0 = the most recent one):
 *   day hours (lib/rapport-pointage.ts HORAIRES_FIXES / HORAIRE_JOURNEE)
 *     1  NICOLAS   09-18    i1 arrives 09:22 · i3 lunch not clocked · i5 back from lunch 14:25
 *     5  OLIVIER   08:30-17:30  i0 leaves 16:40 · i2 clock-out forgotten before lunch
 *     20 MICKAEL   09-18    i2 leaves 17:20 · i6 arrives 09:15
 *     35 ANGELIQUE 09-18    always in order
 *   shift workers (a planning row each day)
 *     46 MARIE     05-13    i1 35 min of pause · i4 arrives 05:14
 *     44 DAUNOVAN  13-21    i2 leaves 20:30 · i5 two lines, 25 min between them + 10 min pause
 *     33 ANAIS     21-05    i3 planned, never clocked · i6 arrives 21:12
 */
import { pointageConnectionString, pointageDb } from '../lib/hfsql-pointage.js'
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { dtParis, jourParis, msHeureParis } from '../lib/pointage-etat.js'

const WRITE = process.argv.includes('--write')

const LOCAL = /Server Name\s*=\s*(localhost|127\.0\.0\.1)\s*(;|$)/i
if (!LOCAL.test(pointageConnectionString()) || !LOCAL.test(process.env.HFSQL_CONNECTION_STRING ?? '')) {
  console.error('REFUS : ce script écrit, et une des deux bases n’est pas sur localhost.')
  process.exit(1)
}

/** A line of the day as « HH:MM » wall-clock times; `+` = next day. */
type L = { d: string; p1?: [string, string]; p2?: [string, string]; f?: string }
type Jour = L[] | null // null = no line at all

interface Salarie {
  nom: string
  id: number
  idMps: number
  /** Planning « HH:MM-HH:MM » for a shift worker; none = day hours. */
  equipe?: [string, string]
  jour: (i: number) => Jour
}

const journee = (matin: string, midi: string, reprise: string, soir: string): L[] => [{ d: matin, f: midi }, { d: reprise, f: soir }]

const SALARIES: Salarie[] = [
  {
    nom: 'NICOLAS', id: 1, idMps: 16,
    jour: (i) =>
      i === 1 ? journee('09:22', '12:04', '13:58', '18:03')
      : i === 3 ? [{ d: '08:55', f: '18:02' }]
      : i === 5 ? journee('08:52', '12:01', '14:25', '18:05')
      : journee('08:5' + (i % 9), '12:0' + (i % 6), '13:5' + (i % 9), '18:0' + (i % 7)),
  },
  {
    nom: 'OLIVIER', id: 5, idMps: 19,
    jour: (i) =>
      i === 0 ? journee('08:22', '12:00', '13:49', '16:40')
      : i === 2 ? [{ d: '08:21' }, { d: '13:55', f: '17:31' }]
      : journee('08:2' + (i % 9), '12:00', '13:4' + (i % 9), '17:3' + (i % 5)),
  },
  {
    nom: 'MICKAEL', id: 20, idMps: 15,
    jour: (i) =>
      i === 2 ? journee('08:57', '12:02', '13:57', '17:20')
      : i === 6 ? journee('09:15', '12:03', '13:59', '18:04')
      : journee('08:5' + (i % 9), '12:0' + (i % 4), '13:5' + (i % 9), '18:0' + (i % 6)),
  },
  { nom: 'ANGELIQUE', id: 35, idMps: 24, jour: (i) => journee('08:4' + (i % 9), '12:01', '13:55', '18:02') },
  {
    nom: 'MARIE', id: 46, idMps: 30, equipe: ['05:00', '13:00'],
    jour: (i) =>
      i === 1 ? [{ d: '04:56', p1: ['09:00', '09:35'], f: '13:03' }]
      : i === 4 ? [{ d: '05:14', p1: ['09:02', '09:20'], f: '13:02' }]
      : [{ d: '04:5' + (i % 9), p1: ['09:0' + (i % 5), '09:2' + (i % 5)], f: '13:0' + (i % 6) }],
  },
  {
    nom: 'DAUNOVAN', id: 44, idMps: 28, equipe: ['13:00', '21:00'],
    jour: (i) =>
      i === 2 ? [{ d: '12:57', p1: ['17:00', '17:18'], f: '20:30' }]
      : i === 5 ? [{ d: '12:55', p1: ['15:00', '15:10'], f: '17:00' }, { d: '17:25', f: '21:02' }]
      : [{ d: '12:5' + (i % 9), p1: ['17:0' + (i % 5), '17:1' + (i % 9)], f: '21:0' + (i % 6) }],
  },
  {
    nom: 'ANAIS', id: 33, idMps: 22, equipe: ['21:00', '+05:00'],
    jour: (i) =>
      i === 3 ? null
      : i === 6 ? [{ d: '21:12', p1: ['+01:00', '+01:18'], f: '+05:03' }]
      : [{ d: '20:5' + (i % 9), p1: ['+01:0' + (i % 5), '+01:1' + (i % 9)], f: '+05:0' + (i % 6) }],
  },
]

const ymd = (ms: number) => jourParis(ms)
/** Epoch SECONDS of « HH:MM » (or « +HH:MM », next day) on `jour`. */
function instant(jour: string, hm: string | undefined): number {
  if (!hm) return 0
  const lendemain = hm.startsWith('+')
  const [h, mi] = hm.replace('+', '').split(':').map(Number)
  const base = Date.UTC(+jour.slice(0, 4), +jour.slice(4, 6) - 1, +jour.slice(6, 8) + (lendemain ? 1 : 0))
  const d = new Date(base)
  return Math.floor(msHeureParis(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi) / 1000)
}

const sql = async (db: 'pointage' | 'mps', label: string, statement: string): Promise<void> => {
  if (label) console.log(`  ${WRITE ? '→' : '(dry)'} ${label}`)
  if (!WRITE) return
  if (db === 'pointage') await pointageDb.query(statement)
  else await query(statement)
}
const maxId = async (table: string): Promise<number> =>
  Number((await pointageDb.query<{ m: number | null }>(`SELECT MAX(id) AS m FROM ${table}`))[0]?.m) || 0

async function main(): Promise<void> {
  const now = Date.now()
  // Weekdays of the last 10 days, most recent first.
  const jours: string[] = []
  for (let k = 1; k <= 10; k++) {
    const j = ymd(now - k * 86_400_000)
    const wd = new Date(Date.UTC(+j.slice(0, 4), +j.slice(4, 6) - 1, +j.slice(6, 8))).getUTCDay()
    if (wd !== 0 && wd !== 6) jours.push(j)
  }
  const du = jours[jours.length - 1], au = jours[0]
  const ids = SALARIES.map((s) => s.id).join(', ')
  const bonnetiers = SALARIES.map((s) => s.idMps).join(', ')
  console.log(WRITE ? 'MODE ÉCRITURE' : 'Simulation — ajouter --write pour écrire')
  console.log(`Jours : ${[...jours].reverse().join(' ')}`)

  console.log('\nNettoyage de la fenêtre :')
  await sql('pointage', `lst_horaire ${du}..${au}`, `DELETE FROM lst_horaire WHERE DATE >= '${du}' AND DATE <= '${au}' AND id_salarie IN (${ids})`)
  await sql('pointage', `lst_pointage ${du}..${au}`, `DELETE FROM lst_pointage WHERE DATE >= '${du}' AND DATE <= '${au}' AND id_salarie IN (${ids})`)
  await sql('mps', `planning_bonnetier ${du}..${au}`,
    `DELETE FROM planning_bonnetier WHERE date_debut >= '${du}000000' AND date_debut <= '${au}235959' AND IDbonnetier IN (${bonnetiers})`)

  let idH = await maxId('lst_horaire')
  let idP = await maxId('lst_pointage')
  for (const s of SALARIES) {
    console.log(`\n${s.nom}${s.equipe ? ` (équipe ${s.equipe.join('-')})` : ''} :`)
    for (let i = 0; i < jours.length; i++) {
      const jour = jours[i]
      if (s.equipe) {
        const [d, f] = s.equipe
        await sql('mps', `planning ${jour} ${d}-${f}`,
          `INSERT INTO planning_bonnetier (date_debut, date_fin, IDbonnetier) VALUES ('${dtParis(instant(jour, d) * 1000)}', '${dtParis(instant(jour, f) * 1000)}', ${s.idMps})`)
      }
      const lignes = s.jour(i)
      if (!lignes) {
        console.log(`  ${jour} aucune ligne`)
        continue
      }
      for (const l of lignes) {
        const t = [instant(jour, l.d), instant(jour, l.p1?.[0]), instant(jour, l.p1?.[1]), instant(jour, l.p2?.[0]), instant(jour, l.p2?.[1]), instant(jour, l.f)]
        const dt = (x: number) => (x ? `'${dtParis(x * 1000)}'` : 'NULL')
        idH++
        await sql('pointage', `${jour} ${l.d}${l.p1 ? ` pause ${l.p1.join('-')}` : ''} → ${l.f ?? '(pas de sortie)'}`,
          `INSERT INTO lst_horaire VALUES (${idH}, ${s.id}, '${jour}', ${t.join(', ')}, 0)`)
        idP++
        await sql('pointage', '', `INSERT INTO lst_pointage VALUES (${idP}, ${s.id}, '${jour}', ${t.map(dt).join(', ')}, 0)`)
      }
    }
  }
  console.log(WRITE ? '\nOK — rouvrir un salarié dans Pointage › Salariés.' : '\nRien écrit.')
}

main()
  .catch((err) => {
    console.error('ÉCHEC :', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(async () => {
    await pointageDb.closeConnection()
    await closeConnection()
  })
