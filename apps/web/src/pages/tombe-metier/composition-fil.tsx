// One yarn line of a composition (fil + its coloris + %): the coloris recipe
// of an écru reference (LIVA #1205) and the composition of a trial sample
// (Tombé Métier › Échantillons) are edited with the same row.
// Imported RELATIVELY (TRM renders these screens through `@etm`).
import { useQuery } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { SearchableCombobox } from '@/components/ui/popover-select'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { fmtNum } from '@/lib/format'

const inputClass =
  'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'

export interface RefFilLookup { IDref_fil: number; reference: string | null; prix_kg: number | null }
export interface ColorisFilLookup { IDcolori_fil: number; reference: string; stock_kg: number }
export interface CompoDraftLine { key: number; IDref_fil: number; IDcolori_fil: number; pourcentage: string }

export function useColorisFil(refFil: number) {
  return useQuery<ColorisFilLookup[]>({
    queryKey: ['references-ecru', 'lookups', 'colori-fil', refFil],
    queryFn: () => apiFetch(`/references-ecru/lookups/colori-fil?ref_fil=${refFil}`),
    enabled: refFil > 0,
    staleTime: 60_000,
  })
}

export function ColorisCompoLineRow({
  line,
  refsFil,
  onChange,
  onRemove,
}: {
  line: CompoDraftLine
  refsFil: RefFilLookup[]
  onChange: (patch: Partial<CompoDraftLine>) => void
  onRemove: () => void
}) {
  const { data: colorisFil, isLoading } = useColorisFil(line.IDref_fil)
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_5rem_1.5rem] sm:grid-cols-[minmax(0,5fr)_minmax(0,4fr)_5rem_1.5rem] gap-2 items-center rounded-lg border border-border/60 bg-zinc-100/80 p-2">
      <div className="min-w-0 col-span-2 sm:col-span-1">
        <SearchableCombobox<RefFilLookup>
          options={refsFil}
          value={line.IDref_fil}
          onChange={(id) => onChange({ IDref_fil: id, IDcolori_fil: 0 })}
          getId={(r) => r.IDref_fil}
          getPrimary={(r) => r.reference ?? `#${r.IDref_fil}`}
          placeholder="Rechercher un fil"
        />
      </div>
      <button onClick={onRemove} className="sm:hidden p-0.5 text-destructive hover:text-destructive transition-colors justify-self-center" title="Retirer">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <div className="min-w-0">
        <SearchableCombobox<ColorisFilLookup>
          options={colorisFil ?? []}
          value={line.IDcolori_fil}
          onChange={(id) => onChange({ IDcolori_fil: id })}
          getId={(c) => c.IDcolori_fil}
          getPrimary={(c) => c.reference || `#${c.IDcolori_fil}`}
          getSecondary={(c) => (c.stock_kg > 0 ? `${fmtNum(c.stock_kg, 1)} kg en stock` : 'pas de stock')}
          placeholder={line.IDref_fil > 0 ? 'Choisir le coloris' : "Choisir d'abord le fil"}
          loading={isLoading && line.IDref_fil > 0}
          disabled={line.IDref_fil <= 0}
        />
      </div>
      <input
        type="number"
        step="0.1"
        min="0"
        max="100"
        value={line.pourcentage}
        onChange={(e) => onChange({ pourcentage: e.target.value })}
        className={cn(inputClass, 'text-right tabular-nums')}
        aria-label="Pourcentage"
      />
      <button onClick={onRemove} className="hidden sm:block p-0.5 text-destructive hover:text-destructive transition-colors justify-self-center" title="Retirer">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
