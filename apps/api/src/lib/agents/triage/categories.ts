// Agent « Triage » — the categories, ONE list for the prompt's schema, the
// Gmail labels and the web screen (served by GET /api/agents-ia/triage/categories;
// MFProd kept two copies that drifted apart).
//
// A category is « what kind of mail is this, and who should handle it ». The
// model chooses them (one or more per mail), the code never second-guesses
// it. The sub-category (which dyer, which client…) is NEVER the model's: it is
// derived from the sender (annuaire.ts) and from what the agent behind the
// category recognised in the PDF (decision Vincent 2026-10-05).
//
// Adding a category = one entry here + its line in the prompt (prompt.ts, a
// new version from the Prompt tab). Never rename a `cle`: runs and Gmail
// labels keep it.

export interface Categorie {
  cle: string
  libelle: string
  /** One line for the screen (the prompt carries its own definitions). */
  description: string
  /** The agent this category's mails are handed to (slug), if any. */
  cible?: string
  /** Gmail label nested by sub-category (« ETM/BL ennoblisseur/MATEL »). */
  detailGmail?: boolean
}

export const CATEGORIES: readonly Categorie[] = [
  { cle: 'bl_ennoblisseur', libelle: 'BL ennoblisseur', description: 'Bordereau de livraison ou mise à disposition d’un ennoblisseur (MATEL, Bontemps, TAD…).', cible: 'bl-ennoblisseur', detailGmail: true },
  { cle: 'facture_sous_traitant', libelle: 'Facture sous-traitant', description: 'Facture ou avoir d’un ennoblisseur / sous-traitant.', cible: 'factures-ennoblisseur', detailGmail: true },
  { cle: 'commande_client', libelle: 'Commande client', description: 'Nouvelle commande d’un client, ou modification / annulation d’une commande.' },
  { cle: 'demande_prix', libelle: 'Demande de prix', description: 'Demande de devis, de prix, d’échantillon ou de catalogue — client ou prospect.' },
  { cle: 'suivi_client', libelle: 'Suivi client', description: 'Échange avec un client sur une commande en cours : délai, validation, cahier des charges, rapport ou prévisionnel.' },
  { cle: 'facturation_client', libelle: 'Facturation client', description: 'Un client écrit au sujet de NOS factures : paiement, relance, litige, demande de facture, d’avoir ou de relevé.' },
  { cle: 'qualite', libelle: 'Qualité', description: 'Réclamation, défaut, retour, écart de métrage ; demandes de certificats, RSE, audits.' },
  { cle: 'sous_traitant', libelle: 'Échange sous-traitant', description: 'Échange avec un ennoblisseur ou un sous-traitant hors BL et facture : point du jour, plan de charge, question sur un lot.' },
  { cle: 'fournisseur', libelle: 'Fournisseur', description: 'Achat de fil ou de fournitures : confirmation de commande, offre, délai, livraison d’un fournisseur.' },
  { cle: 'transport', libelle: 'Transport', description: 'Enlèvement, suivi d’expédition, information d’un transporteur (hors facture).' },
  { cle: 'facture_fournisseur', libelle: 'Facture fournisseur', description: 'Facture, avis de prélèvement ou relance d’un fournisseur, transporteur ou prestataire (hors sous-traitants).' },
  { cle: 'administratif', libelle: 'Administratif', description: 'Social, paie, banque, assurance, impôts, organismes (URSSAF, CAF, mutuelle…).' },
  { cle: 'interne', libelle: 'Interne', description: 'Message d’une personne d’ETS Malterre ou du groupe.' },
  { cle: 'indesirable', libelle: 'Indésirable', description: 'Publicité, newsletter, invitation, notification sans action à mener.' },
  { cle: 'autre', libelle: 'Autre', description: 'Rien de ce qui précède.' },
]

export const CLES_CATEGORIES = CATEGORIES.map((c) => c.cle)

export function categorie(cle: string): Categorie | undefined {
  return CATEGORIES.find((c) => c.cle === cle)
}

/** Known keys, deduplicated, in the given order; « autre » when nothing is left. */
export function normaliserCategories(cles: readonly unknown[]): string[] {
  const out: string[] = []
  for (const c of cles) if (typeof c === 'string' && categorie(c) && !out.includes(c)) out.push(c)
  return out.length ? out : ['autre']
}

/** Under one ETM/ folder in Gmail: never a bare name that clashes with a
 *  system label (MFProd's « Spam » broke every tick for 17 h). */
export const LIBELLE_RACINE = 'ETM'

/** The Gmail label of a category on one mail. A « / » in a company name would
 *  nest one level deeper: replaced. */
export function libelleGmail(c: Categorie, sousCategorie: string | null): string {
  const base = `${LIBELLE_RACINE}/${c.libelle}`
  if (!c.detailGmail) return base
  return `${base}/${(sousCategorie || 'Inconnu').replace(/\//g, '-').trim() || 'Inconnu'}`
}
