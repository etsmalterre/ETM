// Render the écru fiche technique of a ref_ecru id against the dev database
// and write it to a local file for visual inspection.
// Run: pnpm --filter @mps/api exec tsx src/scripts/dump-fiche-technique-ecru-pdf.ts <IDref_ecru> [outPath]
import dotenv from 'dotenv'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env.development') })

const { renderFicheTechniqueEcruPdf } = await import('../routes/references-ecru.js')
const { company } = await import('../lib/pdf/theme.js')

const id = parseInt(process.argv[2] ?? '', 10)
if (isNaN(id)) {
  console.error('Usage: tsx dump-fiche-technique-ecru-pdf.ts <IDref_ecru> [outPath]')
  process.exit(1)
}
const out = await renderFicheTechniqueEcruPdf(id, company)
if (!out) {
  console.error(`ref_ecru ${id} not found`)
  process.exit(1)
}
const file = process.argv[3] ?? path.join(os.tmpdir(), `fiche-technique-ecru-${id}.pdf`)
fs.writeFileSync(file, out.buffer)
console.log(`Wrote ${out.buffer.length} bytes to ${file}`)
process.exit(0)
