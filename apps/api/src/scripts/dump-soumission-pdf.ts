// Render a soumission-lot PDF for a known eligible lot to disk so we can
// inspect the layout visually without spinning up the full API.
//
// Usage: tsx src/scripts/dump-soumission-pdf.ts [commandeId] [out]
//   defaults to commande 8518 (lot MA108050 — Bonne Nouvelle, ref 825/1056).
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { SoumissionLotPdf } from '../lib/pdf/SoumissionLotPdf.js'

async function main() {
  // Re-import the route module just to access the (unexported) helpers via
  // their module symbol table. To avoid leaking the helpers into the
  // public API surface, we re-export a couple of them temporarily here.
  const routeMod: any = await import('../routes/commandes-sous-traitant.js')

  const commandeId = parseInt(process.argv[2] ?? '8518', 10)
  const out = process.argv[3] ?? path.join(os.homedir(), 'Downloads', `soumission-lot-${commandeId}.pdf`)

  // findEligibleLots + buildSoumissionLotPdfData are not exported. Test via
  // the running app instead. For an offline dump, we hit the eligibility
  // helper directly through a fresh require if needed — but easier:
  // hardcode the lot params we already verified.
  const params = {
    IDref_fini: 825,
    IDColoris: 1056,
    lot: 'MA108050',
    nature: 'stabilites',
    IDcommande_client: 6843,
  }

  // Re-export helpers temporarily on the route module (added below for
  // this script). If undefined, throw with a hint.
  const find = routeMod.findEligibleLots
  const build = routeMod.buildSoumissionLotPdfData
  if (!find || !build) {
    throw new Error(
      'findEligibleLots / buildSoumissionLotPdfData must be exported on commandes-sous-traitant.ts for this dev script to work.\n' +
      'Add `export` to those two function declarations temporarily, or delete this script after testing.',
    )
  }

  const lots = await find(commandeId)
  console.log(`eligible lots for commande ${commandeId}: ${lots.length}`)
  for (const l of lots) console.log(' ', JSON.stringify(l))

  const data = await build(commandeId, params, /* userId */ 1)
  if (!data) throw new Error('No data — params did not match an eligible lot')
  console.log('PDF data:', JSON.stringify(data, null, 2))

  const buf = await renderToBuffer(React.createElement(SoumissionLotPdf, { data }) as any)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, buf)
  console.log('wrote', out, buf.length, 'bytes')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
