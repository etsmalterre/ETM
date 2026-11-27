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

// ── v4 (2026-10-30, from the v3 feedback) ────────────────
//
//   - BL 109368A printed 3546/11 at 19,80 m for 21,6 kg, its four sisters at
//     ~5 m/kg (~108 m). The OCR read it right: the dyer's typo went into the
//     pre-fill. A piece whose m/kg is less than half or more than 1,5 times the
//     median of its OF on the BL now blocks it. Over the 1 089 pieces of the
//     history this flags 2, both real errors (the other: 3560/16, 14 m for
//     20 kg on BL 109452A, its sisters at 37 and 41 m).
//   - The rectified BL MATEL sent the same morning (19,8 → 109,8 m) was told
//     « Envoyer en reprise »: its rolls were already received and no reprise
//     was open. The agent now compares the BL with the stock: nothing to do when
//     the stock already carries the BL's values; otherwise it names each
//     difference and the two gestures (rectified BL or reprise).

const fr = (v: number, dec = 1) => String(Math.round(v * 10 ** dec) / 10 ** dec).replace('.', ',')

export const ECART_RATIO_METRAGE = 0.5
const MIN_PIECES_OF = 3

export interface MetrageSuspect {
  numero: string
  poids: number
  metrage: number
  of: string
  /** Median m/kg of the other pieces of the OF on the BL. */
  ratioOf: number
  /** The métrage that median gives for this piece's weight. */
  attendu: number
}

const mediane = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Pieces whose métrage is out of proportion with their weight, against the
 *  other pieces of the same OF on the BL (at least 3 comparable). A merged roll,
 *  a cut piece (printed twice) and an unweighed piece are left out. */
export function metragesSuspects(
  pieces: ReadonlyArray<{ numero_piece: string; composants: readonly string[]; poids: number | null; metrage: number | null }>,
): MetrageSuspect[] {
  const fois = new Map<string, number>()
  for (const p of pieces) fois.set(p.numero_piece, (fois.get(p.numero_piece) ?? 0) + 1)
  const parOf = new Map<string, Array<{ numero: string; poids: number; metrage: number }>>()
  for (const p of pieces) {
    if (p.composants.length !== 1 || (fois.get(p.numero_piece) ?? 0) > 1) continue
    if (!p.poids || !p.metrage || p.poids <= 0 || p.metrage <= 0) continue
    const of = /^(\d+)\//.exec(p.composants[0])?.[1]
    if (!of) continue
    parOf.set(of, [...(parOf.get(of) ?? []), { numero: p.numero_piece, poids: p.poids, metrage: p.metrage }])
  }
  const out: MetrageSuspect[] = []
  for (const [of, ps] of parOf) {
    if (ps.length < MIN_PIECES_OF) continue
    const med = mediane(ps.map((p) => p.metrage / p.poids))
    for (const p of ps) {
      if (Math.abs(p.metrage / p.poids / med - 1) <= ECART_RATIO_METRAGE) continue
      const autres = mediane(ps.filter((x) => x !== p).map((x) => x.metrage / x.poids))
      out.push({ numero: p.numero, poids: p.poids, metrage: p.metrage, of, ratioOf: autres, attendu: Math.round(p.poids * autres) })
    }
  }
  return out
}

/** The blocking message for out-of-proportion métrages: what to do, the
 *  figures to ask the dyer about. */
export function messageMetragesSuspects(ss: readonly MetrageSuspect[]): string {
  const parts = ss.map((s) => `${s.numero} : ${fr(s.metrage)} m pour ${fr(s.poids)} kg, les autres pièces de l’OF ${s.of} font ${fr(s.ratioOf)} m/kg (environ ${s.attendu} m attendus)`)
  return `Métrage suspect, faute de frappe probable de l’ennoblisseur : ${parts.join(' ; ')}. Demandez-lui le bon métrage avant de réceptionner : il n’est jamais corrigé sans vous.`
}

/** A received roll's figure within this share of the BL's is the same figure
 *  (Malterre's own réception moves a métrage by ~0,5 %: 105,2 m → 104,8 m). */
export const TOLERANCE_RECU = 0.02

export interface Valeurs { poids: number | null; metrage: number | null }

export interface EcartRecu {
  numero: string
  champ: 'poids' | 'metrage'
  bl: number
  stock: number
}

/** Rolls already received (no reprise open) whose stock figures disagree with
 *  this BL. A figure counts as up to date when the stock is within
 *  TOLERANCE_RECU of the BL, or when the stock is closer to the BL than to the
 *  figure the previous BL of the lot gave (`avant`): somebody already moved it
 *  (3546/11: 19,8 on the first BL, 109,8 on the rectified one, 103,8 in stock).
 *  The weight is compared only for a dyer whose weight is written (MATEL). */
export function ecartsRecus(
  pieces: ReadonlyArray<{ numero_piece: string; composants: readonly string[]; poids: number | null; metrage: number | null }>,
  stock: ReadonlyMap<string, Valeurs>,
  avant: ReadonlyMap<string, Valeurs>,
  comparerPoids: boolean,
): EcartRecu[] {
  const out: EcartRecu[] = []
  const champs: Array<'poids' | 'metrage'> = comparerPoids ? ['poids', 'metrage'] : ['metrage']
  for (const p of pieces) {
    if (p.composants.length !== 1) continue
    const s = stock.get(p.composants[0])
    if (!s) continue
    for (const champ of champs) {
      const b = p[champ]
      const v = s[champ]
      if (b == null || b <= 0 || v == null || v <= 0) continue
      if (Math.abs(v - b) <= Math.max(0.05, TOLERANCE_RECU * b)) continue
      const a = avant.get(p.numero_piece)?.[champ]
      if (a != null && Math.abs(a - b) > 0.05 && Math.abs(v - b) < Math.abs(v - a)) continue
      out.push({ numero: p.numero_piece, champ, bl: b, stock: v })
    }
  }
  return out
}

/** The warning for received rolls the BL changes: each difference, and the
 *  gesture for each of the two cases. */
export function messageEcartsRecus(es: readonly EcartRecu[]): string {
  const unite = (e: EcartRecu) => (e.champ === 'poids' ? 'kg' : 'm')
  const parts = es.map((e) => `${e.numero} (BL ${fr(e.bl)} ${unite(e)}, en stock ${fr(e.stock)} ${unite(e)})`)
  return `Pièce(s) déjà réceptionnée(s) avec d’autres valeurs que ce BL : ${parts.join(', ')}. BL rectifié : « Corriger la réception » de ces pièces ; reprise : ouvrez-la sur le lot (Qualité › Suivi lots, « Reprendre ») avant de réceptionner.`
}

// ── v5 (2026-11-27, from the v4 feedback) ────────────────
//
//   - BL 109884A printed « Commande n° 91788 » (a typo at MATEL for 9172). The
//     agent stopped at « numéro illisible » and never looked at the pieces,
//     while its 15 pieces were all affected to the 9172. When the printed
//     number cannot be used (unreadable, unknown, another dyer's), the pieces
//     now say where the BL belongs: every piece on ONE order of this dyer =
//     that order, named and proposed, still left to a person. Anything less
//     (a piece elsewhere, unaffected or not in stock) is no guess: the agent
//     only says where the pieces are.
//   - Bontemps BL 3979 printed « Commande N°4501 », an order of another
//     subcontractor: the aide was hung on that stranger's order and told to
//     affect the pieces to it. A number that is not this dyer's is no longer
//     resolved against: the pieces speak, or nobody's order is touched.

/** Where one printed piece number was found. */
export interface PlacePiece {
  numero: string
  /** In the stock at all (an écru, or a roll already received). */
  trouve: boolean
  /** The sst orders of the lines it is affected to / was received on (none = affected to no order). */
  commandes: number[]
}

/** The order a BL belongs to, read from its pieces alone: the ONE order every
 *  printed piece is on, and only when it is an order of this dyer. A piece not
 *  in stock, affected to no order, or on another order = no answer. Pure. */
export function commandeDesPieces(places: readonly PlacePiece[], sstDe: ReadonlyMap<number, number>, idSousTraitant: number): number | null {
  if (places.length === 0) return null
  if (places.some((p) => !p.trouve || p.commandes.length === 0)) return null
  const communes = places.slice(1).reduce<number[]>((cs, p) => cs.filter((c) => p.commandes.includes(c)), [...new Set(places[0].commandes)])
  if (communes.length !== 1) return null
  return sstDe.get(communes[0]) === idSousTraitant ? communes[0] : null
}

/** The blocking message of a BL whose order was found by its pieces. */
export function messageCommandeProbable(nbPieces: number, commande: number, ennoblisseur: string): string {
  const quoi = nbPieces > 1 ? `Les ${nbPieces} pièces de ce BL sont toutes affectées` : 'La pièce de ce BL est affectée'
  return `${quoi} à la commande ${commande} (${ennoblisseur}) : c’est probablement la sienne. Vérifiez avant de réceptionner dessus.`
}

/** The blocking message of a BL whose printed order is a real one of the dyer,
 *  while every piece is on another (the dyer mixed two numbers up). */
export function messageMalNumerote(imprimee: number, nbPieces: number, commande: number, ennoblisseur: string): string {
  const quoi = nbPieces > 1 ? `ses ${nbPieces} pièces sont toutes affectées` : 'sa pièce est affectée'
  return `BL probablement mal numéroté : commande ${imprimee} imprimée, mais ${quoi} à la commande ${commande} (${ennoblisseur}). Vérifiez avant de réceptionner dessus.`
}

/** What the pieces say when they name no single order: where each one is. */
export function messagePiecesSansCommande(places: readonly PlacePiece[]): string {
  const absentes = places.filter((p) => !p.trouve).map((p) => p.numero)
  const libres = places.filter((p) => p.trouve && p.commandes.length === 0).map((p) => p.numero)
  const parCommande = new Map<number, string[]>()
  for (const p of places) for (const c of p.commandes) parCommande.set(c, [...(parCommande.get(c) ?? []), p.numero])
  const parts: string[] = []
  for (const [c, ns] of [...parCommande].sort((a, b) => a[0] - b[0])) parts.push(`${ns.join(', ')} → commande ${c}`)
  if (libres.length) parts.push(`${libres.join(', ')} : affectée${libres.length > 1 ? 's' : ''} à aucune commande`)
  if (absentes.length) parts.push(`${absentes.join(', ')} : introuvable${absentes.length > 1 ? 's' : ''} dans le stock`)
  return `Les pièces ne désignent pas une seule commande : ${parts.join(' ; ')}.`
}
