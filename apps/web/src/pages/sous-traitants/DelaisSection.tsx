// Sous-traitants › Gestion › Info: « Délai standard » + « Fermetures » (doctrine des délais §1-§2, Vincent
// 2026-10-29, API lib/delais-standards.ts). The délai we ask this partner when there is no margin, in WORKING
// DAYS, and its closures; they feed the earliest date of a client order line (doctrine §5 ter). A value left
// empty reads the doctrine's default. Dyer: one standard; knitter: three bands by kg.
// Part of the fiche's edit mode like the type and the comment: the draft lives in the page (brouillonDe /
// corpsDe) and leaves with its « Enregistrer »; closures are added / removed at once while editing, like the
// contacts. A closure whose end has passed is no longer shown (kept in the database: past closures recount
// past délais in working days, e.g. the qualité de service).
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CalendarOff, Hourglass, Loader2, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatHfsqlDate, inputDateToHfsql } from '@/lib/dates'

interface Standards {
  ennoblissement_jours: number
  tricot_seuil1_kg: number
  tricot_seuil2_kg: number
  tricot_jours1: number
  tricot_jours2: number
  tricot_jours3: number
}
type Champ = keyof Standards
interface Fermeture { id: number; du: string; au: string; motif: string | null }
export interface DelaisPayload {
  standards: Standards
  stockes: { [K in Champ]: number | null } | null
  defauts: Standards
  fermetures: Fermeture[]
}
/** The edit-mode draft: one text per field, '' = the doctrine's default. */
export type BrouillonDelais = Record<Champ, string>

export const delaisQueryKey = (id: number) => ['sous-traitant-delais', id]
export function useDelaisSst(id: number | null, enabled: boolean) {
  return useQuery<DelaisPayload>({
    queryKey: delaisQueryKey(id ?? 0),
    queryFn: () => apiFetch(`/sous-traitants/${id}/delais`),
    enabled: enabled && !!id,
  })
}

/** The draft as stored (a field never set reads ''). */
export function brouillonDe(d: DelaisPayload): BrouillonDelais {
  return Object.fromEntries((Object.keys(d.defauts) as Champ[]).map((c) => [c, d.stockes?.[c] == null ? '' : String(d.stockes[c])])) as BrouillonDelais
}

/** PUT body from a draft ('' → null = back to the doctrine). */
export function corpsDe(b: BrouillonDelais): Record<Champ, number | null> {
  return Object.fromEntries((Object.keys(b) as Champ[]).map((c) => [c, b[c].trim() === '' ? null : Number(b[c])])) as Record<Champ, number | null>
}

const jours = (n: number) => `${n} jour${n > 1 ? 's' : ''} ouvré${n > 1 ? 's' : ''}`
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

export function DelaisInfo({ sousTraitantId, kind, data, isEditing, brouillon, onBrouillonChange }: {
  sousTraitantId: number
  kind: 'ennoblisseur' | 'tricoteur'
  data: DelaisPayload | undefined
  isEditing: boolean
  brouillon: BrouillonDelais | null
  onBrouillonChange: (b: BrouillonDelais) => void
}) {
  if (!data) return <div className="h-24 bg-muted animate-pulse rounded-lg" />
  const b = brouillon ?? brouillonDe(data)

  /** One figure, stored or the doctrine's (muted « doctrine »); an input in edit mode. A render function,
   *  not a component: a component declared here would remount, and lose focus, on each key. */
  const valeurDe = (c: Champ, unite: 'kg' | 'jours') => {
    if (isEditing) {
      return (
        <span className="inline-flex items-center gap-1">
          <input value={b[c]} onChange={(e) => onBrouillonChange({ ...b, [c]: e.target.value.replace(/[^\d]/g, '') })}
            placeholder={String(data.defauts[c])} inputMode="numeric"
            className="h-7 w-14 px-2 text-sm text-right rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring tabular-nums" />
          <span className="text-xs text-muted-foreground">{unite === 'kg' ? 'kg' : 'j'}</span>
        </span>
      )
    }
    const v = data.standards[c]
    return (
      <span className="tabular-nums">
        <span className="font-medium">{unite === 'kg' ? `${v} kg` : jours(v)}</span>
      </span>
    )
  }
  const ligne = (label: React.ReactNode, valeur: React.ReactNode) => (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground inline-flex items-center gap-1">{label}</span>
      <span className="text-sm text-right">{valeur}</span>
    </div>
  )

  return (
    <>
      {/* Kept bare (Vincent 2026-10-29): the title and the figures; the dyer's one figure sits on the title row. */}
      <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><Hourglass className="h-3.5 w-3.5" />Délai standard</p>
          {kind === 'ennoblisseur' && <span className="text-sm">{valeurDe('ennoblissement_jours', 'jours')}</span>}
        </div>
        {kind === 'tricoteur' && (
          <div className="mt-1">
            {ligne(<>Jusqu'à {valeurDe('tricot_seuil1_kg', 'kg')}</>, valeurDe('tricot_jours1', 'jours'))}
            {ligne(<>Jusqu'à {valeurDe('tricot_seuil2_kg', 'kg')}</>, valeurDe('tricot_jours2', 'jours'))}
            {ligne('Au-delà', valeurDe('tricot_jours3', 'jours'))}
          </div>
        )}
      </div>
      <FermeturesInfo sousTraitantId={sousTraitantId} fermetures={data.fermetures} isEditing={isEditing} />
    </>
  )
}

function FermeturesInfo({ sousTraitantId, fermetures, isEditing }: { sousTraitantId: number; fermetures: Fermeture[]; isEditing: boolean }) {
  const queryClient = useQueryClient()
  const [du, setDu] = useState('')
  const [au, setAu] = useState('')
  const [motif, setMotif] = useState('')
  const rafraichir = () => queryClient.invalidateQueries({ queryKey: delaisQueryKey(sousTraitantId) })
  const ajout = useMutation({
    mutationFn: () => apiFetch(`/sous-traitants/${sousTraitantId}/fermetures`, {
      method: 'POST', body: JSON.stringify({ du: inputDateToHfsql(du), au: inputDateToHfsql(au), motif: motif.trim() || undefined }),
    }),
    onSuccess: () => { setDu(''); setAu(''); setMotif(''); rafraichir() },
  })
  const retrait = useMutation({
    mutationFn: (id: number) => apiFetch(`/sous-traitants/${sousTraitantId}/fermetures/${id}`, { method: 'DELETE' }),
    onSuccess: rafraichir,
  })
  const inputCls = 'h-8 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
  return (
    <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
      <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5"><CalendarOff className="h-3.5 w-3.5" />Fermetures</p>
      {fermetures.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">Aucune fermeture à venir</p>
      ) : (
        <div className="space-y-1">
          {fermetures.map((f) => (
            <div key={f.id} className="group flex items-center gap-2 text-sm">
              <span className="tabular-nums">{formatHfsqlDate(f.du)} → {formatHfsqlDate(f.au)}</span>
              {f.motif && <span className="text-xs text-muted-foreground truncate">{f.motif}</span>}
              {isEditing && (
                <Button variant="ghost" size="icon" className="h-6 w-6 ml-auto text-destructive hover:text-destructive opacity-0 group-hover:opacity-100"
                  title="Supprimer cette fermeture" disabled={retrait.isPending} onClick={() => retrait.mutate(f.id)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {isEditing && (
        <div className="mt-2 pt-2 border-t border-border/40 space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            <input type="date" value={du} onChange={(e) => setDu(e.target.value)} className={inputCls} title="Début" />
            <input type="date" value={au} onChange={(e) => setAu(e.target.value)} className={inputCls} title="Fin" />
          </div>
          <div className="flex gap-1.5">
            <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Motif (facultatif)" className={cn(inputCls, 'flex-1 min-w-0')} />
            <Button variant="outline" size="sm" className="h-8" disabled={!du || !au || ajout.isPending} onClick={() => ajout.mutate()}>
              {ajout.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}Ajouter
            </Button>
          </div>
        </div>
      )}
      {(ajout.error || retrait.error) && (
        <p className="flex items-center gap-1.5 text-xs text-destructive mt-1">
          <AlertCircle className="h-3.5 w-3.5" />{((ajout.error || retrait.error) as any).body?.message ?? 'L’enregistrement a échoué'}
        </p>
      )}
    </div>
  )
}
