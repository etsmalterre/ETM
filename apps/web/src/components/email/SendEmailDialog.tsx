import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AtSign,
  CalendarClock,
  Check,
  Mail,
  FileText,
  Loader2,
  AlertCircle,
  CheckCircle2,
  User,
  Plus,
  X,
  Paperclip,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { SignaturePreview } from '@/components/ui/signature-preview'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { RichEmailEditor, texteVersHtml } from './RichEmailEditor'
import { apiFetch } from '@/lib/api'
import { useUser } from '@/contexts/UserContext'
import { cn } from '@/lib/utils'
import {
  EMAIL_REGEX,
  parseEmailList,
  formatFileSize,
  MAX_TOTAL_ATTACHMENT_BYTES,
  POINTS_A_SIGNALER_TITRE,
  CORPS_RICHE,
  type EmailDefaults,
  type EmailRecipient,
  type SendPayload,
} from '@/lib/email'

/** User-uploaded attachment, managed internally by the dialog. The public
 *  `SendPayload.userAttachments` API still takes plain `File[]` — this richer
 *  shape only lives in dialog state so we can track stable ids for preview
 *  selection and pair each File with a blob URL for inline previews. */
/** Cc / Cci as chips, same look as the À row. The value stays the
 *  comma-separated string the dialog already sends (parseEmailList); a chip
 *  shows the contact's name when the address belongs to a known contact, and
 *  an invalid address is a red chip (send refuses it). */
function AddressChipsInput({ value, onChange, names, placeholder }: {
  value: string
  onChange: (next: string) => void
  names: Map<string, string>
  placeholder: string
}) {
  const [draft, setDraft] = useState('')
  const list = parseEmailList(value)
  const commit = () => {
    const added = parseEmailList(draft)
    setDraft('')
    if (added.length === 0) return
    const seen = new Set(list.map((a) => a.toLowerCase()))
    const next = [...list, ...added.filter((a) => !seen.has(a.toLowerCase()))]
    onChange(next.join(', '))
  }
  const remove = (i: number) => onChange(list.filter((_, j) => j !== i).join(', '))
  return (
    <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1 py-0.5">
      {list.map((a, i) => {
        const ok = EMAIL_REGEX.test(a)
        const name = names.get(a.toLowerCase())
        return (
          <span
            key={`${a}-${i}`}
            title={ok ? a : `Adresse invalide : ${a}`}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border text-xs py-0.5 pl-1.5 pr-0.5',
              ok ? 'bg-primary/[0.07] border-primary/20 text-primary' : 'bg-destructive/10 border-destructive/30 text-destructive',
            )}
          >
            {name && <User className="h-3 w-3 flex-shrink-0 opacity-70" />}
            <span className="max-w-[220px] truncate">{name || a}</span>
            <button type="button" onClick={() => remove(i)} className="rounded-full hover:bg-primary/15 p-0.5 transition-colors" title="Retirer">
              <X className="h-3 w-3" />
            </button>
          </span>
        )
      })}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Backspace' && draft === '' && list.length > 0) {
            remove(list.length - 1)
          }
        }}
        onBlur={commit}
        onPaste={(e) => {
          // A pasted list becomes chips at once.
          const text = e.clipboardData.getData('text')
          if (/[,;\n]/.test(text)) {
            e.preventDefault()
            const seen = new Set(list.map((a) => a.toLowerCase()))
            onChange([...list, ...parseEmailList(text).filter((a) => !seen.has(a.toLowerCase()))].join(', '))
          }
        }}
        placeholder={list.length === 0 ? placeholder : 'ajouter…'}
        className="flex-1 min-w-[8rem] h-6 px-1 text-xs bg-transparent focus:outline-none"
        autoComplete="off"
      />
    </div>
  )
}

interface UserAttachment {
  id: string
  file: File
  blobUrl: string
}

function makeAttachmentId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Server-side attachment that always rides along with the send (e.g. the
 *  CGV on client order confirmations). Shown as a non-removable chip and
 *  previewable in the right pane; the API attaches it itself, so it is never
 *  part of the send payload. */
export interface ExtraServerAttachment {
  id: string
  label: string
  url: string
}

/** Server-rendered attachment the user can tick on/off (e.g. rapport de
 *  contrôle / info matières on expedition emails). Shown as a chip with a
 *  leading checkbox; previewable even when unticked. The checked map goes
 *  out on SendPayload.optionalAttachments and the caller converts it to
 *  endpoint flags. When the defaults fetch returns `optional_attachments`,
 *  it drives both visibility (unlisted ids are hidden) and the initial
 *  checked state; `defaultChecked` is only the fallback. */
export interface OptionalServerAttachment {
  id: string
  label: string
  url: string
  defaultChecked: boolean
}

interface SendEmailDialogProps {
  open: boolean
  onClose: () => void
  /** Header title — default « Envoyer un email ». */
  title?: string
  /** A quiet alternative left of Annuler (e.g. « Réclamer sans email »). */
  secondaryAction?: { label: string; onClick: () => void }
  /** A « Programmer » button next to Envoyer (Sous-traitants › Point: sent at
   *  9:00 by the automate). Clicking it calls onSend with `programme: true`.
   *  `disabledReason` greys it out and becomes its tooltip. */
  programmer?: { label: string; title?: string; disabledReason?: string | null }

  /** Free-text context chip shown in the dialog header (e.g. fournisseur name). */
  contextLabel?: string

  /** React-query cache key for the defaults fetch. Must be stable per open-id. */
  queryKey: readonly unknown[]
  /** Async loader for pre-fill defaults. Called on dialog open. */
  loadDefaults: () => Promise<EmailDefaults>

  /** Async send handler. Caller wires its own endpoint + payload transform. */
  onSend: (payload: SendPayload) => Promise<void>

  /** Optional PDF preview URL. If undefined, the right pane shows an empty
   *  state and no server-rendered PDF chip is added to the attachment list. */
  pdfUrl?: string
  /** Display label for the server-rendered PDF chip (e.g. "Bon de commande
   *  675.pdf"). Only shown when pdfUrl is set. */
  pdfAttachmentLabel?: string
  /** Always-attached server documents (CGV…). Non-removable chips. */
  extraServerAttachments?: ExtraServerAttachment[]
  /** Optional (tickable) server documents — see OptionalServerAttachment. */
  optionalServerAttachments?: OptionalServerAttachment[]
}

export function SendEmailDialog({
  open,
  onClose,
  title = 'Envoyer un email',
  secondaryAction,
  programmer,
  contextLabel,
  queryKey,
  loadDefaults,
  onSend,
  pdfUrl,
  pdfAttachmentLabel = 'document.pdf',
  extraServerAttachments,
  optionalServerAttachments,
}: SendEmailDialogProps) {
  // ── Form state ───────────────────────────────────────
  const [selectedRecipients, setSelectedRecipients] = useState<EmailRecipient[]>([])
  const [suggestions, setSuggestions] = useState<EmailRecipient[]>([])
  const [manualInput, setManualInput] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  /** Cc / Cci are hidden until asked for, so the form stays compact. Opened
   *  automatically on hydration when the server pre-filled either of them. */
  const [showCc, setShowCc] = useState(false)
  const [showBcc, setShowBcc] = useState(false)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  /** Whether the server-rendered PDF is still in the attachment list. Starts
   *  true when pdfUrl is set; flipped to false when the user clicks ✕ on the
   *  default PDF chip. Never true when there's no pdfUrl. */
  const [attachPdf, setAttachPdf] = useState(true)
  /** User-uploaded attachments. Each carries a stable id (for preview
   *  selection) and a blob URL (so we can iframe/<img> it without reading
   *  the file again). Blob URLs are created on add and revoked on remove
   *  or on dialog close. */
  const [userAttachments, setUserAttachments] = useState<UserAttachment[]>([])
  /** Checked-state of the optional server attachments, keyed by id. Seeded
   *  on hydration from the defaults' optional_attachments (fallback: each
   *  prop entry's defaultChecked). */
  const [optionalChecked, setOptionalChecked] = useState<Record<string, boolean>>({})
  /** Which attachment is currently shown in the right-pane viewer.
   *  'server' → the pdfUrl prop; a string id → a user attachment by id;
   *  null → empty state. */
  const [previewedId, setPreviewedId] = useState<'server' | string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [isSending, setIsSending] = useState(false)
  /** Set when the user sends a mail whose « points à signaler » paragraph
   *  was deleted: holds the send mode until they confirm or go back. */
  const [pendingSansPoints, setPendingSansPoints] = useState<{ programme: boolean } | null>(null)

  // ── Defaults fetch ───────────────────────────────────
  const {
    data: defaults,
    isLoading: loadingDefaults,
    isError: defaultsError,
  } = useQuery<EmailDefaults>({
    queryKey,
    queryFn: loadDefaults,
    enabled: open,
  })

  // Sender's HTML signature — appended server-side at send time; shown here
  // read-only so the user knows what the recipient will see. Keyed by
  // IDutilisateur so a user switch on a shared PC never previews the
  // previous user's cached signature.
  // When nothing is configured, the API derives a default from the user's
  // identity so every mail still goes out signed — flagged so the preview can
  // point at where to customise it.
  const { user } = useUser()
  const { data: profileMe } = useQuery<{ signatureHtml: string | null; signatureIsDefault?: boolean }>({
    queryKey: ['user-profile-me', user?.IDutilisateur],
    queryFn: () => apiFetch<{ signatureHtml: string | null; signatureIsDefault?: boolean }>('/user-profiles/me'),
    enabled: open,
  })
  const signatureHtml = profileMe?.signatureHtml ?? null
  const signatureIsDefault = profileMe?.signatureIsDefault === true

  // Visible optional attachments: when the defaults fetch returns
  // optional_attachments, it is authoritative — only ids it lists are shown
  // (the server knows availability, e.g. "no fini lines → no rapport de
  // contrôle"). Without the field, every prop entry is shown.
  const visibleOptional = useMemo<OptionalServerAttachment[]>(() => {
    const props = optionalServerAttachments ?? []
    if (props.length === 0) return []
    const serverList = defaults?.optional_attachments
    if (!serverList) return props
    const allowed = new Set(serverList.map((o) => o.id))
    return props.filter((a) => allowed.has(a.id))
  }, [optionalServerAttachments, defaults])

  // Names of the known contacts, so a Cc / Cci chip shows « Prénom Nom ».
  const contactNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of [...(defaults?.recipients.selected ?? []), ...(defaults?.recipients.suggestions ?? [])]) {
      if (r.name) m.set(r.email.toLowerCase(), r.name)
    }
    return m
  }, [defaults])

  // Hydrate form fields once defaults arrive, then leave them editable.
  // Also set the initial preview target: 'server' when a pdfUrl is present,
  // otherwise null (user will add a file or stay with the empty state).
  useEffect(() => {
    if (!open || !defaults || hydrated) return
    setSelectedRecipients(defaults.recipients.selected)
    setSuggestions(defaults.recipients.suggestions)
    const ccDefaults = defaults.cc ?? []
    const bccDefaults = defaults.bcc ?? []
    setCc(ccDefaults.join(', '))
    setBcc(bccDefaults.join(', '))
    setShowCc(ccDefaults.length > 0)
    setShowBcc(bccDefaults.length > 0)
    setSubject(defaults.subject)
    // Endpoints pre-fill plain text; a saved rich body comes back with its marker.
    setBody(defaults.body.startsWith(CORPS_RICHE) ? defaults.body.slice(CORPS_RICHE.length) : texteVersHtml(defaults.body))
    // Initial checked state: server default_checked wins over the prop fallback.
    const serverById = new Map((defaults.optional_attachments ?? []).map((o) => [o.id, o.default_checked]))
    const checked: Record<string, boolean> = {}
    for (const a of optionalServerAttachments ?? []) {
      if (defaults.optional_attachments && !serverById.has(a.id)) continue
      checked[a.id] = serverById.get(a.id) ?? a.defaultChecked
    }
    setOptionalChecked(checked)
    setPreviewedId(pdfUrl ? 'server' : extraServerAttachments?.[0]?.id ?? null)
    setHydrated(true)
  }, [open, defaults, hydrated, pdfUrl, extraServerAttachments, optionalServerAttachments])

  // Reset all local state when the dialog closes so re-opening fetches fresh
  // defaults and starts from a clean slate. Blob URLs for user attachments
  // are revoked before the list is cleared — otherwise they'd leak.
  useEffect(() => {
    if (open) return
    setSelectedRecipients([])
    setSuggestions([])
    setManualInput('')
    setCc('')
    setBcc('')
    setShowCc(false)
    setShowBcc(false)
    setSubject('')
    setBody('')
    setPendingSansPoints(null)
    setAttachPdf(true)
    setUserAttachments((prev) => {
      prev.forEach((a) => URL.revokeObjectURL(a.blobUrl))
      return []
    })
    setOptionalChecked({})
    setPreviewedId(null)
    setErrorMessage(null)
    setSuccessMessage(null)
    setHydrated(false)
    setIsSending(false)
  }, [open])

  // ── Chip operations ──────────────────────────────────
  const allKnownEmails = useMemo(() => {
    const s = new Set<string>()
    for (const r of selectedRecipients) s.add(r.email.toLowerCase())
    for (const r of suggestions) s.add(r.email.toLowerCase())
    return s
  }, [selectedRecipients, suggestions])

  const removeRecipient = useCallback((email: string) => {
    setSelectedRecipients((prev) => {
      const found = prev.find((r) => r.email === email)
      if (!found) return prev
      const next = prev.filter((r) => r.email !== email)
      // Contact-sourced recipients go back to suggestions so the user can
      // re-add them without retyping. Manual recipients just vanish.
      if (found.source === 'contact') {
        setSuggestions((s) => [...s, found])
      }
      return next
    })
  }, [])

  const addFromSuggestion = useCallback((recipient: EmailRecipient) => {
    setSuggestions((prev) => prev.filter((r) => r.email !== recipient.email))
    setSelectedRecipients((prev) => [...prev, recipient])
  }, [])

  const addManual = useCallback(() => {
    const raw = manualInput.trim()
    if (!raw) return
    if (!EMAIL_REGEX.test(raw)) {
      setErrorMessage(`L'adresse « ${raw} » n'est pas valide`)
      return
    }
    if (allKnownEmails.has(raw.toLowerCase())) {
      // Already present — just clear the input silently.
      setManualInput('')
      return
    }
    setSelectedRecipients((prev) => [...prev, { email: raw, source: 'manual' }])
    setManualInput('')
    setErrorMessage(null)
  }, [manualInput, allKnownEmails])

  // ── Attachment operations ────────────────────────────
  const totalUserAttachmentBytes = useMemo(
    () => userAttachments.reduce((sum, a) => sum + a.file.size, 0),
    [userAttachments],
  )

  const handleFilePick = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return
    setErrorMessage(null)
    const incoming = Array.from(files).map((file) => ({
      id: makeAttachmentId(),
      file,
      blobUrl: URL.createObjectURL(file),
    }))
    setUserAttachments((prev) => {
      const next = [...prev, ...incoming]
      const total = next.reduce((sum, a) => sum + a.file.size, 0)
      if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
        // Reject the addition — revoke the brand-new blob URLs we just
        // created so they don't leak.
        incoming.forEach((a) => URL.revokeObjectURL(a.blobUrl))
        setErrorMessage(
          `Les pièces jointes dépassent la limite de ${formatFileSize(MAX_TOTAL_ATTACHMENT_BYTES)}.`,
        )
        return prev
      }
      return next
    })
    // Auto-preview the first newly added file when nothing is currently
    // previewed (e.g. user just removed the server PDF, or we're in the
    // entreprise empty-viewer case).
    setPreviewedId((curr) => (curr === null ? incoming[0]?.id ?? null : curr))
  }, [])

  const removeUserAttachment = useCallback((id: string) => {
    setUserAttachments((prev) => {
      const target = prev.find((a) => a.id === id)
      if (!target) return prev
      URL.revokeObjectURL(target.blobUrl)
      const next = prev.filter((a) => a.id !== id)
      // If the removed attachment was the active preview, fall through to
      // the next remaining user file, then the server PDF (if still in the
      // list), then the first always-attached server doc, then null.
      setPreviewedId((curr) => {
        if (curr !== id) return curr
        if (next.length > 0) return next[0].id
        if (pdfUrl && attachPdf) return 'server'
        return extraServerAttachments?.[0]?.id ?? null
      })
      return next
    })
  }, [pdfUrl, attachPdf, extraServerAttachments])

  const removeServerPdf = useCallback(() => {
    setAttachPdf(false)
    // If the server PDF was the active preview, fall through to the first
    // user attachment, then the first always-attached server doc, then null.
    setPreviewedId((curr) => {
      if (curr !== 'server') return curr
      return userAttachments[0]?.id ?? extraServerAttachments?.[0]?.id ?? null
    })
  }, [userAttachments, extraServerAttachments])

  const selectPreview = useCallback((id: 'server' | string) => {
    setPreviewedId(id)
  }, [])

  const toggleOptional = useCallback((id: string) => {
    setOptionalChecked((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  /** Show/hide the Cc or Cci field. Closing it also clears its content —
   *  a hidden field must never smuggle recipients into the send. */
  const toggleCopyField = useCallback((field: 'cc' | 'bcc') => {
    if (field === 'cc') {
      setShowCc((prev) => {
        if (prev) setCc('')
        return !prev
      })
    } else {
      setShowBcc((prev) => {
        if (prev) setBcc('')
        return !prev
      })
    }
  }, [])

  // ── Send ─────────────────────────────────────────────
  const handleSend = useCallback(async (programme = false, confirmeSansPoints = false) => {
    setErrorMessage(null)
    setSuccessMessage(null)
    const to = selectedRecipients.map((r) => r.email)
    if (to.length === 0) {
      setErrorMessage('Ajoutez au moins un destinataire dans le champ « À »')
      return
    }
    const trimmedSubject = subject.trim()
    if (!trimmedSubject) {
      setErrorMessage("L'objet ne peut pas être vide")
      return
    }
    // The client must read the shipment's anomalies in the mail (#1266):
    // deleting the pre-filled paragraph is allowed, but never by accident.
    const points = defaults?.points_a_signaler ?? []
    if (points.length > 0 && !confirmeSansPoints && !body.includes(POINTS_A_SIGNALER_TITRE)) {
      setPendingSansPoints({ programme })
      return
    }
    const ccList = parseEmailList(cc)
    const bccList = parseEmailList(bcc)
    const invalide = [...ccList, ...bccList].find((a) => !EMAIL_REGEX.test(a))
    if (invalide) {
      setErrorMessage(`L'adresse « ${invalide} » n'est pas valide`)
      return
    }
    if (CORPS_RICHE.length + body.length > 20000) {
      setErrorMessage('Le message est trop long (20 000 caractères au plus, mise en forme comprise).')
      return
    }
    setIsSending(true)
    try {
      await onSend({
        to,
        cc: ccList,
        bcc: bccList,
        subject: trimmedSubject,
        body: CORPS_RICHE + body,
        attachPdf: pdfUrl ? attachPdf : false,
        userAttachments: userAttachments.map((a) => a.file),
        optionalAttachments: Object.fromEntries(
          visibleOptional.map((a) => [a.id, optionalChecked[a.id] === true]),
        ),
        ...(programme ? { programme: true } : {}),
      })
      setSuccessMessage(programme ? 'Envoi programmé' : 'Email envoyé avec succès')
      setTimeout(() => onClose(), 1200)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Échec de l'envoi")
    } finally {
      setIsSending(false)
    }
  }, [selectedRecipients, subject, cc, bcc, body, attachPdf, userAttachments, pdfUrl, onSend, onClose, visibleOptional, optionalChecked, defaults])

  // Dev-only "Faux envoi" — short-circuits to vincent@etsmalterre.com with
  // dev_skip_send=true so the backend logs envoi_email + flips sstatut
  // without actually calling Gmail. Lets the operator exercise status
  // transitions in dev without spamming real ennoblisseurs.
  const handleDevFakeSend = useCallback(async () => {
    setErrorMessage(null)
    setSuccessMessage(null)
    const trimmedSubject = subject.trim() || '[Faux envoi dev]'
    setIsSending(true)
    try {
      await onSend({
        to: ['vincent@etsmalterre.com'],
        cc: [],
        bcc: [],
        subject: trimmedSubject,
        body: CORPS_RICHE + (body || '<p>[Faux envoi dev — pas de corps]</p>'),
        attachPdf: false,
        userAttachments: [],
        optionalAttachments: {},
        devSkipSend: true,
      })
      setSuccessMessage('Faux envoi enregistré (statut mis à jour, aucun email réel envoyé)')
      setTimeout(() => onClose(), 1200)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Échec du faux envoi')
    } finally {
      setIsSending(false)
    }
  }, [subject, body, onSend, onClose])

  // ── Preview resolution ───────────────────────────────
  // Resolve what the right-pane viewer should render based on previewedId.
  // Kept as a tagged union so the render branch below is a flat switch.
  type ActivePreview =
    | { kind: 'server-pdf'; url: string }
    | { kind: 'user-pdf'; url: string; name: string }
    | { kind: 'user-image'; url: string; name: string }
    | { kind: 'user-unsupported'; name: string; type: string }
    | { kind: 'empty' }

  const activePreview = useMemo<ActivePreview>(() => {
    if (previewedId === 'server' && pdfUrl && attachPdf) {
      return { kind: 'server-pdf', url: `${pdfUrl}#view=FitH` }
    }
    if (previewedId && previewedId !== 'server') {
      const extra = extraServerAttachments?.find((a) => a.id === previewedId)
      if (extra) {
        return { kind: 'server-pdf', url: `${extra.url}#view=FitH` }
      }
      const optional = visibleOptional.find((a) => a.id === previewedId)
      if (optional) {
        return { kind: 'server-pdf', url: `${optional.url}#view=FitH` }
      }
      const att = userAttachments.find((a) => a.id === previewedId)
      if (att) {
        const type = att.file.type
        if (type === 'application/pdf') {
          return { kind: 'user-pdf', url: `${att.blobUrl}#view=FitH`, name: att.file.name }
        }
        if (type.startsWith('image/')) {
          return { kind: 'user-image', url: att.blobUrl, name: att.file.name }
        }
        return { kind: 'user-unsupported', name: att.file.name, type }
      }
    }
    return { kind: 'empty' }
  }, [previewedId, pdfUrl, attachPdf, userAttachments, extraServerAttachments, visibleOptional])

  // ── Render ───────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        className="max-w-6xl w-[92vw] h-[85vh] flex flex-col p-0 overflow-hidden"
        onClose={onClose}
      >
        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 border-b bg-gradient-to-r from-gold/25 via-gold/10 to-transparent">
          <DialogTitle className="flex items-center gap-2">
            <AtSign className="h-5 w-5 text-accent" />
            <span>{title}</span>
            {contextLabel && (
              <span className="text-muted-foreground font-normal text-base truncate">— {contextLabel}</span>
            )}
          </DialogTitle>
        </div>

        {/* Body — two-pane split */}
        <div className="flex-1 min-h-0 flex">
          {/* ── Left pane: form ── */}
          <div className="w-1/2 border-r flex flex-col min-w-0">
            {loadingDefaults ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-accent" />
              </div>
            ) : defaultsError ? (
              <div className="flex-1 flex flex-col items-center justify-center text-destructive">
                <AlertCircle className="h-8 w-8 mb-2" />
                <p className="text-sm">Impossible de charger les destinataires par défaut</p>
              </div>
            ) : (
              <>
                <div className="flex-1 min-h-0 flex flex-col p-4 gap-3 overflow-y-auto scrollbar-transparent">
                  {/* Envelope header — one bordered block, one row per field with
                      the label on the left (mail-client style), so À / Cc / Cci /
                      Objet cost a line each and the message keeps the room. The
                      Cc / Cci toggles sit at the end of the À row. */}
                  <div className="flex-shrink-0 rounded-md border border-input bg-white divide-y divide-border/60">
                    <div className="flex items-start gap-2 px-2.5 py-1.5">
                      <label className="w-10 flex-shrink-0 pt-1 text-xs font-medium text-muted-foreground">À</label>
                      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1">
                        {selectedRecipients.map((r) => (
                          <span
                            key={r.email}
                            className="inline-flex items-center gap-1 rounded-md bg-primary/[0.07] border border-primary/20 text-xs py-0.5 pl-1.5 pr-0.5 text-primary"
                            title={r.email}
                          >
                            {r.source === 'contact' && <User className="h-3 w-3 flex-shrink-0 opacity-70" />}
                            <span className="max-w-[180px] truncate">{r.name || r.email}</span>
                            <button
                              type="button"
                              onClick={() => removeRecipient(r.email)}
                              className="rounded-full hover:bg-primary/15 p-0.5 transition-colors"
                              title="Retirer"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                        <input
                          type="email"
                          value={manualInput}
                          onChange={(e) => setManualInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
                              e.preventDefault()
                              addManual()
                            }
                          }}
                          onBlur={() => { if (manualInput.trim()) addManual() }}
                          placeholder={selectedRecipients.length === 0 ? 'Ajouter un destinataire…' : 'ajouter…'}
                          className="flex-1 min-w-[8rem] h-6 px-1 text-xs bg-transparent focus:outline-none"
                          autoComplete="off"
                        />
                      </div>
                      <div className="flex items-center gap-0.5 flex-shrink-0">
                        {(['cc', 'bcc'] as const).map((f) => {
                          const on = f === 'cc' ? showCc : showBcc
                          return (
                            <button
                              key={f}
                              type="button"
                              onClick={() => toggleCopyField(f)}
                              aria-pressed={on}
                              title={f === 'cc'
                                ? (on ? 'Masquer le champ Cc' : 'Ajouter des destinataires en copie')
                                : (on ? 'Masquer le champ Cci' : 'Ajouter des destinataires en copie cachée')}
                              className={cn(
                                'px-1.5 py-0.5 text-[11px] rounded-md transition-colors',
                                on ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10',
                              )}
                            >
                              {f === 'cc' ? 'Cc' : 'Cci'}
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    {/* Contacts not pre-selected — one click adds them to À */}
                    {suggestions.length > 0 && (
                      <div className="flex items-center gap-2 px-2.5 py-1 bg-zinc-50">
                        <span className="w-10 flex-shrink-0 text-[10px] text-muted-foreground">Suggérés</span>
                        <div className="flex-1 min-w-0 flex flex-wrap gap-1">
                          {suggestions.map((r) => (
                            <button
                              key={r.email}
                              type="button"
                              onClick={() => addFromSuggestion(r)}
                              className="inline-flex items-center gap-0.5 rounded-md border border-dashed border-border text-[11px] py-0.5 px-1.5 text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors"
                              title={r.email}
                            >
                              <Plus className="h-3 w-3 flex-shrink-0" />
                              <span className="max-w-[180px] truncate">{r.name || r.email}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Cc — comma text, shown on demand (or when pre-filled) */}
                    {showCc && (
                      <div className="flex items-center gap-2 px-2.5 py-1">
                        <label className="w-10 flex-shrink-0 text-xs font-medium text-muted-foreground">Cc</label>
                        <AddressChipsInput value={cc} onChange={setCc} names={contactNames} placeholder="copie@exemple.com" />
                      </div>
                    )}

                    {/* Cci — comma text. Pre-filled (and therefore auto-shown) by
                        endpoints that copy a third party silently, e.g. the
                        sous-traitants holding the rolls of an expédition. */}
                    {showBcc && (
                      <div className="flex items-center gap-2 px-2.5 py-1">
                        <label className="w-10 flex-shrink-0 text-xs font-medium text-muted-foreground">Cci</label>
                        <AddressChipsInput value={bcc} onChange={setBcc} names={contactNames} placeholder="copie.cachee@exemple.com" />
                      </div>
                    )}

                    <div className="flex items-center gap-2 px-2.5 py-1">
                      <label className="w-10 flex-shrink-0 text-xs font-medium text-muted-foreground">Objet</label>
                      <input
                        type="text"
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        className="flex-1 min-w-0 h-7 px-1 text-sm font-medium bg-transparent focus:outline-none"
                        autoComplete="off"
                      />
                    </div>
                  </div>

                  {/* Body — anchored: fills remaining vertical space in the left pane */}
                  <div className="flex-1 min-h-0 flex flex-col gap-1">
                    {/* min-h keeps the message readable when Cc/Cci, the
                        points banner and the signature all show — the form
                        scrolls instead of crushing it (#1266 feedback). */}
                    <RichEmailEditor
                      value={body}
                      onChange={setBody}
                      className="flex-1 min-h-[16rem]"
                      footer={signatureHtml ? (
                        // The signature as the client will receive it — read-only, added
                        // by the server at send time (Paramètres › Utilisateurs).
                        <div
                          className="flex-shrink-0 mx-3 mb-2 pt-2 border-t border-dashed border-border select-none"
                          title={signatureIsDefault
                            ? "Signature automatique, ajoutée à l'envoi. Personnalisez-la dans Paramètres › Utilisateurs."
                            : "Signature ajoutée automatiquement à l'envoi"}
                        >
                          <SignaturePreview html={signatureHtml} autoHeight className="min-h-0 border-0 rounded-none pointer-events-none" />
                          <p className="text-[10px] text-muted-foreground/70 text-right">
                            {signatureIsDefault ? 'Signature automatique · personnalisable dans Paramètres › Utilisateurs' : 'Signature ajoutée à l’envoi'}
                          </p>
                        </div>
                      ) : undefined}
                    />
                  </div>
                </div>

                {/* Left pane footer — banners + actions */}
                <div className="flex-shrink-0 p-4 border-t bg-zinc-200/50 space-y-3">
                  {errorMessage && (
                    <div className="flex items-start gap-2 p-2.5 rounded-md border border-destructive/30 bg-destructive/5 text-destructive text-xs">
                      <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                      <p className="flex-1">{errorMessage}</p>
                    </div>
                  )}
                  {successMessage && (
                    <div className="flex items-start gap-2 p-2.5 rounded-md border border-green-500/30 bg-green-500/5 text-green-700 text-xs">
                      <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5" />
                      <p className="flex-1">{successMessage}</p>
                    </div>
                  )}
                  <div className="flex justify-end gap-2 items-center">
                    {secondaryAction && (
                      <Button variant="ghost" size="sm" onClick={secondaryAction.onClick} disabled={isSending}
                        className="mr-auto text-muted-foreground hover:text-foreground">
                        {secondaryAction.label}
                      </Button>
                    )}
                    {import.meta.env.DEV && (
                      <Button
                        variant="outline"
                        onClick={handleDevFakeSend}
                        disabled={isSending || loadingDefaults || !!successMessage}
                        title="Dev only — n'envoie pas réellement, mais déclenche les transitions de statut côté serveur"
                        className="mr-auto border-dashed border-amber-500/60 text-amber-700 hover:bg-amber-500/10"
                      >
                        Faux envoi (dev)
                      </Button>
                    )}
                    <Button variant="outline" onClick={onClose} disabled={isSending}>
                      Annuler
                    </Button>
                    {programmer && (
                      <Button
                        variant="outline"
                        onClick={() => handleSend(true)}
                        disabled={isSending || loadingDefaults || !!successMessage || !!programmer.disabledReason}
                        title={programmer.disabledReason ?? programmer.title}
                      >
                        <CalendarClock className="h-3.5 w-3.5 mr-1.5" />
                        {programmer.label}
                      </Button>
                    )}
                    <Button
                      onClick={() => handleSend()}
                      disabled={isSending || loadingDefaults || !!successMessage}
                    >
                      {isSending ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          Envoi…
                        </>
                      ) : (
                        <>
                          <Mail className="h-3.5 w-3.5 mr-1.5" />
                          Envoyer
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* ── Right pane: viewer (top) + attachment strip (bottom) ── */}
          <div className="w-1/2 flex flex-col bg-zinc-200/50 min-w-0">
            {/* Viewer area — renders whichever attachment is currently selected */}
            <div className="flex-1 min-h-0 flex">
              {activePreview.kind === 'server-pdf' || activePreview.kind === 'user-pdf' ? (
                <iframe
                  key={activePreview.url}
                  src={activePreview.url}
                  className="w-full h-full border-0"
                  title="Aperçu du document"
                />
              ) : activePreview.kind === 'user-image' ? (
                <div className="w-full h-full flex items-center justify-center p-4 overflow-auto">
                  <img
                    src={activePreview.url}
                    alt={activePreview.name}
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
              ) : activePreview.kind === 'user-unsupported' ? (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground px-6 text-center">
                  <FileText className="h-12 w-12 opacity-30 mb-3" />
                  <p className="text-sm font-medium">Aperçu non disponible pour ce type de fichier</p>
                  <p className="text-xs mt-1 max-w-[280px] truncate" title={activePreview.name}>
                    {activePreview.name}
                  </p>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
                  <FileText className="h-12 w-12 opacity-30 mb-3" />
                  <p className="text-sm">Aucun document à prévisualiser</p>
                </div>
              )}
            </div>

            {/* Attachment strip */}
            <div className="flex-shrink-0 border-t border-border/60 bg-white/70 px-3 py-2.5">
              <div className="flex items-start gap-2">
                <Paperclip className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 mt-1.5" />
                <div className="flex-1 min-w-0 flex flex-wrap gap-1.5 items-center">
                  {/* Server-rendered PDF chip (only when pdfUrl && still included).
                      Clicking the pill body selects it as the preview target;
                      clicking the inner ✕ removes it from the send. */}
                  {pdfUrl && attachPdf && (
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => selectPreview('server')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          selectPreview('server')
                        }
                      }}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md bg-white border shadow-sm text-xs py-1 pl-2 pr-1 text-foreground cursor-pointer transition-colors',
                        previewedId === 'server'
                          ? 'border-accent ring-2 ring-accent/60'
                          : 'border-border/60 hover:bg-zinc-50',
                      )}
                      title={pdfAttachmentLabel}
                    >
                      <FileText className="h-3 w-3 text-accent flex-shrink-0" />
                      <span className="max-w-[180px] truncate">{pdfAttachmentLabel}</span>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeServerPdf() }}
                        className="rounded-full hover:bg-destructive/20 hover:text-destructive p-0.5 transition-colors"
                        title="Retirer la pièce jointe"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )}

                  {/* Optional server documents (rapport de contrôle, info
                      matières…) — leading checkbox toggles whether the API
                      attaches them; the chip body previews (even unticked). */}
                  {visibleOptional.map((a) => {
                    const isChecked = optionalChecked[a.id] === true
                    return (
                      <div
                        key={a.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => selectPreview(a.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            selectPreview(a.id)
                          }
                        }}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-md bg-white border shadow-sm text-xs py-1 px-2 text-foreground cursor-pointer transition-colors',
                          previewedId === a.id
                            ? 'border-accent ring-2 ring-accent/60'
                            : 'border-border/60 hover:bg-zinc-50',
                        )}
                        title={isChecked ? `${a.label} - sera joint à l'email` : `${a.label} - non joint (cochez pour l'ajouter)`}
                      >
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={isChecked}
                          onClick={(e) => { e.stopPropagation(); toggleOptional(a.id) }}
                          className={cn(
                            'h-3.5 w-3.5 rounded-[3px] border flex items-center justify-center flex-shrink-0 transition-colors',
                            isChecked
                              ? 'bg-accent border-accent text-accent-foreground'
                              : 'bg-white border-border hover:border-accent/60',
                          )}
                          title={isChecked ? 'Ne pas joindre' : 'Joindre à l\'email'}
                        >
                          {isChecked && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                        </button>
                        <FileText className={cn('h-3 w-3 flex-shrink-0', isChecked ? 'text-accent' : 'text-muted-foreground/60')} />
                        <span className={cn('max-w-[180px] truncate', !isChecked && 'text-muted-foreground/70')}>{a.label}</span>
                      </div>
                    )
                  })}

                  {/* Always-attached server documents (CGV…) — click to
                      preview, no ✕: the API attaches them unconditionally. */}
                  {(extraServerAttachments ?? []).map((a) => (
                    <div
                      key={a.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => selectPreview(a.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          selectPreview(a.id)
                        }
                      }}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md bg-white border shadow-sm text-xs py-1 px-2 text-foreground cursor-pointer transition-colors',
                        previewedId === a.id
                          ? 'border-accent ring-2 ring-accent/60'
                          : 'border-border/60 hover:bg-zinc-50',
                      )}
                      title={`${a.label} - joint automatiquement`}
                    >
                      <FileText className="h-3 w-3 text-accent flex-shrink-0" />
                      <span className="max-w-[180px] truncate">{a.label}</span>
                    </div>
                  ))}

                  {/* User-uploaded attachment chips — same click-to-preview +
                      inner ✕-to-remove mechanics. */}
                  {userAttachments.map((a) => (
                    <div
                      key={a.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => selectPreview(a.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          selectPreview(a.id)
                        }
                      }}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md bg-white border shadow-sm text-xs py-1 pl-2 pr-1 text-foreground cursor-pointer transition-colors',
                        previewedId === a.id
                          ? 'border-accent ring-2 ring-accent/60'
                          : 'border-border/60 hover:bg-zinc-50',
                      )}
                      title={`${a.file.name} — ${formatFileSize(a.file.size)}`}
                    >
                      <FileText className="h-3 w-3 text-accent flex-shrink-0" />
                      <span className="max-w-[160px] truncate">{a.file.name}</span>
                      <span className="text-[10px] text-muted-foreground">{formatFileSize(a.file.size)}</span>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeUserAttachment(a.id) }}
                        className="rounded-full hover:bg-destructive/20 hover:text-destructive p-0.5 transition-colors"
                        title="Retirer la pièce jointe"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}

                  {/* Add file button */}
                  <button
                    type="button"
                    onClick={openFilePicker}
                    className="inline-flex items-center gap-1 rounded-md border border-dashed border-accent/40 text-xs py-1 px-2 text-muted-foreground hover:bg-accent/10 hover:border-accent hover:text-accent cursor-pointer transition-colors"
                  >
                    <Plus className="h-3 w-3" />
                    Ajouter un fichier
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onClick={(e) => { (e.target as HTMLInputElement).value = '' }}
                    onChange={(e) => handleFilePick(e.target.files)}
                  />

                  {totalUserAttachmentBytes > 0 && (
                    <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
                      {formatFileSize(totalUserAttachmentBytes)} / {formatFileSize(MAX_TOTAL_ATTACHMENT_BYTES)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
        <ConfirmDialog
          open={pendingSansPoints !== null}
          variant="default"
          title="Envoyer sans les points à signaler ?"
          description={
            `Le message ne contient plus le paragraphe « ${POINTS_A_SIGNALER_TITRE} ». ` +
            `Le client ne sera pas prévenu dans l'email de : ${(defaults?.points_a_signaler ?? []).join(' ; ')}.`
          }
          confirmLabel="Envoyer quand même"
          cancelLabel="Revenir au message"
          onCancel={() => setPendingSansPoints(null)}
          onConfirm={() => {
            const mode = pendingSansPoints
            setPendingSansPoints(null)
            if (mode) void handleSend(mode.programme, true)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
