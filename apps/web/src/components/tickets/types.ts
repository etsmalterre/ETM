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
  // The team is blocked on the reporter: it asked them something and waits
  // for the answer (v1.3.1). Open, ranked first, purple.
  | 'en_attente'
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

/** One message of the ticket's conversation with the team (v1.4.0). Team
 *  messages are signed with the brand ("Malterre Intelligence"). */
export interface TicketMessage {
  id: string
  author: 'team' | 'reporter'
  author_name: string | null
  body: string
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
  /** The reporter asked to be emailed on every status change of this ticket
   *  (tracker-side flag, toggled from the detail view). */
  follow_up: boolean
  fixed_in_version: string | null
  resolved_at: string | null
  /** Status `en_attente`: what the team needs from the reporter. Also the
   *  latest team message of the thread — kept as the fallback when the thread
   *  is empty. */
  waiting_for: string | null
  attachments: TicketAttachment[]
  /** Conversation with the team, oldest first. */
  messages: TicketMessage[]
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
  // "Backlog": accepted, parked until scheduled (tracker wording since 2026-09-30).
  pris_en_compte: 'À planifier',
  en_cours: 'En cours',
  // Says whose wait it is — a plain « En attente » reads as "the team is on it".
  en_attente: 'En attente de votre réponse',
  resolu: 'Résolu',
  ferme: 'Fermé',
  ne_sera_pas_corrige: 'Ne sera pas corrigé',
}

export const statusColors: Record<TicketStatus, string> = {
  nouveau: 'bg-blue-100 text-blue-800',
  pris_en_compte: 'bg-teal-100 text-teal-800',
  en_cours: 'bg-orange-100 text-orange-800',
  // Purple belongs to the wait on the reporter, as in the tracker and its mails.
  en_attente: 'bg-purple-100 text-purple-800',
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
