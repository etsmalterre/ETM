/**
 * DEV-ONLY seed for the WORKLIST of Production › Visitage — the pieces waiting
 * to be weighed — and, by the same rows, for the « Pièces à visiter » dashboard
 * widget.
 *
 *   cd apps/api && npx tsx src/scripts/seed-visitage-pieces.ts
 *   … --metier 2A            # one métier instead of the first --metiers ones
 *   … --metiers 4 --nb 3     # how many métiers, how many pieces each
 *   … --clean                # remove everything it created
 *
 * (`pnpm --filter @mps/api exec tsx …` works too, as for the sibling script,
 * but trails a spurious « Command "tsx" not found » after the script has
 * already finished. Run it from apps/api and the exit code is clean.)
 *
 * Why it exists: the local HFSQL copy is a snapshot months behind, and its last
 * eight pieces are all still ON the machine (date_fin NULL), so nothing is
 * awaiting visitage anywhere. The poste therefore opens on « Aucune pièce à
 * visiter · Tous les métiers sont à jour » and none of the screen can be
 * exercised locally. This is the companion of seed-visitage-historique.ts,
 * which seeds the opposite end (rolls already weighed today).
 *
 * The two windows this has to land inside, both in routes/visitage-trm.ts:
 *   - ORPHAN_MAX_AGE_DAYS = 7, a HARD constant — a piece older than a week is
 *     off the screen whatever VISITAGE_PIECE_MAX_AGE_DAYS says;
 *   - the widget's 24 h.
 * So every piece is finished within the last few HOURS, which also means no
 * env override is needed to see them.
 *
 * The finish times are deliberately spread to straddle the widget's colour
 * thresholds (green < 2 h, orange ≥ 2 h, red ≥ 3 h — FI_PiecesAVisiter's
 * recovered WLanguage): a seed that lands them all in one bucket cannot show
 * that the grid works.
 *
 * ⚠️ It WRITES. Guards:
 *   - it refuses to run unless HFSQL_CONNECTION_STRING points at localhost;
 *   - it only ever ADDS rows (piece_production + their two evenement_piece and
 *     their defaut_qualite), never touches an existing one;
 *   - --clean removes exactly what it wrote, identified as « a piece finished
 *     today » — on a snapshot months old, nothing else can be — and unwinds
 *     any roll the poste has since created from one of them.
 */
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })

import { query, closeConnection } from '../lib/hfsql-auto.js'
import { maxId } from '../routes/expeditions.js'
import {
  sqlText, parseDtMs, selectMachines, selectBonnetiers, loadOf,
} from '../lib/production-trm.js'

const args = process.argv.slice(2)
const flag = (name: string): string | null => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}
const CLEAN = args.includes('--clean')
const ONLY = flag('metier')
const NB = Math.max(1, Math.min(8, parseInt(flag('nb') ?? '3', 10) || 3))
const NB_METIERS = Math.max(1, Math.min(12, parseInt(flag('metiers') ?? '4', 10) || 4))

// Same guard as seed-visitage-historique: read the CONFIGURED string, not the
// resolved one — lib/hfsql.ts falls back to localhost when the variable is
// missing, and on the prod host that fallback looks like a dev connection.
if (!/Server Name\s*=\s*localhost/i.test(process.env.HFSQL_CONNECTION_STRING ?? '')) {
  console.error('REFUS : ce script écrit, et la connexion ne pointe pas sur localhost.')
  console.error('  ' + (process.env.HFSQL_CONNECTION_STRING ?? '(vide)').replace(/PWD=[^;]*/i, 'PWD=***'))
  process.exit(1)
}

/** Compact HFSQL DATETIME literal for "N minutes ago". */
function dtMinutesAgo(minutes: number): string {
  const t = new Date(Date.now() - minutes * 60_000)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`
}

/** How long ago each piece of a métier came off, in minutes. Straddles the
 *  widget's 2 h / 3 h thresholds so the seeded grid shows all three colours;
 *  the offset per métier keeps two métiers from producing identical rows. */
function finishedMinutesAgo(i: number, metierIndex: number): number {
  const ladder = [25, 140, 215, 300, 55, 175, 260, 340]
  return ladder[i % ladder.length] + metierIndex * 7
}

/** Terminal defects, as the bonnetier declares them at the workshop terminal:
 *  Type_Reference = 1, Type_Spotteur = 1, an approximate quantity and the
 *  free-text `description` he picked. The exact (description, taille_cm,
 *  nombre) triples below are the live vocabulary of the base, most-used first.
 *
 *  The point of seeding these is the poste's quantity-correction field: the
 *  visiteuse measures and rectifies what the terminal guessed. So the list
 *  deliberately includes « Maille Toute la pièce » (taille_cm 999 — the
 *  coarsest bucket the terminal offers, 7 live rows) and « Maille de 100cm »
 *  (the lazy default, 1 127 live rows), which are exactly the two a visiteuse
 *  has to fix. */
const DEFAUTS_TERMINAL: Array<{ type: string; description: string; taille_cm: number; nombre: number }> = [
  { type: 'Maille', description: 'Maille de 100cm', taille_cm: 100, nombre: 0 },
  { type: 'Démaillage', description: 'Démaillage', taille_cm: 0, nombre: 1 },
  { type: 'Maille', description: 'Maille Toute la pièce', taille_cm: 999, nombre: 0 },
  { type: 'Barrure Lycra', description: 'Barrure Lycra de 100cm', taille_cm: 100, nombre: 0 },
  { type: 'Trou', description: 'Trou', taille_cm: 0, nombre: 1 },
  { type: 'Maille', description: 'Maille Plus de 3m', taille_cm: 300, nombre: 0 },
  { type: 'Grille', description: 'Grille', taille_cm: 0, nombre: 1 },
]

/** Pieces whose date_fin falls today. On this snapshot they are, by
 *  construction, the ones this script wrote. Read the tail and cut in JS —
 *  date comparisons differ between the two drivers. */
async function piecesSeededToday(): Promise<number[]> {
  const rows = await query<any>(
    `SELECT IDpiece_production, date_fin FROM piece_production
     ORDER BY IDpiece_production DESC LIMIT 400`,
  )
  const from = new Date()
  from.setHours(0, 0, 0, 0)
  return rows
    .filter((r) => (parseDtMs(r.date_fin) ?? 0) >= from.getTime())
    .map((r) => Number(r.IDpiece_production) || 0)
    .filter(Boolean)
}

async function clean(): Promise<void> {
  const ids = await piecesSeededToday()
  if (ids.length === 0) {
    console.log("Rien a nettoyer : aucune piece terminee aujourd hui.")
    return
  }
  const list = ids.join(',')

  // A piece may already have been weighed at the poste since. Unwind the roll
  // too, or --clean leaves a stock_ecru pointing at a piece that no longer
  // exists — and the OF's numbering sequences drifted for nothing.
  const rolls = await query<{ IDstock_ecru: number }>(
    `SELECT IDstock_ecru FROM stock_ecru WHERE IDpiece_production IN (${list})`,
  )
  const rollIds = rolls.map((r) => Number(r.IDstock_ecru) || 0).filter(Boolean)
  if (rollIds.length > 0) {
    const rl = rollIds.join(',')
    console.log(`  ${rollIds.length} rouleau(x) issus de ces pieces : ${rl}`)
    await query(`DELETE FROM evenement_piece WHERE IDstock_ecru IN (${rl})`)
    for (const id of rollIds) {
      await query(`DELETE FROM defaut_qualite WHERE Type_Reference = 2 AND reference = '${id}'`)
    }
    await query(`DELETE FROM stock_ecru WHERE IDstock_ecru IN (${rl})`)
  }

  console.log(`Suppression de ${ids.length} piece(s) : ${list}`)
  await query(`DELETE FROM evenement_piece WHERE IDpiece_production IN (${list})`)
  for (const id of ids) {
    await query(`DELETE FROM defaut_qualite WHERE Type_Reference = 1 AND reference = '${id}'`)
  }
  await query(`DELETE FROM piece_production WHERE IDpiece_production IN (${list})`)
  console.log('Nettoye.')
}

/** The OF at the head of a métier's queue — same hop as the screen
 *  (headOfForMachine in routes/visitage-trm.ts, itself verbatim legacy). */
async function headOf(machineId: number): Promise<number> {
  const rows = await query<{ IDordre_fabrication: number }>(
    `SELECT ordre_fabrication.IDordre_fabrication
     FROM ordre_fabrication
     LEFT JOIN (
       SELECT ordre_fabrication.IDmachine, ordre_fabrication.priorite
       FROM ordre_fabrication WHERE ordre_fabrication.est_actif = 1
     ) prio_actif ON prio_actif.IDmachine = ordre_fabrication.IDmachine
     WHERE ordre_fabrication.IDmachine = ${machineId}
       AND ordre_fabrication.est_termine = 0
       AND ordre_fabrication.priorite <= prio_actif.priorite
       AND ordre_fabrication.priorite <> 0
     ORDER BY ordre_fabrication.priorite ASC
     LIMIT 1`,
  )
  return Number(rows[0]?.IDordre_fabrication) || 0
}

async function nextNumero(ofId: number): Promise<number> {
  const rows = await query<{ m: number | null }>(
    `SELECT MAX(numero) AS m FROM piece_production WHERE IDordre_fabrication = ${ofId}`,
  )
  return (Number(rows[0]?.m) || 0) + 1
}

async function seed(): Promise<void> {
  const machines = (await selectMachines()).filter((m) => m.archive === 0 && m.emplacement !== '')
  const actives = await query<{ IDmachine: number }>(
    'SELECT IDmachine FROM ordre_fabrication WHERE est_actif = 1 AND est_termine = 0',
  )
  const activeIds = new Set(actives.map((a) => Number(a.IDmachine) || 0))

  let targets = machines
    .filter((m) => activeIds.has(m.id))
    .sort((a, b) => a.emplacement.localeCompare(b.emplacement, 'fr'))
  if (ONLY) {
    targets = targets.filter((m) => m.emplacement.toUpperCase() === ONLY.toUpperCase())
    if (targets.length === 0) {
      console.error(`Metier ${ONLY} introuvable, ou sans OF actif.`)
      return
    }
  } else {
    targets = targets.slice(0, NB_METIERS)
  }

  // Régleurs excluded: a piece is knitted by a bonnetier, and the poste shows
  // this name as the person who declared the terminal defects.
  const bonnetiers = (await selectBonnetiers()).filter((b) => b.archive === 0 && b.regleur === 0)
  if (bonnetiers.length === 0) {
    console.error('Aucun bonnetier pour signer les pieces.')
    return
  }

  let total = 0
  let metierIndex = 0
  for (const m of targets) {
    const ofId = await headOf(m.id)
    if (ofId === 0) continue
    // Scope guard: an OF whose commande is not société 2 is invisible to the
    // poste anyway, so seeding it would produce pieces nothing can open.
    const loaded = await loadOf(ofId)
    if (!loaded) {
      console.log(`${m.emplacement} - OF ${ofId} hors perimetre TRM, ignore`)
      continue
    }
    const poids = Number(loaded.of.poids_piece) || 20
    let numero = await nextNumero(ofId)

    for (let i = 0; i < NB; i++) {
      const finMin = finishedMinutesAgo(i, metierIndex)
      // A piece is knitted in roughly four hours on these OFs.
      const debutMin = finMin + 235 + ((i * 13) % 40)
      const bonnetier = bonnetiers[(i + metierIndex) % bonnetiers.length]
      const pieceId = (await maxId('piece_production', 'IDpiece_production')) + 1

      // piece_production is entirely ASCII and carries no reserved word — a
      // named INSERT is safe here (unlike defaut_qualite, whose `date` forces
      // the positional form below).
      await query(
        `INSERT INTO piece_production
         (IDpiece_production, IDordre_fabrication, bonnetier_debut, bonnetier_controle,
          bonnetier_fin, date_debut, date_controle, date_fin, observations, poids,
          visiteur, date_visitage, bonnetier_interruption, date_interruption, numero)
         VALUES (${pieceId}, ${ofId}, ${bonnetier.id}, 0, ${bonnetier.id},
                 '${dtMinutesAgo(debutMin)}', NULL, '${dtMinutesAgo(finMin)}', NULL,
                 ${poids}, '', NULL, 0, NULL, ${numero})`,
      )
      numero++
      total++

      // The two events the terminal writes around a piece. `date` is reserved
      // on evenement_piece → positional INSERT, MAX+1 PK. Column order:
      // (id, evenement, IDpiece_production, DATE, IDbonnetier, observation,
      //  IDstock_ecru, appareil).
      for (const [label, min] of [['Début du tricotage', debutMin], ['Fin du tricotage', finMin]] as const) {
        const evtId = (await maxId('evenement_piece', 'IDevenement_piece')) + 1
        await query(
          `INSERT INTO evenement_piece VALUES (${evtId}, ${sqlText(label)}, ${pieceId}, ` +
          `'${dtMinutesAgo(min)}', ${bonnetier.id}, NULL, 0, ${sqlText('Terminal 4')})`,
        )
      }

      // Two pieces in three carry a terminal defect — roughly the live rate,
      // and enough that the correction field is always reachable.
      const nbDefauts = i % 3 === 2 ? 0 : (i % 3 === 1 ? 2 : 1)
      for (let d = 0; d < nbDefauts; d++) {
        const def = DEFAUTS_TERMINAL[(i * 2 + d + metierIndex) % DEFAUTS_TERMINAL.length]
        const dId = (await maxId('defaut_qualite', 'IDdefaut_qualite')) + 1
        // Column order: (id, reference, description, DATE, Type_Spotteur,
        // IDSpotteur, Type_Reference, type_defaut, traité, taille_cm,
        // récuperé, nombre). reference is TEXT holding the id.
        await query(
          `INSERT INTO defaut_qualite VALUES (${dId}, '${pieceId}', ${sqlText(def.description)}, ` +
          `'${dtMinutesAgo(finMin)}', 1, ${bonnetier.id}, 1, ${sqlText(def.type)}, 0, ` +
          `${def.taille_cm}, 0, ${def.nombre})`,
        )
      }
    }
    console.log(
      `${m.emplacement} - OF ${ofId} - ${NB} piece(s) terminee(s) il y a ` +
      Array.from({ length: NB }, (_, i) => `${Math.round(finishedMinutesAgo(i, metierIndex) / 6) / 10}h`).join(', '),
    )
    metierIndex++
  }

  if (total === 0) {
    console.log('Aucune piece creee : aucun metier cible n a d OF de tete dans le perimetre TRM.')
    return
  }
  console.log(`\n${total} piece(s) creee(s) sur ${metierIndex} metier(s). Pour tout retirer : --clean`)
  console.log('Le poste (7 j) et le widget « Pieces a visiter » (24 h) les voient tous les deux.')
}

if (CLEAN) await clean()
else await seed()
await closeConnection()
