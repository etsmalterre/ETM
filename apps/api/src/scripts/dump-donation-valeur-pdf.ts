// Render a "Calcul de la valeur" (donation) PDF for visual inspection.
//   tsx src/scripts/dump-donation-valeur-pdf.ts [out.pdf] [--cmd 6903]
// Without --cmd, uses synthetic data mirroring the legacy DON3693 sample
// (including a piece with an unpriceable "?" component).
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { ValeurDonationPdf } from '../lib/pdf/ValeurDonationPdf.js'
import type { DonationValeurPdfData } from '../lib/donation-valeur.js'

const synthetic: DonationValeurPdfData = {
  numero: '3693',
  isDonation: true,
  dateLong: '28 Juillet 2026',
  clientNom: 'Donation - association',
  pieces: [
    {
      kind: 'ecru', refLabel: '003 - ecru', numero: '988/10', poids: 20.5, prixKg: null, total: null,
      lines: [
        { kind: 'fil', label: '167/48/1 PES FR - noir', detail: 'Lot 8807', detail2: 'Commande fil N° 418', poids: 15.58, prixKg: 3.25, total: 50.635 },
        { kind: 'fil', label: '83/36/1 PES - ecru', detail: 'Lot 9318', detail2: 'Commande fil N° 109', poids: 4.92, prixKg: 1.85, total: 9.102 },
        { kind: 'fil', label: '167/48/1 PES FR - ecru', detail: '?', detail2: '?', poids: null, prixKg: null, total: null },
        { kind: 'operation', label: 'Tricotage de la référence', detail: 'Le 28/07/2026', detail2: '', poids: 20.5, prixKg: 2.07, total: 42.435 },
      ],
    },
    {
      kind: 'fini', refLabel: '004B - Blanc pour imprimer en jersey', numero: '2114/194', poids: 20.8187, prixKg: 14.5606, total: 303.117,
      lines: [
        { kind: 'fil', label: '167/36/1 PES - ecru', detail: 'Lot 9810', detail2: 'Commande fil N° 289', poids: 18.99, prixKg: 2.3, total: 43.677 },
        { kind: 'fil', label: '44 ELASTHANNE - ecru', detail: 'Lot 9811', detail2: 'Commande fil N° 290', poids: 2.11, prixKg: 11.5, total: 24.265 },
        { kind: 'operation', label: 'Tricotage de la référence', detail: 'Le 28/07/2026', detail2: '', poids: 21.1, prixKg: 2.3, total: 48.53 },
        { kind: 'operation', label: 'Blanchissement Simple Teinture', detail: 'Le 28/07/2026', detail2: '', poids: 21.1, prixKg: 5.35, total: 112.885 },
        { kind: 'operation', label: 'Rame', detail: 'Le 28/07/2026', detail2: '', poids: 21.1, prixKg: 0, total: 0 },
        { kind: 'operation', label: 'Ignifuge Polyester', detail: 'Le 28/07/2026', detail2: '', poids: 21.1, prixKg: 3.01, total: 63.511 },
        { kind: 'operation', label: 'Préfixation', detail: 'Le 28/07/2026', detail2: '', poids: 21.1, prixKg: 0.68, total: 14.348 },
      ],
    },
    {
      kind: 'fini', refLabel: '007A - ecru', numero: '2381/10', poids: 15.3, prixKg: 11.206, total: 171.4518,
      lines: [
        { kind: 'fil', label: '334/72/1 Pes mimat - ecru', detail: 'Lot 9879', detail2: 'Commande fil N° 289', poids: 9.486, prixKg: 3, total: 28.458 },
        { kind: 'fil', label: '83/36/1 PES - ecru', detail: 'Lot 10023', detail2: 'Commande fil N° 387', poids: 4.59, prixKg: 1.9, total: 8.721 },
        { kind: 'fil', label: '44 ELASTHANNE - ecru', detail: 'Lot 10018', detail2: 'Commande fil N° 384', poids: 1.224, prixKg: 6.95, total: 8.5068 },
        { kind: 'operation', label: 'Tricotage de la référence', detail: 'Le 28/07/2026', detail2: '', poids: 15.3, prixKg: 4.6, total: 70.38 },
        { kind: 'operation', label: 'Vaporisage', detail: 'Le 28/07/2026', detail2: '', poids: 15.3, prixKg: 0, total: 0 },
        { kind: 'operation', label: 'Calandrage Seul', detail: 'Le 28/07/2026', detail2: '', poids: 15.3, prixKg: 3.62, total: 55.386 },
      ],
    },
  ],
  totalValeur: 474.57,
}

async function main() {
  const args = process.argv.slice(2)
  const cmdIdx = args.indexOf('--cmd')
  const cmdId = cmdIdx >= 0 ? parseInt(args[cmdIdx + 1], 10) : NaN
  const outArg = args.find((a) => !a.startsWith('--') && a !== String(cmdId))

  let data = synthetic
  if (!isNaN(cmdId)) {
    await import('dotenv/config')
    const { buildDonationValeurData } = await import('../lib/donation-valeur.js')
    const live = await buildDonationValeurData(cmdId)
    if (!live) { console.error(`commande ${cmdId} not found`); process.exit(1) }
    data = live
    console.log(`Live data: donation N° ${data.numero}, ${data.pieces.length} pièces, total ${data.totalValeur} €`)
  }

  const buffer = await renderToBuffer(
    React.createElement(ValeurDonationPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
  const out = outArg
    ? path.resolve(outArg)
    : path.join(os.tmpdir(), `donation-valeur-${data.numero}.pdf`)
  fs.writeFileSync(out, buffer)
  console.log(`Wrote ${out} (${(buffer.length / 1024).toFixed(1)} KB)`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
