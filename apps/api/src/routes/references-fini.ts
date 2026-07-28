import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { calcTarifRefFini } from '../lib/pricing-fini-tarif.js'
import { FicheTechniquePdf, type FicheTechniquePdfData } from '../lib/pdf/FicheTechniquePdf.js'
import { TarifsClientPdf, type TarifsClientPdfData, type TarifsSectionData } from '../lib/pdf/TarifsClientPdf.js'

export const referencesFiniRouter: RouterType = Router()

// ref_fini is the finished-fabric technical datasheet (43 columns). Three of its
// column NAMES are accented — dateCréation, archivé, catalogue_privé — which the
// Linux HFSQL bridge cannot resolve when NAMED (it truncates at the accent and,
// worse, naming a column that then looks "unknown" triggers a respawn storm on
// the shared prod server). So:
//   • reads   — SELECT * (Windows returns the accented keys verbatim; Linux
//               returns them truncated). normalizeRefFini() resolves each by a
//               case-insensitive prefix regex (pickKey), never by a hardcoded name.
//   • writes  — we only ever SET ascii-named columns; the accented flags
//               (archivé / catalogue_privé) and the dates are read-only here.
// Accented VALUES (designation, observations, …) corrupt to U+FFFD through ODBC
// and are repaired via fixEncoding (single rows) or a batched CONVERT (lists).
//
// NB: `SELECT *` works on ref_fini but FAILS (returns 0 rows) on ref_fini_colori
// and colori_ecru — those two are only ever read with an explicit column list.

/** Escape a string for use in SQL (single quotes doubled). */
function esc(value: string): string {
  return value.replace(/'/g, "''")
}

/** SQL literal for user-supplied text. ASCII → quoted; accented → Latin-1 hex
 *  literal (raw multi-byte UTF-8 in a SQL line corrupts the Linux bridge).
 *  Mirrors sqlText() in references-fil.ts / stock-fini.ts. */
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

/** Coerce a possibly-nullable numeric value to number | null. */
function toNumOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** number | null, rounded to `dp` decimals to strip HFSQL REAL float artefacts
 *  (e.g. freinte 0.11999999, rendement 4.0552997). */
function round(v: unknown, dp: number): number | null {
  const n = toNumOrNull(v)
  if (n == null) return null
  const f = 10 ** dp
  return Math.round(n * f) / f
}

/** Value of the first row key matching `re`. The Linux HFSQL ODBC path returns
 *  accented identifiers truncated at the first accent (archivé → archiv,
 *  catalogue_privé → catalogue_priv, dateCréation → dateCr), so resolve those
 *  keys dynamically rather than by a hardcoded (accented) name. */
function pickKey(row: Record<string, unknown>, re: RegExp): unknown {
  const k = Object.keys(row).find((key) => re.test(key))
  return k === undefined ? undefined : row[k]
}

/** Shape a raw ref_fini row (from SELECT *) into an ASCII-keyed object. Resolves
 *  the three accented column names via prefix regex; rounds REAL artefacts. */
function normalizeRefFini(row: Record<string, unknown>) {
  return {
    IDref_fini: Number(row.IDref_fini) || 0,
    IDref_ecru: Number(row.IDref_ecru) || 0,
    IDcolori_ecru: Number(row.IDcolori_ecru) || 0,
    reference: (row.reference ?? null) as string | null,
    designation: (row.designation ?? null) as string | null,
    conditionnement: (row.conditionnement ?? null) as string | null,
    observations: (row.observations ?? null) as string | null,
    observation_technique: (row.observation_technique ?? null) as string | null,
    description_commercial: (row.description_commercial ?? null) as string | null,
    responsable: (row.responsable ?? null) as string | null,
    avec_teinture: Number(row.avec_teinture) || 0,
    rendement: round(row.rendement, 4),
    freinte: round(row.freinte, 4),
    temp_lavage: toNumOrNull(row.temp_lavage),
    poids_Moy: toNumOrNull(row.poids_Moy),
    poids_Min: toNumOrNull(row.poids_Min),
    poids_Max: toNumOrNull(row.poids_Max),
    laizeHT_Moy: toNumOrNull(row.laizeHT_Moy),
    laizeHT_Min: toNumOrNull(row.laizeHT_Min),
    laizeHT_Max: toNumOrNull(row.laizeHT_Max),
    laizeUtile_Moy: toNumOrNull(row.laizeUtile_Moy),
    laizeUtile_Min: toNumOrNull(row.laizeUtile_Min),
    laizeUtile_Max: toNumOrNull(row.laizeUtile_Max),
    stab_hauteur: toNumOrNull(row.stab_hauteur),
    stab_largeur: toNumOrNull(row.stab_largeur),
    allongementH_Min: toNumOrNull(row.allongementH_Min),
    allongementH_Moy: toNumOrNull(row.allongementH_Moy),
    allongementH_Max: toNumOrNull(row.allongementH_Max),
    allongementL_Min: toNumOrNull(row.allongementL_Min),
    allongementL_Moy: toNumOrNull(row.allongementL_Moy),
    allongementL_Max: toNumOrNull(row.allongementL_Max),
    controle_sst_rendement: Number(row.controle_sst_rendement) ? 1 : 0,
    controle_sst_stab: Number(row.controle_sst_stab) ? 1 : 0,
    controle_sst_allongement: Number(row.controle_sst_allongement) ? 1 : 0,
    en_developpement: Number(row.en_developpement) ? 1 : 0,
    // accented column names — resolved by prefix, never named in SQL
    archive: Number(pickKey(row, /^archiv/i)) ? 1 : 0,
    catalogue_prive: Number(pickKey(row, /^catalogue_priv/i)) ? 1 : 0,
    date_creation: (pickKey(row, /^datecr/i) ?? null) as string | null,
    date_modification: (row.dateModification ?? null) as string | null,
  }
}

type RefFini = ReturnType<typeof normalizeRefFini>

/** Is a raw ref_fini row archived? (archivé accented — resolve by prefix.) */
function isArchive(row: Record<string, unknown>): boolean {
  return Number(pickKey(row, /^archiv/i)) === 1
}

/** Batched accent repair for a flat list: one CONVERT(...) WHERE pk IN (...) per
 *  source column, only for the ids whose value actually contains U+FFFD. Avoids
 *  the per-row N+1 that fixEncoding would do (a storm on the Linux bridge for a
 *  ~600-row list). All `fields` must be ASCII-named columns. */
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
// LOOKUPS
// ──────────────────────────────────────────────────────────

// GET /api/references-fini/lookups/ecru — ref_ecru list for the écru picker.
referencesFiniRouter.get('/lookups/ecru', async (_req: Request, res: Response) => {
  try {
    // ref_ecru.archivé is accented → SELECT explicit ASCII columns and skip the
    // archive filter (the picker shows all écru refs). designation corrupts →
    // batched repair.
    const rows = await query<Record<string, unknown>>(
      `SELECT IDref_ecru, reference, designation FROM ref_ecru ORDER BY reference`,
    )
    const shaped = rows.map((r) => ({
      IDref_ecru: Number(r.IDref_ecru) || 0,
      reference: (r.reference ?? null) as string | null,
      designation: (r.designation ?? null) as string | null,
    }))
    const fixed = await batchRepair(shaped, 'ref_ecru', 'IDref_ecru', ['reference', 'designation'])
    res.json(fixed.filter((r) => r.reference && String(r.reference).trim().length > 0))
  } catch (err) {
    console.error('Error fetching ecru lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// LIST
// ──────────────────────────────────────────────────────────

// GET /api/references-fini — non-archived ref_fini with coloris + stock summary.
referencesFiniRouter.get('/', async (_req: Request, res: Response) => {
  try {
    // SELECT * works on ref_fini even with accented column names; the archivé
    // filter is applied in JS (naming the accented column would storm Linux).
    const rawRows = await query<Record<string, unknown>>(`SELECT * FROM ref_fini ORDER BY reference`)
    const visible = rawRows.filter((r) => !isArchive(r))
    let refs = visible.map((r) => normalizeRefFini(r))
    refs = await batchRepair(refs as any, 'ref_fini', 'IDref_fini', ['reference', 'designation']) as RefFini[]

    if (refs.length === 0) {
      res.json([])
      return
    }

    // Coloris count is polymorphic (memory project_avec_teinture_coloris_rule):
    //   dyed (avec_teinture != 0) → ref_fini_colori grouped by IDref_fini
    //   wash (avec_teinture == 0) → colori_ecru grouped by IDref_ecru
    const dyedCountByRef = new Map<number, number>()
    const washCountByEcru = new Map<number, number>()
    try {
      const d = await query<{ IDref_fini: number; n: number }>(
        `SELECT IDref_fini, COUNT(*) AS n FROM ref_fini_colori GROUP BY IDref_fini`,
      )
      for (const r of d) dyedCountByRef.set(Number(r.IDref_fini), Number(r.n))
    } catch { /* tolerate */ }
    try {
      const w = await query<{ IDref_ecru: number; n: number }>(
        `SELECT IDref_ecru, COUNT(*) AS n FROM colori_ecru GROUP BY IDref_ecru`,
      )
      for (const r of w) washCountByEcru.set(Number(r.IDref_ecru), Number(r.n))
    } catch { /* tolerate */ }

    // Active stock per ref (exclude shipped: IDligne_expedition / état 4).
    const stockByRef = new Map<number, { lots: number; kg: number }>()
    try {
      const s = await query<{ IDref_fini: number; lots: number; kg: number | null }>(
        `SELECT IDref_fini, COUNT(*) AS lots, SUM(poids) AS kg FROM stock_fini
         WHERE (IDligne_expedition IS NULL OR IDligne_expedition = 0)
           AND (IDetat_stock_fini IS NULL OR IDetat_stock_fini <> 4)
         GROUP BY IDref_fini`,
      )
      for (const r of s) stockByRef.set(Number(r.IDref_fini), { lots: Number(r.lots) || 0, kg: Number(r.kg) || 0 })
    } catch { /* tolerate */ }

    const out = refs.map((r) => {
      const coloris_count = r.avec_teinture !== 0
        ? dyedCountByRef.get(r.IDref_fini) ?? 0
        : washCountByEcru.get(r.IDref_ecru) ?? 0
      const stock = stockByRef.get(r.IDref_fini) ?? { lots: 0, kg: 0 }
      return {
        IDref_fini: r.IDref_fini,
        reference: r.reference,
        designation: r.designation,
        avec_teinture: r.avec_teinture,
        en_developpement: r.en_developpement,
        coloris_count,
        stock_lots: stock.lots,
        stock_total_kg: stock.kg,
      }
    })

    res.json(out)
  } catch (err) {
    console.error('Error fetching ref_fini list:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// DETAIL
// ──────────────────────────────────────────────────────────

// GET /api/references-fini/:id
referencesFiniRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await query<Record<string, unknown>>(`SELECT * FROM ref_fini WHERE IDref_fini = ${id}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Ref fini not found' }); return }
    let ref = normalizeRefFini(rows[0])
    const fixed = await fixEncoding(
      [ref] as any,
      'ref_fini',
      'IDref_fini',
      ['reference', 'designation', 'conditionnement', 'observations', 'observation_technique', 'description_commercial', 'responsable'],
    ) as RefFini[]
    ref = fixed[0]

    // Écru base (reference + designation) for context.
    let ecru: { IDref_ecru: number; reference: string | null; designation: string | null } | null = null
    if (ref.IDref_ecru > 0) {
      const er = await query<Record<string, unknown>>(
        `SELECT IDref_ecru, reference, designation FROM ref_ecru WHERE IDref_ecru = ${ref.IDref_ecru}`,
      )
      if (er.length > 0) {
        const shaped = [{
          IDref_ecru: Number(er[0].IDref_ecru) || 0,
          reference: (er[0].reference ?? null) as string | null,
          designation: (er[0].designation ?? null) as string | null,
        }]
        const ecruFixed = await fixEncoding(shaped, 'ref_ecru', 'IDref_ecru', ['reference', 'designation'])
        ecru = ecruFixed[0]
      }
    }

    // Coloris — polymorphic by avec_teinture. ref_fini_colori / colori_ecru only
    // ever read with explicit columns (SELECT * fails on both tables).
    let coloris: Array<{ id: number; reference: string | null; IDteinture: number | null }> = []
    const coloris_mode: 'dye' | 'wash' = ref.avec_teinture !== 0 ? 'dye' : 'wash'
    if (coloris_mode === 'dye') {
      const cr = await query<{ IDref_fini_colori: number; reference: string | null; IDteinture: number | null }>(
        `SELECT IDref_fini_colori, reference, IDteinture FROM ref_fini_colori WHERE IDref_fini = ${id} ORDER BY reference`,
      )
      const crFixed = (await fixEncoding(cr, 'ref_fini_colori', 'IDref_fini_colori', ['reference'])) as any[]
      coloris = crFixed.map((c) => ({ id: Number(c.IDref_fini_colori), reference: c.reference ?? null, IDteinture: toNumOrNull(c.IDteinture) }))
    } else if (ref.IDref_ecru > 0) {
      const cr = await query<{ IDcolori_ecru: number; reference: string | null }>(
        `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDref_ecru = ${ref.IDref_ecru} ORDER BY reference`,
      )
      const crFixed = (await fixEncoding(cr, 'colori_ecru', 'IDcolori_ecru', ['reference'])) as any[]
      coloris = crFixed.map((c) => ({ id: Number(c.IDcolori_ecru), reference: c.reference ?? null, IDteinture: null }))
    }
    coloris = coloris.filter((c) => c.reference && String(c.reference).trim().length > 0)

    // Traitements via traitement_ref_fini (ASCII junction) → traitement.
    let traitements: Array<{ IDtraitement: number; designation: string | null }> = []
    const tr = await query<{ IDtraitement: number; designation: string | null; ordre: number | null }>(
      `SELECT t.IDtraitement, t.designation, t.ordre
         FROM traitement_ref_fini trf
         JOIN traitement t ON trf.IDtraitement = t.IDtraitement
        WHERE trf.IDref_fini = ${id}
        ORDER BY t.ordre`,
    )
    const trFixed = (await fixEncoding(tr, 'traitement', 'IDtraitement', ['designation'])) as any[]
    traitements = trFixed.map((t) => ({ IDtraitement: Number(t.IDtraitement), designation: t.designation ?? null }))

    // Active stock aggregate (exclude shipped).
    let stock_total_kg = 0
    let stock_total_m = 0
    let stock_lots = 0
    const sr = await query<{ lots: number; kg: number | null; m: number | null }>(
      `SELECT COUNT(*) AS lots, SUM(poids) AS kg, SUM(metrage) AS m FROM stock_fini
       WHERE IDref_fini = ${id}
         AND (IDligne_expedition IS NULL OR IDligne_expedition = 0)
         AND (IDetat_stock_fini IS NULL OR IDetat_stock_fini <> 4)`,
    )
    if (sr.length > 0) {
      stock_lots = Number(sr[0].lots) || 0
      stock_total_kg = Number(sr[0].kg) || 0
      stock_total_m = Number(sr[0].m) || 0
    }

    res.json({
      ...ref,
      ecru,
      coloris,
      coloris_mode,
      traitements,
      stock_total_kg,
      stock_total_m,
      stock_lots,
    })
  } catch (err) {
    console.error('Error fetching ref_fini detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/references-fini/:id/tarif?coloris=<id> — cost-price breakdown +
// volume-tier grid for the reference and a chosen coloris (port of the legacy
// FI_Tarifs / PrixDeVenteV4). When `coloris` is omitted we default to the ref's
// first coloris (polymorphic by avec_teinture). Always 200 with tranches: []
// rather than an error when nothing can be priced, so the UI shows empty state.
referencesFiniRouter.get('/:id/tarif', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    let colorisId = parseInt(String(req.query.coloris ?? ''), 10)
    if (isNaN(colorisId) || colorisId <= 0) {
      // Default to the first coloris in the right catalog for this ref.
      const refRows = await query<{ avec_teinture: number; IDref_ecru: number }>(
        `SELECT avec_teinture, IDref_ecru FROM ref_fini WHERE IDref_fini = ${id}`,
      )
      colorisId = 0
      if (refRows.length > 0) {
        if (Number(refRows[0].avec_teinture) !== 0) {
          const cr = await query<{ IDref_fini_colori: number }>(
            `SELECT IDref_fini_colori FROM ref_fini_colori WHERE IDref_fini = ${id} ORDER BY reference`,
          )
          colorisId = Number(cr[0]?.IDref_fini_colori) || 0
        } else if (Number(refRows[0].IDref_ecru) > 0) {
          const cr = await query<{ IDcolori_ecru: number }>(
            `SELECT IDcolori_ecru FROM colori_ecru WHERE IDref_ecru = ${Number(refRows[0].IDref_ecru)} ORDER BY reference`,
          )
          colorisId = Number(cr[0]?.IDcolori_ecru) || 0
        }
      }
    }

    const result = await calcTarifRefFini(id, colorisId)
    res.json(result)
  } catch (err) {
    console.error('Error computing ref_fini tarif:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// FICHE TECHNIQUE PDF
// ──────────────────────────────────────────────────────────

/** Format an HFSQL date ("20230221") or datetime ("2024-03-18 09:07:26.721")
 *  as French dd/mm/yyyy. Returns null when unparseable. */
function formatFicheDate(raw: string | null): string | null {
  if (!raw) return null
  const s = String(raw).trim()
  let m = s.match(/^(\d{4})(\d{2})(\d{2})/)
  if (!m) m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const [, y, mo, d] = m
  if (y === '0000' || (mo === '00' && d === '00')) return null
  return `${d}/${mo}/${y}`
}

/** Build the fiche technique data for one ref_fini. Reused by /pdf (and a
 *  future /email endpoint) per the mandatory build/render split. */
export async function buildFicheTechniquePdfData(id: number): Promise<FicheTechniquePdfData | null> {
  const rows = await query<Record<string, unknown>>(`SELECT * FROM ref_fini WHERE IDref_fini = ${id}`)
  if (rows.length === 0) return null
  let ref = normalizeRefFini(rows[0])
  const fixed = await fixEncoding(
    [ref] as any,
    'ref_fini',
    'IDref_fini',
    ['reference', 'designation', 'conditionnement', 'observations'],
  ) as RefFini[]
  ref = fixed[0]

  // Contexture: ref_ecru.IDcontexture (ASCII column) → contexture.nom.
  let contexture: string | null = null
  if (ref.IDref_ecru > 0) {
    try {
      const er = await query<{ IDcontexture: number }>(
        `SELECT IDref_ecru, IDcontexture FROM ref_ecru WHERE IDref_ecru = ${ref.IDref_ecru}`,
      )
      const ctxId = Number(er[0]?.IDcontexture) || 0
      if (ctxId > 0) {
        const cr = await query<{ IDcontexture: number; nom: string | null }>(
          `SELECT IDcontexture, nom FROM contexture WHERE IDcontexture = ${ctxId}`,
        )
        const crFixed = (await fixEncoding(cr, 'contexture', 'IDcontexture', ['nom'])) as any[]
        contexture = (crFixed[0]?.nom ?? null) as string | null
      }
    } catch { /* tolerate — fiche renders without contexture */ }
  }

  // Composition: composition_ecru (per écru, optionally per colori_ecru) gives
  // the yarn mix; asso_fil_matiere gives each yarn's matière percentages
  // (stored as 0-1 fractions). Aggregate matière % = Σ yarnShare × matièreFrac.
  const composition: Array<{ matiere: string; pourcentage: number }> = []
  try {
    if (ref.IDref_ecru > 0) {
      const comp = await query<{ IDcolori_ecru: number; IDref_fil: number; pourcentage: number }>(
        `SELECT IDcomposition_ecru, IDcolori_ecru, IDref_fil, pourcentage
           FROM composition_ecru WHERE IDref_ecru = ${ref.IDref_ecru}`,
      )
      // Prefer the rows scoped to the ref's écru coloris, then the generic
      // (IDcolori_ecru = 0) rows, then whatever exists.
      let chosen = ref.IDcolori_ecru > 0 ? comp.filter((r) => Number(r.IDcolori_ecru) === ref.IDcolori_ecru) : []
      if (chosen.length === 0) chosen = comp.filter((r) => Number(r.IDcolori_ecru) === 0)
      if (chosen.length === 0) chosen = comp

      const totalPct = chosen.reduce((s, r) => s + (Number(r.pourcentage) || 0), 0)
      if (totalPct > 0) {
        const filIds = Array.from(new Set(chosen.map((r) => Number(r.IDref_fil)).filter((n) => n > 0)))
        // asso_fil_matiere / matiere_premiere both have accented column NAMES
        // (IDMatière, IDmatière_première) — never name them in SQL. SELECT * and
        // resolve the keys via pickKey. matiere_premiere's PK is accented too,
        // so fixEncoding can't repair libelle; U+FFFD → é is the only accent
        // that occurs in matière names (élasthanne, acétate, polyéthylène…).
        const assoByFil = new Map<number, Array<{ matiereId: number; frac: number }>>()
        if (filIds.length > 0) {
          const asso = await query<Record<string, unknown>>(
            `SELECT * FROM asso_fil_matiere WHERE IDRef_fil IN (${filIds.join(',')})`,
          )
          for (const a of asso) {
            const filId = Number(a.IDRef_fil) || 0
            const matiereId = Number(pickKey(a, /^idmati/i)) || 0
            const frac = Number(a.pourcentage) || 0
            if (filId <= 0 || matiereId <= 0 || frac <= 0) continue
            const arr = assoByFil.get(filId) ?? []
            arr.push({ matiereId, frac })
            assoByFil.set(filId, arr)
          }
        }
        const libelleById = new Map<number, string>()
        if (assoByFil.size > 0) {
          const mats = await query<Record<string, unknown>>(`SELECT * FROM matiere_premiere`)
          for (const m of mats) {
            const mid = Number(pickKey(m, /^idmati/i)) || 0
            const lib = String(m.libelle ?? '').replace(/�/g, 'é').trim()
            if (mid > 0 && lib) libelleById.set(mid, lib)
          }
        }
        const pctByMatiere = new Map<string, number>()
        for (const row of chosen) {
          const share = (Number(row.pourcentage) || 0) / totalPct
          for (const a of assoByFil.get(Number(row.IDref_fil)) ?? []) {
            const lib = libelleById.get(a.matiereId)
            if (!lib) continue
            pctByMatiere.set(lib, (pctByMatiere.get(lib) ?? 0) + share * a.frac * 100)
          }
        }
        for (const [matiere, pourcentage] of pctByMatiere) composition.push({ matiere, pourcentage })
        composition.sort((a, b) => b.pourcentage - a.pourcentage)
      }
    }
  } catch { /* tolerate — fiche renders with an empty composition */ }

  return {
    reference: ref.reference ?? `#${id}`,
    designation: ref.designation,
    contexture,
    laizeHT: { min: ref.laizeHT_Min, moy: ref.laizeHT_Moy, max: ref.laizeHT_Max },
    laizeUtile: { min: ref.laizeUtile_Min, moy: ref.laizeUtile_Moy, max: ref.laizeUtile_Max },
    poids: { min: ref.poids_Min, moy: ref.poids_Moy, max: ref.poids_Max },
    composition,
    stabHauteur: ref.stab_hauteur,
    stabLargeur: ref.stab_largeur,
    allongementH: { min: ref.allongementH_Min, moy: ref.allongementH_Moy, max: ref.allongementH_Max },
    allongementL: { min: ref.allongementL_Min, moy: ref.allongementL_Moy, max: ref.allongementL_Max },
    conditionnement: ref.conditionnement,
    observations: ref.observations,
    tempLavage: ref.temp_lavage,
    dateCreation: formatFicheDate(ref.date_creation),
    dateModification: formatFicheDate(ref.date_modification),
  }
}

/** Render the fiche technique PDF as a Buffer. */
export async function renderFicheTechniquePdfBuffer(data: FicheTechniquePdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(FicheTechniquePdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

// GET /api/references-fini/:id/pdf — fiche technique, streamed inline.
referencesFiniRouter.get('/:id/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const data = await buildFicheTechniquePdfData(id)
    if (!data) { res.status(404).json({ error: 'Ref fini not found' }); return }
    const buffer = await renderFicheTechniquePdfBuffer(data)

    const safeRef = data.reference.replace(/[^\w.-]+/g, '_')
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="fiche-technique-${safeRef}.pdf"`)
    // Strip helmet's restrictive headers so the web app (different origin/port
    // in dev) can embed the PDF in an <iframe>. See mps_designer §21.
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering fiche technique PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// FICHE TARIFS PDF
// ──────────────────────────────────────────────────────────
// Standard (non client-negotiated) price grid for one reference: every coloris
// of the ref priced via calcTarifRefFini, rendered through the same
// TarifsClientPdf component as the Clients › Gestion fiche. The 15 and 30
// rouleaux tranches (indices 7 and 8 of the 9-tranche array) are each opt-in
// via ?rlx15=1 / ?rlx30=1 — the caller asks the user before generating.

/** Default visible tranches: up to 10 rouleaux (indices 0..6). */
const TARIF_TRANCHE_IDX_DEFAULT = [0, 1, 2, 3, 4, 5, 6]
/** Price columns per grid — bounded by the A4 content width. */
const TARIF_COLORIS_PER_TABLE = 4

const MOIS_FR = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre']
function formatDateLongFr(d: Date): string {
  return `${d.getDate()} ${MOIS_FR[d.getMonth()]} ${d.getFullYear()}`
}
function formatDateShortFr(d: Date): string {
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`
}

/** Build the fiche tarifs data for one ref_fini.
 *
 *  `colorisIds` restricts the sheet to the picked coloris (ids are polymorphic
 *  by `avec_teinture` — ref_fini_colori for dyed refs, colori_ecru for washed
 *  ones, same as the detail endpoint). Pass null/empty for the whole catalog. */
export async function buildFicheTarifsPdfData(
  id: number,
  include15: boolean,
  include30: boolean,
  colorisIds: number[] | null = null,
): Promise<TarifsClientPdfData | null> {
  const rows = await query<Record<string, unknown>>(`SELECT * FROM ref_fini WHERE IDref_fini = ${id}`)
  if (rows.length === 0) return null
  let ref = normalizeRefFini(rows[0])
  const fixed = await fixEncoding([ref] as any, 'ref_fini', 'IDref_fini', ['reference']) as RefFini[]
  ref = fixed[0]

  // Écru context: contexture label + bio flag (ASCII columns only).
  let contexture: string | null = null
  let bio = false
  if (ref.IDref_ecru > 0) {
    try {
      const er = await query<{ IDcontexture: number; bio: number }>(
        `SELECT IDref_ecru, IDcontexture, bio FROM ref_ecru WHERE IDref_ecru = ${ref.IDref_ecru}`,
      )
      bio = Number(er[0]?.bio) === 1
      const ctxId = Number(er[0]?.IDcontexture) || 0
      if (ctxId > 0) {
        const cr = await query<{ IDcontexture: number; nom: string | null }>(
          `SELECT IDcontexture, nom FROM contexture WHERE IDcontexture = ${ctxId}`,
        )
        const crFixed = (await fixEncoding(cr, 'contexture', 'IDcontexture', ['nom'])) as any[]
        contexture = (crFixed[0]?.nom ?? null) as string | null
      }
    } catch { /* tolerate */ }
  }

  // Coloris catalog — polymorphic by avec_teinture (explicit columns: SELECT *
  // fails on both tables).
  let coloris: Array<{ id: number; label: string }> = []
  if (ref.avec_teinture !== 0) {
    const cr = await query<{ IDref_fini_colori: number; reference: string | null }>(
      `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini = ${id} ORDER BY reference`,
    )
    const crFixed = (await fixEncoding(cr, 'ref_fini_colori', 'IDref_fini_colori', ['reference'])) as any[]
    coloris = crFixed.map((c) => ({ id: Number(c.IDref_fini_colori), label: String(c.reference ?? '').trim() }))
  } else if (ref.IDref_ecru > 0) {
    const cr = await query<{ IDcolori_ecru: number; reference: string | null }>(
      `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDref_ecru = ${ref.IDref_ecru} ORDER BY reference`,
    )
    const crFixed = (await fixEncoding(cr, 'colori_ecru', 'IDcolori_ecru', ['reference'])) as any[]
    coloris = crFixed.map((c) => ({ id: Number(c.IDcolori_ecru), label: String(c.reference ?? '').trim() }))
  }
  coloris = coloris.filter((c) => c.id > 0 && c.label.length > 0)
  // Narrow to the user's picks before the 60-coloris cap, so a selection is
  // never silently truncated by coloris the user explicitly left out.
  if (colorisIds && colorisIds.length > 0) {
    const wanted = new Set(colorisIds)
    coloris = coloris.filter((c) => wanted.has(c.id))
  }
  coloris = coloris.slice(0, 60)

  const trancheIdx = [
    ...TARIF_TRANCHE_IDX_DEFAULT,
    ...(include15 ? [7] : []),
    ...(include30 ? [8] : []),
  ]

  // Price each coloris sequentially (calcTarifRefFini fires several HFSQL
  // queries — a Promise.all over dozens of coloris would flood the bridge).
  const priced: Array<{ label: string; tranches: Awaited<ReturnType<typeof calcTarifRefFini>>['tranches'] }> = []
  for (const c of coloris) {
    try {
      const t = await calcTarifRefFini(id, c.id)
      const hasPrice = trancheIdx.some((i) => (t.tranches[i]?.moPrixDeVenteAuMl ?? 0) > 0)
      if (hasPrice) priced.push({ label: c.label, tranches: t.tranches })
    } catch { /* skip unpriceable coloris */ }
  }
  if (priced.length === 0) {
    return {
      clientNom: ref.reference ?? `#${id}`,
      dateDocument: formatDateLongFr(new Date()),
      validUntil: '',
      sections: [],
    }
  }

  const laize = ref.laizeHT_Moy != null ? Math.round(ref.laizeHT_Moy) : null
  const poids = ref.poids_Moy != null ? Math.round(ref.poids_Moy) : null

  // Chunk the coloris into groups so each grid fits the page width.
  const sections: TarifsSectionData[] = []
  for (let start = 0; start < priced.length; start += TARIF_COLORIS_PER_TABLE) {
    const group = priced.slice(start, start + TARIF_COLORIS_PER_TABLE)
    const sectionRows: TarifsSectionData['rows'] = []
    for (const i of trancheIdx) {
      const anyTranche = group.find((g) => g.tranches.length > i)?.tranches[i]
      if (!anyTranche) continue
      sectionRows.push({
        rlx: anyTranche.isMetrage ? '< 1' : String(anyTranche.rolls),
        ml: anyTranche.isMetrage ? `< ${anyTranche.qte_ml}` : String(anyTranche.qte_ml),
        prices: group.map((g) => {
          const t = g.tranches[i]
          return t && t.moPrixDeVenteAuMl > 0 ? t.moPrixDeVenteAuMl : null
        }),
      })
    }
    if (sectionRows.length === 0) continue
    sections.push({
      ref: ref.reference ?? `#${id}`,
      contexture,
      laize,
      poids,
      bio,
      colorisLabels: group.map((g) => g.label),
      rows: sectionRows,
    })
  }

  const now = new Date()
  const validUntil = new Date(now)
  validUntil.setFullYear(validUntil.getFullYear() + 1)

  return {
    clientNom: ref.reference ?? `#${id}`,
    dateDocument: formatDateLongFr(now),
    validUntil: formatDateShortFr(validUntil),
    sections,
  }
}

/** Render the fiche tarifs PDF as a Buffer. */
export async function renderFicheTarifsPdfBuffer(data: TarifsClientPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(TarifsClientPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

// GET /api/references-fini/:id/tarifs/pdf?rlx15=1&rlx30=1&coloris=1,2,3
// Fiche tarifs, inline. `coloris` is an optional CSV of coloris ids limiting
// the sheet to those colours; omitted means the whole catalog.
referencesFiniRouter.get('/:id/tarifs/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const include15 = String(req.query.rlx15 ?? '') === '1'
    const include30 = String(req.query.rlx30 ?? '') === '1'
    const colorisIds = String(req.query.coloris ?? '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0)

    const data = await buildFicheTarifsPdfData(id, include15, include30, colorisIds)
    if (!data) { res.status(404).json({ error: 'Ref fini not found' }); return }
    if (data.sections.length === 0) {
      res.status(404).json({
        error: colorisIds.length > 0
          ? 'Aucun tarif calculable pour les coloris sélectionnés.'
          : 'Aucun tarif calculable pour cette référence.',
      })
      return
    }
    const buffer = await renderFicheTarifsPdfBuffer(data)

    const safeRef = data.clientNom.replace(/[^\w.-]+/g, '_')
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="fiche-tarifs-${safeRef}.pdf"`)
    // Strip helmet's restrictive headers so the web app (different origin/port
    // in dev) can embed the PDF in an <iframe>. See mps_designer §21.
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering fiche tarifs PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────

// Editable datasheet fields — every column here is ASCII-named, so the same SET
// list is bridge-safe on Linux and Windows. The accented flags (archivé /
// catalogue_privé), the dates, avec_teinture, and the écru/coloris ids that drive
// the coloris catalog + pricing are intentionally NOT writable from this screen,
// except IDref_ecru which is a clean FK the user sets when wiring a new ref.
const refFiniBody = z.object({
  reference: z.string().min(1).max(100),
  designation: z.string().optional().nullable(),
  conditionnement: z.string().optional().nullable(),
  observations: z.string().optional().nullable(),
  observation_technique: z.string().optional().nullable(),
  description_commercial: z.string().optional().nullable(),
  responsable: z.string().optional().nullable(),
  IDref_ecru: z.number().int().nonnegative().optional().nullable(),
  rendement: z.number().optional().nullable(),
  freinte: z.number().optional().nullable(),
  temp_lavage: z.number().optional().nullable(),
  poids_Moy: z.number().optional().nullable(),
  poids_Min: z.number().optional().nullable(),
  poids_Max: z.number().optional().nullable(),
  laizeHT_Moy: z.number().optional().nullable(),
  laizeHT_Min: z.number().optional().nullable(),
  laizeHT_Max: z.number().optional().nullable(),
  laizeUtile_Moy: z.number().optional().nullable(),
  laizeUtile_Min: z.number().optional().nullable(),
  laizeUtile_Max: z.number().optional().nullable(),
  stab_hauteur: z.number().optional().nullable(),
  stab_largeur: z.number().optional().nullable(),
  allongementH_Min: z.number().optional().nullable(),
  allongementH_Moy: z.number().optional().nullable(),
  allongementH_Max: z.number().optional().nullable(),
  allongementL_Min: z.number().optional().nullable(),
  allongementL_Moy: z.number().optional().nullable(),
  allongementL_Max: z.number().optional().nullable(),
  controle_sst_rendement: z.boolean().optional(),
  controle_sst_stab: z.boolean().optional(),
  controle_sst_allongement: z.boolean().optional(),
  en_developpement: z.boolean().optional(),
})

type RefFiniBody = z.infer<typeof refFiniBody>

const NUMERIC_COLS: (keyof RefFiniBody)[] = [
  'rendement', 'freinte', 'temp_lavage',
  'poids_Moy', 'poids_Min', 'poids_Max',
  'laizeHT_Moy', 'laizeHT_Min', 'laizeHT_Max',
  'laizeUtile_Moy', 'laizeUtile_Min', 'laizeUtile_Max',
  'stab_hauteur', 'stab_largeur',
  'allongementH_Min', 'allongementH_Moy', 'allongementH_Max',
  'allongementL_Min', 'allongementL_Moy', 'allongementL_Max',
]
const BOOL_COLS: (keyof RefFiniBody)[] = [
  'controle_sst_rendement', 'controle_sst_stab', 'controle_sst_allongement', 'en_developpement',
]

function buildRefFiniSets(b: RefFiniBody): string[] {
  const sets: string[] = []
  sets.push(`reference = ${sqlText(b.reference)}`)
  sets.push(`designation = ${sqlText(b.designation ?? '')}`)
  sets.push(`conditionnement = ${sqlText(b.conditionnement ?? '')}`)
  sets.push(`observations = ${sqlText(b.observations ?? '')}`)
  sets.push(`observation_technique = ${sqlText(b.observation_technique ?? '')}`)
  sets.push(`description_commercial = ${sqlText(b.description_commercial ?? '')}`)
  sets.push(`responsable = ${sqlText(b.responsable ?? '')}`)
  sets.push(`IDref_ecru = ${Number(b.IDref_ecru) || 0}`)
  for (const c of NUMERIC_COLS) sets.push(`${c} = ${toNumOrNull(b[c]) ?? 0}`)
  for (const c of BOOL_COLS) sets.push(`${c} = ${b[c] ? 1 : 0}`)
  return sets
}

// POST /api/references-fini — inline-create an empty datasheet (named-column
// INSERT → PK auto-assigns). The user fills the rest in edit mode.
referencesFiniRouter.post('/', async (req: Request, res: Response) => {
  try {
    const reference = typeof req.body?.reference === 'string' && req.body.reference.trim()
      ? String(req.body.reference).trim()
      : 'Nouvelle référence'
    await query(
      `INSERT INTO ref_fini (reference, designation, avec_teinture, IDref_ecru, IDcolori_ecru, en_developpement)
       VALUES (${sqlText(reference)}, '', 0, 0, 0, 0)`,
    )
    const rows = await query<{ IDref_fini: number }>(
      `SELECT IDref_fini FROM ref_fini WHERE reference = ${sqlText(reference)} ORDER BY IDref_fini DESC`,
    )
    const newId = rows[0]?.IDref_fini ?? null
    res.status(201).json({ IDref_fini: newId })
  } catch (err) {
    console.error('Error creating ref_fini:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/references-fini/:id
referencesFiniRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = refFiniBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    // If an écru is set, validate it exists (a stray id would orphan the ref).
    if (parsed.data.IDref_ecru && parsed.data.IDref_ecru > 0) {
      const ecru = await query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ref_ecru WHERE IDref_ecru = ${parsed.data.IDref_ecru}`,
      )
      if (Number(ecru[0]?.n ?? 0) === 0) {
        res.status(400).json({ error: "La référence écru sélectionnée n'existe pas." })
        return
      }
    }
    const sets = buildRefFiniSets(parsed.data)
    await query(`UPDATE ref_fini SET ${sets.join(', ')} WHERE IDref_fini = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating ref_fini:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-fini/:id — guarded against in-use references.
referencesFiniRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const stock = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stock_fini WHERE IDref_fini = ${id}`,
    )
    if (Number(stock[0]?.n ?? 0) > 0) {
      res.status(409).json({ error: 'Cette référence est utilisée par des lots de stock.' })
      return
    }
    const coloris = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ref_fini_colori WHERE IDref_fini = ${id}`,
    )
    if (Number(coloris[0]?.n ?? 0) > 0) {
      res.status(409).json({ error: 'Cette référence possède encore des coloris teints.' })
      return
    }
    const traitements = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM traitement_ref_fini WHERE IDref_fini = ${id}`,
    )
    if (Number(traitements[0]?.n ?? 0) > 0) {
      res.status(409).json({ error: 'Cette référence possède encore des traitements associés.' })
      return
    }
    await query(`DELETE FROM ref_fini WHERE IDref_fini = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting ref_fini:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
