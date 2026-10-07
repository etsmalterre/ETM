// Sous-traitants › Point — the daily « Point du JJ/MM » to a dyer (MATEL
// first), prepared at 17:00 by the automate « Point sous-traitant »
// (lib/automates/point-sst/, rules in lib/point-sst/regles.ts), checked here
// line by line, then sent now or scheduled (HEURE_ENVOI, 8:00).
//
// Every line carries the Tricobot button: the remark lands in the automate's
// « Retours » (Agents IA › Automates), tied to its line — read before each
// new version of the rules. Edits and removals are kept too (`auto` vs the
// line, `retiree`), so the next version can be written from what people changed.
//
// Gate: seeing the screen (Écrans: Sous-traitants › Point) — no action key.
// ⚠️ No file extension in a route (the Word file is /:id/word): nginx serves
// static extensions before /api/ (CLAUDE.md, #1222).

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { mpsPg } from '../lib/mps-pg.js'
import { userCanOpenScreen } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { auteur } from './agents-ia.js'
import {
  ajouterLigne, enregistrerEnvoi, listerPoints, lirePoint, modifierLigne, noterRetourLigne, PointEnvoye, PointIntrouvable,
  preparerPoint, programmer, restaurerLigne, retirerLigne,
} from '../lib/point-sst/db.js'
import { docx, nomDocx, pageApercu } from '../lib/point-sst/rendu.js'
import { EnvoiImpossible, envoyerPoint, POINT_EXPEDITEUR } from '../lib/point-sst/envoi.js'
import { HEURE_ENVOI, jourSuivantOuvre, SECTIONS, type Section } from '../lib/point-sst/regles.js'
import { SLUG as SLUG_AUTOMATE, VERSION, sousTraitantsDuPoint } from '../lib/automates/point-sst/point-sst.js'
import { ajouterRetour, lireEtat, supprimerRetour } from '../lib/automates/store.js'
import { msHeureParis, partiesParis } from '../lib/pointage-etat.js'
import { corpsEnTexte } from '../lib/email-riche.js'

export const pointsSstRouter: RouterType = Router()

const MENU = '/sous-traitants'
export const ECRAN_POINT_SST = '/sous-traitants/point'

async function garde(req: Request, res: Response): Promise<number | null> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return null
  }
  if (!(await userCanOpenScreen(req.userId, isEffectiveAdmin(req), MENU, ECRAN_POINT_SST))) {
    res.status(403).json({ error: 'écran non accessible' })
    return null
  }
  return req.userId
}

const idParam = (v: unknown) => {
  const id = Number.parseInt(String(v), 10)
  return Number.isFinite(id) && id > 0 ? id : null
}

function erreur(res: Response, err: unknown, quoi: string) {
  if (err instanceof PointIntrouvable) { res.status(404).json({ error: err.message }); return }
  if (err instanceof PointEnvoye || err instanceof EnvoiImpossible) { res.status(409).json({ error: err.message }); return }
  console.error(`[points-sst] ${quoi} failed:`, err)
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
}

const isoParis = (ms: number) => { const p = partiesParis(ms); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` }

// ── GET / — the list + what the screen needs to create one ──
pointsSstRouter.get('/', async (req, res) => {
  if ((await garde(req, res)) === null) return
  try {
    const sql = mpsPg()
    const [points, etat, ssts] = await Promise.all([
      listerPoints(),
      lireEtat(SLUG_AUTOMATE),
      sql<{ id: number; nom: string }[]>`SELECT idsous_traitant AS id, nom FROM sous_traitant WHERE idtype_sst = 2 AND COALESCE(est_visible, 1) = 1 ORDER BY nom`,
    ])
    res.json({
      points,
      automate: { mode: etat.mode, version: VERSION },
      sousTraitants: ssts.map((s) => ({ id: Number(s.id), nom: s.nom, automatique: sousTraitantsDuPoint().includes(Number(s.id)) })),
      prochainJour: jourSuivantOuvre(isoParis(Date.now())),
      expediteur: POINT_EXPEDITEUR,
      heureEnvoi: HEURE_ENVOI,
      sections: SECTIONS,
    })
  } catch (err) { erreur(res, err, 'list') }
})

/** The dyer's contacts with an e-mail — who the point can go to. */
async function contactsDe(idsst: number): Promise<{ email: string; nom: string }[]> {
  const sql = mpsPg()
  const rows = await sql<{ nom: string | null; prenom: string | null; mail: string | null }[]>`
    SELECT nom, prenom::text AS prenom, mail FROM contact
    WHERE idsous_traitant = ${idsst} AND COALESCE(est_visible, 1) = 1 AND COALESCE(TRIM(mail), '') <> '' ORDER BY nom`
  return rows.map((r) => ({ email: String(r.mail).trim(), nom: [r.prenom, r.nom].filter((x) => x && String(x).trim()).join(' ').trim() }))
}

// ── POST /preparer — prepare (or refresh) the point of a day by hand ──
const preparerBody = z.object({ idsousTraitant: z.number().int().positive(), jour: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
pointsSstRouter.post('/preparer', async (req, res) => {
  const uid = await garde(req, res)
  if (uid === null) return
  const b = preparerBody.safeParse(req.body)
  if (!b.success) { res.status(400).json({ error: 'sous-traitant et jour requis' }); return }
  try {
    const qui = await auteur(uid)
    const r = await preparerPoint(b.data.idsousTraitant, b.data.jour, qui.nom, VERSION)
    if (r.envoye) { res.status(409).json({ error: 'Le point de ce jour est déjà envoyé.', id: r.id }); return }
    res.status(r.cree ? 201 : 200).json(r)
  } catch (err) { erreur(res, err, 'preparer') }
})

// ── GET /:id ──
pointsSstRouter.get('/:id', async (req, res) => {
  if ((await garde(req, res)) === null) return
  const id = idParam(req.params.id)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  try { res.json({ point: await lirePoint(id) }) } catch (err) { erreur(res, err, 'get') }
})

// ── POST /:id/actualiser — re-run the rules, keep every edit ──
pointsSstRouter.post('/:id/actualiser', async (req, res) => {
  const uid = await garde(req, res)
  if (uid === null) return
  const id = idParam(req.params.id)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  try {
    const p = await lirePoint(id)
    if (p.statut === 'envoye') throw new PointEnvoye()
    res.json(await preparerPoint(p.idsousTraitant, p.jour, (await auteur(uid)).nom, VERSION))
  } catch (err) { erreur(res, err, 'actualiser') }
})

// ── Lines ──
const section = z.number().int().min(1).max(6).transform((n) => n as Section)
const ligneBody = z.object({
  section: section.optional(),
  commande: z.string().max(40).optional(),
  reference: z.string().max(120).optional(),
  coloris: z.string().max(300).optional(),
  datePrevue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  commentaire: z.string().max(500).optional(),
})

pointsSstRouter.post('/:id/lignes', async (req, res) => {
  const uid = await garde(req, res)
  if (uid === null) return
  const id = idParam(req.params.id)
  const b = ligneBody.extend({ section }).safeParse(req.body)
  if (!id || !b.success) { res.status(400).json({ error: 'requête invalide' }); return }
  try {
    const lid = await ajouterLigne(id, b.data.section, b.data, (await auteur(uid)).nom)
    res.status(201).json({ id: lid, point: await lirePoint(id) })
  } catch (err) { erreur(res, err, 'ajouter ligne') }
})

pointsSstRouter.patch('/:id/lignes/:lid', async (req, res) => {
  const uid = await garde(req, res)
  if (uid === null) return
  const id = idParam(req.params.id)
  const lid = idParam(req.params.lid)
  const b = ligneBody.safeParse(req.body)
  if (!id || !lid || !b.success) { res.status(400).json({ error: 'requête invalide' }); return }
  try {
    await modifierLigne(id, lid, b.data, (await auteur(uid)).nom)
    res.json({ point: await lirePoint(id) })
  } catch (err) { erreur(res, err, 'modifier ligne') }
})

pointsSstRouter.delete('/:id/lignes/:lid', async (req, res) => {
  const uid = await garde(req, res)
  if (uid === null) return
  const id = idParam(req.params.id)
  const lid = idParam(req.params.lid)
  if (!id || !lid) { res.status(400).json({ error: 'requête invalide' }); return }
  try {
    await retirerLigne(id, lid, (await auteur(uid)).nom)
    res.json({ point: await lirePoint(id) })
  } catch (err) { erreur(res, err, 'retirer ligne') }
})

pointsSstRouter.post('/:id/lignes/:lid/restaurer', async (req, res) => {
  const uid = await garde(req, res)
  if (uid === null) return
  const id = idParam(req.params.id)
  const lid = idParam(req.params.lid)
  if (!id || !lid) { res.status(400).json({ error: 'requête invalide' }); return }
  try {
    await restaurerLigne(id, lid, (await auteur(uid)).nom)
    res.json({ point: await lirePoint(id) })
  } catch (err) { erreur(res, err, 'restaurer ligne') }
})

// ── Tricobot feedback on a line → the automate's « Retours » ──
const retourBody = z.object({ texte: z.string().trim().min(1).max(4000) })
pointsSstRouter.post('/:id/lignes/:lid/retour', async (req, res) => {
  const uid = await garde(req, res)
  if (uid === null) return
  const id = idParam(req.params.id)
  const lid = idParam(req.params.lid)
  const b = retourBody.safeParse(req.body)
  if (!id || !lid || !b.success) { res.status(400).json({ error: 'Dites à Tricobot ce qui n’allait pas.' }); return }
  try {
    const p = await lirePoint(id)
    const l = p.lignes.find((x) => x.id === lid)
    if (!l) throw new PointIntrouvable()
    const par = await auteur(uid)
    const titre = SECTIONS.find((s) => s.n === l.section)?.court ?? `§${l.section}`
    const quoi = [l.commande, l.reference, l.coloris].filter(Boolean).join(' · ') || 'ligne'
    const libelle = `${p.sousTraitant} — point du ${p.jour.slice(8, 10)}/${p.jour.slice(5, 7)} · ${l.section}. ${titre} · ${l.origine === 'manuel' ? 'ligne ajoutée à la main · ' : ''}${quoi}`
    if (l.retour) await supprimerRetour(SLUG_AUTOMATE, l.retour.id, par)
    const r = await ajouterRetour(SLUG_AUTOMATE, { version: p.version, texte: b.data.texte, par, cible: { libelle, lien: `${ECRAN_POINT_SST}?point=${id}` } })
    await noterRetourLigne(id, lid, { id: r.id, texte: r.texte, par: par.nom })
    res.status(201).json({ point: await lirePoint(id) })
  } catch (err) { erreur(res, err, 'retour') }
})

pointsSstRouter.delete('/:id/lignes/:lid/retour', async (req, res) => {
  const uid = await garde(req, res)
  if (uid === null) return
  const id = idParam(req.params.id)
  const lid = idParam(req.params.lid)
  if (!id || !lid) { res.status(400).json({ error: 'requête invalide' }); return }
  try {
    const p = await lirePoint(id)
    const l = p.lignes.find((x) => x.id === lid)
    if (!l?.retour) throw new PointIntrouvable()
    if (!(await supprimerRetour(SLUG_AUTOMATE, l.retour.id, await auteur(uid)))) {
      res.status(403).json({ error: 'Seule la personne qui l’a écrit peut annuler ce retour.' })
      return
    }
    await noterRetourLigne(id, lid, null)
    res.json({ point: await lirePoint(id) })
  } catch (err) { erreur(res, err, 'annuler retour') }
})

// ── What goes out ──
// The point as it will read in the email, as a page: the email dialog's preview pane iframes it.
pointsSstRouter.get('/:id/apercu', async (req, res) => {
  if ((await garde(req, res)) === null) return
  const id = idParam(req.params.id)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  try {
    const p = await lirePoint(id)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(pageApercu(p))
  } catch (err) { erreur(res, err, 'apercu') }
})

pointsSstRouter.get('/:id/word', async (req, res) => {
  if ((await garde(req, res)) === null) return
  const id = idParam(req.params.id)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  try {
    const p = await lirePoint(id)
    const buf = await docx(p)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(nomDocx(p))}`)
    res.send(buf)
  } catch (err) { erreur(res, err, 'word') }
})

// ── The standard email dialog (SendEmailDialog) ──
// GET /:id/email-defaults — recipients carried over from the last point sent to
// this dyer, every other contact as a suggestion; the message typed last time.
pointsSstRouter.get('/:id/email-defaults', async (req, res) => {
  if ((await garde(req, res)) === null) return
  const id = idParam(req.params.id)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  try {
    const p = await lirePoint(id)
    const contacts = await contactsDe(p.idsousTraitant)
    const choisis = new Set(p.destinataires.map((d) => d.email.toLowerCase()))
    const enCopie = new Set([...p.cc, ...p.cci].map((d) => d.email.toLowerCase()))
    const nomDe = (email: string) => contacts.find((c) => c.email.toLowerCase() === email.toLowerCase())?.nom || p.destinataires.find((d) => d.email === email)?.nom || undefined
    res.json({
      recipients: {
        selected: p.destinataires.map((d) => ({ email: d.email, name: nomDe(d.email), source: contacts.some((c) => c.email.toLowerCase() === d.email.toLowerCase()) ? 'contact' : 'manual' })),
        suggestions: contacts
          .filter((c) => !choisis.has(c.email.toLowerCase()) && !enCopie.has(c.email.toLowerCase()))
          .map((c) => ({ email: c.email, name: c.nom || undefined, source: 'contact' })),
      },
      cc: p.cc.map((d) => d.email),
      bcc: p.cci.map((d) => d.email),
      subject: p.sujet,
      body: p.introduction,
      optional_attachments: [{ id: 'word', default_checked: p.avecDocx }],
    })
  } catch (err) { erreur(res, err, 'email-defaults') }
})

// POST /:id/email — the dialog's payload (postEmail). `programme: true` = the
// « Programmer » button: saved and sent at HEURE_ENVOI (8:00) on the point's day by the automate.
const piece = z.object({ filename: z.string().min(1).max(255), content_base64: z.string(), content_type: z.string().max(200) })
const emailBody = z.object({
  to: z.array(z.string().trim().email()).min(1, 'Ajoutez au moins un destinataire'),
  cc: z.array(z.string().trim().email()).optional(),
  bcc: z.array(z.string().trim().email()).optional(),
  subject: z.string().trim().min(1).max(300),
  body: z.string().max(20000),
  word: z.boolean().optional(),
  programme: z.boolean().optional(),
  extra_attachments: z.array(piece).max(10).optional(),
  dev_skip_send: z.boolean().optional(),
})
pointsSstRouter.post('/:id/email', async (req, res) => {
  const uid = await garde(req, res)
  if (uid === null) return
  const id = idParam(req.params.id)
  const b = emailBody.safeParse(req.body)
  if (!id || !b.success) { res.status(400).json({ error: b.success ? 'id invalide' : b.error.issues[0]?.message ?? 'requête invalide' }); return }
  try {
    const par = await auteur(uid)
    const p = await lirePoint(id)
    if (p.statut === 'envoye') throw new PointEnvoye()
    const quand = heureEnvoi(p.jour)
    if (b.data.programme) {
      if (quand.getTime() <= Date.now()) throw new EnvoiImpossible(`${HEURE_ENVOI} h est déjà passé pour ce point : envoyez-le maintenant.`)
      if ((await lireEtat(SLUG_AUTOMATE)).mode !== 'actif') throw new EnvoiImpossible('L’automate « Point sous-traitant » n’est pas actif : un envoi programmé ne partirait pas. Envoyez maintenant, ou activez-le dans Agents IA › Automates.')
    }
    const contacts = await contactsDe(p.idsousTraitant)
    const avecNom = (email: string) => ({ email, nom: contacts.find((c) => c.email.toLowerCase() === email.toLowerCase())?.nom ?? '' })
    await enregistrerEnvoi(id, {
      destinataires: b.data.to.map(avecNom),
      cc: (b.data.cc ?? []).map(avecNom),
      cci: (b.data.bcc ?? []).map(avecNom),
      sujet: b.data.subject,
      // The point lays the message out itself (mail, Word): keep it as text.
      message: corpsEnTexte(b.data.body),
      avecDocx: !!b.data.word,
      pieces: b.data.extra_attachments ?? [],
    })
    if (b.data.programme) {
      await programmer(id, quand.toISOString(), { id: par.id, nom: par.nom })
      res.json({ ok: true, programme: true })
      return
    }
    const r = await envoyerPoint(id, { id: par.id, nom: par.nom }, !!b.data.dev_skip_send)
    res.json({ ok: true, messageId: r.messageId, essai: r.essai })
  } catch (err) { erreur(res, err, 'email') }
})

pointsSstRouter.delete('/:id/programme', async (req, res) => {
  const uid = await garde(req, res)
  if (uid === null) return
  const id = idParam(req.params.id)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  try {
    const par = await auteur(uid)
    await programmer(id, null, { id: par.id, nom: par.nom })
    res.json({ point: await lirePoint(id) })
  } catch (err) { erreur(res, err, 'annuler programme') }
})

/** HEURE_ENVOI Paris on the point's day. */
function heureEnvoi(jour: string): Date {
  return new Date(msHeureParis(+jour.slice(0, 4), +jour.slice(5, 7), +jour.slice(8, 10), HEURE_ENVOI))
}

