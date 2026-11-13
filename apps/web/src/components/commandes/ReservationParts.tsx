// Shared pieces of the « Réservation — Commande N° … » dialogs of a client order line (knitting order,
// yarn supplier order): the choice of a quantity, the order's répartition between the client lines that
// reserve on it, and the footer gauge of the client line. One look for both (Vincent 2026-11-13).
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Footer gauge of the reservation / create-order dialogs: projected affecté vs the commanded quantity,
 *  with a mini progress bar (legacy: "801 / 800 Ml affecté à la commande de Le slip Français", green once
 *  covered). `libelle` replaces the words after the figures. */
export function AffecteGauge({
  projected, target, uniteLabel, clientNom, libelle,
}: {
  projected: number
  target: number
  uniteLabel: string
  clientNom?: string
  libelle?: string
}) {
  const covered = target > 0 && projected >= target
  const pct = target > 0 ? Math.min(100, Math.max(0, (projected / target) * 100)) : 0
  return (
    <div className="min-w-0 flex-1">
      <p className={cn('text-xs font-medium tabular-nums truncate', covered ? 'text-green-600' : 'text-muted-foreground')}>
        <span className={cn('font-bold', !covered && 'text-foreground')}>{fmtNum(projected, 1)}</span>
        {' / '}{fmtNum(target, 1)} {uniteLabel} {libelle ?? `affecté à la commande${clientNom ? ` de ${clientNom}` : ''}`}
      </p>
      <div className="h-1.5 mt-1.5 rounded-full bg-white overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', covered ? 'bg-green-500' : 'bg-accent')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** One choice of quantity: its words and the kg it stands for. */
export interface OptionQuantite<K extends string> {
  cle: K
  label: string
  detail: string
  /** greyed, with the reason on hover */
  off?: boolean
  titre?: string
}

/** How much to reserve: each choice carries its kg (a field only for another quantity). No card around
 *  it: the dialog holds this one decision. */
export function ChoixQuantite<K extends string>({ options, mode, onChange, disabled }: {
  options: readonly OptionQuantite<K>[]
  mode: K
  onChange: (k: K) => void
  disabled?: boolean
}) {
  return (
    <div className="flex gap-1 rounded-md p-1 bg-white border border-border/60 shadow-sm">
      {options.map((o) => (
        <button
          key={o.cle}
          type="button"
          disabled={disabled || o.off}
          title={o.titre}
          onClick={() => onChange(o.cle)}
          className={cn(
            'flex-1 min-w-0 px-2 py-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
            mode === o.cle ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10',
          )}
        >
          <span className={cn('block text-sm truncate', mode === o.cle && 'font-medium')}>{o.label}</span>
          <span className={cn('block text-xs tabular-nums truncate', mode === o.cle ? 'font-semibold' : 'opacity-80')}>{o.detail}</span>
        </button>
      ))}
    </div>
  )
}

/** The other client lines' colours, in turn (this line is gold, what nobody holds is zinc). */
export const COULEURS_AUTRES_LIGNES = ['bg-primary', 'bg-accent-blue', 'bg-teal'] as const

/** One client line's share of an order. */
export interface PartCommande {
  cle: string
  /** who: « Cette ligne », or the client */
  nom: string
  /** « N° 3922 » */
  detail?: string
  /** the client line's « REF - coloris »: what tells apart two lines of the same order */
  article?: string
  kg: number
  couleur: string
  /** this line: its name in medium weight */
  fort?: boolean
}

/** What becomes of an order, in kg: one bar, then one row per share in three aligned columns
 *  (who · « REF - coloris » · kg), and last what nobody holds (stock for a knitting order, free for a
 *  yarn order). It moves with the choice above. */
export function RepartitionCommande({ titre, total, parts, reste }: {
  titre: string
  /** the bar's full width, kg */
  total: number
  parts: readonly PartCommande[]
  reste: { nom: string; kg: number }
}) {
  const largeur = (kg: number) => `${Math.min(100, (kg / total) * 100)}%`
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{titre}</p>
      <div className="h-2.5 rounded-full bg-white border border-border/60 overflow-hidden flex">
        {total > 0 && parts.filter((s) => s.kg > 0).map((s) => (
          <div key={s.cle} title={`${s.nom} : ${fmtNum(s.kg, 1)} kg`} className={cn('h-full transition-all', s.couleur)} style={{ width: largeur(s.kg) }} />
        ))}
        {total > 0 && reste.kg > 0 && (
          <div title={`${reste.nom} : ${fmtNum(reste.kg, 1)} kg`} className="h-full transition-all bg-zinc-300" style={{ width: largeur(reste.kg) }} />
        )}
      </div>
      <ul className="space-y-1 pt-0.5 text-xs">
        {parts.map((s) => (
          <li key={s.cle} className="flex items-center gap-2 tabular-nums min-w-0">
            <span className={cn('h-2.5 w-2.5 rounded-sm flex-shrink-0', s.couleur)} />
            <span className="flex-1 basis-0 min-w-0 truncate" title={[s.nom, s.detail].filter(Boolean).join(' · ')}>
              <span className={cn(s.fort && 'font-medium')}>{s.nom}</span>
              {s.detail && <span className="text-muted-foreground"> · {s.detail}</span>}
            </span>
            <span className="flex-1 basis-0 min-w-0 truncate" title={s.article || undefined}>{s.article}</span>
            <span className="w-20 flex-shrink-0 text-right font-semibold">{fmtNum(Math.max(0, s.kg), 1)} kg</span>
          </li>
        ))}
        <li className="flex items-center gap-2 tabular-nums text-muted-foreground">
          <span className="h-2.5 w-2.5 rounded-sm flex-shrink-0 bg-zinc-300" />
          <span className="flex-1 min-w-0 truncate">{reste.nom}</span>
          <span className="w-20 flex-shrink-0 text-right font-semibold">{fmtNum(reste.kg, 1)} kg</span>
        </li>
      </ul>
    </div>
  )
}
