// Expéditions — client shipments. Combines the two legacy WinDev screens into
// one two-bucket master-detail (mirrors factures.ts's prov/def shape):
//
//   kind 'formelle' → expedition / ligne_expedition  (tied to a commande_client;
//                     bundles received finished/écru ROLLS into a Bon de Livraison)
//   kind 'divers'   → expedition_divers / ligne_expedition_divers  (free-text
//                     miscellaneous shipment, no stock link)
//
// DIVERS carton model (verified against live data, e.g. expedition 597):
//   ligne_expedition_divers is a CARTON/COLIS — detail_ligne is its free-text
//   label ("CARTON 3", "enveloppe"). The actual content lives in
//   ref_divers_expedie (FK IDligne_expedition_divers): one row per article =
//   IDref_divers (catalog `ref_divers`) + up to two variation axes
//   (IDVariation1/IDVariation2 → ref_divers_variation, niveau 1/2 matching
//   ref_divers.sTypeVariation1/sTypeVariation2 ∈ Couleur|Taille|Reference|Aucun)
//   + quantite/unite + prix (unit price frozen at ship time). `designation` is
//   a legacy free-text override — modern rows leave it empty and display
//   ref + variations. Prices come from the tarif_divers grid keyed on
//   (IDref_divers, IDVariation1, IDVariation2) with (0,0) = base price;
//   fallback ref_divers.prix_unitaire. stock_divers is NOT touched by MPS_NG
//   (legacy stock semantics unverified — managed via FEN_Gestion_Stock_Divers).
//   ref_divers has an ACCENTED column `archivé` → SELECT * + pickKey, never
//   name it in SQL.
//
// FORMELLE roll model (verified against MPS.xdd + clients.ts marchandise JOIN):
//   expedition ──< ligne_expedition (one per shipped order line, FK
//   IDligne_commande_client) ──< the rolls themselves point BACK via
//   stock_fini.IDligne_expedition (fini) / stock_ecru.IDligne_expedition_ETM (écru).
//   Candidate rolls for a line = stock affected to it (IDligne_commande_client)
//   that isn't yet shipped (exp FK 0/NULL). Shipping sets the exp FK; unshipping
//   resets it to 0. ligne_expedition rows are created lazily on first roll-assign.
//
// Hard rules baked in (CLAUDE.md + the XDD):
//  - `date` is a RESERVED word on both header tables → SELECT `DATE AS dexp`,
//    write `DATE` uppercase.
//  - expedition has ACCENTED bool columns `envoyé_client` / `envoyé_sst` — NEVER
//    name them (storms the Linux bridge). Explicit column lists omit them; INSERT
//    omits them (HFSQL zero-fills). Never `SELECT *` on expedition.
//  - Empty FK = 0, not NULL → `(col IS NULL OR col = 0)` everywhere.
//  - `expedition.IDsociete = 1` (ETM) on every formelle read/write.
//    `expedition_divers` has NO IDsociete column — don't filter/insert it.
//  - ligne_commande_client.type is reserved → `SELECT TYPE AS type_kind`.
//  - No parameterized queries / RETURNING; esc()/parseInt/sqlText; RTF
//    (observation_bl / detail_ligne) via stripRtf (read) + wrapRtf+sqlText (write);
//    text reads via fixEncoding.
//  - No `numero` column on either header — the document number IS the PK.
//  - Lock model: the legacy validé/dévalider concept is RETIRED in MPS_NG.
//    An expedition is either "non facturée" (fully editable) or "facturée"
//    (est_facture=1 OR a definitive facture references it) — then header/line/
//    roll writes 409. Facture linkage: formelle via ligne_facture.
//    IDligne_expedition → ligne_expedition; divers via the facture.
//    IDexpedition_divers header back-pointer. est_valide still exists in the
//    schema (legacy writes it) but MPS_NG ignores it everywhere.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { repairAliased } from './stock-fini.js'
import { esc, n, dateDigits as dateStr, IS_WINDOWS } from '../lib/sst-shared.js'
import { stripRtf, wrapRtf } from '../lib/rtf-utils.js'
import { BonLivraisonPdf, type BonLivraisonPdfData, type BlArticle, type BlLot, type BlPiece } from '../lib/pdf/BonLivraisonPdf.js'
import { BonLivraisonDiversPdf, type BonLivraisonDiversPdfData, type BlDiversCarton } from '../lib/pdf/BonLivraisonDiversPdf.js'
import { RapportControlePdf, type RapportControlePdfData, type RcArticle, type RcLot, type RcRow } from '../lib/pdf/RapportControlePdf.js'
import { InfoMatieresPdf, type InfoMatieresPdfData, type ImArticle, type ImEntry } from '../lib/pdf/InfoMatieresPdf.js'
import { DemandeTransportPdf, type DemandeTransportPdfData } from '../lib/pdf/DemandeTransportPdf.js'
import { company } from '../lib/pdf/theme.js'
import { sendMail } from '../lib/gmail.js'
import { getUserEmail } from '../lib/user-emails.js'

export const expeditionsRouter: RouterType = Router()

// ── Bucket model ─────────────────────────────────────────

type Kind = 'formelle' | 'divers'

const TBL: Record<Kind, { head: string; line: string; pk: string; linePk: string; lineFk: string }> = {
  formelle: { head: 'expedition',        line: 'ligne_expedition',        pk: 'IDexpedition',        linePk: 'IDligne_expedition',        lineFk: 'IDexpedition' },
  divers:   { head: 'expedition_divers', line: 'ligne_expedition_divers', pk: 'IDexpedition_divers', linePk: 'IDligne_expedition_divers', lineFk: 'IDexpedition_divers' },
}

function parseKind(raw: string | undefined): Kind | null {
  return raw === 'formelle' ? 'formelle' : raw === 'divers' ? 'divers' : null
}

const FACTURE_LOCK = { error: 'expedition_facturee', message: 'Expédition facturée — non modifiable.' }

// ── Small SQL/format helpers (same as factures.ts / clients.ts) ──

/** SQL literal for user text. ASCII → quoted literal; accents → Latin-1 hex
 *  literal (the Linux iODBC bridge corrupts raw multi-byte UTF-8 in a SQL line). */
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
  const bytes = Buffer.from(Array.from(ascii, (ch) => {
    const c = ch.codePointAt(0) ?? 0x3f
    return c <= 0xff ? c : 0x3f
  }))
  return `x'${bytes.toString('hex')}'`
}

const numOf = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0 }

function decode(v: unknown): string | null {
  if (v instanceof ArrayBuffer) return Buffer.from(v).toString('utf8')
  if (typeof v === 'string') return v
  return null
}

/** Accent-insensitive contains-matching (search). */
function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

function todayDigits(): string {
  const t = new Date()
  return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`
}

// ── Line unit + dimension semantics (mirror commandes-client.ts) ──

function uniteLabel(u: number | null | undefined): string {
  switch (Number(u)) {
    case 1: return 'Kg'
    case 3: return 'Ml'
    case 4: return 'unité'
    case 5: return 'm²'
    default: return ''
  }
}
function lineDim(unite: number | null | undefined): 'metrage' | 'poids' {
  return Number(unite) === 3 ? 'metrage' : 'poids'
}
/** Roll kind a line ships: type 1 → écru, type 2 → fini, else none. */
function lineStockKind(typeKind: number): 'ecru' | 'fini' | 'none' {
  if (typeKind === 1) return 'ecru'
  if (typeKind === 2) return 'fini'
  return 'none'
}

// ── Reference-data resolvers (batched, flat — never SELECT * on client) ──

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

async function resolveTransporteurNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(ids.filter((x) => x > 0)))
  if (u.length === 0) return out
  const rows = await query<{ IDtransporteur: number; nom: string | null }>(
    `SELECT IDtransporteur, nom FROM transporteur WHERE IDtransporteur IN (${u.join(',')})`,
  )
  const fixed = await fixEncoding(rows, 'transporteur', 'IDtransporteur', ['nom'])
  for (const r of fixed) out.set(Number(r.IDtransporteur), (r.nom ?? '').toString())
  return out
}

async function loadAdresse(id: number): Promise<Record<string, unknown> | null> {
  if (!(id > 0)) return null
  const rows = await query(
    `SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays FROM adresse WHERE IDadresse = ${id}`,
  )
  const fixed = await fixEncoding(rows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays'])
  return (fixed[0] as Record<string, unknown>) ?? null
}

async function loadContactName(id: number): Promise<string | null> {
  if (!(id > 0)) return null
  // IDcontact must be in the SELECT — fixEncoding keys its CONVERT repair on it.
  const rows = await query<{ IDcontact: number; nom: string | null; prenom: string | null }>(
    `SELECT IDcontact, nom, prenom FROM contact WHERE IDcontact = ${id}`,
  )
  const fixed = await fixEncoding(rows, 'contact', 'IDcontact', ['nom', 'prenom'])
  const c = fixed[0] as any
  if (!c) return null
  return [c.prenom, c.nom].map((s: string | null) => (s ?? '').toString().trim()).filter((s: string) => s).join(' ') || null
}

async function resolveMagasinNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(ids.filter((x) => x > 0)))
  if (u.length === 0) return out
  const rows = await query<{ IDsous_traitant: number; nom: unknown }>(
    `SELECT IDsous_traitant, CONVERT(nom USING 'UTF-8') AS nom FROM sous_traitant WHERE IDsous_traitant IN (${u.join(',')})`,
  )
  for (const r of rows) out.set(Number(r.IDsous_traitant), decode(r.nom) ?? '')
  return out
}

// ── Line label resolution (ref + coloris per commande line) ──

interface ResolvedMaps {
  ecru: Map<number, string>; fini: Map<number, string>; divers: Map<number, string>
  finiAvecTeinture: Map<number, number>; colorisFini: Map<number, string>; colorisEcru: Map<number, string>
}

async function resolveLineLabels(
  lignes: Array<{ IDreference: number | null; IDcolori: number | null; type_kind: number }>,
): Promise<ResolvedMaps> {
  const refIds = Array.from(new Set(lignes.map((l) => Number(l.IDreference) || 0).filter((x) => x > 0)))
  const coloriIds = Array.from(new Set(lignes.map((l) => Number(l.IDcolori) || 0).filter((x) => x > 0)))
  const ecru = new Map<number, string>(); const fini = new Map<number, string>(); const divers = new Map<number, string>()
  const finiAvecTeinture = new Map<number, number>(); const colorisFini = new Map<number, string>(); const colorisEcru = new Map<number, string>()

  if (refIds.length > 0) {
    const [ecruRows, finiRows, diversRows] = await Promise.all([
      query<{ IDref_ecru: number; reference: string | null }>(`SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru IN (${refIds.join(',')})`),
      query<{ IDref_fini: number; reference: string | null; avec_teinture: number | null }>(`SELECT IDref_fini, reference, avec_teinture FROM ref_fini WHERE IDref_fini IN (${refIds.join(',')})`),
      query<{ IDref_divers: number; designation: string | null }>(`SELECT IDref_divers, designation FROM ref_divers WHERE IDref_divers IN (${refIds.join(',')})`),
    ])
    for (const r of await fixEncoding(ecruRows, 'ref_ecru', 'IDref_ecru', ['reference'])) ecru.set(Number(r.IDref_ecru), (r.reference ?? '').toString())
    for (const r of await fixEncoding(finiRows, 'ref_fini', 'IDref_fini', ['reference'])) {
      fini.set(Number(r.IDref_fini), (r.reference ?? '').toString())
      finiAvecTeinture.set(Number(r.IDref_fini), Number((r as any).avec_teinture) || 0)
    }
    for (const r of await fixEncoding(diversRows, 'ref_divers', 'IDref_divers', ['designation'])) divers.set(Number(r.IDref_divers), (r.designation ?? '').toString())
  }
  if (coloriIds.length > 0) {
    const [finiC, ecruC] = await Promise.all([
      query<{ IDref_fini_colori: number; reference: string | null }>(`SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori IN (${coloriIds.join(',')})`),
      query<{ IDcolori_ecru: number; reference: string | null }>(`SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${coloriIds.join(',')})`),
    ])
    for (const c of await fixEncoding(finiC, 'ref_fini_colori', 'IDref_fini_colori', ['reference'])) colorisFini.set(Number(c.IDref_fini_colori), (c.reference ?? '').toString())
    for (const c of await fixEncoding(ecruC, 'colori_ecru', 'IDcolori_ecru', ['reference'])) colorisEcru.set(Number(c.IDcolori_ecru), (c.reference ?? '').toString())
  }
  return { ecru, fini, divers, finiAvecTeinture, colorisFini, colorisEcru }
}

function resolveRefLabel(maps: ResolvedMaps, IDref: number, typeKind: number): string {
  if (IDref <= 0) return ''
  if (typeKind === 1) return maps.ecru.get(IDref) ?? ''
  if (typeKind === 2) return maps.fini.get(IDref) ?? ''
  if (typeKind === 3) return maps.divers.get(IDref) ?? ''
  return maps.fini.get(IDref) ?? maps.ecru.get(IDref) ?? maps.divers.get(IDref) ?? ''
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

// ── Roll shape + resolvers (mirror commandes-client.ts) ──

interface RollLite {
  id: number; numero: string | null; lot: string | null; poids: number | null; metrage: number | null
  coloris_reference: string | null; magasin_nom: string | null; second_choix: number | null
  observations: string | null; etat_label: string | null
}
const ETAT_FINI_LABELS: Record<number, string> = {
  1: 'En Contrôle', 2: 'En Reprise', 3: 'Validé', 4: 'Expédié', 5: 'Attente décision',
}

async function resolveEcruColoris(coloriIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(coloriIds.filter((x) => x > 0)))
  if (u.length === 0) return out
  const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(`SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${u.join(',')})`)
  for (const r of await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference'])) out.set(Number(r.IDcolori_ecru), (r.reference ?? '').toString())
  return out
}
async function resolveFiniColoris(coloriIds: number[], avecTeinture: number): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(coloriIds.filter((x) => x > 0)))
  if (u.length === 0) return out
  if (avecTeinture === 0) return resolveEcruColoris(u)
  const rows = await query<{ IDref_fini_colori: number; reference: string | null }>(`SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori IN (${u.join(',')})`)
  for (const r of await fixEncoding(rows, 'ref_fini_colori', 'IDref_fini_colori', ['reference'])) out.set(Number(r.IDref_fini_colori), (r.reference ?? '').toString())
  return out
}

// ── Facture linkage + lock helper ────────────────────────

interface FactureRef { IDfacture: number; numero: number | null; date: string | null; type: number }

/** Definitive factures attached to an expedition.
 *  formelle: ligne_facture.IDligne_expedition → this expedition's ligne_expedition rows.
 *  divers:   facture.IDexpedition_divers header back-pointer.
 *  (facture_prov.IDexpedition_divers is EXCLUDED on purpose — MPS_NG repurposed
 *  it as the converted-proforma marker, it holds an IDfacture, not an expedition.) */
async function attachedFactures(kind: Kind, id: number): Promise<FactureRef[]> {
  let factIds: number[] = []
  if (kind === 'formelle') {
    const leRows = await query<{ IDligne_expedition: number }>(
      `SELECT IDligne_expedition FROM ligne_expedition WHERE IDexpedition = ${id}`,
    )
    const leIds = leRows.map((r) => Number(r.IDligne_expedition)).filter((x) => x > 0)
    if (leIds.length === 0) return []
    const lfRows = await query<{ IDfacture: number }>(
      `SELECT IDfacture FROM ligne_facture WHERE IDligne_expedition IN (${leIds.join(',')})`,
    )
    factIds = Array.from(new Set(lfRows.map((r) => Number(r.IDfacture)).filter((x) => x > 0)))
  } else {
    const rows = await query<{ IDfacture: number }>(
      `SELECT IDfacture FROM facture WHERE IDexpedition_divers = ${id}`,
    )
    factIds = Array.from(new Set(rows.map((r) => Number(r.IDfacture)).filter((x) => x > 0)))
  }
  if (factIds.length === 0) return []
  const heads = await query<any>(
    `SELECT IDfacture, numero, DATE AS dfac, TYPE AS type_kind FROM facture WHERE IDfacture IN (${factIds.join(',')}) ORDER BY IDfacture`,
  )
  return heads.map((h: any) => ({
    IDfacture: Number(h.IDfacture),
    numero: h.numero != null ? Number(h.numero) : null,
    date: h.dfac ?? null,
    type: Number(h.type_kind) === 2 ? 2 : 1,
  }))
}

/** Write lock: an expedition with a definitive facture is fully read-only.
 *  est_facture=1 (legacy flag) short-circuits; otherwise check real linkage. */
async function isLocked(kind: Kind, id: number): Promise<boolean> {
  const rows = await query<{ est_facture: number | null }>(
    `SELECT est_facture FROM ${TBL[kind].head} WHERE ${TBL[kind].pk} = ${id}`,
  )
  if (rows.length === 0) return false
  if (Number(rows[0].est_facture) === 1) return true
  return (await attachedFactures(kind, id)).length > 0
}

/** Allocate the new PK after an INSERT (no numero column). Capture MAX before,
 *  select the highest row above it after — robust against a concurrent legacy insert. */
async function newIdAfterInsert(head: string, pk: string, before: number): Promise<number> {
  const rows = await query<{ id: number }>(`SELECT TOP 1 ${pk} AS id FROM ${head} WHERE ${pk} > ${before} ORDER BY ${pk} DESC`)
  return Number(rows[0]?.id) || 0
}
async function maxId(head: string, pk: string): Promise<number> {
  const rows = await query<{ m: number | null }>(`SELECT MAX(${pk}) AS m FROM ${head}`)
  return Number(rows[0]?.m) || 0
}

// ════════════════════════════════════════════════════════
//  LOOKUPS  (literal paths — must register before /:kind/*)
// ════════════════════════════════════════════════════════

expeditionsRouter.get('/lookups/transporteurs', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDtransporteur: number; nom: string | null }>(
      `SELECT IDtransporteur, nom FROM transporteur WHERE est_visible = 1 ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'transporteur', 'IDtransporteur', ['nom'])
    res.json(fixed.map((r) => ({ IDtransporteur: Number(r.IDtransporteur), nom: (r.nom ?? '').toString() })))
  } catch (err) {
    console.error('Error fetching transporteurs lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeditionsRouter.get('/lookups/clients', async (_req: Request, res: Response) => {
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

// ETM orders for the formelle create picker. Optional ?client= narrows the list.
expeditionsRouter.get('/lookups/commandes', async (req: Request, res: Response) => {
  try {
    const cid = parseInt(String(req.query.client ?? ''), 10)
    const where = ['IDsociete = 1', 'IDcommande_ETM = 0']
    if (!isNaN(cid) && cid > 0) where.push(`IDclient = ${cid}`)
    const rows = await query<{ IDcommande_client: number; numero: number | null; date_commande: string | null; IDclient: number }>(
      `SELECT TOP 300 IDcommande_client, numero, date_commande, IDclient FROM commande_client WHERE ${where.join(' AND ')} ORDER BY IDcommande_client DESC`,
    )
    const names = await resolveClientNames(rows.map((r) => Number(r.IDclient)))
    res.json(rows.map((r) => ({
      IDcommande_client: Number(r.IDcommande_client),
      numero: r.numero != null ? Number(r.numero) : null,
      date_commande: r.date_commande ?? null,
      IDclient: Number(r.IDclient) || 0,
      client_nom: names.get(Number(r.IDclient)) ?? '',
    })))
  } catch (err) {
    console.error('Error fetching commandes lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeditionsRouter.get('/lookups/adresses', async (req: Request, res: Response) => {
  try {
    const cid = parseInt(String(req.query.client ?? ''), 10)
    if (isNaN(cid)) { res.status(400).json({ error: 'client query parameter required' }); return }
    const rows = await query(
      `SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays,
              est_defaut, est_defaut_facturation, est_defaut_livraison
       FROM adresse
       WHERE IDclient = ${cid} AND (est_visible IS NULL OR est_visible = 1)
       ORDER BY est_defaut_livraison DESC, est_defaut DESC, IDadresse`,
    )
    const fixed = await fixEncoding(rows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays'])
    res.json(fixed)
  } catch (err) {
    console.error('Error fetching adresses lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeditionsRouter.get('/lookups/contacts', async (req: Request, res: Response) => {
  try {
    const cid = parseInt(String(req.query.client ?? ''), 10)
    if (isNaN(cid)) { res.status(400).json({ error: 'client query parameter required' }); return }
    const rows = await query<{ IDcontact: number; nom: string | null; prenom: string | null; mail: string | null; envoi_bl: number | null; est_visible: number | null }>(
      `SELECT IDcontact, nom, prenom, mail, envoi_bl, est_visible FROM contact WHERE IDclient = ${cid}`,
    )
    const fixed = await fixEncoding(rows, 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])
    res.json(
      (fixed as any[])
        .filter((c) => c.est_visible !== 0)
        .map((c) => ({
          IDcontact: Number(c.IDcontact),
          nom: [c.prenom, c.nom].map((s: string | null) => (s ?? '').toString().trim()).filter((s: string) => s).join(' ') || `Contact #${Number(c.IDcontact)}`,
          mail: (c.mail ?? '').toString(),
        })),
    )
  } catch (err) {
    console.error('Error fetching contacts lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  LIST  (?bucket=formelle|divers&q=&state=&limit=)
// ════════════════════════════════════════════════════════

/** Roll count + Σ poids/metrage per expedition (formelle), via ligne_expedition
 *  → stock_fini (IDligne_expedition) + stock_ecru (IDligne_expedition_ETM). */
async function formelleRollAggregates(expIds: number[]): Promise<Map<number, { nb_rolls: number; poids: number; metrage: number }>> {
  const out = new Map<number, { nb_rolls: number; poids: number; metrage: number }>()
  const ids = Array.from(new Set(expIds.filter((x) => x > 0)))
  if (ids.length === 0) return out
  const leRows = await query<{ IDligne_expedition: number; IDexpedition: number }>(
    `SELECT IDligne_expedition, IDexpedition FROM ligne_expedition WHERE IDexpedition IN (${ids.join(',')})`,
  )
  const expByLine = new Map<number, number>()
  for (const r of leRows) expByLine.set(Number(r.IDligne_expedition), Number(r.IDexpedition))
  const lineIds = leRows.map((r) => Number(r.IDligne_expedition)).filter((x) => x > 0)
  if (lineIds.length === 0) return out
  const inList = lineIds.join(',')
  const [fini, ecru] = await Promise.all([
    query<{ le: number; poids: number | null; metrage: number | null }>(
      `SELECT IDligne_expedition AS le, poids, metrage FROM stock_fini WHERE IDligne_expedition IN (${inList})`,
    ),
    query<{ le: number; poids: number | null; metrage: number | null }>(
      `SELECT IDligne_expedition_ETM AS le, poids, metrage FROM stock_ecru WHERE IDligne_expedition_ETM IN (${inList})`,
    ),
  ])
  for (const r of [...fini, ...ecru]) {
    const exp = expByLine.get(Number(r.le)) ?? 0
    if (exp === 0) continue
    const acc = out.get(exp) ?? { nb_rolls: 0, poids: 0, metrage: 0 }
    acc.nb_rolls += 1
    acc.poids += Number(r.poids) || 0
    acc.metrage += Number(r.metrage) || 0
    out.set(exp, acc)
  }
  return out
}

expeditionsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(String(req.query.bucket ?? 'formelle')) ?? 'formelle'
    const q = String(req.query.q ?? '').trim()
    const state = String(req.query.state ?? 'all') // 'all' | 'facture' | 'nonfacture'
    const limitRaw = parseInt(String(req.query.limit ?? ''), 10)
    const limit = isNaN(limitRaw) ? 200 : Math.min(Math.max(limitRaw, 1), 500)
    const fetchCap = q ? 800 : limit

    // Cursor pagination (load more): only ids strictly below `before`. Ignored while searching.
    const beforeRaw = parseInt(String(req.query.before ?? ''), 10)
    const beforeId = !q && !isNaN(beforeRaw) && beforeRaw > 0 ? beforeRaw : null

    // Invoiced filter — HFSQL keeps empty flags at 0 (or NULL), never trust IS NULL alone.
    const stateSql = state === 'nonfacture' ? ' AND (est_facture IS NULL OR est_facture = 0)' : state === 'facture' ? ' AND est_facture = 1' : ''

    if (kind === 'formelle') {
      const beforeSql = beforeId !== null ? ` AND IDexpedition < ${beforeId}` : ''
      const heads = await query<any>(
        `SELECT TOP ${fetchCap} IDexpedition, IDcommande_client, IDadresse, IDtransporteur, DATE AS dexp, est_facture, donation ` +
          `FROM expedition WHERE IDsociete = 1${stateSql}${beforeSql} ORDER BY IDexpedition DESC`,
      )
      const cmdIds = heads.map((h: any) => Number(h.IDcommande_client)).filter(Boolean)
      const cmdRows = cmdIds.length
        ? await query<{ IDcommande_client: number; numero: number | null; IDclient: number }>(
            `SELECT IDcommande_client, numero, IDclient FROM commande_client WHERE IDcommande_client IN (${Array.from(new Set(cmdIds)).join(',')})`,
          )
        : []
      const cmdMap = new Map(cmdRows.map((c) => [Number(c.IDcommande_client), { numero: c.numero != null ? Number(c.numero) : null, IDclient: Number(c.IDclient) || 0 }]))
      const [clientNames, transNames, aggs] = await Promise.all([
        resolveClientNames(cmdRows.map((c) => Number(c.IDclient))),
        resolveTransporteurNames(heads.map((h: any) => Number(h.IDtransporteur))),
        formelleRollAggregates(heads.map((h: any) => Number(h.IDexpedition))),
      ])
      let result = heads.map((h: any) => {
        const id = Number(h.IDexpedition)
        const cmd = cmdMap.get(Number(h.IDcommande_client)) ?? { numero: null, IDclient: 0 }
        const agg = aggs.get(id) ?? { nb_rolls: 0, poids: 0, metrage: 0 }
        return {
          id, kind, IDcommande_client: Number(h.IDcommande_client) || 0,
          // IDadresse drives the grouped demande-de-transport picker: one sheet
          // has one "Pour livraison chez" block, so mixed addresses can't group.
          IDadresse: Number(h.IDadresse) || 0,
          commande_numero: cmd.numero, IDclient: cmd.IDclient,
          client_nom: clientNames.get(cmd.IDclient) ?? '',
          transporteur_nom: transNames.get(Number(h.IDtransporteur)) ?? '',
          date: h.dexp ?? null,
          est_facture: Number(h.est_facture) || 0,
          donation: Number(h.donation) || 0,
          nb_rolls: agg.nb_rolls, total_poids: agg.poids, total_metrage: agg.metrage,
        }
      })
      if (q) {
        const nq = norm(q)
        result = result.filter((r: any) =>
          String(r.id).includes(q) || (r.commande_numero != null && String(r.commande_numero).includes(q)) || norm(r.client_nom).includes(nq),
        )
      }
      res.json(result.slice(0, limit))
      return
    }

    // divers (no IDsociete)
    const beforeSql = beforeId !== null ? ` AND IDexpedition_divers < ${beforeId}` : ''
    const heads = await query<any>(
      `SELECT TOP ${fetchCap} IDexpedition_divers, IDclient, ref_client, IDtransporteur, DATE AS dexp, est_facture ` +
        `FROM expedition_divers WHERE 1 = 1${stateSql}${beforeSql} ORDER BY IDexpedition_divers DESC`,
    )
    const ids = heads.map((h: any) => Number(h.IDexpedition_divers)).filter(Boolean)
    const lineRows = ids.length
      ? await query<{ IDexpedition_divers: number }>(`SELECT IDexpedition_divers FROM ligne_expedition_divers WHERE IDexpedition_divers IN (${ids.join(',')})`)
      : []
    const lineCount = new Map<number, number>()
    for (const r of lineRows) lineCount.set(Number(r.IDexpedition_divers), (lineCount.get(Number(r.IDexpedition_divers)) ?? 0) + 1)
    const [clientNames, transNames] = await Promise.all([
      resolveClientNames(heads.map((h: any) => Number(h.IDclient))),
      resolveTransporteurNames(heads.map((h: any) => Number(h.IDtransporteur))),
    ])
    let result = heads.map((h: any) => {
      const id = Number(h.IDexpedition_divers)
      const IDclient = Number(h.IDclient) || 0
      const refClient = (h.ref_client ?? '').toString().trim()
      return {
        id, kind, IDclient, ref_client: refClient,
        client_nom: IDclient > 0 ? (clientNames.get(IDclient) ?? '') : refClient,
        transporteur_nom: transNames.get(Number(h.IDtransporteur)) ?? '',
        date: h.dexp ?? null,
        est_facture: Number(h.est_facture) || 0,
        nb_lignes: lineCount.get(id) ?? 0,
      }
    })
    if (q) {
      const nq = norm(q)
      result = result.filter((r: any) => String(r.id).includes(q) || norm(r.client_nom).includes(nq))
    }
    res.json(result.slice(0, limit))
  } catch (err) {
    console.error('Error fetching expeditions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  DETAIL
// ════════════════════════════════════════════════════════

/** Per-(expedition,line) shipped-roll aggregates + dispo counts for a formelle.
 *  Dispo is counted per line's OWN stock kind (fini lines → stock_fini, écru
 *  lines → stock_ecru); écru rolls merely RESERVED to a fini line as dyeing
 *  input must not be counted as shippable — that's what the roll drawer ships. */
async function formelleLineRollInfo(
  expId: number,
  lines: Array<{ lcc: number; kind: 'ecru' | 'fini' | 'none' }>,
): Promise<{
  leByLcc: Map<number, number>
  expAgg: Map<number, { nb: number; poids: number; metrage: number }>
  dispoCount: Map<number, number>
}> {
  const leByLcc = new Map<number, number>()
  const expAgg = new Map<number, { nb: number; poids: number; metrage: number }>()
  const dispoCount = new Map<number, number>()
  const ids = lines.map((l) => l.lcc).filter((x) => x > 0)
  if (ids.length === 0) return { leByLcc, expAgg, dispoCount }

  // ligne_expedition rows of this expedition (one per shipped line).
  const leRows = await query<{ IDligne_expedition: number; IDligne_commande_client: number }>(
    `SELECT IDligne_expedition, IDligne_commande_client FROM ligne_expedition WHERE IDexpedition = ${expId}`,
  )
  const lccByLe = new Map<number, number>()
  for (const r of leRows) {
    leByLcc.set(Number(r.IDligne_commande_client), Number(r.IDligne_expedition))
    lccByLe.set(Number(r.IDligne_expedition), Number(r.IDligne_commande_client))
  }
  const leIds = leRows.map((r) => Number(r.IDligne_expedition)).filter((x) => x > 0)

  // Shipped rolls on those lines.
  if (leIds.length > 0) {
    const inLe = leIds.join(',')
    const [fini, ecru] = await Promise.all([
      query<{ le: number; poids: number | null; metrage: number | null }>(`SELECT IDligne_expedition AS le, poids, metrage FROM stock_fini WHERE IDligne_expedition IN (${inLe})`),
      query<{ le: number; poids: number | null; metrage: number | null }>(`SELECT IDligne_expedition_ETM AS le, poids, metrage FROM stock_ecru WHERE IDligne_expedition_ETM IN (${inLe})`),
    ])
    for (const r of [...fini, ...ecru]) {
      const lcc = lccByLe.get(Number(r.le)) ?? 0
      if (lcc === 0) continue
      const acc = expAgg.get(lcc) ?? { nb: 0, poids: 0, metrage: 0 }
      acc.nb += 1; acc.poids += Number(r.poids) || 0; acc.metrage += Number(r.metrage) || 0
      expAgg.set(lcc, acc)
    }
  }

  // Available (affected, not yet shipped) rolls per line — only the line's own
  // stock kind counts as shippable.
  const finiLccs = lines.filter((l) => l.kind === 'fini').map((l) => l.lcc)
  const ecruLccs = lines.filter((l) => l.kind === 'ecru').map((l) => l.lcc)
  const [finiDispo, ecruDispo] = await Promise.all([
    finiLccs.length
      ? query<{ IDligne_commande_client: number }>(`SELECT IDligne_commande_client FROM stock_fini WHERE IDligne_commande_client IN (${finiLccs.join(',')}) AND (IDligne_expedition IS NULL OR IDligne_expedition = 0)`)
      : Promise.resolve([]),
    ecruLccs.length
      ? query<{ IDligne_commande_client: number }>(`SELECT IDligne_commande_client FROM stock_ecru WHERE IDligne_commande_client IN (${ecruLccs.join(',')}) AND (IDligne_expedition_ETM IS NULL OR IDligne_expedition_ETM = 0)`)
      : Promise.resolve([]),
  ])
  for (const r of [...finiDispo, ...ecruDispo]) {
    const lcc = Number(r.IDligne_commande_client) || 0
    if (lcc === 0) continue
    dispoCount.set(lcc, (dispoCount.get(lcc) ?? 0) + 1)
  }
  return { leByLcc, expAgg, dispoCount }
}

expeditionsRouter.get('/:kind/:id', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    if (kind === 'formelle') {
      const rows = await query<any>(
        `SELECT IDexpedition, IDsociete, IDcommande_client, IDadresse, IDtransporteur, DATE AS dexp, ` +
          `affiche_observations, est_facture, donation, IDcontact, observation_bl, inclureRapportQualite ` +
          `FROM expedition WHERE IDexpedition = ${id} AND IDsociete = 1`,
      )
      if (rows.length === 0) { res.status(404).json({ error: 'Expédition not found' }); return }
      const h = rows[0]
      const cmdId = Number(h.IDcommande_client) || 0

      const cmdRows = cmdId > 0
        ? await query<{ numero: number | null; IDclient: number }>(`SELECT numero, IDclient FROM commande_client WHERE IDcommande_client = ${cmdId}`)
        : []
      const IDclient = Number(cmdRows[0]?.IDclient) || 0

      const [clientNames, transNames, adr, contactNom, factures, lignesRaw] = await Promise.all([
        resolveClientNames([IDclient]),
        resolveTransporteurNames([Number(h.IDtransporteur)]),
        loadAdresse(Number(h.IDadresse) || 0),
        loadContactName(Number(h.IDcontact) || 0),
        attachedFactures('formelle', id),
        cmdId > 0
          ? query<any>(
              `SELECT IDligne_commande_client, TYPE AS type_kind, IDreference, IDcolori, quantite, unite ` +
                `FROM ligne_commande_client WHERE IDcommande_client = ${cmdId} ORDER BY IDligne_commande_client`,
            )
          : Promise.resolve([]),
      ])

      const lignesForResolve = (lignesRaw as any[]).map((l) => ({ IDreference: Number(l.IDreference) || 0, IDcolori: Number(l.IDcolori) || 0, type_kind: Number(l.type_kind) || 0 }))
      const maps = await resolveLineLabels(lignesForResolve)
      const typedLines = (lignesRaw as any[])
        .map((l) => ({ lcc: Number(l.IDligne_commande_client) || 0, kind: lineStockKind(Number(l.type_kind) || 0) }))
        .filter((l) => l.lcc > 0)
      const { leByLcc, expAgg, dispoCount } = await formelleLineRollInfo(id, typedLines)

      const lignes = (lignesRaw as any[]).map((l) => {
        const lcc = Number(l.IDligne_commande_client)
        const typeKind = Number(l.type_kind) || 0
        const refId = Number(l.IDreference) || 0
        const colId = Number(l.IDcolori) || 0
        const agg = expAgg.get(lcc) ?? { nb: 0, poids: 0, metrage: 0 }
        return {
          IDligne_commande_client: lcc,
          IDligne_expedition: leByLcc.get(lcc) ?? 0,
          type: typeKind,
          stock_kind: lineStockKind(typeKind),
          ref_label: resolveRefLabel(maps, refId, typeKind) || null,
          colori_reference: resolveColorisLabel(maps, colId, typeKind, refId) || null,
          quantite: Number(l.quantite) || 0,
          unite: Number(l.unite) || 0,
          unite_label: uniteLabel(l.unite),
          dim: lineDim(l.unite),
          nb_rolls_exp: agg.nb,
          poids_exp: agg.poids,
          metrage_exp: agg.metrage,
          nb_rolls_dispo: dispoCount.get(lcc) ?? 0,
        }
      })

      res.json({
        id, kind,
        IDcommande_client: cmdId,
        commande_numero: cmdRows[0]?.numero != null ? Number(cmdRows[0].numero) : null,
        IDclient, client_nom: clientNames.get(IDclient) ?? '',
        date: h.dexp ?? null,
        IDtransporteur: Number(h.IDtransporteur) || 0,
        transporteur_nom: transNames.get(Number(h.IDtransporteur)) ?? '',
        IDadresse: Number(h.IDadresse) || 0,
        adresse_livraison: adr,
        IDcontact: Number(h.IDcontact) || 0,
        contact_nom: contactNom,
        donation: Number(h.donation) || 0,
        affiche_observations: Number(h.affiche_observations) || 0,
        inclureRapportQualite: Number(h.inclureRapportQualite) || 0,
        observation_bl: stripRtf(h.observation_bl) || '',
        est_facture: Number(h.est_facture) || 0,
        factures,
        locked: Number(h.est_facture) === 1 || factures.length > 0,
        lignes,
      })
      return
    }

    // divers
    const rows = await query<any>(
      `SELECT IDexpedition_divers, IDclient, ref_client, IDadresse, IDtransporteur, DATE AS dexp, est_facture, IDcommande_client ` +
        `FROM expedition_divers WHERE IDexpedition_divers = ${id}`,
    )
    if (rows.length === 0) { res.status(404).json({ error: 'Expédition not found' }); return }
    const h = rows[0]
    const IDclient = Number(h.IDclient) || 0
    const [clientNames, transNames, adr, factures, lignesRaw] = await Promise.all([
      resolveClientNames([IDclient]),
      resolveTransporteurNames([Number(h.IDtransporteur)]),
      loadAdresse(Number(h.IDadresse) || 0),
      attachedFactures('divers', id),
      query<any>(`SELECT IDligne_expedition_divers, detail_ligne FROM ligne_expedition_divers WHERE IDexpedition_divers = ${id} ORDER BY IDligne_expedition_divers`),
    ])
    const lignesFixed = await fixEncoding(lignesRaw, 'ligne_expedition_divers', 'IDligne_expedition_divers', ['detail_ligne'])
    const itemsByLigne = await loadDiversItems((lignesFixed as any[]).map((l) => Number(l.IDligne_expedition_divers) || 0))
    const lignes = (lignesFixed as any[]).map((l) => ({
      IDligne_expedition_divers: Number(l.IDligne_expedition_divers),
      detail_ligne: stripRtf(l.detail_ligne) || '',
      items: itemsByLigne.get(Number(l.IDligne_expedition_divers)) ?? [],
    }))
    res.json({
      id, kind,
      IDclient, ref_client: (h.ref_client ?? '').toString(),
      client_nom: IDclient > 0 ? (clientNames.get(IDclient) ?? '') : (h.ref_client ?? '').toString(),
      date: h.dexp ?? null,
      IDtransporteur: Number(h.IDtransporteur) || 0,
      transporteur_nom: transNames.get(Number(h.IDtransporteur)) ?? '',
      IDadresse: Number(h.IDadresse) || 0,
      adresse_livraison: adr,
      est_facture: Number(h.est_facture) || 0,
      factures,
      locked: Number(h.est_facture) === 1 || factures.length > 0,
      lignes,
    })
  } catch (err) {
    console.error('Error fetching expedition detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  HEADER CRUD
// ════════════════════════════════════════════════════════

const createBody = z.object({
  // formelle
  IDcommande_client: z.number().int().positive().optional(),
  // divers
  IDclient: z.number().int().nonnegative().optional(),
  ref_client: z.string().optional(),
  // divers — optional back-pointer to the client order the shipment fulfils
  // (expedition_divers.IDcommande_client; set by the Clients › Commandes
  // "Expédition groupée" flow, left at 0 for standalone misc shipments).
  IDcommande_client_divers: z.number().int().nonnegative().optional(),
  // shared
  date: z.string().optional(),
  IDtransporteur: z.number().int().nonnegative().optional(),
  IDadresse: z.number().int().nonnegative().optional(),
  donation: z.number().int().min(0).max(1).optional(),
})

expeditionsRouter.post('/:kind', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const parsed = createBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    const date = d.date ? dateStr(d.date) || todayDigits() : todayDigits()

    if (kind === 'formelle') {
      if (!d.IDcommande_client) { res.status(400).json({ error: 'IDcommande_client is required' }); return }
      const cmdRows = await query<{ IDclient: number; IDadresse_livraison: number; donation: number | null }>(
        `SELECT IDclient, IDadresse_livraison, donation FROM commande_client WHERE IDcommande_client = ${n(d.IDcommande_client)} AND IDsociete = 1`,
      )
      if (cmdRows.length === 0) { res.status(400).json({ error: 'Commande introuvable' }); return }
      const IDclient = Number(cmdRows[0].IDclient) || 0
      // Auto-fill: livraison address from the order, carrier from the client,
      // donation flag from the order (donation shipments never get a proforma).
      const clientRows = await query<{ IDtransporteur: number; inclureRapportQualite: number | null }>(
        `SELECT IDtransporteur, inclureRapportQualite FROM client WHERE IDclient = ${IDclient}`,
      )
      const idAdresse = d.IDadresse ?? (Number(cmdRows[0].IDadresse_livraison) || 0)
      const idTrans = d.IDtransporteur ?? (Number(clientRows[0]?.IDtransporteur) || 0)
      const donation = d.donation ?? (Number(cmdRows[0].donation) === 1 ? 1 : 0)
      // Per-shipment mirror of the client's "inclure rapports contrôle" flag —
      // legacy seeds it from the client at creation time.
      const inclureRc = Number(clientRows[0]?.inclureRapportQualite) === 1 ? 1 : 0

      const before = await maxId('expedition', 'IDexpedition')
      await query(
        `INSERT INTO expedition (IDsociete, IDcommande_client, IDadresse, IDtransporteur, IDcontact, DATE, donation, affiche_observations, est_valide, est_facture, inclureRapportQualite) ` +
          `VALUES (1, ${n(d.IDcommande_client)}, ${n(idAdresse)}, ${n(idTrans)}, 0, '${date}', ${donation ? 1 : 0}, 1, 0, 0, ${inclureRc})`,
      )
      const newId = await newIdAfterInsert('expedition', 'IDexpedition', before)
      res.status(201).json({ id: newId, kind })
      return
    }

    // divers
    const before = await maxId('expedition_divers', 'IDexpedition_divers')
    await query(
      `INSERT INTO expedition_divers (IDclient, ref_client, IDadresse, IDtransporteur, DATE, est_valide, est_facture, IDcommande_client) ` +
        `VALUES (${n(d.IDclient)}, ${sqlText(d.ref_client)}, ${n(d.IDadresse)}, ${n(d.IDtransporteur)}, '${date}', 0, 0, ${n(d.IDcommande_client_divers ?? 0)})`,
    )
    const newId = await newIdAfterInsert('expedition_divers', 'IDexpedition_divers', before)
    res.status(201).json({ id: newId, kind })
  } catch (err) {
    console.error('Error creating expedition:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const updateBody = z.object({
  date: z.string().optional(),
  IDtransporteur: z.number().int().nonnegative().optional(),
  IDadresse: z.number().int().nonnegative().optional(),
  // formelle only
  IDcontact: z.number().int().nonnegative().optional(),
  donation: z.number().int().min(0).max(1).optional(),
  affiche_observations: z.number().int().min(0).max(1).optional(),
  inclureRapportQualite: z.number().int().min(0).max(1).optional(),
  observation_bl: z.string().optional(),
  // divers only
  IDclient: z.number().int().nonnegative().optional(),
  ref_client: z.string().optional(),
})

expeditionsRouter.put('/:kind/:id', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (await isLocked(kind, id)) { res.status(409).json(FACTURE_LOCK); return }

    const parsed = updateBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    const sets: string[] = []
    if (d.date !== undefined) sets.push(`DATE = '${dateStr(d.date)}'`)
    if (d.IDtransporteur !== undefined) sets.push(`IDtransporteur = ${n(d.IDtransporteur)}`)
    if (d.IDadresse !== undefined) sets.push(`IDadresse = ${n(d.IDadresse)}`)
    if (kind === 'formelle') {
      if (d.IDcontact !== undefined) sets.push(`IDcontact = ${n(d.IDcontact)}`)
      if (d.donation !== undefined) sets.push(`donation = ${d.donation ? 1 : 0}`)
      if (d.affiche_observations !== undefined) sets.push(`affiche_observations = ${d.affiche_observations ? 1 : 0}`)
      if (d.inclureRapportQualite !== undefined) sets.push(`inclureRapportQualite = ${d.inclureRapportQualite ? 1 : 0}`)
      if (d.observation_bl !== undefined) sets.push(`observation_bl = ${sqlText(wrapRtf(d.observation_bl))}`)
    } else {
      if (d.IDclient !== undefined) sets.push(`IDclient = ${n(d.IDclient)}`)
      if (d.ref_client !== undefined) sets.push(`ref_client = ${sqlText(d.ref_client)}`)
    }
    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }
    await query(`UPDATE ${TBL[kind].head} SET ${sets.join(', ')} WHERE ${TBL[kind].pk} = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating expedition:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeditionsRouter.delete('/:kind/:id', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (await isLocked(kind, id)) { res.status(409).json(FACTURE_LOCK); return }

    if (kind === 'formelle') {
      // Free every roll shipped on this expedition, then drop the lines + header.
      const leRows = await query<{ IDligne_expedition: number }>(`SELECT IDligne_expedition FROM ligne_expedition WHERE IDexpedition = ${id}`)
      const leIds = leRows.map((r) => Number(r.IDligne_expedition)).filter((x) => x > 0)
      if (leIds.length > 0) {
        const inLe = leIds.join(',')
        await query(`UPDATE stock_fini SET IDligne_expedition = 0 WHERE IDligne_expedition IN (${inLe})`)
        await query(`UPDATE stock_ecru SET IDligne_expedition_ETM = 0 WHERE IDligne_expedition_ETM IN (${inLe})`)
      }
      await query(`DELETE FROM ligne_expedition WHERE IDexpedition = ${id}`)
      await query(`DELETE FROM expedition WHERE IDexpedition = ${id} AND IDsociete = 1`)
    } else {
      // Cascade: carton items first, then the cartons, then the header.
      const lineRows = await query<{ IDligne_expedition_divers: number }>(
        `SELECT IDligne_expedition_divers FROM ligne_expedition_divers WHERE IDexpedition_divers = ${id}`,
      )
      const lineIds = lineRows.map((r) => Number(r.IDligne_expedition_divers)).filter((x) => x > 0)
      if (lineIds.length > 0) {
        await restoreDiversStockForCartons(lineIds)
        await query(`DELETE FROM ref_divers_expedie WHERE IDligne_expedition_divers IN (${lineIds.join(',')})`)
      }
      await query(`DELETE FROM ligne_expedition_divers WHERE IDexpedition_divers = ${id}`)
      await query(`DELETE FROM expedition_divers WHERE IDexpedition_divers = ${id}`)
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting expedition:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  FORMELLE — roll picking per commande line
// ════════════════════════════════════════════════════════

interface LineCtx { lcc: number; type: number; refId: number; coloriId: number; quantite: number; unite: number; kind: 'ecru' | 'fini' | 'none' }

async function loadLineCtx(lccId: number): Promise<LineCtx | null> {
  const rows = await query<any>(
    `SELECT IDligne_commande_client, TYPE AS type_kind, IDreference, IDcolori, quantite, unite ` +
      `FROM ligne_commande_client WHERE IDligne_commande_client = ${lccId}`,
  )
  if (rows.length === 0) return null
  const r = rows[0]
  const type = Number(r.type_kind) || 0
  return { lcc: lccId, type, refId: Number(r.IDreference) || 0, coloriId: Number(r.IDcolori) || 0, quantite: Number(r.quantite) || 0, unite: Number(r.unite) || 0, kind: lineStockKind(type) }
}

/** Resolve the ligne_expedition id linking (expId, lccId), 0 if none. */
async function findLigneExpedition(expId: number, lccId: number): Promise<number> {
  const rows = await query<{ IDligne_expedition: number }>(
    `SELECT TOP 1 IDligne_expedition FROM ligne_expedition WHERE IDexpedition = ${expId} AND IDligne_commande_client = ${lccId} ORDER BY IDligne_expedition DESC`,
  )
  return Number(rows[0]?.IDligne_expedition) || 0
}

async function buildRollPayload(expId: number, ctx: LineCtx) {
  const base = {
    kind: ctx.kind,
    dim: lineDim(ctx.unite) as 'metrage' | 'poids',
    unite_label: uniteLabel(ctx.unite),
    target_qty: ctx.quantite,
    onExp: [] as RollLite[],
    dispo: [] as RollLite[],
  }
  if (ctx.kind === 'none') return base
  const leId = await findLigneExpedition(expId, ctx.lcc)

  if (ctx.kind === 'fini') {
    const avecRows = await query<{ avec_teinture: number | null }>(`SELECT avec_teinture FROM ref_fini WHERE IDref_fini = ${ctx.refId}`)
    const avec = Number(avecRows[0]?.avec_teinture) || 0
    const [onRaw, dispoRaw] = await Promise.all([
      leId > 0
        ? query<any>(`SELECT IDstock_fini, numero, lot, poids, metrage, IDColoris, IDmagasin, second_choix, observations, IDetat_stock_fini FROM stock_fini WHERE IDligne_expedition = ${leId} ORDER BY numero`)
        : Promise.resolve([]),
      query<any>(
        `SELECT IDstock_fini, numero, lot, poids, metrage, IDColoris, IDmagasin, second_choix, observations, IDetat_stock_fini ` +
          `FROM stock_fini WHERE IDligne_commande_client = ${ctx.lcc} AND (IDligne_expedition IS NULL OR IDligne_expedition = 0) ORDER BY numero`,
      ),
    ])
    const onFixed = await fixEncoding(onRaw, 'stock_fini', 'IDstock_fini', ['numero', 'lot', 'observations'])
    const dispoFixed = await fixEncoding(dispoRaw, 'stock_fini', 'IDstock_fini', ['numero', 'lot', 'observations'])
    const all = [...onFixed, ...dispoFixed] as any[]
    const [mag, col] = await Promise.all([
      resolveMagasinNames(all.map((r) => Number(r.IDmagasin))),
      resolveFiniColoris(all.map((r) => Number(r.IDColoris)), avec),
    ])
    const toRoll = (r: any): RollLite => ({
      id: Number(r.IDstock_fini), numero: r.numero ?? null, lot: r.lot ?? null,
      poids: Number(r.poids) || 0, metrage: Number(r.metrage) || 0,
      coloris_reference: col.get(Number(r.IDColoris)) ?? null, magasin_nom: mag.get(Number(r.IDmagasin)) ?? null,
      second_choix: Number(r.second_choix) || 0, observations: r.observations ?? null,
      etat_label: ETAT_FINI_LABELS[Number(r.IDetat_stock_fini)] ?? null,
    })
    base.onExp = onFixed.map(toRoll)
    base.dispo = dispoFixed.map(toRoll)
    return base
  }

  // écru
  const [onRaw, dispoRaw] = await Promise.all([
    leId > 0
      ? query<any>(`SELECT IDstock_ecru, numero, lot, poids, metrage, IDcolori_ecru, IDmagasin, second_choix, observations FROM stock_ecru WHERE IDligne_expedition_ETM = ${leId} ORDER BY numero`)
      : Promise.resolve([]),
    query<any>(
      `SELECT IDstock_ecru, numero, lot, poids, metrage, IDcolori_ecru, IDmagasin, second_choix, observations ` +
        `FROM stock_ecru WHERE IDligne_commande_client = ${ctx.lcc} AND (IDligne_expedition_ETM IS NULL OR IDligne_expedition_ETM = 0) ORDER BY numero`,
    ),
  ])
  const onFixed = await fixEncoding(onRaw, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot', 'observations'])
  const dispoFixed = await fixEncoding(dispoRaw, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot', 'observations'])
  const all = [...onFixed, ...dispoFixed] as any[]
  const [mag, col] = await Promise.all([
    resolveMagasinNames(all.map((r) => Number(r.IDmagasin))),
    resolveEcruColoris(all.map((r) => Number(r.IDcolori_ecru))),
  ])
  const toRoll = (r: any): RollLite => ({
    id: Number(r.IDstock_ecru), numero: r.numero ?? null, lot: r.lot ?? null,
    poids: Number(r.poids) || 0, metrage: Number(r.metrage) || 0,
    coloris_reference: col.get(Number(r.IDcolori_ecru)) ?? null, magasin_nom: mag.get(Number(r.IDmagasin)) ?? null,
    second_choix: Number(r.second_choix) || 0, observations: r.observations ?? null, etat_label: null,
  })
  base.onExp = onFixed.map(toRoll)
  base.dispo = dispoFixed.map(toRoll)
  return base
}

expeditionsRouter.get('/formelle/:id/lignes/:lccId/rolls', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const lccId = parseInt(req.params.lccId, 10)
    if (isNaN(id) || isNaN(lccId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadLineCtx(lccId)
    if (!ctx) { res.status(404).json({ error: 'Ligne introuvable' }); return }
    res.json(await buildRollPayload(id, ctx))
  } catch (err) {
    console.error('Error fetching expedition rolls:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Assign a roll to this shipment's line (lazily creating the ligne_expedition).
expeditionsRouter.put('/formelle/:id/lignes/:lccId/rolls/:stockId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const lccId = parseInt(req.params.lccId, 10)
    const stockId = parseInt(req.params.stockId, 10)
    if (isNaN(id) || isNaN(lccId) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (await isLocked('formelle', id)) { res.status(409).json(FACTURE_LOCK); return }
    const ctx = await loadLineCtx(lccId)
    if (!ctx || ctx.kind === 'none') { res.status(404).json({ error: 'Ligne non expédiable' }); return }

    // Ensure a ligne_expedition exists for (expedition, commande line).
    let leId = await findLigneExpedition(id, lccId)
    if (leId === 0) {
      await query(`INSERT INTO ligne_expedition (IDexpedition, IDligne_commande_client, est_facture) VALUES (${id}, ${lccId}, 0)`)
      leId = await findLigneExpedition(id, lccId)
      if (leId === 0) { res.status(500).json({ error: "Création de la ligne d'expédition échouée" }); return }
    }

    if (ctx.kind === 'fini') {
      const roll = await query<{ IDligne_commande_client: number | null; IDligne_expedition: number | null }>(
        `SELECT IDligne_commande_client, IDligne_expedition FROM stock_fini WHERE IDstock_fini = ${stockId}`,
      )
      if (roll.length === 0) { res.status(404).json({ error: 'Rouleau introuvable' }); return }
      if ((Number(roll[0].IDligne_commande_client) || 0) !== lccId) { res.status(400).json({ error: 'Rouleau non affecté à cette ligne' }); return }
      const cur = Number(roll[0].IDligne_expedition) || 0
      if (cur !== 0 && cur !== leId) { res.status(409).json({ error: 'Rouleau déjà expédié' }); return }
      await query(`UPDATE stock_fini SET IDligne_expedition = ${leId} WHERE IDstock_fini = ${stockId}`)
    } else {
      const roll = await query<{ IDligne_commande_client: number | null; IDligne_expedition_ETM: number | null }>(
        `SELECT IDligne_commande_client, IDligne_expedition_ETM FROM stock_ecru WHERE IDstock_ecru = ${stockId}`,
      )
      if (roll.length === 0) { res.status(404).json({ error: 'Rouleau introuvable' }); return }
      if ((Number(roll[0].IDligne_commande_client) || 0) !== lccId) { res.status(400).json({ error: 'Rouleau non affecté à cette ligne' }); return }
      const cur = Number(roll[0].IDligne_expedition_ETM) || 0
      if (cur !== 0 && cur !== leId) { res.status(409).json({ error: 'Rouleau déjà expédié' }); return }
      await query(`UPDATE stock_ecru SET IDligne_expedition_ETM = ${leId} WHERE IDstock_ecru = ${stockId}`)
    }
    res.json(await buildRollPayload(id, ctx))
  } catch (err) {
    console.error('Error assigning roll to expedition:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Unassign a roll; drop the ligne_expedition if it becomes empty.
expeditionsRouter.delete('/formelle/:id/lignes/:lccId/rolls/:stockId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const lccId = parseInt(req.params.lccId, 10)
    const stockId = parseInt(req.params.stockId, 10)
    if (isNaN(id) || isNaN(lccId) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (await isLocked('formelle', id)) { res.status(409).json(FACTURE_LOCK); return }
    const ctx = await loadLineCtx(lccId)
    if (!ctx || ctx.kind === 'none') { res.status(404).json({ error: 'Ligne non expédiable' }); return }
    const leId = await findLigneExpedition(id, lccId)
    if (leId > 0) {
      if (ctx.kind === 'fini') {
        await query(`UPDATE stock_fini SET IDligne_expedition = 0 WHERE IDstock_fini = ${stockId} AND IDligne_expedition = ${leId}`)
      } else {
        await query(`UPDATE stock_ecru SET IDligne_expedition_ETM = 0 WHERE IDstock_ecru = ${stockId} AND IDligne_expedition_ETM = ${leId}`)
      }
      // Delete the ligne_expedition if no rolls remain on it.
      const [f, e] = await Promise.all([
        query<{ c: number }>(`SELECT COUNT(*) AS c FROM stock_fini WHERE IDligne_expedition = ${leId}`),
        query<{ c: number }>(`SELECT COUNT(*) AS c FROM stock_ecru WHERE IDligne_expedition_ETM = ${leId}`),
      ])
      if ((Number(f[0]?.c) || 0) === 0 && (Number(e[0]?.c) || 0) === 0) {
        await query(`DELETE FROM ligne_expedition WHERE IDligne_expedition = ${leId}`)
      }
    }
    res.json(await buildRollPayload(id, ctx))
  } catch (err) {
    console.error('Error unassigning roll from expedition:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  DIVERS — free-text line CRUD
// ════════════════════════════════════════════════════════

const diversLineBody = z.object({ detail_ligne: z.string().optional() })

expeditionsRouter.post('/divers/:id/lignes', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (await isLocked('divers', id)) { res.status(409).json(FACTURE_LOCK); return }
    const parsed = diversLineBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    await query(
      `INSERT INTO ligne_expedition_divers (IDexpedition_divers, detail_ligne) VALUES (${id}, ${sqlText(wrapRtf(parsed.data.detail_ligne ?? ''))})`,
    )
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('Error adding divers line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

async function diversLineParent(lineId: number): Promise<number> {
  const rows = await query<{ IDexpedition_divers: number }>(`SELECT IDexpedition_divers FROM ligne_expedition_divers WHERE IDligne_expedition_divers = ${lineId}`)
  return Number(rows[0]?.IDexpedition_divers) || 0
}

expeditionsRouter.put('/divers/lignes/:lineId', async (req: Request, res: Response) => {
  try {
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parent = await diversLineParent(lineId)
    if (parent === 0) { res.status(404).json({ error: 'Line not found' }); return }
    if (await isLocked('divers', parent)) { res.status(409).json(FACTURE_LOCK); return }
    const parsed = diversLineBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    await query(`UPDATE ligne_expedition_divers SET detail_ligne = ${sqlText(wrapRtf(parsed.data.detail_ligne ?? ''))} WHERE IDligne_expedition_divers = ${lineId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating divers line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeditionsRouter.delete('/divers/lignes/:lineId', async (req: Request, res: Response) => {
  try {
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parent = await diversLineParent(lineId)
    if (parent === 0) { res.status(404).json({ error: 'Line not found' }); return }
    if (await isLocked('divers', parent)) { res.status(409).json(FACTURE_LOCK); return }
    // Cascade: the carton's items go with it — their quantities go back on stock.
    await restoreDiversStockForCartons([lineId])
    await query(`DELETE FROM ref_divers_expedie WHERE IDligne_expedition_divers = ${lineId}`)
    await query(`DELETE FROM ligne_expedition_divers WHERE IDligne_expedition_divers = ${lineId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting divers line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  DIVERS — carton items (ref_divers_expedie)
// ════════════════════════════════════════════════════════

/** Kill HFSQL REAL artifacts (69.440002 → 69.44). Prices/qty keep 4 decimals. */
const r4 = (v: unknown): number => Math.round((Number(v) || 0) * 10000) / 10000

/** Divers stock ledger — the legacy "Stock disponible" of a divers order line.
 *  `stock_divers` holds one on-hand row per (IDref_divers, IDVariation1,
 *  IDVariation2); legacy decrements it when an expédition divers ships that
 *  combo and puts it back when the shipment is undone. Every write to
 *  `ref_divers_expedie` in this file goes through here so the two apps agree
 *  on the same live rows.
 *
 *  `delta` is signed: negative = shipped (take off stock), positive = restored.
 *  MPS_NG never CREATES a stock_divers row — rows are opened by the legacy
 *  FEN_Gestion_Stock_Divers screen when goods are received. A combo with no
 *  row is simply untracked and the call is a no-op. */
export async function adjustDiversStock(
  refId: number, v1: number, v2: number, delta: number,
): Promise<void> {
  if (!(refId > 0) || !Number.isFinite(delta) || delta === 0) return
  const rows = await query<{ IDstock_divers: number; quantite: number | null }>(
    `SELECT IDstock_divers, quantite FROM stock_divers
      WHERE IDref_divers = ${n(refId)} AND IDVariation1 = ${n(v1)} AND IDVariation2 = ${n(v2)}`,
  )
  if (rows.length === 0) return
  const id = Number(rows[0].IDstock_divers) || 0
  if (id <= 0) return
  await query(`UPDATE stock_divers SET quantite = ${r4((Number(rows[0].quantite) || 0) + delta)} WHERE IDstock_divers = ${id}`)
}

/** Restore the divers stock consumed by a set of cartons — used by the cascade
 *  deletes (carton dropped, expédition dropped). Reads the items before they go. */
async function restoreDiversStockForCartons(ligneIds: number[]): Promise<void> {
  const ids = ligneIds.filter((x) => Number.isInteger(x) && x > 0)
  if (ids.length === 0) return
  const rows = await query<any>(
    `SELECT quantite, IDref_divers, IDVariation1, IDVariation2 FROM ref_divers_expedie ` +
      `WHERE IDligne_expedition_divers IN (${ids.join(',')})`,
  )
  for (const r of rows as any[]) {
    await adjustDiversStock(Number(r.IDref_divers) || 0, Number(r.IDVariation1) || 0, Number(r.IDVariation2) || 0, r4(r.quantite))
  }
}

export interface DiversItem {
  IDref_divers_expedie: number
  IDref_divers: number
  ref_designation: string
  designation: string
  IDVariation1: number
  variation1_label: string | null
  IDVariation2: number
  variation2_label: string | null
  quantite: number
  unite: number
  unite_label: string
  prix: number
}

/** Load ref_divers_expedie items for a set of cartons, with ref + variation
 *  labels resolved (batched — one query per table, one CONVERT per column). */
export async function loadDiversItems(ligneIds: number[]): Promise<Map<number, DiversItem[]>> {
  const out = new Map<number, DiversItem[]>()
  const ids = ligneIds.filter((x) => Number.isInteger(x) && x > 0)
  if (ids.length === 0) return out

  const raw = await query<any>(
    `SELECT IDref_divers_expedie, IDligne_expedition_divers, designation, quantite, unite, prix, IDref_divers, IDVariation1, IDVariation2 ` +
      `FROM ref_divers_expedie WHERE IDligne_expedition_divers IN (${ids.join(',')}) ORDER BY IDref_divers_expedie`,
  )
  if (raw.length === 0) return out
  const items = await repairAliased(raw, 'ref_divers_expedie', 'IDref_divers_expedie', { designation: 'designation' })

  const refIds = [...new Set(items.map((i: any) => Number(i.IDref_divers) || 0).filter((x) => x > 0))]
  const varIds = [
    ...new Set(
      items
        .flatMap((i: any) => [Number(i.IDVariation1) || 0, Number(i.IDVariation2) || 0])
        .filter((x) => x > 0),
    ),
  ]
  const [refRows, varRows] = await Promise.all([
    refIds.length
      ? query<any>(`SELECT IDref_divers, designation FROM ref_divers WHERE IDref_divers IN (${refIds.join(',')})`)
      : Promise.resolve([]),
    varIds.length
      ? query<any>(`SELECT IDref_divers_variation, designation FROM ref_divers_variation WHERE IDref_divers_variation IN (${varIds.join(',')})`)
      : Promise.resolve([]),
  ])
  const refFixed = await repairAliased(refRows as any[], 'ref_divers', 'IDref_divers', { designation: 'designation' })
  const varFixed = await repairAliased(varRows as any[], 'ref_divers_variation', 'IDref_divers_variation', { designation: 'designation' })
  const refName = new Map<number, string>()
  for (const r of refFixed as any[]) refName.set(Number(r.IDref_divers), (r.designation ?? '').toString())
  const varName = new Map<number, string>()
  for (const v of varFixed as any[]) varName.set(Number(v.IDref_divers_variation), (v.designation ?? '').toString())

  for (const i of items as any[]) {
    const ligneId = Number(i.IDligne_expedition_divers) || 0
    const v1 = Number(i.IDVariation1) || 0
    const v2 = Number(i.IDVariation2) || 0
    const item: DiversItem = {
      IDref_divers_expedie: Number(i.IDref_divers_expedie) || 0,
      IDref_divers: Number(i.IDref_divers) || 0,
      ref_designation: refName.get(Number(i.IDref_divers) || 0) ?? '',
      designation: (i.designation ?? '').toString(),
      IDVariation1: v1,
      variation1_label: v1 > 0 ? (varName.get(v1) ?? null) : null,
      IDVariation2: v2,
      variation2_label: v2 > 0 ? (varName.get(v2) ?? null) : null,
      quantite: r4(i.quantite),
      unite: Number(i.unite) || 0,
      unite_label: uniteLabel(i.unite),
      prix: r4(i.prix),
    }
    if (!out.has(ligneId)) out.set(ligneId, [])
    out.get(ligneId)!.push(item)
  }
  return out
}

/** Resolve the tarif_divers grid price for a (ref, v1, v2) combo:
 *  exact combo → (v1, 0) → base (0, 0) → ref_divers.prix_unitaire. */
async function resolveDiversPrix(refId: number, v1: number, v2: number): Promise<number> {
  const rows = await query<any>(
    `SELECT prix, IDVariation1, IDVariation2 FROM tarif_divers WHERE IDref_divers = ${refId}`,
  )
  const grid = (rows as any[]).map((r) => ({ v1: Number(r.IDVariation1) || 0, v2: Number(r.IDVariation2) || 0, prix: r4(r.prix) }))
  const pick = (a: number, b: number) => grid.find((g) => g.v1 === a && g.v2 === b && g.prix > 0)
  const hit = pick(v1, v2) ?? (v2 > 0 ? pick(v1, 0) : undefined) ?? pick(0, 0)
  if (hit) return hit.prix
  const ref = await query<any>(`SELECT prix_unitaire FROM ref_divers WHERE IDref_divers = ${refId}`)
  return r4(ref[0]?.prix_unitaire)
}

async function diversItemParentLigne(itemId: number): Promise<number> {
  const rows = await query<{ IDligne_expedition_divers: number }>(
    `SELECT IDligne_expedition_divers FROM ref_divers_expedie WHERE IDref_divers_expedie = ${itemId}`,
  )
  return Number(rows[0]?.IDligne_expedition_divers) || 0
}

const diversItemBody = z.object({
  IDref_divers: z.number().int().positive(),
  IDVariation1: z.number().int().nonnegative().optional(),
  IDVariation2: z.number().int().nonnegative().optional(),
  quantite: z.number().nonnegative(),
  prix: z.number().nonnegative().optional(),
  designation: z.string().optional(),
})

expeditionsRouter.post('/divers/lignes/:lineId/items', async (req: Request, res: Response) => {
  try {
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parent = await diversLineParent(lineId)
    if (parent === 0) { res.status(404).json({ error: 'Line not found' }); return }
    if (await isLocked('divers', parent)) { res.status(409).json(FACTURE_LOCK); return }
    const parsed = diversItemBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    const refRows = await query<any>(`SELECT IDref_divers, unite FROM ref_divers WHERE IDref_divers = ${n(d.IDref_divers)}`)
    if (refRows.length === 0) { res.status(400).json({ error: 'Référence introuvable' }); return }
    const unite = Number(refRows[0].unite) || 0
    const v1 = d.IDVariation1 ?? 0
    const v2 = d.IDVariation2 ?? 0
    const prix = d.prix ?? (await resolveDiversPrix(d.IDref_divers, v1, v2))
    await query(
      `INSERT INTO ref_divers_expedie (IDligne_expedition_divers, designation, quantite, unite, prix, IDref_divers, IDVariation1, IDVariation2) ` +
        `VALUES (${lineId}, ${sqlText(d.designation ?? '')}, ${r4(d.quantite)}, ${unite}, ${r4(prix)}, ${n(d.IDref_divers)}, ${n(v1)}, ${n(v2)})`,
    )
    // Shipping takes the quantity off the divers stock ledger (legacy parity).
    await adjustDiversStock(d.IDref_divers, v1, v2, -r4(d.quantite))
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('Error adding divers item:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeditionsRouter.put('/divers/items/:itemId', async (req: Request, res: Response) => {
  try {
    const itemId = parseInt(req.params.itemId, 10)
    if (isNaN(itemId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ligneId = await diversItemParentLigne(itemId)
    if (ligneId === 0) { res.status(404).json({ error: 'Item not found' }); return }
    const parent = await diversLineParent(ligneId)
    if (parent === 0) { res.status(404).json({ error: 'Line not found' }); return }
    if (await isLocked('divers', parent)) { res.status(409).json(FACTURE_LOCK); return }
    const parsed = diversItemBody.partial().safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    // Snapshot the pre-edit ref/variation/quantity so the stock ledger can be
    // rebalanced: put the old quantity back, take the new one off.
    const beforeRows = await query<any>(
      `SELECT quantite, IDref_divers, IDVariation1, IDVariation2 FROM ref_divers_expedie WHERE IDref_divers_expedie = ${itemId}`,
    )
    const before = beforeRows[0]
      ? {
          qty: r4(beforeRows[0].quantite),
          ref: Number(beforeRows[0].IDref_divers) || 0,
          v1: Number(beforeRows[0].IDVariation1) || 0,
          v2: Number(beforeRows[0].IDVariation2) || 0,
        }
      : null
    const sets: string[] = []
    if (d.IDref_divers !== undefined) {
      const refRows = await query<any>(`SELECT IDref_divers, unite FROM ref_divers WHERE IDref_divers = ${n(d.IDref_divers)}`)
      if (refRows.length === 0) { res.status(400).json({ error: 'Référence introuvable' }); return }
      sets.push(`IDref_divers = ${n(d.IDref_divers)}`, `unite = ${Number(refRows[0].unite) || 0}`)
    }
    if (d.IDVariation1 !== undefined) sets.push(`IDVariation1 = ${n(d.IDVariation1)}`)
    if (d.IDVariation2 !== undefined) sets.push(`IDVariation2 = ${n(d.IDVariation2)}`)
    if (d.quantite !== undefined) sets.push(`quantite = ${r4(d.quantite)}`)
    if (d.prix !== undefined) sets.push(`prix = ${r4(d.prix)}`)
    if (d.designation !== undefined) sets.push(`designation = ${sqlText(d.designation)}`)
    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }
    await query(`UPDATE ref_divers_expedie SET ${sets.join(', ')} WHERE IDref_divers_expedie = ${itemId}`)
    if (before) {
      await adjustDiversStock(before.ref, before.v1, before.v2, before.qty)
      await adjustDiversStock(
        d.IDref_divers ?? before.ref,
        d.IDVariation1 ?? before.v1,
        d.IDVariation2 ?? before.v2,
        -(d.quantite !== undefined ? r4(d.quantite) : before.qty),
      )
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating divers item:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeditionsRouter.delete('/divers/items/:itemId', async (req: Request, res: Response) => {
  try {
    const itemId = parseInt(req.params.itemId, 10)
    if (isNaN(itemId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ligneId = await diversItemParentLigne(itemId)
    if (ligneId === 0) { res.status(404).json({ error: 'Item not found' }); return }
    const parent = await diversLineParent(ligneId)
    if (parent === 0) { res.status(404).json({ error: 'Line not found' }); return }
    if (await isLocked('divers', parent)) { res.status(409).json(FACTURE_LOCK); return }
    const rows = await query<any>(
      `SELECT quantite, IDref_divers, IDVariation1, IDVariation2 FROM ref_divers_expedie WHERE IDref_divers_expedie = ${itemId}`,
    )
    await query(`DELETE FROM ref_divers_expedie WHERE IDref_divers_expedie = ${itemId}`)
    if (rows[0]) {
      await adjustDiversStock(
        Number(rows[0].IDref_divers) || 0, Number(rows[0].IDVariation1) || 0, Number(rows[0].IDVariation2) || 0,
        r4(rows[0].quantite),
      )
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting divers item:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Divers lookups: ref catalog / variations / price ──

/** Accented identifiers come back truncated on the Linux bridge (archivé →
 *  archiv) and verbatim on Windows — resolve by prefix regex, never by name. */
function pickKey(row: Record<string, unknown>, re: RegExp): unknown {
  const k = Object.keys(row).find((key) => re.test(key))
  return k === undefined ? undefined : row[k]
}

expeditionsRouter.get('/divers/lookups/refs', async (_req: Request, res: Response) => {
  try {
    // SELECT * on purpose — `archivé` is accented and must never be named in SQL.
    const raw = await query<any>(`SELECT * FROM ref_divers`)
    const fixed = await repairAliased(raw, 'ref_divers', 'IDref_divers', { designation: 'designation' })
    const refs = (fixed as any[])
      .map((r) => ({
        IDref_divers: Number(r.IDref_divers) || 0,
        designation: (r.designation ?? '').toString(),
        prix_unitaire: r4(r.prix_unitaire),
        unite: Number(r.unite) || 0,
        unite_label: uniteLabel(r.unite),
        archive: Number(pickKey(r, /^archiv/i)) ? 1 : 0,
        sTypeVariation1: (r.sTypeVariation1 ?? 'Aucun').toString(),
        sTypeVariation2: (r.sTypeVariation2 ?? 'Aucun').toString(),
      }))
      .sort((a, b) => a.designation.localeCompare(b.designation, 'fr'))
    res.json(refs)
  } catch (err) {
    console.error('Error fetching ref_divers lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeditionsRouter.get('/divers/lookups/refs/:refId/variations', async (req: Request, res: Response) => {
  try {
    const refId = parseInt(req.params.refId, 10)
    if (isNaN(refId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const raw = await query<any>(
      `SELECT IDref_divers_variation, designation, niveau, prix, unite FROM ref_divers_variation WHERE IDref_divers = ${refId}`,
    )
    const fixed = await repairAliased(raw, 'ref_divers_variation', 'IDref_divers_variation', { designation: 'designation' })
    // niveau 1 ↔ sTypeVariation1, niveau 2 ↔ sTypeVariation2 (verified: every
    // IDVariation1 in ref_divers_expedie is niveau 1, every IDVariation2 niveau 2;
    // niveau 0 = pre-axis legacy rows, exposed on axis 1).
    const vars = (fixed as any[])
      .map((v) => ({
        IDref_divers_variation: Number(v.IDref_divers_variation) || 0,
        designation: (v.designation ?? '').toString(),
        niveau: Number(v.niveau) || 0,
        prix: r4(v.prix),
      }))
      .sort((a, b) => a.designation.localeCompare(b.designation, 'fr'))
    res.json(vars)
  } catch (err) {
    console.error('Error fetching ref_divers variations:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeditionsRouter.get('/divers/lookups/prix', async (req: Request, res: Response) => {
  try {
    const refId = parseInt(String(req.query.ref ?? ''), 10)
    if (isNaN(refId) || refId <= 0) { res.status(400).json({ error: 'Invalid ref' }); return }
    const v1 = parseInt(String(req.query.v1 ?? '0'), 10) || 0
    const v2 = parseInt(String(req.query.v2 ?? '0'), 10) || 0
    res.json({ prix: await resolveDiversPrix(refId, v1, v2) })
  } catch (err) {
    console.error('Error resolving divers price:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  PDF — Avis d'expédition (formelle only)
// ════════════════════════════════════════════════════════

const FRENCH_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

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

// Legacy gtaFinition enum (WinDev project globals) — printed under the
// article identity block on the avis d'expédition.
const FINITION_LABELS: Record<number, string> = {
  1: 'OUVERT AU LARGE',
  2: "TUBULAIRE AVEC MAILLE D'OUVERTURE",
  3: "TUBULAIRE SANS MAILLE D'OUVERTURE",
}

/** Group shipped pieces (already ORDER BY lot, numero) into per-lot buckets —
 *  Map preserves the SQL lot ordering. Pieces are re-sorted naturally in JS:
 *  numero is a string column, so SQL sorts "3386/100" before "3386/87". */
const pieceCollator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })
function groupByLot(rows: any[]): BlLot[] {
  const byLot = new Map<string, BlPiece[]>()
  for (const p of rows) {
    const lot = (p.lot ?? '').toString().trim()
    const arr = byLot.get(lot) ?? []
    arr.push({
      numero: (p.numero ?? '').toString().trim(),
      poids: Number(p.poids) || 0,
      metrage: Number(p.metrage) || 0,
      observations: p.observations != null ? String(p.observations) : null,
    })
    byLot.set(lot, arr)
  }
  return Array.from(byLot, ([lot, pieces]) => ({
    lot,
    pieces: pieces.sort((a, b) => pieceCollator.compare(a.numero, b.numero)),
  }))
}

export async function buildBlPdfData(id: number): Promise<BonLivraisonPdfData | null> {
  const rows = await query<any>(
    `SELECT IDexpedition, IDcommande_client, IDadresse, IDtransporteur, IDcontact, DATE AS dexp, ` +
      `affiche_observations, donation, observation_bl ` +
      `FROM expedition WHERE IDexpedition = ${id} AND IDsociete = 1`,
  )
  if (rows.length === 0) return null
  const h = rows[0]
  const cmdId = Number(h.IDcommande_client) || 0

  const cmdRows = cmdId > 0
    ? await query<any>(`SELECT IDcommande_client, numero, IDclient, ref_client FROM commande_client WHERE IDcommande_client = ${cmdId}`)
    : []
  const cmd = (await fixEncoding(cmdRows, 'commande_client', 'IDcommande_client', ['ref_client']))[0] as any
  const IDclient = Number(cmd?.IDclient) || 0

  const [clientNames, transNames, adr, contactNom, leRows] = await Promise.all([
    resolveClientNames([IDclient]),
    resolveTransporteurNames([Number(h.IDtransporteur)]),
    loadAdresse(Number(h.IDadresse) || 0),
    loadContactName(Number(h.IDcontact) || 0),
    query<any>(`SELECT IDligne_expedition, IDligne_commande_client FROM ligne_expedition WHERE IDexpedition = ${id} ORDER BY IDligne_expedition`),
  ])

  const articles: BlArticle[] = []
  for (const le of leRows as any[]) {
    const leId = Number(le.IDligne_expedition) || 0
    const lccId = Number(le.IDligne_commande_client) || 0
    if (leId === 0 || lccId === 0) continue
    const lccRows = await query<any>(
      `SELECT IDligne_commande_client, IDdesignation_client, TYPE AS type_kind, IDreference, IDcolori ` +
        `FROM ligne_commande_client WHERE IDligne_commande_client = ${lccId}`,
    )
    if (lccRows.length === 0) continue
    const lcc = lccRows[0]
    const kind = lineStockKind(Number(lcc.type_kind) || 0)
    if (kind === 'none') continue
    const refId = Number(lcc.IDreference) || 0
    const colId = Number(lcc.IDcolori) || 0
    const desigId = Number(lcc.IDdesignation_client) || 0

    // Client-side article reference ("V/réf. : 227A").
    let refClientArticle: string | null = null
    if (desigId > 0) {
      const dcRows = await query<any>(`SELECT IDdesignation_client, designation FROM designation_client WHERE IDdesignation_client = ${desigId}`)
      const dc = (await fixEncoding(dcRows, 'designation_client', 'IDdesignation_client', ['designation']))[0] as any
      refClientArticle = (dc?.designation ?? '').toString().trim() || null
    }

    let reference = ''
    let designation = ''
    let finition: string | null = null
    let coloris = ''
    let piecesRaw: any[] = []

    if (kind === 'fini') {
      const rfRows = refId > 0
        ? await query<any>(`SELECT IDref_fini, reference, designation, finition, avec_teinture FROM ref_fini WHERE IDref_fini = ${refId}`)
        : []
      const rf = (await fixEncoding(rfRows, 'ref_fini', 'IDref_fini', ['reference', 'designation']))[0] as any
      reference = (rf?.reference ?? '').toString().trim()
      designation = (rf?.designation ?? '').toString().trim()
      const avec = Number(rf?.avec_teinture) || 0
      let colFinition = 0
      if (colId > 0) {
        if (avec === 0) {
          // Wash-only fini → coloris lives in the écru catalog (avec_teinture rule).
          const cRows = await query<any>(`SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru = ${colId}`)
          const c = (await fixEncoding(cRows, 'colori_ecru', 'IDcolori_ecru', ['reference']))[0] as any
          coloris = (c?.reference ?? '').toString().trim()
        } else {
          const cRows = await query<any>(`SELECT IDref_fini_colori, reference, finition FROM ref_fini_colori WHERE IDref_fini_colori = ${colId}`)
          const c = (await fixEncoding(cRows, 'ref_fini_colori', 'IDref_fini_colori', ['reference']))[0] as any
          coloris = (c?.reference ?? '').toString().trim()
          colFinition = Number(c?.finition) || 0
        }
      }
      finition = FINITION_LABELS[colFinition || Number(rf?.finition) || 0] ?? null
      const rollRows = await query<any>(
        `SELECT IDstock_fini, numero, lot, poids, metrage, observations FROM stock_fini WHERE IDligne_expedition = ${leId} ORDER BY lot, numero`,
      )
      piecesRaw = await fixEncoding(rollRows, 'stock_fini', 'IDstock_fini', ['numero', 'lot', 'observations'])
    } else {
      // écru (tombé de métier)
      const reRows = refId > 0
        ? await query<any>(`SELECT IDref_ecru, reference, designation FROM ref_ecru WHERE IDref_ecru = ${refId}`)
        : []
      const re = (await fixEncoding(reRows, 'ref_ecru', 'IDref_ecru', ['reference', 'designation']))[0] as any
      reference = (re?.reference ?? '').toString().trim()
      designation = (re?.designation ?? '').toString().trim()
      if (colId > 0) {
        const cRows = await query<any>(`SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru = ${colId}`)
        const c = (await fixEncoding(cRows, 'colori_ecru', 'IDcolori_ecru', ['reference']))[0] as any
        coloris = (c?.reference ?? '').toString().trim()
      }
      const rollRows = await query<any>(
        `SELECT IDstock_ecru, numero, lot, poids, metrage, observations FROM stock_ecru WHERE IDligne_expedition_ETM = ${leId} ORDER BY lot, numero`,
      )
      piecesRaw = await fixEncoding(rollRows, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot', 'observations'])
    }

    const lots = groupByLot(piecesRaw)
    if (lots.length === 0) continue
    const titre = [reference, coloris].filter(Boolean).join(' - ') || `Ligne ${lccId}`
    const sousTitre = designation ? [designation, coloris].filter(Boolean).join(' - ') : null
    articles.push({ titre, sousTitre, finition, refClientArticle, lots })
  }

  const a = adr as any
  return {
    numero: id,
    dateLong: formatHfsqlDateLongFr(h.dexp),
    clientNom: clientNames.get(IDclient) ?? '',
    // Legacy ref_client can embed CR/LF — collapse to plain spaces so the
    // metadata card wraps naturally instead of showing blank gaps.
    refClient: (cmd?.ref_client ?? '').toString().replace(/\s+/g, ' ').trim() || null,
    commandeNumero: cmd?.numero != null ? Number(cmd.numero) : null,
    transporteurNom: transNames.get(Number(h.IDtransporteur)) || null,
    contactNom,
    donation: Number(h.donation) === 1,
    showObservations: Number(h.affiche_observations) === 1,
    observationBl: stripRtf(h.observation_bl) || null,
    adresseLivraison: a
      ? {
          nom: (a.nom ?? null) as string | null,
          adresse1: (a.adresse1 ?? null) as string | null,
          adresse2: (a.adresse2 ?? null) as string | null,
          adresse3: (a.adresse3 ?? null) as string | null,
          cp: (a.cp ?? null) as string | null,
          ville: (a.ville ?? null) as string | null,
          pays: (a.pays ?? null) as string | null,
        }
      : null,
    articles,
  }
}

async function renderBlPdfBuffer(data: BonLivraisonPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(BonLivraisonPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

expeditionsRouter.get('/formelle/:id/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const data = await buildBlPdfData(id)
    if (!data) { res.status(404).json({ error: 'Expédition not found' }); return }
    const buffer = await renderBlPdfBuffer(data)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="BL-${id}.pdf"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering expedition PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  RAPPORT DE CONTRÔLE + INFO MATIÈRES (formelle only)
// ════════════════════════════════════════════════════════
// Two extra documents that can accompany a formelle expedition (ports of the
// legacy ETAT_RapportQualité / ETAT_Info_Matiere reports). Both start from the
// expedition's FINI lines only — écru lines have no QC data or dyeing chain.
// HFSQL traps honored here (see probe-rc-info-matieres.ts):
//  - suivilot is read `SELECT *` (accented spec columns must never be named);
//    only ASCII keys are consumed (lot, *_tirelle, IDsous_traitant, …).
//  - stock_fil: `SELECT *` AND any list containing certif_bio silently return
//    0 rows on Windows — explicit ASCII list without the certif block.
//  - stock_ecru.IDref_commande_source = the tricoteur line that produced the
//    roll (type 1); IDref_commande_affectation is the ennoblisseur line.
//  - Transport docs: ged IDtype_doc 3 (bl retour ennoblisseur, on the
//    suivilot's commande), 4 (bl retour tricoteur), 6 (bl fournisseur,
//    IDreference = IDcommande_fil).

const trimStr = (v: unknown): string => (v ?? '').toString().trim()
/** HFSQL "unset" numeric → null (tolerance columns keep 0 when never filled). */
const zeroNull = (v: unknown): number | null => {
  const x = Number(v)
  return Number.isFinite(x) && x !== 0 ? x : null
}

/** Coloris display label for a fini line — catalog depends on avec_teinture
 *  (0 = wash-only → colori_ecru, 1/2 = dyed → ref_fini_colori). */
async function resolveFiniColorisLabel(avecTeinture: number, colId: number): Promise<string> {
  if (colId <= 0) return ''
  if (avecTeinture === 0) {
    const cRows = await query<any>(`SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru = ${colId}`)
    const c = (await fixEncoding(cRows, 'colori_ecru', 'IDcolori_ecru', ['reference']))[0] as any
    return trimStr(c?.reference)
  }
  const cRows = await query<any>(`SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori = ${colId}`)
  const c = (await fixEncoding(cRows, 'ref_fini_colori', 'IDref_fini_colori', ['reference']))[0] as any
  return trimStr(c?.reference)
}

interface FiniLineCtx {
  leId: number
  refId: number
  titre: string
  sousTitre: string | null
  /** ref_fini row with the tolerance columns (laizeHT/poids min-max, stab). */
  refFini: any | null
}

interface FormelleFiniCtx {
  dexp: string | null
  commandeNumero: number | null
  refClient: string | null
  clientNom: string
  lines: FiniLineCtx[]
}

/** Shared header + fini-lines context for the RC / Info matières builders.
 *  Returns null when the expedition doesn't exist; lines may be empty. */
async function loadFormelleFiniLines(id: number): Promise<FormelleFiniCtx | null> {
  const rows = await query<any>(
    `SELECT IDexpedition, IDcommande_client, DATE AS dexp FROM expedition WHERE IDexpedition = ${id} AND IDsociete = 1`,
  )
  if (rows.length === 0) return null
  const h = rows[0]
  const cmdId = Number(h.IDcommande_client) || 0
  const cmdRows = cmdId > 0
    ? await query<any>(`SELECT IDcommande_client, numero, IDclient, ref_client FROM commande_client WHERE IDcommande_client = ${cmdId}`)
    : []
  const cmd = (await fixEncoding(cmdRows, 'commande_client', 'IDcommande_client', ['ref_client']))[0] as any
  const IDclient = Number(cmd?.IDclient) || 0
  const clientNames = await resolveClientNames([IDclient])

  const leRows = await query<any>(
    `SELECT IDligne_expedition, IDligne_commande_client FROM ligne_expedition WHERE IDexpedition = ${id} ORDER BY IDligne_expedition`,
  )
  const lines: FiniLineCtx[] = []
  for (const le of leRows as any[]) {
    const leId = Number(le.IDligne_expedition) || 0
    const lccId = Number(le.IDligne_commande_client) || 0
    if (leId === 0 || lccId === 0) continue
    const lccRows = await query<any>(
      `SELECT IDligne_commande_client, TYPE AS type_kind, IDreference, IDcolori FROM ligne_commande_client WHERE IDligne_commande_client = ${lccId}`,
    )
    if (lccRows.length === 0) continue
    const lcc = lccRows[0]
    if (lineStockKind(Number(lcc.type_kind) || 0) !== 'fini') continue
    const refId = Number(lcc.IDreference) || 0
    const colId = Number(lcc.IDcolori) || 0
    const rfRows = refId > 0
      ? await query<any>(
          `SELECT IDref_fini, reference, designation, avec_teinture, laizeHT_Min, laizeHT_Max, ` +
            `poids_Min, poids_Max, stab_hauteur, stab_largeur FROM ref_fini WHERE IDref_fini = ${refId}`,
        )
      : []
    const rf = (await fixEncoding(rfRows, 'ref_fini', 'IDref_fini', ['reference', 'designation']))[0] as any
    const coloris = await resolveFiniColorisLabel(Number(rf?.avec_teinture) || 0, colId)
    const titre = [trimStr(rf?.reference), coloris].filter(Boolean).join(' - ') || `Ligne ${lccId}`
    lines.push({ leId, refId, titre, sousTitre: trimStr(rf?.designation) || null, refFini: rf ?? null })
  }
  return {
    dexp: h.dexp ?? null,
    commandeNumero: cmd?.numero != null ? Number(cmd.numero) : null,
    refClient: trimStr(cmd?.ref_client).replace(/\s+/g, ' ') || null,
    clientNom: clientNames.get(IDclient) ?? '',
    lines,
  }
}

/** Prefer the suivilot row that carries operator data — measurements can be
 *  negative (stab), so check "any non-zero" plus the free-text columns. */
function suivilotRowHasData(row: Record<string, unknown>): boolean {
  const numCols = [
    'laize_sst', 'poids_sst', 'rendement_sst', 'stabH_sst', 'stabL_sst',
    'laize_tirelle', 'poids_tirelle', 'rendement_tirelle', 'stabH_tirelle', 'stabL_tirelle',
  ]
  if (numCols.some((c) => Number(row[c]) !== 0 && Number.isFinite(Number(row[c])))) return true
  const textCols = ['observations', 'emplacement_tirelle', 'fin_archivage']
  return textCols.some((c) => (row[c] ?? '').toString().replace(/\0/g, '').trim() !== '')
}

/** Distinct shipped lots of a fini line, plus the best suivilot row per lot. */
async function loadLineLotsWithSuivilot(leId: number, refId: number): Promise<{
  lots: string[]
  suiviByLot: Map<string, any>
  rolls: any[]
}> {
  const rollRows = await query<any>(
    `SELECT IDstock_fini, lot, IDstock_ecru FROM stock_fini WHERE IDligne_expedition = ${leId} ORDER BY lot, numero`,
  )
  const rolls = await fixEncoding(rollRows, 'stock_fini', 'IDstock_fini', ['lot'])
  const lots = [...new Set((rolls as any[]).map((r) => trimStr(r.lot)).filter(Boolean))]
  const suiviByLot = new Map<string, any>()
  if (lots.length > 0 && refId > 0) {
    const suiviRows = await query<any>(
      `SELECT * FROM suivilot WHERE IDref_fini = ${refId} AND lot IN (${lots.map((l) => `'${esc(l)}'`).join(',')})`,
    )
    for (const s of suiviRows as any[]) {
      const key = trimStr(s.lot)
      const prev = suiviByLot.get(key)
      if (!prev || (!suivilotRowHasData(prev) && suivilotRowHasData(s))) suiviByLot.set(key, s)
    }
  }
  return { lots, suiviByLot, rolls: rolls as any[] }
}

export async function buildRapportControlePdfData(id: number): Promise<RapportControlePdfData | null> {
  const ctx = await loadFormelleFiniLines(id)
  if (!ctx || ctx.lines.length === 0) return null

  const articles: RcArticle[] = []
  for (const line of ctx.lines) {
    const { lots, suiviByLot } = await loadLineLotsWithSuivilot(line.leId, line.refId)
    const rf = line.refFini ?? {}
    // A line whose rolls carry no lot label still prints its tolerance rows.
    const lotKeys = lots.length > 0 ? lots : ['']
    const lotBlocks: RcLot[] = lotKeys.map((lot) => {
      const s = suiviByLot.get(lot) ?? null
      const rel = (col: string): number | null => (s ? numOf(s[col]) : null)
      const rows: RcRow[] = [
        { parametre: 'Laize HT', min: zeroNull(rf.laizeHT_Min), max: zeroNull(rf.laizeHT_Max), releve: rel('laize_tirelle') },
        { parametre: 'Poids', min: zeroNull(rf.poids_Min), max: zeroNull(rf.poids_Max), releve: rel('poids_tirelle') },
        { parametre: 'Stab H', min: zeroNull(rf.stab_hauteur), max: null, releve: rel('stabH_tirelle') },
        { parametre: 'Stab L', min: zeroNull(rf.stab_largeur), max: null, releve: rel('stabL_tirelle') },
      ]
      return { lot, hasSuivilot: s != null, rows }
    })
    articles.push({ titre: line.titre, sousTitre: line.sousTitre, lots: lotBlocks })
  }
  if (articles.length === 0) return null

  return {
    numero: id,
    dateLong: formatHfsqlDateLongFr(ctx.dexp),
    clientNom: ctx.clientNom,
    commandeNumero: ctx.commandeNumero,
    refClient: ctx.refClient,
    articles,
  }
}

/** sous_traitant / fournisseur names + pays, batched with encoding repair. */
async function loadPartnerLookups(sstIds: number[], frsIds: number[]): Promise<{
  sstNames: Map<number, string>
  sstPays: Map<number, string>
  frsNames: Map<number, string>
  frsPays: Map<number, string>
}> {
  const sstNames = new Map<number, string>()
  const sstPays = new Map<number, string>()
  const frsNames = new Map<number, string>()
  const frsPays = new Map<number, string>()
  if (sstIds.length > 0) {
    const rows = await fixEncoding(
      await query<any>(`SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${sstIds.join(',')})`),
      'sous_traitant', 'IDsous_traitant', ['nom'],
    )
    for (const r of rows as any[]) sstNames.set(Number(r.IDsous_traitant), trimStr(r.nom))
    const adr = await fixEncoding(
      await query<any>(`SELECT IDadresse, IDsous_traitant, pays FROM adresse WHERE IDsous_traitant IN (${sstIds.join(',')})`),
      'adresse', 'IDadresse', ['pays'],
    )
    for (const r of adr as any[]) {
      const k = Number(r.IDsous_traitant)
      if (!sstPays.has(k) && trimStr(r.pays)) sstPays.set(k, trimStr(r.pays))
    }
  }
  if (frsIds.length > 0) {
    const rows = await fixEncoding(
      await query<any>(`SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur IN (${frsIds.join(',')})`),
      'fournisseur', 'IDfournisseur', ['nom'],
    )
    for (const r of rows as any[]) frsNames.set(Number(r.IDfournisseur), trimStr(r.nom))
    const adr = await fixEncoding(
      await query<any>(`SELECT IDadresse, IDfournisseur, pays FROM adresse WHERE IDfournisseur IN (${frsIds.join(',')})`),
      'adresse', 'IDadresse', ['pays'],
    )
    for (const r of adr as any[]) {
      const k = Number(r.IDfournisseur)
      if (!frsPays.has(k) && trimStr(r.pays)) frsPays.set(k, trimStr(r.pays))
    }
  }
  return { sstNames, sstPays, frsNames, frsPays }
}

/** ged transport docs for a set of sst commandes, one type_doc at a time. */
async function loadGedDocs(cmdIds: number[], typeDoc: number): Promise<Map<number, string[]>> {
  const byCmd = new Map<number, string[]>()
  if (cmdIds.length === 0) return byCmd
  const rows = await fixEncoding(
    await query<any>(
      `SELECT IDged, nom, IDcommande_sous_traitant FROM ged WHERE IDcommande_sous_traitant IN (${cmdIds.join(',')}) AND IDtype_doc = ${typeDoc}`,
    ),
    'ged', 'IDged', ['nom'],
  )
  for (const r of rows as any[]) {
    const k = Number(r.IDcommande_sous_traitant)
    const nom = trimStr(r.nom)
    if (!nom) continue
    const list = byCmd.get(k) ?? []
    list.push(nom)
    byCmd.set(k, list)
  }
  return byCmd
}

export async function buildInfoMatieresPdfData(id: number): Promise<InfoMatieresPdfData | null> {
  const ctx = await loadFormelleFiniLines(id)
  if (!ctx || ctx.lines.length === 0) return null

  const articles: ImArticle[] = []
  for (const line of ctx.lines) {
    const { lots, suiviByLot, rolls } = await loadLineLotsWithSuivilot(line.leId, line.refId)

    // ── Tissu fini: one entry per (ennoblisseur, commande), lots grouped.
    interface EnnoGroup { sstId: number; cmdId: number; lots: string[] }
    const ennoGroups = new Map<string, EnnoGroup>()
    for (const lot of lots) {
      const s = suiviByLot.get(lot)
      if (!s) continue
      const sstId = Number(s.IDsous_traitant) || 0
      const cmdId = Number(s.IDcommande_sous_traitant) || 0
      if (sstId === 0) continue
      const key = `${sstId}:${cmdId}`
      const g = ennoGroups.get(key) ?? { sstId, cmdId, lots: [] }
      g.lots.push(lot)
      ennoGroups.set(key, g)
    }

    // ── Tombé de métier: écru provenance via IDref_commande_source (type 1).
    const ecruIds = [...new Set((rolls as any[]).map((r) => Number(r.IDstock_ecru) || 0).filter((x) => x > 0))]
    const ecruRows = ecruIds.length > 0
      ? await query<any>(
          `SELECT IDstock_ecru, IDref_ecru, IDordre_fabrication, IDref_commande_source FROM stock_ecru WHERE IDstock_ecru IN (${ecruIds.join(',')})`,
        )
      : []
    const srcLcsstIds = [...new Set((ecruRows as any[]).map((r) => Number(r.IDref_commande_source) || 0).filter((x) => x > 0))]
    const ofIds = [...new Set((ecruRows as any[]).map((r) => Number(r.IDordre_fabrication) || 0).filter((x) => x > 0))]
    const refEcruIds = [...new Set((ecruRows as any[]).map((r) => Number(r.IDref_ecru) || 0).filter((x) => x > 0))]

    const srcLines = srcLcsstIds.length > 0
      ? await query<any>(
          `SELECT IDligne_commande_sous_traitant, IDcommande_sous_traitant, TYPE AS type_kind ` +
            `FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant IN (${srcLcsstIds.join(',')})`,
        )
      : []
    const tricoLcsst = (srcLines as any[]).filter((l) => Number(l.type_kind) === 1)
    const tricoCmdIds = [...new Set(tricoLcsst.map((l) => Number(l.IDcommande_sous_traitant) || 0).filter((x) => x > 0))]
    const tricoCmds = tricoCmdIds.length > 0
      ? await query<any>(`SELECT IDcommande_sous_traitant, IDsous_traitant FROM commande_sous_traitant WHERE IDcommande_sous_traitant IN (${tricoCmdIds.join(',')})`)
      : []
    const refEcruRows = refEcruIds.length > 0
      ? await fixEncoding(
          await query<any>(`SELECT IDref_ecru, reference, designation FROM ref_ecru WHERE IDref_ecru IN (${refEcruIds.join(',')})`),
          'ref_ecru', 'IDref_ecru', ['reference', 'designation'],
        )
      : []
    const ecruLabel = new Map((refEcruRows as any[]).map((r) => [
      Number(r.IDref_ecru),
      [trimStr(r.reference), trimStr(r.designation)].filter(Boolean).join(' - '),
    ]))

    // ── Fil: OF → asso_fil_of → stock_fil (NO certif_bio!) → fournisseur.
    const assoRows = ofIds.length > 0
      ? await query<any>(`SELECT IDasso_fil_of, IDordre_fabrication, IDref_fil, IDstock_fil FROM asso_fil_of WHERE IDordre_fabrication IN (${ofIds.join(',')})`)
      : []
    const stockFilIds = [...new Set((assoRows as any[]).map((r) => Number(r.IDstock_fil) || 0).filter((x) => x > 0))]
    const stockFils = stockFilIds.length > 0
      ? await query<any>(
          `SELECT IDstock_fil, IDref_fil, IDfournisseur, IDref_fil_commande FROM stock_fil WHERE IDstock_fil IN (${stockFilIds.join(',')})`,
        )
      : []
    const sfById = new Map((stockFils as any[]).map((r) => [Number(r.IDstock_fil), r]))
    const refFilIds = [...new Set([
      ...(assoRows as any[]).map((r) => Number(r.IDref_fil) || 0),
      ...(stockFils as any[]).map((r) => Number(r.IDref_fil) || 0),
    ].filter((x) => x > 0))]

    const refFilRows = refFilIds.length > 0
      ? await fixEncoding(
          await query<any>(`SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${refFilIds.join(',')})`),
          'ref_fil', 'IDref_fil', ['reference'],
        )
      : []
    const refFilLabel = new Map((refFilRows as any[]).map((r) => [Number(r.IDref_fil), trimStr(r.reference)]))

    // Certifications: ref_fil_certif M:N → certificat.nom (deduped labels).
    const rfcRows = refFilIds.length > 0
      ? await query<any>(`SELECT IDref_fil_certif, IDref_fil, IDcertificat FROM ref_fil_certif WHERE IDref_fil IN (${refFilIds.join(',')})`)
      : []
    const certIds = [...new Set((rfcRows as any[]).map((r) => Number(r.IDcertificat) || 0).filter((x) => x > 0))]
    const certRows = certIds.length > 0
      ? await fixEncoding(
          await query<any>(`SELECT IDcertificat, nom FROM certificat WHERE IDcertificat IN (${certIds.join(',')})`),
          'certificat', 'IDcertificat', ['nom'],
        )
      : []
    const certName = new Map((certRows as any[]).map((r) => [Number(r.IDcertificat), trimStr(r.nom)]))
    const certsByRefFil = new Map<number, string[]>()
    for (const r of rfcRows as any[]) {
      const k = Number(r.IDref_fil)
      const nom = certName.get(Number(r.IDcertificat)) ?? ''
      if (!nom) continue
      const list = certsByRefFil.get(k) ?? []
      if (!list.includes(nom)) list.push(nom)
      certsByRefFil.set(k, list)
    }

    // Yarn origin country (origine_matiere has accented PK columns → SELECT *,
    // read only the ASCII keys pays/IDref_fil/IDfournisseur).
    const origRows = refFilIds.length > 0
      ? await query<any>(`SELECT * FROM origine_matiere WHERE IDref_fil IN (${refFilIds.join(',')})`)
      : []
    const origPays = new Map<number, string>()
    for (const r of origRows as any[]) {
      const k = Number(r.IDref_fil) || 0
      if (k > 0 && !origPays.has(k) && trimStr(r.pays)) origPays.set(k, trimStr(r.pays))
    }

    // Fil transport docs: stock_fil → ref_fil_commande → ged type 6 on IDcommande_fil.
    const rfCmdLineIds = [...new Set((stockFils as any[]).map((r) => Number(r.IDref_fil_commande) || 0).filter((x) => x > 0))]
    const rfCmdRows = rfCmdLineIds.length > 0
      ? await query<any>(`SELECT IDref_fil_commande, IDcommande_fil FROM ref_fil_commande WHERE IDref_fil_commande IN (${rfCmdLineIds.join(',')})`)
      : []
    const cmdFilByLine = new Map((rfCmdRows as any[]).map((r) => [Number(r.IDref_fil_commande), Number(r.IDcommande_fil) || 0]))
    const cmdFilIds = [...new Set([...cmdFilByLine.values()].filter((x) => x > 0))]
    const filGedRows = cmdFilIds.length > 0
      ? await fixEncoding(
          await query<any>(`SELECT IDged, nom, IDreference FROM ged WHERE IDreference IN (${cmdFilIds.join(',')}) AND IDtype_doc = 6`),
          'ged', 'IDged', ['nom'],
        )
      : []
    const filDocsByCmd = new Map<number, string[]>()
    for (const r of filGedRows as any[]) {
      const k = Number(r.IDreference)
      const nom = trimStr(r.nom)
      if (!nom) continue
      const list = filDocsByCmd.get(k) ?? []
      list.push(nom)
      filDocsByCmd.set(k, list)
    }

    // Batched partner lookups (names + pays) for every partner in this article.
    const tricoSstByCmd = new Map((tricoCmds as any[]).map((r) => [Number(r.IDcommande_sous_traitant), Number(r.IDsous_traitant) || 0]))
    const allSstIds = [...new Set([
      ...[...ennoGroups.values()].map((g) => g.sstId),
      ...[...tricoSstByCmd.values()],
    ].filter((x) => x > 0))]
    const allFrsIds = [...new Set((stockFils as any[]).map((r) => Number(r.IDfournisseur) || 0).filter((x) => x > 0))]
    const { sstNames, sstPays, frsNames, frsPays } = await loadPartnerLookups(allSstIds, allFrsIds)
    const [ennoDocs, tricoDocs] = await Promise.all([
      loadGedDocs([...new Set([...ennoGroups.values()].map((g) => g.cmdId).filter((x) => x > 0))], 3),
      loadGedDocs(tricoCmdIds, 4),
    ])

    // ── Assemble the article's entries ──
    const tissuFini: ImEntry[] = [...ennoGroups.values()].map((g) => {
      const docs = ennoDocs.get(g.cmdId) ?? []
      // Prefer docs whose filename matches one of the entry's lots (an sst
      // commande can carry docs for lots shipped elsewhere).
      const matching = docs.filter((d) => g.lots.some((lot) => lot && d.toLowerCase().includes(lot.toLowerCase())))
      return {
        titre: g.lots.length > 0 ? `Lot ${g.lots.join(', ')}` : null,
        nom: sstNames.get(g.sstId) ?? `Sous-traitant ${g.sstId}`,
        pays: sstPays.get(g.sstId) ?? null,
        transportDocs: matching.length > 0 ? matching : docs,
      }
    })

    interface TricoGroup { sstId: number; refEcruId: number; cmdIds: Set<number> }
    const tricoGroups = new Map<string, TricoGroup>()
    for (const e of ecruRows as any[]) {
      const srcId = Number(e.IDref_commande_source) || 0
      const lcsst = tricoLcsst.find((l) => Number(l.IDligne_commande_sous_traitant) === srcId)
      if (!lcsst) continue
      const cmdId = Number(lcsst.IDcommande_sous_traitant) || 0
      const sstId = tricoSstByCmd.get(cmdId) ?? 0
      if (sstId === 0) continue
      const refEcruId = Number(e.IDref_ecru) || 0
      const key = `${sstId}:${refEcruId}`
      const g = tricoGroups.get(key) ?? { sstId, refEcruId, cmdIds: new Set<number>() }
      if (cmdId > 0) g.cmdIds.add(cmdId)
      tricoGroups.set(key, g)
    }
    const tombeMetier: ImEntry[] = [...tricoGroups.values()].map((g) => ({
      titre: ecruLabel.get(g.refEcruId) || null,
      nom: sstNames.get(g.sstId) ?? `Sous-traitant ${g.sstId}`,
      pays: sstPays.get(g.sstId) ?? null,
      transportDocs: [...g.cmdIds].flatMap((c) => tricoDocs.get(c) ?? []),
    }))

    interface FilGroup { refFilId: number; frsId: number; cmdFilIds: Set<number> }
    const filGroups = new Map<string, FilGroup>()
    for (const a of assoRows as any[]) {
      const sf = sfById.get(Number(a.IDstock_fil) || 0)
      const refFilId = Number(a.IDref_fil) || Number(sf?.IDref_fil) || 0
      if (refFilId === 0) continue
      const frsId = Number(sf?.IDfournisseur) || 0
      const key = `${refFilId}:${frsId}`
      const g = filGroups.get(key) ?? { refFilId, frsId, cmdFilIds: new Set<number>() }
      const cmdFil = cmdFilByLine.get(Number(sf?.IDref_fil_commande) || 0) ?? 0
      if (cmdFil > 0) g.cmdFilIds.add(cmdFil)
      filGroups.set(key, g)
    }
    const fils: ImEntry[] = [...filGroups.values()].map((g) => ({
      titre: refFilLabel.get(g.refFilId) || null,
      nom: g.frsId > 0 ? frsNames.get(g.frsId) ?? `Fournisseur ${g.frsId}` : '—',
      pays: origPays.get(g.refFilId) ?? (g.frsId > 0 ? frsPays.get(g.frsId) ?? null : null),
      certifications: certsByRefFil.get(g.refFilId) ?? [],
      transportDocs: [...g.cmdFilIds].flatMap((c) => filDocsByCmd.get(c) ?? []),
    }))

    articles.push({ titre: line.titre, sousTitre: line.sousTitre, tissuFini, tombeMetier, fils })
  }
  if (articles.length === 0) return null

  return {
    numero: id,
    dateLong: formatHfsqlDateLongFr(ctx.dexp),
    clientNom: ctx.clientNom,
    articles,
  }
}

async function renderRapportControleBuffer(data: RapportControlePdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(RapportControlePdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

async function renderInfoMatieresBuffer(data: InfoMatieresPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(InfoMatieresPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

expeditionsRouter.get('/formelle/:id/rapport-controle/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const data = await buildRapportControlePdfData(id)
    if (!data) { res.status(404).json({ error: 'Rapport de contrôle indisponible pour cette expédition.' }); return }
    const buffer = await renderRapportControleBuffer(data)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="RC-${id}.pdf"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering rapport de contrôle PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeditionsRouter.get('/formelle/:id/info-matieres/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const data = await buildInfoMatieresPdfData(id)
    if (!data) { res.status(404).json({ error: 'Info matières indisponible pour cette expédition.' }); return }
    const buffer = await renderInfoMatieresBuffer(data)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="Info-matieres-${id}.pdf"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering info matières PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  DEMANDE DE TRANSPORT (formelle only)
// ════════════════════════════════════════════════════════
// Port of the legacy "Demande_transport_<id>" sheet: the pickup request sent
// to a carrier. Internal-process document — printed/faxed, never emailed by
// the app, so there is no email-defaults counterpart.
//
// Pickup is always ETS Malterre (the legacy sheet hardcodes the factory as
// the pickup point, even when rolls physically sit at a sous-traitant), and
// the delivery block is the expedition's own adresse — same one the BL uses.

/** "Prénom - Ets Malterre" for the acting user (legacy sender line). */
async function loadExpediteurLabel(userId: number | undefined): Promise<string> {
  const fallback = 'Ets Malterre'
  if (userId === undefined) return fallback
  try {
    // IDutilisateur must be selected — fixEncoding keys its repair on it.
    const rows = await query<Record<string, unknown>>(
      `SELECT IDutilisateur, prenom, nom FROM utilisateur WHERE IDutilisateur = ${userId}`,
    )
    const fixed = await fixEncoding(rows, 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
    const prenom = (fixed[0]?.prenom ?? '').toString().trim()
    return prenom ? `${prenom} - Ets Malterre` : fallback
  } catch {
    return fallback
  }
}

/** Total shipped weight + roll count across every line of the expedition. */
async function loadExpeditionRollTotals(ligneIds: number[]): Promise<{ poids: number; nb: number }> {
  const ids = Array.from(new Set(ligneIds.filter((x) => x > 0)))
  if (ids.length === 0) return { poids: 0, nb: 0 }
  const inLe = ids.join(',')
  const [fini, ecru] = await Promise.all([
    query<{ poids: unknown }>(`SELECT IDstock_fini, poids FROM stock_fini WHERE IDligne_expedition IN (${inLe})`),
    query<{ poids: unknown }>(`SELECT IDstock_ecru, poids FROM stock_ecru WHERE IDligne_expedition_ETM IN (${inLe})`),
  ])
  const rolls = [...fini, ...ecru]
  return { poids: rolls.reduce((s, r) => s + numOf(r.poids), 0), nb: rolls.length }
}

/** Build failure the caller turns into an HTTP status + French message. */
type TransportBuildError = { status: number; error: string; message: string }

/** Data for ONE pickup request covering `ids` (one expedition, or a grouped
 *  selection — legacy's right-click "Transport" on a multi-row selection).
 *
 *  Grouping rules, ported from the legacy screen + what the sheet can express:
 *   - every expedition must belong to the SAME client (legacy refuses the
 *     selection otherwise: "Toutes les lignes sélectionnées ne sont pas liées
 *     au même client"),
 *   - the sheet has exactly one "Pour livraison chez" block, so the delivery
 *     addresses must agree too. Expeditions with no address set (IDadresse = 0)
 *     don't count as a disagreement — they just inherit the one that is set,
 *   - the carrier is only printed when all of them name the same one; otherwise
 *     the Destinataire block stays blank for the operator to fill in (it is a
 *     fill-in field on the legacy sheet anyway),
 *   - rolls are CUMULATED: the weight/count line is the total across every
 *     line of every selected expedition. */
export async function buildDemandeTransportPdfData(
  ids: number[],
  userId: number | undefined,
): Promise<{ data: DemandeTransportPdfData } | { err: TransportBuildError }> {
  const wanted = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)))
  if (wanted.length === 0) return { err: { status: 400, error: 'Invalid ID', message: 'Aucune expédition sélectionnée.' } }

  const heads = await query<any>(
    `SELECT IDexpedition, IDcommande_client, IDadresse, IDtransporteur, DATE AS dexp ` +
      `FROM expedition WHERE IDexpedition IN (${wanted.join(',')}) AND IDsociete = 1 ORDER BY IDexpedition`,
  )
  if (heads.length === 0) {
    return { err: { status: 404, error: 'Expédition not found', message: 'Expédition introuvable.' } }
  }
  const expIds = heads.map((h: any) => Number(h.IDexpedition))

  // Commandes → client. Distinct clients = the legacy refusal.
  const cmdIds = Array.from(new Set(heads.map((h: any) => Number(h.IDcommande_client) || 0).filter((x: number) => x > 0)))
  const cmdRows = cmdIds.length > 0
    ? await query<any>(`SELECT IDcommande_client, numero, IDclient FROM commande_client WHERE IDcommande_client IN (${cmdIds.join(',')})`)
    : []
  const cmdMap = new Map<number, { numero: number | null; IDclient: number }>(
    cmdRows.map((c: any) => [Number(c.IDcommande_client), { numero: c.numero != null ? Number(c.numero) : null, IDclient: Number(c.IDclient) || 0 }]),
  )
  const clientIds = Array.from(new Set(heads.map((h: any) => cmdMap.get(Number(h.IDcommande_client) || 0)?.IDclient ?? 0)))
  if (clientIds.length > 1) {
    return {
      err: {
        status: 400,
        error: 'multiple_clients',
        message: 'Toutes les expéditions sélectionnées ne sont pas liées au même client.',
      },
    }
  }
  const IDclient = clientIds[0] ?? 0

  // One delivery block → one address. Unset (0) expeditions inherit.
  const adrIds = Array.from(new Set(heads.map((h: any) => Number(h.IDadresse) || 0).filter((x: number) => x > 0)))
  if (adrIds.length > 1) {
    return {
      err: {
        status: 400,
        error: 'multiple_adresses',
        message: 'Les expéditions sélectionnées n\'ont pas la même adresse de livraison.',
      },
    }
  }
  // Blank when the carriers disagree — it is a fill-in field on the sheet.
  const transIds = Array.from(new Set(heads.map((h: any) => Number(h.IDtransporteur) || 0).filter((x: number) => x > 0)))
  const IDtransporteur = transIds.length === 1 ? transIds[0] : 0

  const leRows = await query<any>(
    `SELECT IDligne_expedition FROM ligne_expedition WHERE IDexpedition IN (${expIds.join(',')})`,
  )
  const [clientNames, transNames, adr, totals, expediteur] = await Promise.all([
    resolveClientNames([IDclient]),
    resolveTransporteurNames([IDtransporteur]),
    loadAdresse(adrIds[0] ?? 0),
    loadExpeditionRollTotals((leRows as any[]).map((l) => Number(l.IDligne_expedition) || 0)),
    loadExpediteurLabel(userId),
  ])

  const now = new Date()
  const pad = (x: number) => String(x).padStart(2, '0')
  const dateCourte = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`
  const dateLong = `${now.getDate()} ${FRENCH_MONTHS[now.getMonth()]} ${now.getFullYear()}`

  const commandeNumeros = Array.from(
    new Set(
      heads
        .map((h: any) => cmdMap.get(Number(h.IDcommande_client) || 0)?.numero ?? null)
        .filter((x: number | null): x is number => x != null),
    ),
  ).sort((a, b) => a - b)

  const a = adr as any
  return {
    data: {
      numero: expIds[0],
      expeditionIds: expIds,
      dateLong,
      dateCourte,
      expediteur,
      transporteurNom: transNames.get(IDtransporteur) || null,
      clientNom: clientNames.get(IDclient) || null,
      commandeNumero: commandeNumeros.length > 0 ? commandeNumeros[0] : null,
      commandeNumeros,
      poids: totals.poids,
      nbRouleaux: totals.nb,
      enlevement: {
        nom: company.legalName,
        adresse1: company.address1,
        adresse2: company.address2 || null,
        adresse3: null,
        cp: company.zip,
        ville: company.city,
        pays: company.country,
      },
      livraison: a
        ? {
            nom: (a.nom ?? null) as string | null,
            adresse1: (a.adresse1 ?? null) as string | null,
            adresse2: (a.adresse2 ?? null) as string | null,
            adresse3: (a.adresse3 ?? null) as string | null,
            cp: (a.cp ?? null) as string | null,
            ville: (a.ville ?? null) as string | null,
            pays: (a.pays ?? null) as string | null,
          }
        : null,
    },
  }
}

async function renderDemandeTransportBuffer(data: DemandeTransportPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(DemandeTransportPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

function sendTransportPdf(res: Response, buffer: Buffer, filenameSuffix: string): void {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="Demande-transport-${filenameSuffix}.pdf"`)
  res.removeHeader('X-Frame-Options')
  res.removeHeader('Content-Security-Policy')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.send(buffer)
}

/** Grouped pickup request — ONE sheet cumulating the rolls of several
 *  expeditions (legacy right-click → Transport on a multi-row selection).
 *
 *  MUST stay registered BEFORE `/formelle/:id/demande-transport/pdf`: both
 *  patterns are 4 segments, so Express would otherwise match this URL with
 *  id = 'groupee' and 400 on the parseInt. */
expeditionsRouter.get('/formelle/groupee/demande-transport/pdf', async (req: Request, res: Response) => {
  try {
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((x) => !isNaN(x) && x > 0)
    if (ids.length === 0) { res.status(400).json({ error: 'Invalid ID', message: 'Aucune expédition sélectionnée.' }); return }
    if (ids.length > 100) { res.status(400).json({ error: 'Too many', message: 'Trop d\'expéditions sélectionnées (100 maximum).' }); return }
    const built = await buildDemandeTransportPdfData(ids, req.userId)
    if ('err' in built) { res.status(built.err.status).json({ error: built.err.error, message: built.err.message }); return }
    const buffer = await renderDemandeTransportBuffer(built.data)
    sendTransportPdf(res, buffer, (built.data.expeditionIds ?? [built.data.numero]).join('-'))
  } catch (err) {
    console.error('Error rendering grouped demande de transport PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeditionsRouter.get('/formelle/:id/demande-transport/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const built = await buildDemandeTransportPdfData([id], req.userId)
    if ('err' in built) { res.status(built.err.status).json({ error: built.err.error, message: built.err.message }); return }
    const buffer = await renderDemandeTransportBuffer(built.data)
    sendTransportPdf(res, buffer, String(id))
  } catch (err) {
    console.error('Error rendering demande de transport PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  EMAIL — Avis d'expédition (formelle only)
// ════════════════════════════════════════════════════════

// type_doc 14 = "avis expedition" — envoi_email audit rows for formelle BLs.
// type_doc 16 = "avis expedition diver" — same, for the divers flow.
const TYPE_DOC_AVIS_EXPEDITION = 14
const TYPE_DOC_AVIS_EXPEDITION_DIVERS = 16

function nowHfsqlDatetime(): string {
  const d = new Date()
  const pad = (x: number, w = 2) => String(x).padStart(w, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${String(d.getMilliseconds()).padStart(3, '0')}`
  )
}

interface EmailRecipientPayload { email: string; name?: string; source: 'contact'; contactId: number }

const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** BL-flagged contact emails of a set of sous-traitants. `mail` is ASCII by
 *  nature, so no encoding repair is needed. Deduped, lowercase-keyed. */
async function loadSstBlEmails(sstIds: number[]): Promise<string[]> {
  const ids = Array.from(new Set(sstIds.filter((x) => x > 0)))
  if (ids.length === 0) return []
  const rows = await query<{ IDcontact: number; mail: string | null; envoi_bl: number | null; est_visible: number | null }>(
    `SELECT IDcontact, mail, envoi_bl, est_visible FROM contact WHERE IDsous_traitant IN (${ids.join(',')})`,
  )
  const out: string[] = []
  const seen = new Set<string>()
  for (const c of rows) {
    if (Number(c.envoi_bl) !== 1) continue
    if (Number(c.est_visible ?? 1) === 0) continue
    const raw = (c.mail ?? '').toString().trim()
    if (!raw || !MAIL_RE.test(raw)) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(raw)
  }
  return out
}

/** Sous-traitants physically holding the rolls of an expedition — the rolls'
 *  magasin (stock_*.IDmagasin → sous_traitant.IDsous_traitant; 0 = à l'usine).
 *  They get the BL in Cci so they know what to ship and where it goes. */
async function loadExpeditionMagasinSstIds(ligneIds: number[]): Promise<number[]> {
  const ids = Array.from(new Set(ligneIds.filter((x) => x > 0)))
  if (ids.length === 0) return []
  const inLe = ids.join(',')
  const [fini, ecru] = await Promise.all([
    query<{ IDmagasin: number | null }>(`SELECT IDmagasin FROM stock_fini WHERE IDligne_expedition IN (${inLe})`),
    query<{ IDmagasin: number | null }>(`SELECT IDmagasin FROM stock_ecru WHERE IDligne_expedition_ETM IN (${inLe})`),
  ])
  return Array.from(new Set([...fini, ...ecru].map((r) => Number(r.IDmagasin) || 0).filter((x) => x > 0)))
}

async function buildBlEmailDefaults(id: number): Promise<{
  recipients: { selected: EmailRecipientPayload[]; suggestions: EmailRecipientPayload[] }
  subject: string; body: string; clientNom: string
  bcc: string[]
  optional_attachments: Array<{ id: string; default_checked: boolean }>
} | null> {
  const rows = await query<{ IDcommande_client: number; inclureRapportQualite: number | null }>(
    `SELECT IDcommande_client, inclureRapportQualite FROM expedition WHERE IDexpedition = ${id} AND IDsociete = 1`,
  )
  if (rows.length === 0) return null
  const cmdId = Number(rows[0].IDcommande_client) || 0
  const expRcFlag = Number(rows[0].inclureRapportQualite) === 1
  const cmdRows = cmdId > 0
    ? await query<{ IDclient: number }>(`SELECT IDclient FROM commande_client WHERE IDcommande_client = ${cmdId}`)
    : []
  const IDclient = Number(cmdRows[0]?.IDclient) || 0

  const [clientNames, contactRows, clientFlagRows, leRows] = await Promise.all([
    resolveClientNames([IDclient]),
    IDclient > 0
      ? query<{ IDcontact: number; nom: string | null; prenom: string | null; mail: string | null; envoi_bl: number | null; est_visible: number | null }>(
          `SELECT IDcontact, nom, prenom, mail, envoi_bl, est_visible FROM contact WHERE IDclient = ${IDclient}`,
        )
      : Promise.resolve([]),
    IDclient > 0
      ? query<{ inclureRapportQualite: number | null }>(`SELECT inclureRapportQualite FROM client WHERE IDclient = ${IDclient}`)
      : Promise.resolve([]),
    query<{ IDligne_commande_client: number }>(
      `SELECT IDligne_expedition, IDligne_commande_client FROM ligne_expedition WHERE IDexpedition = ${id}`,
    ),
  ])

  // The RC / Info matières documents only exist for fini lines. Availability
  // gates whether the dialog shows the checkboxes at all.
  const lccIds = (leRows as any[]).map((l) => Number(l.IDligne_commande_client) || 0).filter((x) => x > 0)
  let hasFiniLines = false
  if (lccIds.length > 0) {
    const typeRows = await query<any>(
      `SELECT IDligne_commande_client, TYPE AS type_kind FROM ligne_commande_client WHERE IDligne_commande_client IN (${lccIds.join(',')})`,
    )
    hasFiniLines = (typeRows as any[]).some((t) => lineStockKind(Number(t.type_kind) || 0) === 'fini')
  }
  // Default: expedition mirror OR live client flag — MPS_NG INSERTs seeded the
  // mirror to 0 before 2026-07, so the OR keeps those shipments covered.
  const clientRcFlag = Number((clientFlagRows as any[])[0]?.inclureRapportQualite) === 1
  const optional_attachments = hasFiniLines
    ? [
        { id: 'rapport-controle', default_checked: expRcFlag || clientRcFlag },
        { id: 'info-matieres', default_checked: false },
      ]
    : []
  const clientNom = clientNames.get(IDclient) ?? ''
  const fixedContacts = await fixEncoding(contactRows, 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])

  // Cci: the sous-traitants whose magasin holds the shipped rolls — they need
  // the BL to know what to send out. Never in Cc: the client must not see them.
  const sstIds = await loadExpeditionMagasinSstIds((leRows as any[]).map((l) => Number(l.IDligne_expedition) || 0))
  const bcc = await loadSstBlEmails(sstIds)

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
    if (c.envoi_bl === 1) selected.push(recipient)
    else suggestions.push(recipient)
  }

  const subject = `Avis d'expédition N°${id} - ETS Malterre`
  const body =
    `Bonjour,\n\n` +
    `Veuillez trouver ci-joint notre avis d'expédition N°${id}.\n\n` +
    `Nous restons à votre disposition pour toute information complémentaire.\n\n` +
    `Cordialement,\n` +
    `ETS Malterre`
  return { recipients: { selected, suggestions }, subject, body, clientNom, bcc, optional_attachments }
}

expeditionsRouter.get('/formelle/:id/email-defaults', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const defaults = await buildBlEmailDefaults(id)
    if (!defaults) { res.status(404).json({ error: 'Expédition not found' }); return }
    res.json(defaults)
  } catch (err) {
    console.error('Error building expedition email defaults:', err)
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
  // Optional per-document attachments — formelle only (divers ignores them).
  attach_rapport_controle: z.boolean().optional(),
  attach_info_matieres: z.boolean().optional(),
  extra_attachments: z.array(extraAttachmentSchema).optional(),
  dev_skip_send: z.boolean().optional(),
})
const ALLOW_DEV_SKIP_SEND = process.env.NODE_ENV !== 'production'

async function logEnvoiEmails(idReference: number, recipients: string[], societe: string, typeDoc: number, notes = ''): Promise<void> {
  if (recipients.length === 0) return
  const ts = nowHfsqlDatetime()
  for (const raw of recipients) {
    const addr = String(raw).trim()
    if (!addr) continue
    try {
      if (IS_WINDOWS) {
        await query(
          `INSERT INTO envoi_email (DATE, adresse, société, IDreference, invalidé, notes, IDtype_doc)
           VALUES ('${ts}', ${sqlText(addr)}, ${sqlText(societe || '')}, ${idReference}, 0, ${sqlText(notes)}, ${typeDoc})`,
        )
      } else {
        await query(
          `INSERT INTO envoi_email (DATE, adresse, IDreference, notes, IDtype_doc)
           VALUES ('${ts}', ${sqlText(addr)}, ${idReference}, ${sqlText(notes)}, ${typeDoc})`,
        )
      }
    } catch (e) {
      console.error(`envoi_email log failed (expedition/${idReference}/${addr}):`, (e as Error).message)
    }
  }
}

expeditionsRouter.post('/formelle/:id/email', async (req: Request, res: Response) => {
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
      console.log(`[dev-skip-send] expedition #${id} — fake send to ${parsed.data.to.join(', ')}`)
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
      const fromName = displayName ? `${displayName} - ETS Malterre` : 'ETS Malterre'

      const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
      if (parsed.data.attach_pdf !== false) {
        const data = await buildBlPdfData(id)
        if (!data) { res.status(404).json({ error: 'Expédition not found' }); return }
        const buffer = await renderBlPdfBuffer(data)
        attachments.push({ filename: `BL-${id}.pdf`, content: buffer, contentType: 'application/pdf' })
      }
      // Ticked optional documents — fail loudly when the data can't be built
      // (the user explicitly asked for the attachment; never skip silently).
      if (parsed.data.attach_rapport_controle === true) {
        const rc = await buildRapportControlePdfData(id)
        if (!rc) {
          res.status(400).json({ error: 'rc_indisponible', message: 'Rapport de contrôle indisponible pour cette expédition.' })
          return
        }
        attachments.push({ filename: `RC-${id}.pdf`, content: await renderRapportControleBuffer(rc), contentType: 'application/pdf' })
      }
      if (parsed.data.attach_info_matieres === true) {
        const im = await buildInfoMatieresPdfData(id)
        if (!im) {
          res.status(400).json({ error: 'im_indisponible', message: 'Info matières indisponible pour cette expédition.' })
          return
        }
        attachments.push({ filename: `Info-matieres-${id}.pdf`, content: await renderInfoMatieresBuffer(im), contentType: 'application/pdf' })
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

    const allRecipients = [...parsed.data.to, ...(parsed.data.cc ?? []), ...(parsed.data.bcc ?? [])]
    let societe = ''
    try {
      const er = await query<{ IDcommande_client: number }>(`SELECT IDcommande_client FROM expedition WHERE IDexpedition = ${id} AND IDsociete = 1`)
      const cr = Number(er[0]?.IDcommande_client) > 0
        ? await query<{ IDclient: number }>(`SELECT IDclient FROM commande_client WHERE IDcommande_client = ${Number(er[0].IDcommande_client)}`)
        : []
      const names = await resolveClientNames([Number(cr[0]?.IDclient) || 0])
      societe = names.get(Number(cr[0]?.IDclient) || 0) ?? ''
    } catch { /* informational */ }
    // Audit note records which documents rode along (e.g. "BL+RC+IM") — the
    // send is still logged under the avis d'expédition type_doc like legacy.
    const noteParts = [
      ...(parsed.data.attach_pdf !== false ? ['BL'] : []),
      ...(parsed.data.attach_rapport_controle === true ? ['RC'] : []),
      ...(parsed.data.attach_info_matieres === true ? ['IM'] : []),
    ]
    await logEnvoiEmails(id, allRecipients, societe, TYPE_DOC_AVIS_EXPEDITION, noteParts.join('+'))

    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending expedition email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})

// ════════════════════════════════════════════════════════
//  PDF + EMAIL — Avis d'expédition diverse
// ════════════════════════════════════════════════════════

export async function buildBlDiversPdfData(id: number): Promise<BonLivraisonDiversPdfData | null> {
  const rows = await query<any>(
    `SELECT IDexpedition_divers, IDclient, ref_client, IDadresse, IDtransporteur, DATE AS dexp ` +
      `FROM expedition_divers WHERE IDexpedition_divers = ${id}`,
  )
  if (rows.length === 0) return null
  const fixed = await fixEncoding(rows, 'expedition_divers', 'IDexpedition_divers', ['ref_client'])
  const h = fixed[0] as any
  const IDclient = Number(h.IDclient) || 0

  const [clientNames, transNames, adr, lignesRaw] = await Promise.all([
    resolveClientNames([IDclient]),
    resolveTransporteurNames([Number(h.IDtransporteur)]),
    loadAdresse(Number(h.IDadresse) || 0),
    query<any>(
      `SELECT IDligne_expedition_divers, detail_ligne FROM ligne_expedition_divers ` +
        `WHERE IDexpedition_divers = ${id} ORDER BY IDligne_expedition_divers`,
    ),
  ])
  const lignesFixed = await fixEncoding(lignesRaw, 'ligne_expedition_divers', 'IDligne_expedition_divers', ['detail_ligne'])
  const itemsByLigne = await loadDiversItems((lignesFixed as any[]).map((l) => Number(l.IDligne_expedition_divers) || 0))

  const cartons: BlDiversCarton[] = (lignesFixed as any[]).map((l) => {
    const items = itemsByLigne.get(Number(l.IDligne_expedition_divers)) ?? []
    return {
      detail: stripRtf(l.detail_ligne) || '',
      items: items.map((it) => ({
        // Legacy free-text override wins, else the catalog designation (same
        // rule as the web UI's diversItemLabel).
        designation: it.designation.trim() || it.ref_designation || `Réf #${it.IDref_divers}`,
        variations: [it.variation1_label, it.variation2_label].filter(Boolean).join(' · ') || null,
        quantite: it.quantite,
        unite: it.unite,
        unite_label: it.unite_label,
        prix: it.prix,
      })),
    }
  })

  const refClient = (h.ref_client ?? '').toString().replace(/\s+/g, ' ').trim()
  const a = adr as any
  return {
    numero: id,
    dateLong: formatHfsqlDateLongFr(h.dexp),
    clientNom: (IDclient > 0 ? clientNames.get(IDclient) : '') || refClient || '',
    refClient: refClient || null,
    transporteurNom: transNames.get(Number(h.IDtransporteur)) || null,
    adresseLivraison: a
      ? {
          nom: (a.nom ?? null) as string | null,
          adresse1: (a.adresse1 ?? null) as string | null,
          adresse2: (a.adresse2 ?? null) as string | null,
          adresse3: (a.adresse3 ?? null) as string | null,
          cp: (a.cp ?? null) as string | null,
          ville: (a.ville ?? null) as string | null,
          pays: (a.pays ?? null) as string | null,
        }
      : null,
    cartons,
  }
}

async function renderBlDiversPdfBuffer(data: BonLivraisonDiversPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(BonLivraisonDiversPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

expeditionsRouter.get('/divers/:id/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const data = await buildBlDiversPdfData(id)
    if (!data) { res.status(404).json({ error: 'Expédition not found' }); return }
    const buffer = await renderBlDiversPdfBuffer(data)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="BL-divers-${id}.pdf"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering expedition diverse PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

async function buildBlDiversEmailDefaults(id: number): Promise<{
  recipients: { selected: EmailRecipientPayload[]; suggestions: EmailRecipientPayload[] }
  subject: string; body: string; clientNom: string
} | null> {
  const rows = await query<any>(
    `SELECT IDexpedition_divers, IDclient, ref_client FROM expedition_divers WHERE IDexpedition_divers = ${id}`,
  )
  if (rows.length === 0) return null
  const IDclient = Number(rows[0].IDclient) || 0

  const [clientNames, contactRows] = await Promise.all([
    resolveClientNames([IDclient]),
    IDclient > 0
      ? query<{ IDcontact: number; nom: string | null; prenom: string | null; mail: string | null; envoi_bl: number | null; est_visible: number | null }>(
          `SELECT IDcontact, nom, prenom, mail, envoi_bl, est_visible FROM contact WHERE IDclient = ${IDclient}`,
        )
      : Promise.resolve([]),
  ])
  const clientNom = clientNames.get(IDclient) ?? (rows[0].ref_client ?? '').toString().trim()
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
    if (c.envoi_bl === 1) selected.push(recipient)
    else suggestions.push(recipient)
  }

  const subject = `Avis d'expédition N°${id} - ETS Malterre`
  const body =
    `Bonjour,\n\n` +
    `Veuillez trouver ci-joint notre avis d'expédition N°${id}.\n\n` +
    `Nous restons à votre disposition pour toute information complémentaire.\n\n` +
    `Cordialement,\n` +
    `ETS Malterre`
  return { recipients: { selected, suggestions }, subject, body, clientNom }
}

expeditionsRouter.get('/divers/:id/email-defaults', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const defaults = await buildBlDiversEmailDefaults(id)
    if (!defaults) { res.status(404).json({ error: 'Expédition not found' }); return }
    res.json(defaults)
  } catch (err) {
    console.error('Error building expedition diverse email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeditionsRouter.post('/divers/:id/email', async (req: Request, res: Response) => {
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
      console.log(`[dev-skip-send] expedition diverse #${id} — fake send to ${parsed.data.to.join(', ')}`)
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
      const fromName = displayName ? `${displayName} - ETS Malterre` : 'ETS Malterre'

      const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
      if (parsed.data.attach_pdf !== false) {
        const data = await buildBlDiversPdfData(id)
        if (!data) { res.status(404).json({ error: 'Expédition not found' }); return }
        const buffer = await renderBlDiversPdfBuffer(data)
        attachments.push({ filename: `BL-divers-${id}.pdf`, content: buffer, contentType: 'application/pdf' })
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

    const allRecipients = [...parsed.data.to, ...(parsed.data.cc ?? []), ...(parsed.data.bcc ?? [])]
    let societe = ''
    try {
      const er = await query<{ IDclient: number; ref_client: string | null }>(
        `SELECT IDclient, ref_client FROM expedition_divers WHERE IDexpedition_divers = ${id}`,
      )
      const cid = Number(er[0]?.IDclient) || 0
      const names = await resolveClientNames([cid])
      societe = names.get(cid) ?? (er[0]?.ref_client ?? '').toString().trim()
    } catch { /* informational */ }
    await logEnvoiEmails(id, allRecipients, societe, TYPE_DOC_AVIS_EXPEDITION_DIVERS)

    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending expedition diverse email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})
