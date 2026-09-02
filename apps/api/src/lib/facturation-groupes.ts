// Grouping rule of the FORMELLE pass of « Générer les factures » (LIVA #1117).
//
// One proforma per (client × billing address of the commande × delivery
// address of the avis). The first two halves are the legacy GenererFacturesETM
// key (recovered from the WinDev compile cache — it also grouped on mode de
// paiement / échéance / remise, which nobody has asked for); the third is the
// #1117 rule: two avis of one client shipped to two addresses must never share
// an invoice. Legacy never split on it — 207 of its invoices mix delivery
// addresses — and Isabelle only got separate invoices by generating after each
// avis; once two avis existed before the run, WinDev merged them too.
//
// Pure: the route feeds it the rows it already loaded and writes the groups
// out. Keep it that way so the rule stays unit-testable off the database.

export interface FormelleCandidate {
  /** expedition.IDexpedition */
  id: number
  /** expedition.IDcommande_client (0 when detached) */
  cmdId: number
  /** expedition.IDadresse — where the goods went */
  adrLivraison: number
}

export interface FormelleCommande {
  IDclient: number
  /** commande_client.IDadresse_facturation — 0 falls back to the client's default */
  IDadresse_facturation: number
  donation: number
}

export interface FormelleClient {
  interne: number
}

export interface FormelleGroup {
  clientId: number
  /** 0 = use the client's default billing address */
  adrFacturation: number
  adrLivraison: number
  expeditions: FormelleCandidate[]
}

export interface FormelleGrouping {
  groups: FormelleGroup[]
  skippedVide: number
  skippedDonation: number
  skippedInterne: number
  /** Clients that ended up with more than one group this run — the UI names
   *  the delivery address on those so the split reads as intended. */
  multiAdresses: Set<number>
}

export function groupFormelle(
  candidates: FormelleCandidate[],
  cmdMap: Map<number, FormelleCommande>,
  clientMap: Map<number, FormelleClient>,
): FormelleGrouping {
  let skippedVide = 0
  let skippedDonation = 0
  let skippedInterne = 0
  const byKey = new Map<string, FormelleGroup>()
  for (const e of [...candidates].sort((a, b) => a.id - b.id)) {
    const cmd = cmdMap.get(e.cmdId)
    if (!cmd || !(cmd.IDclient > 0) || !clientMap.has(cmd.IDclient)) { skippedVide++; continue }
    if (cmd.donation === 1) { skippedDonation++; continue }
    if (clientMap.get(cmd.IDclient)!.interne === 1) { skippedInterne++; continue }
    const adrFacturation = cmd.IDadresse_facturation > 0 ? cmd.IDadresse_facturation : 0
    const adrLivraison = e.adrLivraison > 0 ? e.adrLivraison : 0
    const key = `${cmd.IDclient}|${adrFacturation}|${adrLivraison}`
    let g = byKey.get(key)
    if (!g) {
      g = { clientId: cmd.IDclient, adrFacturation, adrLivraison, expeditions: [] }
      byKey.set(key, g)
    }
    g.expeditions.push(e)
  }
  const groups = Array.from(byKey.values())
  const perClient = new Map<number, number>()
  for (const g of groups) perClient.set(g.clientId, (perClient.get(g.clientId) ?? 0) + 1)
  const multiAdresses = new Set<number>()
  for (const [c, k] of perClient) if (k > 1) multiAdresses.add(c)
  return { groups, skippedVide, skippedDonation, skippedInterne, multiAdresses }
}
