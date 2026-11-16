// Tombé Métier › Échantillons — the rules of a sample's life, kept apart from
// the route so they can be tested without a database.
//
// A sample (`ref_echantillon`) is a trial écru fabric knitted before it is a
// reference: its own tables, its own cycle (claude_doc/echantillons_plan.md).
// While it is a laboratory trial it lives apart from `ref_ecru`. The day it
// goes to an INDUSTRIAL trial it needs what only a reference has — a knitting
// order, an OF, stock, a dyer order — so it creates its provisional reference
// (`ref_ecru.essai = 1`, named like the sample, `idref_ecru` pointing at it;
// LIVA #1370). The cycle then ends in one of two ways: « retenu », the
// provisional reference is renamed and loses its flag (pieces, OFs and lots
// follow, nothing to convert), or archived together with its reference.

export type StatutEchantillon = 'en_cours' | 'essai' | 'reference' | 'archive'

/** `ref_essai` = the linked reference's `essai` flag (0 once retained).
 *  « Devenu référence » wins over the archive flag: a passage archives the
 *  sample too, but what the user needs to know is which reference it became.
 *  An abandoned industrial trial keeps its link and its flag: archived. */
export function statutEchantillon(e: { archive: number | null; idref_ecru: number | null; ref_essai?: number | null }): StatutEchantillon {
  const lie = (Number(e.idref_ecru) || 0) > 0
  const essai = lie && !!Number(e.ref_essai)
  if (lie && !essai) return 'reference'
  if (Number(e.archive)) return 'archive'
  if (essai) return 'essai'
  return 'en_cours'
}

/** Still followed (editable, relances): the laboratory trial and the industrial one. */
export function estSuivi(statut: StatutEchantillon): boolean {
  return statut === 'en_cours' || statut === 'essai'
}

/** The technical sheet (contexture, jauge, Ø, LFA, laize + poids TBM,
 *  composition) lives on the linked reference while that one is an essai —
 *  ONE recipe, the one the OF reads. The sample's own columns are then a
 *  stale copy until « retenu » writes the retained sheet back as a snapshot. */
export function ficheSurReference(e: { idref_ecru: number | null; ref_essai?: number | null }): boolean {
  return (Number(e.idref_ecru) || 0) > 0 && !!Number(e.ref_essai)
}

/** The sample's display number: « E055 ». It has no name of its own — the
 *  legacy shows the bare id; the E keeps it apart from a reference number. */
export function numeroEchantillon(id: number): string {
  return `E${String(id).padStart(3, '0')}`
}

/** `fil_ref_echantillon.pourcentage` is a FRACTION (0..1) while
 *  `composition_ecru.pourcentage` is a percentage (0..100). The API speaks
 *  percentages only; these two are the only crossings. */
export function fractionVersPourcent(f: number | null | undefined): number {
  return Math.round((Number(f) || 0) * 100 * 1000) / 1000
}
export function pourcentVersFraction(p: number): number {
  return Math.round((Number(p) || 0) * 1000) / 100000
}

/** A composition is valid empty (not entered yet) or totalling 100 %. */
export function compositionComplete(pourcents: number[]): boolean {
  if (pourcents.length === 0) return true
  const total = pourcents.reduce((s, p) => s + (Number(p) || 0), 0)
  return Math.abs(total - 100) < 0.01
}

/** `ref_echantillon.lfa1..4` are numbers, `ref_ecru.lfa_tour_1..4` text written
 *  « 7.50 » by the legacy; 0 / empty stays empty. */
export function lfaTexte(v: number | null | undefined): string {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : ''
}

/** Jauge / diamètre are 1-based ordinals of the legacy combos on both tables
 *  (2..5 / 2..3); the legacy left 65535 (and -1) on unset rows. Keep only a
 *  real choice, 0 otherwise. */
export function ordinalValide(v: number | null | undefined, max: number): number {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= max ? n : 0
}
export const JAUGE_ORD_MAX = 5
export const DIAMETRE_ORD_MAX = 3

/** Display labels of the ordinals, as the web's `pages/tombe-metier/ordinals.ts`
 *  (jauge = needles per inch, Ø in inches). Null when not set. */
const JAUGE_LIBELLES: Record<number, string> = { 2: '14', 3: '18', 4: '20', 5: '28' }
const DIAMETRE_LIBELLES: Record<number, string> = { 2: '26"', 3: '30"' }
export const jaugeLibelle = (ord: number | null | undefined): string | null => JAUGE_LIBELLES[Number(ord)] ?? null
export const diametreLibelle = (ord: number | null | undefined): string | null => DIAMETRE_LIBELLES[Number(ord)] ?? null

/** Why a sample cannot become a reference, or null when it can — from the
 *  laboratory (a new reference is created) or from its industrial trial (the
 *  provisional reference is renamed). `pourcents` = the composition that will
 *  be the reference's: the sample's, or the provisional reference's. */
export function refusCreationReference(
  e: { archive: number | null; idref_ecru: number | null; ref_essai?: number | null },
  pourcents: number[],
): 'deja_reference' | 'archive' | 'composition_incomplete' | null {
  const statut = statutEchantillon(e)
  if (statut === 'reference') return 'deja_reference'
  if (statut === 'archive') return 'archive'
  if (!compositionComplete(pourcents)) return 'composition_incomplete'
  return null
}

/** Why a sample cannot start its industrial trial, or null when it can. */
export function refusEssaiIndustriel(
  e: { archive: number | null; idref_ecru: number | null; ref_essai?: number | null },
  pourcents: number[],
): 'deja_reference' | 'deja_essai' | 'archive' | 'composition_incomplete' | null {
  const statut = statutEchantillon(e)
  if (statut === 'reference') return 'deja_reference'
  if (statut === 'essai') return 'deja_essai'
  if (statut === 'archive') return 'archive'
  if (!compositionComplete(pourcents)) return 'composition_incomplete'
  return null
}

/** `ref_ecru.lfa_tour_N` (text « 7.50 », sometimes « 7,5 ») back to a number. */
export function lfaNombre(v: string | number | null | undefined): number {
  const n = Number(String(v ?? '').trim().replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** The name a fini of the provisional reference takes when that one is
 *  retained: « E055A » → « 104A », « E055 lavé » → « 104 lavé ». Null when the
 *  fini is not named after the provisional reference — it is left alone. */
export function nomFiniRetenu(ancienneRef: string, nouvelleRef: string, nomFini: string): string | null {
  const ancien = ancienneRef.trim()
  const nom = nomFini.trim()
  if (!ancien || !nouvelleRef.trim()) return null
  if (nom.toLowerCase().slice(0, ancien.length) !== ancien.toLowerCase()) return null
  const reste = nom.slice(ancien.length)
  // « E0551 » is another name, not « E055 » + a suffix.
  if (/^\d/.test(reste)) return null
  return `${nouvelleRef.trim()}${reste}`
}

// ── Real pieces of the industrial trial ──

export interface PieceStockFaits {
  /** stock_ecru.idsociete: 2 = still Tricotage Malterre's. */
  idsociete: number
  /** Where it physically is: 0 = the factory, else a sous-traitant. */
  magasin_nom: string | null
  expediee: boolean
  donnee: boolean
  /** Dyer order line it is affected to (not yet received back). */
  ennoblisseur: { nom: string | null; commande: number } | null
  /** Fini roll(s) it became. */
  fini: { lot: string | null; reference: string | null } | null
}

/** Where a trial piece stands, in the words of the screens it is read on, and
 *  whether it is still physically ours (what an abandon must warn about). */
export function situationPiece(p: PieceStockFaits): { libelle: string; enStock: boolean } {
  if (p.fini) {
    const quoi = [p.fini.reference, p.fini.lot ? `lot ${p.fini.lot}` : null].filter(Boolean).join(' · ')
    return { libelle: quoi ? `Ennoblie (${quoi})` : 'Ennoblie', enStock: false }
  }
  if (p.donnee) return { libelle: 'Donnée', enStock: false }
  if (p.expediee) return { libelle: 'Expédiée', enStock: false }
  if (p.ennoblisseur) {
    return { libelle: `En ennoblissement chez ${p.ennoblisseur.nom ?? 'le sous-traitant'} (commande ${p.ennoblisseur.commande})`, enStock: true }
  }
  if (p.idsociete === 2) return { libelle: 'Chez Tricotage Malterre', enStock: true }
  return { libelle: `En stock · ${p.magasin_nom ?? 'Malterre'}`, enStock: true }
}

// ── Relance (follow-up of the research, Vincent 2026-10-21) ──

/** Days between a sample's creation (or a relance done) and the next one. */
export const DELAI_RELANCE_JOURS = 30
/** Amber from this many days before the relance date. */
export const AMBRE_JOURS = 7

export type UrgenceRelance = 'retard' | 'bientot'

/** Whole days from `aujourdhui` to `date` (YYYY-MM-DD), negative when past. */
export function joursAvant(date: string, aujourdhui: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`) - Date.parse(`${aujourdhui}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}

/** Red from the relance date on, amber within the 7 days before, nothing
 *  otherwise — and only on a followed sample (laboratory or industrial
 *  trial): one kept or archived is no longer followed. No date on an open sample = nothing to say (the migration gave
 *  every open sample one; a cleared date is a deliberate choice). */
export function urgenceRelance(
  e: { statut: StatutEchantillon; date_relance: string | null },
  aujourdhui: string,
): { urgence: UrgenceRelance | null; jours: number | null } {
  if (!estSuivi(e.statut) || !e.date_relance) return { urgence: null, jours: null }
  const jours = joursAvant(e.date_relance, aujourdhui)
  if (jours <= 0) return { urgence: 'retard', jours }
  if (jours <= AMBRE_JOURS) return { urgence: 'bientot', jours }
  return { urgence: null, jours }
}

/** `date` + n days, YYYY-MM-DD. */
export function ajouterJours(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Today in the factory's time zone, YYYY-MM-DD (the server may run in UTC). */
export function aujourdhuiParis(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(now)
}
