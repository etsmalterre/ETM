// A tombé de métier is sold by the kg (LIVA #1144). Its old ref_ecru.rendement is
// retired (decision Vincent 2026-10-26, lib/freinte-tricotage.ts): in knitting one
// speaks of yarn in and matter out, in kg; the Ml becomes the unit at the stenter
// (ref_fini.rendement).
//
// Exception, LIVA #1355 (Vincent 2026-11-09): a few historical clients still buy
// some écru by the metre. A reference opens it with « Vente au mètre » on its fiche
// (ref_ecru.vente_au_metre) and its own conversion `rendement_metre` (Ml per kg,
// migration 0067 — never the retired `rendement`, which still holds stale values on
// 93 fiches). The client then chooses Ml on its designation, as for a fini. Every
// Ml figure is kg × rendement: the price per Ml = price per kg ÷ rendement, and the
// BL / invoice bill Σ poids × rendement (an écru roll has no measured length).

import { query } from './hfsql-auto.js'

/** Line types (ligne_commande_client / ligne_devis_etm `type`): 1 = écru. Unit 3 = Ml. */
export function ecruEnMl(type: unknown, unite: unknown): boolean {
  return Number(type) === 1 && Number(unite) === 3
}

export const MESSAGE_ECRU_EN_ML =
  'Ce tombé de métier ne se vend pas au mètre : choisissez l’unité Kg, '
  + 'ou activez « Vente au mètre » sur sa fiche (Tombé Métier › Références).'

/** The Ml per kg a reference sells at, 0 when it is not sold by the metre. Pure. */
export function rendementVenteEcru(r: { vente_au_metre?: unknown; rendement_metre?: unknown }): number {
  if (!Number(r.vente_au_metre)) return 0
  const v = Math.round((Number(r.rendement_metre) || 0) * 100) / 100
  return v > 0 ? v : 0
}

/** Metres billed for one écru roll: its weight × the reference's rendement,
 *  to the centimetre. 0 without a rendement. Pure. */
export function metrageEcruVendu(poids: unknown, rendement: number): number {
  if (!(rendement > 0)) return 0
  return Math.round((Number(poids) || 0) * rendement * 100) / 100
}

/** `rendementVenteEcru` of each reference, read in one query. Missing ids → 0. */
export async function loadRendementsVenteEcru(ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const uniq = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))]
  if (uniq.length === 0) return out
  const rows = await query<{ IDref_ecru: number; vente_au_metre: number | null; rendement_metre: number | null }>(
    `SELECT IDref_ecru, vente_au_metre, rendement_metre FROM ref_ecru WHERE IDref_ecru IN (${uniq.join(',')})`,
  )
  for (const r of rows) out.set(Number(r.IDref_ecru), rendementVenteEcru(r))
  return out
}

export async function loadRendementVenteEcru(id: number): Promise<number> {
  return (await loadRendementsVenteEcru([id])).get(id) ?? 0
}

/** An écru line may be in Ml only when its reference is sold by the metre.
 *  Returns the refusal message, or null when the line is fine. */
export async function refusEcruEnMl(type: unknown, unite: unknown, IDreference: unknown): Promise<string | null> {
  if (!ecruEnMl(type, unite)) return null
  return (await loadRendementVenteEcru(Number(IDreference) || 0)) > 0 ? null : MESSAGE_ECRU_EN_ML
}

/** Clients holding a price contract on a Ml designation of this écru — the prices
 *  whose unit would change if the reference's « Vente au mètre » flipped. */
export async function clientsContratEcruEnMl(IDref_ecru: number): Promise<string[]> {
  if (!(IDref_ecru > 0)) return []
  const desig = await query<{ IDdesignation_client: number; IDclient: number }>(
    `SELECT IDdesignation_client, IDclient FROM designation_client
      WHERE IDref_ecru = ${IDref_ecru} AND (IDref_fini IS NULL OR IDref_fini = 0) AND unite = 3`,
  )
  if (desig.length === 0) return []
  const clientOf = new Map(desig.map((d) => [Number(d.IDdesignation_client), Number(d.IDclient)]))
  const rcc = await query<{ IDref_client_colori: number; IDdesignation_client: number }>(
    `SELECT IDref_client_colori, IDdesignation_client FROM ref_client_colori
      WHERE IDdesignation_client IN (${[...clientOf.keys()].join(',')})`,
  )
  if (rcc.length === 0) return []
  const ct = await query<{ IDref_client_colori: number }>(
    `SELECT IDref_client_colori FROM contrat_tarif
      WHERE IDref_client_colori IN (${rcc.map((r) => Number(r.IDref_client_colori)).join(',')})`,
  )
  const avecContrat = new Set(ct.map((r) => Number(r.IDref_client_colori)))
  const clientIds = [...new Set(rcc
    .filter((r) => avecContrat.has(Number(r.IDref_client_colori)))
    .map((r) => clientOf.get(Number(r.IDdesignation_client)) ?? 0)
    .filter((n) => n > 0))]
  if (clientIds.length === 0) return []
  const noms = await query<{ nom: string | null }>(`SELECT nom FROM client WHERE IDclient IN (${clientIds.join(',')}) ORDER BY nom`)
  return noms.map((n) => (n.nom ?? '').trim()).filter(Boolean)
}
