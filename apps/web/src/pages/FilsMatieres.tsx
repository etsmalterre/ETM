// Fils › Matières premières (LIVA #1359) — « Tableau » layout (mps_designer §27).
//
// The matières a yarn is made of (coton, polyester…) and the fibre FAMILY of
// each. The family decides which coloris can be copied from one finished
// reference to another (Finis › Références › Coloris, « Ajouter un coloris
// existant »): same families = same dye recipe. The families themselves are a
// fixed list from the API (lib/familles-fibres.ts), never edited here.
// A matière without a family blocks that copy for every écru it weighs in, so
// the amber counter shows them: classifying them is ours to do, not urgent.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, ArrowDown, ArrowUp, Layers, Loader2, Pencil, Plus, Save, Search, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Famille { code: string; libelle: string; ignoree: boolean }
interface Matiere {
  IDmatiere: number
  libelle: string
  famille: string | null
  fils: Array<{ IDref_fil: number; reference: string }>
}
interface Payload { familles: Famille[]; seuil: number; matieres: Matiere[] }

type SortKey = 'libelle' | 'famille' | 'fils'
const COLUMNS: { key: SortKey; label: string; width: string; align?: 'right' }[] = [
  { key: 'libelle', label: 'Matière', width: '40%' },
  { key: 'famille', label: 'Famille', width: '40%' },
  { key: 'fils', label: 'Fils', width: '20%', align: 'right' },
]

const QK = ['matieres-premieres'] as const
const sansAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const inputClass = 'h-8 w-full px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'

/** One stable hue per family — a category, like the sst type chip (§36). */
const TEINTE: Record<string, string> = {
  vegetale: 'bg-green-500/10 text-green-800 border-green-500/25',
  artificielle: 'bg-teal-500/10 text-teal-800 border-teal-500/25',
  animale: 'bg-orange-500/10 text-orange-800 border-orange-500/25',
  polyester: 'bg-sky-500/10 text-sky-800 border-sky-500/25',
  polyamide: 'bg-indigo-500/10 text-indigo-800 border-indigo-500/25',
  elasthanne: 'bg-zinc-500/10 text-zinc-700 border-zinc-500/25',
  metallique: 'bg-slate-500/15 text-slate-800 border-slate-500/30',
  autre: 'bg-stone-500/10 text-stone-700 border-stone-500/25',
}

function FamillePill({ code, familles }: { code: string | null; familles: Famille[] }) {
  if (!code) return <span className="text-xs text-amber-700 italic">À classer</span>
  const f = familles.find((x) => x.code === code)
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium border', TEINTE[code] ?? TEINTE.autre)}>
      {f?.libelle ?? code}
    </span>
  )
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 min-h-[28px]">
      <span className="text-xs text-muted-foreground flex-shrink-0">{label}</span>
      <span className="text-sm text-right min-w-0">{value}</span>
    </div>
  )
}

export function FilsMatieres() {
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery<Payload>({ queryKey: QK, queryFn: () => apiFetch('/matieres-premieres') })
  const familles = data?.familles ?? []

  const [q, setQ] = useState('')
  const [aClasserSeul, setAClasserSeul] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'libelle', dir: 'asc' })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const aClasser = (data?.matieres ?? []).filter((m) => !m.famille).length
  const filtreAClasser = aClasserSeul && aClasser > 0

  const rows = useMemo(() => {
    const t = sansAccents(q.trim())
    const libFam = (m: Matiere) => familles.find((f) => f.code === m.famille)?.libelle ?? ''
    const out = (data?.matieres ?? []).filter((m) =>
      (!filtreAClasser || !m.famille)
      && (!t || sansAccents(m.libelle).includes(t) || sansAccents(libFam(m)).includes(t) || m.fils.some((f) => sansAccents(f.reference).includes(t))))
    const val = (m: Matiere): string | number =>
      sort.key === 'fils' ? m.fils.length : sort.key === 'famille' ? libFam(m) : m.libelle
    out.sort((a, b) => {
      const x = val(a), y = val(b)
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'fr')
      return sort.dir === 'asc' ? c : -c
    })
    return out
  }, [data, familles, q, filtreAClasser, sort])

  const selected = (data?.matieres ?? []).find((m) => m.IDmatiere === selectedId) ?? null

  // ── Drawer edit state, owned here so the guard sees it (§28) ──
  const [isEditing, setIsEditing] = useState(false)
  const [draftLibelle, setDraftLibelle] = useState('')
  const [draftFamille, setDraftFamille] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const startEdit = useCallback(() => {
    if (!selected) return
    setDraftLibelle(selected.libelle)
    setDraftFamille(selected.famille)
    setSaveError(null)
    setIsEditing(true)
  }, [selected])

  const isDirty = isEditing && !!selected && (draftLibelle.trim() !== selected.libelle || draftFamille !== selected.famille)

  const saveMut = useMutation({
    mutationFn: () => apiFetch(`/matieres-premieres/${selectedId}`, {
      method: 'PUT', body: JSON.stringify({ libelle: draftLibelle.trim(), famille: draftFamille }),
    }),
    onMutate: () => setSaveError(null),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: QK })
      queryClient.invalidateQueries({ queryKey: ['ref-fini-coloris-reprenables'] })
      setIsEditing(false)
    },
    onError: (e: Error & { body?: { message?: string } }) => setSaveError(e.body?.message ?? 'Enregistrement impossible.'),
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/matieres-premieres/${id}`, { method: 'DELETE' }),
    onMutate: () => setDeleteError(null),
    onSuccess: () => {
      setConfirmDelete(false)
      setSelectedId(null)
      queryClient.invalidateQueries({ queryKey: QK })
    },
    onError: (e: Error & { body?: { message?: string } }) => setDeleteError(e.body?.message ?? 'Suppression impossible.'),
  })

  const guard = useUnsavedGuard({
    isDirty,
    save: async () => { await saveMut.mutateAsync() },
    onDiscard: () => setIsEditing(false),
  })
  const handleRowClick = useCallback((id: number) => {
    guard.guardAction(() => { setIsEditing(false); setSelectedId((prev) => (prev === id ? null : id)) })
  }, [guard])
  const handleClose = useCallback(() => {
    guard.guardAction(() => { setIsEditing(false); setSelectedId(null) })
  }, [guard])

  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      {/* Toolbar */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-3">
        <div className="order-1 flex-1 min-w-0 flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Rechercher (matière, famille, fil)"
              className="h-9 w-full pl-8 pr-3 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {aClasser > 0 && (
            <button
              type="button"
              onClick={() => setAClasserSeul((v) => !v)}
              aria-pressed={filtreAClasser}
              title="Matières à classer dans une famille"
              className={cn(
                'h-7 min-w-[1.75rem] px-1.5 inline-flex items-center justify-center rounded-md text-xs font-semibold tabular-nums border transition-colors flex-shrink-0',
                filtreAClasser ? 'bg-amber-500 text-white border-amber-500 shadow-sm' : 'bg-amber-500/10 text-amber-800 border-amber-500/30 hover:bg-amber-500/20',
              )}
            >
              {aClasser}
            </button>
          )}
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)} className="order-2 flex-shrink-0" title="Nouvelle matière">
          <Plus className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">Nouveau</span>
        </Button>
      </div>

      <p className="flex-shrink-0 text-xs text-muted-foreground">
        La famille décide quels coloris se reprennent d’une référence finie à l’autre : même familles de fibres, même recette.
        L’élasthanne et toute fibre sous {Math.round((data?.seuil ?? 0.1) * 100)} % de l’écru ne comptent pas.
      </p>

      {/* Table */}
      <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border/60 bg-white shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{(error as Error).message}</div>
        ) : (
          <>
            <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
              <colgroup>{COLUMNS.map((c) => <col key={c.key} style={{ width: c.width }} />)}</colgroup>
              <thead className="bg-zinc-200/60 border-b border-border/60">
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  {COLUMNS.map((c) => {
                    const active = sort.key === c.key
                    return (
                      <th key={c.key} onClick={() => onSort(c.key)}
                        className={cn('px-3 py-2.5 font-semibold cursor-pointer select-none whitespace-nowrap', c.align === 'right' ? 'text-right' : 'text-left', active && 'text-accent')}>
                        <span className="inline-flex items-center gap-1">
                          {c.label}
                          {active && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                        </span>
                      </th>
                    )
                  })}
                </tr>
              </thead>
            </table>
            <div className="flex-1 min-h-0 overflow-auto scrollbar-transparent">
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground italic text-center py-10">Aucune matière</p>
              ) : (
                <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
                  <colgroup>{COLUMNS.map((c) => <col key={c.key} style={{ width: c.width }} />)}</colgroup>
                  <tbody>
                    {rows.map((m) => (
                      <tr key={m.IDmatiere} data-stock-row onClick={() => handleRowClick(m.IDmatiere)}
                        className={cn('border-b border-border/40 cursor-pointer transition-colors', selectedId === m.IDmatiere ? 'bg-accent/10' : 'hover:bg-accent/5')}>
                        <td className="px-3 py-2 font-medium truncate" title={m.libelle}>{m.libelle}</td>
                        <td className="px-3 py-2 truncate"><FamillePill code={m.famille} familles={familles} /></td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {m.fils.length > 0 ? m.fils.length : <span className="text-muted-foreground/40">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>

      <MatiereDrawer
        matiere={selected}
        familles={familles}
        isEditing={isEditing}
        draftLibelle={draftLibelle}
        draftFamille={draftFamille}
        onDraftLibelle={setDraftLibelle}
        onDraftFamille={setDraftFamille}
        onStartEdit={startEdit}
        onCancel={() => setIsEditing(false)}
        onSave={() => saveMut.mutate()}
        isSaving={saveMut.isPending}
        saveError={saveError}
        onDelete={() => { setDeleteError(null); setConfirmDelete(true) }}
        onClose={handleClose}
      />

      <CreateMatiereDialog
        open={createOpen}
        familles={familles}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false)
          queryClient.invalidateQueries({ queryKey: QK })
          setSelectedId(id)
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Supprimer la matière"
        description={selected ? `« ${selected.libelle} » sera supprimée. Aucun fil ne l’utilise.` : undefined}
        error={deleteError}
        isPending={deleteMut.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => { if (selectedId !== null) { setIsEditing(false); deleteMut.mutate(selectedId) } }}
      />
      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />
    </div>
  )
}

function MatiereDrawer({
  matiere, familles, isEditing, draftLibelle, draftFamille, onDraftLibelle, onDraftFamille,
  onStartEdit, onCancel, onSave, isSaving, saveError, onDelete, onClose,
}: {
  matiere: Matiere | null
  familles: Famille[]
  isEditing: boolean
  draftLibelle: string
  draftFamille: string | null
  onDraftLibelle: (v: string) => void
  onDraftFamille: (v: string | null) => void
  onStartEdit: () => void
  onCancel: () => void
  onSave: () => void
  isSaving: boolean
  saveError: string | null
  onDelete: () => void
  onClose: () => void
}) {
  const drawerRef = useRef<HTMLDivElement>(null)
  const [searchParams] = useSearchParams()
  const embed = searchParams.get('embed') === 'true'
  const open = matiere !== null

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const target = e.target as Node | null
      if (!target) return
      if (drawerRef.current?.contains(target)) return
      if ((target as Element).closest?.('[data-stock-row]')) return
      // The family picker's list and the dialogs are portaled into <body>,
      // outside the app root: a click there is not a click « outside ».
      if (!document.getElementById('root')?.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, onClose])

  // Codes are strings; PopoverSelect is id-keyed: index + 1, 0 = none.
  const options = familles.map((f, i) => ({ id: i + 1, primary: f.libelle, secondary: f.ignoree ? 'ne compte pas' : undefined }))
  const idFamille = draftFamille ? familles.findIndex((f) => f.code === draftFamille) + 1 : 0

  return (
    <div
      ref={drawerRef}
      className={cn(
        'fixed right-0 bottom-0 w-full max-w-[440px] bg-white border-l border-border/60 shadow-xl z-30 transition-transform duration-300 flex flex-col',
        embed ? 'top-0' : 'top-14',
        open ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      <div className="flex-1 min-h-0 flex flex-col bg-zinc-100/80">
        <div className="flex-shrink-0 flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5">
          <div className={cn('h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm transition-colors', isEditing ? 'bg-white text-primary' : 'bg-gold text-gold-foreground')}>
            <Layers className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">{matiere?.libelle ?? ''}</h2>
            <p className="text-xs text-white/70 truncate">Matière première</p>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {matiere && (isEditing ? (
              <>
                {matiere.fils.length === 0 && (
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-red-200 hover:bg-white/15 hover:text-red-100" title="Supprimer" onClick={onDelete}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
                <Button variant="ghost" size="sm" className="px-2 text-white/80 hover:bg-white/15 hover:text-white" onClick={onCancel} title="Annuler">
                  <X className="h-3.5 w-3.5 sm:mr-1.5" /><span className="hidden sm:inline">Annuler</span>
                </Button>
                <Button variant="gold" size="sm" onClick={onSave} disabled={isSaving || !draftLibelle.trim()} title="Enregistrer">
                  {isSaving ? <Loader2 className="h-3.5 w-3.5 sm:mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 sm:mr-1.5" />}
                  <span className="hidden sm:inline">Enregistrer</span>
                </Button>
              </>
            ) : (
              <Button variant="gold" size="sm" onClick={onStartEdit} title="Modifier">
                <Pencil className="h-3.5 w-3.5 sm:mr-1.5" /><span className="hidden sm:inline">Modifier</span>
              </Button>
            ))}
            <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0 md:hidden text-white/80 hover:bg-white/15 hover:text-white" onClick={onClose} title="Fermer">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {matiere && (
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3 scrollbar-transparent">
            <div className={cn('rounded-lg border border-border/60 bg-card p-3 shadow-sm space-y-1', isEditing && 'border-l-4 border-l-accent/70 bg-accent/[0.03]')}>
              <div className="flex items-center gap-2 mb-1"><Layers className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">Matière</h3></div>
              <KV label="Nom" value={isEditing
                ? <input value={draftLibelle} onChange={(e) => onDraftLibelle(e.target.value)} className={cn(inputClass, 'h-7 w-[220px] text-right')} />
                : matiere.libelle} />
              <KV label="Famille" value={isEditing
                ? <PopoverSelect size="sm" options={options} value={idFamille} emptyLabel="— à classer —" onChange={(id) => onDraftFamille(id > 0 ? familles[id - 1].code : null)} />
                : <FamillePill code={matiere.famille} familles={familles} />} />
              {saveError && <p className="text-xs text-destructive pt-1">{saveError}</p>}
            </div>
            <div className={cn('rounded-lg border border-border/60 bg-card p-3 shadow-sm', isEditing && 'border-l-4 border-l-accent/70 bg-accent/[0.03]')}>
              <div className="flex items-center gap-2 mb-2">
                <BobineIcon className="h-4 w-4 text-accent" />
                <h3 className="text-sm font-semibold">Fils qui l’utilisent</h3>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{matiere.fils.length}</span>
              </div>
              {matiere.fils.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">Aucun fil</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {matiere.fils.map((f) => (
                    <span key={f.IDref_fil} className="rounded border border-border/60 bg-zinc-100/80 px-1.5 py-0.5 text-xs">{f.reference}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function CreateMatiereDialog({ open, familles, onClose, onCreated }: {
  open: boolean
  familles: Famille[]
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const [libelle, setLibelle] = useState('')
  const [famille, setFamille] = useState(0)
  const [erreur, setErreur] = useState<string | null>(null)
  useEffect(() => { if (open) { setLibelle(''); setFamille(0); setErreur(null) } }, [open])
  const mut = useMutation({
    mutationFn: () => apiFetch('/matieres-premieres', {
      method: 'POST', body: JSON.stringify({ libelle: libelle.trim(), famille: famille > 0 ? familles[famille - 1].code : null }),
    }) as Promise<{ IDmatiere: number }>,
    onMutate: () => setErreur(null),
    onSuccess: (r) => onCreated(r.IDmatiere),
    onError: (e: Error & { body?: { message?: string } }) => setErreur(e.body?.message ?? 'Création impossible.'),
  })
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Plus className="h-5 w-5 text-accent" />Nouvelle matière</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Nom</label>
            <input autoFocus value={libelle} onChange={(e) => setLibelle(e.target.value)} placeholder="ex. nickel" className={inputClass} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Famille</label>
            <PopoverSelect
              options={familles.map((f, i) => ({ id: i + 1, primary: f.libelle, secondary: f.ignoree ? 'ne compte pas' : undefined }))}
              value={famille}
              onChange={setFamille}
              emptyLabel="— à classer —"
            />
          </div>
          {erreur && <p className="text-sm text-destructive">{erreur}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button disabled={!libelle.trim() || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Créer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
