import { Router, type Request, type Response, type Router as RouterType } from 'express'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { userHasPermission } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { childNumero, cutBase, nextCutIndex } from '../lib/roll-cut.js'
import { StockFiniLabelPdf, type StockFiniLabelData } from '../lib/pdf/StockFiniLabelPdf.js'

export const stockFiniRouter: RouterType = Router()

type StockFini = Record<string, unknown>

/** Escape a string for use in SQL (single quotes doubled). */
function esc(value: string): string {
  return value.replace(/'/g, "''")
}

const IS_WINDOWS = process.platform === 'win32'

/** ref_fini.archivé is accented — on Linux SELECT * returns a mangled key. */
function isArchive(row: Record<string, unknown>): boolean {
  const v = row.archivé ?? row.archiv ?? 0
  return Number(v) === 1
}

/** Emit a text value as a bridge-safe SQL literal: plain quoted for ASCII,
 *  Latin-1 hex literal for accented text (raw multi-byte UTF-8 in a SQL
 *  string corrupts the Linux bridge → [HY090]). Ported from
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
      const c = ch.codePointAt(0) ?? 0x3f
      return c <= 0xff ? c : 0x3f
    }),
  )
  return `x'${bytes.toString('hex')}'`
}

// stock_fini and all the tables we join (ref_fini, ref_fini_colori,
// etat_stock_fini, sous_traitant) have NO accented columns in the fields we
// read, so the IS_WINDOWS branching dance from stock.ts is not needed here.
// coloris is polymorphic by ref_fini.avec_teinture: 0 = wash only → the
// IDColoris is a colori_ecru id (joined as `ce`); 1/2 = dyed → it's a
// ref_fini_colori id (joined as `rfc`). The id spaces collide numerically, so
// we select BOTH labels + avec_teinture and pick the right one in repairAllJoins.
const STOCK_FINI_SELECT = `sf.IDstock_fini, sf.IDref_fini, sf.IDColoris, sf.IDetat_stock_fini, sf.IDligne_commande_client, sf.IDref_commande_source, sf.IDstock_ecru, sf.IDmagasin, sf.IDligne_expedition, sf.IDProprietaire, sf.IDcommande_donation, sf.poids, sf.metrage, sf.lot, sf.numero, sf.observations, sf.observation_sst, sf.second_choix, sf.date_saisie, sf.destockage, sf.don, sf.pointage, sf.emplacement, sf.conteneur, rf.reference AS ref_fini, rf.designation, rf.avec_teinture, rfc.reference AS coloris_dyed, ce.reference AS coloris_wash, esf.libelle AS etat_libelle, st.nom AS magasin_nom`

const STOCK_FINI_JOINS = `FROM stock_fini sf LEFT JOIN ref_fini rf ON sf.IDref_fini = rf.IDref_fini LEFT JOIN ref_fini_colori rfc ON sf.IDColoris = rfc.IDref_fini_colori LEFT JOIN colori_ecru ce ON sf.IDColoris = ce.IDcolori_ecru LEFT JOIN etat_stock_fini esf ON sf.IDetat_stock_fini = esf.IDetat_stock_fini LEFT JOIN sous_traitant st ON sf.IDmagasin = st.IDsous_traitant`

const TEXT_FIELDS = ['lot', 'numero', 'observations', 'observation_sst', 'emplacement', 'conteneur']

/**
 * Lazy CONVERT() repair for aliased columns that came back with U+FFFD glyphs.
 * Mirrors stock.ts:402.
 */
// Repair U+FFFD-corrupted accents on aliased columns coming back from a join.
// BATCHED: instead of one CONVERT query per row (an N+1 explosion that, on the
// Linux bridge, turned a single list load into hundreds of serialized round
// trips — état labels like "Réservé"/"Expédié" corrupt on *every* row), we issue
// at most one CONVERT query per source column, fetching every distinct id at
// once with `WHERE keyCol IN (...)`. Only ids whose value actually has a U+FFFD
// are requested, so empty values never enter the CONVERT (which would otherwise
// collapse the result set — see CLAUDE.md).
export async function repairAliased<T extends Record<string, unknown>>(
  rows: T[],
  table: string,
  idField: string,
  aliasMap: Record<string, string>,
  // Column to match in the target `table`. Defaults to idField (used when the
  // row's id property and the target table's PK share a name). When they differ
  // — e.g. stock_fini.IDColoris → ref_fini_colori.IDref_fini_colori, or
  // stock_fini.IDmagasin → sous_traitant.IDsous_traitant — pass the target PK
  // explicitly. Getting this wrong issues a query against a non-existent column,
  // which on the Linux HFSQL bridge triggers a connection-respawn storm.
  keyCol: string = idField,
): Promise<T[]> {
  const aliasNames = Object.keys(aliasMap)

  // Collect, per alias, the distinct ids whose value is corrupted.
  const idsByAlias: Record<string, Set<number>> = {}
  for (const alias of aliasNames) idsByAlias[alias] = new Set<number>()
  let anyNeedsFix = false
  for (const row of rows) {
    const idNum = Number(row[idField])
    // Only finite integer ids are usable in the `WHERE key IN (…)` below — a NaN
    // in that list makes HFSQL reject the whole query ([01000]) and, on the Linux
    // bridge, triggers a connection-respawn storm against the shared server.
    if (!Number.isInteger(idNum)) continue
    for (const alias of aliasNames) {
      const v = row[alias]
      if (typeof v === 'string' && v.includes('�')) {
        idsByAlias[alias].add(idNum)
        anyNeedsFix = true
      }
    }
  }
  if (!anyNeedsFix) return rows

  // One batched CONVERT query per source column, over all distinct ids.
  const valueByAlias: Record<string, Map<number, string>> = {}
  for (const alias of aliasNames) {
    valueByAlias[alias] = new Map<number, string>()
    const ids = idsByAlias[alias]
    if (ids.size === 0) continue
    const sourceCol = aliasMap[alias]
    try {
      const r = await query<{ id: number; v: unknown }>(
        `SELECT ${keyCol} AS id, CONVERT(${sourceCol} USING 'UTF-8') AS v FROM ${table} WHERE ${keyCol} IN (${Array.from(ids).join(',')})`,
      )
      for (const rec of r) {
        if (rec.v == null) continue
        const val = rec.v
        valueByAlias[alias].set(
          Number(rec.id),
          val instanceof ArrayBuffer ? Buffer.from(val).toString('utf8') : String(val),
        )
      }
    } catch {
      // keep originals on failure
    }
  }

  // Apply the fetched values back onto every corrupted row.
  return rows.map((row) => {
    const id = row[idField]
    if (id == null) return row
    let fixed: T | null = null
    for (const alias of aliasNames) {
      const v = row[alias]
      if (typeof v === 'string' && v.includes('�')) {
        const nv = valueByAlias[alias].get(Number(id))
        if (nv != null) {
          if (!fixed) fixed = { ...row }
          ;(fixed as Record<string, unknown>)[alias] = nv
        }
      }
    }
    return fixed ?? row
  })
}

export async function repairAllJoins(rows: StockFini[]): Promise<StockFini[]> {
  let fixed = rows
  fixed = await repairAliased(fixed, 'ref_fini', 'IDref_fini', { ref_fini: 'reference', designation: 'designation' })
  fixed = await repairAliased(fixed, 'ref_fini_colori', 'IDColoris', { coloris_dyed: 'reference' }, 'IDref_fini_colori')
  fixed = await repairAliased(fixed, 'colori_ecru', 'IDColoris', { coloris_wash: 'reference' }, 'IDcolori_ecru')
  fixed = await repairAliased(fixed, 'etat_stock_fini', 'IDetat_stock_fini', { etat_libelle: 'libelle' })
  fixed = await repairAliased(fixed, 'sous_traitant', 'IDmagasin', { magasin_nom: 'nom' }, 'IDsous_traitant')
  // Pick the coloris label dictated by avec_teinture (0 = wash → colori_ecru,
  // 1/2 = dyed → ref_fini_colori). Unknown ref (null) defaults to dyed to keep
  // the previous behaviour. Collapse to the single `coloris_reference` field
  // the frontend expects and drop the internal helpers.
  for (const r of fixed) {
    const av = (r as any).avec_teinture
    const dyed = av == null ? true : Number(av) !== 0
    ;(r as any).coloris_reference = (dyed ? (r as any).coloris_dyed : (r as any).coloris_wash) ?? null
    delete (r as any).coloris_dyed
    delete (r as any).coloris_wash
    delete (r as any).avec_teinture
  }
  return fixed
}

// Enrich list rows with the extra legacy columns that aren't covered by the
// shared SELECT/JOINS (those are reused by the detail + label endpoints, so we
// keep them lean and enrich here only):
//   • contexture_nom + grammage — ref_fini → ref_ecru → contexture, and
//     ref_fini.poids_Moy (g/m²)
//   • client_nom + commande_numero — IDligne_commande_client → ligne_commande_client
//     → commande_client → client
// Batched flat queries + JS merge: no CONVERT-in-JOIN collapse, no row
// multiplication, every WHERE is an integer IN-list (bridge-storm safe). The
// accented name columns (contexture.nom, client.nom) are repaired with
// fixEncoding, never named in a WHERE.
async function enrichListExtras(rows: StockFini[]): Promise<StockFini[]> {
  if (rows.length === 0) return rows
  const num = (v: unknown) => Number(v) || 0

  // ── Contexture + grammage, keyed off IDref_fini ──
  const refFiniIds = Array.from(new Set(rows.map((r) => num((r as any).IDref_fini)).filter((x) => x > 0)))
  const grammageByRef = new Map<number, number | null>()
  const ecruByRef = new Map<number, number>()
  if (refFiniIds.length) {
    const rf = await query<{ IDref_fini: number; IDref_ecru: number; poids_Moy: number | null }>(
      `SELECT IDref_fini, IDref_ecru, poids_Moy FROM ref_fini WHERE IDref_fini IN (${refFiniIds.join(',')})`,
    )
    for (const r of rf) {
      const g = r.poids_Moy == null ? null : Number(r.poids_Moy)
      grammageByRef.set(num(r.IDref_fini), g && g > 0 ? g : null)
      ecruByRef.set(num(r.IDref_fini), num(r.IDref_ecru))
    }
  }
  const ecruIds = Array.from(new Set(Array.from(ecruByRef.values()).filter((x) => x > 0)))
  const ctxByEcru = new Map<number, number>()
  if (ecruIds.length) {
    const re = await query<{ IDref_ecru: number; IDcontexture: number }>(
      `SELECT IDref_ecru, IDcontexture FROM ref_ecru WHERE IDref_ecru IN (${ecruIds.join(',')})`,
    )
    for (const r of re) ctxByEcru.set(num(r.IDref_ecru), num(r.IDcontexture))
  }
  const ctxIds = Array.from(new Set(Array.from(ctxByEcru.values()).filter((x) => x > 0)))
  const ctxNameById = new Map<number, string>()
  if (ctxIds.length) {
    const cx = await query<{ IDcontexture: number; nom: string | null }>(
      `SELECT IDcontexture, nom FROM contexture WHERE IDcontexture IN (${ctxIds.join(',')})`,
    )
    for (const r of (await fixEncoding(cx as any[], 'contexture', 'IDcontexture', ['nom'])) as any[]) {
      ctxNameById.set(num(r.IDcontexture), (r.nom ?? '').toString().trim())
    }
  }

  // ── Client + commande N°, keyed off IDligne_commande_client ──
  const lccIds = Array.from(new Set(rows.map((r) => num((r as any).IDligne_commande_client)).filter((x) => x > 0)))
  const lccToCc = new Map<number, number>()
  if (lccIds.length) {
    const lcc = await query<{ IDligne_commande_client: number; IDcommande_client: number }>(
      `SELECT IDligne_commande_client, IDcommande_client FROM ligne_commande_client WHERE IDligne_commande_client IN (${lccIds.join(',')})`,
    )
    for (const r of lcc) lccToCc.set(num(r.IDligne_commande_client), num(r.IDcommande_client))
  }
  const ccIds = Array.from(new Set(Array.from(lccToCc.values()).filter((x) => x > 0)))
  const ccNumero = new Map<number, number>()
  const ccToClient = new Map<number, number>()
  if (ccIds.length) {
    const cc = await query<{ IDcommande_client: number; numero: number | null; IDclient: number }>(
      `SELECT IDcommande_client, numero, IDclient FROM commande_client WHERE IDcommande_client IN (${ccIds.join(',')})`,
    )
    for (const r of cc) {
      ccNumero.set(num(r.IDcommande_client), num(r.numero))
      ccToClient.set(num(r.IDcommande_client), num(r.IDclient))
    }
  }
  const clientIds = Array.from(new Set(Array.from(ccToClient.values()).filter((x) => x > 0)))
  const clientName = new Map<number, string>()
  if (clientIds.length) {
    const cl = await query<{ IDclient: number; nom: string | null }>(
      `SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`,
    )
    for (const r of (await fixEncoding(cl as any[], 'client', 'IDclient', ['nom'])) as any[]) {
      clientName.set(num(r.IDclient), (r.nom ?? '').toString().trim())
    }
  }

  for (const r of rows as any[]) {
    const idRef = num(r.IDref_fini)
    const ecru = ecruByRef.get(idRef) ?? 0
    r.contexture_nom = ctxNameById.get(ctxByEcru.get(ecru) ?? 0) || null
    r.grammage = grammageByRef.get(idRef) ?? null
    const cc = lccToCc.get(num(r.IDligne_commande_client)) ?? 0
    r.commande_numero = (ccNumero.get(cc) ?? 0) || null
    r.client_nom = clientName.get(ccToClient.get(cc) ?? 0) || null
  }
  return rows
}

// GET /api/stock/fini - List stock_fini rows with joined display columns.
//   ?q=<text>        — fuzzy search across ref/coloris/lot/numero/emplacement/observations/conteneur
//   ?expedie=all     — include rolls already shipped (default hides them)
stockFiniRouter.get('/fini', async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const showShipped = req.query.expedie === 'all'

    const where: string[] = []
    // HFSQL stores "no FK" as 0 (not NULL). Hide rolls that have shipped:
    //   - IDligne_expedition = 0 means not on a shipment slip
    //   - IDetat_stock_fini = 4 means "Expédié" état (manual flag)
    if (!showShipped) where.push(`(sf.IDligne_expedition IS NULL OR sf.IDligne_expedition = 0) AND (sf.IDetat_stock_fini IS NULL OR sf.IDetat_stock_fini <> 4)`)
    if (q) {
      const e = esc(q)
      where.push(
        `(sf.lot LIKE '%${e}%' OR sf.numero LIKE '%${e}%' OR sf.emplacement LIKE '%${e}%' OR sf.conteneur LIKE '%${e}%' OR sf.observations LIKE '%${e}%' OR rf.reference LIKE '%${e}%' OR rfc.reference LIKE '%${e}%' OR ce.reference LIKE '%${e}%')`,
      )
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const sql = `SELECT ${STOCK_FINI_SELECT} ${STOCK_FINI_JOINS} ${whereSql} ORDER BY sf.date_saisie DESC, sf.IDstock_fini DESC`
    const rows = await query<StockFini>(sql)

    // Batched accent repair for the base table's own text columns, then the
    // joined columns — both via the batched repairAliased (no per-row N+1).
    let fixed = await repairAliased(rows, 'stock_fini', 'IDstock_fini', {
      lot: 'lot',
      numero: 'numero',
      observations: 'observations',
      observation_sst: 'observation_sst',
      emplacement: 'emplacement',
      conteneur: 'conteneur',
    })
    fixed = await repairAllJoins(fixed)
    fixed = await enrichListExtras(fixed)

    res.json(fixed)
  } catch (err) {
    console.error('Error fetching stock_fini:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/fini/lookups/etats - état_stock_fini rows for the drawer dropdown.
stockFiniRouter.get('/fini/lookups/etats', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDetat_stock_fini: number; libelle: string }>(
      `SELECT IDetat_stock_fini, libelle FROM etat_stock_fini ORDER BY IDetat_stock_fini ASC`,
    )
    const fixed = await fixEncoding(rows, 'etat_stock_fini', 'IDetat_stock_fini', ['libelle'])
    res.json(fixed)
  } catch (err) {
    console.error('Error fetching etat_stock_fini:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/fini/lookups/refs - ref_fini list for the "Nouveau" form.
//   Carries avec_teinture so the coloris lookup can pick the right catalog.
stockFiniRouter.get('/fini/lookups/refs', async (_req: Request, res: Response) => {
  try {
    // ref_fini.archivé is accented: name it only on Windows; on Linux SELECT *
    // and filter in JS (naming the accented column storms the bridge).
    const sql = IS_WINDOWS
      ? `SELECT IDref_fini, reference, designation, avec_teinture FROM ref_fini WHERE archivé = 0 ORDER BY reference`
      : `SELECT * FROM ref_fini ORDER BY reference`
    const rows = await query<Record<string, unknown>>(sql)
    const visible = IS_WINDOWS ? rows : rows.filter((r) => !isArchive(r))
    const shaped = visible.map((r) => ({
      IDref_fini: Number(r.IDref_fini),
      reference: (r.reference ?? null) as string | null,
      designation: (r.designation ?? null) as string | null,
      avec_teinture: Number(r.avec_teinture) || 0,
    }))
    const fixed = (await fixEncoding(shaped, 'ref_fini', 'IDref_fini', ['reference', 'designation'])) as any[]
    res.json(fixed.filter((r) => r.reference && String(r.reference).trim().length > 0))
  } catch (err) {
    console.error('Error fetching refs-fini lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/fini/lookups/coloris?ref_fini=X - coloris options for a ref,
//   polymorphic by ref_fini.avec_teinture (memory project_avec_teinture_coloris_rule):
//     0 (wash)   → colori_ecru of the ref's écru base (IDref_ecru)
//     1/2 (dyed) → ref_fini_colori of the ref. The returned `id` is the value
//   to store in stock_fini.IDColoris (a colori_ecru id or a ref_fini_colori id).
stockFiniRouter.get('/fini/lookups/coloris', async (req: Request, res: Response) => {
  try {
    const refFini = parseInt(String(req.query.ref_fini ?? ''), 10)
    if (isNaN(refFini) || refFini <= 0) { res.json([]); return }
    // avec_teinture and IDref_ecru are ASCII column names — safe to name on
    // both platforms in a single-table SELECT.
    const refRows = await query<{ avec_teinture: number | null; IDref_ecru: number | null }>(
      `SELECT avec_teinture, IDref_ecru FROM ref_fini WHERE IDref_fini = ${refFini}`,
    )
    if (refRows.length === 0) { res.json([]); return }
    const dyed = Number(refRows[0].avec_teinture) !== 0
    let out: Array<{ id: number; reference: string | null }>
    if (dyed) {
      const rows = await query<{ IDref_fini_colori: number; reference: string | null }>(
        `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini = ${refFini} ORDER BY reference`,
      )
      const fixed = (await fixEncoding(rows, 'ref_fini_colori', 'IDref_fini_colori', ['reference'])) as any[]
      out = fixed.map((r) => ({ id: Number(r.IDref_fini_colori), reference: r.reference }))
    } else {
      const idRefEcru = Number(refRows[0].IDref_ecru) || 0
      if (idRefEcru <= 0) { res.json([]); return }
      const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(
        `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDref_ecru = ${idRefEcru} ORDER BY reference`,
      )
      const fixed = (await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference'])) as any[]
      out = fixed.map((r) => ({ id: Number(r.IDcolori_ecru), reference: r.reference }))
    }
    res.json(out.filter((r) => r.reference && String(r.reference).trim().length > 0))
  } catch (err) {
    console.error('Error fetching coloris lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/fini/lookups/magasins - sous_traitant rows used as depots for
//   the "Nouveau" form's Magasin dropdown (stock_fini.IDmagasin → sous_traitant).
stockFiniRouter.get('/fini/lookups/magasins', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDsous_traitant: number; nom: string | null }>(
      `SELECT IDsous_traitant, nom FROM sous_traitant ORDER BY nom`,
    )
    const fixed = (await fixEncoding(rows, 'sous_traitant', 'IDsous_traitant', ['nom'])) as any[]
    res.json(
      fixed
        .filter((r) => r.nom && String(r.nom).trim().length > 0)
        .map((r) => ({ IDsous_traitant: Number(r.IDsous_traitant), nom: r.nom })),
    )
  } catch (err) {
    console.error('Error fetching magasins lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/stock/fini - manually create a finished roll. Gated by the
//   create_stock_fini permission (effective admins bypass; impersonation does
//   not). All columns are ASCII; text values go through sqlText() for bridge
//   safety. IDColoris must be the catalog id matching the ref's avec_teinture
//   (the /lookups/coloris endpoint already returns the correct id space).
stockFiniRouter.post('/fini', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'create_stock_fini')
    if (!allowed) {
      res.status(403).json({ error: 'permission denied: create_stock_fini' })
      return
    }

    const b = req.body ?? {}
    const IDref_fini = parseInt(String(b.IDref_fini), 10)
    const IDColoris = parseInt(String(b.IDColoris), 10)
    const poids = Number(b.poids)
    const metrage = Number(b.metrage)
    if (!Number.isInteger(IDref_fini) || IDref_fini <= 0) {
      res.status(400).json({ error: 'IDref_fini required' })
      return
    }
    if (!Number.isInteger(IDColoris) || IDColoris <= 0) {
      res.status(400).json({ error: 'IDColoris required' })
      return
    }
    if (!Number.isFinite(poids) || poids < 0 || !Number.isFinite(metrage) || metrage < 0) {
      res.status(400).json({ error: 'poids and metrage must be non-negative numbers' })
      return
    }
    const r2 = (v: number) => Math.round(v * 100) / 100
    const IDetat = Number.isInteger(parseInt(String(b.IDetat_stock_fini), 10))
      ? parseInt(String(b.IDetat_stock_fini), 10)
      : 1 // default "En Contrôle"
    const IDmagasin = Number.isInteger(parseInt(String(b.IDmagasin), 10)) && parseInt(String(b.IDmagasin), 10) > 0
      ? parseInt(String(b.IDmagasin), 10)
      : 0
    const secondChoix = b.second_choix ? 1 : 0
    const lot = (b.lot ?? '').toString()
    const numero = (b.numero ?? '').toString()
    const emplacement = (b.emplacement ?? '').toString()
    const observations = (b.observations ?? '').toString()
    const now = new Date()
    const dateSaisie = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`

    await query(
      `INSERT INTO stock_fini
       (numero, lot, poids, metrage, IDref_fini, IDColoris, IDstock_ecru,
        IDmagasin, IDref_commande_source, observations, observation_sst, emplacement, date_saisie,
        second_choix, destockage, don, IDProprietaire, IDcommande_donation, IDligne_commande_client,
        IDligne_expedition, IDetat_stock_fini)
       VALUES (${sqlText(numero)}, ${sqlText(lot)}, ${r2(poids)}, ${r2(metrage)}, ${IDref_fini}, ${IDColoris}, 0,
               ${IDmagasin}, 0, ${sqlText(observations)}, '', ${sqlText(emplacement)}, '${dateSaisie}',
               ${secondChoix}, 0, 0, 0, 0, 0,
               0, ${IDetat})`,
    )
    const idRows = await query<{ id: number }>(`SELECT MAX(IDstock_fini) AS id FROM stock_fini`)
    const newId = Number(idRows[0]?.id) || null
    res.status(201).json({ IDstock_fini: newId })
  } catch (err) {
    console.error('Error creating stock_fini:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/fini/:id - Single stock_fini row by id.
stockFiniRouter.get('/fini/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }

    const rows = await query<StockFini>(
      `SELECT ${STOCK_FINI_SELECT} ${STOCK_FINI_JOINS} WHERE sf.IDstock_fini = ${id}`,
    )
    if (rows.length === 0) {
      res.status(404).json({ error: 'Stock fini not found' })
      return
    }

    let fixed = await fixEncoding(rows, 'stock_fini', 'IDstock_fini', TEXT_FIELDS)
    fixed = await repairAllJoins(fixed)

    res.json(fixed[0])
  } catch (err) {
    console.error('Error fetching stock_fini detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Provenance helpers ─────────────────────────────────
// Resolve a sous-traitant commande LINE id to { sous-traitant name, commande
// id }. The sst order "number" is the commande PK (commande_sous_traitant has
// no numero column — matches the rest of the app). Flat queries + JS merge:
// the sous_traitant.nom is accented, so it's read raw and repaired via
// fixEncoding (never named in a WHERE — bridge-storm footgun). Integer-only
// WHERE clauses throughout.
export async function resolveSstLine(
  lineId: number,
): Promise<{ sst_nom: string | null; IDcommande: number } | null> {
  if (!(lineId > 0)) return null
  const lineRows = await query<{ IDcommande_sous_traitant: number }>(
    `SELECT IDcommande_sous_traitant FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant = ${lineId}`,
  )
  const cmdId = Number(lineRows[0]?.IDcommande_sous_traitant) || 0
  if (!cmdId) return null
  const cmdRows = await query<{ IDsous_traitant: number }>(
    `SELECT IDsous_traitant FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${cmdId}`,
  )
  const sstId = Number(cmdRows[0]?.IDsous_traitant) || 0
  let sstNom: string | null = null
  if (sstId > 0) {
    const stRows = await query<{ IDsous_traitant: number; nom: string | null }>(
      `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant = ${sstId}`,
    )
    const fixedSt = await fixEncoding(stRows as any[], 'sous_traitant', 'IDsous_traitant', ['nom'])
    const n = (fixedSt[0] as any)?.nom
    sstNom = n != null ? n.toString().trim() || null : null
  }
  return { sst_nom: sstNom, IDcommande: cmdId }
}

// Resolve the yarns (fils) affected to a tricoteur sst LINE via
// asso_fil_lignecmdsst → stock_fil. Each fil carries its designation
// (ref_fil.reference), its supplier (fournisseur.nom) and its fournisseur
// order number (commande_fil id, via ref_fil_commande). Deduped per
// (ref_fil, fournisseur, commande). All accented name columns repaired with
// fixEncoding; every WHERE uses integer id lists only.
export async function resolveProvenanceFils(
  tricoteurLineId: number,
): Promise<Array<{ ref_fil: string | null; fournisseur: string | null; IDcommande_fil: number | null }>> {
  if (!(tricoteurLineId > 0)) return []
  const asso = await query<{ IDstock_fil: number }>(
    `SELECT IDstock_fil FROM asso_fil_lignecmdsst WHERE IDligne_commande_sous_traitant = ${tricoteurLineId}`,
  )
  const stockFilIds = Array.from(new Set(asso.map((a) => Number(a.IDstock_fil)).filter((x) => x > 0)))
  if (stockFilIds.length === 0) return []

  const lots = await query<{
    IDstock_fil: number
    IDref_fil: number
    IDfournisseur: number
    IDref_fil_commande: number
  }>(
    `SELECT IDstock_fil, IDref_fil, IDfournisseur, IDref_fil_commande FROM stock_fil WHERE IDstock_fil IN (${stockFilIds.join(',')})`,
  )

  // ref_fil designation (accented → repair)
  const refFilIds = Array.from(new Set(lots.map((l) => Number(l.IDref_fil)).filter((x) => x > 0)))
  const refFilMap = new Map<number, string>()
  if (refFilIds.length) {
    const rf = await query<{ IDref_fil: number; reference: string | null }>(
      `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${refFilIds.join(',')})`,
    )
    for (const r of await fixEncoding(rf as any[], 'ref_fil', 'IDref_fil', ['reference'])) {
      refFilMap.set(Number((r as any).IDref_fil), ((r as any).reference ?? '').toString().trim())
    }
  }

  // fournisseur name (accented → repair)
  const frsIds = Array.from(new Set(lots.map((l) => Number(l.IDfournisseur)).filter((x) => x > 0)))
  const frsMap = new Map<number, string>()
  if (frsIds.length) {
    const fr = await query<{ IDfournisseur: number; nom: string | null }>(
      `SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur IN (${frsIds.join(',')})`,
    )
    for (const f of await fixEncoding(fr as any[], 'fournisseur', 'IDfournisseur', ['nom'])) {
      frsMap.set(Number((f as any).IDfournisseur), ((f as any).nom ?? '').toString().trim())
    }
  }

  // ref_fil_commande line → commande_fil header id (the order N°)
  const rfcIds = Array.from(new Set(lots.map((l) => Number(l.IDref_fil_commande)).filter((x) => x > 0)))
  const cmdMap = new Map<number, number>()
  if (rfcIds.length) {
    const rfc = await query<{ IDref_fil_commande: number; IDcommande_fil: number }>(
      `SELECT IDref_fil_commande, IDcommande_fil FROM ref_fil_commande WHERE IDref_fil_commande IN (${rfcIds.join(',')})`,
    )
    for (const r of rfc) cmdMap.set(Number(r.IDref_fil_commande), Number(r.IDcommande_fil) || 0)
  }

  const seen = new Set<string>()
  const out: Array<{ ref_fil: string | null; fournisseur: string | null; IDcommande_fil: number | null }> = []
  for (const lot of lots) {
    const ref = refFilMap.get(Number(lot.IDref_fil)) || null
    const frs = frsMap.get(Number(lot.IDfournisseur)) || null
    const cmd = cmdMap.get(Number(lot.IDref_fil_commande)) || 0
    const key = `${Number(lot.IDref_fil)}:${Number(lot.IDfournisseur)}:${cmd}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ref_fil: ref, fournisseur: frs, IDcommande_fil: cmd || null })
  }
  return out
}

// GET /api/stock/fini/:id/provenance — yarn + order origins of one roll.
//   Chain: stock_fini.IDref_commande_source → the dyeing (ennoblisseur) sst
//   line; stock_fini.IDstock_ecru → stock_ecru.IDref_commande_source → the
//   tricoteur sst line, whose asso_fil_lignecmdsst yarn lots resolve back to
//   ref_fil + fournisseur + commande_fil. Read-only, not permission-gated.
stockFiniRouter.get('/fini/:id/provenance', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }
    const rows = await query<{ IDstock_ecru: number; IDref_commande_source: number }>(
      `SELECT IDstock_ecru, IDref_commande_source FROM stock_fini WHERE IDstock_fini = ${id}`,
    )
    if (rows.length === 0) {
      res.status(404).json({ error: 'Stock fini not found' })
      return
    }
    const ecruId = Number(rows[0].IDstock_ecru) || 0
    const sourceLineId = Number(rows[0].IDref_commande_source) || 0

    // Immediate source line = the dyeing (ennoblisseur) sst commande line.
    const ennoblissement = await resolveSstLine(sourceLineId)

    // Tricotage = the line that knit the source écru roll.
    let tricoteurLineId = 0
    if (ecruId > 0) {
      const ecruRows = await query<{ IDref_commande_source: number }>(
        `SELECT IDref_commande_source FROM stock_ecru WHERE IDstock_ecru = ${ecruId}`,
      )
      tricoteurLineId = Number(ecruRows[0]?.IDref_commande_source) || 0
    }
    const tricotage = await resolveSstLine(tricoteurLineId)
    const fils = await resolveProvenanceFils(tricoteurLineId)

    res.json({ tricotage, ennoblissement, fils })
  } catch (err) {
    console.error('Error fetching stock_fini provenance:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/fini/:id/label - Dymo étiquette PDF (89 × 36 mm) for one roll.
// Read-only, not permission-gated. Reuses the same SELECT/JOINs/repair as the
// detail endpoint so coloris_reference is resolved identically.
stockFiniRouter.get('/fini/:id/label', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }

    const rows = await query<StockFini>(
      `SELECT ${STOCK_FINI_SELECT} ${STOCK_FINI_JOINS} WHERE sf.IDstock_fini = ${id}`,
    )
    if (rows.length === 0) {
      res.status(404).json({ error: 'Stock fini not found' })
      return
    }

    let fixed = await fixEncoding(rows, 'stock_fini', 'IDstock_fini', TEXT_FIELDS)
    fixed = await repairAllJoins(fixed)
    const row = fixed[0] as Record<string, unknown>

    const data: StockFiniLabelData = {
      numero: (row.numero as string | null) ?? null,
      ref_fini: (row.ref_fini as string | null) ?? null,
      coloris_reference: (row.coloris_reference as string | null) ?? null,
      poids: (row.poids as number | null) ?? null,
      metrage: (row.metrage as number | null) ?? null,
      lot: (row.lot as string | null) ?? null,
    }

    const buffer = await renderToBuffer(
      React.createElement(StockFiniLabelPdf, { data }) as unknown as React.ReactElement<
        import('@react-pdf/renderer').DocumentProps
      >,
    )

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="etiquette-${id}.pdf"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering stock_fini label PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/stock/fini/batch - batch-edit ("Édition groupée") emplacement
//   and/or observations across many rolls at once. Body:
//     { ids: number[], emplacement?: string, observations?: string }
//   Only the provided fields are written (an empty string clears the field);
//   omit a field to leave it untouched. Accented values are emitted via
//   sqlText() so French observations don't corrupt the Linux bridge.
//   MUST be registered before PATCH /fini/:id, otherwise "batch" is parsed as
//   the :id param.
//   Gated like the single-roll PATCH: edit_stock_fini + the sub-permission of
//   each written field (emplacement → stockage, observations → notes).
stockFiniRouter.patch('/fini/batch', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }
    const admin = isEffectiveAdmin(req)
    const allowed = await userHasPermission(req.userId, admin, 'edit_stock_fini')
    if (!allowed) {
      res.status(403).json({ error: 'permission denied: edit_stock_fini' })
      return
    }

    const body = req.body ?? {}
    if (typeof body.emplacement === 'string' && !(await userHasPermission(req.userId, admin, 'edit_stock_fini_stockage'))) {
      res.status(403).json({ error: 'permission denied: edit_stock_fini_stockage' })
      return
    }
    if (typeof body.observations === 'string' && !(await userHasPermission(req.userId, admin, 'edit_stock_fini_notes'))) {
      res.status(403).json({ error: 'permission denied: edit_stock_fini_notes' })
      return
    }
    const ids = (Array.isArray(body.ids) ? body.ids : [])
      .map((x: unknown) => parseInt(String(x), 10))
      .filter((n: number) => Number.isInteger(n) && n > 0)
    if (ids.length === 0) {
      res.status(400).json({ error: 'ids must be a non-empty array of roll ids' })
      return
    }
    if (ids.length > 1000) {
      res.status(400).json({ error: 'too many ids (max 1000)' })
      return
    }

    const sets: string[] = []
    if (typeof body.emplacement === 'string') sets.push(`emplacement = ${sqlText(body.emplacement)}`)
    if (typeof body.observations === 'string') sets.push(`observations = ${sqlText(body.observations)}`)
    if (sets.length === 0) {
      res.status(400).json({ error: 'No editable fields provided' })
      return
    }

    await query(`UPDATE stock_fini SET ${sets.join(', ')} WHERE IDstock_fini IN (${ids.join(',')})`)

    res.json({ updated: ids.length })
  } catch (err) {
    console.error('Error batch-updating stock_fini:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Sub-permissions of edit_stock_fini, one per drawer section. A field may
// only be written when the acting user holds edit_stock_fini AND the section's
// sub-key (effective admins bypass both, inside userHasPermission).
type EditSubKey =
  | 'edit_stock_fini_stockage'
  | 'edit_stock_fini_etat'
  | 'edit_stock_fini_affectation'
  | 'edit_stock_fini_notes'

async function loadEditSubPermissions(
  userId: number,
  isAdmin: boolean,
): Promise<Record<EditSubKey, boolean>> {
  return {
    edit_stock_fini_stockage: await userHasPermission(userId, isAdmin, 'edit_stock_fini_stockage'),
    edit_stock_fini_etat: await userHasPermission(userId, isAdmin, 'edit_stock_fini_etat'),
    edit_stock_fini_affectation: await userHasPermission(userId, isAdmin, 'edit_stock_fini_affectation'),
    edit_stock_fini_notes: await userHasPermission(userId, isAdmin, 'edit_stock_fini_notes'),
  }
}

// PATCH /api/stock/fini/:id - whitelist edit
//   poids, metrage, IDref_fini, IDColoris, IDref_commande_source, IDstock_ecru,
//   IDligne_expedition, IDligne_commande_client are NOT editable here — they
//   belong to the sst reception / shipment flows.
//   Field groups map to the edit_stock_fini_* sub-permissions:
//     stockage    → emplacement, conteneur, pointage
//     etat        → second_choix, IDetat_stock_fini
//     affectation → don, destockage
//     notes       → observations, observation_sst
stockFiniRouter.patch('/fini/:id', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }
    const admin = isEffectiveAdmin(req)
    const allowed = await userHasPermission(req.userId, admin, 'edit_stock_fini')
    if (!allowed) {
      res.status(403).json({ error: 'permission denied: edit_stock_fini' })
      return
    }
    const sub = await loadEditSubPermissions(req.userId, admin)
    const deny = (key: EditSubKey) => res.status(403).json({ error: `permission denied: ${key}` })

    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }

    const body = req.body ?? {}
    const sets: string[] = []

    if (typeof body.observations === 'string' || typeof body.observation_sst === 'string') {
      if (!sub.edit_stock_fini_notes) { deny('edit_stock_fini_notes'); return }
    }
    if (typeof body.emplacement === 'string' || typeof body.conteneur === 'string' || typeof body.pointage === 'string') {
      if (!sub.edit_stock_fini_stockage) { deny('edit_stock_fini_stockage'); return }
    }
    if (body.second_choix !== undefined || body.IDetat_stock_fini !== undefined) {
      if (!sub.edit_stock_fini_etat) { deny('edit_stock_fini_etat'); return }
    }
    if (body.don !== undefined || body.destockage !== undefined) {
      if (!sub.edit_stock_fini_affectation) { deny('edit_stock_fini_affectation'); return }
    }

    if (typeof body.observations === 'string') sets.push(`observations = ${sqlText(body.observations)}`)
    if (typeof body.observation_sst === 'string') sets.push(`observation_sst = ${sqlText(body.observation_sst)}`)
    if (typeof body.emplacement === 'string') sets.push(`emplacement = ${sqlText(body.emplacement)}`)
    if (typeof body.conteneur === 'string') sets.push(`conteneur = ${sqlText(body.conteneur)}`)
    if (body.second_choix !== undefined) sets.push(`second_choix = ${body.second_choix ? 1 : 0}`)
    if (body.destockage !== undefined) sets.push(`destockage = ${body.destockage ? 1 : 0}`)
    if (body.don !== undefined) sets.push(`don = ${body.don ? 1 : 0}`)
    if (body.IDetat_stock_fini !== undefined) {
      const v = parseInt(String(body.IDetat_stock_fini), 10)
      if (!isNaN(v)) sets.push(`IDetat_stock_fini = ${v}`)
    }
    if (typeof body.pointage === 'string') {
      const d = body.pointage
      // stock_fini.pointage is a NOT NULL date column — an empty date must be
      // written as '' (HFSQL's empty-date sentinel), never NULL. Writing NULL
      // is rejected server-side ("item does not allow Null values"), which the
      // bridge mis-reads as a lost connection and respawns, wedging the queue.
      if (d === '') sets.push(`pointage = ''`)
      else sets.push(`pointage = '${esc(d)}'`)
    }

    if (sets.length === 0) {
      res.status(400).json({ error: 'No editable fields provided' })
      return
    }

    await query(`UPDATE stock_fini SET ${sets.join(', ')} WHERE IDstock_fini = ${id}`)

    // Fetch fresh row in the same shape as GET /fini/:id
    const rows = await query<StockFini>(
      `SELECT ${STOCK_FINI_SELECT} ${STOCK_FINI_JOINS} WHERE sf.IDstock_fini = ${id}`,
    )
    let fixed = await fixEncoding(rows, 'stock_fini', 'IDstock_fini', TEXT_FIELDS)
    fixed = await repairAllJoins(fixed)

    res.json(fixed[0])
  } catch (err) {
    console.error('Error updating stock_fini:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Resolve a set of IDligne_commande_client → client display name, via the
// flat chain ligne_commande_client → commande_client → client. Flat queries
// only (a JOIN + CONVERT collapses the result set on the Linux bridge — see
// CLAUDE.md). Returns a Map keyed by IDligne_commande_client; missing/empty
// links are simply absent.
async function resolveClientNames(lccIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const ids = Array.from(new Set(lccIds.filter((x) => Number.isInteger(x) && x > 0)))
  if (ids.length === 0) return out
  const lccRows = await query<{ IDligne_commande_client: number; IDcommande_client: number }>(
    `SELECT IDligne_commande_client, IDcommande_client FROM ligne_commande_client WHERE IDligne_commande_client IN (${ids.join(',')})`,
  )
  const lccToCc = new Map<number, number>()
  for (const r of lccRows) lccToCc.set(Number(r.IDligne_commande_client), Number(r.IDcommande_client) || 0)
  const ccIds = Array.from(new Set(Array.from(lccToCc.values()))).filter((x) => x > 0)
  const ccToClient = new Map<number, number>()
  if (ccIds.length > 0) {
    const ccRows = await query<{ IDcommande_client: number; IDclient: number }>(
      `SELECT IDcommande_client, IDclient FROM commande_client WHERE IDcommande_client IN (${ccIds.join(',')})`,
    )
    for (const r of ccRows) ccToClient.set(Number(r.IDcommande_client), Number(r.IDclient) || 0)
  }
  const clientIds = Array.from(new Set(Array.from(ccToClient.values()))).filter((x) => x > 0)
  const clientName = new Map<number, string>()
  if (clientIds.length > 0) {
    const cRows = await query<{ IDclient: number; nom: string | null }>(
      `SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`,
    )
    const fixedC = (await fixEncoding(cRows, 'client', 'IDclient', ['nom'])) as any[]
    for (const r of fixedC) clientName.set(Number(r.IDclient), (r.nom ?? '').toString().trim())
  }
  for (const [lccId, ccId] of lccToCc) {
    const name = clientName.get(ccToClient.get(ccId) ?? 0) ?? ''
    if (name) out.set(lccId, name)
  }
  return out
}

// Build the surteinture trace observation for a finished roll being sent back
// to dyeing: "<lot> - <ref> - <coloris> a surteindre". Built server-side so the
// modal preview and the actual write can never drift.
function surteintObservation(lot: string, ref: string, coloris: string): string {
  return [lot, ref, coloris].map((s) => (s ?? '').toString().trim()).filter(Boolean).join(' - ') + ' a surteindre'
}

interface SurteintFiniRow {
  IDstock_fini: number
  IDstock_ecru: number
  IDligne_expedition: number
  lot: string
  ref_fini: string
  coloris_reference: string
  numero: string
  poids: number
  metrage: number
  IDligne_commande_client: number
}

// Load the selected finished rolls with the fields surteinture needs, resolving
// coloris via the same SELECT/JOIN/repair path as the list so labels match.
async function loadSurteintFiniRows(ids: number[]): Promise<SurteintFiniRow[]> {
  const rows = await query<StockFini>(
    `SELECT ${STOCK_FINI_SELECT} ${STOCK_FINI_JOINS} WHERE sf.IDstock_fini IN (${ids.join(',')})`,
  )
  let fixed = await fixEncoding(rows, 'stock_fini', 'IDstock_fini', TEXT_FIELDS)
  fixed = await repairAllJoins(fixed)
  return (fixed as any[]).map((r) => ({
    IDstock_fini: Number(r.IDstock_fini),
    IDstock_ecru: Number(r.IDstock_ecru) || 0,
    IDligne_expedition: Number(r.IDligne_expedition) || 0,
    lot: (r.lot ?? '').toString().trim(),
    ref_fini: (r.ref_fini ?? '').toString().trim(),
    coloris_reference: (r.coloris_reference ?? '').toString().trim(),
    numero: (r.numero ?? '').toString().trim(),
    poids: Number(r.poids) || 0,
    metrage: Number(r.metrage) || 0,
    IDligne_commande_client: Number(r.IDligne_commande_client) || 0,
  }))
}

// POST /api/stock/fini/surteindre/preview - drive the Surteinture modal.
//   Body: { ids: number[] }. Returns, per selected roll, the fini fields (left
//   table) + the linked tombé-de-métier écru fields (right table) + the trace
//   observation that will be written. Also returns the colori_ecru catalog for
//   the rolls' écru base + the current (default) écru coloris. Rolls with no
//   linked écru are flagged `skipped` so the UI can warn.
//   MUST be registered before POST /fini/:id-style routes (none today, but keep
//   it above /fini/:id/cut for clarity).
stockFiniRouter.post('/fini/surteindre/preview', async (req: Request, res: Response) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
      .map((x: unknown) => parseInt(String(x), 10))
      .filter((n: number) => Number.isInteger(n) && n > 0)
    if (ids.length === 0) {
      res.status(400).json({ error: 'ids must be a non-empty array of roll ids' })
      return
    }
    if (ids.length > 200) {
      res.status(400).json({ error: 'too many ids (max 200)' })
      return
    }

    const finiRows = await loadSurteintFiniRows(ids)

    // Linked écru rows (skip rolls with no source écru).
    const ecruIds = Array.from(new Set(finiRows.map((r) => r.IDstock_ecru).filter((x) => x > 0)))
    const ecruById = new Map<number, any>()
    if (ecruIds.length > 0) {
      const ecruRows = await query<Record<string, unknown>>(
        `SELECT IDstock_ecru, numero, IDref_ecru, IDcolori_ecru, poids, IDmagasin, observations, IDligne_commande_client
         FROM stock_ecru WHERE IDstock_ecru IN (${ecruIds.join(',')})`,
      )
      const fixedEcru = await fixEncoding(ecruRows, 'stock_ecru', 'IDstock_ecru', ['numero', 'observations'])
      for (const r of fixedEcru as any[]) ecruById.set(Number(r.IDstock_ecru), r)
    }

    // Resolve display lookups: ref_ecru.reference, colori_ecru.reference,
    // magasin (sous_traitant.nom), and client names for both fini + écru lines.
    const refEcruIds = Array.from(new Set(Array.from(ecruById.values()).map((r) => Number(r.IDref_ecru)).filter((x) => x > 0)))
    const refEcruLabel = new Map<number, string>()
    if (refEcruIds.length > 0) {
      const rr = await query<{ IDref_ecru: number; reference: string | null }>(
        `SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru IN (${refEcruIds.join(',')})`,
      )
      for (const r of (await fixEncoding(rr, 'ref_ecru', 'IDref_ecru', ['reference'])) as any[])
        refEcruLabel.set(Number(r.IDref_ecru), (r.reference ?? '').toString().trim())
    }

    // colori_ecru labels for the écru rows (read-only display in the right table).
    const coloriLabel = new Map<number, string>()
    if (refEcruIds.length > 0) {
      const cr = await query<{ IDcolori_ecru: number; IDref_ecru: number; reference: string | null }>(
        `SELECT IDcolori_ecru, IDref_ecru, reference FROM colori_ecru WHERE IDref_ecru IN (${refEcruIds.join(',')}) ORDER BY reference`,
      )
      for (const r of (await fixEncoding(cr, 'colori_ecru', 'IDcolori_ecru', ['reference'])) as any[]) {
        coloriLabel.set(Number(r.IDcolori_ecru), (r.reference ?? '').toString().trim())
      }
    }

    const magasinIds = Array.from(new Set(Array.from(ecruById.values()).map((r) => Number(r.IDmagasin)).filter((x) => x > 0)))
    const magasinLabel = new Map<number, string>()
    if (magasinIds.length > 0) {
      const mr = await query<{ IDsous_traitant: number; nom: string | null }>(
        `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${magasinIds.join(',')})`,
      )
      for (const r of (await fixEncoding(mr, 'sous_traitant', 'IDsous_traitant', ['nom'])) as any[])
        magasinLabel.set(Number(r.IDsous_traitant), (r.nom ?? '').toString().trim())
    }

    const allLcc = [
      ...finiRows.map((r) => r.IDligne_commande_client),
      ...Array.from(ecruById.values()).map((r) => Number(r.IDligne_commande_client) || 0),
    ]
    const clientByLcc = await resolveClientNames(allLcc)

    const rows = finiRows.map((f) => {
      const ecru = f.IDstock_ecru > 0 ? ecruById.get(f.IDstock_ecru) : undefined
      const ecruColoris = ecru ? coloriLabel.get(Number(ecru.IDcolori_ecru)) ?? '' : ''
      return {
        IDstock_fini: f.IDstock_fini,
        skipped: !ecru,
        fini: {
          numero: f.numero,
          poids: f.poids,
          metrage: f.metrage,
          lot: f.lot,
          client: clientByLcc.get(f.IDligne_commande_client) ?? '',
        },
        ecru: ecru
          ? {
              IDstock_ecru: Number(ecru.IDstock_ecru),
              numero: (ecru.numero ?? '').toString().trim(),
              ref_ecru: refEcruLabel.get(Number(ecru.IDref_ecru)) ?? '',
              coloris: ecruColoris,
              poids: Number(ecru.poids) || 0,
              magasin_nom: magasinLabel.get(Number(ecru.IDmagasin)) ?? '',
              client: clientByLcc.get(Number(ecru.IDligne_commande_client) || 0) ?? '',
            }
          : null,
        computedObservation: surteintObservation(f.lot, f.ref_fini, f.coloris_reference),
      }
    })

    res.json({ rows })
  } catch (err) {
    console.error('Error building surteinture preview:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/stock/fini/surteindre - execute the surteinture.
//   Body: { ids: number[] }.
//   Gated by surteindre_stock_fini. For each selected roll that has a linked
//   écru and is not shipped: append the trace observation to its tombé-de-métier
//   (stock_ecru) row, then DELETE the finished roll. The écru thus returns to
//   available stock for a fresh dyeing cycle, keeping a record of where it came
//   from. The écru's coloris and magasin are left untouched. Accented text via
//   sqlText().
stockFiniRouter.post('/fini/surteindre', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'surteindre_stock_fini')
    if (!allowed) {
      res.status(403).json({ error: 'permission denied: surteindre_stock_fini' })
      return
    }

    const b = req.body ?? {}
    const ids = (Array.isArray(b.ids) ? b.ids : [])
      .map((x: unknown) => parseInt(String(x), 10))
      .filter((n: number) => Number.isInteger(n) && n > 0)
    if (ids.length === 0) {
      res.status(400).json({ error: 'ids must be a non-empty array of roll ids' })
      return
    }
    if (ids.length > 200) {
      res.status(400).json({ error: 'too many ids (max 200)' })
      return
    }

    const finiRows = await loadSurteintFiniRows(ids)

    // Existing écru observations (to append, not overwrite).
    const ecruIds = Array.from(new Set(finiRows.map((r) => r.IDstock_ecru).filter((x) => x > 0)))
    const ecruObs = new Map<number, string>()
    if (ecruIds.length > 0) {
      const ecruRows = await query<{ IDstock_ecru: number; observations: string | null }>(
        `SELECT IDstock_ecru, observations FROM stock_ecru WHERE IDstock_ecru IN (${ecruIds.join(',')})`,
      )
      for (const r of (await fixEncoding(ecruRows, 'stock_ecru', 'IDstock_ecru', ['observations'])) as any[])
        ecruObs.set(Number(r.IDstock_ecru), (r.observations ?? '').toString())
    }

    let deleted = 0
    let updated = 0
    let skipped = 0
    for (const f of finiRows) {
      // Skip rolls with no source écru or already shipped — nothing to send back.
      if (f.IDstock_ecru <= 0 || f.IDligne_expedition > 0) {
        skipped++
        continue
      }
      const trace = surteintObservation(f.lot, f.ref_fini, f.coloris_reference)
      const existing = (ecruObs.get(f.IDstock_ecru) ?? '').trim()
      const obs = existing ? `${existing}\n${trace}` : trace

      await query(`UPDATE stock_ecru SET observations = ${sqlText(obs)} WHERE IDstock_ecru = ${f.IDstock_ecru}`)
      updated++
      await query(`DELETE FROM stock_fini WHERE IDstock_fini = ${f.IDstock_fini}`)
      deleted++
    }

    res.json({ deleted, updated, skipped })
  } catch (err) {
    console.error('Error executing surteinture:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Base + next free suffix index for a roll about to be cut. The sibling scan
 *  is a flat `LIKE '<base>-%'` on `numero` alone (no memo column named, so the
 *  Windows driver returns rows); the digits test happens in JS. */
async function nextFiniCutNumero(numero: string | null, id: number): Promise<{ base: string; next: number }> {
  const own = (numero ?? '').trim() || `#${id}`
  const base = cutBase(own)
  const siblings = await query<{ numero: string | null }>(
    `SELECT numero FROM stock_fini WHERE numero LIKE '${esc(base)}-%'`,
  )
  return { base, next: nextCutIndex(base, siblings.map((r) => r.numero ?? '')) }
}

// GET /api/stock/fini/:id/cut/preview - the numbers a cut of this roll would
//   produce: `{ base, next }` — the dialog labels its pieces `<base>-<next>`,
//   `<base>-<next+1>`, … before the user confirms. Same gate as the cut.
stockFiniRouter.get('/fini/:id/cut/preview', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'cut_stock_fini')
    if (!allowed) {
      res.status(403).json({ error: 'permission denied: cut_stock_fini' })
      return
    }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }
    const rows = await query<{ numero: string | null }>(`SELECT numero FROM stock_fini WHERE IDstock_fini = ${id}`)
    if (rows.length === 0) {
      res.status(404).json({ error: 'Stock fini not found' })
      return
    }
    res.json(await nextFiniCutNumero(rows[0].numero, id))
  } catch (err) {
    console.error('Error previewing stock_fini cut:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/stock/fini/:id/cut - cut one physical roll into N rolls.
//   Body: { pieces: Array<{ poids: number; metrage: number }> } (length 2..10).
//   Piece 0 is the original row (updated in place, numero kept) — the piece
//   that stays on the shelf; pieces 1..N-1 are new rows that inherit EVERY
//   other column from the original (ref, coloris, lot, état, magasin,
//   emplacement, client-line link, …) numbered `<base>-<next>`, `<base>-<next+1>`,
//   … (lib/roll-cut.ts). The poids/metrage of the pieces must sum to the
//   original (value conservation), re-validated here regardless of what the
//   client sent. Answers `{ ok, created, numeros }`.
//
//   New rows are created with INSERT ... SELECT so accented text columns
//   (observations, …) are copied inside the DB — no encoding round-trip through
//   the SQL string, which keeps the Linux bridge happy.
stockFiniRouter.post('/fini/:id/cut', async (req: Request, res: Response) => {
  try {
    // Permission gate: must have cut_stock_fini (effective admins bypass; an
    // admin impersonating another user sees exactly what that user sees).
    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'cut_stock_fini')
    if (!allowed) {
      res.status(403).json({ error: 'permission denied: cut_stock_fini' })
      return
    }

    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }

    const pieces = (req.body?.pieces ?? []) as Array<{ poids?: unknown; metrage?: unknown }>
    if (!Array.isArray(pieces) || pieces.length < 2 || pieces.length > 10) {
      res.status(400).json({ error: 'pieces must be an array of length 2..10' })
      return
    }
    const norm = pieces.map((p) => ({
      poids: Number(p?.poids),
      metrage: Number(p?.metrage),
    }))
    if (norm.some((p) => !Number.isFinite(p.poids) || !Number.isFinite(p.metrage) || p.poids < 0 || p.metrage < 0)) {
      res.status(400).json({ error: 'each piece needs a non-negative poids and metrage' })
      return
    }

    const origRows = await query<{ poids: number | null; metrage: number | null; numero: string | null; IDligne_expedition: number | null }>(
      `SELECT poids, metrage, numero, IDligne_expedition FROM stock_fini WHERE IDstock_fini = ${id}`,
    )
    if (origRows.length === 0) {
      res.status(404).json({ error: 'Stock fini not found' })
      return
    }
    const orig = origRows[0]
    if (Number(orig.IDligne_expedition) > 0) {
      res.status(400).json({ error: 'Roll already shipped' })
      return
    }

    const origPoids = Number(orig.poids) || 0
    const origMetrage = Number(orig.metrage) || 0
    const sumPoids = norm.reduce((s, p) => s + p.poids, 0)
    const sumMetrage = norm.reduce((s, p) => s + p.metrage, 0)
    if (Math.abs(sumPoids - origPoids) > 0.01 || Math.abs(sumMetrage - origMetrage) > 0.1) {
      res.status(400).json({ error: 'Sum mismatch: pieces must total the original poids and metrage' })
      return
    }

    // Round to avoid float artefacts in the stored values.
    const r2 = (v: number) => Math.round(v * 100) / 100
    // Suffix rule (lib/roll-cut.ts, LIVA #1135): the next free `<base>-N` among
    // the numeros already derived from this roll's base, so a second cut on the
    // same roll — or a cut on `<base>-2` itself — never duplicates a number.
    const { base, next } = await nextFiniCutNumero(orig.numero, id)

    // Piece 0 -> update the original row in place (numero unchanged). The
    // dialog sends the piece that STAYS ON THE SHELF here; the cut-off pieces
    // are the new rows.
    await query(
      `UPDATE stock_fini SET poids = ${r2(norm[0].poids)}, metrage = ${r2(norm[0].metrage)} WHERE IDstock_fini = ${id}`,
    )

    // Pieces 1..N-1 -> new rows copying every other column from the original.
    const COPY_COLS =
      'numero, IDstock_ecru, poids, metrage, lot, observations, second_choix, IDref_commande_source, IDmagasin, IDref_fini, IDColoris, date_saisie, IDetat_stock_fini, destockage, IDligne_commande_client, IDProprietaire, IDcommande_donation, conteneur, emplacement, don, pointage, observation_sst, IDligne_expedition'
    const created: string[] = []
    for (let i = 1; i < norm.length; i++) {
      const child = childNumero(base, next + i - 1)
      created.push(child)
      await query(
        `INSERT INTO stock_fini (${COPY_COLS})
         SELECT '${esc(child)}', IDstock_ecru, ${r2(norm[i].poids)}, ${r2(norm[i].metrage)}, lot, observations, second_choix, IDref_commande_source, IDmagasin, IDref_fini, IDColoris, date_saisie, IDetat_stock_fini, destockage, IDligne_commande_client, IDProprietaire, IDcommande_donation, conteneur, emplacement, don, pointage, observation_sst, IDligne_expedition
         FROM stock_fini WHERE IDstock_fini = ${id}`,
      )
    }

    res.json({ ok: true, created: norm.length - 1, numeros: created })
  } catch (err) {
    console.error('Error cutting stock_fini:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
