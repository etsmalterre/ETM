import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { POLL_MS } from './lib/rafraichissement'
import { installerMiseAJour } from './lib/mise-a-jour'
import { installerPleinEcran } from './lib/plein-ecran'
import { AppareilProvider, useAppareil } from './contexts/AppareilContext'
import { NonEnrolee } from './pages/NonEnrolee'
import { Labo } from './pages/Labo'
import './index.css'

// Dev-only: a feature worktree writes VITE_WORKTREE_LABEL to
// .env.development.local; prefix the tab title so parallel tabs stay apart.
const worktreeLabel = import.meta.env.VITE_WORKTREE_LABEL
if (import.meta.env.DEV && worktreeLabel) {
  document.title = `${worktreeLabel} · ${document.title}`
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The queue changes under the tablet (BLs recorded at the office, a
      // reprise decided by Isabelle): every mounted query re-reads on POLL_MS,
      // and again when the screen wakes or the network returns.
      staleTime: POLL_MS,
      refetchInterval: POLL_MS,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: 1,
    },
  },
})

// A deploy reaches the tablet on its own (lib/mise-a-jour.ts).
installerMiseAJour(queryClient)
// Nothing but the app on the bench, even outside an installed WebAPK (lib/plein-ecran.ts).
installerPleinEcran()

/** Nothing renders until the server has said this is the enrolled lab tablet. */
function Gate({ children }: { children: React.ReactNode }) {
  const { appareil } = useAppareil()
  if (appareil === undefined) return <Attente />
  if (!appareil) return <NonEnrolee />
  return <>{children}</>
}

function Attente() {
  return (
    <div className="h-full bg-gradient-brand flex items-center justify-center">
      <img src="/logo-full.png" alt="Malterre" className="h-14 w-auto" />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppareilProvider>
        <Gate>
          <Labo />
        </Gate>
      </AppareilProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
