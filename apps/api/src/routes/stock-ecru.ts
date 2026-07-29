import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { repairAliased, resolveSstLine, resolveProvenanceFils } from './stock-fini.js'
import { userHasPermission } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'

export const stockEcruRouter: RouterType = Router()

type StockEcru = Record<string, unknown>

/** Escape a string for use in SQL (single quotes doubled). */
function esc(value: string): string {
  return value.replace(/'/g, "''")
}

const IS_WINDOWS = process.platform === 'win32'

/** ref_ecru.archivé is accented — on Linux SELECT * returns a mangled key. */
function isArchive(row: Record<string, unknown>): boolean {
  const v = row.archivé ?? row.archiv ?? 0
  return Number(v) === 1
}

/** Emit a text value as a bridge-safe SQL literal: plain quoted for ASCII,
 *  Latin-1 hex literal for accented text (raw multi-byte UTF-8 in a SQL
 *  string corrupts the Linux bridge → [HY090]). Ported from stock-fini.ts. */
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

// stock_ecru and the tables we join (ref_ecru, colori_ecru, sous_traitant) have
// NO accented columns in the fields we read, so the IS_WINDOWS branching from
// stock.ts is not needed on the base query — every selected column name is
// ASCII. Accented *values* in numero/lot/observations/visiteur and the joined
// labels are repaired afterwards via repairAliased (batched CONVERT).
const STOCK_ECRU_SELECT = `se.IDstock_ecru, se.IDref_ecru, se.IDcolori_ecru, se.IDmagasin, se.IDordre_fabrication, se.IDref_commande_source, se.IDref_commande_affectation, se.IDligne_commande_client, se.poids, se.metrage, se.lot, se.numero, se.observations, se.visiteur, se.second_choix, se.date_saisie, re.reference AS ref_ecru, ce.reference AS coloris_reference, st.nom AS magasin_nom`

const STOCK_ECRU_JOINS = `FROM stock_ecru se LEFT JOIN ref_ecru re ON se.IDref_ecru = re.IDref_ecru LEFT JOIN colori_ecru ce ON se.IDcolori_ecru = ce.IDcolori_ecru LEFT JOIN sous_traitant st ON se.IDmagasin = st.IDsous_traitant`

const TEXT_FIELDS = ['numero', 'lot', 'observations', 'visiteur']

export interface DefautQualite {
  IDdefaut_qualite: number
  description: string | null
  type_defaut: string | null
  taille_cm: number | null
}

/** Build the per-roll défauts summary string shown in the table column:
 *  "Maille 200 cm; Trou" etc. Each defect is `type_defaut [taille cm]`, falling
 *  back to its free-text description when there's no structured type. */
export function defautSummary(defects: DefautQualite[]): string {
  return defects
    .map((d) => {
      const type = (d.type_defaut ?? '').toString().trim()
      const size = d.taille_cm != null && Number(d.taille_cm) > 0 ? `${Number(d.taille_cm)} cm` : ''
      const head = [type, size].filter(Boolean).join(' ')
      return head || (d.description ?? '').toString().trim()
    })
    .filter(Boolean)
    .join('; ')
}

/** Fetch structured defects for a set of écru rolls. `defaut_qualite` is
 *  polymorphic: Type_Reference=2 with reference (string) = stringified
 *  IDstock_ecru (pattern: commandes-sous-traitant.ts). Returns a Map keyed by
 *  IDstock_ecru. */
export async function fetchDefectsByEcru(ecruIds: number[]): Promise<Map<number, DefautQualite[]>> {
  const out = new Map<number, DefautQualite[]>()
  const ids = Array.from(new Set(ecruIds.filter((x) => Number.isInteger(x) && x > 0)))
  if (ids.length === 0) return out
  const inList = ids.map((x) => `'${x}'`).join(',')
  const rows = await query<{
    IDdefaut_qualite: number
    reference: string | null
    description: string | null
    type_defaut: string | null
    taille_cm: number | null
  }>(
    `SELECT IDdefaut_qualite, reference, description, type_defaut, taille_cm
     FROM defaut_qualite
     WHERE Type_Reference = 2 AND reference IN (${inList})`,
  )
  const fixed = await fixEncoding(rows, 'defaut_qualite', 'IDdefaut_qualite', ['description', 'type_defaut'])
  for (const d of fixed as any[]) {
    const ecruId = parseInt(String(d.reference ?? ''), 10)
    if (!Number.isInteger(ecruId)) continue
    const arr = out.get(ecruId) ?? []
    arr.push({
      IDdefaut_qualite: Number(d.IDdefaut_qualite),
      description: d.description ?? null,
      type_defaut: d.type_defaut ?? null,
      taille_cm: d.taille_cm == null ? null : Number(d.taille_cm),
    })
    out.set(ecruId, arr)
  }
  return out
}

interface ClientReservation {
  commande_numero: string | null
  client_nom: string | null
}

/** Resolve a set of IDligne_commande_client → { N° commande, client name } via
 *  the flat chain ligne_commande_client → commande_client → client. Flat
 *  queries only (a JOIN + CONVERT collapses the result set on the Linux bridge
 *  — see CLAUDE.md). Returns a Map keyed by IDligne_commande_client; missing /
 *  empty links are simply absent. */
async function resolveClientReservations(lccIds: number[]): Promise<Map<number, ClientReservation>> {
  const out = new Map<number, ClientReservation>()
  const ids = Array.from(new Set(lccIds.filter((x) => Number.isInteger(x) && x > 0)))
  if (ids.length === 0) return out

  const lccRows = await query<{ IDligne_commande_client: number; IDcommande_client: number }>(
    `SELECT IDligne_commande_client, IDcommande_client FROM ligne_commande_client WHERE IDligne_commande_client IN (${ids.join(',')})`,
  )
  const lccToCc = new Map<number, number>()
  for (const r of lccRows) lccToCc.set(Number(r.IDligne_commande_client), Number(r.IDcommande_client) || 0)

  const ccIds = Array.from(new Set(Array.from(lccToCc.values()))).filter((x) => x > 0)
  const ccInfo = new Map<number, { numero: string | null; IDclient: number }>()
  if (ccIds.length > 0) {
    const ccRows = await query<{ IDcommande_client: number; IDclient: number; numero: string | null }>(
      `SELECT IDcommande_client, IDclient, numero FROM commande_client WHERE IDcommande_client IN (${ccIds.join(',')})`,
    )
    for (const r of ccRows) {
      ccInfo.set(Number(r.IDcommande_client), {
        numero: (r.numero ?? null) as string | null,
        IDclient: Number(r.IDclient) || 0,
      })
    }
  }

  const clientIds = Array.from(new Set(Array.from(ccInfo.values()).map((c) => c.IDclient))).filter((x) => x > 0)
  const clientName = new Map<number, string>()
  if (clientIds.length > 0) {
    const cRows = await query<{ IDclient: number; nom: string | null }>(
      `SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`,
    )
    const fixedC = (await fixEncoding(cRows, 'client', 'IDclient', ['nom'])) as any[]
    for (const r of fixedC) clientName.set(Number(r.IDclient), (r.nom ?? '').toString().trim())
  }

  for (const [lccId, ccId] of lccToCc) {
    const cc = ccInfo.get(ccId)
    if (!cc) continue
    const numero = (cc.numero ?? '').toString().trim() || null
    const nom = clientName.get(cc.IDclient) || null
    if (numero || nom) out.set(lccId, { commande_numero: numero, client_nom: nom })
  }
  return out
}

/** Repair the base text columns + joined labels for a batch of écru rows, then
 *  attach the resolved client reservation (N° commande + client) and the
 *  défauts summary. Shared by the list and detail endpoints. */
async function hydrateEcruRows(rows: StockEcru[]): Promise<StockEcru[]> {
  let fixed = await repairAliased(rows, 'stock_ecru', 'IDstock_ecru', {
    numero: 'numero',
    lot: 'lot',
    observations: 'observations',
    visiteur: 'visiteur',
  })
  fixed = await repairAliased(fixed, 'ref_ecru', 'IDref_ecru', { ref_ecru: 'reference' })
  fixed = await repairAliased(fixed, 'colori_ecru', 'IDcolori_ecru', { coloris_reference: 'reference' })
  fixed = await repairAliased(fixed, 'sous_traitant', 'IDmagasin', { magasin_nom: 'nom' }, 'IDsous_traitant')

  const lccIds = fixed.map((r) => Number((r as any).IDligne_commande_client) || 0)
  const reservations = await resolveClientReservations(lccIds)
  const ecruIds = fixed.map((r) => Number((r as any).IDstock_ecru) || 0)
  const defectsByEcru = await fetchDefectsByEcru(ecruIds)

  for (const r of fixed as any[]) {
    const lccId = Number(r.IDligne_commande_client) || 0
    const resv = lccId > 0 ? reservations.get(lccId) : undefined
    r.commande_numero = resv?.commande_numero ?? null
    r.client_nom = resv?.client_nom ?? null
    const defects = defectsByEcru.get(Number(r.IDstock_ecru) || 0) ?? []
    r.defects = defects
    r.defauts = defautSummary(defects)
  }
  return fixed
}

// GET /api/stock/ecru - list écru (tombé de métier) rolls with joined display
//   columns + client reservation + défauts.
//     ?statut=disponible | teinture | tous   (default disponible)
//        disponible → not affected to an ennoblisseur (dyeing) line
//        teinture   → affected to a dyeing line (IDref_commande_affectation > 0)
//        tous       → no affectation filter
//     ?second_choix=1   → only second-choix rolls
//     ?q=<text>         → optional server-side fuzzy filter (the frontend
//                         filters client-side; kept for completeness)
stockEcruRouter.get('/ecru', async (req: Request, res: Response) => {
  try {
    const statut = typeof req.query.statut === 'string' ? req.query.statut : 'disponible'
    const onlySecond = req.query.second_choix === '1'
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''

    // Base population = ETM écru rolls currently physically in stock:
    //   IDsociete = 1             → ETM only (TRM rolls belong to the sister
    //                               company; the legacy ETM screen never shows them)
    //   IDligne_expedition_ETM = 0 → not yet shipped out from ETM
    //   no stock_fini child        → not yet dyed/consumed into a finished roll
    // This bounds the view to the live working set (~1.5k rolls) matching the
    // legacy "Disponible / En teinture / Tous" screen. Without it, "Tous" would
    // return ~45k historical rows and the client-chain + défauts hydration would
    // time out. (IDligne_expedition_TRM is NOT a stock signal — it records the
    // TRM→ETM provenance, so most in-stock rolls carry it.)
    // HFSQL stores "no FK" as 0 (not NULL) — guard both.
    const where: string[] = [
      'se.IDsociete = 1',
      '(se.IDligne_expedition_ETM = 0 OR se.IDligne_expedition_ETM IS NULL)',
      'NOT EXISTS (SELECT 1 FROM stock_fini sf WHERE sf.IDstock_ecru = se.IDstock_ecru)',
    ]
    if (statut === 'disponible') {
      where.push(`(se.IDref_commande_affectation IS NULL OR se.IDref_commande_affectation = 0)`)
      // Rolls reserved to a donation commande client are already assigned —
      // they are not disponible (still visible under "tous").
      where.push(`(se.IDcommande_donation IS NULL OR se.IDcommande_donation = 0)`)
    } else if (statut === 'teinture') {
      where.push(`se.IDref_commande_affectation > 0`)
    }
    if (onlySecond) where.push(`se.second_choix = 1`)
    if (q) {
      const e = esc(q)
      where.push(
        `(se.lot LIKE '%${e}%' OR se.numero LIKE '%${e}%' OR se.observations LIKE '%${e}%' OR se.visiteur LIKE '%${e}%' OR re.reference LIKE '%${e}%' OR ce.reference LIKE '%${e}%')`,
      )
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const sql = `SELECT ${STOCK_ECRU_SELECT} ${STOCK_ECRU_JOINS} ${whereSql} ORDER BY se.date_saisie DESC, se.IDstock_ecru DESC`
    const rows = await query<StockEcru>(sql)
    const hydrated = await hydrateEcruRows(rows)
    res.json(hydrated)
  } catch (err) {
    console.error('Error fetching stock_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/ecru/lookups/refs - ref_ecru list for the "Nouveau" form.
stockEcruRouter.get('/ecru/lookups/refs', async (_req: Request, res: Response) => {
  try {
    // ref_ecru.archivé is accented: name it only on Windows; on Linux SELECT *
    // and filter in JS (naming the accented column storms the bridge).
    const sql = IS_WINDOWS
      ? `SELECT IDref_ecru, reference, designation FROM ref_ecru WHERE archivé = 0 ORDER BY reference`
      : `SELECT * FROM ref_ecru ORDER BY reference`
    const rows = await query<Record<string, unknown>>(sql)
    const visible = IS_WINDOWS ? rows : rows.filter((r) => !isArchive(r))
    const shaped = visible.map((r) => ({
      IDref_ecru: Number(r.IDref_ecru),
      reference: (r.reference ?? null) as string | null,
      designation: (r.designation ?? null) as string | null,
    }))
    const fixed = (await fixEncoding(shaped, 'ref_ecru', 'IDref_ecru', ['reference', 'designation'])) as any[]
    res.json(fixed.filter((r) => r.reference && String(r.reference).trim().length > 0))
  } catch (err) {
    console.error('Error fetching refs-ecru lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/ecru/lookups/coloris?ref_ecru=X - colori_ecru options for a ref.
//   colori_ecru cannot be read via SELECT * (returns 0 rows) — explicit columns.
stockEcruRouter.get('/ecru/lookups/coloris', async (req: Request, res: Response) => {
  try {
    const refEcru = parseInt(String(req.query.ref_ecru ?? ''), 10)
    if (isNaN(refEcru) || refEcru <= 0) { res.json([]); return }
    const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(
      `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDref_ecru = ${refEcru} ORDER BY reference`,
    )
    const fixed = (await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference'])) as any[]
    res.json(
      fixed
        .filter((r) => r.reference && String(r.reference).trim().length > 0)
        .map((r) => ({ id: Number(r.IDcolori_ecru), reference: r.reference })),
    )
  } catch (err) {
    console.error('Error fetching coloris-ecru lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/ecru/lookups/magasins - sous_traitant rows used as depots
//   (stock_ecru.IDmagasin → sous_traitant).
stockEcruRouter.get('/ecru/lookups/magasins', async (_req: Request, res: Response) => {
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

// POST /api/stock/ecru - manually create an écru roll. Gated by the
//   create_stock_ecru permission (effective admins bypass). Écru rolls are
//   normally created by the tricoteur reception flow; this is the rare manual
//   entry. Column set mirrors the reception INSERT (commandes-sous-traitant.ts)
//   plus visiteur — every named column is known to exist (naming a phantom
//   column storms the Linux bridge). Empty text → '' (never NULL).
// ── GET /api/stock/ecru/suivi?numero=3397/30 ─────────────────────────
// "Suivi Pièce" — port of the legacy FI_Suivi_pièce.wdw dashboard panel: type a
// piece number and get its life story, écru → transferts → fini.
//
// MUST stay declared before '/ecru/:id' or "suivi" is captured as an id.
//
// Field mapping validated against the legacy screen for piece 3397/30:
//  • `stock_ecru.IDref_commande_source` / `IDref_commande_affectation` hold a
//    ligne_commande_sous_traitant id, NOT a commande id. Legacy prints the
//    parent commande ("Commande source : 8461 - Tricotage Malterre" — the piece
//    stores ligne 8437, whose commande is 8461), so both are resolved up.
//  • Transfers come from `piece_transfert` (IDpiece_ecru / IDpiece_fini) joined
//    to `bon_transfert`; legacy's "Transfert n° 4165 le 03/03/2026" is the bon's
//    own id and its DATE (a reserved word — always alias it).
//
// A numero is NOT unique in stock_ecru (dev data has 903 rows numbered
// "fictif"), and fini rolls carry their own numero — including the `-1`/`-2`
// suffixes a cut roll gets. So the search covers both tables and returns every
// match rather than pretending there is exactly one.
const SUIVI_MAX_PIECES = 20

interface SuiviCommandeRef {
  commande: number
  sous_traitant: string | null
  date_commande: string | null
}

/** Resolve ligne_commande_sous_traitant ids → their commande, sous-traitant
 *  and order date. */
async function resolveSstCommandes(lineIds: number[]): Promise<Map<number, SuiviCommandeRef>> {
  const out = new Map<number, SuiviCommandeRef>()
  const ids = Array.from(new Set(lineIds.filter((x) => Number.isInteger(x) && x > 0)))
  if (ids.length === 0) return out
  const lignes = await query<{ IDligne_commande_sous_traitant: number; IDcommande_sous_traitant: number }>(
    `SELECT IDligne_commande_sous_traitant, IDcommande_sous_traitant
     FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant IN (${ids.join(',')})`,
  )
  const cmdIds = Array.from(new Set(lignes.map((l) => Number(l.IDcommande_sous_traitant)).filter((x) => x > 0)))
  const cmdSst = new Map<number, number>()
  const cmdDate = new Map<number, string | null>()
  if (cmdIds.length > 0) {
    const cmds = await query<{
      IDcommande_sous_traitant: number; IDsous_traitant: number; date_commande: string | null
    }>(
      `SELECT IDcommande_sous_traitant, IDsous_traitant, date_commande FROM commande_sous_traitant
       WHERE IDcommande_sous_traitant IN (${cmdIds.join(',')})`,
    )
    for (const c of cmds) {
      cmdSst.set(Number(c.IDcommande_sous_traitant), Number(c.IDsous_traitant) || 0)
      cmdDate.set(Number(c.IDcommande_sous_traitant), (c.date_commande ?? null) as string | null)
    }
  }
  const names = await resolveSstNames([...cmdSst.values()])
  for (const l of lignes) {
    const cmd = Number(l.IDcommande_sous_traitant) || 0
    out.set(Number(l.IDligne_commande_sous_traitant), {
      commande: cmd,
      sous_traitant: cmd ? (names.get(cmdSst.get(cmd) ?? 0) ?? null) : null,
      date_commande: cmd ? (cmdDate.get(cmd) ?? null) : null,
    })
  }
  return out
}

/** sous_traitant names, batched. Flat query + fixEncoding — a JOIN carrying
 *  CONVERT() collapses the result set on the bridge (CLAUDE.md HFSQL rules). */
async function resolveSstNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)))
  if (u.length === 0) return out
  const rows = await query<{ IDsous_traitant: number; nom: string | null }>(
    `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${u.join(',')})`,
  )
  for (const r of await fixEncoding(rows as any[], 'sous_traitant', 'IDsous_traitant', ['nom'])) {
    out.set(Number((r as any).IDsous_traitant), ((r as any).nom ?? '').toString().trim())
  }
  return out
}

/** Magasin 0 is the company's own stock — it has no sous_traitant row.
 *  Labelled as the Transferts screen labels it (routes/transferts.ts), which is
 *  deliberately NOT what the legacy Suivi Pièce printed there ("Tricotage
 *  Malterre"): one label for magasin 0 across MPS_NG beats reproducing a
 *  per-screen inconsistency. */
const SUIVI_MAGASIN_ZERO = 'Ets Malterre'
function suiviMagasin(id: number, names: Map<number, string>): string {
  return id === 0 ? SUIVI_MAGASIN_ZERO : (names.get(id) || `Magasin #${id}`)
}

export interface SuiviExpedition {
  IDexpedition: number
  date: string | null
  /** Who shipped it — derived from `expedition.IDsociete`. An écru piece
   *  knitted by the sister company ships TRM → ETM, and reading only the
   *  recipient ("Ets Malterre") makes that leg look like it went nowhere. */
  expediteur: string
  /** Who received it: the client of the expédition's commande. */
  client: string | null
  commande_numero: number | null
  IDsociete: number
}

/** The three companies sharing the base, keyed by IDsociete (CLAUDE.md
 *  §IDsociete partitioning). Used to name the sender of an expédition. */
const SOCIETE_NOMS: Record<number, string> = {
  1: 'Ets Malterre',
  2: 'Tricotage Malterre',
  3: 'Confection',
}

/** ligne_expedition ids → their expédition, with the client it went to.
 *  `expedition.DATE` is a reserved word (alias it) and `envoyé_client` /
 *  `envoyé_sst` are accented — never name them; select the ASCII columns only. */
async function resolveExpeditions(ligneIds: number[]): Promise<Map<number, SuiviExpedition>> {
  const out = new Map<number, SuiviExpedition>()
  const ids = Array.from(new Set(ligneIds.filter((x) => Number.isInteger(x) && x > 0)))
  if (ids.length === 0) return out

  const lignes = await query<{ IDligne_expedition: number; IDexpedition: number }>(
    `SELECT IDligne_expedition, IDexpedition FROM ligne_expedition
     WHERE IDligne_expedition IN (${ids.join(',')})`,
  )
  const expIds = Array.from(new Set(lignes.map((l) => Number(l.IDexpedition)).filter((x) => x > 0)))
  if (expIds.length === 0) return out

  const exps = await query<{
    IDexpedition: number; IDcommande_client: number; dexp: string | null; IDsociete: number
  }>(
    `SELECT IDexpedition, IDcommande_client, DATE AS dexp, IDsociete FROM expedition
     WHERE IDexpedition IN (${expIds.join(',')})`,
  )
  const cmdIds = Array.from(new Set(exps.map((e) => Number(e.IDcommande_client)).filter((x) => x > 0)))
  const cmdInfo = new Map<number, { numero: number | null; IDclient: number }>()
  if (cmdIds.length > 0) {
    // commande_client carries accented columns (archivé, expedié, envoyé_client)
    // — name only the ASCII ones.
    const cmds = await query<{ IDcommande_client: number; IDclient: number; numero: number | null }>(
      `SELECT IDcommande_client, IDclient, numero FROM commande_client
       WHERE IDcommande_client IN (${cmdIds.join(',')})`,
    )
    for (const c of cmds) {
      cmdInfo.set(Number(c.IDcommande_client), {
        numero: c.numero == null ? null : Number(c.numero),
        IDclient: Number(c.IDclient) || 0,
      })
    }
  }
  const clientNames = new Map<number, string>()
  const clientIds = Array.from(new Set([...cmdInfo.values()].map((c) => c.IDclient).filter((x) => x > 0)))
  if (clientIds.length > 0) {
    const rows = await query<{ IDclient: number; nom: string | null }>(
      `SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`,
    )
    for (const r of await fixEncoding(rows as any[], 'client', 'IDclient', ['nom'])) {
      clientNames.set(Number((r as any).IDclient), ((r as any).nom ?? '').toString().trim())
    }
  }

  const byExp = new Map<number, SuiviExpedition>()
  for (const e of exps) {
    const info = cmdInfo.get(Number(e.IDcommande_client))
    const societe = Number(e.IDsociete) || 0
    byExp.set(Number(e.IDexpedition), {
      IDexpedition: Number(e.IDexpedition),
      date: (e.dexp ?? null) as string | null,
      expediteur: SOCIETE_NOMS[societe] ?? SOCIETE_NOMS[1],
      client: info ? (clientNames.get(info.IDclient) ?? null) : null,
      commande_numero: info?.numero ?? null,
      IDsociete: societe,
    })
  }
  for (const l of lignes) {
    const exp = byExp.get(Number(l.IDexpedition))
    if (exp) out.set(Number(l.IDligne_expedition), exp)
  }
  return out
}

export interface SuiviFil {
  reference: string
  coloris: string
  pourcentage: number | null
  lot: string
  fournisseur: string | null
  /** The purchase order this lot arrived on — absent on older stock. */
  commande_fil: number | null
  date_commande: string | null
  date_livraison: string | null
}

/** The yarns an écru piece was knitted from.
 *
 *  The link is the ORDRE DE FABRICATION (`asso_fil_of`), not the tricoteur
 *  order line: `asso_fil_lignecmdsst` is about what was *sent* to a knitter and
 *  is empty for in-house production, whereas `asso_fil_of` records what the
 *  machine actually consumed — including the percentage of each yarn. */
async function resolveFilsForOf(ofId: number): Promise<SuiviFil[]> {
  if (!Number.isInteger(ofId) || ofId <= 0) return []
  const asso = await query<{
    IDref_fil: number; IDcolori_fil: number; IDstock_fil: number; pourcentage: number | null
  }>(
    `SELECT IDref_fil, IDcolori_fil, IDstock_fil, pourcentage FROM asso_fil_of
     WHERE IDordre_fabrication = ${ofId}`,
  )
  if (asso.length === 0) return []

  // stock_fil must never be read with SELECT * nor with certif_bio in the list —
  // both silently return 0 rows on Windows (project-stock-fil-poisoned-select).
  const stockIds = Array.from(new Set(asso.map((a) => Number(a.IDstock_fil)).filter((x) => x > 0)))
  const lots = new Map<number, { lot: string; IDfournisseur: number; IDref_fil_commande: number }>()
  if (stockIds.length > 0) {
    const rows = await query<{
      IDstock_fil: number; lot: string | null; IDfournisseur: number; IDref_fil_commande: number
    }>(
      `SELECT IDstock_fil, lot, IDfournisseur, IDref_fil_commande FROM stock_fil
       WHERE IDstock_fil IN (${stockIds.join(',')})`,
    )
    for (const r of await fixEncoding(rows as any[], 'stock_fil', 'IDstock_fil', ['lot'])) {
      lots.set(Number((r as any).IDstock_fil), {
        lot: ((r as any).lot ?? '').toString().trim(),
        IDfournisseur: Number((r as any).IDfournisseur) || 0,
        IDref_fil_commande: Number((r as any).IDref_fil_commande) || 0,
      })
    }
  }

  // Purchase order behind each lot: ref_fil_commande → commande_fil.
  const lineIds = Array.from(new Set([...lots.values()].map((l) => l.IDref_fil_commande).filter((x) => x > 0)))
  const orderByLine = new Map<number, { cmd: number; date_livraison: string | null }>()
  const cmdDate = new Map<number, string | null>()
  if (lineIds.length > 0) {
    const rfc = await query<{ IDref_fil_commande: number; IDcommande_fil: number; date_livraison: string | null }>(
      `SELECT IDref_fil_commande, IDcommande_fil, date_livraison FROM ref_fil_commande
       WHERE IDref_fil_commande IN (${lineIds.join(',')})`,
    )
    for (const r of rfc) {
      orderByLine.set(Number(r.IDref_fil_commande), {
        cmd: Number(r.IDcommande_fil) || 0,
        date_livraison: (r.date_livraison ?? null) as string | null,
      })
    }
    const cmdIds = Array.from(new Set([...orderByLine.values()].map((o) => o.cmd).filter((x) => x > 0)))
    if (cmdIds.length > 0) {
      const cf = await query<{ IDcommande_fil: number; date_commande: string | null }>(
        `SELECT IDcommande_fil, date_commande FROM commande_fil WHERE IDcommande_fil IN (${cmdIds.join(',')})`,
      )
      for (const c of cf) cmdDate.set(Number(c.IDcommande_fil), (c.date_commande ?? null) as string | null)
    }
  }

  // Labels
  const refNames = new Map<number, string>()
  const refIds = Array.from(new Set(asso.map((a) => Number(a.IDref_fil)).filter((x) => x > 0)))
  if (refIds.length > 0) {
    const rows = await query<any>(`SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${refIds.join(',')})`)
    for (const r of await fixEncoding(rows, 'ref_fil', 'IDref_fil', ['reference'])) {
      refNames.set(Number((r as any).IDref_fil), ((r as any).reference ?? '').toString().trim())
    }
  }
  const coloriNames = new Map<number, string>()
  const coloriIds = Array.from(new Set(asso.map((a) => Number(a.IDcolori_fil)).filter((x) => x > 0)))
  if (coloriIds.length > 0) {
    const rows = await query<any>(
      `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${coloriIds.join(',')})`)
    for (const r of await fixEncoding(rows, 'colori_fil', 'IDcolori_fil', ['reference'])) {
      coloriNames.set(Number((r as any).IDcolori_fil), ((r as any).reference ?? '').toString().trim())
    }
  }
  const frsNames = new Map<number, string>()
  const frsIds = Array.from(new Set([...lots.values()].map((l) => l.IDfournisseur).filter((x) => x > 0)))
  if (frsIds.length > 0) {
    const rows = await query<any>(
      `SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur IN (${frsIds.join(',')})`)
    for (const r of await fixEncoding(rows, 'fournisseur', 'IDfournisseur', ['nom'])) {
      frsNames.set(Number((r as any).IDfournisseur), ((r as any).nom ?? '').toString().trim())
    }
  }

  return asso
    .map((a) => {
      const lot = lots.get(Number(a.IDstock_fil))
      const order = lot ? orderByLine.get(lot.IDref_fil_commande) : undefined
      return {
        reference: refNames.get(Number(a.IDref_fil)) ?? '',
        coloris: coloriNames.get(Number(a.IDcolori_fil)) ?? '',
        pourcentage: a.pourcentage == null ? null : Number(a.pourcentage),
        lot: lot?.lot ?? '',
        fournisseur: lot ? (frsNames.get(lot.IDfournisseur) ?? null) : null,
        commande_fil: order?.cmd || null,
        date_commande: order ? (cmdDate.get(order.cmd) ?? null) : null,
        date_livraison: order?.date_livraison ?? null,
      }
    })
    .sort((a, b) => (b.pourcentage ?? 0) - (a.pourcentage ?? 0))
}

stockEcruRouter.get('/ecru/suivi', async (req: Request, res: Response) => {
  const numero = String(req.query.numero ?? '').trim()
  if (numero === '') { res.status(400).json({ error: 'numero query parameter required' }); return }

  try {
    const q = esc(numero)

    // ── 1. Écru pieces carrying this number ──
    const ecruRows = await query<Record<string, unknown>>(
      `SELECT TOP ${SUIVI_MAX_PIECES} IDstock_ecru, numero, lot, poids, metrage, IDref_ecru, IDcolori_ecru,
              IDmagasin, IDref_commande_source, IDref_commande_affectation, IDligne_commande_client,
              IDordre_fabrication, IDligne_expedition_ETM, IDligne_expedition_TRM,
              observations, second_choix, IDsociete, date_saisie
       FROM stock_ecru WHERE numero = '${q}' ORDER BY IDstock_ecru DESC`,
    )

    // ── 2. Fini rolls carrying it, so a cut roll ("3417/57-2") finds its écru ──
    const finiByNumero = await query<Record<string, unknown>>(
      `SELECT TOP ${SUIVI_MAX_PIECES} IDstock_fini, IDstock_ecru FROM stock_fini
       WHERE numero = '${q}' ORDER BY IDstock_fini DESC`,
    )
    const ecruIds = ecruRows.map((r) => Number(r.IDstock_ecru))
    const extraEcruIds = Array.from(new Set(
      finiByNumero.map((r) => Number(r.IDstock_ecru)).filter((x) => x > 0 && !ecruIds.includes(x)),
    ))
    if (extraEcruIds.length > 0) {
      const more = await query<Record<string, unknown>>(
        `SELECT IDstock_ecru, numero, lot, poids, metrage, IDref_ecru, IDcolori_ecru,
                IDmagasin, IDref_commande_source, IDref_commande_affectation, IDligne_commande_client,
                IDordre_fabrication, IDligne_expedition_ETM, IDligne_expedition_TRM,
                observations, second_choix, IDsociete, date_saisie
         FROM stock_ecru WHERE IDstock_ecru IN (${extraEcruIds.join(',')})`,
      )
      ecruRows.push(...more)
    }

    if (ecruRows.length === 0) {
      res.json({ numero, pieces: [], truncated: false })
      return
    }
    const allEcruIds = ecruRows.map((r) => Number(r.IDstock_ecru))

    // ── 3. Fini rolls born from those écru pieces ──
    const finiRows = await query<Record<string, unknown>>(
      `SELECT IDstock_fini, IDstock_ecru, IDref_fini, IDColoris, lot, numero, poids, metrage,
              IDmagasin, IDref_commande_source, IDetat_stock_fini,
              IDligne_expedition, IDligne_commande_client,
              observations, observation_sst, second_choix
       FROM stock_fini WHERE IDstock_ecru IN (${allEcruIds.join(',')}) ORDER BY IDstock_fini`,
    )
    const finiIds = finiRows.map((r) => Number(r.IDstock_fini))

    // ── 4. Transfers touching either stage ──
    const ptWhere = [`IDpiece_ecru IN (${allEcruIds.join(',')})`]
    if (finiIds.length > 0) ptWhere.push(`IDpiece_fini IN (${finiIds.join(',')})`)
    const pieceTransferts = await query<{
      IDbon_transfert: number; IDpiece_ecru: number; IDpiece_fini: number
    }>(
      `SELECT IDbon_transfert, IDpiece_ecru, IDpiece_fini FROM piece_transfert WHERE ${ptWhere.join(' OR ')}`,
    )
    const bonIds = Array.from(new Set(pieceTransferts.map((p) => Number(p.IDbon_transfert)).filter((x) => x > 0)))
    const bons = new Map<number, { date: string | null; source: number; dest: number; valide: boolean }>()
    if (bonIds.length > 0) {
      // DATE is a reserved word — always alias it (it comes back uppercased).
      const bonRows = await query<{
        IDbon_transfert: number; IDmagasin_source: number; IDmagasin_destination: number
        dtransfert: string | null; est_valide: number
      }>(
        `SELECT IDbon_transfert, IDmagasin_source, IDmagasin_destination, DATE AS dtransfert, est_valide
         FROM bon_transfert WHERE IDbon_transfert IN (${bonIds.join(',')})`,
      )
      for (const b of bonRows) {
        bons.set(Number(b.IDbon_transfert), {
          date: (b.dtransfert ?? null) as string | null,
          source: Number(b.IDmagasin_source) || 0,
          dest: Number(b.IDmagasin_destination) || 0,
          valide: Number(b.est_valide) === 1,
        })
      }
    }

    // ── 5. Labels ──
    const refEcruIds = ecruRows.map((r) => Number(r.IDref_ecru))
    const refEcru = new Map<number, { reference: string; designation: string }>()
    if (refEcruIds.some((x) => x > 0)) {
      const rows = await query<any>(
        `SELECT IDref_ecru, reference, designation FROM ref_ecru
         WHERE IDref_ecru IN (${Array.from(new Set(refEcruIds.filter((x) => x > 0))).join(',')})`,
      )
      for (const r of await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['reference', 'designation'])) {
        refEcru.set(Number((r as any).IDref_ecru), {
          reference: ((r as any).reference ?? '').toString().trim(),
          designation: ((r as any).designation ?? '').toString().trim(),
        })
      }
    }

    const refFiniIds = Array.from(new Set(finiRows.map((r) => Number(r.IDref_fini)).filter((x) => x > 0)))
    const refFini = new Map<number, { reference: string; designation: string; avec_teinture: number }>()
    if (refFiniIds.length > 0) {
      const rows = await query<any>(
        `SELECT IDref_fini, reference, designation, avec_teinture FROM ref_fini
         WHERE IDref_fini IN (${refFiniIds.join(',')})`,
      )
      for (const r of await fixEncoding(rows, 'ref_fini', 'IDref_fini', ['reference', 'designation'])) {
        refFini.set(Number((r as any).IDref_fini), {
          reference: ((r as any).reference ?? '').toString().trim(),
          designation: ((r as any).designation ?? '').toString().trim(),
          avec_teinture: Number((r as any).avec_teinture) || 0,
        })
      }
    }

    // Fini coloris is polymorphic and the two id spaces collide numerically, so
    // fetch BOTH candidate labels and pick per avec_teinture — the same rule
    // stock-fini.ts applies (memory project_avec_teinture_coloris_rule).
    const coloriCandidates = Array.from(new Set([
      ...finiRows.map((r) => Number(r.IDColoris)),
      ...ecruRows.map((r) => Number(r.IDcolori_ecru)),
    ].filter((x) => x > 0)))
    const coloriWash = new Map<number, string>()
    const coloriDyed = new Map<number, string>()
    if (coloriCandidates.length > 0) {
      const inList = coloriCandidates.join(',')
      const w = await query<any>(
        `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${inList})`)
      for (const r of await fixEncoding(w, 'colori_ecru', 'IDcolori_ecru', ['reference'])) {
        coloriWash.set(Number((r as any).IDcolori_ecru), ((r as any).reference ?? '').toString().trim())
      }
      const d = await query<any>(
        `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori IN (${inList})`)
      for (const r of await fixEncoding(d, 'ref_fini_colori', 'IDref_fini_colori', ['reference'])) {
        coloriDyed.set(Number((r as any).IDref_fini_colori), ((r as any).reference ?? '').toString().trim())
      }
    }

    const etatIds = Array.from(new Set(finiRows.map((r) => Number(r.IDetat_stock_fini)).filter((x) => x > 0)))
    const etats = new Map<number, string>()
    if (etatIds.length > 0) {
      const rows = await query<any>(
        `SELECT IDetat_stock_fini, libelle FROM etat_stock_fini WHERE IDetat_stock_fini IN (${etatIds.join(',')})`)
      for (const r of await fixEncoding(rows, 'etat_stock_fini', 'IDetat_stock_fini', ['libelle'])) {
        etats.set(Number((r as any).IDetat_stock_fini), ((r as any).libelle ?? '').toString().trim())
      }
    }

    const magasinNames = await resolveSstNames([
      ...ecruRows.map((r) => Number(r.IDmagasin)),
      ...finiRows.map((r) => Number(r.IDmagasin)),
      ...[...bons.values()].flatMap((b) => [b.source, b.dest]),
    ])
    const cmdRefs = await resolveSstCommandes([
      ...ecruRows.map((r) => Number(r.IDref_commande_source)),
      ...ecruRows.map((r) => Number(r.IDref_commande_affectation)),
      ...finiRows.map((r) => Number(r.IDref_commande_source)),
    ])

    // Expéditions — the fini roll's shipment to the client, and the écru's own
    // (a TRM-knitted piece ships to ETM before dyeing, which is why the écru
    // side has its own ligne_expedition columns).
    const expeditions = await resolveExpeditions([
      ...finiRows.map((r) => Number(r.IDligne_expedition)),
      ...ecruRows.map((r) => Number(r.IDligne_expedition_ETM)),
      ...ecruRows.map((r) => Number(r.IDligne_expedition_TRM)),
    ])

    // Ordre de fabrication — when and on which machine the piece was knitted.
    // `productivité*` and friends are accented; name only ASCII columns.
    const ofIds = Array.from(new Set(ecruRows.map((r) => Number(r.IDordre_fabrication)).filter((x) => x > 0)))
    const fabrications = new Map<number, { IDordre_fabrication: number; date_creation: string | null; machine: string | null }>()
    if (ofIds.length > 0) {
      const ofRows = await query<{ IDordre_fabrication: number; date_creation: string | null; IDmachine: number }>(
        `SELECT IDordre_fabrication, date_creation, IDmachine FROM ordre_fabrication
         WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
      )
      const machineIds = Array.from(new Set(ofRows.map((o) => Number(o.IDmachine)).filter((x) => x > 0)))
      const machines = new Map<number, string>()
      if (machineIds.length > 0) {
        // machine.connecté / archivé / diamètre are accented — ASCII only.
        const mRows = await query<any>(
          `SELECT IDmachine, nom FROM machine WHERE IDmachine IN (${machineIds.join(',')})`)
        for (const m of await fixEncoding(mRows, 'machine', 'IDmachine', ['nom'])) {
          machines.set(Number((m as any).IDmachine), ((m as any).nom ?? '').toString().trim())
        }
      }
      for (const o of ofRows) {
        fabrications.set(Number(o.IDordre_fabrication), {
          IDordre_fabrication: Number(o.IDordre_fabrication),
          date_creation: (o.date_creation ?? null) as string | null,
          machine: machines.get(Number(o.IDmachine)) ?? null,
        })
      }
    }

    // The yarns each piece was knitted from, keyed by its OF.
    const filsByOf = new Map<number, SuiviFil[]>()
    for (const ofId of ofIds) filsByOf.set(ofId, await resolveFilsForOf(ofId))

    // Structured quality defects, via the same polymorphic lookup the Tombé
    // Métier stock screen uses (defaut_qualite Type_Reference = 2).
    const defectsByEcru = await fetchDefectsByEcru(allEcruIds)

    // Free-text observations are accent-bearing VALUES (the column name is
    // ASCII), so they only need the usual encoding repair.
    const ecruTextFixed = (await fixEncoding(
      ecruRows.map((r) => ({
        IDstock_ecru: Number(r.IDstock_ecru),
        observations: ((r.observations ?? '') as string) || '',
      })),
      'stock_ecru', 'IDstock_ecru', ['observations'],
    )) as any[]
    const observationsByEcru = new Map<number, string>(
      ecruTextFixed.map((r) => [Number(r.IDstock_ecru), ((r.observations ?? '') as string).toString().trim()]),
    )

    // A fini roll's notes come from its OWN columns — `observations` (free text)
    // and `observation_sst` (the ennoblisseur's defect report) — exactly as the
    // Finis > Stock screens read them.
    //
    // ⚠️ Deliberately NOT from `defaut_qualite`: under `Type_Reference = 2` its
    // `reference` holds a bare id that is ambiguous between stock_ecru and
    // stock_fini — of 900 sampled refs, 881 are valid écru ids AND 810 are valid
    // fini ids. Joining it to a roll would happily attribute another roll's
    // defect. (That ambiguity is why the écru side reads it through the shared
    // fetchDefectsByEcru, which is scoped to écru ids the caller already has.)
    const finiTextFixed = (await fixEncoding(
      finiRows.map((r) => ({
        IDstock_fini: Number(r.IDstock_fini),
        observations: ((r.observations ?? '') as string) || '',
        observation_sst: ((r.observation_sst ?? '') as string) || '',
      })),
      'stock_fini', 'IDstock_fini', ['observations', 'observation_sst'],
    )) as any[]
    const finiNotes = new Map<number, { observations: string; defauts: string }>(
      finiTextFixed.map((r) => [Number(r.IDstock_fini), {
        observations: ((r.observations ?? '') as string).toString().trim(),
        defauts: ((r.observation_sst ?? '') as string).toString().trim(),
      }]),
    )

    // ── 6. Assemble one chain per écru piece ──
    const transfertsFor = (ecruId: number, finiId: number) => pieceTransferts
      .filter((p) => (ecruId > 0 && Number(p.IDpiece_ecru) === ecruId)
        || (finiId > 0 && Number(p.IDpiece_fini) === finiId))
      .map((p) => {
        const b = bons.get(Number(p.IDbon_transfert))
        if (!b) return null
        return {
          IDbon_transfert: Number(p.IDbon_transfert),
          date: b.date,
          de: suiviMagasin(b.source, magasinNames),
          vers: suiviMagasin(b.dest, magasinNames),
          valide: b.valide,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.IDbon_transfert - b.IDbon_transfert)

    const pieces = ecruRows.map((e) => {
      const ecruId = Number(e.IDstock_ecru)
      const re = refEcru.get(Number(e.IDref_ecru))
      const finis = finiRows
        .filter((f) => Number(f.IDstock_ecru) === ecruId)
        .map((f) => {
          const rf = refFini.get(Number(f.IDref_fini))
          const cid = Number(f.IDColoris)
          // Unknown ref → treat as dyed, matching stock-fini.ts's fallback.
          const dyed = (rf?.avec_teinture ?? 1) !== 0
          const coloris = (dyed ? coloriDyed.get(cid) : coloriWash.get(cid))
            // The stored id can miss its catalog (real case: a dyed roll whose
            // IDColoris is an écru-coloris id). Fall back to the other space
            // rather than showing nothing.
            ?? (dyed ? coloriWash.get(cid) : coloriDyed.get(cid)) ?? ''
          return {
            IDstock_fini: Number(f.IDstock_fini),
            numero: ((f.numero ?? '') as string).toString().trim(),
            reference: rf?.reference ?? '',
            designation: rf?.designation ?? '',
            coloris,
            lot: ((f.lot ?? '') as string).toString().trim(),
            poids: Number(f.poids) || 0,
            metrage: Number(f.metrage) || 0,
            magasin: suiviMagasin(Number(f.IDmagasin) || 0, magasinNames),
            etat: etats.get(Number(f.IDetat_stock_fini)) ?? '',
            commande_source: cmdRefs.get(Number(f.IDref_commande_source)) ?? null,
            expedition: expeditions.get(Number(f.IDligne_expedition)) ?? null,
            observations: finiNotes.get(Number(f.IDstock_fini))?.observations ?? '',
            defauts: finiNotes.get(Number(f.IDstock_fini))?.defauts ?? '',
            second_choix: Number(f.second_choix) > 0,
            transferts: transfertsFor(0, Number(f.IDstock_fini)),
          }
        })
      return {
        ecru: {
          IDstock_ecru: ecruId,
          numero: ((e.numero ?? '') as string).toString().trim(),
          reference: re?.reference ?? '',
          designation: re?.designation ?? '',
          coloris: coloriWash.get(Number(e.IDcolori_ecru)) ?? '',
          lot: ((e.lot ?? '') as string).toString().trim(),
          poids: Number(e.poids) || 0,
          metrage: Number(e.metrage) || 0,
          magasin: suiviMagasin(Number(e.IDmagasin) || 0, magasinNames),
          date_saisie: (e.date_saisie ?? null) as string | null,
          IDsociete: Number(e.IDsociete) || 0,
          observations: observationsByEcru.get(ecruId) ?? '',
          second_choix: Number(e.second_choix) > 0,
          defauts: defautSummary(defectsByEcru.get(ecruId) ?? []),
        },
        commande_source: cmdRefs.get(Number(e.IDref_commande_source)) ?? null,
        commande_affectee: cmdRefs.get(Number(e.IDref_commande_affectation)) ?? null,
        fabrication: fabrications.get(Number(e.IDordre_fabrication)) ?? null,
        fils: filsByOf.get(Number(e.IDordre_fabrication)) ?? [],
        // The écru's own shipment (TRM → ETM). ETM takes precedence when both
        // are set; TRM is the usual one for a piece knitted by the sister company.
        expedition_ecru:
          expeditions.get(Number(e.IDligne_expedition_ETM))
          ?? expeditions.get(Number(e.IDligne_expedition_TRM))
          ?? null,
        transferts: transfertsFor(ecruId, 0),
        finis,
      }
    })

    res.json({
      numero,
      pieces,
      /** More pieces share this number than we returned — the UI says so
       *  instead of quietly showing a slice. */
      truncated: ecruRows.length >= SUIVI_MAX_PIECES,
    })
  } catch (err) {
    console.error('Error tracing piece:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

stockEcruRouter.post('/ecru', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'create_stock_ecru')
    if (!allowed) {
      res.status(403).json({ error: 'permission denied: create_stock_ecru' })
      return
    }

    const b = req.body ?? {}
    const IDref_ecru = parseInt(String(b.IDref_ecru), 10)
    const IDcolori_ecru = parseInt(String(b.IDcolori_ecru), 10)
    const poids = Number(b.poids)
    if (!Number.isInteger(IDref_ecru) || IDref_ecru <= 0) {
      res.status(400).json({ error: 'IDref_ecru required' })
      return
    }
    if (!Number.isInteger(IDcolori_ecru) || IDcolori_ecru <= 0) {
      res.status(400).json({ error: 'IDcolori_ecru required' })
      return
    }
    if (!Number.isFinite(poids) || poids < 0) {
      res.status(400).json({ error: 'poids must be a non-negative number' })
      return
    }
    const metrage = Number.isFinite(Number(b.metrage)) && Number(b.metrage) >= 0 ? Number(b.metrage) : 0
    const r2 = (v: number) => Math.round(v * 100) / 100
    const IDmagasin = Number.isInteger(parseInt(String(b.IDmagasin), 10)) && parseInt(String(b.IDmagasin), 10) > 0
      ? parseInt(String(b.IDmagasin), 10)
      : 0
    const secondChoix = b.second_choix ? 1 : 0
    const lot = (b.lot ?? '').toString()
    const numero = (b.numero ?? '').toString()
    const observations = (b.observations ?? '').toString()
    const visiteur = (b.visiteur ?? '').toString()
    const now = new Date()
    const dateSaisie = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`

    await query(
      `INSERT INTO stock_ecru
       (numero, lot, poids, metrage, IDref_ecru, IDcolori_ecru, IDmagasin,
        IDordre_fabrication, IDref_commande_source, IDref_commande_affectation,
        IDligne_commande_client, IDLigne_Commande_TRM, IDsociete,
        second_choix, observations, visiteur, date_saisie)
       VALUES (${sqlText(numero)}, ${sqlText(lot)}, ${r2(poids)}, ${r2(metrage)},
               ${IDref_ecru}, ${IDcolori_ecru}, ${IDmagasin},
               0, 0, 0,
               0, 0, 1,
               ${secondChoix}, ${sqlText(observations)}, ${sqlText(visiteur)}, '${dateSaisie}')`,
    )
    const idRows = await query<{ id: number }>(`SELECT MAX(IDstock_ecru) AS id FROM stock_ecru`)
    const newId = Number(idRows[0]?.id) || null
    res.status(201).json({ IDstock_ecru: newId })
  } catch (err) {
    console.error('Error creating stock_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/ecru/:id - single écru roll, same shape as a list row.
stockEcruRouter.get('/ecru/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }
    const rows = await query<StockEcru>(
      `SELECT ${STOCK_ECRU_SELECT} ${STOCK_ECRU_JOINS} WHERE se.IDstock_ecru = ${id}`,
    )
    if (rows.length === 0) {
      res.status(404).json({ error: 'Stock écru not found' })
      return
    }
    const hydrated = await hydrateEcruRows(rows)
    res.json(hydrated[0])
  } catch (err) {
    console.error('Error fetching stock_ecru detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/ecru/:id/provenance — yarn + knitting origins of one écru roll.
//   The écru roll IS the source écru, so its provenance is simpler than a fini's:
//     stock_ecru.IDref_commande_source → the tricoteur sst line that knit it
//       → resolveSstLine gives { sst_nom, IDcommande } (Tricotage)
//       → resolveProvenanceFils gives the yarn lots affected to that line (Fils)
//   There is no "ennoblissement" step — dyeing is the écru's destination
//   (IDref_commande_affectation), not its origin. Read-only, not gated.
//   Mirrors stock-fini.ts /provenance; reuses its exported resolvers.
stockEcruRouter.get('/ecru/:id/provenance', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }
    const rows = await query<{ IDref_commande_source: number }>(
      `SELECT IDref_commande_source FROM stock_ecru WHERE IDstock_ecru = ${id}`,
    )
    if (rows.length === 0) {
      res.status(404).json({ error: 'Stock écru not found' })
      return
    }
    const tricoteurLineId = Number(rows[0].IDref_commande_source) || 0
    const tricotage = await resolveSstLine(tricoteurLineId)
    const fils = await resolveProvenanceFils(tricoteurLineId)
    res.json({ tricotage, fils })
  } catch (err) {
    console.error('Error fetching stock_ecru provenance:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/stock/ecru/batch - "Édition groupée": apply observations / visiteur
//   / magasin / second_choix to many rolls at once. Only the provided fields
//   are written. Accented values via sqlText() for bridge safety.
//   MUST be registered before PATCH /ecru/:id (else "batch" is parsed as :id).
stockEcruRouter.patch('/ecru/batch', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'edit_stock_ecru')
    if (!allowed) {
      res.status(403).json({ error: 'permission denied: edit_stock_ecru' })
      return
    }
    const body = req.body ?? {}
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
    if (typeof body.observations === 'string') sets.push(`observations = ${sqlText(body.observations)}`)
    if (typeof body.visiteur === 'string') sets.push(`visiteur = ${sqlText(body.visiteur)}`)
    if (body.IDmagasin !== undefined) {
      const m = parseInt(String(body.IDmagasin), 10)
      if (Number.isInteger(m) && m >= 0) sets.push(`IDmagasin = ${m}`)
    }
    if (body.second_choix !== undefined) sets.push(`second_choix = ${body.second_choix ? 1 : 0}`)
    if (sets.length === 0) {
      res.status(400).json({ error: 'No editable fields provided' })
      return
    }

    await query(`UPDATE stock_ecru SET ${sets.join(', ')} WHERE IDstock_ecru IN (${ids.join(',')})`)
    res.json({ updated: ids.length })
  } catch (err) {
    console.error('Error batch-updating stock_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/stock/ecru/:id - whitelist edit (observations, visiteur,
//   second_choix, IDmagasin). poids/metrage/refs/affectation/reservation belong
//   to the reception & affectation flows, not this screen.
stockEcruRouter.patch('/ecru/:id', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'edit_stock_ecru')
    if (!allowed) {
      res.status(403).json({ error: 'permission denied: edit_stock_ecru' })
      return
    }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }
    const body = req.body ?? {}
    const sets: string[] = []
    if (typeof body.observations === 'string') sets.push(`observations = ${sqlText(body.observations)}`)
    if (typeof body.visiteur === 'string') sets.push(`visiteur = ${sqlText(body.visiteur)}`)
    if (body.second_choix !== undefined) sets.push(`second_choix = ${body.second_choix ? 1 : 0}`)
    if (body.IDmagasin !== undefined) {
      const m = parseInt(String(body.IDmagasin), 10)
      if (Number.isInteger(m) && m >= 0) sets.push(`IDmagasin = ${m}`)
    }
    if (sets.length === 0) {
      res.status(400).json({ error: 'No editable fields provided' })
      return
    }

    await query(`UPDATE stock_ecru SET ${sets.join(', ')} WHERE IDstock_ecru = ${id}`)

    const rows = await query<StockEcru>(
      `SELECT ${STOCK_ECRU_SELECT} ${STOCK_ECRU_JOINS} WHERE se.IDstock_ecru = ${id}`,
    )
    const hydrated = await hydrateEcruRows(rows)
    res.json(hydrated[0])
  } catch (err) {
    console.error('Error updating stock_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/stock/ecru/:id/cut - split one écru roll into N rolls (2..10). The
//   poids/metrage of the pieces must sum to the original (value conservation),
//   re-validated server-side. Piece 0 updates the original in place; pieces
//   1..N-1 are INSERT ... SELECT copies (accented text columns copied inside the
//   DB — no encoding round-trip) with numero suffixes -2, -3, … Gated by the
//   cut_stock_ecru permission.
stockEcruRouter.post('/ecru/:id/cut', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'cut_stock_ecru')
    if (!allowed) {
      res.status(403).json({ error: 'permission denied: cut_stock_ecru' })
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
    const norm = pieces.map((p) => ({ poids: Number(p?.poids), metrage: Number(p?.metrage) }))
    if (norm.some((p) => !Number.isFinite(p.poids) || !Number.isFinite(p.metrage) || p.poids < 0 || p.metrage < 0)) {
      res.status(400).json({ error: 'each piece needs a non-negative poids and metrage' })
      return
    }

    const origRows = await query<{ poids: number | null; metrage: number | null; numero: string | null }>(
      `SELECT poids, metrage, numero FROM stock_ecru WHERE IDstock_ecru = ${id}`,
    )
    if (origRows.length === 0) {
      res.status(404).json({ error: 'Stock écru not found' })
      return
    }
    const orig = origRows[0]
    const origPoids = Number(orig.poids) || 0
    const origMetrage = Number(orig.metrage) || 0
    const sumPoids = norm.reduce((s, p) => s + p.poids, 0)
    const sumMetrage = norm.reduce((s, p) => s + p.metrage, 0)
    if (Math.abs(sumPoids - origPoids) > 0.01 || Math.abs(sumMetrage - origMetrage) > 0.1) {
      res.status(400).json({ error: 'Sum mismatch: pieces must total the original poids and metrage' })
      return
    }

    const r2 = (v: number) => Math.round(v * 100) / 100
    const base = (orig.numero ?? '').trim() || `#${id}`

    // Piece 0 -> update the original row in place (numero unchanged).
    await query(
      `UPDATE stock_ecru SET poids = ${r2(norm[0].poids)}, metrage = ${r2(norm[0].metrage)} WHERE IDstock_ecru = ${id}`,
    )

    // Pieces 1..N-1 -> new rows copying every known column from the original.
    // Only columns proven to exist are named (a phantom column storms the
    // Linux bridge).
    const COPY_COLS =
      'numero, IDref_ecru, IDcolori_ecru, IDmagasin, IDordre_fabrication, IDref_commande_source, IDref_commande_affectation, IDligne_commande_client, IDLigne_Commande_TRM, IDsociete, poids, metrage, lot, observations, visiteur, second_choix, date_saisie'
    for (let i = 1; i < norm.length; i++) {
      const suffix = `-${i + 1}`
      const child = base.slice(0, 20 - suffix.length) + suffix
      await query(
        `INSERT INTO stock_ecru (${COPY_COLS})
         SELECT '${esc(child)}', IDref_ecru, IDcolori_ecru, IDmagasin, IDordre_fabrication, IDref_commande_source, IDref_commande_affectation, IDligne_commande_client, IDLigne_Commande_TRM, IDsociete, ${r2(norm[i].poids)}, ${r2(norm[i].metrage)}, lot, observations, visiteur, second_choix, date_saisie
         FROM stock_ecru WHERE IDstock_ecru = ${id}`,
      )
    }

    res.json({ ok: true, created: norm.length - 1 })
  } catch (err) {
    console.error('Error cutting stock_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
