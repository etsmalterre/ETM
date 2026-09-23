import { AlertCircle, AlertTriangle, Trash2, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from '@/components/ui/alert-dialog'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'destructive' | 'default'
  isPending?: boolean
  /** Why the last confirm was refused (the server's message). Shown under
   *  the description; the dialog stays open so the user can read it. */
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Annuler',
  variant = 'destructive',
  isPending = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const isDestructive = variant === 'destructive'
  const Icon = isDestructive ? AlertTriangle : null
  const resolvedConfirmLabel = confirmLabel ?? (isDestructive ? 'Supprimer' : 'Confirmer')

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {Icon && <Icon className="h-5 w-5 text-destructive" />}
            {title}
          </AlertDialogTitle>
          {!!description && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {!!error && (
          <div className="mt-3 flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        <AlertDialogFooter className="gap-2 sm:gap-2 mt-4">
          <Button variant="outline" onClick={onCancel} disabled={isPending}>
            <X className="h-4 w-4 mr-2" />
            {cancelLabel}
          </Button>
          <Button
            variant={isDestructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              isDestructive && <Trash2 className="h-4 w-4 mr-2" />
            )}
            {resolvedConfirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
