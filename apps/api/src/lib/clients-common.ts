// Shared plumbing for the two "Gestion client" ledgers served by this API:
// `routes/clients.ts`   → ETM  (IDsociete = 1, consumed by mpsng)
// `routes/clients-trm.ts` → TRM (IDsociete = 2, consumed by TRM (trm.malterre))
//
// The `client` table is partitioned by IDsociete but its footguns are not — the
// accented columns, the Windows/Linux SELECT split and the polymorphic
// contact/adresse CRUD are identical on both sides, so they live here once.
//
// Hard rules baked in (see CLAUDE.md § HFSQL rules + claude_doc/hfsql_odbc.md):
//  - `SELECT * FROM client` returns 0 rows on the WINDOWS ODBC driver — name
//    explicit columns there. On the LINUX bridge SELECT * works but accented
//    column NAMES (`archivé`, `bloqué`) are rejected/truncated (→ `archiv`,
//    `bloqu`). So we NEVER name an accented column in a SELECT list.
//  - Accented text VALUES are written as Latin-1 hex literals via sqlText()
//    (raw multi-byte UTF-8 corrupts the Linux bridge).

import type { Request, Response, Router as RouterType } from 'express'
import { query, queryB64Text } from './hfsql-auto.js'
import { IS_WINDOWS, esc } from './sst-shared.js'
import { userHasPermission } from './permissions.js'
import type { PermissionKey } from './permission-keys.js'
import { isEffectiveAdmin } from './auth.js'

// ── Small SQL/format helpers ───────────────────────────

/** SQL literal for a user-supplied text value. Pure ASCII → quoted literal;
 *  anything with accents → Latin-1 hex literal (the Linux iODBC bridge corrupts
 *  raw multi-byte UTF-8 embedded in a SQL line). */
export function sqlText(value: string | null | undefined): string {
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

export const numOf = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

export const strOf = (v: unknown): string | null => {
  if (v == null) return null
  return String(v)
}

/** Read a value off a row by trying several candidate keys (covers the
 *  platform-specific accented-name truncation: `archivé` vs `archiv`). */
export function pick(r: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (k in r && r[k] != null) return r[k]
  }
  return undefined
}

export function todayDigits(): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

/** Date input from the FE arrives as 8 digits (YYYYMMDD) or ''. Keep digits only. */
export function dateDigitsOnly(v: unknown): string {
  const s = String(v ?? '').replace(/[^0-9]/g, '')
  return s.length === 8 ? s : ''
}

export const flag = (v: unknown): number => (v === true || v === 1 || v === '1' ? 1 : 0)
export const intOf = (v: unknown): number => { const x = parseInt(String(v ?? ''), 10); return Number.isFinite(x) ? x : 0 }
export const floatOf = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0 }

// ── Permission guard ───────────────────────────────────

/** 401/403 guard for a permission-gated route. Returns true when the request
 *  may proceed (the response is already sent otherwise). */
export async function requirePermission(req: Request, res: Response, key: PermissionKey): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), key)
  if (!allowed) {
    res.status(403).json({ error: `permission denied: ${key}` })
    return false
  }
  return true
}

// ── Accent repair for a client list ────────────────────

/** Batched accent repair for a client list: one CONVERT query for all rows
 *  whose `nom` came back with U+FFFD, instead of per-row (avoids an N+1 flood
 *  of the shared Linux bridge — CLAUDE.md "batch the repair" rule). */
export async function repairNames(rows: { IDclient: number; nom: string | null }[]): Promise<void> {
  const broken = rows
    .filter((r) => typeof r.nom === 'string' && r.nom.includes('�'))
    .map((r) => r.IDclient)
    .filter((id) => Number.isInteger(id))
  if (broken.length === 0) return
  try {
    const conv = await query<{ IDclient: number; nom: string | null }>(
      `SELECT IDclient, CONVERT(nom USING 'UTF-8') AS nom FROM client WHERE IDclient IN (${broken.join(',')})`,
    )
    const m = new Map<number, string>()
    for (const c of conv) if (c.nom != null) m.set(Number(c.IDclient), String(c.nom))
    for (const r of rows) {
      const f = m.get(r.IDclient)
      if (f != null) r.nom = f
    }
  } catch {
    // keep original (a leftover U+FFFD glyph is cosmetic)
  }
}

// ── Delete-vs-archive ──────────────────────────────────

/** A client with commandes or marchandise (client-owned finished rolls) can
 *  never be hard-deleted — only archived. Marchandise shipped to the client
 *  always hangs off a commande_client, so the two counts cover everything the
 *  history sub-views show. Deliberately NOT scoped by IDsociete: a client row
 *  is owned by exactly one ledger, so its activity is all in that ledger. */
export async function countClientActivity(id: number): Promise<{ commandes: number; marchandises: number }> {
  const [cc, sf] = await Promise.all([
    query<{ nb: number }>(`SELECT COUNT(*) AS nb FROM commande_client WHERE IDclient = ${id}`),
    query<{ nb: number }>(`SELECT COUNT(*) AS nb FROM stock_fini WHERE IDProprietaire = ${id}`),
  ])
  return { commandes: numOf(cc[0]?.nb), marchandises: numOf(sf[0]?.nb) }
}

// ── Accented boolean flags (archivé / bloqué) ──────────

/** Physical text/blob columns of `client` (from ODBC column metadata). Only the
 *  Linux flag path needs this typing — the reinsert order itself comes from the
 *  runtime SELECT * key order. All text/blob columns of `client` have ASCII
 *  names; the two accented columns (archivé, bloqué) are numeric flags. */
const CLIENT_TEXT_COLS = new Set([
  'nom', 'tel', 'fax', 'num_tva', 'commentaire', 'compte', 'rib', 'domiciliation',
  'login', 'mot_de_passe', 'date_creation', 'dernier_contact', 'journal_commercial',
])
const CLIENT_BLOB_COLS = new Set(['CleComp'])

/** The two accented boolean columns of `client`, with the prefix used to find
 *  them in a Linux `SELECT *` row (the bridge truncates the last character). */
const CLIENT_FLAG_COLUMNS = {
  archive: { sql: 'archivé', prefix: /^archiv/i },
  bloque: { sql: 'bloqué', prefix: /^bloqu/i },
} as const

export type ClientFlag = keyof typeof CLIENT_FLAG_COLUMNS

/** Set `client.archivé` or `client.bloqué`. Windows: named UPDATE (accented
 *  identifiers work there). Linux: the bridge rejects any accented identifier,
 *  so — same pattern as references-ecru.ts setArchive — read the row via
 *  SELECT * (values arrive in physical column order; queryB64Text keeps
 *  accented VALUES lossless as Latin-1), flip the flag slot, then delete +
 *  positional reinsert preserving the PK (FKs stay valid).
 *
 *  Returns false when the row is missing. Callers that also write plain columns
 *  must do that UPDATE *first* — this re-reads the row it reinserts. */
export async function setClientFlag(id: number, which: ClientFlag, value: 0 | 1): Promise<boolean> {
  const col = CLIENT_FLAG_COLUMNS[which]
  if (IS_WINDOWS) {
    const exists = await query<{ IDclient: number }>(`SELECT IDclient FROM client WHERE IDclient = ${id}`)
    if (exists.length === 0) return false
    await query(`UPDATE client SET ${col.sql} = ${value} WHERE IDclient = ${id}`)
    return true
  }
  const rows = await queryB64Text<Record<string, unknown>>(`SELECT * FROM client WHERE IDclient = ${id}`)
  if (rows.length === 0) return false
  const keys = Object.keys(rows[0])
  const vals = Object.values(rows[0])
  const idx = keys.findIndex((k) => col.prefix.test(k))
  if (idx === -1) throw new Error(`client.${col.sql} column not found — refusing positional reinsert`)
  vals[idx] = value
  const literals = vals.map((v, i) => {
    const key = keys[i]
    if (CLIENT_BLOB_COLS.has(key)) {
      if (v == null) return "''"
      const buf = Buffer.isBuffer(v) ? v
        : v instanceof ArrayBuffer ? Buffer.from(v)
        : Buffer.from(String(v), 'latin1')
      return buf.length > 0 ? `x'${buf.toString('hex')}'` : "''"
    }
    if (CLIENT_TEXT_COLS.has(key)) {
      if (v == null) return "''"
      const s = v instanceof ArrayBuffer ? Buffer.from(v).toString('latin1') : String(v)
      return sqlText(s)
    }
    const n = Number(v)
    return Number.isFinite(n) ? String(n) : '0'
  })
  await query(`DELETE FROM client WHERE IDclient = ${id}`)
  await query(`INSERT INTO client VALUES (${literals.join(', ')})`)
  return true
}

/** Read one accented flag without naming it in a SELECT list. Windows uses a
 *  WHERE-only probe (WHERE tolerates the accent there); Linux reads the
 *  truncated key off a `SELECT *` row it already has. */
export async function readClientFlag(id: number, which: ClientFlag, linuxRow?: Record<string, unknown>): Promise<0 | 1> {
  const col = CLIENT_FLAG_COLUMNS[which]
  if (IS_WINDOWS) {
    const hit = await query<{ IDclient: number }>(
      `SELECT IDclient FROM client WHERE IDclient = ${id} AND ${col.sql} = 1`,
    )
    return hit.length > 0 ? 1 : 0
  }
  if (!linuxRow) return 0
  const key = Object.keys(linuxRow).find((k) => col.prefix.test(k))
  return key && numOf(linuxRow[key]) ? 1 : 0
}

// ── Contacts / adresses CRUD (polymorphic sub-resources) ──
//
// `contact` and `adresse` carry IDclient / IDsous_traitant / IDfournisseur /
// IDentreprise discriminators and are NOT partitioned by société — so both
// ledgers register the exact same handlers under their own mount point.

export function registerContactAdresseRoutes(router: RouterType): void {
  router.post('/:id/contacts', async (req: Request, res: Response) => {
    try {
      if (!(await requirePermission(req, res, 'crud_client_contacts'))) return
      const id = parseInt(req.params.id, 10)
      if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
      const { nom, prenom, tel, mail, envoi_bl, envoi_facture, envoi_commande, envoi_soumission } = req.body
      await query(
        `INSERT INTO contact (IDclient, nom, prenom, tel, mail, envoi_bl, envoi_facture, envoi_commande, envoi_soumission, est_defaut, est_visible) ` +
          `VALUES (${id}, ${sqlText(nom)}, ${sqlText(prenom)}, ${sqlText(tel)}, ${sqlText(mail)}, ${flag(envoi_bl)}, ${flag(envoi_facture)}, ${flag(envoi_commande)}, ${flag(envoi_soumission)}, 0, 1)`,
      )
      res.status(201).json({ ok: true })
    } catch (err) {
      console.error('Error creating contact:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  router.put('/:id/contacts/:cid', async (req: Request, res: Response) => {
    try {
      if (!(await requirePermission(req, res, 'crud_client_contacts'))) return
      const cid = parseInt(req.params.cid, 10)
      if (isNaN(cid)) { res.status(400).json({ error: 'Invalid ID' }); return }
      const { nom, prenom, tel, mail, envoi_bl, envoi_facture, envoi_commande, envoi_soumission } = req.body
      await query(
        `UPDATE contact SET nom = ${sqlText(nom)}, prenom = ${sqlText(prenom)}, tel = ${sqlText(tel)}, mail = ${sqlText(mail)}, ` +
          `envoi_bl = ${flag(envoi_bl)}, envoi_facture = ${flag(envoi_facture)}, envoi_commande = ${flag(envoi_commande)}, envoi_soumission = ${flag(envoi_soumission)} ` +
          `WHERE IDcontact = ${cid}`,
      )
      res.json({ ok: true })
    } catch (err) {
      console.error('Error updating contact:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  router.delete('/:id/contacts/:cid', async (req: Request, res: Response) => {
    try {
      if (!(await requirePermission(req, res, 'crud_client_contacts'))) return
      const cid = parseInt(req.params.cid, 10)
      if (isNaN(cid)) { res.status(400).json({ error: 'Invalid ID' }); return }
      await query(`DELETE FROM contact WHERE IDcontact = ${cid}`)
      res.json({ ok: true })
    } catch (err) {
      console.error('Error deleting contact:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  router.post('/:id/adresses', async (req: Request, res: Response) => {
    try {
      if (!(await requirePermission(req, res, 'crud_client_adresses'))) return
      const id = parseInt(req.params.id, 10)
      if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
      const { nom, adresse1, adresse2, adresse3, cp, ville, pays, commentaire, est_defaut_facturation, est_defaut_livraison } = req.body
      await query(
        `INSERT INTO adresse (IDclient, nom, adresse1, adresse2, adresse3, cp, ville, pays, commentaire, est_defaut, est_defaut_facturation, est_defaut_livraison, est_visible) ` +
          `VALUES (${id}, ${sqlText(nom)}, ${sqlText(adresse1)}, ${sqlText(adresse2)}, ${sqlText(adresse3)}, ${sqlText(cp)}, ${sqlText(ville)}, ${sqlText(pays)}, ${sqlText(commentaire)}, 0, ${flag(est_defaut_facturation)}, ${flag(est_defaut_livraison)}, 1)`,
      )
      res.status(201).json({ ok: true })
    } catch (err) {
      console.error('Error creating adresse:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  router.put('/:id/adresses/:aid', async (req: Request, res: Response) => {
    try {
      if (!(await requirePermission(req, res, 'crud_client_adresses'))) return
      const aid = parseInt(req.params.aid, 10)
      if (isNaN(aid)) { res.status(400).json({ error: 'Invalid ID' }); return }
      const { nom, adresse1, adresse2, adresse3, cp, ville, pays, commentaire, est_defaut_facturation, est_defaut_livraison } = req.body
      await query(
        `UPDATE adresse SET nom = ${sqlText(nom)}, adresse1 = ${sqlText(adresse1)}, adresse2 = ${sqlText(adresse2)}, adresse3 = ${sqlText(adresse3)}, ` +
          `cp = ${sqlText(cp)}, ville = ${sqlText(ville)}, pays = ${sqlText(pays)}, commentaire = ${sqlText(commentaire)}, ` +
          `est_defaut_facturation = ${flag(est_defaut_facturation)}, est_defaut_livraison = ${flag(est_defaut_livraison)} ` +
          `WHERE IDadresse = ${aid}`,
      )
      res.json({ ok: true })
    } catch (err) {
      console.error('Error updating adresse:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  router.delete('/:id/adresses/:aid', async (req: Request, res: Response) => {
    try {
      if (!(await requirePermission(req, res, 'crud_client_adresses'))) return
      const aid = parseInt(req.params.aid, 10)
      if (isNaN(aid)) { res.status(400).json({ error: 'Invalid ID' }); return }
      await query(`DELETE FROM adresse WHERE IDadresse = ${aid}`)
      res.json({ ok: true })
    } catch (err) {
      console.error('Error deleting adresse:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })
}
