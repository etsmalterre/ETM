import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, queryRaw, fixEncoding } from '../lib/hfsql-auto.js'

export const referencesDiversRouter: RouterType = Router()

// ref_divers is the "Divers" catalog (legacy FI_Ref_Divers.wdw) — miscellaneous
// sellable articles that are neither yarn (ref_fil), écru (ref_ecru) nor finished
// fabric (ref_fini). Client order / devis lines point at it with TYPE = 3.
//
// Data model (reverse-engineered from the HFSQL data — the WinDev sources are
// PCS-compressed):
//   ref_divers            designation, prix_unitaire, observations, unite,
//                         archivé, sTypeVariation1, sTypeVariation2
//   ref_divers_variation  one row per variation VALUE; `niveau` = which axis
//                         (1 = sTypeVariation1, 2 = sTypeVariation2). niveau = 0
//                         rows are pre-`niveau` legacy leftovers on refs whose
//                         axes are both "Aucun" — unreachable in the legacy UI,
//                         surfaced here as "orphelines" so they can be cleaned up.
//   tarif_divers          price per variation COMBINATION. A single row with
//                         IDVariation1 = IDVariation2 = 0 means "one price for
//                         every combination" (legacy combo "Saisie du prix:
//                         Global"); rows keyed on variation ids mean per-variation
//                         pricing. A ref with no variation axis has no tarif rows
//                         at all and prices through ref_divers.prix_unitaire.
//   stock_divers          quantity on hand per variation combination.
//
// HFSQL notes:
//   • ref_divers.archivé is ACCENTED — never name it in SQL (the Linux bridge
//     truncates it at the accent and a query on an unknown column triggers a
//     respawn storm on the shared prod server). Reads go through `SELECT *` +
//     pickKey(/^archiv/i); the archive flip uses a named UPDATE on Windows and a
//     delete + positional reinsert on Linux (same shape as references-ecru.ts).
//   • ligne_commande_client.TYPE / ligne_devis_etm.TYPE are reserved words —
//     always alias when selected.
//   • Empty FK columns store 0, never NULL — variation ids use 0 as "none".

const IS_WINDOWS = process.platform === 'win32'

/** Upper bound on rows pre-created when switching a reference to per-variation
 *  pricing. Above it the grid opens blank and fills in on demand. */
const MAX_TARIF_SEED_ROWS = 200

/** Escape a string for SQL (single quotes doubled). */
function esc(value: string): string {
  return value.replace(/'/g, "''")
}

/** SQL literal for user text. ASCII → quoted; accented → Latin-1 hex literal
 *  (raw multi-byte UTF-8 in a SQL line corrupts the Linux bridge). Mirrors
 *  sqlText() in references-ecru.ts / references-fil.ts. */
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
      const c = ch.codePointAt(0) ?? 0x3f
      return c <= 0xff ? c : 0x3f
    }),
  )
  return `x'${bytes.toString('hex')}'`
}

function toNumOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Round to 2 decimals — HFSQL stores prices as 4-byte reals, so 29.30 reads
 *  back as 29.299999237060547. */
function money(v: unknown): number | null {
  const n = toNumOrNull(v)
  if (n == null) return null
  return Math.round(n * 100) / 100
}

function qty(v: unknown): number {
  const n = toNumOrNull(v)
  if (n == null) return 0
  return Math.round(n * 1000) / 1000
}

/** Value of the first row key matching `re`. Accented identifiers come back
 *  truncated on the Linux bridge (archivé → archiv), so resolve dynamically. */
function pickKey(row: Record<string, unknown>, re: RegExp): unknown {
  const k = Object.keys(row).find((key) => re.test(key))
  return k === undefined ? undefined : row[k]
}

/** Variation-axis type. Legacy stores the French label verbatim (no accent on
 *  "Reference"); anything unrecognised is normalised to "Aucun". */
const VARIATION_TYPES = ['Aucun', 'Couleur', 'Taille', 'Reference'] as const
type VariationType = (typeof VARIATION_TYPES)[number]

function normalizeVariationType(v: unknown): VariationType {
  const s = String(v ?? '').trim()
  const hit = VARIATION_TYPES.find((t) => t.toLowerCase() === s.toLowerCase())
  return hit ?? 'Aucun'
}

/** Unit enum shared with ligne_commande_client. The Divers screens label 4 as
 *  "Pièce" (the legacy Divers combo) rather than the generic "unité". */
function uniteLabel(u: unknown): string {
  switch (Number(u)) {
    case 1: return 'Kg'
    case 3: return 'Ml'
    case 4: return 'Pièce'
    case 5: return 'm²'
    default: return ''
  }
}

/** Shape a raw ref_divers row (from SELECT *) into an ASCII-keyed object. */
function normalizeRefDivers(row: Record<string, unknown>) {
  return {
    IDref_divers: Number(row.IDref_divers) || 0,
    designation: (row.designation ?? null) as string | null,
    prix_unitaire: money(row.prix_unitaire) ?? 0,
    observations: (row.observations ?? null) as string | null,
    unite: Number(row.unite) || 0,
    archive: Number(pickKey(row, /^archiv/i)) ? 1 : 0,
    sTypeVariation1: normalizeVariationType(row.sTypeVariation1),
    sTypeVariation2: normalizeVariationType(row.sTypeVariation2),
  }
}

type RefDivers = ReturnType<typeof normalizeRefDivers>

function isArchive(row: Record<string, unknown>): boolean {
  return Number(pickKey(row, /^archiv/i)) === 1
}

/** Batched accent repair for a flat list: one CONVERT(...) WHERE pk IN (...) per
 *  source column, only for the ids whose value actually contains U+FFFD.
 *  Mirrors batchRepair() in references-ecru.ts / references-fini.ts. */
async function batchRepair<T extends Record<string, unknown>>(
  rows: T[],
  table: string,
  idField: string,
  fields: string[],
): Promise<T[]> {
  const idsByField: Record<string, Set<number>> = {}
  let any = false
  for (const f of fields) idsByField[f] = new Set<number>()
  for (const row of rows) {
    const id = Number(row[idField])
    if (!Number.isInteger(id)) continue
    for (const f of fields) {
      const v = row[f]
      if (typeof v === 'string' && v.includes('�')) {
        idsByField[f].add(id)
        any = true
      }
    }
  }
  if (!any) return rows
  const valueByField: Record<string, Map<number, string>> = {}
  for (const f of fields) {
    valueByField[f] = new Map<number, string>()
    const ids = idsByField[f]
    if (ids.size === 0) continue
    try {
      const r = await query<{ id: number; v: unknown }>(
        `SELECT ${idField} AS id, CONVERT(${f} USING 'UTF-8') AS v FROM ${table} WHERE ${idField} IN (${Array.from(ids).join(',')})`,
      )
      for (const rec of r) {
        if (rec.v == null) continue
        valueByField[f].set(
          Number(rec.id),
          rec.v instanceof ArrayBuffer ? Buffer.from(rec.v).toString('utf8') : String(rec.v),
        )
      }
    } catch {
      /* keep originals on failure */
    }
  }
  return rows.map((row) => {
    const id = Number(row[idField])
    let fixed: T | null = null
    for (const f of fields) {
      const v = row[f]
      if (typeof v === 'string' && v.includes('�')) {
        const nv = valueByField[f].get(id)
        if (nv != null) {
          if (!fixed) fixed = { ...row }
          ;(fixed as Record<string, unknown>)[f] = nv
        }
      }
    }
    return fixed ?? row
  })
}

// ──────────────────────────────────────────────────────────
// Shared loaders
// ──────────────────────────────────────────────────────────

interface VariationRow {
  IDref_divers_variation: number
  IDref_divers: number
  designation: string | null
  niveau: number
  prix: number | null
  unite: number
}

async function loadVariations(refId: number): Promise<VariationRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT IDref_divers_variation, IDref_divers, designation, niveau, prix, unite
     FROM ref_divers_variation WHERE IDref_divers = ${refId} ORDER BY niveau, designation`,
  )
  const fixed = await batchRepair(rows, 'ref_divers_variation', 'IDref_divers_variation', ['designation'])
  return fixed.map((r) => ({
    IDref_divers_variation: Number(r.IDref_divers_variation) || 0,
    IDref_divers: Number(r.IDref_divers) || 0,
    designation: (r.designation ?? null) as string | null,
    niveau: Number(r.niveau) || 0,
    prix: money(r.prix),
    unite: Number(r.unite) || 0,
  }))
}

interface TarifRow {
  IDtarif_divers: number
  prix: number
  IDVariation1: number
  IDVariation2: number
}

async function loadTarifs(refId: number): Promise<TarifRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT IDtarif_divers, prix, IDVariation1, IDVariation2
     FROM tarif_divers WHERE IDref_divers = ${refId} ORDER BY IDtarif_divers`,
  )
  return rows.map((r) => ({
    IDtarif_divers: Number(r.IDtarif_divers) || 0,
    prix: money(r.prix) ?? 0,
    IDVariation1: Number(r.IDVariation1) || 0,
    IDVariation2: Number(r.IDVariation2) || 0,
  }))
}

/** "global" = at most one tarif row, keyed on (0, 0) — one price for every
 *  combination. "detail" = at least one row keyed on a real variation id. */
function tarifMode(tarifs: TarifRow[]): 'global' | 'detail' {
  return tarifs.some((t) => t.IDVariation1 !== 0 || t.IDVariation2 !== 0) ? 'detail' : 'global'
}

/** How many rows across the app point at this reference. Drives the delete guard
 *  and the "utilisation" summary in the UI. */
async function refUsage(refId: number) {
  const one = async (sql: string): Promise<number> => {
    try {
      const r = await query<{ n: number }>(sql)
      return Number(r[0]?.n ?? 0)
    } catch {
      return 0
    }
  }
  const [stock, tarifs, variations, lignesCmd, lignesDevis, expeditions] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM stock_divers WHERE IDref_divers = ${refId}`),
    one(`SELECT COUNT(*) AS n FROM tarif_divers WHERE IDref_divers = ${refId}`),
    one(`SELECT COUNT(*) AS n FROM ref_divers_variation WHERE IDref_divers = ${refId}`),
    one(`SELECT COUNT(*) AS n FROM ligne_commande_client WHERE TYPE = 3 AND IDreference = ${refId}`),
    one(`SELECT COUNT(*) AS n FROM ligne_devis_etm WHERE TYPE = 3 AND IDreference = ${refId}`),
    one(`SELECT COUNT(*) AS n FROM ref_divers_expedie WHERE IDref_divers = ${refId}`),
  ])
  return { stock, tarifs, variations, lignes_commande: lignesCmd, lignes_devis: lignesDevis, expeditions }
}

// ──────────────────────────────────────────────────────────
// LOOKUPS
// ──────────────────────────────────────────────────────────

// GET /api/references-divers/lookups/unites
referencesDiversRouter.get('/lookups/unites', (_req: Request, res: Response) => {
  res.json([1, 3, 4, 5].map((u) => ({ unite: u, label: uniteLabel(u) })))
})

// GET /api/references-divers/lookups/types-variation
referencesDiversRouter.get('/lookups/types-variation', (_req: Request, res: Response) => {
  res.json(VARIATION_TYPES.map((t) => ({ value: t, label: t === 'Reference' ? 'Référence' : t })))
})

// ──────────────────────────────────────────────────────────
// LIST
// ──────────────────────────────────────────────────────────

// GET /api/references-divers?archived=0|1
referencesDiversRouter.get('/', async (req: Request, res: Response) => {
  try {
    const wantArchived = req.query.archived === '1'
    const rawRows = await query<Record<string, unknown>>(`SELECT * FROM ref_divers ORDER BY designation`)
    const filtered = rawRows.filter((r) => isArchive(r) === wantArchived)
    let refs = filtered.map((r) => normalizeRefDivers(r))
    refs = (await batchRepair(refs as any, 'ref_divers', 'IDref_divers', ['designation'])) as RefDivers[]

    if (refs.length === 0) {
      res.json([])
      return
    }

    // Batched summaries — one grouped query each, never per row.
    const variationsByRef = new Map<number, number>()
    try {
      const v = await query<{ IDref_divers: number; n: number }>(
        `SELECT IDref_divers, COUNT(*) AS n FROM ref_divers_variation WHERE niveau > 0 GROUP BY IDref_divers`,
      )
      for (const r of v) variationsByRef.set(Number(r.IDref_divers), Number(r.n))
    } catch { /* tolerate */ }

    const stockByRef = new Map<number, number>()
    try {
      const s = await query<{ IDref_divers: number; q: number }>(
        `SELECT IDref_divers, SUM(quantite) AS q FROM stock_divers GROUP BY IDref_divers`,
      )
      for (const r of s) stockByRef.set(Number(r.IDref_divers), qty(r.q))
    } catch { /* tolerate */ }

    // Global tarif (the single 0/0 row) — the display price for refs that carry
    // variations and therefore leave prix_unitaire at 0.
    const globalTarifByRef = new Map<number, number>()
    const detailRefs = new Set<number>()
    try {
      const t = await query<{ IDref_divers: number; prix: number; IDVariation1: number; IDVariation2: number }>(
        `SELECT IDref_divers, prix, IDVariation1, IDVariation2 FROM tarif_divers`,
      )
      for (const r of t) {
        const rid = Number(r.IDref_divers)
        if (Number(r.IDVariation1) === 0 && Number(r.IDVariation2) === 0) {
          globalTarifByRef.set(rid, money(r.prix) ?? 0)
        } else {
          detailRefs.add(rid)
        }
      }
    } catch { /* tolerate */ }

    const out = refs.map((r) => {
      const hasVariations = r.sTypeVariation1 !== 'Aucun' || r.sTypeVariation2 !== 'Aucun'
      const prixAffiche = hasVariations
        ? (detailRefs.has(r.IDref_divers) ? null : globalTarifByRef.get(r.IDref_divers) ?? null)
        : (r.prix_unitaire || null)
      return {
        IDref_divers: r.IDref_divers,
        designation: r.designation,
        unite: r.unite,
        unite_label: uniteLabel(r.unite),
        archive: r.archive,
        sTypeVariation1: r.sTypeVariation1,
        sTypeVariation2: r.sTypeVariation2,
        variations_count: variationsByRef.get(r.IDref_divers) ?? 0,
        stock_total: stockByRef.get(r.IDref_divers) ?? 0,
        prix_affiche: prixAffiche,
        tarif_detaille: detailRefs.has(r.IDref_divers) ? 1 : 0,
      }
    })
    res.json(out)
  } catch (err) {
    console.error('Error fetching ref_divers list:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// DETAIL
// ──────────────────────────────────────────────────────────

// GET /api/references-divers/:id
referencesDiversRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await query<Record<string, unknown>>(`SELECT * FROM ref_divers WHERE IDref_divers = ${id}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Ref divers not found' }); return }
    let ref = normalizeRefDivers(rows[0])
    const fixed = await fixEncoding([ref] as any, 'ref_divers', 'IDref_divers', ['designation', 'observations'])
    ref = fixed[0] as RefDivers

    const [variations, tarifs, usage] = await Promise.all([
      loadVariations(id),
      loadTarifs(id),
      refUsage(id),
    ])
    const varById = new Map(variations.map((v) => [v.IDref_divers_variation, v.designation ?? '']))
    const label = (vid: number): string | null => (vid > 0 ? varById.get(vid) ?? `#${vid}` : null)

    // Stock on hand per variation combination.
    const stockRows = await query<Record<string, unknown>>(
      `SELECT IDstock_divers, quantite, unite, IDVariation1, IDVariation2
       FROM stock_divers WHERE IDref_divers = ${id} ORDER BY IDstock_divers DESC`,
    )
    const stock = stockRows.map((r) => {
      const v1 = Number(r.IDVariation1) || 0
      const v2 = Number(r.IDVariation2) || 0
      return {
        IDstock_divers: Number(r.IDstock_divers) || 0,
        quantite: qty(r.quantite),
        unite: Number(r.unite) || 0,
        unite_label: uniteLabel(Number(r.unite) || ref.unite),
        IDVariation1: v1,
        IDVariation2: v2,
        variation1_label: label(v1),
        variation2_label: label(v2),
      }
    })
    const stockTotal = Math.round(stock.reduce((s, r) => s + r.quantite, 0) * 1000) / 1000

    // Client order lines pointing at this reference (TYPE = 3 is the divers
    // discriminator). Newest first, capped — this is a "where is it used" recap,
    // not a full history screen.
    const ligneRows = await query<Record<string, unknown>>(
      `SELECT IDligne_commande_client, IDcommande_client, quantite, unite, prix, IDvariation1, IDvariation2
       FROM ligne_commande_client WHERE TYPE = 3 AND IDreference = ${id}
       ORDER BY IDligne_commande_client DESC LIMIT 40`,
    )
    const cmdIds = [...new Set(ligneRows.map((r) => Number(r.IDcommande_client) || 0).filter((n) => n > 0))]
    const cmdById = new Map<number, { numero: number; date_commande: string | null; IDclient: number }>()
    const clientNames = new Map<number, string>()
    if (cmdIds.length > 0) {
      const cmds = await query<Record<string, unknown>>(
        `SELECT IDcommande_client, IDclient, numero, date_commande FROM commande_client WHERE IDcommande_client IN (${cmdIds.join(',')})`,
      )
      for (const c of cmds) {
        cmdById.set(Number(c.IDcommande_client), {
          numero: Number(c.numero) || 0,
          date_commande: (c.date_commande ?? null) as string | null,
          IDclient: Number(c.IDclient) || 0,
        })
      }
      const clientIds = [...new Set([...cmdById.values()].map((c) => c.IDclient).filter((n) => n > 0))]
      if (clientIds.length > 0) {
        const cl = await query<{ IDclient: number; nom: string | null }>(
          `SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`,
        )
        for (const c of await fixEncoding(cl, 'client', 'IDclient', ['nom'])) {
          clientNames.set(Number(c.IDclient), String(c.nom ?? ''))
        }
      }
    }
    const commandes = ligneRows.map((r) => {
      const cid = Number(r.IDcommande_client) || 0
      const head = cmdById.get(cid)
      const v1 = Number(r.IDvariation1) || 0
      const v2 = Number(r.IDvariation2) || 0
      return {
        IDligne_commande_client: Number(r.IDligne_commande_client) || 0,
        IDcommande_client: cid,
        numero: head?.numero ?? 0,
        date_commande: head?.date_commande ?? null,
        client_nom: head ? clientNames.get(head.IDclient) ?? null : null,
        quantite: qty(r.quantite),
        unite_label: uniteLabel(Number(r.unite) || ref.unite),
        prix: money(r.prix) ?? 0,
        variation1_label: label(v1),
        variation2_label: label(v2),
      }
    })

    const mode = tarifMode(tarifs)
    const globalRow = tarifs.find((t) => t.IDVariation1 === 0 && t.IDVariation2 === 0)

    res.json({
      ...ref,
      unite_label: uniteLabel(ref.unite),
      variations,
      tarifs,
      tarif_mode: mode,
      tarif_global: globalRow ? globalRow.prix : null,
      stock,
      stock_total: stockTotal,
      commandes,
      usage,
    })
  } catch (err) {
    console.error('Error fetching ref_divers detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// HEADER CRUD
// ──────────────────────────────────────────────────────────

const refDiversBody = z.object({
  designation: z.string().min(1).max(255),
  prix_unitaire: z.number().nullable().optional(),
  observations: z.string().max(20000).nullable().optional(),
  unite: z.number().int().nullable().optional(),
  sTypeVariation1: z.enum(VARIATION_TYPES),
  sTypeVariation2: z.enum(VARIATION_TYPES),
})

// POST /api/references-divers — inline-create a placeholder row.
referencesDiversRouter.post('/', async (_req: Request, res: Response) => {
  try {
    // archivé is never named (accented). New rows default to 0 = "en cours".
    await query(
      `INSERT INTO ref_divers (designation, prix_unitaire, observations, unite, sTypeVariation1, sTypeVariation2)
       VALUES ('Nouvelle référence', 0, '', 4, 'Aucun', 'Aucun')`,
    )
    const rows = await query<{ IDref_divers: number }>(
      `SELECT IDref_divers FROM ref_divers ORDER BY IDref_divers DESC LIMIT 1`,
    )
    res.status(201).json({ IDref_divers: rows[0]?.IDref_divers ?? null })
  } catch (err) {
    console.error('Error creating ref_divers:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/references-divers/:id
referencesDiversRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = refDiversBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const b = parsed.data

    const dup = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ref_divers WHERE designation = ${sqlText(b.designation.trim())} AND IDref_divers <> ${id}`,
    )
    if (Number(dup[0]?.n ?? 0) > 0) {
      res.status(409).json({ error: 'Cette désignation existe déjà.' })
      return
    }

    // Turning an axis off would orphan its variation values (and the tarif /
    // stock rows keyed on them). Refuse rather than silently strand data.
    const existing = await loadVariations(id)
    for (const niveau of [1, 2] as const) {
      const wanted = niveau === 1 ? b.sTypeVariation1 : b.sTypeVariation2
      if (wanted !== 'Aucun') continue
      const values = existing.filter((v) => v.niveau === niveau)
      if (values.length > 0) {
        const what = values.length === 1 ? 'la valeur' : `les ${values.length} valeurs`
        res.status(409).json({
          error: `Supprimez d'abord ${what} de la variation ${niveau} avant de la désactiver.`,
        })
        return
      }
    }

    const sets = [
      `designation = ${sqlText(b.designation.trim())}`,
      `prix_unitaire = ${toNumOrNull(b.prix_unitaire) ?? 0}`,
      `observations = ${sqlText(b.observations ?? '')}`,
      `unite = ${b.unite ?? 0}`,
      `sTypeVariation1 = ${sqlText(b.sTypeVariation1)}`,
      `sTypeVariation2 = ${sqlText(b.sTypeVariation2)}`,
    ]
    await query(`UPDATE ref_divers SET ${sets.join(', ')} WHERE IDref_divers = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating ref_divers:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Physical column order of ref_divers (from SELECT * key order). Used only for
// the Linux archive path (delete + positional reinsert preserving the PK).
const REF_DIVERS_PHYSICAL_COLS = [
  'IDref_divers', 'designation', 'prix_unitaire', 'observations', 'unite',
  'archive', 'sTypeVariation1', 'sTypeVariation2',
] as const
const REF_DIVERS_ARCHIVE_IDX = REF_DIVERS_PHYSICAL_COLS.indexOf('archive')
const REF_DIVERS_TEXT_IDX = new Set([1, 3, 6, 7])

/** Flip ref_divers.archivé. Windows: named UPDATE. Linux: read SELECT * (values
 *  stay in physical order even when the accented key is mangled), flip the
 *  archive slot, delete + positional reinsert preserving the PK. */
async function setArchive(id: number, value: 0 | 1): Promise<void> {
  if (IS_WINDOWS) {
    await query(`UPDATE ref_divers SET archivé = ${value} WHERE IDref_divers = ${id}`)
    return
  }
  const rows = await queryRaw(`SELECT * FROM ref_divers WHERE IDref_divers = ${id}`)
  if (rows.length === 0) return
  const vals = Object.values(rows[0] as Record<string, unknown>)
  vals[REF_DIVERS_ARCHIVE_IDX] = value
  const literals = vals.map((v, i) => {
    if (v == null) return REF_DIVERS_TEXT_IDX.has(i) ? "''" : '0'
    if (REF_DIVERS_TEXT_IDX.has(i)) {
      const s = v instanceof ArrayBuffer ? Buffer.from(v).toString('latin1') : String(v)
      return sqlText(s)
    }
    const n = Number(v)
    return Number.isFinite(n) ? String(n) : '0'
  })
  await query(`DELETE FROM ref_divers WHERE IDref_divers = ${id}`)
  await query(`INSERT INTO ref_divers VALUES (${literals.join(', ')})`)
}

// POST /api/references-divers/:id/archive  &  /unarchive
referencesDiversRouter.post('/:id/archive', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await setArchive(id, 1)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error archiving ref_divers:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

referencesDiversRouter.post('/:id/unarchive', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await setArchive(id, 0)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error unarchiving ref_divers:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-divers/:id — refuse while anything still points at it.
referencesDiversRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const usage = await refUsage(id)
    const blockers: string[] = []
    if (usage.lignes_commande > 0) blockers.push(`${usage.lignes_commande} ligne(s) de commande client`)
    if (usage.lignes_devis > 0) blockers.push(`${usage.lignes_devis} ligne(s) de devis`)
    if (usage.expeditions > 0) blockers.push(`${usage.expeditions} ligne(s) d'expédition`)
    if (usage.stock > 0) blockers.push(`${usage.stock} ligne(s) de stock`)
    if (blockers.length > 0) {
      res.status(409).json({
        error: `Suppression impossible : cette référence est utilisée par ${blockers.join(', ')}. Archivez-la plutôt.`,
      })
      return
    }
    // Only variations + tarifs remain — they belong to the reference, cascade them.
    await query(`DELETE FROM tarif_divers WHERE IDref_divers = ${id}`)
    await query(`DELETE FROM ref_divers_variation WHERE IDref_divers = ${id}`)
    await query(`DELETE FROM ref_divers WHERE IDref_divers = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting ref_divers:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// VARIATIONS
// ──────────────────────────────────────────────────────────

const variationBody = z.object({
  designation: z.string().min(1).max(255),
  niveau: z.number().int().min(1).max(2),
})

// POST /api/references-divers/:id/variations
referencesDiversRouter.post('/:id/variations', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = variationBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const { designation, niveau } = parsed.data

    const refRows = await query<Record<string, unknown>>(`SELECT * FROM ref_divers WHERE IDref_divers = ${id}`)
    if (refRows.length === 0) { res.status(404).json({ error: 'Ref divers not found' }); return }
    const ref = normalizeRefDivers(refRows[0])
    const axis = niveau === 1 ? ref.sTypeVariation1 : ref.sTypeVariation2
    if (axis === 'Aucun') {
      res.status(409).json({ error: `Activez d'abord le type de la variation ${niveau}.` })
      return
    }

    const existing = await loadVariations(id)
    const clash = existing.some(
      (v) => v.niveau === niveau && (v.designation ?? '').trim().toLowerCase() === designation.trim().toLowerCase(),
    )
    if (clash) {
      res.status(409).json({ error: 'Cette valeur existe déjà pour cette variation.' })
      return
    }

    await query(
      `INSERT INTO ref_divers_variation (prix, unite, IDref_divers, designation, niveau)
       VALUES (0, 0, ${id}, ${sqlText(designation.trim())}, ${niveau})`,
    )
    const rows = await query<{ IDref_divers_variation: number }>(
      `SELECT IDref_divers_variation FROM ref_divers_variation WHERE IDref_divers = ${id} ORDER BY IDref_divers_variation DESC LIMIT 1`,
    )
    res.status(201).json({ IDref_divers_variation: rows[0]?.IDref_divers_variation ?? null })
  } catch (err) {
    console.error('Error creating ref_divers_variation:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/references-divers/:id/variations/:vid
referencesDiversRouter.put('/:id/variations/:vid', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const vid = parseInt(req.params.vid, 10)
    if (isNaN(id) || isNaN(vid)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = z.object({ designation: z.string().min(1).max(255) }).safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ref_divers_variation WHERE IDref_divers_variation = ${vid} AND IDref_divers = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) { res.status(404).json({ error: 'Variation not found' }); return }

    await query(
      `UPDATE ref_divers_variation SET designation = ${sqlText(parsed.data.designation.trim())} WHERE IDref_divers_variation = ${vid}`,
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating ref_divers_variation:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-divers/:id/variations/:vid — refuse while stock or an
// order line still points at it; tarif rows keyed on it are cascaded.
referencesDiversRouter.delete('/:id/variations/:vid', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const vid = parseInt(req.params.vid, 10)
    if (isNaN(id) || isNaN(vid)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ref_divers_variation WHERE IDref_divers_variation = ${vid} AND IDref_divers = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) { res.status(404).json({ error: 'Variation not found' }); return }

    const count = async (sql: string) => {
      try {
        const r = await query<{ n: number }>(sql)
        return Number(r[0]?.n ?? 0)
      } catch {
        return 0
      }
    }
    const [inStock, inLignes, inExpe] = await Promise.all([
      count(`SELECT COUNT(*) AS n FROM stock_divers WHERE IDVariation1 = ${vid} OR IDVariation2 = ${vid}`),
      count(`SELECT COUNT(*) AS n FROM ligne_commande_client WHERE IDvariation1 = ${vid} OR IDvariation2 = ${vid}`),
      count(`SELECT COUNT(*) AS n FROM ref_divers_expedie WHERE IDVariation1 = ${vid} OR IDVariation2 = ${vid}`),
    ])
    const blockers: string[] = []
    if (inStock > 0) blockers.push(`${inStock} ligne(s) de stock`)
    if (inLignes > 0) blockers.push(`${inLignes} ligne(s) de commande`)
    if (inExpe > 0) blockers.push(`${inExpe} ligne(s) d'expédition`)
    if (blockers.length > 0) {
      res.status(409).json({ error: `Suppression impossible : cette valeur est utilisée par ${blockers.join(', ')}.` })
      return
    }
    await query(`DELETE FROM tarif_divers WHERE IDref_divers = ${id} AND (IDVariation1 = ${vid} OR IDVariation2 = ${vid})`)
    await query(`DELETE FROM ref_divers_variation WHERE IDref_divers_variation = ${vid}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting ref_divers_variation:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// TARIFS
// ──────────────────────────────────────────────────────────

// PUT /api/references-divers/:id/tarifs — upsert the price of ONE combination.
// (0, 0) is the "global" combination. Returns the refreshed tarif list so the
// caller can hydrate without a follow-up fetch.
referencesDiversRouter.put('/:id/tarifs', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = z
      .object({
        IDVariation1: z.number().int().min(0),
        IDVariation2: z.number().int().min(0),
        prix: z.number().min(0),
      })
      .safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const { IDVariation1: v1, IDVariation2: v2, prix } = parsed.data

    // Every non-zero variation id must belong to this reference.
    const ids = [v1, v2].filter((n) => n > 0)
    if (ids.length > 0) {
      const owned = await query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ref_divers_variation WHERE IDref_divers = ${id} AND IDref_divers_variation IN (${ids.join(',')})`,
      )
      if (Number(owned[0]?.n ?? 0) !== ids.length) {
        res.status(400).json({ error: 'Variation inconnue pour cette référence.' })
        return
      }
    }

    const existing = await query<{ IDtarif_divers: number }>(
      `SELECT IDtarif_divers FROM tarif_divers WHERE IDref_divers = ${id} AND IDVariation1 = ${v1} AND IDVariation2 = ${v2}`,
    )
    if (existing.length > 0) {
      await query(`UPDATE tarif_divers SET prix = ${prix} WHERE IDtarif_divers = ${Number(existing[0].IDtarif_divers)}`)
      // Legacy data has duplicate rows for a few combinations — collapse them.
      for (const dup of existing.slice(1)) {
        await query(`DELETE FROM tarif_divers WHERE IDtarif_divers = ${Number(dup.IDtarif_divers)}`)
      }
    } else {
      await query(
        `INSERT INTO tarif_divers (prix, IDVariation1, IDVariation2, IDref_divers) VALUES (${prix}, ${v1}, ${v2}, ${id})`,
      )
    }
    res.json({ tarifs: await loadTarifs(id) })
  } catch (err) {
    console.error('Error upserting tarif_divers:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/references-divers/:id/tarif-mode — switch between one global price
// and one price per variation combination. Destructive in both directions, so
// the UI confirms first.
referencesDiversRouter.post('/:id/tarif-mode', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = z.object({ mode: z.enum(['global', 'detail']) }).safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }

    const tarifs = await loadTarifs(id)
    if (parsed.data.mode === 'global') {
      // Keep the most common per-variation price as the new global one so the
      // switch doesn't silently zero out the reference.
      const perVariation = tarifs.filter((t) => t.IDVariation1 !== 0 || t.IDVariation2 !== 0)
      const globalRow = tarifs.find((t) => t.IDVariation1 === 0 && t.IDVariation2 === 0)
      let prix = globalRow?.prix ?? 0
      if (!prix && perVariation.length > 0) {
        const counts = new Map<number, number>()
        for (const t of perVariation) counts.set(t.prix, (counts.get(t.prix) ?? 0) + 1)
        prix = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]
      }
      await query(`DELETE FROM tarif_divers WHERE IDref_divers = ${id}`)
      await query(`INSERT INTO tarif_divers (prix, IDVariation1, IDVariation2, IDref_divers) VALUES (${prix}, 0, 0, ${id})`)
    } else {
      // Seed every combination with the previous global price so the grid opens
      // filled in rather than blank.
      const globalRow = tarifs.find((t) => t.IDVariation1 === 0 && t.IDVariation2 === 0)
      const seed = globalRow?.prix ?? 0
      const variations = await loadVariations(id)
      const axis1 = variations.filter((v) => v.niveau === 1)
      const axis2 = variations.filter((v) => v.niveau === 2)
      if (axis1.length === 0 && axis2.length === 0) {
        res.status(409).json({ error: 'Ajoutez au moins une valeur de variation avant de détailler les tarifs.' })
        return
      }
      const combos: Array<[number, number]> = []
      if (axis1.length > 0 && axis2.length > 0) {
        for (const a of axis1) for (const b of axis2) combos.push([a.IDref_divers_variation, b.IDref_divers_variation])
      } else if (axis1.length > 0) {
        for (const a of axis1) combos.push([a.IDref_divers_variation, 0])
      } else {
        for (const b of axis2) combos.push([0, b.IDref_divers_variation])
      }
      const known = new Set(tarifs.map((t) => `${t.IDVariation1}:${t.IDVariation2}`))
      await query(`DELETE FROM tarif_divers WHERE IDref_divers = ${id} AND IDVariation1 = 0 AND IDVariation2 = 0`)
      // Seeding is one INSERT per combination — skip it on very wide grids
      // (19 couleurs × 27 tailles = 513 rows) rather than hammer the shared
      // HFSQL server. The grid then opens with blank cells the user fills in,
      // and each edit upserts its own row through PUT /tarifs.
      const missing = combos.filter(([v1, v2]) => !known.has(`${v1}:${v2}`))
      if (missing.length <= MAX_TARIF_SEED_ROWS) {
        for (const [v1, v2] of missing) {
          await query(
            `INSERT INTO tarif_divers (prix, IDVariation1, IDVariation2, IDref_divers) VALUES (${seed}, ${v1}, ${v2}, ${id})`,
          )
        }
      }
    }
    res.json({ tarifs: await loadTarifs(id) })
  } catch (err) {
    console.error('Error switching tarif mode:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
