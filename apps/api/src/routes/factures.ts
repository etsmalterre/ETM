// Factures — client invoices: proforma drafts + definitive invoices.
// Mirrors commandes-client.ts but for the ETM invoicing ledger. This is the
// MANUAL invoicing screen (legacy "Détail facture" / "Nouvelle facture"): an
// invoice header + free-text lines, with computed HT / TVA / TTC totals.
//
// PROFORMA vs DEFINITIVE — two parallel table pairs (legacy model):
//   kind 'prov' → facture_prov / ligne_facture_prov  (editable drafts)
//   kind 'def'  → facture / ligne_facture            (locked once issued)
// Both header tables have the same column shape EXCEPT facture_prov has no
// IDcommande_client. A proforma is fully editable; converting it copies the
// header + lines into `facture` with a fresh definitive numero. A definitive
// facture is read-only (corrections go through an Avoir, never an edit/delete).
//
// CONVERSION IS A MOVE — converting a proforma copies its header + lines into
// the definitive ledger (fresh facture numero) and then DELETES the proforma
// (header + lines). Nothing "converted" lingers in facture_prov: the proforma
// bucket only ever holds open, editable drafts. Expeditions stay est_facture=1
// because their ligne_expedition ids are now referenced by ligne_facture rows
// (wipeOpenProformas checks that ledger before reopening an expedition).
// Generated proformas link to their expeditions per-line via
// ligne_facture_prov.IDligne_expedition, and expedition.est_facture carries
// the "already invoiced" state both apps read.
//
// TWO SOCIÉTÉS, ONE ROUTER — `facture` / `facture_prov` are shared tables
// partitioned by IDsociete (1 = ETS Malterre, 2 = Tricotage Malterre). Unlike
// `stock_ecru`, whose two halves are genuinely different objects (hence the
// separate `stock-ecru-trm.ts`), the two invoice ledgers are the SAME object:
// identical columns, identical lifecycle, identical screen. So this file is a
// factory — `createFacturesRouter(scope)` — mounted twice (`/api/factures` for
// ETM, `/api/factures-trm` for TRM) instead of being forked. Everything that
// differs between the companies lives in the `FacturesScope` record below and
// nowhere else; if you find yourself writing a literal `1` for IDsociete again,
// it belongs in the scope.
//
// Hard rules baked in (verified against live data + the XDD + CLAUDE.md):
//  - Société scope: every read/write is IDsociete = scope.societe.
//  - numero allocator: MAX(numero)+1 per table WHERE IDsociete=scope, retry loop.
//    facture and facture_prov keep INDEPENDENT numero sequences, and each
//    société has its own (live: ETM ~9 100, TRM ~85 200 — far apart, but they
//    are only kept apart BY the per-société MAX, so never drop that predicate).
//  - Neither header table has accented columns; `date` and `type` are reserved
//    words → SELECT/INSERT/UPDATE them as uppercase DATE / TYPE (same trick as
//    envoi_email.DATE and ligne_commande_client.TYPE). SELECT * is safe here.
//  - line `designation` is corrupted on read (ODBC) → fixEncoding it.
//    `unite` is FREE TEXT ("Ml"/"Kg"/"Pièce"…), not the numeric enum used by
//    ligne_commande_client.
//  - No stored totals: HT = Σ(quantite×prix), TVA = HT×tva.valeur/100, TTC=HT+TVA.
//  - TYPE 1 = Facture, 2 = Avoir (credit note). Amounts are stored positive;
//    the Avoir's "credit" sign is a presentation concern (the list shows it
//    negative). This API returns magnitudes + type; callers apply the sign.
//  - `SELECT * FROM client` returns 0 rows on this driver — explicit columns only.
//  - On create, billing defaults are auto-filled from the client row
//    (num_tva, IDtva, IDmode_paiement, IDecheance, IDcode_comptable + the
//    est_defaut_facturation address), matching the legacy auto-fill.
//  - Email works for BOTH kinds (print too), but envoi_email HISTORY is
//    definitive-only: prov and def share a numeric id space on the same
//    envoi_email IDtype_doc, so logging a proforma send would collide with a
//    definitive facture's history. Proforma sends are therefore NOT logged
//    (their /historique returns []). Both PDFs carry the bank coordinates card.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { FacturePdf, type FacturePdfData } from '../lib/pdf/FacturePdf.js'
import { sendMail } from '../lib/gmail.js'
import { getUserEmail } from '../lib/user-emails.js'
import { IS_WINDOWS, esc, n, dateDigits as dateStr } from '../lib/sst-shared.js'
import { buildXImportFile, type XImportEntry } from '../lib/ximport.js'
import { userHasPermission } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { company as companyEtm, companyTrm, type CompanyInfo } from '../lib/pdf/theme.js'
import { loadDiversItems, resolveDiversPrix, type DiversItem } from './expeditions.js'

// ── Société scope ────────────────────────────────────────
//
// The complete list of what differs between the ETM and TRM invoice ledgers.
// Anything not in here is identical for both companies by construction.
interface FacturesScope {
  /** `facture.IDsociete` / `facture_prov.IDsociete` partition key. */
  societe: 1 | 2
  /** `stock_ecru` column linking a roll to a shipment line of THIS company.
   *  ETM ships écru it bought (`IDligne_expedition_ETM`); TRM ships écru it
   *  knitted (`IDligne_expedition_TRM`). The same physical roll can carry both
   *  over its life — TRM knits it and ships it to ETM, which later ships it on
   *  — so the generator MUST read its own column or it invoices the wrong
   *  shipment's weight. */
  ecruShipmentFk: 'IDligne_expedition_ETM' | 'IDligne_expedition_TRM'
  /** Legal identity on the PDF (footer + bank card). */
  company: CompanyInfo
  /** Trade name used in the email subject and the "from" display name. */
  brand: string
}

const SCOPE_ETM: FacturesScope = {
  societe: 1,
  ecruShipmentFk: 'IDligne_expedition_ETM',
  company: companyEtm,
  brand: 'ETS Malterre',
}

const SCOPE_TRM: FacturesScope = {
  societe: 2,
  ecruShipmentFk: 'IDligne_expedition_TRM',
  company: companyTrm,
  brand: 'Tricotage Malterre',
}

/** Guard for every invoice write path: create, header edit, delete, line
 *  CRUD, generate, batch-delete and convert (edit_factures permission).
 *  Reads (list / detail / pdf / email) stay open to everyone.
 *  Sends the 401/403 itself and returns false when the caller is not allowed. */
async function requireEditFactures(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'edit_factures')
  if (!allowed) {
    res.status(403).json({ error: 'permission denied: edit_factures' })
    return false
  }
  return true
}

// type_doc 19 = "facture definitve" (sic — validated invoice). Used for the
// envoi_email audit log when a facture/avoir is emailed.
const TYPE_DOC_FACTURE = 19

// ── Proforma / définitive table model ────────────────────

type Kind = 'prov' | 'def'

const TBL: Record<Kind, {
  table: string; lineTable: string; pk: string; linePk: string; lineFk: string
}> = {
  prov: { table: 'facture_prov', lineTable: 'ligne_facture_prov', pk: 'IDfacture_prov', linePk: 'IDligne_facture_prov', lineFk: 'IDfacture_prov' },
  def:  { table: 'facture',      lineTable: 'ligne_facture',      pk: 'IDfacture',      linePk: 'IDligne_facture',      lineFk: 'IDfacture' },
}

function parseKind(raw: string | undefined): Kind | null {
  return raw === 'prov' ? 'prov' : raw === 'def' ? 'def' : null
}

// Write-path lock responses.
const DEF_LOCK = { error: 'facture_definitive', message: 'Facture définitive — non modifiable. Créez un avoir pour corriger.' }

/** Parent proforma id for a ligne_facture_prov row (0 if not found). */
async function provLineParent(lineId: number): Promise<number> {
  const rows = await query<any>(`SELECT IDfacture_prov FROM ligne_facture_prov WHERE IDligne_facture_prov = ${lineId}`)
  return rows.length > 0 ? Number(rows[0].IDfacture_prov) || 0 : 0
}

/** Does this facture / facture_prov row belong to the calling router's société?
 *
 *  MANDATORY on every id-addressed route. `facture` and `facture_prov` PKs are
 *  a single sequence shared by all three sociétés, so an id from ETM's ledger
 *  is a perfectly valid id in TRM's URL space: without this check
 *  `GET /api/factures-trm/def/5332` happily returns ETM's facture N°9099, and
 *  `PUT /api/factures-trm/prov/<etm id>` would rewrite an ETM proforma's TVA
 *  with a TRM tva row. Harmless while a single router existed — a real
 *  cross-ledger hole the moment the second one is mounted. */
async function inScope(scope: FacturesScope, kind: Kind, id: number): Promise<boolean> {
  const t = TBL[kind]
  const rows = await query<{ IDsociete: number }>(
    `SELECT IDsociete FROM ${t.table} WHERE ${t.pk} = ${id}`,
  )
  return rows.length > 0 && Number(rows[0].IDsociete) === scope.societe
}

/** 404 (not 403) when the id belongs to the other société: from this router's
 *  point of view the document genuinely does not exist, and saying otherwise
 *  would leak that an invoice with that id exists elsewhere. */
const NOT_FOUND = { error: 'Facture not found' }

// ── Small SQL/format helpers (same as commandes-client.ts) ──

/** SQL literal for a user-supplied text value. Pure ASCII → quoted literal;
 *  anything with accents → Latin-1 hex literal (the Linux iODBC bridge
 *  corrupts raw multi-byte UTF-8 embedded in a SQL line). Newlines (\r\n) are
 *  preserved by both branches. */
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

function nowHfsqlDatetime(): string {
  const d = new Date()
  const pad = (x: number, w = 2) => String(x).padStart(w, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  )
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

function cleanAddrField(s: string | null | undefined): string | null {
  if (!s) return null
  const t = String(s).trim()
  if (!t) return null
  if (/^[.\-_·•\s]+$/.test(t)) return null
  return t
}

/** Normalise for accent-insensitive contains-matching (search). */
function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

function todayDigits(): string {
  const t = new Date()
  return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`
}

/** Display number for a facture row. Definitive invoices show their `numero`
 *  column, but the legacy app shows a proforma's PK (IDfacture_prov) as its
 *  number — facture_prov.numero is a vestigial internal sequence the user
 *  never sees (verified live: legacy "proforma 13521" = IDfacture_prov 13521,
 *  numero 3). Every user-facing surface (list, detail, PDF, email) goes
 *  through this. */
function displayNumero(kind: Kind, id: number, numero: unknown): number | null {
  if (kind === 'prov') return id
  return numero != null ? Number(numero) : null
}

/** Next numero for the given ledger, within this société. MAX+1 matches the
 *  legacy allocator; concurrent POSTs retry on collision. facture and
 *  facture_prov keep separate sequences, and so does each société. */
async function nextNumero(scope: FacturesScope, kind: Kind): Promise<number> {
  const r = await query<{ m: number | null }>(
    `SELECT MAX(numero) AS m FROM ${TBL[kind].table} WHERE IDsociete = ${scope.societe}`,
  )
  return (Number(r[0]?.m) || 0) + 1
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

/** Map of IDtva → { valeur (rate %), libelle }. Loads every société's rows so
 *  any facture's IDtva resolves. */
async function loadTvaMap(): Promise<Map<number, { valeur: number; libelle: string }>> {
  const out = new Map<number, { valeur: number; libelle: string }>()
  const rows = await query<{ IDtva: number; valeur: number | null; libelle_compte: string | null }>(
    `SELECT IDtva, valeur, libelle_compte FROM tva`,
  )
  const fixed = await fixEncoding(rows, 'tva', 'IDtva', ['libelle_compte'])
  for (const r of fixed) {
    out.set(Number(r.IDtva), { valeur: Number(r.valeur) || 0, libelle: (r.libelle_compte ?? '').toString() })
  }
  return out
}

// Both label loaders MUST project their PK: fixEncoding re-reads the corrupted
// field with `WHERE <idField> = <row[idField]>`, so a projection without the id
// silently skips the repair (that is how "Vente à façon" first came back as
// "Vente � fa�on").
async function loadCodeComptableLabel(id: number): Promise<string | null> {
  if (!(id > 0)) return null
  const rows = await query<{ IDcode_comptable: number; libelle: string | null }>(
    `SELECT IDcode_comptable, libelle FROM code_comptable WHERE IDcode_comptable = ${id}`,
  )
  const fixed = await fixEncoding(rows, 'code_comptable', 'IDcode_comptable', ['libelle'])
  return (fixed[0]?.libelle ?? null) as string | null
}

async function loadModePaiementLabel(id: number): Promise<string | null> {
  if (!(id > 0)) return null
  const rows = await query<{ IDmode_paiement: number; libelle: string | null }>(
    `SELECT IDmode_paiement, libelle FROM mode_paiement WHERE IDmode_paiement = ${id}`,
  )
  const fixed = await fixEncoding(rows, 'mode_paiement', 'IDmode_paiement', ['libelle'])
  return (fixed[0]?.libelle ?? null) as string | null
}

export interface EcheanceRule { libelle: string | null; type: number; nb_jours: number; jour: number }

/** Echeance row incl. the calculation params (TYPE is a reserved word — comes
 *  back as the uppercase key, like facture.DATE/TYPE). */
export async function loadEcheanceRule(id: number): Promise<EcheanceRule | null> {
  if (!(id > 0)) return null
  const rows = await query<any>(`SELECT * FROM echeance WHERE IDecheance = ${id}`)
  if (rows.length === 0) return null
  const fixed = await fixEncoding(rows, 'echeance', 'IDecheance', ['libelle'])
  const r = fixed[0] as any
  return {
    libelle: (r.libelle ?? null) as string | null,
    type: Number(r.TYPE) || 0,
    nb_jours: Number(r.nb_jours) || 0,
    jour: Number(r.jour) || 0,
  }
}

/** Due date from the facture date + the echeance rule — mirrors the legacy
 *  calculation (verified against live data: facture 15/07/2026 + "45 jours,
 *  fin de mois" [TYPE 3, nb_jours 45] → 31/08/2026, matching the legacy PDF).
 *    TYPE 1 → no computable date (à réception / avant livraison / acomptes…)
 *    TYPE 2 → date + nb_jours
 *    TYPE 3 → "<nb> jours, fin de mois": date + nb_jours, then end of month
 *    TYPE 4 → "fin de mois, <nb> jours": end of month, then + nb_jours
 *    TYPE 5 → "<nb> jours, fin de mois, le <jour>": TYPE 3 then + jour days
 *             (= the <jour>th of the following month)
 *  Returns "dd/mm/yyyy" or null. */
export function computeDateEcheance(dateYmd: string | null | undefined, ech: EcheanceRule | null): string | null {
  if (!ech) return null
  const s = String(dateYmd ?? '')
  if (!/^\d{8}$/.test(s)) return null
  let d = new Date(parseInt(s.slice(0, 4), 10), parseInt(s.slice(4, 6), 10) - 1, parseInt(s.slice(6, 8), 10))
  const addDays = (n: number) => { d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n) }
  const endOfMonth = () => { d = new Date(d.getFullYear(), d.getMonth() + 1, 0) }
  switch (ech.type) {
    case 2: addDays(ech.nb_jours); break
    case 3: addDays(ech.nb_jours); endOfMonth(); break
    case 4: endOfMonth(); addDays(ech.nb_jours); break
    case 5: addDays(ech.nb_jours); endOfMonth(); addDays(ech.jour); break
    default: return null
  }
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
}

async function loadAdresse(id: number): Promise<Record<string, unknown> | null> {
  if (!(id > 0)) return null
  const rows = await query(
    `SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays FROM adresse WHERE IDadresse = ${id}`,
  )
  const fixed = await fixEncoding(rows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays'])
  return (fixed[0] as Record<string, unknown>) ?? null
}

/** Money rounding — 2 decimals, half away from zero (all amounts here are
 *  positive, so this is plain half-up, the same as WinDev's `Arrondi`). */
function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** Amount of one invoice line — THE invoice arithmetic, used by every total
 *  (list, detail, PDF, XImport) so they can never disagree.
 *
 *  `ligne_facture.prix` is a 4-byte REAL and, when the price came out of the
 *  tarif engine rather than being typed by hand, it carries full float noise
 *  (2.100738048553467, 4.677432060241699…). The invoice PRINTS the unit price
 *  at 2 decimals, and the client checks qty × printed price = printed line
 *  total = printed invoice total — so the arithmetic has to close at the
 *  precision the document shows. The legacy WinDev app does exactly that:
 *  round the unit price to the centime, multiply, round the line.
 *
 *  Verified against the 14 TRM invoices legible in the legacy Factures screen:
 *  this formula reproduces 13 (the 14th, N°85200, is off by one centime on a
 *  half-cent tie). Summing raw `quantite * prix` — what this file did before —
 *  reproduced only 4, and was wrong by up to €6.71 on a single invoice, which
 *  the XImport export then posted straight into the accounting system. */
function lineMontant(quantite: unknown, prix: unknown): number {
  return round2((Number(quantite) || 0) * round2(Number(prix) || 0))
}

/** Per-facture line totals (Σ line montants, count). Batched over a set of ids. */
async function lineTotals(kind: Kind, factureIds: number[]): Promise<Map<number, { total_ht: number; nb_lignes: number }>> {
  const out = new Map<number, { total_ht: number; nb_lignes: number }>()
  const ids = factureIds.filter((x) => x > 0)
  if (ids.length === 0) return out
  const t = TBL[kind]
  const rows = await query<{ pid: number; quantite: number | null; prix: number | null }>(
    `SELECT ${t.lineFk} AS pid, quantite, prix FROM ${t.lineTable} WHERE ${t.lineFk} IN (${ids.join(',')})`,
  )
  for (const r of rows) {
    const id = Number(r.pid)
    const acc = out.get(id) ?? { total_ht: 0, nb_lignes: 0 }
    acc.total_ht += lineMontant(r.quantite, r.prix)
    acc.nb_lignes += 1
    out.set(id, acc)
  }
  // Σ of already-rounded centimes still drifts in binary float — settle it.
  for (const acc of out.values()) acc.total_ht = round2(acc.total_ht)
  return out
}

/** Legacy auto-fill: billing defaults from the client row (num_tva, IDtva,
 *  IDmode_paiement, IDecheance, IDcode_comptable + the est_defaut_facturation
 *  address), with the société-wide TVA / code comptable rows as backstop.
 *  Shared by the manual POST and the batch generator.
 *
 *  `tva` and `code_comptable` are partitioned by IDsociete, but `client` has a
 *  SINGLE IDtva / IDcode_comptable column shared by all three companies —
 *  live data: 627 clients point at ETM rows, 27 at TRM rows, 4 at Confection.
 *  Copying that id verbatim would book a TRM invoice on an ETM TVA account the
 *  moment a client is shared between the two (SOFILETA, Bonneterie Gautier…),
 *  and the XImport export posts whatever we store here straight into the
 *  accounting system. So both ids are re-homed into THIS société:
 *    - TVA by RATE — the rate is the business fact (0 % exonération vs 20 %),
 *      the row id is just where that rate lives for a given company;
 *    - code comptable by keeping the client's only if it is already ours,
 *      else this société's default (there is no cross-société equivalence to
 *      match on, and the default is what the legacy app writes anyway).
 *  Every existing invoice in the live ledger already satisfies this (facture
 *  société always equals its tva/code société, 5 297/5 297 rows), so for ETM
 *  this is a no-op guard, not a behaviour change. */
async function clientBillingDefaults(scope: FacturesScope, IDclient: number): Promise<{
  idAdresse: number; idTva: number; idMode: number; idEcheance: number; idCode: number; numTva: string
}> {
  const clientRows = await query<{
    num_tva: string | null; IDtva: number | null; IDmode_paiement: number | null
    IDecheance: number | null; IDcode_comptable: number | null
  }>(
    `SELECT num_tva, IDtva, IDmode_paiement, IDecheance, IDcode_comptable FROM client WHERE IDclient = ${IDclient}`,
  )
  const c = clientRows[0] ?? {}
  const [adrRows, tvaRows, codeRows] = await Promise.all([
    query<{ IDadresse: number }>(
      `SELECT IDadresse FROM adresse
       WHERE IDclient = ${IDclient} AND (est_visible IS NULL OR est_visible = 1)
       ORDER BY est_defaut_facturation DESC, est_defaut DESC, IDadresse`,
    ),
    query<{ IDtva: number; IDsociete: number; valeur: number | null; est_defaut: number | null }>(
      `SELECT IDtva, IDsociete, valeur, est_defaut FROM tva`,
    ),
    query<{ IDcode_comptable: number; IDsociete: number; est_defaut: number | null }>(
      `SELECT IDcode_comptable, IDsociete, est_defaut FROM code_comptable`,
    ),
  ])

  const ourTva = tvaRows.filter((t) => Number(t.IDsociete) === scope.societe)
  const clientTva = tvaRows.find((t) => Number(t.IDtva) === (Number(c.IDtva) || 0))
  const idTva =
    (clientTva && Number(clientTva.IDsociete) === scope.societe ? Number(clientTva.IDtva) : 0) ||
    (clientTva ? Number(ourTva.find((t) => Number(t.valeur) === Number(clientTva.valeur))?.IDtva) || 0 : 0) ||
    Number(ourTva.find((t) => Number(t.est_defaut) === 1)?.IDtva) || 0

  const ourCodes = codeRows.filter((x) => Number(x.IDsociete) === scope.societe)
  const clientCode = Number(c.IDcode_comptable) || 0
  const idCode =
    (ourCodes.some((x) => Number(x.IDcode_comptable) === clientCode) ? clientCode : 0) ||
    Number(ourCodes.find((x) => Number(x.est_defaut) === 1)?.IDcode_comptable) || 0

  return {
    idAdresse: Number(adrRows[0]?.IDadresse) || 0,
    idTva,
    idMode: Number(c.IDmode_paiement) || 0,
    idEcheance: Number(c.IDecheance) || 0,
    idCode,
    numTva: (c.num_tva ?? '').toString(),
  }
}

/** ligne_commande_client.unite enum → the free-text unite stored on facture
 *  lines (mirrors expeditions.ts / the legacy generated invoices). */
function uniteLabel(u: number | null | undefined): string {
  switch (Number(u)) {
    case 1: return 'Kg'
    case 3: return 'Ml'
    case 4: return 'unité'
    case 5: return 'm²'
    default: return ''
  }
}

/** ref_divers_expedie.unite → the unite text a DIVERS invoice line carries.
 *  Same enum, except 4: the invoice ledger has always printed "Pièce" there
 *  (2 417 legacy lines vs 0 saying "unité"), while the bon de livraison says
 *  "unité" — keep the invoice reading the way these clients have always
 *  received it. */
export function diversUniteLabel(u: number | null | undefined): string {
  return Number(u) === 4 ? 'Pièce' : uniteLabel(u)
}

/** Article label of a generated divers invoice line: the item's free-text
 *  `designation` when it has one (legacy per-shipment override, on 1 459 of
 *  2 904 rows), else the ref_divers designation — then its variation labels.
 *  Reproduces the legacy lines exactly ("Col R006-46 L/XL - GRIS 8985",
 *  "Tissu Voltige ® - Blanche - 12 Mètres"). */
export function diversArticleLabel(it: DiversItem): string {
  const head = (it.designation ?? '').trim() || (it.ref_designation ?? '').trim()
  return [head, it.variation1_label, it.variation2_label]
    .map((v) => (v ?? '').trim())
    .filter(Boolean)
    .join(' - ')
}

function chunks<T>(arr: T[], size = 500): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// ── Validation schemas ───────────────────────────────────

const factureBody = z.object({
  IDclient: z.number().int().positive().optional(),
  date: z.string().optional(),
  type: z.number().int().min(1).max(2).optional(),
  IDadresse: z.number().int().nonnegative().optional(),
  IDmode_paiement: z.number().int().nonnegative().optional(),
  IDecheance: z.number().int().nonnegative().optional(),
  IDtva: z.number().int().nonnegative().optional(),
  IDcode_comptable: z.number().int().nonnegative().optional(),
  num_tva: z.string().optional(),
})

const ligneBody = z.object({
  designation: z.string().optional(),
  quantite: z.number().optional(),
  unite: z.string().optional(),
  prix: z.number().optional(),
})

const batchIdsBody = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) })

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

// ════════════════════════════════════════════════════════
//  ROUTER FACTORY  (one instance per société — see the file header)
// ════════════════════════════════════════════════════════

function createFacturesRouter(scope: FacturesScope): RouterType {
  const router: RouterType = Router()

// ════════════════════════════════════════════════════════
//  LOOKUPS  (literal paths — must register before /:kind/*)
// ════════════════════════════════════════════════════════

router.get('/lookups/clients', async (_req: Request, res: Response) => {
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

router.get('/lookups/adresses', async (req: Request, res: Response) => {
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
    const fixed = await fixEncoding(rows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays'])
    res.json(fixed)
  } catch (err) {
    console.error('Error fetching adresses lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/lookups/modes-paiement', async (_req: Request, res: Response) => {
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

router.get('/lookups/echeances', async (_req: Request, res: Response) => {
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

// TVA options for the ETM société (the detail dropdown). Returns the rate so
// the FE can label them "20 %", "0 % (Exonération)", "5,5 %".
router.get('/lookups/tva', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDtva: number; valeur: number | null; libelle_compte: string | null }>(
      `SELECT IDtva, valeur, libelle_compte FROM tva WHERE IDsociete = ${scope.societe} AND est_visible = 1 ORDER BY valeur DESC`,
    )
    const fixed = await fixEncoding(rows, 'tva', 'IDtva', ['libelle_compte'])
    res.json(fixed.map((r) => ({ IDtva: Number(r.IDtva), valeur: Number(r.valeur) || 0, libelle: r.libelle_compte ?? '' })))
  } catch (err) {
    console.error('Error fetching tva lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Sales accounts for this société — the "Code comptable" the legacy TRM
// facture screen exposes as a dropdown, and what XImport posts the HT half of
// each invoice to. Partitioned by IDsociete (TRM: "Vente à façon", "Vente à
// façon internationale", "Vente article fini"…).
router.get('/lookups/codes-comptables', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDcode_comptable: number; numero: string | null; libelle: string | null }>(
      `SELECT IDcode_comptable, numero, libelle FROM code_comptable
       WHERE IDsociete = ${scope.societe} AND est_visible = 1 ORDER BY IDcode_comptable`,
    )
    const fixed = await fixEncoding(rows, 'code_comptable', 'IDcode_comptable', ['libelle'])
    res.json(fixed.map((r) => ({
      IDcode_comptable: Number(r.IDcode_comptable),
      numero: (r.numero ?? '').toString(),
      libelle: (r.libelle ?? '').toString(),
    })))
  } catch (err) {
    console.error('Error fetching codes-comptables lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  XIMPORT  (accounting export of one day's definitive invoices)
// ════════════════════════════════════════════════════════

/** Resolve one day's definitive invoices into XImport entries (ordered by
 *  numero, like the legacy export). Shared by the summary + download routes. */
async function loadXImportEntries(date: string): Promise<XImportEntry[]> {
  // DATE/TYPE are reserved words → uppercase keys. SELECT * is safe here.
  const factures = await query<any>(
    `SELECT * FROM facture WHERE IDsociete = ${scope.societe} AND DATE = '${date}' ORDER BY numero`,
  )
  if (factures.length === 0) return []

  const ids = factures.map((f: any) => Number(f.IDfacture)).filter(Boolean)
  const clientIds = factures.map((f: any) => Number(f.IDclient)).filter(Boolean)

  const [clients, tvaRows, codeRows, totalsMap] = await Promise.all([
    (async () => {
      const uniq = Array.from(new Set(clientIds))
      if (uniq.length === 0) return [] as any[]
      const rows = await query<any>(
        `SELECT IDclient, nom, compte FROM client WHERE IDclient IN (${uniq.join(',')})`,
      )
      return fixEncoding(rows, 'client', 'IDclient', ['nom'])
    })(),
    (async () => {
      const rows = await query<any>(`SELECT IDtva, compte, valeur, libelle_compte FROM tva`)
      return fixEncoding(rows, 'tva', 'IDtva', ['libelle_compte'])
    })(),
    (async () => {
      const rows = await query<any>(`SELECT IDcode_comptable, numero, libelle FROM code_comptable`)
      return fixEncoding(rows, 'code_comptable', 'IDcode_comptable', ['libelle'])
    })(),
    lineTotals('def', ids),
  ])

  const clientMap = new Map(clients.map((c: any) => [Number(c.IDclient), c]))
  const tvaMap = new Map(tvaRows.map((t: any) => [Number(t.IDtva), t]))
  const codeMap = new Map(codeRows.map((c: any) => [Number(c.IDcode_comptable), c]))

  // Échéance rules are shared across invoices — resolve each id once.
  const echeanceIds = Array.from(new Set(factures.map((f: any) => Number(f.IDecheance) || 0)))
  const echeances = new Map<number, EcheanceRule | null>(
    await Promise.all(echeanceIds.map(async (id) => [id, await loadEcheanceRule(id)] as const)),
  )


  return factures.map((f: any) => {
    const id = Number(f.IDfacture)
    const client = clientMap.get(Number(f.IDclient))
    const tva = tvaMap.get(Number(f.IDtva))
    const code = codeMap.get(Number(f.IDcode_comptable))
    const rate = Number(tva?.valeur) || 0

    // No stored totals: HT = Σ(quantite×prix), TVA = HT×rate. Round each half
    // before summing so TTC always equals the two posted lines exactly.
    const ht = round2(totalsMap.get(id)?.total_ht ?? 0)
    const tvaAmount = round2(ht * (rate / 100))

    // computeDateEcheance returns dd/mm/yyyy, or null for "à réception"-style
    // rules — the legacy export then falls back to the invoice date itself.
    const ech = computeDateEcheance(f.DATE, echeances.get(Number(f.IDecheance) || 0) ?? null)
    const echDigits = ech ? `${ech.slice(6, 10)}${ech.slice(3, 5)}${ech.slice(0, 2)}` : String(f.DATE ?? '')

    return {
      numero: Number(f.numero) || id,
      date: String(f.DATE ?? ''),
      dateEcheance: echDigits,
      isAvoir: Number(f.TYPE) === 2,
      compteTiers: (client?.compte ?? '').toString().trim(),
      libelleTiers: (client?.nom ?? '').toString().trim(),
      compteVente: (code?.numero ?? '').toString().trim(),
      libelleVente: (code?.libelle ?? '').toString().trim(),
      compteTva: (tva?.compte ?? '').toString().trim(),
      libelleTva: (tva?.libelle_compte ?? '').toString().trim(),
      ht,
      tva: tvaAmount,
      ttc: round2(ht + tvaAmount),
    }
  })
}

/** YYYYMMDD from ?date=, or null when absent/malformed. */
function parseExportDate(raw: unknown): string | null {
  const s = String(raw ?? '').replace(/-/g, '').trim()
  return /^\d{8}$/.test(s) ? s : null
}

// Pre-flight for the export dialog: how many invoices would the file contain?
router.get('/ximport/summary', async (req: Request, res: Response) => {
  try {
    const date = parseExportDate(req.query.date)
    if (!date) { res.status(400).json({ error: 'invalid_date' }); return }
    const entries = await loadXImportEntries(date)
    res.json({
      date,
      nb_factures: entries.filter((e) => !e.isAvoir).length,
      nb_avoirs: entries.filter((e) => e.isAvoir).length,
      nb_lignes: entries.length * 3,
      total_ttc: entries.reduce((sum, e) => sum + (e.isAvoir ? -e.ttc : e.ttc), 0),
    })
  } catch (err) {
    console.error('Error building XImport summary:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// The file itself. Opened via window.open() from the browser, so it must be a
// plain GET that triggers a download (no JSON envelope).
router.get('/ximport', async (req: Request, res: Response) => {
  try {
    const date = parseExportDate(req.query.date)
    if (!date) { res.status(400).json({ error: 'invalid_date' }); return }
    const body = buildXImportFile(await loadXImportEntries(date))
    // Latin-1: the content is ASCII-only (accents are stripped by the builder),
    // but the accounting import expects a single-byte encoding, not UTF-8.
    res.setHeader('Content-Type', 'text/plain; charset=iso-8859-1')
    res.setHeader('Content-Disposition', 'attachment; filename="XImport.txt"')
    res.end(Buffer.from(body, 'latin1'))
  } catch (err) {
    console.error('Error building XImport file:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  LIST  (one bucket per call: ?status=prov|def)
// ════════════════════════════════════════════════════════

router.get('/', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(String(req.query.status ?? 'def')) ?? 'def'
    const t = TBL[kind]
    const q = String(req.query.q ?? '').trim()
    const typeFilter = String(req.query.type ?? 'all') // 'facture' | 'avoir' | 'all'
    const limitRaw = parseInt(String(req.query.limit ?? ''), 10)
    const limit = isNaN(limitRaw) ? 200 : Math.min(Math.max(limitRaw, 1), 500)
    const isSearching = q.length > 0

    const whereParts: string[] = [`f.IDsociete = ${scope.societe}`]
    if (typeFilter === 'facture') whereParts.push('f.TYPE = 1')
    else if (typeFilter === 'avoir') whereParts.push('f.TYPE = 2')

    if (isSearching) {
      const orParts: string[] = []
      if (/^\d+$/.test(q)) orParts.push(`f.numero = ${parseInt(q, 10)}`)
      const clientRows = await query<{ IDclient: number; nom: string | null }>(
        `SELECT IDclient, nom FROM client WHERE est_visible = 1`,
      )
      const fixedClients = await fixEncoding(clientRows, 'client', 'IDclient', ['nom'])
      const nq = norm(q)
      const matchIds = fixedClients
        .filter((c) => norm((c.nom ?? '').toString()).includes(nq))
        .map((c) => Number(c.IDclient))
        .filter((x) => x > 0)
      if (matchIds.length > 0) orParts.push(`f.IDclient IN (${matchIds.join(',')})`)
      if (orParts.length === 0) { res.json([]); return }
      whereParts.push(`(${orParts.join(' OR ')})`)
    }

    const whereSql = `WHERE ${whereParts.join(' AND ')}`
    // SELECT * is safe on both header tables (no accented columns). DATE/TYPE
    // come back uppercase (reserved words).
    const factures = await query<any>(
      `SELECT TOP ${limit} * FROM ${t.table} f ${whereSql} ORDER BY f.${t.pk} DESC`,
    )

    const ids = factures.map((f: any) => Number(f[t.pk])).filter(Boolean)
    const clientIds = factures.map((f: any) => Number(f.IDclient)).filter(Boolean)
    const [clientNames, tvaMap, totalsMap, envoyeIds] = await Promise.all([
      resolveClientNames(clientIds),
      loadTvaMap(),
      lineTotals(kind, ids),
      // "Envoyé" flag — definitive only: at least one envoi_email row logged
      // for this facture (IDreference = IDfacture, shared with the legacy
      // app's own send log). Proformas never log (id-space collision — see
      // file header), so the prov bucket reports everything as sent.
      (async () => {
        if (kind !== 'def' || ids.length === 0) return new Set<number>()
        const rows = await query<{ IDreference: number }>(
          `SELECT DISTINCT IDreference FROM envoi_email
           WHERE IDtype_doc = ${TYPE_DOC_FACTURE} AND IDreference IN (${ids.join(',')})`,
        )
        return new Set(rows.map((r) => Number(r.IDreference)))
      })(),
    ])

    const result = factures.map((f: any) => {
      const id = Number(f[t.pk])
      const totals = totalsMap.get(id) ?? { total_ht: 0, nb_lignes: 0 }
      const tva = tvaMap.get(Number(f.IDtva)) ?? { valeur: 0, libelle: '' }
      const tvaAmount = round2(totals.total_ht * (tva.valeur / 100))
      return {
        id,
        kind,
        numero: displayNumero(kind, id, f.numero),
        date: f.DATE ?? null,
        IDclient: Number(f.IDclient) || 0,
        client_nom: clientNames.get(Number(f.IDclient)) ?? '',
        type: Number(f.TYPE) || 1,
        tva_rate: tva.valeur,
        total_ht: totals.total_ht,
        total_tva: tvaAmount,
        total_ttc: round2(totals.total_ht + tvaAmount),
        nb_lignes: totals.nb_lignes,
        est_envoye: kind === 'def' ? (envoyeIds.has(id) ? 1 : 0) : 1,
      }
    })
    res.json(result)
  } catch (err) {
    console.error('Error fetching factures:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  DETAIL
// ════════════════════════════════════════════════════════

/** Domain kind of a facture line, for the UI's per-line icon: resolved through
 *  ligne_expedition → ligne_commande_client.TYPE (1 = écru / tombé métier,
 *  2 = fini). Manual lines (frais de port, refacturations… IDligne_expedition
 *  = 0) and unresolvable links fall back to 'divers'. */
type LineStockKind = 'fini' | 'ecru' | 'divers'

async function resolveLineStockKinds(leIds: number[]): Promise<Map<number, LineStockKind>> {
  const out = new Map<number, LineStockKind>()
  const ids = Array.from(new Set(leIds.filter((x) => x > 0)))
  if (ids.length === 0) return out
  const leToLcc = new Map<number, number>()
  for (const chunk of chunks(ids)) {
    const rows = await query<any>(
      `SELECT IDligne_expedition, IDligne_commande_client FROM ligne_expedition WHERE IDligne_expedition IN (${chunk.join(',')})`,
    )
    for (const r of rows) leToLcc.set(Number(r.IDligne_expedition), Number(r.IDligne_commande_client) || 0)
  }
  const lccIds = Array.from(new Set(Array.from(leToLcc.values()).filter((x) => x > 0)))
  const lccKind = new Map<number, LineStockKind>()
  for (const chunk of chunks(lccIds)) {
    // TYPE is a reserved word — alias it or it comes back uppercase-only.
    const rows = await query<any>(
      `SELECT IDligne_commande_client, TYPE AS type_kind FROM ligne_commande_client WHERE IDligne_commande_client IN (${chunk.join(',')})`,
    )
    for (const r of rows) {
      // TYPE 4 appears only on TRM orders (175 lines live, none ever shipped)
      // and points at the same ref_ecru / colori_ecru catalog as TYPE 1 — it is
      // écru counted per piece rather than per Kg. Same glyph.
      const tk = Number(r.type_kind) || 0
      lccKind.set(Number(r.IDligne_commande_client), tk === 1 || tk === 4 ? 'ecru' : tk === 2 ? 'fini' : 'divers')
    }
  }
  for (const [le, lcc] of leToLcc) out.set(le, lccKind.get(lcc) ?? 'divers')
  return out
}

async function loadFactureLines(kind: Kind, id: number): Promise<Array<{
  IDligne_facture: number; IDligne_expedition: number; designation: string | null
  quantite: number; unite: string; prix: number; montant: number; stock_kind: LineStockKind
}>> {
  const t = TBL[kind]
  const rows = await query<any>(
    `SELECT ${t.linePk}, ${t.lineFk}, IDligne_expedition, designation, quantite, unite, prix
     FROM ${t.lineTable} WHERE ${t.lineFk} = ${id} ORDER BY ${t.linePk}`,
  )
  // fixEncoding needs the REAL pk column name in its WHERE — pass t.linePk.
  const fixed = await fixEncoding(rows, t.lineTable, t.linePk, ['designation', 'unite'])
  const kinds = await resolveLineStockKinds(fixed.map((r: any) => Number(r.IDligne_expedition) || 0))
  return fixed.map((r: any) => {
    const qty = Number(r.quantite) || 0
    const prix = Number(r.prix) || 0
    const leId = Number(r.IDligne_expedition) || 0
    return {
      IDligne_facture: Number(r[t.linePk]),
      IDligne_expedition: leId,
      designation: r.designation ?? null,
      quantite: qty,
      unite: (r.unite ?? '').toString(),
      // `prix` stays raw so the proforma edit dialog round-trips the stored
      // value untouched; only the montant is computed at invoice precision.
      prix,
      montant: lineMontant(qty, prix),
      stock_kind: kinds.get(leId) ?? 'divers',
    }
  })
}

router.get('/:kind/:id', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const t = TBL[kind]
    const rows = await query<any>(`SELECT * FROM ${t.table} WHERE ${t.pk} = ${id}`)
    if (rows.length === 0) { res.status(404).json(NOT_FOUND); return }
    const h = rows[0]
    // Cross-ledger guard — the PK space is shared by all sociétés (see inScope).
    if (Number(h.IDsociete) !== scope.societe) { res.status(404).json(NOT_FOUND); return }
    const IDclient = Number(h.IDclient) || 0

    const [clientNames, adr, lignes, tvaMap, modePaiement, echeance, codeComptable] = await Promise.all([
      resolveClientNames([IDclient]),
      loadAdresse(Number(h.IDadresse) || 0),
      loadFactureLines(kind, id),
      loadTvaMap(),
      loadModePaiementLabel(Number(h.IDmode_paiement) || 0),
      loadEcheanceRule(Number(h.IDecheance) || 0),
      loadCodeComptableLabel(Number(h.IDcode_comptable) || 0),
    ])

    const tva = tvaMap.get(Number(h.IDtva)) ?? { valeur: 0, libelle: '' }
    const totalHt = round2(lignes.reduce((s, l) => s + l.montant, 0))
    const tvaAmount = round2(totalHt * (tva.valeur / 100))

    res.json({
      id,
      kind,
      IDclient,
      client_nom: clientNames.get(IDclient) ?? '',
      // Proforma display number = the PK (what the legacy app shows), NOT the
      // numero column — see displayNumero.
      numero: displayNumero(kind, id, h.numero),
      date: h.DATE ?? null,
      type: Number(h.TYPE) || 1,
      IDadresse: Number(h.IDadresse) || 0,
      IDmode_paiement: Number(h.IDmode_paiement) || 0,
      mode_paiement_label: modePaiement,
      IDecheance: Number(h.IDecheance) || 0,
      echeance_label: echeance?.libelle ?? null,
      date_echeance: computeDateEcheance(h.DATE, echeance),
      IDtva: Number(h.IDtva) || 0,
      tva_rate: tva.valeur,
      tva_label: tva.libelle,
      num_tva: (h.num_tva ?? '').toString(),
      IDcode_comptable: Number(h.IDcode_comptable) || 0,
      code_comptable_label: codeComptable,
      adresse_facturation: adr,
      lignes,
      total_ht: totalHt,
      total_tva: tvaAmount,
      total_ttc: round2(totalHt + tvaAmount),
    })
  } catch (err) {
    console.error('Error fetching facture detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  BATCH  (proforma ledger only — the definitive ledger is immutable)
// ════════════════════════════════════════════════════════

/** POST /prov/generate — port of the legacy FI_Facturation_ETM auto-generation.
 *  Two passes over the two shipment ledgers, both marking their sources
 *  est_facture = 1 (the flag legacy reads):
 *
 *  FORMELLE (`expedition`) — every not-yet-invoiced shipment, grouped BY CLIENT:
 *  ONE proforma per client whose lines mirror the expedition lines (designation
 *  = article + V/ref + N°/V/commande + Avis, quantite = shipped Kg/Ml from the
 *  rolls, prix from the commande line).
 *
 *  DIVERS (`expedition_divers`) — ONE proforma PER SHIPMENT, not per client.
 *  That grouping is legacy's, and it is forced by the schema: the link back to
 *  the shipment is the header column `IDexpedition_divers`, which holds a
 *  single id (535 legacy factures, exactly one shipment each, and never mixing
 *  in a formelle line). Lines mirror the cartons' `ref_divers_expedie` articles
 *  with the price frozen at ship time. `expedition_divers` has NO IDsociete
 *  column — misc shipments are ETM-only — so this pass is skipped entirely on
 *  the TRM mount.
 *
 *  Skipped in both passes: clients internes (client.client_interne = 1),
 *  donations (expedition.donation = 1 OR commande_client.donation = 1), and
 *  shipments with nothing on them (left unmarked so a later run picks them up).
 *  Frais de port are charged ONCE per commande across both passes — a commande
 *  shipped both ways in the same run must not pay them twice. */
router.post('/prov/generate', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditFactures(req, res))) return
    // 1. Candidate expeditions (formelle, ETM, not yet invoiced).
    const expRows = await query<any>(
      `SELECT IDexpedition, IDcommande_client, donation FROM expedition
       WHERE IDsociete = ${scope.societe} AND (est_facture IS NULL OR est_facture = 0)`,
    )
    let skippedDonation = 0
    let skippedInterne = 0
    let skippedVide = 0
    const candidates: Array<{ id: number; cmdId: number }> = []
    for (const e of expRows) {
      if ((Number(e.donation) || 0) === 1) { skippedDonation++; continue }
      candidates.push({ id: Number(e.IDexpedition), cmdId: Number(e.IDcommande_client) || 0 })
    }

    // 2. Their commandes (donation flag + client + the N°/V/Commande strings
    //    + frais_port for the shipping-cost line).
    const cmdMap = new Map<number, { IDclient: number; numero: number | null; ref_client: string; donation: number; frais_port: number }>()
    for (const chunk of chunks(Array.from(new Set(candidates.map((e) => e.cmdId).filter((x) => x > 0))))) {
      const rows = await query<any>(
        `SELECT IDcommande_client, IDclient, numero, ref_client, donation, frais_port FROM commande_client WHERE IDcommande_client IN (${chunk.join(',')})`,
      )
      for (const r of await fixEncoding(rows, 'commande_client', 'IDcommande_client', ['ref_client'])) {
        cmdMap.set(Number(r.IDcommande_client), {
          IDclient: Number(r.IDclient) || 0,
          numero: r.numero != null ? Number(r.numero) : null,
          ref_client: (r.ref_client ?? '').toString().trim(),
          donation: Number(r.donation) || 0,
          frais_port: Number(r.frais_port) || 0,
        })
      }
    }

    // 3. Their clients (interne flag + name for the summary).
    const clientMap = new Map<number, { nom: string; interne: number }>()
    for (const chunk of chunks(Array.from(new Set(Array.from(cmdMap.values()).map((c) => c.IDclient).filter((x) => x > 0))))) {
      const rows = await query<any>(
        `SELECT IDclient, nom, client_interne FROM client WHERE IDclient IN (${chunk.join(',')})`,
      )
      for (const r of await fixEncoding(rows, 'client', 'IDclient', ['nom'])) {
        clientMap.set(Number(r.IDclient), { nom: (r.nom ?? '').toString().trim(), interne: Number(r.client_interne) || 0 })
      }
    }

    // 4. Partition: skip internes / donations, group the rest by client.
    const byClient = new Map<number, Array<{ id: number; cmdId: number }>>()
    for (const e of candidates) {
      const cmd = cmdMap.get(e.cmdId)
      if (!cmd || !(cmd.IDclient > 0) || !clientMap.has(cmd.IDclient)) { skippedVide++; continue }
      if (cmd.donation === 1) { skippedDonation++; continue }
      if (clientMap.get(cmd.IDclient)!.interne === 1) { skippedInterne++; continue }
      const arr = byClient.get(cmd.IDclient) ?? []
      arr.push(e)
      byClient.set(cmd.IDclient, arr)
    }

    // Per-request catalog caches for the designation builder.
    const refFiniCache = new Map<number, { reference: string; designation: string; avec: number }>()
    const refEcruCache = new Map<number, { reference: string; designation: string }>()
    const coloriEcruCache = new Map<number, string>()
    const refFiniColoriCache = new Map<number, string>()
    const desigClientCache = new Map<number, string>()

    async function coloriEcruRef(id: number): Promise<string> {
      if (!(id > 0)) return ''
      if (!coloriEcruCache.has(id)) {
        const rows = await query<any>(`SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru = ${id}`)
        const c = (await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference']))[0] as any
        coloriEcruCache.set(id, (c?.reference ?? '').toString().trim())
      }
      return coloriEcruCache.get(id)!
    }

    interface GenLine { leId: number; designation: string; quantite: number; unite: string; prix: number }

    /** One facture line for one ligne_expedition — null when nothing shipped. */
    async function lineFor(leId: number, lccId: number, expId: number, cmd: { numero: number | null; ref_client: string }): Promise<GenLine | null> {
      if (!(leId > 0 && lccId > 0)) return null
      const lccRows = await query<any>(
        `SELECT IDligne_commande_client, IDdesignation_client, TYPE AS type_kind, IDreference, IDcolori, unite, prix
         FROM ligne_commande_client WHERE IDligne_commande_client = ${lccId}`,
      )
      if (lccRows.length === 0) return null
      const lcc = lccRows[0]
      // TYPE 4 is a TRM-only variant of the écru line (same ref_ecru /
      // colori_ecru catalog, counted per piece instead of per Kg). No TYPE-4
      // line has ever reached a ligne_expedition, so this branch is currently
      // unexercised — it is here so that if one ever ships it is invoiced
      // rather than silently dropped (a dropped line leaves the expedition
      // un-marked and the client under-billed).
      const typeKind = Number(lcc.type_kind) || 0
      const kind = typeKind === 1 || typeKind === 4 ? 'ecru' : typeKind === 2 ? 'fini' : 'none'
      if (kind === 'none') return null
      const refId = Number(lcc.IDreference) || 0
      const colId = Number(lcc.IDcolori) || 0

      // Shipped quantity = Σ of the rolls' poids (Kg) or metrage (Ml).
      const dim = Number(lcc.unite) === 3 ? 'metrage' : 'poids'
      const rollRows = kind === 'fini'
        ? await query<any>(`SELECT poids, metrage FROM stock_fini WHERE IDligne_expedition = ${leId}`)
        : await query<any>(`SELECT poids, metrage FROM stock_ecru WHERE ${scope.ecruShipmentFk} = ${leId}`)
      if (rollRows.length === 0) return null
      const qty = Math.round(rollRows.reduce((s: number, r: any) => s + (Number(r[dim]) || 0), 0) * 100) / 100

      // Article label — mirrors the legacy generated designations:
      //   fini → "REF - COLORIS DESIGNATION", écru → "REF COLORIS".
      let artLabel = ''
      if (kind === 'fini') {
        if (refId > 0 && !refFiniCache.has(refId)) {
          const rows = await query<any>(`SELECT IDref_fini, reference, designation, avec_teinture FROM ref_fini WHERE IDref_fini = ${refId}`)
          const rf = (await fixEncoding(rows, 'ref_fini', 'IDref_fini', ['reference', 'designation']))[0] as any
          refFiniCache.set(refId, {
            reference: (rf?.reference ?? '').toString().trim(),
            designation: (rf?.designation ?? '').toString().trim(),
            avec: Number(rf?.avec_teinture) || 0,
          })
        }
        const rf = refFiniCache.get(refId)
        let coloris = ''
        if (colId > 0) {
          if ((rf?.avec ?? 0) === 0) {
            // Wash-only fini → coloris lives in the écru catalog (avec_teinture rule).
            coloris = await coloriEcruRef(colId)
          } else {
            if (!refFiniColoriCache.has(colId)) {
              const rows = await query<any>(`SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori = ${colId}`)
              const c = (await fixEncoding(rows, 'ref_fini_colori', 'IDref_fini_colori', ['reference']))[0] as any
              refFiniColoriCache.set(colId, (c?.reference ?? '').toString().trim())
            }
            coloris = refFiniColoriCache.get(colId)!
          }
        }
        artLabel = [rf?.reference ?? '', [coloris, rf?.designation ?? ''].filter(Boolean).join(' ')].filter(Boolean).join(' - ')
      } else {
        if (refId > 0 && !refEcruCache.has(refId)) {
          const rows = await query<any>(`SELECT IDref_ecru, reference, designation FROM ref_ecru WHERE IDref_ecru = ${refId}`)
          const re = (await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['reference', 'designation']))[0] as any
          refEcruCache.set(refId, { reference: (re?.reference ?? '').toString().trim(), designation: (re?.designation ?? '').toString().trim() })
        }
        const re = refEcruCache.get(refId)
        const coloris = await coloriEcruRef(colId)
        artLabel = [re?.reference ?? '', coloris].filter(Boolean).join(' ')
      }

      // "V/ref : …" — the client-side article reference.
      const desigId = Number(lcc.IDdesignation_client) || 0
      if (desigId > 0 && !desigClientCache.has(desigId)) {
        const rows = await query<any>(`SELECT IDdesignation_client, designation FROM designation_client WHERE IDdesignation_client = ${desigId}`)
        const dc = (await fixEncoding(rows, 'designation_client', 'IDdesignation_client', ['designation']))[0] as any
        desigClientCache.set(desigId, (dc?.designation ?? '').toString().trim())
      }
      const vref = desigId > 0 ? desigClientCache.get(desigId)! : ''

      const parts = [artLabel || `Ligne ${lccId}`]
      if (vref) parts.push(`V/ref : ${vref}`)
      let cmdLine = cmd.numero != null ? `N/Commande : ${cmd.numero}` : ''
      if (cmd.ref_client) cmdLine += `${cmdLine ? ' ' : ''}V/Commande : ${cmd.ref_client}`
      if (cmdLine) parts.push(cmdLine)
      parts.push(`Avis : ${expId}`)

      return {
        leId,
        designation: parts.join('\r\n'),
        quantite: qty,
        unite: uniteLabel(lcc.unite),
        prix: Number(lcc.prix) || 0,
      }
    }

    /** Insert one proforma header + its lines, return the new PK.
     *  `expDivers` is the `expedition_divers` this proforma invoices (0 for the
     *  formelle pass) — the same header back-pointer the definitive ledger
     *  uses, carried over verbatim on conversion. */
    async function insertProforma(clientId: number, lines: GenLine[], expDivers: number): Promise<number> {
      const bd = await clientBillingDefaults(scope, clientId)
      const date = todayDigits()
      let newNumero = 0
      let inserted = false
      let lastErr: unknown = null
      for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
        newNumero = await nextNumero(scope, 'prov')
        try {
          await query(
            `INSERT INTO facture_prov
               (IDsociete, numero, IDclient, IDadresse, IDmode_paiement, IDecheance,
                DATE, IDtva, num_tva, TYPE, IDcode_comptable, IDexpedition_divers)
             VALUES
               (${scope.societe}, ${newNumero}, ${clientId}, ${bd.idAdresse}, ${bd.idMode}, ${bd.idEcheance},
                '${date}', ${bd.idTva}, ${sqlText(bd.numTva)}, 1, ${bd.idCode}, ${expDivers})`,
          )
          inserted = true
        } catch (e) { lastErr = e }
      }
      if (!inserted) throw lastErr ?? new Error('insert failed after 3 attempts')
      const newRows = await query<any>(
        `SELECT IDfacture_prov FROM facture_prov WHERE IDsociete = ${scope.societe} AND numero = ${newNumero} ORDER BY IDfacture_prov DESC`,
      )
      const newId = Number(newRows[0]?.IDfacture_prov) || 0
      if (!newId) throw new Error('could not resolve new facture_prov id')

      for (const l of lines) {
        await query(
          `INSERT INTO ligne_facture_prov (IDfacture_prov, IDligne_expedition, designation, quantite, unite, prix)
           VALUES (${newId}, ${l.leId}, ${sqlText(l.designation)}, ${l.quantite}, ${sqlText(l.unite)}, ${l.prix})`,
        )
      }
      return newId
    }

    /** Commandes whose frais de port this run has already billed — a commande
     *  shipped both formelle and divers must not be charged twice. */
    const portBilled = new Set<number>()

    // 5. One proforma per client (formelle pass).
    const created: Array<{ id: number; numero: number; client_nom: string; nb_lignes: number; nb_expeditions: number; divers: boolean }> = []
    for (const [clientId, group] of byClient) {
      group.sort((a, b) => a.id - b.id)
      const lines: GenLine[] = []
      const contributing = new Set<number>()
      const contributingCmds: number[] = [] // insertion-ordered, deduped below
      for (const e of group) {
        const cmd = cmdMap.get(e.cmdId)!
        const leRows = await query<any>(
          `SELECT IDligne_expedition, IDligne_commande_client FROM ligne_expedition WHERE IDexpedition = ${e.id} ORDER BY IDligne_expedition`,
        )
        for (const le of leRows) {
          const line = await lineFor(Number(le.IDligne_expedition) || 0, Number(le.IDligne_commande_client) || 0, e.id, cmd)
          if (line) {
            lines.push(line)
            contributing.add(e.id)
            if (!contributingCmds.includes(e.cmdId)) contributingCmds.push(e.cmdId)
          }
        }
      }
      // Nothing shipped for this client → no proforma, expeditions stay open.
      skippedVide += group.length - contributing.size
      if (lines.length === 0) continue

      // Frais de port — legacy charges it on every invoicing run: ONE line per
      // contributing commande with frais_port > 0 (never multiplied by the
      // number of expeditions; verified against the live definitive ledger).
      for (const cmdId of contributingCmds) {
        const port = cmdMap.get(cmdId)?.frais_port ?? 0
        if (port > 0 && !portBilled.has(cmdId)) {
          lines.push({ leId: 0, designation: 'Frais de port', quantite: 1, unite: '', prix: port })
          portBilled.add(cmdId)
        }
      }

      const newId = await insertProforma(clientId, lines, 0)
      // Mark the expeditions invoiced (the flag both apps read).
      for (const eid of contributing) {
        await query(`UPDATE expedition SET est_facture = 1 WHERE IDexpedition = ${eid}`)
      }

      created.push({
        id: newId,
        // Display number = the PK (legacy convention), not the internal
        // numero sequence — see displayNumero.
        numero: newId,
        client_nom: clientMap.get(clientId)?.nom ?? '',
        nb_lignes: lines.length,
        nb_expeditions: contributing.size,
        divers: false,
      })
    }

    // 6. Divers pass — misc shipments (expedition_divers), ONE proforma each.
    //    ETM-only: the table has no IDsociete column, so the TRM mount must not
    //    read or write it at all.
    if (scope.societe === 1) {
      const diversRaw = await query<any>(
        `SELECT IDexpedition_divers, IDclient, IDcommande_client, ref_client FROM expedition_divers
         WHERE est_facture IS NULL OR est_facture = 0 ORDER BY IDexpedition_divers`,
      )
      const diversHeads = await fixEncoding(diversRaw, 'expedition_divers', 'IDexpedition_divers', ['ref_client'])

      /** Unit price of a shipped article: the price frozen on the shipment,
       *  falling back to the tarif_divers grid when it carries none. 375 of the
       *  2 904 shipped articles have no price (still happening — 2 of the last
       *  100 shipments), and invoicing those at 0 € would silently under-bill.
       *  Same rule as the divers order line: never re-derive a real price, only
       *  refill a stored 0. Memoised — the grid read is per (ref, v1, v2). */
      const prixCache = new Map<string, number>()
      async function diversPrix(it: DiversItem): Promise<number> {
        if (it.prix > 0) return it.prix
        if (!(it.IDref_divers > 0)) return 0
        const key = `${it.IDref_divers}|${it.IDVariation1}|${it.IDVariation2}`
        if (!prixCache.has(key)) {
          prixCache.set(key, await resolveDiversPrix(it.IDref_divers, it.IDVariation1, it.IDVariation2))
        }
        return prixCache.get(key)!
      }

      // Top up the commande / client caches with what only this pass needs.
      const newCmdIds = Array.from(new Set(
        (diversHeads as any[]).map((h) => Number(h.IDcommande_client) || 0).filter((x) => x > 0 && !cmdMap.has(x)),
      ))
      for (const chunk of chunks(newCmdIds)) {
        const rows = await query<any>(
          `SELECT IDcommande_client, IDclient, numero, ref_client, donation, frais_port FROM commande_client WHERE IDcommande_client IN (${chunk.join(',')})`,
        )
        for (const r of await fixEncoding(rows, 'commande_client', 'IDcommande_client', ['ref_client'])) {
          cmdMap.set(Number(r.IDcommande_client), {
            IDclient: Number(r.IDclient) || 0,
            numero: r.numero != null ? Number(r.numero) : null,
            ref_client: (r.ref_client ?? '').toString().trim(),
            donation: Number(r.donation) || 0,
            frais_port: Number(r.frais_port) || 0,
          })
        }
      }
      const newClientIds = Array.from(new Set(
        (diversHeads as any[])
          .map((h) => Number(h.IDclient) || cmdMap.get(Number(h.IDcommande_client) || 0)?.IDclient || 0)
          .filter((x) => x > 0 && !clientMap.has(x)),
      ))
      for (const chunk of chunks(newClientIds)) {
        const rows = await query<any>(
          `SELECT IDclient, nom, client_interne FROM client WHERE IDclient IN (${chunk.join(',')})`,
        )
        for (const r of await fixEncoding(rows, 'client', 'IDclient', ['nom'])) {
          clientMap.set(Number(r.IDclient), { nom: (r.nom ?? '').toString().trim(), interne: Number(r.client_interne) || 0 })
        }
      }

      for (const h of diversHeads as any[]) {
        const expId = Number(h.IDexpedition_divers) || 0
        if (!(expId > 0)) continue
        const cmdId = Number(h.IDcommande_client) || 0
        const cmd = cmdId > 0 ? cmdMap.get(cmdId) : undefined
        // The shipment carries its own client; the commande is only a fallback
        // (a divers shipment can exist without one).
        const clientId = Number(h.IDclient) || cmd?.IDclient || 0
        if (!(clientId > 0) || !clientMap.has(clientId)) { skippedVide++; continue }
        if (cmd?.donation === 1) { skippedDonation++; continue }
        if (clientMap.get(clientId)!.interne === 1) { skippedInterne++; continue }

        const cartonRows = await query<any>(
          `SELECT IDligne_expedition_divers FROM ligne_expedition_divers WHERE IDexpedition_divers = ${expId} ORDER BY IDligne_expedition_divers`,
        )
        const cartonIds = cartonRows.map((c: any) => Number(c.IDligne_expedition_divers) || 0).filter((x: number) => x > 0)
        const itemsByCarton = await loadDiversItems(cartonIds)

        // The commande line, exactly as legacy writes it: present iff the
        // shipment is attached to a commande, and then carrying BOTH segments
        // even when the client's reference is empty ("N/Commande : 2921
        // V/Commande : ", facture 4000). A shipment with no commande gets no
        // line at all — legacy does NOT fall back to expedition_divers.ref_client
        // even when it holds something (avis 372 carries "C2968 et C2987" and
        // its facture prints only the article + "Avis : 372").
        const cmdLine = cmd
          ? `N/Commande : ${cmd.numero ?? ''} V/Commande : ${cmd.ref_client}`
          : ''

        // The invoice bills ARTICLES, not cartons: the same article split over
        // several cartons is ONE line carrying the total. Verified on the live
        // ledger (facture 5098 bills "Col R006-46 L/XL - GRIS 8985" 320 for
        // carton 1130's 125 + carton 1131's 195). Keyed on the printed label +
        // unit + unit price, so two rows priced differently stay apart, and in
        // first-appearance order.
        const merged = new Map<string, GenLine>()
        for (const cartonId of cartonIds) {
          for (const it of itemsByCarton.get(cartonId) ?? []) {
            const label = diversArticleLabel(it) || `Article ${it.IDref_divers_expedie}`
            const unite = diversUniteLabel(it.unite)
            const prix = await diversPrix(it)
            const key = `${label} ${unite} ${prix}`
            const existing = merged.get(key)
            if (existing) {
              existing.quantite = Math.round((existing.quantite + it.quantite) * 100) / 100
              continue
            }
            const parts = [label]
            if (cmdLine) parts.push(cmdLine)
            parts.push(`Avis : ${expId}`)
            merged.set(key, {
              // No per-line FK on this ledger — the link is the header's
              // IDexpedition_divers (legacy leaves IDligne_expedition at 0).
              leId: 0,
              designation: parts.join('\r\n'),
              quantite: it.quantite,
              unite,
              prix, // frozen at ship time, grid only when the article carries none
            })
          }
        }
        const lines: GenLine[] = Array.from(merged.values())
        // Empty shipment (no carton, or cartons with no article) → no proforma,
        // and it stays open so a later run picks it up once filled.
        if (lines.length === 0) { skippedVide++; continue }

        if (cmdId > 0 && !portBilled.has(cmdId)) {
          const port = cmd?.frais_port ?? 0
          if (port > 0) {
            lines.push({ leId: 0, designation: 'Frais de port', quantite: 1, unite: '', prix: port })
            portBilled.add(cmdId)
          }
        }

        const newId = await insertProforma(clientId, lines, expId)
        await query(`UPDATE expedition_divers SET est_facture = 1 WHERE IDexpedition_divers = ${expId}`)

        created.push({
          id: newId,
          numero: newId,
          client_nom: clientMap.get(clientId)?.nom ?? '',
          nb_lignes: lines.length,
          nb_expeditions: 1,
          divers: true,
        })
      }
    }

    res.json({ created, skipped: { internes: skippedInterne, donations: skippedDonation, vides: skippedVide } })
  } catch (err) {
    console.error('Error generating proformas:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Delete the given proformas (headers + lines) and reset est_facture = 0
 *  on expeditions no longer referenced by any surviving invoice line — neither
 *  a DEFINITIVE ligne_facture (e.g. via a converted proforma) nor a
 *  ligne_facture_prov belonging to a proforma outside the deleted set (matters
 *  when the caller deletes a subset). Divers shipments are reopened on the same
 *  rule, read through the header column IDexpedition_divers instead.
 *  Callers must pass verified-existing ids. */
async function wipeOpenProformas(targetIds: number[]): Promise<{ deleted: number; expeditions_reouvertes: number }> {
  if (targetIds.length === 0) return { deleted: 0, expeditions_reouvertes: 0 }
  const targetSet = new Set(targetIds)

  // Expeditions referenced by the lines we're about to delete.
  const leIds = new Set<number>()
  for (const chunk of chunks(targetIds)) {
    const rows = await query<any>(
      `SELECT IDligne_expedition FROM ligne_facture_prov WHERE IDfacture_prov IN (${chunk.join(',')}) AND IDligne_expedition > 0`,
    )
    for (const r of rows) leIds.add(Number(r.IDligne_expedition))
  }
  const expIds = new Set<number>()
  for (const chunk of chunks(Array.from(leIds))) {
    const rows = await query<any>(
      `SELECT IDexpedition FROM ligne_expedition WHERE IDligne_expedition IN (${chunk.join(',')})`,
    )
    for (const r of rows) expIds.add(Number(r.IDexpedition))
  }

  // Keep est_facture=1 on expeditions still covered by a surviving line —
  // only reset the truly un-invoiced ones.
  let reopened = 0
  if (expIds.size > 0) {
    const allLe = new Map<number, number>() // every le of the affected expeditions → exp
    for (const chunk of chunks(Array.from(expIds))) {
      const rows = await query<any>(
        `SELECT IDligne_expedition, IDexpedition FROM ligne_expedition WHERE IDexpedition IN (${chunk.join(',')})`,
      )
      for (const r of rows) allLe.set(Number(r.IDligne_expedition), Number(r.IDexpedition))
    }
    const stillLinked = new Set<number>()
    for (const chunk of chunks(Array.from(allLe.keys()))) {
      const defRows = await query<any>(
        `SELECT IDligne_expedition FROM ligne_facture WHERE IDligne_expedition IN (${chunk.join(',')})`,
      )
      for (const r of defRows) stillLinked.add(allLe.get(Number(r.IDligne_expedition)) ?? 0)
      const provRows = await query<any>(
        `SELECT IDfacture_prov, IDligne_expedition FROM ligne_facture_prov WHERE IDligne_expedition IN (${chunk.join(',')})`,
      )
      for (const r of provRows) {
        if (!targetSet.has(Number(r.IDfacture_prov))) stillLinked.add(allLe.get(Number(r.IDligne_expedition)) ?? 0)
      }
    }
    const toReopen = Array.from(expIds).filter((e) => !stillLinked.has(e))
    for (const chunk of chunks(toReopen)) {
      await query(`UPDATE expedition SET est_facture = 0 WHERE IDexpedition IN (${chunk.join(',')})`)
    }
    reopened = toReopen.length
  }

  // Same for the divers ledger, where the link is the header column
  // IDexpedition_divers (no per-line FK exists on that side).
  const diversIds = new Set<number>()
  for (const chunk of chunks(targetIds)) {
    const rows = await query<any>(
      `SELECT IDexpedition_divers FROM facture_prov WHERE IDfacture_prov IN (${chunk.join(',')}) AND IDexpedition_divers > 0`,
    )
    for (const r of rows) diversIds.add(Number(r.IDexpedition_divers))
  }
  if (diversIds.size > 0) {
    const ids = Array.from(diversIds)
    const stillLinked = new Set<number>()
    for (const chunk of chunks(ids)) {
      const defRows = await query<any>(
        `SELECT IDexpedition_divers FROM facture WHERE IDexpedition_divers IN (${chunk.join(',')})`,
      )
      for (const r of defRows) stillLinked.add(Number(r.IDexpedition_divers))
      const provRows = await query<any>(
        `SELECT IDfacture_prov, IDexpedition_divers FROM facture_prov WHERE IDexpedition_divers IN (${chunk.join(',')})`,
      )
      for (const r of provRows) {
        if (!targetSet.has(Number(r.IDfacture_prov))) stillLinked.add(Number(r.IDexpedition_divers))
      }
    }
    const toReopen = ids.filter((e) => !stillLinked.has(e))
    for (const chunk of chunks(toReopen)) {
      await query(`UPDATE expedition_divers SET est_facture = 0 WHERE IDexpedition_divers IN (${chunk.join(',')})`)
    }
    reopened += toReopen.length
  }

  for (const chunk of chunks(targetIds)) {
    await query(`DELETE FROM ligne_facture_prov WHERE IDfacture_prov IN (${chunk.join(',')})`)
    await query(`DELETE FROM facture_prov WHERE IDfacture_prov IN (${chunk.join(',')})`)
  }
  return { deleted: targetIds.length, expeditions_reouvertes: reopened }
}

/** DELETE /prov/all — wipe every proforma. Expeditions whose lines were only
 *  referenced by the deleted proformas get est_facture reset to 0 so the next
 *  generation run picks them up again. Must register BEFORE the generic
 *  /:kind/:id delete. */
router.delete('/prov/all', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditFactures(req, res))) return
    const heads = await query<any>(`SELECT IDfacture_prov FROM facture_prov WHERE IDsociete = ${scope.societe}`)
    const ids = heads.map((h: any) => Number(h.IDfacture_prov))
    const r = await wipeOpenProformas(ids)
    res.json({ deleted: r.deleted, expeditions_reouvertes: r.expeditions_reouvertes })
  } catch (err) {
    console.error('Error deleting proformas:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** POST /prov/delete-batch — delete a user-selected set of proformas. Unknown
 *  ids in the payload are skipped rather than erroring: the list the user
 *  picked from may be stale. Registered near the other /prov/* batch routes;
 *  the generic POST /:kind only matches a single path segment so there is no
 *  routing conflict. */
router.post('/prov/delete-batch', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditFactures(req, res))) return
    const parsed = batchIdsBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const requested = Array.from(new Set(parsed.data.ids))
    const found: number[] = []
    for (const chunk of chunks(requested)) {
      const heads = await query<any>(
        `SELECT IDfacture_prov FROM facture_prov WHERE IDfacture_prov IN (${chunk.join(',')}) AND IDsociete = ${scope.societe}`,
      )
      for (const h of heads) found.push(Number(h.IDfacture_prov))
    }
    const r = await wipeOpenProformas(found)
    res.json({ deleted: r.deleted, expeditions_reouvertes: r.expeditions_reouvertes })
  } catch (err) {
    console.error('Error batch-deleting proformas:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  HEADER CRUD
// ════════════════════════════════════════════════════════

router.post('/:kind', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditFactures(req, res))) return
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const t = TBL[kind]
    const parsed = factureBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    if (!d.IDclient) { res.status(400).json({ error: 'IDclient is required' }); return }
    const type = d.type === 2 ? 2 : 1
    const date = d.date ? dateStr(d.date) || todayDigits() : todayDigits()

    // Auto-fill billing defaults from the client row (explicit cols — SELECT *
    // fails on client). The société TVA/code default backstops a blank client.
    const bd = await clientBillingDefaults(scope, n(d.IDclient))
    const idAdresse = d.IDadresse ?? bd.idAdresse
    const idTva = d.IDtva ?? bd.idTva
    const idMode = d.IDmode_paiement ?? bd.idMode
    const idEcheance = d.IDecheance ?? bd.idEcheance
    const idCode = d.IDcode_comptable ?? bd.idCode
    const numTva = d.num_tva ?? bd.numTva

    // numero allocator with collision retry. DATE / TYPE written uppercase
    // (reserved words). IDexpedition_divers is written 0 (unused legacy col).
    // facture also has IDcommande_client (= 0); facture_prov does not.
    let newNumero = 0
    let inserted = false
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      newNumero = await nextNumero(scope, kind)
      const cols = kind === 'def'
        ? `(IDsociete, numero, IDclient, IDadresse, IDmode_paiement, IDecheance,
            DATE, IDtva, num_tva, TYPE, IDcode_comptable, IDexpedition_divers, IDcommande_client)`
        : `(IDsociete, numero, IDclient, IDadresse, IDmode_paiement, IDecheance,
            DATE, IDtva, num_tva, TYPE, IDcode_comptable, IDexpedition_divers)`
      const vals = kind === 'def'
        ? `(${scope.societe}, ${newNumero}, ${n(d.IDclient)}, ${n(idAdresse)}, ${n(idMode)}, ${n(idEcheance)},
            '${date}', ${n(idTva)}, ${sqlText(numTva)}, ${type}, ${n(idCode)}, 0, 0)`
        : `(${scope.societe}, ${newNumero}, ${n(d.IDclient)}, ${n(idAdresse)}, ${n(idMode)}, ${n(idEcheance)},
            '${date}', ${n(idTva)}, ${sqlText(numTva)}, ${type}, ${n(idCode)}, 0)`
      try {
        await query(`INSERT INTO ${t.table} ${cols} VALUES ${vals}`)
        inserted = true
      } catch (e) { lastErr = e }
    }
    if (!inserted) throw lastErr ?? new Error('insert failed after 3 attempts')

    const newRows = await query<any>(
      `SELECT ${t.pk} FROM ${t.table} WHERE IDsociete = ${scope.societe} AND numero = ${newNumero} ORDER BY ${t.pk} DESC`,
    )
    res.status(201).json({ id: Number(newRows[0]?.[t.pk]) || 0, kind })
  } catch (err) {
    console.error('Error creating facture:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/:kind/:id', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditFactures(req, res))) return
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    // Lock: the definitive ledger is read-only.
    if (kind === 'def') { res.status(409).json(DEF_LOCK); return }
    if (!(await inScope(scope, kind, id))) { res.status(404).json(NOT_FOUND); return }

    const parsed = factureBody.partial().safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data

    const sets: string[] = []
    if (d.date !== undefined) sets.push(`DATE = '${dateStr(d.date)}'`)
    if (d.type !== undefined) sets.push(`TYPE = ${d.type === 2 ? 2 : 1}`)
    if (d.IDadresse !== undefined) sets.push(`IDadresse = ${n(d.IDadresse)}`)
    if (d.IDmode_paiement !== undefined) sets.push(`IDmode_paiement = ${n(d.IDmode_paiement)}`)
    if (d.IDecheance !== undefined) sets.push(`IDecheance = ${n(d.IDecheance)}`)
    if (d.IDtva !== undefined) sets.push(`IDtva = ${n(d.IDtva)}`)
    if (d.IDcode_comptable !== undefined) sets.push(`IDcode_comptable = ${n(d.IDcode_comptable)}`)
    if (d.num_tva !== undefined) sets.push(`num_tva = ${sqlText(d.num_tva)}`)
    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }

    await query(`UPDATE ${TBL[kind].table} SET ${sets.join(', ')} WHERE ${TBL[kind].pk} = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating facture:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/:kind/:id', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditFactures(req, res))) return
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    // Lock: the definitive ledger can't be deleted from.
    if (kind === 'def') { res.status(409).json(DEF_LOCK); return }
    if (!(await inScope(scope, kind, id))) { res.status(404).json(NOT_FOUND); return }

    const t = TBL[kind]
    await query(`DELETE FROM ${t.lineTable} WHERE ${t.lineFk} = ${id}`)
    await query(`DELETE FROM ${t.table} WHERE ${t.pk} = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting facture:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  CONVERT  (proforma → definitive facture)
// ════════════════════════════════════════════════════════

/** Move ONE proforma into the definitive ledger: copy the header (fresh
 *  definitive numero) + lines into facture/ligne_facture, then DELETE the
 *  proforma. Expeditions stay est_facture = 1 — their ligne_expedition ids are
 *  now referenced by ligne_facture rows, and a divers shipment by the copied
 *  IDexpedition_divers header back-pointer (which is also what makes the
 *  invoice show up in Expéditions › onglet Factures). Returns null when the
 *  proforma does not exist (stale id from a batch picker). */
async function convertProforma(id: number): Promise<{ IDfacture: number; numero: number } | null> {
  const provRows = await query<any>(`SELECT * FROM facture_prov WHERE IDfacture_prov = ${id} AND IDsociete = ${scope.societe}`)
  if (provRows.length === 0) return null
  const p = provRows[0]

  const lignes = await loadFactureLines('prov', id)
  const type = Number(p.TYPE) === 2 ? 2 : 1
  // Issue date carries over the (editable) proforma date; today as fallback.
  const date = /^\d{8}$/.test(String(p.DATE ?? '')) ? String(p.DATE) : todayDigits()
  const numTva = (p.num_tva ?? '').toString()

  // Allocate a definitive numero (facture sequence) with collision retry.
  let newNumero = 0
  let inserted = false
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
    newNumero = await nextNumero(scope, 'def')
    try {
      await query(
        `INSERT INTO facture
           (IDsociete, numero, IDclient, IDadresse, IDmode_paiement, IDecheance,
            DATE, IDtva, num_tva, TYPE, IDcode_comptable, IDexpedition_divers, IDcommande_client)
         VALUES
           (${scope.societe}, ${newNumero}, ${n(p.IDclient)}, ${n(p.IDadresse)}, ${n(p.IDmode_paiement)}, ${n(p.IDecheance)},
            '${date}', ${n(p.IDtva)}, ${sqlText(numTva)}, ${type}, ${n(p.IDcode_comptable)}, ${n(p.IDexpedition_divers)}, 0)`,
      )
      inserted = true
    } catch (e) { lastErr = e }
  }
  if (!inserted) throw lastErr ?? new Error('insert failed after 3 attempts')

  const newRows = await query<{ IDfacture: number }>(
    `SELECT IDfacture FROM facture WHERE IDsociete = ${scope.societe} AND numero = ${newNumero} ORDER BY IDfacture DESC`,
  )
  const newId = Number(newRows[0]?.IDfacture) || 0
  if (!newId) throw new Error('could not resolve new facture id')

  // Copy lines (designation/unite re-encoded via sqlText after fixEncoding read).
  for (const l of lignes) {
    await query(
      `INSERT INTO ligne_facture (IDfacture, IDligne_expedition, designation, quantite, unite, prix)
       VALUES (${newId}, ${n(l.IDligne_expedition)}, ${sqlText(l.designation ?? '')}, ${Number(l.quantite) || 0}, ${sqlText(l.unite ?? '')}, ${Number(l.prix) || 0})`,
    )
  }

  // The proforma has served its purpose — remove it (lines first, then header).
  await query(`DELETE FROM ligne_facture_prov WHERE IDfacture_prov = ${id}`)
  await query(`DELETE FROM facture_prov WHERE IDfacture_prov = ${id}`)

  return { IDfacture: newId, numero: newNumero }
}

router.post('/prov/:id/convert', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditFactures(req, res))) return
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const r = await convertProforma(id)
    if (!r) { res.status(404).json({ error: 'Proforma not found' }); return }
    res.json(r)
  } catch (err) {
    console.error('Error converting proforma:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** POST /prov/convert-batch — convert a user-selected set of proformas, each
 *  into its own definitive facture. Unknown ids are skipped (stale picker).
 *  Returns the created invoices with client names for the summary dialog. */
router.post('/prov/convert-batch', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditFactures(req, res))) return
    const parsed = batchIdsBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const requested = Array.from(new Set(parsed.data.ids))

    // Resolve client names up front (the proforma rows are gone after convert).
    const clientByProv = new Map<number, number>()
    for (const chunk of chunks(requested)) {
      const heads = await query<any>(
        `SELECT IDfacture_prov, IDclient FROM facture_prov WHERE IDfacture_prov IN (${chunk.join(',')}) AND IDsociete = ${scope.societe}`,
      )
      for (const h of heads) clientByProv.set(Number(h.IDfacture_prov), Number(h.IDclient) || 0)
    }
    const clientNames = await resolveClientNames(Array.from(clientByProv.values()))

    const converted: Array<{ prov_id: number; IDfacture: number; numero: number; client_nom: string }> = []
    for (const id of requested) {
      if (!clientByProv.has(id)) continue
      const r = await convertProforma(id)
      if (r) {
        converted.push({
          prov_id: id,
          IDfacture: r.IDfacture,
          numero: r.numero,
          client_nom: clientNames.get(clientByProv.get(id) ?? 0) ?? '',
        })
      }
    }
    res.json({ converted, skipped: requested.length - converted.length })
  } catch (err) {
    console.error('Error batch-converting proformas:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  AVOIR  (definitive facture → prefilled proforma credit note)
// ════════════════════════════════════════════════════════

/** POST /def/:id/avoir — create a proforma Avoir prefilled from a definitive
 *  facture: billing header fields are copied as-is, every line is duplicated
 *  (amounts stay positive — the credit sign is presentational), DATE is today.
 *  The result is a normal editable proforma: the user trims the lines to what
 *  is actually reimbursed, then converts it like any other proforma. */
router.post('/def/:id/avoir', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditFactures(req, res))) return
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await query<any>(`SELECT * FROM facture WHERE IDfacture = ${id} AND IDsociete = ${scope.societe}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Facture not found' }); return }
    const f = rows[0]
    if (Number(f.TYPE) === 2) {
      res.status(409).json({ error: 'facture_avoir', message: 'Ce document est déjà un avoir.' })
      return
    }

    const lignes = await loadFactureLines('def', id)
    const numTva = (f.num_tva ?? '').toString()

    // Allocate a proforma numero (vestigial internal sequence) with retry.
    // IDexpedition_divers is deliberately NOT copied: the avoir credits an
    // invoice, it does not invoice the shipment a second time — carrying the
    // back-pointer over would make deleting the avoir reopen a shipment that
    // is still invoiced, and converting it would attach two factures to it.
    let newNumero = 0
    let inserted = false
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      newNumero = await nextNumero(scope, 'prov')
      try {
        await query(
          `INSERT INTO facture_prov
             (IDsociete, numero, IDclient, IDadresse, IDmode_paiement, IDecheance,
              DATE, IDtva, num_tva, TYPE, IDcode_comptable, IDexpedition_divers)
           VALUES
             (${scope.societe}, ${newNumero}, ${n(f.IDclient)}, ${n(f.IDadresse)}, ${n(f.IDmode_paiement)}, ${n(f.IDecheance)},
              '${todayDigits()}', ${n(f.IDtva)}, ${sqlText(numTva)}, 2, ${n(f.IDcode_comptable)}, 0)`,
        )
        inserted = true
      } catch (e) { lastErr = e }
    }
    if (!inserted) throw lastErr ?? new Error('insert failed after 3 attempts')

    const newRows = await query<{ IDfacture_prov: number }>(
      `SELECT IDfacture_prov FROM facture_prov WHERE IDsociete = ${scope.societe} AND numero = ${newNumero} ORDER BY IDfacture_prov DESC`,
    )
    const newId = Number(newRows[0]?.IDfacture_prov) || 0
    if (!newId) throw new Error('could not resolve new proforma id')

    // Duplicate the lines. IDligne_expedition carries over so the credited
    // shipment lines stay traceable (and keep their stock-kind icon); the
    // original facture still references them, so deleting this avoir never
    // reopens an expedition (wipeOpenProformas checks the definitive ledger).
    for (const l of lignes) {
      await query(
        `INSERT INTO ligne_facture_prov (IDfacture_prov, IDligne_expedition, designation, quantite, unite, prix)
         VALUES (${newId}, ${n(l.IDligne_expedition)}, ${sqlText(l.designation ?? '')}, ${Number(l.quantite) || 0}, ${sqlText(l.unite ?? '')}, ${Number(l.prix) || 0})`,
      )
    }

    res.status(201).json({ id: newId, kind: 'prov' as const })
  } catch (err) {
    console.error('Error creating avoir from facture:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  LINE CRUD
// ════════════════════════════════════════════════════════

router.post('/:kind/:id/lignes', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditFactures(req, res))) return
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (kind === 'def') { res.status(409).json(DEF_LOCK); return }
    if (!(await inScope(scope, kind, id))) { res.status(404).json(NOT_FOUND); return }

    const parsed = ligneBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    const t = TBL[kind]
    await query(
      `INSERT INTO ${t.lineTable} (${t.lineFk}, IDligne_expedition, designation, quantite, unite, prix)
       VALUES (${id}, 0, ${sqlText(d.designation ?? '')}, ${Number(d.quantite) || 0}, ${sqlText(d.unite ?? '')}, ${Number(d.prix) || 0})`,
    )
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('Error adding facture line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/:kind/lignes/:lineId', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditFactures(req, res))) return
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (kind === 'def') { res.status(409).json(DEF_LOCK); return }
    const parentId = await provLineParent(lineId)
    if (parentId === 0 || !(await inScope(scope, kind, parentId))) { res.status(404).json({ error: 'Line not found' }); return }

    const parsed = ligneBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    const sets: string[] = []
    if (d.designation !== undefined) sets.push(`designation = ${sqlText(d.designation)}`)
    if (d.quantite !== undefined) sets.push(`quantite = ${Number(d.quantite) || 0}`)
    if (d.unite !== undefined) sets.push(`unite = ${sqlText(d.unite)}`)
    if (d.prix !== undefined) sets.push(`prix = ${Number(d.prix) || 0}`)
    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }
    await query(`UPDATE ${TBL[kind].lineTable} SET ${sets.join(', ')} WHERE ${TBL[kind].linePk} = ${lineId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating facture line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/:kind/lignes/:lineId', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditFactures(req, res))) return
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (kind === 'def') { res.status(409).json(DEF_LOCK); return }
    const parentId = await provLineParent(lineId)
    if (parentId === 0 || !(await inScope(scope, kind, parentId))) { res.status(404).json({ error: 'Line not found' }); return }

    await query(`DELETE FROM ${TBL[kind].lineTable} WHERE ${TBL[kind].linePk} = ${lineId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting facture line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  PDF
// ════════════════════════════════════════════════════════

async function buildFacturePdfData(kind: Kind, id: number): Promise<FacturePdfData | null> {
  const t = TBL[kind]
  const rows = await query<any>(`SELECT * FROM ${t.table} WHERE ${t.pk} = ${id}`)
  if (rows.length === 0) return null
  const h = rows[0]
  // Cross-ledger guard: never render another société's invoice through this
  // router (its footer/IBAN would be this société's — a forged document).
  if (Number(h.IDsociete) !== scope.societe) return null
  const IDclient = Number(h.IDclient) || 0

  const [clientNames, adr, lignes, tvaMap, modePaiement, echeance] = await Promise.all([
    resolveClientNames([IDclient]),
    loadAdresse(Number(h.IDadresse) || 0),
    loadFactureLines(kind, id),
    loadTvaMap(),
    loadModePaiementLabel(Number(h.IDmode_paiement) || 0),
    loadEcheanceRule(Number(h.IDecheance) || 0),
  ])
  const tva = tvaMap.get(Number(h.IDtva)) ?? { valeur: 0, libelle: '' }

  const a = adr as any
  const cleanAddr = a ? {
    nom: cleanAddrField(a.nom), adresse1: cleanAddrField(a.adresse1), adresse2: cleanAddrField(a.adresse2),
    adresse3: cleanAddrField(a.adresse3), cp: cleanAddrField(a.cp), ville: cleanAddrField(a.ville), pays: cleanAddrField(a.pays),
  } : null

  return {
    numero: String(displayNumero(kind, id, h.numero) ?? id),
    type: Number(h.TYPE) || 1,
    isProforma: kind === 'prov',
    dateFacture: formatHfsqlDateLongFr(h.DATE),
    clientNom: clientNames.get(IDclient) ?? '',
    numTva: (h.num_tva ?? '').toString() || null,
    adresseFacturation: cleanAddr,
    modePaiement,
    echeance: echeance?.libelle ?? null,
    echeanceDate: computeDateEcheance(h.DATE, echeance),
    tvaRate: tva.valeur,
    // The issuing société's legal identity (footer SIRET/TVA + the IBAN the
    // client is asked to pay). Not branding — a Tricotage Malterre invoice
    // carrying ETM's bank details would be paid into the wrong account.
    company: scope.company,
    lignes: lignes.map((l) => ({ designation: l.designation ?? '', quantite: l.quantite, unite: l.unite, prix: l.prix, montant: l.montant })),
  }
}

async function renderFacturePdfBuffer(data: FacturePdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(FacturePdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

router.get('/:kind/:id/pdf', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const data = await buildFacturePdfData(kind, id)
    if (!data) { res.status(404).json({ error: 'Facture not found' }); return }
    const buffer = await renderFacturePdfBuffer(data)
    const word = data.isProforma ? 'proforma' : (data.type === 2 ? 'avoir' : 'facture')
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${word}-${data.numero}.pdf"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering facture PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  EMAIL  (both kinds — proforma sends are not logged; see header note)
// ════════════════════════════════════════════════════════

interface EmailRecipientPayload { email: string; name?: string; source: 'contact'; contactId: number }

async function buildEmailDefaults(kind: Kind, id: number): Promise<{
  recipients: { selected: EmailRecipientPayload[]; suggestions: EmailRecipientPayload[] }
  subject: string; body: string; clientNom: string; numero: string
} | null> {
  const t = TBL[kind]
  const rows = await query<{ IDclient: number; numero: number | null; TYPE: number | null; IDsociete: number }>(
    `SELECT IDclient, numero, TYPE, IDsociete FROM ${t.table} WHERE ${t.pk} = ${id}`,
  )
  if (rows.length === 0) return null
  if (Number(rows[0].IDsociete) !== scope.societe) return null
  const IDclient = Number(rows[0].IDclient) || 0
  const numero = String(displayNumero(kind, id, rows[0].numero) ?? id)
  const isAvoir = Number(rows[0].TYPE) === 2
  const isProforma = kind === 'prov'
  const docWord = (isAvoir ? 'avoir' : 'facture') + (isProforma ? ' proforma' : '')

  const [clientNames, contactRows] = await Promise.all([
    resolveClientNames([IDclient]),
    query<{ IDcontact: number; nom: string | null; prenom: string | null; mail: string | null; envoi_facture: number | null; est_visible: number | null }>(
      `SELECT IDcontact, nom, prenom, mail, envoi_facture, est_visible FROM contact WHERE IDclient = ${IDclient}`,
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
    if (c.envoi_facture === 1) selected.push(recipient)
    else suggestions.push(recipient)
  }

  const docCap = (isAvoir ? 'Avoir' : 'Facture') + (isProforma ? ' proforma' : '')
  const subject = `${docCap} N°${numero} — ${scope.brand}`
  const body =
    `Bonjour,\n\n` +
    `Veuillez trouver ci-joint notre ${docWord} N°${numero}.\n\n` +
    `Bonne réception,\n` +
    `Belle journée,`
  return { recipients: { selected, suggestions }, subject, body, clientNom, numero }
}

router.get('/:kind/:id/email-defaults', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const defaults = await buildEmailDefaults(kind, id)
    if (!defaults) { res.status(404).json({ error: 'Facture not found' }); return }
    res.json(defaults)
  } catch (err) {
    console.error('Error building facture email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

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
           VALUES ('${ts}', ${sqlText(addr)}, ${sqlText(societe || '')}, ${idReference}, 0, '', ${TYPE_DOC_FACTURE})`,
        )
      } else {
        await query(
          `INSERT INTO envoi_email (DATE, adresse, IDreference, notes, IDtype_doc)
           VALUES ('${ts}', ${sqlText(addr)}, ${idReference}, '', ${TYPE_DOC_FACTURE})`,
        )
      }
    } catch (e) {
      console.error(`envoi_email log failed (facture/${idReference}/${addr}):`, (e as Error).message)
    }
  }
}

router.post('/:kind/:id/email', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    if (!(await inScope(scope, kind, id))) { res.status(404).json(NOT_FOUND); return }
    const parsed = emailBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const devSkip = parsed.data.dev_skip_send === true && ALLOW_DEV_SKIP_SEND

    let messageId: string
    if (devSkip) {
      messageId = `dev-skip-${Date.now()}`
      console.log(`[dev-skip-send] facture #${id} — fake send to ${parsed.data.to.join(', ')}`)
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
      const fromName = displayName ? `${displayName} — ${scope.brand}` : scope.brand

      const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
      if (parsed.data.attach_pdf !== false) {
        const data = await buildFacturePdfData(kind, id)
        if (!data) { res.status(404).json({ error: 'Facture not found' }); return }
        const buffer = await renderFacturePdfBuffer(data)
        const word = data.isProforma ? 'proforma' : (data.type === 2 ? 'avoir' : 'facture')
        attachments.push({ filename: `${word}-${data.numero}.pdf`, content: buffer, contentType: 'application/pdf' })
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

    // envoi_email history is definitive-only: prov and def share a numeric id
    // space on the same IDtype_doc, so logging a proforma send would collide
    // with a definitive facture's history (see file header note).
    if (kind === 'def') {
      const allRecipients = [...parsed.data.to, ...(parsed.data.cc ?? [])]
      let societe = ''
      try {
        const cr = await query<{ IDclient: number }>(`SELECT IDclient FROM facture WHERE IDfacture = ${id}`)
        const names = await resolveClientNames([Number(cr[0]?.IDclient) || 0])
        societe = names.get(Number(cr[0]?.IDclient) || 0) ?? ''
      } catch { /* informational */ }
      await logEnvoiEmails(id, allRecipients, societe)
    }

    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending facture email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})

// ════════════════════════════════════════════════════════
//  HISTORIQUE  (envoi_email timeline — definitive only)
// ════════════════════════════════════════════════════════

router.get('/:kind/:id/historique', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    // Proforma rows never log emails; their id space would otherwise collide
    // with definitive ids on the shared envoi_email IDtype_doc. Return empty.
    if (kind === 'prov') { res.json([]); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await inScope(scope, kind, id))) { res.status(404).json(NOT_FOUND); return }
    const rows = await query<{ adresse: string | null; DATE: string | null }>(
      `SELECT adresse, DATE FROM envoi_email WHERE IDreference = ${id} AND IDtype_doc = ${TYPE_DOC_FACTURE}`,
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
      .map((e) => ({ kind: 'email' as const, type_label: 'Document envoyé', recipients: e.recipients, DATE: e.DATE }))
      .sort((a, b) => (a.DATE < b.DATE ? 1 : -1))
    res.json(events)
  } catch (err) {
    console.error('Error fetching facture historique:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

  return router
}

// ── The two mounted instances ────────────────────────────
// `/api/factures` (ETM web) and `/api/factures-trm` (TRM web). Same surface,
// same code path; only `FacturesScope` differs. See index.ts for the mounts.
export const facturesRouter: RouterType = createFacturesRouter(SCOPE_ETM)
export const facturesTrmRouter: RouterType = createFacturesRouter(SCOPE_TRM)
