// Prints the point sous-traitant the automate would prepare — read-only.
//
//   npx tsx src/scripts/essai-point-sst.ts [--sst 9] [--jour 2026-10-06] [--env production]
//
// --env production reads apps/api/.env.production of the main checkout
// (the prod database, SELECTs only); default .env.development.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined }
const envFile = arg('env') === 'production'
  ? path.resolve(__dirname, '../../../../../ETM/apps/api/.env.production')
  : path.resolve(__dirname, '../../.env.development')
if (!fs.existsSync(envFile)) throw new Error(`missing ${envFile}`)
dotenv.config({ path: envFile, override: true })

const { lireFaits } = await import('../lib/point-sst/lecture.js')
const { construirePoint, jourSuivantOuvre, SECTIONS } = await import('../lib/point-sst/regles.js')
const { closeMpsPg } = await import('../lib/mps-pg.js')

const sst = Number(arg('sst') ?? 9)
const jour = arg('jour') ?? jourSuivantOuvre(new Date().toISOString().slice(0, 10))
const { lignes } = await lireFaits(sst, jour)
const point = construirePoint(jour, lignes)
console.log(`Point du ${jour} — sous-traitant ${sst} — ${lignes.length} lignes ouvertes lues, ${point.length} lignes au point\n`)
for (const s of SECTIONS) {
  console.log(`${s.n}. ${s.titre}`)
  for (const l of point.filter((p) => p.section === s.n)) {
    console.log(`   ${l.commande.padEnd(5)} ${l.reference.padEnd(9)} ${l.coloris}${l.commentaire ? ` - ${l.commentaire}` : ''}${l.datePrevue ? `  ${l.datePrevue}` : ''}`)
    console.log(`         ↳ ${l.pourquoi}`)
  }
}
await closeMpsPg()
