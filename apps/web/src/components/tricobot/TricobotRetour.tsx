// « Former Tricobot » — the one way a person tells an AI agent it got an item
// wrong (decision Vincent 2026-10-02). Users only ever see Tricobot; the
// server routes the feedback to the agent that produced the item (BL
// Ennoblisseur, Superviseur, Factures Ennoblisseur — apps/api/src/lib/agents/
// retours.ts).
//
//   - silence = Tricobot was right (recorded when the person handles the
//     item: invoice validated, rolls received, point « Traité »);
//   - this button = he was not, always with a why — what the next version of
//     his prompt is written from.
//
// Three pieces: the small mascot button on the item, the dialog asking why,
// and the chip that shows the correction once given.

import { useEffect, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TricobotMascot } from '@/components/icons/TricobotMascot'
import { cn } from '@/lib/utils'

/** Small pill on an item Tricobot produced: « Tricobot s'est trompé ? ». */
export function TricobotBouton({ onClick, disabled, label = 'Tricobot s’est trompé ?', title }: {
  onClick: () => void
  disabled?: boolean
  label?: string
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? 'Dire à Tricobot ce qui n’allait pas — il s’en sert pour s’améliorer'}
      className="h-6 pl-1 pr-2 rounded-md border border-border bg-white inline-flex items-center gap-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent/10 hover:border-accent/40 disabled:opacity-50"
    >
      <TricobotMascot className="h-4 w-4" />{label}
    </button>
  )
}

/** The correction once given — red, with the why and who said it. */
export function TricobotCorrection({ commentaire, par, onAnnuler, disabled, className }: {
  commentaire: string
  par?: string | null
  onAnnuler?: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <div className={cn('rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11px] flex items-start gap-1.5', className)}>
      <TricobotMascot className="h-4 w-4 mt-px" />
      <span className="min-w-0 flex-1">
        <span className="font-semibold text-destructive">Tricobot corrigé</span>
        {commentaire && <span className="text-foreground"> — {commentaire}</span>}
        {par && <span className="text-muted-foreground"> · {par}</span>}
      </span>
      {onAnnuler && (
        <button type="button" onClick={onAnnuler} disabled={disabled} className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors">
          Annuler
        </button>
      )}
    </div>
  )
}

/** Asks why Tricobot was wrong. The why is required. */
export function TricobotRetourDialog({ open, titre = 'Je me suis trompé ?', sujet, texte, placeholder, isPending, onClose, onConfirm }: {
  open: boolean
  /** Tricobot's own words (« Je me suis trompé ! »). */
  titre?: string
  /** What the feedback is about, appended to the title (« MA109337 »). */
  sujet?: string | null
  texte?: string
  placeholder?: string
  isPending: boolean
  onClose: () => void
  onConfirm: (commentaire: string) => Promise<void>
}) {
  const [commentaire, setCommentaire] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (open) { setCommentaire(''); setError(null) } }, [open])
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle>{sujet ? `Former Tricobot — ${sujet}` : 'Former Tricobot'}</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          {/* Tricobot speaks for himself: the mascot, and his words in a bubble. */}
          <div className="flex items-end gap-3">
            <TricobotMascot className="h-24 w-24 -mb-1" />
            <div className="relative min-w-0 flex-1 rounded-xl rounded-bl-none border border-accent/30 bg-accent/10 px-3 py-2.5">
              <p className="text-sm font-semibold">{titre}</p>
              <p className="mt-0.5 text-sm text-foreground/80">{texte ?? 'Dis-moi ce qui n’allait pas : je m’en sers pour ne plus refaire l’erreur.'}</p>
            </div>
          </div>
          <textarea
            rows={3}
            autoFocus
            value={commentaire}
            onChange={(e) => setCommentaire(e.target.value)}
            placeholder={placeholder}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          />
          {error && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="h-4 w-4" />{error}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button
            disabled={isPending || !commentaire.trim()}
            onClick={async () => {
              setError(null)
              try { await onConfirm(commentaire.trim()) } catch (e) { setError(e instanceof Error ? e.message : 'Erreur') }
            }}
          >
            {isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Envoyer à Tricobot
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
