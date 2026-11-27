// One-off (2026-11-27, Vincent): a line waiting for its étude coloris carries no date.
//
// Until then « Valider la commande » dated every line, the ones in étude included: order 3944 (Simone
// Pérèle) took 27/01/2027 as an engagement on a coloris that did not exist, then two reports « on attend
// le coloris ». The validation now leaves those lines without a date (lib/preparation-commande.ts,
// lib/etude-ligne-client.ts dateEnEtude). This script puts the lines validated BEFORE the rule in the same
// state: on every open, validated ETM order, a fini line still waiting for its étude (an étude, no
// coloris) loses its « Prête le » and its engagement (delai_annonce). It reads « Après l'étude » again and
// takes its first date — its engagement, not a report — once the coloris is accepted.
//
// The reports already journaled on those lines (report_ligne_client, append-only) are kept as they are.
//
//   node --env-file=.env --import tsx src/scripts/etude-lignes-sans-date.ts            # lists
//   node --env-file=.env --import tsx src/scripts/etude-lignes-sans-date.ts --write
//
// Without --write nothing is written; idempotent.
import '../load-env.js'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'

const write = process.argv.includes('--write')
const sql = mpsPg()
console.log(write ? 'MODE ÉCRITURE' : 'Simulation (ajouter --write pour appliquer)')

const lignes = await sql<{ id: number; numero: string | null; client: string | null; etude: number; d: string | null; e: string | null; reports: number }[]>`
  SELECT l.idligne_commande_client AS id, c.numero::text AS numero, cl.nom AS client, l.idetude_col AS etude,
         to_char(l.date_livraison, 'DD/MM/YYYY') AS d, to_char(l.delai_annonce, 'DD/MM/YYYY') AS e,
         (SELECT count(*)::int FROM report_ligne_client r WHERE r.idligne_commande_client = l.idligne_commande_client) AS reports
    FROM ligne_commande_client l
    JOIN commande_client c ON c.idcommande_client = l.idcommande_client
    LEFT JOIN client cl ON cl.idclient = c.idclient
   WHERE c.idsociete = 1 AND c.validee_le IS NOT NULL AND COALESCE(c.est_soldee, 0) <> 1
     AND l.type = 2 AND l.idetude_col > 0 AND COALESCE(l.idcolori, 0) = 0
     AND (l.date_livraison IS NOT NULL OR l.delai_annonce IS NOT NULL)
   ORDER BY c.numero, l.idligne_commande_client`

if (lignes.length === 0) console.log('Aucune ligne en étude ne porte de date.')
for (const l of lignes) {
  console.log(`Commande ${l.numero ?? '?'} (${(l.client ?? '').trim()}) · ligne ${l.id} · étude ${l.etude} : prête le ${l.d ?? '—'}, engagement ${l.e ?? '—'}`
    + (l.reports > 0 ? `, ${l.reports} report${l.reports > 1 ? 's' : ''} gardé${l.reports > 1 ? 's' : ''} au journal` : ''))
}
if (write && lignes.length > 0) {
  const ids = lignes.map((l) => Number(l.id))
  const r = await sql`
    UPDATE ligne_commande_client SET date_livraison = NULL, delai_annonce = NULL
     WHERE idligne_commande_client = ANY(${ids as any}::bigint[])
       AND idetude_col > 0 AND COALESCE(idcolori, 0) = 0`
  console.log(`${r.count} ligne${r.count > 1 ? 's' : ''} sans date ni engagement.`)
}
await closeMpsPg()
