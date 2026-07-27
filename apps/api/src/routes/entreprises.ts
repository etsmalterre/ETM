import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { sendMail } from '../lib/gmail.js'
import { getUserEmail } from '../lib/user-emails.js'

export const entreprisesRouter: RouterType = Router()

interface Entreprise {
  IDentreprise: number
  nom: string
  commentaire: string | null
}

const TEXT_FIELDS = ['nom', 'commentaire']

const entrepriseBody = z.object({
  nom: z.string().min(1).max(100),
  commentaire: z.string().optional(),
})

/** Escape a string for use in SQL (single quotes doubled) */
function esc(value: string): string {
  return value.replace(/'/g, "''")
}

// GET /api/entreprises - List all
entreprisesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const rows = await query<Entreprise>('SELECT * FROM entreprise ORDER BY IDentreprise')
    const fixed = await fixEncoding(rows, 'entreprise', 'IDentreprise', TEXT_FIELDS)
    res.json(fixed)
  } catch (err) {
    console.error('Error fetching entreprises:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/entreprises/:id - Get by ID with related data
entreprisesRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }

    const rows = await query<Entreprise>(
      `SELECT * FROM entreprise WHERE IDentreprise = ${id}`
    )
    if (rows.length === 0) {
      res.status(404).json({ error: 'Entreprise not found' })
      return
    }

    const fixed = await fixEncoding(rows, 'entreprise', 'IDentreprise', TEXT_FIELDS)

    const [adresses, contacts, competenceLinks, recommandations] = await Promise.all([
      query(`SELECT * FROM adresse WHERE IDentreprise = ${id} ORDER BY est_defaut DESC, IDadresse`),
      query(`SELECT * FROM contact WHERE IDentreprise = ${id} ORDER BY est_defaut DESC, IDcontact`),
      query(`SELECT c.IDcompetence, c.reference FROM entreprise_competence ec, competence c WHERE ec.IDentreprise = ${id} AND ec.IDcompetence = c.IDcompetence ORDER BY c.reference`),
      query(`SELECT * FROM recommandation WHERE IDentreprise = ${id} ORDER BY DATE DESC`),
    ])

    const fixedAdresses = await fixEncoding(adresses, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays', 'commentaire'])
    const fixedContacts = await fixEncoding(contacts, 'contact', 'IDcontact', ['nom', 'prenom', 'tel', 'mail', 'commentaire'])
    const fixedCompetences = await fixEncoding(competenceLinks, 'competence', 'IDcompetence', ['reference'])
    const fixedRecommandations = await fixEncoding(recommandations, 'recommandation', 'IDrecommandation', ['soci', 'contact', 'besoin'])

    res.json({
      ...fixed[0],
      adresses: fixedAdresses,
      contacts: fixedContacts,
      competences: fixedCompetences,
      recommandations: fixedRecommandations,
    })
  } catch (err) {
    console.error('Error fetching entreprise:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/entreprises - Create
entreprisesRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = entrepriseBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }

    const { nom, commentaire } = parsed.data
    await query(
      `INSERT INTO entreprise (nom, commentaire) VALUES ('${esc(nom)}', '${esc(commentaire ?? '')}')`
    )

    // HFSQL does not support RETURNING — fetch the inserted row
    const rows = await query<Entreprise>(
      `SELECT * FROM entreprise WHERE nom = '${esc(nom)}' ORDER BY IDentreprise DESC`
    )

    res.status(201).json(rows[0] ?? { nom, commentaire: commentaire ?? null })
  } catch (err) {
    console.error('Error creating entreprise:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/entreprises/:id - Update
entreprisesRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }

    const parsed = entrepriseBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }

    const { nom, commentaire } = parsed.data
    await query(
      `UPDATE entreprise SET nom = '${esc(nom)}', commentaire = '${esc(commentaire ?? '')}' WHERE IDentreprise = ${id}`
    )

    const rows = await query<Entreprise>(
      `SELECT * FROM entreprise WHERE IDentreprise = ${id}`
    )
    if (rows.length === 0) {
      res.status(404).json({ error: 'Entreprise not found' })
      return
    }

    res.json(rows[0])
  } catch (err) {
    console.error('Error updating entreprise:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/entreprises/:id - Delete
entreprisesRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }

    const rows = await query<Entreprise>(
      `SELECT * FROM entreprise WHERE IDentreprise = ${id}`
    )
    if (rows.length === 0) {
      res.status(404).json({ error: 'Entreprise not found' })
      return
    }

    await query(`DELETE FROM entreprise WHERE IDentreprise = ${id}`)
    res.json({ message: 'Deleted', data: rows[0] })
  } catch (err) {
    console.error('Error deleting entreprise:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Contacts CRUD ────────────────────────────────────────

entreprisesRouter.post('/:id/contacts', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const { nom, prenom, tel, mail } = req.body
    await query(
      `INSERT INTO contact (IDentreprise, nom, prenom, tel, mail, est_defaut, est_visible) VALUES (${id}, '${esc(nom ?? '')}', '${esc(prenom ?? '')}', '${esc(tel ?? '')}', '${esc(mail ?? '')}', 0, 1)`
    )
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('Error creating contact:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

entreprisesRouter.put('/:id/contacts/:cid', async (req: Request, res: Response) => {
  try {
    const cid = parseInt(req.params.cid, 10)
    if (isNaN(cid)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const { nom, prenom, tel, mail } = req.body
    await query(
      `UPDATE contact SET nom = '${esc(nom ?? '')}', prenom = '${esc(prenom ?? '')}', tel = '${esc(tel ?? '')}', mail = '${esc(mail ?? '')}' WHERE IDcontact = ${cid}`
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating contact:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

entreprisesRouter.delete('/:id/contacts/:cid', async (req: Request, res: Response) => {
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

// ── Adresses CRUD ────────────────────────────────────────

entreprisesRouter.post('/:id/adresses', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const { nom, adresse1, cp, ville, pays } = req.body
    await query(
      `INSERT INTO adresse (IDentreprise, nom, adresse1, cp, ville, pays, est_defaut, est_visible) VALUES (${id}, '${esc(nom ?? '')}', '${esc(adresse1 ?? '')}', '${esc(cp ?? '')}', '${esc(ville ?? '')}', '${esc(pays ?? '')}', 0, 1)`
    )
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('Error creating adresse:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

entreprisesRouter.put('/:id/adresses/:aid', async (req: Request, res: Response) => {
  try {
    const aid = parseInt(req.params.aid, 10)
    if (isNaN(aid)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const { nom, adresse1, cp, ville, pays } = req.body
    await query(
      `UPDATE adresse SET nom = '${esc(nom ?? '')}', adresse1 = '${esc(adresse1 ?? '')}', cp = '${esc(cp ?? '')}', ville = '${esc(ville ?? '')}', pays = '${esc(pays ?? '')}' WHERE IDadresse = ${aid}`
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating adresse:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

entreprisesRouter.delete('/:id/adresses/:aid', async (req: Request, res: Response) => {
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

// ── Competences CRUD ─────────────────────────────────────

entreprisesRouter.get('/:id/competences/available', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const rows = await query(
      `SELECT c.IDcompetence, c.reference FROM competence c WHERE c.IDcompetence NOT IN (SELECT IDcompetence FROM entreprise_competence WHERE IDentreprise = ${id}) ORDER BY c.reference`
    )
    const fixed = await fixEncoding(rows, 'competence', 'IDcompetence', ['reference'])
    res.json(fixed)
  } catch (err) {
    console.error('Error fetching available competences:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

entreprisesRouter.post('/:id/competences', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const compId = parseInt(req.body.IDcompetence, 10)
    if (isNaN(id) || isNaN(compId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await query(`INSERT INTO entreprise_competence (IDentreprise, IDcompetence) VALUES (${id}, ${compId})`)
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('Error adding competence:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

entreprisesRouter.delete('/:id/competences/:cid', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const cid = parseInt(req.params.cid, 10)
    if (isNaN(id) || isNaN(cid)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await query(`DELETE FROM entreprise_competence WHERE IDentreprise = ${id} AND IDcompetence = ${cid}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error removing competence:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Recommandations CRUD ─────────────────────────────────

entreprisesRouter.post('/:id/recommandations', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const { société, contact, besoin, date_reco } = req.body
    const dateVal = date_reco ? `'${esc(date_reco.replace(/-/g, ''))}'` : 'NULL'
    await query(
      `INSERT INTO recommandation (IDentreprise, société, contact, besoin, DATE) VALUES (${id}, '${esc(société ?? '')}', '${esc(contact ?? '')}', '${esc(besoin ?? '')}', ${dateVal})`
    )
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('Error creating recommandation:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

entreprisesRouter.put('/:id/recommandations/:rid', async (req: Request, res: Response) => {
  try {
    const rid = parseInt(req.params.rid, 10)
    if (isNaN(rid)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const { société, contact, besoin, date_reco } = req.body
    const dateVal = date_reco ? `'${esc(date_reco.replace(/-/g, ''))}'` : 'NULL'
    await query(
      `UPDATE recommandation SET société = '${esc(société ?? '')}', contact = '${esc(contact ?? '')}', besoin = '${esc(besoin ?? '')}', DATE = ${dateVal} WHERE IDrecommandation = ${rid}`
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating recommandation:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

entreprisesRouter.delete('/:id/recommandations/:rid', async (req: Request, res: Response) => {
  try {
    const rid = parseInt(req.params.rid, 10)
    if (isNaN(rid)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await query(`DELETE FROM recommandation WHERE IDrecommandation = ${rid}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting recommandation:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Email ────────────────────────────────────────────────
//
// Two endpoints mirroring the commandes-fil pattern, minus PDF attachments.
// Entreprise has no document type, so the viewer pane on the frontend
// dialog stays empty and the body is a generic salutation template.
//
// Entreprise contacts have no envoi_* flag (unlike fournisseur contacts), so
// we split default recipients by `est_defaut`: default contacts become
// pre-checked chips, the rest become suggestions the user can click to add.

interface EmailRecipientPayload {
  email: string
  name?: string
  source: 'contact'
  contactId: number
}

interface EntrepriseEmailDefaults {
  recipients: {
    selected: EmailRecipientPayload[]
    suggestions: EmailRecipientPayload[]
  }
  subject: string
  body: string
  entrepriseNom: string
}

async function buildEntrepriseEmailDefaults(id: number): Promise<EntrepriseEmailDefaults | null> {
  const rows = await query<Entreprise>(`SELECT IDentreprise, nom FROM entreprise WHERE IDentreprise = ${id}`)
  if (rows.length === 0) return null
  const fixedEnt = await fixEncoding(rows, 'entreprise', 'IDentreprise', ['nom'])
  const entrepriseNom = ((fixedEnt[0] as any)?.nom ?? '').toString() || ''

  const contactRows = await query<{
    IDcontact: number
    nom: string | null
    prenom: string | null
    mail: string | null
    est_defaut: number | null
    est_visible: number | null
  }>(
    `SELECT IDcontact, nom, prenom, mail, est_defaut, est_visible FROM contact WHERE IDentreprise = ${id}`,
  )
  const fixedContacts = await fixEncoding(contactRows, 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])

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
      contactId: parseInt(c.IDcontact, 10),
    }
    if (displayName) recipient.name = displayName
    if (c.est_defaut === 1) selected.push(recipient)
    else suggestions.push(recipient)
  }

  const subject = 'Message — ETS Malterre'
  const body =
    `Bonjour,\n\n` +
    `…\n\n` +
    `Cordialement,\n` +
    `ETS Malterre`

  return {
    recipients: { selected, suggestions },
    subject,
    body,
    entrepriseNom,
  }
}

entreprisesRouter.get('/:id/email-defaults', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const defaults = await buildEntrepriseEmailDefaults(id)
    if (!defaults) { res.status(404).json({ error: 'Entreprise not found' }); return }
    res.json(defaults)
  } catch (err) {
    console.error('Error building entreprise email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const entrepriseExtraAttachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  content_base64: z.string().min(1),
  content_type: z.string().min(1).max(100),
})

const entrepriseEmailBody = z.object({
  to: z.array(z.string().email()).min(1, 'At least one recipient is required'),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20000),
  extra_attachments: z.array(entrepriseExtraAttachmentSchema).optional(),
})

entreprisesRouter.post('/:id/email', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }

    const parsed = entrepriseEmailBody.safeParse(req.body)
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
      `SELECT prenom, nom FROM utilisateur WHERE IDutilisateur = ${req.userId}`,
    )
    const fixedUser = await fixEncoding(userRows, 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
    const u = (fixedUser[0] as any) ?? null
    const displayName = u
      ? [u.prenom, u.nom].filter((s: string | null) => s && s.trim()).map((s: string) => s.trim()).join(' ')
      : ''
    const fromName = displayName ? `${displayName} — ETS Malterre` : 'ETS Malterre'

    // Decode user-uploaded attachments (base64 JSON payload).
    const attachments: Array<{ filename: string; content: Buffer; contentType: string }> =
      (parsed.data.extra_attachments ?? []).map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content_base64, 'base64'),
        contentType: a.content_type,
      }))

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
    console.error('Error sending entreprise email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})
