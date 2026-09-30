// The legal line printed under the totals of a document at 0 % VAT (LIVA #1248).
//
// A French invoice without VAT must say WHY (CGI annexe II art. 242 nonies A):
// the exemption's legal basis. Until #1248 the client PDFs dropped the TVA and
// TTC rows at 0 % and ended on « TOTAL HT » with no reason at all — a client
// (SOFILETA, Laetitia 2026-09-30) read that as an unfinished invoice. Since
// then every 0 % document keeps « TVA (0 %) · 0,00 € » and « TOTAL TTC », and
// prints the line this module picks.
//
// The reason depends on where the goods go, read from the document's own
// billing address (`adresse.pays`, free text — see lib/pays.ts):
//   - another EU member state → intra-community delivery, art. 262 ter I;
//   - outside the EU (Maroc, Suisse, Royaume-Uni, DOM…) → export, art. 262 I;
//   - France (or no country) → no automatic reason. A French customer at 0 %
//     is exempt for a reason only the customer file knows — an exporter
//     buying under franchise with a yearly attestation (SOFILETA, art. 275),
//     a recycler under reverse charge (art. 283-2 sexies)… — so the mention is
//     CHOSEN in Clients › Gestion and stored per client
//     (lib/tva-exoneration-store.ts). Unchosen → no line; the TRM fiche refuses
//     to save a French 0 % client without one.
//
// Pure: no I/O, tested in tva-mention.test.ts.

export const MENTION_UE = 'Exonération de TVA, article 262 ter I du CGI'
export const MENTION_EXPORT = 'Exonération de TVA, article 262 I du CGI'

/** The mentions offered for a French client at 0 %, in the fiche's picker.
 *  `autre` = free text typed by the user. The code is stored with the text so
 *  a later rewording of a preset does not silently change past choices. */
export const MENTIONS_FRANCE = [
  {
    code: 'franchise_275',
    libelle: 'Franchise (attestation)',
    texte: 'Vente en franchise de TVA, article 275 du CGI',
  },
  {
    code: 'autoliquidation_dechets',
    libelle: 'Autoliquidation (déchets)',
    texte: 'Autoliquidation, article 283-2 sexies du CGI',
  },
  {
    code: 'autre',
    libelle: 'Autre mention',
    texte: '',
  },
] as const

export type MentionFranceCode = (typeof MENTIONS_FRANCE)[number]['code']

export interface MentionClient {
  code: MentionFranceCode
  texte: string
}

export type ZoneTva = 'france' | 'ue' | 'hors_ue'

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z]+/g, ' ').trim()
}

// Folded spellings found in `adresse.pays` (2026-09-30 dev snapshot) plus the
// usual French / English / native names. Monaco is inside the French VAT
// territory. Anything unrecognised that is not French is treated as export —
// a typo there prints the export article, never no reason at all.
const FRANCE = new Set(['', 'france', 'fr', 'francia', 'monaco', 'paris', 'drance', 'metropole'])

const UE = new Set([
  'allemagne', 'germany', 'deutschland',
  'autriche', 'austria', 'osterreich',
  'belgique', 'belgium', 'belgie', 'belgien',
  'bulgarie', 'bulgaria',
  'chypre', 'cyprus',
  'croatie', 'croatia', 'hrvatska',
  'danemark', 'denmark', 'danmark',
  'espagne', 'spain', 'espana',
  'estonie', 'estonia',
  'finlande', 'finland', 'suomi',
  'grece', 'greece',
  'hongrie', 'hungary', 'magyarorszag',
  'irlande', 'ireland', 'eire',
  'italie', 'italy', 'italia',
  'lettonie', 'latvia',
  'lituanie', 'lithuania',
  'luxembourg',
  'malte', 'malta',
  'pays bas', 'netherlands', 'nederland', 'hollande', 'holland',
  'pologne', 'poland', 'polska',
  'portugal',
  'republique tcheque', 'tchequie', 'czech republic', 'czechia',
  'roumanie', 'romania',
  'slovaquie', 'slovakia',
  'slovenie', 'slovenia',
  'suede', 'sweden', 'sverige',
])

/** Where a document's goods go, VAT-wise, from its billing country. */
export function zoneTva(pays: string | null | undefined): ZoneTva {
  const v = fold(String(pays ?? ''))
  if (FRANCE.has(v) || v === '-' || v === '1') return 'france'
  if (UE.has(v)) return 'ue'
  return 'hors_ue'
}

/** The text a stored client choice prints: the preset's current wording, or
 *  the free text for `autre`. Empty when nothing usable is stored. */
export function texteMentionClient(m: MentionClient | null | undefined): string {
  if (!m) return ''
  if (m.code === 'autre') return (m.texte ?? '').trim()
  return MENTIONS_FRANCE.find((p) => p.code === m.code)?.texte ?? (m.texte ?? '').trim()
}

/** The line to print under the totals, or null when the document carries VAT
 *  (or is a French 0 % document whose client has no mention chosen). */
export function mentionTva(opts: {
  tvaRate: number
  pays: string | null | undefined
  client: MentionClient | null | undefined
}): string | null {
  if ((Number(opts.tvaRate) || 0) !== 0) return null
  const zone = zoneTva(opts.pays)
  if (zone === 'ue') return MENTION_UE
  if (zone === 'hors_ue') return MENTION_EXPORT
  return texteMentionClient(opts.client) || null
}
