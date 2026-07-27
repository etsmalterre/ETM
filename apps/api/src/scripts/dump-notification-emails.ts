// Render every notification email with synthetic data (no DB, no Gmail) so the
// layout can be inspected in a browser. The logo is inlined as a data: URI, so
// the files open standalone with no network access.
//
// Usage: tsx src/scripts/dump-notification-emails.ts [outDir]
//        (default: ~/Downloads/mps-notifications/, then open the .html files)
//
// Keep the sample content here in sync with the real call sites in
// routes/clients.ts — this script is the only way to eyeball a notification
// without triggering the real event.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  renderNotificationEmailPreview,
  type NotificationEmailContent,
} from '../lib/notification-email.js'

interface Sample {
  file: string
  key: string
  subject: string
  content: NotificationEmailContent
}

const SAMPLES: Sample[] = [
  {
    file: 'notif_coloris_ajoute.html',
    key: 'notif_coloris_ajoute',
    subject: 'Coloris ajouté - CONFECTION MARTIN - MOLLETON GRATTE (ML-4420)',
    content: {
      title: 'Coloris ajouté',
      tone: 'info',
      intro: '2 coloris ont été ajoutés à une référence client par **Marie Dupont**.',
      rows: [
        { label: 'Client', value: 'CONFECTION MARTIN' },
        { label: 'Référence', value: 'MOLLETON GRATTE (ML-4420)' },
        { label: 'Coloris ajoutés', value: 'MARINE, BORDEAUX' },
        { label: 'Tranches appliquées', value: '< 1 · 1 · 2 · 3 · 4 · 5 · 10 rouleaux' },
        // Only present when the same save also removed coloris.
        { label: 'Retirés en même temps', value: 'KAKI' },
      ],
    },
  },
  {
    file: 'notif_coloris_refuse.html',
    key: 'notif_coloris_refuse',
    subject: 'Demande d’ajout de coloris - CONFECTION MARTIN - MOLLETON GRATTE (ML-4420)',
    content: {
      title: 'Demande d’ajout de coloris',
      tone: 'alert',
      intro:
        '**Marie Dupont** souhaite ajouter un coloris à une référence client, mais l’opération est ' +
        'bloquée : les coloris existants de cette référence n’ont pas tous le tarif standard avec les ' +
        'mêmes tranches.',
      rows: [
        { label: 'Client', value: 'CONFECTION MARTIN' },
        { label: 'Référence', value: 'MOLLETON GRATTE (ML-4420)' },
        { label: 'Coloris souhaités', value: 'MARINE' },
        { label: 'Demandé par', value: 'Marie Dupont' },
      ],
      note: { label: 'Note du demandeur', value: 'Commande client à saisir cette semaine' },
      callout: 'L’ajout doit être réalisé par un utilisateur ayant le droit d’éditer les tarifs.',
    },
  },
]

/** Wrap the email body in a minimal page that also shows the subject line, so
 *  the preview reflects what lands in the inbox. */
function previewPage(sample: Sample): string {
  const body = renderNotificationEmailPreview(sample.content)
  return (
    '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    `<title>${sample.key}</title></head>` +
    '<body style="margin:0;padding:0;background-color:#F4F5F7;">' +
    '<div style="max-width:600px;margin:0 auto;padding:20px 12px 0 12px;' +
    'font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6B7280;">' +
    `<div>Objet : <strong style="color:#1F2937;">${sample.subject}</strong></div>` +
    `<div style="margin-top:4px;">Clé : <code>${sample.key}</code></div>` +
    '</div>' +
    body +
    '</body></html>'
  )
}

function main() {
  const outDir = process.argv[2] ?? path.join(os.homedir(), 'Downloads', 'mps-notifications')
  fs.mkdirSync(outDir, { recursive: true })
  for (const s of SAMPLES) {
    const out = path.join(outDir, s.file)
    fs.writeFileSync(out, previewPage(s), 'utf8')
    console.log('wrote', out)
  }
  console.log(`\n${SAMPLES.length} aperçu(s) dans ${outDir}`)
}

main()
