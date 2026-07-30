// Client tarif modes (standard / coefficient fixe / contrat).
//
// Legacy model, per ref_client_colori (référence client × coloris):
//   • standard     — nothing stored; PrixDeVenteV4 with the degressive
//                    per-tranche margins (COEFFICIENT_V2).
//   • coefficient  — one tranche_tarifaire row (IDref_client_colori set,
//                    IDcontrat_tarif = 0) whose `coefficient` (%, e.g. 20)
//                    replaces the degressive margin on every tranche.
//   • contrat      — ref_client_colori.contrat = 1 + contrat_tarif rows
//                    (date_debut / date_expiration; renewals pile up as
//                    history) + tranche_tarifaire rows carrying the
//                    negotiated prix_saisi (€/Ml) per nb_rouleaux, linked
//                    via IDcontrat_tarif.
//
// Extracted from routes/clients.ts (Clients › Gestion) so the ORDER path can
// price the same way the fiche does: a client in contrat mode must be quoted
// its negotiated price, and once that contract expires the reference is simply
// not sellable — never a silent fall back to the standard grid. That fall back
// is the bug this module exists to close (a C2TEC order went out on the
// standard tariff a month after its contract lapsed, with nothing on screen
// saying so).
//
// tranche_tarifaire's qtéMin/qtéMax and contrat_tarif's archivé are accented —
// never named in any SELECT/INSERT here (explicit ASCII column lists only).

import { query } from './hfsql-auto.js'
import { numOf, strOf, pick, todayDigits } from './clients-common.js'

/** nb_rouleaux (0 = métrage "<1") → tranche index in the 9-tranche array. */
export const NB_RLX_TO_TRANCHE_IDX: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 10: 6, 15: 7, 30: 8 }

/** Default visible tranches: up to 10 rouleaux (indices 0..6). The 15/30
 *  rouleaux rows (7/8) are only shown once negotiated per client. */
export const DEFAULT_TRANCHE_IDX = [0, 1, 2, 3, 4, 5, 6]

/** Parse ref_client_colori.lst_tranche ("0,1,2,3,4,5,6" = indices into the
 *  9-tranche array <1,1,2,3,4,5,10,15,30 rlx) — empty falls back to the
 *  up-to-10-rouleaux default, matching the legacy Fiche Tarifs behavior. */
export function parseLstTrancheIdx(raw: string | null | undefined): number[] {
  const idx = [...new Set(
    String(raw ?? '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 8),
  )].sort((a, b) => a - b)
  return idx.length === 0 ? [...DEFAULT_TRANCHE_IDX] : idx
}

export interface ContratTarifInfo {
  IDcontrat_tarif: number
  date_debut: string
  date_expiration: string
  tranches: { nb_rouleaux: number; prix: number }[]
}

export interface TarifModeInfo {
  tarif_mode: 'standard' | 'coefficient' | 'contrat'
  coefficient: number
  contrats: ContratTarifInfo[]
  contrat_actif: ContratTarifInfo | null
  contrat_expire: boolean
}

/** Batched tarif-mode resolution for a set of ref_client_colori rows
 *  (two flat queries total — never per-row). `contrat` is the flag off the
 *  rcc row itself. */
export async function fetchTarifModes(rccs: { id: number; contrat: number }[]): Promise<Map<number, TarifModeInfo>> {
  const out = new Map<number, TarifModeInfo>()
  const ids = [...new Set(rccs.map((r) => r.id).filter((n) => Number.isInteger(n) && n > 0))]
  if (ids.length === 0) return out

  const [ttRows, ctRows] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT IDtranche_tarifaire, IDref_client_colori, nb_rouleaux, coefficient, prix_saisi, IDcontrat_tarif ` +
        `FROM tranche_tarifaire WHERE IDref_client_colori IN (${ids.join(',')})`,
    ),
    query<Record<string, unknown>>(
      `SELECT IDcontrat_tarif, IDref_client_colori, date_debut, date_expiration ` +
        `FROM contrat_tarif WHERE IDref_client_colori IN (${ids.join(',')})`,
    ),
  ])

  const coefByRcc = new Map<number, number>()
  const tranchesByContrat = new Map<number, { nb_rouleaux: number; prix: number }[]>()
  for (const t of ttRows) {
    const cid = numOf(t.IDcontrat_tarif)
    if (cid > 0) {
      const arr = tranchesByContrat.get(cid) ?? []
      arr.push({ nb_rouleaux: numOf(t.nb_rouleaux), prix: numOf(t.prix_saisi) })
      tranchesByContrat.set(cid, arr)
    } else if (numOf(t.coefficient) > 0) {
      coefByRcc.set(numOf(t.IDref_client_colori), numOf(t.coefficient))
    }
  }

  const contratsByRcc = new Map<number, ContratTarifInfo[]>()
  for (const c of ctRows) {
    const rid = numOf(c.IDref_client_colori)
    const info: ContratTarifInfo = {
      IDcontrat_tarif: numOf(c.IDcontrat_tarif),
      date_debut: strOf(c.date_debut) ?? '',
      date_expiration: strOf(c.date_expiration) ?? '',
      tranches: (tranchesByContrat.get(numOf(c.IDcontrat_tarif)) ?? []).sort(
        (a, b) => (NB_RLX_TO_TRANCHE_IDX[a.nb_rouleaux] ?? 99) - (NB_RLX_TO_TRANCHE_IDX[b.nb_rouleaux] ?? 99),
      ),
    }
    const arr = contratsByRcc.get(rid) ?? []
    arr.push(info)
    contratsByRcc.set(rid, arr)
  }
  for (const arr of contratsByRcc.values()) {
    // Newest first — YYYYMMDD strings compare lexicographically.
    arr.sort((a, b) => (a.date_debut === b.date_debut ? b.IDcontrat_tarif - a.IDcontrat_tarif : b.date_debut.localeCompare(a.date_debut)))
  }

  const today = todayDigits()
  for (const r of rccs) {
    const contrats = contratsByRcc.get(r.id) ?? []
    const actif = contrats.find(
      (c) => c.date_debut.length === 8 && c.date_expiration.length === 8 && c.date_debut <= today && today <= c.date_expiration,
    ) ?? null
    const coefficient = coefByRcc.get(r.id) ?? 0
    const tarif_mode: TarifModeInfo['tarif_mode'] = r.contrat === 1 ? 'contrat' : coefficient > 0 ? 'coefficient' : 'standard'
    out.set(r.id, {
      tarif_mode,
      coefficient,
      contrats,
      contrat_actif: actif,
      contrat_expire: tarif_mode === 'contrat' && actif === null,
    })
  }
  return out
}

// ── Order-line resolution (client × line reference × coloris → tarif mode) ──

export interface LigneTarifMode extends TarifModeInfo {
  IDref_client_colori: number
  /** Newest contract on the pair, active or not — the expiry date the UI shows. */
  dernier_contrat: ContratTarifInfo | null
}

/** The (reference, coloris) pair of a client order line maps to a
 *  ref_client_colori row through the client's designation_client catalogue.
 *  Returns null when the pair isn't in the client's catalogue at all (a line
 *  entered outside it prices standard, exactly as before).
 *
 *  `type` is the line's TYPE: 1 = écru (designation_client.IDref_ecru),
 *  2 = fini (designation_client.IDref_fini). Divers (3) never has a tarif mode.
 *
 *  Coloris matching is polymorphic like everywhere else
 *  (project_avec_teinture_coloris_rule): a dye ref carries an
 *  IDref_fini_colori, a wash-only ref an IDcolori_ecru. The id spaces collide
 *  numerically, so the expected column is tried first and the other one only as
 *  a fallback — never both at once. */
export async function resolveLigneTarifMode(p: {
  IDclient: number
  type: number
  IDreference: number
  IDcolori: number
}): Promise<LigneTarifMode | null> {
  if (!(p.IDclient > 0) || !(p.IDreference > 0)) return null
  if (p.type !== 1 && p.type !== 2) return null

  const refCol = p.type === 1 ? 'IDref_ecru' : 'IDref_fini'
  // designation_client tolerates SELECT * (verified); archivé is accented so it
  // is pruned in JS, never named in the WHERE.
  const dRows = await query<Record<string, unknown>>(
    `SELECT * FROM designation_client WHERE IDclient = ${p.IDclient} AND ${refCol} = ${p.IDreference}`,
  )
  const dIds = dRows
    .filter((r) => !numOf(pick(r, 'archivé', 'archiv')))
    .map((r) => numOf(r.IDdesignation_client))
    .filter((n) => n > 0)
  if (dIds.length === 0) return null

  const rccRows = await query<Record<string, unknown>>(
    `SELECT * FROM ref_client_colori WHERE IDdesignation_client IN (${dIds.join(',')})`,
  )
  const rcc = rccRows.filter((r) => !numOf(pick(r, 'archivé', 'archiv')))
  if (rcc.length === 0) return null

  // Which coloris column the line's IDcolori lives in depends on the ref.
  let expected: 'IDref_fini_colori' | 'IDcolori_ecru' = 'IDcolori_ecru'
  if (p.type === 2) {
    const fRows = await query<{ avec_teinture: number }>(
      `SELECT avec_teinture FROM ref_fini WHERE IDref_fini = ${p.IDreference}`,
    )
    expected = numOf(fRows[0]?.avec_teinture) !== 0 ? 'IDref_fini_colori' : 'IDcolori_ecru'
  }
  const other = expected === 'IDref_fini_colori' ? 'IDcolori_ecru' : 'IDref_fini_colori'
  const match =
    rcc.find((r) => numOf(r[expected]) === p.IDcolori && p.IDcolori > 0) ??
    rcc.find((r) => numOf(r[other]) === p.IDcolori && p.IDcolori > 0) ??
    null
  if (!match) return null

  const rccId = numOf(match.IDref_client_colori)
  const mode = (await fetchTarifModes([{ id: rccId, contrat: numOf(match.contrat) }])).get(rccId)
  if (!mode) return null
  return {
    ...mode,
    IDref_client_colori: rccId,
    // contrats is sorted newest-first by fetchTarifModes.
    dernier_contrat: mode.contrats[0] ?? null,
  }
}

/** Negotiated €/Ml of a contract at a tranche index (0 = métrage "<1 rouleau",
 *  1..8 = 1,2,3,4,5,10,15,30 rouleaux): the largest band the contract defines
 *  at or below that index, falling back to its smallest (dearest) band when the
 *  quantity sits below every negotiated one — a contract that only prices
 *  "1 rouleau" prices the whole order at that figure, which is the common case
 *  (a single-band contract is what most clients actually sign).
 *  Returns null when the contract carries no priced tranche at all. */
export function contratPrixForTrancheIdx(contrat: ContratTarifInfo, idx: number): number | null {
  const bands = contrat.tranches
    .filter((t) => t.prix > 0 && NB_RLX_TO_TRANCHE_IDX[t.nb_rouleaux] !== undefined)
    .map((t) => ({ idx: NB_RLX_TO_TRANCHE_IDX[t.nb_rouleaux], prix: t.prix }))
    .sort((a, b) => a.idx - b.idx)
  if (bands.length === 0) return null
  let picked = bands[0]
  for (const b of bands) {
    if (b.idx <= idx) picked = b
  }
  return picked.prix
}
