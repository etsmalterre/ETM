// Seeds Sous-traitants › Point in the DEV database to try v3 (bandeau
// « dépassé / c'est celui d'aujourd'hui », carried removals).
//
//   npx tsx src/scripts/seed-point-sst-dev.ts [--aujourdhui 2026-10-07]
//
// For MATEL (9), re-creates from the rules on dev data:
//   - the point of the previous working day   → « Ce point est dépassé » (under « Tous »)
//   - today's point, where « Pierre-Emmanuel Roux (seed) » removed the first
//     line of §1 and of §2 with a reason       → « C'est le point d'aujourd'hui » (after 12:00)
// and deletes tomorrow's point, so the bandeau offers « Préparer le point du … »:
// click it and the two removed lines arrive already removed, with the reason.
// Re-runnable. Refuses anything but a *_dev database.

import dotenv from 'dotenv'

dotenv.config({ path: '.env.development' })
const url = process.env.PG_CONNECTION_STRING ?? ''
if (!/\/[a-z_]+_dev(\?|$)/.test(url)) {
  console.error('Refusé : PG_CONNECTION_STRING ne pointe pas sur une base *_dev.')
  process.exit(1)
}

const { mpsPg, closeMpsPg } = await import('../lib/mps-pg.js')
const { preparerPoint, retirerLigne, noterRetourLigne, lirePoint } = await import('../lib/point-sst/db.js')
const { jourSuivantOuvre, plusJours } = await import('../lib/point-sst/regles.js')
const { VERSION } = await import('../lib/automates/point-sst/point-sst.js')

const SST = 9
const PAR = 'Pierre-Emmanuel Roux (seed)'
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined }
const aujourdhui = arg('aujourdhui') ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())
let veille = plusJours(aujourdhui, -1)
while ([0, 6].includes(new Date(`${veille}T12:00:00Z`).getUTCDay())) veille = plusJours(veille, -1)
const demain = jourSuivantOuvre(aujourdhui)

const sql = mpsPg()
await sql`DELETE FROM point_sst_ligne WHERE idpoint_sst IN (SELECT idpoint_sst FROM point_sst WHERE idsous_traitant = ${SST} AND jour IN (${veille}::date, ${aujourdhui}::date, ${demain}::date))`
await sql`DELETE FROM point_sst WHERE idsous_traitant = ${SST} AND jour IN (${veille}::date, ${aujourdhui}::date, ${demain}::date)`

const v = await preparerPoint(SST, veille, 'automate', VERSION)
const a = await preparerPoint(SST, aujourdhui, 'automate', VERSION)
const point = await lirePoint(a.id)
const motifs: Record<number, string> = {
  1: 'La commande est prête et la soumission est partie ce jour — inutile de la réclamer.',
  2: 'On attend la décision du client sur le premier lot : rien à demander à MATEL.',
}
const retirees: string[] = []
for (const s of [1, 2]) {
  const l = point.lignes.find((x) => x.section === s && x.origine === 'auto')
  if (!l) continue
  await retirerLigne(a.id, l.id, PAR)
  await noterRetourLigne(a.id, l.id, { id: `seed-${a.id}-${l.id}`, texte: motifs[s], par: PAR })
  retirees.push(`§${s} ${l.commande} ${l.reference}`)
}

console.log(`Point du ${veille} (dépassé) : ${v.ajoutees} lignes — id ${v.id}`)
console.log(`Point du ${aujourdhui} (aujourd’hui) : ${a.ajoutees} lignes, retirées par ${PAR} : ${retirees.join(', ') || 'aucune (pas de ligne §1/§2 en dev)'} — id ${a.id}`)
console.log(`Point du ${demain} : supprimé — le bandeau propose « Préparer le point du … ».`)
await closeMpsPg()
