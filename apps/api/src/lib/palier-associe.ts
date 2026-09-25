import { query, fixEncoding } from './hfsql-auto.js'
import { numOf, strOf, pick } from './clients-common.js'
import { ROLL_MULT } from './pricing-fini-tarif.js'
import { geom, pickTrancheIndex, rollSizeFor } from './roll-geometry.js'
import { parseAssocieeCsv } from './refs-associees.js'

/**
 * The associated-ref band (LIVA #1217) — legacy FEN_Gestion_ligne_commandeV2
 * « Associée à »: a côte ordered with its molleton is priced at the MOLLETON's
 * quantity band, not at its own (90 Ml of côte next to 570 Ml / 10 rolls of
 * molleton pays the 10-roll price).
 *
 * Pairing, as decided with Vincent 2026-09-25:
 *   • the link is the CLIENT's (Clients › Gestion): a parent designation whose
 *     `associee` CSV holds a hidden child designation on the côte's ref_fini;
 *   • only a molleton line of the SAME COLORIS pairs. The two refs have their
 *     own coloris rows whose names carry the dyer's lab number
 *     (« 0804 noir OTV 63763/2 » vs « 0804 noir OTV 63764/2 »), so the names are
 *     compared without it — see colorisKey(). On the 861 côte lines ordered with
 *     their molleton in prod (2026-09-25), 738 match exactly and 41 more only
 *     after dropping the lab number;
 *   • several matching molleton lines → the best band wins; the côte never
 *     pays more than its own quantity would.
 */

export interface PalierAssocie {
  /** The molleton line the band comes from. */
  IDligne_commande_client: number
  reference: string
  coloris: string
  nRolls: number
  trancheIdx: number
  /** Roll count of the band (1, 2, 3, 4, 5, 10, 15, 30; 0 = métrage). */
  trancheRolls: number
}

/** A coloris name without what differs between two refs dyed the same colour:
 *  accents, case, spacing and punctuation, the « (m) » marker, and the trailing
 *  dyer lab number (« 63763/2 »). */
export function colorisKey(name: string | null | undefined): string {
  return String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(m\)/g, '')
    .replace(/[\s-]*\d{4,6}\/\d+\s*$/, '')
    .replace(/[^a-z0-9]/g, '')
}

/** Parent ref → the associated (côte) refs the client has linked under it. */
export async function loadClientAssociations(IDclient: number): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>()
  if (!(IDclient > 0)) return out
  // designation_client tolerates SELECT * (verified); archivé is accented → pruned in JS.
  const rows = (await query<Record<string, unknown>>(
    `SELECT * FROM designation_client WHERE IDclient = ${IDclient}`,
  )).filter((r) => !numOf(pick(r, 'archivé', 'archiv')))
  const finiByDid = new Map(rows.map((r) => [numOf(r.IDdesignation_client), numOf(r.IDref_fini)]))
  for (const r of rows) {
    const parent = numOf(r.IDref_fini)
    if (!(parent > 0)) continue
    for (const did of parseAssocieeCsv(r.associee)) {
      const child = finiByDid.get(did) ?? 0
      if (child > 0 && child !== parent) {
        const set = out.get(parent) ?? new Set<number>()
        set.add(child)
        out.set(parent, set)
      }
    }
  }
  return out
}

export interface RefGeo { reference: string; avec_teinture: number; rendement: number; poids: number }

export async function loadRefGeo(ids: number[]): Promise<Map<number, RefGeo>> {
  const out = new Map<number, RefGeo>()
  const uniq = [...new Set(ids.filter((x) => x > 0))]
  if (uniq.length === 0) return out
  const rows = await query<Record<string, unknown>>(
    `SELECT IDref_fini, reference, avec_teinture, rendement, IDref_ecru FROM ref_fini WHERE IDref_fini IN (${uniq.join(',')})`,
  )
  const fixed = await fixEncoding(rows, 'ref_fini', 'IDref_fini', ['reference'])
  const ecruIds = [...new Set(fixed.map((r) => numOf(r.IDref_ecru)).filter((x) => x > 0))]
  const poidsByEcru = new Map<number, number>()
  if (ecruIds.length > 0) {
    const er = await query<{ IDref_ecru: number; poids: number | null }>(
      `SELECT IDref_ecru, poids FROM ref_ecru WHERE IDref_ecru IN (${ecruIds.join(',')})`,
    )
    for (const e of er) poidsByEcru.set(numOf(e.IDref_ecru), numOf(e.poids))
  }
  for (const r of fixed) {
    out.set(numOf(r.IDref_fini), {
      reference: strOf(r.reference) ?? '',
      avec_teinture: numOf(r.avec_teinture),
      rendement: numOf(r.rendement),
      poids: poidsByEcru.get(numOf(r.IDref_ecru)) ?? 0,
    })
  }
  return out
}

/** Coloris labels of fini lines — polymorphic by the ref's avec_teinture
 *  (dyed → ref_fini_colori, wash-only → colori_ecru; the id spaces collide). */
export async function loadColorisNames(lines: { IDreference: number; IDcolori: number }[], geo: Map<number, RefGeo>): Promise<(l: { IDreference: number; IDcolori: number }) => string> {
  const dyed = new Set<number>(), washed = new Set<number>()
  for (const l of lines) {
    if (!(l.IDcolori > 0)) continue
    if ((geo.get(l.IDreference)?.avec_teinture ?? 0) !== 0) dyed.add(l.IDcolori); else washed.add(l.IDcolori)
  }
  const dyedNames = new Map<number, string>(), washedNames = new Map<number, string>()
  if (dyed.size > 0) {
    const rows = await query<Record<string, unknown>>(
      `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori IN (${[...dyed].join(',')})`,
    )
    for (const r of await fixEncoding(rows, 'ref_fini_colori', 'IDref_fini_colori', ['reference'])) {
      dyedNames.set(numOf(r.IDref_fini_colori), (strOf(r.reference) ?? '').trim())
    }
  }
  if (washed.size > 0) {
    const rows = await query<Record<string, unknown>>(
      `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${[...washed].join(',')})`,
    )
    for (const r of await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference'])) {
      washedNames.set(numOf(r.IDcolori_ecru), (strOf(r.reference) ?? '').trim())
    }
  }
  return (l) => ((geo.get(l.IDreference)?.avec_teinture ?? 0) !== 0 ? dyedNames : washedNames).get(l.IDcolori) ?? ''
}

/** The best band among the molleton lines of the same coloris on this order,
 *  for a fini line on `IDref_fini` / `IDcolori`. null when the ref is nobody's
 *  associated ref for this client, or no parent line of that coloris is on the
 *  order. `IDligneExclue` = the line being priced itself (on an edit). */
export async function findPalierAssocie(p: {
  IDclient: number
  IDcommande_client: number
  IDligneExclue?: number
  IDref_fini: number
  IDcolori: number
}): Promise<PalierAssocie | null> {
  if (!(p.IDclient > 0) || !(p.IDcommande_client > 0) || !(p.IDref_fini > 0) || !(p.IDcolori > 0)) return null
  const assoc = await loadClientAssociations(p.IDclient)
  const parentRefs = new Set([...assoc].filter(([, kids]) => kids.has(p.IDref_fini)).map(([parent]) => parent))
  if (parentRefs.size === 0) return null

  // TYPE is a reserved word — written uppercase.
  const lines = (await query<{ IDligne_commande_client: number; IDreference: number; IDcolori: number; quantite: number | null; unite: number | null }>(
    `SELECT IDligne_commande_client, IDreference, IDcolori, quantite, unite FROM ligne_commande_client ` +
      `WHERE IDcommande_client = ${p.IDcommande_client} AND TYPE = 2`,
  )).map((l) => ({
    IDligne_commande_client: numOf(l.IDligne_commande_client),
    IDreference: numOf(l.IDreference),
    IDcolori: numOf(l.IDcolori),
    quantite: numOf(l.quantite),
    unite: numOf(l.unite),
  })).filter((l) => l.IDligne_commande_client !== (p.IDligneExclue ?? 0) && parentRefs.has(l.IDreference) && l.quantite > 0)
  if (lines.length === 0) return null

  const geo = await loadRefGeo([p.IDref_fini, ...lines.map((l) => l.IDreference)])
  const nameOf = await loadColorisNames([{ IDreference: p.IDref_fini, IDcolori: p.IDcolori }, ...lines], geo)
  const key = colorisKey(nameOf({ IDreference: p.IDref_fini, IDcolori: p.IDcolori }))
  if (!key) return null

  let best: PalierAssocie | null = null
  for (const l of lines) {
    const coloris = nameOf(l)
    if (colorisKey(coloris) !== key) continue
    const g = geo.get(l.IDreference)
    if (!g) continue
    const rollSize = rollSizeFor(l.unite, g.poids, g.rendement)
    if (!(rollSize > 0)) continue
    const { nRolls } = geom(l.quantite, rollSize)
    const trancheIdx = pickTrancheIndex(nRolls)
    if (!best || trancheIdx > best.trancheIdx) {
      best = {
        IDligne_commande_client: l.IDligne_commande_client,
        reference: g.reference,
        coloris,
        nRolls,
        trancheIdx,
        trancheRolls: trancheIdx === 0 ? 0 : ROLL_MULT[trancheIdx],
      }
    }
  }
  return best
}
