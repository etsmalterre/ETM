// Repairs the yarn left on knitting orders that no longer exist (LIVA #1398).
//
// Until 2026-11-26 deleting a knitting LINE (Sous-traitants › Tricotage) removed neither its links
// to the yarn lots nor the client lines' yarn it held: the client line kept its yarn « pris par le
// tricotage » on an order that was gone (order 3957, the 171A line: 17 kg). The delete now gives the
// yarn back (lib/lancement-tricotage.ts rendreFilDesLignes); this script does it for what is already
// there: the reservations go back to their lots, reserved in stock to the same client line, and the
// orphan lot links and typed shares are removed.
//
//   npx tsx --env-file=.env src/scripts/repair-fil-commande-supprimee.ts            # what it would do
//   npx tsx --env-file=.env src/scripts/repair-fil-commande-supprimee.ts --write    # do it
import '../load-env.js'
import type { Sql } from 'postgres'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'

const write = process.argv.includes('--write')
const sql = mpsPg()
const sansLigne = sql`NOT EXISTS (SELECT 1 FROM ligne_commande_sous_traitant l WHERE l.idligne_commande_sous_traitant = x.idligne_commande_sous_traitant)`

try {
  const resas = await sql<{ id: number; lcc: number; numero: number | null; lot: string | null; kg: number; lsst: number }[]>`
    SELECT x.id, x.idligne_commande_client AS lcc, cc.numero, s.lot, x.quantite::float8 AS kg, x.idligne_commande_sous_traitant AS lsst
      FROM reservation_fil x
      LEFT JOIN ligne_commande_client lc ON lc.idligne_commande_client = x.idligne_commande_client
      LEFT JOIN commande_client cc ON cc.idcommande_client = lc.idcommande_client
      LEFT JOIN stock_fil s ON s.idstock_fil = x.idstock_fil
     WHERE x.liberee_le IS NULL AND x.idligne_commande_sous_traitant > 0 AND ${sansLigne}
     ORDER BY x.id`
  const [{ n: assos }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM asso_fil_lignecmdsst x WHERE x.idligne_commande_sous_traitant > 0 AND ${sansLigne}`
  const [{ n: parts }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM affectation_cmd_tricotage x WHERE x.idligne_commande_sous_traitant > 0 AND ${sansLigne}`

  console.log(`${resas.length} réservation(s) de fil sur une commande de tricotage disparue :`)
  for (const r of resas) {
    console.log(`  #${r.id}  commande client ${r.numero ?? '?'} (ligne ${r.lcc})  lot ${r.lot ?? '?'}  ${r.kg} kg  (ligne tricot ${r.lsst})`)
  }
  console.log(`${assos} lien(s) lot → commande orphelin(s), ${parts} part(s) saisie(s) orpheline(s).`)

  if (!write) {
    console.log('Lecture seule : relancer avec --write pour rendre le fil aux lignes.')
  } else {
    await sql.begin(async (t) => {
      const tx = t as unknown as Sql
      await tx`
        UPDATE reservation_fil x SET idligne_commande_sous_traitant = 0, idasso_fil_lignecmdsst = 0
         WHERE x.liberee_le IS NULL AND x.idligne_commande_sous_traitant > 0 AND ${sansLigne}`
      await tx`DELETE FROM asso_fil_lignecmdsst x WHERE x.idligne_commande_sous_traitant > 0 AND ${sansLigne}`
      await tx`DELETE FROM affectation_cmd_tricotage x WHERE x.idligne_commande_sous_traitant > 0 AND ${sansLigne}`
    })
    console.log('Fait : le fil est de nouveau réservé en stock aux mêmes lignes client.')
  }
} finally {
  await closeMpsPg()
}
