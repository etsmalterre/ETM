// Guard for the Fiche Technique page count. `validationRow` is wrap={false} and
// sits at the end of the flow, so anything that grows it (the OEKO-TEX mark,
// extra date lines…) can push the block onto a second, near-empty page for
// content-heavy references.
//
// Renders a sample of ref_fini ids and reports how many pages each fiche takes.
// Every row should be "1". Run it after touching FicheTechniquePdf layout:
//   pnpm --filter @mps/api exec tsx src/scripts/check-fiche-page-counts.ts [n]
import dotenv from 'dotenv'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env.development') })

const { query } = await import('../lib/hfsql.js')
const { buildFicheTechniquePdfData, renderFicheTechniquePdfBuffer } = await import(
  '../routes/references-fini.js'
)

/** Count `/Type /Page` objects (excluding /Pages) in a rendered PDF. */
function pageCount(buf: Buffer): number {
  return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
}

async function main() {
  const limit = parseInt(process.argv[2] ?? '', 10) || 25

  // Bias the sample toward the references most likely to overflow: the ones
  // with the longest free-text blocks (observations + conditionnement are the
  // only unbounded fields on the fiche).
  const rows = await query<{ IDref_fini: number; reference: string | null }>(
    `SELECT IDref_fini, reference, observations, conditionnement FROM ref_fini WHERE archive = 0`,
  )
  const ranked = rows
    .map((r: any) => ({
      id: Number(r.IDref_fini),
      ref: String(r.reference ?? '').trim(),
      len: String(r.observations ?? '').length + String(r.conditionnement ?? '').length,
    }))
    .sort((a, b) => b.len - a.len)
    .slice(0, limit)

  let bad = 0
  for (const r of ranked) {
    try {
      const data = await buildFicheTechniquePdfData(r.id)
      if (!data) continue
      const n = pageCount(await renderFicheTechniquePdfBuffer(data))
      if (n !== 1) bad++
      console.log(`${n === 1 ? 'ok  ' : 'SPILL'} ${String(r.id).padStart(5)} ${r.ref.padEnd(12)} pages=${n} textLen=${r.len}`)
    } catch (e) {
      console.log(`err   ${r.id} ${r.ref}: ${(e as Error).message}`)
    }
  }
  console.log(bad === 0 ? `\nAll ${ranked.length} fiches fit on one page.` : `\n${bad} fiche(s) spilled to a second page.`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
