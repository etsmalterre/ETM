import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import type { Sql } from 'postgres'
import { mpsPg } from '../lib/mps-pg.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { userCanOpenScreen } from '../lib/permissions.js'
import { loadTraitementCatalog } from '../lib/traitements.js'
import { numeroEchantillon, statutEchantillon } from '../lib/echantillons.js'
import { achatDepuisPrixBase, FRAIS_GESTION_FIL_PCT } from '../lib/fil-frais-gestion.js'
import { calcTarifRefFini } from '../lib/pricing-fini-tarif.js'
import { contratPriceFn } from '../lib/pricing-ligne-client.js'
import { resolveLigneTarifMode } from '../lib/tarif-client.js'
import {
  calcTarifSimulation,
  type PortMode,
  type TarifSimFil,
  type TarifSimInput,
  type TarifSimTraitement,
} from '../lib/pricing-ref-tarif.js'
import { rendementDepuisMesures, sourceSimulation } from '../lib/tarif-simulation.js'
import {
  prixAchatCatalogue, seedFromEchantillon, seedFromRefFini, type NewFil,
} from '../lib/tarif-simulation-sources.js'

export const tarifsFiniRouter: RouterType = Router()

// Finis › Tarifs — the price SIMULATOR (legacy `FI_Tarifs.wdw`, reworked on
// LIVA #1298). A simulation is a what-if record: physical parameters, a yarn
// composition, a list of treatments, and the levers of a price study. Nothing
// here feeds the real catalogue — it is a costing sandbox with its own tables.
//
// Two ways in (Vincent, 2026-10-21):
//   • from a SAMPLE (Tombé Métier › Échantillons) — give a client we do R&D
//     with a price before going further: the yarns come with their current
//     purchase prices, the rendement from the washed sample's measures;
//   • from a CLIENT'S REFERENCE — a study to bring its price down: the
//     simulation starts at the reference's exact catalogue price, and every
//     tranche is compared with the catalogue AND with what the client pays
//     (contract / fixed coefficient / standard) — GET /:id/comparaison.
//
// Data model:
//   ref_tarif              one row per simulation (+ 0028: source idref_fini /
//                          idcoloris / idclient / idref_echantillon,
//                          date_creation, mult_auto, gots,
//                          ajust_ennoblissement, frais_gestion_fil). ok_tarif
//                          = 1 means archivée. `avec_teinture` is vestigial.
//   asso_fil_tarif         composition; `prix_achat` = the yarn's PURCHASE
//                          €/Kg snapshot (the line costs prix_achat × (1 +
//                          frais_gestion_fil)); the legacy `prix` is kept in
//                          step with that €/Kg for old readers.
//   asso_traitement_tarif  applied treatments, one row per application (the
//                          same treatment may repeat).
//
// Native PostgreSQL (lib/mps-pg.ts) — the pricing engine itself still reads
// its bands through the legacy adapter.

const MENU = '/finis'
const ECRAN = '/finis/tarifs'

// Every route, reads included: the screen IS the right (CLAUDE.md « Écrans =
// what a user SEES »), and there is no global guard.
tarifsFiniRouter.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    if (!(await userCanOpenScreen(req.userId, isEffectiveAdmin(req), MENU, ECRAN))) {
      res.status(403).json({ error: 'écran non accordé : Finis › Tarifs' })
      return
    }
    next()
  } catch (err) {
    next(err)
  }
})

/** Round to 2 decimals — prices. */
function money(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

/** Round to 4 decimals — rendement / ratios, where 2 would lose precision. */
function num4(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0
}

function txt(v: unknown): string | null {
  const s = v == null ? '' : String(v).trim()
  return s === '' ? null : s
}

function idParam(req: Request, name = 'id'): number | null {
  const n = parseInt(String(req.params[name]), 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

// ──────────────────────────────────────────────────────────
// SHARED LOADERS
// ──────────────────────────────────────────────────────────

interface RefTarifRow {
  idref_tarif: number
  reference: string | null
  commentaire: string | null
  laize: number | null
  poids: number | null
  rendement: number | null
  freinte: number | null
  prix_tricotage: number | null
  poids_rouleau: number | null
  port_fixe: number | null
  port_pct: number | null
  multiplicateur: number | null
  idteinture: number | null
  ok_tarif: number | null
  idref_fini: number | null
  idcoloris: number | null
  idclient: number | null
  idref_echantillon: number | null
  date_creation: Date | string | null
  mult_auto: number | null
  gots: number | null
  ajust_ennoblissement: number | null
  frais_gestion_fil: number | null
}

async function loadRefTarifRow(sql: Sql, id: number): Promise<RefTarifRow | null> {
  const [row] = await sql<RefTarifRow[]>`
    SELECT idref_tarif, reference, commentaire, laize, poids, rendement, freinte, prix_tricotage,
           poids_rouleau, port_fixe, port_pct, multiplicateur, idteinture, ok_tarif,
           idref_fini, idcoloris, idclient, idref_echantillon, date_creation,
           mult_auto, gots, ajust_ennoblissement, frais_gestion_fil
      FROM ref_tarif WHERE idref_tarif = ${id}`
  return row ?? null
}

interface TeintureRow {
  idteinture: number
  designation_interne: string | null
  designation_externe: string | null
  simple_teinture: number | null
  prix_gots: number | null
}

/** Teinture catalog (4 rows) — read whole. */
async function loadTeintures(sql: Sql): Promise<TeintureRow[]> {
  return sql<TeintureRow[]>`
    SELECT idteinture, designation_interne, designation_externe, simple_teinture, prix_gots
      FROM teinture ORDER BY idteinture`
}

/** Composition lines of one simulation, with yarn + coloris labels. */
async function loadFils(sql: Sql, id: number): Promise<TarifSimFil[]> {
  const rows = await sql<{
    idasso_fil_tarif: number; idref_fil: number; idcolori_fil: number
    pourcentage: number | null; prix_achat: number | null
    ref_label: string | null; colori_label: string | null
  }[]>`
    SELECT a.idasso_fil_tarif, a.idref_fil, a.idcolori_fil, a.pourcentage, a.prix_achat,
           f.reference AS ref_label, c.reference AS colori_label
      FROM asso_fil_tarif a
      LEFT JOIN ref_fil f ON f.idref_fil = a.idref_fil
      LEFT JOIN colori_fil c ON c.idcolori_fil = a.idcolori_fil AND a.idcolori_fil > 0
     WHERE a.idref_tarif = ${id}
     ORDER BY a.idasso_fil_tarif`
  return rows.map((r) => ({
    IDasso_fil_tarif: Number(r.idasso_fil_tarif),
    IDref_fil: Number(r.idref_fil) || 0,
    ref_label: txt(r.ref_label),
    IDcolori_fil: Number(r.idcolori_fil) || 0,
    colori_label: txt(r.colori_label),
    pourcentage: num4(r.pourcentage),
    prix_achat: num4(r.prix_achat),
  }))
}

/** Applied treatments, in the catalog's process order (Préfixation → Lavage →
 *  … → Chardonnage). */
async function loadTraitements(sql: Sql, id: number): Promise<TarifSimTraitement[]> {
  const rows = await sql<{ idasso_traitement_tarif: number; idtraitement: number; designation: string | null }[]>`
    SELECT a.idasso_traitement_tarif, a.idtraitement, t.designation
      FROM asso_traitement_tarif a
      LEFT JOIN traitement t ON t.idtraitement = a.idtraitement
     WHERE a.idref_tarif = ${id}
     ORDER BY COALESCE(t.ordre, 999), a.idasso_traitement_tarif`
  return rows.map((r) => ({
    IDasso_traitement_tarif: Number(r.idasso_traitement_tarif),
    IDtraitement: Number(r.idtraitement) || 0,
    designation: txt(r.designation),
  }))
}

/** `port_pct > 0` means percentage mode; otherwise the flat €/Kg column drives. */
function portModeOf(row: { port_pct: number | null }): PortMode {
  return Number(row.port_pct) > 0 ? 'pct' : 'kg'
}

/** The parameters a preview may override — every one of them a lever. */
interface SimParams {
  rendement: number
  poids_rouleau: number
  prix_tricotage: number
  port_mode: PortMode
  port_fixe: number
  port_pct: number
  mult_auto: boolean
  multiplicateur: number
  ajust_ennoblissement: number
  frais_gestion_fil: number
  gots: boolean
  IDteinture: number
}

function paramsOf(row: RefTarifRow): SimParams {
  return {
    rendement: Number(row.rendement) || 0, // raw — see seedFromRefFini
    poids_rouleau: num4(row.poids_rouleau),
    prix_tricotage: num4(row.prix_tricotage),
    port_mode: portModeOf(row),
    port_fixe: money(row.port_fixe),
    port_pct: num4(row.port_pct),
    mult_auto: Number(row.mult_auto ?? 1) === 1,
    multiplicateur: num4(row.multiplicateur),
    ajust_ennoblissement: num4(row.ajust_ennoblissement),
    frais_gestion_fil: num4(row.frais_gestion_fil ?? FRAIS_GESTION_FIL_PCT),
    gots: Number(row.gots) === 1,
    IDteinture: Number(row.idteinture) || 0,
  }
}

/** Everything the pricing engine needs for one simulation, `params` overriding
 *  the stored row (live preview while editing). */
async function buildSimInput(sql: Sql, id: number, params?: SimParams): Promise<TarifSimInput | null> {
  const row = await loadRefTarifRow(sql, id)
  if (!row) return null
  const [fils, traitements, teintures] = await Promise.all([loadFils(sql, id), loadTraitements(sql, id), loadTeintures(sql)])
  const p = params ?? paramsOf(row)
  const teinture = teintures.find((t) => Number(t.idteinture) === p.IDteinture) ?? null
  return {
    IDref_tarif: id,
    rendement: p.rendement,
    poids_rouleau: p.poids_rouleau,
    prix_tricotage: p.prix_tricotage,
    port_mode: p.port_mode,
    port_fixe: p.port_fixe,
    port_pct: p.port_pct,
    mult_auto: p.mult_auto,
    multiplicateur: p.multiplicateur,
    ajust_ennoblissement: p.ajust_ennoblissement,
    frais_gestion_fil: p.frais_gestion_fil,
    gots: p.gots,
    IDteinture: p.IDteinture,
    teinture_label: txt(teinture?.designation_externe),
    prix_gots: money(teinture?.prix_gots),
    fils,
    traitements,
  }
}

/** Labels of a simulation's source (reference, coloris, client, sample). */
async function loadSourceLabels(sql: Sql, row: RefTarifRow) {
  const idRefFini = Number(row.idref_fini) || 0
  const idCol = Number(row.idcoloris) || 0
  const idClient = Number(row.idclient) || 0
  const idEch = Number(row.idref_echantillon) || 0
  let ref_fini: string | null = null
  let coloris: string | null = null
  if (idRefFini > 0) {
    const [r] = await sql<{ reference: string | null; designation: string | null; avec_teinture: number | null }[]>`
      SELECT reference, designation, avec_teinture FROM ref_fini WHERE idref_fini = ${idRefFini}`
    ref_fini = txt(r?.reference)
    if (idCol > 0) {
      // A fini's coloris lives in ref_fini_colori when it is dyed, in the
      // écru's colori_ecru when it is only washed (#1158).
      const [c] = Number(r?.avec_teinture) !== 0
        ? await sql<{ reference: string | null }[]>`SELECT reference FROM ref_fini_colori WHERE idref_fini_colori = ${idCol}`
        : await sql<{ reference: string | null }[]>`SELECT reference FROM colori_ecru WHERE idcolori_ecru = ${idCol}`
      coloris = txt(c?.reference)
    }
  }
  let client: string | null = null
  if (idClient > 0) {
    const [c] = await sql<{ nom: string | null }[]>`SELECT nom FROM client WHERE idclient = ${idClient}`
    client = txt(c?.nom)
  }
  return {
    IDref_fini: idRefFini,
    ref_fini,
    IDcoloris: idCol,
    coloris,
    IDclient: idClient,
    client,
    IDref_echantillon: idEch,
    echantillon: idEch > 0 ? numeroEchantillon(idEch) : null,
  }
}

function isoDate(v: Date | string | null): string | null {
  if (!v) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

async function loadDetail(sql: Sql, id: number) {
  const row = await loadRefTarifRow(sql, id)
  if (!row) return null
  const [fils, traitements, source] = await Promise.all([loadFils(sql, id), loadTraitements(sql, id), loadSourceLabels(sql, row)])
  return {
    IDref_tarif: Number(row.idref_tarif),
    reference: txt(row.reference) ?? '',
    commentaire: txt(row.commentaire) ?? '',
    laize: num4(row.laize),
    poids: num4(row.poids),
    freinte: num4(row.freinte),
    ok_tarif: Number(row.ok_tarif) || 0,
    date_creation: isoDate(row.date_creation),
    source_kind: sourceSimulation(row),
    ...source,
    ...paramsOf(row),
    fils,
    traitements,
  }
}

// ──────────────────────────────────────────────────────────
// LOOKUPS (declared before '/:id')
// ──────────────────────────────────────────────────────────

// GET /api/tarifs-fini/lookups/fils — yarn catalog + each ref's coloris, for
// the « Ajouter un fil » picker. `prix_kg` is the base price (purchase + frais
// de gestion); `prix_achat` the purchase price a new line starts from.
tarifsFiniRouter.get('/lookups/fils', async (_req: Request, res: Response) => {
  try {
    const sql = mpsPg()
    const [refs, cols] = await Promise.all([
      sql<{ idref_fil: number; reference: string | null; prix_kg: number | null }[]>`
        SELECT idref_fil, reference, prix_kg FROM ref_fil ORDER BY reference`,
      sql<{ idcolori_fil: number; idref_fil: number; reference: string | null; prix_kg: number | null }[]>`
        SELECT idcolori_fil, idref_fil, reference, prix_kg FROM colori_fil ORDER BY reference`,
    ])
    const colorisByRef = new Map<number, Array<{ id: number; reference: string | null; prix_kg: number; prix_achat: number }>>()
    for (const c of cols) {
      const k = Number(c.idref_fil) || 0
      const arr = colorisByRef.get(k) ?? []
      arr.push({ id: Number(c.idcolori_fil), reference: txt(c.reference), prix_kg: money(c.prix_kg), prix_achat: num4(achatDepuisPrixBase(money(c.prix_kg))) })
      colorisByRef.set(k, arr)
    }
    res.json(refs.map((r) => ({
      IDref_fil: Number(r.idref_fil),
      reference: txt(r.reference),
      prix_kg: money(r.prix_kg),
      prix_achat: num4(achatDepuisPrixBase(money(r.prix_kg))),
      coloris: colorisByRef.get(Number(r.idref_fil)) ?? [],
    })))
  } catch (err) {
    console.error('Error fetching tarif fils lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/tarifs-fini/lookups/traitements — the ennoblissement catalog.
tarifsFiniRouter.get('/lookups/traitements', async (_req: Request, res: Response) => {
  try {
    res.json(await loadTraitementCatalog())
  } catch (err) {
    console.error('Error fetching traitements lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/tarifs-fini/lookups/teintures — the 4 dye rows, so the screen can
// map (mode simple/double) × (Blanc / Tous Coloris) onto an IDteinture.
tarifsFiniRouter.get('/lookups/teintures', async (_req: Request, res: Response) => {
  try {
    const rows = await loadTeintures(mpsPg())
    res.json(rows.map((t) => ({
      IDteinture: Number(t.idteinture),
      designation_interne: txt(t.designation_interne),
      designation_externe: txt(t.designation_externe),
      simple_teinture: Number(t.simple_teinture) || 0,
      prix_gots: money(t.prix_gots),
    })))
  } catch (err) {
    console.error('Error fetching teintures lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/tarifs-fini/lookups/refs-finies — source list for « Depuis une
// référence client ». Only refs with an écru (they carry the composition and
// the knitting price); archived ones are left out.
tarifsFiniRouter.get('/lookups/refs-finies', async (_req: Request, res: Response) => {
  try {
    const rows = await mpsPg()<{ idref_fini: number; reference: string | null; designation: string | null }[]>`
      SELECT idref_fini, reference, designation FROM ref_fini
       WHERE idref_ecru > 0 AND COALESCE(archive, 0) = 0
       ORDER BY reference`
    res.json(rows.map((r) => ({ IDref_fini: Number(r.idref_fini), reference: txt(r.reference), designation: txt(r.designation) })))
  } catch (err) {
    console.error('Error fetching refs-finies lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/tarifs-fini/lookups/refs-finies/:id/coloris — the ref's coloris,
// branched on avec_teinture (#1158).
tarifsFiniRouter.get('/lookups/refs-finies/:id/coloris', async (req: Request, res: Response) => {
  try {
    const id = idParam(req)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const sql = mpsPg()
    const [ref] = await sql<{ avec_teinture: number | null; idref_ecru: number | null }[]>`
      SELECT avec_teinture, idref_ecru FROM ref_fini WHERE idref_fini = ${id}`
    if (!ref) { res.status(404).json({ error: 'Référence introuvable' }); return }
    const rows = Number(ref.avec_teinture) !== 0
      ? await sql<{ id: number; reference: string | null }[]>`
          SELECT idref_fini_colori AS id, reference FROM ref_fini_colori WHERE idref_fini = ${id} ORDER BY reference`
      : await sql<{ id: number; reference: string | null }[]>`
          SELECT idcolori_ecru AS id, reference FROM colori_ecru WHERE idref_ecru = ${Number(ref.idref_ecru) || 0} ORDER BY reference`
    res.json(rows.map((r) => ({ id: Number(r.id), reference: txt(r.reference) ?? `#${r.id}` })))
  } catch (err) {
    console.error('Error fetching ref fini coloris:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/tarifs-fini/lookups/refs-finies/:id/clients — the ETM clients that
// have this reference in their catalogue (designation_client): their tarif
// mode (contract / coefficient / standard) is what the study compares with.
tarifsFiniRouter.get('/lookups/refs-finies/:id/clients', async (req: Request, res: Response) => {
  try {
    const id = idParam(req)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const rows = await mpsPg()<{ idclient: number; nom: string | null }[]>`
      SELECT DISTINCT c.idclient, c.nom
        FROM designation_client d
        JOIN client c ON c.idclient = d.idclient
       WHERE d.idref_fini = ${id} AND COALESCE(d.archive, 0) = 0 AND c.idsociete = 1
       ORDER BY c.nom`
    res.json(rows.map((r) => ({ IDclient: Number(r.idclient), nom: txt(r.nom) ?? `#${r.idclient}` })))
  } catch (err) {
    console.error('Error fetching ref fini clients:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/tarifs-fini/lookups/echantillons — the samples of Tombé Métier ›
// Échantillons a simulation can start from, open ones first.
tarifsFiniRouter.get('/lookups/echantillons', async (_req: Request, res: Response) => {
  try {
    const rows = await mpsPg()<{
      idref_echantillon: number; archive: number | null; idref_ecru: number | null
      laize_lave: number | null; poids_m2_lave: number | null; commentaire: string | null
      client_nom: string | null; contexture_nom: string | null; nb_fils: number
    }[]>`
      SELECT e.idref_echantillon, e.archive, e.idref_ecru, e.laize_lave, e.poids_m2_lave, e.commentaire,
             cl.nom AS client_nom, c.nom AS contexture_nom,
             (SELECT COUNT(*)::int FROM fil_ref_echantillon f WHERE f.idref_echantillon = e.idref_echantillon) AS nb_fils
        FROM ref_echantillon e
        LEFT JOIN client cl ON cl.idclient = e.idclient AND e.idclient > 0
        LEFT JOIN contexture c ON c.idcontexture = e.idcontexture AND e.idcontexture > 0
       ORDER BY e.idref_echantillon DESC`
    const out = rows.map((r) => ({
      IDref_echantillon: Number(r.idref_echantillon),
      numero: numeroEchantillon(Number(r.idref_echantillon)),
      statut: statutEchantillon({ archive: r.archive, idref_ecru: r.idref_ecru }),
      client: txt(r.client_nom),
      contexture: txt(r.contexture_nom),
      commentaire: txt(r.commentaire),
      nb_fils: Number(r.nb_fils) || 0,
      rendement: rendementDepuisMesures(Number(r.laize_lave) || 0, Number(r.poids_m2_lave) || 0),
    }))
    // Open samples first — those are the R&D still being priced.
    out.sort((a, b) => Number(a.statut !== 'en_cours') - Number(b.statut !== 'en_cours') || b.IDref_echantillon - a.IDref_echantillon)
    res.json(out)
  } catch (err) {
    console.error('Error fetching echantillons lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// LIST
// ──────────────────────────────────────────────────────────

// GET /api/tarifs-fini — every simulation, light payload for the left list.
tarifsFiniRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const sql = mpsPg()
    const rows = await sql<{
      idref_tarif: number; reference: string | null; ok_tarif: number | null; idteinture: number | null
      laize: number | null; poids: number | null; rendement: number | null
      idref_fini: number | null; idclient: number | null; idref_echantillon: number | null
      date_creation: Date | string | null
      ref_fini: string | null; client: string | null; fils_count: number
      simple_teinture: number | null; teinture_shade: string | null
    }[]>`
      SELECT t.idref_tarif, t.reference, t.ok_tarif, t.idteinture, t.laize, t.poids, t.rendement,
             t.idref_fini, t.idclient, t.idref_echantillon, t.date_creation,
             f.reference AS ref_fini, c.nom AS client,
             (SELECT COUNT(*)::int FROM asso_fil_tarif a WHERE a.idref_tarif = t.idref_tarif) AS fils_count,
             te.simple_teinture, te.designation_interne AS teinture_shade
        FROM ref_tarif t
        LEFT JOIN ref_fini f ON f.idref_fini = t.idref_fini AND t.idref_fini > 0
        LEFT JOIN client c ON c.idclient = t.idclient AND t.idclient > 0
        LEFT JOIN teinture te ON te.idteinture = t.idteinture AND t.idteinture > 0`
    const out = rows
      .map((r) => ({
        IDref_tarif: Number(r.idref_tarif),
        reference: txt(r.reference),
        ok_tarif: Number(r.ok_tarif) || 0,
        IDteinture: Number(r.idteinture) || 0,
        teinture_mode: (Number(r.idteinture) || 0) === 0 ? 'sans' : Number(r.simple_teinture) === 1 ? 'simple' : 'double',
        teinture_shade: txt(r.teinture_shade),
        laize: num4(r.laize),
        poids: num4(r.poids),
        rendement: num4(r.rendement),
        fils_count: Number(r.fils_count) || 0,
        source_kind: sourceSimulation(r),
        ref_fini: txt(r.ref_fini),
        client: txt(r.client),
        echantillon: (Number(r.idref_echantillon) || 0) > 0 ? numeroEchantillon(Number(r.idref_echantillon)) : null,
        date_creation: isoDate(r.date_creation),
      }))
      // Newest first: the studies in progress are the recent ones; legacy
      // rows without a date sort by id among themselves.
      .sort((a, b) => (b.date_creation ?? '').localeCompare(a.date_creation ?? '') || b.IDref_tarif - a.IDref_tarif)
    res.json(out)
  } catch (err) {
    console.error('Error fetching ref_tarif list:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// DETAIL + PRICING
// ──────────────────────────────────────────────────────────

// GET /api/tarifs-fini/:id
tarifsFiniRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = idParam(req)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const detail = await loadDetail(mpsPg(), id)
    if (!detail) { res.status(404).json({ error: 'Simulation not found' }); return }
    res.json(detail)
  } catch (err) {
    console.error('Error fetching ref_tarif detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const paramsSchema = z.object({
  rendement: z.number().min(0).max(100),
  poids_rouleau: z.number().min(0).max(10000),
  prix_tricotage: z.number().min(0).max(10000),
  port_mode: z.enum(['pct', 'kg']),
  port_fixe: z.number().min(0).max(1000),
  port_pct: z.number().min(0).max(99),
  mult_auto: z.boolean(),
  multiplicateur: z.number().min(-1).max(10),
  ajust_ennoblissement: z.number().min(-90).max(500),
  frais_gestion_fil: z.number().min(0).max(100),
  gots: z.boolean(),
  IDteinture: z.number().int().min(0),
})

const libreSchema = z.object({
  poids: z.number().min(0).max(1000000),
  /** Percent (35) — the engine wants a ratio. */
  coefficient: z.number().min(0).max(99).optional(),
  prix_cible_ml: z.number().min(0).max(100000).optional(),
})

// POST /api/tarifs-fini/:id/preview — the nine tranches (plus an optional
// free simulation), priced against UNSAVED parameters: the right panel
// re-prices while the user moves a lever, before anything is written. The
// composition and treatments come from the stored rows (they persist as soon
// as they are edited).
tarifsFiniRouter.post('/:id/preview', async (req: Request, res: Response) => {
  try {
    const id = idParam(req)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = z.object({ params: paramsSchema.optional(), libre: libreSchema.optional() }).safeParse(req.body ?? {})
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const input = await buildSimInput(mpsPg(), id, parsed.data.params)
    if (!input) { res.status(404).json({ error: 'Simulation not found' }); return }
    const l = parsed.data.libre
    const libreOpts = l && l.poids > 0
      ? {
        poids: l.poids,
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

// GET /api/tarifs-fini/:id/comparaison — what the simulation is compared with,
// tranche by tranche: the source reference's catalogue price, and the price
// the chosen client really pays for it (contract → negotiated prices, fixed
// coefficient → its margin, otherwise the catalogue). Empty for a simulation
// that has no reference behind it. `?client=<id>` overrides the saved client.
tarifsFiniRouter.get('/:id/comparaison', async (req: Request, res: Response) => {
  try {
    const id = idParam(req)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const row = await loadRefTarifRow(mpsPg(), id)
    if (!row) { res.status(404).json({ error: 'Simulation not found' }); return }
    const idRef = Number(row.idref_fini) || 0
    const idCol = Number(row.idcoloris) || 0
    // `?client=` prices another client while the study is being edited (the
    // picker moves before Enregistrer); default = the saved one.
    const clientParam = parseInt(String(req.query.client ?? ''), 10)
    const idClient = Number.isInteger(clientParam) && clientParam >= 0 ? clientParam : Number(row.idclient) || 0
    const empty = { catalogue: null, client: null }
    if (idRef <= 0 || idCol <= 0) { res.json(empty); return }

    const catalogue = await calcTarifRefFini(idRef, idCol)
    if (catalogue.tranches.length === 0) { res.json(empty); return }
    const catTranches = catalogue.tranches.map((t) => ({ ml: t.moPrixDeVenteAuMl, kg: t.moPrixDeVenteAuKg }))

    let client = null
    if (idClient > 0) {
      const mode = await resolveLigneTarifMode({ IDclient: idClient, type: 2, IDreference: idRef, IDcolori: idCol })
      const rdt2 = Math.round(catalogue.rendement * 100) / 100
      let tranches: Array<{ ml: number; kg: number } | null> = catTranches
      let note: string | null = null
      if (!mode || mode.tarif_mode === 'standard') {
        note = mode ? null : 'Coloris absent du catalogue du client : tarif standard.'
      } else if (mode.contrat_expire) {
        tranches = catTranches.map(() => null)
        note = 'Contrat expiré : la référence n’est plus vendable à ce client tant qu’un nouveau contrat n’est pas établi.'
      } else if (mode.tarif_mode === 'contrat' && mode.contrat_actif) {
        const atMl = contratPriceFn(mode.contrat_actif, 3, rdt2, mode.prix_unit)
        const atKg = contratPriceFn(mode.contrat_actif, 1, rdt2, mode.prix_unit)
        tranches = catTranches.map((_, i) => (atMl && atKg ? { ml: atMl(i), kg: atKg(i) } : null))
      } else if (mode.tarif_mode === 'coefficient' && mode.coefficient > 0) {
        const coef = await calcTarifRefFini(idRef, idCol, { coefficient: mode.coefficient / 100 })
        tranches = coef.tranches.map((t) => ({ ml: t.moPrixDeVenteAuMl, kg: t.moPrixDeVenteAuKg }))
      }
      client = {
        mode: mode?.tarif_mode ?? 'standard',
        coefficient: mode?.coefficient ?? 0,
        prix_unit: mode?.prix_unit ?? 'Ml',
        contrat_debut: mode?.contrat_actif?.date_debut ?? null,
        contrat_fin: mode?.contrat_actif?.date_expiration ?? mode?.dernier_contrat?.date_expiration ?? null,
        contrat_expire: mode?.contrat_expire ?? false,
        note,
        tranches,
      }
    }
    res.json({ catalogue: { tranches: catTranches }, client })
  } catch (err) {
    console.error('Error comparing ref_tarif simulation:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// CREATE
// ──────────────────────────────────────────────────────────

const createBody = z.object({
  mode: z.enum(['blank', 'duplicate', 'from_fini', 'from_echantillon']),
  reference: z.string().trim().min(1).max(120),
  /** ref_tarif id (duplicate), ref_fini id (from_fini), sample id (from_echantillon). */
  source_id: z.number().int().positive().optional(),
  /** from_fini: the coloris (ref_fini_colori or colori_ecru, per avec_teinture). */
  IDcoloris: z.number().int().min(0).optional(),
  /** from_fini: the client whose price is the study's baseline (0 = none). */
  IDclient: z.number().int().min(0).optional(),
})

interface NewSimulation {
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
  mult_auto: number
  idteinture: number
  gots: number
  ajust_ennoblissement: number
  frais_gestion_fil: number
  idref_fini: number
  idcoloris: number
  idclient: number
  idref_echantillon: number
}

/** Defaults of a blank simulation — the values every legacy row carries. */
const BLANK: NewSimulation = {
  reference: '',
  commentaire: '',
  laize: 0,
  poids: 0,
  rendement: 0,
  freinte: 0.1,
  prix_tricotage: 0,
  poids_rouleau: 20,
  port_fixe: 0,
  port_pct: 5,
  multiplicateur: 0,
  mult_auto: 1,
  idteinture: 0,
  gots: 0,
  ajust_ennoblissement: 0,
  frais_gestion_fil: FRAIS_GESTION_FIL_PCT,
  idref_fini: 0,
  idcoloris: 0,
  idclient: 0,
  idref_echantillon: 0,
}

/** Insert a simulation with its lines in one transaction; returns its id. */
async function insertSimulation(sql: Sql, v: NewSimulation, fils: NewFil[], traitements: number[]): Promise<number> {
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql
    const [{ idref_tarif }] = await t<{ idref_tarif: number }[]>`
      INSERT INTO ref_tarif
        (reference, designation, commentaire, laize, poids, rendement, freinte, prix_tricotage, poids_rouleau,
         port_fixe, port_pct, multiplicateur, idteinture, avec_teinture, poids_teinture, ok_tarif,
         plus_moins_poids, plus_moins_laize, idref_fini, idcoloris, idclient, idref_echantillon,
         date_creation, mult_auto, gots, ajust_ennoblissement, frais_gestion_fil)
      VALUES
        (${v.reference}, '', ${v.commentaire}, ${v.laize}, ${v.poids}, ${v.rendement}, ${v.freinte},
         ${v.prix_tricotage}, ${v.poids_rouleau}, ${v.port_fixe}, ${v.port_pct}, ${v.multiplicateur},
         ${v.idteinture}, ${v.idteinture > 0 ? 1 : 0}, 0, 0, 0, 0, ${v.idref_fini}, ${v.idcoloris}, ${v.idclient},
         ${v.idref_echantillon}, CURRENT_DATE, ${v.mult_auto}, ${v.gots}, ${v.ajust_ennoblissement}, ${v.frais_gestion_fil})
      RETURNING idref_tarif`
    // An identity may hand back the id of a simulation the legacy deleted
    // without its lines (#1290): a new simulation starts empty.
    await t`DELETE FROM asso_fil_tarif WHERE idref_tarif = ${idref_tarif}`
    await t`DELETE FROM asso_traitement_tarif WHERE idref_tarif = ${idref_tarif}`
    for (const f of fils) {
      await t`
        INSERT INTO asso_fil_tarif (idref_tarif, idref_fil, idcolori_fil, pourcentage, prix_achat, prix)
        VALUES (${idref_tarif}, ${f.idref_fil}, ${f.idcolori_fil}, ${f.pourcentage}, ${f.prix_achat},
                ${money(f.prix_achat * (1 + v.frais_gestion_fil / 100))})`
    }
    for (const tid of traitements) {
      await t`
        INSERT INTO asso_traitement_tarif (idref_tarif, idtraitement, metrage, coeff, pv_calcule, pv_saisi)
        VALUES (${idref_tarif}, ${tid}, 0, 0, 0, 0)`
    }
    return Number(idref_tarif)
  })
}

// POST /api/tarifs-fini — create a simulation.
tarifsFiniRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = createBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const { mode, reference, source_id } = parsed.data
    const sql = mpsPg()
    let v: NewSimulation = { ...BLANK, reference }
    let fils: NewFil[] = []
    let traitements: number[] = []

    if (mode === 'duplicate') {
      if (!source_id) { res.status(400).json({ error: 'source_id required' }); return }
      const src = await loadRefTarifRow(sql, source_id)
      if (!src) { res.status(404).json({ error: 'Simulation source introuvable' }); return }
      const p = paramsOf(src)
      v = {
        ...v,
        commentaire: txt(src.commentaire) ?? '',
        laize: num4(src.laize),
        poids: num4(src.poids),
        rendement: p.rendement,
        freinte: num4(src.freinte),
        prix_tricotage: p.prix_tricotage,
        poids_rouleau: p.poids_rouleau,
        port_fixe: p.port_mode === 'kg' ? p.port_fixe : 0,
        port_pct: p.port_mode === 'pct' ? p.port_pct : 0,
        multiplicateur: p.multiplicateur,
        mult_auto: p.mult_auto ? 1 : 0,
        idteinture: p.IDteinture,
        gots: p.gots ? 1 : 0,
        ajust_ennoblissement: p.ajust_ennoblissement,
        frais_gestion_fil: p.frais_gestion_fil,
        // A copy keeps its source: it is the same study, another scenario.
        idref_fini: Number(src.idref_fini) || 0,
        idcoloris: Number(src.idcoloris) || 0,
        idclient: Number(src.idclient) || 0,
        idref_echantillon: Number(src.idref_echantillon) || 0,
      }
      fils = (await loadFils(sql, source_id)).map((f) => ({
        idref_fil: f.IDref_fil, idcolori_fil: f.IDcolori_fil, pourcentage: f.pourcentage, prix_achat: f.prix_achat,
      }))
      traitements = (await loadTraitements(sql, source_id)).map((t) => t.IDtraitement)
    } else if (mode === 'from_fini') {
      if (!source_id) { res.status(400).json({ error: 'source_id required' }); return }
      const IDcoloris = parsed.data.IDcoloris ?? 0
      if (IDcoloris <= 0) { res.status(400).json({ error: 'coloris_requis', message: 'Choisissez le coloris étudié.' }); return }
      const seed = await seedFromRefFini(sql, source_id, IDcoloris)
      if (!seed) { res.status(404).json({ error: 'Référence finie introuvable' }); return }
      v = { ...v, ...seed.v, idref_fini: source_id, idcoloris: IDcoloris, idclient: parsed.data.IDclient ?? 0 }
      fils = seed.fils
      traitements = seed.traitements
    } else if (mode === 'from_echantillon') {
      if (!source_id) { res.status(400).json({ error: 'source_id required' }); return }
      const seed = await seedFromEchantillon(sql, source_id)
      if (!seed) { res.status(404).json({ error: 'Échantillon introuvable' }); return }
      v = { ...v, ...seed.v }
      fils = seed.fils
    }

    const newId = await insertSimulation(sql, v, fils, traitements)
    res.status(201).json(await loadDetail(sql, newId))
  } catch (err) {
    console.error('Error creating ref_tarif:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// UPDATE / DELETE
// ──────────────────────────────────────────────────────────

const updateBody = paramsSchema.extend({
  reference: z.string().trim().min(1).max(120),
  commentaire: z.string().max(4000).optional(),
  laize: z.number().min(0).max(1000),
  poids: z.number().min(0).max(10000),
  freinte: z.number().min(0).max(1),
  /** The client the study compares with — only for a reference's study. */
  IDclient: z.number().int().min(0).optional(),
})

// PUT /api/tarifs-fini/:id — header + every lever.
tarifsFiniRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = idParam(req)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = updateBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    const sql = mpsPg()
    const row = await loadRefTarifRow(sql, id)
    if (!row) { res.status(404).json({ error: 'Simulation not found' }); return }
    // Only the column matching the port mode carries a value — the other is
    // zeroed so `portModeOf` reads back the same mode next time.
    const portFixe = d.port_mode === 'kg' ? d.port_fixe : 0
    const portPct = d.port_mode === 'pct' ? d.port_pct : 0
    const idClient = d.IDclient ?? (Number(row.idclient) || 0)
    await sql.begin(async (tx) => {
    const t = tx as unknown as Sql
      await t`
        UPDATE ref_tarif SET
          reference = ${d.reference}, commentaire = ${d.commentaire ?? ''},
          laize = ${d.laize}, poids = ${d.poids}, rendement = ${d.rendement}, freinte = ${d.freinte},
          prix_tricotage = ${d.prix_tricotage}, poids_rouleau = ${d.poids_rouleau},
          port_fixe = ${portFixe}, port_pct = ${portPct},
          multiplicateur = ${d.multiplicateur}, mult_auto = ${d.mult_auto ? 1 : 0},
          ajust_ennoblissement = ${d.ajust_ennoblissement}, frais_gestion_fil = ${d.frais_gestion_fil},
          gots = ${d.gots ? 1 : 0}, idteinture = ${d.IDteinture}, avec_teinture = ${d.IDteinture > 0 ? 1 : 0},
          idclient = ${idClient}
        WHERE idref_tarif = ${id}`
      // Keep the legacy `prix` of each line in step with the gestion rate.
      await t`
        UPDATE asso_fil_tarif SET prix = ROUND((prix_achat * (1 + ${d.frais_gestion_fil}::float8 / 100))::numeric, 2)
         WHERE idref_tarif = ${id}`
    })
    res.json(await loadDetail(sql, id))
  } catch (err) {
    console.error('Error updating ref_tarif:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/tarifs-fini/:id/archive — the En cours ↔ Archivée status pill.
tarifsFiniRouter.patch('/:id/archive', async (req: Request, res: Response) => {
  try {
    const id = idParam(req)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = z.object({ ok_tarif: z.number().int().min(0).max(1) }).safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed' }); return }
    const done = await mpsPg()`UPDATE ref_tarif SET ok_tarif = ${parsed.data.ok_tarif} WHERE idref_tarif = ${id}`
    if (done.count === 0) { res.status(404).json({ error: 'Simulation not found' }); return }
    res.json({ IDref_tarif: id, ok_tarif: parsed.data.ok_tarif })
  } catch (err) {
    console.error('Error archiving ref_tarif:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/tarifs-fini/:id — drops the simulation and both child tables.
tarifsFiniRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = idParam(req)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    await mpsPg().begin(async (tx) => {
    const t = tx as unknown as Sql
      await t`DELETE FROM asso_fil_tarif WHERE idref_tarif = ${id}`
      await t`DELETE FROM asso_traitement_tarif WHERE idref_tarif = ${id}`
      await t`DELETE FROM ref_tarif WHERE idref_tarif = ${id}`
    })
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
  /** Purchase €/Kg, without the frais de gestion. */
  prix_achat: z.number().min(0).max(100000),
})

/** The simulation's gestion rate, for the legacy `prix` kept on each line. */
async function fraisGestionOf(sql: Sql, id: number): Promise<number | null> {
  const [r] = await sql<{ frais_gestion_fil: number | null }[]>`
    SELECT frais_gestion_fil FROM ref_tarif WHERE idref_tarif = ${id}`
  return r ? num4(r.frais_gestion_fil ?? FRAIS_GESTION_FIL_PCT) : null
}

// POST /api/tarifs-fini/:id/fils
tarifsFiniRouter.post('/:id/fils', async (req: Request, res: Response) => {
  try {
    const id = idParam(req)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = filBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    const sql = mpsPg()
    const frais = await fraisGestionOf(sql, id)
    if (frais === null) { res.status(404).json({ error: 'Simulation not found' }); return }
    await sql`
      INSERT INTO asso_fil_tarif (idref_tarif, idref_fil, idcolori_fil, pourcentage, prix_achat, prix)
      VALUES (${id}, ${d.IDref_fil}, ${d.IDcolori_fil}, ${d.pourcentage}, ${d.prix_achat}, ${money(d.prix_achat * (1 + frais / 100))})`
    res.status(201).json(await loadFils(sql, id))
  } catch (err) {
    console.error('Error adding tarif fil line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/tarifs-fini/:id/fils/actualiser — every line back to today's
// purchase price from Fils › Références (the « prix fil du jour » of a study
// opened weeks ago).
tarifsFiniRouter.post('/:id/fils/actualiser', async (req: Request, res: Response) => {
  try {
    const id = idParam(req)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const sql = mpsPg()
    const frais = await fraisGestionOf(sql, id)
    if (frais === null) { res.status(404).json({ error: 'Simulation not found' }); return }
    const fils = await loadFils(sql, id)
    const achat = await prixAchatCatalogue(sql, fils.map((f) => ({ idref_fil: f.IDref_fil, idcolori_fil: f.IDcolori_fil })))
    await sql.begin(async (tx) => {
    const t = tx as unknown as Sql
      for (const f of fils) {
        const a = achat({ idref_fil: f.IDref_fil, idcolori_fil: f.IDcolori_fil })
        await t`UPDATE asso_fil_tarif SET prix_achat = ${a}, prix = ${money(a * (1 + frais / 100))}
                 WHERE idasso_fil_tarif = ${f.IDasso_fil_tarif}`
      }
    })
    res.json(await loadFils(sql, id))
  } catch (err) {
    console.error('Error refreshing tarif fil prices:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/tarifs-fini/:id/fils/:lineId — edit coloris / % / purchase price.
tarifsFiniRouter.put('/:id/fils/:lineId', async (req: Request, res: Response) => {
  try {
    const id = idParam(req)
    const lineId = idParam(req, 'lineId')
    if (!id || !lineId) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = filBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    const sql = mpsPg()
    const frais = (await fraisGestionOf(sql, id)) ?? FRAIS_GESTION_FIL_PCT
    // Scoped to the simulation: a line id from another one is a 404.
    const done = await sql`
      UPDATE asso_fil_tarif SET
        idref_fil = ${d.IDref_fil}, idcolori_fil = ${d.IDcolori_fil}, pourcentage = ${d.pourcentage},
        prix_achat = ${d.prix_achat}, prix = ${money(d.prix_achat * (1 + frais / 100))}
       WHERE idasso_fil_tarif = ${lineId} AND idref_tarif = ${id}`
    if (done.count === 0) { res.status(404).json({ error: 'Ligne introuvable' }); return }
    res.json(await loadFils(sql, id))
  } catch (err) {
    console.error('Error updating tarif fil line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/tarifs-fini/:id/fils/:lineId
tarifsFiniRouter.delete('/:id/fils/:lineId', async (req: Request, res: Response) => {
  try {
    const id = idParam(req)
    const lineId = idParam(req, 'lineId')
    if (!id || !lineId) { res.status(400).json({ error: 'Invalid ID' }); return }
    const sql = mpsPg()
    await sql`DELETE FROM asso_fil_tarif WHERE idasso_fil_tarif = ${lineId} AND idref_tarif = ${id}`
    res.json(await loadFils(sql, id))
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
    const id = idParam(req)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = z.object({ IDtraitement: z.number().int().positive() }).safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed' }); return }
    const sql = mpsPg()
    await sql`
      INSERT INTO asso_traitement_tarif (idref_tarif, idtraitement, metrage, coeff, pv_calcule, pv_saisi)
      VALUES (${id}, ${parsed.data.IDtraitement}, 0, 0, 0, 0)`
    res.status(201).json(await loadTraitements(sql, id))
  } catch (err) {
    console.error('Error adding tarif traitement:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/tarifs-fini/:id/traitements/:lineId
tarifsFiniRouter.delete('/:id/traitements/:lineId', async (req: Request, res: Response) => {
  try {
    const id = idParam(req)
    const lineId = idParam(req, 'lineId')
    if (!id || !lineId) { res.status(400).json({ error: 'Invalid ID' }); return }
    const sql = mpsPg()
    await sql`DELETE FROM asso_traitement_tarif WHERE idasso_traitement_tarif = ${lineId} AND idref_tarif = ${id}`
    res.json(await loadTraitements(sql, id))
  } catch (err) {
    console.error('Error deleting tarif traitement:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
