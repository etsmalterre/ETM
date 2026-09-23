import { query, fixEncoding, queryB64Text } from './hfsql-auto.js'
import { sqlText } from './clients-common.js'
import { IS_WINDOWS } from './sst-shared.js'
import { refFiniReferenceLock, freeRefFiniReference } from './ref-fini-reference.js'

/**
 * « Dupliquer » on Finis › Références (LIVA #1186) — the legacy BTN_Dupliquer of
 * FI_Ref_Fini, ported: the whole ref_fini row is copied under a new PK with the
 * reference suffixed « (copie) », fresh dates and archivé = 0, then the
 * treatments (traitement_ref_fini) follow. The dyed coloris (ref_fini_colori)
 * are NOT copied — the legacy didn't either, and a new reference gets its own.
 *
 * Why a whole-row copy and not the fiche's SET list: the fiche cannot write
 * avec_teinture / IDcolori_ecru (they drive the coloris catalog and pricing) nor
 * the accented catalogue_privé, and a copy missing any of them is a different
 * product. Three column NAMES are accented (dateCréation, archivé,
 * catalogue_privé), which the Linux bridge cannot name — so the INSERT is
 * positional there, in the runtime `SELECT *` order of the very row it read
 * (the only order a positional INSERT accepts, CLAUDE.md § HFSQL). Windows names
 * every column. Either way the PK is explicit MAX+1: a positional INSERT does
 * not auto-assign it.
 */

/** ref_fini columns holding text (or a date/datetime written as text). Every
 *  other column is numeric. Matched on the lower-cased key; the accented date
 *  column is matched by prefix because Linux truncates it (`dateCr…`). */
const TEXT_COLUMNS = new Set([
  'reference', 'designation', 'observations', 'conditionnement', 'responsable',
  'associee', 'description_commercial', 'observation_technique', 'datemodification',
])
const DATE_CREATION = /^datecr/i
const ARCHIVE = /^archiv/i
const CATALOGUE_PRIVE = /^catalogue_priv/i

function isTextColumn(key: string): boolean {
  return TEXT_COLUMNS.has(key.toLowerCase()) || DATE_CREATION.test(key)
}

/** The real (accented) column name for a key read off `SELECT *` — Windows
 *  returns it verbatim, but normalise anyway so the named INSERT never depends
 *  on how the driver spelled the key. */
export function refFiniColumnName(key: string): string {
  if (DATE_CREATION.test(key)) return 'dateCréation'
  if (ARCHIVE.test(key)) return 'archivé'
  if (CATALOGUE_PRIVE.test(key)) return 'catalogue_privé'
  return key
}

export interface CloneOverrides {
  newId: number
  reference: string
  /** HFSQL DATE, YYYYMMDD. */
  today: string
  /** HFSQL DATETIME, YYYYMMDDHHMMSS. */
  now: string
}

/**
 * Pure: turn a source `SELECT *` row into the clone's column names + SQL
 * literals, in the row's own key order. Throws instead of guessing when a
 * column it must override is missing or a numeric slot holds text — a
 * positional INSERT with a shifted or mistyped value writes garbage silently.
 */
export function cloneRefFiniRow(
  src: Record<string, unknown>,
  o: CloneOverrides,
): { columns: string[]; literals: string[] } {
  const keys = Object.keys(src)
  const overrides: Array<[(k: string) => boolean, unknown, string]> = [
    [(k) => k === 'IDref_fini', o.newId, 'IDref_fini'],
    [(k) => k === 'reference', o.reference, 'reference'],
    [(k) => DATE_CREATION.test(k), o.today, 'dateCréation'],
    [(k) => k.toLowerCase() === 'datemodification', o.now, 'dateModification'],
    [(k) => ARCHIVE.test(k), 0, 'archivé'],
  ]
  const values = keys.map((k) => src[k])
  for (const [match, value, label] of overrides) {
    const hits = keys.filter(match)
    if (hits.length !== 1) throw new Error(`ref_fini.${label}: ${hits.length} matching columns — refusing to clone`)
    values[keys.indexOf(hits[0])] = value
  }

  const literals = keys.map((k, i) => {
    const v = values[i]
    if (isTextColumn(k)) {
      if (v == null) return "''"
      const s = v instanceof ArrayBuffer ? Buffer.from(v).toString('latin1') : String(v)
      return sqlText(s)
    }
    if (v == null || v === '') return '0'
    const n = typeof v === 'bigint' ? v : Number(v)
    if (typeof n === 'number' && !Number.isFinite(n)) {
      throw new Error(`ref_fini.${k}: non-numeric value ${JSON.stringify(String(v))} — refusing to clone`)
    }
    return String(n)
  })
  return { columns: keys.map(refFiniColumnName), literals }
}

const pad = (x: number) => String(x).padStart(2, '0')
/** HFSQL DATE literal (YYYYMMDD) and DATETIME literal (YYYYMMDDHHMMSS), local time. */
function hfsqlToday(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}
function hfsqlNow(d: Date): string {
  return `${hfsqlToday(d)}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** Read one ref_fini row with faithful text on both platforms. */
async function readSourceRow(id: number): Promise<Record<string, unknown> | null> {
  const sql = `SELECT * FROM ref_fini WHERE IDref_fini = ${id}`
  if (IS_WINDOWS) {
    const rows = await query<Record<string, unknown>>(sql)
    if (rows.length === 0) return null
    const fixed = await fixEncoding(rows, 'ref_fini', 'IDref_fini', [
      'reference', 'designation', 'observations', 'conditionnement', 'responsable',
      'associee', 'description_commercial', 'observation_technique',
    ])
    return fixed[0]
  }
  const rows = await queryB64Text<Record<string, unknown>>(sql)
  return rows[0] ?? null
}

/** Duplicate a ref_fini + its treatments. Returns the new id, or null when the
 *  source does not exist. Runs under the reference lock: it both picks a free
 *  name and a MAX+1 PK, and two clicks landing together would agree on both. */
export function duplicateRefFini(id: number): Promise<number | null> {
  return refFiniReferenceLock.run(() => duplicateRefFiniUnlocked(id))
}

async function duplicateRefFiniUnlocked(id: number): Promise<number | null> {
  const src = await readSourceRow(id)
  if (!src) return null

  const base = String(src.reference ?? '').trim() || 'Référence'
  const reference = await freeRefFiniReference(base, true)
  const maxRows = await query<{ m: number | null }>(`SELECT MAX(IDref_fini) AS m FROM ref_fini`)
  const newId = (Number(maxRows[0]?.m) || 0) + 1

  const { columns, literals } = cloneRefFiniRow(src, {
    newId,
    reference,
    today: hfsqlToday(new Date()),
    now: hfsqlNow(new Date()),
  })
  if (IS_WINDOWS) {
    await query(`INSERT INTO ref_fini (${columns.join(', ')}) VALUES (${literals.join(', ')})`)
  } else {
    await query(`INSERT INTO ref_fini VALUES (${literals.join(', ')})`)
  }

  const traitements = await query<{ IDtraitement: number }>(
    `SELECT IDtraitement FROM traitement_ref_fini WHERE IDref_fini = ${id}`,
  )
  for (const t of new Set(traitements.map((r) => Number(r.IDtraitement)).filter((x) => x > 0))) {
    await query(`INSERT INTO traitement_ref_fini (IDref_fini, IDtraitement) VALUES (${newId}, ${t})`)
  }
  return newId
}
