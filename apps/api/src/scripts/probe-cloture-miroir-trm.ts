// Read-only probe — the TRM mirrors that ETM has already clôturé but that
// are still « En cours » on the TRM ledger, and what still blocks their
// clôture under the rule of `routes/commandes-trm.ts` checkCloture().
//
// Context (LIVA #1100, 2026-09-02): until then a mirror (commande_client
// with IDcommande_ETM > 0) could not be soldée from anywhere — TRM refused
// it as a mirror, ETM's clôture only writes commande_sous_traitant. So every
// sst clôturé since go-live left its mirror open. The fix lets TRM solder
// its own side once every OF is terminé and every roll shipped; this probe
// says how many of the drifted mirrors Nicolas can now close with one
// click, and which ones are blocked (an OF never terminated, a roll never
// shipped) and need a look first.
//
//   pnpm exec tsx src/scripts/probe-cloture-miroir-trm.ts
//
// Safe to replay on prod after /etm_deploy — it only reads.

import { query, closeConnection } from '../lib/hfsql-auto.js'

interface Row { IDcommande_client: number; numero: number | null; date_commande: string | null; IDcommande_ETM: number; sst_soldee: number }

async function main() {
  const drifted = await query<Row>(
    `SELECT cc.IDcommande_client, cc.numero, cc.date_commande, cc.IDcommande_ETM, cst.est_soldee AS sst_soldee
     FROM commande_client cc
     JOIN commande_sous_traitant cst ON cst.IDcommande_sous_traitant = cc.IDcommande_ETM
     WHERE cc.IDsociete = 2 AND cc.IDcommande_ETM > 0 AND cc.est_soldee = 0
     ORDER BY cc.IDcommande_client`,
  )
  const openMirrors = drifted.length
  const etmClosed = drifted.filter((r) => Number(r.sst_soldee) === 1)
  console.log(`open TRM mirrors: ${openMirrors} — of which ETM already clôturé: ${etmClosed.length}`)

  let closable = 0
  const blocked: Array<{ numero: number | null; date: string | null; sst: number; of: number; rolls: number }> = []
  for (const r of drifted) {
    const lines = await query<{ IDligne_commande_client: number }>(
      `SELECT IDligne_commande_client FROM ligne_commande_client WHERE IDcommande_client = ${Number(r.IDcommande_client)}`,
    )
    const ids = lines.map((l) => Number(l.IDligne_commande_client)).filter((x) => x > 0)
    let of = 0
    let rolls = 0
    if (ids.length > 0) {
      const inList = ids.join(',')
      of = Number((await query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ordre_fabrication WHERE IDligne_commande_client IN (${inList}) AND est_termine = 0`,
      ))[0]?.n) || 0
      rolls = Number((await query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM stock_ecru WHERE IDLigne_Commande_TRM IN (${inList}) AND IDligne_expedition_TRM = 0`,
      ))[0]?.n) || 0
    }
    const isEtmClosed = Number(r.sst_soldee) === 1
    if (of === 0 && rolls === 0) { if (isEtmClosed) closable += 1 }
    else if (isEtmClosed) blocked.push({ numero: r.numero, date: r.date_commande, sst: Number(r.IDcommande_ETM), of, rolls })
  }
  console.log(`ETM-clôturé mirrors TRM can solder now: ${closable}`)
  console.log(`ETM-clôturé mirrors still blocked: ${blocked.length}`)
  if (blocked.length > 0) console.table(blocked)
  await closeConnection()
}

main().catch((e) => { console.error(e); process.exit(1) })
