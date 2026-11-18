// Small pieces shared by the lab's two screens: the queue and its open lot
// (pages/Labo.tsx), the shelf of stored tirelles (pages/Rangement.tsx).
import { Building2, CheckCircle2, RefreshCw, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/** « 2026-11-18 » → « 18/11/2026 ». */
export function jour(d: string | null): string {
  if (!d) return ''
  const [y, m, j] = d.slice(0, 10).split('-')
  return `${j}/${m}/${y}`
}

/** What the last gesture did, over the screen for a few seconds. */
export function Message({ texte, onFermer }: { texte: string; onFermer: () => void }) {
  return (
    <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 rounded-full bg-success text-white pl-4 pr-2 py-2 shadow-lg" role="status">
      <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
      <span className="text-base font-semibold whitespace-nowrap">{texte}</span>
      <button type="button" onClick={onFermer} className="h-8 w-8 rounded-full flex items-center justify-center active:bg-white/20" title="Fermer">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

/** The band's refresh button (white on navy). */
export function Actualiser({ chargement, onClick }: { chargement: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-11 w-11 rounded-xl flex items-center justify-center text-white/80 active:bg-white/15 flex-shrink-0"
      title="Actualiser"
    >
      <RefreshCw className={cn('h-5 w-5', chargement && 'animate-spin')} />
    </button>
  )
}

export function PillClient({ nom, titre, sombre }: { nom: string; titre?: string; sombre?: boolean }) {
  return (
    <span
      title={titre ?? nom}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 rounded-full border font-semibold',
        sombre ? 'border-teal/40 bg-teal-light px-3 py-1 text-sm text-teal-dark' : 'border-teal/30 bg-teal-light px-2 py-0.5 text-xs text-teal-dark',
      )}
    >
      <Building2 className={cn('flex-shrink-0', sombre ? 'h-4 w-4' : 'h-3 w-3')} />
      <span className="truncate">{nom}</span>
    </span>
  )
}
