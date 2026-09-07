// Read-only probe for the OF queue handover (LIVA #1128).
//
// Prints, per métier, the open queue of ordre_fabrication with the four
// columns the handover plays on (est_actif, est_termine, priorite, arret_prod)
// and flags the legacy Android AutoActivation leftovers — the rows
// lib/of-queue-trm.ts healHandedOverOfs would close on the ERP's next read:
// est_actif = 0, est_termine = 0, arret_prod stamped, another OF active on the
// same métier. Then the closing event of each leftover's last piece, so the
// device that wrote it is visible (`appareil` = 'Terminal N' is the Android
// app; the PWA leaves it empty).
//
// Writes nothing — run it on prod after an /etm_deploy, or before, to see what
// the deploy will repair:
//
//   node --env-file=.env.development --import tsx src/scripts/probe-of-handover-trm.ts
//   node --env-file=.env.production  --import tsx src/scripts/probe-of-handover-trm.ts
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { n } from '../lib/sst-shared.js'
import { handedOverLeftovers, type OpenOfState } from '../lib/of-queue-trm.js'
import { selectMachines, machineLabel } from '../lib/production-trm.js'

const COLS = 'IDordre_fabrication, IDmachine, est_actif, est_termine, priorite, auto_activation, nb_pieces, demarrage_prod, arret_prod'

const open = await query<any>(`SELECT ${COLS} FROM ordre_fabrication WHERE est_termine = 0 ORDER BY IDmachine ASC, est_actif DESC, priorite ASC`)
const machines = new Map((await selectMachines()).map((m) => [m.id, machineLabel(m)]))

console.log(`── file ouverte (${open.length} OF)`)
let current = -1
for (const o of open) {
  const m = n(o.IDmachine)
  if (m !== current) { current = m; console.log(`\n  métier ${machines.get(m) ?? '?'} (#${m})`) }
  const etat = n(o.est_actif) === 1 ? 'EN COURS' : 'attente '
  console.log(`    OF ${o.IDordre_fabrication}  ${etat}  prio ${o.priorite}  auto ${o.auto_activation}  démarré ${o.demarrage_prod ?? '—'}  arrêt ${o.arret_prod ?? '—'}`)
}

const state: OpenOfState[] = open.map((o: any) => ({
  id: n(o.IDordre_fabrication), IDmachine: n(o.IDmachine), est_actif: n(o.est_actif), arret_prod: o.arret_prod,
}))
const leftovers = handedOverLeftovers(state)
console.log(`\n── reliquats de l'AutoActivation legacy : ${leftovers.length}`)
for (const l of leftovers) {
  const pieces = await query<any>(`SELECT IDpiece_production, numero, date_fin FROM piece_production WHERE IDordre_fabrication = ${l.id} ORDER BY numero DESC`)
  const rolls = await query<any>(`SELECT COUNT(*) AS c FROM stock_ecru WHERE IDordre_fabrication = ${l.id}`)
  const last = pieces[0]
  const ev = last
    ? await query<any>(`SELECT evenement, appareil, IDbonnetier FROM evenement_piece WHERE IDpiece_production = ${last.IDpiece_production} ORDER BY IDevenement_piece DESC`)
    : []
  console.log(
    `  OF ${l.id} (métier ${machines.get(l.IDmachine) ?? l.IDmachine}) — ${pieces.length} pièces, ${n(rolls[0]?.c)} rouleaux ; ` +
      `dernière pièce n°${last?.numero ?? '—'} fermée par « ${ev[0]?.evenement ?? '?'} » [${ev[0]?.appareil ?? ''}]`,
  )
}
if (leftovers.length === 0) console.log('  (aucun — la base est propre)')

const activesOnly = await query<any>(`SELECT COUNT(*) AS c FROM ordre_fabrication WHERE est_actif = 1 AND est_termine = 1`)
console.log(`\nactif ET terminé (jamais attendu) : ${n(activesOnly[0]?.c)}`)
await closeConnection()
