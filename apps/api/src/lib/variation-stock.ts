// ── Estimation de la variation de stock (compte 603700) ───────────────────
//
// Le compte de résultat ne compte pas ce qu'on achète ou fabrique, mais ce
// qu'on CONSOMME. La variation de stock est la correction qui fait le passage :
// stock qui monte → une partie des coûts concerne des marchandises encore en
// magasin → à retirer des charges ; stock qui baisse → on a consommé du stock
// non encore chargé → à ajouter.
//
// ⚠️ L'ÉCRITURE EST ANNUELLE. Onze mois sur douze, le compte de résultat porte
// donc le coût complet de la production, y compris ce qui dort en magasin, et
// l'EBE intermédiaire est amputé d'autant. C'est ce qui a fait lire l'EBE de
// juillet 2026 (88 k€) comme un effondrement.
//
// CE MODULE PRODUIT UNE ESTIMATION, PAS UNE ÉCRITURE
//
// Elle ne s'applique QUE si la valeur comptabilisée est à zéro : le jour où
// l'expert-comptable passe l'écriture, le vrai chiffre reprend automatiquement
// la main et l'estimation disparaît. Rien à nettoyer, aucun risque d'écraser
// une écriture réelle.
//
// COMMENT L'ESTIMATION EST CONSTRUITE
//
//   niveau  : deux photos réelles du stock, prises par la méthode de
//             l'expert-comptable — le dernier arrêté `inventaire_compta` de
//             l'année N-1 (base) et la valorisation d'aujourd'hui
//             (`valoriserStock`). Le total est donc exact aux deux bouts.
//   forme   : les kilos physiques accumulés mois par mois (écru tombé de métier
//             produit moins écru et finis expédiés), normalisés pour que le
//             dernier mois retombe sur le total ci-dessus.
//
// Autrement dit la courbe suit l'activité réelle et ses deux extrémités sont
// justes ; les mois intermédiaires sont une répartition plausible, pas une
// mesure. C'est un outil de pilotage, assumé comme tel — décision Vincent,
// 2026-08-25. La seule façon de rendre les mois intermédiaires exacts est
// l'arrêté mensuel : dès qu'`inventaire_compta` reçoit un point par mois, cette
// interpolation n'a plus lieu d'être.
//
// ⚠️ La forme ignore les achats de fil (qui gonflent le stock sans passer par
// la production) et le passage écru → fini (qui ajoute de la valeur sans ajouter
// de kilos). Elle est donc un proxy d'activité, pas une reconstitution.

import { query } from './hfsql-auto.js'
import { n } from './sst-shared.js'
import { valoriserStockCache } from './valorisation-stock.js'

/** Le seul compte de variation de stock du plan comptable ERP. C'est une charge
 *  VARIABLE (`frais_variable = 1`), donc un montant négatif y remonte la marge
 *  brute et l'EBE. Historique : 81 083 € (2024), 59 092 € (2025), 0 € (2026). */
export const NUMERO_VARIATION_STOCK = 603700

export interface VariationStockEstimee {
  annee: number
  /** Valeur brute du stock au dernier arrêté de N-1. */
  base: number
  baseDate: string
  /** Valeur brute du stock aujourd'hui. */
  actuel: number
  /** Montant au sens du compte 603700 (`debit − credit`) : base − actuel.
   *  Négatif quand le stock monte — un crédit, qui allège les charges. */
  montant: number
  /** Montant cumulé estimé à la fin de chaque mois présent, même convention. */
  parMois: Record<number, number>
  /** Toujours vrai : ce module ne produit que des estimations. */
  estime: true
}

const d8 = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(0, 8)

/** Kilos physiquement accumulés (produits − expédiés) à la fin de chaque mois
 *  de `annee`, cumulés. Sert UNIQUEMENT de forme : les niveaux viennent des
 *  deux photos du stock. */
async function formeMensuelle(annee: number): Promise<{ cumul: Record<number, number>; dernier: number }> {
  const [ecru, fini, exps, lignes] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT poids, date_saisie, IDligne_expedition_ETM FROM stock_ecru WHERE IDsociete = 1`),
    query<Record<string, unknown>>(`SELECT poids, IDligne_expedition FROM stock_fini`),
    query<Record<string, unknown>>(`SELECT IDexpedition, DATE AS dexp FROM expedition`),
    query<Record<string, unknown>>(`SELECT IDligne_expedition, IDexpedition FROM ligne_expedition`),
  ])
  const dateExp = new Map<number, string>()
  for (const x of exps) dateExp.set(n(x.IDexpedition), d8(x.dexp))
  const dateLigne = new Map<number, string>()
  for (const l of lignes) {
    const d = dateExp.get(n(l.IDexpedition))
    if (d) dateLigne.set(n(l.IDligne_expedition), d)
  }

  const net: Record<number, number> = {}
  const bump = (date: string, kg: number) => {
    if (!date.startsWith(String(annee))) return
    const m = Number(date.slice(4, 6))
    if (m >= 1 && m <= 12) net[m] = (net[m] ?? 0) + kg
  }
  // entrées : tombé de métier produit
  for (const r of ecru) bump(d8(r.date_saisie), n(r.poids))
  // sorties : écru et rouleaux finis expédiés
  for (const r of ecru) {
    const d = dateLigne.get(n(r.IDligne_expedition_ETM))
    if (d) bump(d, -n(r.poids))
  }
  for (const r of fini) {
    const d = dateLigne.get(n(r.IDligne_expedition))
    if (d) bump(d, -n(r.poids))
  }

  const cumul: Record<number, number> = {}
  let acc = 0
  for (let m = 1; m <= 12; m++) { acc += net[m] ?? 0; cumul[m] = acc }
  // ⚠️ Dernier mois ACTIF, lu sur les mouvements et non sur le cumul : un cumul
  // reste non nul une fois qu'il a démarré, donc le chercher là-dedans renvoie
  // toujours décembre — et l'estimation s'étalait jusqu'à la fin d'une année en
  // cours, sur des mois qui n'ont pas encore eu lieu.
  let dernier = 0
  for (let m = 12; m >= 1; m--) { if ((net[m] ?? 0) !== 0) { dernier = m; break } }
  return { cumul, dernier }
}

/** Dernier arrêté `inventaire_compta` strictement antérieur à `annee`. */
async function baseDeLAnnee(annee: number): Promise<{ valeur: number; date: string } | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT DATE, prix_achat FROM inventaire_compta`)
  const parDate = new Map<string, number>()
  for (const r of rows) {
    const d = d8(r.DATE)
    if (!/^\d{8}$/.test(d)) continue
    parDate.set(d, (parDate.get(d) ?? 0) + n(r.prix_achat))
  }
  // ⚠️ La base doit être une CLÔTURE d'exercice, pas le dernier arrêté venu.
  // Sans ce garde-fou, une série qui s'arrête en juin ferait porter à l'année
  // suivante une « variation » de quatorze mois — un chiffre faux qui a l'air
  // juste. Mieux vaut ne rien estimer : l'écran montre alors le vrai zéro.
  const candidates = [...parDate.keys()]
    .filter((d) => Number(d.slice(0, 4)) === annee - 1 && d.slice(4) >= '1201')
    .sort()
  const date = candidates[candidates.length - 1]
  if (!date) return null
  return { valeur: parDate.get(date) as number, date }
}

/** Estime la variation de stock de `annee`, ou `null` si l'estimation n'a pas
 *  de sens : seule l'année EN COURS est estimable, puisque son point d'arrivée
 *  est la valorisation d'aujourd'hui. Une année révolue porte soit sa vraie
 *  écriture, soit rien. */
export async function estimerVariationStock(annee: number): Promise<VariationStockEstimee | null> {
  if (annee !== new Date().getFullYear()) return null

  const base = await baseDeLAnnee(annee)
  if (!base) return null

  const stock = await valoriserStockCache()
  const actuel = stock.total.brut
  if (actuel <= 0) return null

  const montant = base.valeur - actuel
  const { cumul: forme, dernier } = await formeMensuelle(annee)

  // Le dernier mois actif sert de dénominateur : son cumul vaut alors 1, donc
  // le point d'arrivée de l'estimation est exactement le montant réel.
  const denom = dernier > 0 ? forme[dernier] : 0

  const parMois: Record<number, number> = {}
  for (let m = 1; m <= 12; m++) {
    if (m > dernier) break
    // Sans forme exploitable (dénominateur nul, ou mouvement de signe opposé),
    // on retombe sur une répartition linéaire plutôt que sur des valeurs
    // aberrantes — une droite reste lisible, un rapport négatif non.
    const brut = denom !== 0 ? (forme[m] ?? 0) / denom : m / Math.max(dernier, 1)
    // Bornée à [0, 1] : une interpolation entre deux points connus ne peut pas
    // les dépasser. La forme brute le fait volontiers — elle ignore les achats
    // de fil et la valeur ajoutée au passage écru → fini, donc son pic peut
    // excéder de moitié le point d'arrivée réel (mesuré sur la copie dev :
    // −178 538 € au mois 2 pour un total de −114 556 €). Le profil suit toujours
    // l'activité à l'intérieur de ces bornes.
    const part = Number.isFinite(brut) ? Math.min(1, Math.max(0, brut)) : 0
    parMois[m] = montant * part
  }

  return { annee, base: base.valeur, baseDate: base.date, actuel, montant, parMois, estime: true }
}
