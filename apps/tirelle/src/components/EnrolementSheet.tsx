// « Enrôler cette tablette » — the one-time code, typed once.
//
// The admin generates a six-digit code in the Console Administration ›
// Utilisateurs › Appareils (type « Tablette labo »); the tablet posts it and
// receives its own cookie (`mps_tirelle`). Copied from TRM/apps/pointage.
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { FlaskConical, Loader2 } from 'lucide-react'
import { enrolerAppareil } from '@/lib/tirelle-api'
import { useAppareil } from '@/contexts/AppareilContext'
import { messagePourErreur } from '@/lib/erreurs'
import { cn } from '@/lib/utils'

export function EnrolementSheet({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState('')
  const { rafraichir } = useAppareil()

  const mut = useMutation({
    mutationFn: (c: string) => enrolerAppareil(c),
    onSuccess: async () => {
      await rafraichir()
      onClose()
    },
  })

  const pret = /^\d{6}$/.test(code) && !mut.isPending

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
      onClick={() => !mut.isPending && onClose()}
      role="presentation"
    >
      <form
        className="w-full max-w-md bg-card text-foreground rounded-2xl p-6 space-y-5 shadow-xl animate-fade-in"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (pret) mut.mutate(code)
        }}
      >
        <div>
          <h2 className="text-2xl font-heading font-bold tracking-tight flex items-center gap-2">
            <FlaskConical className="h-6 w-6 text-gold" />
            Enrôler cette tablette
          </h2>
          <p className="text-base text-muted-foreground mt-1">
            Saisissez le code à six chiffres affiché dans la Console Administration › Utilisateurs › Appareils.
          </p>
        </div>

        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          autoFocus
          maxLength={6}
          value={code}
          onChange={(e) => {
            setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
            mut.reset()
          }}
          disabled={mut.isPending}
          aria-label="Code d’enrôlement"
          className={cn(
            'w-full h-16 rounded-xl border border-border bg-background text-center select-text',
            'text-3xl font-heading font-bold tracking-[0.4em] tabular-nums',
            'focus:outline-none focus:ring-2 focus:ring-gold',
            mut.isError && 'border-destructive',
          )}
        />

        {mut.isError && (
          <p className="text-base text-destructive" role="alert">
            {messagePourErreur(mut.error)}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={mut.isPending}
            className="h-14 rounded-xl border border-border bg-background text-lg font-semibold active:bg-muted disabled:opacity-40"
          >
            Annuler
          </button>
          <button
            type="submit"
            disabled={!pret}
            className="h-14 rounded-xl bg-gold text-gold-foreground text-lg font-semibold flex items-center justify-center gap-2 active:opacity-90 disabled:opacity-40"
          >
            {mut.isPending && <Loader2 className="h-5 w-5 animate-spin" />}
            Enrôler
          </button>
        </div>
      </form>
    </div>
  )
}
