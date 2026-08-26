/**
 * DEV-ONLY seed for the « Aujourd'hui sur <métier> » strip of Production ›
 * Visitage (bande 5).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/seed-visitage-historique.ts
 *   … --metier 2A --nb 5        # one métier, five rolls
 *   … --clean                   # remove every roll it created
 *
 * Why it exists: the local HFSQL copy is a snapshot months behind, so "today"
 * is empty on every métier and the strip always reads « aucun rouleau passé » —
 * which says nothing about how it looks in production. Measured over 400 days
 * of live history, a métier that worked a day drops a MEDIAN OF 4 rolls
 * (mean 4,5; p90 8), so that is what this seeds.
 *
 * ⚠️ It WRITES. Guards:
 *   - it refuses to run unless HFSQL_CONNECTION_STRING points at localhost;
 *   - it never touches a piece_production, so the poste keeps every piece it
 *     had left to visit (the seeded rolls carry IDpiece_production = 0);
 *   - --clean removes exactly what it wrote, identified as « a roll dated
 *     today » — on a snapshot months old, nothing else can be.
 *
 * Side effects to expect on the seeded OF, all of them the real ones a genuine
 * weighing would have: the « OF en cours » gauge climbs, both numbering
 * sequences advance, and the visitage cadence moves on.
 */
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })

import { query, closeConnection } from '../lib/hfsql-auto.js'
import { maxId } from '../routes/expeditions.js'
import {
  TRM_SOCIETE, sqlText, nowDt, parseDtMs, selectMachines, selectBonnetiers,
  bonnetierDisplayName, loadOf, TYPES_DEFAUT,
} from '../lib/production-trm.js'

const args = process.argv.slice(2)
const flag = (name: string): string | null => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}
const CLEAN = args.includes('--clean')
const ONLY = flag('metier')
const NB = Math.max(1, Math.min(12, parseInt(flag('nb') ?? '4', 10) || 4))

// The guard reads the CONFIGURED string, not the resolved one: lib/hfsql.ts
// falls back to localhost when the variable is missing, and on the prod host
// that fallback would look exactly like a dev connection. Empty = refuse.
if (!/Server Name\s*=\s*localhost/i.test(process.env.HFSQL_CONNECTION_STRING ?? '')) {
  console.error('REFUS : ce script écrit, et la connexion ne pointe pas sur localhost.')
  console.error('  ' + (process.env.HFSQL_CONNECTION_STRING ?? '(vide)').replace(/PWD=[^;]*/i, 'PWD=***'))
  process.exit(1)
}

/** A DATETIME literal for a given hour today. */
function dtAt(h: number, m: number): string {
  const t = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}${p(h)}${p(m)}00`
}

/** Rolls whose date_saisie falls today. On this snapshot they are, by
 *  construction, the ones this script wrote. Read the tail and cut in JS —
 *  date comparisons differ between the two drivers. */
async function rollsSeededToday(): Promise<number[]> {
  const rows = await query<any>(
    `SELECT IDstock_ecru, date_saisie FROM stock_ecru
     ORDER BY IDstock_ecru DESC LIMIT 400`,
  )
  const from = new Date()
  from.setHours(0, 0, 0, 0)
  return rows
    .filter((r) => (parseDtMs(r.date_saisie) ?? 0) >= from.getTime())
    .map((r) => Number(r.IDstock_ecru) || 0)
    .filter(Boolean)
}

async function clean(): Promise<void> {
  const ids = await rollsSeededToday()
  if (ids.length === 0) {
    console.log('Rien a nettoyer : aucun rouleau date d’aujourd’hui.')
    return
  }
  console.log(`Suppression de ${ids.length} rouleau(x) : ${ids.join(', ')}`)
  const list = ids.join(',')
  await query(`DELETE FROM evenement_piece WHERE IDstock_ecru IN (${list})`)
  for (const id of ids) {
    await query(`DELETE FROM defaut_qualite WHERE Type_Reference = 2 AND reference = '${id}'`)
  }
  await query(`DELETE FROM stock_ecru WHERE IDstock_ecru IN (${list})`)
  console.log('Nettoye.')
}

/** The OF at the head of a métier's queue — same hop as the screen. */
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

async function nextNumeros(ofId: number): Promise<{ premier: number; second: number }> {
  const rows = await query<{ num_piece_OF: number }>(
    `SELECT num_piece_OF FROM stock_ecru WHERE IDordre_fabrication = ${ofId}`,
  )
  let p = 0
  // The déclassé sequence opens at 1001 — same rule as routes/visitage-trm.ts.
  let s = 1000
  for (const r of rows) {
    const n = Number(r.num_piece_OF) || 0
    if (n >= 1000 && n < 2000) s = Math.max(s, n)
    else if (n > 0 && n < 1000) p = Math.max(p, n)
  }
  return { premier: p + 1, second: s + 1 }
}

async function seed(): Promise<void> {
  const machines = (await selectMachines()).filter((m) => m.archive === 0 && m.emplacement !== '')
  const targets = ONLY
    ? machines.filter((m) => m.emplacement.toUpperCase() === ONLY.toUpperCase())
    : machines
  if (targets.length === 0) {
    console.error(`Metier ${ONLY} introuvable.`)
    return
  }

  const visiteurs = (await selectBonnetiers()).filter((b) => b.archive === 0).slice(0, 3)
  if (visiteurs.length === 0) {
    console.error('Aucun bonnetier pour signer les rouleaux.')
    return
  }

  let total = 0
  for (const m of targets) {
    const ofId = await headOf(m.id)
    if (ofId === 0) continue
    const loaded = await loadOf(ofId)
    if (!loaded) continue
    const of = loaded.of
    const cible = Number(of.poids_piece) || 20
    const seq = await nextNumeros(ofId)

    // One déclassé two rolls from the end — roughly the live 2nd-choix rate,
    // and enough to show the red pastille and its defect count.
    const declasseAt = NB >= 3 ? NB - 2 : -1

    for (let i = 0; i < NB; i++) {
      const declasse = i === declasseAt
      const num = declasse ? seq.second++ : seq.premier++
      // Inside the valid band [cible, cible + 0,7] — the rule the « Poids des
      // pièces » widget scores — except the last roll, a short end-of-lot
      // remnant, so the strip is not uniformly perfect.
      const poids = i === NB - 1
        ? Math.round(cible * 0.45 * 100) / 100
        : Math.round((cible + ((i * 17) % 7) / 10) * 100) / 100
      const visiteur = visiteurs[i % visiteurs.length]
      const nom = bonnetierDisplayName(visiteur)
      // Spread over the shift, oldest first, never in the future.
      const heure = Math.min(new Date().getHours(), 6 + Math.floor((i * 11) / Math.max(1, NB)))
      const minute = (i * 23) % 60

      await query(
        `INSERT INTO stock_ecru
         (numero, lot, poids, metrage, num_piece_OF, second_choix, visiteur, observations,
          date_saisie, IDmagasin, IDsociete, IDordre_fabrication, IDref_ecru, IDcolori_ecru,
          IDpiece_production, IDLigne_Commande_TRM, IDligne_commande_client,
          IDligne_expedition_TRM, IDligne_expedition_ETM,
          IDref_commande_source, IDref_commande_affectation, IDcommande_donation)
         VALUES (${sqlText(`${ofId}/${num}`)}, '', ${poids}, 0, ${num},
                 ${declasse ? 1 : 0}, ${sqlText(nom)}, '',
                 '${dtAt(heure, minute)}', 0, ${TRM_SOCIETE}, ${ofId}, ${Number(of.IDref_ecru) || 0},
                 ${Number(of.IDcolori_ecru) || 0}, 0,
                 ${Number(of.IDligne_commande_client) || 0}, 0, 0, 0, 0, 0, 0)`,
      )
      const rollId = Number(
        (await query<{ m: number }>('SELECT MAX(IDstock_ecru) AS m FROM stock_ecru'))[0]?.m,
      ) || 0
      total++

      if (declasse) {
        // Type_Spotteur = 2 + description NULL is the visitage signature.
        // `date` is reserved → positional INSERT, MAX+1 PK.
        const t = TYPES_DEFAUT[(i * 3) % TYPES_DEFAUT.length]
        const dId = (await maxId('defaut_qualite', 'IDdefaut_qualite')) + 1
        await query(
          `INSERT INTO defaut_qualite VALUES (${dId}, '${rollId}', NULL, '${nowDt()}', 2, ` +
          `${visiteur.id}, 2, ${sqlText(t.type)}, 0, ${t.unite === 'cm' ? 120 : 0}, 0, ` +
          `${t.unite === 'nb' ? 2 : 0})`,
        )
      }

      const evtId = (await maxId('evenement_piece', 'IDevenement_piece')) + 1
      const evenement = declasse || i % 3 === 0 ? 'Visitage tombé métier' : 'Pesage tombé métier'
      await query(
        `INSERT INTO evenement_piece VALUES (${evtId}, ${sqlText(evenement)}, 0, ` +
        `'${dtAt(heure, minute)}', ${visiteur.id}, NULL, ${rollId}, '')`,
      )
    }
    console.log(`${m.emplacement} - OF ${ofId} - ${NB} rouleau(x) poses aujourd hui`)
  }
  console.log(`\n${total} rouleau(x) cree(s). Pour tout retirer : --clean`)
}

if (CLEAN) await clean()
else await seed()
await closeConnection()
