// « + Nouveau » of Paramètres › Utilisateurs: creates an account (a person, or
// a station account for an enrolled PC). The password is set afterwards from
// the account panel — it is shown once there.

import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { AlertCircle, Loader2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { apiFetch } from '@/lib/api'
import { messageErreur } from '@/contexts/UserContext'
import type { Compte } from './CompteSidebar'

const inputClass = 'w-full h-9 px-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function NouveauCompteDialog({ open, onClose, onCreated }: {
  open: boolean
  onClose: () => void
  onCreated: (c: Compte) => void
}) {
  const [prenom, setPrenom] = useState('')
  const [nom, setNom] = useState('')
  const [identifiant, setIdentifiant] = useState('')
  const [identifiantTouche, setIdentifiantTouche] = useState(false)
  const [email, setEmail] = useState('')
  const [type, setType] = useState<1 | 2>(1)
  useEffect(() => {
    if (!open) { setPrenom(''); setNom(''); setIdentifiant(''); setIdentifiantTouche(false); setEmail(''); setType(1) }
  }, [open])
  // The identifiant follows the first name until the admin types their own.
  useEffect(() => { if (!identifiantTouche) setIdentifiant(slug(prenom)) }, [prenom, identifiantTouche])

  const mut = useMutation({
    mutationFn: () => apiFetch<Compte>('/comptes', {
      method: 'POST',
      body: JSON.stringify({
        prenom: prenom.trim(),
        nom: nom.trim(),
        identifiant: identifiant.trim().toLowerCase(),
        email: email.trim(),
        typeCompte: type === 2 ? 'poste' : 'personne',
      }),
    }),
    onSuccess: onCreated,
  })

  const valide = prenom.trim().length > 0 && identifiant.trim().length >= 2 && (type === 2 || nom.trim().length > 0)

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-accent" />
            Nouveau compte
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1 col-span-full">
            <label className="text-xs font-medium text-muted-foreground">Type</label>
            <PopoverSelect
              value={type}
              onChange={(v) => setType(v === 2 ? 2 : 1)}
              hideEmpty
              options={[
                { id: 1, primary: 'Personne', description: 'Se connecte avec un identifiant et un mot de passe.' },
                { id: 2, primary: 'Poste d’atelier', description: 'Un PC partagé (visitage…), enrôlé par un code.' },
              ]}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{type === 2 ? 'Nom du poste' : 'Prénom'}</label>
            <input autoFocus value={prenom} onChange={(e) => setPrenom(e.target.value)} className={inputClass} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Nom{type === 2 ? ' (facultatif)' : ''}</label>
            <input value={nom} onChange={(e) => setNom(e.target.value)} className={inputClass} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Identifiant</label>
            <input
              value={identifiant}
              onChange={(e) => { setIdentifiant(e.target.value); setIdentifiantTouche(true) }}
              autoCapitalize="none"
              spellCheck={false}
              className={inputClass}
            />
          </div>
          {type === 1 && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">E-mail (facultatif)</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
            </div>
          )}
          <p className="col-span-full text-[11px] text-muted-foreground">
            {type === 2
              ? 'Ensuite, générez un code d’enrôlement depuis le panneau Compte et saisissez-le sur le PC.'
              : 'Ensuite, définissez son mot de passe depuis le panneau Compte, puis ses écrans et ses droits.'}
          </p>
        </div>
        {mut.error && (
          <p className="mt-3 text-xs text-destructive flex items-start gap-1">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
            {messageErreur(mut.error, 'Création impossible.')}
          </p>
        )}
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => mut.mutate()} disabled={!valide || mut.isPending}>
            {mut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5 mr-1.5" />}
            Créer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
