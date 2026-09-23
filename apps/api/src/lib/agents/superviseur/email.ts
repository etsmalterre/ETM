// Agent « Superviseur » — the 19:00 mail, on the shared notification template
// (lib/notification-email.ts, the malterre_email_report model).
//
// Three blocks: Urgent (new or aggravated), À voir (new), then the findings
// still open from earlier days as one compact line each with their age — so
// the mail stays short enough to be read every evening. `info` findings never
// reach the mail; they stay in the run.

import { EMAIL_STYLE as S, type EmailSection, type NotificationEmailContent } from '../../notification-email.js'
import type { ConstatRun } from './constats.js'
import { DOMAINE_LIBELLE } from './types.js'

const RED = '#B91C1C'
const RED_BG = '#FEF2F2'
const AMBER = '#B45309'
const AMBER_BG = '#FFFBEB'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const TABLE = 'cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"'

export const baseUrl = () => process.env.ERP_BASE_URL?.trim() || 'https://etm.intra.etsmalterre.com'

/** « 3 j », « 1 j », « aujourd’hui » — age of an open finding. */
export function age(depuisIso: string, nowMs: number): string {
  const j = Math.floor((nowMs - new Date(depuisIso).getTime()) / 86_400_000)
  return j <= 0 ? 'aujourd’hui' : `${j} j`
}

function lienHtml(c: ConstatRun): string {
  return c.lien
    ? ` <a href="${esc(baseUrl() + c.lien)}" style="color:${S.navy};font-size:12px;white-space:nowrap;">Ouvrir</a>`
    : ''
}

function bloc(titre: string, couleur: string, fond: string, cs: ConstatRun[]): EmailSection {
  return {
    html:
      `<table ${TABLE}><tr><td style="border-left:3px solid ${couleur};background-color:${fond};padding:12px 14px;font-family:${S.font};">` +
      `<div style="font-size:11px;line-height:1.4;color:${couleur};text-transform:uppercase;letter-spacing:0.4px;font-weight:bold;">${esc(titre)}</div>` +
      cs
        .map(
          (c) =>
            `<div style="font-size:14px;line-height:1.5;color:${S.text};margin-top:8px;">` +
            `<strong>${esc(c.titre)}</strong>${c.etat === 'aggrave' ? ' <span style="color:' + RED + ';font-size:12px;">(aggravé)</span>' : ''}${lienHtml(c)}` +
            `<br><span style="color:${S.muted};font-size:12px;">${esc(DOMAINE_LIBELLE[c.domaine])}</span> · ${esc(c.message)}</div>`,
        )
        .join('') +
      `</td></tr></table>`,
    text: [titre.toUpperCase(), ...cs.map((c) => `- ${c.titre} : ${c.message}${c.lien ? ` (${baseUrl()}${c.lien})` : ''}`)].join('\n'),
  }
}

function tableOuverts(cs: ConstatRun[], nowMs: number): EmailSection {
  const th = (t: string, al = 'left') =>
    `<td align="${al}" style="padding:0 0 8px 0;font-family:${S.font};font-size:11px;color:${S.muted};text-transform:uppercase;letter-spacing:0.4px;">${t}</td>`
  const rows = cs
    .map((c) => {
      const bt = `border-top:1px solid ${S.border};`
      const dot = c.gravite === 'urgent' ? RED : AMBER
      return (
        `<tr><td width="16" style="padding:8px 8px 8px 0;vertical-align:top;${bt}"><div style="width:8px;height:8px;margin-top:5px;border-radius:4px;background-color:${dot};font-size:0;line-height:0;">&nbsp;</div></td>` +
        `<td style="padding:8px 12px 8px 0;font-family:${S.font};font-size:13px;color:${S.text};${bt}"><strong>${esc(c.titre)}</strong>${lienHtml(c)}<br><span style="color:${S.muted};font-size:12px;">${esc(c.message)}</span></td>` +
        `<td align="right" style="padding:8px 0;font-family:${S.font};font-size:12px;color:${S.muted};white-space:nowrap;vertical-align:top;${bt}">${age(c.depuis, nowMs)}</td></tr>`
      )
    })
    .join('')
  return {
    html: `<table ${TABLE}><tr><td></td>${th('Toujours ouvert')}${th('Depuis', 'right')}</tr>${rows}</table>`,
    text: ['TOUJOURS OUVERT', ...cs.map((c) => `- ${c.titre} : ${c.message} (depuis ${age(c.depuis, nowMs)})`)].join('\n'),
  }
}

export interface MailSuperviseur {
  sujet: string
  contenu: NotificationEmailContent
}

/** The mail for one run. `lienRun` = ETM path of the run (deep link). */
export function construireMail(cs: ConstatRun[], nbFermes: number, nowMs: number, lienRun: string): MailSuperviseur {
  const aMailer = cs.filter((c) => c.gravite !== 'info')
  const neufs = aMailer.filter((c) => c.etat !== 'ouvert')
  const urgents = neufs.filter((c) => c.gravite === 'urgent')
  const aVoir = neufs.filter((c) => c.gravite === 'attention')
  const ouverts = aMailer.filter((c) => c.etat === 'ouvert')
  const sections: EmailSection[] = []
  if (urgents.length) sections.push(bloc('Urgent', RED, RED_BG, urgents))
  if (aVoir.length) sections.push(bloc('À voir', AMBER, AMBER_BG, aVoir))
  if (ouverts.length) sections.push(tableOuverts(ouverts, nowMs))
  const jour = new Date(nowMs).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'Europe/Paris' })
  const n = neufs.length
  return {
    sujet: `Superviseur — ${n} point${n > 1 ? 's' : ''} à voir (${jour})`,
    contenu: {
      title: 'Superviseur ETM',
      tone: 'alert',
      intro: `Le contrôle du soir a trouvé **${n} nouveau${n > 1 ? 'x' : ''} point${n > 1 ? 's' : ''}** qui demande${n > 1 ? 'nt' : ''} votre attention.`,
      rows: [
        { label: 'Urgent', value: String(urgents.length) },
        { label: 'À voir', value: String(aVoir.length) },
        { label: 'Toujours ouvert', value: String(ouverts.length) },
        { label: 'Résolu depuis la dernière fois', value: String(nbFermes) },
      ],
      sections,
      callout: `Détail de l’exécution et avis sur ce contrôle : ${baseUrl()}${lienRun}`,
    },
  }
}
