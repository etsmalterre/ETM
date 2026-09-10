/**
 * Probe for ticket #1144 — « Tarif tombé de métier » (Gant Maille, ref 254).
 *   pnpm --filter @mps/api exec tsx --env-file=.env.development src/scripts/probe-1144-gant-maille.ts
 * Read-only: the two client rows named Gant Maille, the contract on their
 * ref 254 (IDref_ecru 370) and every order line taken on that écru.
 */
import { query, closeConnection } from '../lib/hfsql-auto.js'

async function main() {
  const clients = await query<any>(`SELECT IDclient, nom, IDsociete, archive FROM client WHERE IDclient IN (682, 1023)`)
  console.log('clients:', clients)
  const contrats = await query<any>(`SELECT * FROM contrat_tarif WHERE IDcontrat_tarif = 479`)
  console.log('contrat 479:', contrats)
  const rcc = await query<any>(`SELECT * FROM ref_client_colori WHERE IDref_client_colori = 2035`)
  console.log('ref_client_colori 2035:', rcc)
  const allContrats = await query<any>(`SELECT * FROM contrat_tarif WHERE IDref_client_colori = 2035`)
  console.log('every contrat on rcc 2035:', allContrats)
  const tranches = await query<any>(`SELECT * FROM tranche_tarifaire WHERE IDref_client_colori = 2035`)
  console.log('tranche_tarifaire on rcc 2035:', tranches)
  const ecru = await query<any>(`SELECT IDref_ecru, reference, poids, prix, rendement FROM ref_ecru WHERE IDref_ecru = 370`)
  console.log('ref_ecru 370:', ecru)
  const desig = await query<any>(`SELECT IDdesignation_client, IDclient, IDref_ecru, IDref_fini, unite FROM designation_client WHERE IDdesignation_client = 996`)
  console.log('designation_client 996:', desig)
  const lignes = await query<any>(`SELECT * FROM ligne_commande_client WHERE IDreference = 370`)
  const l1 = lignes.filter((l) => Number(l.TYPE ?? l.type) === 1)
  console.log(`ligne_commande_client on IDreference 370: ${lignes.length} rows, ${l1.length} type=1; keys:`, Object.keys(lignes[0] ?? {}).join(','))
  const cmdIds = Array.from(new Set(l1.map((l) => Number(l.IDcommande_client)).filter((x) => x > 0)))
  const cmds = cmdIds.length
    ? await query<any>(`SELECT IDcommande_client, IDclient, numero, date_commande, IDsociete, est_soldee FROM commande_client WHERE IDcommande_client IN (${cmdIds.join(',')})`)
    : []
  const byId = new Map(cmds.map((c) => [Number(c.IDcommande_client), c]))
  const rows = l1.map((l) => {
    const c = byId.get(Number(l.IDcommande_client))
    return { ligne: l.IDligne_commande_client, cmd: l.IDcommande_client, numero: c?.numero, date: c?.date_commande, client: c?.IDclient, soc: c?.IDsociete, qte: l.quantite, unite: l.unite, prix: l.prix, colori: l.IDcolori ?? l.IDColoris }
  }).sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
  console.table(rows.slice(0, 8))
  await closeConnection()
}
main().catch((e) => { console.error(e); process.exit(1) })
