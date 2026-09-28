// Agent « BL Ennoblisseur » — one profile per dyer it reads. Pure (no I/O):
// how to recognise the dyer's delivery document in the OCR text, which prompt
// reads it, what its lot is, and what is written. Tests: bl-profils.test.ts.
//
// Investigation 2026-09-28 (mailboxes + ged + stock_fini, 12 months):
//   - MATEL (sst 9): Céline sends ~830 BLs a year to contact@, but also ~1 900
//     mails that are NOT BLs from the same address (palettes, ramasses, replies
//     to our « Expédition N° » / « Soumission Lot » carrying OUR PDFs). The
//     document itself decides, never the sender alone.
//   - Bontemps (sst 38): « BON DE LIVRAISON », Référence = 4-digit BL number,
//     one order per BL, text PDF. Asked on 2026-09-28 to mail contact@.
//   - TAD (sst 6): « BORDEREAU DE LIVRAISON N° 344642 » and « STOCK FINI A
//     DISPOSITION » (same piece table, sent before shipping), one OF per page;
//     also « TAD INFOS CLIENTS » (a 2019 circular) and « PLAN DE CHARGE ».
//     Its weight column is the ÉCRU weight.
//   - Lots follow what Pierrot typed at the réception: MA<BL>, BON<BL>, TA<OF>.
//   - Weight: Malterre weighs the rolls itself (decision Vincent 2026-09-28);
//     only MATEL keeps the dyer's weight, as n8n did.

import { BL_SCHEMA, type BlExtraction, type ReglesControle } from './bl-extraction.js'
import type { AgentMode } from './store.js'

export type ProfilCle = 'matel' | 'bontemps' | 'tad'
/** A delivery note, or TAD's « stock fini à disposition » (the same pieces, before shipping). */
export type TypeDocument = 'bl' | 'mise_a_dispo'

export interface ProfilEnnoblisseur {
  cle: ProfilCle
  nom: string
  idSousTraitant: number
  /** The most this dyer's runs may do: « essai » keeps a new dyer in test
   *  whatever the agent's own mode. Bontemps and TAD went actif straight
   *  after their ged benchmark (decision Vincent, 2026-09-28). */
  modeMax: Exclude<AgentMode, 'off'>
  /** Which of its documents this OCR text is, or null when it is none of them. */
  reconnaitre(ocr: string): TypeDocument | null
  /** null = the agent version's prompt (MATEL, versioned in the Prompt tab). */
  prompt: string | null
  schema: object
  /** The printed bordereau number, once normalised ('' allowed on a mise à dispo). */
  bordereauRe: RegExp
  /** The réception lot, e.g. « MA109152 », « BON3976 », « TA530425 ». '' = unreadable. */
  lot(e: BlExtraction): string
  /** Write the dyer's weight into the réception pre-fill (false = 0, the dialog keeps its own). */
  ecritPoids: boolean
  /** Checks only this dyer needs, on the raw OCR text (several orders on one BL…). */
  controlesTexte?(ocr: string): Array<{ code: string; message: string }>
}

// ── Prompts of the new dyers (MATEL keeps its versioned prompt) ─────────────

export const BL_SCHEMA_ETENDU = {
  ...BL_SCHEMA,
  properties: {
    ...BL_SCHEMA.properties,
    numero_of: { type: 'string' },
    destinataire: { type: 'string' },
  },
  required: [...BL_SCHEMA.required, 'numero_of', 'destinataire'],
} as const

export const PROMPT_BONTEMPS = `Tu extrais les données d'un bon de livraison de l'ennoblisseur BONTEMPS (Villers-Outreaux) adressé à Tricotage Malterre.

Champs :
- numero_commande : le numéro après "Commande N°" (4 chiffres, sans la date "du 15/07").
- numero_bordereau : le numéro après "Référence" (4 chiffres).
- ligne : toujours null.
- pieces : une entrée par ligne du tableau, dans l'ordre.
  - numero_piece : colonne "N° de pièce", exactement tel qu'imprimé (ex. "3533/1").
  - poids : colonne "Poids" en kg, nombre décimal (sans "Kgs").
  - metrage : colonne "Métrage" en mètres, nombre décimal (sans "m").
  - observations : toujours "". N'y mets JAMAIS le texte des traitements ("Déroulage + Teinture + Roulage").
- nombre_pieces : toujours null ("Nombre de colis" n'est pas un nombre de pièces).
- poids_total : "Poids total" de l'en-tête ; metrage_total : "Métrage total" de l'en-tête. null s'ils sont absents.
- numero_of : toujours "".
- destinataire : toujours "".

Ne calcule rien, ne devine rien : recopie ce qui est imprimé. Réponds uniquement avec le JSON.`

export const PROMPT_TAD = `Tu extrais les données d'un document de l'ennoblisseur T.A.D (Teinturerie Apprêts Danjoux) pour Malterre : un "BORDEREAU DE LIVRAISON" ou un "STOCK FINI A DISPOSITION".

Champs :
- numero_commande : "N° commande client" (4 chiffres).
- numero_bordereau : le numéro après "BORDEREAU DE LIVRAISON N°" (6 chiffres). "" sur un "STOCK FINI A DISPOSITION" (le "BORDEREAU" du pied de page n'est PAS ce numéro).
- numero_of : "OF n°" (6 chiffres).
- ligne : toujours null.
- pieces : une entrée par ligne du tableau des pièces, dans l'ordre.
  - numero_piece : colonne "N°PIECES", sans ce qui suit la barre verticale (ex. "3379/80|A" → "3379/80").
  - poids : colonne "POIDS ECRUS", nombre décimal (virgule française convertie en point).
  - metrage : colonne "METR. FINI", nombre décimal.
  - observations : colonne "OBSERVATIONS/VISITE", texte tel quel, "" si vide. Si la colonne "CX" (choix) vaut 2, commence par "2e choix" (ex. "2e choix, 16V *").
- nombre_pieces : le nombre de la ligne de total "N PIECES" ; poids_total : le total de la colonne "POIDS ECRUS" ; metrage_total : le total de la colonne "METR. FINI" (il ne compte que le 1er choix). null s'ils sont absents.
- destinataire : la première ligne du bloc "DESTINATAIRE" (nom de l'entreprise), "" s'il n'y en a pas.

Ne calcule rien, ne devine rien : recopie ce qui est imprimé. Réponds uniquement avec le JSON.`

// ── Profiles ────────────────────────────────────────────

const chiffres = (s: string, n: number) => new RegExp(`^(\\d{${n}})`).exec(s)?.[1] ?? ''

export const PROFILS: readonly ProfilEnnoblisseur[] = [
  {
    cle: 'tad',
    nom: 'TAD',
    idSousTraitant: 6,
    modeMax: 'actif',
    // TAD's BL also says « BORDEREAU DE LIVRAISON » (like MATEL's): it is told
    // apart by its « OF n° » and the écru / fini columns. Checked before MATEL.
    reconnaitre: (t) =>
      /STOCK\s+FINI\s+A\s+DISPOSITION/i.test(t) ? 'mise_a_dispo'
      : /BORDEREAU\s+DE\s+LIVRAISON/i.test(t) && /OF\s*n\s*°/i.test(t) && /ECRUS/i.test(t) ? 'bl'
      : null,
    prompt: PROMPT_TAD,
    schema: BL_SCHEMA_ETENDU,
    bordereauRe: /^(\d{6})?$/,
    lot: (e) => (chiffres(e.numero_of, 6) ? `TA${chiffres(e.numero_of, 6)}` : ''),
    ecritPoids: false,
  },
  {
    cle: 'matel',
    nom: 'MATEL',
    idSousTraitant: 9,
    modeMax: 'actif',
    reconnaitre: (t) => (/BORDEREAU\s+DE\s+LIVRAISON/i.test(t) && /MATEL/i.test(t) ? 'bl' : null),
    prompt: null,
    schema: BL_SCHEMA,
    bordereauRe: /^\d{6}[A-Z]?$/,
    lot: (e) => (chiffres(e.numero_bordereau, 6) ? `MA${chiffres(e.numero_bordereau, 6)}` : ''),
    ecritPoids: true,
  },
  {
    cle: 'bontemps',
    nom: 'Bontemps',
    idSousTraitant: 38,
    modeMax: 'actif',
    reconnaitre: (t) =>
      /BON\s+DE\s+LIVRAISON/i.test(t) && /VILLERS[\s-]+OUTREAUX|943\s?934\s?489|BONTEMPS/i.test(t) ? 'bl' : null,
    prompt: PROMPT_BONTEMPS,
    schema: BL_SCHEMA_ETENDU,
    bordereauRe: /^\d{4}$/,
    lot: (e) => (chiffres(e.numero_bordereau, 4) ? `BON${chiffres(e.numero_bordereau, 4)}` : ''),
    ecritPoids: false,
    // The table opens with « Commande N°8565 du 19/03 »: a second one would put
    // two orders on one BL, which the agent does not split.
    controlesTexte: (t) => {
      const cmds = new Set([...t.matchAll(/Commande\s+N\s*°\s*(\d{4})/gi)].map((m) => m[1]))
      return cmds.size > 1
        ? [{ code: 'plusieurs_commandes', message: `Ce BL porte plusieurs commandes (${[...cmds].join(', ')}) : à réceptionner à la main.` }]
        : []
    },
  },
]

export const profilDe = (cle: string | null | undefined) => PROFILS.find((p) => p.cle === cle) ?? null
export const profilDuSousTraitant = (id: number) => PROFILS.find((p) => p.idSousTraitant === id) ?? null

/** Which dyer's document this is, from its OCR text alone. */
export function detecterProfil(ocr: string): { profil: ProfilEnnoblisseur; type: TypeDocument } | null {
  for (const profil of PROFILS) {
    const type = profil.reconnaitre(ocr)
    if (type) return { profil, type }
  }
  return null
}

/** The mode a run of this dyer really has. */
export function modeEffectif(mode: AgentMode, profil: ProfilEnnoblisseur): AgentMode {
  return mode === 'actif' && profil.modeMax === 'essai' ? 'essai' : mode
}

/** ged name of the document on the order: the BL is `<lot>.pdf` (as n8n named
 *  MATEL's), TAD's mise à dispo `<lot>-dispo.pdf` (the BL of the same OF follows). */
export function nomGed(lot: string, type: TypeDocument): string {
  return type === 'mise_a_dispo' ? `${lot}-dispo` : lot
}

// ── Mailbox: who to read, which attachments ─────────────

/** Mail providers shared by many people: filter on the full address, never the domain. */
const DOMAINES_GENERIQUES = /^(wanadoo|orange|free|sfr|laposte|gmail|googlemail|hotmail|outlook|live|yahoo|icloud|aol|neuf|bbox|numericable)\./i

/** Gmail `from:` terms for the dyers' contacts: their company domain (any
 *  MATEL address counts, not only Céline's), or the full address on a public
 *  provider (bontemps.maurice@wanadoo.fr). Sorted, deduplicated. */
export function termesExpediteurs(mails: readonly string[]): string[] {
  const out = new Set<string>()
  for (const m of mails) {
    const a = m.trim().toLowerCase().replace(/\.+$/, '')
    const at = a.lastIndexOf('@')
    if (at < 1 || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(a.slice(at + 1))) continue
    const domaine = a.slice(at + 1)
    out.add(DOMAINES_GENERIQUES.test(domaine) ? a : `@${domaine}`)
  }
  return [...out].sort()
}

/** Whether `de` (a From header) matches one of the terms. */
export function correspond(de: string, termes: readonly string[]): boolean {
  const a = (/<([^>]+)>/.exec(de)?.[1] ?? de).trim().toLowerCase()
  return termes.some((t) => (t.startsWith('@') ? a.endsWith(t) : a === t))
}

/** The dyer a mail comes from, by its contacts (null = none of them). */
export function sousTraitantExpediteur(de: string, contacts: ReadonlyArray<{ mail: string; idSousTraitant: number }>): number | null {
  for (const c of contacts) {
    const [t] = termesExpediteurs([c.mail])
    if (t && correspond(de, [t])) return c.idSousTraitant
  }
  return null
}

/** Gmail search terms: `from:` takes a bare domain. */
export const requeteExpediteurs = (termes: readonly string[]) => `from:(${termes.map((t) => t.replace(/^@/, '')).join(' OR ')})`

/** An attachment worth reading: a PDF that is not one of OUR documents sent
 *  back in a reply (avis d'expédition « BL-12204.pdf », soumission de lot,
 *  logo) nor an invoice. The OCR decides for the rest. */
export function estPieceCandidate(p: { nom: string; mimeType: string }): boolean {
  const pdf = p.mimeType === 'application/pdf' || /\.pdf$/i.test(p.nom)
  if (!pdf) return false
  return !/^BL-\d+\.pdf$|soumission|^logo|factur|^FA\d|avoir|\bRIB\b/i.test(p.nom)
}

/** MATEL's prompt is the agent version's one; the others ship with the code. */
export function promptDe(profil: ProfilEnnoblisseur, promptVersion: string): string {
  return profil.prompt ?? promptVersion
}

/** The per-dyer rules controlerExtraction() applies. */
export function reglesDe(profil: ProfilEnnoblisseur): ReglesControle {
  return { bordereauRe: profil.bordereauRe, ofRequis: profil.cle === 'tad', poidsUtile: profil.ecritPoids }
}
