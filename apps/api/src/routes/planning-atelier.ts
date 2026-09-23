import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { query, fixEncoding, queryB64Text } from '../lib/hfsql-auto.js'
import { PlanningAtelierPdf, type PlanningAtelierPdfData } from '../lib/pdf/PlanningAtelierPdf.js'

// Atelier planning (TRM knitting mill) — weekly bonnetier schedule + desiderata.
// Legacy: FI_Planning_Atelier.wdw / FEN_Desiderata.wdw in TRM mode.
//
// Tables:
//   planning_bonnetier  IDplanning_bonnetier, date_debut (DATETIME), date_fin (DATETIME), IDbonnetier
//                       — one row per bonnetier per worked day; the shift (Matin /
//                       Après-Midi / Nuit) is derived from the start hour, no équipe column.
//   bonnetier           accented columns `prénom` / `archivé` — same read/write rules as
//                       `prospect` (SELECT * + key folding; queryB64Text on the Linux bridge).
//                       Grid shows archivé = 0 AND regleur = 0 (regleurs are excluded, verified
//                       against the legacy screen).
//   desiderata          IDdesiderata, DATE (reserved word — comes back uppercased; 8-char
//                       YYYYMMDD), description, IDbonnetier, justifie, declare. Writes use a
//                       positional INSERT (self-assigned max+1 PK) so the reserved `date`
//                       column is never named.
//
// These tables are TRM-only (no IDsociete partitioning).

export const planningAtelierRouter: RouterType = Router()

import { IS_WINDOWS } from '../lib/sst-shared.js'

// ── Helpers ──────────────────────────────────────────────

function esc(value: string): string {
  return value.replace(/'/g, "''")
}

/** SQL literal for a user-supplied text value. Pure-ASCII → quoted literal;
 *  accented values → hex literal of their Latin-1 bytes (the Linux bridge
 *  corrupts raw multi-byte UTF-8 embedded in a SQL string). */
function sqlText(value: string | null | undefined): string {
  const v = (value ?? '').toString()
  if (v === '') return "''"
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(v)) return `'${esc(v)}'`
  return `x'${Buffer.from(v, 'latin1').toString('hex')}'`
}

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

/** Fold a column key: strip accents + lowercase (prénom → prenom). */
function foldKey(k: string): string {
  return k.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Case/accent-insensitive getter with a prefix fallback for the Linux
 *  bridge's accent-truncated keys (prénom → `pr`). Same shape as prospects.ts. */
function rawGet(raw: Record<string, unknown>, re: RegExp): unknown {
  for (const [k, v] of Object.entries(raw)) {
    if (re.test(k)) return v
  }
  return undefined
}

/** Normalize an HFSQL DATETIME value to `{ date: 'YYYY-MM-DD', time: 'HH:MM' }`.
 *  Windows ODBC returns 'YYYY-MM-DD HH:MM:SS.mmm'; the bridge may return the
 *  compact 'YYYYMMDDHHMMSS' — accept both. */
function splitDateTime(v: unknown): { date: string; time: string } | null {
  const s = String(v ?? '')
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/)
  if (!m) return null
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` }
}

/** Compact HFSQL DATETIME literal from 'YYYY-MM-DD' + 'HH:MM' (verified to
 *  round-trip on the live DB). */
function dtLiteral(date: string, time: string): string {
  return `'${date.replace(/-/g, '')}${time.replace(':', '')}00'`
}

/** Add `days` to a 'YYYY-MM-DD' string (UTC-safe, no DST drift). */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}$/

/** YYYYMMDD for desiderata / date columns. */
function ymd(date: string): string {
  return date.replace(/-/g, '')
}

// ── Bonnetiers ───────────────────────────────────────────

interface BonnetierRow {
  IDbonnetier: number
  prenom: string
  nom: string
  regleur: number
  archive: number
  IDrole_employe: number
}

// The `prénom` column key comes back in unpredictable shapes from the Linux
// bridge — `pr` (truncated), `pr�nom`, `pr?nom`, or worse — and the shape has
// been observed to CHANGE mid-process on the same connection (prod, 2026-07-06).
// Match any `pr…nom`-ish key (`preference` doesn't end in "nom" so it stays
// out), then fall back to the column physically before `nom` in the legacy
// table layout, which is always prénom whatever its key got mangled into.
let prenomKeyWarned = false
function bonnetierPrenom(raw: Record<string, unknown>): string {
  const direct = rawGet(raw, /^pr$|^pr.*nom$/i)
  if (direct !== undefined) return String(direct ?? '')
  const keys = Object.keys(raw)
  const i = keys.indexOf('nom')
  if (!prenomKeyWarned) {
    prenomKeyWarned = true
    console.warn(`[planning-atelier] prénom key unrecognizable, using positional fallback; keys=${keys.join(',')}`)
  }
  return i > 0 ? String(raw[keys[i - 1]] ?? '') : ''
}

function normalizeBonnetierRow(raw: Record<string, unknown>): BonnetierRow {
  return {
    IDbonnetier: n(raw.IDbonnetier),
    prenom: bonnetierPrenom(raw),
    nom: String(raw.nom ?? ''),
    regleur: n(raw.regleur),
    // `archivé` arrives as `archivé` (Windows) or truncated `archiv` (Linux).
    archive: n(rawGet(raw, /^archiv/i) ?? 0),
    IDrole_employe: n(raw.IDrole_employe),
  }
}

async function selectBonnetiers(): Promise<BonnetierRow[]> {
  // No WHERE on the accented `archivé` column — filter in JS on both platforms.
  const sql = 'SELECT * FROM bonnetier'
  if (IS_WINDOWS) {
    const rows = await query<Record<string, unknown>>(sql)
    const fixed = await fixEncoding(rows, 'bonnetier', 'IDbonnetier', ['prénom', 'nom'])
    return fixed.map(normalizeBonnetierRow)
  }
  const rows = await queryB64Text<Record<string, unknown>>(sql)
  return rows.map(normalizeBonnetierRow)
}

// GET /api/planning-atelier/bonnetiers — active grid rows (archivé=0, regleur=0).
// ?all=1 additionally returns active regleurs (for future screens).
planningAtelierRouter.get('/bonnetiers', async (req: Request, res: Response) => {
  try {
    const all = req.query.all === '1'
    const rows = (await selectBonnetiers())
      .filter((b) => b.archive === 0 && (all || b.regleur === 0))
      .sort((a, b) => a.prenom.localeCompare(b.prenom, 'fr'))
      .map(({ IDbonnetier, prenom, nom, regleur }) => ({ IDbonnetier, prenom, nom, regleur }))
    res.json(rows)
  } catch (err) {
    console.error('Error fetching bonnetiers:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Planning entries ─────────────────────────────────────

interface PlanningEntry {
  IDplanning_bonnetier: number
  IDbonnetier: number
  date: string // YYYY-MM-DD (day of date_debut)
  debut: string // HH:MM
  fin: string // HH:MM (may belong to the next day for night shifts)
}

function normalizeEntry(raw: Record<string, unknown>): PlanningEntry | null {
  const debut = splitDateTime(raw.date_debut)
  const fin = splitDateTime(raw.date_fin)
  if (!debut || !fin) return null
  return {
    IDplanning_bonnetier: n(raw.IDplanning_bonnetier),
    IDbonnetier: n(raw.IDbonnetier),
    date: debut.date,
    debut: debut.time,
    fin: fin.time,
  }
}

async function selectEntries(fromDate: string, toDate: string, bonnetierId?: number): Promise<PlanningEntry[]> {
  const bonnetierFilter = bonnetierId ? ` AND IDbonnetier = ${bonnetierId}` : ''
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM planning_bonnetier
     WHERE date_debut >= ${dtLiteral(fromDate, '00:00')}
       AND date_debut < ${dtLiteral(addDays(toDate, 1), '00:00')}${bonnetierFilter}`,
  )
  return rows.map(normalizeEntry).filter((e): e is PlanningEntry => e !== null)
}

// GET /api/planning-atelier/entries?from=YYYY-MM-DD&to=YYYY-MM-DD
planningAtelierRouter.get('/entries', async (req: Request, res: Response) => {
  try {
    const from = String(req.query.from ?? '')
    const to = String(req.query.to ?? '')
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      res.status(400).json({ error: 'from/to must be YYYY-MM-DD' })
      return
    }
    res.json(await selectEntries(from, to))
  } catch (err) {
    console.error('Error fetching planning entries:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const entriesBody = z.object({
  IDbonnetier: z.number().int().positive(),
  entries: z
    .array(
      z.object({
        date: z.string().regex(DATE_RE),
        debut: z.string().regex(TIME_RE),
        fin: z.string().regex(TIME_RE),
      }),
    )
    .min(1)
    .max(31),
})

/** Insert one worked day. A `fin` at or before `debut` means the shift ends on
 *  the next day (Nuit 21:00 → 05:00). Any existing entry of that bonnetier on
 *  that day is replaced — matches the legacy one-shift-per-day model. */
async function insertEntry(bonnetierId: number, date: string, debut: string, fin: string): Promise<void> {
  await query(
    `DELETE FROM planning_bonnetier
     WHERE IDbonnetier = ${bonnetierId}
       AND date_debut >= ${dtLiteral(date, '00:00')}
       AND date_debut < ${dtLiteral(addDays(date, 1), '00:00')}`,
  )
  const finDate = fin > debut ? date : addDays(date, 1)
  await query(
    `INSERT INTO planning_bonnetier (date_debut, date_fin, IDbonnetier)
     VALUES (${dtLiteral(date, debut)}, ${dtLiteral(finDate, fin)}, ${bonnetierId})`,
  )
}

// POST /api/planning-atelier/entries — create (or replace) one entry per given day.
planningAtelierRouter.post('/entries', async (req: Request, res: Response) => {
  try {
    const parsed = entriesBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const { IDbonnetier, entries } = parsed.data
    for (const e of entries) {
      await insertEntry(IDbonnetier, e.date, e.debut, e.fin)
    }
    const dates = entries.map((e) => e.date).sort()
    res.status(201).json(await selectEntries(dates[0], dates[dates.length - 1], IDbonnetier))
  } catch (err) {
    console.error('Error creating planning entries:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/planning-atelier/entries/:id — remove one shift cell.
planningAtelierRouter.delete('/entries/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }
    await query(`DELETE FROM planning_bonnetier WHERE IDplanning_bonnetier = ${id}`)
    res.status(204).end()
  } catch (err) {
    console.error('Error deleting planning entry:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const clearBody = z.object({
  IDbonnetier: z.number().int().positive(),
  from: z.string().regex(DATE_RE),
  to: z.string().regex(DATE_RE),
})

// POST /api/planning-atelier/entries/clear — clear a bonnetier's week (legacy row X).
planningAtelierRouter.post('/entries/clear', async (req: Request, res: Response) => {
  try {
    const parsed = clearBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const { IDbonnetier, from, to } = parsed.data
    await query(
      `DELETE FROM planning_bonnetier
       WHERE IDbonnetier = ${IDbonnetier}
         AND date_debut >= ${dtLiteral(from, '00:00')}
         AND date_debut < ${dtLiteral(addDays(to, 1), '00:00')}`,
    )
    res.status(204).end()
  } catch (err) {
    console.error('Error clearing planning week:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const repeatBody = z.object({
  IDbonnetier: z.number().int().positive(),
  weekStart: z.string().regex(DATE_RE), // source week start (the visible week)
})

// POST /api/planning-atelier/entries/repeat — duplicate the visible week's
// schedule of one bonnetier onto the following week (legacy green repeat icon).
// Existing target-week entries of that bonnetier are replaced.
planningAtelierRouter.post('/entries/repeat', async (req: Request, res: Response) => {
  try {
    const parsed = repeatBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const { IDbonnetier, weekStart } = parsed.data
    const source = await selectEntries(weekStart, addDays(weekStart, 6), IDbonnetier)
    if (source.length === 0) {
      res.status(400).json({ error: 'empty_source_week' })
      return
    }
    for (const e of source) {
      await insertEntry(IDbonnetier, addDays(e.date, 7), e.debut, e.fin)
    }
    res.status(201).json({ copied: source.length })
  } catch (err) {
    console.error('Error repeating planning week:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Weekly planning PDF (landscape, MalterreDocument frame) ──

const DAY_NAMES_FR = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi']
const MONTH_NAMES_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
]

/** ISO week number of the ISO week containing `dateIso`. */
function isoWeekNumber(dateIso: string): number {
  const d = new Date(`${dateIso}T00:00:00Z`)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day) // Thursday of this ISO week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
}

function frLongDate(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`)
  return `${d.getUTCDate()} ${MONTH_NAMES_FR[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

async function buildPlanningPdfData(
  from: string,
  comment: string,
  excludeIds: Set<number>,
): Promise<PlanningAtelierPdfData> {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i))
  const to = days[6]
  const [allBonnetiers, entries] = await Promise.all([selectBonnetiers(), selectEntries(from, to)])
  const bonnetiers = allBonnetiers
    .filter((b) => b.archive === 0 && b.regleur === 0 && !excludeIds.has(b.IDbonnetier))
    .sort((a, b) => a.prenom.localeCompare(b.prenom, 'fr'))

  const byCell = new Map<string, { debut: string; fin: string }>()
  for (const e of entries) byCell.set(`${e.IDbonnetier}|${e.date}`, { debut: e.debut, fin: e.fin })

  // The grid week starts on Sunday (legacy convention); its ISO week is the
  // one containing the following Monday.
  const semaine = isoWeekNumber(addDays(from, 1))
  const today = new Date()
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  return {
    semaineLabel: `Semaine ${semaine}`,
    periodeLabel: `Planning du ${frLongDate(from)} au ${frLongDate(to)}`,
    printedDate: frLongDate(todayIso),
    dayLabels: days.map((d) => `${DAY_NAMES_FR[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${parseInt(d.slice(8, 10), 10)}`),
    rows: bonnetiers.map((b) => ({
      nom: `${b.prenom} ${b.nom}`.trim(),
      cells: days.map((d) => byCell.get(`${b.IDbonnetier}|${d}`) ?? null),
    })),
    comment,
  }
}

// GET /api/planning-atelier/pdf?from=YYYY-MM-DD&comment=...&exclude=1,2,3
// `from` is the visible week's Sunday; `comment` is the print-time free text;
// `exclude` lists bonnetier ids hidden on screen, left off the document too.
planningAtelierRouter.get('/pdf', async (req: Request, res: Response) => {
  try {
    const from = String(req.query.from ?? '')
    if (!DATE_RE.test(from)) {
      res.status(400).json({ error: 'from must be YYYY-MM-DD' })
      return
    }
    const comment = String(req.query.comment ?? '').slice(0, 500)
    const excludeIds = new Set(
      String(req.query.exclude ?? '')
        .split(',')
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n > 0),
    )

    const data = await buildPlanningPdfData(from, comment, excludeIds)
    const buffer = await renderToBuffer(
      React.createElement(PlanningAtelierPdf, { data }) as unknown as React.ReactElement<
        import('@react-pdf/renderer').DocumentProps
      >,
    )

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `inline; filename="planning-atelier-${data.semaineLabel.toLowerCase().replace(' ', '-')}.pdf"`,
    )
    // Strip helmet's restrictive headers so the web app (different origin/port
    // in dev) can embed the PDF in an <iframe>. See mps_designer §21.
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering planning-atelier PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Desiderata ───────────────────────────────────────────

interface DesiderataRow {
  IDdesiderata: number
  date: string // YYYY-MM-DD
  description: string
  IDbonnetier: number
  justifie: number
  declare: number
}

function normalizeDesiderata(raw: Record<string, unknown>): DesiderataRow {
  // `date` is a reserved word — HFSQL returns the key uppercased as `DATE`.
  const d = String(rawGet(raw, /^date$/i) ?? '')
  return {
    IDdesiderata: n(raw.IDdesiderata),
    date: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d,
    description: String(raw.description ?? '').trim(),
    IDbonnetier: n(raw.IDbonnetier),
    justifie: n(raw.justifie),
    declare: n(raw.declare),
  }
}

// GET /api/planning-atelier/desiderata?statut=encours|termine
// "En cours" = today or future, "Terminé" = past (legacy radio filter).
planningAtelierRouter.get('/desiderata', async (req: Request, res: Response) => {
  try {
    const statut = req.query.statut === 'termine' ? 'termine' : 'encours'
    const rows = await query<Record<string, unknown>>('SELECT * FROM desiderata')
    const fixed = await fixEncoding(rows, 'desiderata', 'IDdesiderata', ['description'])
    const today = new Date().toISOString().slice(0, 10)
    const out = fixed
      .map(normalizeDesiderata)
      .filter((d) => (statut === 'encours' ? d.date >= today : d.date < today))
      .sort((a, b) => (statut === 'encours' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)))
    res.json(out)
  } catch (err) {
    console.error('Error fetching desiderata:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const desiderataBody = z.object({
  date: z.string().regex(DATE_RE),
  IDbonnetier: z.number().int().positive(),
  description: z.string().min(1).max(500),
})

// POST /api/planning-atelier/desiderata — positional INSERT (self-assigned PK)
// so the reserved-word `date` column is never named.
// Physical column order: IDdesiderata, date, description, IDbonnetier, justifie, declare.
planningAtelierRouter.post('/desiderata', async (req: Request, res: Response) => {
  try {
    const parsed = desiderataBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data
    const maxRows = await query<{ m: unknown }>('SELECT MAX(IDdesiderata) AS m FROM desiderata')
    const newId = n(maxRows[0]?.m) + 1
    await query(
      `INSERT INTO desiderata VALUES (${newId}, '${ymd(d.date)}', ${sqlText(d.description)}, ${d.IDbonnetier}, 0, 0)`,
    )
    const created = await query<Record<string, unknown>>(`SELECT * FROM desiderata WHERE IDdesiderata = ${newId}`)
    const fixed = await fixEncoding(created, 'desiderata', 'IDdesiderata', ['description'])
    res.status(201).json(fixed.length > 0 ? normalizeDesiderata(fixed[0]) : null)
  } catch (err) {
    console.error('Error creating desiderata:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const desiderataFlags = z.object({
  justifie: z.union([z.literal(0), z.literal(1)]).optional(),
  declare: z.union([z.literal(0), z.literal(1)]).optional(),
})

// PUT /api/planning-atelier/desiderata/:id — toggle the déclaré / justifié flags.
planningAtelierRouter.put('/desiderata/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }
    const parsed = desiderataFlags.safeParse(req.body)
    if (!parsed.success || (parsed.data.justifie === undefined && parsed.data.declare === undefined)) {
      res.status(400).json({ error: 'Validation failed' })
      return
    }
    const sets: string[] = []
    if (parsed.data.justifie !== undefined) sets.push(`justifie = ${parsed.data.justifie}`)
    if (parsed.data.declare !== undefined) sets.push(`declare = ${parsed.data.declare}`)
    await query(`UPDATE desiderata SET ${sets.join(', ')} WHERE IDdesiderata = ${id}`)
    const rows = await query<Record<string, unknown>>(`SELECT * FROM desiderata WHERE IDdesiderata = ${id}`)
    if (rows.length === 0) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const fixed = await fixEncoding(rows, 'desiderata', 'IDdesiderata', ['description'])
    res.json(normalizeDesiderata(fixed[0]))
  } catch (err) {
    console.error('Error updating desiderata:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/planning-atelier/desiderata/:id
planningAtelierRouter.delete('/desiderata/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }
    await query(`DELETE FROM desiderata WHERE IDdesiderata = ${id}`)
    res.status(204).end()
  } catch (err) {
    console.error('Error deleting desiderata:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
