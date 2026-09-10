/**
 * Probe for ticket #1144 — in which UNIT is a contract's `prix_saisi`?
 *   pnpm --filter @mps/api exec tsx --env-file=.env.development src/scripts/probe-1144-contrat-units.ts
 * For every contract with a single-band tranche, compares prix_saisi with the
 * prices of the order lines taken on that designation while the contract ran,
 * split by the designation's unite (1 = Kg, 3 = Ml). Read-only.
 */
import { query, closeConnection } from '../lib/hfsql-auto.js'

const num = (v: unknown) => Number(v) || 0
async function main() {
  const contrats = await query<any>(`SELECT IDcontrat_tarif, IDref_client_colori, date_debut, date_expiration FROM contrat_tarif`)
  const tranches = await query<any>(`SELECT IDcontrat_tarif, nb_rouleaux, prix_saisi FROM tranche_tarifaire WHERE IDcontrat_tarif > 0`)
  const rccIds = [...new Set(contrats.map((c) => num(c.IDref_client_colori)).filter((x) => x > 0))]
  const rccs = await query<any>(`SELECT IDref_client_colori, IDdesignation_client FROM ref_client_colori WHERE IDref_client_colori IN (${rccIds.join(',')})`)
  const desIds = [...new Set(rccs.map((r) => num(r.IDdesignation_client)).filter((x) => x > 0))]
  const des = await query<any>(`SELECT IDdesignation_client, IDclient, IDref_ecru, IDref_fini, unite FROM designation_client WHERE IDdesignation_client IN (${desIds.join(',')})`)
  const lignes = await query<any>(`SELECT IDcommande_client, IDdesignation_client, prix, unite, quantite FROM ligne_commande_client WHERE IDdesignation_client IN (${desIds.join(',')})`)
  const cmdIds = [...new Set(lignes.map((l) => num(l.IDcommande_client)))]
  const cmds: any[] = []
  for (let i = 0; i < cmdIds.length; i += 300) {
    cmds.push(...await query<any>(`SELECT IDcommande_client, date_commande FROM commande_client WHERE IDcommande_client IN (${cmdIds.slice(i, i + 300).join(',')})`))
  }
  const dateOf = new Map(cmds.map((c) => [num(c.IDcommande_client), String(c.date_commande ?? '')]))
  const desById = new Map(des.map((d) => [num(d.IDdesignation_client), d]))
  const rccById = new Map(rccs.map((r) => [num(r.IDref_client_colori), r]))
  const trByContrat = new Map<number, any[]>()
  for (const t of tranches) { const a = trByContrat.get(num(t.IDcontrat_tarif)) ?? []; a.push(t); trByContrat.set(num(t.IDcontrat_tarif), a) }

  const rows: any[] = []
  const tally: Record<string, { same: number; diff: number; none: number }> = {}
  for (const c of contrats) {
    const rcc = rccById.get(num(c.IDref_client_colori)); if (!rcc) continue
    const d = desById.get(num(rcc.IDdesignation_client)); if (!d) continue
    const tr = (trByContrat.get(num(c.IDcontrat_tarif)) ?? []).sort((a, b) => num(a.nb_rouleaux) - num(b.nb_rouleaux))
    if (tr.length === 0) continue
    const prices = tr.map((t) => num(t.prix_saisi))
    const inRange = lignes.filter((l) => num(l.IDdesignation_client) === num(d.IDdesignation_client))
      .filter((l) => { const dt = dateOf.get(num(l.IDcommande_client)) ?? ''; return dt >= String(c.date_debut) && dt <= String(c.date_expiration) })
    const linePrices = [...new Set(inRange.map((l) => Math.round(num(l.prix) * 100) / 100))].sort((a, b) => a - b)
    const lineUnits = [...new Set(inRange.map((l) => num(l.unite)))]
    const kind = num(d.IDref_ecru) > 0 ? 'ecru' : 'fini'
    const key = `${kind} · designation unite ${num(d.unite)}`
    tally[key] ??= { same: 0, diff: 0, none: 0 }
    const match = linePrices.some((p) => prices.some((q) => Math.abs(p - q) < 0.011))
    if (inRange.length === 0) tally[key].none++; else if (match) tally[key].same++; else tally[key].diff++
    if (inRange.length > 0) rows.push({ contrat: num(c.IDcontrat_tarif), kind, des_unite: num(d.unite), prix_saisi: prices.join('/'), lignes: inRange.length, line_unites: lineUnits.join('/'), line_prix: linePrices.slice(0, 5).join(' '), match })
  }
  console.log('contracts with tranches:', contrats.length, '| per kind/unit — lines priced AT prix_saisi (same) vs not (diff) vs no line in range (none):')
  console.table(tally)
  console.log('écru designations under contract (all):')
  console.table(rows.filter((r) => r.kind === 'ecru'))
  console.log('fini contracts where line prices DIFFER from prix_saisi (first 12):')
  console.table(rows.filter((r) => r.kind === 'fini' && !r.match).slice(0, 12))
  await closeConnection()
}
main().catch((e) => { console.error(e); process.exit(1) })
