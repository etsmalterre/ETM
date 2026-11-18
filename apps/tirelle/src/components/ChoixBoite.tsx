// The box where a lot's square and tirelle are stored: one big button showing
// the box, which opens the shelf to pick another. Never typed: « vider une
// boîte » finds a box's lots by this exact name (LIVA #1380). The shelf shows
// how full each box is, so she sees where there is room.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Archive, ChevronRight, X } from 'lucide-react'
import { fetchBoites } from '@/lib/tirelle-api'
import { GrilleBoites } from '@/components/GrilleBoites'
import { cn } from '@/lib/utils'

export function ChoixBoite({ valeur, onChange }: {
  /** « B3 », or '' while none is picked. */
  valeur: string
  onChange: (boite: string) => void
}) {
  const [ouvert, setOuvert] = useState(false)
  const boites = useQuery({ queryKey: ['tirelle', 'rangement', 'boites'], queryFn: fetchBoites })
  const dedans = valeur ? boites.data?.boites.find((b) => b.boite === valeur)?.n : undefined
  return (
    <>
      <button
        type="button"
        onClick={() => setOuvert(true)}
        className={cn(
          'w-full h-[72px] rounded-xl border-2 bg-background pl-4 pr-3 flex items-center gap-3 text-left active:bg-gold/10 focus:outline-none focus:ring-4 focus:ring-gold/40',
          valeur ? 'border-border' : 'border-gold',
        )}
      >
        <Archive className="h-7 w-7 flex-shrink-0 text-muted-foreground" />
        {valeur ? (
          <>
            <span className="text-4xl font-bold tabular-nums">{valeur}</span>
            {dedans != null && (
              <span className="min-w-0 truncate text-sm text-muted-foreground">{dedans === 0 ? 'boîte vide' : `déjà ${dedans} dedans`}</span>
            )}
          </>
        ) : (
          <span className="text-2xl text-muted-foreground">Choisir la boîte</span>
        )}
        <span className="ml-auto flex items-center gap-0.5 flex-shrink-0 text-sm font-semibold text-accent-blue">
          {valeur && 'Changer'}<ChevronRight className="h-5 w-5" />
        </span>
      </button>

      {ouvert && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-primary/50 p-3" onClick={() => setOuvert(false)}>
          <div className="w-full max-w-[460px] rounded-2xl bg-zinc-100 shadow-xl overflow-hidden" role="dialog" aria-label="Choisir la boîte" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2.5 border-b-2 border-gold bg-primary pl-4 pr-2 h-12">
              <Archive className="h-5 w-5 text-white/80" />
              <h2 className="flex-1 text-base font-heading font-bold tracking-tight text-primary-foreground">Dans quelle boîte ?</h2>
              <button type="button" onClick={() => setOuvert(false)} className="h-10 w-10 rounded-lg flex items-center justify-center text-white/80 active:bg-white/15" title="Fermer">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-3">
              <GrilleBoites
                boites={boites.data?.boites ?? null}
                choisie={valeur || null}
                onChoisir={(b) => { onChange(b); setOuvert(false) }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
