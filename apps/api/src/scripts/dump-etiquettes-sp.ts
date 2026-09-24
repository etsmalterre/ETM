/**
 * Renders the Simone Pérèle label sheet and the MATEL « tableau de métrage »
 * from synthetic data (no database) — LIVA #1200.
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/dump-etiquettes-sp.ts [outDir]
 *
 * The rolls are the five of the legacy sheet « 106910 - CAB.pdf », so the
 * output can be laid next to it: same SSCCs, same human-readable lines.
 */
import React from 'react'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer'
import { EtiquettesSpPdf, type SpLabelData } from '../lib/pdf/EtiquettesSpPdf.js'
import { TableauMetragePdf } from '../lib/pdf/TableauMetragePdf.js'
import { spLabelCodes } from '../lib/gs1-barcode.js'

const outDir = process.argv[2] ?? '.'
const rolls = [
  { numero: '3215/6', brut: 110, net: 109.8, tare: 2, poids: 19 },
  { numero: '3215/7', brut: 110.3, net: 110.2, tare: 1, poids: 20 },
  { numero: '3215/8', brut: 106.3, net: 106.3, tare: 0, poids: 19 },
  { numero: '3215/9', brut: 108, net: 107.8, tare: 2, poids: 19 },
  { numero: '3215/10', brut: 106.7, net: 106.6, tare: 1, poids: 19 },
]
const labels: SpLabelData[] = rolls.map((r) => ({
  articleClient: 'LF 043 - 739 PEAU',
  commandeClient: 'A3-57179 DU 30/07/2025',
  articleFournisseur: '191 COTON / POLY. EDF 85/55 MALTERRE',
  ean13: '3700442210223',
  libelleArticle: 'EDF 85/55 PES/COT/COTON',
  coloris: '739 PEAU',
  tare: r.tare,
  poids: r.poids,
  codes: spLabelCodes({
    numero: r.numero, commandeClient: 'A3-57179 DU 30/07/2025', ean13: '3700442210223',
    bain: '58808', lot: 'MA106910', brut: r.brut, net: r.net, laizeCm: 161,
  }),
}))

async function main() {
  const asDoc = (el: React.ReactElement) => el as unknown as React.ReactElement<DocumentProps>
  const a = await renderToBuffer(asDoc(React.createElement(EtiquettesSpPdf, { labels })))
  const b = await renderToBuffer(asDoc(React.createElement(TableauMetragePdf, {
    data: {
      commandeClient: 'A3-57378 du 16/10/2025', articleClient: 'LF 043 - 469 ROSE FUMEE',
      libelle: '191 coton / poly. EDF 85/55', lot: '107052', bain: '63424/1', coloris: '469 ROSE FUMEE',
      rolls: ['3250/18', '3250/19'],
    },
  })))
  fs.writeFileSync(path.join(outDir, 'etiquettes-sp.pdf'), a)
  fs.writeFileSync(path.join(outDir, 'tableau-metrage.pdf'), b)
  console.log('written to', path.resolve(outDir))
}
main().catch((e) => { console.error(e); process.exit(1) })
