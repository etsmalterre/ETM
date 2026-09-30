// Changing one's own password: the form (current + new + confirmation), used
// in two frames — a dialog from the profile menu, and the fullscreen step an
// account with a temporary password must pass before the app opens
// (doitChangerMdp). Shared with TRM through `@etm`.

import { useState } from 'react'
import { AlertCircle, CheckCircle2, KeyRound, Loader2, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api'
import { messageErreur, useUser } from '@/contexts/UserContext'
import { AuthCard, AuthLayout, authInputClass } from './AuthLayout'

const LONGUEUR_MIN = 8

function ChangePasswordForm({ onDone, onCancel, cancelLabel = 'Annuler' }: {
  onDone: () => void
  onCancel?: () => void
  cancelLabel?: string
}) {
  const [actuel, setActuel] = useState('')
  const [nouveau, setNouveau] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [erreur, setErreur] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [ok, setOk] = useState(false)
  const { user } = useUser()

  const tropCourt = nouveau.length > 0 && nouveau.trim().length < LONGUEUR_MIN
  const different = confirmation.length > 0 && confirmation !== nouveau
  const valide = actuel.length > 0 && nouveau.trim().length >= LONGUEUR_MIN && confirmation === nouveau

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!valide) return
    setErreur(null)
    setPending(true)
    try {
      await apiFetch('/auth/mot-de-passe', { method: 'POST', body: JSON.stringify({ actuel, nouveau }) })
      setOk(true)
      setTimeout(onDone, 900)
    } catch (err) {
      setErreur(messageErreur(err, 'Le changement a échoué.'))
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="space-y-3" method="post" action="/mot-de-passe" onSubmit={submit}>
      {/* Tells the password manager WHICH saved login the new password replaces. */}
      <input type="text" name="username" autoComplete="username" value={user?.identifiant ?? user?.email ?? ''}
        readOnly hidden />
      <div className="space-y-1">
        <label htmlFor="mdp-actuel" className="text-xs font-medium text-muted-foreground">Mot de passe actuel</label>
        <input id="mdp-actuel" name="current-password" type="password" autoFocus autoComplete="current-password" value={actuel}
          onChange={(e) => setActuel(e.target.value)} className={authInputClass} />
      </div>
      <div className="space-y-1">
        <label htmlFor="mdp-nouveau" className="text-xs font-medium text-muted-foreground">Nouveau mot de passe</label>
        <input id="mdp-nouveau" name="new-password" type="password" autoComplete="new-password" value={nouveau}
          onChange={(e) => setNouveau(e.target.value)} className={authInputClass} />
        <p className={tropCourt ? 'text-[11px] text-destructive' : 'text-[11px] text-muted-foreground'}>
          Au moins {LONGUEUR_MIN} caractères. Une phrase de plusieurs mots est idéale.
        </p>
      </div>
      <div className="space-y-1">
        <label htmlFor="mdp-confirmation" className="text-xs font-medium text-muted-foreground">Confirmer le nouveau mot de passe</label>
        <input id="mdp-confirmation" name="new-password-confirmation" type="password" autoComplete="new-password" value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)} className={authInputClass} />
        {different && <p className="text-[11px] text-destructive">Les deux saisies ne correspondent pas.</p>}
      </div>
      {erreur && (
        <p className="text-xs text-destructive flex items-start gap-1">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
          {erreur}
        </p>
      )}
      {ok && (
        <p className="text-xs text-success flex items-center gap-1">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Mot de passe modifié. Vos autres sessions ont été fermées.
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>{cancelLabel}</Button>
        )}
        <Button type="submit" disabled={!valide || pending || ok}>
          {pending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5 mr-1.5" />}
          Enregistrer
        </Button>
      </div>
    </form>
  )
}

/** From the profile menu. */
export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-sm" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-accent" />
            Changer mon mot de passe
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4">
          {open && <ChangePasswordForm onDone={onClose} onCancel={onClose} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Fullscreen step before the app opens, for an account whose password an
 *  administrator set as temporary. */
export function ForcedPasswordChange() {
  const { user, refresh, logout } = useUser()
  const nom = [user?.prenom, user?.nom].filter(Boolean).join(' ')
  return (
    <AuthLayout>
      <h1 className="text-3xl sm:text-4xl font-heading font-bold text-primary tracking-tight mb-3 text-center">
        Choisissez votre mot de passe
      </h1>
      <p className="text-sm text-muted-foreground mb-8 max-w-md text-center">
        Le mot de passe que vous venez d’utiliser est provisoire. Choisissez-en un
        que vous seul connaissez avant de continuer.
      </p>
      <AuthCard icon={<KeyRound className="h-[18px] w-[18px]" />} title="Nouveau mot de passe" subtitle={nom}>
        <ChangePasswordForm onDone={() => void refresh()} />
      </AuthCard>
      <button
        type="button"
        onClick={() => void logout()}
        className="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-accent transition-colors"
      >
        <LogOut className="h-3.5 w-3.5" />
        Se déconnecter
      </button>
    </AuthLayout>
  )
}
