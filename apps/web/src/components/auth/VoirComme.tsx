// « Voir comme » — an administrator sees the app exactly as another account
// does (their menus, their rights, no admin bypass), without their password.
// The session keeps the admin as owner (session.voir_comme on the API), so
// coming back needs no login. Shared with TRM through `@etm`.
//
// Switching reloads the page: every cached query was fetched as the previous
// identity, and a reload is the only reset that cannot miss one.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Eye, Loader2, Search, Undo2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAppCode, useUser, type AppCode } from '@/contexts/UserContext'

interface CompteListe {
  IDutilisateur: number
  prenom: string | null
  nom: string | null
  typeCompte: 'personne' | 'poste'
  apps?: AppCode[]
}

async function voirComme(id: number | null): Promise<void> {
  await apiFetch('/auth/voir-comme', { method: 'POST', body: JSON.stringify({ IDutilisateur: id }) })
  window.location.reload()
}

const nomDe = (c: { prenom: string | null; nom: string | null }) =>
  [c.prenom?.trim(), c.nom?.trim()].filter(Boolean).join(' ') || '—'

export function VoirCommeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useUser()
  const app = useAppCode()
  const [recherche, setRecherche] = useState('')
  const [enCours, setEnCours] = useState<number | null>(null)
  const { data, isLoading } = useQuery<CompteListe[]>({
    queryKey: ['auth', 'users'],
    queryFn: () => apiFetch('/auth/users'),
    enabled: open,
    staleTime: 60_000,
  })
  const moi = user?.voirComme?.IDutilisateur ?? user?.IDutilisateur
  const q = recherche.trim().toLowerCase()
  // This app's members only: looking through a non-member ends on the gate's refusal.
  const comptes = (data ?? []).filter((c) =>
    c.IDutilisateur !== moi && (!c.apps || c.apps.includes(app)) && (!q || nomDe(c).toLowerCase().includes(q)))

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="h-5 w-5 text-accent" />
            Voir l’application comme…
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Vous voyez les menus et les droits de la personne choisie, sans vos droits d’administrateur.
            Vous restez connecté : un bouton en bas de l’écran vous ramène à votre compte.
          </p>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              autoFocus
              value={recherche}
              onChange={(e) => setRecherche(e.target.value)}
              placeholder="Rechercher"
              className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="max-h-72 overflow-y-auto space-y-1.5 scrollbar-transparent p-0.5">
            {isLoading && <Loader2 className="h-5 w-5 animate-spin text-accent mx-auto my-4" />}
            {comptes.map((c) => (
              <button
                key={c.IDutilisateur}
                type="button"
                disabled={enCours !== null}
                onClick={() => { setEnCours(c.IDutilisateur); void voirComme(c.IDutilisateur).catch(() => setEnCours(null)) }}
                className={cn(
                  'w-full flex items-center justify-between gap-2 p-2.5 rounded-lg border border-border/60 bg-white text-left text-sm',
                  'hover:border-accent/50 transition-colors disabled:opacity-60',
                )}
              >
                <span className="font-medium truncate">{nomDe(c)}</span>
                {enCours === c.IDutilisateur ? (
                  <Loader2 className="h-4 w-4 animate-spin text-accent flex-shrink-0" />
                ) : c.typeCompte === 'poste' ? (
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground flex-shrink-0">Poste</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Fixed pill, bottom-left, while looking through another account. */
export function VoirCommeBandeau() {
  const { user } = useUser()
  const [pending, setPending] = useState(false)
  if (!user?.voirComme) return null
  return (
    <div className="fixed bottom-3 left-3 z-[60] flex items-center gap-2 rounded-full bg-primary text-primary-foreground shadow-lg pl-3 pr-1 py-1 text-xs">
      <Eye className="h-3.5 w-3.5 text-gold flex-shrink-0" />
      <span className="truncate max-w-[50vw]">
        Vous voyez l’application comme <strong>{nomDe(user)}</strong>
      </span>
      <button
        type="button"
        disabled={pending}
        onClick={() => { setPending(true); void voirComme(null).catch(() => setPending(false)) }}
        className="flex items-center gap-1 rounded-full bg-gold text-gold-foreground px-2.5 py-1 font-semibold hover:bg-gold/90 disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
        Revenir à {user.voirComme.prenom ?? 'moi'}
      </button>
    </div>
  )
}
