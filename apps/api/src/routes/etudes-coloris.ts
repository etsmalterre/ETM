import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import { query, queryRaw, fixEncoding } from '../lib/hfsql-auto.js'
import {
  DemandeEtudeColorisPdf,
  type DemandeEtudeColorisPdfData,
} from '../lib/pdf/DemandeEtudeColorisPdf.js'
import {
  SoumissionPdf,
  parseSampleNumbers,
  type SoumissionPdfData,
} from '../lib/pdf/SoumissionPdf.js'
import {
  FeuilleColorisPdf,
  type FeuilleColorisPdfData,
} from '../lib/pdf/FeuilleColorisPdf.js'
import { sendMail } from '../lib/gmail.js'
import { getUserEmail } from '../lib/user-emails.js'
import { userHasPermission } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'

export const etudesColorisRouter: RouterType = Router()

// ── Permission gate ─────────────────────────────────────
// ONE key covering every write on the screen — same shape as transferts.ts.
// Until ticket #1092 this router had no gate at all: whoever could open the
// screen could create, edit, delete, answer a soumission and mail a
// sous-traitant. Reads stay open, INCLUDING the three PDF endpoints: a
// read-only user must still be able to print and download.
//
// ⚠ `attachUser()` is best-effort and there is no global auth middleware, so a
// write route WITHOUT this call is reachable anonymously. Any new write here
// starts with it.
const EDIT_KEY = 'edit_etudes_coloris' as const

/** True when the caller may write. Writes the 401/403 itself, so callers
 *  just `return` on false. */
async function ensureCanEdit(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  if (!(await userHasPermission(req.userId, isEffectiveAdmin(req), EDIT_KEY))) {
    res.status(403).json({ error: `permission denied: ${EDIT_KEY}` })
    return false
  }
  return true
}

// HFSQL footgun: the Linux iODBC bridge rejects any accented identifier
// token in the SQL text (e.g. `archivé`), so WHERE / ORDER BY referencing
// those columns blows up with "Unexpected word". Branch on platform and
// post-filter in JS on Linux. The bridge truncates the column name on the
// way out (last char dropped) so `archivé` arrives as `archiv`. Pattern
// canonicalised in `apps/api/src/routes/stock.ts`.
const IS_WINDOWS = process.platform === 'win32'

// `envoi_email.invalidé` is an accented column. Naming it in SQL is FATAL on the
// Linux iODBC bridge: the truncated `invalid` reaches the server → [01000] →
// the bridge respawns and retries → respawn storm that floods the shared HFSQL
// server and hangs every app on it. So never name `invalidé` (nor `société`) in
// a query: SELECT * (or only ASCII columns), drop the `invalidé` predicate, and
// prune invalidated rows in JS via the surfaced (truncated) key.
function isActiveEnvoi(r: Record<string, unknown>): boolean {
  return Number((r as any).invalid ?? (r as any)['invalidé'] ?? 0) === 0
}

// Read the `archivé` column off a row regardless of the platform-specific
// column-name shape (Linux returns it truncated to `archiv`).
function isArchive(row: Record<string, unknown>): boolean {
  const v = row.archivé ?? row.archiv ?? 0
  return Number(v) === 1
}

// ── Types ────────────────────────────────────────────────

type EtudeStatut = 1 | 2 | 3 | 4 // 1=attente labo · 2=soumis au client · 3=accepté · 4=annulé
type SoumissionAccepte = 0 | 1 | 2 // 0=pending · 1=accepté · 2=refusé

interface EtudeRow {
  IDetude_col: number
  IDclient: number
  IDref_fini: number
  IDref_fini_colori: number
  IDsous_traitant: number
  libelle: string | null
  num_commande: string | null
  desig_client: string | null
  date_reception_type: string | null // YYYYMMDD
  statut_col: EtudeStatut
  commentaire: string | null
  /** Free-form text journal — added in May 2026, ETM-only field used
   *  by the user to record action notes on the étude. Stored as plain
   *  text (the user explicitly opted out of legacy-RTF compatibility for
   *  this column). */
  journal: string | null
  date_derniere_action: string | null // YYYY-MM-DD (ISO)
}

interface SoumissionRow {
  IDsoum_col: number
  IDetude_col: number
  date_soum: string | null // YYYYMMDD
  type_soum: string | null
  observation: string | null
  date_reponse: string | null // YYYYMMDD
  accepte: SoumissionAccepte
}

// ── Helpers ──────────────────────────────────────────────

function esc(v: string): string {
  return v.replace(/'/g, "''")
}

/** Emit a text value as a SQL literal that survives the Linux HFSQL bridge.
 *  Raw multi-byte UTF-8 in a SQL string desyncs the bridge pipeline → HFSQL
 *  reports "string without end" / [HY090] / 500 (a commentaire with "validé"
 *  did exactly this). HFSQL text columns are Latin-1, so accented values are
 *  emitted as a hex literal of their Latin-1 bytes (pure ASCII in transit).
 *  ASCII-only values keep the normal quoted literal. Mirrors sqlText() in
 *  commandes-sous-traitant.ts. */
function sqlText(value: string | null | undefined): string {
  const v = (value ?? '').toString()
  if (v === '') return "''"
  if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(v)) return `'${esc(v)}'`
  const ascii = v
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
  const bytes = Buffer.from(
    Array.from(ascii, (ch) => {
      const c = ch.codePointAt(0) ?? 0x3F
      return c <= 0xFF ? c : 0x3F
    }),
  )
  return `x'${bytes.toString('hex')}'`
}

function n(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0
  const p = Number(v)
  return isNaN(p) ? 0 : p
}

/** Strip non-digits. Accepts 'YYYY-MM-DD' or 'YYYYMMDD' or ''. */
function dateStr(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v).replace(/-/g, '')
  return /^\d{8}$/.test(s) ? s : ''
}

/** Format today as HFSQL YYYYMMDD. */
function todayHfsql(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${dd}`
}

/** Format today as ISO YYYY-MM-DD (used for etude_col.date_derniere_action). */
function todayIso(): string {
  const t = todayHfsql()
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`
}

const statutFilterToCode: Record<string, EtudeStatut | undefined> = {
  attente_labo: 1,
  soumis: 2,
  accepte: 3,
  annule: 4,
}

/** Coerce HFSQL BYTE driver output into a strict EtudeStatut union. */
function coerceStatut(v: unknown): EtudeStatut {
  const x = Number(v)
  if (x === 1 || x === 2 || x === 3 || x === 4) return x as EtudeStatut
  return 1
}

function coerceAccepte(v: unknown): SoumissionAccepte {
  const x = Number(v)
  if (x === 0 || x === 1 || x === 2) return x as SoumissionAccepte
  return 0
}

/** Bump date_derniere_action to now for a given étude id. Fire-and-log-failure. */
async function touchEtude(id: number): Promise<void> {
  try {
    await query(
      `UPDATE etude_col SET date_derniere_action = '${todayIso()}' WHERE IDetude_col = ${id}`,
    )
  } catch (err) {
    console.error(`touchEtude(${id}) failed:`, (err as Error).message)
  }
}

/** Compute the next auto version label ('v{N+1}') across existing soumissions. */
function nextTypeSoum(existing: SoumissionRow[]): string {
  let max = 0
  for (const s of existing) {
    const t = (s.type_soum ?? '').trim()
    const m = /^v(\d+)$/i.exec(t)
    if (m) {
      const n = parseInt(m[1], 10)
      if (!isNaN(n) && n > max) max = n
    }
  }
  return `v${max + 1}`
}

/** Load soumissions for an étude, ordered newest-first. Includes a
 *  precomputed envoi_count so the UI can badge rows that have been sent. */
async function loadSoumissions(
  etudeId: number,
): Promise<(SoumissionRow & { envoi_count: number; last_envoi_date: string | null })[]> {
  const rows = await query<any>(
    `SELECT IDsoum_col, IDetude_col, date_soum, type_soum, observation, date_reponse, accepte
     FROM soum_col WHERE IDetude_col = ${etudeId}
     ORDER BY date_soum ASC, IDsoum_col ASC`,
  )
  const fixed = await fixEncoding(rows, 'soum_col', 'IDsoum_col', ['type_soum', 'observation'])
  const base = (fixed as any[]).map((r) => ({
    IDsoum_col: Number(r.IDsoum_col),
    IDetude_col: Number(r.IDetude_col),
    date_soum: r.date_soum ?? null,
    type_soum: r.type_soum ?? null,
    observation: r.observation ?? null,
    date_reponse: r.date_reponse ?? null,
    accepte: coerceAccepte(r.accepte),
  }))
  if (base.length === 0) return []

  // Bulk-fetch envoi aggregates in one query; avoids N extra SELECTs.
  const soumIds = base.map((s) => s.IDsoum_col)
  const envoiAgg = new Map<number, { count: number; last: string | null }>()
  try {
    const aggRows = await query<Record<string, unknown>>(
      `SELECT * FROM envoi_email
       WHERE IDtype_doc = ${TYPE_DOC_SOUMISSION}
         AND IDreference IN (${soumIds.join(',')})`,
    )
    for (const r of aggRows) {
      if (!isActiveEnvoi(r)) continue
      const id = Number(r.IDreference)
      const acc = envoiAgg.get(id) ?? { count: 0, last: null as string | null }
      acc.count += 1
      const d = typeof r.DATE === 'string' ? r.DATE : ''
      if (d && (acc.last === null || d > acc.last)) acc.last = d
      envoiAgg.set(id, acc)
    }
  } catch (e) {
    // Legacy envoi_email absent or unreadable — degrade to zero counts.
    console.error('envoi_email aggregate failed:', (e as Error).message)
  }

  return base.map((s) => {
    const agg = envoiAgg.get(s.IDsoum_col)
    return {
      ...s,
      envoi_count: agg?.count ?? 0,
      last_envoi_date: agg?.last ?? null,
    }
  })
}

/** Load a single étude with all its soumissions + join-enriched display names.
 *  Returns null on not-found. */
async function loadEtudeDetail(id: number): Promise<Record<string, unknown> | null> {
  const rows = await query<any>(
    `SELECT IDetude_col, IDclient, IDref_fini, IDref_fini_colori, IDsous_traitant,
            libelle, num_commande, desig_client, date_reception_type, statut_col,
            commentaire, journal, date_derniere_action
     FROM etude_col WHERE IDetude_col = ${id}`,
  )
  if (rows.length === 0) return null
  const fixed = await fixEncoding(rows, 'etude_col', 'IDetude_col', [
    'libelle', 'num_commande', 'desig_client', 'commentaire', 'journal',
  ])
  const header = fixed[0] as any as EtudeRow

  // Bulk-fetch display names for FK parents
  const [clientRows, refFiniRows, refFiniColRows, sousTraitantRows, soumissions] = await Promise.all([
    header.IDclient > 0
      ? query<{ IDclient: number; nom: string | null }>(
          `SELECT IDclient, nom FROM client WHERE IDclient = ${header.IDclient}`,
        )
      : Promise.resolve([]),
    header.IDref_fini > 0
      ? query<{ IDref_fini: number; reference: string | null; designation: string | null }>(
          `SELECT IDref_fini, reference, designation FROM ref_fini WHERE IDref_fini = ${header.IDref_fini}`,
        )
      : Promise.resolve([]),
    header.IDref_fini_colori > 0
      ? query<{ IDref_fini_colori: number; reference: string | null }>(
          `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori = ${header.IDref_fini_colori}`,
        )
      : Promise.resolve([]),
    header.IDsous_traitant > 0
      ? query<{ IDsous_traitant: number; nom: string | null }>(
          `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant = ${header.IDsous_traitant}`,
        )
      : Promise.resolve([]),
    loadSoumissions(id),
  ])

  const fixedClient = await fixEncoding(clientRows as any[], 'client', 'IDclient', ['nom'])
  const fixedRefFini = await fixEncoding(refFiniRows as any[], 'ref_fini', 'IDref_fini', ['reference', 'designation'])
  const fixedRefFiniCol = await fixEncoding(refFiniColRows as any[], 'ref_fini_colori', 'IDref_fini_colori', ['reference'])
  const fixedSousTraitant = await fixEncoding(sousTraitantRows as any[], 'sous_traitant', 'IDsous_traitant', ['nom'])

  return {
    ...header,
    statut_col: coerceStatut(header.statut_col),
    client_nom: (fixedClient[0] as any)?.nom ?? null,
    ref_fini_reference: (fixedRefFini[0] as any)?.reference ?? null,
    ref_fini_designation: (fixedRefFini[0] as any)?.designation ?? null,
    ref_fini_colori_reference: (fixedRefFiniCol[0] as any)?.reference ?? null,
    // Photos are disabled in v1 (see /lookups/ref-fini-coloris note).
    ref_fini_colori_has_photo: 0,
    sous_traitant_nom: (fixedSousTraitant[0] as any)?.nom ?? null,
    soumissions,
  }
}

// ── Validation schemas ───────────────────────────────────

const etudeBody = z.object({
  IDclient: z.number().int().positive(),
  IDref_fini: z.number().int().positive(),
  IDref_fini_colori: z.number().int().nonnegative().optional(),
  IDsous_traitant: z.number().int().nonnegative().optional(),
  libelle: z.string().min(1).max(100),
  num_commande: z.string().max(100).optional(),
  desig_client: z.string().max(100).optional(),
  date_reception_type: z.string().optional(), // YYYYMMDD or YYYY-MM-DD
  commentaire: z.string().optional(),
  journal: z.string().optional(),
})

const etudeUpdateBody = etudeBody.partial().extend({
  statut_col: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
})

const soumissionBody = z.object({
  date_soum: z.string().optional(),
  type_soum: z.string().max(50).optional(),
  observation: z.string().optional(),
})

const respondBody = z.object({
  accepte: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  date_reponse: z.string().optional(), // defaults to today
  // Only meaningful when accepte=1. When provided, a new ref_fini_colori
  // row is created named "<étude.libelle>/<sampleNumber>" and the étude's
  // libelle + IDref_fini_colori are updated to point at it; statut_col is
  // auto-advanced to 3 (accepté).
  sampleNumber: z.string().trim().min(1).max(20).optional(),
})

// ── List endpoint ────────────────────────────────────────

etudesColorisRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim()
    const statut = String(req.query.statut ?? 'attente_labo')
    const clientFilter = parseInt(String(req.query.client ?? ''), 10)

    const whereParts: string[] = []
    const statutCode = statutFilterToCode[statut]
    if (statutCode !== undefined) whereParts.push(`ec.statut_col = ${statutCode}`)
    // 'all' → no filter
    if (!isNaN(clientFilter) && clientFilter > 0) whereParts.push(`ec.IDclient = ${clientFilter}`)
    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''

    const etudes = await query<any>(
      `SELECT ec.IDetude_col, ec.IDclient, ec.IDref_fini, ec.IDref_fini_colori, ec.IDsous_traitant,
              ec.libelle, ec.num_commande, ec.desig_client, ec.date_reception_type, ec.statut_col,
              ec.date_derniere_action
       FROM etude_col ec
       ${whereSql}
       ORDER BY ec.date_derniere_action DESC, ec.IDetude_col DESC`,
    )
    const fixedEtudes = await fixEncoding(etudes as any[], 'etude_col', 'IDetude_col', [
      'libelle', 'num_commande', 'desig_client',
    ]) as any[]

    // Bulk-fetch display names for FK parents
    const clientIds = Array.from(new Set(fixedEtudes.map((e) => Number(e.IDclient)).filter((x) => x > 0)))
    const refFiniIds = Array.from(new Set(fixedEtudes.map((e) => Number(e.IDref_fini)).filter((x) => x > 0)))
    const refFiniColIds = Array.from(
      new Set(fixedEtudes.map((e) => Number(e.IDref_fini_colori)).filter((x) => x > 0)),
    )
    const sousTraitantIds = Array.from(
      new Set(fixedEtudes.map((e) => Number(e.IDsous_traitant)).filter((x) => x > 0)),
    )

    const [clientRows, refFiniRows, refFiniColRows, sousTraitantRows] = await Promise.all([
      clientIds.length > 0
        ? query<{ IDclient: number; nom: string | null }>(
            `SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`,
          )
        : Promise.resolve([]),
      refFiniIds.length > 0
        ? query<{ IDref_fini: number; reference: string | null }>(
            `SELECT IDref_fini, reference FROM ref_fini WHERE IDref_fini IN (${refFiniIds.join(',')})`,
          )
        : Promise.resolve([]),
      refFiniColIds.length > 0
        ? query<{ IDref_fini_colori: number; reference: string | null }>(
            `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori IN (${refFiniColIds.join(',')})`,
          )
        : Promise.resolve([]),
      sousTraitantIds.length > 0
        ? query<{ IDsous_traitant: number; nom: string | null }>(
            `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${sousTraitantIds.join(',')})`,
          )
        : Promise.resolve([]),
    ])

    const fixedClients = await fixEncoding(clientRows as any[], 'client', 'IDclient', ['nom'])
    const fixedRefFini = await fixEncoding(refFiniRows as any[], 'ref_fini', 'IDref_fini', ['reference'])
    const fixedRefFiniCol = await fixEncoding(
      refFiniColRows as any[], 'ref_fini_colori', 'IDref_fini_colori', ['reference'],
    )
    const fixedSousTraitant = await fixEncoding(
      sousTraitantRows as any[], 'sous_traitant', 'IDsous_traitant', ['nom'],
    )

    const clientMap = new Map<number, string>()
    for (const c of fixedClients as any[]) clientMap.set(Number(c.IDclient), c.nom ?? '')
    const refFiniMap = new Map<number, string>()
    for (const r of fixedRefFini as any[]) refFiniMap.set(Number(r.IDref_fini), r.reference ?? '')
    const refFiniColMap = new Map<number, string>()
    for (const r of fixedRefFiniCol as any[])
      refFiniColMap.set(Number(r.IDref_fini_colori), r.reference ?? '')
    const sousTraitantMap = new Map<number, string>()
    for (const s of fixedSousTraitant as any[])
      sousTraitantMap.set(Number(s.IDsous_traitant), s.nom ?? '')

    // Bulk-fetch soumission aggregates: count + latest date_soum per étude
    const etudeIds = fixedEtudes.map((e) => Number(e.IDetude_col)).filter(Boolean)
    const soumAggMap = new Map<number, { nb_soumissions: number; last_soumission_date: string | null }>()
    if (etudeIds.length > 0) {
      const soums = await query<{ IDetude_col: number; date_soum: string | null }>(
        `SELECT IDetude_col, date_soum FROM soum_col WHERE IDetude_col IN (${etudeIds.join(',')})`,
      )
      for (const s of soums) {
        const id = Number(s.IDetude_col)
        const acc = soumAggMap.get(id) ?? { nb_soumissions: 0, last_soumission_date: null }
        acc.nb_soumissions += 1
        const ds = typeof s.date_soum === 'string' ? s.date_soum : ''
        if (/^\d{8}$/.test(ds) && (acc.last_soumission_date === null || ds > acc.last_soumission_date)) {
          acc.last_soumission_date = ds
        }
        soumAggMap.set(id, acc)
      }
    }

    const qLower = q.toLowerCase()
    const result = fixedEtudes
      .map((e: any) => {
        const agg = soumAggMap.get(Number(e.IDetude_col)) ?? {
          nb_soumissions: 0, last_soumission_date: null,
        }
        return {
          ...e,
          statut_col: coerceStatut(e.statut_col),
          client_nom: clientMap.get(Number(e.IDclient)) ?? null,
          ref_fini_reference: refFiniMap.get(Number(e.IDref_fini)) ?? null,
          ref_fini_colori_reference: refFiniColMap.get(Number(e.IDref_fini_colori)) ?? null,
          sous_traitant_nom: sousTraitantMap.get(Number(e.IDsous_traitant)) ?? null,
          ...agg,
        }
      })
      .filter((e: any) => {
        if (!q) return true
        const hay = [
          e.IDetude_col, e.libelle, e.num_commande, e.desig_client, e.client_nom,
          e.ref_fini_reference, e.ref_fini_colori_reference,
        ].join(' ').toLowerCase()
        return hay.includes(qLower)
      })

    res.json(result)
  } catch (err) {
    console.error('Error listing etudes-coloris:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Detail endpoint ──────────────────────────────────────

etudesColorisRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const detail = await loadEtudeDetail(id)
    if (!detail) { res.status(404).json({ error: 'Étude not found' }); return }
    res.json(detail)
  } catch (err) {
    console.error('Error fetching etude-coloris detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PDF export (Demande d'étude coloris) ─────────────────

const FRENCH_MONTHS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
] as const

/** Format a HFSQL YYYYMMDD string as long-form French "14 avril 2026". */
function formatHfsqlDateLongFr(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = String(raw)
  if (!/^\d{8}$/.test(s)) return ''
  const day = parseInt(s.slice(6, 8), 10)
  const month = parseInt(s.slice(4, 6), 10)
  const year = s.slice(0, 4)
  if (month < 1 || month > 12) return ''
  return `${day} ${FRENCH_MONTHS[month - 1]} ${year}`
}

function todayLongFr(): string {
  const d = new Date()
  return `${d.getDate()} ${FRENCH_MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** Strip HFSQL placeholder values (dots, dashes, underscores, blanks).
 *  Legacy records often have ".", " . ", "-", "" etc. in unset address fields. */
function cleanAddrField(s: string | null | undefined): string | null {
  if (!s) return null
  const t = String(s).trim()
  if (!t) return null
  if (/^[.\-_·•\s]+$/.test(t)) return null
  return t
}

interface DefaultAdresse {
  nom: string | null
  adresse1: string | null
  adresse2: string | null
  adresse3: string | null
  cp: string | null
  ville: string | null
  pays: string | null
}

/** Load the default visible address for an owner (client / sous_traitant /
 *  fournisseur). Prefers est_defaut = 1, then est_defaut_livraison, then the
 *  first visible row. Returns null when the owner has no address on file. */
async function loadDefaultAdresse(
  ownerType: 'client' | 'sous_traitant' | 'fournisseur',
  id: number,
): Promise<DefaultAdresse | null> {
  if (id <= 0) return null
  const fkCol =
    ownerType === 'client' ? 'IDclient'
    : ownerType === 'sous_traitant' ? 'IDsous_traitant'
    : 'IDfournisseur'
  const rows = await query<any>(
    `SELECT * FROM adresse
     WHERE ${fkCol} = ${id} AND est_visible = 1
     ORDER BY est_defaut DESC, est_defaut_livraison DESC, IDadresse`,
  )
  if (rows.length === 0) return null
  const fixed = await fixEncoding(rows, 'adresse', 'IDadresse', [
    'nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays',
  ])
  const a = fixed[0] as any
  return {
    nom: cleanAddrField(a.nom),
    adresse1: cleanAddrField(a.adresse1),
    adresse2: cleanAddrField(a.adresse2),
    adresse3: cleanAddrField(a.adresse3),
    cp: cleanAddrField(a.cp),
    ville: cleanAddrField(a.ville),
    pays: cleanAddrField(a.pays),
  }
}

/** Backwards-compatible alias for the PDF builder. */
async function loadSousTraitantAdresse(id: number): Promise<DefaultAdresse | null> {
  return loadDefaultAdresse('sous_traitant', id)
}

/** Load all data and build the PDF payload for a demande d'étude coloris.
 *  Reused by the /pdf download route and the /email send route so both
 *  produce a byte-identical PDF. Returns null if the étude doesn't exist. */
async function buildDemandeEtudeColorisData(
  id: number,
): Promise<DemandeEtudeColorisPdfData | null> {
  const detail = (await loadEtudeDetail(id)) as Record<string, any> | null
  if (!detail) return null

  const dateLong =
    formatHfsqlDateLongFr(detail.date_reception_type as string | null) || todayLongFr()

  const sousTraitantAdresse = await loadSousTraitantAdresse(
    Number(detail.IDsous_traitant) || 0,
  )

  return {
    numero: String(detail.IDetude_col),
    dateDocument: dateLong,
    sousTraitantNom: (detail.sous_traitant_nom as string | null) ?? null,
    sousTraitantAdresse,
    clientNom: (detail.client_nom as string | null) ?? null,
    refFini: (detail.ref_fini_reference as string | null) ?? null,
    refFiniDesignation: (detail.ref_fini_designation as string | null) ?? null,
    libelle: (detail.libelle as string | null) ?? null,
    commentaire: (detail.commentaire as string | null) ?? null,
  }
}

/** Render the demande d'étude coloris PDF as a Buffer. */
async function renderDemandeEtudeColorisBuffer(
  data: DemandeEtudeColorisPdfData,
): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(DemandeEtudeColorisPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

etudesColorisRouter.get('/:id/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const data = await buildDemandeEtudeColorisData(id)
    if (!data) { res.status(404).json({ error: 'Étude not found' }); return }

    const buffer = await renderDemandeEtudeColorisBuffer(data)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `inline; filename="demande-etude-coloris-${data.numero}.pdf"`,
    )
    // Allow iframe embedding from the web app origin (dev + prod).
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering etude-coloris PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Internal "Feuille coloris" PDF ───────────────────────
// Workshop-board document, not emailed. Shows the Type placeholder (top-
// left), a manual-fill coloris card + general info (top-right stacked),
// an approved-coloris placeholder, and an open production-sample area.

async function buildFeuilleColorisData(id: number): Promise<FeuilleColorisPdfData | null> {
  const detail = (await loadEtudeDetail(id)) as Record<string, any> | null
  if (!detail) return null

  const dateLong =
    formatHfsqlDateLongFr(detail.date_reception_type as string | null) || todayLongFr()

  return {
    numero: String(detail.IDetude_col),
    dateDocument: dateLong,
    clientNom: (detail.client_nom as string | null) ?? null,
    refFini: (detail.ref_fini_reference as string | null) ?? null,
    refFiniDesignation: (detail.ref_fini_designation as string | null) ?? null,
    codeClient: (detail.desig_client as string | null) ?? null,
    // Prefer the étude libellé (full descriptive name like "2304 Coffee")
    // over the raw ref_fini_colori reference — matches the Soumission PDF.
    codeMalterre:
      ((detail.libelle as string | null) && String(detail.libelle).trim())
      || (detail.ref_fini_colori_reference as string | null)
      || null,
    sousTraitantNom: (detail.sous_traitant_nom as string | null) ?? null,
  }
}

async function renderFeuilleColorisBuffer(data: FeuilleColorisPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(FeuilleColorisPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

etudesColorisRouter.get('/:id/feuille-pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const data = await buildFeuilleColorisData(id)
    if (!data) { res.status(404).json({ error: 'Étude not found' }); return }

    const buffer = await renderFeuilleColorisBuffer(data)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `inline; filename="feuille-coloris-${data.numero}.pdf"`,
    )
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering feuille coloris PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Email (Gmail API via domain-wide delegation) ─────────
//
// Two endpoints, mirroring the commandes-fil pattern (mps_designer §32):
//   GET  /:id/email-defaults  — returns pre-filled recipients + subject +
//                               body so the frontend dialog opens populated
//   POST /:id/email           — sends the email, impersonating the acting
//                               user's mapped @etsmalterre.com address

interface EmailRecipientPayload {
  email: string
  name?: string
  source: 'contact'
  contactId: number
}

interface EmailDefaultsPayload {
  recipients: {
    selected: EmailRecipientPayload[]
    suggestions: EmailRecipientPayload[]
  }
  subject: string
  body: string
  sousTraitantNom: string
  numero: string
}

/** Build default email form state for an étude. Splits the sous-traitant's
 *  visible contacts with a valid email into two buckets: those flagged
 *  envoi_soumission = 1 go into `selected` (pre-filled chips), the rest
 *  into `suggestions` (clickable to add). */
async function buildEtudeEmailDefaults(id: number): Promise<EmailDefaultsPayload | null> {
  const detail = (await loadEtudeDetail(id)) as Record<string, any> | null
  if (!detail) return null

  const idSt = Number(detail.IDsous_traitant) || 0
  const sousTraitantNom = (detail.sous_traitant_nom as string | null) ?? ''
  const refFini = (detail.ref_fini_reference as string | null) ?? ''
  const codeClient = (detail.desig_client as string | null) ?? ''
  const clientNom = (detail.client_nom as string | null) ?? ''

  const contactRows = idSt > 0
    ? await query<{
        IDcontact: number
        nom: string | null
        prenom: string | null
        mail: string | null
        envoi_soumission: number | null
        est_visible: number | null
      }>(
        `SELECT IDcontact, nom, prenom, mail, envoi_soumission, est_visible
         FROM contact WHERE IDsous_traitant = ${idSt}`,
      )
    : []
  const fixedContacts = await fixEncoding(contactRows, 'contact', 'IDcontact', [
    'nom', 'prenom', 'mail',
  ])

  const selected: EmailRecipientPayload[] = []
  const suggestions: EmailRecipientPayload[] = []
  const seen = new Set<string>()
  for (const c of fixedContacts as any[]) {
    if (c.est_visible === 0) continue
    const raw = (c.mail ?? '').toString().trim()
    if (!raw) continue
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const displayName = [c.prenom, c.nom]
      .map((s: string | null) => (s ?? '').toString().trim())
      .filter((s: string) => s.length > 0)
      .join(' ')
    const recipient: EmailRecipientPayload = {
      email: raw,
      source: 'contact',
      contactId: Number(c.IDcontact),
    }
    if (displayName) recipient.name = displayName
    if (c.envoi_soumission === 1) selected.push(recipient)
    else suggestions.push(recipient)
  }

  const numero = String(id)

  // Include a concise context block in the subject so a casual inbox
  // scan lets the recipient know which study + coloris this concerns.
  const subjectContext = [refFini, codeClient].filter((s) => s).join(' · ')
  const subject = subjectContext
    ? `Demande d'étude coloris N°${numero} — ${subjectContext}`
    : `Demande d'étude coloris N°${numero}`

  const bodyLines = [
    'Bonjour,',
    '',
    `Veuillez trouver ci-joint notre demande d'étude coloris N°${numero}${
      clientNom ? ` à destination de ${clientNom}` : ''
    }.`,
    '',
  ]
  if (refFini || clientNom || codeClient) {
    bodyLines.push('Détails de la demande :')
    if (refFini) bodyLines.push(`  • Référence fini : ${refFini}`)
    if (clientNom) bodyLines.push(`  • Client : ${clientNom}`)
    if (codeClient) bodyLines.push(`  • Code client : ${codeClient}`)
    bodyLines.push('')
  }
  bodyLines.push(
    "Nous vous remercions de bien vouloir nous retourner vos propositions après étude de l'échantillon joint.",
    '',
    'Cordialement,',
    'ETS Malterre',
  )
  const body = bodyLines.join('\n')

  return {
    recipients: { selected, suggestions },
    subject,
    body,
    sousTraitantNom,
    numero,
  }
}

etudesColorisRouter.get('/:id/email-defaults', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const defaults = await buildEtudeEmailDefaults(id)
    if (!defaults) { res.status(404).json({ error: 'Étude not found' }); return }
    res.json(defaults)
  } catch (err) {
    console.error('Error building etude email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const extraAttachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  content_base64: z.string().min(1),
  content_type: z.string().min(1).max(100),
})

const emailBodySchema = z.object({
  to: z.array(z.string().email()).min(1, 'At least one recipient is required'),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20000),
  attach_pdf: z.boolean().optional(),
  extra_attachments: z.array(extraAttachmentSchema).optional(),
})

etudesColorisRouter.post('/:id/email', async (req: Request, res: Response) => {
  try {
    if (!(await ensureCanEdit(req, res))) return
    const id = parseInt(String(req.params.id), 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }

    const parsed = emailBodySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }

    // Acting user's corporate email (required to impersonate via DWD)
    const senderEmail = await getUserEmail(req.userId)
    if (!senderEmail) {
      res.status(400).json({
        error: 'no_sender_email',
        message:
          "Aucune adresse email n'est associée à votre compte. Un administrateur doit en définir une dans Paramètres › Utilisateurs.",
      })
      return
    }

    // Display name for the From header
    const userRows = await query<{ prenom: string | null; nom: string | null }>(
      `SELECT prenom, nom FROM utilisateur WHERE IDutilisateur = ${req.userId}`,
    )
    const fixedUser = await fixEncoding(userRows, 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
    const u = (fixedUser[0] as any) ?? null
    const displayName = u
      ? [u.prenom, u.nom]
          .filter((s: string | null) => s && s.trim())
          .map((s: string) => s.trim())
          .join(' ')
      : ''
    const fromName = displayName ? `${displayName} — ETS Malterre` : 'ETS Malterre'

    const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
    if (parsed.data.attach_pdf !== false) {
      const data = await buildDemandeEtudeColorisData(id)
      if (!data) { res.status(404).json({ error: 'Étude not found' }); return }
      const buffer = await renderDemandeEtudeColorisBuffer(data)
      attachments.push({
        filename: `demande-etude-coloris-${data.numero}.pdf`,
        content: buffer,
        contentType: 'application/pdf',
      })
    }
    for (const a of parsed.data.extra_attachments ?? []) {
      attachments.push({
        filename: a.filename,
        content: Buffer.from(a.content_base64, 'base64'),
        contentType: a.content_type,
      })
    }

    const messageId = await sendMail({
      from: senderEmail,
      fromName,
      to: parsed.data.to,
      cc: parsed.data.cc,
      bcc: parsed.data.bcc,
      subject: parsed.data.subject,
      body: parsed.data.body,
      attachments: attachments.length > 0 ? attachments : undefined,
    })

    // Log one envoi_email row per recipient. Société defaults to the
    // sous-traitant name — the demande is sent to the sous-traitant.
    const logDetail = (await loadEtudeDetail(id)) as Record<string, any> | null
    const societe = (logDetail?.sous_traitant_nom as string | null) ?? ''
    const recipients = [...parsed.data.to, ...(parsed.data.cc ?? [])]
    await logEnvoiEmails(TYPE_DOC_DEMANDE_ETUDE_COLORIS, id, recipients, societe)

    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending etude-coloris email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})

// ── Étude history timeline ───────────────────────────────
//
// Unified timeline of envoi_email events for an étude: demande d'étude
// coloris sends (IDtype_doc = 27, IDreference = etudeId) + every soumission
// send (IDtype_doc = 15, IDreference IN soumissions). Returned newest-first
// so the frontend can render a reverse-chronological list.

interface HistoryEvent {
  /** Envoi_email id for send events, or 'reception-<etudeId>' /
   *  'acceptance-<soumId>' for synthetic events (no DB id). */
  id: number | string
  kind: 'etude' | 'soumission' | 'reception_type' | 'acceptance'
  date: string | null                 // raw datetime for envois (YYYY-MM-DD HH:MM:SS.mmm) or YYYYMMDD for synthetic events
  adresse: string | null
  societe: string | null
  soumissionId: number | null         // non-null when kind='soumission' or 'acceptance'
  soumissionObservation: string | null // e.g. "1-2" for the sample numbers
}

etudesColorisRouter.get('/:id/history', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const etudeRows = await query<{ IDetude_col: number; date_reception_type: string | null }>(
      `SELECT IDetude_col, date_reception_type FROM etude_col WHERE IDetude_col = ${id}`,
    )
    if (etudeRows.length === 0) { res.status(404).json({ error: 'Étude not found' }); return }
    const etude = etudeRows[0]

    // Gather soumission IDs + their observations so we can enrich events,
    // and grab date_reponse + accepte so we can synthesize acceptance events.
    const soumRows = await query<{
      IDsoum_col: number; observation: string | null
      date_reponse: string | null; accepte: number | null
    }>(
      `SELECT IDsoum_col, observation, date_reponse, accepte
       FROM soum_col WHERE IDetude_col = ${id}`,
    )
    const fixedSoum = await fixEncoding(soumRows as any[], 'soum_col', 'IDsoum_col', ['observation'])
    interface SoumCtx { observation: string | null; dateReponse: string | null; accepte: number }
    const soumMap = new Map<number, SoumCtx>()
    for (const s of fixedSoum as any[]) {
      soumMap.set(Number(s.IDsoum_col), {
        observation: s.observation ?? null,
        dateReponse: (s.date_reponse as string | null) ?? null,
        accepte: Number(s.accepte) || 0,
      })
    }
    const soumIds = Array.from(soumMap.keys())

    // Pull both kinds of envois in parallel.
    const [etudeEnvoisRaw, soumissionEnvoisRaw] = await Promise.all([
      query<any>(
        `SELECT * FROM envoi_email
         WHERE IDtype_doc = ${TYPE_DOC_DEMANDE_ETUDE_COLORIS}
           AND IDreference = ${id}`,
      ),
      soumIds.length > 0
        ? query<any>(
            `SELECT * FROM envoi_email
             WHERE IDtype_doc = ${TYPE_DOC_SOUMISSION}
               AND IDreference IN (${soumIds.join(',')})`,
          )
        : Promise.resolve([]),
    ])
    const etudeEnvois = (etudeEnvoisRaw as any[]).filter(isActiveEnvoi)
    const soumissionEnvois = (soumissionEnvoisRaw as any[]).filter(isActiveEnvoi)
    const fixedEtudeEnvois = await fixEncoding(etudeEnvois as any[], 'envoi_email', 'IDenvoi_email', ['adresse', 'société'])
    const fixedSoumEnvois = await fixEncoding(soumissionEnvois as any[], 'envoi_email', 'IDenvoi_email', ['adresse', 'société'])

    const events: HistoryEvent[] = []

    // Synthetic "reception type" event, dated at the start of that day so
    // it sorts correctly against the datetime-stamped envoi events.
    if (etude.date_reception_type && /^\d{8}$/.test(String(etude.date_reception_type))) {
      const raw = String(etude.date_reception_type)
      const normalized = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} 00:00:00.000`
      events.push({
        id: `reception-${id}`,
        kind: 'reception_type',
        date: normalized,
        adresse: null,
        societe: null,
        soumissionId: null,
        soumissionObservation: null,
      })
    }

    for (const r of fixedEtudeEnvois as any[]) {
      events.push({
        id: Number(r.IDenvoi_email),
        kind: 'etude',
        date: (r.DATE as string | null) ?? null,
        adresse: r.adresse ?? null,
        societe: r['société'] ?? null,
        soumissionId: null,
        soumissionObservation: null,
      })
    }
    for (const r of fixedSoumEnvois as any[]) {
      const sid = Number(r.IDreference)
      const ctx = soumMap.get(sid)
      events.push({
        id: Number(r.IDenvoi_email),
        kind: 'soumission',
        date: (r.DATE as string | null) ?? null,
        adresse: r.adresse ?? null,
        societe: r['société'] ?? null,
        soumissionId: sid,
        soumissionObservation: ctx?.observation ?? null,
      })
    }

    // Synthetic "soumission acceptée" events — one per accepted soumission
    // with a recorded response date. Lets the Historique tab show a clear
    // "Soumission X acceptée le 23/04/2026" card.
    for (const [sid, ctx] of soumMap) {
      if (ctx.accepte !== 1) continue
      const raw = String(ctx.dateReponse ?? '')
      if (!/^\d{8}$/.test(raw)) continue
      const normalized = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} 23:59:59.999`
      events.push({
        id: `acceptance-${sid}`,
        kind: 'acceptance',
        date: normalized,
        adresse: null,
        societe: null,
        soumissionId: sid,
        soumissionObservation: ctx.observation,
      })
    }

    // Newest-first. Nulls sink to the bottom. Tie-break by string id so
    // numeric + synthetic ids compare safely.
    events.sort((a, b) => {
      if (a.date === b.date) return String(b.id).localeCompare(String(a.id))
      if (!a.date) return 1
      if (!b.date) return -1
      return a.date < b.date ? 1 : -1
    })

    res.json(events)
  } catch (err) {
    console.error('Error fetching étude history:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Create étude ─────────────────────────────────────────

etudesColorisRouter.post('/', async (req: Request, res: Response) => {
  try {
    if (!(await ensureCanEdit(req, res))) return
    const parsed = etudeBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data
    const dateRecep = dateStr(d.date_reception_type)

    await query(
      `INSERT INTO etude_col
         (IDclient, IDref_fini, IDref_fini_colori, IDsous_traitant,
          libelle, num_commande, desig_client, date_reception_type,
          statut_col, commentaire, date_derniere_action)
       VALUES
         (${d.IDclient}, ${d.IDref_fini}, ${d.IDref_fini_colori ?? 0}, ${d.IDsous_traitant ?? 0},
          ${sqlText(d.libelle)}, ${sqlText(d.num_commande ?? '')}, ${sqlText(d.desig_client ?? '')},
          '${dateRecep}', 1, ${sqlText(d.commentaire ?? '')}, '${todayIso()}')`,
    )

    // Find the newly-inserted row. Use the last ID that matches the creation signature.
    const rows = await query<{ IDetude_col: number }>(
      `SELECT TOP 1 IDetude_col FROM etude_col
       WHERE IDclient = ${d.IDclient} AND IDref_fini = ${d.IDref_fini}
       ORDER BY IDetude_col DESC`,
    )
    const newId = rows[0]?.IDetude_col
    if (!newId) { res.status(500).json({ error: 'Insert succeeded but ID not found' }); return }

    const detail = await loadEtudeDetail(newId)
    res.status(201).json(detail)
  } catch (err) {
    console.error('Error creating etude-coloris:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Update étude ─────────────────────────────────────────

etudesColorisRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    if (!(await ensureCanEdit(req, res))) return
    const id = parseInt(String(req.params.id), 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = etudeUpdateBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data

    const sets: string[] = []
    if (d.IDclient !== undefined) sets.push(`IDclient = ${d.IDclient}`)
    if (d.IDref_fini !== undefined) sets.push(`IDref_fini = ${d.IDref_fini}`)
    if (d.IDref_fini_colori !== undefined) sets.push(`IDref_fini_colori = ${d.IDref_fini_colori}`)
    if (d.IDsous_traitant !== undefined) sets.push(`IDsous_traitant = ${d.IDsous_traitant}`)
    if (d.libelle !== undefined) sets.push(`libelle = ${sqlText(d.libelle)}`)
    if (d.num_commande !== undefined) sets.push(`num_commande = ${sqlText(d.num_commande)}`)
    if (d.desig_client !== undefined) sets.push(`desig_client = ${sqlText(d.desig_client)}`)
    if (d.date_reception_type !== undefined)
      sets.push(`date_reception_type = '${dateStr(d.date_reception_type)}'`)
    if (d.statut_col !== undefined) sets.push(`statut_col = ${d.statut_col}`)
    if (d.commentaire !== undefined) sets.push(`commentaire = ${sqlText(d.commentaire)}`)
    if (d.journal !== undefined) sets.push(`journal = ${sqlText(d.journal)}`)

    if (sets.length === 0) {
      res.status(400).json({ error: 'No fields to update' }); return
    }

    // Always touch date_derniere_action on update
    sets.push(`date_derniere_action = '${todayIso()}'`)

    await query(`UPDATE etude_col SET ${sets.join(', ')} WHERE IDetude_col = ${id}`)
    const detail = await loadEtudeDetail(id)
    if (!detail) { res.status(404).json({ error: 'Étude not found' }); return }
    res.json(detail)
  } catch (err) {
    console.error('Error updating etude-coloris:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Delete étude (cascade to soumissions) ────────────────

etudesColorisRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    if (!(await ensureCanEdit(req, res))) return
    const id = parseInt(String(req.params.id), 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await query(`DELETE FROM soum_col WHERE IDetude_col = ${id}`)
    await query(`DELETE FROM etude_col WHERE IDetude_col = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting etude-coloris:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Create soumission (auto-advance parent if needed) ────

etudesColorisRouter.post('/:id/soumissions', async (req: Request, res: Response) => {
  try {
    if (!(await ensureCanEdit(req, res))) return
    const id = parseInt(String(req.params.id), 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = soumissionBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data

    // Confirm parent exists + capture current statut
    const parentRows = await query<{ statut_col: number }>(
      `SELECT statut_col FROM etude_col WHERE IDetude_col = ${id}`,
    )
    if (parentRows.length === 0) { res.status(404).json({ error: 'Étude not found' }); return }
    const currentStatut = coerceStatut(parentRows[0].statut_col)

    // Auto-pick type_soum if empty
    let typeSoum = (d.type_soum ?? '').trim()
    if (typeSoum.length === 0) {
      const existing = await loadSoumissions(id)
      typeSoum = nextTypeSoum(existing)
    }
    const dateSoum = dateStr(d.date_soum) || todayHfsql()

    await query(
      `INSERT INTO soum_col
         (IDetude_col, date_soum, type_soum, observation, date_reponse, accepte)
       VALUES
         (${id}, '${dateSoum}', ${sqlText(typeSoum)}, ${sqlText(d.observation ?? '')}, '', 0)`,
    )

    // Hybrid auto-advance: if étude was "attente labo" (1), bump to "soumis au client" (2)
    if (currentStatut === 1) {
      await query(`UPDATE etude_col SET statut_col = 2 WHERE IDetude_col = ${id}`)
    }
    await touchEtude(id)

    const detail = await loadEtudeDetail(id)
    res.status(201).json(detail)
  } catch (err) {
    console.error('Error creating soumission:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Update soumission fields (type, date, observation) ───

etudesColorisRouter.put('/soumissions/:soumId', async (req: Request, res: Response) => {
  try {
    if (!(await ensureCanEdit(req, res))) return
    const soumId = parseInt(String(req.params.soumId), 10)
    if (isNaN(soumId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = soumissionBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data

    const sets: string[] = []
    if (d.date_soum !== undefined) sets.push(`date_soum = '${dateStr(d.date_soum)}'`)
    if (d.type_soum !== undefined) sets.push(`type_soum = ${sqlText(d.type_soum)}`)
    if (d.observation !== undefined) sets.push(`observation = ${sqlText(d.observation)}`)
    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }

    // Look up parent étude to return a refreshed detail and touch its date
    const parentRows = await query<{ IDetude_col: number }>(
      `SELECT IDetude_col FROM soum_col WHERE IDsoum_col = ${soumId}`,
    )
    if (parentRows.length === 0) { res.status(404).json({ error: 'Soumission not found' }); return }
    const etudeId = Number(parentRows[0].IDetude_col)

    await query(`UPDATE soum_col SET ${sets.join(', ')} WHERE IDsoum_col = ${soumId}`)
    await touchEtude(etudeId)

    const detail = await loadEtudeDetail(etudeId)
    res.json(detail)
  } catch (err) {
    console.error('Error updating soumission:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Delete soumission ────────────────────────────────────

etudesColorisRouter.delete('/soumissions/:soumId', async (req: Request, res: Response) => {
  try {
    if (!(await ensureCanEdit(req, res))) return
    const soumId = parseInt(String(req.params.soumId), 10)
    if (isNaN(soumId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parentRows = await query<{ IDetude_col: number }>(
      `SELECT IDetude_col FROM soum_col WHERE IDsoum_col = ${soumId}`,
    )
    if (parentRows.length === 0) { res.status(404).json({ error: 'Soumission not found' }); return }
    const etudeId = Number(parentRows[0].IDetude_col)

    await query(`DELETE FROM soum_col WHERE IDsoum_col = ${soumId}`)
    await touchEtude(etudeId)

    const detail = await loadEtudeDetail(etudeId)
    res.json(detail)
  } catch (err) {
    console.error('Error deleting soumission:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Respond to soumission (accept / refuse / clear) ──────

etudesColorisRouter.post('/soumissions/:soumId/respond', async (req: Request, res: Response) => {
  try {
    if (!(await ensureCanEdit(req, res))) return
    const soumId = parseInt(String(req.params.soumId), 10)
    if (isNaN(soumId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = respondBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data

    const parentRows = await query<{ IDetude_col: number }>(
      `SELECT IDetude_col FROM soum_col WHERE IDsoum_col = ${soumId}`,
    )
    if (parentRows.length === 0) { res.status(404).json({ error: 'Soumission not found' }); return }
    const etudeId = Number(parentRows[0].IDetude_col)

    // accepte=0 means "clear the response" → wipe date_reponse. Non-zero → set date.
    const dateRep = d.accepte === 0 ? '' : (dateStr(d.date_reponse) || todayHfsql())
    await query(
      `UPDATE soum_col SET accepte = ${d.accepte}, date_reponse = '${dateRep}' WHERE IDsoum_col = ${soumId}`,
    )

    // Acceptance flow: when accepte=1 and a sample number was supplied,
    // create a brand-new ref_fini_colori scoped to the étude's IDref_fini
    // with reference = "<libelle>/<sampleNumber>", point the étude at it,
    // update the étude's libelle to match, and auto-advance statut to 3.
    if (d.accepte === 1 && d.sampleNumber) {
      const sampleNumber = d.sampleNumber.trim()
      const etudeRows = await query<{
        libelle: string | null
        IDref_fini: number
        IDref_fini_colori: number
        IDsous_traitant: number
      }>(
        `SELECT libelle, IDref_fini, IDref_fini_colori, IDsous_traitant
         FROM etude_col WHERE IDetude_col = ${etudeId}`,
      )
      const fixedEtude = await fixEncoding(etudeRows, 'etude_col', 'IDetude_col', ['libelle'])
      const etu = (fixedEtude[0] as any) ?? null
      if (etu) {
        const currentLibelle = ((etu.libelle as string | null) ?? '').trim()
        // Avoid doubling the suffix if the user re-accepts on the same
        // soumission (idempotent-ish): only append when the libelle doesn't
        // already end with "/<sampleNumber>".
        const suffix = `/${sampleNumber}`
        const newLibelle = currentLibelle.endsWith(suffix)
          ? currentLibelle
          : `${currentLibelle}${suffix}`
        const idRefFini = Number(etu.IDref_fini) || 0
        const idSousTraitant = Number(etu.IDsous_traitant) || 0
        let newColoriId = Number(etu.IDref_fini_colori) || 0

        if (idRefFini > 0) {
          // Default the coloris' dye (IDteinture) from the ref's avec_teinture.
          // avec_teinture already encodes the simple/double/no-dye choice, so a
          // newly-accepted coloris defaults to the "Tous Coloris" tier of the
          // matching tier (white is reassigned by hand later if needed):
          //   1 (simple) -> 7 (Tous Coloris simple)
          //   2 (double) -> 5 (Tous Coloris double)
          //   0 (no dye) -> 0
          // Without this, HFSQL stores IDteinture = 0 and ennoblisseur
          // auto-pricing (pricing-sst.ts) can't resolve the dye-only base
          // price, silently dropping the teinture cost from the line.
          const refFiniDyeRows = await query<{ avec_teinture: number }>(
            `SELECT avec_teinture FROM ref_fini WHERE IDref_fini = ${idRefFini}`,
          )
          const avecTeinture = Number(refFiniDyeRows[0]?.avec_teinture) || 0
          const defaultTeinture = avecTeinture === 1 ? 7 : avecTeinture === 2 ? 5 : 0

          // Include IDsous_traitant so the new colori is owned by the
          // étude's sous-traitant (otherwise legacy screens display it as
          // orphan / default "Tricotage Malterre").
          await query(
            `INSERT INTO ref_fini_colori (IDref_fini, IDsous_traitant, IDteinture, reference, observations)
             VALUES (${idRefFini}, ${idSousTraitant}, ${defaultTeinture}, ${sqlText(newLibelle)}, '')`,
          )
          // Look up the new row's ID (HFSQL has no RETURNING).
          const inserted = await query<{ IDref_fini_colori: number }>(
            `SELECT TOP 1 IDref_fini_colori FROM ref_fini_colori
             WHERE IDref_fini = ${idRefFini} AND reference = ${sqlText(newLibelle)}
             ORDER BY IDref_fini_colori DESC`,
          )
          if (inserted[0]?.IDref_fini_colori) {
            newColoriId = Number(inserted[0].IDref_fini_colori)
          }
        }

        await query(
          `UPDATE etude_col SET
             libelle = ${sqlText(newLibelle)},
             IDref_fini_colori = ${newColoriId},
             statut_col = 3
           WHERE IDetude_col = ${etudeId}`,
        )
      }
    } else if (d.accepte === 1) {
      // Plain acceptance (no sample number) — still move statut to 3 so
      // the list filter picks up the final state.
      await query(`UPDATE etude_col SET statut_col = 3 WHERE IDetude_col = ${etudeId}`)
    }

    await touchEtude(etudeId)

    const detail = await loadEtudeDetail(etudeId)
    res.json(detail)
  } catch (err) {
    console.error('Error responding to soumission:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Soumission PDF + email ───────────────────────────────
//
// A "Soumission" is a single proposal within an étude. The PDF is a
// sample carrier sent to the client — dashed placeholders for physical
// samples, numbered from soumission.observation ("1-2" or "4-5-6").

interface SoumissionWithContext {
  soumission: SoumissionRow
  etudeId: number
  idClient: number
  idSousTraitant: number
  idRefFini: number
  idRefFiniColori: number
  desigClient: string | null
  libelleEtude: string | null
  commentaireEtude: string | null
  refFiniReference: string | null
  refFiniColoriReference: string | null
  clientNom: string | null
  sousTraitantNom: string | null
}

async function loadSoumissionContext(soumId: number): Promise<SoumissionWithContext | null> {
  const soumRows = await query<any>(
    `SELECT IDsoum_col, IDetude_col, date_soum, type_soum, observation, date_reponse, accepte
     FROM soum_col WHERE IDsoum_col = ${soumId}`,
  )
  if (soumRows.length === 0) return null
  const fixedSoum = await fixEncoding(soumRows, 'soum_col', 'IDsoum_col', ['type_soum', 'observation'])
  const s = fixedSoum[0] as any

  const etudeId = Number(s.IDetude_col)
  const etudeRows = await query<any>(
    `SELECT IDclient, IDsous_traitant, IDref_fini, IDref_fini_colori, libelle, desig_client, commentaire
     FROM etude_col WHERE IDetude_col = ${etudeId}`,
  )
  if (etudeRows.length === 0) return null
  const fixedEtude = await fixEncoding(etudeRows, 'etude_col', 'IDetude_col', ['libelle', 'desig_client', 'commentaire'])
  const e = fixedEtude[0] as any

  const [refFiniRows, colorisRows, clientRows, sousTraitantRows] = await Promise.all([
    // Each SELECT must include the id column used as fixEncoding's idField below:
    // without it, fixEncoding reads an undefined id → `WHERE col = NaN` → bridge storm.
    Number(e.IDref_fini) > 0
      ? query<{ IDref_fini: number; reference: string | null }>(`SELECT IDref_fini, reference FROM ref_fini WHERE IDref_fini = ${Number(e.IDref_fini)}`)
      : Promise.resolve([]),
    Number(e.IDref_fini_colori) > 0
      ? query<{ IDref_fini_colori: number; reference: string | null }>(
          `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori = ${Number(e.IDref_fini_colori)}`,
        )
      : Promise.resolve([]),
    Number(e.IDclient) > 0
      ? query<{ IDclient: number; nom: string | null }>(`SELECT IDclient, nom FROM client WHERE IDclient = ${Number(e.IDclient)}`)
      : Promise.resolve([]),
    Number(e.IDsous_traitant) > 0
      ? query<{ IDsous_traitant: number; nom: string | null }>(
          `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant = ${Number(e.IDsous_traitant)}`,
        )
      : Promise.resolve([]),
  ])
  const fixedRefFini = await fixEncoding(refFiniRows as any[], 'ref_fini', 'IDref_fini', ['reference'])
  const fixedColoris = await fixEncoding(colorisRows as any[], 'ref_fini_colori', 'IDref_fini_colori', ['reference'])
  const fixedClient = await fixEncoding(clientRows as any[], 'client', 'IDclient', ['nom'])
  const fixedSousTraitant = await fixEncoding(sousTraitantRows as any[], 'sous_traitant', 'IDsous_traitant', ['nom'])

  return {
    soumission: {
      IDsoum_col: Number(s.IDsoum_col),
      IDetude_col: etudeId,
      date_soum: s.date_soum ?? null,
      type_soum: s.type_soum ?? null,
      observation: s.observation ?? null,
      date_reponse: s.date_reponse ?? null,
      accepte: coerceAccepte(s.accepte),
    },
    etudeId,
    idClient: Number(e.IDclient) || 0,
    idSousTraitant: Number(e.IDsous_traitant) || 0,
    idRefFini: Number(e.IDref_fini) || 0,
    idRefFiniColori: Number(e.IDref_fini_colori) || 0,
    desigClient: (e.desig_client as string | null) ?? null,
    libelleEtude: (e.libelle as string | null) ?? null,
    commentaireEtude: (e.commentaire as string | null) ?? null,
    refFiniReference: ((fixedRefFini[0] as any)?.reference ?? null) as string | null,
    refFiniColoriReference: ((fixedColoris[0] as any)?.reference ?? null) as string | null,
    clientNom: ((fixedClient[0] as any)?.nom ?? null) as string | null,
    sousTraitantNom: ((fixedSousTraitant[0] as any)?.nom ?? null) as string | null,
  }
}

async function buildSoumissionPdfData(soumId: number): Promise<SoumissionPdfData | null> {
  const ctx = await loadSoumissionContext(soumId)
  if (!ctx) return null

  // Prefer the soumission's own date; fall back to today so the header
  // isn't blank.
  const dateLong =
    formatHfsqlDateLongFr(ctx.soumission.date_soum) || todayLongFr()

  const clientAdresse = await loadDefaultAdresse('client', ctx.idClient)

  return {
    numero: String(ctx.soumission.IDsoum_col),
    dateDocument: dateLong,
    clientNom: ctx.clientNom,
    clientAdresse,
    refFini: ctx.refFiniReference,
    codeClient: ctx.desigClient,
    // Full étude label ("1202 0593 lilas 63710") preferred; fall back to
    // the raw coloris reference if the étude's libelle is blank.
    codeMalterre: (ctx.libelleEtude && ctx.libelleEtude.trim())
      || ctx.refFiniColoriReference,
    sampleNumbers: parseSampleNumbers(ctx.soumission.observation),
  }
}

async function renderSoumissionPdfBuffer(data: SoumissionPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(SoumissionPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

etudesColorisRouter.get('/soumissions/:soumId/pdf', async (req: Request, res: Response) => {
  try {
    const soumId = parseInt(String(req.params.soumId), 10)
    if (isNaN(soumId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const data = await buildSoumissionPdfData(soumId)
    if (!data) { res.status(404).json({ error: 'Soumission not found' }); return }

    const buffer = await renderSoumissionPdfBuffer(data)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="soumission-${data.numero}.pdf"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering soumission PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

async function buildSoumissionEmailDefaults(soumId: number): Promise<{
  recipients: { selected: EmailRecipientPayload[]; suggestions: EmailRecipientPayload[] }
  subject: string
  body: string
  sousTraitantNom: string
  numero: string
} | null> {
  const ctx = await loadSoumissionContext(soumId)
  if (!ctx) return null

  // Recipients = the sous-traitant's envoi_soumission contacts (the lab
  // doing the coloris work), NOT the end client.
  const contactRows = ctx.idSousTraitant > 0
    ? await query<{
        IDcontact: number
        nom: string | null
        prenom: string | null
        mail: string | null
        envoi_soumission: number | null
        est_visible: number | null
      }>(
        `SELECT IDcontact, nom, prenom, mail, envoi_soumission, est_visible
         FROM contact WHERE IDsous_traitant = ${ctx.idSousTraitant}`,
      )
    : []
  const fixedContacts = await fixEncoding(contactRows, 'contact', 'IDcontact', [
    'nom', 'prenom', 'mail',
  ])

  const selected: EmailRecipientPayload[] = []
  const suggestions: EmailRecipientPayload[] = []
  const seen = new Set<string>()
  for (const c of fixedContacts as any[]) {
    if (c.est_visible === 0) continue
    const raw = (c.mail ?? '').toString().trim()
    if (!raw) continue
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const displayName = [c.prenom, c.nom]
      .map((s: string | null) => (s ?? '').toString().trim())
      .filter((s: string) => s.length > 0)
      .join(' ')
    const recipient: EmailRecipientPayload = {
      email: raw,
      source: 'contact',
      contactId: Number(c.IDcontact),
    }
    if (displayName) recipient.name = displayName
    if (c.envoi_soumission === 1) selected.push(recipient)
    else suggestions.push(recipient)
  }

  const numero = String(soumId)
  const sousTraitantNom = ctx.sousTraitantNom ?? ''
  const clientNom = ctx.clientNom ?? ''
  const refFini = ctx.refFiniReference ?? ''
  const codeClient = ctx.desigClient ?? ''
  const subjectContext = [refFini, codeClient].filter(Boolean).join(' · ')
  const subject = subjectContext
    ? `Soumission N°${numero} — ${subjectContext}`
    : `Soumission N°${numero}`

  const bodyLines = [
    'Bonjour,',
    '',
    `Veuillez trouver ci-joint notre soumission N°${numero}${clientNom ? ` à destination de ${clientNom}` : ''}.`,
    '',
  ]
  if (refFini || codeClient || ctx.refFiniColoriReference) {
    bodyLines.push('Détails :')
    if (refFini) bodyLines.push(`  • Référence fini : ${refFini}`)
    if (codeClient) bodyLines.push(`  • Code client : ${codeClient}`)
    if (ctx.refFiniColoriReference) bodyLines.push(`  • Code Malterre : ${ctx.refFiniColoriReference}`)
    bodyLines.push('')
  }
  bodyLines.push(
    "Merci de bien vouloir nous retourner vos commentaires après examen des échantillons joints.",
    '',
    'Cordialement,',
    'ETS Malterre',
  )

  return {
    recipients: { selected, suggestions },
    subject,
    body: bodyLines.join('\n'),
    sousTraitantNom,
    numero,
  }
}

etudesColorisRouter.get('/soumissions/:soumId/email-defaults', async (req: Request, res: Response) => {
  try {
    const soumId = parseInt(String(req.params.soumId), 10)
    if (isNaN(soumId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const defaults = await buildSoumissionEmailDefaults(soumId)
    if (!defaults) { res.status(404).json({ error: 'Soumission not found' }); return }
    res.json(defaults)
  } catch (err) {
    console.error('Error building soumission email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// envoi_email logging — legacy table shared across every outbound document
// in MPS. One row per recipient. IDtype_doc codes come from the legacy
// type_doc catalog. Never blocks the response: a logging failure is
// reported in the server log but the client still sees a successful send.
const TYPE_DOC_SOUMISSION = 15
const TYPE_DOC_DEMANDE_ETUDE_COLORIS = 27 // "labo coloris"

function nowHfsqlDatetime(): string {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.`
    + `${pad(d.getMilliseconds(), 3)}`
}

/** Insert one envoi_email row per recipient. `societe` is a free-text
 *  label — typically the client name for a soumission. Failures are
 *  swallowed (logged) so the send response path isn't affected. */
async function logEnvoiEmails(
  idTypeDoc: number,
  idReference: number,
  recipients: string[],
  societe: string,
): Promise<void> {
  if (recipients.length === 0) return
  const ts = nowHfsqlDatetime()
  const soc = esc(societe || '')
  for (const raw of recipients) {
    const addr = esc(String(raw).trim())
    if (!addr) continue
    try {
      if (IS_WINDOWS) {
        await query(
          `INSERT INTO envoi_email
             (DATE, adresse, société, IDreference, invalidé, notes, IDtype_doc)
           VALUES
             ('${ts}', '${addr}', '${soc}', ${idReference}, 0, '', ${idTypeDoc})`,
        )
      } else {
        // Linux iODBC bridge rejects the accented identifiers `société`/
        // `invalidé` ([HY090]) — omit them (HFSQL defaults invalidé=0=active,
        // société empty). Same fix as logEnvoiEmails in commandes-sous-traitant.
        await query(
          `INSERT INTO envoi_email
             (DATE, adresse, IDreference, notes, IDtype_doc)
           VALUES
             ('${ts}', '${addr}', ${idReference}, '', ${idTypeDoc})`,
        )
      }
    } catch (e) {
      console.error(`envoi_email log failed (${idTypeDoc}/${idReference}/${addr}):`, (e as Error).message)
    }
  }
}

etudesColorisRouter.post('/soumissions/:soumId/email', async (req: Request, res: Response) => {
  try {
    if (!(await ensureCanEdit(req, res))) return
    const soumId = parseInt(String(req.params.soumId), 10)
    if (isNaN(soumId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }

    const parsed = emailBodySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }

    const senderEmail = await getUserEmail(req.userId)
    if (!senderEmail) {
      res.status(400).json({
        error: 'no_sender_email',
        message:
          "Aucune adresse email n'est associée à votre compte. Un administrateur doit en définir une dans Paramètres › Utilisateurs.",
      })
      return
    }

    const userRows = await query<{ prenom: string | null; nom: string | null }>(
      `SELECT prenom, nom FROM utilisateur WHERE IDutilisateur = ${req.userId}`,
    )
    const fixedUser = await fixEncoding(userRows, 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
    const u = (fixedUser[0] as any) ?? null
    const displayName = u
      ? [u.prenom, u.nom]
          .filter((s: string | null) => s && s.trim())
          .map((s: string) => s.trim())
          .join(' ')
      : ''
    const fromName = displayName ? `${displayName} — ETS Malterre` : 'ETS Malterre'

    const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
    if (parsed.data.attach_pdf !== false) {
      const data = await buildSoumissionPdfData(soumId)
      if (!data) { res.status(404).json({ error: 'Soumission not found' }); return }
      const buffer = await renderSoumissionPdfBuffer(data)
      attachments.push({
        filename: `soumission-${data.numero}.pdf`,
        content: buffer,
        contentType: 'application/pdf',
      })
    }
    for (const a of parsed.data.extra_attachments ?? []) {
      attachments.push({
        filename: a.filename,
        content: Buffer.from(a.content_base64, 'base64'),
        contentType: a.content_type,
      })
    }

    const messageId = await sendMail({
      from: senderEmail,
      fromName,
      to: parsed.data.to,
      cc: parsed.data.cc,
      bcc: parsed.data.bcc,
      subject: parsed.data.subject,
      body: parsed.data.body,
      attachments: attachments.length > 0 ? attachments : undefined,
    })

    // Log one envoi_email row per recipient (TO + CC). Société defaults to
    // the sous-traitant (the actual recipient of the soumission).
    const ctx = await loadSoumissionContext(soumId)
    const societe = ctx?.sousTraitantNom ?? ''
    const recipients = [...parsed.data.to, ...(parsed.data.cc ?? [])]
    await logEnvoiEmails(TYPE_DOC_SOUMISSION, soumId, recipients, societe)

    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending soumission email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})

etudesColorisRouter.get('/soumissions/:soumId/envois', async (req: Request, res: Response) => {
  try {
    const soumId = parseInt(String(req.params.soumId), 10)
    if (isNaN(soumId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const rowsRaw = await query<Record<string, unknown>>(
      `SELECT * FROM envoi_email
       WHERE IDtype_doc = ${TYPE_DOC_SOUMISSION}
         AND IDreference = ${soumId}
       ORDER BY DATE DESC, IDenvoi_email DESC`,
    )
    const rows = (rowsRaw as any[]).filter(isActiveEnvoi)
    const fixed = await fixEncoding(rows as any[], 'envoi_email', 'IDenvoi_email', ['adresse', 'société'])
    res.json(
      (fixed as any[]).map((r) => ({
        IDenvoi_email: Number(r.IDenvoi_email),
        date: r.DATE ?? null,
        adresse: r.adresse ?? null,
        societe: r['société'] ?? null,
      })),
    )
  } catch (err) {
    console.error('Error fetching soumission envois:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Lookups (dropdown sources) ───────────────────────────

etudesColorisRouter.get('/lookups/clients', async (_req: Request, res: Response) => {
  try {
    const sql = IS_WINDOWS
      ? `SELECT IDclient, nom FROM client
         WHERE est_visible = 1 AND archivé = 0
         ORDER BY nom`
      : `SELECT * FROM client
         WHERE est_visible = 1
         ORDER BY nom`
    const rows = await query<Record<string, unknown>>(sql)
    const visible = IS_WINDOWS ? rows : rows.filter((r) => !isArchive(r))
    const shaped = visible.map((r) => ({
      IDclient: Number(r.IDclient),
      nom: (r.nom ?? null) as string | null,
    }))
    const fixed = await fixEncoding(shaped, 'client', 'IDclient', ['nom'])
    res.json(fixed.filter((r: any) => r.nom && String(r.nom).trim().length > 0))
  } catch (err) {
    console.error('Error fetching clients lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

etudesColorisRouter.get('/lookups/refs-fini', async (_req: Request, res: Response) => {
  try {
    const sql = IS_WINDOWS
      ? `SELECT IDref_fini, reference, designation FROM ref_fini
         WHERE archivé = 0
         ORDER BY reference`
      : `SELECT * FROM ref_fini
         ORDER BY reference`
    const rows = await query<Record<string, unknown>>(sql)
    const visible = IS_WINDOWS ? rows : rows.filter((r) => !isArchive(r))
    const shaped = visible.map((r) => ({
      IDref_fini: Number(r.IDref_fini),
      reference: (r.reference ?? null) as string | null,
      designation: (r.designation ?? null) as string | null,
    }))
    const fixed = await fixEncoding(shaped, 'ref_fini', 'IDref_fini', ['reference', 'designation'])
    res.json(fixed.filter((r: any) => r.reference && String(r.reference).trim().length > 0))
  } catch (err) {
    console.error('Error fetching refs-fini lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Open (non-settled, non-archived) commandes for a given client — used as
// the "N° commande" dropdown options on the Nouvelle étude dialog. Returns
// an empty array if no client is specified or no matching rows exist.
etudesColorisRouter.get('/lookups/client-commandes', async (req: Request, res: Response) => {
  try {
    const client = parseInt(String(req.query.client ?? ''), 10)
    if (isNaN(client) || client <= 0) { res.json([]); return }
    const sql = IS_WINDOWS
      ? `SELECT IDcommande_client, numero, ref_client, date_commande
         FROM commande_client
         WHERE IDclient = ${client}
           AND est_soldee = 0
           AND archivé = 0
         ORDER BY date_commande DESC, IDcommande_client DESC`
      : `SELECT * FROM commande_client
         WHERE IDclient = ${client}
           AND est_soldee = 0
         ORDER BY date_commande DESC, IDcommande_client DESC`
    const rawRows = await query<Record<string, unknown>>(sql)
    const visible = IS_WINDOWS ? rawRows : rawRows.filter((r) => !isArchive(r))
    const rows = visible.map((r) => ({
      IDcommande_client: Number(r.IDcommande_client),
      numero: Number(r.numero) || 0,
      ref_client: (r.ref_client ?? null) as string | null,
      date_commande: (r.date_commande ?? null) as string | null,
    }))
    const fixed = await fixEncoding(rows, 'commande_client', 'IDcommande_client', ['ref_client'])
    res.json(
      (fixed as any[]).map((r) => ({
        IDcommande_client: Number(r.IDcommande_client),
        numero: Number(r.numero) || 0,
        ref_client: (r.ref_client ?? null) as string | null,
        date_commande: (r.date_commande ?? null) as string | null,
      })),
    )
  } catch (err) {
    console.error('Error fetching client-commandes lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

etudesColorisRouter.get('/lookups/ref-fini-coloris', async (req: Request, res: Response) => {
  try {
    const refFini = parseInt(String(req.query.ref_fini ?? ''), 10)
    if (isNaN(refFini) || refFini <= 0) { res.json([]); return }

    const rows = await query<{ IDref_fini_colori: number; reference: string | null }>(
      `SELECT IDref_fini_colori, reference FROM ref_fini_colori
       WHERE IDref_fini = ${refFini}
       ORDER BY reference`,
    )
    const fixed = (await fixEncoding(rows, 'ref_fini_colori', 'IDref_fini_colori', ['reference'])) as any[]
    const out = fixed
      .filter((r) => r.reference && String(r.reference).trim().length > 0)
      .map((r) => ({
        IDref_fini_colori: Number(r.IDref_fini_colori),
        reference: r.reference,
        // `has_photo` reserved for future — probing ref_fini_colori.photo with a
        // WHERE clause returns 0 rows on Windows HFSQL ODBC (BinMemo quirk). A
        // scan of 50 "photo IS NOT NULL" rows also showed every blob was
        // effectively empty, so there's nothing to surface in v1. Revisit if
        // real photos start landing.
        has_photo: 0,
      }))
    res.json(out)
  } catch (err) {
    console.error('Error fetching ref-fini-coloris lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

etudesColorisRouter.get('/lookups/sous-traitants', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDsous_traitant: number; nom: string | null }>(
      `SELECT IDsous_traitant, nom FROM sous_traitant WHERE est_visible = 1 ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'sous_traitant', 'IDsous_traitant', ['nom'])
    res.json(fixed.filter((r: any) => r.nom && String(r.nom).trim().length > 0))
  } catch (err) {
    console.error('Error fetching sous-traitants lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Default address for a given owner (client / sous_traitant / fournisseur).
// Used by the Études Adresses tab to render both the client and sous-traitant
// addresses live-following the selection in edit mode. Returns null when the
// owner has no address on file.
etudesColorisRouter.get('/lookups/default-adresse', async (req: Request, res: Response) => {
  try {
    const type = String(req.query.type ?? '')
    const id = parseInt(String(req.query.id ?? ''), 10)
    if (type !== 'client' && type !== 'sous_traitant' && type !== 'fournisseur') {
      res.status(400).json({ error: 'Invalid type (expected client|sous_traitant|fournisseur)' })
      return
    }
    if (isNaN(id) || id <= 0) { res.json(null); return }
    const adr = await loadDefaultAdresse(type, id)
    res.json(adr)
  } catch (err) {
    console.error('Error fetching default adresse lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Photo blob proxy (ref_fini_colori.photo) ─────────────
//
// HFSQL BinMemo IS NOT NULL is unreliable — empty blobs pass the null check.
// Return 404 when the buffer is empty so the frontend can hide the thumbnail
// cleanly. Strip helmet's restrictive headers so cross-origin <img> works in
// dev — mirror §21 / §34.6 of the design skill.

etudesColorisRouter.get('/ref-fini-coloris/:id/photo', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await queryRaw(
      `SELECT photo FROM ref_fini_colori WHERE IDref_fini_colori = ${id}`,
    )
    if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return }

    const raw = rows[0].photo
    if (raw == null) { res.status(404).json({ error: 'No photo' }); return }
    let buf: Buffer
    if (raw instanceof ArrayBuffer) buf = Buffer.from(raw)
    else if (Buffer.isBuffer(raw)) buf = raw
    else { res.status(404).json({ error: 'No photo' }); return }
    if (buf.length === 0 || (buf.length === 1 && buf[0] === 0)) {
      res.status(404).json({ error: 'No photo' }); return
    }

    // MIME sniff (PNG / JPEG / generic)
    let contentType = 'application/octet-stream'
    if (buf.length >= 4) {
      const h = buf.subarray(0, 4)
      if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) contentType = 'image/png'
      else if (h[0] === 0xff && h[1] === 0xd8) contentType = 'image/jpeg'
      else if (h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46) contentType = 'application/pdf'
    }

    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', 'inline')
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.end(buf)
  } catch (err) {
    console.error('Error serving ref_fini_colori photo:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
