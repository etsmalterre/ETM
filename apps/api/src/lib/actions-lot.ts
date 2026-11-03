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
