// Agent « Factures Ennoblisseur » — the pure half of the check: given the lines
// read on the invoice and what ETM knows about each lot, the verdict of every
// line and of the invoice. No I/O here (tests: controle.test.ts).
//
// What Pierre-Emmanuel checked by hand (decision Vincent 2026-10-02): the
// weight, the yield and the treatments that end up in the right price. ETM's
// expected price is the legacy CalculTarifSST (lib/pricing-sst.ts: dye base ×
// MATEL yield multiplier + treatments, by weight band) at the lot's weight.
// Reproduced on FA2865 (2026-05-15): exact or ±1 centime on every lot, and the
// one he disputed (lot 108406, billed 5,64 for 5,00 → 133,76 € credited)
// comes out as the only gap.
//
// TWO verdicts per line (decision Vincent 2026-10-02 — « too many statuses »):
//   - « conforme »: the agent had everything (lot, order, tariff for the ref,
//     coloris, treatments, yield, the pieces' weight) and it is right — or
//     billed BELOW (MATEL bills calandrage only on the calendered pieces);
//   - « écart »: something is wrong (price / weight above ETM, lot already
//     billed) — nature « réel » — or the agent could not check it (lot not
//     found, no or incomplete ETM tariff, pieces not all in ETM) — nature
//     « non vérifié ». Every écart takes a person; the nature decides what
//     their answer scores (avis.ts) and what goes into a réclamation.
// The finer reasoning stays internal (`Constat`) and in each line's message.

import type { Controle, FactureLue, Fournisseur, LigneFactureLue } from './extraction.js'
import { estBloquant, estOfferte } from './extraction.js'

/** The line's verdict; « info » = a line that bills no lot (packaging, transport, remise, offered). */
export type Verdict = 'conforme' | 'ecart' | 'info'
/** Why an écart: something is wrong, or the agent could not check it. */
export type Nature = 'reel' | 'non_verifie'
export type StatutFacture = 'conforme' | 'ecarts'
/** The agent's finer reading, folded into Verdict + Nature at the end. */
type Constat = 'conforme' | 'ecart' | 'inferieur' | 'non_rapproche' | 'non_controle' | 'info'

/** What ETM knows about one lot of the invoice (factures-sst/db.ts). */
export interface LotEtm {
  /** ETM lot code, « MA108406 ». */
  lot: string
  idsuivilot: number
  idligne: number
  /** The sst order — what MATEL prints as « BON CLIENT ». */
  idcommande: number
  idSousTraitant: number
  /** Écru weight of the lot's pieces, received or still at the dyer. null = no piece found. */
  poids: number | null
  pieces: number | null
  /** €/Kg by ETM's tariff at `poids`; null = no tariff for this ref. */
  prixAttendu: number | null
  /** How the expected price is made, in French (« Teinture 4,82 × 1,03 + PREF 0,58 »). */
  explicationPrix: string
  /** Why ETM's tariff cannot be trusted for this ref (a dyed coloris with no
   *  dye price, a treatment without tariff), null when complete. A price billed
   *  above an incomplete tariff is « non contrôlé », never a gap: on 2026-10-02
   *  every such case was ETM's gap (0,56 €/kg expected for a dyed lot). */
  tarifIncomplet: string | null
  /** Other invoices of the same dyer that already billed this lot. */
  autresFactures: string[]
}

export interface LigneVerifiee {
  ligne: LigneFactureLue
  /** ETM lot code of the line, '' for a line that bills no lot. */
  lotEtm: string
  etm: LotEtm | null
  verdict: Verdict
  /** Set on an écart only. */
  nature: Nature | null
  ecartMontant: number
  controles: Controle[]
}

export interface FactureVerifiee {
  lignes: LigneVerifiee[]
  controles: Controle[]
  statut: StatutFacture
  ecartMontant: number
}

/** Above the expected price, what is accepted: the larger of 2 centimes/kg
 *  (MATEL rounds the yield multiplier its own way: 8,38 billed for 8,37) and
 *  1 % (FA2888: 5,59 billed for 5,54 on four lots, pointed by Pierre-Emmanuel
 *  without dispute). His smallest real dispute was 5,3 % (MA108967). */
export const TOLERANCE_PRIX = 0.02
export const TOLERANCE_PRIX_PCT = 0.01
export const tolerancePrix = (attendu: number) => Math.max(TOLERANCE_PRIX, Math.round(attendu * TOLERANCE_PRIX_PCT * 100) / 100)
/** Kg above ETM's weight: the larger of these. */
export const TOLERANCE_POIDS_KG = 0.5
export const TOLERANCE_POIDS_PCT = 0.005

const round2 = (n: number) => Math.round(n * 100) / 100
const eur = (n: number) => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const kg = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 2 })
const estKg = (u: string) => /^k/i.test(u.trim())

const RANG: Record<Constat, number> = { ecart: 5, non_rapproche: 4, non_controle: 3, inferieur: 2, conforme: 1, info: 0 }
const pire = (a: Constat, b: Constat): Constat => (RANG[b] > RANG[a] ? b : a)

/** Internal working line: the finer constat, folded at the end. */
type Travail = Omit<LigneVerifiee, 'verdict' | 'nature'> & { verdict: Constat }

const PLIAGE: Record<Constat, { verdict: Verdict; nature: Nature | null }> = {
  conforme: { verdict: 'conforme', nature: null },
  inferieur: { verdict: 'conforme', nature: null },
  ecart: { verdict: 'ecart', nature: 'reel' },
  non_rapproche: { verdict: 'ecart', nature: 'non_verifie' },
  non_controle: { verdict: 'ecart', nature: 'non_verifie' },
  info: { verdict: 'info', nature: null },
}

/**
 * @param lots  ETM's view of each ETM lot code read on the invoice; a code
 *              absent from the map, or mapped to null, is unknown to ETM.
 * @param lecture  the checks on the reading (controlerLecture).
 */
export function verifierFacture(f: FactureLue, fournisseur: Fournisseur, lots: ReadonlyMap<string, LotEtm | null>, lecture: Controle[]): FactureVerifiee {
  const lignes: Travail[] = f.lignes.map((ligne) => ({
    ligne,
    lotEtm: ligne.genre === 'lot' ? fournisseur.lotEtm(ligne.lot) : '',
    etm: null,
    verdict: (ligne.genre === 'lot' ? 'conforme' : 'info') as Constat,
    ecartMontant: 0,
    controles: [],
  }))
  const controles: Controle[] = [...lecture]

  // Lines of the same lot are checked together (weight, pieces): a lot partly
  // calendered takes two lines.
  const parLot = new Map<string, Travail[]>()
  for (const l of lignes) {
    if (l.ligne.genre !== 'lot') continue
    if (estOfferte(l.ligne)) {
      l.verdict = 'info'
      l.controles.push({ code: 'offert', gravite: 'info', message: 'Ligne sans prix ni montant : offerte ou non facturée.' })
      continue
    }
    if (!l.lotEtm) {
      l.verdict = 'non_rapproche'
      l.controles.push({ code: 'sans_lot', gravite: 'avertissement', message: 'Ligne sans numéro de lot : elle n’a pu être rattachée à aucune commande.' })
      continue
    }
    const g = parLot.get(l.lotEtm) ?? []
    g.push(l)
    parLot.set(l.lotEtm, g)
  }

  for (const [code, groupe] of parLot) {
    const etm = lots.get(code) ?? null
    for (const l of groupe) l.etm = etm
    const premiere = groupe[0]
    if (!etm || etm.idSousTraitant !== fournisseur.idSousTraitant) {
      for (const l of groupe) {
        l.verdict = 'non_rapproche'
        l.controles.push({
          code: 'lot_inconnu',
          gravite: 'avertissement',
          message: etm ? `Le lot ${code} appartient à une commande d’un autre sous-traitant.` : `Lot ${code} introuvable dans ETM (Suivi lots).`,
        })
      }
      continue
    }

    for (const l of groupe) {
      if (l.ligne.numero_commande && Number(l.ligne.numero_commande) !== etm.idcommande) {
        l.controles.push({
          code: 'commande',
          gravite: 'avertissement',
          message: `La facture indique la commande ${l.ligne.numero_commande}, le lot ${code} est sur la commande ${etm.idcommande}.`,
        })
      }
    }

    if (etm.autresFactures.length) {
      for (const l of groupe) {
        l.verdict = 'ecart'
        l.ecartMontant = round2(l.ecartMontant + (l.ligne.montant ?? 0))
        l.controles.push({ code: 'double', gravite: 'avertissement', message: `Lot ${code} déjà facturé sur ${etm.autresFactures.join(', ')}.` })
      }
      continue
    }

    // Weight: what the lot weighed in ETM against what is billed.
    const lignesKg = groupe.filter((l) => estKg(l.ligne.unite) && l.ligne.quantite != null)
    const factureKg = lignesKg.reduce((s, l) => s + (l.ligne.quantite ?? 0), 0)
    const facturePieces = groupe.reduce((s, l) => s + (l.ligne.pieces ?? 0), 0)
    // Fewer pieces in ETM than billed: the rest is not received nor tagged
    // with the lot yet (MA109269: 1 of 21 pieces) — the weight says nothing.
    const piecesManquantes = etm.pieces != null && Math.round(facturePieces) > etm.pieces
    if (etm.poids != null && lignesKg.length) {
      const diff = factureKg - etm.poids
      const tol = Math.max(TOLERANCE_POIDS_KG, TOLERANCE_POIDS_PCT * etm.poids)
      if (diff > tol && piecesManquantes) {
        premiere.verdict = pire(premiere.verdict, 'non_controle')
        premiere.controles.push({
          code: 'poids_incomplet',
          gravite: 'avertissement',
          message: `${kg(factureKg)} kg facturés : seules ${etm.pieces} des ${kg(facturePieces)} pièces du lot sont dans ETM (${kg(etm.poids)} kg), poids non vérifié.`,
        })
      } else if (diff > tol) {
        const pu = premiere.ligne.prix_unitaire ?? 0
        premiere.verdict = 'ecart'
        premiere.ecartMontant = round2(premiere.ecartMontant + diff * pu)
        premiere.controles.push({
          code: 'poids',
          gravite: 'avertissement',
          message: `${kg(factureKg)} kg facturés pour ${kg(etm.poids)} kg de pièces dans ETM (+${kg(diff)} kg, ${eur(round2(diff * pu))} €).`,
        })
      } else if (diff < -tol) {
        premiere.controles.push({ code: 'poids_inferieur', gravite: 'info', message: `${kg(factureKg)} kg facturés pour ${kg(etm.poids)} kg de pièces dans ETM.` })
      }
    } else if (etm.poids == null) {
      premiere.controles.push({ code: 'poids_inconnu', gravite: 'info', message: `Aucune pièce du lot ${code} trouvée dans ETM : poids non vérifié.` })
    }

    if (!piecesManquantes && etm.pieces != null && groupe.some((l) => l.ligne.pieces != null) && Math.round(facturePieces) !== etm.pieces) {
      premiere.controles.push({ code: 'pieces', gravite: 'info', message: `${kg(facturePieces)} pièces facturées, ${etm.pieces} dans ETM.` })
    }

    // Price, line by line (a calendered part may cost more than the rest).
    for (const l of groupe) {
      const pu = l.ligne.prix_unitaire
      if (!fournisseur.controlePrix) {
        l.verdict = pire(l.verdict, 'non_controle')
        // Every écart says why: here the dyer's prices are outside ETM's €/Kg tariff.
        l.controles.push({ code: 'prix_hors_tarif', gravite: 'avertissement', message: `Prix ${fournisseur.nom} non comparés au tarif ETM (facturation au m² / ML) : à vérifier.` })
        continue
      }
      if (!estKg(l.ligne.unite) || pu == null) {
        l.verdict = pire(l.verdict, 'non_controle')
        l.controles.push({ code: 'prix_unite', gravite: 'info', message: `Prix en ${l.ligne.unite || 'unité inconnue'} : non comparé au tarif (€/Kg).` })
        continue
      }
      if (etm.prixAttendu == null || !(etm.prixAttendu > 0)) {
        l.verdict = pire(l.verdict, 'non_controle')
        l.controles.push({ code: 'sans_tarif', gravite: 'avertissement', message: 'Pas de tarif ETM pour cette référence chez ce sous-traitant : prix non vérifié.' })
        continue
      }
      const delta = round2(pu - etm.prixAttendu)
      const tol = tolerancePrix(etm.prixAttendu)
      if (delta > tol && etm.tarifIncomplet) {
        l.verdict = pire(l.verdict, 'non_controle')
        l.controles.push({ code: 'tarif_incomplet', gravite: 'avertissement', message: `Facturé ${eur(pu)} €/kg, tarif ETM incomplet (${etm.tarifIncomplet}) : prix non vérifié.` })
      } else if (delta > tol) {
        const e = round2(delta * (l.ligne.quantite ?? 0))
        l.verdict = 'ecart'
        l.ecartMontant = round2(l.ecartMontant + e)
        l.controles.push({
          code: 'prix',
          gravite: 'avertissement',
          message: `Facturé ${eur(pu)} €/kg, tarif ETM ${eur(etm.prixAttendu)} €/kg${etm.explicationPrix ? ` (${etm.explicationPrix})` : ''} : ${eur(e)} € de trop.`,
        })
      } else if (delta < -tol) {
        l.verdict = pire(l.verdict, 'inferieur')
        l.controles.push({ code: 'prix_inferieur', gravite: 'info', message: `Facturé ${eur(pu)} €/kg, en dessous du tarif ETM ${eur(etm.prixAttendu)} €/kg.` })
      }
    }
  }

  // Lines that bill no lot: never a gap, but said.
  const piecesFacturees = lignes.filter((l) => l.ligne.genre === 'lot').reduce((s, l) => s + (l.ligne.pieces ?? 0), 0)
  for (const l of lignes) {
    if (l.ligne.genre === 'remise' && l.ligne.montant != null) {
      l.controles.push({ code: 'remise', gravite: 'info', message: `Remise de ${eur(Math.abs(l.ligne.montant))} € : à rapprocher d’un avoir convenu.` })
    }
    if (l.ligne.genre === 'emballage' && l.ligne.quantite != null && piecesFacturees > 0 && Math.round(l.ligne.quantite) !== Math.round(piecesFacturees)) {
      l.controles.push({ code: 'emballage', gravite: 'info', message: `${kg(l.ligne.quantite)} emballages facturés pour ${kg(piecesFacturees)} pièces.` })
    }
  }

  const ecartMontant = round2(lignes.reduce((s, l) => s + l.ecartMontant, 0))
  const pliees: LigneVerifiee[] = lignes.map((l) => ({ ...l, ...PLIAGE[l.verdict] }))
  // A misread invoice is an écart as a whole, whatever its lines say.
  const statut: StatutFacture = estBloquant(lecture) || pliees.some((l) => l.verdict === 'ecart') ? 'ecarts' : 'conforme'
  return { lignes: pliees, controles, statut, ecartMontant }
}

/** One line for a run, a notification card, the invoice list. */
export function resumerVerification(v: FactureVerifiee): string {
  const lots = new Set(v.lignes.filter((l) => l.lotEtm).map((l) => l.lotEtm)).size
  const reels = v.lignes.filter((l) => l.verdict === 'ecart' && l.nature === 'reel').length
  const nv = v.lignes.filter((l) => l.verdict === 'ecart' && l.nature === 'non_verifie').length
  if (estBloquant(v.controles)) return `lecture à vérifier — ${v.controles.find((c) => c.gravite === 'bloquant')?.message ?? ''}`
  const parts: string[] = []
  if (reels) parts.push(`${reels} écart${reels > 1 ? 's' : ''} (${eur(v.ecartMontant)} €)`)
  if (nv) parts.push(`${nv} non vérifiable${nv > 1 ? 's' : ''}`)
  if (!parts.length) return `${lots} lot${lots > 1 ? 's' : ''} conforme${lots > 1 ? 's' : ''}`
  return `${lots} lot${lots > 1 ? 's' : ''} · ${parts.join(' · ')}`
}
