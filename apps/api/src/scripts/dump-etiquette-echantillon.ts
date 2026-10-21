// Render the Dymo étiquette of a trial sample to disk, optionally rasterized
// to PNG for a visual check (pdf-to-img + sharp from a temp dir — see
// claude_doc/pdf_email.md § Rasterizing).
// Usage: tsx src/scripts/dump-etiquette-echantillon.ts <id|longest> [outDir] [rasterDir]
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pathToFileURL } from 'url'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'
import { EtiquetteEchantillonPdf } from '../lib/pdf/EtiquetteEchantillonPdf.js'
import { buildEtiquetteEchantillonData } from '../routes/echantillons.js'

async function main() {
  const arg = process.argv[2] ?? '55'
  const outDir = process.argv[3] ?? path.join(os.homedir(), 'Downloads')
  const rasterDir = process.argv[4]

  let id = parseInt(arg, 10)
  if (arg === 'longest') {
    // The sample whose yarn list is the longest — the composition clamp's worst case.
    const [r] = await mpsPg()<{ idref_echantillon: number }[]>`
      SELECT f.idref_echantillon FROM fil_ref_echantillon f JOIN ref_fil rf ON rf.idref_fil = f.idref_fil
       GROUP BY f.idref_echantillon ORDER BY SUM(LENGTH(rf.reference) + 6) DESC LIMIT 1`
    id = r.idref_echantillon
  }
  const data = await buildEtiquetteEchantillonData(id)
  if (!data) throw new Error('échantillon not found')
  console.log(JSON.stringify(data))
  const buf = await renderToBuffer(React.createElement(EtiquetteEchantillonPdf, { data }) as any)
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, `etiquette-${data.numero}.pdf`)
  fs.writeFileSync(out, buf)
  console.log('wrote', out, buf.length, 'bytes')

  if (rasterDir) {
    const mod = await import(pathToFileURL(path.join(rasterDir, 'node_modules/pdf-to-img/dist/index.js')).href)
    const doc = await mod.pdf(out, { scale: 5 })
    let i = 0
    for await (const page of doc) {
      const png = path.join(outDir, `etiquette-${data.numero}-p${++i}.png`)
      fs.writeFileSync(png, page)
      console.log('png', png)
    }
  }
  await closeMpsPg()
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
