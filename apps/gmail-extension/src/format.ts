// Pure wording / formatting helpers (French UI, same vocabulary as ETM's
// Agents IA screens: apps/web/src/pages/AgentsIa.tsx, components/agents-ia/Triage.tsx).

import type { Categorie, Conversation, LigneFacture, Message, RunStatut } from './types'

export const STATUT_LABEL: Partial<Record<RunStatut, string>> = {
  ecrit: 'Enregistré',
  simule: 'Simulé',
  a_verifier: 'À vérifier',
  verifie: 'Vérifié',
  deja_importe: 'Déjà importé',
  ignore: 'Ignoré',
  erreur: 'Erreur',
  trie: 'Trié',
}

/** Pill tone of a run statut (sidepanel.css .pill.<tone>). */
export function statutTone(s: RunStatut): 'ok' | 'warn' | 'bad' | 'muted' {
  if (s === 'ecrit' || s === 'verifie' || s === 'trie') return 'ok'
  if (s === 'a_verifier') return 'warn'
  if (s === 'erreur') return 'bad'
  return 'muted'
}

export const TRANSMISSION_LABEL: Record<string, string> = {
  transmis: 'Transmis',
  deja_traite: 'Déjà traité',
  non_transmis: 'Non transmis',
  erreur: 'Erreur',
}

export const ORGANISATION_LABEL: Record<string, string> = {
  interne: 'Interne',
  client: 'Client',
  sous_traitant: 'Sous-traitant',
  fournisseur: 'Fournisseur',
  transporteur: 'Transporteur',
  prospect: 'Prospect',
}

export const TRAITEMENT_LABEL: Record<string, string> = {
  validee: 'Validée',
  reclamee: 'Réclamée',
  reclamation_close: 'Réclamation close',
}

/** The agent's verdict on an invoice line, as Sous-traitants › Factures says it. */
export function verdictLigne(l: Pick<LigneFacture, 'verdict' | 'nature'>): { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (l.verdict === 'info') return { label: 'Info', tone: 'muted' }
  if (l.verdict === 'conforme') return { label: 'Conforme', tone: 'ok' }
  return l.nature === 'non_verifie' ? { label: 'Non vérifié', tone: 'warn' } : { label: 'Écart', tone: 'bad' }
}

export function libelleCategorie(cle: string, categories: readonly Categorie[]): string {
  return categories.find(c => c.cle === cle)?.libelle ?? cle
}

const euro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' })
const nombre = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 })

// Intl uses narrow no-break spaces; plain spaces read the same and test simply.
const plain = (s: string) => s.replace(/[  ]/g, ' ')

export function formatEuro(n: number | null): string {
  return n === null ? '' : plain(euro.format(n))
}

export function formatNombre(n: number | null, unite = ''): string {
  return n === null ? '' : plain(nombre.format(n)) + (unite ? ` ${unite}` : '')
}

export function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** « Céline FERNANDES <mct.celine@…> » → « Céline FERNANDES ». */
export function nomExpediteur(de: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(de)
  return (m && m[1].trim()) || de.replace(/[<>]/g, '').trim()
}

/** Something on this message waits for a person. */
export function aVerifier(m: Message): boolean {
  if (m.triage?.statut === 'erreur') return true
  if (m.bl.some(b => b.statut === 'a_verifier' || b.statut === 'erreur')) return true
  return m.factures.some(f => f.statut === 'erreur' || (f.statut === 'a_verifier' && !f.traitement))
}

export interface BadgeSummary {
  text: string
  /** A BL or an invoice waits for a person. An uncorrected triage counts as right. */
  attention: boolean
}

/** Chip shown next to the Gmail subject. Null when Tricobot never saw the thread. */
export function badgeSummary(conv: Conversation): BadgeSummary | null {
  if (conv.messages.length === 0) return null
  const last = conv.messages[conv.messages.length - 1]
  const parts: string[] = []
  if (last.triage) parts.push(last.triage.categories.map(c => libelleCategorie(c, conv.categories)).join(', '))
  const bl = last.bl.find(b => b.bordereau)
  if (bl) parts.push(`BL ${bl.bordereau}`)
  const facture = last.factures.find(f => f.numero)
  if (facture) parts.push(`facture ${facture.numero}`)
  if (parts.length === 0) parts.push('traité')
  return { text: parts.join(' · '), attention: conv.messages.some(aVerifier) }
}
