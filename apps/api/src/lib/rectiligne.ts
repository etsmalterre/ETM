import { query, queryB64Text, fixEncoding } from './hfsql-auto.js'
import { batchRepair } from './batch-repair.js'
import { pickVal } from './accented-keys.js'
import { sqlText } from './clients-common.js'
import { IS_WINDOWS } from './sst-shared.js'
import { createSerialLock } from './serial-lock.js'
import { referenceKey } from './ref-fini-reference.js'
import { LINE_TYPE_RECTILIGNE } from './sst-line-kind.js'

/**
 * Rectiligne — the cols and bandes Tricotage Malterre knits on its flat-bed
 * machine (LIVA #1185, port of the legacy FI_Ref_TombéMetier « Rectiligne »
 * mode, FEN_Gestion_Guide_Fil and FEN_Gestion_Coloris_Guide_Fil).
 *
 *   ref_rectiligne       one reference (R006-38 « col 38x9 cm BIO »): programme,
 *                        nb aiguilles, prix per piece, unité, commentaire, archivé
 *   guide_fil_rectiligne the yarn guides of a « montage » (one threading of the
 *                        machine): ref_fil, nb_fil, pourcentage stored 0–1
 *   coloris_rectiligne   a coloris of the reference (free text name)
 *   coloris_guide_fil    the colori_fil each guide carries for that coloris
 *
 * `stock_rectiligne` exists in the analysis but the legacy never wrote it
 * (0 rows) — deliberately not ported (decision 2026-09-23).
 *
 * HFSQL: `ref_rectiligne.archivé` is the only accented column name. It is
 * never NAMED on Linux — reads resolve it by prefix, inserts leave it out
 * (zero-fill) and the archive flip rewrites the row positionally in its own
 * `SELECT *` key order (see archiveRewrite). Every other column is ASCII.
 */

// ── Pure rules ───────────────────────────────────────────

export interface RefRectiligne {
  IDref_rectiligne: number
  reference: string
  designation: string
  programme: string
  nb_aiguilles: number
  prix: number
  unite: number
  commentaire: string
  archive: 0 | 1
}

const ARCHIVE_KEY = /^archiv/i

const str = (v: unknown): string => (v == null ? '' : String(v))
const num = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

/** ASCII-keyed shape of a `SELECT *` row (archivé read by prefix). */
export function normalizeRefRectiligne(row: Record<string, unknown>): RefRectiligne {
  return {
    IDref_rectiligne: num(row.IDref_rectiligne),
    reference: str(row.reference).trim(),
    designation: str(row.designation),
    programme: str(row.programme),
    nb_aiguilles: num(row.nb_aiguilles),
    prix: num(row.prix),
    unite: num(row.unite),
    commentaire: str(row.commentaire),
    archive: num(pickVal(row, ARCHIVE_KEY)) ? 1 : 0,
  }
}

/**
 * Next reference of the R + 3 digits series. The legacy took the max over
 * `^R\d{3}$` only, which ignores every size variant (R006-38, R009-44…): in
 * prod it would answer R008 while R008-40 exists and R010-38 is the highest.
 * The series number is the three digits after the R whatever follows them.
 */
export function nextRectiligneReference(existing: string[]): string {
  const used = new Set(existing.map((r) => referenceKey(r)))
  let max = 0
  for (const r of existing) {
    const m = /^R(\d{3})/i.exec(r.trim())
    if (m) max = Math.max(max, Number(m[1]))
  }
  let n = max + 1
  let candidate = `R${String(n).padStart(3, '0')}`
  while (used.has(referenceKey(candidate))) {
    n += 1
    candidate = `R${String(n).padStart(3, '0')}`
  }
  return candidate
}

/** « R006-38 (copie) », « R006-38 (copie 2) »… — first name nobody uses. */
export function duplicateReference(base: string, existing: string[]): string {
  const used = new Set(existing.map((r) => referenceKey(r)))
  const b = base.trim() || 'R'
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? `${b} (copie)` : `${b} (copie ${n})`
    if (!used.has(referenceKey(candidate))) return candidate
  }
  throw new Error(`No free ref_rectiligne reference for « ${b} »`)
}

/** pourcentage is stored as a 0–1 real4 (0.995); the screen speaks percent. */
export function pctFromStored(stored: unknown): number {
  return Math.round(num(stored) * 100 * 100) / 100
}
export function pctToStored(pct: number): number {
  return Math.round(pct * 100) / 10000
}

export interface GuideRow {
  IDguide_fil_rectiligne: number
  IDref_fil: number
  nb_fil: number
  pourcentage: number
  montage: number
}

/** Distinct montage numbers of a reference, ascending. */
export function montagesOf(guides: Pick<GuideRow, 'montage'>[]): number[] {
  return Array.from(new Set(guides.map((g) => num(g.montage)))).sort((a, b) => a - b)
}

/** Legacy « + montage »: MAX(montage) + 1 (1 on a reference without guides). */
export function nextMontage(guides: Pick<GuideRow, 'montage'>[]): number {
  return guides.reduce((m, g) => Math.max(m, num(g.montage)), 0) + 1
}

/** The legacy refused to create or edit a coloris while a guide of the montage
 *  had no fil (« Vous devez choisir tout les fils des guides fil avant de
 *  créer un coloris ») — a coloris is one colori_fil per guide. */
export function montageReadyForColoris(guides: Pick<GuideRow, 'IDref_fil'>[]): boolean {
  return guides.length > 0 && guides.every((g) => num(g.IDref_fil) > 0)
}

/** One guide of a coloris composition, with labels. */
export interface GuideLabel {
  nb_fil: number
  /** percent (99.5), not the stored fraction */
  pct: number
  fil: string
  colori: string
}

/** « 2 fils 1/30 COTON BIO noir 5685 99,5 % + 1 fil ELASTHANNE 0,5 % » — the
 *  yarn line printed under a rectiligne line on the bon de commande. */
export function formatGuideComposition(guides: GuideLabel[]): string {
  const fmt = (x: number) => (Math.round(x * 100) / 100).toString().replace('.', ',')
  return guides
    .filter((g) => g.fil.trim() !== '')
    .map((g) => {
      const n = Math.max(1, Math.round(g.nb_fil || 1))
      const parts = [`${n} ${n > 1 ? 'fils' : 'fil'} ${g.fil.trim()}`]
      if (g.colori.trim()) parts.push(g.colori.trim())
      if (g.pct > 0) parts.push(`${fmt(g.pct)} %`)
      return parts.join(' ')
    })
    .join(' + ')
}

/**
 * The Linux archive flip: `archivé` cannot be named, so the row is deleted and
 * re-inserted positionally with the SAME PK, in the key order of the row just
 * read (the only order a positional INSERT accepts — CLAUDE.md § HFSQL: the
 * .xdd order is not the runtime order). Throws instead of guessing when the
 * archive key is missing or a numeric slot holds text.
 */
const TEXT_COLUMNS = new Set(['reference', 'designation', 'programme', 'commentaire'])
export function archiveRewrite(row: Record<string, unknown>, value: 0 | 1): string[] {
  const keys = Object.keys(row)
  const archiveKeys = keys.filter((k) => ARCHIVE_KEY.test(k))
  if (archiveKeys.length !== 1) throw new Error(`ref_rectiligne.archivé: ${archiveKeys.length} matching columns — refusing to rewrite`)
  return keys.map((k) => {
    const v = ARCHIVE_KEY.test(k) ? value : row[k]
    if (TEXT_COLUMNS.has(k)) {
      if (v == null) return "''"
      return sqlText(v instanceof ArrayBuffer ? Buffer.from(v).toString('latin1') : String(v))
    }
    if (v == null || v === '') return '0'
    const x = Number(v)
    if (!Number.isFinite(x)) throw new Error(`ref_rectiligne.${k}: non-numeric ${JSON.stringify(String(v))} — refusing to rewrite`)
    return String(x)
  })
}

// ── Catalog I/O ──────────────────────────────────────────

/** Every write that picks a reference name or a MAX+1 runs under this lock
 *  (no unique index on the bridge side, no transactions — lib/serial-lock.ts). */
export const rectiligneLock = createSerialLock()

/** One ref_rectiligne row with faithful text on both platforms. */
export async function readRefRectiligneRow(id: number): Promise<Record<string, unknown> | null> {
  const sql = `SELECT * FROM ref_rectiligne WHERE IDref_rectiligne = ${id}`
  if (IS_WINDOWS) {
    const rows = await query<Record<string, unknown>>(sql)
    if (rows.length === 0) return null
    const fixed = await fixEncoding(rows, 'ref_rectiligne', 'IDref_rectiligne', ['reference', 'designation', 'programme', 'commentaire'])
    return fixed[0]
  }
  const rows = await queryB64Text<Record<string, unknown>>(sql)
  return rows[0] ?? null
}

/** Every reference (list screen, pickers, uniqueness). 33 rows in prod. */
export async function loadAllRefRectiligne(): Promise<RefRectiligne[]> {
  const rows = await query<Record<string, unknown>>(`SELECT * FROM ref_rectiligne ORDER BY reference`)
  const fixed = await batchRepair(rows, 'ref_rectiligne', 'IDref_rectiligne', ['reference', 'designation', 'programme'])
  return fixed.map(normalizeRefRectiligne)
}

/** Is `reference` used by another row? Same rule as ref_fini (#1186): trimmed,
 *  case- and accent-insensitive, compared in JS. Call under rectiligneLock. */
export async function rectiligneReferenceTaken(reference: string, exceptId = 0): Promise<boolean> {
  const key = referenceKey(reference)
  return (await loadAllRefRectiligne()).some((r) => r.IDref_rectiligne !== exceptId && referenceKey(r.reference) === key)
}

/** Flip archivé (Windows: named UPDATE; Linux: positional rewrite). */
export async function setRectiligneArchive(id: number, value: 0 | 1): Promise<boolean> {
  if (IS_WINDOWS) {
    await query(`UPDATE ref_rectiligne SET archivé = ${value} WHERE IDref_rectiligne = ${id}`)
    return true
  }
  const row = await readRefRectiligneRow(id)
  if (!row) return false
  const literals = archiveRewrite(row, value)
  await query(`DELETE FROM ref_rectiligne WHERE IDref_rectiligne = ${id}`)
  await query(`INSERT INTO ref_rectiligne VALUES (${literals.join(', ')})`)
  return true
}

export interface RectiligneRefLabel {
  reference: string
  designation: string
  prix: number
  unite: number
}

/** Batched labels for the order screens (flat IN lookups, one repair pass). */
export async function loadRectiligneRefLabels(ids: number[]): Promise<Map<number, RectiligneRefLabel>> {
  const out = new Map<number, RectiligneRefLabel>()
  const uniq = Array.from(new Set(ids.filter((x) => x > 0)))
  if (uniq.length === 0) return out
  const rows = await query<{ IDref_rectiligne: number; reference: string | null; designation: string | null; prix: number | null; unite: number | null }>(
    `SELECT IDref_rectiligne, reference, designation, prix, unite FROM ref_rectiligne WHERE IDref_rectiligne IN (${uniq.join(',')})`,
  )
  const fixed = await batchRepair(rows, 'ref_rectiligne', 'IDref_rectiligne', ['reference', 'designation'])
  for (const r of fixed) {
    out.set(Number(r.IDref_rectiligne), {
      reference: str(r.reference).trim(),
      designation: str(r.designation).trim(),
      prix: num(r.prix),
      unite: num(r.unite),
    })
  }
  return out
}

/** Batched coloris names (coloris_rectiligne.coloris). */
export async function loadRectiligneColorisLabels(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const uniq = Array.from(new Set(ids.filter((x) => x > 0)))
  if (uniq.length === 0) return out
  const rows = await query<{ IDcoloris_rectiligne: number; coloris: string | null }>(
    `SELECT IDcoloris_rectiligne, coloris FROM coloris_rectiligne WHERE IDcoloris_rectiligne IN (${uniq.join(',')})`,
  )
  const fixed = await batchRepair(rows, 'coloris_rectiligne', 'IDcoloris_rectiligne', ['coloris'])
  for (const r of fixed) out.set(Number(r.IDcoloris_rectiligne), str(r.coloris).trim())
  return out
}

/** Guides of one or more references (every montage). */
export async function loadGuides(refIds: number[]): Promise<Array<GuideRow & { IDref_rectiligne: number }>> {
  const uniq = Array.from(new Set(refIds.filter((x) => x > 0)))
  if (uniq.length === 0) return []
  const rows = await query<Record<string, unknown>>(
    `SELECT IDguide_fil_rectiligne, IDref_rectiligne, IDref_fil, nb_fil, pourcentage, montage
     FROM guide_fil_rectiligne WHERE IDref_rectiligne IN (${uniq.join(',')})
     ORDER BY IDref_rectiligne, montage, IDguide_fil_rectiligne`,
  )
  return rows.map((r) => ({
    IDguide_fil_rectiligne: num(r.IDguide_fil_rectiligne),
    IDref_rectiligne: num(r.IDref_rectiligne),
    IDref_fil: num(r.IDref_fil),
    nb_fil: num(r.nb_fil),
    pourcentage: num(r.pourcentage),
    montage: num(r.montage),
  }))
}

/** coloris_guide_fil rows of a set of coloris: coloris id → guide id → colori_fil id. */
export async function loadColorisGuideFils(colorisIds: number[]): Promise<Map<number, Map<number, number>>> {
  const out = new Map<number, Map<number, number>>()
  const uniq = Array.from(new Set(colorisIds.filter((x) => x > 0)))
  if (uniq.length === 0) return out
  const rows = await query<{ IDcoloris_rectiligne: number; IDguide_fil_rectiligne: number; IDcolori_fil: number }>(
    `SELECT IDcoloris_rectiligne, IDguide_fil_rectiligne, IDcolori_fil FROM coloris_guide_fil
     WHERE IDcoloris_rectiligne IN (${uniq.join(',')})`,
  )
  for (const r of rows) {
    const cid = num(r.IDcoloris_rectiligne)
    const m = out.get(cid) ?? new Map<number, number>()
    m.set(num(r.IDguide_fil_rectiligne), num(r.IDcolori_fil))
    out.set(cid, m)
  }
  return out
}

/** ref_fil / colori_fil labels, batched. */
export async function loadFilLabels(refFilIds: number[], coloriFilIds: number[]): Promise<{ fils: Map<number, string>; coloris: Map<number, string> }> {
  const fils = new Map<number, string>()
  const coloris = new Map<number, string>()
  const f = Array.from(new Set(refFilIds.filter((x) => x > 0)))
  const c = Array.from(new Set(coloriFilIds.filter((x) => x > 0)))
  const [fRows, cRows] = await Promise.all([
    f.length > 0
      ? query<{ IDref_fil: number; reference: string | null }>(`SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${f.join(',')})`)
      : Promise.resolve([]),
    c.length > 0
      ? query<{ IDcolori_fil: number; reference: string | null }>(`SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${c.join(',')})`)
      : Promise.resolve([]),
  ])
  for (const r of await batchRepair(fRows, 'ref_fil', 'IDref_fil', ['reference'])) fils.set(num(r.IDref_fil), str(r.reference).trim())
  for (const r of await batchRepair(cRows, 'colori_fil', 'IDcolori_fil', ['reference'])) coloris.set(num(r.IDcolori_fil), str(r.reference).trim())
  return { fils, coloris }
}

/**
 * The yarn line of one (reference, coloris) pair for the order documents:
 * the guides of the reference's first montage that the coloris covers (the
 * one every order used — prod has no montage 2), each with its colori_fil.
 * Returns '' when the reference has no guide.
 */
export async function loadCompositionLabels(
  pairs: Array<{ refId: number; colorisId: number }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const valid = pairs.filter((p) => p.refId > 0)
  if (valid.length === 0) return out
  const guides = await loadGuides(valid.map((p) => p.refId))
  const cgf = await loadColorisGuideFils(valid.map((p) => p.colorisId))
  const { fils, coloris } = await loadFilLabels(
    guides.map((g) => g.IDref_fil),
    Array.from(cgf.values()).flatMap((m) => Array.from(m.values())),
  )
  for (const p of valid) {
    const own = guides.filter((g) => g.IDref_rectiligne === p.refId)
    const mine = cgf.get(p.colorisId)
    const montage = montagesOf(own).find((m) => own.some((g) => g.montage === m && mine?.has(g.IDguide_fil_rectiligne)))
      ?? montagesOf(own)[0]
    const label = formatGuideComposition(
      own
        .filter((g) => g.montage === montage)
        .map((g) => ({
          nb_fil: g.nb_fil,
          pct: pctFromStored(g.pourcentage),
          fil: fils.get(g.IDref_fil) ?? '',
          colori: coloris.get(mine?.get(g.IDguide_fil_rectiligne) ?? 0) ?? '',
        })),
    )
    out.set(`${p.refId}:${p.colorisId}`, label)
  }
  return out
}

/** How many order lines (sst + TRM, type 4) point at a reference / coloris —
 *  the delete guard and the fiche's « utilisé par » card. */
export async function rectiligneUsage(opts: { refId?: number; colorisId?: number }): Promise<{ sst: number; trm: number }> {
  const where = opts.colorisId
    ? { sst: `IDColoris = ${opts.colorisId}`, trm: `IDcolori = ${opts.colorisId}` }
    : { sst: `IDreference = ${opts.refId ?? 0}`, trm: `IDreference = ${opts.refId ?? 0}` }
  const [s, t] = await Promise.all([
    query<{ n: number }>(`SELECT COUNT(*) AS n FROM ligne_commande_sous_traitant WHERE TYPE = ${LINE_TYPE_RECTILIGNE} AND ${where.sst}`),
    // Only TRM-native lines: a mirror line is already counted on the sst side.
    query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ligne_commande_client WHERE TYPE = ${LINE_TYPE_RECTILIGNE} AND ${where.trm}
       AND (IDligne_commande_ETM IS NULL OR IDligne_commande_ETM = 0)`,
    ),
  ])
  return { sst: num(s[0]?.n), trm: num(t[0]?.n) }
}
