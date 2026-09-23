/**
 * DEV-ONLY seed for the « En poste » faces of the TRS wall tablet (LIVA #1194)
 * and, by the same rows, for the roster of Production › TRS: clocks a few
 * bonnetiers in on `mps.pointage` at the start of the CURRENT shift.
 *
 *   cd apps/api && npx tsx src/scripts/seed-en-poste-dev.ts            # 4 bonnetiers, one on a pause
 *   … --nb 6                                                            # how many
 *   … --clean                                                           # remove today's rows
 *
 * Why it exists: the local HFSQL copy's `pointage` stops in March (the
 * pointeuse writes prod only), so GET /api/trs/atelier answers `enPoste: []`
 * and the band can never be seen with faces locally. The kg half of the band
 * is exercised by seed-visitage-pieces.ts (pieces finished in the last hours).
 *
 * Picks living bonnetiers WITH a photo first (bonnetier.photo IS NOT NULL) so
 * the faces are real, then fills with the others (initials fallback). Rows:
 * an « in » a few minutes after the shift start for each; the last one also
 * gets an « out » ten minutes ago, so one seat is visibly empty — the tablet
 * must not show someone who clocked out.
 *
 * ⚠️ It WRITES. Guards: refuses unless HFSQL_CONNECTION_STRING points at
 * localhost; only ADDS rows (positional INSERT, MAX+1 PK — `DATE` is reserved
 * on pointage); --clean deletes exactly today's rows, which on a snapshot
 * months old can only be its own.
 */
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })

import { query, closeConnection } from '../lib/hfsql-auto.js'
import { maxId } from '../routes/expeditions.js'
import { selectBonnetiers } from '../lib/production-trm.js'
import { equipeCourante, toHfsqlDt } from '../lib/trs-trm.js'

const args = process.argv.slice(2)
const flag = (name: string): string | null => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}
const CLEAN = args.includes('--clean')
const NB = Math.max(1, Math.min(10, parseInt(flag('nb') ?? '4', 10) || 4))

if (!/Server Name\s*=\s*localhost/i.test(process.env.HFSQL_CONNECTION_STRING ?? '')) {
  console.error('REFUS : ce script écrit, et la connexion ne pointe pas sur localhost.')
  console.error('  ' + (process.env.HFSQL_CONNECTION_STRING ?? '(vide)').replace(/PWD=[^;]*/i, 'PWD=***'))
  process.exit(1)
}

const MIN = 60_000
const nowMs = Date.now()
const equipe = equipeCourante(nowMs)

async function clean(): Promise<void> {
  const jour = toHfsqlDt(new Date(new Date(nowMs).setHours(0, 0, 0, 0)).getTime())
  const rows = await query<{ IDpointage: number }>(`SELECT IDpointage FROM pointage WHERE DATE >= '${jour}'`)
  for (const r of rows) await query(`DELETE FROM pointage WHERE IDpointage = ${Number(r.IDpointage)}`)
  console.log(`${rows.length} ligne(s) de pointage d'aujourd'hui supprimée(s).`)
}

async function seed(): Promise<void> {
  const tous = (await selectBonnetiers()).filter((b) => b.archive !== 1)
  const avecPhoto = new Set(
    (await query<{ IDbonnetier: number }>('SELECT IDbonnetier FROM bonnetier WHERE photo IS NOT NULL')).map((r) => Number(r.IDbonnetier)),
  )
  const choisis = [
    ...tous.filter((b) => avecPhoto.has(b.id)),
    ...tous.filter((b) => !avecPhoto.has(b.id)),
  ].slice(0, NB)
  if (choisis.length === 0) {
    console.error('Aucun bonnetier vivant en base.')
    process.exit(1)
  }

  let id = await maxId('pointage', 'IDpointage')
  const ecrire = async (bonnetierId: number, atMs: number, enPoste: 0 | 1) => {
    id += 1
    await query(`INSERT INTO pointage VALUES (${id}, ${bonnetierId}, '${toHfsqlDt(atMs)}', ${enPoste})`)
  }
  for (const [i, b] of choisis.entries()) {
    // Staggered arrivals, all inside the shift and before now.
    const arrivee = Math.min(equipe.debutMs + (3 + i * 4) * MIN, nowMs - 15 * MIN)
    await ecrire(b.id, arrivee, 1)
    console.log(`${b.prenom} ${b.nom} (#${b.id}) pointé à ${new Date(arrivee).toLocaleTimeString('fr-FR')}${avecPhoto.has(b.id) ? '' : ' — sans photo'}`)
  }
  if (choisis.length > 1) {
    const dernier = choisis[choisis.length - 1]
    const sortie = nowMs - 10 * MIN
    await ecrire(dernier.id, sortie, 0)
    console.log(`${dernier.prenom} ${dernier.nom} (#${dernier.id}) dépointé à ${new Date(sortie).toLocaleTimeString('fr-FR')} — ne doit PAS apparaître`)
  }
  console.log(`\nÉquipe ${equipe.nom}. Pour tout retirer : --clean`)
}

try {
  if (CLEAN) await clean()
  else await seed()
} finally {
  await closeConnection()
}
