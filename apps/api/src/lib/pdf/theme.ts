// Shared design tokens and company info for all Malterre-branded PDFs.
// Mirrors the MPS design system defined in .claude/skills/mps_designer/SKILL.md
// so the generated documents match the app's visual language.

export const colors = {
  // PDF-specific palette — chosen to match the Malterre brand HTML template
  // the user approved. Distinct from the on-screen ETM app colors.
  primary: '#002395',    // French Blue (used for headings + grand total)
  primaryDark: '#00174D', // Darker navy used for the bar under the header
  gold: '#EFA633',       // Malterre brand gold (header band + accents)
  text: '#1F2937',       // Body text
  muted: '#6B7280',      // Secondary text
  subtle: '#9CA3AF',     // Very muted
  border: '#E5E7EB',     // Card/table borders
  borderStrong: '#D1D5DB', // Stronger card border
  darkBar: '#374151',    // Thin dark gray bar under the header
  bgMuted: '#F4F4F4',    // Table header background
  bgFlagWhite: '#D8D8D8', // Slightly darker gray used as the "white" of the footer flag stripe (so it shows against the lighter footer bg)
  bgCream: '#FDFAF4',    // Address block background (warm cream)
  bgTotal: '#F9F9F9',    // Grand-total cell background
  flagBlue: '#002395',   // Tricolore stripe — blue
  flagWhite: '#FFFFFF',  // Tricolore stripe — white
  flagRed: '#ED2939',    // Tricolore stripe — red
  white: '#FFFFFF',
  black: '#000000',
} as const

// ETS Malterre — company information for document headers and footers.
// Keep in sync with real legal info; TODO: move to env or DB config when needed.
export const company = {
  legalName: 'ETS MALTERRE SARL',
  tradeName: 'Malterre',
  tagline: 'BONNETTERIE · TRICOTAGE',
  address1: 'ZI Route de Thennes',
  address2: '',
  zip: '80110',
  city: 'MOREUIL',
  country: 'France',
  phone: '03.22.35.36.66',
  email: 'contact@etsmalterre.com',
  website: 'etsmalterre.fr',
  capital: '7 750 €',
  rcs: 'Amiens 430 382 135',
  siret: '430 382 135 00019',
  vat: 'FR 78430 382 135',
  naf: '4641Z',
  legalJurisdiction: 'TOUTE CONTESTATION SERA JUGEE PAR LE TRIBUNAL DE COMMERCE D\'AMIENS (SOMME)',
  // Bank coordinates — shown on proforma invoices (payment before delivery).
  bank: {
    holder: 'ETS MALTERRE SARL',
    iban: 'FR76 3000 3035 8100 0200 0249 485',
    bic: 'SOGEFRPP',
  },
} as const

/** Label of the TVA row in a totals block, e.g. "TVA (20 %)" / "TVA (5,5 %)".
 *  Only ever called with a rate > 0: a client flagged "Exonération" in
 *  Clients › Gestion (export customers) drops the TVA and TTC rows entirely,
 *  leaving the block at TOTAL HT — see the commande / devis / facture totals
 *  blocks, which share this helper so they can't drift apart. */
export function tvaRowLabel(rate: number): string {
  const r = Number(rate) || 0
  const decimals = r % 1 === 0 ? 0 : 1
  return `TVA (${r.toFixed(decimals).replace('.', ',')} %)`
}

/** Shape of a company identity block — `company` is the canonical instance and
 *  the default everywhere; `companyTrm` is the sister company's. Documents that
 *  are issued BY Tricotage Malterre (its avis d'expédition) must pass it to
 *  `MalterreDocument`, otherwise the footer would print ETS Malterre's SIRET /
 *  TVA on a legal document TRM signed. */
export interface CompanyInfo {
  legalName: string
  tradeName: string
  tagline: string
  address1: string
  address2: string
  zip: string
  city: string
  country: string
  phone: string
  email: string
  website: string
  capital: string
  rcs: string
  siret: string
  vat: string
  naf: string
  legalJurisdiction: string
  bank: { holder: string; iban: string; bic: string }
}

/** Tricotage Malterre SARL — the knitting company (IDsociete = 2).
 *  Same site and switchboard as ETS Malterre, different legal entity. Values
 *  transcribed from the legacy `ETAT_Expédition_TRM` report footer (see
 *  BL 12211): SIRET 332 604 727 00021, NAF 1391Z (fabrication d'étoffes à
 *  maille), TVA FR 25 332 604 727, capital 46 500 €. `rcs` is deliberately
 *  the empty string — the legacy report prints no RCS for TRM and inventing
 *  one on a delivery note is not an option; the footer already skips it. */
export const companyTrm: CompanyInfo = {
  ...company,
  legalName: 'TRICOTAGE MALTERRE SARL',
  tradeName: 'Tricotage Malterre',
  tagline: 'TRICOTAGE',
  phone: '03.22.35.36.66',
  capital: '46 500 €',
  rcs: '',
  siret: '332 604 727 00021',
  vat: 'FR 25 332 604 727',
  naf: '1391Z',
  bank: {
    holder: 'TRICOTAGE MALTERRE SARL',
    iban: '',
    bic: '',
  },
} as const

export const sizes = {
  pagePadding: 36,       // ~12mm
  headerHeight: 90,
  footerHeight: 40,
  logoWidth: 160,
  logoHeight: 52,
  // Typography scale
  fontXs: 7,
  fontSm: 8,
  fontBase: 9,
  fontMd: 10,
  fontLg: 13,
  fontXl: 18,
  font2xl: 24,
  // Spacing scale
  gap1: 2,
  gap2: 4,
  gap3: 8,
  gap4: 12,
  gap5: 16,
  gap6: 24,
} as const
