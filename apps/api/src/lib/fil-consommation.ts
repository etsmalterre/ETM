// Yarn consumption per coloris and what it means for the minimum stock
// (Fils › Références › « Stock & conso », 2026-10-07).
//
// ── Where consumption comes from ──
// No table records yarn movements. Consumption is rebuilt from what TRM
// KNITTED: every écru piece weighed at visitage (`stock_ecru.poids`, dated by
// `date_saisie`) × the share of the yarn in its OF (`asso_fil_of.pourcentage`).
// That is exactly what visitage decrements from `stock_fil.stock`.
// Measured on the dev copy (2026-10-07), over 24 months:
//   - knitted × share = 306 t, lot depletion (stock_initial − stock) = 299 t
//     → the two agree within 2.5 %;
//   - yarn reserved on EXTERNAL tricoteur lines = 500 kg → negligible, ignored.
// Lot depletion itself is NOT usable per month: it has no date per movement,
// and stock_initial is unreliable (lot 10555: 189 kg initial, 750 kg in stock;
// several lots end negative).
//
// ── Which coloris a kilo belongs to ──
// The LOT's coloris when the OF row names a lot (that is the yarn visitage
// takes from), else the OF row's own idcolori_fil. 104 of 5 330 rows disagree.
//
// ── The figures ──
// The rate is measured on COMPLETE months only (the running month would drag
// it down). « Disponible » is the État des stocks figure (stock + ordered −
// reserved, lib/fil-etat.ts) so this screen, the dashboard widget and the
// Superviseur never disagree. A suggested minimum needs a delivery time:
// kg/week × (délai + MARGE_SEMAINES), rounded UP to 10 kg.

import { mpsPg } from './mps-pg.js'
import { calculerEtatFil } from './fil-etat.js'
import { analyserAppro, type AnalyseAppro, type LigneAppro } from './fil-appro.js'

/** Safety margin added to the delivery time in the suggested minimum. */
export const MARGE_SEMAINES = 4
/** Months of history returned for the bar chart (running month included). */
export const MOIS_HISTORIQUE = 24

const JOURS_PAR_SEMAINE = 7

export interface MoisConso {
  /** 'YYYY-MM' */
  mois: string
  kg: number
  /** The running month — drawn, but never used in a rate. */
  partiel: boolean
}

export type StatutStock = 'sans_mini' | 'ok' | 'bientot' | 'commander'

export interface AnalyseConso {
  mensuel: MoisConso[]
  /** kg per week over the last 12 complete months. */
  kg_semaine_12m: number
  /** kg per week over the last 3 complete months — the trend. */
  kg_semaine_3m: number
  /** How many weeks the available stock lasts at the 12-month rate (null = no consumption). */
  semaines_couvertes: number | null
  /** 'YYYY-MM-DD' when the available stock reaches 0 at that rate. */
  date_rupture: string | null
  /** Weeks of consumption the current minimum represents. */
  semaines_mini: number | null
  /** Weeks left before the available stock reaches the minimum (0 = already under). */
  semaines_avant_mini: number | null
  /** 'YYYY-MM-DD' — order by this date (the stock reaches the minimum). */
  date_commande: string | null
  /** kg/week × (délai + marge), rounded up to 10 kg; null without délai or consumption. */
  mini_suggere: number | null
  statut: StatutStock
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  r.setDate(r.getDate() + Math.round(days))
  return r
}

function daysInMonth(y: number, m0: number): number {
  return new Date(y, m0 + 1, 0).getDate()
}

/** Pure arithmetic — pinned by fil-consommation.test.ts. */
export function analyserConsommation(input: {
  /** kg per 'YYYY-MM' (missing months = 0). */
  parMois: Map<string, number>
  aujourdhui: Date
  disponible: number
  stockMini: number
  delaiSemaines: number
}): AnalyseConso {
  const { parMois, aujourdhui, disponible } = input
  const mini = Math.max(0, input.stockMini || 0)
  const delai = Math.max(0, input.delaiSemaines || 0)

  // Last MOIS_HISTORIQUE months, oldest first, running month last.
  const mensuel: MoisConso[] = []
  for (let i = MOIS_HISTORIQUE - 1; i >= 0; i--) {
    const d = new Date(aujourdhui.getFullYear(), aujourdhui.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    mensuel.push({ mois: key, kg: parMois.get(key) ?? 0, partiel: i === 0 })
  }

  const rate = (nMonths: number): number => {
    let kg = 0
    let days = 0
    for (let i = 1; i <= nMonths; i++) {
      const d = new Date(aujourdhui.getFullYear(), aujourdhui.getMonth() - i, 1)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      kg += parMois.get(key) ?? 0
      days += daysInMonth(d.getFullYear(), d.getMonth())
    }
    return days > 0 ? (kg / days) * JOURS_PAR_SEMAINE : 0
  }
  const kg12 = rate(12)
  const kg3 = rate(3)

  const semaines_couvertes = kg12 > 0 ? Math.max(0, disponible) / kg12 : null
  const date_rupture = semaines_couvertes != null ? ymd(addDays(aujourdhui, semaines_couvertes * JOURS_PAR_SEMAINE)) : null
  const semaines_mini = kg12 > 0 && mini > 0 ? mini / kg12 : null
  const semaines_avant_mini = kg12 > 0 && mini > 0 ? Math.max(0, (disponible - mini) / kg12) : null
  const date_commande =
    semaines_avant_mini != null ? ymd(addDays(aujourdhui, semaines_avant_mini * JOURS_PAR_SEMAINE)) : null
  const mini_suggere = kg12 > 0 && delai > 0 ? Math.ceil((kg12 * (delai + MARGE_SEMAINES)) / 10) * 10 : null

  let statut: StatutStock
  if (mini <= 0) statut = 'sans_mini'
  else if (disponible <= mini) statut = 'commander'
  else if (semaines_avant_mini != null && semaines_avant_mini <= MARGE_SEMAINES) statut = 'bientot'
  else statut = 'ok'

  return {
    mensuel,
    kg_semaine_12m: kg12,
    kg_semaine_3m: kg3,
    semaines_couvertes,
    date_rupture,
    semaines_mini,
    semaines_avant_mini,
    date_commande,
    mini_suggere,
    statut,
  }
}

/** kg knitted per coloris and month since `depuis` — see the header for the rules. */
export async function chargerConsoMensuelle(
  coloriIds: number[],
  depuis: Date,
): Promise<Map<number, Map<string, number>>> {
  const out = new Map<number, Map<string, number>>()
  if (coloriIds.length === 0) return out
  const sql = mpsPg()
  const rows = await sql<{ colori: number; mois: string; kg: number }[]>`
    SELECT x.colori, to_char(x.d, 'YYYY-MM') AS mois, SUM(x.kg)::float8 AS kg
    FROM (
      SELECT CASE WHEN f.idcolori_fil > 0 THEN f.idcolori_fil ELSE a.idcolori_fil END AS colori,
             e.date_saisie AS d,
             e.poids * a.pourcentage / 100.0 AS kg
      FROM stock_ecru e
      JOIN asso_fil_of a ON a.idordre_fabrication = e.idordre_fabrication
      LEFT JOIN stock_fil f ON f.idstock_fil = a.idstock_fil AND a.idstock_fil > 0
      WHERE e.idordre_fabrication > 0 AND e.date_saisie >= ${depuis}
    ) x
    WHERE x.colori = ANY(${coloriIds})
    GROUP BY 1, 2`
  for (const r of rows) {
    const m = out.get(r.colori) ?? new Map<string, number>()
    m.set(r.mois, Number(r.kg) || 0)
    out.set(r.colori, m)
  }
  return out
}

export interface ConsoColoris extends AnalyseConso {
  IDcolori_fil: number
  reference: string | null
  stock_mini: number
  /** The délai typed on the coloris (weeks, 0 = not filled in). */
  delai_appro: number
  /** The délai the suggestion used: the typed one, else the measured one. */
  delai_utilise_semaines: number | null
  delai_source: 'saisi' | 'mesure' | null
  en_stock: number
  commande: number
  besoin: number
  disponible: number
  appro: AnalyseAppro
}

/** Order lines of these coloris, with their first / last lot — see lib/fil-appro.ts. */
export async function chargerLignesAppro(coloriIds: number[]): Promise<Map<number, LigneAppro[]>> {
  const out = new Map<number, LigneAppro[]>()
  if (coloriIds.length === 0) return out
  const sql = mpsPg()
  const rows = await sql<{
    colori: number; idref_fil_commande: number; idcommande_fil: number; fournisseur: string | null
    date_commande: string; date_promise: string | null; premiere: string | null; derniere: string | null
    quantite: number; recu: number; etat: number
  }[]>`
    SELECT l.idcolori_fil AS colori, l.idref_fil_commande, c.idcommande_fil, fr.nom::text AS fournisseur,
           to_char(c.date_commande, 'YYYY-MM-DD') AS date_commande,
           to_char(l.date_livraison, 'YYYY-MM-DD') AS date_promise,
           to_char(MIN(f.date_entree), 'YYYY-MM-DD') AS premiere,
           to_char(MAX(f.date_entree), 'YYYY-MM-DD') AS derniere,
           COALESCE(l.quantite, 0)::float8 AS quantite,
           COALESCE(SUM(f.stock_initial), 0)::float8 AS recu,
           COALESCE(l.etat, 0)::int AS etat
    FROM ref_fil_commande l
    JOIN commande_fil c ON c.idcommande_fil = l.idcommande_fil
    LEFT JOIN fournisseur fr ON fr.idfournisseur = c.idfournisseur
    LEFT JOIN stock_fil f ON f.idref_fil_commande = l.idref_fil_commande
    WHERE l.idcolori_fil = ANY(${coloriIds}) AND c.date_commande IS NOT NULL
    GROUP BY l.idcolori_fil, l.idref_fil_commande, c.idcommande_fil, fr.nom, c.date_commande, l.date_livraison, l.quantite, l.etat`
  for (const r of rows) {
    const list = out.get(r.colori) ?? []
    list.push({
      idref_fil_commande: r.idref_fil_commande,
      idcommande_fil: r.idcommande_fil,
      fournisseur: r.fournisseur?.trim() || null,
      date_commande: r.date_commande,
      // HFSQL's empty date came over as an early sentinel on some rows.
      date_promise: r.date_promise && r.date_promise > '1900-01-01' ? r.date_promise : null,
      premiere_reception: r.premiere,
      derniere_reception: r.derniere,
      quantite: Number(r.quantite) || 0,
      recu_kg: Number(r.recu) || 0,
      ouverte: r.etat === 0,
    })
    out.set(r.colori, list)
  }
  return out
}

/** Every coloris of a yarn reference: stock position + consumption + supply analysis. */
export async function consommationRefFil(refFil: number, aujourdhui = new Date()): Promise<ConsoColoris[]> {
  const sql = mpsPg()
  const coloris = await sql<{ idcolori_fil: number; reference: string | null; stock_mini: number | null; delai_appro: number | null }[]>`
    SELECT idcolori_fil, reference, stock_mini, delai_appro FROM colori_fil WHERE idref_fil = ${refFil} ORDER BY reference`
  const ids = coloris.map((c) => c.idcolori_fil)
  const depuis = new Date(aujourdhui.getFullYear(), aujourdhui.getMonth() - (MOIS_HISTORIQUE - 1), 1)
  const conso = await chargerConsoMensuelle(ids, depuis)
  const lignes = await chargerLignesAppro(ids)

  const out: ConsoColoris[] = []
  // Sequential on purpose: calculerEtatFil runs ~10 queries per coloris and a
  // reference has a handful of coloris — no need to open the pool wide.
  for (const c of coloris) {
    const etat = await calculerEtatFil(refFil, c.idcolori_fil)
    const stockMini = Number(c.stock_mini) || 0
    const delaiSaisi = Number(c.delai_appro) || 0
    const appro = analyserAppro(lignes.get(c.idcolori_fil) ?? [], ymd(aujourdhui))
    // The typed délai wins; else the measured one (rounded up to the week).
    const delaiMesure = appro.delai_mesure_jours != null ? Math.max(1, Math.ceil(appro.delai_mesure_jours / 7)) : null
    const delaiUtilise = delaiSaisi > 0 ? delaiSaisi : delaiMesure
    const analyse = analyserConsommation({
      parMois: conso.get(c.idcolori_fil) ?? new Map(),
      aujourdhui,
      disponible: etat.disponible,
      stockMini,
      delaiSemaines: delaiUtilise ?? 0,
    })
    out.push({
      IDcolori_fil: c.idcolori_fil,
      reference: c.reference?.trim() ?? null,
      stock_mini: stockMini,
      delai_appro: delaiSaisi,
      delai_utilise_semaines: delaiUtilise,
      delai_source: delaiSaisi > 0 ? 'saisi' : delaiMesure != null ? 'mesure' : null,
      en_stock: etat.en_stock,
      commande: etat.commande,
      besoin: etat.besoin,
      disponible: etat.disponible,
      ...analyse,
      appro,
    })
  }
  return out
}
