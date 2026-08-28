import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import { query, queryRaw, fixEncoding } from '../lib/hfsql-auto.js'
import { pickVal, stripKeys } from './stock.js'

const upload = multer({ storage: multer.memoryStorage() })
import { CommandeFournisseurPdf, type CommandeFournisseurPdfData } from '../lib/pdf/CommandeFournisseurPdf.js'
import { sendMail } from '../lib/gmail.js'
import { getUserEmail } from '../lib/user-emails.js'

export const commandesFilRouter: RouterType = Router()

// ── Types ────────────────────────────────────────────────

interface CommandeFil {
  IDcommande_fil: number
  IDfournisseur: number
  date_commande: string | null
  etat: number | null
  commentaire: string | null
  journal: string | null
  IDadresse_fournisseur: number | null
  IDadresse_livraison: number | null
  IDmode_paiement: number | null
  IDecheance: number | null
}

interface RefFilCommande {
  IDref_fil_commande: number
  IDcommande_fil: number
  IDref_fil: number
  IDcolori_fil: number
  quantite: number | null
  unite: number | null
  prix_unitaire: number | null
  date_livraison: string | null
  etat: number | null
  date_notif: string | null
}

// ── Helpers ──────────────────────────────────────────────

function esc(value: string): string {
  return value.replace(/'/g, "''")
}

function n(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const parsed = Number(value)
  return isNaN(parsed) ? 0 : parsed
}

/** Keep only digits from a YYYYMMDD-ish input. Accepts 'YYYY-MM-DD' or 'YYYYMMDD' or ''. */
function dateStr(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value).replace(/-/g, '')
  return /^\d{8}$/.test(s) ? s : ''
}

// ── Commande lifecycle helpers ───────────────────────────
//
// A "terminée" commande (etat=1) is locked: no line create/update/delete.
// Re-opening (sidebar pill → etat=0) is the only path back to editing.
// Conversely, when the last open line of an open commande gets toggled to
// terminé, the commande auto-flips to terminée — see `maybeAutoCloseCommande`.

async function loadCommandeEtat(commandeId: number): Promise<number | null> {
  const rows = await query<{ etat: number | null }>(
    `SELECT etat FROM commande_fil WHERE IDcommande_fil = ${commandeId}`
  )
  if (rows.length === 0) return null
  return rows[0].etat ?? 0
}

async function loadCommandeIdForLine(lineId: number): Promise<number | null> {
  const rows = await query<{ IDcommande_fil: number }>(
    `SELECT IDcommande_fil FROM ref_fil_commande WHERE IDref_fil_commande = ${lineId}`
  )
  if (rows.length === 0) return null
  return Number(rows[0].IDcommande_fil) || null
}

/** Send a 409 if the commande is closed. Returns true when the response was
 *  written (caller must `return` immediately). */
function refuseIfTerminee(res: Response, etat: number | null): boolean {
  if (etat === 1) {
    res.status(409).json({
      error: 'commande_terminee',
      message: 'Commande terminée — réouvrir la commande pour modifier les lignes.',
    })
    return true
  }
  return false
}

/** Flip commande_fil.etat to 1 when every line is terminé. Skips empty
 *  commandes so a freshly-created header is not auto-closed. */
async function maybeAutoCloseCommande(commandeId: number): Promise<void> {
  const lines = await query<{ etat: number | null }>(
    `SELECT etat FROM ref_fil_commande WHERE IDcommande_fil = ${commandeId}`
  )
  if (lines.length === 0) return
  if (!lines.every((l) => Number(l.etat) === 1)) return
  await query(
    `UPDATE commande_fil SET etat = 1 WHERE IDcommande_fil = ${commandeId} AND etat = 0`
  )
}

// ── Stock lookup helpers (used by /lignes/:ligneId/stock endpoints) ─────
//
// stock_fil has accented columns (terminé, controlé). On Linux the iODBC
// bridge rejects any accented identifier token in the SQL text, so we use
// `sf.*` and accept truncated names (terminé→termin, controlé→control). On
// Windows we must list columns explicitly because `alias.*` returns empty
// rows in a JOIN. Both paths are post-processed via `normStockLot` to emit
// the same ASCII-only keys. See CLAUDE.md "Accented column names through
// bridge" for the full picture.

const IS_WINDOWS = process.platform === 'win32'

const STOCK_LOT_SELECT = IS_WINDOWS
  ? `sf.IDstock_fil, sf.IDfournisseur, sf.IDref_fil, sf.IDcolori_fil, sf.IDref_fil_commande, sf.stock, sf.stock_initial, sf.lot, sf.lot_frs, sf.emplacement, sf.date_entree, sf.niveau, sf.terminé AS termine, sf.controlé AS controle, rf.reference AS ref_fil, rf.bio, cf.reference AS colori_reference, f.nom AS fournisseur_nom`
  : `sf.*, rf.reference AS ref_fil, rf.bio, cf.reference AS colori_reference, f.nom AS fournisseur_nom`

const STOCK_LOT_JOINS = `FROM stock_fil sf LEFT JOIN ref_fil rf ON sf.IDref_fil = rf.IDref_fil LEFT JOIN colori_fil cf ON sf.IDcolori_fil = cf.IDcolori_fil LEFT JOIN fournisseur f ON sf.IDfournisseur = f.IDfournisseur`

/** Map the two platform-specific row shapes to stable ASCII keys, and drop
 *  binary blobs so JSON serialization doesn't crash.
 *
 *  ⚠ The accented columns come back from the Linux bridge truncated at the accent
 *  AND with a non-deterministic garbage trailing byte (termin / termint / termini
 *  … depending on server load), so a hardcoded `.termin` fallback misses the key
 *  in production and leaves the flag at 0 for EVERY row — which offered finished
 *  lots as available stock here. Always resolve by prefix (stock.ts pickVal), and
 *  strip by prefix too, or the mangled key leaks into the payload. Same defect,
 *  same root cause as ticket #1090 on the référence fil card. */
function normStockLot(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  // Read by prefix BEFORE stripping every mangled variant.
  const termineVal = (row as any).termine ?? pickVal(row, /^termin/i)
  const controleVal = (row as any).controle ?? pickVal(row, /^control/i)
  stripKeys(out, /^termin/i)
  stripKeys(out, /^control/i)
  out.termine = Number(termineVal) || 0
  out.controle = Number(controleVal) || 0
  // stock_fil carries certificate blobs we never want in this response
  delete out.certif_bio
  stripKeys(out, /^certif_recycl/i)
  delete out.commentaire
  delete out.observation_freinte
  return out
}

async function fetchStockLots(whereSql: string): Promise<Record<string, unknown>[]> {
  const sql = `SELECT ${STOCK_LOT_SELECT} ${STOCK_LOT_JOINS} ${whereSql} ORDER BY sf.date_entree DESC, sf.IDstock_fil DESC`
  const rows = await query<Record<string, unknown>>(sql)
  const fixed = await fixEncoding(rows, 'stock_fil', 'IDstock_fil', ['lot', 'lot_frs', 'emplacement'])
  return fixed.map((r) => normStockLot(r as Record<string, unknown>))
}

// ── Validation schemas ───────────────────────────────────

const commandeBody = z.object({
  IDfournisseur: z.number().int().positive(),
  date_commande: z.string().optional(), // YYYYMMDD or YYYY-MM-DD
  IDadresse_fournisseur: z.number().int().nonnegative().optional(),
  IDadresse_livraison: z.number().int().nonnegative().optional(),
  IDmode_paiement: z.number().int().nonnegative().optional(),
  IDecheance: z.number().int().nonnegative().optional(),
  commentaire: z.string().optional(),
  journal: z.string().optional(),
  etat: z.number().int().min(0).max(1).optional(),
})

const ligneBody = z.object({
  IDref_fil: z.number().int().positive(),
  IDcolori_fil: z.number().int().positive(),
  quantite: z.number().optional(),
  unite: z.number().int().optional(),
  prix_unitaire: z.number().optional(),
  date_livraison: z.string().optional(),
  etat: z.number().int().min(0).max(1).optional(),
})

// ── Lookups ──────────────────────────────────────────────

commandesFilRouter.get('/lookups/modes-paiement', async (_req: Request, res: Response) => {
  try {
    const rows = await query('SELECT IDmode_paiement, libelle FROM mode_paiement ORDER BY libelle')
    const fixed = await fixEncoding(rows, 'mode_paiement', 'IDmode_paiement', ['libelle'])
    res.json(fixed)
  } catch (err) {
    console.error('Error fetching mode_paiement:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesFilRouter.get('/lookups/echeances', async (_req: Request, res: Response) => {
  try {
    const rows = await query('SELECT IDecheance, libelle, nb_jours FROM echeance ORDER BY libelle')
    const fixed = await fixEncoding(rows, 'echeance', 'IDecheance', ['libelle'])
    res.json(fixed)
  } catch (err) {
    console.error('Error fetching echeance:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesFilRouter.get('/lookups/refs-fil', async (req: Request, res: Response) => {
  try {
    const fid = parseInt(String(req.query.fournisseur ?? ''), 10)
    if (isNaN(fid)) { res.status(400).json({ error: 'fournisseur query parameter required' }); return }

    const rows = await query(
      `SELECT cf.IDcolori_fil, cf.reference as colori_reference, cf.prix_kg as colori_prix_kg, rf.IDref_fil, rf.reference as ref_fil_reference, rf.bio, rf.titrage FROM asso_colorisfil_frs a JOIN colori_fil cf ON a.IDcolori_fil = cf.IDcolori_fil JOIN ref_fil rf ON cf.IDref_fil = rf.IDref_fil WHERE a.IDfournisseur = ${fid} ORDER BY rf.reference, cf.reference`
    )
    const fixed = await fixEncoding(rows, 'colori_fil', 'IDcolori_fil', ['colori_reference', 'ref_fil_reference'])
    res.json(fixed)
  } catch (err) {
    console.error('Error fetching refs-fil lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesFilRouter.get('/lookups/adresses', async (req: Request, res: Response) => {
  try {
    const fid = parseInt(String(req.query.fournisseur ?? ''), 10)
    if (isNaN(fid)) { res.status(400).json({ error: 'fournisseur query parameter required' }); return }

    const rows = await query(`SELECT * FROM adresse WHERE IDfournisseur = ${fid} ORDER BY est_defaut DESC, IDadresse`)
    const fixed = await fixEncoding(rows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays', 'commentaire'])
    res.json(fixed)
  } catch (err) {
    console.error('Error fetching adresses lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── List all commandes ───────────────────────────────────

commandesFilRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim()
    const fournisseurFilter = parseInt(String(req.query.fournisseur ?? ''), 10)
    const etatFilter = String(req.query.etat ?? 'all')

    const whereParts: string[] = []
    if (!isNaN(fournisseurFilter)) whereParts.push(`cf.IDfournisseur = ${fournisseurFilter}`)
    if (etatFilter === 'en_cours') whereParts.push(`cf.etat = 0`)
    else if (etatFilter === 'terminee') whereParts.push(`cf.etat = 1`)
    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''

    const commandes = await query<any>(
      `SELECT cf.IDcommande_fil, cf.IDfournisseur, cf.date_commande, cf.etat, cf.commentaire FROM commande_fil cf ${whereSql} ORDER BY cf.date_commande DESC, cf.IDcommande_fil DESC`
    )
    const fixedCommandes = await fixEncoding(commandes, 'commande_fil', 'IDcommande_fil', ['commentaire'])

    // Fetch supplier names in a bulk query and merge in JS (avoid aliased CONVERT mismatch in fixEncoding)
    const fournisseurIds = Array.from(new Set(fixedCommandes.map((c: any) => Number(c.IDfournisseur)).filter((x) => !isNaN(x) && x > 0)))
    const fournisseurNomMap = new Map<number, string>()
    if (fournisseurIds.length > 0) {
      const frs = await query<{ IDfournisseur: number; nom: string }>(
        `SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur IN (${fournisseurIds.join(',')})`
      )
      const fixedFrs = await fixEncoding(frs, 'fournisseur', 'IDfournisseur', ['nom'])
      for (const f of fixedFrs) fournisseurNomMap.set(Number(f.IDfournisseur), f.nom ?? '')
    }
    const fixedWithFournisseurNom = fixedCommandes.map((c: any) => ({
      ...c,
      fournisseur_nom: fournisseurNomMap.get(Number(c.IDfournisseur)) ?? '',
    }))

    // Fetch line totals + earliest delivery date in one bulk query
    const ids = fixedWithFournisseurNom.map((c: any) => c.IDcommande_fil).filter(Boolean)
    const totalsMap = new Map<number, { total_kg: number; total_eur: number; nb_lignes: number; earliest_delivery: string | null }>()
    if (ids.length > 0) {
      const lignes = await query<any>(
        `SELECT IDcommande_fil, quantite, prix_unitaire, date_livraison, etat FROM ref_fil_commande WHERE IDcommande_fil IN (${ids.join(',')})`
      )
      for (const l of lignes) {
        const id = Number(l.IDcommande_fil)
        const acc = totalsMap.get(id) ?? { total_kg: 0, total_eur: 0, nb_lignes: 0, earliest_delivery: null }
        const qty = Number(l.quantite) || 0
        const price = Number(l.prix_unitaire) || 0
        acc.total_kg += qty
        acc.total_eur += qty * price
        acc.nb_lignes += 1
        // Earliest non-empty YYYYMMDD across OPEN lines only — terminé lines
        // are already delivered and shouldn't drive the urgency color of the
        // parent commande. Zero-padded strings compare lexicographically.
        if (Number(l.etat) !== 1) {
          const dl = typeof l.date_livraison === 'string' ? l.date_livraison : ''
          if (/^\d{8}$/.test(dl) && (acc.earliest_delivery === null || dl < acc.earliest_delivery)) {
            acc.earliest_delivery = dl
          }
        }
        totalsMap.set(id, acc)
      }
    }

    // Filter by search query (supplier name, id, or commentaire)
    const qLower = q.toLowerCase()
    const result = fixedWithFournisseurNom
      .map((c: any) => {
        const totals = totalsMap.get(Number(c.IDcommande_fil)) ?? { total_kg: 0, total_eur: 0, nb_lignes: 0, earliest_delivery: null }
        return { ...c, ...totals }
      })
      .filter((c: any) => {
        if (!q) return true
        const hay = `${c.IDcommande_fil} ${c.fournisseur_nom ?? ''} ${c.commentaire ?? ''}`.toLowerCase()
        return hay.includes(qLower)
      })

    res.json(result)
  } catch (err) {
    console.error('Error fetching commandes-fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Get one commande with full detail ───────────────────

commandesFilRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await query<CommandeFil>(`SELECT * FROM commande_fil WHERE IDcommande_fil = ${id}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Commande not found' }); return }

    const fixedHeader = await fixEncoding(rows, 'commande_fil', 'IDcommande_fil', ['commentaire', 'journal'])
    const header = fixedHeader[0] as any

    // Fetch related data in parallel
    const [fournisseurRows, modePaiementRows, echeanceRows, adresseFactRows, adresseLivRows, lignes] = await Promise.all([
      query(`SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur = ${n(header.IDfournisseur)}`),
      header.IDmode_paiement ? query(`SELECT IDmode_paiement, libelle FROM mode_paiement WHERE IDmode_paiement = ${n(header.IDmode_paiement)}`) : Promise.resolve([]),
      header.IDecheance ? query(`SELECT IDecheance, libelle, nb_jours FROM echeance WHERE IDecheance = ${n(header.IDecheance)}`) : Promise.resolve([]),
      header.IDadresse_fournisseur ? query(`SELECT * FROM adresse WHERE IDadresse = ${n(header.IDadresse_fournisseur)}`) : Promise.resolve([]),
      header.IDadresse_livraison ? query(`SELECT * FROM adresse WHERE IDadresse = ${n(header.IDadresse_livraison)}`) : Promise.resolve([]),
      query(
        `SELECT rfc.IDref_fil_commande, rfc.IDcommande_fil, rfc.IDref_fil, rfc.IDcolori_fil, rfc.quantite, rfc.unite, rfc.prix_unitaire, rfc.date_livraison, rfc.etat, rf.reference as ref_fil, rf.bio as ref_fil_bio, cf.reference as colori_reference FROM ref_fil_commande rfc LEFT JOIN ref_fil rf ON rfc.IDref_fil = rf.IDref_fil LEFT JOIN colori_fil cf ON rfc.IDcolori_fil = cf.IDcolori_fil WHERE rfc.IDcommande_fil = ${id} ORDER BY rfc.IDref_fil_commande`
      ),
    ])

    const fixedFournisseur = await fixEncoding(fournisseurRows, 'fournisseur', 'IDfournisseur', ['nom'])
    const fixedModePaiement = await fixEncoding(modePaiementRows, 'mode_paiement', 'IDmode_paiement', ['libelle'])
    const fixedEcheance = await fixEncoding(echeanceRows, 'echeance', 'IDecheance', ['libelle'])
    const fixedAdresseFact = await fixEncoding(adresseFactRows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays'])
    const fixedAdresseLiv = await fixEncoding(adresseLivRows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays'])
    const fixedLignes = await fixEncoding(lignes, 'ref_fil_commande', 'IDref_fil_commande', ['ref_fil', 'colori_reference'])

    // Linked-stock aggregates per line: count + sum of stock_initial from
    // every stock_fil row whose IDref_fil_commande points at each line.
    const lineIds = (fixedLignes as any[]).map((l) => Number(l.IDref_fil_commande)).filter((x) => !isNaN(x) && x > 0)
    const linkedMap = new Map<number, { nb_lots_lies: number; total_kg_lie: number }>()
    if (lineIds.length > 0) {
      const linkedRows = await query<{ IDref_fil_commande: number; stock_initial: number }>(
        `SELECT IDref_fil_commande, stock_initial FROM stock_fil WHERE IDref_fil_commande IN (${lineIds.join(',')})`
      )
      for (const lr of linkedRows) {
        const lid = Number(lr.IDref_fil_commande)
        const acc = linkedMap.get(lid) ?? { nb_lots_lies: 0, total_kg_lie: 0 }
        acc.nb_lots_lies += 1
        acc.total_kg_lie += Number(lr.stock_initial) || 0
        linkedMap.set(lid, acc)
      }
    }
    const lignesWithLinked = (fixedLignes as any[]).map((l) => {
      const agg = linkedMap.get(Number(l.IDref_fil_commande)) ?? { nb_lots_lies: 0, total_kg_lie: 0 }
      return { ...l, ...agg }
    })

    res.json({
      ...header,
      fournisseur_nom: (fixedFournisseur[0] as any)?.nom ?? null,
      mode_paiement_libelle: (fixedModePaiement[0] as any)?.libelle ?? null,
      echeance_libelle: (fixedEcheance[0] as any)?.libelle ?? null,
      adresse_facturation: fixedAdresseFact[0] ?? null,
      adresse_livraison: fixedAdresseLiv[0] ?? null,
      lignes: lignesWithLinked,
    })
  } catch (err) {
    console.error('Error fetching commande-fil detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PDF export ──────────────────────────────────────────
//
// Renders a Malterre-branded PDF for a single commande fournisseur using
// @react-pdf/renderer. The React component trees live in src/lib/pdf/.

/** Format a HFSQL YYYYMMDD string as dd/mm/yyyy (French locale). */
function formatHfsqlDateFr(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = String(raw)
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`
  }
  return ''
}

const FRENCH_MONTHS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
] as const

/** Format a HFSQL YYYYMMDD string as the long-form French "14 avril 2026". */
function formatHfsqlDateLongFr(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = String(raw)
  if (!/^\d{8}$/.test(s)) return ''
  const day = parseInt(s.slice(6, 8), 10)
  const month = parseInt(s.slice(4, 6), 10)
  const year = s.slice(0, 4)
  if (month < 1 || month > 12) return ''
  return `${day} ${FRENCH_MONTHS[month - 1]} ${year}`
}

/** Strip HFSQL placeholder values (dots, dashes, underscores, single chars).
 *  Many legacy records have ".", " . ", "-", "" etc. in unset address fields. */
function cleanAddrField(s: string | null | undefined): string | null {
  if (!s) return null
  const t = String(s).trim()
  if (!t) return null
  if (/^[.\-_·•\s]+$/.test(t)) return null
  return t
}

/** Clean a full address record into the shape the PDF expects. */
function cleanAddress(a: any | null): {
  nom: string | null
  adresse1: string | null
  adresse2: string | null
  adresse3: string | null
  cp: string | null
  ville: string | null
  pays: string | null
} | null {
  if (!a) return null
  return {
    nom: cleanAddrField(a.nom),
    adresse1: cleanAddrField(a.adresse1),
    adresse2: cleanAddrField(a.adresse2),
    adresse3: cleanAddrField(a.adresse3),
    cp: cleanAddrField(a.cp),
    ville: cleanAddrField(a.ville),
    pays: cleanAddrField(a.pays),
  }
}

/** Load all data for a commande_fil and build the PDF data object. Used by
 *  both the /pdf download route and the /email send route. Returns null if
 *  the commande doesn't exist. */
async function buildCommandePdfData(id: number): Promise<CommandeFournisseurPdfData | null> {
  const rows = await query<CommandeFil>(`SELECT * FROM commande_fil WHERE IDcommande_fil = ${id}`)
  if (rows.length === 0) return null
  const fixedHeader = await fixEncoding(rows, 'commande_fil', 'IDcommande_fil', ['commentaire', 'journal'])
  const header = fixedHeader[0] as any

  const [fournisseurRows, modePaiementRows, echeanceRows, adresseFournisseurRows, adresseLivRows, lignes] = await Promise.all([
    query(`SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur = ${n(header.IDfournisseur)}`),
    header.IDmode_paiement ? query(`SELECT IDmode_paiement, libelle FROM mode_paiement WHERE IDmode_paiement = ${n(header.IDmode_paiement)}`) : Promise.resolve([]),
    header.IDecheance ? query(`SELECT IDecheance, libelle FROM echeance WHERE IDecheance = ${n(header.IDecheance)}`) : Promise.resolve([]),
    header.IDadresse_fournisseur ? query(`SELECT * FROM adresse WHERE IDadresse = ${n(header.IDadresse_fournisseur)}`) : Promise.resolve([]),
    header.IDadresse_livraison ? query(`SELECT * FROM adresse WHERE IDadresse = ${n(header.IDadresse_livraison)}`) : Promise.resolve([]),
    query(
      `SELECT rfc.IDref_fil_commande, rfc.quantite, rfc.unite, rfc.prix_unitaire, rfc.date_livraison, rfc.etat, rf.reference as ref_fil, rf.bio as ref_fil_bio, cf.reference as colori_reference FROM ref_fil_commande rfc LEFT JOIN ref_fil rf ON rfc.IDref_fil = rf.IDref_fil LEFT JOIN colori_fil cf ON rfc.IDcolori_fil = cf.IDcolori_fil WHERE rfc.IDcommande_fil = ${id} ORDER BY rfc.IDref_fil_commande`
    ),
  ])

  const fixedFournisseur = await fixEncoding(fournisseurRows, 'fournisseur', 'IDfournisseur', ['nom'])
  const fixedModePaiement = await fixEncoding(modePaiementRows, 'mode_paiement', 'IDmode_paiement', ['libelle'])
  const fixedEcheance = await fixEncoding(echeanceRows, 'echeance', 'IDecheance', ['libelle'])
  const fixedAdresseFrs = await fixEncoding(adresseFournisseurRows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays'])
  const fixedAdresseLiv = await fixEncoding(adresseLivRows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays'])
  const fixedLignes = await fixEncoding(lignes, 'ref_fil_commande', 'IDref_fil_commande', ['ref_fil', 'colori_reference'])

  // Earliest line delivery date — drives the "Délai de livraison" metadata.
  const earliestDelivery = ((fixedLignes as any[])
    .map((l) => (typeof l.date_livraison === 'string' ? l.date_livraison : ''))
    .filter((s) => /^\d{8}$/.test(s)) as string[])
    .sort()[0] ?? null

  return {
    numero: String(header.IDcommande_fil),
    dateCommande: formatHfsqlDateLongFr(header.date_commande),
    fournisseurNom: ((fixedFournisseur[0] as any)?.nom ?? '').toString() || '—',
    fournisseurAdresse: cleanAddress(fixedAdresseFrs[0] as any),
    adresseLivraison: cleanAddress(fixedAdresseLiv[0] as any),
    modePaiement: ((fixedModePaiement[0] as any)?.libelle ?? null) as string | null,
    echeance: ((fixedEcheance[0] as any)?.libelle ?? null) as string | null,
    delaiLivraison: earliestDelivery ? formatHfsqlDateLongFr(earliestDelivery) : null,
    commentaire: (header.commentaire ?? null) as string | null,
    lignes: (fixedLignes as any[]).map((l) => ({
      ref_fil: l.ref_fil ?? null,
      colori_reference: l.colori_reference ?? null,
      bio: Number(l.ref_fil_bio) === 1,
      quantite: l.quantite == null ? null : Number(l.quantite),
      prix_unitaire: l.prix_unitaire == null ? null : Number(l.prix_unitaire),
      date_livraison: formatHfsqlDateFr(l.date_livraison) || null,
    })),
  }
}

/** Render a commande_fil PDF as a Buffer. */
async function renderCommandePdfBuffer(data: CommandeFournisseurPdfData): Promise<Buffer> {
  // CommandeFournisseurPdf returns a <Document> tree via MalterreDocument;
  // renderToBuffer's type demands a DocumentProps element explicitly, so cast.
  return renderToBuffer(
    React.createElement(CommandeFournisseurPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >
  )
}

commandesFilRouter.get('/:id/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const data = await buildCommandePdfData(id)
    if (!data) { res.status(404).json({ error: 'Commande not found' }); return }

    const buffer = await renderCommandePdfBuffer(data)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `inline; filename="commande-fournisseur-${data.numero}.pdf"`
    )
    // Strip helmet's restrictive headers so the web app (different origin/port
    // in dev) can embed the PDF in an <iframe>. See mps_designer §21.
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering commande-fil PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Email the commande (Gmail API via domain-wide delegation) ───────────
//
// Two endpoints:
//   GET  /:id/email-defaults  — returns pre-filled recipients + subject +
//                               body, so the frontend dialog opens with
//                               reasonable defaults
//   POST /:id/email           — sends the email, impersonating the acting
//                               user's mapped @etsmalterre.com address

/** Recipient entry returned to the frontend SendEmailDialog. `selected`
 *  contacts are rendered as pre-checked chips on open; `suggestions` are
 *  shown beneath, clickable to move into selected. */
interface EmailRecipientPayload {
  email: string
  name?: string
  source: 'contact'
  contactId: number
}

interface EmailDefaultsPayload {
  recipients: {
    selected: EmailRecipientPayload[]
    suggestions: EmailRecipientPayload[]
  }
  subject: string
  body: string
  fournisseurNom: string
  numero: string
}

/** Build default email form state for a commande_fil. Splits the fournisseur's
 *  visible contacts with a valid email into two buckets: those flagged
 *  envoi_commande=1 go into `selected` (pre-filled chips), the rest into
 *  `suggestions` (clickable to add). */
async function buildEmailDefaults(id: number): Promise<EmailDefaultsPayload | null> {
  const rows = await query<CommandeFil>(`SELECT IDfournisseur FROM commande_fil WHERE IDcommande_fil = ${id}`)
  if (rows.length === 0) return null
  const header = rows[0] as any
  const idFrs = n(header.IDfournisseur)

  const [frsRows, contactRows] = await Promise.all([
    query<{ IDfournisseur: number; nom: string }>(
      `SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur = ${idFrs}`
    ),
    query<{ IDcontact: number; nom: string | null; prenom: string | null; mail: string | null; envoi_commande: number | null; est_visible: number | null }>(
      `SELECT IDcontact, nom, prenom, mail, envoi_commande, est_visible FROM contact WHERE IDfournisseur = ${idFrs}`
    ),
  ])
  const fixedFrs = await fixEncoding(frsRows, 'fournisseur', 'IDfournisseur', ['nom'])
  const fixedContacts = await fixEncoding(contactRows, 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])

  const fournisseurNom = ((fixedFrs[0] as any)?.nom ?? '').toString() || ''

  const selected: EmailRecipientPayload[] = []
  const suggestions: EmailRecipientPayload[] = []
  const seen = new Set<string>()
  for (const c of fixedContacts as any[]) {
    if (c.est_visible === 0) continue
    const raw = (c.mail ?? '').toString().trim()
    if (!raw) continue
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const displayName = [c.prenom, c.nom]
      .map((s: string | null) => (s ?? '').toString().trim())
      .filter((s: string) => s.length > 0)
      .join(' ')
    const recipient: EmailRecipientPayload = {
      email: raw,
      source: 'contact',
      contactId: n(c.IDcontact),
    }
    if (displayName) recipient.name = displayName
    if (c.envoi_commande === 1) selected.push(recipient)
    else suggestions.push(recipient)
  }

  const numero = String(id)
  const subject = `Bon de commande N°${numero} — ETS Malterre`
  const body =
    `Bonjour,\n\n` +
    `Veuillez trouver ci-joint notre bon de commande N°${numero}${fournisseurNom ? ` à destination de ${fournisseurNom}` : ''}.\n\n` +
    `Merci de bien vouloir nous confirmer la bonne réception de cette commande.\n\n` +
    `Cordialement,\n` +
    `ETS Malterre`

  return {
    recipients: { selected, suggestions },
    subject,
    body,
    fournisseurNom,
    numero,
  }
}

commandesFilRouter.get('/:id/email-defaults', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const defaults = await buildEmailDefaults(id)
    if (!defaults) { res.status(404).json({ error: 'Commande not found' }); return }
    res.json(defaults)
  } catch (err) {
    console.error('Error building email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const extraAttachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  content_base64: z.string().min(1),
  content_type: z.string().min(1).max(100),
})

const emailBody = z.object({
  to: z.array(z.string().email()).min(1, 'At least one recipient is required'),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20000),
  attach_pdf: z.boolean().optional(),
  extra_attachments: z.array(extraAttachmentSchema).optional(),
})

commandesFilRouter.post('/:id/email', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }

    const parsed = emailBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }

    // Look up the acting user's corporate email — required to impersonate.
    const senderEmail = await getUserEmail(req.userId)
    if (!senderEmail) {
      res.status(400).json({
        error: 'no_sender_email',
        message:
          "Aucune adresse email n'est associée à votre compte. Un administrateur doit en définir une dans Paramètres › Utilisateurs.",
      })
      return
    }

    // Look up the user's display name so the From header reads nicely.
    const userRows = await query<{ prenom: string | null; nom: string | null }>(
      `SELECT prenom, nom FROM utilisateur WHERE IDutilisateur = ${req.userId}`
    )
    const fixedUser = await fixEncoding(userRows, 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
    const u = (fixedUser[0] as any) ?? null
    const displayName = u
      ? [u.prenom, u.nom].filter((s: string | null) => s && s.trim()).map((s: string) => s.trim()).join(' ')
      : ''
    const fromName = displayName ? `${displayName} — ETS Malterre` : 'ETS Malterre'

    // Build the server-rendered PDF first (if requested), then append any
    // user-uploaded attachments the dialog sent along.
    const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
    if (parsed.data.attach_pdf !== false) {
      const data = await buildCommandePdfData(id)
      if (!data) { res.status(404).json({ error: 'Commande not found' }); return }
      const buffer = await renderCommandePdfBuffer(data)
      attachments.push({
        filename: `commande-fournisseur-${data.numero}.pdf`,
        content: buffer,
        contentType: 'application/pdf',
      })
    }
    for (const a of parsed.data.extra_attachments ?? []) {
      attachments.push({
        filename: a.filename,
        content: Buffer.from(a.content_base64, 'base64'),
        contentType: a.content_type,
      })
    }

    const messageId = await sendMail({
      from: senderEmail,
      fromName,
      to: parsed.data.to,
      cc: parsed.data.cc,
      bcc: parsed.data.bcc,
      subject: parsed.data.subject,
      body: parsed.data.body,
      attachments: attachments.length > 0 ? attachments : undefined,
    })

    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending commande-fil email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})

// ── Create commande ──────────────────────────────────────

commandesFilRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = commandeBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data
    const dateCmd = dateStr(d.date_commande)

    await query(
      `INSERT INTO commande_fil (IDfournisseur, date_commande, etat, commentaire, journal, IDadresse_fournisseur, IDadresse_livraison, IDmode_paiement, IDecheance) VALUES (${d.IDfournisseur}, '${dateCmd}', 0, '${esc(d.commentaire ?? '')}', '${esc(d.journal ?? '')}', ${d.IDadresse_fournisseur ?? 0}, ${d.IDadresse_livraison ?? 0}, ${d.IDmode_paiement ?? 0}, ${d.IDecheance ?? 0})`
    )

    // Fetch the newly inserted row
    const rows = await query<CommandeFil>(
      `SELECT * FROM commande_fil WHERE IDfournisseur = ${d.IDfournisseur} ORDER BY IDcommande_fil DESC`
    )
    const fixed = await fixEncoding(rows.slice(0, 1), 'commande_fil', 'IDcommande_fil', ['commentaire', 'journal'])
    res.status(201).json(fixed[0] ?? {})
  } catch (err) {
    console.error('Error creating commande-fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Update commande header ───────────────────────────────

commandesFilRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = commandeBody.partial().safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data

    const sets: string[] = []
    if (d.date_commande !== undefined) sets.push(`date_commande = '${dateStr(d.date_commande)}'`)
    if (d.etat !== undefined) sets.push(`etat = ${d.etat}`)
    if (d.commentaire !== undefined) sets.push(`commentaire = '${esc(d.commentaire)}'`)
    if (d.journal !== undefined) sets.push(`journal = '${esc(d.journal)}'`)
    if (d.IDadresse_fournisseur !== undefined) sets.push(`IDadresse_fournisseur = ${d.IDadresse_fournisseur}`)
    if (d.IDadresse_livraison !== undefined) sets.push(`IDadresse_livraison = ${d.IDadresse_livraison}`)
    if (d.IDmode_paiement !== undefined) sets.push(`IDmode_paiement = ${d.IDmode_paiement}`)
    if (d.IDecheance !== undefined) sets.push(`IDecheance = ${d.IDecheance}`)

    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }

    await query(`UPDATE commande_fil SET ${sets.join(', ')} WHERE IDcommande_fil = ${id}`)

    // Closing the commande (etat = 1) must close its lines too — a terminée
    // commande can't carry an "en cours" line. The line-level auto-close
    // (maybeAutoCloseCommande) only runs the other direction, so the manual
    // "Clôturer" toggle used to leave lines at etat = 0.
    if (d.etat === 1) {
      await query(`UPDATE ref_fil_commande SET etat = 1 WHERE IDcommande_fil = ${id} AND etat = 0`)
    }

    const rows = await query<CommandeFil>(`SELECT * FROM commande_fil WHERE IDcommande_fil = ${id}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Commande not found' }); return }
    const fixed = await fixEncoding(rows, 'commande_fil', 'IDcommande_fil', ['commentaire', 'journal'])
    res.json(fixed[0])
  } catch (err) {
    console.error('Error updating commande-fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Delete commande (cascades to lines) ──────────────────

commandesFilRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await query(`DELETE FROM ref_fil_commande WHERE IDcommande_fil = ${id}`)
    await query(`DELETE FROM commande_fil WHERE IDcommande_fil = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting commande-fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Create line ──────────────────────────────────────────

commandesFilRouter.post('/:id/lignes', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = ligneBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data
    const dateLiv = dateStr(d.date_livraison)

    if (refuseIfTerminee(res, await loadCommandeEtat(id))) return

    await query(
      `INSERT INTO ref_fil_commande (IDcommande_fil, IDref_fil, IDcolori_fil, quantite, unite, prix_unitaire, date_livraison, etat, date_notif) VALUES (${id}, ${d.IDref_fil}, ${d.IDcolori_fil}, ${n(d.quantite)}, ${d.unite ?? 1}, ${n(d.prix_unitaire)}, '${dateLiv}', ${d.etat ?? 0}, '')`
    )
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('Error creating ref_fil_commande:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Update line ──────────────────────────────────────────

commandesFilRouter.put('/lignes/:lineId', async (req: Request, res: Response) => {
  try {
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = ligneBody.partial().safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data

    const commandeId = await loadCommandeIdForLine(lineId)
    if (commandeId == null) { res.status(404).json({ error: 'Line not found' }); return }
    if (refuseIfTerminee(res, await loadCommandeEtat(commandeId))) return

    const sets: string[] = []
    if (d.IDref_fil !== undefined) sets.push(`IDref_fil = ${d.IDref_fil}`)
    if (d.IDcolori_fil !== undefined) sets.push(`IDcolori_fil = ${d.IDcolori_fil}`)
    if (d.quantite !== undefined) sets.push(`quantite = ${n(d.quantite)}`)
    if (d.unite !== undefined) sets.push(`unite = ${d.unite}`)
    if (d.prix_unitaire !== undefined) sets.push(`prix_unitaire = ${n(d.prix_unitaire)}`)
    if (d.date_livraison !== undefined) sets.push(`date_livraison = '${dateStr(d.date_livraison)}'`)
    if (d.etat !== undefined) sets.push(`etat = ${d.etat}`)

    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }

    await query(`UPDATE ref_fil_commande SET ${sets.join(', ')} WHERE IDref_fil_commande = ${lineId}`)

    if (d.etat === 1) await maybeAutoCloseCommande(commandeId)

    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating ref_fil_commande:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Delete line ──────────────────────────────────────────

commandesFilRouter.delete('/lignes/:lineId', async (req: Request, res: Response) => {
  try {
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const commandeId = await loadCommandeIdForLine(lineId)
    if (commandeId == null) { res.status(404).json({ error: 'Line not found' }); return }
    if (refuseIfTerminee(res, await loadCommandeEtat(commandeId))) return

    await query(`DELETE FROM ref_fil_commande WHERE IDref_fil_commande = ${lineId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting ref_fil_commande:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Stock linkage for a commande line ─────────────────────
//
// The reception clerk creates stock_fil lots via the Fournisseurs > Stock
// screen. The orders clerk then links those lots to a specific
// ref_fil_commande line from Fournisseurs > Commandes so everyone can see
// which lot fulfills which order line. The FK is stock_fil.IDref_fil_commande;
// a value of 0 (or NULL) means "not yet assigned to any line".

/** Load the context of a line + its commande header. Used to validate
 *  cross-commande access, and to derive the filter keys for "available"
 *  lots. Returns null if the line or commande does not exist / does not
 *  belong together. */
async function loadLineContext(commandeId: number, ligneId: number): Promise<{
  IDfournisseur: number
  IDref_fil: number
  IDcolori_fil: number
} | null> {
  const lineRows = await query<any>(
    `SELECT IDref_fil_commande, IDcommande_fil, IDref_fil, IDcolori_fil FROM ref_fil_commande WHERE IDref_fil_commande = ${ligneId}`
  )
  if (lineRows.length === 0) return null
  const line = lineRows[0]
  if (Number(line.IDcommande_fil) !== commandeId) return null

  const headerRows = await query<any>(
    `SELECT IDfournisseur FROM commande_fil WHERE IDcommande_fil = ${commandeId}`
  )
  if (headerRows.length === 0) return null

  return {
    IDfournisseur: Number(headerRows[0].IDfournisseur) || 0,
    IDref_fil: Number(line.IDref_fil) || 0,
    IDcolori_fil: Number(line.IDcolori_fil) || 0,
  }
}

/** Fetch both {linked, available} lot lists for a line. */
async function fetchLinkedAndAvailable(
  ctx: { IDfournisseur: number; IDref_fil: number; IDcolori_fil: number },
  ligneId: number,
): Promise<{ linked: Record<string, unknown>[]; available: Record<string, unknown>[] }> {
  const linked = await fetchStockLots(`WHERE sf.IDref_fil_commande = ${ligneId}`)
  const available = await fetchStockLots(
    `WHERE sf.IDref_fil = ${ctx.IDref_fil} AND sf.IDcolori_fil = ${ctx.IDcolori_fil} AND sf.IDfournisseur = ${ctx.IDfournisseur} AND (sf.IDref_fil_commande IS NULL OR sf.IDref_fil_commande = 0) AND sf.stock > 0`
  )
  return { linked, available }
}

// GET lots linked to a line + lots available to link
commandesFilRouter.get('/:commandeId/lignes/:ligneId/stock', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.commandeId, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const ctx = await loadLineContext(commandeId, ligneId)
    if (!ctx) { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }

    const payload = await fetchLinkedAndAvailable(ctx, ligneId)
    res.json(payload)
  } catch (err) {
    console.error('Error fetching line stock:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT link a stock lot to a line
commandesFilRouter.put('/:commandeId/lignes/:ligneId/stock/:stockId', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.commandeId, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    const stockId = parseInt(req.params.stockId, 10)
    if (isNaN(commandeId) || isNaN(ligneId) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const ctx = await loadLineContext(commandeId, ligneId)
    if (!ctx) { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }

    // Verify the stock row matches the line's (ref_fil, colori_fil, fournisseur)
    // and is currently unassigned. Defensive — the UI already filters.
    const stockRows = await query<any>(
      `SELECT IDstock_fil, IDfournisseur, IDref_fil, IDcolori_fil, IDref_fil_commande FROM stock_fil WHERE IDstock_fil = ${stockId}`
    )
    if (stockRows.length === 0) { res.status(404).json({ error: 'Stock lot not found' }); return }
    const s = stockRows[0]
    if (Number(s.IDref_fil) !== ctx.IDref_fil
      || Number(s.IDcolori_fil) !== ctx.IDcolori_fil
      || Number(s.IDfournisseur) !== ctx.IDfournisseur) {
      res.status(400).json({ error: 'Stock lot does not match line (ref_fil / colori_fil / fournisseur)' })
      return
    }
    const current = Number(s.IDref_fil_commande) || 0
    if (current !== 0 && current !== ligneId) {
      res.status(409).json({ error: 'Stock lot is already linked to another line' })
      return
    }

    await query(`UPDATE stock_fil SET IDref_fil_commande = ${ligneId} WHERE IDstock_fil = ${stockId}`)

    const payload = await fetchLinkedAndAvailable(ctx, ligneId)
    res.json(payload)
  } catch (err) {
    console.error('Error linking stock to line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE unlink a stock lot from a line
commandesFilRouter.delete('/:commandeId/lignes/:ligneId/stock/:stockId', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.commandeId, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    const stockId = parseInt(req.params.stockId, 10)
    if (isNaN(commandeId) || isNaN(ligneId) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const ctx = await loadLineContext(commandeId, ligneId)
    if (!ctx) { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }

    // Only unlink if the stock row is currently linked to THIS line — guards
    // against racing with a re-assignment from another screen.
    await query(`UPDATE stock_fil SET IDref_fil_commande = 0 WHERE IDstock_fil = ${stockId} AND IDref_fil_commande = ${ligneId}`)

    const payload = await fetchLinkedAndAvailable(ctx, ligneId)
    res.json(payload)
  } catch (err) {
    console.error('Error unlinking stock from line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Documents (GED) ─────────────────────────────────────
//
// Documents attached to a commande_fil live in the shared `ged` table with a
// polymorphic reverse-link: `IDreference = IDcommande_fil`. The discriminator
// is `IDtype_doc`. A single `ged` row may be shared across multiple parents
// (e.g. a GOTS cert attached simultaneously to a fournisseur commande, a
// client commande, and a sous-traitant commande in the same chain) — so we
// must NOT filter on `IDcommande_client = 0 AND IDcommande_sous_traitant = 0`,
// which silently hid every shared row from the legacy data. Instead we
// whitelist the IDtype_doc values whose IDreference points at commande_fil.
// Per-lot linkage (a doc attached to specific lots within the order) is
// handled separately via `stock_fil_ged`.

// IDtype_doc values offered in (and displayed in) a commande_fil's documents
// tab. Deliberately curated — BOTH the create dropdown (/lookups/type-doc) and
// the list/scope guards read this constant, so a type absent here can be
// neither created nor shown.
//   1 = facture fil
//   2 = autre (misc). Safe to share the generic "autre" type: every existing
//       "autre" row has IDreference=0 and is scoped by IDcommande_client/sst,
//       so a fil "autre" row (keyed by IDreference) can never collide with one.
//   5 = certificat de transaction GOTS
//   6 = bl fournisseur — the canonical delivery note for yarn orders
// Removed 2026-06-15:
//   15 (soumission) — a client-commande doc type. Its IDreference points at
//       commande_client ids that numerically collide with commande_fil ids, so
//       it leaked ~333 unrelated client docs (bl/certif/ARC/PL…) into fil tabs.
//   29 (bl fil) — unused (0 rows) and redundant with bl fournisseur.
const COMMANDE_FIL_DOC_TYPES = '1, 2, 5, 6'

// Type-doc lookup scoped to the types that can actually appear in a
// commande_fil's documents tab. The generic /fournisseurs/type-doc returns
// all 29 types; offering types like "labo coloris" in the create dropdown
// would let the user attach a doc that the list endpoint (filtered on
// COMMANDE_FIL_DOC_TYPES) then silently hides. Keep both in sync.
commandesFilRouter.get('/lookups/type-doc', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDtype_doc: number; nom: string | null }>(
      `SELECT IDtype_doc, nom FROM type_doc WHERE IDtype_doc IN (${COMMANDE_FIL_DOC_TYPES}) ORDER BY nom`
    )
    const fixed = await fixEncoding(rows, 'type_doc', 'IDtype_doc', ['nom'])
    res.json(fixed)
  } catch (err) {
    console.error('Error listing commande-fil type-doc:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesFilRouter.get('/:id/documents', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await query<{
      IDged: number
      nom: string | null
      commentaire: string | null
      IDtype_doc: number
      type_nom: string | null
    }>(
      `SELECT g.IDged, g.nom, g.commentaire, g.IDtype_doc, td.nom AS type_nom
       FROM ged g
       LEFT JOIN type_doc td ON g.IDtype_doc = td.IDtype_doc
       WHERE g.IDreference = ${id}
         AND g.IDtype_doc IN (${COMMANDE_FIL_DOC_TYPES})
       ORDER BY g.IDged DESC`
    )
    const fixed = await fixEncoding(rows, 'ged', 'IDged', ['nom', 'commentaire'])
    // type_nom comes from the joined type_doc table — fix it separately via a
    // targeted query keyed on IDtype_doc, because fixEncoding works on a single
    // base table at a time.
    const typeIds = Array.from(new Set(fixed.map((r) => r.IDtype_doc).filter((t) => t > 0)))
    const typeMap = new Map<number, string>()
    if (typeIds.length > 0) {
      const typeRows = await query<{ IDtype_doc: number; nom: string }>(
        `SELECT IDtype_doc, nom FROM type_doc WHERE IDtype_doc IN (${typeIds.join(',')})`
      )
      const fixedTypes = await fixEncoding(typeRows, 'type_doc', 'IDtype_doc', ['nom'])
      for (const t of fixedTypes) typeMap.set(t.IDtype_doc, t.nom)
    }
    // Fetch linked lots per doc in one batched query. Empty result for a
    // given IDged means "applies to all lots of the commande" (zero rows in
    // stock_fil_ged = no per-lot scoping, matches legacy semantics).
    const docIds = fixed.map((r) => r.IDged)
    const lotsByDoc = new Map<number, Array<{ IDstock_fil: number; lot: string | null }>>()
    if (docIds.length > 0) {
      const lotRows = await query<{ IDged: number; IDstock_fil: number; lot: string | null }>(
        `SELECT sfg.IDged, sf.IDstock_fil, sf.lot
         FROM stock_fil_ged sfg
         INNER JOIN stock_fil sf ON sfg.IDstock_fil = sf.IDstock_fil
         WHERE sfg.IDged IN (${docIds.join(',')})
         ORDER BY sf.lot`
      )
      for (const lr of lotRows) {
        const arr = lotsByDoc.get(lr.IDged) ?? []
        arr.push({ IDstock_fil: lr.IDstock_fil, lot: lr.lot })
        lotsByDoc.set(lr.IDged, arr)
      }
    }

    const out = fixed.map((r) => ({
      IDged: r.IDged,
      nom: r.nom,
      commentaire: r.commentaire,
      IDtype_doc: r.IDtype_doc,
      type_nom: typeMap.get(r.IDtype_doc) ?? null,
      linked_lots: lotsByDoc.get(r.IDged) ?? [],
    }))
    res.json(out)
  } catch (err) {
    console.error('Error listing commande-fil documents:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesFilRouter.get('/:id/documents/:idged/fichier', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const idged = parseInt(req.params.idged, 10)
    if (isNaN(id) || isNaN(idged)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // Scope the blob read by both :id and :idged so one commande cannot fetch
    // another commande's (or a client commande's) documents by guessing IDged.
    const rows = await queryRaw(
      `SELECT fichier FROM ged
       WHERE IDged = ${idged}
         AND IDreference = ${id}
         AND IDtype_doc IN (${COMMANDE_FIL_DOC_TYPES})`
    )
    if (rows.length === 0) { res.status(404).json({ error: 'Document not found' }); return }

    const fichier = rows[0].fichier
    if (fichier == null) { res.status(404).json({ error: 'No file attached' }); return }

    let buf: Buffer
    if (fichier instanceof ArrayBuffer) {
      buf = Buffer.from(fichier)
    } else if (Buffer.isBuffer(fichier)) {
      buf = fichier
    } else {
      res.status(404).json({ error: 'No file attached' }); return
    }

    // HFSQL BinMemo IS NOT NULL is unreliable — empty/null-terminator-only
    // blobs pass the null check. Return 404 here so the frontend HEAD pre-check
    // can hide the preview for empty rows.
    if (buf.length === 0 || (buf.length === 1 && buf[0] === 0)) {
      res.status(404).json({ error: 'No file attached' }); return
    }

    // MIME sniff from magic bytes (same taxonomy as fournisseurs certificats).
    let contentType = 'application/octet-stream'
    if (buf.length >= 4) {
      const h = buf.subarray(0, 4)
      if (h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46) contentType = 'application/pdf'
      else if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4E && h[3] === 0x47) contentType = 'image/png'
      else if (h[0] === 0xFF && h[1] === 0xD8) contentType = 'image/jpeg'
    }

    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', 'inline')
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.end(buf)
  } catch (err) {
    console.error('Error serving commande-fil document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /:id/documents — create a new document attached to this commande_fil.
// Mirrors the certificat upload flow in fournisseurs.ts: metadata INSERT
// first, then a hex-literal UPDATE for the blob because HFSQL ODBC doesn't
// accept parameterized binary values.
commandesFilRouter.post('/:id/documents', upload.single('fichier'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // Guard: commande must exist (avoid creating orphan ged rows pointing at
    // a non-existent IDreference).
    const cf = await query(`SELECT IDcommande_fil FROM commande_fil WHERE IDcommande_fil = ${id}`)
    if (cf.length === 0) { res.status(404).json({ error: 'Commande not found' }); return }

    const nom = (req.body.nom ?? '').toString()
    const commentaire = (req.body.commentaire ?? '').toString()
    const idTypeDoc = parseInt(req.body.IDtype_doc, 10) || 0

    await query(
      `INSERT INTO ged (nom, commentaire, IDtype_doc, IDreference, IDcommande_client, IDcommande_sous_traitant, IDdossier)
       VALUES ('${esc(nom)}', '${esc(commentaire)}', ${idTypeDoc}, ${id}, 0, 0, 0)`
    )

    // HFSQL has no RETURNING, so look up the just-inserted row by the highest
    // IDged for this commande. We also scope by IDcommande_client = 0 and
    // IDcommande_sous_traitant = 0 — the values we just wrote — to avoid
    // matching a legacy row that happens to be a higher IDged for the same
    // IDreference / IDtype_doc.
    const newRows = await query<{ IDged: number }>(
      `SELECT IDged FROM ged
       WHERE IDreference = ${id}
         AND IDcommande_client = 0
         AND IDcommande_sous_traitant = 0
         AND IDtype_doc = ${idTypeDoc}
       ORDER BY IDged DESC`
    )
    if (newRows.length === 0) { res.status(500).json({ error: 'Insert lookup failed' }); return }
    const newId = newRows[0].IDged

    if (req.file && req.file.buffer.length > 0) {
      const hexStr = req.file.buffer.toString('hex')
      await queryRaw(`UPDATE ged SET fichier = x'${hexStr}' WHERE IDged = ${newId}`)
    }

    res.status(201).json({ IDged: newId })
  } catch (err) {
    console.error('Error creating commande-fil document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /:id/documents/:idged — update metadata and optionally replace the
// file blob. `remove_fichier=1` (without a new file) clears the blob.
commandesFilRouter.put('/:id/documents/:idged', upload.single('fichier'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const idged = parseInt(req.params.idged, 10)
    if (isNaN(id) || isNaN(idged)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // Scope guard: only update ged rows that belong to THIS commande_fil.
    // Prevents a caller from editing another commande's documents by guessing
    // IDged.
    const scope = await query(
      `SELECT IDged FROM ged
       WHERE IDged = ${idged}
         AND IDreference = ${id}
         AND IDtype_doc IN (${COMMANDE_FIL_DOC_TYPES})`
    )
    if (scope.length === 0) { res.status(404).json({ error: 'Document not found' }); return }

    const sets: string[] = []
    if (req.body.nom !== undefined) sets.push(`nom = '${esc(String(req.body.nom))}'`)
    if (req.body.commentaire !== undefined) sets.push(`commentaire = '${esc(String(req.body.commentaire))}'`)
    if (req.body.IDtype_doc !== undefined) sets.push(`IDtype_doc = ${parseInt(req.body.IDtype_doc, 10) || 0}`)
    if (sets.length > 0) {
      await query(`UPDATE ged SET ${sets.join(', ')} WHERE IDged = ${idged}`)
    }

    if (req.file && req.file.buffer.length > 0) {
      const hexStr = req.file.buffer.toString('hex')
      await queryRaw(`UPDATE ged SET fichier = x'${hexStr}' WHERE IDged = ${idged}`)
    } else if (req.body.remove_fichier === '1') {
      await query(`UPDATE ged SET fichier = NULL WHERE IDged = ${idged}`)
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating commande-fil document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /:id/documents/:idged — scoped delete, same guard as PUT.
commandesFilRouter.delete('/:id/documents/:idged', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const idged = parseInt(req.params.idged, 10)
    if (isNaN(id) || isNaN(idged)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const scope = await query(
      `SELECT IDged FROM ged
       WHERE IDged = ${idged}
         AND IDreference = ${id}
         AND IDtype_doc IN (${COMMANDE_FIL_DOC_TYPES})`
    )
    if (scope.length === 0) { res.status(404).json({ error: 'Document not found' }); return }

    await query(`DELETE FROM ged WHERE IDged = ${idged}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting commande-fil document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Document ↔ stock_fil lot linkage (per-lot doc scope) ────────
//
// stock_fil_ged is the M:N linker. A GOTS certificate (or any other doc)
// attached to a commande_fil can additionally be scoped to specific lots
// within that commande. The UI in DocCreateEditDialog shows a checkbox list
// of all lots reachable via this commande's ref_fil_commande rows; clicking
// a checkbox PUTs or DELETEs a single stock_fil_ged row and echoes back the
// refreshed {linked, available} payload so the dialog can hydrate without
// a follow-up fetch.

/** Throws 404 semantics via return null if the ged row doesn't belong to the
 *  given commande_fil. Callers check the return and short-circuit. */
async function verifyDocBelongsToCommande(commandeId: number, idged: number): Promise<boolean> {
  const rows = await query(
    `SELECT IDged FROM ged
     WHERE IDged = ${idged}
       AND IDreference = ${commandeId}
       AND IDtype_doc IN (${COMMANDE_FIL_DOC_TYPES})`
  )
  return rows.length > 0
}

/** Build the {linked, available} payload for a given ged row + commande.
 *  `linked` = stock_fil rows currently in stock_fil_ged for this IDged that
 *  are also reachable via this commande's ref_fil_commande lines.
 *  `available` = the remaining lots of the commande not yet linked. */
async function fetchDocLots(commandeId: number, idged: number) {
  // All lots belonging to this commande, via the order-line linkage.
  const all = await fetchStockLots(
    `WHERE sf.IDref_fil_commande IN (
      SELECT IDref_fil_commande FROM ref_fil_commande WHERE IDcommande_fil = ${commandeId}
    )`
  )
  const linkedRows = await query<{ IDstock_fil: number }>(
    `SELECT IDstock_fil FROM stock_fil_ged WHERE IDged = ${idged}`
  )
  const linkedSet = new Set(linkedRows.map((r) => r.IDstock_fil))
  const linked = all.filter((r) => linkedSet.has(r.IDstock_fil as number))
  const available = all.filter((r) => !linkedSet.has(r.IDstock_fil as number))
  return { linked, available }
}

commandesFilRouter.get('/:id/documents/:idged/lots', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const idged = parseInt(req.params.idged, 10)
    if (isNaN(id) || isNaN(idged)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await verifyDocBelongsToCommande(id, idged))) {
      res.status(404).json({ error: 'Document not found' }); return
    }
    const payload = await fetchDocLots(id, idged)
    res.json(payload)
  } catch (err) {
    console.error('Error listing doc lots:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesFilRouter.put('/:id/documents/:idged/lots/:stockId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const idged = parseInt(req.params.idged, 10)
    const stockId = parseInt(req.params.stockId, 10)
    if (isNaN(id) || isNaN(idged) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await verifyDocBelongsToCommande(id, idged))) {
      res.status(404).json({ error: 'Document not found' }); return
    }
    // Scope the stock row to this commande too — prevents a caller from
    // linking an arbitrary stock_fil (from another commande or freestanding)
    // to a doc that's technically attached to a different commande.
    const scope = await query<{ IDstock_fil: number }>(
      `SELECT sf.IDstock_fil FROM stock_fil sf
       INNER JOIN ref_fil_commande rfc ON sf.IDref_fil_commande = rfc.IDref_fil_commande
       WHERE sf.IDstock_fil = ${stockId} AND rfc.IDcommande_fil = ${id}`
    )
    if (scope.length === 0) {
      res.status(400).json({ error: 'Lot does not belong to this commande' }); return
    }
    // Idempotent insert — skip if the link already exists.
    const existing = await query<{ IDstock_fil_ged: number }>(
      `SELECT IDstock_fil_ged FROM stock_fil_ged WHERE IDged = ${idged} AND IDstock_fil = ${stockId}`
    )
    if (existing.length === 0) {
      await query(`INSERT INTO stock_fil_ged (IDged, IDstock_fil) VALUES (${idged}, ${stockId})`)
    }
    const payload = await fetchDocLots(id, idged)
    res.json(payload)
  } catch (err) {
    console.error('Error linking doc to lot:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Bulk unlink — clears every stock_fil_ged row for this IDged. Used when
// the user flips the "Appliquer à tous les lots" toggle back on: zero rows
// in stock_fil_ged semantically means "no per-lot scoping, applies to the
// whole commande" (matches legacy behavior).
commandesFilRouter.delete('/:id/documents/:idged/lots', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const idged = parseInt(req.params.idged, 10)
    if (isNaN(id) || isNaN(idged)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await verifyDocBelongsToCommande(id, idged))) {
      res.status(404).json({ error: 'Document not found' }); return
    }
    await query(`DELETE FROM stock_fil_ged WHERE IDged = ${idged}`)
    const payload = await fetchDocLots(id, idged)
    res.json(payload)
  } catch (err) {
    console.error('Error clearing doc lots:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesFilRouter.delete('/:id/documents/:idged/lots/:stockId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const idged = parseInt(req.params.idged, 10)
    const stockId = parseInt(req.params.stockId, 10)
    if (isNaN(id) || isNaN(idged) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await verifyDocBelongsToCommande(id, idged))) {
      res.status(404).json({ error: 'Document not found' }); return
    }
    await query(`DELETE FROM stock_fil_ged WHERE IDged = ${idged} AND IDstock_fil = ${stockId}`)
    const payload = await fetchDocLots(id, idged)
    res.json(payload)
  } catch (err) {
    console.error('Error unlinking doc from lot:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
