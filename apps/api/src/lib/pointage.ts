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

/** The newest open line of every salarié. */
export async function lignesOuvertes(): Promise<Map<number, LigneHoraire>> {
  const rows = await pointageDb.query<Record<string, unknown>>(
    `SELECT ${COLONNES_LIGNE} FROM lst_horaire WHERE fin = 0 AND is_deleted = 0`,
  )
  const out = new Map<number, LigneHoraire>()
  for (const l of rows.map(versLigne).sort(plusRecente)) if (!out.has(l.idSalarie)) out.set(l.idSalarie, l)
  return out
}

/** Lines dated `depuisJour` (YYYYMMDD) or later. */
export async function lignesDepuis(depuisJour: string): Promise<LigneHoraire[]> {
  const rows = await pointageDb.query<Record<string, unknown>>(
    `SELECT ${COLONNES_LIGNE} FROM lst_horaire WHERE DATE >= '${depuisJour}' AND is_deleted = 0`,
  )
  return rows.map(versLigne)
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

/** The day's « temps hors prod » in hours, or null when no row exists. */
export async function horsProdDuJour(idSalarie: number, jour: string): Promise<number | null> {
  const rows = await pointageDb.query<Record<string, unknown>>(
    `SELECT id, duree FROM hors_prod WHERE id_salarie = ${idSalarie} AND DATE = '${jour}' ORDER BY id`,
  )
  return rows.length ? Number(rows[0].duree) || 0 : null
}
