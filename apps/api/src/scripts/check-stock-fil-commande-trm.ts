// Guard: the Stock de fil tab of a TRM commande line must offer only lots the
// ORDER'S CLIENT owns, in TRM's warehouse, not archived — the legacy
// FI_Gestion_Commande_TRM query's three filters:
//   stock_fil.IDclient = {pIDClient} AND stock_fil.IDMagasin = 1
//   AND stock_fil.terminé = 0
// TRM knits à façon: the client supplies the yarn, so an order can only run off
// its own client's lots. Read-only; reproduces the endpoint's predicate over
// every open TRM line and reports what the client filter removes.
import 'dotenv/config'
import { query } from '../lib/hfsql-auto.js'

const n = (v: unknown) => Number(v) || 0
const f = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
const TRM_MAGASIN = 1

async function main() {
  const cmds = await query<any>(
    `SELECT IDcommande_client, numero, IDclient FROM commande_client WHERE IDsociete = 2 AND est_soldee = 0`,
  )
  const cmdById = new Map<number, any>()
  for (const c of cmds) cmdById.set(n(c.IDcommande_client), c)
  const cliIds = Array.from(new Set(cmds.map((c: any) => n(c.IDclient)).filter(Boolean)))
  const clients = cliIds.length
    ? await query<any>(`SELECT IDclient, nom FROM client WHERE IDclient IN (${cliIds.join(',')})`)
    : []
  const cliName = new Map(clients.map((c: any) => [n(c.IDclient), String(c.nom ?? '').trim()]))

  if (cmds.length === 0) { console.log('Aucune commande TRM ouverte.'); process.exit(0) }
  const lignes = await query<any>(
    `SELECT IDligne_commande_client, IDcommande_client, IDreference, IDcolori FROM ligne_commande_client
     WHERE IDcommande_client IN (${Array.from(cmdById.keys()).join(',')}) AND TYPE = 1`,
  )
  const compo = await query<any>(`SELECT IDref_ecru, IDcolori_ecru, IDref_fil, IDcolori_fil FROM composition_ecru WHERE IDref_fil > 0`)
  const lots = await query<any>(
    `SELECT IDstock_fil, lot, IDref_fil, IDcolori_fil, IDclient, IDMagasin, stock FROM stock_fil WHERE stock > 0`,
  )
  const archived = new Set(
    (await query<any>(`SELECT IDstock_fil FROM stock_fil WHERE terminé = 1`)).map((r: any) => n(r.IDstock_fil)),
  )

  let lignesAvecEcart = 0
  let lotsRetires = 0
  console.log('ligne | cmd  | client                    | avant | après | lots retirés (propriétaire)')
  for (const l of lignes) {
    const cmd = cmdById.get(n(l.IDcommande_client))
    if (!cmd) continue
    const idClient = n(cmd.IDclient)
    const pairs = new Set(
      compo
        .filter((c: any) => n(c.IDref_ecru) === n(l.IDreference)
          && (n(l.IDcolori) === 0 || n(c.IDcolori_ecru) === n(l.IDcolori)))
        .map((c: any) => `${n(c.IDref_fil)}:${n(c.IDcolori_fil)}`),
    )
    if (pairs.size === 0) continue
    const candidats = lots.filter((x: any) => pairs.has(`${n(x.IDref_fil)}:${n(x.IDcolori_fil)}`))
    const apres = candidats.filter((x: any) =>
      n(x.IDclient) === idClient && n(x.IDMagasin) === TRM_MAGASIN && !archived.has(n(x.IDstock_fil)))
    if (candidats.length === apres.length) continue
    lignesAvecEcart++
    lotsRetires += candidats.length - apres.length
    const retires = candidats.filter((x: any) => !apres.includes(x))
    console.log(
      `${String(n(l.IDligne_commande_client)).padEnd(5)} | ${String(n(cmd.numero)).padEnd(4)} | ${(cliName.get(idClient) ?? '?').padEnd(25)} | ${String(candidats.length).padStart(5)} | ${String(apres.length).padStart(5)} | ` +
      retires.map((x: any) => `${x.lot} (${cliName.get(n(x.IDclient)) ?? `client ${n(x.IDclient)}`}, ${f(x.stock).toFixed(0)} Kg)`).join(', '),
    )
  }
  console.log(`\nlignes de type 1 sur commandes ouvertes : ${lignes.length}`)
  console.log(`  dont la liste change              : ${lignesAvecEcart}`)
  console.log(`  lots retirés au total             : ${lotsRetires}`)
  console.log('\n✓ Tout lot retiré ci-dessus appartient à un AUTRE client, à un autre magasin, ou est archivé.')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
