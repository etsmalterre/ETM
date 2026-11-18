// The lab's shelf as a grid of its 48 boxes (rows A to F, numbers 1 to 8),
// each with how many tirelles it holds. One drawing for the two places a box
// is touched: the shelf screen (pages/Rangement.tsx) and the choice of the box
// a lot goes into (components/ChoixBoite.tsx).
import { NUMEROS, RANGEES } from '@/lib/boites'
import type { EtatBoite } from '@/lib/tirelle-api'
import { cn } from '@/lib/utils'

export const tirelles = (n: number) => `${n} tirelle${n > 1 ? 's' : ''}`

export function GrilleBoites({ boites, choisie, touchees, onChoisir }: {
  /** The boxes' content; null while it loads (the boxes can still be touched). */
  boites: EtatBoite[] | null
  choisie: string | null
  /** Boxes holding hits of a search, with their count: lit in gold. */
  touchees?: Map<string, number>
  onChoisir: (boite: string) => void
}) {
  const par = new Map((boites ?? []).map((b) => [b.boite, b.n]))
  return (
    <div className="grid grid-cols-8 gap-1.5">
      {RANGEES.flatMap((r) => NUMEROS.map((numero) => {
        const nom = `${r}${numero}`
        const n = par.get(nom) ?? 0
        const hits = touchees?.get(nom) ?? 0
        const active = choisie === nom
        return (
          <button
            key={nom}
            type="button"
            aria-pressed={active}
            onClick={() => onChoisir(nom)}
            title={`Boîte ${nom} : ${tirelles(n)}`}
            className={cn(
              'relative h-14 rounded-lg border flex flex-col items-center justify-center leading-none transition-colors select-none',
              active ? 'bg-primary border-primary text-primary-foreground shadow-sm'
                : n > 0 ? 'bg-white border-primary/40 text-primary shadow-sm active:bg-primary/10'
                  : 'bg-white/40 border-border/50 text-muted-foreground/70 active:bg-white',
              hits > 0 && !active && 'ring-2 ring-gold border-gold bg-gold/15',
            )}
          >
            <span className="text-base font-bold">{nom}</span>
            {/* An empty box shows its name alone: 48 « vide » drowned the full ones. */}
            {n > 0 && (
              <span className={cn('mt-1 text-xs font-semibold tabular-nums', active ? 'text-white/80' : 'text-muted-foreground')}>{n}</span>
            )}
            {hits > 0 && (
              <span className="absolute -top-1.5 -right-1.5 h-5 min-w-[20px] px-1 rounded-full bg-gold text-gold-foreground text-[11px] font-bold flex items-center justify-center shadow-sm">{hits}</span>
            )}
          </button>
        )
      }))}
    </div>
  )
}
