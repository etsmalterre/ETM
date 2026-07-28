// Ticket reporting — types + fixed semantic palette shared with the LIVA
// issue tracker. The severity/status colors are deliberately hardcoded (not
// host-themed): they must read the same in the tracker dashboard and in
// every integrated app. Enum values are tracker-internal ids; the French
// labels below are the display layer.

export type TicketCategory = 'bug' | 'fonctionnalite'

export type TicketSeverity =
  | 'critique'
  | 'majeur'
  | 'mineur'
  | 'cosmetique'
  | 'haute'
  | 'moyenne'
  | 'basse'

export type TicketStatus =
  | 'nouveau'
  | 'pris_en_compte'
  | 'en_cours'
  | 'resolu'
  | 'ferme'
  | 'ne_sera_pas_corrige'

export interface TicketAttachment {
  id: string
  filename: string
  content_type: string
  size_bytes: number
  created_at: string
}

export interface Ticket {
  /** UUID — used for API calls (detail, attachments). */
  id: string
  /** Human-facing ticket number shown to the user. */
  number: number | null
  title: string
  description: string
  severity: TicketSeverity
  status: TicketStatus
  category: TicketCategory
  context: string | null
  reporter_email: string
  reporter_name: string
  created_at: string
  comment: string | null
  fixed_in_version: string | null
  resolved_at: string | null
  attachments: TicketAttachment[]
}

export const categoryLabels: Record<TicketCategory, string> = {
  bug: 'Bug',
  fonctionnalite: 'Fonctionnalité',
}

export const categoryColors: Record<TicketCategory, string> = {
  bug: 'bg-red-500/15 text-red-700',
  fonctionnalite: 'bg-violet-500/15 text-violet-700',
}

export const severityLabels: Record<TicketSeverity, string> = {
  critique: 'Critique',
  majeur: 'Majeur',
  mineur: 'Mineur',
  cosmetique: 'Cosmétique',
  haute: 'Haute',
  moyenne: 'Moyenne',
  basse: 'Basse',
}

export const severityColors: Record<TicketSeverity, string> = {
  critique: 'bg-red-100 text-red-800 border-red-200',
  majeur: 'bg-orange-100 text-orange-800 border-orange-200',
  mineur: 'bg-amber-100 text-amber-800 border-amber-200',
  cosmetique: 'bg-zinc-100 text-zinc-700 border-zinc-200',
  haute: 'bg-orange-100 text-orange-800 border-orange-200',
  moyenne: 'bg-amber-100 text-amber-800 border-amber-200',
  basse: 'bg-green-100 text-green-800 border-green-200',
}

export const statusLabels: Record<TicketStatus, string> = {
  nouveau: 'Nouveau',
  pris_en_compte: 'Pris en compte',
  en_cours: 'En cours',
  resolu: 'Résolu',
  ferme: 'Fermé',
  ne_sera_pas_corrige: 'Ne sera pas corrigé',
}

export const statusColors: Record<TicketStatus, string> = {
  nouveau: 'bg-blue-100 text-blue-800',
  pris_en_compte: 'bg-purple-100 text-purple-800',
  en_cours: 'bg-orange-100 text-orange-800',
  resolu: 'bg-green-100 text-green-800',
  ferme: 'bg-zinc-100 text-zinc-700',
  ne_sera_pas_corrige: 'bg-zinc-100 text-zinc-500',
}

export const bugSeverities: TicketSeverity[] = ['cosmetique', 'mineur', 'majeur', 'critique']
export const featureSeverities: TicketSeverity[] = ['basse', 'moyenne', 'haute']

/** Statuses that take a ticket out of the user's working set. Those are
 *  collapsed into the "Tickets clôturés" drawer of the "Mes tickets" list so
 *  only what's still moving stays on screen.
 *
 *  `resolu` is deliberately NOT here: it means "fixed and scheduled for a
 *  release" (the fix version is set), not "delivered". The reporter still has
 *  something to wait for — the release being published — and that is exactly
 *  when they most want the ticket visible. The tracker flips resolved tickets
 *  to `ferme` automatically when their release is published; that is the
 *  moment they belong in the drawer. */
export const closedStatuses: TicketStatus[] = ['ferme', 'ne_sera_pas_corrige']

export function isClosedStatus(status: TicketStatus): boolean {
  return closedStatuses.includes(status)
}
