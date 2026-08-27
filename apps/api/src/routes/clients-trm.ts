// Clients TRM — the Tricotage Malterre ledger of the shared `client` table
// (IDsociete = 2). Serves the TRM app's « Clients › Gestion » screen; ports the
// legacy `FI_Gestion_Client_TRM.wdw` window.
//
// Sibling of routes/clients.ts (IDsociete = 1, the ETM ledger). Everything that
// is identical on both sides — the HFSQL footguns, the polymorphic
// contact/adresse CRUD, the accented archivé/bloqué flags — lives in
// lib/clients-common.ts; this file only holds what is TRM-specific:
//
//  - every read/write scoped to IDsociete = 2 (including the tva and
//    code_comptable catalogs, which are partitioned too — TRM's "Vente à façon"
//    is a different row from ETM's "VENTE FACON");
//  - the billing fields the TRM fiche shows and the ETM one doesn't:
//    `rib`, `domiciliation`, `IDtransporteur`, and « Attente paiement facture »
//    (= the accented `client.bloqué` flag — verified against the legacy screen:
//    A.E.T. / IDclient 627 is the only société-2 client with bloqué = 1 and the
//    only one whose checkbox is ticked);
//  - the two center panels of the legacy window: « Historique des commandes »
//    and « Stocks de fil » (client-owned yarn lots — TRM knits à façon, so the
//    yarn in `stock_fil` belongs to the customer via `stock_fil.IDclient`).
//
// No tarifs / références / marchandise sub-views here: the TRM window has none.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { IS_WINDOWS, esc } from '../lib/sst-shared.js'
import {
  sqlText, numOf, strOf, pick, todayDigits, flag, intOf, floatOf,
  requirePermission, TRM_PERMISSIONS, repairNames, countClientActivity, setClientFlag, readClientFlag,
  registerContactAdresseRoutes,
} from '../lib/clients-common.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { loadTakenComptes, pickCompte, normalizeCompte, isValidCompte } from '../lib/compte-client.js'

export const clientsTrmRouter: RouterType = Router()

/** Tricotage Malterre. ETM = 1, Confection = 3. Every read and write below is
 *  scoped to it — a TRM screen must never reach an ETM customer. */
const SOCIETE_TRM = 2

// ── Detail column list (Windows path — no accented names) ──

const CLIENT_DETAIL_COLS = [
  'IDclient', 'nom', 'tel', 'fax', 'num_tva', 'IDtva', 'IDmode_paiement', 'IDecheance',
  'IDtransporteur', 'compte', 'IDcode_comptable', 'rib', 'domiciliation', 'pct_ajeol',
  'pct_remise', 'est_visible', 'IDsociete', 'date_creation', 'commentaire',
].join(', ')

// Columns the TRM fiche has no field for — `client_interne`, `IDsecteur_activite`,
// `IDactivite`, `journal_commercial`, `dernier_contact`, `inclureRapportQualite`,
// `pct_ajeol`. They exist on the ETM fiche, so this router must never NAME them
// in an UPDATE: an unnamed column keeps its stored value, a named one would be
// zeroed by a TRM save. (`client_interne` appears once, in the create INSERT,
// where 0 is the intended default for a brand-new row.)

const CLIENT_TEXT_FIELDS = ['nom', 'tel', 'fax', 'num_tva', 'compte', 'commentaire', 'rib', 'domiciliation']

function shapeClient(r: Record<string, unknown>) {
  return {
    IDclient: numOf(r.IDclient),
    nom: strOf(r.nom),
    tel: strOf(r.tel),
    fax: strOf(r.fax),
    num_tva: strOf(r.num_tva),
    compte: strOf(r.compte),
    commentaire: strOf(r.commentaire),
    rib: strOf(r.rib),
    domiciliation: strOf(r.domiciliation),
    pct_remise: numOf(r.pct_remise),
    pct_ajeol: numOf(r.pct_ajeol),
    IDtva: numOf(r.IDtva),
    IDmode_paiement: numOf(r.IDmode_paiement),
    IDecheance: numOf(r.IDecheance),
    IDcode_comptable: numOf(r.IDcode_comptable),
    IDtransporteur: numOf(r.IDtransporteur),
    date_creation: strOf(pick(r, 'date_creation')),
    est_visible: numOf(r.est_visible),
    IDsociete: numOf(r.IDsociete),
  }
}

/** True when the id exists in the TRM ledger. Guards every /:id route so an ETM
 *  customer id typed into a TRM URL 404s instead of being edited from here. */
async function isTrmClient(id: number): Promise<boolean> {
  const rows = await query<{ IDclient: number }>(
    `SELECT IDclient FROM client WHERE IDclient = ${id} AND IDsociete = ${SOCIETE_TRM}`,
  )
  return rows.length > 0
}

// ════════════════════════════════════════════════════════
//  LIST  — GET /api/clients-trm
// ════════════════════════════════════════════════════════
clientsTrmRouter.get('/', async (_req: Request, res: Response) => {
  try {
    let rows: Record<string, unknown>[]
    const archivedSet = new Set<number>()
    if (IS_WINDOWS) {
      rows = await query<Record<string, unknown>>(
        `SELECT IDclient, nom, tel, est_visible FROM client ` +
          `WHERE est_visible = 1 AND IDsociete = ${SOCIETE_TRM} ORDER BY nom`,
      )
      // WHERE tolerates the accented name on Windows ODBC (unlike a SELECT list).
      const arch = await query<{ IDclient: number }>(
        `SELECT IDclient FROM client WHERE est_visible = 1 AND IDsociete = ${SOCIETE_TRM} AND archivé = 1`,
      )
      for (const a of arch) archivedSet.add(Number(a.IDclient))
    } else {
      rows = await query<Record<string, unknown>>(
        `SELECT * FROM client WHERE est_visible = 1 AND IDsociete = ${SOCIETE_TRM} ORDER BY nom`,
      )
    }
    const shaped = rows.map((r) => ({
      IDclient: numOf(r.IDclient),
      nom: strOf(r.nom),
      tel: strOf(r.tel),
      // Accented names come back from the Linux bridge truncated at the accent
      // with a non-deterministic trailing byte — resolve by prefix, never by a
      // hardcoded `archiv` key (see routes/stock.ts pickVal).
      archive: IS_WINDOWS
        ? (archivedSet.has(numOf(r.IDclient)) ? 1 : 0)
        : (numOf(r[Object.keys(r).find((k) => /^archiv/i.test(k)) ?? ''] ) ? 1 : 0),
    }))
    await repairNames(shaped)
    res.json(shaped.filter((r) => r.nom != null && String(r.nom).trim().length > 0))
  } catch (err) {
    console.error('Error fetching TRM clients:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  LOOKUPS  (literal paths — must register before /:id)
// ════════════════════════════════════════════════════════

// mode_paiement and echeance are NOT partitioned — one catalog for all sociétés.
clientsTrmRouter.get('/lookups/modes-paiement', async (_req: Request, res: Response) => {
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

clientsTrmRouter.get('/lookups/echeances', async (_req: Request, res: Response) => {
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

// tva IS partitioned — société 2 has its own « Tva collectée 20 % » row (id 1),
// distinct from ETM's (id 3). Serving ETM's list here would silently rewrite a
// client's VAT to another company's row on the next save.
clientsTrmRouter.get('/lookups/tva', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDtva: number; libelle_compte: string | null; valeur: number | null }>(
      `SELECT IDtva, libelle_compte, valeur FROM tva WHERE IDsociete = ${SOCIETE_TRM} AND est_visible = 1 ORDER BY valeur`,
    )
    const fixed = await fixEncoding(rows, 'tva', 'IDtva', ['libelle_compte'])
    res.json(fixed.map((r) => ({
      IDtva: Number(r.IDtva),
      libelle: r.libelle_compte ?? '',
      valeur: Number(r.valeur) || 0,
    })))
  } catch (err) {
    console.error('Error fetching tva lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// code_comptable is partitioned too (TRM's « Vente à façon » = 701103).
clientsTrmRouter.get('/lookups/codes-comptables', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDcode_comptable: number; libelle: string | null; numero: string | null }>(
      `SELECT IDcode_comptable, libelle, numero FROM code_comptable ` +
        `WHERE IDsociete = ${SOCIETE_TRM} AND est_visible = 1 ORDER BY libelle`,
    )
    const fixed = await fixEncoding(rows, 'code_comptable', 'IDcode_comptable', ['libelle'])
    res.json(fixed.map((r) => ({
      IDcode_comptable: Number(r.IDcode_comptable),
      libelle: r.libelle ?? '',
      numero: r.numero ?? '',
    })))
  } catch (err) {
    console.error('Error fetching codes-comptables lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// transporteur — shared catalog, « Autre » block of the legacy fiche.
clientsTrmRouter.get('/lookups/transporteurs', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDtransporteur: number; nom: string | null }>(
      `SELECT IDtransporteur, nom FROM transporteur WHERE est_visible = 1 ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'transporteur', 'IDtransporteur', ['nom'])
    res.json(fixed.map((r) => ({ IDtransporteur: Number(r.IDtransporteur), nom: r.nom ?? '' })))
  } catch (err) {
    console.error('Error fetching transporteurs lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/clients-trm/comptes — every compte currently in use, normalized.
// Deliberately NOT scoped by société: the compte identifies the company in the
// shared chart of accounts, so uniqueness spans all three ledgers.
clientsTrmRouter.get('/comptes', async (_req: Request, res: Response) => {
  try {
    res.json({ comptes: [...await loadTakenComptes()] })
  } catch (err) {
    console.error('Error listing comptes clients:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/clients-trm/compte-suggestion?nom=…&exclude=…
clientsTrmRouter.get('/compte-suggestion', async (req: Request, res: Response) => {
  try {
    const nom = typeof req.query.nom === 'string' ? req.query.nom.trim() : ''
    if (!nom) { res.status(400).json({ error: 'nom is required' }); return }
    const excludeRaw = parseInt(String(req.query.exclude ?? ''), 10)
    const exclude = Number.isInteger(excludeRaw) && excludeRaw > 0 ? excludeRaw : undefined
    const taken = await loadTakenComptes(exclude)
    res.json({ compte: pickCompte(nom, taken) })
  } catch (err) {
    console.error('Error suggesting compte client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  DETAIL  — GET /api/clients-trm/:id
// ════════════════════════════════════════════════════════
clientsTrmRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }

    const sql = IS_WINDOWS
      ? `SELECT ${CLIENT_DETAIL_COLS} FROM client WHERE IDclient = ${id} AND IDsociete = ${SOCIETE_TRM}`
      : `SELECT * FROM client WHERE IDclient = ${id} AND IDsociete = ${SOCIETE_TRM}`
    const rawRows = await query<Record<string, unknown>>(sql)
    if (rawRows.length === 0) { res.status(404).json({ error: 'Client not found' }); return }
    const fixed = await fixEncoding(rawRows, 'client', 'IDclient', CLIENT_TEXT_FIELDS)
    const client = shapeClient(fixed[0])

    // archivé / bloqué are accented: neither may be named in a SELECT list.
    const [archive, bloque] = await Promise.all([
      readClientFlag(id, 'archive', rawRows[0]),
      readClientFlag(id, 'bloque', rawRows[0]),
    ])

    // contact / adresse — SELECT * works on these two tables (no accented names).
    const [adresses, contacts] = await Promise.all([
      query(`SELECT * FROM adresse WHERE IDclient = ${id} ORDER BY est_defaut DESC, IDadresse`),
      query(`SELECT * FROM contact WHERE IDclient = ${id} ORDER BY est_defaut DESC, IDcontact`),
    ])
    const fixedAdresses = await fixEncoding(adresses, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays', 'commentaire'])
    const fixedContacts = await fixEncoding(contacts, 'contact', 'IDcontact', ['nom', 'prenom', 'tel', 'mail', 'commentaire'])

    res.json({ ...client, archive, bloque, adresses: fixedAdresses, contacts: fixedContacts })
  } catch (err) {
    console.error('Error fetching TRM client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  CREATE / UPDATE / DELETE
// ════════════════════════════════════════════════════════

const createClientBody = z.object({
  nom: z.string().trim().min(1).max(100),
  /** Optional override of the auto-generated code. */
  compte: z.string().optional(),
})

const clientBody = z.object({
  nom: z.string().min(1).max(100),
  tel: z.string().optional(),
  fax: z.string().optional(),
  num_tva: z.string().optional(),
  compte: z.string().optional(),
  commentaire: z.string().optional(),
  rib: z.string().optional(),
  domiciliation: z.string().optional(),
  pct_remise: z.number().optional(),
  IDtva: z.number().int().optional(),
  IDmode_paiement: z.number().int().optional(),
  IDecheance: z.number().int().optional(),
  IDcode_comptable: z.number().int().optional(),
  IDtransporteur: z.number().int().optional(),
  /** « Attente paiement facture » — stored in the accented `client.bloqué`. */
  bloque: z.union([z.boolean(), z.number()]).optional(),
})

// POST /api/clients-trm — create a client on the TRM ledger.
clientsTrmRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = createClientBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const b = parsed.data
    const nom = b.nom

    // Resolve the compte in the same request that inserts, so the uniqueness
    // check can't be invalidated by a concurrent create in between.
    const taken = await loadTakenComptes()
    let compte: string
    if (b.compte !== undefined && b.compte.trim() !== '') {
      compte = normalizeCompte(b.compte)
      if (!isValidCompte(compte)) {
        res.status(400).json({
          error: 'compte_invalide',
          message: 'Le compte client doit commencer par 411 puis 3 lettres ou chiffres.',
        })
        return
      }
      if (taken.has(compte)) {
        res.status(409).json({
          error: 'compte_duplique',
          message: `Le compte client ${compte} est déjà attribué à un autre client.`,
        })
        return
      }
    } else {
      compte = pickCompte(nom, taken)
    }

    await query(
      `INSERT INTO client (nom, compte, est_visible, client_interne, IDsociete, date_creation) ` +
        `VALUES (${sqlText(nom)}, '${esc(compte)}', ` +
        `1, 0, ${SOCIETE_TRM}, '${todayDigits()}')`,
    )
    const rows = await query<{ IDclient: number }>(`SELECT IDclient FROM client ORDER BY IDclient DESC`)
    const newId = rows.length > 0 ? Number(rows[0].IDclient) : 0
    res.status(201).json({ IDclient: newId, nom, compte })
  } catch (err) {
    console.error('Error creating TRM client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/clients-trm/:id — update master-data fields.
//
// `nom` lives in the detail header; every other field of the fiche belongs to
// the `edit_client_info` scope. Columns outside the caller's scope are simply
// not named, so they keep their stored value — as are the columns this screen
// has no field for at all (see the CLIENT_DETAIL_COLS note above).
clientsTrmRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await isTrmClient(id))) { res.status(404).json({ error: 'Client not found' }); return }
    const parsed = clientBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const b = parsed.data

    const canInfo = await TRM_PERMISSIONS.hasPermission(req.userId, isEffectiveAdmin(req), 'edit_client_info')

    // Compte client — only reachable through the Info scope, so it is only
    // validated when the caller actually writes it. Format is enforced on every
    // save; UNIQUENESS only when the value changes (the legacy data already
    // holds duplicate codes that must stay saveable).
    let compte = ''
    if (canInfo) {
      compte = normalizeCompte(b.compte)
      if (!isValidCompte(compte)) {
        res.status(400).json({
          error: 'compte_invalide',
          message: 'Le compte client doit commencer par 411 puis 3 lettres ou chiffres.',
        })
        return
      }
      const current = await query<{ compte: unknown }>(`SELECT compte FROM client WHERE IDclient = ${id}`)
      if (current.length === 0) { res.status(404).json({ error: 'Client not found' }); return }
      if (normalizeCompte(current[0].compte == null ? '' : String(current[0].compte)) !== compte) {
        const taken = await loadTakenComptes(id)
        if (taken.has(compte)) {
          res.status(409).json({
            error: 'compte_duplique',
            message: `Le compte client ${compte} est déjà attribué à un autre client.`,
          })
          return
        }
      }
    }

    const sets = [`nom = ${sqlText(b.nom)}`]
    if (canInfo) {
      sets.push(
        `tel = ${sqlText(b.tel)}`,
        `fax = ${sqlText(b.fax)}`,
        `num_tva = ${sqlText(b.num_tva)}`,
        `compte = '${esc(compte)}'`,
        `commentaire = ${sqlText(b.commentaire)}`,
        `rib = ${sqlText(b.rib)}`,
        `domiciliation = ${sqlText(b.domiciliation)}`,
        `pct_remise = ${floatOf(b.pct_remise)}`,
        `IDtva = ${intOf(b.IDtva)}`,
        `IDmode_paiement = ${intOf(b.IDmode_paiement)}`,
        `IDecheance = ${intOf(b.IDecheance)}`,
        `IDcode_comptable = ${intOf(b.IDcode_comptable)}`,
        `IDtransporteur = ${intOf(b.IDtransporteur)}`,
      )
    }
    await query(`UPDATE client SET ${sets.join(', ')} WHERE IDclient = ${id}`)

    // « Attente paiement facture » = the accented `bloqué` column, which the
    // Linux bridge cannot name in a SET — it goes through the delete +
    // positional-reinsert helper, and MUST run after the UPDATE above (it
    // re-reads the row it reinserts).
    if (canInfo) await setClientFlag(id, 'bloque', flag(b.bloque) as 0 | 1)

    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating TRM client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Delete / archive (permission-gated: delete_client) ──

// GET /api/clients-trm/:id/deletability — drives the delete-vs-archive confirm.
clientsTrmRouter.get('/:id/deletability', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    const activity = await countClientActivity(id)
    res.json({ ...activity, deletable: activity.commandes === 0 && activity.marchandises === 0 })
  } catch (err) {
    console.error('Error checking TRM client deletability:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

clientsTrmRouter.post('/:id/archive', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await requirePermission(req, res, 'delete_client', TRM_PERMISSIONS))) return
    if (!(await isTrmClient(id))) { res.status(404).json({ error: 'Client not found' }); return }
    await setClientFlag(id, 'archive', 1)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error archiving TRM client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

clientsTrmRouter.post('/:id/unarchive', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await requirePermission(req, res, 'delete_client', TRM_PERMISSIONS))) return
    if (!(await isTrmClient(id))) { res.status(404).json({ error: 'Client not found' }); return }
    await setClientFlag(id, 'archive', 0)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error unarchiving TRM client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/clients-trm/:id — hard delete, only for clients with zero activity.
clientsTrmRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    // id <= 0 must be rejected: contact/adresse are polymorphic and store
    // IDclient = 0 for rows belonging to other parents — the cleanup below
    // would wipe them all.
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await requirePermission(req, res, 'delete_client', TRM_PERMISSIONS))) return
    if (!(await isTrmClient(id))) { res.status(404).json({ error: 'Client not found' }); return }
    const activity = await countClientActivity(id)
    if (activity.commandes > 0 || activity.marchandises > 0) {
      res.status(409).json({
        error: 'client_has_activity',
        message: 'Ce client a des commandes ou de la marchandise et ne peut pas être supprimé. Archivez-le à la place.',
        ...activity,
      })
      return
    }
    await query(`DELETE FROM client WHERE IDclient = ${id}`)
    // Orphan cleanup: contacts/adresses belong exclusively to this client.
    await query(`DELETE FROM contact WHERE IDclient = ${id}`)
    await query(`DELETE FROM adresse WHERE IDclient = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting TRM client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  HISTORIQUE DES COMMANDES  — GET /:id/historique
// ════════════════════════════════════════════════════════
// The legacy panel's columns: Date · ref interne · coloris · quantité · prix
// unitaire · Marge Brute. Unlike the ETM ledger this does NOT exclude the
// ETM-mirrored orders (IDcommande_ETM > 0): on the TRM side those ARE the work
// — every one of the 2 518 mirrors belongs to the "Ets Malterre" customer and
// is the knitting ETM ordered from TRM.

/** Label map for a catalog keyed by `reference`. */
async function mapSimpleRef(table: string, idCol: string, ids: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>()
  const uniq = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))]
  if (!uniq.length) return m
  const rows = await query<Record<string, unknown>>(`SELECT ${idCol}, reference FROM ${table} WHERE ${idCol} IN (${uniq.join(',')})`)
  const fixed = await fixEncoding(rows, table, idCol, ['reference'])
  for (const r of fixed) m.set(numOf(r[idCol]), strOf(r.reference) ?? '')
  return m
}

/** Label map for a catalog keyed by `designation` (ref_divers). */
async function mapDesignation(table: string, idCol: string, ids: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>()
  const uniq = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))]
  if (!uniq.length) return m
  const rows = await query<Record<string, unknown>>(`SELECT ${idCol}, designation FROM ${table} WHERE ${idCol} IN (${uniq.join(',')})`)
  const fixed = await fixEncoding(rows, table, idCol, ['designation'])
  for (const r of fixed) m.set(numOf(r[idCol]), strOf(r.designation) ?? '')
  return m
}

const HISTORIQUE_CAP = 120

clientsTrmRouter.get('/:id/historique', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    const heads = await query<Record<string, unknown>>(
      `SELECT TOP ${HISTORIQUE_CAP} IDcommande_client, numero, date_commande FROM commande_client ` +
        `WHERE IDsociete = ${SOCIETE_TRM} AND IDclient = ${id} ORDER BY IDcommande_client DESC`,
    )
    if (heads.length === 0) { res.json({ lignes: [], capped: false }); return }
    const cids = heads.map((h) => numOf(h.IDcommande_client))
    const headMap = new Map(heads.map((h) => [numOf(h.IDcommande_client), h]))
    const lines = await query<Record<string, unknown>>(
      `SELECT IDligne_commande_client, IDcommande_client, TYPE AS type_kind, IDreference, IDcolori, quantite, unite, prix ` +
        `FROM ligne_commande_client WHERE IDcommande_client IN (${cids.join(',')}) ` +
        `ORDER BY IDcommande_client DESC, IDligne_commande_client`,
    )

    // Line polymorphism on the TRM ledger. 1 = écru (the everyday tricotage
    // line), 2 = fini, 3 = divers — same as ETM. **4 = confection**: the type
    // is `type_sst` 4 (Confectionneur), and those 175 legacy rows are mirrors of
    // ETM sous-traitance lines whose ids resolve against the écru catalog, so
    // they are read exactly like type 1 (a stale id just renders "—").
    const ecruLike = (t: number) => t === 1 || t === 4
    const ecruMap = await mapSimpleRef('ref_ecru', 'IDref_ecru', lines.filter((l) => ecruLike(numOf(l.type_kind))).map((l) => numOf(l.IDreference)))
    const finiMap = await mapSimpleRef('ref_fini', 'IDref_fini', lines.filter((l) => numOf(l.type_kind) === 2).map((l) => numOf(l.IDreference)))
    const diversMap = await mapDesignation('ref_divers', 'IDref_divers', lines.filter((l) => numOf(l.type_kind) === 3).map((l) => numOf(l.IDreference)))
    const colIds = lines.map((l) => numOf(l.IDcolori))
    const ceMap = await mapSimpleRef('colori_ecru', 'IDcolori_ecru', colIds)
    const rfcMap = await mapSimpleRef('ref_fini_colori', 'IDref_fini_colori', colIds)

    const lignes = lines.map((l) => {
      const type = numOf(l.type_kind)
      const refId = numOf(l.IDreference)
      const colId = numOf(l.IDcolori)
      const ref = ecruLike(type) ? (ecruMap.get(refId) ?? '')
        : type === 2 ? (finiMap.get(refId) ?? '')
        : type === 3 ? (diversMap.get(refId) || 'Divers')
        : ''
      const coloris = type === 2 ? (rfcMap.get(colId) ?? ceMap.get(colId) ?? '') : (ceMap.get(colId) ?? '')
      const h = headMap.get(numOf(l.IDcommande_client))
      return {
        IDligne: numOf(l.IDligne_commande_client),
        IDcommande_client: numOf(l.IDcommande_client),
        numero: numOf(h?.numero),
        date_commande: strOf(h?.date_commande),
        type_kind: type,
        ref,
        coloris,
        quantite: numOf(l.quantite),
        unite: numOf(l.unite),
        prix: numOf(l.prix),
        // « Marge Brute » — the legacy column is 0,00 % on every row we can
        // observe and its formula is locked in the PCS-compressed .wdw source,
        // so nothing is computed yet. The screen keeps the column; this stays
        // null until the calculation is specified.
        marge_brute: null as number | null,
      }
    })
    res.json({ lignes, capped: heads.length >= HISTORIQUE_CAP })
  } catch (err) {
    console.error('Error fetching TRM client historique:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  STOCKS DE FIL  — GET /:id/stock-fil?etat=…
// ════════════════════════════════════════════════════════
// TRM knits à façon: the yarn is the customer's, and `stock_fil.IDclient` is
// its owner. Columns match the legacy panel (Lot N° · Date entrée · Référence ·
// coloris · Stock · Stock initial).
//
// `terminé` is accented, so it can never appear in a WHERE on the Linux bridge —
// the filtering is done in JS on both platforms, off the prefix-resolved key.
//
// The legacy panel offers three radios (En Cours / En Attente / Historique).
// Only two are reproducible: `terminé` is the single state flag on the table
// and it is what makes the legacy screen show an EMPTY "En Cours" list for
// A.E.T. (all 26 of its lots are terminé = 1). Nothing in the schema backs a
// third state — not `niveau` (that is the rack level, paired with
// `emplacement`), not `controlé` (0 on every open lot), not an OF affectation
// (all 26 A.E.T. lots are linked to one, which would make "En Cours"
// non-empty). « En Attente » is therefore deliberately NOT implemented rather
// than guessed; see the note in TRM's CLAUDE.md.

const STOCK_FIL_CAP = 400

const STOCK_FIL_COLS = IS_WINDOWS
  // `alias.*` returns nothing on the Windows driver — name every column, and
  // alias the accented one.
  ? `IDstock_fil, IDref_fil, IDcolori_fil, IDfournisseur, stock, stock_initial, lot, ` +
    `emplacement, niveau, date_entree, dernier_mouvement, terminé AS termine`
  : `*`

clientsTrmRouter.get('/:id/stock-fil', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    const etat = req.query.etat === 'historique' ? 'historique'
      : req.query.etat === 'tous' ? 'tous'
      : 'encours'

    const rows = await query<Record<string, unknown>>(
      `SELECT ${STOCK_FIL_COLS} FROM stock_fil WHERE IDclient = ${id} ORDER BY IDstock_fil DESC`,
    )

    // Accented columns come back from the Linux bridge truncated at the accent
    // with a non-deterministic trailing byte (`termin`, `termint`, …) — resolve
    // by case-insensitive prefix, never by a hardcoded key.
    const termine = (r: Record<string, unknown>): number => {
      const k = Object.keys(r).find((key) => /^termin/i.test(key))
      return k ? numOf(r[k]) : 0
    }

    const matching = rows.filter((r) => etat === 'tous' || (etat === 'historique' ? termine(r) === 1 : termine(r) !== 1))
    const capped = matching.length > STOCK_FIL_CAP
    const page = matching.slice(0, STOCK_FIL_CAP)

    const refMap = await mapSimpleRef('ref_fil', 'IDref_fil', page.map((r) => numOf(r.IDref_fil)))
    const colMap = await mapSimpleRef('colori_fil', 'IDcolori_fil', page.map((r) => numOf(r.IDcolori_fil)))

    res.json({
      lots: page.map((r) => ({
        IDstock_fil: numOf(r.IDstock_fil),
        lot: strOf(r.lot),
        date_entree: strOf(r.date_entree),
        ref_fil: refMap.get(numOf(r.IDref_fil)) ?? '',
        coloris: colMap.get(numOf(r.IDcolori_fil)) ?? '',
        stock: numOf(r.stock),
        stock_initial: numOf(r.stock_initial),
        emplacement: strOf(r.emplacement),
        termine: termine(r),
      })),
      capped,
      total: matching.length,
    })
  } catch (err) {
    console.error('Error fetching TRM client stock fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Contacts / adresses CRUD — shared verbatim with the ETM ledger
// (both tables are polymorphic on IDclient, not partitioned by société).
registerContactAdresseRoutes(clientsTrmRouter, TRM_PERMISSIONS)
