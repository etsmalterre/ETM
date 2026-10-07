// Agent « Rapport d'activité » — the e-mail, on the branded notification
// template (lib/notification-email.ts). The facts are code: counts, the code
// signals, the tables of actions and mails. The model's part (summary, mail
// lines, points of attention) is labelled « analyse IA » and presented as
// leads to check, never as findings.

import { EMAIL_STYLE as S, type EmailSection, type NotificationEmailContent } from '../../notification-email.js'
import type { Signal } from './regles.js'

const RED = '#B91C1C'
const RED_BG = '#FEF2F2'
const AMBER = '#92400E'
const AMBER_BG = '#FEF3C7'
const TABLE = 'cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface ActionRapport {
  heure: string
  app: 'ETM' | 'TRM'
  menu: string
  action: string
  resultat: 'ok' | 'refus' | 'erreur'
  erreur: string | null
  /** Journal lines this one stands for (a run merged by regrouper). */
  n: number
}

/** Journal actions behind a list of merged lines. */
export const nbActions = (actions: readonly ActionRapport[]) => actions.reduce((t, a) => t + a.n, 0)

export interface MailRapport {
  heure: string
  sens: 'envoyé' | 'reçu'
  correspondant: string
  sujet: string
  resume: string | null
  sansReponse: boolean
  personnel: boolean
}

export interface ContenuRapport {
  personne: string
  periode: string
  /** Paris day and hour of the report, « mardi 06/10 15:00 ». */
  jour: string
  connexions: string[]
  actions: ActionRapport[]
  mails: MailRapport[]
  signaux: Signal[]
  /** null = the model failed: the e-mail says so and keeps the facts. */
  ia: { synthese: string; etm: string[]; trm: string[]; alertes: Signal[] } | null
  iaErreur: string | null
}

/** Rows per table in the e-mail; the rest is counted. */
const MAX_LIGNES = 120

function titreSection(t: string): string {
  return `<div style="font-family:${S.font};font-size:15px;font-weight:bold;color:${S.navy};margin:0 0 8px 0;">${esc(t)}</div>`
}

function paragraphe(t: string, couleur: string = S.text): string {
  return `<div style="font-family:${S.font};font-size:13px;line-height:1.5;color:${couleur};margin:0 0 6px 0;">${esc(t)}</div>`
}

const COULEUR_GRAVITE: Record<Signal['gravite'], string> = { haute: RED, moyenne: AMBER, basse: S.muted }

function blocAlertes(titre: string, alertes: Signal[], fond: string, bord: string): EmailSection {
  const html =
    `<table ${TABLE}><tr><td style="border-left:3px solid ${bord};background-color:${fond};padding:12px 14px;font-family:${S.font};">` +
    `<div style="font-size:11px;line-height:1.4;color:${bord};text-transform:uppercase;letter-spacing:0.4px;font-weight:bold;">${esc(titre)}</div>` +
    alertes
      .map(
        (a) =>
          `<div style="font-size:13px;line-height:1.5;color:${S.text};margin-top:8px;">` +
          `<span style="color:${COULEUR_GRAVITE[a.gravite]};font-weight:bold;">[${a.gravite} · ${a.nature}]</span> ` +
          `<strong>${esc(a.titre)}</strong><br><span style="color:${S.muted};">${esc(a.detail)}</span></div>`,
      )
      .join('') +
    `</td></tr></table>`
  const text = [titre.toUpperCase(), ...alertes.map((a) => `- [${a.gravite} · ${a.nature}] ${a.titre} : ${a.detail}`)].join('\n')
  return { html, text }
}

function th(t: string, align = 'left'): string {
  return `<td style="padding:0 8px 6px 0;font-family:${S.font};font-size:11px;color:${S.muted};text-transform:uppercase;letter-spacing:0.4px;text-align:${align};border-bottom:1px solid ${S.border};">${esc(t)}</td>`
}

function td(t: string, opts: { couleur?: string; gras?: boolean; nowrap?: boolean } = {}): string {
  return (
    `<td style="padding:5px 8px 5px 0;vertical-align:top;font-family:${S.font};font-size:12px;line-height:1.4;` +
    `color:${opts.couleur ?? S.text};${opts.gras ? 'font-weight:bold;' : ''}${opts.nowrap ? 'white-space:nowrap;' : ''}border-bottom:1px solid ${S.border};">${esc(t)}</td>`
  )
}

/** Per app: the action count and the model's summary lines. No line-by-line
 *  table — too long to read; errors and refusals are already in the code
 *  signals (« Relevé par ETM »). */
function sectionActions(app: 'ETM' | 'TRM', lignesIa: string[], actions: ActionRapport[]): EmailSection | null {
  if (!actions.length && !lignesIa.length) return null
  const titre = `${app} — ${nbActions(actions)} action${nbActions(actions) > 1 ? 's' : ''}`
  const html = titreSection(titre) + lignesIa.map((l) => paragraphe(`• ${l}`)).join('')
  const text = [titre, ...lignesIa.map((l) => `• ${l}`)].join('\n')
  return { html, text }
}

function sectionMails(sens: 'envoyé' | 'reçu', mails: MailRapport[]): EmailSection | null {
  const liste = mails.filter((m) => m.sens === sens)
  if (!liste.length) return null
  const titre = sens === 'envoyé' ? `Mails envoyés — ${liste.length}` : `Mails reçus — ${liste.length}`
  const vues = liste.slice(0, MAX_LIGNES)
  const ligneResume = (m: MailRapport) => (m.personnel ? 'Marqué personnel : non lu.' : (m.resume ?? ''))
  const html =
    titreSection(titre) +
    `<table ${TABLE}><tr>${th('Heure')}${th(sens === 'envoyé' ? 'À' : 'De')}${th('Sujet et résumé')}</tr>` +
    vues
      .map(
        (m) =>
          `<tr>${td(m.heure, { nowrap: true })}${td(m.correspondant)}` +
          `<td style="padding:5px 8px 5px 0;vertical-align:top;font-family:${S.font};font-size:12px;line-height:1.4;color:${S.text};border-bottom:1px solid ${S.border};">` +
          `<strong>${esc(m.sujet || '(sans objet)')}</strong>` +
          (m.sansReponse ? ` <span style="color:${RED};font-weight:bold;">· sans réponse</span>` : '') +
          (ligneResume(m) ? `<br><span style="color:${S.muted};">${esc(ligneResume(m))}</span>` : '') +
          `</td></tr>`,
      )
      .join('') +
    `</table>` +
    (liste.length > vues.length ? paragraphe(`… et ${liste.length - vues.length} autres.`, S.muted) : '')
  const text = [
    titre,
    ...vues.map((m) => `  ${m.heure}  ${m.correspondant} — ${m.sujet || '(sans objet)'}${m.sansReponse ? ' [sans réponse]' : ''}${ligneResume(m) ? ` — ${ligneResume(m)}` : ''}`),
  ].join('\n')
  return { html, text }
}

export function sujetRapport(c: Pick<ContenuRapport, 'personne' | 'jour' | 'signaux' | 'ia'>): string {
  const n = c.signaux.filter((s) => s.gravite !== 'basse').length + (c.ia?.alertes.filter((s) => s.gravite !== 'basse').length ?? 0)
  return `Rapport d’activité — ${c.personne} — ${c.jour}${n ? ` — ${n} point${n > 1 ? 's' : ''} à vérifier` : ''}`
}

export function contenuEmail(c: ContenuRapport): NotificationEmailContent {
  const n = (app: 'ETM' | 'TRM') => nbActions(c.actions.filter((a) => a.app === app))
  const envoyes = c.mails.filter((m) => m.sens === 'envoyé').length
  const recus = c.mails.filter((m) => m.sens === 'reçu').length
  const sansReponse = c.mails.filter((m) => m.sansReponse).length
  const sections: EmailSection[] = []
  if (c.signaux.length) sections.push(blocAlertes('Relevé par ETM (faits)', c.signaux, RED_BG, RED))
  if (c.ia?.alertes.length) sections.push(blocAlertes('Points d’attention — analyse IA, à vérifier', c.ia.alertes, AMBER_BG, AMBER))
  if (c.ia?.synthese) sections.push({ html: titreSection('Synthèse') + paragraphe(c.ia.synthese), text: `SYNTHÈSE\n${c.ia.synthese}` })
  if (!c.ia && c.iaErreur) {
    sections.push({ html: paragraphe(`Analyse IA indisponible (${c.iaErreur}) : le rapport ne contient que les faits.`, AMBER), text: `Analyse IA indisponible : ${c.iaErreur}` })
  }
  for (const app of ['ETM', 'TRM'] as const) {
    const s = sectionActions(app, (app === 'ETM' ? c.ia?.etm : c.ia?.trm) ?? [], c.actions.filter((a) => a.app === app))
    if (s) sections.push(s)
  }
  for (const sens of ['envoyé', 'reçu'] as const) {
    const s = sectionMails(sens, c.mails)
    if (s) sections.push(s)
  }
  return {
    title: `Rapport d’activité — ${c.personne}`,
    tone: c.signaux.some((s) => s.gravite === 'haute') || c.ia?.alertes.some((s) => s.gravite === 'haute') ? 'alert' : 'info',
    intro: `Activité de **${c.personne}** du ${c.periode}.`,
    rows: [
      { label: 'Connexions', value: c.connexions.length ? c.connexions.join(' · ') : 'aucune' },
      { label: 'Actions ETM', value: String(n('ETM')) },
      { label: 'Actions TRM', value: String(n('TRM')) },
      { label: 'Mails', value: `${envoyes} envoyé${envoyes > 1 ? 's' : ''} · ${recus} reçu${recus > 1 ? 's' : ''}${sansReponse ? ` · ${sansReponse} sans réponse` : ''}` },
    ],
    sections,
    appName: 'ETM',
    footerNote:
      'Agent « Rapport d’activité » (Agents IA). Les actions sont celles enregistrées par le serveur ETM/TRM (créations, modifications, suppressions, erreurs) ; les simples consultations ne sont pas enregistrées. Les points de l’analyse IA sont des pistes à vérifier, pas des constats. Les mails marqués personnels ne sont pas lus.',
  }
}
