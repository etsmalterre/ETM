// #1345: the « bords côtes » (ribs): Malterre never measured their stabilités
// on the tirelle (Pierrot, 2026-11-02), and since #1345 the reference says which
// measures each side owes (lib/controles-lot.ts). This script switches OFF the
// Malterre stabilités on the côte references, the dyer's side untouched (MATEL
// measures them: 37 of 43 lots of 027A in two years).
//
// A côte is read from the designation (« cote 1/1… », « Côte 2/1… »): no
// contexture column exists, so the list is printed for a person to check first.
//
//   tsx --env-file=.env.development src/scripts/controles-cotes.ts                 # dry run: the list
//   tsx --env-file=.env src/scripts/controles-cotes.ts --sauf=009A,009B --write     # apply, minus refs to keep
//
// Archived references are left out. A reference whose Malterre stabilités are
// already off is listed but not rewritten. Each write is printed (the trace).
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'

async function main() {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const sauf = new Set(
    (args.find((a) => a.startsWith('--sauf='))?.slice(7) ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  )
  const sql = mpsPg()
  const refs = await sql<{ id: number; reference: string; designation: string; stab: number; lots: number; stab_sst: number; stab_malt: number }[]>`
    WITH l AS (SELECT * FROM suivilot WHERE date > now() - interval '2 years')
    SELECT r.idref_fini AS id, r.reference, r.designation::text AS designation, r.controle_malterre_stab AS stab,
           count(l.idsuivilot)::int AS lots,
           (count(*) FILTER (WHERE l.stabh_sst <> 0 OR l.stabl_sst <> 0))::int AS stab_sst,
           (count(*) FILTER (WHERE l.stabh_tirelle <> 0 OR l.stabl_tirelle <> 0))::int AS stab_malt
    FROM ref_fini r LEFT JOIN l ON l.idref_fini = r.idref_fini
    WHERE COALESCE(r.archive, 0) = 0 AND r.designation ~* '\\mc[oô]te'
    GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC, 2`
  console.log(`${refs.length} référence(s) côte actives (${write ? 'WRITE' : 'dry run'}) : lots 2 ans : total / stabs ennoblisseur / stabs Malterre`)
  let ecrites = 0
  for (const r of refs) {
    const garde = sauf.has(r.reference.toUpperCase())
    const deja = Number(r.stab) === 0
    const etat = garde ? 'GARDÉE' : deja ? 'déjà off' : write ? 'OFF' : 'à passer off'
    console.log(`${r.reference.padEnd(10)} ${r.designation.slice(0, 45).padEnd(45)} ${String(r.lots).padStart(3)} / ${String(r.stab_sst).padStart(3)} / ${String(r.stab_malt).padStart(3)}  ${etat}`)
    if (!write || garde || deja) continue
    // The side's « any » flag stays 1: laize, poids and vrillage are still asked.
    await sql`UPDATE ref_fini SET controle_malterre_stab = 0 WHERE idref_fini = ${r.id}`
    ecrites++
  }
  if (write) console.log(`${ecrites} référence(s) passée(s) sans stabilités Malterre.`)
  await closeMpsPg()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
