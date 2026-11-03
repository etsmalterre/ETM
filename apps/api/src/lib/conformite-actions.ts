// Qualité › Actions › Conformité: what an action's mentions were judged on.
//
// A DYE line is judged per lot (lib/conformite-lot.ts, decision Vincent
// 2026-11-03): one row per received lot of the line since the action was set up,
// plus any older lot already judged under it. A KNITTING line has no lot yet: it
// keeps its legacy per-line verdict (conformite_action) until the way to judge it
// is decided.

import {
  loadConformites,
  loadLinesForMentions,
  mentionsForLine,
  type Conformite,
  type MentionRow,
} from './actions-qualite.js'
import { indexVerdicts, lotsDesLignes, verdictsDesLots } from './conformite-lot.js'

/** ligne_commande_sous_traitant.type of a dye line. */
const TYPE_ENNOBLISSEUR = 2

export interface RangConformite {
  IDaction_qualite: number
  IDmention_qualite: number
  IDcommande_sous_traitant: number
  IDligne_commande_sous_traitant: number
  IDsous_traitant: number
  /** The lot judged; null on a knitting line (judged per line). */
  IDsuivilot: number | null
  lot: string | null
  reception: string | null
  /** 'non_controle' = à juger. 'aucun' only on a legacy knitting verdict. */
  conformite: Conformite
  par: string | null
  le: string | null
}

/** 'YYYYMMDD' or 'YYYY-MM-DD…' → 'YYYY-MM-DD' ('' when unknown). */
function jour(d: string): string {
  const m = String(d ?? '').match(/^(\d{4})-?(\d{2})-?(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

/** Every row the given mentions were (or are to be) judged on.
 *  `creees`: action id → its creation date (lots received before it are left
 *  out unless already judged). */
export async function conformitesDesMentions(
  mentions: MentionRow[],
  creees: Map<number, string>,
): Promise<RangConformite[]> {
  if (mentions.length === 0) return []
  const lines = await loadLinesForMentions(mentions)
  const pairs = lines.flatMap((line) => mentionsForLine(line, mentions).map((m) => ({ line, m })))
  if (pairs.length === 0) return []

  const ligneIdsEnno = [...new Set(pairs.filter((p) => p.line.type_kind === TYPE_ENNOBLISSEUR).map((p) => p.line.IDligne_commande_sous_traitant))]
  const lots = await lotsDesLignes(ligneIdsEnno)
  const lotsParLigne = new Map<number, typeof lots>()
  for (const l of lots) lotsParLigne.set(l.ligne, [...(lotsParLigne.get(l.ligne) ?? []), l])
  const verdicts = indexVerdicts(await verdictsDesLots(lots.map((l) => l.idsuivilot)))

  const ligneIdsTricot = [...new Set(pairs.filter((p) => p.line.type_kind !== TYPE_ENNOBLISSEUR).map((p) => p.line.IDligne_commande_sous_traitant))]
  const anciens = ligneIdsTricot.length > 0 ? await loadConformites({ ligneIds: ligneIdsTricot }) : []
  const ancienParPaire = new Map(anciens.map((c) => [`${c.IDligne_commande_sous_traitant}:${c.IDmention_qualite}`, c.conformite]))

  const out: RangConformite[] = []
  for (const { line, m } of pairs) {
    const base = {
      IDaction_qualite: m.IDaction_qualite,
      IDmention_qualite: m.IDmention_qualite,
      IDcommande_sous_traitant: line.IDcommande_sous_traitant,
      IDligne_commande_sous_traitant: line.IDligne_commande_sous_traitant,
      IDsous_traitant: line.IDsous_traitant,
    }
    if (line.type_kind !== TYPE_ENNOBLISSEUR) {
      out.push({
        ...base, IDsuivilot: null, lot: null, reception: null,
        conformite: ancienParPaire.get(`${line.IDligne_commande_sous_traitant}:${m.IDmention_qualite}`) ?? 'non_controle',
        par: null, le: null,
      })
      continue
    }
    const depuis = jour(creees.get(m.IDaction_qualite) ?? '')
    for (const l of lotsParLigne.get(line.IDligne_commande_sous_traitant) ?? []) {
      const v = verdicts.get(`${l.idsuivilot}:${m.IDmention_qualite}`)
      // Not received yet: judged once it is. Received before the action: it was
      // never asked, unless someone judged it anyway.
      if (!v && (!l.reception || (depuis && l.reception < depuis))) continue
      out.push({
        ...base, IDsuivilot: l.idsuivilot, lot: l.lot, reception: l.reception,
        conformite: v?.conformite ?? 'non_controle', par: v?.par ?? null, le: v?.le ?? null,
      })
    }
  }
  return out
}
