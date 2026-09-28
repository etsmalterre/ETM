// Render the RH suivi dossier from synthetic data (no database) to look at it.
//   npx tsx src/scripts/dump-suivi-rh-pdf.ts [out.pdf]
// Rasterize with pdf-to-img from a temp dir (claude_doc/pdf_email.md).

import fs from 'fs'
import React from 'react'
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer'
import { SuiviRhPdf, type SuiviRhPdfData } from '../lib/pdf/SuiviRhPdf.js'

const out = process.argv[2] ?? 'suivi-rh.pdf'
const h = (c: string) => c.repeat(64)

const data: SuiviRhPdfData = {
  employe: { nom: 'Camille Exemple', poste: 'Accueil et expéditions', dateEmbauche: '2012-03-05' },
  exportePar: 'Vincent Malterre',
  exporteLe: '2026-09-28T15:40:00.000Z',
  verification: { ok: true, nombre: 3, detail: '3 événements du registre recalculés à l’export, chaîne intacte.' },
  evenements: [
    {
      id: 3, idemploye: 1, dateEvenement: '2026-09-29', type: 'courrier', titre: 'Compte rendu envoyé par email — À signer',
      presents: '', contenu: 'Récapitulatif de l’entretien du 28/09 envoyé à la salariée, accusé de lecture reçu.',
      rectifie: null, creeLe: '2026-09-29T08:02:00.000Z', creePar: 'Vincent Malterre', hash: h('c'), rectifiePar: [],
      pieces: [{ id: 1, nom: 'Récapitulatif entretien 28-09.pdf', typeMime: 'application/pdf', taille: 84_211, sha256: h('d') }],
    },
    {
      id: 2, idemploye: 1, dateEvenement: '2026-09-28', type: 'rectificatif', titre: 'Heure de l’entretien',
      presents: '', contenu: 'L’entretien a eu lieu à 14 h, et non 11 h comme indiqué.',
      rectifie: 1, creeLe: '2026-09-28T16:30:00.000Z', creePar: 'Vincent Malterre', hash: h('b'), rectifiePar: [], pieces: [],
    },
    {
      id: 1, idemploye: 1, dateEvenement: '2026-09-28', type: 'information', titre: 'Évolution du poste — information anticipée',
      presents: 'Vincent Malterre, Camille Exemple',
      contenu: 'Entretien à 11 h dans le bureau.\n\nInformation de la salariée que plusieurs de ses tâches sont progressivement automatisées. Rien n’est décidé à ce jour ; un passage à temps partiel est envisagé à terme. Proposition de formation et d’accompagnement.\n\nLa salariée a posé des questions sur le calendrier.',
      rectifie: null, creeLe: '2026-09-28T16:12:00.000Z', creePar: 'Vincent Malterre', hash: h('a'), rectifiePar: [2], pieces: [],
    },
  ],
}

const buf = await renderToBuffer(React.createElement(SuiviRhPdf, { data }) as unknown as React.ReactElement<DocumentProps>)
fs.writeFileSync(out, buf)
console.log(`${out} — ${buf.length} bytes`)
