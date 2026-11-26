// Qualité › Actions on a dye lot (decision Vincent 2026-11-03): an OPEN action
// whose mention applies to the lot's sst line must be judged ON THAT LOT by a
// person (Conforme / Non conforme) before « Valider le lot ». Never computed: the
// « vérifiée par le vrillage » option (#1332) that judged it from the measures
// was removed the same day. Verdicts per lot: lib/conformite-lot.ts.
//
// Kept apart from lib/actions-qualite.ts on purpose: that file holds raw bytes
// (legacy Latin-1 literals) that the editing tools refuse to touch.

import { query } from './hfsql-auto.js'
import { loadActions, loadAllMentions, mentionsForLine, type SstLineKey } from './actions-qualite.js'
import { indexVerdicts, verdictsDesLots } from './conformite-lot.js'

/** Per lot: the titles of the open actions still waiting for its verdict. */
export async function actionsSansVerdict(lots: Array<{ idsuivilot: number; ligne: number }>): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>()
  const ids = [...new Set(lots.map((l) => Math.trunc(l.ligne)).filter((x) => x > 0))]
  if (ids.length === 0) return out
  const [actions, mentions] = await Promise.all([loadActions(), loadAllMentions()])
  const ouvertes = new Map(actions.filter((a) => a.termine === 0).map((a) => [a.IDaction_qualite, a]))
  const enCours = mentions.filter((m) => ouvertes.has(m.IDaction_qualite))
  if (enCours.length === 0) return out

  // `type` is a reserved word: always aliased.
  const rows = await query<{ lid: number; cid: number; type_kind: number; refid: number; colid: number; sstid: number }>(
    `SELECT lcs.IDligne_commande_sous_traitant AS lid, lcs.IDcommande_sous_traitant AS cid,
            lcs.type AS type_kind, lcs.IDreference AS refid, lcs.IDColoris AS colid,
            cs.IDsous_traitant AS sstid
     FROM ligne_commande_sous_traitant lcs
     LEFT JOIN commande_sous_traitant cs ON cs.IDcommande_sous_traitant = lcs.IDcommande_sous_traitant
     WHERE lcs.IDligne_commande_sous_traitant IN (${ids.join(',')})`,
  )
  const verdict = indexVerdicts(await verdictsDesLots(lots.map((l) => l.idsuivilot)))
  const titresParLigne = new Map<number, Array<{ idmention: number; titre: string }>>()
  for (const r of rows) {
    const line: SstLineKey = {
      IDligne_commande_sous_traitant: Number(r.lid) || 0,
      IDcommande_sous_traitant: Number(r.cid) || 0,
      type_kind: Number(r.type_kind) || 0,
      IDreference: Number(r.refid) || 0,
      IDColoris: Number(r.colid) || 0,
      IDsous_traitant: Number(r.sstid) || 0,
    }
    titresParLigne.set(line.IDligne_commande_sous_traitant, mentionsForLine(line, enCours).map((m) => ({
      idmention: m.IDmention_qualite,
      titre: ouvertes.get(m.IDaction_qualite)?.titre.trim() || `Action N° ${m.IDaction_qualite}`,
    })))
  }
  for (const l of lots) {
    const titres = new Set<string>()
    for (const m of titresParLigne.get(Math.trunc(l.ligne)) ?? []) {
      if (!verdict.has(`${l.idsuivilot}:${m.idmention}`)) titres.add(m.titre)
    }
    if (titres.size > 0) out.set(l.idsuivilot, [...titres])
  }
  return out
}

/** The « Avant validation » line for those actions, short (Vincent 2026-11-03). */
export function prealableActions(titres: string[]): string | null {
  if (titres.length === 0) return null
  return `${titres.length > 1 ? 'Actions à juger' : 'Action à juger'} : ${titres.map((t) => `« ${t} »`).join(', ')}`
}

/** One mention (« commentaire automatique ») a lot is judged against, with this lot's verdict. */
export interface ActionDuLot {
  IDmention_qualite: number
  IDaction_qualite: number
  action_titre: string
  action_description: string
  action_termine: number
  mention: string
  /** null = à juger. */
  conformite: 'conforme' | 'non_conforme' | null
  par: string | null
  le: string | null
  /** false ⇒ listed only because a verdict already exists (action closed, or the line no longer matches). */
  applicable: boolean
}

/** The actions a lot carries (Qualité › Suivi lots, « Actions qualité »; the espace partenaire reads the mention
 *  and the verdict of each): the mentions of OPEN actions that match its sst line, plus any mention the lot
 *  already carries a verdict for — closing an action must not make the verdicts recorded under it vanish from
 *  the lot. The verdict is THIS lot's (lib/conformite-lot.ts, Vincent 2026-11-03). Null = no such lot. */
export async function actionsDuLot(idsuivilot: number): Promise<ActionDuLot[] | null> {
  const id = Math.trunc(idsuivilot)
  const baseRows = await query<{ IDligne_commande_sous_traitant: number | null; IDcommande_sous_traitant: number | null; IDsous_traitant: number | null }>(
    `SELECT IDligne_commande_sous_traitant, IDcommande_sous_traitant, IDsous_traitant
     FROM suivilot WHERE IDsuivilot = ${id}`,
  )
  if (baseRows.length === 0) return null
  const ligneId = Number(baseRows[0].IDligne_commande_sous_traitant) || 0
  if (ligneId === 0) return []
  // The line's own matching key. `type` is a reserved word → always aliased.
  const lineRows = await query<{ type_kind: number; refid: number; colid: number }>(
    `SELECT type AS type_kind, IDreference AS refid, IDColoris AS colid
     FROM ligne_commande_sous_traitant
     WHERE IDligne_commande_sous_traitant = ${ligneId}`,
  )
  if (lineRows.length === 0) return []
  const line: SstLineKey = {
    IDligne_commande_sous_traitant: ligneId,
    IDcommande_sous_traitant: Number(baseRows[0].IDcommande_sous_traitant) || 0,
    type_kind: Number(lineRows[0].type_kind) || 0,
    IDreference: Number(lineRows[0].refid) || 0,
    IDColoris: Number(lineRows[0].colid) || 0,
    IDsous_traitant: Number(baseRows[0].IDsous_traitant) || 0,
  }
  const [allMentions, actions, verdicts] = await Promise.all([loadAllMentions(), loadActions(), verdictsDesLots([id])])
  const actionById = new Map(actions.map((a) => [a.IDaction_qualite, a]))
  const verdictByMention = new Map(verdicts.map((v) => [v.idmention, v]))
  const openMatches = mentionsForLine(line, allMentions.filter((m) => actionById.get(m.IDaction_qualite)?.termine === 0))
  const seen = new Set(openMatches.map((m) => m.IDmention_qualite))
  const historic = allMentions.filter((m) => !seen.has(m.IDmention_qualite) && verdictByMention.has(m.IDmention_qualite))
  return [...openMatches, ...historic].map((m) => {
    const action = actionById.get(m.IDaction_qualite)
    const v = verdictByMention.get(m.IDmention_qualite)
    return {
      IDmention_qualite: m.IDmention_qualite,
      IDaction_qualite: m.IDaction_qualite,
      action_titre: action?.titre ?? '',
      action_description: action?.description ?? '',
      action_termine: action?.termine ?? 0,
      mention: m.mention,
      conformite: v?.conformite ?? null,
      par: v?.par ?? null,
      le: v?.le ?? null,
      applicable: seen.has(m.IDmention_qualite),
    }
  })
}
