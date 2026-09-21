/**
 * Reads of the legacy `pointage` database for the pointage PWA
 * (routes/pointage.ts). Every WRITE lives in lib/pointage-ecritures.ts.
 *
 * Always through `pointageDb` — the dev `mps` database carries stale copies of
 * lst_horaire / lst_salarie / hors_prod that the default client would read.
 */
import { pointageDb } from './hfsql-pointage.js'
import { COLONNES_HEURE, texteMessage, type LigneHoraire } from './pointage-etat.js'

export interface Salarie {
  id: number
  nom: string
  prenom: string
  /** `lst_salarie.id_mps` → `mps.bonnetier.IDbonnetier`; 0 = no link. */
  idMps: number
  supprime: boolean
}

const num = (v: unknown) => Number(v) || 0
const txt = (v: unknown) => String(v ?? '').trim()

/** The row's key for `name`, whatever case the driver returned it in
 *  (reserved words such as `DATE` and `MESSAGE` come back uppercased). */
function cle(row: Record<string, unknown> | undefined, name: string): string {
  return (row && Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase())) ?? name
}

/** Every salarié, deleted ones included (the day table names them too). */
export async function tousLesSalaries(): Promise<Salarie[]> {
  const raw = await pointageDb.query<Record<string, unknown>>(
    'SELECT id, nom, prenom, id_mps, is_deleted FROM lst_salarie',
  )
  const rows = await pointageDb.fixEncoding(raw, 'lst_salarie', 'id', ['nom', 'prenom'])
  return rows
    .map((r) => ({ id: num(r.id), nom: txt(r.nom), prenom: txt(r.prenom), idMps: num(r.id_mps), supprime: num(r.is_deleted) !== 0 }))
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr') || a.prenom.localeCompare(b.prenom, 'fr'))
}

/** The face grid: salariés not deleted in Admin Pointage. */
export async function listerSalaries(): Promise<Salarie[]> {
  return (await tousLesSalaries()).filter((s) => !s.supprime)
}

export async function trouverSalarie(id: number): Promise<Salarie | null> {
  return (await listerSalaries()).find((s) => s.id === id) ?? null
}

const COLONNES_LIGNE = `id, id_salarie, DATE AS jour, ${COLONNES_HEURE.join(', ')}`

function versLigne(r: Record<string, unknown>): LigneHoraire {
  const l = { id: num(r.id), idSalarie: num(r.id_salarie), jour: txt(r[cle(r, 'jour')]) } as LigneHoraire
  for (const c of COLONNES_HEURE) l[c] = num(r[c])
  return l
}

/** Newest first — the legacy key `sal_fin_del` reads the OLDEST open line,
 *  which is how its lst_pointage twin drifted; a salarié who restarted after a
 *  forgotten shift must continue the line he just opened. */
const plusRecente = (a: LigneHoraire, b: LigneHoraire) => b.debut - a.debut || b.id - a.id

export async function ligneOuverte(idSalarie: number): Promise<LigneHoraire | null> {
  const rows = await pointageDb.query<Record<string, unknown>>(
    `SELECT ${COLONNES_LIGNE} FROM lst_horaire WHERE id_salarie = ${idSalarie} AND fin = 0 AND is_deleted = 0`,
  )
  return rows.map(versLigne).sort(plusRecente)[0] ?? null
}

/** Every open line (`fin = 0`, not deleted), oldest arrival first — the rows
 *  of FEN_Pointage's TABLE_Pointage: who is at work or on a break right now,
 *  a shift forgotten on a previous day included. */
export async function lignesEnPoste(): Promise<LigneHoraire[]> {
  const rows = await pointageDb.query<Record<string, unknown>>(
    `SELECT ${COLONNES_LIGNE} FROM lst_horaire WHERE fin = 0 AND is_deleted = 0`,
  )
  return rows.map(versLigne).sort((a, b) => a.debut - b.debut || a.id - b.id)
}

/** The newest open line of every salarié. */
export async function lignesOuvertes(): Promise<Map<number, LigneHoraire>> {
  const out = new Map<number, LigneHoraire>()
  for (const l of (await lignesEnPoste()).sort(plusRecente)) if (!out.has(l.idSalarie)) out.set(l.idSalarie, l)
  return out
}

/** FEN_PointageSalarié's HTM_Message: `is_deleted = 0 AND id_salarie = X AND
 *  date_fin >= today`, as plain text. */
export async function messagesActifs(idSalarie: number, jour: string): Promise<{ id: number; texte: string }[]> {
  const raw = await pointageDb.query<Record<string, unknown>>(
    `SELECT id, MESSAGE FROM lst_message WHERE is_deleted = 0 AND id_salarie = ${idSalarie} AND date_fin >= '${jour}' ORDER BY id`,
  )
  const k = cle(raw[0], 'message')
  const rows = await pointageDb.fixEncoding(raw, 'lst_message', 'id', [k])
  return rows.map((r) => ({ id: num(r.id), texte: texteMessage(txt(r[k])) })).filter((m) => m.texte !== '')
}

export interface SoldeHeures {
  /** Minutes worked in the reference week (`lst_lissage.cumul_semaine`). */
  semaineMin: number
  /** Annual balance in minutes: worked − planned − yearly adjustment. */
  cumulMin: number
}

/**
 * FEN_PointageSalarié's « Semaine N : » and « Cumul » — window code and the three
 * queries given by Vincent (2026-09-15):
 *   - no `lst_lissage` row for (salarié, year, week, is_deleted = 0) → null, the
 *     legacy hides both fields;
 *   - semaine = that row's `cumul_semaine`;
 *   - cumul = REQ_lissage.total − REQ_prev.total − REQ_info_sal_annee.total:
 *       REQ_lissage         SUM(cumul_semaine) WHERE num_semaine <= week, year, salarié, not deleted
 *       REQ_prev            SUM(prev)          WHERE num_semaine <= week, year, salarié, not deleted
 *       REQ_info_sal_annee  SUM(info)          WHERE year, salarié, not deleted
 *   A SUM over no row is NULL, which WinDev reads as 0.
 */
export async function soldeHeures(
  idSalarie: number,
  semaine: { annee: number; numero: number } | null,
): Promise<SoldeHeures | null> {
  if (!semaine) return null
  const { annee, numero } = semaine
  const lissage = await pointageDb.query<Record<string, unknown>>(
    `SELECT id, cumul_semaine FROM lst_lissage
     WHERE id_salarie = ${idSalarie} AND annee = ${annee} AND num_semaine = ${numero} AND is_deleted = 0 ORDER BY id`,
  )
  if (lissage.length === 0) return null
  const total = async (sql: string) => num((await pointageDb.query<Record<string, unknown>>(sql))[0]?.total)
  const [travaille, prevu, info] = await Promise.all([
    total(`SELECT SUM(cumul_semaine) AS total FROM lst_lissage
           WHERE is_deleted = 0 AND num_semaine <= ${numero} AND id_salarie = ${idSalarie} AND annee = ${annee}`),
    total(`SELECT SUM(prev) AS total FROM lst_prev
           WHERE id_salarie = ${idSalarie} AND annee = ${annee} AND num_semaine <= ${numero} AND is_deleted = 0`),
    total(`SELECT SUM(info) AS total FROM lst_info_sal_annee
           WHERE annee = ${annee} AND id_salarie = ${idSalarie} AND is_deleted = 0`),
  ])
  return { semaineMin: num(lissage[0].cumul_semaine), cumulMin: travaille - prevu - info }
}
