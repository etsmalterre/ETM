// Shares typed on knitting orders that knit OUR yarn become yarn reservations held by the order
// (decision Vincent 2026-11-13, lib/parts-tricotage.ts): a client line reserves matter, never a
// transformation order. Open orders only; an order whose knitter brings the yarn keeps its typed
// shares (it is an entry point). Idempotent: run it again and nothing moves.
//
//   tsx --env-file=.env.development src/scripts/parts-tricotage-vers-fil.ts           # dry run
//   tsx --env-file=.env src/scripts/parts-tricotage-vers-fil.ts --write               # on the API host

import { closeConnection } from '../lib/hfsql-auto.js'
import { mpsPg } from '../lib/mps-pg.js'
import { convertirPartsEnFil } from '../lib/parts-tricotage.js'

const ecrire = process.argv.includes('--write')
const fait = await convertirPartsEnFil(null, ecrire)
for (const x of fait) {
  console.log(`ligne tricotage ${x.lsst} · ligne client ${x.lcc} : ${x.ecru} kg d'écru → ${x.lignes} réservation(s) de fil`)
}
console.log(`${fait.length} part(s) ${ecrire ? 'converties' : 'à convertir (ajoutez --write)'}`)
await closeConnection().catch(() => {})
await mpsPg().end()
