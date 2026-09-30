// Name picker — the pre-2026-09-30 identification, kept as a TRANSITION
// fallback behind the login screen: shown only while the API runs with
// AUTH_PICKER=1 (routes/auth.ts). It is the hole passwords close, so the flag
// goes off once every person has a password.

import { useQuery } from '@tanstack/react-query'
import { Loader2, AlertCircle, ArrowLeft } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useUser } from '@/contexts/UserContext'
import { cn } from '@/lib/utils'
import { AuthLayout } from './AuthLayout'

interface PickerUser {
  IDutilisateur: number
  prenom: string | null
  nom: string | null
  /** Station accounts only (lowercased first name) — labels their role. */
  roleHint: string | null
}

// Station accounts represent a role rather than an individual.
const ROLE_LABELS: Array<{ test: (pc: string) => boolean; label: string }> = [
  { test: (pc) => pc.includes('visitage'), label: 'Inspection qualité' },
  { test: (pc) => pc.includes('regleur'), label: 'Réglage machines' },
]

function roleLabel(roleHint: string | null): string | null {
  if (!roleHint) return null
  for (const r of ROLE_LABELS) if (r.test(roleHint)) return r.label
  return null
}

function initials(u: PickerUser): string {
  const p = (u.prenom?.trim() ?? '')[0] ?? ''
  const n = (u.nom?.trim() ?? '')[0] ?? ''
  const pair = `${p}${n}`.toUpperCase()
  return pair || '?'
}

function displayName(u: PickerUser): string {
  const p = u.prenom?.trim() ?? ''
  const n = u.nom?.trim() ?? ''
  return [p, n].filter(Boolean).join(' ') || '—'
}

export function UserPicker({ onBack }: { onBack: () => void }) {
  const { loginPicker } = useUser()

  const { data, isLoading, isError, refetch } = useQuery<PickerUser[]>({
    queryKey: ['auth', 'users'],
    queryFn: () => apiFetch<PickerUser[]>('/auth/users'),
    staleTime: Infinity,
    // A wedged API answers with a ~15 s timeout per attempt: one retry, then
    // the error with a manual Réessayer.
    retry: 1,
  })

  return (
    <AuthLayout>
      <button
        type="button"
        onClick={onBack}
        className="mb-6 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-accent transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Se connecter avec un identifiant
      </button>
      <h1 className="text-4xl font-heading font-bold text-primary tracking-tight mb-3">
        Qui êtes-vous ?
      </h1>
      <p className="text-sm text-muted-foreground mb-12 max-w-md text-center">
        Mode de transition : sélectionnez votre nom. Bientôt, chacun se connectera
        avec son identifiant et son mot de passe.
      </p>

      {isLoading && (
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin text-accent" />
          <p className="text-sm">Chargement de la liste des utilisateurs…</p>
        </div>
      )}

      {isError && (
        <div className="flex flex-col items-center gap-3 text-destructive">
          <AlertCircle className="h-8 w-8" />
          <p className="text-sm">Impossible de charger la liste. Vérifiez que l'API est accessible.</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="mt-1 px-4 py-1.5 text-sm font-medium rounded-md border border-input bg-white text-foreground hover:bg-accent/10 hover:text-accent transition-colors cursor-pointer"
          >
            Réessayer
          </button>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 w-full max-w-5xl">
          {data.map((u) => {
            const role = roleLabel(u.roleHint)
            return (
              <button
                key={u.IDutilisateur}
                onClick={() => void loginPicker(u.IDutilisateur).catch(() => refetch())}
                className={cn(
                  'group relative flex flex-col items-center gap-3 p-5 rounded-xl',
                  'bg-white border border-border/60 shadow-sm',
                  'hover:border-accent hover:ring-2 hover:ring-accent/30 hover:shadow-md',
                  'transition-all duration-150 cursor-pointer',
                )}
              >
                <div className="h-16 w-16 rounded-full bg-gold flex items-center justify-center text-gold-foreground text-xl font-heading font-bold shadow-sm">
                  {initials(u)}
                </div>
                <div className="text-center">
                  <p className="text-base font-bold text-primary leading-tight">{displayName(u)}</p>
                  {role && (
                    <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wide">{role}</p>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </AuthLayout>
  )
}
