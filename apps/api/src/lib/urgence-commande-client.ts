// Clients › Commandes: what there is to do on an open order, and when (ETM).
//
// Doctrine (Vincent, 2026-10-08): rouge = something to do NOW, ambre = something to do very soon,
// neutral otherwise, including while someone else acts in time (TRM knitting, the dyer dyeing).
// The order takes the colour of its most urgent line: the line's computed status
// (lib/statut-ligne-client.ts) crossed with its délai (ligne_commande_client.date_livraison).
//
// Thresholds measured on mps_dev, 1 905 écru/fini lines ordered since 2024 (p50 / p80):
//   fini   launch → first roll ready: 25 / 36 j on écru stock, 35 / 50 j with knitting;
//          the office launches 39–51 j before the délai (median)            → rouge ≤ 35 j, ambre ≤ 56 j
//   écru   knitting → piece: 4 / 10 j (24 lines only)                         → rouge ≤ 10 j, ambre ≤ 21 j
//   ready  shipped 3–9 j before the délai (median)                           → rouge ≤ 3 j,  ambre ≤ 10 j
// `screen_notes.md` § 3 « Urgence des commandes ».
//
// The card says two things, never mixed: the liseré + reason = what there is to do and when
// (urgenceCommande), the pill = where the order stands (avancementCommande).

import type { EtatLigneClient } from './statut-ligne-client.js'

export const SEUILS_URGENCE = {
  finiRouge: 35,
  finiAmbre: 56,
  ecruRouge: 10,
  ecruAmbre: 21,
  expedierRouge: 3,
  expedierAmbre: 10,
  /** a ready line this far past its délai is probably a remainder nobody will take */
  soldeApres: 60,
} as const

export type NiveauUrgence = 'rouge' | 'ambre'

export interface UrgenceCommande {
  niveau: NiveauUrgence
  /** French, shown on the card: « 2 lignes à lancer · délai 14/10 » */
  raison: string
}

export interface LigneUrgence {
  etat: EtatLigneClient
  /** ligne_commande_client.TYPE: 1 écru, 2 fini, 3 divers */
  typeKind: number
  /** YYYYMMDD, or anything else for « no délai » */
  dateLivraison: string | null
}

type Action = 'lancer' | 'expedier' | 'solder' | 'tricotage' | 'ennoblisseur' | 'sans_delai'

interface Verdict { niveau: NiveauUrgence; action: Action; jours: number | null; date: string | null }

const RANG: Record<NiveauUrgence, number> = { rouge: 2, ambre: 1 }

function joursAvant(date: string, today: Date): number {
  const t = new Date(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8))
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((t.getTime() - d.getTime()) / 86_400_000)
}

/** One line's verdict, null when there is nothing to do on our side. */
export function urgenceLigne(l: LigneUrgence, today: Date): Verdict | null {
  if (l.etat === 'soldee' || l.etat === 'expediee') return null
  const date = l.dateLivraison && /^\d{8}$/.test(l.dateLivraison) ? l.dateLivraison : null
  // A line still to deliver without a délai can never light up on its own: ask for one.
  if (!date) return { niveau: 'ambre', action: 'sans_delai', jours: null, date: null }
  const j = joursAvant(date, today)
  const S = SEUILS_URGENCE
  const palier = (action: Action, rouge: number, ambre: number): Verdict | null =>
    j <= rouge ? { niveau: 'rouge', action, jours: j, date } : j <= ambre ? { niveau: 'ambre', action, jours: j, date } : null

  // Divers lines carry no production: « à lancer » means « not shipped yet ».
  if (l.etat === 'pae' || (l.etat === 'a_lancer' && l.typeKind === 3)) {
    if (j < -S.soldeApres) return { niveau: 'rouge', action: 'solder', jours: j, date }
    return palier('expedier', S.expedierRouge, S.expedierAmbre)
  }
  if (l.etat === 'a_lancer') {
    return l.typeKind === 1 ? palier('lancer', S.ecruRouge, S.ecruAmbre) : palier('lancer', S.finiRouge, S.finiAmbre)
  }
  // tricotage / ennoblisseur: someone else acts; only a passed délai is ours to chase.
  return j < 0 ? { niveau: 'rouge', action: l.etat, jours: j, date } : null
}

const LIBELLE: Record<Action, [string, string]> = {
  lancer: ['ligne à lancer', 'lignes à lancer'],
  expedier: ['ligne à expédier', 'lignes à expédier'],
  solder: ['ligne à expédier ou solder', 'lignes à expédier ou solder'],
  tricotage: ['ligne en tricotage en retard', 'lignes en tricotage en retard'],
  ennoblisseur: ['ligne en retard chez l’ennoblisseur', 'lignes en retard chez l’ennoblisseur'],
  sans_delai: ['ligne sans délai', 'lignes sans délai'],
}

const jjmm = (d: string) => `${d.slice(6, 8)}/${d.slice(4, 6)}`

/** The order's colour = its most urgent line; the reason names that line's action, how many lines
 *  share it at any level (3900: 3 lines due 06/11 + 3 due 27/11 are launched together, « 6 lignes
 *  à lancer »), and the most urgent délai. Null = neutral. */
export function urgenceCommande(lignes: readonly LigneUrgence[], today: Date): UrgenceCommande | null {
  const verdicts = lignes.map((l) => urgenceLigne(l, today)).filter((v): v is Verdict => v !== null)
  if (verdicts.length === 0) return null
  // Most urgent first: level, then earliest délai (no délai last within a level).
  const cle = (v: Verdict) => -RANG[v.niveau] * 1e6 + (v.jours ?? 1e5)
  verdicts.sort((a, b) => cle(a) - cle(b))
  const top = verdicts[0]
  const memes = verdicts.filter((v) => v.action === top.action)
  const [un, plusieurs] = LIBELLE[top.action]
  const n = memes.length
  let raison = `${n} ${n > 1 ? plusieurs : un}`
  if (top.date) raison += ` · délai ${jjmm(top.date)}${top.jours! < 0 ? ' dépassé' : ''}`
  return { niveau: top.niveau, raison }
}

/** Most advanced last. */
const ECHELLE: readonly EtatLigneClient[] = ['a_lancer', 'tricotage', 'ennoblisseur', 'pae', 'expediee', 'soldee']

/** Where an order stands, on the line pills' own scale: its least advanced line still to deliver
 *  (that line holds the order back); « expediee » once every line left; « soldee » when closed.
 *  Null for an open order without lines (a donation attaches pieces, not lines). */
export function avancementCommande(etats: readonly EtatLigneClient[], soldee: boolean): EtatLigneClient | null {
  if (soldee) return 'soldee'
  if (etats.length === 0) return null
  const restants = etats.filter((e) => e !== 'expediee' && e !== 'soldee')
  if (restants.length === 0) return 'expediee'
  return restants.reduce((a, b) => (ECHELLE.indexOf(b) < ECHELLE.indexOf(a) ? b : a))
}
