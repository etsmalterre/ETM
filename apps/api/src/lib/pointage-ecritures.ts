/**
 * EVERY write of the time clock — the one module the future « one table »
 * migration has to change (decision 1, ~/.claude/plans/pointage-pwa.md).
 *
 * A pointage writes three places, in this order, at ONE server instant:
 *   1. `pointage.lst_horaire`  — the truth (epoch seconds, the only table Admin
 *      Pointage reads and edits). If this write fails, nothing else is written
 *      and the request fails.
 *   2. `pointage.lst_pointage` — its DATETIME twin, read by MPS TricoBot. The
 *      legacy found the twin with `fin = 0` (NULL there), landed on the oldest
 *      open row and drifted by one line from December 2025; here the twin is
 *      the row whose `debut` is the same instant (±2 s, the legacy wrote the
 *      two a few ms apart). A line Admin Pointage created by hand has no twin:
 *      reported `introuvable`, never invented.
 *   3. `mps.pointage` — the presence journal the TRS read, only when the
 *      salarié is linked to a bonnetier (`id_mps > 0`).
 * Steps 2 and 3 cannot be undone if they fail (HFSQL has no transaction):
 * they are logged and reported, the truth stays written.
 *
 * Serialised by one lock: « read the open line, check the action, MAX+1,
 * INSERT » is only correct when no other request runs it at the same time
 * (the visitage double POST of 2026-08-28, lib/serial-lock.ts). The legacy
 * pointeuse writing the same tables in parallel is not covered by the lock;
 * the stamped column is guarded with `= 0` and read back instead.
 *
 * Inserts are positional with an explicit MAX+1 id — the shape
 * routes/atelier.ts already runs on the Linux bridge for tables carrying the
 * reserved `DATE`. Measured on the dev copy (2026-09-15): an explicit id is
 * kept and moves the AUTO_INCREMENT counter past it; `NULL` is refused and `0`
 * is stored as 0, so the id is always computed. Runtime column orders:
 *   lst_horaire   id, id_salarie, DATE, debut, debut_pause1, fin_pause1, debut_pause2, fin_pause2, fin, is_deleted
 *   lst_pointage  (same, the six times as DATETIME, NULL = empty)
 *   hors_prod     id, id_salarie, DATE, duree
 *   mps.pointage  IDpointage, IDbonnetier, DATE, en_poste
 * ⚠️ `hors_prod`'s unique key (id_salarie, date) is NOT enforced by the server
 * (a duplicate inserted fine on the dev copy): existence is checked here.
 */
import { query } from './hfsql-auto.js'
import { pointageDb } from './hfsql-pointage.js'
import { createSerialLock } from './serial-lock.js'
import {
  dtParis,
  etatPointage,
  jourParis,
  parseDtParisMs,
  type ActionPointage,
  type ColonneHeure,
} from './pointage-etat.js'
import { ligneOuverte, type Salarie } from './pointage.js'

const verrou = createSerialLock()

/** The action no longer matches the line (screen out of date, double tap, the
 *  legacy pointeuse wrote first). The route answers 409 with the fresh state. */
export class RefusPointage extends Error {
  readonly code = 'etat_change'
}

export type Issue = 'ecrit' | 'introuvable' | 'sans_lien' | 'echec'

export interface ResultatPointage {
  action: ActionPointage
  instantMs: number
  ligneId: number
  lstPointage: Issue
  mps: Issue
}

/** Hours of « temps hors prod » the tablet may record. */
export const HORS_PROD_MAX_H = 12

async function maxId(table: 'lst_horaire' | 'lst_pointage' | 'hors_prod'): Promise<number> {
  const rows = await pointageDb.query<{ m: number | null }>(`SELECT MAX(id) AS m FROM ${table}`)
  return Number(rows[0]?.m) || 0
}

/** Run a secondary write; a failure is logged and reported, never thrown. */
async function secondaire(label: string, fn: () => Promise<Issue>): Promise<Issue> {
  try {
    return await fn()
  } catch (err) {
    console.error(`[pointage] ${label} failed:`, err instanceof Error ? err.message : err)
    return 'echec'
  }
}

/** The `lst_pointage` row twinned with a `lst_horaire` line: same salarié,
 *  `debut` within 2 s. Read in JS — date literals in a WHERE differ per driver. */
async function jumelle(idSalarie: number, debutS: number): Promise<number | null> {
  const rows = await pointageDb.query<Record<string, unknown>>(
    `SELECT TOP 30 id, debut FROM lst_pointage WHERE id_salarie = ${idSalarie} AND is_deleted = 0 ORDER BY id DESC`,
  )
  let best: { id: number; ecart: number } | null = null
  for (const r of rows) {
    const ms = parseDtParisMs(r.debut)
    if (ms === null) continue
    const ecart = Math.abs(ms - debutS * 1000)
    if (ecart <= 2000 && (!best || ecart < best.ecart)) best = { id: Number(r.id), ecart }
  }
  return best?.id ?? null
}

async function assurerHorsProd(idSalarie: number, jour: string, duree: number | null): Promise<void> {
  const rows = await pointageDb.query(`SELECT id FROM hors_prod WHERE id_salarie = ${idSalarie} AND DATE = '${jour}'`)
  if (rows.length === 0) {
    const id = (await maxId('hors_prod')) + 1
    await pointageDb.query(`INSERT INTO hors_prod VALUES (${id}, ${idSalarie}, '${jour}', ${duree ?? 0})`)
  } else if (duree !== null) {
    await pointageDb.query(`UPDATE hors_prod SET duree = ${duree} WHERE id_salarie = ${idSalarie} AND DATE = '${jour}'`)
  }
}

/**
 * Record one pointage. `ligneAttendue` is the open line the screen showed
 * (null when it offered to open one): any mismatch refuses, so a double tap or
 * a stale screen never stamps the wrong column.
 */
export function pointer(
  salarie: Salarie,
  action: ActionPointage,
  ligneAttendue: number | null,
  maintenantMs = Date.now(),
): Promise<ResultatPointage> {
  return verrou.run(async () => {
    const s = Math.floor(maintenantMs / 1000)
    const etat = etatPointage(await ligneOuverte(salarie.id), s)
    const choix = etat.actions.find((a) => a.action === action)
    if (!choix || (etat.ligne?.id ?? null) !== ligneAttendue) {
      throw new RefusPointage('Le pointage a changé depuis l’affichage de l’écran.')
    }
    const dt = dtParis(s * 1000)
    let ligneId: number
    let lstPointage: Issue

    if (action === 'debut_travail') {
      const jour = jourParis(s * 1000)
      ligneId = (await maxId('lst_horaire')) + 1
      await pointageDb.query(
        `INSERT INTO lst_horaire VALUES (${ligneId}, ${salarie.id}, '${jour}', ${s}, 0, 0, 0, 0, 0, 0)`,
      )
      const vue = await pointageDb.query(
        `SELECT id FROM lst_horaire WHERE id = ${ligneId} AND id_salarie = ${salarie.id} AND debut = ${s}`,
      )
      if (vue.length !== 1) throw new Error(`lst_horaire: line ${ligneId} not found after its INSERT`)
      lstPointage = await secondaire('lst_pointage insert', async () => {
        const id = (await maxId('lst_pointage')) + 1
        await pointageDb.query(
          `INSERT INTO lst_pointage VALUES (${id}, ${salarie.id}, '${jour}', '${dt}', NULL, NULL, NULL, NULL, NULL, 0)`,
        )
        return 'ecrit'
      })
      // The legacy creates the day's hors_prod row (duree 0) when the salarié
      // opens his screen; here, when he starts work — a GET stays a read.
      await secondaire('hors_prod', async () => {
        await assurerHorsProd(salarie.id, jour, null)
        return 'ecrit'
      })
    } else {
      const ligne = etat.ligne!
      ligneId = ligne.id
      const cols: ColonneHeure[] = choix.colonnes
      await pointageDb.query(
        `UPDATE lst_horaire SET ${cols.map((c) => `${c} = ${s}`).join(', ')}
         WHERE id = ${ligne.id} AND is_deleted = 0 AND ${cols.map((c) => `${c} = 0`).join(' AND ')}`,
      )
      const relu = (await pointageDb.query<Record<string, unknown>>(
        `SELECT ${cols.join(', ')} FROM lst_horaire WHERE id = ${ligne.id}`,
      ))[0]
      if (!relu || cols.some((c) => Number(relu[c]) !== s)) {
        throw new RefusPointage('Le pointage a changé depuis l’affichage de l’écran.')
      }
      lstPointage = await secondaire('lst_pointage update', async () => {
        const id = await jumelle(salarie.id, ligne.debut)
        if (id === null) {
          console.warn(`[pointage] lst_pointage: no twin for lst_horaire ${ligne.id} (salarié ${salarie.id})`)
          return 'introuvable'
        }
        await pointageDb.query(`UPDATE lst_pointage SET ${cols.map((c) => `${c} = '${dt}'`).join(', ')} WHERE id = ${id}`)
        return 'ecrit'
      })
    }

    const mps: Issue = salarie.idMps > 0
      ? await secondaire('mps.pointage insert', async () => {
          const rows = await query<{ m: number | null }>('SELECT MAX(IDpointage) AS m FROM pointage')
          const id = (Number(rows[0]?.m) || 0) + 1
          await query(`INSERT INTO pointage VALUES (${id}, ${salarie.idMps}, '${dt}', ${choix.enPoste})`)
          return 'ecrit'
        })
      : 'sans_lien'

    return { action, instantMs: s * 1000, ligneId, lstPointage, mps }
  })
}

/** The day's « temps hors prod » (COMBO_Temps_hors_prod_du_jour), in hours. */
export function definirHorsProd(salarie: Salarie, duree: number, maintenantMs = Date.now()): Promise<void> {
  return verrou.run(() => assurerHorsProd(salarie.id, jourParis(maintenantMs), duree))
}
