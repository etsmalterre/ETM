// « Tricobot » feedback given where the work is done (decision Vincent
// 2026-10-02; lib/agents/retours.ts). Users only see Tricobot; each route
// below knows which agent produced the item and sends the feedback there.
//
//   PUT /bl-reception — rolls received from a BL Tricobot pre-filled
//     (Sous-traitants › Commandes › Réception): received as pre-filled =
//     réussite, any pre-filled value changed = échec with what changed (and
//     why, if said). Scored per BL run, the one that wrote the lot.
//
//   GET /conversation — what Tricobot did with a Gmail conversation, for the
//     Tricobot Gmail extension (apps/gmail-extension).
//   GET /fil — that conversation's mails, read live from Gmail (+ attachments).
//
// Gate: the screen where the work is done (Écrans), no action key.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { userCanOpenScreen, userHasPermission } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { auteur } from './agents-ia.js'
import { enregistrerRetour } from '../lib/agents/retours.js'
import { BL_ENNOBLISSEUR_SLUG, runDuLot } from '../lib/agents/bl-ennoblisseur.js'
import { agentsDeLaBoite, chargerConversation, filConnu, lireFilConversation } from '../lib/tricobot-conversation.js'
import { gmailLectureErreur, lireFil, lirePieceJointe } from '../lib/gmail-reader.js'
import { ECRAN_FACTURES_SST } from './factures-sst.js'

export const tricobotRouter: RouterType = Router()

async function garde(req: Request, res: Response, menu: string, ecran: string): Promise<number | null> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return null
  }
  if (!(await userCanOpenScreen(req.userId, isEffectiveAdmin(req), menu, ecran))) {
    res.status(403).json({ error: 'écran non accessible' })
    return null
  }
  return req.userId
}

const blReception = z.object({
  ligneId: z.number().int().positive(),
  lots: z.array(z.object({
    lot: z.string().trim().min(1).max(100),
    /** What the person changed in Tricobot's pre-fill, one line each (« 3505/14 poids 21,4 → 24,1 »). */
    corrections: z.array(z.string().max(300)).max(200),
  })).min(1).max(50),
  /** The person's why, when they gave one. */
  commentaire: z.string().max(2000).default(''),
})

tricobotRouter.put('/bl-reception', async (req, res) => {
  const uid = await garde(req, res, '/sous-traitants', '/sous-traitants/ennoblissement')
  if (uid === null) return
  const p = blReception.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'corps invalide' }); return }
  try {
    const par = await auteur(uid)
    const retours: Array<{ lot: string; runId: string | null; juste: boolean }> = []
    for (const { lot, corrections } of p.data.lots) {
      const run = await runDuLot(p.data.ligneId, lot)
      const juste = corrections.length === 0
      if (run) {
        // The person's comment and the field changes are stored apart: both matter.
        const commentaire = juste ? '' : p.data.commentaire.trim()
        await enregistrerRetour({ slug: BL_ENNOBLISSEUR_SLUG, runId: run.id, cle: null, juste, commentaire, corrections: juste ? [] : corrections, par, garderEchec: true })
      }
      retours.push({ lot, runId: run?.id ?? null, juste })
    }
    res.json({ retours })
  } catch (err) {
    console.error('[tricobot] bl-reception failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /conversation — the Tricobot Gmail extension's panel ──
// ?boite=<mailbox open in Gmail>&thread=<hex>&messages=<hex>,<hex>…
// What Tricobot did with that conversation (lib/tricobot-conversation.ts) and
// which of the panel's gestures the caller may make. Read: any session.

const GMAIL_ID = /^[0-9a-f]{6,32}$/i
const MAX_MESSAGES = 100

tricobotRouter.get('/conversation', async (req, res) => {
  if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
  const uid = req.userId
  const texte = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const thread = texte(req.query.thread) || null
  const messages = texte(req.query.messages).split(',').map((s) => s.trim()).filter(Boolean)
  const boite = texte(req.query.boite).toLowerCase() || null
  if (thread !== null && !GMAIL_ID.test(thread)) { res.status(400).json({ error: 'thread invalide' }); return }
  if (messages.length > MAX_MESSAGES || messages.some((id) => !GMAIL_ID.test(id))) { res.status(400).json({ error: 'messages invalides' }); return }
  if (thread === null && messages.length === 0) { res.status(400).json({ error: 'thread ou messages requis' }); return }
  if (boite !== null && !/^[^\s@]+@[^\s@]+$/.test(boite)) { res.status(400).json({ error: 'boîte invalide' }); return }
  try {
    const admin = isEffectiveAdmin(req)
    const [conversation, piloter, correcteur, factures] = await Promise.all([
      chargerConversation(boite, thread, messages),
      userHasPermission(uid, admin, 'edit_agents_ia'),
      userHasPermission(uid, admin, 'corriger_triage'),
      userCanOpenScreen(uid, admin, '/sous-traitants', ECRAN_FACTURES_SST),
    ])
    res.json({
      ...conversation,
      // Triage: pilot or corriger_triage (routes/agents-ia.ts correcteurTriage).
      // BL « vérifié » / échec: the pilot's gestures (pilote). Invoice lines:
      // whoever checks the invoices.
      droits: { corrigerTriage: piloter || correcteur, piloter, factures },
    })
  } catch (err) {
    console.error('[tricobot] conversation failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /fil — the thread as chat bubbles (the panel's « Conversation » tab) ──
// ?boite=&thread=. Only a mailbox an agent reads, only a thread Tricobot
// handled (filConnu): the route never opens the mailbox at large.

async function filAutorise(req: Request, res: Response): Promise<{ boite: string; thread: string } | null> {
  if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return null }
  const boite = typeof req.query.boite === 'string' ? req.query.boite.trim().toLowerCase() : ''
  const thread = String(req.params.thread ?? req.query.thread ?? '').trim()
  if (!GMAIL_ID.test(thread)) { res.status(400).json({ error: 'thread invalide' }); return null }
  if (!boite || agentsDeLaBoite(boite).size === 0) { res.status(404).json({ error: 'boîte non suivie' }); return null }
  if (!(await filConnu(boite, thread))) { res.status(404).json({ error: 'Tricobot n’a pas traité cette conversation.' }); return null }
  return { boite, thread }
}

tricobotRouter.get('/fil', async (req, res) => {
  const f = await filAutorise(req, res)
  if (!f) return
  try {
    res.json({ messages: await lireFilConversation(f.boite, f.thread) })
  } catch (err) {
    console.error('[tricobot] fil failed:', err)
    res.status(502).json({ error: gmailLectureErreur(err) })
  }
})

/** One attachment of a message of that thread, streamed from Gmail. */
tricobotRouter.get('/fil/:thread/messages/:message/pieces/:n', async (req, res) => {
  const f = await filAutorise(req, res)
  if (!f) return
  try {
    const m = (await lireFil(f.boite, f.thread)).find((x) => x.id === req.params.message)
    const p = m?.piecesJointes[parseInt(req.params.n, 10)]
    if (!m || !p) { res.status(404).json({ error: 'pièce jointe introuvable' }); return }
    const buf = await lirePieceJointe(f.boite, m.id, p.attachmentId)
    res.setHeader('Content-Type', p.mimeType || 'application/octet-stream')
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(p.nom)}`)
    res.send(buf)
  } catch (err) {
    console.error('[tricobot] pièce jointe failed:', err)
    res.status(502).json({ error: gmailLectureErreur(err) })
  }
})
