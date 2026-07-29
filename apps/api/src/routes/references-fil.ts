import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, fixEncoding } from '../lib/hfsql-auto.js'

export const referencesFilRouter: RouterType = Router()

// ref_fil.recyclé and every asso_fil_matiere column is accented. Follow the
// stock.ts pattern: branch on platform for writes, normalise reads via a
// post-processor so HTTP payloads only ever contain ASCII keys.
const IS_WINDOWS = process.platform === 'win32'

/** Escape a string for use in SQL (single quotes doubled) */
function esc(value: string): string {
  return value.replace(/'/g, "''")
}

/** SQL literal for user-supplied text written to an HFSQL column. ASCII values
 *  use a normal quoted literal; accented / non-ASCII values are emitted as a
 *  Latin-1 hex literal `x'<bytes>'`, because raw multi-byte UTF-8 embedded in a
 *  SQL line corrupts the Linux iODBC bridge (→ [HY090] / "string without end").
 *  HFSQL text columns are Latin-1; reads keep going through fixEncoding/CONVERT.
 *  Mirrors sqlText() in commandes-sous-traitant.ts (see CLAUDE.md HFSQL rules). */
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

/** Coerce a possibly-nullable numeric value (string | number | null) to number | null. */
function toNumOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Normalise a ref_fil row: map recyclé (any shape) → recycle. */
function normalizeRefFilRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  if (out.recycle === undefined) {
    out.recycle = (row as any)['recyclé'] ?? (row as any).recycl ?? 0
  }
  delete out['recyclé']
  delete out.recycl
  out.recycle = Number(out.recycle) || 0
  out.bio = Number(out.bio) || 0
  return out
}

/**
 * Normalise an asso_fil_matiere row. The accented columns (IDasso_fil_matière,
 * IDMatière, recyclé) come back from the Linux ODBC driver under a mangled key
 * (truncated/altered at the accent — exact shape varies), so resolve each by a
 * case-insensitive prefix regex rather than a hardcoded fallback list.
 */
function normalizeAssoFilMatiereRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    IDasso_fil_matiere: Number(pickKey(row, /^idasso_fil_mat/i) ?? 0),
    IDRef_fil: Number(pickKey(row, /^idref_fil/i) ?? 0),
    IDmatiere: Number(pickKey(row, /^idmat/i) ?? 0),
    pourcentage: toNumOrNull(pickKey(row, /^pourcentage/i)),
    bio: Number(pickKey(row, /^bio/i)) || 0,
    recycle: Number(pickKey(row, /^recyc/i)) || 0,
  }
}

interface MatiereLookup {
  IDmatiere_premiere: number
  libelle: string | null
}

/** Value of the first row key matching `re`. The Linux HFSQL ODBC path returns
 *  accented identifiers truncated at the first accent (IDmatière_première →
 *  IDmati), so we can't hardcode the key — resolve it dynamically. */
function pickKey(row: Record<string, unknown>, re: RegExp): unknown {
  const k = Object.keys(row).find((key) => re.test(key))
  return k === undefined ? undefined : row[k]
}

/** Normalise a matiere_premiere row: IDmatière_première (any shape) → IDmatiere_premiere. */
function normalizeMatiereRow(row: Record<string, unknown>): MatiereLookup {
  return {
    IDmatiere_premiere: Number(pickKey(row, /^idmati/i) ?? 0),
    libelle: ((row as any).libelle ?? null) as string | null,
  }
}

/** Repair U+FFFD glyphs in matiere_premiere.libelle WITHOUT naming the accented
 *  PK. The usual `WHERE pk IN (…)` CONVERT batch is impossible here — the only
 *  key is IDmatière_première, which can't appear in a Linux query — and naming a
 *  non-existent ASCII column would risk a bridge respawn storm. Instead we
 *  CONVERT every label in this tiny static table at once, then match each corrupt
 *  label to its fixed twin positionally (one accent → one length-preserving
 *  U+FFFD). Leaves the corrupt value in place if no unambiguous match is found. */
async function repairMatiereLabels(rows: MatiereLookup[]): Promise<MatiereLookup[]> {
  if (!rows.some((r) => typeof r.libelle === 'string' && r.libelle.includes('�'))) return rows
  let fixedLabels: string[] = []
  try {
    const conv = await query<{ libelle: unknown }>(
      `SELECT CONVERT(libelle USING 'UTF-8') AS libelle FROM matiere_premiere`,
    )
    fixedLabels = conv
      .map((c) => (typeof c.libelle === 'string' ? c.libelle : ''))
      .filter((s) => s.length > 0 && !s.includes('�'))
  } catch {
    return rows
  }
  const matches = (corrupt: string, fixed: string): boolean =>
    corrupt.length === fixed.length &&
    [...corrupt].every((ch, i) => ch === '�' || ch === fixed[i])
  for (const r of rows) {
    if (typeof r.libelle === 'string' && r.libelle.includes('�')) {
      const m = fixedLabels.find((f) => matches(r.libelle as string, f))
      if (m) r.libelle = m
    }
  }
  return rows
}

/** Load all matieres with resolved ASCII id + accent-repaired libelle. Shared by
 *  the lookup endpoint and the composition-detail enrich. */
async function loadMatieres(): Promise<MatiereLookup[]> {
  const rows = await query(`SELECT * FROM matiere_premiere`)
  const normalised = rows.map((r) => normalizeMatiereRow(r as Record<string, unknown>))
  return repairMatiereLabels(normalised)
}

// ──────────────────────────────────────────────────────────
// LOOKUPS
// ──────────────────────────────────────────────────────────

// GET /api/references-fil/lookups/matieres
referencesFilRouter.get('/lookups/matieres', async (_req: Request, res: Response) => {
  try {
    const normalised = await loadMatieres()
    // Sort by libelle
    normalised.sort((a, b) => String(a.libelle ?? '').localeCompare(String(b.libelle ?? '')))
    res.json(normalised)
  } catch (err) {
    console.error('Error fetching matieres lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/references-fil/lookups/unites-titrage
referencesFilRouter.get('/lookups/unites-titrage', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDunite_titrage: number; nomenclature: string | null }>(
      `SELECT IDunite_titrage, nomenclature FROM unite_titrage ORDER BY IDunite_titrage`,
    )
    const fixed = await fixEncoding(rows, 'unite_titrage', 'IDunite_titrage', ['nomenclature'])
    res.json(fixed)
  } catch (err) {
    console.error('Error fetching unites-titrage lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// LIST
// ──────────────────────────────────────────────────────────

// GET /api/references-fil — list of ref_fil with summary columns
referencesFilRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const refRows = await query(`SELECT * FROM ref_fil ORDER BY reference`)
    let refs = refRows.map((r) => normalizeRefFilRow(r as Record<string, unknown>))
    refs = await fixEncoding(refs as any, 'ref_fil', 'IDref_fil', ['reference', 'commentaire']) as any

    if (refs.length === 0) {
      res.json([])
      return
    }

    // Batched summary: variant count + distinct supplier count per ref_fil
    const variantCountRows = await query<{ IDref_fil: number; n: number }>(
      `SELECT IDref_fil, COUNT(*) AS n FROM colori_fil GROUP BY IDref_fil`,
    )
    const variantsByRef = new Map<number, number>()
    for (const r of variantCountRows) variantsByRef.set(Number(r.IDref_fil), Number(r.n))

    const supplierCountRows = await query<{ IDref_fil: number; n: number }>(
      `SELECT cf.IDref_fil AS IDref_fil, COUNT(DISTINCT a.IDfournisseur) AS n FROM asso_colorisfil_frs a JOIN colori_fil cf ON a.IDcolori_fil = cf.IDcolori_fil GROUP BY cf.IDref_fil`,
    )
    const suppliersByRef = new Map<number, number>()
    for (const r of supplierCountRows) suppliersByRef.set(Number(r.IDref_fil), Number(r.n))

    const out = refs.map((r: any) => ({
      ...r,
      variantes_count: variantsByRef.get(Number(r.IDref_fil)) ?? 0,
      fournisseurs_count: suppliersByRef.get(Number(r.IDref_fil)) ?? 0,
    }))

    res.json(out)
  } catch (err) {
    console.error('Error fetching ref_fil list:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// DETAIL
// ──────────────────────────────────────────────────────────

// GET /api/references-fil/:id
referencesFilRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // Base row
    const rows = await query(`SELECT * FROM ref_fil WHERE IDref_fil = ${id}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Ref fil not found' }); return }
    let refNormalised = normalizeRefFilRow(rows[0] as Record<string, unknown>)
    const refFixed = await fixEncoding(
      [refNormalised] as any,
      'ref_fil',
      'IDref_fil',
      ['reference', 'commentaire'],
    ) as any
    refNormalised = refFixed[0]

    // Variantes — colori_fil is all ASCII. NB: colori_fil.IDfournisseur is
    // misleading legacy data (see project memory). Real fournisseur↔coloris
    // links live in asso_colorisfil_frs and are loaded below.
    const varianteRows = await query(
      `SELECT IDcolori_fil, IDref_fil, reference, prix_kg, stock_mini, commentaire FROM colori_fil WHERE IDref_fil = ${id} ORDER BY reference`,
    )
    const variantesFixed = await fixEncoding(
      varianteRows as any,
      'colori_fil',
      'IDcolori_fil',
      ['reference', 'commentaire'],
    )

    // For each variante, load the linked fournisseurs via asso_colorisfil_frs
    // (one batched query joined against fournisseur for the names).
    const coloriIds = variantesFixed.map((v: any) => Number(v.IDcolori_fil)).filter(Boolean)
    const fournisseursByVariante = new Map<
      number,
      Array<{ IDfournisseur: number; nom: string | null }>
    >()
    if (coloriIds.length > 0) {
      const linkRows = await query<{
        IDcolori_fil: number
        IDfournisseur: number
        nom: string | null
      }>(
        `SELECT a.IDcolori_fil, a.IDfournisseur, f.nom
           FROM asso_colorisfil_frs a
           JOIN fournisseur f ON a.IDfournisseur = f.IDfournisseur
          WHERE a.IDcolori_fil IN (${coloriIds.join(',')})
          ORDER BY f.nom`,
      )
      const fixedLinks = await fixEncoding(linkRows as any, 'fournisseur', 'IDfournisseur', ['nom'])
      for (const r of fixedLinks as any[]) {
        const key = Number(r.IDcolori_fil)
        const arr = fournisseursByVariante.get(key) ?? []
        arr.push({ IDfournisseur: Number(r.IDfournisseur), nom: r.nom ?? null })
        fournisseursByVariante.set(key, arr)
      }
    }
    const variantes = variantesFixed.map((v: any) => {
      const frs = fournisseursByVariante.get(Number(v.IDcolori_fil)) ?? []
      return {
        IDcolori_fil: Number(v.IDcolori_fil),
        IDref_fil: Number(v.IDref_fil),
        reference: v.reference ?? null,
        prix_kg: toNumOrNull(v.prix_kg),
        stock_mini: toNumOrNull(v.stock_mini),
        commentaire: v.commentaire ?? null,
        fournisseurs_count: frs.length,
        fournisseurs: frs,
      }
    })

    // Composition — asso_fil_matiere (accented columns). SELECT * and normalise.
    const assoRows = await query(`SELECT * FROM asso_fil_matiere WHERE IDRef_fil = ${id}`)
    const assoNormalised = assoRows.map((r) => normalizeAssoFilMatiereRow(r as Record<string, unknown>))

    // Enrich each composition row with the matiere libelle
    const matiereIds = Array.from(new Set(assoNormalised.map((a: any) => a.IDmatiere).filter((n: number) => n > 0)))
    const matiereLabelByld = new Map<number, string>()
    if (matiereIds.length > 0) {
      const matNormalised = await loadMatieres()
      for (const m of matNormalised) {
        matiereLabelByld.set(Number(m.IDmatiere_premiere), String(m.libelle ?? ''))
      }
    }
    const composition = assoNormalised.map((a: any) => ({
      ...a,
      matiere_libelle: matiereLabelByld.get(Number(a.IDmatiere)) ?? null,
    }))

    // Aggregated stock (kg) across all variants, in-progress lots only.
    // stock_fil.terminé is accented — we SELECT all stock rows for this
    // ref_fil and filter termine in JS (same approach as stock.ts list).
    // Always query, even when there are no variantes — stock_fil rows can
    // exist with IDcolori_fil = 0 or pointing at a since-deleted coloris,
    // and the aggregate total/lot count must include them.
    let stockTotalKg = 0
    let stockLots = 0
    const stockPerVariante = new Map<number, { total_kg: number; lots: number }>()
    const stockRows = await query(`SELECT * FROM stock_fil WHERE IDref_fil = ${id}`)
    for (const sr of stockRows) {
      const r = sr as any
      const termine = Number(r['terminé'] ?? r.termin ?? 0)
      if (termine !== 0) continue
      const coloriId = Number(r.IDcolori_fil)
      const kg = Number(r.stock) || 0
      stockTotalKg += kg
      stockLots += 1
      if (coloriId > 0) {
        const cur = stockPerVariante.get(coloriId) ?? { total_kg: 0, lots: 0 }
        cur.total_kg += kg
        cur.lots += 1
        stockPerVariante.set(coloriId, cur)
      }
    }

    // Commande history: every ref_fil_commande line for this ref, joined to
    // its parent commande_fil (no etat filter — both en cours and terminée
    // appear), to fournisseur for display, and to colori_fil for the
    // ordered variant. Ordered most-recent-first.
    const orderRows = await query<{
      IDref_fil_commande: number
      IDcommande_fil: number
      quantite: number
      prix_unitaire: number | null
      IDcolori_fil: number
      colori_reference: string | null
      date_commande: string | null
      etat_cmd: number
      IDfournisseur: number
      fournisseur_nom: string | null
    }>(
      `SELECT rfc.IDref_fil_commande, rfc.IDcommande_fil, rfc.quantite, rfc.prix_unitaire, rfc.IDcolori_fil, col.reference AS colori_reference, cmd.date_commande, cmd.etat AS etat_cmd, cmd.IDfournisseur, f.nom AS fournisseur_nom
       FROM ref_fil_commande rfc
       JOIN commande_fil cmd ON rfc.IDcommande_fil = cmd.IDcommande_fil
       LEFT JOIN fournisseur f ON cmd.IDfournisseur = f.IDfournisseur
       LEFT JOIN colori_fil col ON rfc.IDcolori_fil = col.IDcolori_fil
       WHERE rfc.IDref_fil = ${id}
       ORDER BY cmd.date_commande DESC, rfc.IDref_fil_commande DESC`,
    )
    const orderRowsFournisseurFixed = await fixEncoding(orderRows, 'fournisseur', 'IDfournisseur', ['fournisseur_nom'])
    const orderRowsFixed = await fixEncoding(orderRowsFournisseurFixed, 'colori_fil', 'IDcolori_fil', ['colori_reference'])
    const commandeHistory = orderRowsFixed.map((r) => ({
      IDref_fil_commande: Number(r.IDref_fil_commande),
      IDcommande_fil: Number(r.IDcommande_fil),
      quantite: Number(r.quantite) || 0,
      prix_unitaire: toNumOrNull(r.prix_unitaire),
      IDcolori_fil: Number(r.IDcolori_fil) || 0,
      colori_reference: r.colori_reference ?? null,
      date_commande: r.date_commande ?? null,
      etat: Number(r.etat_cmd) || 0,
      IDfournisseur: Number(r.IDfournisseur) || 0,
      fournisseur_nom: r.fournisseur_nom ?? null,
    }))
    const commandeTotalKg = commandeHistory.reduce((sum, r) => sum + r.quantite, 0)
    const commandeLignes = commandeHistory.length

    // Distinct fournisseurs across all variants (read-only list for sidebar)
    let fournisseurs: Array<{ IDfournisseur: number; nom: string | null }> = []
    if (coloriIds.length > 0) {
      const frsRows = await query<{ IDfournisseur: number; nom: string | null }>(
        `SELECT DISTINCT f.IDfournisseur, f.nom FROM asso_colorisfil_frs a JOIN fournisseur f ON a.IDfournisseur = f.IDfournisseur WHERE a.IDcolori_fil IN (${coloriIds.join(',')}) ORDER BY f.nom`,
      )
      fournisseurs = await fixEncoding(frsRows, 'fournisseur', 'IDfournisseur', ['nom'])
    }

    const stockPerVarianteArr = Array.from(stockPerVariante.entries()).map(([IDcolori_fil, v]) => ({
      IDcolori_fil,
      total_kg: v.total_kg,
      lots: v.lots,
    }))

    // Offer history: every offre_fil row for this ref, joined to fournisseur
    // and (optional) colori_fil. Newest first by stored DATE (YYYYMMDD).
    const offreRows = await query<{
      IDoffre_fil: number
      IDfournisseur: number
      fournisseur_nom: string | null
      IDcolori_fil: number
      colori_reference: string | null
      prix: number | null
      quantite: number | null
      DATE: string | null
      observation: string | null
    }>(
      `SELECT o.IDoffre_fil, o.IDfournisseur, f.nom AS fournisseur_nom,
              o.IDcolori_fil, col.reference AS colori_reference,
              o.prix, o.quantite, o.DATE, o.observation
         FROM offre_fil o
         LEFT JOIN fournisseur f ON o.IDfournisseur = f.IDfournisseur
         LEFT JOIN colori_fil col ON o.IDcolori_fil = col.IDcolori_fil
        WHERE o.IDref_fil = ${id}
        ORDER BY o.DATE DESC, o.IDoffre_fil DESC`,
    )
    const offreFrsFixed = await fixEncoding(offreRows, 'fournisseur', 'IDfournisseur', ['fournisseur_nom'])
    const offreColFixed = await fixEncoding(offreFrsFixed, 'colori_fil', 'IDcolori_fil', ['colori_reference'])
    const offreFinal = await fixEncoding(offreColFixed, 'offre_fil', 'IDoffre_fil', ['observation'])
    const offres = offreFinal.map((r: any) => ({
      IDoffre_fil: Number(r.IDoffre_fil),
      IDfournisseur: Number(r.IDfournisseur) || 0,
      fournisseur_nom: r.fournisseur_nom ?? null,
      IDcolori_fil: Number(r.IDcolori_fil) || 0,
      colori_reference: r.colori_reference ?? null,
      prix: toNumOrNull(r.prix),
      quantite: toNumOrNull(r.quantite),
      date: r.DATE ?? null,
      observation: r.observation ?? null,
    }))

    res.json({
      ...refNormalised,
      variantes,
      composition,
      stock_total_kg: stockTotalKg,
      stock_lots: stockLots,
      stock_per_variante: stockPerVarianteArr,
      commande_total_kg: commandeTotalKg,
      commande_lignes: commandeLignes,
      commande_history: commandeHistory,
      offres,
      fournisseurs,
    })
  } catch (err) {
    console.error('Error fetching ref_fil detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// REF_FIL CRUD
// ──────────────────────────────────────────────────────────

const refFilBody = z.object({
  reference: z.string().min(1).max(100),
  commentaire: z.string().optional().nullable(),
  prix_kg: z.number().optional().nullable(),
  titrage: z.number().optional().nullable(),
  nb_fil: z.number().optional().nullable(),
  nb_brin: z.number().optional().nullable(),
  IDunite_titrage: z.number().optional().nullable(),
  bio: z.boolean().optional(),
  recycle: z.boolean().optional(),
})

function buildRefFilSets(body: z.infer<typeof refFilBody>): string[] {
  const sets: string[] = []
  sets.push(`reference = ${sqlText(body.reference)}`)
  sets.push(`commentaire = ${sqlText(body.commentaire ?? '')}`)
  sets.push(`prix_kg = ${body.prix_kg ?? 0}`)
  sets.push(`titrage = ${body.titrage ?? 0}`)
  sets.push(`nb_fil = ${body.nb_fil ?? 0}`)
  sets.push(`nb_brin = ${body.nb_brin ?? 0}`)
  sets.push(`IDunite_titrage = ${body.IDunite_titrage ?? 0}`)
  sets.push(`bio = ${body.bio ? 1 : 0}`)
  // recyclé is accented — Windows only. On Linux the set is skipped.
  if (IS_WINDOWS) sets.push(`recyclé = ${body.recycle ? 1 : 0}`)
  return sets
}

// ── GET /api/references-fil/:id/utilisation?colori=<id> ──────────────
// "Utilisation fil" — port of the legacy FI_Utilisation_fil.wdw dashboard
// panel: which écru references are knitted from this yarn?
//
// The link is `composition_ecru` (IDref_ecru × IDcolori_ecru × IDref_fil ×
// IDcolori_fil × pourcentage). Two things about its shape drive this endpoint:
//
//  • A reference's composition is stored once per écru coloris, PLUS a base row
//    at `IDcolori_ecru = 0`. Those base rows generally carry `IDcolori_fil = 0`
//    ("this ref uses this yarn, no particular yarn coloris"). So filtering by a
//    yarn coloris legitimately returns FEWER refs than the unfiltered list —
//    verified against the legacy screen: 28 refs for 1/28 COTON PEIGNE BIO Z,
//    23 once "ecru" is picked.
//  • `colori_fil` re-uses the same name across many rows — that one yarn has
//    NINE coloris called "ecru", of which only one is referenced by any
//    composition. Picking by id would silently return nothing, so the coloris
//    list is grouped BY NAME and the filter expands the chosen name back to
//    every id carrying it. `colori` takes the group's representative id.
//
// Archived références are included, exactly as legacy does (its list shows
// archived 181/183), but flagged so the caller can mark them.
referencesFilRouter.get('/:id/utilisation', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' }); return
  }
  const coloriParam = parseInt(String(req.query.colori ?? ''), 10)
  const wantColori = Number.isInteger(coloriParam) && coloriParam > 0 ? coloriParam : null

  try {
    const filRows = await query<{ IDref_fil: number; reference: string | null }>(
      `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil = ${id}`,
    )
    if (filRows.length === 0) { res.status(404).json({ error: 'ref_fil not found' }); return }
    const filFixed = (await fixEncoding(filRows as any[], 'ref_fil', 'IDref_fil', ['reference'])) as any[]

    // Flat queries + merge in JS: a JOIN carrying CONVERT() collapses the
    // result set on the bridge (see CLAUDE.md HFSQL rules).
    const comps = await query<{
      IDref_ecru: number; IDcolori_fil: number; pourcentage: number | null
    }>(
      `SELECT IDref_ecru, IDcolori_fil, pourcentage FROM composition_ecru WHERE IDref_fil = ${id}`,
    )

    // ── Coloris groups, by NAME ──
    const coloriIds = Array.from(new Set(comps.map((c) => Number(c.IDcolori_fil)).filter((x) => x > 0)))
    const coloriName = new Map<number, string>()
    if (coloriIds.length > 0) {
      const cRows = await query<{ IDcolori_fil: number; reference: string | null }>(
        `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${coloriIds.join(',')})`,
      )
      for (const c of await fixEncoding(cRows as any[], 'colori_fil', 'IDcolori_fil', ['reference'])) {
        coloriName.set(Number((c as any).IDcolori_fil), ((c as any).reference ?? '').toString().trim())
      }
    }
    // name → { ids, distinct ref_ecru count }. A coloris row that no longer
    // exists in colori_fil (deleted) has no name and is not offered.
    const groups = new Map<string, { ids: number[]; refs: Set<number> }>()
    for (const c of comps) {
      const cid = Number(c.IDcolori_fil)
      const nom = coloriName.get(cid)
      if (!nom) continue
      const g = groups.get(nom) ?? { ids: [], refs: new Set<number>() }
      if (!g.ids.includes(cid)) g.ids.push(cid)
      g.refs.add(Number(c.IDref_ecru))
      groups.set(nom, g)
    }
    const coloris = [...groups]
      .map(([nom, g]) => ({ id: Math.min(...g.ids), nom, ids: g.ids, refs: g.refs.size }))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr', { numeric: true, sensitivity: 'base' }))

    // ── Apply the coloris filter (expanded to every id sharing the name) ──
    let selected: { id: number; nom: string } | null = null
    let scoped = comps
    if (wantColori !== null) {
      const group = coloris.find((g) => g.ids.includes(wantColori))
      if (group) {
        selected = { id: group.id, nom: group.nom }
        const idSet = new Set(group.ids)
        scoped = comps.filter((c) => idSet.has(Number(c.IDcolori_fil)))
      }
    }

    // ── Resolve the écru references ──
    const ecruIds = Array.from(new Set(scoped.map((c) => Number(c.IDref_ecru)).filter((x) => x > 0)))
    let rows: Array<{
      IDref_ecru: number; reference: string; designation: string
      archived: boolean; pourcentage: number | null
    }> = []
    if (ecruIds.length > 0) {
      // SELECT * rather than naming `archivé`: the column is accented, and
      // naming it storms the Linux bridge. The key comes back truncated there,
      // so read it tolerantly.
      const eRows = await query<Record<string, unknown>>(
        `SELECT * FROM ref_ecru WHERE IDref_ecru IN (${ecruIds.join(',')})`,
      )
      const shaped = eRows.map((r) => ({
        IDref_ecru: Number(r.IDref_ecru) || 0,
        reference: ((r.reference ?? '') as string) || '',
        designation: ((r.designation ?? '') as string) || '',
        archived: Number(r['archivé'] ?? (r as Record<string, unknown>).archiv ?? 0) === 1,
      }))
      const eFixed = (await fixEncoding(
        shaped, 'ref_ecru', 'IDref_ecru', ['reference', 'designation'],
      )) as any[]

      // Highest percentage across this ref's rows for the yarn — a ref can name
      // the same yarn on several of its coloris at different shares.
      const pctByRef = new Map<number, number>()
      for (const c of scoped) {
        const p = c.pourcentage == null ? null : Number(c.pourcentage)
        if (p == null || !Number.isFinite(p) || p <= 0) continue
        const k = Number(c.IDref_ecru)
        pctByRef.set(k, Math.max(pctByRef.get(k) ?? 0, p))
      }

      rows = eFixed
        .map((r) => ({
          IDref_ecru: Number(r.IDref_ecru),
          reference: (r.reference ?? '').toString().trim(),
          designation: (r.designation ?? '').toString().trim(),
          archived: !!r.archived,
          pourcentage: pctByRef.get(Number(r.IDref_ecru)) ?? null,
        }))
        .filter((r) => r.reference.length > 0)
        .sort((a, b) => a.reference.localeCompare(b.reference, 'fr', { numeric: true }))
    }

    res.json({
      ref_fil: {
        IDref_fil: Number(filFixed[0].IDref_fil),
        reference: ((filFixed[0].reference ?? '') as string).toString().trim(),
      },
      coloris,
      selected_coloris: selected,
      /** Distinct refs ignoring the coloris filter — lets the UI say what the
       *  filter is hiding instead of the count silently shrinking. */
      total_refs: new Set(comps.map((c) => Number(c.IDref_ecru))).size,
      rows,
    })
  } catch (err) {
    console.error('Error computing utilisation fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/references-fil
referencesFilRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = refFilBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const b = parsed.data

    // Build column list — exclude recyclé on Linux
    const cols = ['reference', 'commentaire', 'prix_kg', 'titrage', 'nb_fil', 'nb_brin', 'IDunite_titrage', 'bio']
    const vals: string[] = [
      sqlText(b.reference),
      sqlText(b.commentaire ?? ''),
      String(b.prix_kg ?? 0),
      String(b.titrage ?? 0),
      String(b.nb_fil ?? 0),
      String(b.nb_brin ?? 0),
      String(b.IDunite_titrage ?? 0),
      String(b.bio ? 1 : 0),
    ]
    if (IS_WINDOWS) {
      cols.push('recyclé')
      vals.push(String(b.recycle ? 1 : 0))
    }
    await query(`INSERT INTO ref_fil (${cols.join(', ')}) VALUES (${vals.join(', ')})`)

    // HFSQL has no RETURNING — fetch back by reference + latest id
    const rows = await query<{ IDref_fil: number }>(
      `SELECT IDref_fil FROM ref_fil WHERE reference = ${sqlText(b.reference)} ORDER BY IDref_fil DESC`,
    )
    const newId = rows[0]?.IDref_fil ?? null
    res.status(201).json({ IDref_fil: newId })
  } catch (err) {
    console.error('Error creating ref_fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/references-fil/:id
referencesFilRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = refFilBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const sets = buildRefFilSets(parsed.data)
    await query(`UPDATE ref_fil SET ${sets.join(', ')} WHERE IDref_fil = ${id}`)
    res.json({ ok: true, _linux_recycle_skipped: !IS_WINDOWS })
  } catch (err) {
    console.error('Error updating ref_fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-fil/:id — guarded
referencesFilRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // Guard: no variantes
    const variantes = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM colori_fil WHERE IDref_fil = ${id}`,
    )
    if (Number(variantes[0]?.n ?? 0) > 0) {
      res.status(409).json({ error: 'Cette référence possède encore des variantes de coloris.' })
      return
    }
    // Guard: no stock_fil rows
    const stock = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stock_fil WHERE IDref_fil = ${id}`,
    )
    if (Number(stock[0]?.n ?? 0) > 0) {
      res.status(409).json({ error: 'Cette référence est utilisée par des lots de stock.' })
      return
    }
    // Guard: no ref_fil_commande rows
    const orders = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ref_fil_commande WHERE IDref_fil = ${id}`,
    )
    if (Number(orders[0]?.n ?? 0) > 0) {
      res.status(409).json({ error: 'Cette référence est utilisée par des commandes en cours ou passées.' })
      return
    }
    await query(`DELETE FROM ref_fil WHERE IDref_fil = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting ref_fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// VARIANTES (colori_fil) — all ASCII columns
// ──────────────────────────────────────────────────────────

const varianteBody = z.object({
  reference: z.string().min(1).max(100),
  prix_kg: z.number().optional().nullable(),
  stock_mini: z.number().optional().nullable(),
  commentaire: z.string().optional().nullable(),
})

// POST /api/references-fil/:id/variantes
referencesFilRouter.post('/:id/variantes', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = varianteBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const b = parsed.data
    // NB: colori_fil.IDfournisseur is deprecated legacy metadata — fournisseur
    // links go into asso_colorisfil_frs via /:id/variantes/:coloriId/fournisseurs.
    await query(
      `INSERT INTO colori_fil (IDref_fil, reference, prix_kg, stock_mini, commentaire) VALUES (${id}, ${sqlText(b.reference)}, ${b.prix_kg ?? 0}, ${b.stock_mini ?? 0}, ${sqlText(b.commentaire ?? '')})`,
    )
    // Fetch the new id — match by (IDref_fil, reference) and take the latest
    const rows = await query<{ IDcolori_fil: number }>(
      `SELECT IDcolori_fil FROM colori_fil WHERE IDref_fil = ${id} AND reference = ${sqlText(b.reference)} ORDER BY IDcolori_fil DESC`,
    )
    const newId = rows[0]?.IDcolori_fil ?? null
    res.status(201).json({ IDcolori_fil: newId })
  } catch (err) {
    console.error('Error creating colori_fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/references-fil/:id/variantes/:coloriId
referencesFilRouter.put('/:id/variantes/:coloriId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const coloriId = parseInt(req.params.coloriId, 10)
    if (isNaN(id) || isNaN(coloriId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // Scope guard: the variante must belong to this ref
    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM colori_fil WHERE IDcolori_fil = ${coloriId} AND IDref_fil = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) {
      res.status(404).json({ error: 'Variante not found for this reference' })
      return
    }

    const parsed = varianteBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const b = parsed.data
    await query(
      `UPDATE colori_fil SET reference = ${sqlText(b.reference)}, prix_kg = ${b.prix_kg ?? 0}, stock_mini = ${b.stock_mini ?? 0}, commentaire = ${sqlText(b.commentaire ?? '')} WHERE IDcolori_fil = ${coloriId}`,
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating colori_fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-fil/:id/variantes/:coloriId — guarded
referencesFilRouter.delete('/:id/variantes/:coloriId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const coloriId = parseInt(req.params.coloriId, 10)
    if (isNaN(id) || isNaN(coloriId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // Scope guard
    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM colori_fil WHERE IDcolori_fil = ${coloriId} AND IDref_fil = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) {
      res.status(404).json({ error: 'Variante not found for this reference' })
      return
    }
    // Guard: no stock_fil
    const stock = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stock_fil WHERE IDcolori_fil = ${coloriId}`,
    )
    if (Number(stock[0]?.n ?? 0) > 0) {
      res.status(409).json({ error: 'Cette variante est utilisée par des lots de stock.' })
      return
    }
    // Guard: no ref_fil_commande
    const orders = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ref_fil_commande WHERE IDcolori_fil = ${coloriId}`,
    )
    if (Number(orders[0]?.n ?? 0) > 0) {
      res.status(409).json({ error: 'Cette variante est utilisée par des commandes.' })
      return
    }
    // Guard: no asso_colorisfil_frs
    const linked = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM asso_colorisfil_frs WHERE IDcolori_fil = ${coloriId}`,
    )
    if (Number(linked[0]?.n ?? 0) > 0) {
      res.status(409).json({ error: 'Cette variante est encore liée à un ou plusieurs fournisseurs.' })
      return
    }
    await query(`DELETE FROM colori_fil WHERE IDcolori_fil = ${coloriId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting colori_fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// VARIANTE ↔ FOURNISSEUR links (asso_colorisfil_frs)
// ──────────────────────────────────────────────────────────
// The M:N join between colori_fil and fournisseur. POST is idempotent
// (skips if already linked). DELETE is scoped to the parent ref so a
// stray coloriId from another reference can't be touched via this URL.

// Helper: validate that the coloris belongs to the ref AND the fournisseur
// exists. Returns null on success, or an Express response error on failure.
async function verifyVarianteFournisseurScope(
  refId: number,
  coloriId: number,
  fournisseurId: number,
): Promise<{ status: number; error: string } | null> {
  if (!Number.isFinite(refId) || refId <= 0) return { status: 400, error: 'Invalid ref id' }
  if (!Number.isFinite(coloriId) || coloriId <= 0) return { status: 400, error: 'Invalid coloris id' }
  if (!Number.isFinite(fournisseurId) || fournisseurId <= 0) {
    return { status: 400, error: 'Invalid fournisseur id' }
  }
  const variante = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM colori_fil WHERE IDcolori_fil = ${coloriId} AND IDref_fil = ${refId}`,
  )
  if (Number(variante[0]?.n ?? 0) === 0) {
    return { status: 404, error: 'Variante not found for this reference' }
  }
  const frs = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM fournisseur WHERE IDfournisseur = ${fournisseurId}`,
  )
  if (Number(frs[0]?.n ?? 0) === 0) {
    return { status: 404, error: 'Fournisseur not found' }
  }
  return null
}

// POST /api/references-fil/:id/variantes/:coloriId/fournisseurs/:fournisseurId
referencesFilRouter.post(
  '/:id/variantes/:coloriId/fournisseurs/:fournisseurId',
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10)
      const coloriId = parseInt(req.params.coloriId, 10)
      const fournisseurId = parseInt(req.params.fournisseurId, 10)

      const scopeError = await verifyVarianteFournisseurScope(id, coloriId, fournisseurId)
      if (scopeError) {
        res.status(scopeError.status).json({ error: scopeError.error })
        return
      }

      // Idempotent — skip if the link already exists
      const existing = await query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM asso_colorisfil_frs WHERE IDcolori_fil = ${coloriId} AND IDfournisseur = ${fournisseurId}`,
      )
      if (Number(existing[0]?.n ?? 0) === 0) {
        await query(
          `INSERT INTO asso_colorisfil_frs (IDfournisseur, IDcolori_fil) VALUES (${fournisseurId}, ${coloriId})`,
        )
      }
      res.status(201).json({ ok: true })
    } catch (err) {
      console.error('Error linking fournisseur to variante:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// DELETE /api/references-fil/:id/variantes/:coloriId/fournisseurs/:fournisseurId
referencesFilRouter.delete(
  '/:id/variantes/:coloriId/fournisseurs/:fournisseurId',
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10)
      const coloriId = parseInt(req.params.coloriId, 10)
      const fournisseurId = parseInt(req.params.fournisseurId, 10)

      const scopeError = await verifyVarianteFournisseurScope(id, coloriId, fournisseurId)
      if (scopeError) {
        res.status(scopeError.status).json({ error: scopeError.error })
        return
      }

      await query(
        `DELETE FROM asso_colorisfil_frs WHERE IDcolori_fil = ${coloriId} AND IDfournisseur = ${fournisseurId}`,
      )
      res.json({ ok: true })
    } catch (err) {
      console.error('Error unlinking fournisseur from variante:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ──────────────────────────────────────────────────────────
// OFFRE_FIL — supplier price quotes per ref_fil
// ──────────────────────────────────────────────────────────
// Employees record price quotes received from suppliers so the team has a
// running picture of the market. unite=1 corresponds to €/kg in legacy data
// and is hardcoded for new rows (only value ever observed in production).

const offreFilBody = z.object({
  IDfournisseur: z.number().int().positive(),
  IDcolori_fil: z.number().int().nonnegative().optional(),
  prix: z.number().nonnegative(),
  quantite: z.number().nonnegative().optional(),
  date: z.string().regex(/^\d{8}$/), // YYYYMMDD
  observation: z.string().max(500).optional(),
})

// POST /api/references-fil/:id/offres
referencesFilRouter.post('/:id/offres', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = offreFilBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const b = parsed.data

    // Scope guard: ref must exist
    const ref = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ref_fil WHERE IDref_fil = ${id}`,
    )
    if (Number(ref[0]?.n ?? 0) === 0) {
      res.status(404).json({ error: 'Reference not found' })
      return
    }
    // Scope guard: if a coloris is specified, it must belong to this ref
    if (b.IDcolori_fil && b.IDcolori_fil > 0) {
      const col = await query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM colori_fil WHERE IDcolori_fil = ${b.IDcolori_fil} AND IDref_fil = ${id}`,
      )
      if (Number(col[0]?.n ?? 0) === 0) {
        res.status(400).json({ error: 'Coloris does not belong to this reference' })
        return
      }
    }
    const frs = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM fournisseur WHERE IDfournisseur = ${b.IDfournisseur}`,
    )
    if (Number(frs[0]?.n ?? 0) === 0) {
      res.status(404).json({ error: 'Fournisseur not found' })
      return
    }

    await query(
      `INSERT INTO offre_fil (IDref_fil, IDfournisseur, IDcolori_fil, prix, unite, quantite, DATE, observation)
       VALUES (${id}, ${b.IDfournisseur}, ${b.IDcolori_fil ?? 0}, ${b.prix}, 1, ${b.quantite ?? 0}, '${esc(b.date)}', ${sqlText(b.observation ?? '')})`,
    )
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('Error creating offre_fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-fil/:id/offres/:offreId
referencesFilRouter.delete('/:id/offres/:offreId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const offreId = parseInt(req.params.offreId, 10)
    if (isNaN(id) || isNaN(offreId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // Scope guard: offre must belong to this ref
    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM offre_fil WHERE IDoffre_fil = ${offreId} AND IDref_fil = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) {
      res.status(404).json({ error: 'Offre not found for this reference' })
      return
    }
    await query(`DELETE FROM offre_fil WHERE IDoffre_fil = ${offreId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting offre_fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// COMPOSITION (asso_fil_matiere)
// ──────────────────────────────────────────────────────────
// asso_fil_matiere has accented column names — IDasso_fil_matière (PK),
// IDMatière (FK), recyclé. The HFSQL Linux ODBC driver cannot resolve an
// accented identifier when it is NAMED in a query: it truncates the token at
// the first accent and HFSQL reports "item unknown" (verified on prod — even
// sending the é as a raw Latin-1 byte is truncated by the driver itself, so the
// "Latin-1 transport" idea does not help). So on Linux we NEVER name those
// columns:
//   • reads     — SELECT * (driver returns truncated keys; normalizeAssoFilMatiereRow maps them)
//   • inserts   — positional `VALUES (...)` in physical column order
//                 [IDasso_fil_matière, IDMatière, IDRef_fil, pourcentage, bio, recyclé].
//                 The PK does NOT auto-assign on a positional insert (an explicit
//                 0 is stored verbatim), so we compute max(existing)+1.
//   • edit/del  — can't target the accented PK in a WHERE, so we delete the ref's
//                 whole set via the ASCII IDRef_fil column and re-insert the
//                 surviving/edited rows, preserving their original PK values.
// Windows keeps the simpler named-column path.

const compositionBody = z.object({
  IDmatiere: z.number().int().positive(),
  pourcentage: z.number().min(0).max(100),
  bio: z.boolean().optional(),
  recycle: z.boolean().optional(),
})

interface CompoRow {
  IDasso_fil_matiere: number
  IDmatiere: number
  pourcentage: number
  bio: number
  recycle: number
}

/** Read a ref's composition rows (works on both platforms via SELECT *). */
async function readCompoRows(refId: number): Promise<CompoRow[]> {
  const rows = await query(`SELECT * FROM asso_fil_matiere WHERE IDRef_fil = ${refId}`)
  return rows.map((r) => {
    const n = normalizeAssoFilMatiereRow(r as Record<string, unknown>) as any
    return {
      IDasso_fil_matiere: Number(n.IDasso_fil_matiere) || 0,
      IDmatiere: Number(n.IDmatiere) || 0,
      pourcentage: Number(n.pourcentage) || 0,
      bio: Number(n.bio) ? 1 : 0,
      recycle: Number(n.recycle) ? 1 : 0,
    }
  })
}

/** Next PK across the whole table + 1 (Linux positional inserts don't auto-assign
 *  and MAX() can't name the accented PK, so scan via SELECT *). */
async function nextAssoId(): Promise<number> {
  const rows = await query(`SELECT * FROM asso_fil_matiere`)
  let max = 0
  for (const r of rows) {
    const id = Number((normalizeAssoFilMatiereRow(r as Record<string, unknown>) as any).IDasso_fil_matiere) || 0
    if (id > max) max = id
  }
  return max + 1
}

/** Positional insert in physical column order (Linux-safe — names no column). */
async function insertCompoRowPositional(
  pk: number,
  refId: number,
  row: { IDmatiere: number; pourcentage: number; bio: number; recycle: number },
): Promise<void> {
  await query(
    `INSERT INTO asso_fil_matiere VALUES (${pk}, ${row.IDmatiere}, ${refId}, ${row.pourcentage}, ${row.bio ? 1 : 0}, ${row.recycle ? 1 : 0})`,
  )
}

/** Replace a ref's whole composition set: delete via ASCII IDRef_fil, then
 *  positional re-insert (PK values preserved). Best-effort restore on failure. */
async function replaceCompoRows(refId: number, rows: CompoRow[]): Promise<void> {
  const original = await readCompoRows(refId)
  await query(`DELETE FROM asso_fil_matiere WHERE IDRef_fil = ${refId}`)
  try {
    for (const row of rows) await insertCompoRowPositional(row.IDasso_fil_matiere, refId, row)
  } catch (err) {
    try {
      await query(`DELETE FROM asso_fil_matiere WHERE IDRef_fil = ${refId}`)
      for (const row of original) await insertCompoRowPositional(row.IDasso_fil_matiere, refId, row)
    } catch {
      /* best-effort restore only */
    }
    throw err
  }
}

// POST /api/references-fil/:id/compositions
referencesFilRouter.post('/:id/compositions', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = compositionBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const b = parsed.data
    let newId: number | null
    if (IS_WINDOWS) {
      // Accented column names work directly on Windows; PK auto-assigns.
      await query(
        `INSERT INTO asso_fil_matiere (IDRef_fil, IDMatière, pourcentage, bio, recyclé) VALUES (${id}, ${b.IDmatiere}, ${b.pourcentage}, ${b.bio ? 1 : 0}, ${b.recycle ? 1 : 0})`,
      )
      const rows = await query(`SELECT * FROM asso_fil_matiere WHERE IDRef_fil = ${id}`)
      const normalised = rows.map((r) => normalizeAssoFilMatiereRow(r as Record<string, unknown>))
      normalised.sort((a: any, b: any) => Number(b.IDasso_fil_matiere) - Number(a.IDasso_fil_matiere))
      newId = Number((normalised[0] as any)?.IDasso_fil_matiere) || null
    } else {
      newId = await nextAssoId()
      await insertCompoRowPositional(newId, id, {
        IDmatiere: b.IDmatiere,
        pourcentage: b.pourcentage,
        bio: b.bio ? 1 : 0,
        recycle: b.recycle ? 1 : 0,
      })
    }
    res.status(201).json({ IDasso_fil_matiere: newId })
  } catch (err) {
    console.error('Error creating asso_fil_matiere:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/references-fil/:id/compositions/:assoId
referencesFilRouter.put('/:id/compositions/:assoId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const assoId = parseInt(req.params.assoId, 10)
    if (isNaN(id) || isNaN(assoId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = compositionBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const b = parsed.data
    // Scope guard via SELECT * (the accented PK can't be named in a WHERE on Linux).
    const current = await readCompoRows(id)
    if (!current.some((r) => r.IDasso_fil_matiere === assoId)) {
      res.status(404).json({ error: 'Composition row not found for this reference' })
      return
    }
    if (IS_WINDOWS) {
      await query(
        `UPDATE asso_fil_matiere SET IDMatière = ${b.IDmatiere}, pourcentage = ${b.pourcentage}, bio = ${b.bio ? 1 : 0}, recyclé = ${b.recycle ? 1 : 0} WHERE IDasso_fil_matière = ${assoId}`,
      )
    } else {
      const updated = current.map((r) =>
        r.IDasso_fil_matiere === assoId
          ? { ...r, IDmatiere: b.IDmatiere, pourcentage: b.pourcentage, bio: b.bio ? 1 : 0, recycle: b.recycle ? 1 : 0 }
          : r,
      )
      await replaceCompoRows(id, updated)
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating asso_fil_matiere:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-fil/:id/compositions/:assoId
referencesFilRouter.delete('/:id/compositions/:assoId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const assoId = parseInt(req.params.assoId, 10)
    if (isNaN(id) || isNaN(assoId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // Scope guard via SELECT * (the accented PK can't be named in a WHERE on Linux).
    const current = await readCompoRows(id)
    if (!current.some((r) => r.IDasso_fil_matiere === assoId)) {
      res.status(404).json({ error: 'Composition row not found for this reference' })
      return
    }
    if (IS_WINDOWS) {
      await query(`DELETE FROM asso_fil_matiere WHERE IDasso_fil_matière = ${assoId}`)
    } else {
      const survivors = current.filter((r) => r.IDasso_fil_matiere !== assoId)
      await replaceCompoRows(id, survivors)
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting asso_fil_matiere:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
