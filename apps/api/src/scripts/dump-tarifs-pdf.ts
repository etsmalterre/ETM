// Render the Fiche Tarifs PDF with synthetic data (no DB) so we can inspect the
// layout visually. Usage: tsx src/scripts/dump-tarifs-pdf.ts [out]
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { TarifsClientPdf, TarifsClientPdfData } from '../lib/pdf/TarifsClientPdf.js'

const data: TarifsClientPdfData = {
  clientNom: 'LE SLIP FRANÇAIS',
  dateDocument: '7 Juillet 2026',
  validUntil: '07/07/2027',
  sections: [
    {
      ref: '049A',
      contexture: 'double face piqué',
      laize: 180,
      poids: 220,
      bio: true,
      unit: 'Ml',
      colorisLabels: ['Marine 1056', 'Blanc Optique', 'Gris Chiné'],
      rows: [
        { rlx: '< 1', qte: '< 44', prices: [14.20, 14.55, 14.20] },
        { rlx: '1', qte: '44', prices: [12.80, 13.10, 12.80] },
        { rlx: '2', qte: '89', prices: [11.95, 12.20, 11.95] },
        { rlx: '3', qte: '133', prices: [11.40, 11.65, 11.40] },
        { rlx: '5', qte: '222', prices: [10.90, 11.10, 10.90] },
        { rlx: '10', qte: '444', prices: [10.35, 10.55, 10.35] },
      ],
    },
    {
      ref: '825',
      contexture: 'molleton gratté',
      laize: 165,
      poids: 310,
      bio: false,
      unit: 'Ml',
      colorisLabels: ['Noir', 'Écru'],
      rows: [
        { rlx: '1', qte: '30', prices: [16.40, 15.90] },
        { rlx: '2', qte: '61', prices: [15.10, 14.70] },
        { rlx: '3', qte: '91', prices: [14.55, 14.10] },
        { rlx: '5', qte: '152', prices: [13.90, 13.50] },
      ],
    },
    {
      ref: '112C',
      contexture: 'interlock fin',
      laize: 200,
      poids: 175,
      bio: true,
      unit: 'Ml',
      colorisLabels: ['Bleu Roi', 'Rouge Coquelicot', 'Vert Sapin', 'Jaune Moutarde'],
      rows: [
        { rlx: '< 1', qte: '< 57', prices: [13.10, 13.10, 13.10, 13.45] },
        { rlx: '1', qte: '57', prices: [11.60, 11.60, 11.60, 11.90] },
        { rlx: '2', qte: '114', prices: [10.85, 10.85, 10.85, 11.10] },
        { rlx: '3', qte: '171', prices: [10.40, 10.40, 10.40, 10.65] },
        { rlx: '5', qte: '285', prices: [9.95, 9.95, 9.95, 10.15] },
        { rlx: '10', qte: '571', prices: [9.45, 9.45, 9.45, 9.65] },
        { rlx: '15', qte: '857', prices: [9.10, 9.10, 9.10, 9.30] },
      ],
    },
  ],
}

async function main() {
  const out = process.argv[2] ?? path.join(os.homedir(), 'Downloads', 'tarifs-preview.pdf')
  const buf = await renderToBuffer(React.createElement(TarifsClientPdf, { data }) as any)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, buf)
  console.log('wrote', out, buf.length, 'bytes')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
