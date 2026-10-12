// Agent « BL Ennoblisseur » — v3 diagnostics (2026-10-12): what the agent tells
// the person when a BL cannot be written. Pure (no I/O; tests:
// bl-diagnostics.test.ts). Every rule here only EXPLAINS a blocked BL — none of
// them lets a BL through or changes what is written (decision Vincent: the
// human gets the answer under his eyes, never an automatic switch).
//
// Cases from the v2 feedback:
//   - BL 109401A prints « Commande n° 9045 », its 12 pieces are all on 9040
//     (two orders dyed the same day): « BL probablement mal numéroté ».
//   - BL 109402A prints « Commande n° 9040+9045 » (one lot, two orders): the
//     agent says which piece goes to which order; réception by hand (4 such
//     lots in the last ~1 300 orders — not worth an automatic split).
//   - BL 109400A prints 3570/50 and 3570/51, which do not exist; the order
//     carries 3572/50 and 3572/51 (typo at MATEL): the agent names them.
//   - 3560/3 was « affectée à une autre commande » while it was affected to
//     none: the two cases are told apart, and the other order is named.

/** The order numbers printed on a BL: « 9040 » → [9040], « 9040+9045 » →
 *  [9040, 9045]. null when it is neither (unreadable). */
export function commandesImprimees(numero: string): number[] | null {
  const t = (numero ?? '').replace(/\s/g, '')
  if (!/^\d{4,6}(\+\d{4,6})*$/.test(t)) return null
  return [...new Set(t.split('+').map((n) => parseInt(n, 10)))]
}

/** Two piece numbers one typo apart: same piece suffix (« /50 »), OF numbers
 *  of the same length differing by exactly one character (3570/50 ↔ 3572/50). */
export function aUnCaractereDe(a: string, b: string): boolean {
  const ma = /^(\d+)\/(.+)$/.exec(a.trim())
  const mb = /^(\d+)\/(.+)$/.exec(b.trim())
  if (!ma || !mb || ma[2] !== mb[2] || ma[1].length !== mb[1].length) return false
  let diff = 0
  for (let i = 0; i < ma[1].length; i++) if (ma[1][i] !== mb[1][i]) diff++
  return diff === 1
}

/** A dyed roll weighs about its écru (MATEL's BL weight vs our écru weight:
 *  a few % either way). 0 / unknown on either side = not comparable, accepted. */
export const TOLERANCE_POIDS = 0.15
export function poidsCoherent(poidsBl: number | null, poidsEcru: number | null): boolean {
  if (!poidsBl || !poidsEcru || poidsBl <= 0 || poidsEcru <= 0) return true
  return Math.abs(poidsBl - poidsEcru) / poidsEcru <= TOLERANCE_POIDS
}

export interface EcruCandidat { numero: string; poids: number | null }

/** The écru a misprinted number most probably means: among the order's écrus
 *  still awaited and not printed elsewhere on the BL, the ONLY one a typo
 *  away with a coherent weight. Two candidates = no guess. */
export function candidatProbable(numero: string, poidsBl: number | null, candidats: readonly EcruCandidat[]): EcruCandidat | null {
  const ok = candidats.filter((c) => aUnCaractereDe(numero, c.numero) && poidsCoherent(poidsBl, c.poids))
  return ok.length === 1 ? ok[0] : null
}

const kg = (v: number | null) => (v && v > 0 ? `, ${String(Math.round(v * 10) / 10).replace('.', ',')} kg` : '')

/** « Pièce(s) introuvable(s) » message, with the probable écru for each piece
 *  that has one. */
export function messageIntrouvables(inconnues: ReadonlyArray<{ numero: string; probable: EcruCandidat | null }>, commande: number | null): string {
  const parts = inconnues.map((p) =>
    p.probable
      ? `${p.numero} (probablement ${p.probable.numero} : affectée à ${commande ? `la commande ${commande}` : 'cette commande'}, pas encore reçue${kg(p.probable.poids)})`
      : p.numero,
  )
  const n = inconnues.length > 1 ? 's' : ''
  const fin = inconnues.some((p) => p.probable) ? ' Vérifiez le BL avec l’ennoblisseur : le numéro n’est jamais remplacé sans vous.' : ''
  return `Pièce${n} introuvable${n} dans le stock : ${parts.join(', ')}.${fin}`
}

/** Where the pieces not on the printed order were found. */
export interface PieceAilleurs {
  numero: string
  /** The other order and line, or 0 when the écru is affected to no order. */
  commande: number
  ligne: number
}

/** One sst order line, as far as « the same article » goes. */
export interface ArticleLigne { ligne: number; commande: number; idSousTraitant: number; reference: number; coloris: number }

/** Order numbers in a readable list: « 9040 », « 9040 et 9045 », « 9040, 9041 et 9045 ». */
export function listeCommandes(ns: readonly number[]): string {
  const s = [...new Set(ns)].sort((a, b) => a - b).map(String)
  return s.length <= 1 ? (s[0] ?? '') : `${s.slice(0, -1).join(', ')} et ${s[s.length - 1]}`
}

/** The two blocking messages for pieces off the printed order: affected to no
 *  order at all, and affected to another order (named). When EVERY piece of
 *  the BL is on one single other order of the same dyer, same article, the BL
 *  was probably misnumbered — said as the probable cause, still blocking. */
export function controlesAilleurs(
  ailleurs: readonly PieceAilleurs[],
  totalPieces: number,
  commandeImprimee: number,
  articles: { imprimee: readonly ArticleLigne[]; autres: readonly ArticleLigne[] },
): Array<{ code: string; message: string }> {
  const out: Array<{ code: string; message: string }> = []
  const sans = ailleurs.filter((p) => p.commande === 0).map((p) => p.numero)
  const autres = ailleurs.filter((p) => p.commande > 0)
  if (sans.length) {
    const n = sans.length > 1 ? 's' : ''
    out.push({
      code: 'pieces_non_affectees',
      message: `Pièce${n} non affectée${n} à la commande ${commandeImprimee} (ni à aucune autre) : ${sans.join(', ')} — affectez-${n ? 'les' : 'la'} avant la réception.`,
    })
  }
  if (autres.length) {
    const cmds = [...new Set(autres.map((p) => p.commande))]
    const parCmd = cmds.map((c) => `${autres.filter((p) => p.commande === c).map((p) => p.numero).join(', ')} → commande ${c}`).join(' ; ')
    let message = `Pièce(s) affectée(s) à une autre commande : ${parCmd}.`
    const autre = articles.autres.filter((a) => a.commande === cmds[0])
    const imprimee = articles.imprimee
    const memeArticle = cmds.length === 1 && autres.length === totalPieces && imprimee.length > 0 && autre.length > 0 &&
      autre.every((a) => a.idSousTraitant === imprimee[0].idSousTraitant) &&
      autre.some((a) => imprimee.some((b) => a.reference === b.reference && a.coloris === b.coloris))
    if (memeArticle) {
      message = `BL probablement mal numéroté : commande ${commandeImprimee} imprimée, mais ses ${totalPieces} pièce(s) sont toutes sur la commande ${cmds[0]} (même ennoblisseur, même référence, même coloris). Vérifiez avec l’ennoblisseur avant de réceptionner sur la ${cmds[0]}.`
    }
    out.push({ code: 'pieces_autre_ligne', message })
  }
  return out
}

/** A BL common to several orders (« 9040+9045 »): which piece goes where.
 *  Réception stays by hand, order by order, under the SAME lot. */
export function messagePlusieursCommandes(commandes: readonly number[], repartition: ReadonlyArray<{ commande: number; pieces: string[] }>, lot: string): string {
  const parts = repartition.filter((r) => r.pieces.length).map((r) => `${r.pieces.length} pièce${r.pieces.length > 1 ? 's' : ''} sur la ${r.commande} (${r.pieces.join(', ')})`)
  return `BL commun aux commandes ${listeCommandes(commandes)} : ${parts.join(' ; ')}. À réceptionner à la main, commande par commande${lot ? `, avec le même lot ${lot}` : ''}.`
}
