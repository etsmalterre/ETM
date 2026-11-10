// « Ajouter un coloris existant » (LIVA #1359): copy onto a dyed finished
// reference a coloris another reference already carries — the dyer's lab
// recipe (« 0212 marine 61508/1 ») and the dyer with it. The API offers only
// references whose écru has the same fibre families (API lib/familles-fibres.ts);
// the contexture only orders the list, the person's judgement does the rest.
// §18.D banded dialog: the list is read before one confirming click.

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertCircle, Loader2, Palette, Plus, Search, X } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { PopoverSelect } from '@/components/ui/popover-select'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'

interface RefUtilisant { IDref_fini: number; reference: string; contexture: string | null }
interface Candidat {
  IDref_fini_colori: number
  reference: string
  IDsous_traitant: number
  sous_traitant: string | null
  ref_source: string
  meme_contexture: boolean
  refs: RefUtilisant[]
}
type Signature =
  | { connue: true; familles: string[]; cle: string }
  | { connue: false; raison: 'sans_composition' | 'matiere_non_classee'; matieres: string[] }
interface Reprenables {
  signature: Signature
  familles: string
  contexture: string | null
  candidats: Candidat[]
}

/** Rows drawn at most — the list is searched, never scrolled through. */
const MAX_LIGNES = 150

const sansAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function RepriseColorisDialog({
  open, onClose, idRefFini, referenceFini, sousTraitantsDeLaRef, onAdded,
}: {
  open: boolean
  onClose: () => void
  idRefFini: number
  referenceFini: string
  /** Dyers already used by this reference's coloris — the default pick. */
  sousTraitantsDeLaRef: number[]
  onAdded: () => void
}) {
  const [q, setQ] = useState('')
  const [idSst, setIdSst] = useState(0)
  const [autresContextures, setAutresContextures] = useState(false)
  const [choix, setChoix] = useState<number | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery<Reprenables>({
    queryKey: ['ref-fini-coloris-reprenables', idRefFini],
    queryFn: () => apiFetch(`/references-fini/${idRefFini}/coloris/reprenables`),
    enabled: open,
    staleTime: 0,
  })

  // Dyers offered, most recipes first.
  const ennoblisseurs = useMemo(() => {
    const n = new Map<number, { nom: string; n: number }>()
    for (const c of data?.candidats ?? []) {
      const e = n.get(c.IDsous_traitant) ?? { nom: c.sous_traitant ?? 'Sans ennoblisseur', n: 0 }
      e.n += 1
      n.set(c.IDsous_traitant, e)
    }
    return [...n].sort((a, b) => b[1].n - a[1].n).map(([id, e]) => ({ id, primary: e.nom, secondary: `${e.n} coloris` }))
  }, [data])

  // Reset on open; default dyer = one this reference already works with, else
  // the one with most recipes.
  useEffect(() => {
    if (!open) return
    setQ(''); setAutresContextures(false); setChoix(null); setErreur(null); setIdSst(0)
  }, [open, idRefFini])
  useEffect(() => {
    if (!open || idSst !== 0 || ennoblisseurs.length === 0) return
    const habituel = ennoblisseurs.find((e) => sousTraitantsDeLaRef.includes(e.id))
    setIdSst((habituel ?? ennoblisseurs[0]).id)
  }, [open, idSst, ennoblisseurs, sousTraitantsDeLaRef])

  const duSst = useMemo(() => (data?.candidats ?? []).filter((c) => c.IDsous_traitant === idSst), [data, idSst])
  const nbAutresContextures = duSst.filter((c) => !c.meme_contexture).length
  const lignes = useMemo(() => {
    const t = sansAccents(q.trim())
    return duSst.filter((c) =>
      (autresContextures || c.meme_contexture || !data?.contexture)
      && (!t || sansAccents(c.reference).includes(t) || c.refs.some((r) => sansAccents(r.reference).includes(t))))
  }, [duSst, q, autresContextures, data?.contexture])
  const choisi = lignes.find((c) => c.IDref_fini_colori === choix) ?? null

  const ajouter = useMutation({
    mutationFn: (IDref_fini_colori: number) =>
      apiFetch(`/references-fini/${idRefFini}/coloris/reprendre`, { method: 'POST', body: JSON.stringify({ IDref_fini_colori }) }),
    onMutate: () => setErreur(null),
    onSuccess: () => { onAdded(); onClose() },
    onError: (e: Error & { body?: { message?: string } }) => setErreur(e.body?.message ?? 'Impossible d’ajouter ce coloris.'),
  })

  const signature = data?.signature
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-3xl p-0 border-0 bg-primary overflow-hidden max-h-[90dvh] flex flex-col">
        {/* Band */}
        <div className="flex-shrink-0 flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5 rounded-t-lg">
          <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
            <Palette className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">Ajouter un coloris existant</h2>
            <p className="text-xs text-white/70 truncate">
              {referenceFini}
              {data?.familles && <> · {data.familles}</>}
              {data?.contexture && <> · {data.contexture}</>}
            </p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-white/80 hover:bg-white/15 hover:text-white" title="Fermer" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 flex flex-col bg-zinc-100 p-4 gap-3">
          {isLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
          ) : error ? (
            <div className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{(error as Error).message}</div>
          ) : signature && !signature.connue ? (
            <div className="rounded-lg border-l-4 border-l-amber-400/60 border border-border/60 bg-card p-4 shadow-sm text-sm space-y-1.5">
              <p className="font-medium">Les fibres de cette référence ne sont pas connues.</p>
              {signature.raison === 'matiere_non_classee' ? (
                <p className="text-muted-foreground">
                  {signature.matieres.length > 1 ? 'Les matières' : 'La matière'} {signature.matieres.map((m) => `« ${m} »`).join(', ')} {signature.matieres.length > 1 ? 'n’ont' : 'n’a'} pas encore de famille.
                  Classez-{signature.matieres.length > 1 ? 'les' : 'la'} dans <Link to="/fils/matieres" className="text-accent-blue hover:underline">Fils › Matières premières</Link>.
                </p>
              ) : (
                <p className="text-muted-foreground">
                  L’écru n’a pas de composition en fils : renseignez-la dans <Link to="/tombe-metier/references" className="text-accent-blue hover:underline">Tombé Métier › Références</Link>.
                </p>
              )}
            </div>
          ) : (
            <>
              <div className="flex-shrink-0 flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <input
                    autoFocus
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Rechercher (coloris, n° labo, référence)"
                    className="h-9 w-full pl-8 pr-3 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <PopoverSelect
                  options={ennoblisseurs}
                  value={idSst}
                  onChange={(id) => { setIdSst(id); setChoix(null) }}
                  hideEmpty
                  widthClass="w-[220px]"
                />
              </div>
              {data?.contexture && nbAutresContextures > 0 && (
                <div className="flex-shrink-0 flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-border/60 bg-white shadow-sm">
                  <div className="min-w-0 text-xs">
                    <span className="font-semibold">Autres contextures</span>
                    <span className="text-muted-foreground">
                      {autresContextures
                        ? ` · ${nbAutresContextures} recette${nbAutresContextures > 1 ? 's' : ''} faite${nbAutresContextures > 1 ? 's' : ''} sur une autre contexture que « ${data.contexture} » affichée${nbAutresContextures > 1 ? 's' : ''}`
                        : ` · seules les recettes déjà appliquées à du « ${data.contexture} » sont affichées`}
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autresContextures}
                    onClick={() => setAutresContextures((v) => !v)}
                    className={cn(
                      'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      autresContextures ? 'bg-accent shadow-inner' : 'bg-zinc-300 hover:bg-zinc-400/80',
                    )}
                  >
                    <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out', autresContextures ? 'translate-x-[18px]' : 'translate-x-0.5')} />
                  </button>
                </div>
              )}

              <div className="flex-1 min-h-[200px] overflow-y-auto scrollbar-transparent space-y-1.5 p-0.5">
                {lignes.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic text-center py-10">
                    {duSst.length === 0 ? 'Aucun coloris de ces fibres chez cet ennoblisseur' : 'Aucun coloris ne correspond'}
                  </p>
                ) : (
                  lignes.slice(0, MAX_LIGNES).map((c) => {
                    const actif = c.IDref_fini_colori === choix
                    return (
                      <button
                        key={c.IDref_fini_colori}
                        type="button"
                        onClick={() => setChoix(actif ? null : c.IDref_fini_colori)}
                        className={cn(
                          'w-full text-left rounded-lg border p-2.5 transition-colors',
                          actif ? 'bg-accent/10 border-accent ring-1 ring-accent' : 'bg-white border-border/60 hover:border-accent/40',
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Palette className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                          <span className="text-sm font-medium truncate">{c.reference}</span>
                          <span className="ml-auto text-[11px] text-muted-foreground flex-shrink-0 tabular-nums">
                            {c.refs.length} réf.
                          </span>
                        </div>
                        <p className="mt-0.5 ml-[22px] text-[11px] text-muted-foreground truncate" title={c.refs.map((r) => `${r.reference}${r.contexture ? ` (${r.contexture})` : ''}`).join(', ')}>
                          {c.refs.map((r) => `${r.reference}${r.contexture ? ` (${r.contexture})` : ''}`).join(', ')}
                        </p>
                      </button>
                    )
                  })
                )}
                {lignes.length > MAX_LIGNES && (
                  <p className="text-xs text-muted-foreground italic text-center py-2">
                    {lignes.length - MAX_LIGNES} autres : affinez la recherche.
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 flex items-center gap-3 border-t border-border/60 bg-zinc-200 px-4 py-3 rounded-b-lg">
          {erreur ? (
            <div className="flex items-center gap-2 text-sm text-destructive min-w-0"><AlertCircle className="h-4 w-4 flex-shrink-0" /><span className="truncate" title={erreur}>{erreur}</span></div>
          ) : choisi ? (
            <p className="text-xs text-muted-foreground min-w-0 truncate">
              « {choisi.reference} » sera ajouté chez {choisi.sous_traitant ?? 'cet ennoblisseur'}, repris de {choisi.ref_source}.
            </p>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>Annuler</Button>
            <Button disabled={!choisi || ajouter.isPending} onClick={() => choisi && ajouter.mutate(choisi.IDref_fini_colori)}>
              {ajouter.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
              Ajouter
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
