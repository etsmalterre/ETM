import { useEffect, useState, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Loader2, Lock, LockKeyhole, Unlock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HeaderActions } from '@/contexts/HeaderActionsContext'
import { useRhAcces, RH_ACCES_KEY } from '@/hooks/useRhAcces'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'

/** Wraps every RH screen. Three outcomes:
 *   • not one of the two people (lib/rh-acces.ts on the API) → home, the menu
 *     does not exist for them;
 *   • the right person without a code session → the lock screen;
 *   • unlocked → the screen, plus « Verrouiller » in the header.
 *  The API enforces the same thing on every /rh route; this is the UI of it. */
export function RhGate({ children }: { children: ReactNode }) {
  const { data: acces, isLoading } = useRhAcces()
  const queryClient = useQueryClient()

  const verrouiller = useMutation({
    mutationFn: () => apiFetch('/rh/verrouiller', { method: 'POST' }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['rh'], predicate: (q) => q.queryKey[1] !== 'acces' })
      queryClient.invalidateQueries({ queryKey: RH_ACCES_KEY })
    },
  })

  // The code session lasts 12 h: when it runs out mid-use, any RH query answers
  // 401 — ask /rh/acces again so the lock screen comes back instead of errors.
  useEffect(() => {
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.query.queryKey[0] !== 'rh') return
      const err = event.query.state.error as { status?: number } | null
      if (event.query.state.status === 'error' && err?.status === 401) {
        queryClient.invalidateQueries({ queryKey: RH_ACCES_KEY })
      }
    })
  }, [queryClient])

  if (isLoading || !acces) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    )
  }
  if (!acces.autorise) return <Navigate to="/" replace />
  if (!acces.deverrouille) return <EcranVerrouille personne={acces.personne ?? ''} codeDefini={!!acces.codeDefini} configure={acces.configure !== false} parMotDePasse={acces.methode === 'mot_de_passe'} />

  return (
    <>
      <HeaderActions>
        <Button
          variant="outline"
          size="sm"
          title="Verrouiller l’espace RH sur cet ordinateur"
          onClick={() => verrouiller.mutate()}
          disabled={verrouiller.isPending}
        >
          <Lock className="h-3.5 w-3.5 sm:mr-1.5" />
          <span className="hidden sm:inline">Verrouiller</span>
        </Button>
      </HeaderActions>
      {children}
    </>
  )
}

function EcranVerrouille({ personne, codeDefini, configure, parMotDePasse }: { personne: string; codeDefini: boolean; configure: boolean; parMotDePasse: boolean }) {
  const queryClient = useQueryClient()
  const [code, setCode] = useState('')
  const [erreur, setErreur] = useState<string | null>(null)

  const deverrouiller = useMutation({
    mutationFn: () => apiFetch('/rh/deverrouiller', { method: 'POST', body: JSON.stringify(parMotDePasse ? { motDePasse: code } : { code }) }),
    onSuccess: () => {
      setCode('')
      queryClient.invalidateQueries({ queryKey: RH_ACCES_KEY })
    },
    onError: (err: Error & { body?: { message?: string } }) => {
      setCode('')
      setErreur(err.body?.message ?? 'Le déverrouillage a échoué.')
    },
  })

  const bloque = !configure || !codeDefini

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border bg-card shadow-md overflow-hidden">
        <div className="flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5">
          <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
            <LockKeyhole className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-heading font-bold tracking-tight text-primary-foreground">Espace RH</h2>
            <p className="text-xs text-white/70 truncate">{personne}</p>
          </div>
        </div>
        <form
          className="p-5 space-y-3 bg-zinc-100/80"
          onSubmit={(e) => {
            e.preventDefault()
            setErreur(null)
            if (code) deverrouiller.mutate()
          }}
        >
          {!configure ? (
            <p className="text-sm text-muted-foreground">La base RH n’est pas configurée sur ce serveur.</p>
          ) : !codeDefini ? (
            <p className="text-sm text-muted-foreground">
              Aucun code RH n’est encore défini pour vous. Il se définit sur le serveur, jamais depuis l’application.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {parMotDePasse
                  ? 'Ces informations sont personnelles. Saisissez à nouveau votre mot de passe pour continuer.'
                  : 'Ces informations sont personnelles. Saisissez votre code RH pour continuer.'}
              </p>
              <input
                type="password"
                inputMode={parMotDePasse ? undefined : 'numeric'}
                autoComplete={parMotDePasse ? 'current-password' : 'off'}
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={parMotDePasse ? 'Mot de passe' : 'Code RH'}
                aria-label={parMotDePasse ? 'Mot de passe' : 'Code RH'}
                className={cn(
                  'w-full h-10 px-3 rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring',
                  parMotDePasse ? 'text-sm' : 'text-center text-lg tracking-[0.3em] placeholder:tracking-normal placeholder:text-sm',
                )}
              />
            </>
          )}
          {erreur && (
            <p className="text-xs text-destructive flex items-center gap-1">
              <AlertCircle className="h-3 w-3 flex-shrink-0" />
              {erreur}
            </p>
          )}
          {!bloque && (
            <Button type="submit" className="w-full" disabled={!code || deverrouiller.isPending}>
              {deverrouiller.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Unlock className="h-3.5 w-3.5 mr-1.5" />}
              Déverrouiller
            </Button>
          )}
          <p className="text-[11px] text-muted-foreground text-center">
            L’accès reste ouvert 12 h sur cet ordinateur, ou jusqu’à « Verrouiller ».
          </p>
        </form>
      </div>
    </div>
  )
}
