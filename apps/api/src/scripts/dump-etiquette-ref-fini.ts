// Render the client-facing Dymo étiquette of a ref_fini to disk, optionally
// rasterized to PNG for a visual check (pdf-to-img + sharp from a temp dir —
// see claude_doc/pdf_email.md § Rasterizing).
// Usage: tsx src/scripts/dump-etiquette-ref-fini.ts <id|longest> [outDir] [rasterDir]
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pathToFileURL } from 'url'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { query } from '../lib/hfsql-auto.js'
import { EtiquetteRefFiniPdf } from '../lib/pdf/EtiquetteRefFiniPdf.js'
import { buildEtiquetteRefFiniData } from '../routes/references-fini.js'

async function main() {
  const arg = process.argv[2] ?? '1730'
  const outDir = process.argv[3] ?? path.join(os.homedir(), 'Downloads')
  const rasterDir = process.argv[4]

  let id = parseInt(arg, 10)
  if (arg === 'longest') {
    const rows = await query<{ IDref_fini: number; designation: string | null }>(
      `SELECT IDref_fini, designation FROM ref_fini`,
    )
    rows.sort((a, b) => (b.designation ?? '').length - (a.designation ?? '').length)
    id = rows[0].IDref_fini
    console.log('longest designation', id, JSON.stringify(rows[0].designation))
  }
  const data = await buildEtiquetteRefFiniData(id)
  if (!data) throw new Error('ref not found')
  console.log(JSON.stringify(data))
  const buf = await renderToBuffer(React.createElement(EtiquetteRefFiniPdf, { data }) as any)
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, `etiquette-${id}.pdf`)
  fs.writeFileSync(out, buf)
  console.log('wrote', out, buf.length, 'bytes')

  if (rasterDir) {
    const mod = await import(pathToFileURL(path.join(rasterDir, 'node_modules/pdf-to-img/dist/index.js')).href)
    const doc = await mod.pdf(out, { scale: 5 })
    let i = 0
    for await (const page of doc) {
      const png = path.join(outDir, `etiquette-${id}-p${++i}.png`)
      fs.writeFileSync(png, page)
      console.log('png', png)
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
