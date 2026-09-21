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

// ── Admin Pointage (TRM menu « Pointage ») — the office's reads ──
// Plan ~/.claude/plans/admin-pointage.md § 7: the legacy grids and dialogs.

export interface SalarieComplet extends Salarie {
  /** 3-character badge code, unique across every row (deleted included). */
  login: string
  /** « Compte dans le ratio de production » (FEN_Ratio_de_production). */
  useInRatio: boolean
}

/** Every `lst_salarie` row with the admin fields, sorted like the grid. */
export async function tousLesSalariesComplets(): Promise<SalarieComplet[]> {
  const raw = await pointageDb.query<Record<string, unknown>>(
    'SELECT id, nom, prenom, login, is_deleted, id_mps, useInRatio FROM lst_salarie',
  )
  const rows = await pointageDb.fixEncoding(raw, 'lst_salarie', 'id', ['nom', 'prenom'])
  return rows
    .map((r) => ({
      id: num(r.id),
      nom: txt(r.nom),
      prenom: txt(r.prenom),
      idMps: num(r.id_mps),
      supprime: num(r.is_deleted) !== 0,
      login: txt(r.login).toUpperCase(),
      useInRatio: num(r[cle(r, 'useInRatio')]) !== 0,
    }))
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr') || a.prenom.localeCompare(b.prenom, 'fr'))
}

export async function trouverSalarieMemeSupprime(id: number): Promise<SalarieComplet | null> {
  return (await tousLesSalariesComplets()).find((s) => s.id === id) ?? null
}

/** FEN_Nouveau_salarié's check: the login is taken when ANY row carries it,
 *  deleted rows included (it is a unique key in the analysis). */
export async function loginPris(login: string, saufId = 0): Promise<boolean> {
  const rows = await pointageDb.query<Record<string, unknown>>(
    `SELECT id FROM lst_salarie WHERE login = '${login.replace(/'/g, "''")}'`,
  )
  return rows.some((r) => num(r.id) !== saufId)
}

/** The shifts of a period (`DATE` = the shift's day, night shifts included on
 *  their evening), newest first — FEN_Horaires_1$Requête with the period
 *  filter the legacy never had (it listed the whole history). */
export async function lignesPeriode(du: string, au: string, idSalarie = 0): Promise<LigneHoraire[]> {
  const rows = await pointageDb.query<Record<string, unknown>>(
    `SELECT ${COLONNES_LIGNE} FROM lst_horaire
     WHERE DATE >= '${du}' AND DATE <= '${au}' AND is_deleted = 0${idSalarie > 0 ? ` AND id_salarie = ${idSalarie}` : ''}`,
  )
  return rows.map(versLigne).sort(plusRecente)
}

export async function trouverLigne(id: number): Promise<LigneHoraire | null> {
  const rows = await pointageDb.query<Record<string, unknown>>(
    `SELECT ${COLONNES_LIGNE} FROM lst_horaire WHERE id = ${id} AND is_deleted = 0`,
  )
  return rows.length ? versLigne(rows[0]) : null
}

export interface MessageSalarie {
  id: number
  idSalarie: number
  /** Plain text (the legacy stored HTML; stripped here, see texteMessage). */
  texte: string
  /** `YYYYMMDD` — last day the tablet shows it. */
  dateFin: string
}

/** A DATE read back in either driver shape, as `YYYYMMDD`. */
function jourDe(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '').slice(0, 8)
}

function versMessage(r: Record<string, unknown>): MessageSalarie {
  const k = cle(r, 'message')
  return { id: num(r.id), idSalarie: num(r.id_salarie), texte: texteMessage(txt(r[k])), dateFin: jourDe(r.date_fin) }
}

/** Every message of a salarié still on file, expired ones included (the
 *  legacy list had no date filter), newest end date first. */
export async function messagesDuSalarie(idSalarie: number): Promise<MessageSalarie[]> {
  const raw = await pointageDb.query<Record<string, unknown>>(
    `SELECT id, id_salarie, MESSAGE, date_fin FROM lst_message WHERE is_deleted = 0 AND id_salarie = ${idSalarie}`,
  )
  const k = cle(raw[0], 'message')
  const rows = await pointageDb.fixEncoding(raw, 'lst_message', 'id', [k])
  return rows.map(versMessage).sort((a, b) => b.dateFin.localeCompare(a.dateFin) || b.id - a.id)
}

export async function trouverMessage(id: number): Promise<MessageSalarie | null> {
  const raw = await pointageDb.query<Record<string, unknown>>(
    `SELECT id, id_salarie, MESSAGE, date_fin FROM lst_message WHERE is_deleted = 0 AND id = ${id}`,
  )
  if (!raw.length) return null
  const k = cle(raw[0], 'message')
  const rows = await pointageDb.fixEncoding(raw, 'lst_message', 'id', [k])
  return versMessage(rows[0])
}
