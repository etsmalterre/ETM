import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { AlertCircle, Loader2 } from 'lucide-react'
import { useRhAcces } from '@/hooks/useRhAcces'

/** Wraps every RH screen. Two outcomes:
 *   • without the RH grant (lib/rh-acces.ts on the API) → home, the menu does
 *     not exist for them;
 *   • granted → the screen.
 *  The API enforces the same thing on every /rh route, behind the Console
 *  Administration membership; this is the UI of it. */
export function RhGate({ children }: { children: ReactNode }) {
  const { data: acces, isLoading } = useRhAcces()

  if (isLoading || !acces) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    )
  }
  if (!acces.autorise) return <Navigate to="/" replace />
  if (acces.configure === false) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <p className="text-sm text-muted-foreground flex items-center gap-1.5">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          La base RH n’est pas configurée sur ce serveur.
        </p>
      </div>
    )
  }

  return <>{children}</>
}
