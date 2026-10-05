// Agent « Factures Ennoblisseur » — the pure half of the reading: which dyer
// sent the invoice, the prompt + strict JSON schema the model fills, the
// normalisation of what it returns, and the checks that say whether the
// reading itself can be trusted. No I/O here (tests: extraction.test.ts).
//
// Investigation 2026-10-02 (LIVA #1255, mailboxes contact@ + Pierre-Emmanuel):
//   - MATEL (sst 9) mails ~2 invoices a month to contact@, one text PDF
//     « Facture - FA2974.pdf ». One line per lot: DESCRIPTION (coloris),
//     Teinture et Finition (treatments), Qualité (MATEL's code of our ref),
//     Qté + Unité (Kg), BON MATEL (= the lot, « MA » + n° in ETM), BON CLIENT
//     (= our sst order), Pièces, Prix Uni.HT (€/Kg), Mt Tot HT. A lot may take
//     two lines (part of it calendered, « ST + CAL »). Then packaging
//     (« TUBES ET EMBALLAGES » × pieces), transport (« EXAPAQ … ») and, after
//     a dispute, a « remise » deducted from the next invoice.
//   - Bontemps (sst 38): printing, priced per m² / ML, « BL 3976/29.07 » +
//     « COMMANDE 8945 » above its lines; went to Pierre-Emmanuel's mailbox
//     from 12/2025, to be sent to contact@ again.
//   - TAD (sst 6): no invoice by mail in two years.

export const FACTURE_PROMPT_V1 = `Tu extrais les données d'une facture d'un ennoblisseur (teinturier, finisseur, imprimeur) adressée à Malterre (ETS MALTERRE ou TRICOTAGE MALTERRE).

En-tête :
- fournisseur : le nom de l'entreprise qui facture, tel qu'imprimé (ex. "MATEL COULEURS TEXTILES", "BONTEMPS ENNOBLISSEMENT").
- type_document : "facture", ou "avoir" si le document est un avoir.
- numero_facture : le numéro de la facture tel qu'imprimé, sans espace (ex. "FA2865", "FA00000522").
- date_facture, date_echeance : au format JJ/MM/AAAA, "" si absente.
- total_ht : le "Net HT" (après remise) s'il est imprimé, sinon le "Total HT" ; total_ttc : le "Total TTC" (ou "Net à payer"). null si absent.

lignes : une entrée par ligne facturée du tableau, dans l'ordre, sur toutes les pages. Ignore les lignes d'en-tête répétées et les lignes de sous-total (sans désignation, qui ne font qu'additionner les quantités).
- description : la désignation (colonne DESCRIPTION, Description ou Code), texte tel quel.
- traitements : la colonne "Teinture et Finition" (ex. "ST + OR", "PREF&ST&OR"), "" si absente.
- qualite : la colonne "Qualité" (ex. "180", "029A", "180 CAL"), "" si absente.
- quantite : la quantité facturée (colonne Qté, ou TOTAL), nombre décimal (virgule française convertie en point, espaces des milliers retirés).
- unite : l'unité imprimée (ex. "Kg", "ML", "M2"), "" si absente.
- lot : le numéro de lot ou de bon du fournisseur (MATEL : colonne "BON MATEL" ; BONTEMPS : le numéro de BL de la ligne "BL 3976/29.07" qui précède, ici "3976"), "" si absent.
- numero_commande : notre numéro de commande (MATEL : colonne "BON CLIENT" ; BONTEMPS : la ligne "COMMANDE 8945" qui précède, ici "8945"), "" si absent.
- pieces : le nombre de pièces (colonne Pièces), null si absent.
- prix_unitaire : le prix unitaire HT (colonne Prix Uni.HT ou P.U. HT), nombre décimal.
- montant : le montant HT de la ligne (colonne Mt Tot HT ou Montant HT), nombre décimal, négatif pour une remise.
- genre : "lot" pour une prestation sur un lot ou une commande (teinture, finition, impression…), "emballage" pour les tubes et emballages, "transport" pour le transport ou la messagerie (EXAPAQ, DPD…), "remise" pour une remise, un avoir déduit ou une réduction, "autre" sinon.

Cas particuliers :
- Une remise imprimée dans le cadre des totaux (ex. une ligne "Remise | 227,00" à côté du Total HT) est AUSSI une ligne : description "Remise", genre "remise", montant négatif (-227), quantite et prix_unitaire null.
- Une ligne offerte ou non facturée (ex. "SANS MAJORATION EN GUISE DE GESTE…", "NON FACTURABLE") : recopie-la avec prix_unitaire null et montant null.

Ne calcule rien, ne devine rien : recopie ce qui est imprimé. Réponds uniquement avec le JSON.`

export const FACTURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fournisseur: { type: 'string' },
    type_document: { type: 'string', enum: ['facture', 'avoir'] },
    numero_facture: { type: 'string' },
    date_facture: { type: 'string' },
    date_echeance: { type: 'string' },
    total_ht: { type: ['number', 'null'] },
    total_ttc: { type: ['number', 'null'] },
    lignes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string' },
          traitements: { type: 'string' },
          qualite: { type: 'string' },
          quantite: { type: ['number', 'null'] },
          unite: { type: 'string' },
          lot: { type: 'string' },
          numero_commande: { type: 'string' },
          pieces: { type: ['number', 'null'] },
          prix_unitaire: { type: ['number', 'null'] },
          montant: { type: ['number', 'null'] },
          genre: { type: 'string', enum: ['lot', 'emballage', 'transport', 'remise', 'autre'] },
        },
        required: ['description', 'traitements', 'qualite', 'quantite', 'unite', 'lot', 'numero_commande', 'pieces', 'prix_unitaire', 'montant', 'genre'],
      },
    },
  },
  required: ['fournisseur', 'type_document', 'numero_facture', 'date_facture', 'date_echeance', 'total_ht', 'total_ttc', 'lignes'],
} as const

export type GenreLigne = 'lot' | 'emballage' | 'transport' | 'remise' | 'autre'

export interface LigneFactureLue {
  description: string
  traitements: string
  qualite: string
  quantite: number | null
  unite: string
  /** As printed (« 108406 », « 3976 »); the ETM lot adds the dyer's prefix. */
  lot: string
  numero_commande: string
  pieces: number | null
  prix_unitaire: number | null
  montant: number | null
  genre: GenreLigne
}

export interface FactureLue {
  fournisseur: string
  type_document: 'facture' | 'avoir'
  numero_facture: string
  /** ISO YYYY-MM-DD, '' when unreadable. */
  date_facture: string
  date_echeance: string
  total_ht: number | null
  total_ttc: number | null
  lignes: LigneFactureLue[]
}

// ── Dyers ────────────────────────────────────────────────

export type FournisseurCle = 'matel' | 'bontemps' | 'tad'

export interface Fournisseur {
  cle: FournisseurCle
  nom: string
  idSousTraitant: number
  /** Recognises the dyer in the OCR text of its own invoice. */
  re: RegExp
  /** The réception lot in ETM from the printed one (bl-profils.ts: MA<BL>, BON<BL>, TA<OF>). */
  lotEtm(lot: string): string
  /** Prices are checked against ETM's tariff (lib/pricing-sst.ts). MATEL
   *  only for now: Bontemps prints per m² / ML, outside that tariff. */
  controlePrix: boolean
}

const chiffres = (s: string) => (s.match(/\d+/)?.[0] ?? '')

export const FOURNISSEURS: readonly Fournisseur[] = [
  { cle: 'matel', nom: 'MATEL', idSousTraitant: 9, re: /MATEL\s+COULEURS\s+TEXTILES/i, lotEtm: (l) => (chiffres(l) ? `MA${chiffres(l)}` : ''), controlePrix: true },
  { cle: 'bontemps', nom: 'Bontemps', idSousTraitant: 38, re: /BONTEMPS\s+ENNOBLISSEMENT/i, lotEtm: (l) => (chiffres(l) ? `BON${chiffres(l)}` : ''), controlePrix: false },
  { cle: 'tad', nom: 'TAD', idSousTraitant: 6, re: /\bDANJOUX\b|\bTEINTURERIE\s+ET\s+APPR[EÊ]TS\s+DANJOUX\b/i, lotEtm: (l) => (chiffres(l) ? `TA${chiffres(l)}` : ''), controlePrix: false },
]

export const fournisseurDe = (cle: string | null | undefined) => FOURNISSEURS.find((f) => f.cle === cle) ?? null
export const fournisseurDuSousTraitant = (id: number) => FOURNISSEURS.find((f) => f.idSousTraitant === id) ?? null

/** The dyer whose invoice this OCR text is, or null when it is no invoice
 *  (a BL, a price list, our own document sent back…). The invoice must name
 *  itself so: a BL quoting « facture » in its conditions is not one. */
export function reconnaitreFacture(ocr: string): Fournisseur | null {
  const head = ocr.slice(0, 3000)
  if (!/\bFACTURE\b|\bFacture\s+N°/i.test(head)) return null
  if (/BORDEREAU\s+DE\s+LIVRAISON|BON\s+DE\s+LIVRAISON/i.test(head) && !/Facture\s+N°|##\s*Facture/i.test(head)) return null
  return FOURNISSEURS.find((f) => f.re.test(ocr)) ?? null
}

/** An attachment worth reading: a PDF whose name looks like an invoice. The
 *  OCR still decides (reconnaitreFacture). The mirror of the BL agent's
 *  estPieceCandidate(), which sets exactly these aside. */
export function estFactureCandidate(p: { nom: string; mimeType: string }): boolean {
  const pdf = p.mimeType === 'application/pdf' || /\.pdf$/i.test(p.nom)
  return pdf && /factur|^FA\d|\bFA\d{3,}/i.test(p.nom)
}

// ── Normalisation ────────────────────────────────────────

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.replace(/[\s €]/g, '').replace(',', '.')
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  return Number(s)
}

const txt = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

/** « 15/05/2026 » → « 2026-05-15 »; anything else → ''. */
export function dateIso(s: string): string {
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s.trim())
  if (!m) return ''
  const y = m[3].length === 2 ? `20${m[3]}` : m[3]
  const d = Number(m[1])
  const mo = Number(m[2])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return ''
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const GENRES: readonly GenreLigne[] = ['lot', 'emballage', 'transport', 'remise', 'autre']

export function normaliserFacture(data: unknown): FactureLue {
  const d = (data ?? {}) as Record<string, unknown>
  const lignes = Array.isArray(d.lignes) ? d.lignes : []
  return {
    fournisseur: txt(d.fournisseur),
    type_document: d.type_document === 'avoir' ? 'avoir' : 'facture',
    numero_facture: txt(d.numero_facture).replace(/\s+/g, '').toUpperCase(),
    date_facture: dateIso(txt(d.date_facture)),
    date_echeance: dateIso(txt(d.date_echeance)),
    total_ht: num(d.total_ht),
    total_ttc: num(d.total_ttc),
    lignes: lignes
      .map((l) => {
        const r = (l ?? {}) as Record<string, unknown>
        let genre = GENRES.includes(r.genre as GenreLigne) ? (r.genre as GenreLigne) : 'autre'
        let montant = num(r.montant)
        const description = txt(r.description)
        // A deduction whatever the model called it: a negative amount, or a
        // « Remise » printed positive in the totals box (FA2854: « Remise | 227,00 »).
        if ((montant != null && montant < 0) || (genre === 'autre' && /^remise\b|^avoir\b/i.test(description))) genre = 'remise'
        if (genre === 'remise' && montant != null) montant = -Math.abs(montant)
        return {
          description,
          traitements: txt(r.traitements),
          qualite: txt(r.qualite),
          quantite: num(r.quantite),
          unite: txt(r.unite),
          lot: txt(r.lot).replace(/\s+/g, ''),
          numero_commande: chiffres(txt(r.numero_commande)),
          pieces: num(r.pieces),
          prix_unitaire: num(r.prix_unitaire),
          montant,
          genre,
        } satisfies LigneFactureLue
      })
      // A sub-total row the model kept anyway: no designation, no amount.
      .filter((l) => l.description !== '' || l.montant != null),
  }
}

// ── Checks on the reading itself ─────────────────────────

/** A line printed with neither price nor amount: offered, or a comment. */
export const estOfferte = (l: LigneFactureLue) => l.montant == null && l.prix_unitaire == null

export type Gravite = 'bloquant' | 'avertissement' | 'info'

export interface Controle {
  code: string
  gravite: Gravite
  message: string
}

const eur = (n: number) => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const round2 = (n: number) => Math.round(n * 100) / 100

/** Whether the numbers read hang together: every line's amount = quantity ×
 *  unit price, and the lines add up to the printed total. A bloquant check
 *  here means the reading is not trusted: the invoice is stored for a person
 *  to look at, nothing is pointed on the orders. */
export function controlerLecture(f: FactureLue): Controle[] {
  const out: Controle[] = []
  if (!/^[A-Z0-9][A-Z0-9/-]{1,}$/.test(f.numero_facture)) {
    out.push({ code: 'numero', gravite: 'bloquant', message: `Numéro de facture illisible (« ${f.numero_facture || '—'} »).` })
  }
  if (f.lignes.length === 0) out.push({ code: 'lignes', gravite: 'bloquant', message: 'Aucune ligne lue sur la facture.' })
  f.lignes.forEach((l, i) => {
    // Offered or not billed (FA2841: « SANS MAJORATION EN GUISE DE GESTE »,
    // « NON FACTURABLE »): no price, no amount — nothing misread.
    if (estOfferte(l)) return
    if (l.montant == null) {
      out.push({ code: 'ligne_montant', gravite: 'bloquant', message: `Ligne ${i + 1} (${l.description || '—'}) : montant illisible.` })
      return
    }
    if (l.quantite != null && l.prix_unitaire != null) {
      const calc = round2(l.quantite * l.prix_unitaire)
      // 2 centimes: the dyer may round the product its own way.
      if (Math.abs(calc - Math.abs(l.montant)) > 0.02 && Math.abs(calc - l.montant) > 0.02) {
        out.push({
          code: 'ligne_calcul',
          gravite: 'bloquant',
          message: `Ligne ${i + 1} (${l.description || '—'}) : ${l.quantite} × ${eur(l.prix_unitaire)} = ${eur(calc)} €, la facture porte ${eur(l.montant)} €.`,
        })
      }
    }
  })
  if (f.total_ht == null) {
    out.push({ code: 'total', gravite: 'bloquant', message: 'Total HT illisible.' })
  } else if (f.lignes.every((l) => l.montant != null)) {
    const somme = round2(f.lignes.reduce((s, l) => s + (l.montant ?? 0), 0))
    // The total read may be the « Total HT » printed BEFORE the remise of the
    // totals box rather than the « Net HT » (FA2854: 51 554,86 − 227 = 51 327,86).
    const avantRemise = round2(f.lignes.filter((l) => l.genre !== 'remise').reduce((s, l) => s + (l.montant ?? 0), 0))
    if (Math.abs(somme - f.total_ht) > 0.05 && Math.abs(avantRemise - f.total_ht) > 0.05) {
      out.push({ code: 'total', gravite: 'bloquant', message: `Les lignes lues totalisent ${eur(somme)} € HT, la facture ${eur(f.total_ht)} € : une ligne manque ou est mal lue.` })
    }
  }
  return out
}

export const estBloquant = (cs: readonly Controle[]) => cs.some((c) => c.gravite === 'bloquant')
