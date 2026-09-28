import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, IdCard, Loader2, Plus, Search } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { initiales, nomComplet, photoUrl, type Employe } from '@/lib/rh'

export function useEmployes() {
  return useQuery<Employe[]>({ queryKey: ['rh', 'employes'], queryFn: () => apiFetch('/rh/employes'), retry: false })
}

const STORAGE_KEY = 'rh-employe'

/** The selected employee, shared by Employés and Charge de travail so moving
 *  between the two tabs keeps the same person. Per-tab convenience only. */
export function useEmployeSelection(): [number | null, (id: number | null) => void] {
  const [id, setId] = useState<number | null>(() => {
    try {
      const v = Number(sessionStorage.getItem(STORAGE_KEY))
      return v > 0 ? v : null
    } catch {
      return null
    }
  })
  const select = useCallback((next: number | null) => {
    setId(next)
    try {
      if (next) sessionStorage.setItem(STORAGE_KEY, String(next))
      else sessionStorage.removeItem(STORAGE_KEY)
    } catch { /* storage unavailable — selection just isn't remembered */ }
  }, [])
  return [id, select]
}

export function filtrerEmployes(employes: Employe[] | undefined, q: string): Employe[] {
  if (!employes) return []
  const s = q.trim().toLowerCase()
  if (!s) return employes
  return employes.filter((e) => `${nomComplet(e)} ${e.poste}`.toLowerCase().includes(s))
}

export function EmployeList({ employes, isLoading, isError, selectedId, onSelect, searchQuery, onSearchChange, onNew, isCreating, isEditing }: {
  employes: Employe[]
  isLoading: boolean
  isError: boolean
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (q: string) => void
  /** Omitted = no « Nouveau » (the workload screen creates no employee). */
  onNew?: () => void
  isCreating?: boolean
  isEditing: boolean
}) {
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Rechercher..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            autoComplete="off"
            className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-2 scrollbar-transparent">
        {isLoading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-8 text-destructive">
            <AlertCircle className="h-6 w-6 mb-2" />
            <p className="text-sm">Impossible de charger les employés</p>
          </div>
        ) : employes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <IdCard className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucun employé</p>
          </div>
        ) : (
          employes.map((e) => (
            <div
              key={e.id}
              onClick={() => onSelect(e.id)}
              className={cn(
                'p-3 border rounded-lg cursor-pointer transition-all flex items-center gap-3',
                selectedId === e.id ? 'border-accent bg-white ring-1 ring-accent' : 'border-border bg-white hover:border-accent/50',
              )}
            >
              <Avatar className="h-9 w-9 text-xs" src={photoUrl(e)} alt={nomComplet(e)} fallback={initiales(e)} />
              <div className="min-w-0">
                <p className="font-medium text-sm truncate">{nomComplet(e)}</p>
                {e.poste && <p className="text-xs text-muted-foreground truncate">{e.poste}</p>}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{employes.length} employé{employes.length !== 1 ? 's' : ''}</span>
        {onNew && !isEditing && (
          <Button size="sm" variant="ghost" onClick={onNew} disabled={isCreating} className="text-accent hover:text-accent hover:bg-accent/10">
            <Plus className="h-3.5 w-3.5 mr-1" />Nouveau
          </Button>
        )}
      </div>
    </div>
  )
}
