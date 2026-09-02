// Guard for LIVA #1117 « deux adresses » — the formelle pass of « Générer les
// factures » groups by client × billing address of the commande × delivery
// address of the avis (lib/facturation-groupes.ts). Pins the data facts that
// rule rests on, and dry-runs the grouping over the live un-invoiced avis.
//
// Facts pinned (dev copy, 2026-09-02):
//   §1 facture.IDadresse == commande_client.IDadresse_facturation on ≥ 99 % of
//      the legacy invoices with formelle lines (3 317 / 3 331) — the legacy
//      GenererFacturesETM key, recovered from the WinDev compile cache.
//   §2 Agape (client 234) bills to Temara (428) on every commande and ships
//      23 of them to C2TEC (858): the split MUST come from the delivery
//      address, the billing address alone would never separate them.
//   §3 the grouping never puts two delivery addresses on one proforma, and
//      never splits a client whose avis all went to one address.
//
// Run:  cd apps/api && npx tsx src/scripts/check-facturation-adresses.ts
import { query } from '../lib/hfsql-auto.js'
import { groupFormelle, type FormelleCandidate, type FormelleClient, type FormelleCommande } from '../lib/facturation-groupes.js'

function n(v: unknown): number { return Number(v) || 0 }
let failures = 0
function check(ok: boolean, label: string) {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}
function chunks<T>(arr: T[], size = 500): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function main() {
  // ── §1 legacy rule: invoice address = commande billing address ───────────
  const lf = await query<any>(
    `SELECT lf.IDfacture, le.IDexpedition FROM ligne_facture lf
     JOIN ligne_expedition le ON le.IDligne_expedition = lf.IDligne_expedition
     WHERE lf.IDligne_expedition > 0`,
  )
  const expCmd = new Map<number, number>()
  for (const c of chunks(Array.from(new Set(lf.map((r: any) => n(r.IDexpedition)))))) {
    for (const r of await query<any>(`SELECT IDexpedition, IDcommande_client FROM expedition WHERE IDexpedition IN (${c.join(',')})`)) {
      expCmd.set(n(r.IDexpedition), n(r.IDcommande_client))
    }
  }
  const cmdFac = new Map<number, number>()
  for (const c of chunks(Array.from(new Set(Array.from(expCmd.values()).filter((x) => x > 0))))) {
    for (const r of await query<any>(`SELECT IDcommande_client, IDadresse_facturation FROM commande_client WHERE IDcommande_client IN (${c.join(',')})`)) {
      cmdFac.set(n(r.IDcommande_client), n(r.IDadresse_facturation))
    }
  }
  const byFac = new Map<number, Set<number>>()
  for (const r of lf as any[]) {
    const s = byFac.get(n(r.IDfacture)) ?? new Set<number>()
    s.add(cmdFac.get(expCmd.get(n(r.IDexpedition)) ?? 0) ?? -1)
    byFac.set(n(r.IDfacture), s)
  }
  const facAdr = new Map<number, number>()
  for (const c of chunks(Array.from(byFac.keys()))) {
    for (const r of await query<any>(`SELECT IDfacture, IDadresse FROM facture WHERE IDfacture IN (${c.join(',')}) AND IDsociete = 1`)) {
      facAdr.set(n(r.IDfacture), n(r.IDadresse))
    }
  }
  let single = 0, eq = 0
  for (const [fid, set] of byFac) {
    if (!facAdr.has(fid) || set.size !== 1) continue
    single++
    if ([...set][0] === facAdr.get(fid)) eq++
  }
  const ratio = single ? eq / single : 0
  check(single > 3000 && ratio >= 0.99, `§1 facture.IDadresse suit commande_client.IDadresse_facturation : ${eq}/${single} (${(ratio * 100).toFixed(1)} %)`)

  // ── §2 Agape: same billing address, two delivery addresses ───────────────
  const agape = await query<any>(`SELECT IDadresse_facturation, IDadresse_livraison FROM commande_client WHERE IDclient = 234 AND IDsociete = 1`)
  const factSet = new Set(agape.map((r: any) => n(r.IDadresse_facturation)))
  const livrSet = new Set(agape.map((r: any) => n(r.IDadresse_livraison)))
  check(agape.length > 100 && factSet.size === 1 && livrSet.has(858) && livrSet.has(428),
    `§2 Agape : ${agape.length} commandes, ${factSet.size} adresse de facturation, livraisons {${[...livrSet].join(',')}} — le découpage ne peut venir que de la livraison`)

  // ── §3 dry-run the grouping over today's un-invoiced avis ────────────────
  const expRows = await query<any>(
    `SELECT IDexpedition, IDcommande_client, IDadresse, donation FROM expedition
     WHERE IDsociete = 1 AND (est_facture IS NULL OR est_facture = 0)`,
  )
  const candidates: FormelleCandidate[] = expRows
    .filter((e: any) => n(e.donation) !== 1)
    .map((e: any) => ({ id: n(e.IDexpedition), cmdId: n(e.IDcommande_client), adrLivraison: n(e.IDadresse) }))
  const cmdMap = new Map<number, FormelleCommande>()
  for (const c of chunks(Array.from(new Set(candidates.map((e) => e.cmdId).filter((x) => x > 0))))) {
    for (const r of await query<any>(`SELECT IDcommande_client, IDclient, IDadresse_facturation, donation FROM commande_client WHERE IDcommande_client IN (${c.join(',')})`)) {
      cmdMap.set(n(r.IDcommande_client), { IDclient: n(r.IDclient), IDadresse_facturation: n(r.IDadresse_facturation), donation: n(r.donation) })
    }
  }
  const clientMap = new Map<number, FormelleClient>()
  for (const c of chunks(Array.from(new Set(Array.from(cmdMap.values()).map((x) => x.IDclient).filter((x) => x > 0))))) {
    for (const r of await query<any>(`SELECT IDclient, client_interne FROM client WHERE IDclient IN (${c.join(',')})`)) {
      clientMap.set(n(r.IDclient), { interne: n(r.client_interne) })
    }
  }
  const g = groupFormelle(candidates, cmdMap, clientMap)
  const expAdr = new Map(candidates.map((e) => [e.id, e.adrLivraison]))
  const mixed = g.groups.filter((grp) => new Set(grp.expeditions.map((e) => expAdr.get(e.id))).size > 1)
  check(mixed.length === 0, `§3a aucun groupe ne mêle deux adresses de livraison (${g.groups.length} groupes sur ${candidates.length} avis)`)
  // A client with one delivery address across all its avis must stay one group.
  const perClientAdr = new Map<number, Set<number>>()
  const perClientGroups = new Map<number, number>()
  for (const grp of g.groups) {
    const s = perClientAdr.get(grp.clientId) ?? new Set<number>()
    for (const e of grp.expeditions) s.add(e.adrLivraison)
    perClientAdr.set(grp.clientId, s)
    perClientGroups.set(grp.clientId, (perClientGroups.get(grp.clientId) ?? 0) + 1)
  }
  let overSplit = 0
  for (const [c, k] of perClientGroups) {
    const adrs = perClientAdr.get(c)!
    const facs = new Set(g.groups.filter((x) => x.clientId === c).map((x) => x.adrFacturation))
    if (k > adrs.size * facs.size) overSplit++
  }
  check(overSplit === 0, `§3b aucun client découpé au-delà de ses adresses (${g.multiAdresses.size} client(s) sur plusieurs adresses aujourd'hui : ${[...g.multiAdresses].join(', ') || '—'})`)
  for (const c of g.multiAdresses) {
    const rows = g.groups.filter((x) => x.clientId === c).map((x) => `livr ${x.adrLivraison} ← avis ${x.expeditions.map((e) => e.id).join(',')}`)
    console.log(`    client ${c}: ${rows.join(' | ')}`)
  }

  console.log(failures === 0 ? '\nOK' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
