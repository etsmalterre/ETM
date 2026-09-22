/**
 * Markup of the two pointage report emails (TRM notifications
 * `notif_rapport_pointage` and `notif_bilan_heures`), inside the standard
 * Malterre notification card (lib/notification-email.ts, skill
 * malterre_email_report). Design validated by Vincent on 2026-09-22:
 *   - daily: a red « À vérifier » note that says what is wrong in words, then
 *     one line per salarié — start, pause 1, pause 2, end as app-style pills,
 *     total pause — red only where something is wrong;
 *   - a day-hours salarié's lunch (clocked out, clocked back in) sits in the
 *     pause columns in its own blue pill (2026-09-22, Nicolas: the row showed
 *     no break at all while the note said « reprise »). The « Pauses » column
 *     then sums pauses and lunch, « 2 h 08 » from an hour up; the 20 min rule
 *     of a shift worker still reads `pauseMin` alone;
 *   - weekly: the annual balances ranked, green up to 5 h, amber to 10 h, red above.
 * Email-safe markup only: tables, inline styles, no <style>, no flexbox.
 * No em / en dash in the content (skill rule).
 */
import { EMAIL_STYLE as S, type EmailSection, type NotificationEmailContent } from './notification-email.js'
import { dureeTexte, hhmm, type LigneRapport, type Plage } from './rapport-pointage.js'

const RED = '#B91C1C'
const RED_BG = '#FEF2F2'
const RED_BORDER = '#FECACA'
const GREEN = '#15803D'
const AMBER = '#B45309'
const FAINT = '#C4C8CE'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const TABLE = 'cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"'

const PILL = {
  heure: { bg: S.pageBg, fg: S.text, bd: S.border },
  pause: { bg: '#FEF7E0', fg: '#7A5A00', bd: '#F8DF8B' },
  repas: { bg: '#EAF2FB', fg: '#1E4F8A', bd: '#BCD5F0' },
  rouge: { bg: RED_BG, fg: RED, bd: RED_BORDER },
} as const

function pill(text: string, kind: keyof typeof PILL): string {
  const k = PILL[kind]
  return (
    `<span style="display:inline-block;background-color:${k.bg};color:${k.fg};border:1px solid ${k.bd};` +
    `border-radius:10px;padding:2px 8px;font-family:${S.font};font-size:12px;line-height:1.4;font-weight:bold;white-space:nowrap;">` +
    `${esc(text)}</span>`
  )
}
const vide = `<span style="font-family:${S.font};font-size:12px;color:${FAINT};">-</span>`
const plage = (p: Plage) => `${hhmm(p.debut)} - ${hhmm(p.fin)}`

/** « lundi 21 septembre » of a YYYYMMDD. */
export function jourLong(jour: string): string {
  const d = new Date(Date.UTC(+jour.slice(0, 4), +jour.slice(4, 6) - 1, +jour.slice(6, 8), 12))
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(d)
}
const majuscule = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function noteAVerifier(lignes: LigneRapport[], avecJour: string | null): EmailSection | null {
  const aVoir = lignes.filter((l) => l.alertes.length)
  if (!aVoir.length) return null
  const titre = avecJour ? `À vérifier · ${jourLong(avecJour)}` : 'À vérifier'
  return {
    html:
      `<table ${TABLE}><tr><td style="border-left:3px solid ${RED};background-color:${RED_BG};padding:12px 14px;font-family:${S.font};">` +
      `<div style="font-size:11px;line-height:1.4;color:${RED};text-transform:uppercase;letter-spacing:0.4px;font-weight:bold;">${esc(titre)}</div>` +
      aVoir
        .map((l) => `<div style="font-size:14px;line-height:1.5;color:${S.text};margin-top:6px;"><strong>${esc(l.salarie.prenom)}</strong> · ${esc(l.alertes.join(' · '))}</div>`)
        .join('') +
      `</td></tr></table>`,
    text: [titre.toUpperCase(), ...aVoir.map((l) => `- ${l.salarie.prenom} : ${l.alertes.join(', ')}`)].join('\n'),
  }
}

function tableJour(lignes: LigneRapport[], titre: string | null): EmailSection {
  const th = (t: string, al = 'center') =>
    `<td align="${al}" style="padding:0 0 8px 0;font-family:${S.font};font-size:11px;color:${S.muted};text-transform:uppercase;letter-spacing:0.4px;white-space:nowrap;">${t}</td>`
  const bt = `border-top:1px solid ${S.border};`
  const td = (html: string, al = 'center') => `<td align="${al}" style="padding:10px 0;vertical-align:middle;${bt}">${html}</td>`
  const heure = (ms: number | null, rouge: boolean) => (ms === null ? pill('non pointé', 'rouge') : pill(hhmm(ms), rouge ? 'rouge' : 'heure'))
  // Pauses and lunch share the two columns, in time order; a third one stacks in the second.
  const creneaux = (l: LigneRapport) =>
    [
      ...l.pauses.map((p) => ({ p, kind: 'pause' as const })),
      ...l.repas.map((p) => ({ p, kind: l.rouge.repas ? ('rouge' as const) : ('repas' as const) })),
    ].sort((a, b) => a.p.debut - b.p.debut)
  const cellule = (cs: ReturnType<typeof creneaux>) =>
    cs.length ? cs.map((c) => pill(plage(c.p), c.kind)).join('<br>') : vide

  const ligne = (l: LigneRapport) => {
    const total = l.pauseMin + l.repasMin
    return (
      '<tr>' +
      `<td style="padding:10px 8px 10px 0;vertical-align:middle;${bt}font-family:${S.font};font-size:14px;font-weight:bold;` +
      `color:${l.alertes.length ? RED : S.navy};">${esc(l.salarie.prenom)}</td>` +
      td(heure(l.debut, l.rouge.debut)) +
      td(cellule(creneaux(l).slice(0, 1))) +
      td(cellule(creneaux(l).slice(1))) +
      td(l.debut === null ? vide : heure(l.fin, l.rouge.fin)) +
      td(
        `<span style="font-family:${S.font};font-size:13px;font-weight:bold;color:${l.rouge.pause ? RED : total ? S.text : FAINT};white-space:nowrap;">` +
          `${total ? dureeTexte(total) : '-'}</span>`,
        'right',
      ) +
      '</tr>'
    )
  }

  const titreHtml = titre
    ? `<div style="font-family:${S.font};font-size:15px;font-weight:bold;color:${S.navy};margin:0 0 10px 0;">${esc(titre)}</div>`
    : ''
  const html =
    titreHtml +
    `<table ${TABLE}><tr>${th('Salarié', 'left')}${th('Début')}${th('Pause 1')}${th('Pause 2')}${th('Fin')}${th('Pauses', 'right')}</tr>` +
    lignes.map(ligne).join('') +
    `</table>`

  const txtHeure = (ms: number | null) => (ms === null ? 'non pointé' : hhmm(ms))
  const text = [
    ...(titre ? [titre.toUpperCase()] : []),
    ...lignes.map((l) =>
      [
        l.salarie.prenom,
        `début ${txtHeure(l.debut)}`,
        ...l.pauses.map((p, i) => `pause ${i + 1} ${plage(p)}`),
        ...l.repas.map((p) => `midi ${plage(p)}`),
        `fin ${l.debut === null ? '-' : txtHeure(l.fin)}`,
        `pauses ${dureeTexte(l.pauseMin + l.repasMin)}`,
      ].join(' · '),
    ),
  ].join('\n')
  return { html, text }
}

export interface JourRapport {
  jour: string
  lignes: LigneRapport[]
}

/** The daily report. `jours` holds the covered days that have at least one line
 *  (a Monday report covers Friday to Sunday). Returns null when nobody clocked
 *  in: no email is sent for an empty day. */
export function contenuRapportPointage(jours: JourRapport[]): { subject: string; content: NotificationEmailContent } | null {
  const pleins = jours.filter((j) => j.lignes.length)
  if (!pleins.length) return null
  const plusieurs = pleins.length > 1
  const toutes = pleins.flatMap((j) => j.lignes)
  const nAVoir = toutes.filter((l) => l.alertes.length).length
  const periode = plusieurs
    ? `du ${jourLong(pleins[0].jour)} au ${jourLong(pleins[pleins.length - 1].jour)}`
    : jourLong(pleins[0].jour)
  const sections: EmailSection[] = []
  for (const j of pleins) {
    const note = noteAVerifier(j.lignes, plusieurs ? j.jour : null)
    if (note) sections.push(note)
  }
  for (const j of pleins) sections.push(tableJour(j.lignes, plusieurs ? majuscule(jourLong(j.jour)) : null))

  const salaries = new Set(toutes.filter((l) => l.debut !== null).map((l) => l.salarie.id)).size
  const bilan = nAVoir
    ? `${nAVoir} ${nAVoir > 1 ? 'pointages à vérifier' : 'pointage à vérifier'}`
    : 'rien à signaler'
  return {
    subject: `Rapport de pointage - ${majuscule(periode)}`,
    content: {
      appName: 'TRM',
      title: 'Rapport de pointage',
      tone: nAVoir ? 'alert' : 'info',
      intro: `**${majuscule(periode)}** · ${salaries} ${salaries > 1 ? 'salariés pointés' : 'salarié pointé'}, ${bilan}.`,
      rows: [],
      footerNote: '',
      sections,
    },
  }
}

// ── Bilan des heures annualisées ──

export interface SoldeSalarie {
  prenom: string
  /** Annual balance in minutes (lib/pointage.ts soldeHeures().cumulMin). */
  soldeMin: number
}

/** The n8n thresholds: |balance| over 10 h red, over 5 h amber, else green. */
export function toneSolde(min: number): 'vert' | 'orange' | 'rouge' {
  const h = Math.abs(min) / 60
  return h > 10 ? 'rouge' : h > 5 ? 'orange' : 'vert'
}

/** « +16:45 » / « −2:30 ». */
export function soldeTexte(min: number): string {
  const a = Math.abs(Math.round(min))
  return `${min < 0 ? '−' : '+'}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`
}

/** The weekly report. `semaine` = the ISO week the balances stop at, with its
 *  Monday and Saturday as YYYYMMDD. Null when no salarié has a balance. */
export function contenuBilanHeures(
  soldes: SoldeSalarie[],
  semaine: { numero: number; lundi: string; samedi: string },
): { subject: string; content: NotificationEmailContent } | null {
  if (!soldes.length) return null
  const tri = [...soldes].sort((a, b) => b.soldeMin - a.soldeMin || a.prenom.localeCompare(b.prenom, 'fr'))
  const COUL = { vert: GREEN, orange: AMBER, rouge: RED }
  const LIB = { vert: 'Dans la marge', orange: 'Entre 5 et 10 h', rouge: 'Au-delà de 10 h' }
  const court = (j: string) =>
    new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(
      new Date(Date.UTC(+j.slice(0, 4), +j.slice(4, 6) - 1, +j.slice(6, 8), 12)),
    )
  const th = (t: string, al = 'left') =>
    `<td align="${al}" style="padding:0 0 8px 0;font-family:${S.font};font-size:11px;color:${S.muted};text-transform:uppercase;letter-spacing:0.4px;">${t}</td>`
  const rows = tri
    .map((s, i) => {
      const t = toneSolde(s.soldeMin)
      const pad = i === 0 ? '0' : '10px'
      const rule = i === 0 ? '' : `border-top:1px solid ${S.border};`
      return (
        '<tr>' +
        `<td width="20" style="padding:${pad} 12px 10px 0;vertical-align:middle;${rule}"><div style="width:8px;height:8px;border-radius:4px;background-color:${COUL[t]};font-size:0;line-height:0;">&nbsp;</div></td>` +
        `<td style="padding:${pad} 16px 10px 0;font-family:${S.font};font-size:14px;font-weight:bold;color:${S.text};${rule}">${esc(s.prenom)}</td>` +
        `<td style="padding:${pad} 16px 10px 0;font-family:${S.font};font-size:12px;color:${S.muted};${rule}">${LIB[t]}</td>` +
        `<td align="right" style="padding:${pad} 0 10px 0;font-family:${S.font};font-size:15px;font-weight:bold;color:${COUL[t]};white-space:nowrap;${rule}">${soldeTexte(s.soldeMin)}</td>` +
        '</tr>'
      )
    })
    .join('')
  const periode = `Semaine ${semaine.numero}, du ${court(semaine.lundi)} au ${court(semaine.samedi)}`
  return {
    subject: `Bilan des heures annualisées - Semaine ${semaine.numero}`,
    content: {
      appName: 'TRM',
      title: 'Bilan des heures annualisées',
      tone: 'info',
      intro: `**${periode}** · solde annuel de chaque salarié (heures lissées − heures prévues − variables), du plus élevé au plus bas.`,
      rows: [],
      footerNote: '',
      sections: [
        {
          html: `<table ${TABLE}><tr><td></td>${th('Salarié')}<td></td>${th('Solde', 'right')}</tr>${rows}</table>`,
          text: tri.map((s) => `${s.prenom} : ${soldeTexte(s.soldeMin)} (${LIB[toneSolde(s.soldeMin)].toLowerCase()})`).join('\n'),
        },
      ],
    },
  }
}
