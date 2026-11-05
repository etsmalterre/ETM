// Catch-up of LIVA #1350 (lib/repartition-tricotage.ts): the pieces already knitted on knitting orders
// still in progress, arrived free at Ets Malterre before the rule existed, go to the client lines that
// reserved on those orders. Run once at deploy, after migration 0058. Dry run by default: prints every
// piece it would reserve; --write applies. Idempotent.
//
//   tsx --env-file=.env.development src/scripts/reserver-pieces-tricotees.ts           # dry run
//   tsx --env-file=.env src/scripts/reserver-pieces-tricotees.ts --write                 # on the API host
//
// Scope: knitting lines (type 1) not done (sstatut « Termin… ») on an order not soldée, with at least
// one reservation of a client line (affectation_cmd_tricotage). A piece already reserved, at a dyer,
// dyed, donated or shipped is never touched — same filter as the live rule.
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { planReservationTricot, reserverPiecesTricotees } from '../lib/repartition-tricotage.js'

const write = process.argv.includes('--write')

async function main() {
  const lignes = await query<{ lsst: number; cmd: number }>(
    `SELECT DISTINCT a.IDligne_commande_sous_traitant AS lsst, s.IDcommande_sous_traitant AS cmd
       FROM affectation_cmd_tricotage a
       JOIN ligne_commande_sous_traitant s ON s.IDligne_commande_sous_traitant = a.IDligne_commande_sous_traitant
       JOIN commande_sous_traitant c ON c.IDcommande_sous_traitant = s.IDcommande_sous_traitant
      WHERE s.type = 1 AND c.est_soldee = 0 AND s.sstatut NOT LIKE 'Termin%' AND a.poids_affecte > 0`,
  )
  const lsst = lignes.map((l) => Number(l.lsst)).filter((x) => x > 0)
  console.log(`${lsst.length} knitting line(s) in progress with a client reservation.`)
  if (lsst.length === 0) return

  const plan = await planReservationTricot(lsst)
  const ids = [...plan.values()].flat()
  if (ids.length === 0) { console.log('Nothing to reserve.'); return }
  const pieces = await query<{ id: number; numero: string | null; poids: number | null; lsst: number }>(
    `SELECT IDstock_ecru AS id, numero, poids, IDref_commande_source AS lsst FROM stock_ecru WHERE IDstock_ecru IN (${ids.join(',')})`,
  )
  const lccs = [...plan.keys()]
  const lignesClient = await query<{ id: number; cmd: number }>(
    `SELECT IDligne_commande_client AS id, IDcommande_client AS cmd FROM ligne_commande_client WHERE IDligne_commande_client IN (${lccs.join(',')})`,
  )
  const cmdIds = [...new Set(lignesClient.map((l) => Number(l.cmd)))]
  const numeros = new Map((await query<{ id: number; numero: number }>(
    `SELECT IDcommande_client AS id, numero FROM commande_client WHERE IDcommande_client IN (${cmdIds.join(',')})`,
  )).map((c) => [Number(c.id), String(c.numero)]))
  const cmdDe = new Map(lignesClient.map((l) => [Number(l.id), Number(l.cmd)]))
  const cmdSst = new Map(lignes.map((l) => [Number(l.lsst), Number(l.cmd)]))
  const parId = new Map(pieces.map((p) => [Number(p.id), p]))
  for (const [lcc, liste] of plan) {
    const kg = liste.reduce((s, id) => s + (Number(parId.get(id)?.poids) || 0), 0)
    const sst = [...new Set(liste.map((id) => cmdSst.get(Number(parId.get(id)?.lsst)) ?? 0))].join(', ')
    console.log(`client order ${numeros.get(cmdDe.get(lcc) ?? 0) ?? '?'} (line ${lcc}) ← knitting order ${sst}: ` +
      `${liste.length} piece(s), ${kg.toFixed(1)} kg — ${liste.map((id) => String(parId.get(id)?.numero ?? id).trim()).join(' ')}`)
  }
  if (!write) { console.log(`Dry run: ${ids.length} piece(s) would be reserved. Re-run with --write.`); return }
  const nb = await reserverPiecesTricotees(lsst)
  console.log(`Reserved ${nb} piece(s).`)
}

main()
  .then(async () => { await closeConnection(); process.exit(0) })
  .catch(async (e) => { console.error(e); await closeConnection(); process.exit(1) })
