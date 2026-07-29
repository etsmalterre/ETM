import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import {
  calcTarifSimulation,
  type PortMode,
  type TarifSimFil,
  type TarifSimInput,
  type TarifSimTraitement,
} from '../lib/pricing-ref-tarif.js'

export const tarifsFiniRouter: RouterType = Router()

// Finis › Tarifs — the price SIMULATOR (legacy `FI_Tarifs.wdw`). A simulation is
// a standalone what-if record: the user types the physical parameters, picks a
// yarn composition and a list of treatments, and reads the resulting sale price
// across nine order-quantity tranches. Nothing here feeds the real catalog —
// it is a costing sandbox, which is why it has its own tables.
//
// Data model (reverse-engineered from the HFSQL data — the WinDev sources are
// PCS-compressed):
//   ref_tarif              one row per simulation. reference, commentaire,
//                          laize, poids (g/m²), rendement (Ml/Kg), freinte,
//                          prix_tricotage, poids_rouleau, port_fixe/port_pct,
//                          multiplicateur (ennoblissement uplift, ratio),
//                          IDteinture (0 = sans teinture), ok_tarif (1 =
//                          archivée). `avec_teinture` is a vestigial copy of the
//                          source ref_fini's flag — the screen drives the dye
//                          mode off IDteinture, which is what legacy displays.
//   asso_fil_tarif         composition: IDref_fil + IDcolori_fil + pourcentage
//                          + `prix`. The price is a per-simulation SNAPSHOT the
//                          user can override, not a live read of ref_fil.prix_kg
//                          — that is the whole point of the screen.
//   asso_traitement_tarif  applied treatments, one row per application. The
//                          same treatment may repeat (simulation 514 carries
//                          Chardonnage ×4). Its metrage/coeff/pv_* columns are
//                          legacy leftovers, always 0.
//
// teinture catalog: IDteinture 1 = Blanc/Simple, 7 = Tous Coloris/Simple,
// 6 = Blanc/Double, 5 = Tous Coloris/Double (`simple_teinture` splits the two
// levels, `designation_interne` the two shades).
//
// HFSQL notes:
//   • ref_tarif.reference and .commentaire hold accented text under ASCII column
//     names — safe to name in SQL, but reads need fixEncoding() and writes need
//     sqlText() (raw multi-byte UTF-8 corrupts the Linux bridge).
//   • No parameterized queries, no RETURNING — insert then re-SELECT the id.
//   • Lookup routes are declared BEFORE '/:id' so Express doesn't swallow them.

/** Escape a string for SQL (single quotes doubled). */
function esc(value: string): string {
  return value.replace(/'/g, "''")
}

/** SQL literal for user text. ASCII → quoted; accented → Latin-1 hex literal
 *  (raw multi-byte UTF-8 in a SQL line corrupts the Linux bridge). Mirrors
 *  sqlText() in references-divers.ts / references-ecru.ts. */
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

/** Round to 2 decimals — HFSQL stores prices as 4-byte reals, so 2.07 reads back
 *  as 2.069999933242798. */
function money(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

/** Round to 4 decimals — for rendement / freinte, where 2 decimals would lose
 *  the precision legacy relies on for the Ml quantities. */
function num4(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0
}

/** SQL literal for a float, guarding against NaN/Infinity reaching the bridge. */
function sqlNum(v: number): string {
  return Number.isFinite(v) ? String(v) : '0'
}

// ──────────────────────────────────────────────────────────
// SHARED LOADERS
// ──────────────────────────────────────────────────────────

interface RefTarifRow {
  IDref_tarif: number
  reference: string | null
  commentaire: string | null
  laize: number
  poids: number
  rendement: number
  freinte: number
  prix_tricotage: number
  poids_rouleau: number
  port_fixe: number
  port_pct: number
  multiplicateur: number
  IDteinture: number
  ok_tarif: number
}

const REF_TARIF_COLS =
  'IDref_tarif, reference, commentaire, laize, poids, rendement, freinte, prix_tricotage, ' +
  'poids_rouleau, port_fixe, port_pct, multiplicateur, IDteinture, ok_tarif'

async function loadRefTarifRow(id: number): Promise<RefTarifRow | null> {
  const rows = await query<RefTarifRow>(
    `SELECT ${REF_TARIF_COLS} FROM ref_tarif WHERE IDref_tarif = ${id}`,
  )
  if (rows.length === 0) return null
  const fixed = (await fixEncoding(rows as any[], 'ref_tarif', 'IDref_tarif', [
    'reference',
    'commentaire',
  ])) as RefTarifRow[]
  return fixed[0] ?? rows[0]
}

/** Teinture catalog, keyed by id. Small table (4 rows) — read whole. */
async function loadTeintures(): Promise<
  Array<{ IDteinture: number; designation_interne: string | null; designation_externe: string | null; simple_teinture: number }>
> {
  const rows = await query<{
    IDteinture: number
    designation_interne: string | null
    designation_externe: string | null
    simple_teinture: number
  }>(
    `SELECT IDteinture, designation_interne, designation_externe, simple_teinture
       FROM teinture ORDER BY IDteinture`,
  )
  return (await fixEncoding(rows as any[], 'teinture', 'IDteinture', [
    'designation_interne',
    'designation_externe',
  ])) as any
}

/** Composition lines of one simulation, with yarn + coloris labels resolved.
 *  Flat queries + JS merge — a JOIN + CONVERT collapses the result set on the
 *  Linux bridge (see CLAUDE.md). */
async function loadFils(id: number): Promise<TarifSimFil[]> {
  const rows = await query<{
    IDasso_fil_tarif: number
    IDref_tarif: number
    IDref_fil: number
    IDcolori_fil: number
    pourcentage: number
    prix: number
  }>(
    `SELECT IDasso_fil_tarif, IDref_tarif, IDref_fil, IDcolori_fil, pourcentage, prix
       FROM asso_fil_tarif WHERE IDref_tarif = ${id} ORDER BY IDasso_fil_tarif`,
  )
  if (rows.length === 0) return []

  const filIds = Array.from(new Set(rows.map((r) => Number(r.IDref_fil)).filter((n) => n > 0)))
  const colIds = Array.from(new Set(rows.map((r) => Number(r.IDcolori_fil)).filter((n) => n > 0)))

  const refById = new Map<number, string | null>()
  if (filIds.length > 0) {
    const refs = await query<{ IDref_fil: number; reference: string | null }>(
      `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${filIds.join(',')})`,
    )
    const fixed = (await fixEncoding(refs as any[], 'ref_fil', 'IDref_fil', ['reference'])) as Array<{
      IDref_fil: number
      reference: string | null
    }>
    for (const r of fixed) refById.set(Number(r.IDref_fil), r.reference ?? null)
  }

  const colById = new Map<number, string | null>()
  if (colIds.length > 0) {
    const cols = await query<{ IDcolori_fil: number; reference: string | null }>(
      `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${colIds.join(',')})`,
    )
    const fixed = (await fixEncoding(cols as any[], 'colori_fil', 'IDcolori_fil', [
      'reference',
    ])) as Array<{ IDcolori_fil: number; reference: string | null }>
    for (const c of fixed) colById.set(Number(c.IDcolori_fil), c.reference ?? null)
  }

  return rows.map((r) => ({
    IDasso_fil_tarif: Number(r.IDasso_fil_tarif),
    IDref_fil: Number(r.IDref_fil) || 0,
    ref_label: refById.get(Number(r.IDref_fil)) ?? null,
    IDcolori_fil: Number(r.IDcolori_fil) || 0,
    colori_label: colById.get(Number(r.IDcolori_fil)) ?? null,
    pourcentage: num4(r.pourcentage),
    prix: money(r.prix),
  }))
}

/** Applied treatments of one simulation, ordered by the catalog's `ordre` so the
 *  list reads in process order (Préfixation → Lavage → … → Chardonnage). */
async function loadTraitements(id: number): Promise<TarifSimTraitement[]> {
  const rows = await query<{ IDasso_traitement_tarif: number; IDtraitement: number }>(
    `SELECT IDasso_traitement_tarif, IDtraitement FROM asso_traitement_tarif
      WHERE IDref_tarif = ${id}`,
  )
  if (rows.length === 0) return []

  const ids = Array.from(new Set(rows.map((r) => Number(r.IDtraitement)).filter((n) => n > 0)))
  const byId = new Map<number, { designation: string | null; ordre: number }>()
  if (ids.length > 0) {
    const trt = await query<{ IDtraitement: number; designation: string | null; ordre: number }>(
      `SELECT IDtraitement, designation, ordre FROM traitement WHERE IDtraitement IN (${ids.join(',')})`,
    )
    const fixed = (await fixEncoding(trt as any[], 'traitement', 'IDtraitement', [
      'designation',
    ])) as Array<{ IDtraitement: number; designation: string | null; ordre: number }>
    for (const t of fixed) {
      byId.set(Number(t.IDtraitement), { designation: t.designation ?? null, ordre: Number(t.ordre) || 0 })
    }
  }

  return rows
    .map((r) => ({
      IDasso_traitement_tarif: Number(r.IDasso_traitement_tarif),
      IDtraitement: Number(r.IDtraitement) || 0,
      designation: byId.get(Number(r.IDtraitement))?.designation ?? null,
      _ordre: byId.get(Number(r.IDtraitement))?.ordre ?? 999,
    }))
    .sort((a, b) => a._ordre - b._ordre || a.IDasso_traitement_tarif - b.IDasso_traitement_tarif)
    .map(({ _ordre, ...rest }) => rest)
}

/** `port_pct > 0` means percentage mode; otherwise the flat €/Kg column drives. */
function portModeOf(row: { port_pct: number; port_fixe: number }): PortMode {
  return Number(row.port_pct) > 0 ? 'pct' : 'kg'
}

/** Assemble everything the pricing engine needs for one simulation. */
async function buildSimInput(id: number): Promise<TarifSimInput | null> {
  const row = await loadRefTarifRow(id)
  if (!row) return null
  const [fils, traitements, teintures] = await Promise.all([
    loadFils(id),
    loadTraitements(id),
    loadTeintures(),
  ])
  const IDteinture = Number(row.IDteinture) || 0
  const teinture = teintures.find((t) => Number(t.IDteinture) === IDteinture) ?? null
  return {
    IDref_tarif: id,
    rendement: num4(row.rendement),
    poids_rouleau: num4(row.poids_rouleau),
    prix_tricotage: money(row.prix_tricotage),
    port_mode: portModeOf(row),
    port_fixe: money(row.port_fixe),
    port_pct: num4(row.port_pct),
    multiplicateur: num4(row.multiplicateur),
    IDteinture,
    teinture_label: teinture?.designation_externe ?? null,
    fils,
    traitements,
  }
}

// ──────────────────────────────────────────────────────────
// LOOKUPS (declared before '/:id')
// ──────────────────────────────────────────────────────────

// GET /api/tarifs-fini/lookups/fils — yarn catalog + each ref's coloris, for
// the "Ajouter un fil" picker. `prix_kg` seeds the new line's editable price.
tarifsFiniRouter.get('/lookups/fils', async (_req: Request, res: Response) => {
  try {
    const refs = await query<{ IDref_fil: number; reference: string | null; prix_kg: number | null }>(
      `SELECT IDref_fil, reference, prix_kg FROM ref_fil ORDER BY reference`,
    )
    const refsFixed = (await fixEncoding(refs as any[], 'ref_fil', 'IDref_fil', [
      'reference',
    ])) as Array<{ IDref_fil: number; reference: string | null; prix_kg: number | null }>

    const cols = await query<{
      IDcolori_fil: number
      IDref_fil: number
      reference: string | null
      prix_kg: number | null
    }>(`SELECT IDcolori_fil, IDref_fil, reference, prix_kg FROM colori_fil ORDER BY reference`)
    const colsFixed = (await fixEncoding(cols as any[], 'colori_fil', 'IDcolori_fil', [
      'reference',
    ])) as Array<{
      IDcolori_fil: number
      IDref_fil: number
      reference: string | null
      prix_kg: number | null
    }>

    const colorisByRef = new Map<number, Array<{ id: number; reference: string | null; prix_kg: number }>>()
    for (const c of colsFixed) {
      const k = Number(c.IDref_fil) || 0
      const arr = colorisByRef.get(k) ?? []
      arr.push({ id: Number(c.IDcolori_fil), reference: c.reference ?? null, prix_kg: money(c.prix_kg) })
      colorisByRef.set(k, arr)
    }

    res.json(
      refsFixed.map((r) => ({
        IDref_fil: Number(r.IDref_fil),
        reference: r.reference ?? null,
        prix_kg: money(r.prix_kg),
        coloris: colorisByRef.get(Number(r.IDref_fil)) ?? [],
      })),
    )
  } catch (err) {
    console.error('Error fetching tarif fils lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/tarifs-fini/lookups/traitements — the ennoblissement catalog.
tarifsFiniRouter.get('/lookups/traitements', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDtraitement: number; designation: string | null; ordre: number; is_deleted: number }>(
      `SELECT IDtraitement, designation, ordre, is_deleted FROM traitement ORDER BY ordre`,
    )
    const fixed = (await fixEncoding(rows as any[], 'traitement', 'IDtraitement', [
      'designation',
    ])) as Array<{ IDtraitement: number; designation: string | null; ordre: number; is_deleted: number }>
    res.json(
      fixed
        .filter((t) => Number(t.is_deleted) !== 1)
        .map((t) => ({
          IDtraitement: Number(t.IDtraitement),
          designation: t.designation ?? null,
          ordre: Number(t.ordre) || 0,
        })),
    )
  } catch (err) {
    console.error('Error fetching traitements lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/tarifs-fini/lookups/teintures — the 4 dye rows, so the screen can
// map (mode simple/double) × (Blanc / Tous Coloris) onto an IDteinture.
tarifsFiniRouter.get('/lookups/teintures', async (_req: Request, res: Response) => {
  try {
    const rows = await loadTeintures()
    res.json(
      rows.map((t) => ({
        IDteinture: Number(t.IDteinture),
        designation_interne: t.designation_interne ?? null,
        designation_externe: t.designation_externe ?? null,
        simple_teinture: Number(t.simple_teinture) || 0,
      })),
    )
  } catch (err) {
    console.error('Error fetching teintures lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/tarifs-fini/lookups/refs-finies — source list for "Importer depuis
// une référence finie". Only refs with an écru (they carry the composition and
// the knitting price) are offered.
tarifsFiniRouter.get('/lookups/refs-finies', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{
      IDref_fini: number
      reference: string | null
      designation: string | null
      IDref_ecru: number
    }>(
      `SELECT IDref_fini, reference, designation, IDref_ecru FROM ref_fini
        WHERE IDref_ecru > 0 ORDER BY reference`,
    )
    const fixed = (await fixEncoding(rows as any[], 'ref_fini', 'IDref_fini', [
      'reference',
      'designation',
    ])) as Array<{ IDref_fini: number; reference: string | null; designation: string | null }>
    res.json(
      fixed.map((r) => ({
        IDref_fini: Number(r.IDref_fini),
        reference: r.reference ?? null,
        designation: r.designation ?? null,
      })),
    )
  } catch (err) {
    console.error('Error fetching refs-finies lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// LIST
// ──────────────────────────────────────────────────────────

// GET /api/tarifs-fini — every simulation, light payload for the left list.
tarifsFiniRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const rows = await query<RefTarifRow>(`SELECT ${REF_TARIF_COLS} FROM ref_tarif`)
    const fixed = (await fixEncoding(rows as any[], 'ref_tarif', 'IDref_tarif', [
      'reference',
    ])) as RefTarifRow[]

    const teintures = await loadTeintures()
    const teintureById = new Map(teintures.map((t) => [Number(t.IDteinture), t]))

    // Composition line count per simulation, batched.
    const counts = await query<{ IDref_tarif: number; n: number }>(
      `SELECT IDref_tarif, COUNT(*) AS n FROM asso_fil_tarif GROUP BY IDref_tarif`,
    )
    const filsCount = new Map<number, number>()
    for (const c of counts) filsCount.set(Number(c.IDref_tarif), Number(c.n))

    const out = fixed
      .map((r) => {
        const t = teintureById.get(Number(r.IDteinture) || 0)
        return {
          IDref_tarif: Number(r.IDref_tarif),
          reference: r.reference ?? null,
          ok_tarif: Number(r.ok_tarif) || 0,
          IDteinture: Number(r.IDteinture) || 0,
          teinture_mode: t ? (Number(t.simple_teinture) === 1 ? 'simple' : 'double') : 'sans',
          teinture_shade: t?.designation_interne ?? null,
          laize: num4(r.laize),
          poids: num4(r.poids),
          rendement: num4(r.rendement),
          fils_count: filsCount.get(Number(r.IDref_tarif)) ?? 0,
        }
      })
      .sort((a, b) => (a.reference ?? '').localeCompare(b.reference ?? '', 'fr'))

    res.json(out)
  } catch (err) {
    console.error('Error fetching ref_tarif list:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// DETAIL
// ──────────────────────────────────────────────────────────

async function loadDetail(id: number) {
  const row = await loadRefTarifRow(id)
  if (!row) return null
  const [fils, traitements] = await Promise.all([loadFils(id), loadTraitements(id)])
  return {
    IDref_tarif: Number(row.IDref_tarif),
    reference: row.reference ?? '',
    commentaire: row.commentaire ?? '',
    laize: num4(row.laize),
    poids: num4(row.poids),
    rendement: num4(row.rendement),
    freinte: num4(row.freinte),
    prix_tricotage: money(row.prix_tricotage),
    poids_rouleau: num4(row.poids_rouleau),
    port_mode: portModeOf(row),
    port_fixe: money(row.port_fixe),
    port_pct: num4(row.port_pct),
    multiplicateur: num4(row.multiplicateur),
    IDteinture: Number(row.IDteinture) || 0,
    ok_tarif: Number(row.ok_tarif) || 0,
    fils,
    traitements,
  }
}

// GET /api/tarifs-fini/:id
tarifsFiniRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const detail = await loadDetail(id)
    if (!detail) { res.status(404).json({ error: 'Simulation not found' }); return }
    res.json(detail)
  } catch (err) {
    console.error('Error fetching ref_tarif detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/tarifs-fini/:id/tarif?poids=&coefficient=&prix_cible_ml=
// The nine standard tranches, plus a free simulation when `poids` is given.
tarifsFiniRouter.get('/:id/tarif', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const input = await buildSimInput(id)
    if (!input) { res.status(404).json({ error: 'Simulation not found' }); return }

    const poids = Number(req.query.poids)
    let libreOpts
    if (Number.isFinite(poids) && poids > 0) {
      const coefficient = Number(req.query.coefficient)
      const prixCible = Number(req.query.prix_cible_ml)
      libreOpts = {
        poids,
        // The client sends a percentage (35) — the engine wants a ratio.
        coefficient: Number.isFinite(coefficient) && coefficient > 0 ? coefficient / 100 : undefined,
        prix_cible_ml: Number.isFinite(prixCible) && prixCible > 0 ? prixCible : undefined,
      }
    }

    res.json(await calcTarifSimulation(input, libreOpts))
  } catch (err) {
    console.error('Error computing ref_tarif simulation:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/tarifs-fini/:id/preview
// Same computation as GET /:id/tarif but priced against UNSAVED parameters —
// this is what makes the screen a simulator: the right panel recalculates while
// the user drags the freinte or the multiplicateur around, before anything is
// written. The composition and treatments still come from the stored rows (they
// persist as soon as they are edited).
const previewBody = z.object({
  params: z
    .object({
      rendement: z.number().min(0).max(100),
      poids_rouleau: z.number().min(0).max(10000),
      prix_tricotage: z.number().min(0).max(10000),
      port_mode: z.enum(['pct', 'kg']),
      port_fixe: z.number().min(0).max(1000),
      port_pct: z.number().min(0).max(100),
      multiplicateur: z.number().min(-1).max(10),
      IDteinture: z.number().int().min(0),
    })
    .optional(),
  libre: z
    .object({
      poids: z.number().min(0).max(1000000),
      coefficient: z.number().min(0).max(100).optional(),
      prix_cible_ml: z.number().min(0).max(100000).optional(),
    })
    .optional(),
})

tarifsFiniRouter.post('/:id/preview', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = previewBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }

    const stored = await buildSimInput(id)
    if (!stored) { res.status(404).json({ error: 'Simulation not found' }); return }

    let input = stored
    const p = parsed.data.params
    if (p) {
      // The dye LABEL follows the overridden id, otherwise the breakdown would
      // name the saved dye while pricing the drafted one.
      const teintures = await loadTeintures()
      const t = teintures.find((x) => Number(x.IDteinture) === p.IDteinture) ?? null
      input = {
        ...stored,
        rendement: p.rendement,
        poids_rouleau: p.poids_rouleau,
        prix_tricotage: p.prix_tricotage,
        port_mode: p.port_mode,
        port_fixe: p.port_fixe,
        port_pct: p.port_pct,
        multiplicateur: p.multiplicateur,
        IDteinture: p.IDteinture,
        teinture_label: t?.designation_externe ?? null,
      }
    }

    const l = parsed.data.libre
    const libreOpts =
      l && l.poids > 0
        ? {
            poids: l.poids,
            // The client sends a percentage (35) — the engine wants a ratio.
            coefficient: l.coefficient !== undefined && l.coefficient > 0 ? l.coefficient / 100 : undefined,
            prix_cible_ml: l.prix_cible_ml !== undefined && l.prix_cible_ml > 0 ? l.prix_cible_ml : undefined,
          }
        : undefined

    res.json(await calcTarifSimulation(input, libreOpts))
  } catch (err) {
    console.error('Error previewing ref_tarif simulation:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// CREATE
// ──────────────────────────────────────────────────────────

/** Defaults for a blank simulation — the values every legacy row carries. */
const BLANK_DEFAULTS = {
  laize: 0,
  poids: 0,
  rendement: 0,
  freinte: 0.1,
  prix_tricotage: 0,
  poids_rouleau: 20,
  port_fixe: 0,
  port_pct: 5,
  multiplicateur: 0,
  IDteinture: 0,
}

const createBody = z.object({
  mode: z.enum(['blank', 'duplicate', 'from_fini']),
  reference: z.string().trim().min(1).max(120),
  /** ref_tarif id for `duplicate`, ref_fini id for `from_fini`. */
  source_id: z.number().int().positive().optional(),
})

/** Insert a ref_tarif header and return its new id. HFSQL assigns the PK. */
async function insertRefTarif(v: {
  reference: string
  commentaire: string
  laize: number
  poids: number
  rendement: number
  freinte: number
  prix_tricotage: number
  poids_rouleau: number
  port_fixe: number
  port_pct: number
  multiplicateur: number
  IDteinture: number
}): Promise<number | null> {
  await query(
    `INSERT INTO ref_tarif
       (reference, designation, commentaire, laize, poids, rendement, freinte,
        prix_tricotage, poids_rouleau, port_fixe, port_pct, multiplicateur,
        IDteinture, avec_teinture, poids_teinture, ok_tarif, plus_moins_poids, plus_moins_laize)
     VALUES
       (${sqlText(v.reference)}, '', ${sqlText(v.commentaire)}, ${sqlNum(v.laize)}, ${sqlNum(v.poids)},
        ${sqlNum(v.rendement)}, ${sqlNum(v.freinte)}, ${sqlNum(v.prix_tricotage)}, ${sqlNum(v.poids_rouleau)},
        ${sqlNum(v.port_fixe)}, ${sqlNum(v.port_pct)}, ${sqlNum(v.multiplicateur)},
        ${v.IDteinture}, ${v.IDteinture > 0 ? 1 : 0}, 0, 0, 0, 0)`,
  )
  const rows = await query<{ IDref_tarif: number }>(
    `SELECT TOP 1 IDref_tarif FROM ref_tarif ORDER BY IDref_tarif DESC`,
  )
  return rows[0]?.IDref_tarif ?? null
}

async function insertFilLine(
  refTarifId: number,
  v: { IDref_fil: number; IDcolori_fil: number; pourcentage: number; prix: number },
): Promise<void> {
  await query(
    `INSERT INTO asso_fil_tarif (IDref_tarif, IDref_fil, IDcolori_fil, pourcentage, prix)
     VALUES (${refTarifId}, ${v.IDref_fil}, ${v.IDcolori_fil}, ${sqlNum(v.pourcentage)}, ${sqlNum(v.prix)})`,
  )
}

async function insertTraitementLine(refTarifId: number, IDtraitement: number): Promise<void> {
  await query(
    `INSERT INTO asso_traitement_tarif (IDref_tarif, IDtraitement, metrage, coeff, pv_calcule, pv_saisi)
     VALUES (${refTarifId}, ${IDtraitement}, 0, 0, 0, 0)`,
  )
}

/** Seed a new simulation from an existing one — params, composition, treatments. */
async function seedFromSimulation(newId: number, sourceId: number): Promise<void> {
  const fils = await loadFils(sourceId)
  for (const f of fils) {
    await insertFilLine(newId, {
      IDref_fil: f.IDref_fil,
      IDcolori_fil: f.IDcolori_fil,
      pourcentage: f.pourcentage,
      prix: f.prix,
    })
  }
  const traitements = await loadTraitements(sourceId)
  for (const t of traitements) await insertTraitementLine(newId, t.IDtraitement)
}

/**
 * Seed a new simulation from a real `ref_fini` — how every "Copie de …" row in
 * the legacy data was made. Copies the geometry from ref_fini, the knitting
 * price + roll weight from its ref_ecru, the écru's yarn composition (with the
 * yarn prices SNAPSHOTTED so later catalog moves don't rewrite history), and
 * the ref's treatment list.
 */
async function seedFromRefFini(newId: number, IDref_fini: number): Promise<void> {
  const refRows = await query<{
    IDref_ecru: number
    IDcolori_ecru: number
    rendement: number | null
  }>(`SELECT IDref_ecru, IDcolori_ecru, rendement FROM ref_fini WHERE IDref_fini = ${IDref_fini}`)
  if (refRows.length === 0) return
  const IDref_ecru = Number(refRows[0].IDref_ecru) || 0
  const IDcolori_ecru = Number(refRows[0].IDcolori_ecru) || 0

  // Composition of the écru, preferring the chosen coloris' own recipe.
  if (IDref_ecru > 0) {
    let comp = await query<{ IDref_fil: number; IDcolori_fil: number; pourcentage: number | null }>(
      `SELECT IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru
        WHERE IDref_ecru = ${IDref_ecru} AND IDcolori_ecru = ${IDcolori_ecru}`,
    )
    if (comp.length === 0 && IDcolori_ecru !== 0) {
      comp = await query<{ IDref_fil: number; IDcolori_fil: number; pourcentage: number | null }>(
        `SELECT IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru
          WHERE IDref_ecru = ${IDref_ecru} AND IDcolori_ecru = 0`,
      )
    }

    // Snapshot each line's €/Kg: the coloris price when set, else the ref's.
    const filIds = Array.from(new Set(comp.map((c) => Number(c.IDref_fil)).filter((n) => n > 0)))
    const colIds = Array.from(new Set(comp.map((c) => Number(c.IDcolori_fil)).filter((n) => n > 0)))
    const filPrix = new Map<number, number>()
    if (filIds.length > 0) {
      const rows = await query<{ IDref_fil: number; prix_kg: number | null }>(
        `SELECT IDref_fil, prix_kg FROM ref_fil WHERE IDref_fil IN (${filIds.join(',')})`,
      )
      for (const r of rows) filPrix.set(Number(r.IDref_fil), money(r.prix_kg))
    }
    const colPrix = new Map<number, number>()
    if (colIds.length > 0) {
      const rows = await query<{ IDcolori_fil: number; prix_kg: number | null }>(
        `SELECT IDcolori_fil, prix_kg FROM colori_fil WHERE IDcolori_fil IN (${colIds.join(',')})`,
      )
      for (const r of rows) colPrix.set(Number(r.IDcolori_fil), money(r.prix_kg))
    }

    for (const c of comp) {
      const colP = colPrix.get(Number(c.IDcolori_fil)) ?? 0
      await insertFilLine(newId, {
        IDref_fil: Number(c.IDref_fil) || 0,
        IDcolori_fil: Number(c.IDcolori_fil) || 0,
        pourcentage: num4(c.pourcentage),
        prix: colP !== 0 ? colP : (filPrix.get(Number(c.IDref_fil)) ?? 0),
      })
    }
  }

  // Treatments applied to the finished reference.
  const trt = await query<{ IDtraitement: number }>(
    `SELECT IDtraitement FROM traitement_ref_fini WHERE IDref_fini = ${IDref_fini}`,
  )
  for (const t of trt) {
    const tid = Number(t.IDtraitement) || 0
    if (tid > 0) await insertTraitementLine(newId, tid)
  }
}

/** Geometry + knitting parameters copied when importing a ref_fini. */
async function refFiniSeedParams(IDref_fini: number) {
  const rows = await query<Record<string, unknown>>(
    `SELECT IDref_fini, IDref_ecru, rendement, freinte, laizeUtile_Moy, laizeHT_Moy, poids_Moy, avec_teinture
       FROM ref_fini WHERE IDref_fini = ${IDref_fini}`,
  )
  if (rows.length === 0) return null
  const r = rows[0]
  const IDref_ecru = Number(r.IDref_ecru) || 0

  let prixTricotage = 0
  let poidsRouleau = BLANK_DEFAULTS.poids_rouleau
  if (IDref_ecru > 0) {
    const ecru = await query<{ prix: number | null; poids: number | null }>(
      `SELECT prix, poids FROM ref_ecru WHERE IDref_ecru = ${IDref_ecru}`,
    )
    if (ecru.length > 0) {
      prixTricotage = money(ecru[0].prix)
      const p = num4(ecru[0].poids)
      if (p > 0) poidsRouleau = p
    }
  }

  // avec_teinture 0 = wash only. 1 = simple, 2 = double — map onto the "Tous
  // Coloris" dye of the matching level (7 / 5), the legacy default.
  const avecTeinture = Number(r.avec_teinture) || 0
  const IDteinture = avecTeinture === 2 ? 5 : avecTeinture === 1 ? 7 : 0

  return {
    laize: num4(r.laizeUtile_Moy) || num4(r.laizeHT_Moy),
    poids: num4(r.poids_Moy),
    rendement: num4(r.rendement),
    freinte: num4(r.freinte),
    prix_tricotage: prixTricotage,
    poids_rouleau: poidsRouleau,
    IDteinture,
  }
}

// POST /api/tarifs-fini — create a simulation (blank / duplicate / from_fini).
tarifsFiniRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = createBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const { mode, reference, source_id } = parsed.data

    let params = { ...BLANK_DEFAULTS }
    let commentaire = ''

    if (mode === 'duplicate') {
      if (!source_id) { res.status(400).json({ error: 'source_id required' }); return }
      const src = await loadRefTarifRow(source_id)
      if (!src) { res.status(404).json({ error: 'Simulation source introuvable' }); return }
      params = {
        laize: num4(src.laize),
        poids: num4(src.poids),
        rendement: num4(src.rendement),
        freinte: num4(src.freinte),
        prix_tricotage: money(src.prix_tricotage),
        poids_rouleau: num4(src.poids_rouleau),
        port_fixe: money(src.port_fixe),
        port_pct: num4(src.port_pct),
        multiplicateur: num4(src.multiplicateur),
        IDteinture: Number(src.IDteinture) || 0,
      }
      commentaire = src.commentaire ?? ''
    } else if (mode === 'from_fini') {
      if (!source_id) { res.status(400).json({ error: 'source_id required' }); return }
      const seed = await refFiniSeedParams(source_id)
      if (!seed) { res.status(404).json({ error: 'Référence finie introuvable' }); return }
      params = { ...BLANK_DEFAULTS, ...seed }
    }

    const newId = await insertRefTarif({ reference, commentaire, ...params })
    if (!newId) { res.status(500).json({ error: 'Insert succeeded but ID not found' }); return }

    if (mode === 'duplicate' && source_id) await seedFromSimulation(newId, source_id)
    else if (mode === 'from_fini' && source_id) await seedFromRefFini(newId, source_id)

    const detail = await loadDetail(newId)
    res.status(201).json(detail)
  } catch (err) {
    console.error('Error creating ref_tarif:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// UPDATE / DELETE
// ──────────────────────────────────────────────────────────

const updateBody = z.object({
  reference: z.string().trim().min(1).max(120),
  commentaire: z.string().max(4000).optional(),
  laize: z.number().min(0).max(1000),
  poids: z.number().min(0).max(10000),
  rendement: z.number().min(0).max(100),
  freinte: z.number().min(0).max(1),
  prix_tricotage: z.number().min(0).max(10000),
  poids_rouleau: z.number().min(0).max(10000),
  port_mode: z.enum(['pct', 'kg']),
  port_fixe: z.number().min(0).max(1000),
  port_pct: z.number().min(0).max(100),
  multiplicateur: z.number().min(-1).max(10),
  IDteinture: z.number().int().min(0),
})

// PUT /api/tarifs-fini/:id — header + parameters.
tarifsFiniRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = updateBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data

    const exists = await query<{ IDref_tarif: number }>(
      `SELECT IDref_tarif FROM ref_tarif WHERE IDref_tarif = ${id}`,
    )
    if (exists.length === 0) { res.status(404).json({ error: 'Simulation not found' }); return }

    // Only the column matching the chosen port mode carries a value — the other
    // is zeroed so `portModeOf` reads back the same mode next time.
    const portFixe = d.port_mode === 'kg' ? d.port_fixe : 0
    const portPct = d.port_mode === 'pct' ? d.port_pct : 0

    await query(
      `UPDATE ref_tarif SET
         reference = ${sqlText(d.reference)},
         commentaire = ${sqlText(d.commentaire ?? '')},
         laize = ${sqlNum(d.laize)},
         poids = ${sqlNum(d.poids)},
         rendement = ${sqlNum(d.rendement)},
         freinte = ${sqlNum(d.freinte)},
         prix_tricotage = ${sqlNum(d.prix_tricotage)},
         poids_rouleau = ${sqlNum(d.poids_rouleau)},
         port_fixe = ${sqlNum(portFixe)},
         port_pct = ${sqlNum(portPct)},
         multiplicateur = ${sqlNum(d.multiplicateur)},
         IDteinture = ${d.IDteinture},
         avec_teinture = ${d.IDteinture > 0 ? 1 : 0}
       WHERE IDref_tarif = ${id}`,
    )

    res.json(await loadDetail(id))
  } catch (err) {
    console.error('Error updating ref_tarif:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/tarifs-fini/:id/archive — the En cours ↔ Archivée status pill.
tarifsFiniRouter.patch('/:id/archive', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = z.object({ ok_tarif: z.number().int().min(0).max(1) }).safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed' }); return }

    await query(`UPDATE ref_tarif SET ok_tarif = ${parsed.data.ok_tarif} WHERE IDref_tarif = ${id}`)
    res.json({ IDref_tarif: id, ok_tarif: parsed.data.ok_tarif })
  } catch (err) {
    console.error('Error archiving ref_tarif:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/tarifs-fini/:id — drops the simulation and both child tables.
tarifsFiniRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await query(`DELETE FROM asso_fil_tarif WHERE IDref_tarif = ${id}`)
    await query(`DELETE FROM asso_traitement_tarif WHERE IDref_tarif = ${id}`)
    await query(`DELETE FROM ref_tarif WHERE IDref_tarif = ${id}`)
    res.json({ success: true })
  } catch (err) {
    console.error('Error deleting ref_tarif:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// COMPOSITION LINES (asso_fil_tarif)
// ──────────────────────────────────────────────────────────

const filBody = z.object({
  IDref_fil: z.number().int().positive(),
  IDcolori_fil: z.number().int().min(0),
  pourcentage: z.number().min(0).max(100),
  prix: z.number().min(0).max(100000),
})

// POST /api/tarifs-fini/:id/fils
tarifsFiniRouter.post('/:id/fils', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = filBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    await insertFilLine(id, parsed.data)
    res.status(201).json(await loadFils(id))
  } catch (err) {
    console.error('Error adding tarif fil line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/tarifs-fini/:id/fils/:lineId — edit coloris / % / price.
tarifsFiniRouter.put('/:id/fils/:lineId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(id) || isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = filBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data
    // Scope guard — a line id from another simulation must not be editable here.
    const scope = await query<{ IDasso_fil_tarif: number }>(
      `SELECT IDasso_fil_tarif FROM asso_fil_tarif
        WHERE IDasso_fil_tarif = ${lineId} AND IDref_tarif = ${id}`,
    )
    if (scope.length === 0) { res.status(404).json({ error: 'Ligne introuvable' }); return }

    await query(
      `UPDATE asso_fil_tarif SET
         IDref_fil = ${d.IDref_fil}, IDcolori_fil = ${d.IDcolori_fil},
         pourcentage = ${sqlNum(d.pourcentage)}, prix = ${sqlNum(d.prix)}
       WHERE IDasso_fil_tarif = ${lineId}`,
    )
    res.json(await loadFils(id))
  } catch (err) {
    console.error('Error updating tarif fil line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/tarifs-fini/:id/fils/:lineId
tarifsFiniRouter.delete('/:id/fils/:lineId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(id) || isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await query(
      `DELETE FROM asso_fil_tarif WHERE IDasso_fil_tarif = ${lineId} AND IDref_tarif = ${id}`,
    )
    res.json(await loadFils(id))
  } catch (err) {
    console.error('Error deleting tarif fil line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// TREATMENTS (asso_traitement_tarif)
// ──────────────────────────────────────────────────────────

// POST /api/tarifs-fini/:id/traitements — the same treatment may be applied
// several times, so this never dedupes.
tarifsFiniRouter.post('/:id/traitements', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = z.object({ IDtraitement: z.number().int().positive() }).safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed' }); return }

    await insertTraitementLine(id, parsed.data.IDtraitement)
    res.status(201).json(await loadTraitements(id))
  } catch (err) {
    console.error('Error adding tarif traitement:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/tarifs-fini/:id/traitements/:lineId
tarifsFiniRouter.delete('/:id/traitements/:lineId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(id) || isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await query(
      `DELETE FROM asso_traitement_tarif
        WHERE IDasso_traitement_tarif = ${lineId} AND IDref_tarif = ${id}`,
    )
    res.json(await loadTraitements(id))
  } catch (err) {
    console.error('Error deleting tarif traitement:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
