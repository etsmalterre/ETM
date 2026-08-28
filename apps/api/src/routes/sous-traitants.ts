import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { repairAliased, repairAllJoins } from './stock-fini.js'

// Gestion route for the `sous_traitant` entity (subcontractor management).
// Mirrors fournisseurs.ts (identical contacts/adresses sub-resource shape) with
// two differences: the domain-specific `IDtype_sst` (Tricoteur / Ennoblisseur /
// Autre / Confectionneur, catalog `type_sst`) and an editable `est_visible` flag.
// NOTE: `commande_sous_traitant` orders live on /api/commandes-sous-traitant.

export const sousTraitantsRouter: RouterType = Router()

interface SousTraitant {
  IDsous_traitant: number
  nom: string
  tel: string | null
  fax: string | null
  commentaire: string | null
  est_visible: number
  IDtype_sst: number | null
}

const TEXT_FIELDS = ['nom', 'tel', 'fax', 'commentaire']

const stBody = z.object({
  nom: z.string().min(1).max(100),
  tel: z.string().optional(),
  fax: z.string().optional(),
  commentaire: z.string().optional(),
  IDtype_sst: z.number().int().optional(),
  est_visible: z.union([z.boolean(), z.number()]).optional(),
})

/** Escape a string for use in SQL (single quotes doubled). ASCII-only path. */
function esc(value: string): string {
  return value.replace(/'/g, "''")
}

/**
 * Emit a text value as a SQL literal that is safe on BOTH the Windows `odbc`
 * driver and the Linux iODBC bridge. Raw multi-byte UTF-8 in a SQL string
 * desyncs the bridge ("string without end" → 500); HFSQL text columns are
 * Latin-1, so accented values are emitted as a hex literal of their Latin-1
 * bytes. ASCII values keep the normal quoted literal. (Canonical impl:
 * commandes-sous-traitant.ts → CLAUDE.md §"Encoding (writes)".)
 */
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

function intParam(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0
}

/** Map IDtype_sst → label. `type` is a reserved word (returns uppercased) so we
 * qualify + alias it; single-table CONVERT is bridge-safe (no JOIN collapse). */
async function loadTypeMap(): Promise<Map<number, string>> {
  const rows = await query<{ IDtype_sst: number; type_label: string | null }>(
    `SELECT ts.IDtype_sst, CONVERT(ts.type USING 'UTF-8') AS type_label FROM type_sst ts ORDER BY ts.IDtype_sst`,
  )
  const map = new Map<number, string>()
  for (const r of rows) map.set(Number(r.IDtype_sst), (r.type_label ?? '').toString().trim())
  return map
}

// GET /api/sous-traitants/type-sst — type catalog (declared before /:id)
sousTraitantsRouter.get('/type-sst', async (_req: Request, res: Response) => {
  try {
    const map = await loadTypeMap()
    res.json(Array.from(map.entries()).map(([IDtype_sst, type_label]) => ({ IDtype_sst, type_label })))
  } catch (err) {
    console.error('Error fetching type_sst:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/sous-traitants — list all (ordered by name, with type label)
sousTraitantsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const rows = await query<SousTraitant>('SELECT * FROM sous_traitant ORDER BY nom')
    const fixed = await fixEncoding(rows, 'sous_traitant', 'IDsous_traitant', TEXT_FIELDS)
    const types = await loadTypeMap()
    res.json(fixed.map((r: any) => ({ ...r, type_label: types.get(Number(r.IDtype_sst)) ?? null })))
  } catch (err) {
    console.error('Error fetching sous-traitants:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/sous-traitants/:id — detail with contacts + adresses
sousTraitantsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await query<SousTraitant>(`SELECT * FROM sous_traitant WHERE IDsous_traitant = ${id}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Sous-traitant not found' }); return }
    const fixed = await fixEncoding(rows, 'sous_traitant', 'IDsous_traitant', TEXT_FIELDS)

    const [adresses, contacts] = await Promise.all([
      query(`SELECT * FROM adresse WHERE IDsous_traitant = ${id} ORDER BY est_defaut DESC, IDadresse`),
      query(`SELECT * FROM contact WHERE IDsous_traitant = ${id} ORDER BY est_defaut DESC, IDcontact`),
    ])
    const fixedAdresses = await fixEncoding(adresses, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays', 'commentaire'])
    const fixedContacts = await fixEncoding(contacts, 'contact', 'IDcontact', ['nom', 'prenom', 'tel', 'mail', 'commentaire'])

    const types = await loadTypeMap()
    res.json({
      ...fixed[0],
      type_label: types.get(Number((fixed[0] as any).IDtype_sst)) ?? null,
      adresses: fixedAdresses,
      contacts: fixedContacts,
    })
  } catch (err) {
    console.error('Error fetching sous-traitant:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/sous-traitants/:id/rolls — fabric rolls physically located at this
// sous-traitant's site (its "magasin"). Used by the Gestion screen for
// ennoblisseur ssts to show what's on site: "tombé métier" (écru) rolls awaiting
// dyeing + finished (fini) rolls already produced and not yet shipped back.
//
// Location model: stock_ecru.IDmagasin / stock_fini.IDmagasin → sous_traitant.
// IDsous_traitant (same id space). IDmagasin is updated on physical transfer, so
// "= this sst" means "currently here".
//
//   - écru: stock_ecru.IDmagasin = sst, MINUS rolls already dyed into a fini (a
//     dyed roll keeps its écru row but also spawns a stock_fini row at the same
//     magasin — counting both would double-count it, so consumed écru are dropped).
//   - fini: stock_fini.IDmagasin = sst, hiding rolls already shipped
//     (IDligne_expedition set, or état 4 "Expédié").
sousTraitantsRouter.get('/:id/rolls', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // ── Écru ("tombé métier") rolls on site ──────────────
    // Explicit columns only (never `se.*` — Windows ODBC returns 0 rows for
    // alias.* in some shapes, and we keep all column names ASCII for the Linux
    // bridge). ref_ecru/colori_ecru references resolve via separate flat
    // queries + maps (avoids the JOIN+CONVERT result-set collapse footgun).
    const ecruRows = await query<{
      IDstock_ecru: number; numero: string | null; lot: string | null
      poids: number | null; metrage: number | null
      IDref_ecru: number | null; IDcolori_ecru: number | null
      date_saisie: string | null; second_choix: number | null
    }>(
      `SELECT IDstock_ecru, numero, lot, poids, metrage, IDref_ecru, IDcolori_ecru, date_saisie, second_choix
       FROM stock_ecru
       WHERE IDmagasin = ${id}
       ORDER BY date_saisie DESC, IDstock_ecru DESC`,
    )
    const ecruFixed = await fixEncoding(ecruRows, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot'])

    // Drop écru already consumed into a fini (dedup against the fini list).
    const ecruIds = ecruFixed.map((r) => Number(r.IDstock_ecru)).filter((n) => n > 0)
    const consumed = new Set<number>()
    if (ecruIds.length > 0) {
      const consumedRows = await query<{ IDstock_ecru: number }>(
        `SELECT IDstock_ecru FROM stock_fini WHERE IDstock_ecru IN (${ecruIds.join(',')})`,
      )
      for (const r of consumedRows) consumed.add(Number(r.IDstock_ecru))
    }
    const ecruLive = ecruFixed.filter((r) => !consumed.has(Number(r.IDstock_ecru)))

    // Resolve ref_ecru + colori_ecru labels (ASCII columns; batched lookups).
    const refEcruIds = Array.from(new Set(ecruLive.map((r) => Number(r.IDref_ecru)).filter((n) => n > 0)))
    const colEcruIds = Array.from(new Set(ecruLive.map((r) => Number(r.IDcolori_ecru)).filter((n) => n > 0)))
    const refEcruMap = new Map<number, string>()
    const colEcruMap = new Map<number, string>()
    if (refEcruIds.length > 0) {
      const r = await query<{ IDref_ecru: number; reference: string | null }>(
        `SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru IN (${refEcruIds.join(',')})`,
      )
      for (const x of await fixEncoding(r, 'ref_ecru', 'IDref_ecru', ['reference'])) refEcruMap.set(Number(x.IDref_ecru), (x.reference ?? '').toString().trim())
    }
    if (colEcruIds.length > 0) {
      const r = await query<{ IDcolori_ecru: number; reference: string | null }>(
        `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${colEcruIds.join(',')})`,
      )
      for (const x of await fixEncoding(r, 'colori_ecru', 'IDcolori_ecru', ['reference'])) colEcruMap.set(Number(x.IDcolori_ecru), (x.reference ?? '').toString().trim())
    }

    const ecru = ecruLive.map((r) => ({
      id: Number(r.IDstock_ecru),
      reference: refEcruMap.get(Number(r.IDref_ecru)) || null,
      coloris: colEcruMap.get(Number(r.IDcolori_ecru)) || null,
      lot: (r.lot ?? '').toString().trim() || null,
      numero: (r.numero ?? '').toString().trim() || null,
      poids: r.poids == null ? null : Number(r.poids),
      metrage: r.metrage == null ? null : Number(r.metrage),
      date_saisie: r.date_saisie ?? null,
      second_choix: Number(r.second_choix) || 0,
    }))

    // ── Fini rolls on site (not shipped) ─────────────────
    // Reuse the canonical stock_fini joins + accent repair so coloris obeys the
    // ref_fini.avec_teinture rule (0 = wash colori_ecru / 1·2 = dyed ref_fini_colori).
    const finiRows = await query<Record<string, unknown>>(
      `SELECT sf.IDstock_fini, sf.poids, sf.metrage, sf.lot, sf.numero, sf.date_saisie, sf.second_choix,
              sf.IDref_fini, sf.IDColoris, sf.IDetat_stock_fini,
              rf.reference AS ref_fini, rf.designation, rf.avec_teinture,
              rfc.reference AS coloris_dyed, ce.reference AS coloris_wash,
              esf.libelle AS etat_libelle
       FROM stock_fini sf
       LEFT JOIN ref_fini rf ON sf.IDref_fini = rf.IDref_fini
       LEFT JOIN ref_fini_colori rfc ON sf.IDColoris = rfc.IDref_fini_colori
       LEFT JOIN colori_ecru ce ON sf.IDColoris = ce.IDcolori_ecru
       LEFT JOIN etat_stock_fini esf ON sf.IDetat_stock_fini = esf.IDetat_stock_fini
       WHERE sf.IDmagasin = ${id}
         AND (sf.IDligne_expedition IS NULL OR sf.IDligne_expedition = 0)
         AND (sf.IDetat_stock_fini IS NULL OR sf.IDetat_stock_fini <> 4)
       ORDER BY sf.date_saisie DESC, sf.IDstock_fini DESC`,
    )
    let finiFixed = await repairAliased(finiRows, 'stock_fini', 'IDstock_fini', { lot: 'lot', numero: 'numero' })
    finiFixed = await repairAllJoins(finiFixed)

    const fini = finiFixed.map((r) => ({
      id: Number(r.IDstock_fini),
      reference: ((r as any).ref_fini ?? '').toString().trim() || null,
      designation: ((r as any).designation ?? '').toString().trim() || null,
      coloris: ((r as any).coloris_reference ?? '').toString().trim() || null,
      lot: ((r as any).lot ?? '').toString().trim() || null,
      numero: ((r as any).numero ?? '').toString().trim() || null,
      poids: (r as any).poids == null ? null : Number((r as any).poids),
      metrage: (r as any).metrage == null ? null : Number((r as any).metrage),
      date_saisie: (r as any).date_saisie ?? null,
      second_choix: Number((r as any).second_choix) || 0,
      etat_libelle: ((r as any).etat_libelle ?? '').toString().trim() || null,
    }))

    res.json({ ecru, fini })
  } catch (err) {
    console.error('Error fetching sous-traitant rolls:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/sous-traitants/:id/yarn-lots — yarn (fil) lots physically located at
// this sous-traitant's site. Used by the Gestion screen for tricoteur ssts to
// show what's on site: the yarn sent to them to knit, still holding stock.
//
// Location model: stock_fil.IDMagasin → sous_traitant.IDsous_traitant (same id
// space as stock_ecru/stock_fini, but note the capital M in IDMagasin). Only
// lots still holding stock (`stock > 0`) are "here" — a depleted lot is gone.
//
// Same Linux-bridge discipline as /rolls: explicit ASCII columns only (no
// `sf.*`, no accented identifiers), and ref_fil/colori_fil/fournisseur labels
// resolved via separate flat queries + maps (avoids the JOIN+CONVERT
// result-set collapse footgun).
sousTraitantsRouter.get('/:id/yarn-lots', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const lotRows = await query<{
      IDstock_fil: number; lot: string | null; lot_frs: string | null
      emplacement: string | null; stock: number | null; date_entree: string | null
      IDref_fil: number | null; IDcolori_fil: number | null; IDfournisseur: number | null
    }>(
      `SELECT IDstock_fil, lot, lot_frs, emplacement, stock, date_entree, IDref_fil, IDcolori_fil, IDfournisseur
       FROM stock_fil
       WHERE IDMagasin = ${id} AND stock > 0
       ORDER BY date_entree DESC, IDstock_fil DESC`,
    )
    const lotsFixed = await fixEncoding(lotRows, 'stock_fil', 'IDstock_fil', ['lot', 'lot_frs', 'emplacement'])

    // Resolve ref_fil + colori_fil + fournisseur labels (ASCII columns; batched).
    const refFilIds = Array.from(new Set(lotsFixed.map((r) => Number(r.IDref_fil)).filter((n) => n > 0)))
    const colFilIds = Array.from(new Set(lotsFixed.map((r) => Number(r.IDcolori_fil)).filter((n) => n > 0)))
    const frsIds = Array.from(new Set(lotsFixed.map((r) => Number(r.IDfournisseur)).filter((n) => n > 0)))
    const refFilMap = new Map<number, string>()
    const colFilMap = new Map<number, string>()
    const frsMap = new Map<number, string>()
    if (refFilIds.length > 0) {
      const r = await query<{ IDref_fil: number; reference: string | null }>(
        `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${refFilIds.join(',')})`,
      )
      for (const x of await fixEncoding(r, 'ref_fil', 'IDref_fil', ['reference'])) refFilMap.set(Number(x.IDref_fil), (x.reference ?? '').toString().trim())
    }
    if (colFilIds.length > 0) {
      const r = await query<{ IDcolori_fil: number; reference: string | null }>(
        `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${colFilIds.join(',')})`,
      )
      for (const x of await fixEncoding(r, 'colori_fil', 'IDcolori_fil', ['reference'])) colFilMap.set(Number(x.IDcolori_fil), (x.reference ?? '').toString().trim())
    }
    if (frsIds.length > 0) {
      const r = await query<{ IDfournisseur: number; nom: string | null }>(
        `SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur IN (${frsIds.join(',')})`,
      )
      for (const x of await fixEncoding(r, 'fournisseur', 'IDfournisseur', ['nom'])) frsMap.set(Number(x.IDfournisseur), (x.nom ?? '').toString().trim())
    }

    const lots = lotsFixed.map((r) => ({
      id: Number(r.IDstock_fil),
      reference: refFilMap.get(Number(r.IDref_fil)) || null,
      coloris: colFilMap.get(Number(r.IDcolori_fil)) || null,
      fournisseur: frsMap.get(Number(r.IDfournisseur)) || null,
      lot: (r.lot ?? '').toString().trim() || null,
      lot_frs: (r.lot_frs ?? '').toString().trim() || null,
      emplacement: (r.emplacement ?? '').toString().trim() || null,
      stock: r.stock == null ? null : Number(r.stock),
      date_entree: r.date_entree ?? null,
    }))

    res.json({ lots })
  } catch (err) {
    console.error('Error fetching sous-traitant yarn lots:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Ennoblisseur tariff catalog (`tranche_tarif_ennoblissement`)
//
// One row = one priced quantity band for one sous-traitant, discriminated into
// three "subject" kinds by which columns are set:
//   - dye base price      → IDteinture>0,  IDtraitement=0, ListeTraitements=''
//   - single treatment    → IDtraitement>0, IDteinture=0,  ListeTraitements=''
//   - combination bundle  → ListeTraitements='287,285', IDtraitement=0,
//                            IDteinture = dye context (0 = no dye)
//
// This is the exact table `pricing-sst.ts` reads, so edits flow straight into
// auto-pricing of NEW ennoblisseur order lines (existing lines are not
// retro-repriced — matches legacy). Table is 8 ASCII columns, PK
// auto-increments; combos are keyed on (IDteinture, sorted ListeTraitements)
// — the SAME treatment list under two different dyes is two distinct subjects.
// ─────────────────────────────────────────────────────────────────────────────

interface TarifBand {
  id: number
  quantite_mini: number
  quantite_maxi: number
  prix: number
}

/** Normalize a treatment-id list into the canonical ascending CSV the legacy
 *  stores (bare ids, no spaces). Dedupes and drops non-positive ids. */
function canonicalListe(ids: number[]): string {
  const set = new Set<number>()
  for (const v of ids) {
    const n = Math.trunc(Number(v))
    if (Number.isFinite(n) && n > 0) set.add(n)
  }
  return Array.from(set).sort((a, b) => a - b).join(',')
}

/** SQL predicate fragment selecting all sibling bands of one subject (same sst
 *  + same discriminator), so we can detect quantity-band overlaps. */
function subjectWhere(kind: 'dye' | 'treatment' | 'combination', d: { IDteinture: number; IDtraitement: number; liste: string }): string {
  if (kind === 'dye') return `IDteinture = ${d.IDteinture} AND IDtraitement = 0 AND ListeTraitements = ''`
  if (kind === 'treatment') return `IDtraitement = ${d.IDtraitement} AND IDteinture = 0 AND ListeTraitements = ''`
  return `IDteinture = ${d.IDteinture} AND IDtraitement = 0 AND ListeTraitements = '${esc(d.liste)}'`
}

/** True iff [aMin,aMax] and [bMin,bMax] intersect (inclusive). */
function overlaps(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin <= bMax && bMin <= aMax
}

const bandBody = z.object({
  kind: z.enum(['dye', 'treatment', 'combination']),
  IDteinture: z.number().int().optional(),
  IDtraitement: z.number().int().optional(),
  liste: z.array(z.number().int()).optional(),
  quantite_mini: z.number(),
  quantite_maxi: z.number(),
  prix: z.number(),
})

/** Resolve + validate the discriminator for a band body. Returns null + an
 *  error message when the body is inconsistent (e.g. combination with no
 *  treatments). */
function resolveDiscriminator(body: z.infer<typeof bandBody>):
  | { ok: true; IDteinture: number; IDtraitement: number; liste: string }
  | { ok: false; error: string } {
  if (body.kind === 'dye') {
    const t = Math.trunc(Number(body.IDteinture) || 0)
    if (!(t > 0)) return { ok: false, error: 'IDteinture requis pour une teinture' }
    return { ok: true, IDteinture: t, IDtraitement: 0, liste: '' }
  }
  if (body.kind === 'treatment') {
    const t = Math.trunc(Number(body.IDtraitement) || 0)
    if (!(t > 0)) return { ok: false, error: 'IDtraitement requis pour un traitement' }
    return { ok: true, IDteinture: 0, IDtraitement: t, liste: '' }
  }
  // combination
  const liste = canonicalListe(body.liste ?? [])
  if (liste === '') return { ok: false, error: 'Au moins un traitement requis pour une combinaison' }
  const t = Math.trunc(Number(body.IDteinture) || 0) // 0 = no dye context, allowed
  return { ok: true, IDteinture: t, IDtraitement: 0, liste }
}

/** Validate the quantity band itself (range sanity), returning an error string
 *  or null. */
function validateBandRange(mini: number, maxi: number, prix: number): string | null {
  if (!Number.isFinite(mini) || mini < 0) return 'Quantité minimum invalide'
  if (!Number.isFinite(maxi) || maxi < mini) return 'La quantité maximum doit être ≥ la quantité minimum'
  if (!Number.isFinite(prix) || prix < 0) return 'Prix invalide'
  return null
}

// GET /api/sous-traitants/:id/tarifs-ennoblissement — full grouped catalog for
// the sst: every dye + every treatment (with their bands, possibly empty) plus
// the combinations that exist. Catalogs are returned in full so an empty
// ennoblisseur can start building a tariff from scratch.
sousTraitantsRouter.get('/:id/tarifs-ennoblissement', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // 1) All tariff rows for this sst (8 ASCII columns, no accents → plain read).
    const rows = await query<{
      IDtranche_tarif_ennoblissement: number
      quantite_mini: number; quantite_maxi: number; prix: number
      IDtraitement: number; IDteinture: number; ListeTraitements: string | null
    }>(
      `SELECT IDtranche_tarif_ennoblissement, quantite_mini, quantite_maxi, prix, IDtraitement, IDteinture, ListeTraitements
       FROM tranche_tarif_ennoblissement
       WHERE IDsous_traitant = ${id}
       ORDER BY quantite_mini, quantite_maxi`,
    )

    // 2) Dye catalog (4 rows). designation_externe is unique + descriptive
    //    ("Coloration Double Teinture"); fall back to interne.
    const teintRows = await query<{ IDteinture: number; designation_interne: string | null; designation_externe: string | null }>(
      `SELECT IDteinture, designation_interne, designation_externe FROM teinture ORDER BY IDteinture`,
    )
    const teintFixed = await fixEncoding(teintRows, 'teinture', 'IDteinture', ['designation_interne', 'designation_externe'])
    const teintName = new Map<number, string>()
    for (const t of teintFixed) {
      teintName.set(Number(t.IDteinture), ((t.designation_externe || t.designation_interne) ?? '').toString().trim())
    }

    // 3) Treatment catalog (non-deleted), ordered by legacy `ordre`.
    const trtRows = await query<{ IDtraitement: number; designation: string | null; ordre: number | null }>(
      `SELECT IDtraitement, designation, ordre FROM traitement WHERE is_deleted = 0 ORDER BY ordre, IDtraitement`,
    )
    const trtFixed = await fixEncoding(trtRows, 'traitement', 'IDtraitement', ['designation'])
    const trtName = new Map<number, string>()
    for (const t of trtFixed) trtName.set(Number(t.IDtraitement), (t.designation ?? '').toString().trim())

    // 4) Partition rows by kind, grouping bands under each subject.
    const dyeBands = new Map<number, TarifBand[]>()
    const trtBands = new Map<number, TarifBand[]>()
    const comboMap = new Map<string, { IDteinture: number; liste: string; bands: TarifBand[] }>()
    for (const r of rows) {
      const band: TarifBand = {
        id: Number(r.IDtranche_tarif_ennoblissement),
        quantite_mini: Number(r.quantite_mini) || 0,
        quantite_maxi: Number(r.quantite_maxi) || 0,
        prix: Number(r.prix) || 0,
      }
      const liste = (r.ListeTraitements ?? '').toString().trim()
      const teint = Number(r.IDteinture) || 0
      const trt = Number(r.IDtraitement) || 0
      if (liste !== '') {
        const canon = canonicalListe(liste.split(',').map((s) => Number(s)))
        const key = `${teint}|${canon}`
        const entry = comboMap.get(key) ?? { IDteinture: teint, liste: canon, bands: [] }
        entry.bands.push(band)
        comboMap.set(key, entry)
      } else if (teint > 0 && trt === 0) {
        const arr = dyeBands.get(teint) ?? []
        arr.push(band)
        dyeBands.set(teint, arr)
      } else if (trt > 0) {
        const arr = trtBands.get(trt) ?? []
        arr.push(band)
        trtBands.set(trt, arr)
      }
    }

    const teintures = teintFixed.map((t) => ({
      IDteinture: Number(t.IDteinture),
      designation: teintName.get(Number(t.IDteinture)) || `Teinture #${t.IDteinture}`,
      bands: dyeBands.get(Number(t.IDteinture)) ?? [],
    }))

    const traitements = trtFixed.map((t) => ({
      IDtraitement: Number(t.IDtraitement),
      designation: trtName.get(Number(t.IDtraitement)) || `Traitement #${t.IDtraitement}`,
      ordre: Number(t.ordre) || 0,
      bands: trtBands.get(Number(t.IDtraitement)) ?? [],
    }))

    const combinaisons = Array.from(comboMap.entries()).map(([key, c]) => ({
      key,
      IDteinture: c.IDteinture,
      teinture_nom: c.IDteinture > 0 ? (teintName.get(c.IDteinture) || `Teinture #${c.IDteinture}`) : null,
      liste: c.liste,
      traitements: c.liste.split(',').filter(Boolean).map((s) => {
        const tid = Number(s)
        return { IDtraitement: tid, designation: trtName.get(tid) || `Traitement #${tid}` }
      }),
      bands: c.bands.sort((a, b) => a.quantite_mini - b.quantite_mini),
    }))

    res.json({ teintures, traitements, combinaisons })
  } catch (err) {
    console.error('Error fetching ennoblisseur tariffs:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/sous-traitants/:id/tarifs-ennoblissement — create one quantity band
// (also the way a new combination is born: kind='combination' + liste).
sousTraitantsRouter.post('/:id/tarifs-ennoblissement', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = bandBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues }); return }

    const disc = resolveDiscriminator(parsed.data)
    if (!disc.ok) { res.status(400).json({ error: disc.error }); return }
    const mini = Math.trunc(parsed.data.quantite_mini)
    const maxi = Math.trunc(parsed.data.quantite_maxi)
    const prix = Number(parsed.data.prix)
    const rangeErr = validateBandRange(mini, maxi, prix)
    if (rangeErr) { res.status(400).json({ error: rangeErr }); return }

    // Overlap guard within the subject.
    const siblings = await query<{ quantite_mini: number; quantite_maxi: number }>(
      `SELECT quantite_mini, quantite_maxi FROM tranche_tarif_ennoblissement
       WHERE IDsous_traitant = ${id} AND ${subjectWhere(parsed.data.kind, disc)}`,
    )
    if (siblings.some((s) => overlaps(mini, maxi, Number(s.quantite_mini) || 0, Number(s.quantite_maxi) || 0))) {
      res.status(409).json({ error: 'Cette tranche chevauche une tranche existante' }); return
    }

    await query(
      `INSERT INTO tranche_tarif_ennoblissement (IDsous_traitant, IDteinture, IDtraitement, ListeTraitements, quantite_mini, quantite_maxi, prix)
       VALUES (${id}, ${disc.IDteinture}, ${disc.IDtraitement}, '${esc(disc.liste)}', ${mini}, ${maxi}, ${prix})`,
    )
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('Error creating ennoblisseur tariff band:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/sous-traitants/:id/tarifs-ennoblissement/:trancheId — update a band's
// quantity range / price (not its subject membership — that's the combinaison
// endpoint below for combos).
sousTraitantsRouter.put('/:id/tarifs-ennoblissement/:trancheId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const trancheId = parseInt(req.params.trancheId, 10)
    if (isNaN(id) || isNaN(trancheId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const schema = z.object({ quantite_mini: z.number(), quantite_maxi: z.number(), prix: z.number() })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues }); return }
    const mini = Math.trunc(parsed.data.quantite_mini)
    const maxi = Math.trunc(parsed.data.quantite_maxi)
    const prix = Number(parsed.data.prix)
    const rangeErr = validateBandRange(mini, maxi, prix)
    if (rangeErr) { res.status(400).json({ error: rangeErr }); return }

    // Scope + read the band's own discriminator so we can find its siblings.
    const owns = await query<{ IDteinture: number; IDtraitement: number; ListeTraitements: string | null }>(
      `SELECT IDteinture, IDtraitement, ListeTraitements FROM tranche_tarif_ennoblissement
       WHERE IDtranche_tarif_ennoblissement = ${trancheId} AND IDsous_traitant = ${id}`,
    )
    if (owns.length === 0) { res.status(404).json({ error: 'Tranche introuvable' }); return }
    const row = owns[0]
    const liste = (row.ListeTraitements ?? '').toString().trim()
    const kind: 'dye' | 'treatment' | 'combination' = liste !== '' ? 'combination' : (Number(row.IDtraitement) > 0 ? 'treatment' : 'dye')
    const disc = { IDteinture: Number(row.IDteinture) || 0, IDtraitement: Number(row.IDtraitement) || 0, liste }

    const siblings = await query<{ quantite_mini: number; quantite_maxi: number }>(
      `SELECT quantite_mini, quantite_maxi FROM tranche_tarif_ennoblissement
       WHERE IDsous_traitant = ${id} AND ${subjectWhere(kind, disc)}
         AND IDtranche_tarif_ennoblissement <> ${trancheId}`,
    )
    if (siblings.some((s) => overlaps(mini, maxi, Number(s.quantite_mini) || 0, Number(s.quantite_maxi) || 0))) {
      res.status(409).json({ error: 'Cette tranche chevauche une tranche existante' }); return
    }

    await query(
      `UPDATE tranche_tarif_ennoblissement SET quantite_mini = ${mini}, quantite_maxi = ${maxi}, prix = ${prix}
       WHERE IDtranche_tarif_ennoblissement = ${trancheId} AND IDsous_traitant = ${id}`,
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating ennoblisseur tariff band:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/sous-traitants/:id/tarifs-ennoblissement/:trancheId — remove a band.
sousTraitantsRouter.delete('/:id/tarifs-ennoblissement/:trancheId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const trancheId = parseInt(req.params.trancheId, 10)
    if (isNaN(id) || isNaN(trancheId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await query(
      `DELETE FROM tranche_tarif_ennoblissement
       WHERE IDtranche_tarif_ennoblissement = ${trancheId} AND IDsous_traitant = ${id}`,
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting ennoblisseur tariff band:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/sous-traitants/:id/tarifs-ennoblissement/combinaison — re-scope an
// existing combination: rewrite IDteinture + ListeTraitements across ALL its
// bands at once. Identified by its old (IDteinture, liste) discriminator.
sousTraitantsRouter.put('/:id/tarifs-ennoblissement/combinaison/rescope', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    const schema = z.object({
      old_IDteinture: z.number().int(),
      old_liste: z.array(z.number().int()),
      new_IDteinture: z.number().int(),
      new_liste: z.array(z.number().int()),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues }); return }
    const oldListe = canonicalListe(parsed.data.old_liste)
    const newListe = canonicalListe(parsed.data.new_liste)
    if (newListe === '') { res.status(400).json({ error: 'Au moins un traitement requis' }); return }
    const oldTeint = Math.trunc(parsed.data.old_IDteinture) || 0
    const newTeint = Math.trunc(parsed.data.new_IDteinture) || 0

    if (oldTeint === newTeint && oldListe === newListe) { res.json({ ok: true }); return }

    // Prevent merging into another existing subject (would risk band overlaps).
    const collision = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tranche_tarif_ennoblissement
       WHERE IDsous_traitant = ${id} AND IDtraitement = 0
         AND IDteinture = ${newTeint} AND ListeTraitements = '${esc(newListe)}'`,
    )
    if (Number(collision[0]?.n) > 0) {
      res.status(409).json({ error: 'Une combinaison identique existe déjà' }); return
    }

    await query(
      `UPDATE tranche_tarif_ennoblissement
       SET IDteinture = ${newTeint}, ListeTraitements = '${esc(newListe)}'
       WHERE IDsous_traitant = ${id} AND IDtraitement = 0
         AND IDteinture = ${oldTeint} AND ListeTraitements = '${esc(oldListe)}'`,
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error re-scoping ennoblisseur combination:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/sous-traitants/:id/tarifs-ennoblissement/copier — seed this sst's
// catalog from another sous-traitant (or the IDsous_traitant=0 default
// catalog). Refuses if the target already has rows unless overwrite=true (which
// clears the target first). Bootstraps the 9 ennoblisseurs that have no catalog.
sousTraitantsRouter.post('/:id/tarifs-ennoblissement/copier', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    const schema = z.object({ sourceId: z.number().int(), overwrite: z.boolean().optional() })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues }); return }
    const sourceId = Math.trunc(parsed.data.sourceId)
    if (sourceId === id) { res.status(400).json({ error: 'Source et destination identiques' }); return }

    const existing = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tranche_tarif_ennoblissement WHERE IDsous_traitant = ${id}`,
    )
    if (Number(existing[0]?.n) > 0) {
      if (!parsed.data.overwrite) { res.status(409).json({ error: 'Ce sous-traitant possède déjà des tarifs' }); return }
      await query(`DELETE FROM tranche_tarif_ennoblissement WHERE IDsous_traitant = ${id}`)
    }

    const src = await query<{
      quantite_mini: number; quantite_maxi: number; prix: number
      IDtraitement: number; IDteinture: number; ListeTraitements: string | null
    }>(
      `SELECT quantite_mini, quantite_maxi, prix, IDtraitement, IDteinture, ListeTraitements
       FROM tranche_tarif_ennoblissement WHERE IDsous_traitant = ${sourceId}`,
    )
    for (const r of src) {
      const liste = (r.ListeTraitements ?? '').toString().trim()
      await query(
        `INSERT INTO tranche_tarif_ennoblissement (IDsous_traitant, IDteinture, IDtraitement, ListeTraitements, quantite_mini, quantite_maxi, prix)
         VALUES (${id}, ${Number(r.IDteinture) || 0}, ${Number(r.IDtraitement) || 0}, '${esc(liste)}', ${Math.trunc(Number(r.quantite_mini)) || 0}, ${Math.trunc(Number(r.quantite_maxi)) || 0}, ${Number(r.prix) || 0})`,
      )
    }
    res.json({ ok: true, copied: src.length })
  } catch (err) {
    console.error('Error copying ennoblisseur tariffs:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/sous-traitants — create (placeholder row, then auto-edit on the client)
sousTraitantsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = stBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const { nom, tel, fax, commentaire, IDtype_sst } = parsed.data
    await query(
      `INSERT INTO sous_traitant (nom, tel, fax, commentaire, est_visible, IDtype_sst) VALUES (${sqlText(nom)}, ${sqlText(tel ?? '')}, ${sqlText(fax ?? '')}, ${sqlText(commentaire ?? '')}, 1, ${intParam(IDtype_sst)})`,
    )
    // HFSQL has no RETURNING — fetch the just-inserted row back by name.
    const rows = await query<SousTraitant>(`SELECT * FROM sous_traitant WHERE nom = ${sqlText(nom)} ORDER BY IDsous_traitant DESC`)
    const fixed = await fixEncoding(rows, 'sous_traitant', 'IDsous_traitant', TEXT_FIELDS)
    res.status(201).json(fixed[0] ?? { nom, tel: tel ?? null, fax: fax ?? null, commentaire: commentaire ?? null })
  } catch (err) {
    console.error('Error creating sous-traitant:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/sous-traitants/:id — update header (name, coordonnées, type, visibility, notes)
sousTraitantsRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = stBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const { nom, tel, fax, commentaire, IDtype_sst, est_visible } = parsed.data
    const visible = est_visible === undefined ? 1 : est_visible ? 1 : 0
    await query(
      `UPDATE sous_traitant SET nom = ${sqlText(nom)}, tel = ${sqlText(tel ?? '')}, fax = ${sqlText(fax ?? '')}, commentaire = ${sqlText(commentaire ?? '')}, IDtype_sst = ${intParam(IDtype_sst)}, est_visible = ${visible} WHERE IDsous_traitant = ${id}`,
    )
    const rows = await query<SousTraitant>(`SELECT * FROM sous_traitant WHERE IDsous_traitant = ${id}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Sous-traitant not found' }); return }
    const fixed = await fixEncoding(rows, 'sous_traitant', 'IDsous_traitant', TEXT_FIELDS)
    res.json(fixed[0])
  } catch (err) {
    console.error('Error updating sous-traitant:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/sous-traitants/:id
sousTraitantsRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const rows = await query<SousTraitant>(`SELECT * FROM sous_traitant WHERE IDsous_traitant = ${id}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Sous-traitant not found' }); return }
    await query(`DELETE FROM sous_traitant WHERE IDsous_traitant = ${id}`)
    res.json({ message: 'Deleted', data: rows[0] })
  } catch (err) {
    console.error('Error deleting sous-traitant:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Contacts CRUD (FK contact.IDsous_traitant) ───────────

sousTraitantsRouter.post('/:id/contacts', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const { nom, prenom, tel, mail, envoi_bl, envoi_bt, envoi_facture, envoi_commande, envoi_soumission } = req.body
    await query(
      `INSERT INTO contact (IDsous_traitant, nom, prenom, tel, mail, envoi_bl, envoi_bt, envoi_facture, envoi_commande, envoi_soumission, est_defaut, est_visible) VALUES (${id}, ${sqlText(nom ?? '')}, ${sqlText(prenom ?? '')}, ${sqlText(tel ?? '')}, ${sqlText(mail ?? '')}, ${envoi_bl ? 1 : 0}, ${envoi_bt ? 1 : 0}, ${envoi_facture ? 1 : 0}, ${envoi_commande ? 1 : 0}, ${envoi_soumission ? 1 : 0}, 0, 1)`,
    )
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('Error creating contact:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

sousTraitantsRouter.put('/:id/contacts/:cid', async (req: Request, res: Response) => {
  try {
    const cid = parseInt(req.params.cid, 10)
    if (isNaN(cid)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const { nom, prenom, tel, mail, envoi_bl, envoi_bt, envoi_facture, envoi_commande, envoi_soumission } = req.body
    await query(
      `UPDATE contact SET nom = ${sqlText(nom ?? '')}, prenom = ${sqlText(prenom ?? '')}, tel = ${sqlText(tel ?? '')}, mail = ${sqlText(mail ?? '')}, envoi_bl = ${envoi_bl ? 1 : 0}, envoi_bt = ${envoi_bt ? 1 : 0}, envoi_facture = ${envoi_facture ? 1 : 0}, envoi_commande = ${envoi_commande ? 1 : 0}, envoi_soumission = ${envoi_soumission ? 1 : 0} WHERE IDcontact = ${cid}`,
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating contact:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

sousTraitantsRouter.delete('/:id/contacts/:cid', async (req: Request, res: Response) => {
  try {
    const cid = parseInt(req.params.cid, 10)
    if (isNaN(cid)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await query(`DELETE FROM contact WHERE IDcontact = ${cid}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting contact:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Adresses CRUD (FK adresse.IDsous_traitant) ───────────

sousTraitantsRouter.post('/:id/adresses', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const { nom, adresse1, adresse2, adresse3, cp, ville, pays, commentaire, est_defaut_facturation, est_defaut_livraison } = req.body
    await query(
      `INSERT INTO adresse (IDsous_traitant, nom, adresse1, adresse2, adresse3, cp, ville, pays, commentaire, est_defaut, est_defaut_facturation, est_defaut_livraison, est_visible) VALUES (${id}, ${sqlText(nom ?? '')}, ${sqlText(adresse1 ?? '')}, ${sqlText(adresse2 ?? '')}, ${sqlText(adresse3 ?? '')}, ${sqlText(cp ?? '')}, ${sqlText(ville ?? '')}, ${sqlText(pays ?? '')}, ${sqlText(commentaire ?? '')}, 0, ${est_defaut_facturation ? 1 : 0}, ${est_defaut_livraison ? 1 : 0}, 1)`,
    )
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('Error creating adresse:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

sousTraitantsRouter.put('/:id/adresses/:aid', async (req: Request, res: Response) => {
  try {
    const aid = parseInt(req.params.aid, 10)
    if (isNaN(aid)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const { nom, adresse1, adresse2, adresse3, cp, ville, pays, commentaire, est_defaut_facturation, est_defaut_livraison } = req.body
    await query(
      `UPDATE adresse SET nom = ${sqlText(nom ?? '')}, adresse1 = ${sqlText(adresse1 ?? '')}, adresse2 = ${sqlText(adresse2 ?? '')}, adresse3 = ${sqlText(adresse3 ?? '')}, cp = ${sqlText(cp ?? '')}, ville = ${sqlText(ville ?? '')}, pays = ${sqlText(pays ?? '')}, commentaire = ${sqlText(commentaire ?? '')}, est_defaut_facturation = ${est_defaut_facturation ? 1 : 0}, est_defaut_livraison = ${est_defaut_livraison ? 1 : 0} WHERE IDadresse = ${aid}`,
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating adresse:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

sousTraitantsRouter.delete('/:id/adresses/:aid', async (req: Request, res: Response) => {
  try {
    const aid = parseInt(req.params.aid, 10)
    if (isNaN(aid)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await query(`DELETE FROM adresse WHERE IDadresse = ${aid}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting adresse:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
