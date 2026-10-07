// Supply lead time of a yarn coloris, measured from its past orders
// (Fils › Références › Stock & conso, 2026-10-07).
//
// ── Data ──
// An order line (`ref_fil_commande`) carries the order date (header
// `commande_fil.date_commande`), the date the supplier PROMISED
// (`date_livraison`) and, through `stock_fil.idref_fil_commande`, the lots it
// delivered (`date_entree`). ~90 % of lines since 2022 have their lots linked.
//
// ── Rules ──
// - A lot dated BEFORE its order (48 of 583 lines) is an order typed in after
//   the fact: the line is left out of every figure.
// - Staggered deliveries: Massebeuf orders are typically 2 × 800 kg on one
//   order, the second promised 6–9 months later. That far date is what WE
//   asked for, not the supplier's lead time — so the MEASURED lead time uses
//   only the FIRST line of each order (earliest promise), from order date to
//   its first lot. Punctuality (received vs promised) uses every line.
// - Median over the last MESURE_COMMANDES orders, so an old habit fades out.
// - « À l'heure » = first lot at most TOLERANCE_JOURS after the promise.

export const MESURE_COMMANDES = 6
export const TOLERANCE_JOURS = 3
/** Lines returned for the chart, most recent first. */
export const LIGNES_GRAPHE = 8

export interface LigneAppro {
  idref_fil_commande: number
  idcommande_fil: number
  fournisseur: string | null
  /** 'YYYY-MM-DD' */
  date_commande: string
  date_promise: string | null
  premiere_reception: string | null
  derniere_reception: string | null
  quantite: number
  recu_kg: number
  /** Order line still open (etat = 0). */
  ouverte: boolean
}

export interface LigneEnCours extends LigneAppro {
  /** Still to receive: ordered − already received (never below 0). */
  reste_kg: number
  /** Promise passed and not fully received (TOLERANCE_JOURS). */
  en_retard: boolean
  retard_jours: number | null
}

export interface AnalyseAppro {
  /** EVERY open line with something still to receive, expected date first
   *  (no promise last) — what the physical-stock projection steps up on. */
  en_cours: LigneEnCours[]
  /** Last lines, most recent order first — for the chart. */
  /** retard_jours: received − promised; for a line still awaited past its
   *  promise, today − promised (and en_retard = true). */
  lignes: (LigneAppro & { delai_jours: number | null; retard_jours: number | null; en_retard: boolean })[]
  /** Median days, order → first lot, first line of each of the last orders. */
  delai_mesure_jours: number | null
  delai_min_jours: number | null
  delai_max_jours: number | null
  nb_commandes_mesurees: number
  /** Median days, order → promised date (same lines). */
  delai_annonce_jours: number | null
  /** Delivered lines with a promise, compared to it. */
  nb_comparees: number
  a_l_heure: number
  /** Average lateness (days) of the late ones. */
  retard_moyen_jours: number | null
}

function days(a: string, b: string): number {
  const pa = a.split('-').map(Number)
  const pb = b.split('-').map(Number)
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86_400_000)
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

/** Pure — pinned by fil-appro.test.ts. */
export function analyserAppro(lignes: LigneAppro[], aujourdhui: string): AnalyseAppro {
  // Typed-in-after-the-fact lines are noise everywhere.
  const valides = lignes.filter((l) => !l.premiere_reception || days(l.date_commande, l.premiere_reception) >= 0)
  const recent = [...valides].sort((a, b) =>
    b.date_commande.localeCompare(a.date_commande) || (a.date_promise ?? '').localeCompare(b.date_promise ?? ''))

  // First line (earliest promise) of each order, delivered.
  const parCommande = new Map<number, LigneAppro>()
  for (const l of recent) {
    const cur = parCommande.get(l.idcommande_fil)
    if (!cur || (l.date_promise ?? '9999') < (cur.date_promise ?? '9999')) parCommande.set(l.idcommande_fil, l)
  }
  const premieres = [...parCommande.values()]
    .filter((l) => l.premiere_reception)
    .sort((a, b) => b.date_commande.localeCompare(a.date_commande))
    .slice(0, MESURE_COMMANDES)
  const delais = premieres.map((l) => days(l.date_commande, l.premiere_reception!))
  const annonces = premieres.filter((l) => l.date_promise).map((l) => days(l.date_commande, l.date_promise!)).filter((d) => d >= 0)

  const comparees = recent.filter((l) => l.premiere_reception && l.date_promise)
  const retards = comparees.map((l) => days(l.date_promise!, l.premiere_reception!))
  const enRetard = retards.filter((r) => r > TOLERANCE_JOURS)

  const enCours: LigneEnCours[] = valides
    .filter((l) => l.ouverte && l.quantite - l.recu_kg > 0)
    .map((l) => {
      const retard = l.date_promise ? Math.max(0, days(l.date_promise, aujourdhui)) : null
      return { ...l, reste_kg: l.quantite - l.recu_kg, retard_jours: retard, en_retard: retard != null && retard > TOLERANCE_JOURS }
    })
    .sort((a, b) => (a.date_promise ?? '9999').localeCompare(b.date_promise ?? '9999'))

  return {
    en_cours: enCours,
    lignes: recent.slice(0, LIGNES_GRAPHE).map((l) => {
      const retard = l.premiere_reception
        ? (l.date_promise ? days(l.date_promise, l.premiere_reception) : null)
        : (l.ouverte && l.date_promise ? Math.max(0, days(l.date_promise, aujourdhui)) : null)
      return {
        ...l,
        delai_jours: l.premiere_reception ? days(l.date_commande, l.premiere_reception) : null,
        retard_jours: retard,
        en_retard: retard != null && retard > TOLERANCE_JOURS,
      }
    }),
    delai_mesure_jours: median(delais),
    delai_min_jours: delais.length ? Math.min(...delais) : null,
    delai_max_jours: delais.length ? Math.max(...delais) : null,
    nb_commandes_mesurees: delais.length,
    delai_annonce_jours: median(annonces),
    nb_comparees: comparees.length,
    a_l_heure: comparees.length - enRetard.length,
    retard_moyen_jours: enRetard.length ? Math.round(enRetard.reduce((s, r) => s + r, 0) / enRetard.length) : null,
  }
}
