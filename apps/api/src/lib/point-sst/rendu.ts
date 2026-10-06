// Point sous-traitant — what goes out: the email (HTML + plain text) and the
// optional Word file. Same six numbered sections as Pierre-Emmanuel's « point
// matel » .docx since 2015: MATEL answers « 2) … 4) … 5) … » by number, so the
// numbering never moves — an empty section stays, with « — ».

import { AlignmentType, BorderStyle, Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx'
import { SECTIONS, type Section } from './regles.js'
import { lignesEnvoyees, type Point, type PointLigne } from './db.js'

const jjmmaaaa = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

/** Coloris + remark the way PE writes them: « 0612 marine… - solde ». */
export const colorisEtRemarque = (l: Pick<PointLigne, 'coloris' | 'commentaire'>) =>
  [l.coloris.trim(), l.commentaire.trim()].filter(Boolean).join(' - ')

function parSection(p: Point): Map<Section, PointLigne[]> {
  const m = new Map<Section, PointLigne[]>()
  for (const s of SECTIONS) m.set(s.n, [])
  for (const l of lignesEnvoyees(p)) m.get(l.section)!.push(l)
  return m
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const html = (s: string) => esc(s).replace(/\r?\n/g, '<br>')

const NAVY = '#143D6B'
const BORD = '#d9dee5'

export function emailHtml(p: Point): string {
  const sections = parSection(p)
  const blocs = SECTIONS.map((s) => {
    const lignes = sections.get(s.n)!
    const avecDate = s.n === 1 && lignes.some((l) => l.datePrevue)
    const corps = lignes.length === 0
      ? `<p style="margin:4px 0 0 22px;color:#8a94a3;">—</p>`
      : `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 0 22px;border-collapse:collapse;font-size:13px;">
          ${lignes.map((l) => `<tr>
            <td style="padding:4px 12px 4px 0;border-bottom:1px solid ${BORD};font-weight:600;color:${NAVY};white-space:nowrap;">${esc(l.commande)}</td>
            <td style="padding:4px 12px 4px 0;border-bottom:1px solid ${BORD};white-space:nowrap;">${esc(l.reference)}</td>
            <td style="padding:4px 12px 4px 0;border-bottom:1px solid ${BORD};">${esc(colorisEtRemarque(l))}</td>
            ${avecDate ? `<td style="padding:4px 0;border-bottom:1px solid ${BORD};white-space:nowrap;">${l.datePrevue ? jjmmaaaa(l.datePrevue) : ''}</td>` : ''}
          </tr>`).join('')}
        </table>`
    return `<div style="margin:14px 0 0;">
      <p style="margin:0;font-weight:700;color:#222;">${s.n}. ${esc(s.titre)}</p>
      ${corps}
    </div>`
  }).join('')
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#222222;">
    <p style="margin:0 0 4px;">${html(p.introduction)}</p>
    ${blocs}
    ${p.conclusion.trim() ? `<p style="margin:18px 0 0;">${html(p.conclusion)}</p>` : ''}
  </div>`
}

export function emailTexte(p: Point): string {
  const sections = parSection(p)
  const out = [p.introduction, '']
  for (const s of SECTIONS) {
    out.push(`${s.n}. ${s.titre}`)
    const lignes = sections.get(s.n)!
    if (lignes.length === 0) out.push('   —')
    for (const l of lignes) out.push(`   ${[l.commande, l.reference, colorisEtRemarque(l), l.datePrevue ? jjmmaaaa(l.datePrevue) : ''].filter(Boolean).join('  |  ')}`)
    out.push('')
  }
  if (p.conclusion.trim()) out.push(p.conclusion)
  return out.join('\n')
}

export const nomDocx = (p: Point) => `point ${p.sousTraitant.toLowerCase() || 'sous-traitant'} ${p.jour.slice(8, 10)}${p.jour.slice(5, 7)}${p.jour.slice(0, 4)}.docx`

/** The Word file, laid out like PE's: greeting, numbered questions, one table each, « Merci ». */
export async function docx(p: Point): Promise<Buffer> {
  const sections = parSection(p)
  const sans = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' }
  const bordures = { top: sans, bottom: sans, left: sans, right: sans, insideHorizontal: sans, insideVertical: sans }
  const cellule = (t: string, w: number, gras = false) => new TableCell({
    width: { size: w, type: WidthType.DXA },
    children: [new Paragraph({ children: [new TextRun({ text: t, bold: gras, size: 20 })] })],
  })
  const enfants: (Paragraph | Table)[] = []
  // The Word file keeps PE's layout: a greeting (first line of the message), the questions, « Merci ».
  const salutation = p.introduction.split(/\r?\n/).find((l) => l.trim())?.trim() || 'Bonjour,'
  enfants.push(new Paragraph({ children: [new TextRun({ text: salutation, size: 22 })] }))
  for (const s of SECTIONS) {
    enfants.push(new Paragraph({ spacing: { before: 240, after: 80 }, children: [new TextRun({ text: `${s.n}. ${s.titre}`, bold: true, size: 22 })] }))
    const lignes = sections.get(s.n)!
    if (lignes.length === 0) continue
    const avecDate = s.n === 1
    enfants.push(new Table({
      borders: bordures,
      rows: lignes.map((l) => new TableRow({
        children: [
          cellule(l.commande, 900, true),
          cellule(l.reference, 1300),
          cellule(colorisEtRemarque(l), avecDate ? 5200 : 6600),
          ...(avecDate ? [cellule(l.datePrevue ? jjmmaaaa(l.datePrevue) : '', 1400)] : []),
        ],
      })),
    }))
  }
  enfants.push(new Paragraph({ spacing: { before: 240 }, children: [] }))
  enfants.push(new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text: 'Merci', size: 22 })] }))
  const doc = new Document({ styles: { default: { document: { run: { font: 'Arial' } } } }, sections: [{ children: enfants }] })
  return Packer.toBuffer(doc)
}

/** The email body as a standalone page — the preview pane of the email dialog iframes it. */
export const pageApercu = (p: Point) =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(p.sujet)}</title></head><body style="margin:20px;background:#ffffff;">${emailHtml(p)}</body></html>`
