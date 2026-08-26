// Clients — customer master data (the legacy "Gestion Client" screen).
// Master-detail over the `client` table + polymorphic contact/adresse, plus the
// commercial sub-views (Références catalogue, Historique des commandes,
// Marchandise/expéditions, Tarifs/PrixDeVente). Mirrors fournisseurs.ts for the
// CRUD + contacts/adresses, and reuses the proven HFSQL client-read pattern from
// etudes-coloris.ts / commandes-client.ts.
//
// Hard rules baked in (verified against CLAUDE.md HFSQL section + live code):
//  - `SELECT * FROM client` returns 0 rows on the WINDOWS ODBC driver — name
//    explicit columns there. On the LINUX bridge SELECT * works but accented
//    column NAMES (`archivé`, `bloqué`) are rejected/truncated (→ `archiv`,
//    `bloqu`). So we NEVER name an accented column in a SELECT list:
//      • Windows  → explicit non-accented column list; read the archive flag via
//                   a separate `WHERE archivé = 1` query (WHERE tolerates it).
//      • Linux    → `SELECT *` and read the truncated key off the row.
//  - Accented text VALUES are written as Latin-1 hex literals via sqlText()
//    (raw multi-byte UTF-8 corrupts the Linux bridge). Client names carry
//    accents ("Amalthée", "37 Degrés"…), so this matters here.
//  - INSERT sets IDsociete = 1 (ETM). archivé/bloqué are left to HFSQL defaults.
//  - contact/adresse are polymorphic (IDclient / IDsous_traitant / IDfournisseur
//    / IDentreprise discriminators); SELECT * works on those two tables.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { IS_WINDOWS, esc } from '../lib/sst-shared.js'
import { userHasPermission } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'
// Shared with the TRM ledger (routes/clients-trm.ts) — see lib/clients-common.ts.
import {
  sqlText, numOf, strOf, pick, todayDigits, dateDigitsOnly, flag, intOf, floatOf,
  requirePermission, repairNames, countClientActivity, setClientFlag,
  registerContactAdresseRoutes,
} from '../lib/clients-common.js'
import { calcTarifRefFini } from '../lib/pricing-fini-tarif.js'
import {
  NB_RLX_TO_TRANCHE_IDX, DEFAULT_TRANCHE_IDX, parseLstTrancheIdx, fetchTarifModes,
} from '../lib/tarif-client.js'
import { TarifsClientPdf, type TarifsClientPdfData, type TarifsSectionData } from '../lib/pdf/TarifsClientPdf.js'
import { sendMail } from '../lib/gmail.js'
import { getUserEmail } from '../lib/user-emails.js'
import { notify } from '../lib/notify.js'
import { subscribersOf } from '../lib/notifications.js'
import {
  generateCompteClient, loadTakenComptes, pickCompte, normalizeCompte, isValidCompte,
} from '../lib/compte-client.js'
import { normalizeSiren, isValidSiren } from '../lib/siren.js'

export const clientsRouter: RouterType = Router()





// ── Detail column list (Windows path — no accented names) ──

const CLIENT_DETAIL_COLS = [
  'IDclient', 'nom', 'tel', 'fax', 'num_tva', 'IDtva', 'IDmode_paiement', 'IDecheance',
  'IDtransporteur', 'compte', 'siren', 'IDcode_comptable', 'pct_ajeol', 'pct_remise', 'est_visible',
  'IDsociete', 'date_creation', 'client_interne', 'dernier_contact', 'journal_commercial',
  'IDsecteur_activite', 'IDactivite', 'inclureRapportQualite', 'commentaire',
].join(', ')

const CLIENT_TEXT_FIELDS = ['nom', 'tel', 'fax', 'num_tva', 'compte', 'commentaire', 'journal_commercial']

function shapeClient(r: Record<string, unknown>) {
  return {
    IDclient: numOf(r.IDclient),
    nom: strOf(r.nom),
    tel: strOf(r.tel),
    fax: strOf(r.fax),
    num_tva: strOf(r.num_tva),
    compte: strOf(r.compte),
    siren: normalizeSiren(strOf(r.siren)),
    commentaire: strOf(r.commentaire),
    journal_commercial: strOf(pick(r, 'journal_commercial')),
    pct_remise: numOf(r.pct_remise),
    pct_ajeol: numOf(r.pct_ajeol),
    IDtva: numOf(r.IDtva),
    IDmode_paiement: numOf(r.IDmode_paiement),
    IDecheance: numOf(r.IDecheance),
    IDcode_comptable: numOf(r.IDcode_comptable),
    IDsecteur_activite: numOf(pick(r, 'IDsecteur_activite')),
    IDactivite: numOf(r.IDactivite),
    IDtransporteur: numOf(r.IDtransporteur),
    client_interne: numOf(r.client_interne),
    inclureRapportQualite: numOf(pick(r, 'inclureRapportQualite', 'inclureRapportQualit')),
    dernier_contact: strOf(pick(r, 'dernier_contact')),
    date_creation: strOf(pick(r, 'date_creation')),
    est_visible: numOf(r.est_visible),
    IDsociete: numOf(r.IDsociete),
  }
}

// ════════════════════════════════════════════════════════
//  LIST  — GET /api/clients
// ════════════════════════════════════════════════════════
// Returns every visible client + an `archive` flag so the FE can offer the
// En cours / Archivé / Tous filter without ever naming `archivé` in a SELECT.
clientsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    let rows: Record<string, unknown>[]
    const archivedSet = new Set<number>()
    if (IS_WINDOWS) {
      rows = await query<Record<string, unknown>>(
        `SELECT IDclient, nom, tel, est_visible, client_interne FROM client WHERE est_visible = 1 ORDER BY nom`,
      )
      // WHERE tolerates the accented name on Windows ODBC (unlike a SELECT list).
      const arch = await query<{ IDclient: number }>(
        `SELECT IDclient FROM client WHERE est_visible = 1 AND archivé = 1`,
      )
      for (const a of arch) archivedSet.add(Number(a.IDclient))
    } else {
      rows = await query<Record<string, unknown>>(
        `SELECT * FROM client WHERE est_visible = 1 ORDER BY nom`,
      )
    }
    const shaped = rows.map((r) => ({
      IDclient: numOf(r.IDclient),
      nom: strOf(r.nom),
      tel: strOf(r.tel),
      client_interne: numOf(r.client_interne),
      archive: IS_WINDOWS
        ? (archivedSet.has(numOf(r.IDclient)) ? 1 : 0)
        : numOf(pick(r, 'archivé', 'archiv')),
    }))
    await repairNames(shaped)
    res.json(shaped.filter((r) => r.nom != null && String(r.nom).trim().length > 0))
  } catch (err) {
    console.error('Error fetching clients:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})


// ════════════════════════════════════════════════════════
//  LOOKUPS  (literal paths — must register before /:id)
// ════════════════════════════════════════════════════════

clientsRouter.get('/lookups/secteurs', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDsecteur_activite: number; nom: string | null }>(
      `SELECT IDsecteur_activite, nom FROM secteur_activite ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'secteur_activite', 'IDsecteur_activite', ['nom'])
    res.json(fixed.map((r) => ({ IDsecteur_activite: Number(r.IDsecteur_activite), nom: r.nom ?? '' })))
  } catch (err) {
    console.error('Error fetching secteurs lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

clientsRouter.get('/lookups/activites', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDactivite: number; nom: string | null }>(
      `SELECT IDactivite, nom FROM activite ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'activite', 'IDactivite', ['nom'])
    res.json(fixed.map((r) => ({ IDactivite: Number(r.IDactivite), nom: r.nom ?? '' })))
  } catch (err) {
    console.error('Error fetching activites lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

clientsRouter.get('/lookups/modes-paiement', async (_req: Request, res: Response) => {
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

clientsRouter.get('/lookups/echeances', async (_req: Request, res: Response) => {
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

clientsRouter.get('/lookups/tva', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDtva: number; libelle_compte: string | null; valeur: number | null }>(
      `SELECT IDtva, libelle_compte, valeur FROM tva WHERE IDsociete = 1 AND est_visible = 1 ORDER BY valeur`,
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

clientsRouter.get('/lookups/codes-comptables', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDcode_comptable: number; libelle: string | null; numero: string | null }>(
      `SELECT IDcode_comptable, libelle, numero FROM code_comptable WHERE IDsociete = 1 AND est_visible = 1 ORDER BY libelle`,
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

// GET /api/clients/compte-suggestion?nom=…&exclude=…
// Proposes a free "411XXX" compte for a customer name. Used by the création
// dialog (live, as the user types the name) and by the detail screen when it
// finds an existing client whose compte was never filled in.
// Literal path — must stay registered before /:id.
clientsRouter.get('/compte-suggestion', async (req: Request, res: Response) => {
  try {
    const nom = typeof req.query.nom === 'string' ? req.query.nom.trim() : ''
    if (!nom) { res.status(400).json({ error: 'nom is required' }); return }
    const excludeRaw = parseInt(String(req.query.exclude ?? ''), 10)
    const exclude = Number.isFinite(excludeRaw) && excludeRaw > 0 ? excludeRaw : undefined
    res.json({ compte: await generateCompteClient(nom, exclude) })
  } catch (err) {
    console.error('Error generating compte client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/clients/comptes — every compte currently in use, normalized.
// Lets the screens flag a duplicate as the user types instead of only when the
// write is rejected. The server still checks on POST/PUT (this list can go
// stale if someone else creates a client meanwhile) — this is the fast path,
// not the authority.
// Literal path — must stay registered before /:id.
clientsRouter.get('/comptes', async (_req: Request, res: Response) => {
  try {
    res.json({ comptes: [...await loadTakenComptes()] })
  } catch (err) {
    console.error('Error listing comptes clients:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  DETAIL  — GET /api/clients/:id
// ════════════════════════════════════════════════════════
clientsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const sql = IS_WINDOWS
      ? `SELECT ${CLIENT_DETAIL_COLS} FROM client WHERE IDclient = ${id}`
      : `SELECT * FROM client WHERE IDclient = ${id}`
    const rawRows = await query<Record<string, unknown>>(sql)
    if (rawRows.length === 0) { res.status(404).json({ error: 'Client not found' }); return }
    const fixed = await fixEncoding(rawRows, 'client', 'IDclient', CLIENT_TEXT_FIELDS)
    const client = shapeClient(fixed[0])

    // archive flag — `archivé` is accented: Windows reads it via a separate
    // WHERE-only query (same trick as the list endpoint), Linux picks the
    // truncated key off the SELECT * row.
    let archive = 0
    if (IS_WINDOWS) {
      const arch = await query<{ IDclient: number }>(
        `SELECT IDclient FROM client WHERE IDclient = ${id} AND archivé = 1`,
      )
      archive = arch.length > 0 ? 1 : 0
    } else {
      archive = numOf(pick(rawRows[0], 'archivé', 'archiv')) ? 1 : 0
    }

    // contact / adresse — SELECT * works on these two tables (no accented names).
    const [adresses, contacts] = await Promise.all([
      query(`SELECT * FROM adresse WHERE IDclient = ${id} ORDER BY est_defaut DESC, IDadresse`),
      query(`SELECT * FROM contact WHERE IDclient = ${id} ORDER BY est_defaut DESC, IDcontact`),
    ])
    const fixedAdresses = await fixEncoding(adresses, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays', 'commentaire'])
    const fixedContacts = await fixEncoding(contacts, 'contact', 'IDcontact', ['nom', 'prenom', 'tel', 'mail', 'commentaire'])

    res.json({
      ...client,
      archive,
      adresses: fixedAdresses,
      contacts: fixedContacts,
    })
  } catch (err) {
    console.error('Error fetching client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  CREATE / UPDATE / DELETE
// ════════════════════════════════════════════════════════

const clientBody = z.object({
  nom: z.string().min(1).max(100),
  tel: z.string().optional(),
  fax: z.string().optional(),
  num_tva: z.string().optional(),
  compte: z.string().optional(),
  siren: z.string().optional(),
  commentaire: z.string().optional(),
  journal_commercial: z.string().optional(),
  pct_remise: z.number().optional(),
  pct_ajeol: z.number().optional(),
  IDtva: z.number().int().optional(),
  IDmode_paiement: z.number().int().optional(),
  IDecheance: z.number().int().optional(),
  IDcode_comptable: z.number().int().optional(),
  IDsecteur_activite: z.number().int().optional(),
  IDactivite: z.number().int().optional(),
  client_interne: z.union([z.boolean(), z.number()]).optional(),
  inclureRapportQualite: z.union([z.boolean(), z.number()]).optional(),
  dernier_contact: z.string().optional(),
})


const createClientBody = z.object({
  nom: z.string().trim().min(1).max(100),
  IDsecteur_activite: z.number().int().optional(),
  IDactivite: z.number().int().optional(),
  /** Optional override of the auto-generated code. */
  compte: z.string().optional(),
})

// POST /api/clients — create a client from the "Nouveau client" dialog.
// `nom` is mandatory (the dialog asks for it up front, which is what stopped
// the old flow from littering the table with "Nouveau client" placeholders),
// and the compte client is generated here — never left empty.
clientsRouter.post('/', async (req: Request, res: Response) => {
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
      `INSERT INTO client (nom, compte, IDsecteur_activite, IDactivite, est_visible, client_interne, IDsociete, date_creation) ` +
        `VALUES (${sqlText(nom)}, '${esc(compte)}', ${intOf(b.IDsecteur_activite)}, ${intOf(b.IDactivite)}, ` +
        `1, 0, 1, '${todayDigits()}')`,
    )
    const rows = await query<{ IDclient: number }>(`SELECT IDclient FROM client ORDER BY IDclient DESC`)
    const newId = rows.length > 0 ? Number(rows[0].IDclient) : 0
    res.status(201).json({ IDclient: newId, nom, compte })
  } catch (err) {
    console.error('Error creating client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/clients/:id — update master-data fields. Never names archivé/bloqué.
//
// The screen saves the whole client in one shot, but its fields belong to three
// independently-granted scopes (Info tab / the lone "Inclure rapports contrôle"
// toggle / Commercial tab). Rather than 403 the whole save — which would break
// a user who legitimately only edited contacts — each scope contributes its SET
// clauses only when the caller holds it. Columns outside the caller's scopes are
// simply not named, so they keep their stored value (no read-back, no re-encode).
clientsRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = clientBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const b = parsed.data

    const admin = isEffectiveAdmin(req)
    const [canInfo, canRapportQualite, canCommercial] = await Promise.all([
      userHasPermission(req.userId, admin, 'edit_client_info'),
      userHasPermission(req.userId, admin, 'edit_client_rapport_qualite'),
      userHasPermission(req.userId, admin, 'edit_client_commercial'),
    ])

    // Compte client — only reachable through the Info scope, so it is only
    // validated when the caller actually writes it.
    //
    // Format is enforced on every save (a client must never be stored without
    // a well-formed compte), but UNIQUENESS is only checked when the value
    // changes: the legacy data already contains 10 duplicate codes, and
    // re-blocking those clients on an unrelated edit would be a regression.
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
      const current = await query<{ compte: unknown }>(
        `SELECT compte FROM client WHERE IDclient = ${id}`,
      )
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

    // SIREN — optional (the column is being filled in client by client), but a
    // non-empty value must be a real 9-digit one: it is the key the facturation
    // électronique routes on. Digits only, so no sqlText/hex encoding needed.
    let siren = ''
    if (canInfo) {
      siren = normalizeSiren(b.siren)
      if (!isValidSiren(siren)) {
        res.status(400).json({
          error: 'siren_invalide',
          message: 'Le SIREN doit comporter 9 chiffres.',
        })
        return
      }
    }

    // `nom` lives in the detail header, not in a permission-scoped tab.
    const sets = [`nom = ${sqlText(b.nom)}`]
    if (canInfo) {
      sets.push(
        `tel = ${sqlText(b.tel)}`,
        `fax = ${sqlText(b.fax)}`,
        `num_tva = ${sqlText(b.num_tva)}`,
        `compte = '${esc(compte)}'`,
        `siren = '${siren}'`,
        `commentaire = ${sqlText(b.commentaire)}`,
        `pct_remise = ${floatOf(b.pct_remise)}`,
        `pct_ajeol = ${floatOf(b.pct_ajeol)}`,
        `IDtva = ${intOf(b.IDtva)}`,
        `IDmode_paiement = ${intOf(b.IDmode_paiement)}`,
        `IDecheance = ${intOf(b.IDecheance)}`,
        `IDcode_comptable = ${intOf(b.IDcode_comptable)}`,
        `IDsecteur_activite = ${intOf(b.IDsecteur_activite)}`,
        `IDactivite = ${intOf(b.IDactivite)}`,
        `client_interne = ${flag(b.client_interne)}`,
      )
    }
    if (canRapportQualite) sets.push(`inclureRapportQualite = ${flag(b.inclureRapportQualite)}`)
    if (canCommercial) {
      sets.push(
        `journal_commercial = ${sqlText(b.journal_commercial)}`,
        `dernier_contact = '${dateDigitsOnly(b.dernier_contact)}'`,
      )
    }
    await query(`UPDATE client SET ${sets.join(', ')} WHERE IDclient = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Delete / archive (permission-gated: delete_client) ──


/** 401/403 guard shared by DELETE and the archive endpoints. */
async function requireDeleteClientPermission(req: Request, res: Response): Promise<boolean> {
  return requirePermission(req, res, 'delete_client')
}


// GET /api/clients/:id/deletability — drives the delete-vs-archive confirm dialog.
clientsRouter.get('/:id/deletability', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    const activity = await countClientActivity(id)
    res.json({ ...activity, deletable: activity.commandes === 0 && activity.marchandises === 0 })
  } catch (err) {
    console.error('Error checking client deletability:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})


// POST /api/clients/:id/archive — the fallback when deletion is blocked.
clientsRouter.post('/:id/archive', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await requireDeleteClientPermission(req, res))) return
    const found = await setClientFlag(id, 'archive', 1)
    if (!found) { res.status(404).json({ error: 'Client not found' }); return }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error archiving client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/clients/:id/unarchive
clientsRouter.post('/:id/unarchive', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await requireDeleteClientPermission(req, res))) return
    const found = await setClientFlag(id, 'archive', 0)
    if (!found) { res.status(404).json({ error: 'Client not found' }); return }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error unarchiving client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/clients/:id — hard delete, only for clients with zero activity.
clientsRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    // id <= 0 must be rejected: contact/adresse are polymorphic and store
    // IDclient = 0 for rows belonging to other parents — a WHERE IDclient = 0
    // cleanup below would wipe them all.
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await requireDeleteClientPermission(req, res))) return
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
    console.error('Error deleting client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  COMMERCIAL SUB-VIEWS  (read-only: historique / références / marchandise)
// ════════════════════════════════════════════════════════

// Shared label resolvers. colori_ecru / ref_fini_colori reject SELECT * — use
// explicit columns. ref_fini / ref_ecru tolerate explicit columns too.
async function mapRefFini(ids: number[]): Promise<Map<number, { reference: string; designation: string; avec_teinture: number }>> {
  const m = new Map<number, { reference: string; designation: string; avec_teinture: number }>()
  const uniq = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))]
  if (!uniq.length) return m
  const rows = await query<Record<string, unknown>>(`SELECT IDref_fini, reference, designation, avec_teinture FROM ref_fini WHERE IDref_fini IN (${uniq.join(',')})`)
  const fixed = await fixEncoding(rows, 'ref_fini', 'IDref_fini', ['reference', 'designation'])
  for (const r of fixed) m.set(numOf(r.IDref_fini), { reference: strOf(r.reference) ?? '', designation: strOf(r.designation) ?? '', avec_teinture: numOf(r.avec_teinture) })
  return m
}
/** ref_ecru with designation (for the client references catalogue). */
async function mapRefEcruFull(ids: number[]): Promise<Map<number, { reference: string; designation: string }>> {
  const m = new Map<number, { reference: string; designation: string }>()
  const uniq = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))]
  if (!uniq.length) return m
  const rows = await query<Record<string, unknown>>(`SELECT IDref_ecru, reference, designation FROM ref_ecru WHERE IDref_ecru IN (${uniq.join(',')})`)
  const fixed = await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['reference', 'designation'])
  for (const r of fixed) m.set(numOf(r.IDref_ecru), { reference: strOf(r.reference) ?? '', designation: strOf(r.designation) ?? '' })
  return m
}
async function mapSimpleRef(table: string, idCol: string, ids: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>()
  const uniq = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))]
  if (!uniq.length) return m
  const rows = await query<Record<string, unknown>>(`SELECT ${idCol}, reference FROM ${table} WHERE ${idCol} IN (${uniq.join(',')})`)
  const fixed = await fixEncoding(rows, table, idCol, ['reference'])
  for (const r of fixed) m.set(numOf(r[idCol]), strOf(r.reference) ?? '')
  return m
}
/** Same as mapSimpleRef but for tables labeled by `designation`
 *  (ref_divers, ref_divers_variation). */
async function mapDesignation(table: string, idCol: string, ids: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>()
  const uniq = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))]
  if (!uniq.length) return m
  const rows = await query<Record<string, unknown>>(`SELECT ${idCol}, designation FROM ${table} WHERE ${idCol} IN (${uniq.join(',')})`)
  const fixed = await fixEncoding(rows, table, idCol, ['designation'])
  for (const r of fixed) m.set(numOf(r[idCol]), strOf(r.designation) ?? '')
  return m
}
/** Resolve a polymorphic coloris id to its label, preferring the dye catalog
 *  when avec_teinture != 0, the wash catalog otherwise (project_avec_teinture_coloris_rule). */
function coloriLabel(id: number, avecTeinture: number, ce: Map<number, string>, rfc: Map<number, string>): string {
  if (!id) return ''
  return (avecTeinture !== 0 ? (rfc.get(id) ?? ce.get(id)) : (ce.get(id) ?? rfc.get(id))) ?? ''
}

// GET /api/clients/:id/historique — recent order lines (Date, n° cmd, ref, coloris, qté, prix).
clientsRouter.get('/:id/historique', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const heads = await query<Record<string, unknown>>(
      `SELECT TOP 120 IDcommande_client, numero, date_commande FROM commande_client ` +
        `WHERE IDsociete = 1 AND IDcommande_ETM = 0 AND IDclient = ${id} ORDER BY IDcommande_client DESC`,
    )
    if (heads.length === 0) { res.json({ lignes: [], capped: false }); return }
    const cids = heads.map((h) => numOf(h.IDcommande_client))
    const headMap = new Map(heads.map((h) => [numOf(h.IDcommande_client), h]))
    const lines = await query<Record<string, unknown>>(
      `SELECT IDligne_commande_client, IDcommande_client, TYPE AS type_kind, IDreference, IDcolori, IDvariation1, IDvariation2, quantite, unite, prix ` +
        `FROM ligne_commande_client WHERE IDcommande_client IN (${cids.join(',')}) ORDER BY IDcommande_client DESC, IDligne_commande_client`,
    )
    const finiMap = await mapRefFini(lines.filter((l) => numOf(l.type_kind) === 2).map((l) => numOf(l.IDreference)))
    const ecruMap = await mapSimpleRef('ref_ecru', 'IDref_ecru', lines.filter((l) => numOf(l.type_kind) === 1).map((l) => numOf(l.IDreference)))
    const colIds = lines.map((l) => numOf(l.IDcolori))
    const ceMap = await mapSimpleRef('colori_ecru', 'IDcolori_ecru', colIds)
    const rfcMap = await mapSimpleRef('ref_fini_colori', 'IDref_fini_colori', colIds)
    // Divers lines (type 3): label from ref_divers, "coloris" from the line's
    // variations (ref_divers_variation — couleur and/or taille).
    const diversMap = await mapDesignation('ref_divers', 'IDref_divers', lines.filter((l) => numOf(l.type_kind) === 3).map((l) => numOf(l.IDreference)))
    const varMap = await mapDesignation('ref_divers_variation', 'IDref_divers_variation',
      lines.flatMap((l) => [numOf(pick(l, 'IDvariation1', 'IDVARIATION1')), numOf(pick(l, 'IDvariation2', 'IDVARIATION2'))]))

    const lignes = lines.map((l) => {
      const type = numOf(l.type_kind)
      let ref = ''
      let avec = 0
      let coloris = ''
      if (type === 2) { const r = finiMap.get(numOf(l.IDreference)); ref = r?.reference ?? ''; avec = r?.avec_teinture ?? 0 }
      else if (type === 1) { ref = ecruMap.get(numOf(l.IDreference)) ?? '' }
      else if (type === 3) {
        ref = diversMap.get(numOf(l.IDreference)) || 'Divers'
        coloris = [numOf(pick(l, 'IDvariation1', 'IDVARIATION1')), numOf(pick(l, 'IDvariation2', 'IDVARIATION2'))]
          .map((v) => (v > 0 ? varMap.get(v) ?? '' : ''))
          .filter((s) => s.length > 0)
          .join(' · ')
      } else { ref = 'Divers' }
      if (type !== 3) coloris = coloriLabel(numOf(l.IDcolori), avec, ceMap, rfcMap)
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
      }
    })
    res.json({ lignes, capped: heads.length >= 120 })
  } catch (err) {
    console.error('Error fetching client historique:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Client tarif modes (standard / coefficient fixe / contrat) ──
// The model and its resolution live in lib/tarif-client.ts — shared with the
// order path (Clients › Commandes prices its lines off the same modes), so the
// fiche and the commande can never disagree about what a client pays.

// GET /api/clients/:id/references — client product catalogue
// (Ref client = designation, Ref interne = ref_fini/ref_ecru, Coloris = ref_client_colori).
clientsRouter.get('/:id/references', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    // designation_client tolerates SELECT * (verified). archivé is accented → prune in JS.
    const dRows = await query<Record<string, unknown>>(`SELECT * FROM designation_client WHERE IDclient = ${id} ORDER BY designation`)
    const dFixed = await fixEncoding(dRows, 'designation_client', 'IDdesignation_client', ['designation'])
    const active = dFixed.filter((r) => !numOf(pick(r, 'archivé', 'archiv')))
    // caché=1 rows are the hidden "Reference Associée" markers a parent ref
    // creates when linking an associated ref — never list them as entries.
    const desigs = active.filter((r) => !numOf(pick(r, 'caché', 'cach')))
    if (desigs.length === 0) { res.json([]); return }
    // did → IDref_fini over ALL active rows (hidden ones included) so a parent's
    // associee CSV (child designation ids) resolves to the linked ref_fini ids.
    const finiByDid = new Map(active.map((r) => [numOf(r.IDdesignation_client), numOf(r.IDref_fini)]))

    const finiMap = await mapRefFini(desigs.map((r) => numOf(r.IDref_fini)))
    const ecruMap = await mapRefEcruFull(desigs.map((r) => numOf(r.IDref_ecru)))

    const dIds = desigs.map((r) => numOf(r.IDdesignation_client))
    const rccRows = await query<Record<string, unknown>>(`SELECT * FROM ref_client_colori WHERE IDdesignation_client IN (${dIds.join(',')})`)
    const rcc = rccRows.filter((r) => !numOf(pick(r, 'archivé', 'archiv')))
    const ceMap = await mapSimpleRef('colori_ecru', 'IDcolori_ecru', rcc.map((r) => numOf(r.IDcolori_ecru)))
    const rfcMap = await mapSimpleRef('ref_fini_colori', 'IDref_fini_colori', rcc.map((r) => numOf(r.IDref_fini_colori)))
    const modeMap = await fetchTarifModes(rcc.map((r) => ({ id: numOf(r.IDref_client_colori), contrat: numOf(r.contrat) })))

    const colorisByDesig = new Map<number, any[]>()
    for (const r of rcc) {
      const did = numOf(r.IDdesignation_client)
      const finiColId = numOf(r.IDref_fini_colori)
      const ecruColId = numOf(r.IDcolori_ecru)
      const label = finiColId > 0 ? (rfcMap.get(finiColId) ?? '') : (ceMap.get(ecruColId) ?? '')
      const arr = colorisByDesig.get(did) ?? []
      const rccId = numOf(r.IDref_client_colori)
      const mode = modeMap.get(rccId)
      arr.push({
        IDref_client_colori: rccId,
        label,
        // coloris id to feed the Tarif endpoint (dye → ref_fini_colori, wash → colori_ecru)
        coloris_id: finiColId > 0 ? finiColId : ecruColId,
        lst_tranche: strOf(r.lst_tranche) ?? '',
        contrat: numOf(r.contrat),
        tarif_mode: mode?.tarif_mode ?? 'standard',
        coefficient: mode?.coefficient ?? 0,
        contrats: mode?.contrats ?? [],
        contrat_actif: mode?.contrat_actif ?? null,
        contrat_expire: mode?.contrat_expire ?? false,
      })
      colorisByDesig.set(did, arr)
    }

    const out = desigs.map((r) => {
      const idFini = numOf(r.IDref_fini)
      const idEcru = numOf(r.IDref_ecru)
      const rf = finiMap.get(idFini)
      const re = ecruMap.get(idEcru)
      return {
        IDdesignation_client: numOf(r.IDdesignation_client),
        client_ref: strOf(r.designation) ?? '',
        IDref_fini: idFini,
        IDref_ecru: idEcru,
        ref_interne: idFini > 0 ? (rf?.reference ?? '') : (re?.reference ?? ''),
        designation: idFini > 0 ? (rf?.designation ?? '') : (re?.designation ?? ''),
        avec_teinture: rf?.avec_teinture ?? 0,
        soumettre: numOf(r.soumettre),
        unite: numOf(r.unite),
        // Inverted legacy storage: yarns NOT invoiced to the client (CSV of IDref_fil).
        fil_non_facture: String(pick(r, 'fil_non_facturé', 'fil_non_factur') ?? '')
          .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0),
        // Linked associated refs: the parent's associee CSV holds hidden child
        // designation ids — resolve each to the child's IDref_fini.
        associees: String(r.associee ?? '')
          .split(',').map((s) => parseInt(s.trim(), 10))
          .map((cd) => (Number.isInteger(cd) && cd > 0 ? (finiByDid.get(cd) ?? 0) : 0))
          .filter((x) => x > 0),
        coloris: colorisByDesig.get(numOf(r.IDdesignation_client)) ?? [],
      }
    })
    res.json(out)
  } catch (err) {
    console.error('Error fetching client references:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Référence client settings (designation_client CRUD + coloris dispo + fils facturés) ──
// designation_client accented columns (archivé, caché, fil_non_facturé) are never
// named in SQL. Writes use positional INSERT with explicit max+1 PK (verified
// 2026-07-16: PK stored verbatim, datetime literal 'YYYY-MM-DD HH:MM:SS' accepted);
// any update goes through delete + positional re-insert preserving the PK and the
// untouched accented values. Same approach for ref_client_colori (archivé).
// Physical column orders (from SELECT * key order, confirmed by the write test):
//   designation_client: IDclient, IDdesignation_client, designation, IDref_fini,
//     IDref_ecru, archivé, date_modification, associee, caché, soumettre, unite,
//     fil_non_facturé
//   ref_client_colori: IDref_client_colori, IDdesignation_client, IDref_fini_colori,
//     IDcolori_ecru, lst_tranche, contrat, IDphoto_produit, archivé, prevision

function nowDateTime(): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function nextPk(table: string, pkCol: string): Promise<number> {
  const rows = await query<Record<string, unknown>>(`SELECT MAX(${pkCol}) AS m FROM ${table}`)
  return numOf(rows[0]?.m) + 1
}

interface DesignationRow {
  IDclient: number
  IDdesignation_client: number
  designation: string
  IDref_fini: number
  IDref_ecru: number
  archive: number
  associee: string
  cache: number
  soumettre: number
  unite: number
  fil_non_facture: string // CSV of IDref_fil, validated digits only
}

function normalizeDesignationRow(r: Record<string, unknown>): DesignationRow {
  return {
    IDclient: numOf(r.IDclient),
    IDdesignation_client: numOf(r.IDdesignation_client),
    designation: strOf(r.designation) ?? '',
    IDref_fini: numOf(r.IDref_fini),
    IDref_ecru: numOf(r.IDref_ecru),
    archive: numOf(pick(r, 'archivé', 'archiv')),
    associee: strOf(r.associee) ?? '',
    cache: numOf(pick(r, 'caché', 'cach')),
    soumettre: numOf(r.soumettre),
    unite: numOf(r.unite),
    fil_non_facture: strOf(pick(r, 'fil_non_facturé', 'fil_non_factur')) ?? '',
  }
}

async function insertDesignationPositional(row: DesignationRow, dateModification: string): Promise<void> {
  await query(
    `INSERT INTO designation_client VALUES (${row.IDclient}, ${row.IDdesignation_client}, ${sqlText(row.designation)}, ` +
      `${row.IDref_fini}, ${row.IDref_ecru}, ${row.archive}, '${dateModification}', ${sqlText(row.associee)}, ` +
      `${row.cache}, ${row.soumettre}, ${row.unite}, '${row.fil_non_facture}')`,
  )
}

interface RccRow {
  IDref_client_colori: number
  IDdesignation_client: number
  IDref_fini_colori: number
  IDcolori_ecru: number
  lst_tranche: string
  contrat: number
  IDphoto_produit: number
  archive: number
  prevision: number
}

async function readRccRows(did: number): Promise<RccRow[]> {
  const rows = await query<Record<string, unknown>>(`SELECT * FROM ref_client_colori WHERE IDdesignation_client = ${did}`)
  return rows.map((r) => ({
    IDref_client_colori: numOf(r.IDref_client_colori),
    IDdesignation_client: numOf(r.IDdesignation_client),
    IDref_fini_colori: numOf(r.IDref_fini_colori),
    IDcolori_ecru: numOf(r.IDcolori_ecru),
    lst_tranche: strOf(r.lst_tranche) ?? '',
    contrat: numOf(r.contrat),
    IDphoto_produit: numOf(r.IDphoto_produit),
    archive: numOf(pick(r, 'archivé', 'archiv')),
    prevision: numOf(r.prevision),
  }))
}

async function insertRccPositional(row: RccRow): Promise<void> {
  await query(
    `INSERT INTO ref_client_colori VALUES (${row.IDref_client_colori}, ${row.IDdesignation_client}, ` +
      `${row.IDref_fini_colori}, ${row.IDcolori_ecru}, '${esc(row.lst_tranche)}', ${row.contrat}, ` +
      `${row.IDphoto_produit}, ${row.archive}, ${row.prevision})`,
  )
}

/** Flip the archivé flag on an rcc row (accented column → delete + re-insert,
 *  PK and tarif linkage — tranche_tarifaire/contrat_tarif key on the rcc id — preserved). */
async function setRccArchive(row: RccRow, archive: 0 | 1): Promise<void> {
  await query(`DELETE FROM ref_client_colori WHERE IDref_client_colori = ${row.IDref_client_colori}`)
  await insertRccPositional({ ...row, archive })
}

/** Which rcc column the coloris ids of this ref live in
 *  (project_avec_teinture_coloris_rule: wash → colori_ecru, dye → ref_fini_colori). */
async function rccColorisColumn(IDref_fini: number): Promise<'IDref_fini_colori' | 'IDcolori_ecru'> {
  if (IDref_fini <= 0) return 'IDcolori_ecru' // TM ref → wash coloris of the ecru
  const rows = await query<Record<string, unknown>>(`SELECT avec_teinture FROM ref_fini WHERE IDref_fini = ${IDref_fini}`)
  return numOf(rows[0]?.avec_teinture) === 0 ? 'IDcolori_ecru' : 'IDref_fini_colori'
}

/** Reconcile the designation's ref_client_colori rows against the wanted catalog
 *  coloris ids: unarchive returning ones, archive removed ones, insert new ones.
 *  Returns the delta so the caller can fire the notif_coloris_ajoute email. */
async function syncRccRows(
  did: number,
  col: 'IDref_fini_colori' | 'IDcolori_ecru',
  wantedIds: number[],
): Promise<{ added: number[]; removed: number[] }> {
  const existing = await readRccRows(did)
  const wanted = new Set(wantedIds)
  const added: number[] = []
  const removed: number[] = []
  for (const row of existing) {
    const rowCol: 'IDref_fini_colori' | 'IDcolori_ecru' = row.IDref_fini_colori > 0 ? 'IDref_fini_colori' : 'IDcolori_ecru'
    const colorisId = rowCol === 'IDref_fini_colori' ? row.IDref_fini_colori : row.IDcolori_ecru
    const isWanted = rowCol === col && wanted.has(colorisId)
    if (isWanted) {
      wanted.delete(colorisId)
      // An archived row coming back is an addition from the user's point of view.
      if (row.archive === 1) { await setRccArchive(row, 0); added.push(colorisId) }
    } else if (row.archive === 0) {
      await setRccArchive(row, 1)
      removed.push(colorisId)
    }
  }
  if (wanted.size === 0) return { added, removed }
  let pk = await nextPk('ref_client_colori', 'IDref_client_colori')
  for (const colorisId of wanted) {
    added.push(colorisId)
    await insertRccPositional({
      IDref_client_colori: pk++,
      IDdesignation_client: did,
      IDref_fini_colori: col === 'IDref_fini_colori' ? colorisId : 0,
      IDcolori_ecru: col === 'IDcolori_ecru' ? colorisId : 0,
      // Up-to-10-rouleaux default — the 15/30 tranches are enabled per client
      // after negotiation (Tarif dialog, permission gestion_tarifs).
      lst_tranche: DEFAULT_TRANCHE_IDX.join(','),
      contrat: 0,
      IDphoto_produit: 0,
      archive: 0,
      prevision: 0,
    })
  }
  return { added, removed }
}

/** Reconcile the hidden "Reference Associée" child rows (caché=1) of a parent
 *  designation against the wanted associated IDref_fini list, keeping the
 *  parent's associee CSV (child designation ids) in sync. Legacy model:
 *  checking an associated ref in the settings dialog creates a hidden
 *  designation_client row for it (designation 'Reference Associée', caché=1,
 *  unite=0, no coloris rows) so order entry can propose/check it alongside
 *  the parent; unchecking deletes that hidden row. */
async function syncAssociees(clientId: number, did: number, currentCsv: string, wantedFiniIds: number[]): Promise<void> {
  const childIds = [...new Set(currentCsv.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0))]
  let children: DesignationRow[] = []
  if (childIds.length > 0) {
    const rows = await query<Record<string, unknown>>(
      `SELECT * FROM designation_client WHERE IDdesignation_client IN (${childIds.join(',')}) AND IDclient = ${clientId}`,
    )
    children = rows.map(normalizeDesignationRow)
  }
  // Only link refs that actually exist in the finished-goods catalog.
  const finiMap = await mapRefFini(wantedFiniIds)
  const wanted = new Set(wantedFiniIds.filter((x) => finiMap.has(x)))
  const keep: number[] = []
  for (const c of children) {
    if (wanted.has(c.IDref_fini)) {
      wanted.delete(c.IDref_fini)
      keep.push(c.IDdesignation_client)
    } else {
      await query(`DELETE FROM designation_client WHERE IDdesignation_client = ${c.IDdesignation_client}`)
    }
  }
  if (wanted.size > 0) {
    let pk = await nextPk('designation_client', 'IDdesignation_client')
    for (const idFini of wanted) {
      const newDid = pk++
      await insertDesignationPositional({
        IDclient: clientId,
        IDdesignation_client: newDid,
        designation: 'Reference Associée', // exact legacy marker string
        IDref_fini: idFini,
        IDref_ecru: 0,
        archive: 0,
        associee: '',
        cache: 1,
        soumettre: 0,
        unite: 0,
        fil_non_facture: '',
      }, nowDateTime())
      keep.push(newDid)
    }
  }
  const csv = keep.join(',')
  if (csv !== currentCsv) {
    await query(`UPDATE designation_client SET associee = '${csv}' WHERE IDdesignation_client = ${did}`)
  }
}

const refSettingsBody = z
  .object({
    designation: z.string().min(1).max(100),
    IDref_fini: z.number().int().nonnegative(),
    IDref_ecru: z.number().int().nonnegative(),
    soumettre: z.boolean(),
    unite: z.union([z.literal(1), z.literal(3)]), // 1 = Kg, 3 = Ml
    fil_non_facture: z.array(z.number().int().positive()).max(50),
    coloris: z.array(z.number().int().positive()).max(500),
    // Associated refs (IDref_fini) to link as hidden child designations.
    // Only meaningful for fini refs — forced empty for TM (écru) refs.
    associees: z.array(z.number().int().positive()).max(50).default([]),
  })
  .refine((b) => (b.IDref_fini > 0) !== (b.IDref_ecru > 0), {
    message: 'Exactly one of IDref_fini / IDref_ecru must be set',
  })

// POST /api/clients/:id/references — create a client reference (designation_client)
clientsRouter.post('/:id/references', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const allowedRefs = await userHasPermission(req.userId, isEffectiveAdmin(req), 'gestion_references')
    if (!allowedRefs) { res.status(403).json({ error: 'permission denied: gestion_references' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = refSettingsBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const b = parsed.data
    const clientRows = await query<Record<string, unknown>>(`SELECT IDclient FROM client WHERE IDclient = ${id}`)
    if (clientRows.length === 0) { res.status(404).json({ error: 'Client not found' }); return }

    const newDid = await nextPk('designation_client', 'IDdesignation_client')
    await insertDesignationPositional(
      {
        IDclient: id,
        IDdesignation_client: newDid,
        designation: b.designation,
        IDref_fini: b.IDref_fini,
        IDref_ecru: b.IDref_ecru,
        archive: 0,
        associee: '',
        cache: 0,
        soumettre: b.soumettre ? 1 : 0,
        unite: b.unite,
        fil_non_facture: b.fil_non_facture.join(','),
      },
      nowDateTime(),
    )
    const col = await rccColorisColumn(b.IDref_fini)
    const delta = await syncRccRows(newDid, col, b.coloris)
    if (b.IDref_fini > 0 && b.associees.length > 0) await syncAssociees(id, newDid, '', b.associees)
    res.status(201).json({ IDdesignation_client: newDid })
    void notifyColorisAjoute({ userId: req.userId, clientId: id, did: newDid, col, ...delta, lstTranche: DEFAULT_TRANCHE_IDX.join(',') })
  } catch (err) {
    console.error('Error creating client reference:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/clients/:id/references/:did — update a client reference's settings
clientsRouter.put('/:id/references/:did', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const allowedRefs = await userHasPermission(req.userId, isEffectiveAdmin(req), 'gestion_references')
    if (!allowedRefs) { res.status(403).json({ error: 'permission denied: gestion_references' }); return }
    const id = parseInt(req.params.id, 10)
    const did = parseInt(req.params.did, 10)
    if (isNaN(id) || isNaN(did)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = refSettingsBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const b = parsed.data

    const rows = await query<Record<string, unknown>>(
      `SELECT * FROM designation_client WHERE IDdesignation_client = ${did} AND IDclient = ${id}`,
    )
    if (rows.length === 0) { res.status(404).json({ error: 'Reference not found' }); return }
    const original = normalizeDesignationRow(rows[0])

    // Replace the row (accented fil_non_facturé can't be named in an UPDATE);
    // archivé / caché / associee are preserved from the original.
    const updated: DesignationRow = {
      ...original,
      designation: b.designation,
      IDref_fini: b.IDref_fini,
      IDref_ecru: b.IDref_ecru,
      soumettre: b.soumettre ? 1 : 0,
      unite: b.unite,
      fil_non_facture: b.fil_non_facture.join(','),
    }
    await query(`DELETE FROM designation_client WHERE IDdesignation_client = ${did}`)
    try {
      await insertDesignationPositional(updated, nowDateTime())
    } catch (err) {
      // Best-effort restore so the row never silently disappears.
      try { await insertDesignationPositional(original, nowDateTime()) } catch { /* restore only */ }
      throw err
    }

    const col = await rccColorisColumn(b.IDref_fini)
    const delta = await syncRccRows(did, col, b.coloris)
    // Always reconcile (deletes unlinked hidden children when the user
    // unchecks a ref or switches the designation to a TM/écru ref).
    await syncAssociees(id, did, original.associee, b.IDref_fini > 0 ? b.associees : [])
    res.json({ ok: true })
    void notifyColorisAjoute({ userId: req.userId, clientId: id, did, col, ...delta, lstTranche: DEFAULT_TRANCHE_IDX.join(',') })
  } catch (err) {
    console.error('Error updating client reference:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Catalog coloris ids selectable for a client reference, in whichever rcc
 *  column applies (mirrors /commandes-client/lookups/colori-fini | colori-ecru). */
async function catalogColorisIds(
  IDref_fini: number,
  IDref_ecru: number,
  col: 'IDref_fini_colori' | 'IDcolori_ecru',
): Promise<Set<number>> {
  if (col === 'IDref_fini_colori') {
    const rows = await query<Record<string, unknown>>(
      `SELECT IDref_fini_colori FROM ref_fini_colori WHERE IDref_fini = ${IDref_fini}`,
    )
    return new Set(rows.map((r) => numOf(r.IDref_fini_colori)))
  }
  // Wash coloris hang off the écru ref — the designation's own one (TM ref) or
  // the one behind the fini ref (avec_teinture = 0).
  let idEcru = IDref_ecru
  if (idEcru <= 0 && IDref_fini > 0) {
    const rows = await query<Record<string, unknown>>(`SELECT IDref_ecru FROM ref_fini WHERE IDref_fini = ${IDref_fini}`)
    idEcru = numOf(rows[0]?.IDref_ecru)
  }
  if (idEcru <= 0) return new Set()
  const rows = await query<Record<string, unknown>>(`SELECT IDcolori_ecru FROM colori_ecru WHERE IDref_ecru = ${idEcru}`)
  return new Set(rows.map((r) => numOf(r.IDcolori_ecru)))
}

/** Which coloris catalog an rcc row points at (dye vs wash). */
function rccRowColumn(r: RccRow): 'IDref_fini_colori' | 'IDcolori_ecru' {
  return r.IDref_fini_colori > 0 ? 'IDref_fini_colori' : 'IDcolori_ecru'
}
function rccRowColorisId(r: RccRow): number {
  return r.IDref_fini_colori > 0 ? r.IDref_fini_colori : r.IDcolori_ecru
}

/** Refusal shown to a gestion_coloris-only user when the ref's existing coloris
 *  don't share one set of standard terms to copy onto the new one. */
const COLORIS_TERMS_MISMATCH =
  'Merci de demander à un utilisateur ayant le droit d’éditer les tarifs pour ajouter ce coloris.'

// ── Coloris notifications (notif_coloris_ajoute / notif_coloris_refuse) ──
// Everything below runs AFTER the response has been sent and is wrapped so a
// failure can never surface to the caller — see lib/notify.ts.

const TRANCHE_ROLL_LABEL = ['< 1', '1', '2', '3', '4', '5', '10', '15', '30']

/** "< 1 · 1 · 2 · 3 · 4 · 5 · 10 rouleaux" for an rcc lst_tranche. */
function trancheSummaryFr(lstTranche: string): string {
  const labels = parseLstTrancheIdx(lstTranche).map((i) => TRANCHE_ROLL_LABEL[i]).filter(Boolean)
  return labels.length === 0 ? '—' : `${labels.join(' · ')} rouleaux`
}

/** Display name of the user whose action triggered a notification. */
async function actorName(userId: number | undefined): Promise<string> {
  if (userId === undefined) return 'Un utilisateur'
  try {
    const rows = await query<Record<string, unknown>>(
      `SELECT IDutilisateur, prenom, nom FROM utilisateur WHERE IDutilisateur = ${userId}`,
    )
    const fixed = await fixEncoding(rows, 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
    const name = [strOf(fixed[0]?.prenom), strOf(fixed[0]?.nom)].filter(Boolean).join(' ').trim()
    return name || `Utilisateur #${userId}`
  } catch {
    return `Utilisateur #${userId}`
  }
}

interface ColorisNotifContext {
  clientNom: string
  refLabel: string
  labelOf: (id: number) => string
}

/** Resolve the human labels a coloris notification needs (client, référence,
 *  coloris names) in the rcc column that applies. */
async function colorisNotifContext(
  clientId: number,
  did: number,
  col: 'IDref_fini_colori' | 'IDcolori_ecru',
  ids: number[],
): Promise<ColorisNotifContext> {
  const [clientRows, desigRows] = await Promise.all([
    query<Record<string, unknown>>(`SELECT IDclient, nom FROM client WHERE IDclient = ${clientId}`),
    query<Record<string, unknown>>(`SELECT * FROM designation_client WHERE IDdesignation_client = ${did}`),
  ])
  const clientFixed = await fixEncoding(clientRows, 'client', 'IDclient', ['nom'])
  const clientNom = strOf(clientFixed[0]?.nom) ?? `Client #${clientId}`

  let refLabel = `Référence #${did}`
  if (desigRows.length > 0) {
    const ref = normalizeDesignationRow(desigRows[0])
    const interne = ref.IDref_fini > 0
      ? (await mapRefFini([ref.IDref_fini])).get(ref.IDref_fini)?.reference
      : (await mapRefEcruFull([ref.IDref_ecru])).get(ref.IDref_ecru)?.reference
    refLabel = [ref.designation || `#${did}`, interne ? `(${interne})` : ''].filter(Boolean).join(' ')
  }

  const labels = col === 'IDref_fini_colori'
    ? await mapSimpleRef('ref_fini_colori', 'IDref_fini_colori', ids)
    : await mapSimpleRef('colori_ecru', 'IDcolori_ecru', ids)
  return { clientNom, refLabel, labelOf: (id) => labels.get(id) || `#${id}` }
}

/** Fire-and-forget: someone added coloris to a client reference. */
async function notifyColorisAjoute(args: {
  userId?: number
  clientId: number
  did: number
  col: 'IDref_fini_colori' | 'IDcolori_ecru'
  added: number[]
  removed: number[]
  lstTranche: string
}): Promise<void> {
  try {
    if (args.added.length === 0) return
    // Early-out before touching HFSQL — with no subscriber there is nothing to
    // build, and this runs on every reference save.
    if ((await subscribersOf('notif_coloris_ajoute')).length === 0) return

    const ctx = await colorisNotifContext(args.clientId, args.did, args.col, [...args.added, ...args.removed])
    const who = await actorName(args.userId)
    const plural = args.added.length > 1 ? 'coloris ont été ajoutés' : 'coloris a été ajouté'
    const rows = [
      { label: 'Client', value: ctx.clientNom },
      { label: 'Référence', value: ctx.refLabel },
      { label: 'Coloris ajoutés', value: args.added.map(ctx.labelOf).join(', ') },
      { label: 'Tranches appliquées', value: trancheSummaryFr(args.lstTranche) },
    ]
    if (args.removed.length > 0) {
      rows.push({ label: 'Retirés en même temps', value: args.removed.map(ctx.labelOf).join(', ') })
    }
    await notify('notif_coloris_ajoute', {
      subject: `Coloris ajouté - ${ctx.clientNom} - ${ctx.refLabel}`,
      content: {
        title: 'Coloris ajouté',
        tone: 'info',
        intro: `${args.added.length} ${plural} à une référence client par **${who}**.`,
        rows,
      },
      actingUserId: args.userId,
      actingUserName: who,
    })
  } catch (err) {
    console.error('notifyColorisAjoute failed:', err)
  }
}

const addColorisBody = z.object({
  coloris: z.array(z.number().int().positive()).min(1).max(500),
})

// POST /api/clients/:id/references/:did/coloris — add coloris to an EXISTING
// client reference without touching the reference itself. Entry point for the
// `gestion_coloris` permission: a user allowed to extend a ref's coloris list
// while managing neither references nor tarifs.
//
// Such a user can't set a tarif, so the new rows must inherit the terms already
// in force — which only exists if the ref is uniform: every coloris on tarif
// standard, all sharing the same visible tranches (lst_tranche). Otherwise
// there is no single "same terms" to copy and we refuse, pointing at someone
// who can edit tarifs. Callers holding gestion_tarifs skip the gate (they can
// set the tarif afterwards).
clientsRouter.post('/:id/references/:did/coloris', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const admin = isEffectiveAdmin(req)
    const [allowedColoris, allowedRefs, allowedTarifs] = await Promise.all([
      userHasPermission(req.userId, admin, 'gestion_coloris'),
      userHasPermission(req.userId, admin, 'gestion_references'),
      userHasPermission(req.userId, admin, 'gestion_tarifs'),
    ])
    if (!allowedColoris && !allowedRefs) { res.status(403).json({ error: 'permission denied: gestion_coloris' }); return }
    const id = parseInt(req.params.id, 10)
    const did = parseInt(req.params.did, 10)
    if (isNaN(id) || isNaN(did)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = addColorisBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }

    const rows = await query<Record<string, unknown>>(
      `SELECT * FROM designation_client WHERE IDdesignation_client = ${did} AND IDclient = ${id}`,
    )
    if (rows.length === 0) { res.status(404).json({ error: 'Reference not found' }); return }
    const ref = normalizeDesignationRow(rows[0])
    if (ref.archive === 1) { res.status(404).json({ error: 'Reference not found' }); return }

    const col = await rccColorisColumn(ref.IDref_fini)
    const catalog = await catalogColorisIds(ref.IDref_fini, ref.IDref_ecru, col)
    const wanted = [...new Set(parsed.data.coloris)].filter((c) => catalog.has(c))
    if (wanted.length === 0) { res.status(400).json({ error: 'Aucun coloris valide pour cette référence' }); return }

    const existing = await readRccRows(did)
    const active = existing.filter((r) => r.archive === 0)
    const alreadyLinked = new Set(active.filter((r) => rccRowColumn(r) === col).map(rccRowColorisId))
    const toAdd = wanted.filter((c) => !alreadyLinked.has(c))
    if (toAdd.length === 0) { res.json({ ok: true, added: 0 }); return }

    // Unchecking a coloris archives its rcc row (tarif linkage intact) — revive
    // that row instead of inserting a duplicate.
    const reviveByColoris = new Map<number, RccRow>()
    for (const r of existing) {
      if (r.archive === 1 && rccRowColumn(r) === col && toAdd.includes(rccRowColorisId(r))) {
        reviveByColoris.set(rccRowColorisId(r), r)
      }
    }

    let lstTranche = DEFAULT_TRANCHE_IDX.join(',')
    // Rows whose terms the new coloris must match (revived ones included — they
    // come back with their old tarif and would break the ref's uniformity).
    const audited = [...active, ...reviveByColoris.values()]
    const signatures = new Set(audited.map((r) => parseLstTrancheIdx(r.lst_tranche).join(',')))

    if (!allowedTarifs) {
      const modes = await fetchTarifModes(audited.map((r) => ({ id: r.IDref_client_colori, contrat: r.contrat })))
      const allStandard = audited.every((r) => (modes.get(r.IDref_client_colori)?.tarif_mode ?? 'standard') === 'standard')
      if (!allStandard || signatures.size > 1) {
        res.status(403).json({ error: 'tarifs_non_uniformes', message: COLORIS_TERMS_MISMATCH })
        return
      }
    }
    // Copy the ref's shared tranches when they're unanimous; otherwise (only
    // reachable with gestion_tarifs) fall back to the standard 0..6 default.
    if (signatures.size === 1) lstTranche = [...signatures][0]

    let pk = 0
    for (const colorisId of toAdd) {
      const revive = reviveByColoris.get(colorisId)
      if (revive) { await setRccArchive(revive, 0); continue }
      if (pk === 0) pk = await nextPk('ref_client_colori', 'IDref_client_colori')
      await insertRccPositional({
        IDref_client_colori: pk++,
        IDdesignation_client: did,
        IDref_fini_colori: col === 'IDref_fini_colori' ? colorisId : 0,
        IDcolori_ecru: col === 'IDcolori_ecru' ? colorisId : 0,
        lst_tranche: lstTranche,
        contrat: 0,
        IDphoto_produit: 0,
        archive: 0,
        prevision: 0,
      })
    }
    res.status(201).json({ ok: true, added: toAdd.length })
    void notifyColorisAjoute({ userId: req.userId, clientId: id, did, col, added: toAdd, removed: [], lstTranche })
  } catch (err) {
    console.error('Error adding client reference coloris:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const colorisDemandeBody = z.object({
  coloris: z.array(z.number().int().positive()).max(500).default([]),
  note: z.string().max(1000).default(''),
})

// POST /api/clients/:id/references/:did/coloris/demande — "Prévenir le
// responsable" from the blocked Ajouter-un-coloris dialog.
//
// Deliberately an explicit user action rather than an automatic email on the
// rejection: the dialog blocks client-side, so an automatic send would fire
// every time someone merely opened it. One click = one email, and the
// requester's note tells the recipient what is actually wanted.
//
// Unlike the other notification call sites this one AWAITS the send, because
// the UI only claims an email went out when one actually did.
clientsRouter.post('/:id/references/:did/coloris/demande', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const admin = isEffectiveAdmin(req)
    const [allowedColoris, allowedRefs] = await Promise.all([
      userHasPermission(req.userId, admin, 'gestion_coloris'),
      userHasPermission(req.userId, admin, 'gestion_references'),
    ])
    if (!allowedColoris && !allowedRefs) { res.status(403).json({ error: 'permission denied: gestion_coloris' }); return }
    const id = parseInt(req.params.id, 10)
    const did = parseInt(req.params.did, 10)
    if (isNaN(id) || isNaN(did)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = colorisDemandeBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }

    if ((await subscribersOf('notif_coloris_refuse')).length === 0) {
      res.json({ subscribers: 0, notified: 0 })
      return
    }

    const rows = await query<Record<string, unknown>>(
      `SELECT * FROM designation_client WHERE IDdesignation_client = ${did} AND IDclient = ${id}`,
    )
    if (rows.length === 0) { res.status(404).json({ error: 'Reference not found' }); return }
    const ref = normalizeDesignationRow(rows[0])
    const col = await rccColorisColumn(ref.IDref_fini)
    const ctx = await colorisNotifContext(id, did, col, parsed.data.coloris)
    const who = await actorName(req.userId)

    const detailRows = [
      { label: 'Client', value: ctx.clientNom },
      { label: 'Référence', value: ctx.refLabel },
    ]
    if (parsed.data.coloris.length > 0) {
      detailRows.push({ label: 'Coloris souhaités', value: parsed.data.coloris.map(ctx.labelOf).join(', ') })
    }
    detailRows.push({ label: 'Demandé par', value: who })

    const result = await notify('notif_coloris_refuse', {
      subject: `Demande d’ajout de coloris - ${ctx.clientNom} - ${ctx.refLabel}`,
      content: {
        title: 'Demande d’ajout de coloris',
        tone: 'alert',
        intro:
          `**${who}** souhaite ajouter un coloris à une référence client, mais l’opération est bloquée : ` +
          'les coloris existants de cette référence n’ont pas tous le tarif standard avec les mêmes tranches.',
        rows: detailRows,
        note: parsed.data.note.trim() ? { label: 'Note du demandeur', value: parsed.data.note } : null,
        callout: 'L’ajout doit être réalisé par un utilisateur ayant le droit d’éditer les tarifs.',
      },
      actingUserId: req.userId,
      actingUserName: who,
    })
    res.json(result)
  } catch (err) {
    console.error('Error sending coloris request notification:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/clients/lookups/refs-associees?ref_fini=X — the finished refs
// associated to X (ref_fini.associee CSV, defined in Finis › Références),
// candidates for the "Références associées" checklist of the settings dialog.
clientsRouter.get('/lookups/refs-associees', async (req: Request, res: Response) => {
  try {
    const refFini = parseInt(String(req.query.ref_fini ?? ''), 10)
    if (!Number.isInteger(refFini) || refFini <= 0) { res.status(400).json({ error: 'Invalid ref_fini' }); return }
    const rows = await query<Record<string, unknown>>(`SELECT associee FROM ref_fini WHERE IDref_fini = ${refFini}`)
    if (rows.length === 0) { res.json([]); return }
    // Legacy CSV is messy: leading "0", empty items, sometimes the ref itself.
    const ids = [...new Set(String(rows[0].associee ?? '')
      .split(',').map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== refFini))]
    if (ids.length === 0) { res.json([]); return }
    const finiMap = await mapRefFini(ids)
    res.json(ids.filter((x) => finiMap.has(x)).map((x) => ({
      IDref_fini: x,
      reference: finiMap.get(x)!.reference,
      designation: finiMap.get(x)!.designation,
    })))
  } catch (err) {
    console.error('Error fetching associated refs lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/clients/lookups/composition-fils?ref_fini=X | ref_ecru=Y — the yarns
// composing a ref (composition_ecru of the underlying écru), for the "Fil facturé"
// checklist of the reference settings dialog.
clientsRouter.get('/lookups/composition-fils', async (req: Request, res: Response) => {
  try {
    const refFini = parseInt(String(req.query.ref_fini ?? ''), 10)
    const refEcruParam = parseInt(String(req.query.ref_ecru ?? ''), 10)
    let ecruId = !isNaN(refEcruParam) && refEcruParam > 0 ? refEcruParam : 0
    if (ecruId === 0 && !isNaN(refFini) && refFini > 0) {
      const rf = await query<Record<string, unknown>>(`SELECT IDref_ecru FROM ref_fini WHERE IDref_fini = ${refFini}`)
      ecruId = numOf(rf[0]?.IDref_ecru)
    }
    if (ecruId === 0) { res.json([]); return }
    const compo = await query<Record<string, unknown>>(
      `SELECT DISTINCT IDref_fil FROM composition_ecru WHERE IDref_ecru = ${ecruId} AND IDref_fil > 0`,
    )
    const filIds = [...new Set(compo.map((c) => numOf(c.IDref_fil)).filter((n) => n > 0))]
    if (filIds.length === 0) { res.json([]); return }
    const fils = await query<Record<string, unknown>>(
      `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${filIds.join(',')})`,
    )
    const fixed = await fixEncoding(fils, 'ref_fil', 'IDref_fil', ['reference'])
    res.json(
      fixed
        .map((r) => ({ IDref_fil: numOf(r.IDref_fil), reference: strOf(r.reference) ?? '' }))
        .sort((a, b) => a.reference.localeCompare(b.reference)),
    )
  } catch (err) {
    console.error('Error fetching composition fils:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Tarif mode endpoints (per référence client × coloris) ──

/** Resolve a ref_client_colori scoped to the client (via its designation).
 *  Returns null when the rcc doesn't exist or belongs to another client.
 *  Explicit ASCII columns only (rcc.archivé is accented). */
async function fetchClientRcc(clientId: number, rccId: number): Promise<{
  rccId: number
  contrat: number
  lst_tranche: string
  IDref_fini: number
  IDref_fini_colori: number
  IDcolori_ecru: number
} | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT rcc.IDref_client_colori, rcc.contrat, rcc.lst_tranche, rcc.IDref_fini_colori, rcc.IDcolori_ecru, dc.IDref_fini ` +
      `FROM ref_client_colori rcc ` +
      `INNER JOIN designation_client dc ON dc.IDdesignation_client = rcc.IDdesignation_client ` +
      `WHERE rcc.IDref_client_colori = ${rccId} AND dc.IDclient = ${clientId}`,
  )
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    rccId,
    contrat: numOf(r.contrat),
    lst_tranche: strOf(r.lst_tranche) ?? '',
    IDref_fini: numOf(r.IDref_fini),
    IDref_fini_colori: numOf(r.IDref_fini_colori),
    IDcolori_ecru: numOf(r.IDcolori_ecru),
  }
}

// GET /api/clients/:id/coloris/:rccId/tarif — PrixDeVente breakdown honoring the
// client's tarif mode: coefficient fixe recomputes every tranche with the fixed
// margin; an ACTIVE contrat surfaces its negotiated €/Ml as `prixContrat` on the
// matching tranches (expired contracts fall back to the standard calculation).
clientsRouter.get('/:id/coloris/:rccId/tarif', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const rccId = parseInt(req.params.rccId, 10)
    if (isNaN(id) || isNaN(rccId) || id <= 0 || rccId <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rcc = await fetchClientRcc(id, rccId)
    if (!rcc) { res.status(404).json({ error: 'Coloris not found for this client' }); return }

    const mode = (await fetchTarifModes([{ id: rccId, contrat: rcc.contrat }])).get(rccId)!

    // Dye refs price on ref_fini_colori, wash-only refs on colori_ecru
    // (project_avec_teinture_coloris_rule) — mirror buildTarifsPdfData.
    let colorisId = 0
    if (rcc.IDref_fini > 0) {
      const fRows = await query<{ avec_teinture: number }>(
        `SELECT avec_teinture FROM ref_fini WHERE IDref_fini = ${rcc.IDref_fini}`,
      )
      const avecTeinture = fRows.length > 0 ? numOf(fRows[0].avec_teinture) : 0
      colorisId = avecTeinture !== 0 ? rcc.IDref_fini_colori : rcc.IDcolori_ecru
    }

    const tarif = await calcTarifRefFini(
      rcc.IDref_fini,
      colorisId,
      mode.tarif_mode === 'coefficient' && mode.coefficient > 0 ? { coefficient: mode.coefficient / 100 } : undefined,
    )

    const contratPrixByIdx = new Map<number, number>()
    if (mode.tarif_mode === 'contrat' && mode.contrat_actif) {
      for (const t of mode.contrat_actif.tranches) {
        const idx = NB_RLX_TO_TRANCHE_IDX[t.nb_rouleaux]
        if (idx !== undefined && t.prix > 0) contratPrixByIdx.set(idx, t.prix)
      }
    }

    res.json({
      ...tarif,
      tranches: tarif.tranches.map((t, i) => ({ ...t, prixContrat: contratPrixByIdx.get(i) ?? null })),
      tranche_idx: parseLstTrancheIdx(rcc.lst_tranche),
      tarif_mode: mode.tarif_mode,
      coefficient: mode.coefficient,
      contrats: mode.contrats,
      contrat_actif: mode.contrat_actif,
      contrat_expire: mode.contrat_expire,
    })
  } catch (err) {
    console.error('Error computing client coloris tarif:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const tarifModeBody = z.object({
  mode: z.enum(['standard', 'coefficient', 'contrat']),
  coefficient: z.number().int().min(1).max(99).optional(),
  contrat: z
    .object({
      IDcontrat_tarif: z.number().int().positive().optional(),
      date_debut: z.string().regex(/^\d{8}$/),
      date_expiration: z.string().regex(/^\d{8}$/),
      tranches: z
        .array(
          z.object({
            nb_rouleaux: z.number().int().refine((n) => n in NB_RLX_TO_TRANCHE_IDX, 'invalid tranche'),
            prix: z.number().positive(),
          }),
        )
        .min(1)
        .max(9),
    })
    .optional(),
})

// PUT /api/clients/:id/coloris/:rccId/tarif-mode — switch a référence×coloris
// between the three tarif modes (permission-gated: gestion_tarifs).
//   standard    → drop the coefficient row, contrat flag off (contract history kept)
//   coefficient → single tranche_tarifaire row with the fixed margin %
//   contrat     → create a new contrat_tarif (renewal keeps history) or update
//                 the one identified by IDcontrat_tarif, with its €/Ml tranches
clientsRouter.put('/:id/coloris/:rccId/tarif-mode', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const rccId = parseInt(req.params.rccId, 10)
    if (isNaN(id) || isNaN(rccId) || id <= 0 || rccId <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }

    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'gestion_tarifs')
    if (!allowed) { res.status(403).json({ error: 'permission denied: gestion_tarifs' }); return }

    const parsed = tarifModeBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const b = parsed.data
    if (b.mode === 'coefficient' && !(b.coefficient && b.coefficient > 0)) {
      res.status(400).json({ error: 'coefficient required for coefficient mode' }); return
    }
    if (b.mode === 'contrat' && !b.contrat) {
      res.status(400).json({ error: 'contrat required for contrat mode' }); return
    }

    const rcc = await fetchClientRcc(id, rccId)
    if (!rcc) { res.status(404).json({ error: 'Coloris not found for this client' }); return }

    // Coefficient rows are the only client-scoped tranche_tarifaire rows with
    // IDcontrat_tarif = 0 — dropping them never touches contract history.
    const dropCoefficientRows = () =>
      query(`DELETE FROM tranche_tarifaire WHERE IDref_client_colori = ${rccId} AND IDcontrat_tarif = 0`)

    if (b.mode === 'standard') {
      await dropCoefficientRows()
      await query(`UPDATE ref_client_colori SET contrat = 0 WHERE IDref_client_colori = ${rccId}`)
    } else if (b.mode === 'coefficient') {
      await dropCoefficientRows()
      await query(
        `INSERT INTO tranche_tarifaire (nb_rouleaux, IDref_client_colori, coefficient, prix_saisi, IDcontrat_tarif, IDRef_Catalogue) ` +
          `VALUES (1, ${rccId}, ${b.coefficient}, 0, 0, 0)`,
      )
      await query(`UPDATE ref_client_colori SET contrat = 0 WHERE IDref_client_colori = ${rccId}`)
    } else {
      const c = b.contrat!
      // Dedupe tranches by nb_rouleaux (last entry wins).
      const byNb = new Map<number, number>()
      for (const t of c.tranches) byNb.set(t.nb_rouleaux, t.prix)

      let contratId = 0
      if (c.IDcontrat_tarif) {
        const scope = await query<{ IDcontrat_tarif: number }>(
          `SELECT IDcontrat_tarif FROM contrat_tarif WHERE IDcontrat_tarif = ${c.IDcontrat_tarif} AND IDref_client_colori = ${rccId}`,
        )
        if (scope.length === 0) { res.status(404).json({ error: 'Contrat not found for this coloris' }); return }
        contratId = c.IDcontrat_tarif
        await query(
          `UPDATE contrat_tarif SET date_debut = '${c.date_debut}', date_expiration = '${c.date_expiration}' WHERE IDcontrat_tarif = ${contratId}`,
        )
        await query(`DELETE FROM tranche_tarifaire WHERE IDcontrat_tarif = ${contratId}`)
      } else {
        await query(
          `INSERT INTO contrat_tarif (date_debut, date_expiration, IDref_client_colori) ` +
            `VALUES ('${c.date_debut}', '${c.date_expiration}', ${rccId})`,
        )
        const back = await query<{ IDcontrat_tarif: number }>(
          `SELECT IDcontrat_tarif FROM contrat_tarif WHERE IDref_client_colori = ${rccId} ORDER BY IDcontrat_tarif DESC`,
        )
        contratId = back.length > 0 ? numOf(back[0].IDcontrat_tarif) : 0
        if (!(contratId > 0)) { res.status(500).json({ error: 'Failed to create contrat' }); return }
      }
      for (const [nb, prix] of byNb) {
        await query(
          `INSERT INTO tranche_tarifaire (nb_rouleaux, IDref_client_colori, coefficient, prix_saisi, IDcontrat_tarif, IDRef_Catalogue) ` +
            `VALUES (${nb}, ${rccId}, 0, ${prix}, ${contratId}, 0)`,
        )
      }
      await dropCoefficientRows()
      await query(`UPDATE ref_client_colori SET contrat = 1 WHERE IDref_client_colori = ${rccId}`)
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating tarif mode:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const tranchesBody = z.object({ t15: z.boolean(), t30: z.boolean() })

// PUT /api/clients/:id/coloris/:rccId/tranches — toggle the negotiated 15/30
// rouleaux tranches (lst_tranche indices 7/8) for a référence×coloris
// (permission-gated: gestion_tarifs). Base indices (0..6) are preserved as-is;
// an empty lst_tranche is materialized to the up-to-10-rouleaux default.
clientsRouter.put('/:id/coloris/:rccId/tranches', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const rccId = parseInt(req.params.rccId, 10)
    if (isNaN(id) || isNaN(rccId) || id <= 0 || rccId <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }

    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'gestion_tarifs')
    if (!allowed) { res.status(403).json({ error: 'permission denied: gestion_tarifs' }); return }

    const parsed = tranchesBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }

    const rcc = await fetchClientRcc(id, rccId)
    if (!rcc) { res.status(404).json({ error: 'Coloris not found for this client' }); return }

    const idx = parseLstTrancheIdx(rcc.lst_tranche).filter((n) => n < 7)
    if (parsed.data.t15) idx.push(7)
    if (parsed.data.t30) idx.push(8)
    // lst_tranche is pure ASCII (digits + commas) — plain quoted literal is safe.
    await query(`UPDATE ref_client_colori SET lst_tranche = '${idx.join(',')}' WHERE IDref_client_colori = ${rccId}`)

    res.json({ ok: true, tranche_idx: idx })
  } catch (err) {
    console.error('Error updating tranches:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Marchandise expédiée — search / sort / lazy paging ─────────────────────
// Ticket #1085: the list was a bare `TOP 400` with no search and no way to
// reach anything older, so a piece shipped long ago could not be found (and
// therefore not returned to stock). Measured on the dev copy: 379 clients have
// shipped rolls, 15 of them exceed 400, and the biggest (client 231, 8 332
// rolls) fetches UNCAPPED in ~230 ms. So the cap was never about query cost —
// it was about payload and render size. Hence: read the client's whole
// history, search and sort it server-side, and hand the UI one page at a time.
// A search therefore reaches every piece the client ever received, not just
// the slice already loaded, while the browser still renders only what it shows.

/** Sortable columns of the marchandise table. */
const MARCH_SORT_KEYS = ['expedition', 'date', 'ref', 'coloris', 'piece', 'poids', 'metrage'] as const
type MarchSortKey = (typeof MARCH_SORT_KEYS)[number]

/** Fold to a search-friendly form: lowercase, accents stripped. The coloris
 *  labels carry accents ("écru", "délavé") and users type without them, so
 *  both sides of the comparison go through this. */
function searchFold(v: string): string {
  return v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/** Human ordering for piece numbers: "3378/51" sorts BEFORE "3378/1007",
 *  which a plain string compare gets backwards (it reads "1" < "5"). Digit
 *  runs compare numerically, everything else lexically. */
function naturalCompare(a: string, b: string): number {
  const ra = a.match(/\d+|\D+/g) ?? []
  const rb = b.match(/\d+|\D+/g) ?? []
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
    const x = ra[i], y = rb[i]
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = parseInt(x, 10) - parseInt(y, 10)
      if (d !== 0) return d
    } else {
      const d = x.localeCompare(y, 'fr')
      if (d !== 0) return d
    }
  }
  return ra.length - rb.length
}

// GET /api/clients/:id/marchandise — shipped rolls (Expédié le, Expé N°, Ref, Pièce, Poids, Métrage).
//   ?q=<terms>      — all whitespace-separated terms must match somewhere in the
//                     row (pièce / lot / réf / coloris / n° expédition), accent-
//                     and case-insensitive. Searches the client's WHOLE history.
//   ?sort=&dir=     — one of MARCH_SORT_KEYS, asc|desc. Default: newest expédition
//                     first, pieces in natural order within it (the legacy order).
//   ?limit=&offset= — one page of the result (default 200, max 500). The UI loads
//                     the next page as the user scrolls, so nothing is ever out
//                     of reach and the browser never renders 8 000 rows it does
//                     not need. Search and sort are applied BEFORE the slice, so
//                     a page is always a page of the matching set.
clientsRouter.get('/:id/marchandise', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const sortRaw = typeof req.query.sort === 'string' ? req.query.sort : ''
    const sort = (MARCH_SORT_KEYS as readonly string[]).includes(sortRaw) ? (sortRaw as MarchSortKey) : null
    const dir = req.query.dir === 'asc' ? 'asc' : 'desc'
    const limitRaw = parseInt(String(req.query.limit ?? ''), 10)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 200
    const offsetRaw = parseInt(String(req.query.offset ?? ''), 10)
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0

    // DATE is a reserved word (alias to dexp); never name expedition's accented
    // envoyé_client/envoyé_sst. Scope to client via commande_client, ETM only.
    const rows = await query<Record<string, unknown>>(
      `SELECT e.IDexpedition, e.DATE AS dexp, sf.IDstock_fini, sf.numero AS piece, sf.poids, sf.metrage, sf.lot, sf.second_choix, sf.IDref_fini, sf.IDColoris ` +
        `FROM expedition e ` +
        `INNER JOIN ligne_expedition le ON le.IDexpedition = e.IDexpedition ` +
        `INNER JOIN stock_fini sf ON sf.IDligne_expedition = le.IDligne_expedition ` +
        `INNER JOIN commande_client cc ON e.IDcommande_client = cc.IDcommande_client ` +
        `WHERE e.IDsociete = 1 AND cc.IDclient = ${id} ORDER BY e.IDexpedition DESC, sf.numero`,
    )
    // Enrichment is keyed on DISTINCT ids inside these helpers, so its cost is
    // bounded by how many refs/coloris the client buys — not by row count.
    // That is what makes enriching the whole history before filtering cheap.
    const finiMap = await mapRefFini(rows.map((r) => numOf(r.IDref_fini)))
    const colIds = rows.map((r) => numOf(r.IDColoris))
    const ceMap = await mapSimpleRef('colori_ecru', 'IDcolori_ecru', colIds)
    const rfcMap = await mapSimpleRef('ref_fini_colori', 'IDref_fini_colori', colIds)
    const all = rows.map((r) => {
      const rf = finiMap.get(numOf(r.IDref_fini))
      return {
        IDexpedition: numOf(r.IDexpedition),
        IDstock_fini: numOf(r.IDstock_fini),
        date: strOf(r.dexp),
        piece: strOf(r.piece) ?? '',
        lot: strOf(r.lot) ?? '',
        ref: rf?.reference ?? '',
        coloris: coloriLabel(numOf(r.IDColoris), rf?.avec_teinture ?? 0, ceMap, rfcMap),
        poids: numOf(r.poids),
        metrage: numOf(r.metrage),
        second_choix: numOf(r.second_choix),
      }
    })

    // Search: every term must hit the row. The ticket names pieces as
    // "3378/51 - 180A Terracotta", so the haystack spans pièce + réf + coloris
    // and multi-term AND lets the user paste that whole line.
    let out = all
    if (q) {
      // Terms carrying no alphanumerics are dropped: users paste whole lines out
      // of a ticket or an email, and a lone "-" as a required term would match
      // nothing. A query that is only punctuation degrades to "no search".
      const terms = searchFold(q).split(/\s+/).filter((t) => /[a-z0-9]/.test(t))
      out = all.filter((l) => {
        const hay = searchFold(`${l.piece} ${l.lot} ${l.ref} ${l.coloris} ${l.IDexpedition}`)
        return terms.every((t) => hay.includes(t))
      })
    }

    // Sort. Only re-sort when asked — the SQL order (newest expédition first)
    // is the legacy default and is already what the list should open on.
    if (sort) {
      const mul = dir === 'asc' ? 1 : -1
      out = [...out].sort((a, b) => {
        let c = 0
        switch (sort) {
          case 'expedition': c = a.IDexpedition - b.IDexpedition; break
          case 'date': c = (a.date ?? '').localeCompare(b.date ?? ''); break
          case 'poids': c = a.poids - b.poids; break
          case 'metrage': c = a.metrage - b.metrage; break
          case 'ref': c = a.ref.localeCompare(b.ref, 'fr'); break
          case 'coloris': c = a.coloris.localeCompare(b.coloris, 'fr'); break
          case 'piece': c = naturalCompare(a.piece, b.piece); break
        }
        // Stable tie-break, or paging could repeat or skip a row between pages.
        return c !== 0 ? c * mul : a.IDstock_fini - b.IDstock_fini
      })
    }

    res.json({
      lignes: out.slice(offset, offset + limit),
      matched: out.length,   // rows the search kept — what paging runs against
      total: all.length,     // rows the client has, all-time
      offset,
      limit,
    })
  } catch (err) {
    console.error('Error fetching client marchandise:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/clients/:id/marchandise/retour-stock — return shipped rolls to stock.
// Body { ids: IDstock_fini[] }. Permission retour_marchandise. Appends
// "Récupéré chez <client> le <dd/MM/yyyy>" to the roll observations and undoes
// what shipping did to it. Observations are read repaired (fixEncoding) so
// existing accents survive the rewrite; the write goes through sqlText
// (Latin-1 hex).
//
// ⚠️ Clearing IDligne_expedition alone is NOT enough — that was the original
// bug (ticket #1086, "elles n'apparaissent dans aucun stock"). Finis › Stock
// filters on TWO criteria, "IDligne_expedition = 0 AND IDetat_stock_fini <> 4"
// (stock-fini.ts), and the legacy WinDev expedition routine stamps état 4
// ("Expédié") on virtually every shipped roll — 42 944 of the 43 391 rolls
// sitting on a shipment line in the dev copy. So a roll returned with état 4
// left the Marchandise tab (no expedition line left to INNER JOIN on) without
// ever entering Finis › Stock, and stayed out of every other order's
// available-rolls pool as well. It appeared in no stock at all. Undo all three:
//   IDligne_expedition      → 0   always
//   IDetat_stock_fini       → 3   ("Validé") but ONLY when it is currently 4,
//                                 so a roll shipped in another état keeps it
//   IDligne_commande_client → 0   releases the client-order reservation, which
//                                 is what actually puts the roll back in the
//                                 free pool (commandes-client.ts requires it
//                                 to be 0 before offering a roll to a line).
//                                 The order line then reads as under-delivered
//                                 again — correct, the goods came back.
// Guard: apps/api/src/scripts/check-retour-marchandise.ts
const retourStockBody = z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) })

/** État "Expédié" — stamped by the legacy expedition routine, cleared on return. */
const ETAT_FINI_EXPEDIE = 4
/** État "Validé" — where a roll sat just before shipping, so where it returns to. */
const ETAT_FINI_VALIDE = 3

clientsRouter.post('/:id/marchandise/retour-stock', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'retour_marchandise')
    if (!allowed) { res.status(403).json({ error: 'permission denied: retour_marchandise' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = retourStockBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }

    const clientRows = await query<Record<string, unknown>>(`SELECT IDclient, nom FROM client WHERE IDclient = ${id}`)
    if (clientRows.length === 0) { res.status(404).json({ error: 'Client not found' }); return }
    const clientFixed = await fixEncoding(clientRows, 'client', 'IDclient', ['nom'])
    const clientNom = strOf(clientFixed[0].nom) ?? `client ${id}`

    // Scope guard: only rolls actually shipped to THIS client are eligible.
    const scoped = await query<Record<string, unknown>>(
      `SELECT sf.IDstock_fini, sf.observations, sf.IDetat_stock_fini FROM stock_fini sf ` +
        `INNER JOIN ligne_expedition le ON sf.IDligne_expedition = le.IDligne_expedition ` +
        `INNER JOIN expedition e ON le.IDexpedition = e.IDexpedition ` +
        `INNER JOIN commande_client cc ON e.IDcommande_client = cc.IDcommande_client ` +
        `WHERE cc.IDclient = ${id} AND sf.IDstock_fini IN (${parsed.data.ids.join(',')})`,
    )
    if (scoped.length === 0) { res.status(404).json({ error: 'No matching shipped rolls for this client' }); return }
    const repaired = await fixEncoding(scoped, 'stock_fini', 'IDstock_fini', ['observations'])

    const d = new Date()
    const p = (x: number) => String(x).padStart(2, '0')
    const line = `Récupéré chez ${clientNom} le ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`

    for (const r of repaired) {
      const sid = numOf(r.IDstock_fini)
      if (!(sid > 0)) continue
      // Empty observations come back as a lone NUL byte — treat as empty.
      const existing = (strOf(r.observations) ?? '').replace(/\u0000/g, '').trim()
      const obs = existing ? `${existing}\r\n${line}` : line
      const sets = [
        'IDligne_expedition = 0',
        'IDligne_commande_client = 0',
        `observations = ${sqlText(obs)}`,
      ]
      // Only demote état 4; any other état is the warehouse's own classification.
      if (numOf(r.IDetat_stock_fini) === ETAT_FINI_EXPEDIE) {
        sets.push(`IDetat_stock_fini = ${ETAT_FINI_VALIDE}`)
      }
      await query(`UPDATE stock_fini SET ${sets.join(', ')} WHERE IDstock_fini = ${sid}`)
    }
    res.json({ ok: true, returned: repaired.length, skipped: parsed.data.ids.length - repaired.length })
  } catch (err) {
    console.error('Error returning marchandise to stock:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Contacts / adresses CRUD — shared verbatim with the TRM ledger.
registerContactAdresseRoutes(clientsRouter)


// ════════════════════════════════════════════════════════
//  FICHE TARIFS  — selection-driven PDF + email
// ════════════════════════════════════════════════════════
// Port of the legacy Choix_Matiere_Tarif → "Fiche Tarif" report. The client
// picks (référence × coloris) pairs (= ref_client_colori rows); each pair's
// €/Ml prices come from calcTarifRefFini (PrixDeVenteV4), keeping only the
// tranches listed in ref_client_colori.lst_tranche ("0,1,2,3,4,5,6" = indices
// into the 9-tranche array: <1,1,2,3,4,5,10,15,30 rolls).
//
//   GET  /:id/tarifs/pdf?items=<IDref_client_colori,...>   — inline PDF
//   GET  /:id/tarifs/email-defaults                        — recipients + subject/body
//   POST /:id/tarifs/email?items=...                       — send with PDF attached
//
// The selection travels as a query param in all cases (the email POST body is
// the shared SendPayload shape, which has no room for screen-specific fields).

/** Parse the ?items= query into a bounded list of ref_client_colori ids. */
function parseTarifItems(raw: unknown): number[] {
  const ids = String(raw ?? '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0)
  return [...new Set(ids)].slice(0, 80)
}

function formatDateShortFr(d: Date): string {
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`
}

const MOIS_FR = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre']
function formatDateLongFr(d: Date): string {
  return `${d.getDate()} ${MOIS_FR[d.getMonth()]} ${d.getFullYear()}`
}

/** Fetch the client's display name (nom is ASCII-named — safe on both
 *  platforms; accent repair via fixEncoding). Returns null if not found. */
async function fetchClientNom(id: number): Promise<string | null> {
  const rows = await query<Record<string, unknown>>(`SELECT IDclient, nom FROM client WHERE IDclient = ${id}`)
  if (rows.length === 0) return null
  const fixed = await fixEncoding(rows, 'client', 'IDclient', ['nom'])
  return (strOf(fixed[0]?.nom) ?? '').trim() || `Client ${id}`
}

/** Build the Fiche Tarifs PDF data for a client + a ref_client_colori
 *  selection. Returns null when the client doesn't exist; sections may be
 *  empty when nothing in the selection is priceable (caller decides). */
async function buildTarifsPdfData(clientId: number, rccIds: number[]): Promise<TarifsClientPdfData | null> {
  const clientNom = await fetchClientNom(clientId)
  if (clientNom === null) return null

  // Selected coloris rows → their designations (scope-checked to the client).
  const rccRows = await query<Record<string, unknown>>(
    `SELECT * FROM ref_client_colori WHERE IDref_client_colori IN (${rccIds.join(',')})`,
  )
  const desigIds = [...new Set(rccRows.map((r) => numOf(r.IDdesignation_client)).filter((n) => n > 0))]
  if (desigIds.length === 0) return { clientNom, dateDocument: '', validUntil: '', sections: [] }

  const dRows = await query<Record<string, unknown>>(
    `SELECT * FROM designation_client WHERE IDdesignation_client IN (${desigIds.join(',')})`,
  )
  const dFixed = await fixEncoding(dRows, 'designation_client', 'IDdesignation_client', ['designation'])
  // Scope guard: drop any selection row whose designation belongs to another client.
  const desigById = new Map<number, Record<string, unknown>>()
  for (const d of dFixed) {
    if (numOf(d.IDclient) === clientId) desigById.set(numOf(d.IDdesignation_client), d)
  }

  // ref_fini context (laize / poids / écru) + ref_ecru (contexture / bio).
  const finiIds = [...new Set([...desigById.values()].map((d) => numOf(d.IDref_fini)).filter((n) => n > 0))]
  const finiById = new Map<number, { IDref_ecru: number; avec_teinture: number; laize: number | null; poids: number | null }>()
  if (finiIds.length > 0) {
    const fRows = await query<Record<string, unknown>>(
      `SELECT IDref_fini, IDref_ecru, avec_teinture, laizeHT_Moy, poids_Moy FROM ref_fini WHERE IDref_fini IN (${finiIds.join(',')})`,
    )
    for (const f of fRows) {
      finiById.set(numOf(f.IDref_fini), {
        IDref_ecru: numOf(f.IDref_ecru),
        avec_teinture: numOf(f.avec_teinture),
        laize: f.laizeHT_Moy == null ? null : Math.round(numOf(f.laizeHT_Moy)),
        poids: f.poids_Moy == null ? null : Math.round(numOf(f.poids_Moy)),
      })
    }
  }
  const ecruIds = [...new Set([...finiById.values()].map((f) => f.IDref_ecru).filter((n) => n > 0))]
  const ecruById = new Map<number, { IDcontexture: number; bio: boolean }>()
  if (ecruIds.length > 0) {
    const eRows = await query<Record<string, unknown>>(
      `SELECT IDref_ecru, IDcontexture, bio FROM ref_ecru WHERE IDref_ecru IN (${ecruIds.join(',')})`,
    )
    for (const e of eRows) {
      ecruById.set(numOf(e.IDref_ecru), { IDcontexture: numOf(e.IDcontexture), bio: numOf(e.bio) === 1 })
    }
  }
  const ctxIds = [...new Set([...ecruById.values()].map((e) => e.IDcontexture).filter((n) => n > 0))]
  const ctxById = new Map<number, string>()
  if (ctxIds.length > 0) {
    const cRows = await query<Record<string, unknown>>(
      `SELECT IDcontexture, nom FROM contexture WHERE IDcontexture IN (${ctxIds.join(',')})`,
    )
    const cFixed = await fixEncoding(cRows, 'contexture', 'IDcontexture', ['nom'])
    for (const c of cFixed) ctxById.set(numOf(c.IDcontexture), strOf(c.nom) ?? '')
  }

  // Coloris labels (dye vs wash catalog per avec_teinture).
  const ceMap = await mapSimpleRef('colori_ecru', 'IDcolori_ecru', rccRows.map((r) => numOf(r.IDcolori_ecru)))
  const rfcMap = await mapSimpleRef('ref_fini_colori', 'IDref_fini_colori', rccRows.map((r) => numOf(r.IDref_fini_colori)))

  // Tarif modes (coefficient fixe / contrat) for every selected coloris —
  // batched, and computed off the un-archived selection rows.
  const modeMap = await fetchTarifModes(
    rccRows
      .filter((r) => !numOf(pick(r, 'archivé', 'archiv')))
      .map((r) => ({ id: numOf(r.IDref_client_colori), contrat: numOf(r.contrat) })),
  )

  // Group the selection by designation, keeping the request's item order for
  // columns and ordering sections by ref label.
  interface ColSel {
    rccId: number
    colorisId: number
    label: string
    trancheIdx: number[]
    coefficient: number
    contratPrix: Map<number, number> | null
  }
  const colsByDesig = new Map<number, ColSel[]>()
  const rccById = new Map<number, Record<string, unknown>>(rccRows.map((r) => [numOf(r.IDref_client_colori), r]))
  for (const rccId of rccIds) {
    const r = rccById.get(rccId)
    if (!r) continue
    const did = numOf(r.IDdesignation_client)
    const desig = desigById.get(did)
    if (!desig) continue
    if (numOf(pick(r, 'archivé', 'archiv'))) continue
    const finiId = numOf(desig.IDref_fini)
    if (!(finiId > 0)) continue // écru-only designations have no fini tarif
    const fini = finiById.get(finiId)
    if (!fini) continue
    const finiColId = numOf(r.IDref_fini_colori)
    const ecruColId = numOf(r.IDcolori_ecru)
    const colorisId = fini.avec_teinture !== 0 ? finiColId : ecruColId
    if (!(colorisId > 0)) continue
    const label = (finiColId > 0 ? rfcMap.get(finiColId) : ceMap.get(ecruColId)) ?? ''
    let trancheIdx = parseLstTrancheIdx(strOf(r.lst_tranche))

    // Client tarif mode overrides: an ACTIVE contrat prints exactly its
    // negotiated tranches at their €/Ml; coefficient fixe recomputes every
    // tranche with the fixed margin. An EXPIRED contrat means the ref is not
    // sellable until a new contract is signed — never print standard prices
    // for it, drop the coloris from the fiche entirely.
    const mode = modeMap.get(rccId)
    let coefficient = 0
    let contratPrix: Map<number, number> | null = null
    if (mode?.tarif_mode === 'coefficient' && mode.coefficient > 0) {
      coefficient = mode.coefficient
    } else if (mode?.tarif_mode === 'contrat') {
      if (!mode.contrat_actif) continue
      contratPrix = new Map()
      for (const t of mode.contrat_actif.tranches) {
        const idx = NB_RLX_TO_TRANCHE_IDX[t.nb_rouleaux]
        if (idx !== undefined && t.prix > 0) contratPrix.set(idx, t.prix)
      }
      if (contratPrix.size > 0) trancheIdx = [...contratPrix.keys()].sort((a, b) => a - b)
      else contratPrix = null
    }

    const arr = colsByDesig.get(did) ?? []
    arr.push({ rccId, colorisId, label, trancheIdx, coefficient, contratPrix })
    colsByDesig.set(did, arr)
  }

  // Price every (fini, coloris) pair.
  const sections: TarifsSectionData[] = []
  const sortedDesigs = [...colsByDesig.keys()].sort((a, b) => {
    const ra = strOf(desigById.get(a)?.designation) ?? ''
    const rb = strOf(desigById.get(b)?.designation) ?? ''
    return ra.localeCompare(rb, 'fr')
  })
  for (const did of sortedDesigs) {
    const desig = desigById.get(did)!
    const cols = colsByDesig.get(did)!
    const finiId = numOf(desig.IDref_fini)
    const fini = finiById.get(finiId)!
    const ecru = ecruById.get(fini.IDref_ecru)

    const tarifs = await Promise.all(
      cols.map((c) => calcTarifRefFini(finiId, c.colorisId, c.coefficient > 0 ? { coefficient: c.coefficient / 100 } : undefined)),
    )

    // Union of the selected coloris' tranche indices, ascending.
    const idxUnion = [...new Set(cols.flatMap((c) => c.trancheIdx))].sort((a, b) => a - b)
    const rows: TarifsSectionData['rows'] = []
    for (const i of idxUnion) {
      // qte_ml / rolls come from any tarif that actually has tranches (same
      // ref → identical quantities across coloris).
      const anyTranche = tarifs.find((t) => t.tranches.length > i)?.tranches[i]
      if (!anyTranche) continue
      rows.push({
        rlx: anyTranche.isMetrage ? '< 1' : String(anyTranche.rolls),
        ml: anyTranche.isMetrage ? `< ${anyTranche.qte_ml}` : String(anyTranche.qte_ml),
        prices: cols.map((c, ci) => {
          if (!c.trancheIdx.includes(i)) return null
          const contrat = c.contratPrix?.get(i)
          if (contrat !== undefined) return contrat
          const t = tarifs[ci].tranches[i]
          return t && t.moPrixDeVenteAuMl > 0 ? t.moPrixDeVenteAuMl : null
        }),
      })
    }
    if (rows.length === 0) continue

    sections.push({
      ref: strOf(desig.designation) ?? '',
      contexture: ecru ? (ctxById.get(ecru.IDcontexture) ?? null) : null,
      laize: fini.laize,
      poids: fini.poids,
      bio: ecru?.bio ?? false,
      colorisLabels: cols.map((c) => c.label),
      rows,
    })
  }

  const now = new Date()
  const validUntil = new Date(now)
  validUntil.setFullYear(validUntil.getFullYear() + 1)

  return {
    clientNom,
    dateDocument: formatDateLongFr(now),
    validUntil: formatDateShortFr(validUntil),
    sections,
  }
}

async function renderTarifsPdfBuffer(data: TarifsClientPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(TarifsClientPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

/** ASCII-safe filename chunk from the client name. */
function tarifsFilename(clientNom: string): string {
  const slug = clientNom
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `tarifs-${slug || 'client'}.pdf`
}

clientsRouter.get('/:id/tarifs/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const items = parseTarifItems(req.query.items)
    if (items.length === 0) { res.status(400).json({ error: 'No items selected' }); return }

    const data = await buildTarifsPdfData(id, items)
    if (!data) { res.status(404).json({ error: 'Client not found' }); return }
    if (data.sections.length === 0) { res.status(400).json({ error: 'No priceable reference in the selection' }); return }

    const buffer = await renderTarifsPdfBuffer(data)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${tarifsFilename(data.clientNom)}"`)
    // Strip helmet's restrictive headers so the web app can iframe the PDF.
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering tarifs PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

clientsRouter.get('/:id/tarifs/email-defaults', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const clientNom = await fetchClientNom(id)
    if (clientNom === null) { res.status(404).json({ error: 'Client not found' }); return }

    const contactRows = await query<Record<string, unknown>>(
      `SELECT IDcontact, nom, prenom, mail, envoi_soumission, est_defaut, est_visible FROM contact WHERE IDclient = ${id}`,
    )
    const fixed = await fixEncoding(contactRows, 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])

    interface Recipient { email: string; name?: string; source: 'contact'; contactId: number }
    const flagged: Recipient[] = []
    const defaults: Recipient[] = []
    const others: Recipient[] = []
    const seen = new Set<string>()
    for (const c of fixed) {
      if (numOf(c.est_visible) === 0 && c.est_visible != null) continue
      const raw = (strOf(c.mail) ?? '').trim()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) continue
      const key = raw.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const displayName = [strOf(c.prenom), strOf(c.nom)]
        .map((s) => (s ?? '').trim())
        .filter((s) => s.length > 0)
        .join(' ')
      const r: Recipient = { email: raw, source: 'contact', contactId: numOf(c.IDcontact) }
      if (displayName) r.name = displayName
      if (numOf(c.envoi_soumission) === 1) flagged.push(r)
      else if (numOf(c.est_defaut) === 1) defaults.push(r)
      else others.push(r)
    }
    // Pre-check the soumission-flagged contacts; fall back to the default
    // contact when nobody carries the flag (tarifs ≈ commercial/soumission).
    const selected = flagged.length > 0 ? flagged : defaults
    const suggestions = flagged.length > 0 ? [...defaults, ...others] : others

    const subject = `Fiche tarifs — ETS Malterre`
    const body =
      `Bonjour,\n\n` +
      `Veuillez trouver ci-joint notre fiche tarifs.\n\n` +
      `Nous restons à votre disposition pour toute information complémentaire.\n\n` +
      `Cordialement,\n` +
      `ETS Malterre`

    res.json({ recipients: { selected, suggestions }, subject, body, clientNom })
  } catch (err) {
    console.error('Error building tarifs email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const tarifExtraAttachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  content_base64: z.string().min(1),
  content_type: z.string().min(1).max(100),
})

const tarifEmailBody = z.object({
  to: z.array(z.string().email()).min(1, 'At least one recipient is required'),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20000),
  attach_pdf: z.boolean().optional(),
  extra_attachments: z.array(tarifExtraAttachmentSchema).optional(),
})

clientsRouter.post('/:id/tarifs/email', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }

    const parsed = tarifEmailBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }

    const senderEmail = await getUserEmail(req.userId)
    if (!senderEmail) {
      res.status(400).json({
        error: 'no_sender_email',
        message:
          "Aucune adresse email n'est associée à votre compte. Un administrateur doit en définir une dans Paramètres › Utilisateurs.",
      })
      return
    }

    const userRows = await query<Record<string, unknown>>(
      `SELECT IDutilisateur, prenom, nom FROM utilisateur WHERE IDutilisateur = ${req.userId}`,
    )
    const fixedUser = await fixEncoding(userRows, 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
    const u = fixedUser[0] ?? null
    const displayName = u
      ? [strOf(u.prenom), strOf(u.nom)].map((s) => (s ?? '').trim()).filter((s) => s.length > 0).join(' ')
      : ''
    const fromName = displayName ? `${displayName} — ETS Malterre` : 'ETS Malterre'

    const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
    if (parsed.data.attach_pdf !== false) {
      const items = parseTarifItems(req.query.items)
      if (items.length === 0) { res.status(400).json({ error: 'No items selected' }); return }
      const data = await buildTarifsPdfData(id, items)
      if (!data) { res.status(404).json({ error: 'Client not found' }); return }
      if (data.sections.length === 0) { res.status(400).json({ error: 'No priceable reference in the selection' }); return }
      const buffer = await renderTarifsPdfBuffer(data)
      attachments.push({
        filename: tarifsFilename(data.clientNom),
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
    console.error('Error sending tarifs email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})
