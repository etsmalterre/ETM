// Devis client — customer quotations (devis_etm / ligne_devis_etm).
// The ETM "Devis ETM" screen: build quotes, auto-suggest line prices from the
// PrixDeVenteV4 cost engine, and (when accepted) "passer en commande" — convert
// a devis into a commande_client. Mirrors the structure of commandes-client.ts
// (PDF, email, documents, historique, the En cours / Soldé footer) but a devis
// NEVER reserves stock, so there is no affectation drawer here.
//
// Hard rules baked in (verified against live data + CLAUDE.md HFSQL section):
//  - Scope: every read/write of the client-devis list is IDprospect = 0
//    (IDprospect > 0 rows are prospect quotes, owned by a separate screen).
//    devis_etm has NO IDsociete column.
//  - numero allocator: MAX(numero)+1 over the whole devis_etm table (the legacy
//    sequence is global, shared with prospect devis), with a retry loop.
//  - `date` is a reserved word → read case-insensitively (SELECT * returns it as
//    `DATE`), write the bare `date = '...'`. `date_expiration` is plain.
//  - `remise` is a FRACTION (0.05 = 5%), not euros — total = Σ(qty×prix) ×
//    (1 − remise) + frais_port. The UI shows it as a %.
//  - Accented columns (devis_etm.archivé, ligne_devis_etm.delai_annoncé /
//    déverrouiller) are NEVER named in SQL — the Linux iODBC bridge can't
//    tokenize them. SELECT * + prune for reads; omit on writes (HFSQL zero-fills).
//  - `SELECT * FROM client` returns 0 rows on this driver — explicit columns only.
//  - ligne_devis_etm.TYPE is a reserved word (alias `TYPE AS type_kind`, write
//    uppercase). Line polymorphism: 1 = écru (ref_ecru), 2 = fini (ref_fini),
//    3 = divers (ref_divers). Type-2 lines also carry IDref_ecru (resolved from
//    ref_fini.IDref_ecru) so the legacy app still reads them correctly.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import { query, queryRaw, fixEncoding } from '../lib/hfsql-auto.js'
import { DevisEtmPdf, type DevisEtmPdfData } from '../lib/pdf/DevisEtmPdf.js'
import { calcTarifRefFini } from '../lib/pricing-fini-tarif.js'
import { loadClientTvaRate } from '../lib/tva.js'
import { sendMail } from '../lib/gmail.js'
import { getUserEmail } from '../lib/user-emails.js'
import { stripRtf } from '../lib/rtf-utils.js'
import { IS_WINDOWS, esc, n, dateDigits as dateStr } from '../lib/sst-shared.js'

const upload = multer({ storage: multer.memoryStorage() })
export const devisRouter: RouterType = Router()

// type_doc 28 = "devis" — the ged document discriminator + envoi_email audit
// log type for client quotations (verified live; unique to devis, so it
// disambiguates devis docs from other IDreference-keyed entities).
const TYPE_DOC_DEVIS = 28

// ── Small SQL/format helpers (shared shape with commandes-client.ts) ──

/** SQL literal for a user-supplied text value. Pure ASCII → quoted literal;
 *  anything with accents → Latin-1 hex literal (the Linux iODBC bridge
 *  corrupts raw multi-byte UTF-8 embedded in a SQL line). */
function sqlText(value: string | null | undefined): string {
  const v = (value ?? '').toString()
  if (v === '') return "''"
  if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(v)) return `'${esc(v)}'`
  const ascii = v
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
  const bytes = Buffer.from(
    Array.from(ascii, (ch) => {
      const c = ch.codePointAt(0) ?? 0x3f
      return c <= 0xff ? c : 0x3f
    }),
  )
  return `x'${bytes.toString('hex')}'`
}

function nowHfsqlDatetime(): string {
  const d = new Date()
  const pad = (x: number, w = 2) => String(x).padStart(w, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  )
}

function todayHfsql(): string {
  const t = new Date()
  return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`
}

const FRENCH_MONTHS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
] as const

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

function formatHfsqlDateFr(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = String(raw)
  if (/^\d{8}$/.test(s)) return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`
  return ''
}

function cleanAddrField(s: string | null | undefined): string | null {
  if (!s) return null
  const t = String(s).trim()
  if (!t) return null
  if (/^[.\-_·•\s]+$/.test(t)) return null
  return t
}

/** Decode an ODBC value (ArrayBuffer / string) to a JS string. */
function decode(v: unknown): string | null {
  if (v instanceof ArrayBuffer) return Buffer.from(v).toString('utf8')
  if (typeof v === 'string') return v
  return null
}

/** Normalise for accent-insensitive contains-matching (search). */
function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

/** `date` is a reserved word: SELECT * returns it as `DATE` on this driver.
 *  Read it case-insensitively from a row. */
function pickDate(row: Record<string, unknown>): string | null {
  const v = row.DATE ?? row.date ?? null
  return v == null ? null : String(v)
}

// ── Line unit semantics (hardcoded WinDev combo; no lookup table) ──

function uniteLabel(u: number | null | undefined): string {
  switch (Number(u)) {
    case 1: return 'Kg'
    case 3: return 'Ml'
    case 4: return 'U'
    case 5: return 'm²'
    default: return ''
  }
}

// ── Lifecycle helpers ────────────────────────────────────

async function loadDevisSoldee(devisId: number): Promise<number | null> {
  const rows = await query<{ est_soldee: number | null }>(
    `SELECT est_soldee FROM devis_etm WHERE IDDevis_etm = ${devisId}`,
  )
  if (rows.length === 0) return null
  return rows[0].est_soldee ?? 0
}

async function loadDevisIdForLine(lineId: number): Promise<number | null> {
  const rows = await query<{ IDDevis_etm: number }>(
    `SELECT IDDevis_etm FROM ligne_devis_etm WHERE IDligne_devis_etm = ${lineId}`,
  )
  if (rows.length === 0) return null
  return Number(rows[0].IDDevis_etm) || null
}

function refuseIfSoldee(res: Response, est_soldee: number | null): boolean {
  if (est_soldee === 1) {
    res.status(409).json({
      error: 'devis_solde',
      message: 'Devis soldé — revalider le devis pour le modifier.',
    })
    return true
  }
  return false
}

/** Next numero for the devis ledger. The legacy sequence is global (shared with
 *  prospect devis): MAX(numero)+1 over the whole table; concurrent POSTs retry. */
async function nextNumero(): Promise<number> {
  const r = await query<{ m: number | null }>(`SELECT MAX(numero) AS m FROM devis_etm`)
  return (Number(r[0]?.m) || 0) + 1
}

/** Resolve a type-2 (fini) line's underlying écru ref (legacy stores it on the
 *  line for the stock panel + pricing). Type 1 → the ref IS the écru; type 3 → 0. */
async function resolveLineRefEcru(typeKind: number, IDreference: number): Promise<number> {
  if (typeKind === 1) return IDreference > 0 ? IDreference : 0
  if (typeKind === 2 && IDreference > 0) {
    const rows = await query<{ IDref_ecru: number | null }>(
      `SELECT IDref_ecru FROM ref_fini WHERE IDref_fini = ${IDreference}`,
    )
    return Number(rows[0]?.IDref_ecru) || 0
  }
  return 0
}

// ── Client name resolution (batched, flat — never SELECT *) ──

async function resolveClientNames(clientIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const ids = Array.from(new Set(clientIds.filter((x) => x > 0)))
  if (ids.length === 0) return out
  const rows = await query<{ IDclient: number; nom: string | null }>(
    `SELECT IDclient, nom FROM client WHERE IDclient IN (${ids.join(',')})`,
  )
  const fixed = await fixEncoding(rows, 'client', 'IDclient', ['nom'])
  for (const r of fixed) out.set(Number(r.IDclient), (r.nom ?? '').toString().trim())
  return out
}

// ── Validation schemas ───────────────────────────────────

const devisBody = z.object({
  IDclient: z.number().int().positive().optional(),
  date: z.string().optional(),
  date_expiration: z.string().optional(),
  ref_client: z.string().optional(),
  IDadresse_livraison: z.number().int().nonnegative().optional(),
  IDadresse_facturation: z.number().int().nonnegative().optional(),
  IDmode_paiement: z.number().int().nonnegative().optional(),
  IDecheance: z.number().int().nonnegative().optional(),
  commentaire: z.string().optional(),
  commentaire_interne: z.string().optional(),
  remise: z.number().optional(), // fraction (0.05 = 5%)
  frais_port: z.number().optional(),
  est_soldee: z.number().int().min(0).max(1).optional(),
})

const ligneBody = z.object({
  type: z.number().int().optional(),
  IDreference: z.number().int().nonnegative().optional(),
  IDcolori: z.number().int().nonnegative().optional(),
  quantite: z.number().optional(),
  unite: z.number().int().optional(),
  prix: z.number().optional(),
  poids: z.number().optional(),
  date_livraison: z.string().optional(),
  commentaire: z.string().optional(),
})

// ════════════════════════════════════════════════════════
//  LOOKUPS  (literal paths — must register before /:id)
// ════════════════════════════════════════════════════════

devisRouter.get('/lookups/clients', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDclient: number; nom: string | null }>(
      `SELECT IDclient, nom FROM client WHERE est_visible = 1 ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'client', 'IDclient', ['nom'])
    res.json(fixed.map((r) => ({ IDclient: Number(r.IDclient), nom: (r.nom ?? '').toString() })))
  } catch (err) {
    console.error('Error fetching clients lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.get('/lookups/adresses', async (req: Request, res: Response) => {
  try {
    const cid = parseInt(String(req.query.client ?? ''), 10)
    if (isNaN(cid)) { res.status(400).json({ error: 'client query parameter required' }); return }
    const rows = await query(
      `SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays,
              est_defaut, est_defaut_facturation, est_defaut_livraison
       FROM adresse
       WHERE IDclient = ${cid} AND (est_visible IS NULL OR est_visible = 1)
       ORDER BY est_defaut DESC, IDadresse`,
    )
    const fixed = await fixEncoding(rows, 'adresse', 'IDadresse', [
      'nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays',
    ])
    res.json(fixed)
  } catch (err) {
    console.error('Error fetching adresses lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.get('/lookups/refs-ecru', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDref_ecru: number; reference: string | null }>(
      `SELECT IDref_ecru, reference FROM ref_ecru ORDER BY reference`,
    )
    const fixed = await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['reference'])
    res.json(fixed.map((r) => ({ IDref_ecru: Number(r.IDref_ecru), reference: r.reference ?? '' })))
  } catch (err) {
    console.error('Error fetching refs-ecru lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.get('/lookups/colori-ecru', async (req: Request, res: Response) => {
  try {
    const refEcru = parseInt(String(req.query.ref_ecru ?? ''), 10)
    const where = !isNaN(refEcru) && refEcru > 0 ? `WHERE IDref_ecru = ${refEcru}` : ''
    const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(
      `SELECT IDcolori_ecru, reference FROM colori_ecru ${where} ORDER BY reference`,
    )
    const fixed = await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference'])
    res.json(fixed.map((r) => ({ IDcolori_ecru: Number(r.IDcolori_ecru), reference: r.reference ?? '' })))
  } catch (err) {
    console.error('Error fetching colori-ecru lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.get('/lookups/refs-fini', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{
      IDref_fini: number; reference: string | null; designation: string | null; avec_teinture: number | null
    }>(
      `SELECT IDref_fini, reference, designation, avec_teinture FROM ref_fini ORDER BY reference`,
    )
    const fixed = await fixEncoding(rows, 'ref_fini', 'IDref_fini', ['reference', 'designation'])
    res.json(fixed.map((r) => ({
      IDref_fini: Number(r.IDref_fini),
      reference: r.reference ?? '',
      designation: r.designation ?? '',
      avec_teinture: Number(r.avec_teinture) || 0,
    })))
  } catch (err) {
    console.error('Error fetching refs-fini lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Coloris for a ref_fini — branch on avec_teinture (0 = colori_ecru of the
// ref's IDref_ecru, 1/2 = ref_fini_colori). Returned id goes into IDcolori.
devisRouter.get('/lookups/colori-fini', async (req: Request, res: Response) => {
  try {
    const refFini = parseInt(String(req.query.ref_fini ?? ''), 10)
    if (isNaN(refFini) || refFini <= 0) { res.status(400).json({ error: 'ref_fini query parameter required' }); return }
    const refRows = await query<{ avec_teinture: number | null; IDref_ecru: number | null }>(
      `SELECT avec_teinture, IDref_ecru FROM ref_fini WHERE IDref_fini = ${refFini}`,
    )
    const avecTeinture = Number(refRows[0]?.avec_teinture) || 0
    if (avecTeinture === 0) {
      const idEcru = Number(refRows[0]?.IDref_ecru) || 0
      const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(
        `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDref_ecru = ${idEcru} ORDER BY reference`,
      )
      const fixed = await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference'])
      res.json(fixed.map((r) => ({ id: Number(r.IDcolori_ecru), reference: r.reference ?? '' })))
    } else {
      const rows = await query<{ IDref_fini_colori: number; reference: string | null }>(
        `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini = ${refFini} ORDER BY reference`,
      )
      const fixed = await fixEncoding(rows, 'ref_fini_colori', 'IDref_fini_colori', ['reference'])
      res.json(fixed.map((r) => ({ id: Number(r.IDref_fini_colori), reference: r.reference ?? '' })))
    }
  } catch (err) {
    console.error('Error fetching colori-fini lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.get('/lookups/refs-divers', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDref_divers: number; designation: string | null; unite: number | null }>(
      `SELECT IDref_divers, designation, unite FROM ref_divers ORDER BY designation`,
    )
    const fixed = await fixEncoding(rows, 'ref_divers', 'IDref_divers', ['designation'])
    res.json(fixed.map((r) => ({
      IDref_divers: Number(r.IDref_divers),
      designation: r.designation ?? '',
      unite: Number(r.unite) || 0,
    })))
  } catch (err) {
    console.error('Error fetching refs-divers lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.get('/lookups/modes-paiement', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDmode_paiement: number; libelle: string | null }>(
      `SELECT IDmode_paiement, libelle FROM mode_paiement WHERE est_visible = 1 ORDER BY libelle`,
    )
    const fixed = await fixEncoding(rows, 'mode_paiement', 'IDmode_paiement', ['libelle'])
    res.json(fixed.map((r) => ({ IDmode_paiement: Number(r.IDmode_paiement), libelle: r.libelle ?? '' })))
  } catch (err) {
    console.error('Error fetching modes-paiement lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.get('/lookups/echeances', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDecheance: number; libelle: string | null }>(
      `SELECT IDecheance, libelle FROM echeance WHERE est_visible = 1 ORDER BY IDecheance`,
    )
    const fixed = await fixEncoding(rows, 'echeance', 'IDecheance', ['libelle'])
    res.json(fixed.map((r) => ({ IDecheance: Number(r.IDecheance), libelle: r.libelle ?? '' })))
  } catch (err) {
    console.error('Error fetching echeances lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.get('/lookups/type-doc', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDtype_doc: number; nom: string | null }>(
      `SELECT IDtype_doc, nom FROM type_doc ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'type_doc', 'IDtype_doc', ['nom'])
    res.json(fixed.map((r) => ({ IDtype_doc: Number(r.IDtype_doc), nom: r.nom ?? '' })))
  } catch (err) {
    console.error('Error listing devis type-doc:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  PRICING  (auto-suggest a line price from PrixDeVenteV4)
// ════════════════════════════════════════════════════════

/** Pick the tariff tranche for a roll count. Tranche 0 is the "< 1 roll"
 *  métrage row; tranches 1..8 are at roll counts [1,2,3,4,5,10,15,30]. */
function pickTranche<T extends { rolls: number; isMetrage: boolean }>(tranches: T[], nbRolls: number): T | null {
  if (tranches.length === 0) return null
  if (nbRolls < 1) return tranches[0]
  let chosen = tranches.find((t) => !t.isMetrage) ?? tranches[0]
  for (const t of tranches) {
    if (!t.isMetrage && t.rolls <= nbRolls + 1e-9) chosen = t
  }
  return chosen
}

// GET /pricing/suggest?ref_fini=&coloris=&quantite=&unite=
// Reuses calcTarifRefFini (the ported PrixDeVenteV4). Returns the volume-tranche
// price for the requested quantity. Suggestion only — the line price stays
// user-editable. Only finished (type-2) refs are auto-priced.
devisRouter.get('/pricing/suggest', async (req: Request, res: Response) => {
  try {
    const refFini = parseInt(String(req.query.ref_fini ?? ''), 10)
    const coloris = parseInt(String(req.query.coloris ?? ''), 10)
    const quantite = Number(req.query.quantite ?? 0) || 0
    const unite = parseInt(String(req.query.unite ?? '3'), 10) || 3
    if (isNaN(refFini) || refFini <= 0) { res.status(400).json({ error: 'ref_fini required' }); return }

    const tarif = await calcTarifRefFini(refFini, isNaN(coloris) ? 0 : coloris)
    if (!tarif.tranches.length || !tarif.ref_ecru) {
      res.json({ prix: null, reason: 'no_tarif' })
      return
    }
    const poids = Number(tarif.ref_ecru.poids) || 0
    // Roll geometry uses round2(rendement) — same basis calcTarifRefFini uses to
    // size each tranche's qte_ml (matches the validated commande auto-price).
    const rendement = Math.round((Number(tarif.rendement) || 0) * 100) / 100
    // Quantity → roll count: Ml lines divide by the per-roll metrage
    // (poids × rendement); Kg lines divide by per-roll weight.
    let nbRolls = 0
    if (unite === 3) nbRolls = poids > 0 && rendement > 0 ? quantite / (poids * rendement) : 0
    else if (unite === 1) nbRolls = poids > 0 ? quantite / poids : 0
    else nbRolls = quantite
    const tr = pickTranche(tarif.tranches, nbRolls)
    if (!tr) { res.json({ prix: null, reason: 'no_tranche' }); return }
    const prix = unite === 3 ? tr.moPrixDeVenteAuMl : tr.moPrixDeVenteAuKg
    res.json({
      prix: Math.round(prix * 100) / 100,
      tranche_rolls: tr.rolls,
      is_metrage: tr.isMetrage,
      nb_rolls: Math.round(nbRolls * 100) / 100,
      unite,
      source: 'PrixDeVenteV4',
    })
  } catch (err) {
    console.error('Error suggesting devis price:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  URGENCY  (header pills: expired / expiring soon by date_expiration)
// ════════════════════════════════════════════════════════

async function computeUrgencyBuckets(): Promise<{ late: Set<number>; soon: Set<number> }> {
  const late = new Set<number>()
  const soon = new Set<number>()
  // Open client devis only; SELECT * so the accented archivé key is ignored.
  const rows = await query<any>(
    `SELECT IDDevis_etm, date_expiration, est_soldee, IDprospect FROM devis_etm
     WHERE IDprospect = 0 AND est_soldee = 0`,
  )
  const today = new Date(); today.setHours(0, 0, 0, 0)
  for (const r of rows) {
    const id = Number(r.IDDevis_etm) || 0
    if (id <= 0) continue
    const e = typeof r.date_expiration === 'string' ? r.date_expiration : ''
    if (!/^\d{8}$/.test(e)) continue // no expiration set → not flagged
    const target = new Date(Number(e.slice(0, 4)), Number(e.slice(4, 6)) - 1, Number(e.slice(6, 8)))
    target.setHours(0, 0, 0, 0)
    const diff = Math.round((target.getTime() - today.getTime()) / 86_400_000)
    if (diff <= 0) late.add(id)
    else if (diff <= 3) soon.add(id)
  }
  return { late, soon }
}

devisRouter.get('/urgency-counts', async (_req: Request, res: Response) => {
  try {
    const { late, soon } = await computeUrgencyBuckets()
    res.json({ late: late.size, soon: soon.size })
  } catch (err) {
    console.error('Error fetching devis urgency counts:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════

devisRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim()
    const statusFilter = String(req.query.status ?? 'all')
    const isSearching = q.length > 0

    // Scope: client devis only (IDprospect = 0). Status maps to est_soldee.
    // SELECT * so the accented archivé key comes back mangled and is ignored.
    let rows = await query<any>(
      `SELECT * FROM devis_etm WHERE IDprospect = 0 ORDER BY numero DESC`,
    )
    if (statusFilter === 'terminee') rows = rows.filter((r: any) => Number(r.est_soldee) === 1)
    else if (statusFilter === 'open') rows = rows.filter((r: any) => Number(r.est_soldee) !== 1)

    // Client-name search (resolve names then filter in JS to dodge LIKE accents).
    const clientIds = rows.map((r: any) => Number(r.IDclient)).filter(Boolean)
    const clientNames = await resolveClientNames(clientIds)
    if (isSearching) {
      const nq = norm(q)
      const isNum = /^\d+$/.test(q)
      rows = rows.filter((r: any) => {
        const numHit = isNum && Number(r.numero) === parseInt(q, 10)
        const nameHit = norm(clientNames.get(Number(r.IDclient)) ?? '').includes(nq)
        return numHit || nameHit
      })
    }

    // Urgency narrowing (urgency_in=late,soon).
    const urgencyTokens = String(req.query.urgency_in ?? '')
      .split(',').map((s) => s.trim()).filter((s) => s === 'late' || s === 'soon')
    if (urgencyTokens.length > 0) {
      const buckets = await computeUrgencyBuckets()
      const merged = new Set<number>()
      if (urgencyTokens.includes('late')) for (const id of buckets.late) merged.add(id)
      if (urgencyTokens.includes('soon')) for (const id of buckets.soon) merged.add(id)
      rows = rows.filter((r: any) => merged.has(Number(r.IDDevis_etm)))
    }

    const limitRaw = parseInt(String(req.query.limit ?? ''), 10)
    const limit = isNaN(limitRaw) ? 200 : Math.min(Math.max(limitRaw, 1), 500)
    rows = rows.slice(0, limit)

    // Line aggregates: nb_lignes, total_qte, total_eur (Σ qty×prix).
    const ids = rows.map((r: any) => Number(r.IDDevis_etm)).filter(Boolean)
    const totalsMap = new Map<number, { total_eur: number; total_qte: number; nb_lignes: number }>()
    if (ids.length > 0) {
      const lignes = await query<any>(
        `SELECT IDDevis_etm, quantite, prix FROM ligne_devis_etm WHERE IDDevis_etm IN (${ids.join(',')})`,
      )
      for (const l of lignes) {
        const id = Number(l.IDDevis_etm)
        const acc = totalsMap.get(id) ?? { total_eur: 0, total_qte: 0, nb_lignes: 0 }
        const qty = Number(l.quantite) || 0
        const price = Number(l.prix) || 0
        acc.total_qte += qty
        acc.total_eur += qty * price
        acc.nb_lignes += 1
        totalsMap.set(id, acc)
      }
    }

    const result = rows.map((r: any) => {
      const id = Number(r.IDDevis_etm)
      const totals = totalsMap.get(id) ?? { total_eur: 0, total_qte: 0, nb_lignes: 0 }
      const remise = Number(r.remise) || 0
      const totalNet = totals.total_eur * (1 - remise) + (Number(r.frais_port) || 0)
      return {
        IDDevis_etm: id,
        IDclient: Number(r.IDclient) || 0,
        numero: r.numero != null ? Number(r.numero) : null,
        date: pickDate(r),
        date_expiration: r.date_expiration ?? null,
        est_soldee: Number(r.est_soldee) || 0,
        IDcommande_ETM: Number(r.IDcommande_ETM) || 0,
        client_nom: clientNames.get(Number(r.IDclient)) ?? '',
        total_eur: totalNet,
        total_qte: totals.total_qte,
        nb_lignes: totals.nb_lignes,
      }
    })
    res.json(result)
  } catch (err) {
    console.error('Error fetching devis:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  LINE REF / COLORIS RESOLUTION (shared by detail + PDF)
// ════════════════════════════════════════════════════════

interface ResolvedMaps {
  ecru: Map<number, string>
  fini: Map<number, string>
  divers: Map<number, string>
  finiAvecTeinture: Map<number, number>
  colorisFini: Map<number, string>
  colorisEcru: Map<number, string>
}

async function resolveLineLabels(
  lignes: Array<{ IDreference: number | null; IDcolori: number | null; type_kind: number }>,
): Promise<ResolvedMaps> {
  const refIds = Array.from(new Set(lignes.map((l) => Number(l.IDreference) || 0).filter((x) => x > 0)))
  const coloriIds = Array.from(new Set(lignes.map((l) => Number(l.IDcolori) || 0).filter((x) => x > 0)))
  const ecru = new Map<number, string>()
  const fini = new Map<number, string>()
  const divers = new Map<number, string>()
  const finiAvecTeinture = new Map<number, number>()
  const colorisFini = new Map<number, string>()
  const colorisEcru = new Map<number, string>()

  if (refIds.length > 0) {
    const [ecruRows, finiRows, diversRows] = await Promise.all([
      query<{ IDref_ecru: number; reference: string | null }>(
        `SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru IN (${refIds.join(',')})`,
      ),
      query<{ IDref_fini: number; reference: string | null; avec_teinture: number | null }>(
        `SELECT IDref_fini, reference, avec_teinture FROM ref_fini WHERE IDref_fini IN (${refIds.join(',')})`,
      ),
      query<{ IDref_divers: number; designation: string | null }>(
        `SELECT IDref_divers, designation FROM ref_divers WHERE IDref_divers IN (${refIds.join(',')})`,
      ),
    ])
    for (const r of await fixEncoding(ecruRows, 'ref_ecru', 'IDref_ecru', ['reference']))
      ecru.set(Number(r.IDref_ecru), (r.reference ?? '').toString())
    for (const r of await fixEncoding(finiRows, 'ref_fini', 'IDref_fini', ['reference'])) {
      fini.set(Number(r.IDref_fini), (r.reference ?? '').toString())
      finiAvecTeinture.set(Number(r.IDref_fini), Number((r as any).avec_teinture) || 0)
    }
    for (const r of await fixEncoding(diversRows, 'ref_divers', 'IDref_divers', ['designation']))
      divers.set(Number(r.IDref_divers), (r.designation ?? '').toString())
  }
  if (coloriIds.length > 0) {
    const [finiC, ecruC] = await Promise.all([
      query<{ IDref_fini_colori: number; reference: string | null }>(
        `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori IN (${coloriIds.join(',')})`,
      ),
      query<{ IDcolori_ecru: number; reference: string | null }>(
        `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${coloriIds.join(',')})`,
      ),
    ])
    for (const c of await fixEncoding(finiC, 'ref_fini_colori', 'IDref_fini_colori', ['reference']))
      colorisFini.set(Number(c.IDref_fini_colori), (c.reference ?? '').toString())
    for (const c of await fixEncoding(ecruC, 'colori_ecru', 'IDcolori_ecru', ['reference']))
      colorisEcru.set(Number(c.IDcolori_ecru), (c.reference ?? '').toString())
  }
  return { ecru, fini, divers, finiAvecTeinture, colorisFini, colorisEcru }
}

function resolveRefLabel(maps: ResolvedMaps, IDref: number, typeKind: number): { label: string; kind: 'ecru' | 'fini' | 'divers' | null } {
  if (IDref <= 0) return { label: '', kind: null }
  if (typeKind === 1) return { label: maps.ecru.get(IDref) ?? '', kind: 'ecru' }
  if (typeKind === 2) return { label: maps.fini.get(IDref) ?? '', kind: 'fini' }
  if (typeKind === 3) return { label: maps.divers.get(IDref) ?? '', kind: 'divers' }
  if (maps.fini.has(IDref)) return { label: maps.fini.get(IDref)!, kind: 'fini' }
  if (maps.ecru.has(IDref)) return { label: maps.ecru.get(IDref)!, kind: 'ecru' }
  if (maps.divers.has(IDref)) return { label: maps.divers.get(IDref)!, kind: 'divers' }
  return { label: '', kind: null }
}

function resolveColorisLabel(maps: ResolvedMaps, IDcolori: number, typeKind: number, IDref: number): string {
  if (IDcolori <= 0) return ''
  if (typeKind === 2) {
    const dyed = (maps.finiAvecTeinture.get(IDref) ?? 1) !== 0
    return dyed
      ? (maps.colorisFini.get(IDcolori) ?? maps.colorisEcru.get(IDcolori) ?? '')
      : (maps.colorisEcru.get(IDcolori) ?? maps.colorisFini.get(IDcolori) ?? '')
  }
  return maps.colorisEcru.get(IDcolori) ?? maps.colorisFini.get(IDcolori) ?? ''
}

// ════════════════════════════════════════════════════════
//  DETAIL
// ════════════════════════════════════════════════════════

devisRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // SELECT * is safe on devis_etm; the accented archivé key comes back
    // mangled and is simply ignored. `date` returns as `DATE` (reserved word).
    const rows = await query<any>(`SELECT * FROM devis_etm WHERE IDDevis_etm = ${id}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Devis not found' }); return }
    const fixedHeader = await fixEncoding(rows, 'devis_etm', 'IDDevis_etm',
      ['ref_client', 'commentaire', 'commentaire_interne', 'observations_facturation'])
    const h = fixedHeader[0] as any
    h.commentaire = stripRtf(h.commentaire) || null
    h.commentaire_interne = stripRtf(h.commentaire_interne) || null
    h.observations_facturation = stripRtf(h.observations_facturation) || null

    const IDclient = Number(h.IDclient) || 0
    const [clientNames, adrLivRows, adrFacRows, lignesRaw] = await Promise.all([
      resolveClientNames([IDclient]),
      h.IDadresse_livraison
        ? query(`SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays FROM adresse WHERE IDadresse = ${n(h.IDadresse_livraison)}`)
        : Promise.resolve([]),
      h.IDadresse_facturation
        ? query(`SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays FROM adresse WHERE IDadresse = ${n(h.IDadresse_facturation)}`)
        : Promise.resolve([]),
      // TYPE → type_kind (reserved word). Never name accented delai_annoncé /
      // déverrouiller. IDref_ecru is the resolved underlying écru ref.
      query<any>(
        `SELECT IDligne_devis_etm, IDDevis_etm, TYPE AS type_kind,
                IDreference, IDref_ecru, IDcolori, quantite, unite, prix, poids,
                date_livraison, commentaire, IDdesignation_client
         FROM ligne_devis_etm
         WHERE IDDevis_etm = ${id}
         ORDER BY IDligne_devis_etm`,
      ),
    ])

    const adrLiv = (await fixEncoding(adrLivRows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays']))[0] ?? null
    const adrFac = (await fixEncoding(adrFacRows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays']))[0] ?? null
    const lignesFixed = (await fixEncoding(lignesRaw, 'ligne_devis_etm', 'IDligne_devis_etm', ['commentaire'])) as any[]
    for (const l of lignesFixed) l.commentaire = stripRtf(l.commentaire) || null

    const maps = await resolveLineLabels(lignesFixed.map((l) => ({
      IDreference: Number(l.IDreference) || 0,
      IDcolori: Number(l.IDcolori) || 0,
      type_kind: Number(l.type_kind) || 0,
    })))

    const lignes = lignesFixed.map((l) => {
      const typeKind = Number(l.type_kind) || 0
      const refId = Number(l.IDreference) || 0
      const colId = Number(l.IDcolori) || 0
      const resolved = resolveRefLabel(maps, refId, typeKind)
      const qty = Number(l.quantite) || 0
      const prix = Number(l.prix) || 0
      return {
        IDligne_devis_etm: Number(l.IDligne_devis_etm),
        IDDevis_etm: Number(l.IDDevis_etm),
        type: typeKind,
        IDreference: refId,
        IDref_ecru: Number(l.IDref_ecru) || 0,
        IDcolori: colId,
        quantite: qty,
        unite: Number(l.unite) || 0,
        unite_label: uniteLabel(l.unite),
        prix,
        poids: Number(l.poids) || 0,
        date_livraison: l.date_livraison ?? null,
        commentaire: l.commentaire ?? null,
        ref_label: resolved.label || null,
        ref_kind: resolved.kind,
        colori_reference: resolveColorisLabel(maps, colId, typeKind, refId) || null,
        montant: qty * prix,
      }
    })

    res.json({
      IDDevis_etm: id,
      IDclient,
      client_nom: clientNames.get(IDclient) ?? '',
      numero: h.numero != null ? Number(h.numero) : null,
      date: pickDate(h),
      date_expiration: h.date_expiration ?? null,
      ref_client: h.ref_client ?? null,
      IDadresse_livraison: Number(h.IDadresse_livraison) || 0,
      IDadresse_facturation: Number(h.IDadresse_facturation) || 0,
      IDmode_paiement: Number(h.IDmode_paiement) || 0,
      IDecheance: Number(h.IDecheance) || 0,
      commentaire: h.commentaire ?? null,
      commentaire_interne: h.commentaire_interne ?? null,
      observations_facturation: h.observations_facturation ?? null,
      est_soldee: Number(h.est_soldee) || 0,
      remise: Number(h.remise) || 0,
      frais_port: Number(h.frais_port) || 0,
      IDcommande_ETM: Number(h.IDcommande_ETM) || 0,
      adresse_livraison: adrLiv,
      adresse_facturation: adrFac,
      lignes,
    })
  } catch (err) {
    console.error('Error fetching devis detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  HEADER CRUD
// ════════════════════════════════════════════════════════

devisRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = devisBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    if (!d.IDclient) { res.status(400).json({ error: 'IDclient is required' }); return }

    const dateDevis = d.date ? dateStr(d.date) : todayHfsql()
    const dateExp = d.date_expiration ? dateStr(d.date_expiration) : ''

    // numero allocator with collision retry. Accented archivé omitted (HFSQL
    // zero-fills). IDprospect = 0 marks this as a client devis.
    let newNumero = 0
    let inserted = false
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      newNumero = await nextNumero()
      try {
        await query(
          `INSERT INTO devis_etm
             (IDclient, IDprospect, numero, date, date_expiration,
              IDadresse_livraison, IDadresse_facturation, IDmode_paiement, IDecheance,
              ref_client, commentaire, commentaire_interne, observations_facturation,
              est_soldee, remise, frais_port, IDcommande_ETM)
           VALUES
             (${n(d.IDclient)}, 0, ${newNumero}, '${dateDevis}', '${dateExp}',
              ${n(d.IDadresse_livraison ?? 0)}, ${n(d.IDadresse_facturation ?? 0)},
              ${n(d.IDmode_paiement ?? 0)}, ${n(d.IDecheance ?? 0)},
              ${sqlText(d.ref_client ?? '')}, ${sqlText(d.commentaire ?? '')}, '', '',
              0, ${Number(d.remise) || 0}, ${Number(d.frais_port) || 0}, 0)`,
        )
        inserted = true
      } catch (e) { lastErr = e }
    }
    if (!inserted) throw lastErr ?? new Error('insert failed after 3 attempts')

    const newRows = await query<{ IDDevis_etm: number }>(
      `SELECT IDDevis_etm FROM devis_etm WHERE IDprospect = 0 AND numero = ${newNumero} ORDER BY IDDevis_etm DESC`,
    )
    res.status(201).json({ IDDevis_etm: Number(newRows[0]?.IDDevis_etm) || 0 })
  } catch (err) {
    console.error('Error creating devis:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = devisBody.partial().safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data

    const sets: string[] = []
    if (d.IDclient !== undefined) sets.push(`IDclient = ${n(d.IDclient)}`)
    if (d.date !== undefined) sets.push(`date = '${dateStr(d.date)}'`)
    if (d.date_expiration !== undefined) sets.push(`date_expiration = '${d.date_expiration ? dateStr(d.date_expiration) : ''}'`)
    if (d.ref_client !== undefined) sets.push(`ref_client = ${sqlText(d.ref_client)}`)
    if (d.IDadresse_livraison !== undefined) sets.push(`IDadresse_livraison = ${n(d.IDadresse_livraison)}`)
    if (d.IDadresse_facturation !== undefined) sets.push(`IDadresse_facturation = ${n(d.IDadresse_facturation)}`)
    if (d.IDmode_paiement !== undefined) sets.push(`IDmode_paiement = ${n(d.IDmode_paiement)}`)
    if (d.IDecheance !== undefined) sets.push(`IDecheance = ${n(d.IDecheance)}`)
    if (d.commentaire !== undefined) sets.push(`commentaire = ${sqlText(d.commentaire)}`)
    if (d.commentaire_interne !== undefined) sets.push(`commentaire_interne = ${sqlText(d.commentaire_interne)}`)
    if (d.remise !== undefined) sets.push(`remise = ${Number(d.remise) || 0}`)
    if (d.frais_port !== undefined) sets.push(`frais_port = ${Number(d.frais_port) || 0}`)
    if (d.est_soldee !== undefined) sets.push(`est_soldee = ${d.est_soldee}`)
    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }

    await query(`UPDATE devis_etm SET ${sets.join(', ')} WHERE IDDevis_etm = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating devis:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Binary est_soldee toggle (sidebar footer pill — "Solder" / "Revalider").
devisRouter.put('/:id/etat', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const est = Number(req.body?.est_soldee) === 1 ? 1 : 0
    await query(`UPDATE devis_etm SET est_soldee = ${est} WHERE IDDevis_etm = ${id}`)
    res.json({ ok: true, est_soldee: est })
  } catch (err) {
    console.error('Error toggling devis etat:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await query(`DELETE FROM ligne_devis_etm WHERE IDDevis_etm = ${id}`)
    await query(`DELETE FROM devis_etm WHERE IDDevis_etm = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting devis:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  LINE CRUD
// ════════════════════════════════════════════════════════

devisRouter.post('/:id/lignes', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (refuseIfSoldee(res, await loadDevisSoldee(id))) return
    const parsed = ligneBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    const typeKind = Number(d.type) || 0
    const idRefEcru = await resolveLineRefEcru(typeKind, Number(d.IDreference) || 0)
    // TYPE written uppercase (reserved word). Never name accented line columns.
    await query(
      `INSERT INTO ligne_devis_etm
         (IDDevis_etm, TYPE, IDreference, IDref_ecru, IDcolori,
          quantite, unite, prix, poids, date_livraison, commentaire, IDdesignation_client)
       VALUES
         (${id}, ${typeKind}, ${n(d.IDreference ?? 0)}, ${idRefEcru}, ${n(d.IDcolori ?? 0)},
          ${Number(d.quantite) || 0}, ${n(d.unite ?? 0)}, ${Number(d.prix) || 0},
          ${Number(d.poids) || 0}, '${d.date_livraison ? dateStr(d.date_livraison) : ''}',
          ${sqlText(d.commentaire ?? '')}, 0)`,
    )
    const newRows = await query<{ IDligne_devis_etm: number }>(
      `SELECT IDligne_devis_etm FROM ligne_devis_etm WHERE IDDevis_etm = ${id} ORDER BY IDligne_devis_etm DESC`,
    )
    res.status(201).json({ IDligne_devis_etm: Number(newRows[0]?.IDligne_devis_etm) || 0 })
  } catch (err) {
    console.error('Error creating ligne-devis:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.put('/lignes/:lineId', async (req: Request, res: Response) => {
  try {
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const devisId = await loadDevisIdForLine(lineId)
    if (devisId == null) { res.status(404).json({ error: 'Line not found' }); return }
    if (refuseIfSoldee(res, await loadDevisSoldee(devisId))) return
    const parsed = ligneBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data

    const sets: string[] = []
    if (d.type !== undefined) {
      sets.push(`TYPE = ${Number(d.type) || 0}`)
      // Keep IDref_ecru in sync with the (possibly changed) type/ref.
      const idRefEcru = await resolveLineRefEcru(Number(d.type) || 0, Number(d.IDreference) || 0)
      sets.push(`IDref_ecru = ${idRefEcru}`)
    } else if (d.IDreference !== undefined) {
      const cur = await query<{ type_kind: number }>(
        `SELECT TYPE AS type_kind FROM ligne_devis_etm WHERE IDligne_devis_etm = ${lineId}`,
      )
      const idRefEcru = await resolveLineRefEcru(Number(cur[0]?.type_kind) || 0, Number(d.IDreference) || 0)
      sets.push(`IDref_ecru = ${idRefEcru}`)
    }
    if (d.IDreference !== undefined) sets.push(`IDreference = ${n(d.IDreference)}`)
    if (d.IDcolori !== undefined) sets.push(`IDcolori = ${n(d.IDcolori)}`)
    if (d.quantite !== undefined) sets.push(`quantite = ${Number(d.quantite) || 0}`)
    if (d.unite !== undefined) sets.push(`unite = ${n(d.unite)}`)
    if (d.prix !== undefined) sets.push(`prix = ${Number(d.prix) || 0}`)
    if (d.poids !== undefined) sets.push(`poids = ${Number(d.poids) || 0}`)
    if (d.date_livraison !== undefined) sets.push(`date_livraison = '${dateStr(d.date_livraison)}'`)
    if (d.commentaire !== undefined) sets.push(`commentaire = ${sqlText(d.commentaire)}`)
    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }

    await query(`UPDATE ligne_devis_etm SET ${sets.join(', ')} WHERE IDligne_devis_etm = ${lineId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating ligne-devis:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.delete('/lignes/:lineId', async (req: Request, res: Response) => {
  try {
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const devisId = await loadDevisIdForLine(lineId)
    if (devisId == null) { res.status(404).json({ error: 'Line not found' }); return }
    if (refuseIfSoldee(res, await loadDevisSoldee(devisId))) return
    await query(`DELETE FROM ligne_devis_etm WHERE IDligne_devis_etm = ${lineId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting ligne-devis:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  CONVERT  ("Passer en commande" — devis → commande_client)
// ════════════════════════════════════════════════════════
//
// Creates an ETM commande_client (IDsociete = 1, IDcommande_ETM = 0) + its lines
// from the devis, marks the devis soldé, and back-links devis_etm.IDcommande_ETM
// to the new order. Mirrors the legacy "Voulez-vous passer ce devis en commande ?"
// flow. commande_client.remise carries the devis remise verbatim (legacy behaviour).

async function nextCommandeNumero(): Promise<number> {
  const r = await query<{ m: number | null }>(
    `SELECT MAX(numero) AS m FROM commande_client WHERE IDsociete = 1`,
  )
  return (Number(r[0]?.m) || 0) + 1
}

devisRouter.post('/:id/convert', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await query<any>(`SELECT * FROM devis_etm WHERE IDDevis_etm = ${id}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Devis not found' }); return }
    const h = (await fixEncoding(rows, 'devis_etm', 'IDDevis_etm', ['ref_client', 'commentaire']))[0] as any
    if (Number(h.IDprospect) > 0) { res.status(400).json({ error: 'prospect_devis', message: 'Un devis prospect ne peut pas être transformé.' }); return }
    if (!(Number(h.IDclient) > 0)) { res.status(400).json({ error: 'no_client', message: 'Le devis doit avoir un client.' }); return }
    if (Number(h.IDcommande_ETM) > 0) {
      res.status(409).json({ error: 'already_converted', message: 'Ce devis a déjà été transformé en commande.', IDcommande_client: Number(h.IDcommande_ETM) })
      return
    }

    const lignes = await query<any>(
      `SELECT TYPE AS type_kind, IDreference, IDcolori, quantite, unite, prix, poids,
              date_livraison, IDdesignation_client
       FROM ligne_devis_etm WHERE IDDevis_etm = ${id} ORDER BY IDligne_devis_etm`,
    )
    const lignesFixed = (await fixEncoding(lignes, 'ligne_devis_etm', 'IDligne_devis_etm', [])) as any[]

    const commentaire = stripRtf(h.commentaire) || ''
    const refClient = (h.ref_client ?? '').toString()

    // Allocate commande numero (per IDsociete = 1) with collision retry.
    let newNumero = 0
    let inserted = false
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      newNumero = await nextCommandeNumero()
      try {
        await query(
          `INSERT INTO commande_client
             (IDclient, IDsociete, IDcommande_ETM, numero, date_commande,
              IDadresse_livraison, IDadresse_facturation, IDmode_paiement, IDecheance,
              ref_client, commentaire, est_soldee, remise, donation,
              attente_paiement, frais_port, IDdossier)
           VALUES
             (${n(h.IDclient)}, 1, 0, ${newNumero}, '${todayHfsql()}',
              ${n(h.IDadresse_livraison ?? 0)}, ${n(h.IDadresse_facturation ?? 0)},
              ${n(h.IDmode_paiement ?? 0)}, ${n(h.IDecheance ?? 0)},
              ${sqlText(refClient)}, ${sqlText(commentaire)}, 0,
              ${Number(h.remise) || 0}, 0, 0, ${Number(h.frais_port) || 0}, 0)`,
        )
        inserted = true
      } catch (e) { lastErr = e }
    }
    if (!inserted) throw lastErr ?? new Error('commande insert failed after 3 attempts')

    const newRows = await query<{ IDcommande_client: number }>(
      `SELECT IDcommande_client FROM commande_client
       WHERE IDsociete = 1 AND numero = ${newNumero} ORDER BY IDcommande_client DESC`,
    )
    const newId = Number(newRows[0]?.IDcommande_client) || 0
    if (!newId) throw new Error('could not resolve new commande id')

    // Copy each devis line into the order.
    for (const l of lignesFixed) {
      const typeKind = Number(l.type_kind) || 0
      await query(
        `INSERT INTO ligne_commande_client
           (IDcommande_client, IDligne_commande_ETM, TYPE, IDreference, IDcolori,
            quantite, unite, prix, poids, date_livraison, commentaire, IDdesignation_client)
         VALUES
           (${newId}, 0, ${typeKind}, ${n(l.IDreference ?? 0)}, ${n(l.IDcolori ?? 0)},
            ${Number(l.quantite) || 0}, ${n(l.unite ?? 0)}, ${Number(l.prix) || 0},
            ${Number(l.poids) || 0}, '${typeof l.date_livraison === 'string' && /^\d{8}$/.test(l.date_livraison) ? l.date_livraison : ''}',
            '', ${n(l.IDdesignation_client ?? 0)})`,
      )
    }

    // Mark the devis soldé and back-link it to the created order.
    await query(`UPDATE devis_etm SET est_soldee = 1, IDcommande_ETM = ${newId} WHERE IDDevis_etm = ${id}`)

    res.status(201).json({ IDcommande_client: newId, numero: newNumero })
  } catch (err) {
    console.error('Error converting devis to commande:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  PDF  (devis)
// ════════════════════════════════════════════════════════

async function loadModePaiementLabel(id: number): Promise<string | null> {
  if (!(id > 0)) return null
  const rows = await query<{ libelle: string | null }>(`SELECT libelle FROM mode_paiement WHERE IDmode_paiement = ${id}`)
  const fixed = await fixEncoding(rows, 'mode_paiement', 'IDmode_paiement', ['libelle'])
  return (fixed[0]?.libelle ?? null) as string | null
}

async function loadEcheanceLabel(id: number): Promise<string | null> {
  if (!(id > 0)) return null
  const rows = await query<{ libelle: string | null }>(`SELECT libelle FROM echeance WHERE IDecheance = ${id}`)
  const fixed = await fixEncoding(rows, 'echeance', 'IDecheance', ['libelle'])
  return (fixed[0]?.libelle ?? null) as string | null
}

export async function buildDevisPdfData(id: number): Promise<DevisEtmPdfData | null> {
  const rows = await query<any>(`SELECT * FROM devis_etm WHERE IDDevis_etm = ${id}`)
  if (rows.length === 0) return null
  const h = (await fixEncoding(rows, 'devis_etm', 'IDDevis_etm', ['ref_client', 'commentaire']))[0] as any
  h.commentaire = stripRtf(h.commentaire) || null

  const IDclient = Number(h.IDclient) || 0
  const [clientNames, adrLivRows, adrFacRows, lignesRaw, tvaRate, modePaiement, echeance] = await Promise.all([
    resolveClientNames([IDclient]),
    h.IDadresse_livraison ? query(`SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays FROM adresse WHERE IDadresse = ${n(h.IDadresse_livraison)}`) : Promise.resolve([]),
    h.IDadresse_facturation ? query(`SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays FROM adresse WHERE IDadresse = ${n(h.IDadresse_facturation)}`) : Promise.resolve([]),
    query<any>(
      `SELECT TYPE AS type_kind, IDreference, IDcolori, quantite, unite, prix, date_livraison
       FROM ligne_devis_etm WHERE IDDevis_etm = ${id} ORDER BY IDligne_devis_etm`,
    ),
    // The client's own rate, NOT the ETM default — an "Exonération" client
    // (export) must be quoted at 0 % on every document (lib/tva.ts).
    loadClientTvaRate(IDclient),
    loadModePaiementLabel(Number(h.IDmode_paiement) || 0),
    loadEcheanceLabel(Number(h.IDecheance) || 0),
  ])

  const adrLiv = (await fixEncoding(adrLivRows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays']))[0] ?? null
  const adrFac = (await fixEncoding(adrFacRows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays']))[0] ?? null
  const lignesFixed = lignesRaw as any[]
  const maps = await resolveLineLabels(lignesFixed.map((l) => ({
    IDreference: Number(l.IDreference) || 0, IDcolori: Number(l.IDcolori) || 0, type_kind: Number(l.type_kind) || 0,
  })))

  const lignes = lignesFixed.map((l) => {
    const typeKind = Number(l.type_kind) || 0
    const refId = Number(l.IDreference) || 0
    const colId = Number(l.IDcolori) || 0
    const resolved = resolveRefLabel(maps, refId, typeKind)
    const qty = Number(l.quantite) || 0
    const prix = Number(l.prix) || 0
    return {
      ref_label: resolved.label || null,
      colori_reference: resolveColorisLabel(maps, colId, typeKind, refId) || null,
      quantite: qty,
      unite_label: uniteLabel(l.unite),
      prix,
      montant: qty * prix,
      date_livraison: formatHfsqlDateFr(l.date_livraison),
    }
  })

  const cleanAddr = (a: any | null) => a ? {
    nom: cleanAddrField(a.nom), adresse1: cleanAddrField(a.adresse1), adresse2: cleanAddrField(a.adresse2),
    adresse3: cleanAddrField(a.adresse3), cp: cleanAddrField(a.cp), ville: cleanAddrField(a.ville), pays: cleanAddrField(a.pays),
  } : null

  return {
    numero: String(h.numero ?? id),
    dateDevis: formatHfsqlDateLongFr(pickDate(h)),
    dateExpiration: formatHfsqlDateLongFr(h.date_expiration),
    clientNom: clientNames.get(IDclient) ?? '',
    refClient: (h.ref_client ?? null) as string | null,
    adresseFacturation: cleanAddr(adrFac),
    adresseLivraison: cleanAddr(adrLiv),
    modePaiement,
    echeance,
    commentaire: h.commentaire ?? null,
    remise: Number(h.remise) || 0, // fraction
    fraisPort: Number(h.frais_port) || 0,
    tvaRate,
    lignes,
  }
}

async function renderDevisPdfBuffer(data: DevisEtmPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(DevisEtmPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

devisRouter.get('/:id/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const data = await buildDevisPdfData(id)
    if (!data) { res.status(404).json({ error: 'Devis not found' }); return }
    const buffer = await renderDevisPdfBuffer(data)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="devis-${data.numero}.pdf"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering devis PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  EMAIL  (devis → Gmail)
// ════════════════════════════════════════════════════════

interface EmailRecipientPayload { email: string; name?: string; source: 'contact'; contactId: number }
interface EmailDefaultsPayload {
  recipients: { selected: EmailRecipientPayload[]; suggestions: EmailRecipientPayload[] }
  subject: string
  body: string
  clientNom: string
  numero: string
}

async function buildEmailDefaults(id: number): Promise<EmailDefaultsPayload | null> {
  const rows = await query<any>(
    `SELECT IDclient, numero FROM devis_etm WHERE IDDevis_etm = ${id}`,
  )
  if (rows.length === 0) return null
  const IDclient = Number(rows[0].IDclient) || 0
  const numero = String(rows[0].numero ?? id)

  const [clientNames, contactRows] = await Promise.all([
    resolveClientNames([IDclient]),
    query<{ IDcontact: number; nom: string | null; prenom: string | null; mail: string | null; envoi_soumission: number | null; est_visible: number | null }>(
      `SELECT IDcontact, nom, prenom, mail, envoi_soumission, est_visible FROM contact WHERE IDclient = ${IDclient}`,
    ),
  ])
  const clientNom = clientNames.get(IDclient) ?? ''
  const fixedContacts = await fixEncoding(contactRows, 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])

  const selected: EmailRecipientPayload[] = []
  const suggestions: EmailRecipientPayload[] = []
  const seen = new Set<string>()
  for (const c of fixedContacts as any[]) {
    if (c.est_visible === 0) continue
    const raw = (c.mail ?? '').toString().trim()
    if (!raw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const displayName = [c.prenom, c.nom].map((s: string | null) => (s ?? '').toString().trim()).filter((s: string) => s.length > 0).join(' ')
    const recipient: EmailRecipientPayload = { email: raw, source: 'contact', contactId: Number(c.IDcontact) }
    if (displayName) recipient.name = displayName
    if (c.envoi_soumission === 1) selected.push(recipient)
    else suggestions.push(recipient)
  }

  const subject = `Devis N°${numero} — ETS Malterre`
  const body =
    `Bonjour,\n\n` +
    `Veuillez trouver ci-joint notre devis N°${numero}.\n\n` +
    `Nous restons à votre disposition pour toute information complémentaire.\n\n` +
    `Cordialement,\n` +
    `ETS Malterre`
  return { recipients: { selected, suggestions }, subject, body, clientNom, numero }
}

devisRouter.get('/:id/email-defaults', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const defaults = await buildEmailDefaults(id)
    if (!defaults) { res.status(404).json({ error: 'Devis not found' }); return }
    res.json(defaults)
  } catch (err) {
    console.error('Error building devis email defaults:', err)
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
  dev_skip_send: z.boolean().optional(),
})
const ALLOW_DEV_SKIP_SEND = process.env.NODE_ENV !== 'production'

async function logEnvoiEmails(idReference: number, recipients: string[], societe: string): Promise<void> {
  if (recipients.length === 0) return
  const ts = nowHfsqlDatetime()
  for (const raw of recipients) {
    const addr = String(raw).trim()
    if (!addr) continue
    try {
      if (IS_WINDOWS) {
        await query(
          `INSERT INTO envoi_email (DATE, adresse, société, IDreference, invalidé, notes, IDtype_doc)
           VALUES ('${ts}', ${sqlText(addr)}, ${sqlText(societe || '')}, ${idReference}, 0, '', ${TYPE_DOC_DEVIS})`,
        )
      } else {
        // Linux bridge can't tokenize accented société/invalidé — omit (HFSQL zero-fills).
        await query(
          `INSERT INTO envoi_email (DATE, adresse, IDreference, notes, IDtype_doc)
           VALUES ('${ts}', ${sqlText(addr)}, ${idReference}, '', ${TYPE_DOC_DEVIS})`,
        )
      }
    } catch (e) {
      console.error(`envoi_email log failed (devis/${idReference}/${addr}):`, (e as Error).message)
    }
  }
}

devisRouter.post('/:id/email', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const parsed = emailBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const devSkip = parsed.data.dev_skip_send === true && ALLOW_DEV_SKIP_SEND

    let messageId: string
    if (devSkip) {
      messageId = `dev-skip-${Date.now()}`
      console.log(`[dev-skip-send] devis #${id} — fake send to ${parsed.data.to.join(', ')}`)
    } else {
      const senderEmail = await getUserEmail(req.userId)
      if (!senderEmail) {
        res.status(400).json({
          error: 'no_sender_email',
          message: "Aucune adresse email n'est associée à votre compte. Un administrateur doit en définir une dans Paramètres › Utilisateurs.",
        })
        return
      }
      const userRows = await query<{ prenom: string | null; nom: string | null }>(
        `SELECT prenom, nom FROM utilisateur WHERE IDutilisateur = ${req.userId}`,
      )
      const fixedUser = await fixEncoding(userRows, 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
      const u = (fixedUser[0] as any) ?? null
      const displayName = u ? [u.prenom, u.nom].filter((s: string | null) => s && s.trim()).map((s: string) => s.trim()).join(' ') : ''
      const fromName = displayName ? `${displayName} — ETS Malterre` : 'ETS Malterre'

      const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
      if (parsed.data.attach_pdf !== false) {
        const data = await buildDevisPdfData(id)
        if (!data) { res.status(404).json({ error: 'Devis not found' }); return }
        const buffer = await renderDevisPdfBuffer(data)
        attachments.push({ filename: `devis-${data.numero}.pdf`, content: buffer, contentType: 'application/pdf' })
      }
      for (const a of parsed.data.extra_attachments ?? []) {
        attachments.push({ filename: a.filename, content: Buffer.from(a.content_base64, 'base64'), contentType: a.content_type })
      }
      messageId = await sendMail({
        from: senderEmail, fromName, to: parsed.data.to, cc: parsed.data.cc, bcc: parsed.data.bcc,
        subject: parsed.data.subject, body: parsed.data.body,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
    }

    const allRecipients = [...parsed.data.to, ...(parsed.data.cc ?? [])]
    let societe = ''
    try {
      const cr = await query<{ IDclient: number }>(`SELECT IDclient FROM devis_etm WHERE IDDevis_etm = ${id}`)
      const names = await resolveClientNames([Number(cr[0]?.IDclient) || 0])
      societe = names.get(Number(cr[0]?.IDclient) || 0) ?? ''
    } catch { /* informational */ }
    await logEnvoiEmails(id, allRecipients, societe)

    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending devis email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})

// ════════════════════════════════════════════════════════
//  HISTORIQUE  (envoi_email timeline for this devis)
// ════════════════════════════════════════════════════════

devisRouter.get('/:id/historique', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const rows = await query<{ adresse: string | null; DATE: string | null }>(
      `SELECT adresse, DATE FROM envoi_email WHERE IDreference = ${id} AND IDtype_doc = ${TYPE_DOC_DEVIS}`,
    )
    const byDate = new Map<string, { DATE: string; recipients: string[] }>()
    for (const r of rows as any[]) {
      const dt = (r.DATE ?? '').toString()
      const acc = byDate.get(dt) ?? { DATE: dt, recipients: [] as string[] }
      const addr = (r.adresse ?? '').toString().trim()
      if (addr) acc.recipients.push(addr)
      byDate.set(dt, acc)
    }
    const events = Array.from(byDate.values())
      .map((e) => ({ kind: 'email' as const, type_label: 'Envoi du devis', recipients: e.recipients, DATE: e.DATE }))
      .sort((a, b) => (a.DATE < b.DATE ? 1 : -1))
    res.json(events)
  } catch (err) {
    console.error('Error fetching devis historique:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  DOCUMENTS  (polymorphic GED — IDreference = id AND IDtype_doc = 28)
// ════════════════════════════════════════════════════════
//
// ged has no IDDevis_etm column. Devis docs key on IDreference = devisId AND
// IDtype_doc = 28 ("devis") with the client/sst FKs = 0 — collision-free, since
// type 28 is unique to devis. Every devis doc is stored as type 28.

const DEVIS_DOC_SCOPE = (id: number, idged?: number) =>
  `${idged != null ? `IDged = ${idged} AND ` : ''}IDreference = ${id} AND IDtype_doc = ${TYPE_DOC_DEVIS} AND IDcommande_client = 0 AND IDcommande_sous_traitant = 0`

devisRouter.get('/:id/documents', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const rows = await query<{ IDged: number; nom: string | null; commentaire: string | null; IDtype_doc: number }>(
      `SELECT IDged, nom, commentaire, IDtype_doc FROM ged WHERE ${DEVIS_DOC_SCOPE(id)} ORDER BY IDged DESC`,
    )
    const fixed = await fixEncoding(rows, 'ged', 'IDged', ['nom', 'commentaire'])
    res.json(fixed.map((r) => ({
      IDged: r.IDged, nom: r.nom, commentaire: r.commentaire,
      IDtype_doc: r.IDtype_doc, type_nom: 'devis',
    })))
  } catch (err) {
    console.error('Error listing devis documents:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.get('/:id/documents/:idged/fichier', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const idged = parseInt(req.params.idged, 10)
    if (isNaN(id) || isNaN(idged)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const rows = await queryRaw(`SELECT fichier FROM ged WHERE ${DEVIS_DOC_SCOPE(id, idged)}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Document not found' }); return }
    const fichier = (rows[0] as any).fichier
    if (fichier == null) { res.status(404).json({ error: 'No file attached' }); return }
    let buf: Buffer
    if (fichier instanceof ArrayBuffer) buf = Buffer.from(fichier)
    else if (Buffer.isBuffer(fichier)) buf = fichier
    else { res.status(404).json({ error: 'No file attached' }); return }
    if (buf.length === 0 || (buf.length === 1 && buf[0] === 0)) { res.status(404).json({ error: 'No file attached' }); return }
    let contentType = 'application/octet-stream'
    if (buf.length >= 4) {
      const hb = buf.subarray(0, 4)
      if (hb[0] === 0x25 && hb[1] === 0x50 && hb[2] === 0x44 && hb[3] === 0x46) contentType = 'application/pdf'
      else if (hb[0] === 0x89 && hb[1] === 0x50 && hb[2] === 0x4e && hb[3] === 0x47) contentType = 'image/png'
      else if (hb[0] === 0xff && hb[1] === 0xd8) contentType = 'image/jpeg'
    }
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', 'inline')
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.end(buf)
  } catch (err) {
    console.error('Error serving devis document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.post('/:id/documents', upload.single('fichier'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const cf = await query(`SELECT IDDevis_etm FROM devis_etm WHERE IDDevis_etm = ${id}`)
    if (cf.length === 0) { res.status(404).json({ error: 'Devis not found' }); return }
    const nom = (req.body.nom ?? '').toString()
    const commentaire = (req.body.commentaire ?? '').toString()
    await query(
      `INSERT INTO ged (nom, commentaire, IDtype_doc, IDreference, IDcommande_client, IDcommande_sous_traitant, IDdossier)
       VALUES (${sqlText(nom)}, ${sqlText(commentaire)}, ${TYPE_DOC_DEVIS}, ${id}, 0, 0, 0)`,
    )
    const newRows = await query<{ IDged: number }>(
      `SELECT IDged FROM ged WHERE ${DEVIS_DOC_SCOPE(id)} ORDER BY IDged DESC`,
    )
    if (newRows.length === 0) { res.status(500).json({ error: 'Insert lookup failed' }); return }
    const newId = newRows[0].IDged
    if (req.file && req.file.buffer.length > 0) {
      await queryRaw(`UPDATE ged SET fichier = x'${req.file.buffer.toString('hex')}' WHERE IDged = ${newId}`)
    }
    res.status(201).json({ IDged: newId })
  } catch (err) {
    console.error('Error creating devis document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.put('/:id/documents/:idged', upload.single('fichier'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const idged = parseInt(req.params.idged, 10)
    if (isNaN(id) || isNaN(idged)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const scope = await query(`SELECT IDged FROM ged WHERE ${DEVIS_DOC_SCOPE(id, idged)}`)
    if (scope.length === 0) { res.status(404).json({ error: 'Document not found' }); return }
    const sets: string[] = []
    if (req.body.nom !== undefined) sets.push(`nom = ${sqlText(String(req.body.nom))}`)
    if (req.body.commentaire !== undefined) sets.push(`commentaire = ${sqlText(String(req.body.commentaire))}`)
    if (sets.length > 0) await query(`UPDATE ged SET ${sets.join(', ')} WHERE IDged = ${idged}`)
    if (req.file && req.file.buffer.length > 0) {
      await queryRaw(`UPDATE ged SET fichier = x'${req.file.buffer.toString('hex')}' WHERE IDged = ${idged}`)
    } else if (req.body.remove_fichier === '1') {
      await query(`UPDATE ged SET fichier = NULL WHERE IDged = ${idged}`)
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating devis document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

devisRouter.delete('/:id/documents/:idged', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const idged = parseInt(req.params.idged, 10)
    if (isNaN(id) || isNaN(idged)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const scope = await query(`SELECT IDged FROM ged WHERE ${DEVIS_DOC_SCOPE(id, idged)}`)
    if (scope.length === 0) { res.status(404).json({ error: 'Document not found' }); return }
    await query(`DELETE FROM ged WHERE IDged = ${idged}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting devis document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
