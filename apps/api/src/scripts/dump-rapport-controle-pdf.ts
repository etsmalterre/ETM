// Render a Rapport de contrôle PDF for visual inspection. Two modes:
//  - synthetic (default): one lot, out-of-tolerance laize, three pieces
//  - live: --lot <idsuivilot> --client <idclient> builds it like Suivi lots does
// Usage: tsx src/scripts/dump-rapport-controle-pdf.ts [out.pdf] [--lot 6123 --client 137]
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { RapportControlePdf, type RapportControlePdfData } from '../lib/pdf/RapportControlePdf.js'

const synthetic: RapportControlePdfData = {
  lot: 'MA108821',
  dateLong: '22 octobre 2026',
  clientNom: 'Le slip Francais',
  commandes: ['3788'],
  refClient: 'Commande 45868 du 15/06/2026',
  articles: [
    {
      titre: '228/122 - 0481 rouge intense 61221/1',
      sousTitre: 'Jersey Coton 115g',
      lots: [
        {
          lot: 'MA108821',
          hasSuivilot: true,
          rows: [
            // Laize above max on purpose — verifies the red rendering.
            { parametre: 'Laize HT', min: 147, max: 153, releve: 155 },
            { parametre: 'Poids', min: 108, max: 122, releve: 117 },
            { parametre: 'Stab H', min: -8, max: null, releve: -5 },
            { parametre: 'Stab L', min: -8, max: null, releve: -4 },
          ],
        },
      ],
      pieces: [
        { numero: '3510/1', poids: 21.4, metrage: 62.5 },
        { numero: '3510/2', poids: 20.9, metrage: 61 },
        { numero: '3510/3-1', poids: 11.2, metrage: 33.4 },
      ],
    },
  ],
}

async function main() {
  const arg = (k: string) => {
    const i = process.argv.indexOf(k)
    return i === -1 ? NaN : parseInt(process.argv[i + 1], 10)
  }
  let data = synthetic
  if (!isNaN(arg('--lot'))) {
    await import('../load-env.js')
    const { rapportControleLot } = await import('../lib/rapport-controle-lot.js')
    const rc = await rapportControleLot(arg('--lot'), arg('--client'))
    if (!rc) { console.error('No pieces of that lot for that client'); process.exit(1) }
    data = rc.data
  }

  const out = process.argv.find((a) => a.endsWith('.pdf')) ?? path.join(os.tmpdir(), 'rapport-controle-preview.pdf')
  const buffer = await renderToBuffer(
    React.createElement(RapportControlePdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
  fs.writeFileSync(out, buffer)
  console.log(`Wrote ${out} (${buffer.length} bytes)`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
