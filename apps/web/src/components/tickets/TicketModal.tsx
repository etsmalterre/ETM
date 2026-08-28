// Ticket widget modal — three views: new-ticket form / "Mes tickets" list /
// ticket detail. The screenshot is captured by the Header trigger in the
// background while the modal is already open (the capture filters out dialog
// portals so the modal is never in the shot) and arrives here as
// initialScreenshot, exposed as an "include screenshot" attachment button
// that shows a spinner while capturingScreenshot is true.
//
// LIVA ticket widget — feature version 1.3.0 (see the
// issue_tracker_integration skill; bump both together).
//
// 1.3.0: an account with no mapped email still reports (the proxy files it
// under a synthetic identity) and only loses the follow-up mail, so the
// follow-up controls render only when GET /reporter says can_follow. A host
// page may name who is at a shared station (reporterHint.ts).

import { useState, useEffect, useRef } from 'react'
import {
  Send,
  ArrowLeft,
  Clock,
  ChevronRight,
  ChevronDown,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Bug,
  Lightbulb,
  Camera,
  Paperclip,
  X,
  FileText,
  CheckCircle2,
  CheckCheck,
  Archive,
  Bell,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { useTicketContext } from './useTicketContext'
import { useTickets, useTicketReporter } from './useTickets'
import { useTicketReporterHint } from './reporterHint'
import { useTicketNotifications } from './useTicketNotifications'
import type { Ticket, TicketCategory, TicketSeverity } from './types'
import {
  severityLabels,
  severityColors,
  statusLabels,
  statusColors,
  categoryLabels,
  categoryColors,
  bugSeverities,
  featureSeverities,
  isClosedStatus,
} from './types'

interface TicketModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialScreenshot?: File | null
  capturingScreenshot?: boolean
}

type View = 'form' | 'list' | 'detail'

const MAX_FILES = 5
const MAX_SIZE = 5 * 1024 * 1024 // 5 MB — tracker-side limit per file
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']

const inputClass =
  'w-full h-9 px-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
}

function CategoryChip({ category }: { category: TicketCategory }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium',
        categoryColors[category],
      )}
    >
      {categoryLabels[category]}
    </span>
  )
}

function SeverityChip({ severity }: { severity: TicketSeverity }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium border',
        severityColors[severity],
      )}
    >
      {severityLabels[severity]}
    </span>
  )
}

function StatusChip({ status }: { status: Ticket['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium',
        statusColors[status],
      )}
    >
      {statusLabels[status]}
    </span>
  )
}

/** One row of the "Mes tickets" list. Unread rows (a status move or a
 *  developer reply the user hasn't opened yet) get the gold attention frame
 *  and a dot, matching the app's "needs your attention" language. */
function TicketRow({
  ticket,
  unread,
  onOpen,
}: {
  ticket: Ticket
  unread: boolean
  onOpen: () => void
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-colors',
        unread
          ? 'border-accent/50 bg-accent/[0.05] hover:bg-accent/10'
          : 'hover:border-accent/50 hover:bg-accent/5',
      )}
      onClick={onOpen}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          {unread && (
            <span
              className="h-2 w-2 rounded-full bg-accent flex-shrink-0"
              title="Mis à jour depuis votre dernière consultation"
            />
          )}
          {!!ticket.number && (
            <span className="text-[10px] font-semibold text-muted-foreground tabular-nums">
              N°{ticket.number}
            </span>
          )}
          <CategoryChip category={ticket.category} />
          <SeverityChip severity={ticket.severity} />
          <StatusChip status={ticket.status} />
          {!!ticket.fixed_in_version && (
            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-green-50 text-green-700 border border-green-200">
              v{ticket.fixed_in_version}
            </span>
          )}
        </div>
        <p className={cn('text-sm truncate', unread ? 'font-semibold' : 'font-medium')}>
          {ticket.title}
        </p>
        <p className="text-xs text-muted-foreground">{formatDate(ticket.created_at)}</p>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
    </div>
  )
}

export function TicketModal({ open, onOpenChange, initialScreenshot, capturingScreenshot }: TicketModalProps) {
  const [view, setView] = useState<View>('form')
  const [titre, setTitre] = useState('')
  const [description, setDescription] = useState('')
  const [categorie, setCategorie] = useState<TicketCategory>('bug')
  const [severite, setSeverite] = useState<TicketSeverity>('mineur')
  const [sentNumber, setSentNumber] = useState<number | null>(null)
  const [sent, setSent] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [attachmentWarning, setAttachmentWarning] = useState<string | null>(null)
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [closedOpen, setClosedOpen] = useState(false)
  // Follow-up: opt-in email on every status change. Off by default — the
  // reporter asks for it, we never subscribe them silently.
  const [suivi, setSuivi] = useState(false)
  const [suiviBusy, setSuiviBusy] = useState(false)
  const [suiviError, setSuiviError] = useState<string | null>(null)

  const [attachments, setAttachments] = useState<File[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [screenshotUsed, setScreenshotUsed] = useState(false)
  const [previewFile, setPreviewFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const contexte = useTicketContext()
  const reporterHint = useTicketReporterHint()
  const { isSubmitting, submitTicket, fetchTicket, setFollowUp, uploadAttachments } =
    useTickets()
  // Can this account receive the follow-up mail at all? Unknown (not loaded
  // yet, or the lookup failed) reads as "yes": the proxy ignores the tick for
  // an account that cannot, so offering it is harmless; hiding it from someone
  // who can is not. The modal is mounted with the Header, so the lookup has
  // long returned by the time anyone opens it.
  const reporter = useTicketReporter()
  const canFollow = reporter.data ? reporter.data.can_follow : true
  const { tickets, isLoading, listError, refresh, unreadCount, isUnread, markSeen, markAllSeen } =
    useTicketNotifications()

  const severityOptions = categorie === 'bug' ? bugSeverities : featureSeverities

  // Split the list: what's still moving stays on screen, everything closed
  // goes into the collapsible drawer at the bottom.
  const openTickets = tickets.filter((t) => !isClosedStatus(t.status))
  const closedTickets = tickets.filter((t) => isClosedStatus(t.status))
  const closedUnread = closedTickets.filter(isUnread).length

  // Refresh the list every time the user lands on the "Mes tickets" view.
  useEffect(() => {
    if (view === 'list' && open) {
      refresh()
    }
    // refresh() is stable per query instance; re-running on its identity would
    // refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, open])

  // A ticket that just got resolved is both "closed" and "unread" — opening
  // the drawer for the user is how they find the reply they were notified of.
  useEffect(() => {
    if (view === 'list' && closedUnread > 0) setClosedOpen(true)
  }, [view, closedUnread])

  const addFiles = (files: FileList | File[]) => {
    setAttachmentError(null)
    const newFiles = Array.from(files)
    if (attachments.length + newFiles.length > MAX_FILES) {
      setAttachmentError(`Maximum ${MAX_FILES} fichiers`)
      return
    }
    for (const f of newFiles) {
      if (f.size > MAX_SIZE) {
        setAttachmentError(`"${f.name}" dépasse 5 Mo`)
        return
      }
      if (!ACCEPTED_TYPES.includes(f.type)) {
        setAttachmentError(`"${f.name}" : format non supporté (PNG, JPEG, WebP, PDF)`)
        return
      }
    }
    setAttachments((prev) => [...prev, ...newFiles])
  }

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
    setAttachmentError(null)
  }

  const addScreenshot = () => {
    if (initialScreenshot) {
      addFiles([initialScreenshot])
      setScreenshotUsed(true)
    }
  }

  const resetForm = () => {
    setTitre('')
    setDescription('')
    setCategorie('bug')
    setSeverite('mineur')
    setSuivi(false)
    setSent(false)
    setSentNumber(null)
    setSendError(null)
    setAttachmentWarning(null)
    setAttachments([])
    setAttachmentError(null)
    setScreenshotUsed(false)
  }

  const handleClose = () => {
    resetForm()
    setView('form')
    setSelectedTicket(null)
    setDetailError(null)
    setSuiviError(null)
    setPreviewFile(null)
    onOpenChange(false)
  }

  const handleCategoryChange = (cat: TicketCategory) => {
    setCategorie(cat)
    setSeverite(cat === 'bug' ? 'mineur' : 'moyenne')
  }

  const handleOpenDetail = async (id: string) => {
    setIsLoadingDetail(true)
    setDetailError(null)
    setSuiviError(null)
    setView('detail')
    try {
      const ticket = await fetchTicket(id)
      setSelectedTicket(ticket)
      // Reading the detail is what clears the unread badge for this ticket.
      markSeen(ticket)
    } catch (err) {
      setSelectedTicket(null)
      setDetailError(err instanceof Error ? err.message : 'Erreur lors du chargement')
    } finally {
      setIsLoadingDetail(false)
    }
  }

  /** Detail view: subscribe / unsubscribe. The tracker is the source of
   *  truth for the flag, so the row only moves once the call succeeds. */
  const handleToggleSuivi = async () => {
    if (!selectedTicket || suiviBusy) return
    setSuiviBusy(true)
    setSuiviError(null)
    try {
      const updated = await setFollowUp(selectedTicket.id, !selectedTicket.follow_up)
      setSelectedTicket(updated)
      refresh()
    } catch (err) {
      setSuiviError(err instanceof Error ? err.message : 'Erreur lors de la mise à jour du suivi')
    } finally {
      setSuiviBusy(false)
    }
  }

  const handleSend = async () => {
    if (!titre.trim() || !description.trim()) return
    setSendError(null)
    setAttachmentWarning(null)
    try {
      const ticket = await submitTicket({
        title: titre.trim(),
        description: description.trim(),
        severity: severite,
        category: categorie,
        context: contexte || null,
        follow_up: canFollow && suivi,
        reporter_name: reporterHint,
      })
      if (attachments.length > 0) {
        try {
          await uploadAttachments(ticket.id, attachments)
        } catch {
          // Non-fatal: the ticket exists, only the attachments failed.
          setAttachmentWarning(
            "Le ticket a été créé mais l'envoi des pièces jointes a échoué.",
          )
        }
      }
      // The user just wrote it — it must not come back as unread.
      markSeen(ticket)
      refresh()
      setSentNumber(ticket.number)
      setSent(true)
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Erreur lors de l'envoi")
    }
  }

  const canSend = titre.trim().length > 0 && description.trim().length > 0 && !isSubmitting

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="max-w-lg max-h-[85dvh] overflow-y-auto scrollbar-transparent"
        onClose={handleClose}
      >
        <DialogHeader>
          <div className="flex items-center justify-between pr-6">
            <DialogTitle className="flex items-center gap-2">
              <MessageSquarePlus className="h-5 w-5 text-accent" />
              {view === 'form'
                ? 'Envoyer un ticket'
                : view === 'list'
                  ? 'Mes tickets'
                  : 'Détail du ticket'}
            </DialogTitle>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => {
                if (view === 'form') {
                  setView('list')
                } else if (view === 'detail') {
                  setSelectedTicket(null)
                  setView('list')
                } else {
                  setView('form')
                }
              }}
            >
              {view === 'form' ? (
                <>
                  <Clock className="h-3.5 w-3.5 mr-1" />
                  Mes tickets
                </>
              ) : view === 'detail' ? (
                <>
                  <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                  Liste
                </>
              ) : (
                <>
                  <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                  Nouveau
                </>
              )}
            </Button>
          </div>
        </DialogHeader>

        {view === 'detail' ? (
          <div className="mt-4 space-y-4">
            {isLoadingDetail ? (
              <div className="py-8 flex justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-accent" />
              </div>
            ) : selectedTicket ? (
              <>
                {/* Title + badges */}
                <div>
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    {!!selectedTicket.number && (
                      <span className="text-[10px] font-semibold text-muted-foreground tabular-nums">
                        N°{selectedTicket.number}
                      </span>
                    )}
                    <CategoryChip category={selectedTicket.category} />
                    <SeverityChip severity={selectedTicket.severity} />
                    <StatusChip status={selectedTicket.status} />
                  </div>
                  <h3 className="text-sm font-semibold">{selectedTicket.title}</h3>
                </div>

                {/* Description */}
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Description
                  </p>
                  <div className="text-sm whitespace-pre-line bg-muted/50 rounded-md p-3 border">
                    {selectedTicket.description}
                  </div>
                </div>

                {/* Attachments */}
                {selectedTicket.attachments.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                      <Paperclip className="h-3 w-3" />
                      Pièces jointes
                    </p>
                    <div className="space-y-1 bg-muted/50 rounded-md p-3 border">
                      {selectedTicket.attachments.map((att) => (
                        <div key={att.id} className="flex items-center justify-between text-sm">
                          <span className="truncate">{att.filename}</span>
                          <span className="text-xs text-muted-foreground ml-2 flex-shrink-0">
                            {formatSize(att.size_bytes)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Developer reply */}
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                    <MessageSquare className="h-3 w-3" />
                    Réponse
                  </p>
                  {selectedTicket.comment ? (
                    <div className="text-sm whitespace-pre-line bg-accent/[0.06] rounded-md p-3 border border-accent/20">
                      {selectedTicket.comment}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">Pas encore de réponse</p>
                  )}
                </div>

                {/* Metadata */}
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Informations
                  </p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm bg-muted/50 rounded-md p-3 border">
                    <span className="text-muted-foreground">Signalé le</span>
                    <span>{formatDate(selectedTicket.created_at)}</span>
                    <span className="text-muted-foreground">Résolu le</span>
                    <span>
                      {selectedTicket.resolved_at ? formatDate(selectedTicket.resolved_at) : '—'}
                    </span>
                    <span className="text-muted-foreground">Corrigé dans</span>
                    <span>{selectedTicket.fixed_in_version || '—'}</span>
                  </div>
                </div>

                {/* Suivi par email — §35 inline toggle pill. The reporter owns
                    this flag; flipping it takes effect on the tracker, so the
                    row only moves once the PATCH comes back.
                    Same rule as the form checkbox: no email, no follow-up row. */}
                {canFollow && (
                  <>
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-border/60 bg-white shadow-sm">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-xs font-semibold">
                          <Bell className="h-3.5 w-3.5 text-accent" />
                          <span>Suivi par email</span>
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {selectedTicket.follow_up
                            ? 'Vous êtes averti à chaque changement de statut'
                            : 'Aucun email envoyé pour ce ticket'}
                        </p>
                      </div>
                      {suiviBusy && (
                        <Loader2 className="h-3 w-3 animate-spin text-accent flex-shrink-0" />
                      )}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={selectedTicket.follow_up}
                        aria-label="Suivi par email"
                        disabled={suiviBusy}
                        onClick={handleToggleSuivi}
                        className={cn(
                          'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
                          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                          'disabled:opacity-50 disabled:cursor-not-allowed',
                          selectedTicket.follow_up
                            ? 'bg-accent shadow-inner'
                            : 'bg-zinc-300 hover:bg-zinc-400/80',
                        )}
                      >
                        <span
                          className={cn(
                            'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out',
                            selectedTicket.follow_up ? 'translate-x-[18px]' : 'translate-x-0.5',
                          )}
                        />
                      </button>
                    </div>
                    {!!suiviError && <p className="text-xs text-destructive">{suiviError}</p>}
                  </>
                )}

                {/* Context */}
                {!!selectedTicket.context && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Contexte
                    </p>
                    <div className="text-xs font-mono whitespace-pre-line bg-muted rounded-md p-2.5 border">
                      {selectedTicket.context}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {detailError || 'Erreur lors du chargement'}
              </div>
            )}
          </div>
        ) : view === 'form' ? (
          <div className="mt-4 space-y-4">
            {sent ? (
              <div className="py-8 flex flex-col items-center text-center">
                <CheckCircle2 className="h-12 w-12 mb-3 text-green-600" />
                <p className="text-sm font-medium">
                  {sentNumber !== null
                    ? `Ticket n°${sentNumber} envoyé avec succès`
                    : 'Ticket envoyé avec succès'}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Vous pouvez suivre son avancement dans « Mes tickets ».
                </p>
                {!!attachmentWarning && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mt-3">
                    {attachmentWarning}
                  </p>
                )}
                <Button size="sm" className="mt-4" onClick={handleClose}>
                  Fermer
                </Button>
              </div>
            ) : (
              <>
                {/* Category tabs */}
                <div className="flex border-b border-border">
                  <button
                    type="button"
                    onClick={() => handleCategoryChange('bug')}
                    className={cn(
                      'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
                      categorie === 'bug'
                        ? 'border-red-500 text-red-700'
                        : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
                    )}
                  >
                    <Bug className="h-4 w-4" />
                    Bug
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCategoryChange('fonctionnalite')}
                    className={cn(
                      'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
                      categorie === 'fonctionnalite'
                        ? 'border-violet-500 text-violet-700'
                        : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
                    )}
                  >
                    <Lightbulb className="h-4 w-4" />
                    Fonctionnalité
                  </button>
                </div>

                {/* Severity pills */}
                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    {categorie === 'bug' ? 'Sévérité' : 'Priorité'}
                  </p>
                  <div className="flex gap-2">
                    {severityOptions.map((sev) => (
                      <button
                        key={sev}
                        type="button"
                        onClick={() => setSeverite(sev)}
                        className={cn(
                          'flex-1 px-2 py-1.5 text-xs rounded-md border text-center transition-all',
                          severite === sev
                            ? cn(severityColors[sev], 'ring-2 ring-offset-1 ring-current')
                            : 'border-input bg-background hover:bg-accent/10',
                        )}
                      >
                        {severityLabels[sev]}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Title */}
                <div className="space-y-1">
                  <p className="text-sm font-medium">Titre</p>
                  <input
                    type="text"
                    value={titre}
                    onChange={(e) => setTitre(e.target.value)}
                    placeholder="Résumé court..."
                    className={inputClass}
                    autoComplete="off"
                  />
                </div>

                {/* Description */}
                <div className="space-y-1">
                  <p className="text-sm font-medium">Description</p>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={
                      categorie === 'bug'
                        ? "Décrivez le problème en détail : ce que vous faisiez, ce qui s'est passé, ce que vous attendiez..."
                        : 'Décrivez la fonctionnalité souhaitée en détail...'
                    }
                    rows={4}
                    autoComplete="off"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                  />
                </div>

                {/* Attachments */}
                <div className="space-y-2">
                  <p className="text-sm font-medium">Pièces jointes</p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addScreenshot}
                      disabled={
                        capturingScreenshot ||
                        !initialScreenshot ||
                        screenshotUsed ||
                        attachments.length >= MAX_FILES
                      }
                    >
                      {capturingScreenshot ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <Camera className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      {capturingScreenshot
                        ? 'Capture en cours...'
                        : screenshotUsed
                          ? 'Capture ajoutée'
                          : "Capture d'écran"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={attachments.length >= MAX_FILES}
                    >
                      <Paperclip className="h-3.5 w-3.5 mr-1.5" />
                      Ajouter fichier
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={ACCEPTED_TYPES.join(',')}
                      multiple
                      className="hidden"
                      onClick={(e) => {
                        ;(e.target as HTMLInputElement).value = ''
                      }}
                      onChange={(e) => {
                        if (e.target.files?.length) addFiles(e.target.files)
                      }}
                    />
                  </div>
                  {attachments.length > 0 && (
                    <div className="flex gap-2 flex-wrap">
                      {attachments.map((file, i) => (
                        <div key={i} className="relative group">
                          {file.type === 'application/pdf' ? (
                            <div
                              className="h-16 w-16 rounded border bg-muted flex items-center justify-center cursor-pointer hover:ring-2 hover:ring-ring transition-all"
                              onClick={() => setPreviewFile(file)}
                              title={file.name}
                            >
                              <FileText className="h-7 w-7 text-muted-foreground" />
                            </div>
                          ) : (
                            <img
                              src={URL.createObjectURL(file)}
                              alt={file.name}
                              className="h-16 w-16 object-cover rounded border cursor-pointer hover:ring-2 hover:ring-ring transition-all"
                              onClick={() => setPreviewFile(file)}
                            />
                          )}
                          <button
                            type="button"
                            onClick={() => removeAttachment(i)}
                            className="absolute -top-1.5 -right-1.5 bg-destructive text-destructive-foreground rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <X className="h-3 w-3" />
                          </button>
                          <span className="block text-[9px] text-muted-foreground truncate w-16 text-center mt-0.5">
                            {file.name.length > 12 ? file.name.slice(0, 10) + '…' : file.name}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {!!attachmentError && <p className="text-xs text-destructive">{attachmentError}</p>}
                  <p className="text-[10px] text-muted-foreground">
                    Max {MAX_FILES} fichiers, 5 Mo chacun (PNG, JPEG, WebP, PDF)
                  </p>
                </div>

                {/* Context */}
                <div className="space-y-1">
                  <p className="text-sm font-medium">Contexte</p>
                  <div className="p-2.5 text-xs rounded-md bg-muted border border-input font-mono whitespace-pre-line">
                    {contexte || 'Aucun contexte'}
                  </div>
                </div>

                {/* Follow-up opt-in. Unticked by default: the reporter asks to
                    be notified, we never subscribe them silently.
                    Absent for an account without an email: nobody would receive the mail. */}
                {canFollow && (
                  <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-input bg-muted/40">
                    <Checkbox
                      checked={suivi}
                      onCheckedChange={setSuivi}
                      aria-label="Me tenir informé par email"
                      className="mt-0.5"
                    />
                    <div
                      className="min-w-0 cursor-pointer select-none"
                      onClick={() => setSuivi(!suivi)}
                    >
                      <p className="text-sm font-medium leading-tight">
                        Me tenir informé par email
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                        Un email à chaque changement de statut de ce ticket.
                      </p>
                    </div>
                  </div>
                )}

                {/* Error */}
                {!!sendError && (
                  <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-2.5">
                    {sendError}
                  </div>
                )}

                {/* Send */}
                <div className="flex justify-end pt-1">
                  <Button onClick={handleSend} disabled={!canSend}>
                    {isSubmitting ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4 mr-1" />
                    )}
                    {isSubmitting ? 'Envoi...' : 'Envoyer'}
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="mt-4">
            {isLoading ? (
              <div className="py-8 flex justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-accent" />
              </div>
            ) : listError ? (
              <div className="py-8 text-center text-sm text-muted-foreground">{listError}</div>
            ) : tickets.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">Aucun ticket</div>
            ) : (
              <div className="space-y-2 max-h-[55vh] overflow-y-auto scrollbar-transparent p-0.5">
                {unreadCount > 0 && (
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-accent font-medium">
                      {unreadCount} ticket{unreadCount > 1 ? 's' : ''} mis à jour
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-muted-foreground"
                      onClick={markAllSeen}
                    >
                      <CheckCheck className="h-3.5 w-3.5 mr-1" />
                      Tout marquer comme lu
                    </Button>
                  </div>
                )}

                {/* Tickets en cours */}
                {openTickets.length > 0 ? (
                  <div className="space-y-1">
                    {openTickets.map((ticket) => (
                      <TicketRow
                        key={ticket.id}
                        ticket={ticket}
                        unread={isUnread(ticket)}
                        onOpen={() => handleOpenDetail(ticket.id)}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Aucun ticket en cours
                  </p>
                )}

                {/* Drawer: everything closed, collapsed by default */}
                {closedTickets.length > 0 && (
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => setClosedOpen((o) => !o)}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-md border border-border/60 bg-zinc-100/80 hover:bg-zinc-100 text-xs font-medium text-muted-foreground transition-colors select-none"
                    >
                      <Archive className="h-3.5 w-3.5" />
                      <span>Tickets clôturés</span>
                      {closedUnread > 0 && (
                        <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-accent text-accent-foreground text-[10px] font-bold tabular-nums">
                          {closedUnread}
                        </span>
                      )}
                      <span className="ml-auto tabular-nums">{closedTickets.length}</span>
                      <ChevronDown
                        className={cn('h-3.5 w-3.5 transition-transform', closedOpen && 'rotate-180')}
                      />
                    </button>
                    {closedOpen && (
                      <div className="mt-1 space-y-1">
                        {closedTickets.map((ticket) => (
                          <TicketRow
                            key={ticket.id}
                            ticket={ticket}
                            unread={isUnread(ticket)}
                            onOpen={() => handleOpenDetail(ticket.id)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>

      {/* Attachment preview lightbox */}
      {previewFile && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 cursor-pointer"
          onClick={() => setPreviewFile(null)}
        >
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white"
            onClick={() => setPreviewFile(null)}
          >
            <X className="h-6 w-6" />
          </button>
          {previewFile.type === 'application/pdf' ? (
            <iframe
              src={URL.createObjectURL(previewFile)}
              title={previewFile.name}
              className="w-[90vw] h-[90vh] rounded shadow-2xl bg-white"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <img
              src={URL.createObjectURL(previewFile)}
              alt={previewFile.name}
              className="max-w-[90vw] max-h-[90vh] object-contain rounded shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}
    </Dialog>
  )
}
