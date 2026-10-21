// Simone Pérèle roll labels — LIVA #1200. Mounted at /api/etiquettes-sp.
//
//   GET    /clients                         clients with labels switched on
//   PUT    /clients/:id        {enabled}    switch a client on/off (edit_client_info)
//   GET    /codes                           the `code_sp` list (EAN per coloris)
//   GET    /codes/next                      the code a new coloris would take (LIVA #1209)
//   POST   /codes | PUT /codes/:id | DELETE /codes/:id      (edit_client_info or gestion_codes_sp)
//   GET    /lignes/:ligneId                 everything the order-line tab shows
//   PUT    /lignes/:ligneId                 save the batch fields + MATEL's measures
//   GET    /lignes/:ligneId/:doc/pdf        doc = etiquettes | tableau, ?rolls=1,2
//   GET    /lignes/:ligneId/:doc/email-defaults
//   POST   /lignes/:ligneId/:doc/email      to MATEL (the sous-traitant holding the rolls)
//
//   Per dyer lot (Qualité › Suivi lots, LIVA #1303) — the tableau only:
//   GET    /lots/:suivilotId                every roll of the lot, affected or not
//   PUT    /lots/:suivilotId                save the batch fields + MATEL's measures
//   GET    /lots/:suivilotId/tableau/pdf    ?rolls=1,2
//   GET    /lots/:suivilotId/tableau/email-defaults
//   POST   /lots/:suivilotId/tableau/email
//
// Workflow and storage: lib/etiquettes-sp.ts. Barcodes: lib/gs1-barcode.ts.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import React from 'react'
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { sqlText } from '../lib/clients-common.js'
import { userHasPermission, userCanOpenScreen } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { sendMail } from '../lib/gmail.js'
import { getUserEmail } from '../lib/user-emails.js'
import { resolveClientNames } from './expeditions.js'
import { ean13FromStored, spLabelCodes } from '../lib/gs1-barcode.js'
import { createCodeSp, updateCodeSp, peekNextCode, CodeEanPrisError } from '../lib/codes-sp.js'
import {
  listEtiquetteClients, setEtiquetteClient, getLigneEtiquettes, getRollMesures, saveLigneEtiquettes,
  getLotEtiquettes, saveLotEtiquettes, commandeClientDuLot,
  matchCodeSp, lotDigits, missingMesures, defaultCommandeClient, netAAppliquer, type RollMesure,
} from '../lib/etiquettes-sp.js'
import { appliquerNetEtiquette, nomUtilisateur } from '../lib/stock-fini-mesures.js'
import { EtiquettesSpPdf, type SpLabelData } from '../lib/pdf/EtiquettesSpPdf.js'
import { TableauMetragePdf, type TableauMetrageData } from '../lib/pdf/TableauMetragePdf.js'

export const etiquettesSpRouter: RouterType = Router()

// ── Codes SP (HFSQL `code_sp`, shared live with WinDev) ────────────────────

interface CodeSp {
  IDcode_sp: number
  coloris: string
  code_ean_13: string
  article_client: string
  article_fournisseur: string
  libelle_article: string
  num_bain: string
  /** The EAN-13 as it prints (check digit added), null when the stored code
   *  is unusable (11 digits, bad check digit). */
  ean13: string | null
}

async function loadCodes(where = ''): Promise<CodeSp[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT IDcode_sp, coloris, code_ean_13, article_client, article_fournisseur, libelle_article, num_bain
     FROM code_sp ${where} ORDER BY coloris`,
  )
  const fixed = await fixEncoding(rows, 'code_sp', 'IDcode_sp', ['coloris', 'article_client', 'article_fournisseur', 'libelle_article'])
  const str = (v: unknown) => (v ?? '').toString().trim()
  return fixed.map((r) => ({
    IDcode_sp: Number(r.IDcode_sp),
    coloris: str(r.coloris),
    code_ean_13: str(r.code_ean_13),
    article_client: str(r.article_client),
    article_fournisseur: str(r.article_fournisseur),
    libelle_article: str(r.libelle_article),
    num_bain: str(r.num_bain),
    ean13: ean13FromStored(str(r.code_ean_13)),
  }))
}

async function requireEditClient(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return false }
  if (!(await userHasPermission(req.userId, isEffectiveAdmin(req), 'edit_client_info'))) {
    res.status(403).json({ error: 'permission denied: edit_client_info' })
    return false
  }
  return true
}

/** The SP code list: the whole client sheet right, or the narrow key that
 *  lets someone maintain the codes alone (LIVA #1209). */
async function requireEditCodes(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return false }
  const admin = isEffectiveAdmin(req)
  const [info, codes] = await Promise.all([
    userHasPermission(req.userId, admin, 'edit_client_info'),
    userHasPermission(req.userId, admin, 'gestion_codes_sp'),
  ])
  if (!info && !codes) {
    res.status(403).json({ error: 'permission denied: gestion_codes_sp' })
    return false
  }
  return true
}

function sendCodePris(res: Response, err: CodeEanPrisError): void {
  res.status(409).json({ error: 'ean_deja_utilise', message: err.message })
}

/** The EAN as typed: 12 data digits (the check digit is added at print, like
 *  the legacy), or 13 digits with a valid check digit — stored as 12. */
const eanInput = z.string().transform((s) => s.replace(/\D/g, '')).refine(
  (d) => d.length === 12 || (d.length === 13 && ean13FromStored(d) !== null),
  { message: 'Le code EAN doit compter 12 chiffres (ou 13 avec une clé de contrôle valide).' },
).transform((d) => d.slice(0, 12))

const codeBody = z.object({
  coloris: z.string().trim().min(1).max(100),
  code_ean_13: eanInput,
  article_client: z.string().trim().max(100).default(''),
  article_fournisseur: z.string().trim().max(100).default(''),
  libelle_article: z.string().trim().max(100).default(''),
  num_bain: z.string().trim().max(50).default(''),
})

etiquettesSpRouter.get('/codes', async (_req: Request, res: Response) => {
  try {
    res.json(await loadCodes())
  } catch (err) {
    console.error('Error listing code_sp:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

etiquettesSpRouter.get('/codes/next', async (_req: Request, res: Response) => {
  try {
    res.json({ code_ean_13: await peekNextCode() })
  } catch (err) {
    console.error('Error computing next code_sp:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// `auto: true` = the user kept the pre-filled next code: the number is taken
// again at insert time, so two people adding a coloris together never collide.
const createBody = codeBody.extend({ auto: z.boolean().default(false) })

etiquettesSpRouter.post('/codes', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditCodes(req, res))) return
    const p = createBody.safeParse(req.body)
    if (!p.success) { res.status(400).json({ error: 'Validation failed', message: p.error.issues[0]?.message, details: p.error.issues }); return }
    const { auto, ...d } = p.data
    res.status(201).json(await createCodeSp(d, auto))
  } catch (err) {
    if (err instanceof CodeEanPrisError) { sendCodePris(res, err); return }
    console.error('Error creating code_sp:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

etiquettesSpRouter.put('/codes/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await requireEditCodes(req, res))) return
    const p = codeBody.safeParse(req.body)
    if (!p.success) { res.status(400).json({ error: 'Validation failed', message: p.error.issues[0]?.message, details: p.error.issues }); return }
    await updateCodeSp(id, p.data)
    res.json({ ok: true })
  } catch (err) {
    if (err instanceof CodeEanPrisError) { sendCodePris(res, err); return }
    console.error('Error updating code_sp:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

etiquettesSpRouter.delete('/codes/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await requireEditCodes(req, res))) return
    await query(`DELETE FROM code_sp WHERE IDcode_sp = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting code_sp:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Clients with labels ────────────────────────────────────────────────────

etiquettesSpRouter.get('/clients', async (_req: Request, res: Response) => {
  try {
    res.json({ clients: await listEtiquetteClients() })
  } catch (err) {
    console.error('Error listing etiquette clients:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

etiquettesSpRouter.put('/clients/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await requireEditClient(req, res))) return
    const p = z.object({ enabled: z.boolean() }).safeParse(req.body)
    if (!p.success) { res.status(400).json({ error: 'Validation failed' }); return }
    await setEtiquetteClient(id, p.data.enabled)
    res.json({ clients: await listEtiquetteClients() })
  } catch (err) {
    console.error('Error switching etiquette client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── One order line ─────────────────────────────────────────────────────────

interface LineRoll {
  id: number
  numero: string
  lot: string
  metrage: number
  poids: number
  expedie: boolean
  IDmagasin: number
  mesure: RollMesure | null
}

interface LineContext {
  ligneId: number
  commandeId: number
  numero: number | null
  IDclient: number
  clientNom: string
  refClient: string
  coloris: string
  rolls: LineRoll[]
  sousTraitant: { id: number; nom: string } | null
}

/** Loads a fini line of a client with labels switched on. Responds itself
 *  (404 / 409) and returns null when the caller must stop. */
async function loadLine(ligneId: number, res: Response): Promise<LineContext | null> {
  const lines = await query<{ IDcommande_client: number; type_kind: number; IDreference: number; IDcolori: number }>(
    `SELECT IDcommande_client, TYPE AS type_kind, IDreference, IDcolori
     FROM ligne_commande_client WHERE IDligne_commande_client = ${ligneId}`,
  )
  const l = lines[0]
  if (!l) { res.status(404).json({ error: 'Ligne introuvable' }); return null }
  if (Number(l.type_kind) !== 2) {
    res.status(409).json({ error: 'not_fini', message: 'Les étiquettes ne concernent que les lignes de tissu fini.' })
    return null
  }
  const commandeId = Number(l.IDcommande_client)
  const cmd = await query<{ IDcommande_client: number; IDclient: number; numero: number | null; ref_client: string | null }>(
    `SELECT IDcommande_client, IDclient, numero, ref_client FROM commande_client WHERE IDcommande_client = ${commandeId}`,
  )
  const cFixed = await fixEncoding(cmd, 'commande_client', 'IDcommande_client', ['ref_client'])
  const c = cFixed[0]
  if (!c) { res.status(404).json({ error: 'Commande introuvable' }); return null }
  const IDclient = Number(c.IDclient)
  if (!(await listEtiquetteClients()).includes(IDclient)) {
    res.status(409).json({ error: 'client_sans_etiquettes', message: "Les étiquettes ne sont pas activées pour ce client (Clients › Gestion)." })
    return null
  }

  // Coloris label: dyed finis read ref_fini_colori, wash-only ones the écru's
  // colori_ecru (#1158 — branch on avec_teinture).
  const refIdFini = Number(l.IDreference) || 0
  const coloriId = Number(l.IDcolori) || 0
  let coloris = ''
  if (refIdFini > 0 && coloriId > 0) {
    const rf = await query<{ avec_teinture: number | null }>(`SELECT avec_teinture FROM ref_fini WHERE IDref_fini = ${refIdFini}`)
    if ((Number(rf[0]?.avec_teinture) || 0) === 0) {
      const r = await query<{ IDcolori_ecru: number; reference: string | null }>(
        `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru = ${coloriId}`,
      )
      coloris = ((await fixEncoding(r, 'colori_ecru', 'IDcolori_ecru', ['reference']))[0]?.reference ?? '').toString().trim()
    } else {
      const r = await query<{ IDref_fini_colori: number; reference: string | null }>(
        `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori = ${coloriId}`,
      )
      coloris = ((await fixEncoding(r, 'ref_fini_colori', 'IDref_fini_colori', ['reference']))[0]?.reference ?? '').toString().trim()
    }
  }

  const rollRows = await query<{
    IDstock_fini: number; numero: string | null; lot: string | null; metrage: number | null; poids: number | null
    IDmagasin: number | null; IDligne_expedition: number | null; IDetat_stock_fini: number | null
  }>(
    `SELECT IDstock_fini, numero, lot, metrage, poids, IDmagasin, IDligne_expedition, IDetat_stock_fini
     FROM stock_fini WHERE IDligne_commande_client = ${ligneId}`,
  )
  const mesures = await getRollMesures(rollRows.map((r) => Number(r.IDstock_fini)))
  const rolls: LineRoll[] = rollRows
    .map((r) => ({
      id: Number(r.IDstock_fini),
      numero: (r.numero ?? '').toString().trim(),
      lot: (r.lot ?? '').toString().trim(),
      metrage: Math.round((Number(r.metrage) || 0) * 100) / 100,
      poids: Math.round((Number(r.poids) || 0) * 100) / 100,
      // "Shipped" is two facts (CLAUDE.md § Data semantics) — either one hides
      // the roll from a new label batch by default.
      expedie: (Number(r.IDligne_expedition) || 0) > 0 || Number(r.IDetat_stock_fini) === 4,
      IDmagasin: Number(r.IDmagasin) || 0,
      mesure: mesures.get(Number(r.IDstock_fini)) ?? null,
    }))
    .sort((a, b) => a.numero.localeCompare(b.numero, 'fr', { numeric: true }))

  // MATEL = the sous-traitant most of the rolls sit at (magasin 0 = the factory).
  const counts = new Map<number, number>()
  for (const r of rolls) if (r.IDmagasin > 0) counts.set(r.IDmagasin, (counts.get(r.IDmagasin) ?? 0) + 1)
  const sstId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
  let sousTraitant: LineContext['sousTraitant'] = null
  if (sstId > 0) {
    const st = await query<{ IDsous_traitant: number; nom: string | null }>(
      `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant = ${sstId}`,
    )
    const stFixed = await fixEncoding(st, 'sous_traitant', 'IDsous_traitant', ['nom'])
    sousTraitant = { id: sstId, nom: (stFixed[0]?.nom ?? '').toString().trim() }
  }

  return {
    ligneId, commandeId, numero: c.numero ?? null, IDclient,
    clientNom: (await resolveClientNames([IDclient])).get(IDclient) ?? '',
    refClient: (c.ref_client ?? '').toString().trim(),
    coloris, rolls, sousTraitant,
  }
}

/** A complete roll now carries its NET length in stock, so the BL and the
 *  invoice bill the net (LIVA #1246, lib/stock-fini-mesures.ts). Same rule
 *  whether the measures were typed on the order line or on the lot. */
async function appliquerNets(
  userId: number,
  rolls: Array<{ id: number; numero: string; metrage: number }>,
  sent: Array<{ id: number } & RollMesure>,
): Promise<{ appliques: string[]; factures: string[]; sousNonFactures: string[] }> {
  const stock = new Map(rolls.map((r) => [r.id, r]))
  const todo = sent
    .map((r) => ({ r, net: netAAppliquer(r, stock.get(r.id)?.metrage ?? 0) }))
    .filter((x): x is { r: typeof x.r; net: number } => x.net !== null)
  const appliques: string[] = []
  const factures: string[] = []
  // Net below the roll's « Ml non facturés »: not applied (lib/ml-non-factures.ts).
  const sousNonFactures: string[] = []
  if (todo.length > 0) {
    const auteur = { idutilisateur: userId, nom: await nomUtilisateur(userId) }
    for (const { r, net } of todo) {
      const verdict = await appliquerNetEtiquette(r.id, net, auteur)
      const numero = stock.get(r.id)?.numero ?? String(r.id)
      if (verdict === 'applique') appliques.push(numero)
      else if (verdict === 'facture') factures.push(numero)
      else if (verdict === 'sous_non_factures') sousNonFactures.push(numero)
    }
  }
  return { appliques, factures, sousNonFactures }
}

etiquettesSpRouter.get('/lignes/:ligneId', async (req: Request, res: Response) => {
  try {
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadLine(ligneId, res)
    if (!ctx) return
    const codes = await loadCodes()
    const saved = await getLigneEtiquettes(ligneId)
    const suggested = matchCodeSp(ctx.coloris, codes)
    const codeId = saved?.IDcode_sp && codes.some((c) => c.IDcode_sp === saved.IDcode_sp) ? saved.IDcode_sp : suggested
    res.json({
      ...ctx,
      codes,
      suggestedCodeId: suggested,
      commandeClient: saved?.commandeClient ?? defaultCommandeClient(ctx.refClient),
      bain: saved?.bain ?? codes.find((c) => c.IDcode_sp === codeId)?.num_bain ?? '',
      IDcode_sp: codeId,
      saved: saved !== null,
    })
  } catch (err) {
    console.error('Error loading etiquettes line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const num = z.number().finite().nonnegative().nullable()
const saveBody = z.object({
  commandeClient: z.string().trim().max(60),
  bain: z.string().trim().max(20),
  IDcode_sp: z.number().int().nonnegative(),
  rolls: z.array(z.object({
    id: z.number().int().positive(),
    brut: num, net: num, laizeCm: num, tare: num, poids: num,
  })).max(500),
})

etiquettesSpRouter.put('/lignes/:ligneId', async (req: Request, res: Response) => {
  try {
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    // The save now writes the roll's length in stock (#1246): whoever cannot
    // open Clients › Commandes cannot reach this tab, so cannot save either.
    if (!(await userCanOpenScreen(req.userId, isEffectiveAdmin(req), '/clients', '/clients/commandes'))) {
      res.status(403).json({ error: 'permission denied: /clients/commandes' }); return
    }
    const p = saveBody.safeParse(req.body)
    if (!p.success) { res.status(400).json({ error: 'Validation failed', details: p.error.issues }); return }
    const ctx = await loadLine(ligneId, res)
    if (!ctx) return
    const own = new Set(ctx.rolls.map((r) => r.id))
    const foreign = p.data.rolls.find((r) => !own.has(r.id))
    if (foreign) { res.status(409).json({ error: 'roll_hors_ligne', message: "Un rouleau n'est plus affecté à cette ligne. Rechargez." }); return }
    await saveLigneEtiquettes(ligneId, {
      commandeClient: p.data.commandeClient, bain: p.data.bain, IDcode_sp: p.data.IDcode_sp,
    }, p.data.rolls)
    // The bain is kept per coloris in code_sp (the legacy read it from
    // there): remember the last one so the next batch is pre-filled, and
    // WinDev sees it too. num_bain is an ASCII column.
    if (p.data.IDcode_sp > 0 && p.data.bain) {
      await query(`UPDATE code_sp SET num_bain = ${sqlText(p.data.bain)} WHERE IDcode_sp = ${p.data.IDcode_sp}`)
    }
    res.json({ ok: true, net: await appliquerNets(req.userId, ctx.rolls, p.data.rolls) })
  } catch (err) {
    console.error('Error saving etiquettes line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Documents ──────────────────────────────────────────────────────────────

type Doc = 'etiquettes' | 'tableau'
const isDoc = (s: string): s is Doc => s === 'etiquettes' || s === 'tableau'

function parseRollIds(raw: unknown): number[] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  return raw.split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0)
}

class DocError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

/** Builds the requested document from the SAVED state (the tab saves before
 *  opening or sending). Throws DocError with a user-facing message. */
async function buildDoc(ligneId: number, doc: Doc, rollIds: number[] | null, res: Response) {
  const ctx = await loadLine(ligneId, res)
  if (!ctx) return null
  const saved = await getLigneEtiquettes(ligneId)
  const codes = await loadCodes()
  const codeId = saved?.IDcode_sp || matchCodeSp(ctx.coloris, codes)
  const code = codes.find((c) => c.IDcode_sp === codeId) ?? null
  const commandeClient = saved?.commandeClient ?? defaultCommandeClient(ctx.refClient)
  const bain = saved?.bain ?? code?.num_bain ?? ''
  const rolls = rollIds ? ctx.rolls.filter((r) => rollIds.includes(r.id)) : ctx.rolls.filter((r) => !r.expedie)
  if (rolls.length === 0) throw new DocError(409, 'aucun_rouleau', 'Aucun rouleau sélectionné.')
  if (!code) throw new DocError(409, 'code_sp', 'Choisissez le code Simone Pérèle du coloris.')
  const lots = [...new Set(rolls.map((r) => lotDigits(r.lot)).filter(Boolean))]
  const ref = commandeClient || String(ctx.numero ?? ctx.commandeId)

  if (doc === 'tableau') return { ctx, ...(await renderTableau(code, commandeClient, bain, rolls, ref)) }

  if (!code.ean13) {
    throw new DocError(409, 'ean_invalide', `Le code EAN du coloris « ${code.coloris} » est incomplet (${code.code_ean_13 || 'vide'}) — corrigez-le dans Clients › Gestion › Étiquettes.`)
  }
  if (!commandeClient) throw new DocError(409, 'commande_client', 'Renseignez le N° de commande Simone Pérèle.')
  if (!bain) throw new DocError(409, 'bain', 'Renseignez le N° de bain de teinture.')
  const incomplete = rolls
    .map((r) => ({ r, missing: missingMesures(r.mesure) }))
    .filter((x) => x.missing.length > 0)
  if (incomplete.length > 0) {
    const first = incomplete[0]
    throw new DocError(409, 'mesures', `Rouleau ${first.r.numero} : ${first.missing.join(', ')}${incomplete.length > 1 ? ` (et ${incomplete.length - 1} autre${incomplete.length > 2 ? 's' : ''})` : ''}.`)
  }
  const labels: SpLabelData[] = rolls.map((r) => {
    const m = r.mesure!
    return {
      articleClient: code.article_client, commandeClient, articleFournisseur: code.article_fournisseur,
      ean13: code.ean13!, libelleArticle: code.libelle_article, coloris: code.coloris,
      tare: Number(m.tare) || 0, poids: Number(m.poids) || 0,
      codes: spLabelCodes({
        numero: r.numero, commandeClient, ean13: code.ean13!, bain, lot: r.lot,
        brut: Number(m.brut), net: Number(m.net), laizeCm: Number(m.laizeCm),
      }),
    }
  })
  const buffer = await renderToBuffer(React.createElement(EtiquettesSpPdf, { labels }) as unknown as React.ReactElement<DocumentProps>)
  return { ctx, buffer, filename: `etiquettes-${lots[0] ?? ref}.pdf`.replace(/[^\w.-]+/g, '-') }
}

/** The « tableau de métrage » MATEL fills in by hand: one row per roll. */
async function renderTableau(
  code: CodeSp, commandeClient: string, bain: string,
  rolls: Array<{ numero: string; lot: string }>, fallbackName: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const lots = [...new Set(rolls.map((r) => lotDigits(r.lot)).filter(Boolean))]
  const data: TableauMetrageData = {
    commandeClient, articleClient: code.article_client, libelle: code.libelle_article || code.article_fournisseur,
    lot: lots.join(' / '), bain, coloris: code.coloris, rolls: rolls.map((r) => r.numero),
  }
  const buffer = await renderToBuffer(React.createElement(TableauMetragePdf, { data }) as unknown as React.ReactElement<DocumentProps>)
  return { buffer, filename: `tableau-metrage-${lots[0] ?? fallbackName}.pdf`.replace(/[^\w.-]+/g, '-') }
}

function sendDocError(res: Response, err: unknown): boolean {
  if (err instanceof DocError) { res.status(err.status).json({ error: err.code, message: err.message }); return true }
  if (err instanceof Error && /code128|gs1_128/.test(err.message)) {
    res.status(409).json({ error: 'caractere', message: 'Le N° de commande contient un caractère impossible à coder en code-barres (accent ?).' })
    return true
  }
  return false
}

etiquettesSpRouter.get('/lignes/:ligneId/:doc/pdf', async (req: Request, res: Response) => {
  try {
    const ligneId = parseInt(req.params.ligneId, 10)
    const doc = req.params.doc
    if (isNaN(ligneId) || !isDoc(doc)) { res.status(400).json({ error: 'Invalid request' }); return }
    const built = await buildDoc(ligneId, doc, parseRollIds(req.query.rolls), res)
    if (!built) return
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${built.filename}"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(built.buffer)
  } catch (err) {
    if (sendDocError(res, err)) return
    console.error('Error rendering etiquettes document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Email to MATEL ─────────────────────────────────────────────────────────

interface Recipient { email: string; name?: string; source: 'contact'; contactId: number }

async function sstRecipients(sstId: number): Promise<{ selected: Recipient[]; suggestions: Recipient[] }> {
  const selected: Recipient[] = []
  const suggestions: Recipient[] = []
  if (sstId <= 0) return { selected, suggestions }
  const rows = await query<{ IDcontact: number; nom: string | null; prenom: string | null; mail: string | null; envoi_commande: number | null; est_visible: number | null }>(
    `SELECT IDcontact, nom, prenom, mail, envoi_commande, est_visible FROM contact WHERE IDsous_traitant = ${sstId}`,
  )
  const fixed = await fixEncoding(rows, 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])
  const seen = new Set<string>()
  for (const c of fixed) {
    if (c.est_visible === 0) continue
    const raw = (c.mail ?? '').toString().trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) || seen.has(raw.toLowerCase())) continue
    seen.add(raw.toLowerCase())
    const name = [c.prenom, c.nom].map((s) => (s ?? '').toString().trim()).filter(Boolean).join(' ')
    const r: Recipient = { email: raw, source: 'contact', contactId: Number(c.IDcontact) }
    if (name) r.name = name
    if (c.envoi_commande === 1) selected.push(r); else suggestions.push(r)
  }
  return { selected, suggestions }
}

function emailText(doc: Doc, commandeClient: string, coloris: string) {
  const what = [commandeClient && `commande ${commandeClient}`, coloris].filter(Boolean).join(' – ')
  if (doc === 'tableau') {
    return {
      subject: `Tableau de métrage Simone Pérèle${what ? ` - ${what}` : ''} - ETS Malterre`,
      body:
        `Bonjour,\n\n` +
        `Veuillez trouver ci-joint le tableau de métrage des pièces Simone Pérèle${what ? ` (${what})` : ''}.\n\n` +
        `Merci de nous le retourner complété (métrage brut, métrage net, laize, tare et poids de chaque pièce).\n\n` +
        `Cordialement,`,
    }
  }
  return {
    subject: `Étiquettes Simone Pérèle${what ? ` - ${what}` : ''} - ETS Malterre`,
    body:
      `Bonjour,\n\n` +
      `Veuillez trouver ci-joint les étiquettes des pièces Simone Pérèle${what ? ` (${what})` : ''}, à imprimer et à apposer sur chaque rouleau avant expédition.\n\n` +
      `Cordialement,`,
  }
}

etiquettesSpRouter.get('/lignes/:ligneId/:doc/email-defaults', async (req: Request, res: Response) => {
  try {
    const ligneId = parseInt(req.params.ligneId, 10)
    const doc = req.params.doc
    if (isNaN(ligneId) || !isDoc(doc)) { res.status(400).json({ error: 'Invalid request' }); return }
    const ctx = await loadLine(ligneId, res)
    if (!ctx) return
    const saved = await getLigneEtiquettes(ligneId)
    const code = saved?.IDcode_sp ? (await loadCodes(`WHERE IDcode_sp = ${saved.IDcode_sp}`))[0] : undefined
    const recipients = await sstRecipients(ctx.sousTraitant?.id ?? 0)
    res.json({ recipients, ...emailText(doc, saved?.commandeClient ?? defaultCommandeClient(ctx.refClient), code?.coloris ?? ctx.coloris), sousTraitantNom: ctx.sousTraitant?.nom ?? '' })
  } catch (err) {
    console.error('Error building etiquettes email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const emailBody = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20000),
  attach_pdf: z.boolean().optional(),
  extra_attachments: z.array(z.object({
    filename: z.string().min(1).max(255), content_base64: z.string().min(1), content_type: z.string().min(1).max(100),
  })).optional(),
  rolls: z.array(z.number().int().positive()).optional(),
  dev_skip_send: z.boolean().optional(),
})

etiquettesSpRouter.post('/lignes/:ligneId/:doc/email', async (req: Request, res: Response) => {
  try {
    const ligneId = parseInt(req.params.ligneId, 10)
    const doc = req.params.doc
    if (isNaN(ligneId) || !isDoc(doc)) { res.status(400).json({ error: 'Invalid request' }); return }
    await sendDocMail(req, res, async (rolls) => {
      const built = await buildDoc(ligneId, doc, rolls, res)
      return built ? { filename: built.filename, buffer: built.buffer } : null
    })
  } catch (err) {
    if (sendDocError(res, err)) return
    console.error('Error sending etiquettes email:', err)
    res.status(500).json({ error: 'send_failed', message: err instanceof Error ? err.message : 'Internal server error' })
  }
})

/** Validates the dialog's body, attaches the document (unless unticked) and
 *  the user's files, and sends from the user's own mailbox. `build` answers
 *  the request itself and returns null when it must stop. */
async function sendDocMail(
  req: Request, res: Response,
  build: (rolls: number[] | null) => Promise<{ filename: string; buffer: Buffer } | null>,
): Promise<void> {
  if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
  const p = emailBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'Validation failed', details: p.error.issues }); return }

  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
  if (p.data.attach_pdf !== false) {
    const built = await build(p.data.rolls ?? null)
    if (!built) return
    attachments.push({ filename: built.filename, content: built.buffer, contentType: 'application/pdf' })
  }
  for (const a of p.data.extra_attachments ?? []) {
    attachments.push({ filename: a.filename, content: Buffer.from(a.content_base64, 'base64'), contentType: a.content_type })
  }

  if (p.data.dev_skip_send === true && process.env.NODE_ENV !== 'production') {
    console.log(`[dev-skip-send] etiquettes-sp ${req.path} — fake send to ${p.data.to.join(', ')}`)
    res.json({ ok: true, messageId: `dev-skip-${Date.now()}` })
    return
  }
  const senderEmail = await getUserEmail(req.userId)
  if (!senderEmail) {
    res.status(400).json({
      error: 'no_sender_email',
      message: "Aucune adresse email n'est associée à votre compte. Un administrateur doit en définir une dans Paramètres › Utilisateurs.",
    })
    return
  }
  const users = await query<{ IDutilisateur: number; prenom: string | null; nom: string | null }>(
    `SELECT IDutilisateur, prenom, nom FROM utilisateur WHERE IDutilisateur = ${req.userId}`,
  )
  const u = (await fixEncoding(users, 'utilisateur', 'IDutilisateur', ['prenom', 'nom']))[0]
  const displayName = u ? [u.prenom, u.nom].map((s) => (s ?? '').toString().trim()).filter(Boolean).join(' ') : ''
  const messageId = await sendMail({
    from: senderEmail, fromName: displayName ? `${displayName} - ETS Malterre` : 'ETS Malterre',
    to: p.data.to, cc: p.data.cc, bcc: p.data.bcc, subject: p.data.subject, body: p.data.body,
    attachments: attachments.length > 0 ? attachments : undefined,
  })
  res.json({ ok: true, messageId })
}

// ── One dyer lot (Qualité › Suivi lots, LIVA #1303) ────────────────────────

interface LotRoll extends LineRoll {
  /** The client order line the roll is affected to, 0 when it is free. */
  IDligne_commande_client: number
  /** « 3875 · SIMONE PERELE » — empty when the roll is free. */
  affectation: string
}

interface LotContext {
  suivilotId: number
  lot: string
  coloris: string
  rolls: LotRoll[]
  sousTraitant: { id: number; nom: string } | null
  /** SP order numbers of the lines the rolls are affected to (labels' form). */
  commandesSp: string[]
}

/** Whether a fini (ref + coloris) has ever been ordered by a client with
 *  labels switched on — the lots that get the tableau (LIVA #1303, decision
 *  Vincent 2026-10-21). A lot dyed for stock ahead of the next SP order has no
 *  affected roll, so « a roll is affected to SP » would miss it; the coloris
 *  alone cannot tell (code_sp has no FK to a coloris). `coloriId` is read as
 *  an order line stores `IDcolori`: ref_fini_colori on a dyed fini,
 *  colori_ecru on a wash-only one (#1158). */
export async function finiCommandeParClientEtiquettes(refFiniId: number, coloriId: number): Promise<boolean> {
  if (refFiniId <= 0 || coloriId <= 0) return false
  const clients = await listEtiquetteClients()
  if (clients.length === 0) return false
  const lines = await query<{ IDcommande_client: number }>(
    `SELECT IDcommande_client FROM ligne_commande_client
     WHERE TYPE = 2 AND IDreference = ${refFiniId} AND IDcolori = ${coloriId}`,
  )
  const cmdIds = [...new Set(lines.map((l) => Number(l.IDcommande_client)).filter((x) => x > 0))]
  for (let i = 0; i < cmdIds.length; i += 200) {
    const rows = await query<{ IDcommande_client: number }>(
      `SELECT IDcommande_client FROM commande_client
       WHERE IDcommande_client IN (${cmdIds.slice(i, i + 200).join(',')}) AND IDclient IN (${clients.join(',')})`,
    )
    if (rows.length > 0) return true
  }
  return false
}

/** The coloris id of a suivilot as an order line stores it (#1158 branch). */
export function lotColoriId(avecTeinture: number, IDref_fini_colori: number, IDColoris: number): number {
  return avecTeinture > 0 ? IDref_fini_colori : IDColoris
}

/** Loads a lot whose fini an SP client orders. Responds itself (404 / 409)
 *  and returns null when the caller must stop. */
async function loadLot(suivilotId: number, res: Response): Promise<LotContext | null> {
  const base = await query<{
    IDsuivilot: number; IDligne_commande_sous_traitant: number | null; IDsous_traitant: number | null
    IDref_fini: number | null; IDref_fini_colori: number | null; IDColoris: number | null; lot: string | null
  }>(
    `SELECT IDsuivilot, IDligne_commande_sous_traitant, IDsous_traitant, IDref_fini, IDref_fini_colori, IDColoris, lot
     FROM suivilot WHERE IDsuivilot = ${suivilotId}`,
  )
  const b = base[0]
  if (!b) { res.status(404).json({ error: 'Lot introuvable' }); return null }
  const refFiniId = Number(b.IDref_fini) || 0
  const rf = refFiniId > 0
    ? await query<{ avec_teinture: number | null }>(`SELECT avec_teinture FROM ref_fini WHERE IDref_fini = ${refFiniId}`)
    : []
  const avecTeinture = Number(rf[0]?.avec_teinture) || 0
  const coloriId = lotColoriId(avecTeinture, Number(b.IDref_fini_colori) || 0, Number(b.IDColoris) || 0)
  if (!(await finiCommandeParClientEtiquettes(refFiniId, coloriId))) {
    res.status(409).json({ error: 'lot_sans_etiquettes', message: "Ce coloris n'a jamais été commandé par un client avec étiquettes (Clients › Gestion)." })
    return null
  }

  let coloris = ''
  if (avecTeinture > 0) {
    const r = await query<{ IDref_fini_colori: number; reference: string | null }>(
      `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori = ${coloriId}`,
    )
    coloris = ((await fixEncoding(r, 'ref_fini_colori', 'IDref_fini_colori', ['reference']))[0]?.reference ?? '').toString().trim()
  } else {
    const r = await query<{ IDcolori_ecru: number; reference: string | null }>(
      `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru = ${coloriId}`,
    )
    coloris = ((await fixEncoding(r, 'colori_ecru', 'IDcolori_ecru', ['reference']))[0]?.reference ?? '').toString().trim()
  }

  // The lot's rolls, as Suivi lots lists them: (sst line, lot).
  const lot = (b.lot ?? '').toString()
  const ligneSst = Number(b.IDligne_commande_sous_traitant) || 0
  const rollRows = ligneSst > 0
    ? await query<{
        IDstock_fini: number; numero: string | null; lot: string | null; metrage: number | null; poids: number | null
        IDmagasin: number | null; IDligne_expedition: number | null; IDetat_stock_fini: number | null; IDligne_commande_client: number | null
      }>(
        `SELECT IDstock_fini, numero, lot, metrage, poids, IDmagasin, IDligne_expedition, IDetat_stock_fini, IDligne_commande_client
         FROM stock_fini WHERE IDref_commande_source = ${ligneSst} AND lot = ${sqlText(lot)}`,
      )
    : []

  // Which client order each affected roll serves, and whether it is an SP one.
  const lccIds = [...new Set(rollRows.map((r) => Number(r.IDligne_commande_client) || 0).filter((x) => x > 0))]
  const affectation = new Map<number, string>()
  const commandesSp: string[] = []
  if (lccIds.length > 0) {
    const lcc = await query<{ IDligne_commande_client: number; IDcommande_client: number }>(
      `SELECT IDligne_commande_client, IDcommande_client FROM ligne_commande_client WHERE IDligne_commande_client IN (${lccIds.join(',')})`,
    )
    const cmdIds = [...new Set(lcc.map((l) => Number(l.IDcommande_client)).filter((x) => x > 0))]
    const cmds = cmdIds.length > 0
      ? await fixEncoding(await query<{ IDcommande_client: number; IDclient: number; numero: number | null; ref_client: string | null }>(
          `SELECT IDcommande_client, IDclient, numero, ref_client FROM commande_client WHERE IDcommande_client IN (${cmdIds.join(',')})`,
        ), 'commande_client', 'IDcommande_client', ['ref_client'])
      : []
    const cmdById = new Map(cmds.map((c) => [Number(c.IDcommande_client), c]))
    const noms = await resolveClientNames([...new Set(cmds.map((c) => Number(c.IDclient)))])
    const clientsSp = new Set(await listEtiquetteClients())
    for (const l of [...lcc].sort((x, y) => Number(x.IDligne_commande_client) - Number(y.IDligne_commande_client))) {
      const c = cmdById.get(Number(l.IDcommande_client))
      if (!c) continue
      const lid = Number(l.IDligne_commande_client)
      // numero is an integer on PostgreSQL (#1264): String() it.
      affectation.set(lid, [c.numero != null ? String(c.numero) : '', noms.get(Number(c.IDclient)) ?? ''].filter(Boolean).join(' · '))
      if (clientsSp.has(Number(c.IDclient))) {
        const saved = await getLigneEtiquettes(lid)
        commandesSp.push(saved?.commandeClient ?? defaultCommandeClient((c.ref_client ?? '').toString()))
      }
    }
  }

  const mesures = await getRollMesures(rollRows.map((r) => Number(r.IDstock_fini)))
  const rolls: LotRoll[] = rollRows
    .map((r) => {
      const lcc = Number(r.IDligne_commande_client) || 0
      return {
        id: Number(r.IDstock_fini),
        numero: (r.numero ?? '').toString().trim(),
        lot: (r.lot ?? '').toString().trim(),
        metrage: Math.round((Number(r.metrage) || 0) * 100) / 100,
        poids: Math.round((Number(r.poids) || 0) * 100) / 100,
        expedie: (Number(r.IDligne_expedition) || 0) > 0 || Number(r.IDetat_stock_fini) === 4,
        IDmagasin: Number(r.IDmagasin) || 0,
        mesure: mesures.get(Number(r.IDstock_fini)) ?? null,
        IDligne_commande_client: lcc,
        affectation: lcc > 0 ? affectation.get(lcc) ?? '' : '',
      }
    })
    .sort((a, c) => a.numero.localeCompare(c.numero, 'fr', { numeric: true }))

  // The dyer is the lot's sous-traitant (the rolls may already sit elsewhere).
  const sstId = Number(b.IDsous_traitant) || 0
  let sousTraitant: LotContext['sousTraitant'] = null
  if (sstId > 0) {
    const st = await query<{ IDsous_traitant: number; nom: string | null }>(
      `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant = ${sstId}`,
    )
    sousTraitant = { id: sstId, nom: ((await fixEncoding(st, 'sous_traitant', 'IDsous_traitant', ['nom']))[0]?.nom ?? '').toString().trim() }
  }

  return { suivilotId, lot, coloris, rolls, sousTraitant, commandesSp }
}

/** The batch fields of a lot: saved, else derived (code from the coloris,
 *  bain remembered on the code, order numbers from the affected rolls). */
async function lotBatch(ctx: LotContext, codes: CodeSp[]) {
  const saved = await getLotEtiquettes(ctx.suivilotId)
  const suggested = matchCodeSp(ctx.coloris, codes)
  const codeId = saved?.IDcode_sp && codes.some((c) => c.IDcode_sp === saved.IDcode_sp) ? saved.IDcode_sp : suggested
  return {
    suggestedCodeId: suggested,
    IDcode_sp: codeId,
    commandeClient: saved?.commandeClient ?? commandeClientDuLot(ctx.commandesSp),
    bain: saved?.bain ?? codes.find((c) => c.IDcode_sp === codeId)?.num_bain ?? '',
  }
}

function parseLotId(req: Request, res: Response): number | null {
  const id = parseInt(req.params.suivilotId, 10)
  if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return null }
  return id
}

etiquettesSpRouter.get('/lots/:suivilotId', async (req: Request, res: Response) => {
  try {
    const id = parseLotId(req, res)
    if (id === null) return
    const ctx = await loadLot(id, res)
    if (!ctx) return
    const codes = await loadCodes()
    res.json({ ...ctx, codes, ...(await lotBatch(ctx, codes)) })
  } catch (err) {
    console.error('Error loading etiquettes lot:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

etiquettesSpRouter.put('/lots/:suivilotId', async (req: Request, res: Response) => {
  try {
    const id = parseLotId(req, res)
    if (id === null) return
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    // The save writes the roll's length in stock (#1246): the dialog lives on
    // Qualité › Suivi lots, so whoever cannot open it cannot save.
    if (!(await userCanOpenScreen(req.userId, isEffectiveAdmin(req), '/qualite', '/qualite/suivi-lots'))) {
      res.status(403).json({ error: 'permission denied: /qualite/suivi-lots' }); return
    }
    const p = saveBody.safeParse(req.body)
    if (!p.success) { res.status(400).json({ error: 'Validation failed', details: p.error.issues }); return }
    const ctx = await loadLot(id, res)
    if (!ctx) return
    const own = new Set(ctx.rolls.map((r) => r.id))
    if (p.data.rolls.some((r) => !own.has(r.id))) {
      res.status(409).json({ error: 'roll_hors_lot', message: "Un rouleau n'appartient plus à ce lot. Rechargez." }); return
    }
    await saveLotEtiquettes(id, {
      commandeClient: p.data.commandeClient, bain: p.data.bain, IDcode_sp: p.data.IDcode_sp,
    }, p.data.rolls)
    if (p.data.IDcode_sp > 0 && p.data.bain) {
      await query(`UPDATE code_sp SET num_bain = ${sqlText(p.data.bain)} WHERE IDcode_sp = ${p.data.IDcode_sp}`)
    }
    res.json({ ok: true, net: await appliquerNets(req.userId, ctx.rolls, p.data.rolls) })
  } catch (err) {
    console.error('Error saving etiquettes lot:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** The lot's tableau, from the SAVED state (the dialog saves first). Every
 *  roll still in stock by default — the point of asking per lot. */
async function buildLotTableau(id: number, rollIds: number[] | null, res: Response) {
  const ctx = await loadLot(id, res)
  if (!ctx) return null
  const codes = await loadCodes()
  const batch = await lotBatch(ctx, codes)
  const code = codes.find((c) => c.IDcode_sp === batch.IDcode_sp) ?? null
  const rolls = rollIds ? ctx.rolls.filter((r) => rollIds.includes(r.id)) : ctx.rolls.filter((r) => !r.expedie)
  if (rolls.length === 0) throw new DocError(409, 'aucun_rouleau', 'Aucun rouleau sélectionné.')
  if (!code) throw new DocError(409, 'code_sp', 'Choisissez le code Simone Pérèle du coloris.')
  return renderTableau(code, batch.commandeClient, batch.bain, rolls, ctx.lot || String(id))
}

etiquettesSpRouter.get('/lots/:suivilotId/tableau/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseLotId(req, res)
    if (id === null) return
    const built = await buildLotTableau(id, parseRollIds(req.query.rolls), res)
    if (!built) return
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${built.filename}"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(built.buffer)
  } catch (err) {
    if (sendDocError(res, err)) return
    console.error('Error rendering lot tableau:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

etiquettesSpRouter.get('/lots/:suivilotId/tableau/email-defaults', async (req: Request, res: Response) => {
  try {
    const id = parseLotId(req, res)
    if (id === null) return
    const ctx = await loadLot(id, res)
    if (!ctx) return
    const codes = await loadCodes()
    const batch = await lotBatch(ctx, codes)
    const code = codes.find((c) => c.IDcode_sp === batch.IDcode_sp)
    const recipients = await sstRecipients(ctx.sousTraitant?.id ?? 0)
    const what = [ctx.lot && `lot ${ctx.lot.toUpperCase()}`, code?.coloris ?? ctx.coloris].filter(Boolean).join(' – ')
    res.json({
      recipients,
      subject: `Tableau de métrage Simone Pérèle${what ? ` - ${what}` : ''} - ETS Malterre`,
      body:
        `Bonjour,\n\n` +
        `Veuillez trouver ci-joint le tableau de métrage des pièces Simone Pérèle${what ? ` (${what})` : ''}.\n\n` +
        `Merci de nous le retourner complété (métrage brut, métrage net, laize, tare et poids de chaque pièce).\n\n` +
        `Cordialement,`,
      sousTraitantNom: ctx.sousTraitant?.nom ?? '',
    })
  } catch (err) {
    console.error('Error building lot tableau email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

etiquettesSpRouter.post('/lots/:suivilotId/tableau/email', async (req: Request, res: Response) => {
  try {
    const id = parseLotId(req, res)
    if (id === null) return
    await sendDocMail(req, res, (rolls) => buildLotTableau(id, rolls, res))
  } catch (err) {
    if (sendDocError(res, err)) return
    console.error('Error sending lot tableau email:', err)
    res.status(500).json({ error: 'send_failed', message: err instanceof Error ? err.message : 'Internal server error' })
  }
})
