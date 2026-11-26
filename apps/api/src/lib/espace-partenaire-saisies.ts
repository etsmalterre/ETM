// What a sous-traitant types itself in the espace partenaire (Vincent 2026-11-26: « écrire directement les
// délais et les lots », instead of the e-mails ETM read until then) — written by
//   PUT /api/site/espace/partenaires/:id/commandes/:idCommande/lignes/:idLigne/delai
//   PUT /api/site/espace/partenaires/:id/lots/:idLot/mesures
// (routes/webservice-site.ts). Nothing is re-derived here: each write goes through the path ETM already has for
// « the dyer said so » — the one Tricobot uses when it reads the dyer's mail (lib/agents/flux-ennoblisseur/
// saisies.ts `ecrireDelai` / `ecrireMesures`) — so the engagement rules, the report, the urgency's answer, the
// lot's Journal and Tricobot's own scoring all see the partner's entry as they see a person's.
//
// Guards, before any write:
//  - the order / the lot is one the partner can open (lib/espace-partenaire-commandes.ts: its own, bon de
//    commande e-mailed, in the twelve months) — anything else is « not found », never « not yours »;
//  - a délai: the order is in progress and the line not delivered; a real date, from today, at most
//    DELAI_MAX_J ahead (Tricobot's own doubt); never earlier than the one given (the engagement rule,
//    lib/report-delai-sst.ts `refusAvanceDelai`, with its exceptions); a later one is a report, due to the
//    sous-traitant, and needs the partner's reason;
//  - measures: the lot is at a step where the partner measures (LOT_MESURABLE), never a validated one; only the
//    measures the reference asks it; a measure left out keeps its value, an empty one erases it.
// The partner's wording of a refusal is its own: it never reads ETM's (« engagement du sous-traitant »).
//
// Who typed: the portal names its signed-in contact (« Prénom Nom (MATEL, espace partenaire) »); it is not an ETM
// user (par_id 0) and shows as written in the order's and the lot's Journal.

import { commandePartenaire, lotPartenaire, type CleMesure } from './espace-partenaire-commandes.js'
import { estUnReportDelai, refusAvanceDelai, dateDeReference } from './report-delai-sst.js'
import { lireSaisieStab, StabInvalide } from './stabilites.js'
import { lireSaisieVrillage, VrillageInvalide } from './vrillage.js'
import { lireMesuresCotes, noterMesures } from './journal-lot.js'
import {
  aDesMesures, ecrireDelai, ecrireMesures, lireEtatLigne, lireMesuresLot, ligneModifiee, lotModifie, texteMesures,
  type Auteur, type MesuresSst,
} from './agents/flux-ennoblisseur/saisies.js'
import { noterSaisieHumaine } from './agents/flux-ennoblisseur/observation.js'
import { DELAI_MAX_J } from './agents/flux-ennoblisseur/delais.js'

/** A refusal the partner reads: its HTTP status, a code for the portal, a sentence for the person. */
export class RefusSaisie extends Error {
  constructor(public status: 400 | 404 | 409, public code: string, message: string) { super(message) }
}

const DEPUIS = 'l’espace partenaire'
const auteur = (par: string): Auteur => ({ id: 0, nom: par.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Espace partenaire' })
const jjmmaaaa = (d: string) => { const x = d.replace(/-/g, ''); return `${x.slice(6, 8)}/${x.slice(4, 6)}/${x.slice(0, 4)}` }

function aujourdhuiIso(): string {
  const t = new Date()
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

function plusJours(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// ── Pure readers of what was typed (tested) ─────────────────

/** A délai as typed → 'YYYY-MM-DD'. A real date, from today, at most DELAI_MAX_J ahead. */
export function lireSaisieDelai(v: unknown, aujourdhui: string): string {
  const s = typeof v === 'string' ? v.trim() : ''
  // A day that exists: « 2026-02-30 » rolls over to March, « 2026-13-01 » is no date at all.
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00Z`) : null
  const reel = !!t && !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s
  if (!reel) throw new RefusSaisie(400, 'delai_invalide', 'Indiquez une date de livraison.')
  if (s < aujourdhui) throw new RefusSaisie(400, 'delai_passe', 'Le délai ne peut pas être une date passée.')
  if (s > plusJours(aujourdhui, DELAI_MAX_J)) throw new RefusSaisie(400, 'delai_lointain', 'Ce délai est à plus de six mois : vérifiez la date.')
  return s
}

/** Highest laize (cm) and poids (g/m²) a person may type: typo guards, not tolerances. */
export const LAIZE_SAISIE_MAX = 400
export const POIDS_SAISIE_MAX = 1500

/** A laize or a poids as typed → its stored integer; empty = not measured (0, as the legacy stores it). */
export function lireSaisieEntier(v: unknown, libelle: string, max: number, unite: string): number {
  if (v === null || v === undefined) return 0
  const s = String(v).trim().replace(',', '.')
  if (s === '') return 0
  const x = Number(s)
  if (!Number.isFinite(x)) throw new RefusSaisie(400, 'mesure_invalide', `${libelle} doit être un nombre.`)
  if (x <= 0 || x > max) throw new RefusSaisie(400, 'mesure_invalide', `${libelle} doit être entre 1 et ${max} ${unite}.`)
  return Math.round(x)
}

/** The measures typed, over what the lot holds: only the measures asked (`demandees`) are read, one left out of
 *  `saisie` keeps its value. */
export function lireSaisieMesures(saisie: Partial<Record<CleMesure, unknown>>, avant: MesuresSst, demandees: readonly CleMesure[]): MesuresSst {
  const m = { ...avant }
  const donnee = (c: CleMesure) => demandees.includes(c) && c in saisie
  try {
    if (donnee('laize')) m.laize = lireSaisieEntier(saisie.laize, 'La laize', LAIZE_SAISIE_MAX, 'cm')
    if (donnee('poids')) m.poids = lireSaisieEntier(saisie.poids, 'Le poids', POIDS_SAISIE_MAX, 'g/m²')
    if (donnee('stabH')) m.stabH = lireSaisieStab('stabH', saisie.stabH, 'La stabilité en hauteur')
    if (donnee('stabL')) m.stabL = lireSaisieStab('stabL', saisie.stabL, 'La stabilité en largeur')
    if (donnee('vrillage')) m.vrillage = lireSaisieVrillage('vrillage_sst', saisie.vrillage)
  } catch (e) {
    if (e instanceof StabInvalide || e instanceof VrillageInvalide) throw new RefusSaisie(400, 'mesure_invalide', e.message)
    throw e
  }
  return m
}

// ── The two writes ──────────────────────────────────────────

/** The partner gives (or pushes back) its délai for one line of one of its orders. `par`: who typed, as the
 *  portal names its contact. Resolves to false when the line already carries that date. */
export async function donnerDelaiPartenaire(
  idSousTraitant: number, idCommande: number, idLigne: number, saisie: { delai: unknown; motif?: unknown }, par: string,
): Promise<boolean> {
  const commande = await commandePartenaire(idSousTraitant, idCommande)
  const ligne = commande?.lignes.find((l) => l.id === idLigne)
  if (!commande || !ligne) throw new RefusSaisie(404, 'introuvable', 'Commande introuvable.')
  if (commande.etape === 'terminee') throw new RefusSaisie(409, 'commande_terminee', 'Cette commande est terminée : son délai ne se modifie plus.')
  if (ligne.etape === 'livree') throw new RefusSaisie(409, 'ligne_livree', 'Cette ligne est livrée : son délai ne se modifie plus.')
  const delai = lireSaisieDelai(saisie.delai, aujourdhuiIso())

  const avant = await lireEtatLigne(idLigne)
  if (!avant || avant.idcommande !== idCommande) throw new RefusSaisie(404, 'introuvable', 'Commande introuvable.')
  const digits = delai.replace(/-/g, '')
  if (avant.dateLivraison === digits) return false
  const cur = { date_livraison: avant.dateLivraison, date_delai: avant.dateDelai, sstatut: avant.sstatut }
  if (await refusAvanceDelai(idLigne, cur, delai)) {
    throw new RefusSaisie(409, 'delai_avance',
      `Votre délai du ${jjmmaaaa(dateDeReference(avant.dateLivraison, avant.dateDelai))} est un engagement : il peut être repoussé, pas avancé. Une livraison en avance se constate à la réception.`)
  }
  const motif = typeof saisie.motif === 'string' ? saisie.motif.replace(/\s+/g, ' ').trim().slice(0, 400) : ''
  const report = estUnReportDelai(avant.dateLivraison, avant.dateDelai, delai)
  if (report && !motif) throw new RefusSaisie(400, 'motif_requis', 'Vous repoussez un délai déjà donné : indiquez-en la raison.')

  const qui = auteur(par)
  await ecrireDelai(idLigne, delai, qui, report ? motif : null)
  // As a délai typed on the line in ETM: Tricobot's open saisie on it is judged by it, and kept for its observation.
  const juges = await ligneModifiee(idLigne, digits, qui, DEPUIS)
  await noterSaisieHumaine({ competence: 'delais', idligne: idLigne, valeur: delai, avant, par: qui, juges })
  return true
}

/** The partner types its measures of one of its lots. Resolves to false when nothing changes. */
export async function enregistrerMesuresPartenaire(
  idSousTraitant: number, idLot: number, saisie: Partial<Record<CleMesure, unknown>>, par: string,
): Promise<boolean> {
  const lot = await lotPartenaire(idSousTraitant, idLot)
  if (!lot) throw new RefusSaisie(404, 'introuvable', 'Lot introuvable.')
  if (!lot.controle) throw new RefusSaisie(409, 'sans_controle', 'Aucune mesure ne vous est demandée pour ce lot.')
  if (!lot.controle.modifiable) {
    throw new RefusSaisie(409, 'lot_verrouille', lot.etape === 'valide'
      ? 'Ce lot est validé : ses mesures ne se modifient plus.'
      : 'Les mesures de ce lot se saisissent une fois le lot terminé chez vous.')
  }
  const avant = await lireMesuresLot(idLot)
  if (!avant) throw new RefusSaisie(404, 'introuvable', 'Lot introuvable.')
  const apres = lireSaisieMesures(saisie, avant, lot.controle.mesures.map((m) => m.cle))
  if (texteMesures(apres) === texteMesures(avant)) return false

  const qui = auteur(par)
  const cotesAvant = await lireMesuresCotes(idLot)
  await ecrireMesures(idLot, apres)
  // As measures typed on Suivi lots: Tricobot's open saisie is judged by them, the observation keeps them, and
  // the lot's Journal tells what changed.
  const juges = await lotModifie(idLot, qui, DEPUIS)
  const ecrites = await lireMesuresLot(idLot)
  if (ecrites && aDesMesures(ecrites)) {
    await noterSaisieHumaine({ competence: 'controles', idsuivilot: idLot, valeur: texteMesures(ecrites), avant, par: qui, juges })
  }
  await noterMesures(idLot, cotesAvant, await lireMesuresCotes(idLot), qui)
  return true
}
