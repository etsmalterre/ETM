// A sous-traitant's own figures, as the espace partenaire shows them — read by
// GET /api/site/espace/partenaires/:id/qualite-service (routes/webservice-site.ts). The shape is the portal's
// contract (its packages/api `QualiteServiceApi`), field for field.
//
// « Qualité de service »: the « Respect du délai » lines of Sous-traitants › Gestion › « Qualité de service »
// (lib/qualite-service-sst.ts `qualiteService()`, reused: same lines, same working days, same first promise),
// over twelve sliding months, with the gap SIGNED (ETM clamps its `retard` at 0; the partner is also told when
// it was early) and limited to the orders the partner can open (bon de commande e-mailed: an order progressed
// without one is not in its space, lib/espace-partenaire-commandes.ts).
// Never add: « Réponse au délai » (how long the partner took to answer, the relances it took, the reports and
// whose fault they were), the synthesis figures ETM computes for itself (part à l'heure, retard moyen), another
// sous-traitant's lines, prices, the Malterre customer behind a line.

import { qualiteService, type LigneRespect } from './qualite-service-sst.js'
import { articlesDesLignes, commandesEnvoyees } from './espace-partenaire-commandes.js'

export interface LigneService {
  idCommande: number
  idLigne: number
  /** « REF - coloris ». */
  article: string
  /** commande_sous_traitant.date_commande */
  commandeLe: string | null
  /** The first délai given. */
  delaiPromis: string
  /** First lot received; null for an open line past its promise. */
  recuLe: string | null
  /** Working days from the order to the first lot received, or to today while open. */
  dureeJours: number | null
  /** Working days from the promise to the first lot received (today while open): negative = early. */
  ecartJours: number
}

export interface QualiteServicePartenaire {
  calculeLe: string
  depuis: string
  /** The partner's délai standard (delai_standard_sst, default 15). */
  objectifJours: number
  /** Newest first. */
  lignes: LigneService[]
}

/** First day of the twelve sliding months ending with the current one (2026-11-24 → 2025-12-01). Pure. */
export function debutDouzeMois(aujourdhui: string): string {
  const d = new Date(Date.UTC(Number(aujourdhui.slice(0, 4)), Number(aujourdhui.slice(5, 7)) - 12, 1))
  return d.toISOString().slice(0, 10)
}

/** One ETM line as the partner reads it. Pure. */
export function ligneService(l: LigneRespect, article: string): LigneService {
  return {
    idCommande: l.idcommande,
    idLigne: l.idligne,
    article: article || l.reference,
    commandeLe: l.commandeLe,
    delaiPromis: l.delaiPromis,
    recuLe: l.premiereReception,
    dureeJours: l.dureeJours,
    ecartJours: l.ecart,
  }
}

export function aujourdhuiIso(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function qualiteServicePartenaire(idSousTraitant: number, aujourdhui = aujourdhuiIso()): Promise<QualiteServicePartenaire> {
  const depuis = debutDouzeMois(aujourdhui)
  const q = await qualiteService(idSousTraitant, depuis, aujourdhui)
  const [articles, envoyees] = await Promise.all([
    articlesDesLignes(q.lignes.map((l) => l.idligne)),
    commandesEnvoyees(idSousTraitant, q.lignes.map((l) => l.idcommande)),
  ])
  return {
    calculeLe: aujourdhui,
    depuis,
    objectifJours: q.standardJours,
    // qualiteService() sorts them newest first (first lot received, open ones on top).
    lignes: q.lignes.filter((l) => envoyees.has(l.idcommande)).map((l) => ligneService(l, articles.get(l.idligne) ?? '')),
  }
}
