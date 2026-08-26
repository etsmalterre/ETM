// `retour_client` data layer — the table TRM's Qualité › Retour client screen
// sits on, and the row ETM creates when it sends a FNC to Tricotage Malterre.
//
// It lives in lib/ rather than inside routes/retours-client-trm.ts because BOTH
// routers write it: the TRM one for the screen's own edits, and ETM's
// dossiers-qualite.ts when the responsable qualité hands a non-conformity over.
// Keeping it here is what stops those two route files importing each other in a
// cycle, and keeps RC_COLUMNS — the physical column order the Linux positional
// rewrite depends on — in exactly one place.
//
// Table facts (verified by scripts/probe-retour-client-trm.ts):
//  - no IDsociete column: the object is TRM's by nature.
//  - `archivé` is the only accented column, and it is the En cours / Terminé
//    flag: 0 = en cours, 1 = terminé.
//  - `DATE` is a reserved word — it comes back uppercased and is written as
//    `DATE` in every named statement.
//  - `impact_prime` and `defaut` are dead (0 / empty on the whole table).
//  - no memo-BINARY column, so `SELECT *` is safe on the Windows ODBC driver.

import { query, queryB64Text, fixEncoding } from './hfsql-auto.js'
import { esc, n, IS_WINDOWS } from './sst-shared.js'

/** SQL literal for user text. Pure ASCII → quoted; accented → Latin-1 hex
 *  literal (raw multi-byte UTF-8 in a SQL line corrupts the Linux bridge). */
export function rcSqlText(value: string | null | undefined): string {
  const v = (value ?? '').toString()
  if (v === '') return "''"
  if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(v)) return `'${esc(v)}'`
  const ascii = v
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ | /g, ' ')
  const bytes = Buffer.from(
    Array.from(ascii, (ch) => {
      const c = ch.codePointAt(0) ?? 0x3f
      return c <= 0xff ? c : 0x3f
    }),
  )
  return `x'${bytes.toString('hex')}'`
}

/** '20260220' | '' — HFSQL stores dates as 8-char strings. */
export function rcDateDigits8(value: unknown): string {
  const s = (value ?? '').toString().replace(/\D/g, '')
  return s.length === 8 ? s : ''
}

export function rcTrim(v: unknown): string {
  return (v ?? '').toString().trim()
}

export function rcToday(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** `archivé` → `archiv` — the Linux driver truncates an accented column name at
 *  its first non-ASCII char, in the returned key as well as in SQL text. */
function accentTrunc(name: string): string {
  const m = name.match(/[^\x00-\x7F]/)
  return m && m.index !== undefined ? name.slice(0, m.index) : name
}

/** Read a column by its real name, its accent-truncated twin, or a
 *  case-insensitive match (reserved words like DATE come back uppercased). */
export function rcReadCol(row: Record<string, unknown>, name: string): unknown {
  if (name in row) return row[name]
  const t = accentTrunc(name)
  if (t !== name && t in row) return row[t]
  const lower = name.toLowerCase()
  const tLower = t.toLowerCase()
  for (const k of Object.keys(row)) {
    const kl = k.toLowerCase()
    if (kl === lower || kl === tLower) return row[k]
  }
  return undefined
}

// ── Physical column order ────────────────────────────────
// The RUNTIME `SELECT *` order, which the positional INSERT/rewrite on Linux
// depends on. It differs from the MPS.xdd analysis listing — the same trap that
// once bit controle_titrage. probe-retour-client-trm.ts §2 re-asserts it.
export const RC_COLUMNS = [
  'IDretour_client',
  'message_client',
  'reponse',
  'impact_prime',
  'IDclient',
  'DATE',
  'Type_Reference',
  'reference',
  'archivé',
  'defaut',
  'IDdossier_qualite',
  'IDdefaut_textile',
  'journal',
  'message_resp_atelier',
  'IDresolution_qualite',
  'IDbonnetier',
  'IDmachine',
] as const

/** Columns emitted as SQL text literals; everything else is numeric. */
const RC_TEXT_COLUMNS = new Set<string>([
  'message_client', 'reponse', 'DATE', 'Type_Reference', 'reference',
  'defaut', 'journal', 'message_resp_atelier',
])

const RC_TEXT_FIELDS_FOR_REPAIR = [
  'message_client', 'reponse', 'Type_Reference', 'reference', 'defaut',
  'journal', 'message_resp_atelier',
]

/** Emit one positional value for a retour_client column. */
export function rcLiteral(column: string, value: unknown): string {
  if (RC_TEXT_COLUMNS.has(column)) return rcSqlText(value == null ? '' : value.toString())
  if (column === 'impact_prime') return String(Number(value) || 0)
  return String(n(value))
}

/** SELECT * with clean text on both platforms. */
export async function selectRetourRows(tail: string): Promise<Record<string, unknown>[]> {
  const sql = `SELECT * FROM retour_client ${tail}`
  if (IS_WINDOWS) {
    const rows = await query<Record<string, unknown>>(sql)
    return fixEncoding(rows, 'retour_client', 'IDretour_client', RC_TEXT_FIELDS_FOR_REPAIR)
  }
  return queryB64Text<Record<string, unknown>>(sql)
}

// ── Row shape ────────────────────────────────────────────

export interface RetourRow {
  IDretour_client: number
  IDclient: number
  date: string | null
  IDdefaut_textile: number
  /** Legacy free-text copy of the defect label — dead (empty on 90/91). */
  defaut_legacy: string
  message_client: string
  message_resp_atelier: string
  reponse: string
  type_reference: string
  reference: string
  /** Dead — 0 on every row, no input in the legacy window. Printed anyway. */
  impact_prime: number
  archive: 0 | 1
  IDdossier_qualite: number
  journal: string
  IDresolution_qualite: number
  IDbonnetier: number
  IDmachine: number
}

export function normalizeRetour(raw: Record<string, unknown>): RetourRow {
  const d = rcDateDigits8(rcReadCol(raw, 'DATE'))
  return {
    IDretour_client: n(rcReadCol(raw, 'IDretour_client')),
    IDclient: n(rcReadCol(raw, 'IDclient')),
    date: d || null,
    IDdefaut_textile: n(rcReadCol(raw, 'IDdefaut_textile')),
    defaut_legacy: rcTrim(rcReadCol(raw, 'defaut')),
    message_client: (rcReadCol(raw, 'message_client') ?? '').toString(),
    message_resp_atelier: (rcReadCol(raw, 'message_resp_atelier') ?? '').toString(),
    reponse: (rcReadCol(raw, 'reponse') ?? '').toString(),
    type_reference: rcTrim(rcReadCol(raw, 'Type_Reference')),
    reference: rcTrim(rcReadCol(raw, 'reference')),
    impact_prime: Number(rcReadCol(raw, 'impact_prime')) || 0,
    archive: n(rcReadCol(raw, 'archivé')) === 1 ? 1 : 0,
    IDdossier_qualite: n(rcReadCol(raw, 'IDdossier_qualite')),
    journal: (rcReadCol(raw, 'journal') ?? '').toString(),
    IDresolution_qualite: n(rcReadCol(raw, 'IDresolution_qualite')),
    IDbonnetier: n(rcReadCol(raw, 'IDbonnetier')),
    IDmachine: n(rcReadCol(raw, 'IDmachine')),
  }
}

export async function readRetour(id: number): Promise<RetourRow | null> {
  const rows = await selectRetourRows(`WHERE IDretour_client = ${id}`)
  return rows[0] ? normalizeRetour(rows[0]) : null
}

// ── Writes ───────────────────────────────────────────────

export interface RetourSeed {
  IDclient: number
  IDdefaut_textile: number
  date: string
  message_client?: string
  type_reference?: string
  reference?: string
  IDdossier_qualite?: number
}

/** INSERT one retour_client and return its id. The PK is self-assigned MAX+1
 *  because the Linux path has to be positional: neither the accented `archivé`
 *  nor the reserved `DATE` can be named there. */
export async function insertRetour(seed: RetourSeed): Promise<number> {
  const maxRows = await query<{ id: number }>(`SELECT MAX(IDretour_client) AS id FROM retour_client`)
  const newId = n(maxRows[0]?.id) + 1

  const values: Record<string, unknown> = {
    IDretour_client: newId,
    message_client: seed.message_client ?? '',
    reponse: '',
    impact_prime: 0,
    IDclient: seed.IDclient,
    DATE: rcDateDigits8(seed.date) || rcToday(),
    Type_Reference: seed.type_reference ?? '',
    reference: seed.reference ?? '',
    'archivé': 0,
    defaut: '',
    IDdossier_qualite: seed.IDdossier_qualite ?? 0,
    IDdefaut_textile: seed.IDdefaut_textile,
    journal: '',
    message_resp_atelier: '',
    IDresolution_qualite: 0,
    IDbonnetier: 0,
    IDmachine: 0,
  }
  const literals = RC_COLUMNS.map((c) => rcLiteral(c, values[c])).join(', ')

  if (IS_WINDOWS) {
    await query(`INSERT INTO retour_client (${RC_COLUMNS.join(', ')}) VALUES (${literals})`)
  } else {
    await query(`INSERT INTO retour_client VALUES (${literals})`)
  }
  return newId
}

/**
 * Write the accented `archivé` flag. Windows names it directly; the Linux
 * bridge cannot, so the whole row is re-inserted positionally under the same
 * PK. Best-effort restore if the re-insert fails, so an interrupted toggle
 * cannot lose a dossier. (Same shape as patchAccented() in dossiers-qualite.ts,
 * which has to do it for four columns — here there is exactly one.)
 */
export async function patchArchive(id: number, archive: 0 | 1): Promise<void> {
  if (IS_WINDOWS) {
    await query(`UPDATE retour_client SET archivé = ${archive} WHERE IDretour_client = ${id}`)
    return
  }
  const rows = await selectRetourRows(`WHERE IDretour_client = ${id}`)
  const original = rows[0]
  if (!original) throw new Error(`retour_client ${id} disappeared before rewrite`)

  const values: Record<string, unknown> = {}
  for (const col of RC_COLUMNS) values[col] = rcReadCol(original, col)
  values['archivé'] = archive

  const literals = RC_COLUMNS.map((c) => rcLiteral(c, values[c]))
  const restore = RC_COLUMNS.map((c) => rcLiteral(c, rcReadCol(original, c)))

  await query(`DELETE FROM retour_client WHERE IDretour_client = ${id}`)
  try {
    await query(`INSERT INTO retour_client VALUES (${literals.join(', ')})`)
  } catch (err) {
    try {
      await query(`DELETE FROM retour_client WHERE IDretour_client = ${id}`)
      await query(`INSERT INTO retour_client VALUES (${restore.join(', ')})`)
    } catch {
      console.error(`[retour-client-trm] FAILED to restore retour ${id} after rewrite error`)
    }
    throw err
  }
}

// ── The FNC handover (ETM → TRM) ─────────────────────────

export const TRM_SOCIETE = 2

/** The retour already opened for an ETM dossier, if any. */
export async function findRetourForDossier(dossierId: number): Promise<number> {
  if (!Number.isInteger(dossierId) || dossierId <= 0) return 0
  const rows = await query<any>(
    `SELECT IDretour_client FROM retour_client WHERE IDdossier_qualite = ${dossierId} ORDER BY IDretour_client LIMIT 1`,
  )
  return n((rows as any[])[0]?.IDretour_client)
}

/**
 * TRM's own client row standing for the company issuing the FNC.
 *
 * The asymmetry that makes this necessary: `dossier_qualite.IDclient` names
 * ETM's END client (the one who actually complained — LEMAHIEU, Cocorico…),
 * while `retour_client.IDclient` names TRM's client, which is Ets Malterre
 * itself. Resolved by name against the `societe` row rather than hardcoding
 * the id, and it raises rather than guessing: a silent fallback would file the
 * complaint under whichever client happens to be id 1.
 */
export async function resolveTrmClientForSociete(idSociete: number): Promise<number> {
  const socRows = await fixEncoding(
    await query<any>(`SELECT IDsociete, nom FROM societe WHERE IDsociete = ${n(idSociete)}`),
    'societe', 'IDsociete', ['nom'],
  )
  const nom = rcTrim((socRows as any[])[0]?.nom)
  if (nom === '') throw new Error(`societe ${idSociete} introuvable`)

  const clientRows = await fixEncoding(
    await query<any>(`SELECT IDclient, nom FROM client WHERE IDsociete = ${TRM_SOCIETE}`),
    'client', 'IDclient', ['nom'],
  )
  const wanted = nom.toLowerCase()
  const hit = (clientRows as any[]).find((c) => rcTrim(c.nom).toLowerCase() === wanted)
  if (!hit) throw new Error(`client « ${nom} » absent du registre Tricotage Malterre`)
  return n(hit.IDclient)
}

export interface FncHandoverSeed {
  IDdossier_qualite: number
  /** dossier_qualite.messageFNC — copied verbatim into message_client. */
  message_fnc: string
  IDdefaut_textile: number
  type_reference: string
  reference: string
  /** envoiFNC (YYYYMMDD) — becomes the retour's DATE. */
  date: string
  /** The société ISSUING the FNC (1 = Ets Malterre). */
  IDsociete_emettrice: number
}

/**
 * Open the TRM side of a FNC — the legacy « Voulez-vous envoyer cette FNC a
 * TRM ? ». Idempotent: a dossier already handed over returns its existing
 * retour untouched, so re-sending the FNC by email never duplicates the
 * atelier's dossier.
 *
 * Only the answer travels back afterwards (dossier_qualite.reponseFNC). The
 * affectation is seeded here and then belongs to TRM: on live data the atelier
 * re-points it on 13 of 91 dossiers, because it finds the roll ETM meant rather
 * than the one ETM named.
 */
export async function createRetourFromFnc(
  seed: FncHandoverSeed,
): Promise<{ IDretour_client: number; created: boolean }> {
  const existing = await findRetourForDossier(seed.IDdossier_qualite)
  if (existing > 0) return { IDretour_client: existing, created: false }

  const IDclient = await resolveTrmClientForSociete(seed.IDsociete_emettrice)
  const IDretour_client = await insertRetour({
    IDclient,
    IDdefaut_textile: seed.IDdefaut_textile,
    date: seed.date,
    message_client: seed.message_fnc,
    type_reference: seed.type_reference,
    reference: seed.reference,
    IDdossier_qualite: seed.IDdossier_qualite,
  })
  return { IDretour_client, created: true }
}
