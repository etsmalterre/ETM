import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { query, queryRaw, fixEncoding } from '../lib/hfsql-auto.js'
import { userHasPermission } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'

export const stockRouter: RouterType = Router()

type StockFil = Record<string, unknown>

/** Escape a string for use in SQL (single quotes doubled) */
function esc(value: string): string {
  return value.replace(/'/g, "''")
}

// stock_fil has accented column names (terminé, controlé, certif_recyclé) and
// ref_fil has recyclé. Windows and Linux HFSQL ODBC paths have OPPOSITE quirks:
//
// • Linux (iODBC bridge → wd310hfo64.so): accepts `alias.*` expansion, but any
//   reference to an accented identifier token (UTF-8 é) blows up the tokenizer.
//   Workaround: use `sf.*` to pull accented columns back with their last char
//   truncated (terminé→termin, controlé→control, certif_recyclé→certif_recycl).
//
// • Windows (odbc npm package → Windows HFSQL driver): accepts accented
//   column names as long as they're written in the exact source encoding, but
//   silently returns zero rows for `alias.*` in a JOIN. Workaround: list every
//   column explicitly with `alias.terminé AS termine` style aliases.
//
// Each path defines its own SELECT/JOINS strings below. The `normalizeStockRow`
// post-processor then maps both shapes to the same canonical ASCII keys.
const IS_WINDOWS = process.platform === 'win32'

const STOCK_SELECT = IS_WINDOWS
  ? `sf.IDstock_fil, sf.IDfournisseur, sf.IDref_fil, sf.IDcolori_fil, sf.IDref_fil_commande, sf.IDMagasin, sf.stock, sf.stock_initial, sf.lot, sf.lot_frs, sf.emplacement, sf.date_entree, sf.dernier_mouvement, sf.dernier_pointage, sf.niveau, sf.terminé AS termine, sf.controlé AS controle, sf.commentaire, sf.observation_freinte, rf.reference AS ref_fil, rf.titrage, rf.bio, rf.recyclé AS recycle, cf.reference AS colori_reference, f.nom AS fournisseur_nom, st.nom AS magasin_nom`
  : `sf.*, rf.reference AS ref_fil, rf.titrage, rf.bio, cf.reference AS colori_reference, f.nom AS fournisseur_nom, st.nom AS magasin_nom`

const STOCK_JOINS = `FROM stock_fil sf LEFT JOIN ref_fil rf ON sf.IDref_fil = rf.IDref_fil LEFT JOIN colori_fil cf ON sf.IDcolori_fil = cf.IDcolori_fil LEFT JOIN fournisseur f ON sf.IDfournisseur = f.IDfournisseur LEFT JOIN sous_traitant st ON sf.IDMagasin = st.IDsous_traitant`

// Accented sf.* columns (terminé, controlé, certif_recyclé; ref_fil.recyclé) come
// back from the Linux bridge with the identifier truncated at the accent AND a
// non-deterministic garbage trailing byte from a reused buffer: `terminé` arrives
// as `termin`, `termint`, `termini`, … depending on server load. A hardcoded
// fallback (`row.termin`) therefore MISSES the key in production, leaving the flag
// at 0 for every row (this broke "Masquer les lots terminés"). Always resolve
// these columns by case-insensitive PREFIX, never by a hardcoded name.
export function pickVal(row: Record<string, unknown>, re: RegExp): unknown {
  const k = Object.keys(row).find((key) => re.test(key))
  return k === undefined ? undefined : row[k]
}
/** Delete every key matching `re` from `out` — strips all mangled variants. */
export function stripKeys(out: Record<string, unknown>, re: RegExp): void {
  for (const k of Object.keys(out)) if (re.test(k)) delete out[k]
}

// The recycle map is a full-table SELECT * over ref_fil on every list/detail/
// patch request — cache it briefly so the TRM screen (stock-fil-trm.ts) and
// this router don't hammer the shared bridge. The flag changes rarely; 60s of
// staleness is invisible to users.
let recycleMapCache: { map: Map<number, number>; at: number } | null = null
const RECYCLE_MAP_TTL_MS = 60_000

/** Load IDref_fil → recycle map via SELECT * (cannot SELECT recyclé directly). */
export async function loadRefFilRecycleMap(): Promise<Map<number, number>> {
  if (recycleMapCache && Date.now() - recycleMapCache.at < RECYCLE_MAP_TTL_MS) {
    return recycleMapCache.map
  }
  const rows = await query<Record<string, unknown>>(`SELECT * FROM ref_fil`)
  const map = new Map<number, number>()
  for (const r of rows) {
    const id = Number(r.IDref_fil)
    // recyclé → recycl/recyclt/… on the bridge, recyclé on Windows — resolve by prefix.
    const recycle = Number(pickVal(r, /^recycl/i)) || 0
    if (!Number.isNaN(id)) map.set(id, recycle)
  }
  recycleMapCache = { map, at: Date.now() }
  return map
}

/**
 * Normalise a stock_fil row so the HTTP payload has stable, ASCII-only keys:
 *   terminé / termin        → termine
 *   controlé / control      → controle
 *   certif_recyclé / certif_recycl → certif_recycle (boolean flag, not blob)
 * Also attaches `recycle` (from ref_fil) using the provided map.
 */
export function normalizeStockRow(row: Record<string, unknown>, recycleMap: Map<number, number>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }

  // terminé / controlé: read by prefix BEFORE stripping every mangled variant
  // (the bridge key is non-deterministic — termin/termint/…; see pickVal above).
  const termineVal = pickVal(out, /^termin/i)
  const controleVal = pickVal(out, /^control/i)
  stripKeys(out, /^termin/i)
  stripKeys(out, /^control/i)
  out.termine = Number(termineVal) || 0
  out.controle = Number(controleVal) || 0

  // certif_recyclé / certif_bio blobs — keep them out of the JSON payload.
  stripKeys(out, /^certif_recycl/i)
  delete out.certif_bio

  // recycle (from ref_fil)
  const idRefFil = Number(out.IDref_fil)
  out.recycle = recycleMap.get(idRefFil) ?? 0

  return out
}

// GET /api/stock/fil - List stock_fil rows with joined display columns
stockRouter.get('/fil', async (req: Request, res: Response) => {
  try {
    const fournisseur = req.query.fournisseur ? parseInt(String(req.query.fournisseur), 10) : null
    const showAll = req.query.terminé === 'all' || req.query.termine === 'all'
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''

    // WHERE clause: only use non-accented columns. terminé filter is applied in JS.
    const where: string[] = []
    if (fournisseur && !isNaN(fournisseur)) where.push(`sf.IDfournisseur = ${fournisseur}`)
    if (q) {
      const e = esc(q)
      where.push(`(sf.lot LIKE '%${e}%' OR sf.lot_frs LIKE '%${e}%' OR sf.emplacement LIKE '%${e}%' OR rf.reference LIKE '%${e}%' OR cf.reference LIKE '%${e}%' OR f.nom LIKE '%${e}%')`)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const sql = `SELECT ${STOCK_SELECT} ${STOCK_JOINS} ${whereSql} ORDER BY sf.date_entree DESC, sf.IDstock_fil DESC`
    const rows = await query<StockFil>(sql)

    // Encoding repair on text fields
    let fixed: StockFil[] = await fixEncoding(
      rows,
      'stock_fil',
      'IDstock_fil',
      ['lot', 'lot_frs', 'emplacement', 'commentaire', 'observation_freinte']
    )
    fixed = await repairAliased(fixed, 'ref_fil', 'IDref_fil', { ref_fil: 'reference' })
    fixed = await repairAliased(fixed, 'colori_fil', 'IDcolori_fil', { colori_reference: 'reference' })
    fixed = await repairAliased(fixed, 'fournisseur', 'IDfournisseur', { fournisseur_nom: 'nom' })

    // Load ref_fil recycle flags and normalise each row
    const recycleMap = await loadRefFilRecycleMap()
    let normalised = fixed.map((r) => normalizeStockRow(r as Record<string, unknown>, recycleMap))

    // Apply terminé filter in JS
    if (!showAll) {
      normalised = normalised.filter((r) => !(r as any).termine || Number((r as any).termine) === 0)
    }

    res.json(normalised)
  } catch (err) {
    console.error('Error fetching stock_fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/fil/etat?ref_fil=X&colori_fil=Y
// Yarn-stock summary for one (ref_fil, colori_fil): en stock / commandé /
// besoin / disponible — backs the "État des stocks de fil" dashboard widget.
// MUST be declared before '/fil/:id' so "etat" isn't captured as an id.
stockRouter.get('/fil/etat', async (req: Request, res: Response) => {
  try {
    const refFil = parseInt(String(req.query.ref_fil ?? ''), 10)
    const coloriFil = parseInt(String(req.query.colori_fil ?? ''), 10)
    if (!Number.isFinite(refFil) || refFil <= 0 || !Number.isFinite(coloriFil) || coloriFil <= 0) {
      res.status(400).json({ error: 'ref_fil and colori_fil are required' }); return
    }

    // En stock — physical on-hand rolls (stock > 0), with their source
    // fournisseur. `terminé` is accented (bridge can't tokenize it in WHERE);
    // consumed rolls carry stock=0 so `stock > 0` already excludes them.
    const stockRows = await query<{ lot: string | null; stock: number | null; IDfournisseur: number }>(
      `SELECT lot, stock, IDfournisseur FROM stock_fil
       WHERE IDref_fil = ${refFil} AND IDcolori_fil = ${coloriFil} AND stock > 0
       ORDER BY stock DESC`,
    )
    const en_stock = stockRows.reduce((s, r) => s + (Number(r.stock) || 0), 0)
    const nb_lots = stockRows.length

    // Commandé — incoming order lines not yet received (etat = 0). The
    // fournisseur lives on the commande_fil header, not the line.
    const cmdRows = await query<{ IDref_fil_commande: number; IDcommande_fil: number; quantite: number | null }>(
      `SELECT IDref_fil_commande, IDcommande_fil, quantite FROM ref_fil_commande
       WHERE IDref_fil = ${refFil} AND IDcolori_fil = ${coloriFil} AND etat = 0
       ORDER BY IDcommande_fil DESC`,
    )
    const nb_commandes = cmdRows.length

    // Received-against-line — sum of stock_initial of every stock_fil roll
    // linked back to the order line via IDref_fil_commande (the same aggregate
    // the commande detail surfaces as "N lots · X kg"). A partially-received
    // line stays etat = 0, so without this its full ordered quantity would
    // still count as "commandé" even though some has already landed in stock.
    // Subtracting it also avoids double-counting: received rolls already sit in
    // `en_stock`, so a gross "commandé" would inflate `disponible`.
    const lineIds = cmdRows.map((r) => Number(r.IDref_fil_commande)).filter((x) => x > 0)
    const recuByLine = new Map<number, number>()
    if (lineIds.length > 0) {
      const recuRows = await query<{ IDref_fil_commande: number; stock_initial: number | null }>(
        `SELECT IDref_fil_commande, stock_initial FROM stock_fil WHERE IDref_fil_commande IN (${lineIds.join(',')})`,
      )
      for (const rr of recuRows) {
        const lid = Number(rr.IDref_fil_commande)
        recuByLine.set(lid, (recuByLine.get(lid) ?? 0) + (Number(rr.stock_initial) || 0))
      }
    }

    const cmdIds = Array.from(new Set(cmdRows.map((r) => Number(r.IDcommande_fil)).filter((x) => x > 0)))
    const cmdFournisseur = new Map<number, number>()
    if (cmdIds.length > 0) {
      const headerRows = await query<{ IDcommande_fil: number; IDfournisseur: number }>(
        `SELECT IDcommande_fil, IDfournisseur FROM commande_fil WHERE IDcommande_fil IN (${cmdIds.join(',')})`,
      )
      for (const h of headerRows) cmdFournisseur.set(Number(h.IDcommande_fil), Number(h.IDfournisseur) || 0)
    }

    // Resolve fournisseur names with a flat query + fixEncoding (names are
    // accented; a JOIN + CONVERT would collapse the result set on the bridge).
    const frsIds = Array.from(new Set([
      ...stockRows.map((r) => Number(r.IDfournisseur)).filter((x) => x > 0),
      ...Array.from(cmdFournisseur.values()).filter((x) => x > 0),
    ]))
    const frsName = new Map<number, string>()
    if (frsIds.length > 0) {
      const frsRows = await query<{ IDfournisseur: number; nom: string | null }>(
        `SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur IN (${frsIds.join(',')})`,
      )
      for (const f of await fixEncoding(frsRows as any[], 'fournisseur', 'IDfournisseur', ['nom'])) {
        frsName.set(Number((f as any).IDfournisseur), ((f as any).nom ?? '').toString().trim())
      }
    }

    const en_stock_rows = stockRows.map((r) => ({
      lot: (r.lot ?? '').toString().trim() || '—',
      fournisseur: frsName.get(Number(r.IDfournisseur)) || '—',
      kg: Number(r.stock) || 0,
    }))
    const commande_rows = cmdRows.map((r) => {
      const ordered = Number(r.quantite) || 0
      const recu = recuByLine.get(Number(r.IDref_fil_commande)) ?? 0
      const reste = Math.max(0, ordered - recu)
      return {
        commande: Number(r.IDcommande_fil) || 0,
        fournisseur: frsName.get(cmdFournisseur.get(Number(r.IDcommande_fil)) ?? 0) || '—',
        ordered,
        recu,
        kg: reste,
      }
    })
    // Outstanding quantity still to receive — gross ordered minus what's landed.
    const commande = commande_rows.reduce((s, r) => s + r.kg, 0)

    // Besoin — yarn affected to OPEN tricoteur orders. asso_fil_lignecmdsst links
    // a stock_fil roll → a tricoteur sst line; scope to commandes est_soldee = 0.
    // All-ASCII columns, no CONVERT → the JOIN is bridge-safe. Lots are ASCII.
    const besoinRows = await query<{ quantite: number | null; lot: string | null; cmd_sst: number }>(
      `SELECT a.quantite, sf.lot AS lot, cst.IDcommande_sous_traitant AS cmd_sst
       FROM asso_fil_lignecmdsst a
       JOIN stock_fil sf ON a.IDstock_fil = sf.IDstock_fil
       JOIN ligne_commande_sous_traitant lcs ON a.IDligne_commande_sous_traitant = lcs.IDligne_commande_sous_traitant
       JOIN commande_sous_traitant cst ON lcs.IDcommande_sous_traitant = cst.IDcommande_sous_traitant
       WHERE sf.IDref_fil = ${refFil} AND sf.IDcolori_fil = ${coloriFil} AND cst.est_soldee = 0
       ORDER BY a.quantite DESC`,
    )
    const besoin_rows = besoinRows.map((r) => ({
      lot: (r.lot ?? '').toString().trim() || '—',
      commande_sst: Number(r.cmd_sst) || 0,
      kg: Number(r.quantite) || 0,
    }))
    const besoin = besoin_rows.reduce((s, r) => s + r.kg, 0)
    const nb_affectations = besoin_rows.length

    res.json({
      ref_fil: refFil,
      colori_fil: coloriFil,
      en_stock,
      nb_lots,
      en_stock_rows,
      commande,
      nb_commandes,
      commande_rows,
      besoin,
      nb_affectations,
      besoin_rows,
      disponible: en_stock + commande - besoin,
    })
  } catch (err) {
    console.error('Error computing fil etat:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Normalise a HFSQL date value to "YYYYMMDD". Handles both the 8-char string
// form (stock_fil.date_entree = "20201021") and the datetime form
// (stock_ecru.date_saisie = "2020-09-30 00:00:00.000").
export function toYmd(v: unknown): string {
  if (v == null) return ''
  const s = String(v).trim()
  if (/^\d{8}$/.test(s)) return s
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return m[1] + m[2] + m[3]
  return ''
}

// GET /api/stock/fil/la-gentle-stale?cutoff=YYYYMMDD
// Stale-stock report for client "La Gentle Factory" (IDclient = 8): yarn lots
// (terminé = 0) whose last movement — max(stock_ecru.date_saisie via
// asso_fil_of), falling back to stock_fil.date_entree — is on or before the
// cutoff. Returns JSON rows; the frontend builds the .xlsx.
//
// HFSQL footguns handled per the canonical /fil list pattern:
//   - `terminé` is accented → can't WHERE on the Linux bridge; filter in JS.
//   - no inline CONVERT in the JOIN (collapses result sets); encoding fixed
//     afterwards via fixEncoding (stock_fil) + repairAliased (ref/coloris/client).
//   - the max + HAVING(date) is done in JS to avoid an accent-tainted aggregate.
// MUST be declared before '/fil/:id' so "la-gentle-stale" isn't captured as an id.
const LA_GENTLE_CLIENT_ID = 8
stockRouter.get('/fil/la-gentle-stale', async (req: Request, res: Response) => {
  try {
    const cutoffRaw = String(req.query.cutoff ?? '')
    if (!/^\d{8}$/.test(cutoffRaw)) {
      res.status(400).json({ error: 'cutoff (YYYYMMDD) is required' }); return
    }
    const cutoff = cutoffRaw

    // Main rows — JOIN without CONVERT. On Windows we can name terminé; on the
    // Linux bridge we fall back to sf.* and read the truncated key in JS.
    const sfCols = IS_WINDOWS
      ? `sf.IDstock_fil, sf.IDref_fil, sf.IDcolori_fil, sf.IDclient, sf.lot, sf.stock, sf.emplacement, sf.commentaire, sf.date_entree, sf.terminé AS termine`
      : `sf.*`
    const rows = await query<Record<string, unknown>>(
      `SELECT ${sfCols}, c.nom AS client_nom, rf.reference AS ref_fil, cf.reference AS coloris
       FROM stock_fil sf
       LEFT JOIN client c ON c.IDclient = sf.IDclient
       LEFT JOIN ref_fil rf ON rf.IDref_fil = sf.IDref_fil
       LEFT JOIN colori_fil cf ON cf.IDcolori_fil = sf.IDcolori_fil
       WHERE sf.IDclient = ${LA_GENTLE_CLIENT_ID}`,
    )

    // terminé filter in JS (accented column, key varies by platform).
    const active = rows.filter((r) => {
      const t = pickVal(r, /^termin/i)
      return !t || Number(t) === 0
    })

    // Encoding repair (only re-queries rows that actually contain U+FFFD).
    let fixed = await fixEncoding(active, 'stock_fil', 'IDstock_fil', ['lot', 'emplacement', 'commentaire'])
    fixed = await repairAliased(fixed as any, 'ref_fil', 'IDref_fil', { ref_fil: 'reference' })
    fixed = await repairAliased(fixed as any, 'colori_fil', 'IDcolori_fil', { coloris: 'reference' })
    fixed = await repairAliased(fixed as any, 'client', 'IDclient', { client_nom: 'nom' })

    // dernier_mouvement = max( IFNULL(stock_ecru.date_saisie, date_entree) ) per
    // lot. Fetch the raw (lot → ecru date) pairs and fold in JS.
    const entreeBySfid = new Map<number, string>()
    for (const r of fixed) entreeBySfid.set(Number((r as any).IDstock_fil), toYmd((r as any).date_entree))

    const ids = Array.from(entreeBySfid.keys()).filter((x) => x > 0)
    const ecruBySfid = new Map<number, string[]>()
    if (ids.length > 0) {
      const ecruRows = await query<{ sfid: number; ds: unknown }>(
        `SELECT a.IDstock_fil AS sfid, se.date_saisie AS ds
         FROM asso_fil_of a
         JOIN stock_ecru se ON se.IDordre_fabrication = a.IDordre_fabrication
         WHERE a.IDstock_fil IN (${ids.join(',')})`,
      )
      for (const er of ecruRows) {
        const sfid = Number(er.sfid)
        // IFNULL(date_saisie, date_entree)
        const eff = toYmd(er.ds) || entreeBySfid.get(sfid) || ''
        if (!eff) continue
        const arr = ecruBySfid.get(sfid) ?? []
        arr.push(eff)
        ecruBySfid.set(sfid, arr)
      }
    }

    const out = fixed
      .map((r) => {
        const sfid = Number((r as any).IDstock_fil)
        const entree = entreeBySfid.get(sfid) || ''
        const cands = ecruBySfid.get(sfid) ?? (entree ? [entree] : [])
        const dernier = cands.length > 0 ? cands.reduce((a, b) => (a >= b ? a : b)) : ''
        return {
          client: ((r as any).client_nom ?? '').toString().trim(),
          lot: ((r as any).lot ?? '').toString().trim(),
          reference: ((r as any).ref_fil ?? '').toString().trim(),
          coloris: ((r as any).coloris ?? '').toString().trim(),
          stock: Number((r as any).stock) || 0,
          emplacement: ((r as any).emplacement ?? '').toString().trim(),
          commentaire: ((r as any).commentaire ?? '').toString().trim(),
          dernier_mouvement: dernier, // YYYYMMDD
        }
      })
      // Legacy report only lists lots actually holding stock — exclude
      // depleted (0) and anomalous negative rows.
      .filter((r) => r.stock > 0 && r.dernier_mouvement !== '' && r.dernier_mouvement <= cutoff)
      .sort((a, b) => a.dernier_mouvement.localeCompare(b.dernier_mouvement))

    res.json({ client_nom: 'La Gentle Factory', cutoff, count: out.length, rows: out })
  } catch (err) {
    console.error('Error computing la-gentle stale stock:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/fil/:id - Single stock_fil row + has_certif flags
stockRouter.get('/fil/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }

    const rows = await query<StockFil>(
      `SELECT ${STOCK_SELECT} ${STOCK_JOINS} WHERE sf.IDstock_fil = ${id}`
    )
    if (rows.length === 0) {
      res.status(404).json({ error: 'Stock fil not found' })
      return
    }

    let fixed: StockFil[] = await fixEncoding(
      rows,
      'stock_fil',
      'IDstock_fil',
      ['lot', 'lot_frs', 'emplacement', 'commentaire', 'observation_freinte']
    )
    fixed = await repairAliased(fixed, 'ref_fil', 'IDref_fil', { ref_fil: 'reference' })
    fixed = await repairAliased(fixed, 'colori_fil', 'IDcolori_fil', { colori_reference: 'reference' })
    fixed = await repairAliased(fixed, 'fournisseur', 'IDfournisseur', { fournisseur_nom: 'nom' })

    const recycleMap = await loadRefFilRecycleMap()
    const normalised = normalizeStockRow(fixed[0] as Record<string, unknown>, recycleMap)

    // Resolve the real commande number. stock_fil.IDref_fil_commande is the
    // ref_fil_commande LINE PK, NOT the commande N° — the commande number lives
    // on the line as IDcommande_fil. (e.g. lot 10471 → line 920 → commande 646.)
    let IDcommande_fil = 0
    const lineId = Number((normalised as Record<string, unknown>).IDref_fil_commande) || 0
    if (lineId > 0) {
      const cmdRows = await query<{ IDcommande_fil: number }>(
        `SELECT IDcommande_fil FROM ref_fil_commande WHERE IDref_fil_commande = ${lineId}`
      )
      IDcommande_fil = Number(cmdRows[0]?.IDcommande_fil) || 0
    }

    // has_certif flags: SELECT * on the row and check the mangled blob column for non-null.
    // Cannot reference certif_recyclé directly; SELECT * returns it as certif_recycl (bridge)
    // or 'certif_recyclé' (Windows ODBC). Check both.
    let has_certif_bio = false
    let has_certif_recycle = false
    try {
      const rawRows = await query<Record<string, unknown>>(
        `SELECT * FROM stock_fil WHERE IDstock_fil = ${id}`
      )
      if (rawRows.length > 0) {
        const r = rawRows[0] as any
        has_certif_bio = r.certif_bio != null && r.certif_bio !== '' && r.certif_bio !== '\x00'
        const rec = pickVal(r, /^certif_recycl/i)
        has_certif_recycle = rec != null && rec !== '' && rec !== '\x00'
      }
    } catch {
      // ignore — default to false
    }

    res.json({ ...normalised, IDcommande_fil, has_certif_bio, has_certif_recycle })
  } catch (err) {
    console.error('Error fetching stock_fil detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/stock/fil - Create a new lot de fil
stockRouter.post('/fil', async (req: Request, res: Response) => {
  // Permission gate: must have create_stock_fil (effective admins bypass).
  // An admin who is impersonating another user does NOT bypass — they see
  // exactly what the impersonated user sees.
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return
  }
  const allowed = await userHasPermission(
    req.userId,
    isEffectiveAdmin(req),
    'create_stock_fil',
  )
  if (!allowed) {
    res.status(403).json({ error: 'permission denied: create_stock_fil' })
    return
  }

  try {
    const body = req.body ?? {}
    const IDfournisseur = parseInt(String(body.IDfournisseur), 10)
    const IDref_fil = parseInt(String(body.IDref_fil), 10)
    const IDcolori_fil = parseInt(String(body.IDcolori_fil), 10)
    const stock_initial = Number(body.stock_initial)

    if (isNaN(IDfournisseur) || isNaN(IDref_fil) || isNaN(IDcolori_fil)) {
      res.status(400).json({ error: 'IDfournisseur, IDref_fil and IDcolori_fil are required' })
      return
    }
    if (isNaN(stock_initial) || stock_initial < 0) {
      res.status(400).json({ error: 'stock_initial must be a positive number' })
      return
    }

    const lot = typeof body.lot === 'string' ? body.lot : ''
    const lot_frs = typeof body.lot_frs === 'string' ? body.lot_frs : ''
    const emplacement = typeof body.emplacement === 'string' ? body.emplacement : ''
    const commentaire = typeof body.commentaire === 'string' ? body.commentaire : ''
    const niveau = typeof body.niveau === 'number' ? body.niveau : 1

    // Default date_entree to today if not provided
    let date_entree = typeof body.date_entree === 'string' && body.date_entree.length === 8 ? body.date_entree : ''
    if (!date_entree) {
      const d = new Date()
      date_entree = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    }

    // Accented columns terminé/controlé cannot be named in the INSERT column list
    // on the Linux bridge. Only include them on Windows.
    const insertSql = IS_WINDOWS
      ? `INSERT INTO stock_fil (IDfournisseur, IDref_fil, IDcolori_fil, stock, stock_initial, lot, lot_frs, emplacement, date_entree, commentaire, niveau, terminé, controlé) VALUES (${IDfournisseur}, ${IDref_fil}, ${IDcolori_fil}, ${stock_initial}, ${stock_initial}, '${esc(lot)}', '${esc(lot_frs)}', '${esc(emplacement)}', '${esc(date_entree)}', '${esc(commentaire)}', ${parseInt(String(niveau), 10) || 1}, 0, 0)`
      : `INSERT INTO stock_fil (IDfournisseur, IDref_fil, IDcolori_fil, stock, stock_initial, lot, lot_frs, emplacement, date_entree, commentaire, niveau) VALUES (${IDfournisseur}, ${IDref_fil}, ${IDcolori_fil}, ${stock_initial}, ${stock_initial}, '${esc(lot)}', '${esc(lot_frs)}', '${esc(emplacement)}', '${esc(date_entree)}', '${esc(commentaire)}', ${parseInt(String(niveau), 10) || 1})`
    await query(insertSql)

    // HFSQL does not support RETURNING — fetch the newly inserted row by max ID
    const newRows = await query<{ IDstock_fil: number }>(
      `SELECT IDstock_fil FROM stock_fil WHERE IDfournisseur = ${IDfournisseur} AND IDref_fil = ${IDref_fil} AND IDcolori_fil = ${IDcolori_fil} ORDER BY IDstock_fil DESC`
    )
    const newId = newRows[0]?.IDstock_fil ?? null

    res.status(201).json({ IDstock_fil: newId })
  } catch (err) {
    console.error('Error creating stock_fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/stock/fil/:id - Light edit (whitelisted fields only)
//
// NOTE: the terminé and controlé fields cannot currently be updated via this
// endpoint on Linux because the HFSQL bridge rejects accented column names in
// UPDATE SET clauses. Users must mark lots as terminated via the legacy
// WinDev app until the bridge is extended to support this.
stockRouter.patch('/fil/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }

    const body = req.body ?? {}
    const sets: string[] = []
    const skipped: string[] = []

    if (typeof body.commentaire === 'string') sets.push(`commentaire = '${esc(body.commentaire)}'`)
    if (typeof body.observation_freinte === 'string') sets.push(`observation_freinte = '${esc(body.observation_freinte)}'`)
    if (typeof body.emplacement === 'string') sets.push(`emplacement = '${esc(body.emplacement)}'`)
    if (typeof body.niveau === 'number') sets.push(`niveau = ${parseInt(String(body.niveau), 10)}`)
    if (body.termine !== undefined) {
      if (IS_WINDOWS) sets.push(`terminé = ${body.termine ? 1 : 0}`)
      else skipped.push('termine')
    }
    if (body.controle !== undefined) {
      if (IS_WINDOWS) sets.push(`controlé = ${body.controle ? 1 : 0}`)
      else skipped.push('controle')
    }
    if (typeof body.dernier_pointage === 'string') {
      const d = body.dernier_pointage
      if (d === '') {
        sets.push(`dernier_pointage = NULL`)
      } else {
        sets.push(`dernier_pointage = '${esc(d)}'`)
      }
    }

    if (sets.length === 0) {
      res.status(400).json({
        error:
          skipped.length > 0
            ? `Fields ${skipped.join(', ')} are not supported via the web API on Linux — edit via the legacy app`
            : 'No editable fields provided',
      })
      return
    }

    await query(`UPDATE stock_fil SET ${sets.join(', ')} WHERE IDstock_fil = ${id}`)

    // Fetch fresh row in the same shape as GET /fil/:id
    const rows = await query<StockFil>(
      `SELECT ${STOCK_SELECT} ${STOCK_JOINS} WHERE sf.IDstock_fil = ${id}`
    )
    let fixed: StockFil[] = await fixEncoding(
      rows,
      'stock_fil',
      'IDstock_fil',
      ['lot', 'lot_frs', 'emplacement', 'commentaire', 'observation_freinte']
    )
    fixed = await repairAliased(fixed, 'ref_fil', 'IDref_fil', { ref_fil: 'reference' })
    fixed = await repairAliased(fixed, 'colori_fil', 'IDcolori_fil', { colori_reference: 'reference' })
    fixed = await repairAliased(fixed, 'fournisseur', 'IDfournisseur', { fournisseur_nom: 'nom' })

    const recycleMap = await loadRefFilRecycleMap()
    const normalised = normalizeStockRow(fixed[0] as Record<string, unknown>, recycleMap)

    res.json({ ...normalised, _skipped: skipped.length > 0 ? skipped : undefined })
  } catch (err) {
    console.error('Error updating stock_fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/fil/:id/certif/:type - Serve bio or recycle certificate blob
stockRouter.get('/fil/:id/certif/:type', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const type = req.params.type
    if (type !== 'bio' && type !== 'recycle') { res.status(400).json({ error: 'Invalid type' }); return }

    // For 'bio' we can reference certif_bio directly (no accent). For 'recycle'
    // the column is certif_recyclé — on Linux the bridge can't parse the
    // accented identifier, so fall back to SELECT * and pick the mangled key.
    let fichier: unknown = null
    if (type === 'bio') {
      const rows = await queryRaw(`SELECT certif_bio AS f FROM stock_fil WHERE IDstock_fil = ${id}`)
      if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return }
      fichier = rows[0].f
    } else if (IS_WINDOWS) {
      const rows = await queryRaw(`SELECT certif_recyclé AS f FROM stock_fil WHERE IDstock_fil = ${id}`)
      if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return }
      fichier = rows[0].f
    } else {
      const rows = await queryRaw(`SELECT * FROM stock_fil WHERE IDstock_fil = ${id}`)
      if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return }
      fichier = pickVal(rows[0], /^certif_recycl/i)
    }

    if (fichier == null) { res.status(404).json({ error: 'No document' }); return }

    let buf: Buffer
    if (fichier instanceof ArrayBuffer) buf = Buffer.from(fichier)
    else if (Buffer.isBuffer(fichier)) buf = fichier
    else { res.status(404).json({ error: 'No document' }); return }

    if (buf.length === 0 || (buf.length === 1 && buf[0] === 0)) {
      res.status(404).json({ error: 'No document' })
      return
    }

    let contentType = 'application/octet-stream'
    if (buf.length >= 4) {
      const head = buf.subarray(0, 4)
      if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) contentType = 'application/pdf'
      else if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) contentType = 'image/png'
      else if (head[0] === 0xFF && head[1] === 0xD8) contentType = 'image/jpeg'
    }

    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', 'inline')
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.end(buf)
  } catch (err) {
    console.error('Error serving stock certif:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * Repair aliased text fields that came from a joined table.
 * For each row whose alias contains U+FFFD, run a targeted CONVERT() against
 * the source table+column.
 */
async function repairAliased<T extends Record<string, unknown>>(
  rows: T[],
  table: string,
  idField: string,
  aliasMap: Record<string, string>
): Promise<T[]> {
  const aliasNames = Object.keys(aliasMap)
  const out: T[] = []
  for (const row of rows) {
    const needsFix = aliasNames.some((alias) => {
      const v = row[alias]
      return typeof v === 'string' && v.includes('\ufffd')
    })
    if (!needsFix) {
      out.push(row)
      continue
    }
    const id = row[idField]
    if (id == null) {
      out.push(row)
      continue
    }
    const fixed = { ...row }
    for (const alias of aliasNames) {
      const v = row[alias]
      if (typeof v === 'string' && v.includes('\ufffd')) {
        const sourceCol = aliasMap[alias]
        try {
          const r = await query<{ v: unknown }>(
            `SELECT CONVERT(${sourceCol} USING 'UTF-8') AS v FROM ${table} WHERE ${idField} = ${Number(id)}`
          )
          if (r.length > 0 && r[0].v != null) {
            const val = r[0].v
            ;(fixed as Record<string, unknown>)[alias] =
              val instanceof ArrayBuffer ? Buffer.from(val).toString('utf8') : val
          }
        } catch {
          // keep original
        }
      }
    }
    out.push(fixed)
  }
  return out
}
