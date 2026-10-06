// Point sous-traitant — sending. From contact@ (where PE's points have always
// left from, and where MATEL answers — the triage agent and the BL agent read
// it), signed with the sending person's own signature (PE's « Pierre-Emmanuel
// Roux / Administration des ventes »).
//
// ⚠️ Outside production the email goes to the sender alone, subject prefixed
// « [ESSAI] »: a dev or worktree API must never write to MATEL.

import { sendMail } from '../gmail.js'
import { getSignatureForEmail } from '../user-profiles.js'
import { getUserEmail } from '../user-emails.js'
import { lirePiecesJointes, lirePoint, marquerEnvoye, type Point } from './db.js'
import { docx, emailHtml, emailTexte, nomDocx } from './rendu.js'

export const POINT_EXPEDITEUR = process.env.POINT_SST_EXPEDITEUR?.trim() || 'contact@etsmalterre.com'
const EXPEDITEUR_NOM = 'ETS Malterre'

export class EnvoiImpossible extends Error {}

export interface ResultatEnvoi {
  messageId: string
  a: string[]
  cc: string[]
  essai: boolean
}

/** `sansEnvoi` = the dialog's dev-only « Faux envoi »: everything but the Gmail call. */
export async function envoyerPoint(idpoint: number, par: { id: number | null; nom: string | null }, sansEnvoi = false): Promise<ResultatEnvoi> {
  const p: Point = await lirePoint(idpoint)
  if (p.statut === 'envoye') throw new EnvoiImpossible('Ce point est déjà envoyé.')
  const a = p.destinataires.map((d) => d.email).filter(Boolean)
  const cc = p.cc.map((d) => d.email).filter(Boolean)
  const cci = p.cci.map((d) => d.email).filter(Boolean)
  if (a.length === 0) throw new EnvoiImpossible('Aucun destinataire : choisissez à qui envoyer le point.')
  if (sansEnvoi && process.env.NODE_ENV !== 'production') {
    await marquerEnvoye(idpoint, par, 'faux-envoi-dev')
    return { messageId: 'faux-envoi-dev', a, cc, essai: true }
  }

  const emailPar = par.id != null ? await getUserEmail(par.id) : null
  const signature = emailPar ? await getSignatureForEmail(emailPar) : null
  const essai = process.env.NODE_ENV !== 'production'
  if (essai && !emailPar) throw new EnvoiImpossible('Hors production, le point part seulement vers votre propre adresse : aucune adresse e-mail sur votre compte.')

  const pieces = [
    ...(p.avecDocx ? [{ filename: nomDocx(p), content: await docx(p), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }] : []),
    // Files attached in the email dialog — stored on the point so a scheduled send carries them too.
    ...(await lirePiecesJointes(idpoint)).map((f) => ({ filename: f.filename, content: Buffer.from(f.content_base64, 'base64'), contentType: f.content_type })),
  ]
  const sujet = p.sujet.trim() || `Point du ${p.jour.slice(8, 10)}/${p.jour.slice(5, 7)}`
  const messageId = await sendMail({
    from: POINT_EXPEDITEUR,
    fromName: EXPEDITEUR_NOM,
    to: essai ? [emailPar!] : a,
    cc: essai ? [] : cc,
    bcc: essai ? [] : cci,
    subject: essai ? `[ESSAI — aurait été envoyé à ${[...a, ...cc, ...cci].join(', ')}] ${sujet}` : sujet,
    body: emailTexte(p),
    bodyHtml: emailHtml(p),
    attachments: pieces,
    signatureHtml: signature?.html ?? null,
    inlineImages: signature?.inlineImages,
  })
  await marquerEnvoye(idpoint, par, messageId)
  return { messageId, a, cc, essai }
}
