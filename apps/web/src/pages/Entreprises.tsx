import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  Globe,
  Building2,
  Search,
  Loader2,
  AlertCircle,
  MapPin,
  Phone,
  Mail,
  User,
  Award,
  Star,
  Pencil,
  AtSign,
  MessageSquare,
  Calendar,
  Building,
  Plus,
  X,
  Save,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { SendEmailDialog } from '@/components/email/SendEmailDialog'
import { cn } from '@/lib/utils'
import { formatHfsqlDate, hfsqlDateToInput } from '@/lib/dates'
import { apiFetch, API_URL } from '@/lib/api'
import { postEmail } from '@/lib/email'

// ── Types ──────────────────────────────────────────────

interface Entreprise {
  IDentreprise: number
  nom: string
  commentaire: string | null
}

interface EntrepriseDetail extends Entreprise {
  adresses: Adresse[]
  contacts: Contact[]
  competences: Competence[]
  recommandations: Recommandation[]
}

interface Adresse {
  IDadresse: number
  nom: string | null
  adresse1: string | null
  adresse2: string | null
  adresse3: string | null
  cp: string | null
  ville: string | null
  pays: string | null
  commentaire: string | null
  est_defaut: boolean
}

interface Contact {
  IDcontact: number
  nom: string | null
  prenom: string | null
  tel: string | null
  mail: string | null
  commentaire: string | null
  est_defaut: boolean
}

interface Competence {
  IDcompetence: number
  reference: string | null
}

interface Recommandation {
  IDrecommandation: number
  date_reco: string | null
  société: string | null
  contact: string | null
  besoin: string | null
}

// ── API helpers ────────────────────────────────────────
// Shared apiFetch (credentials: 'include' for cookie auth) — see apps/web/src/lib/api.ts

function useEntreprises() {
  return useQuery<Entreprise[]>({ queryKey: ['entreprises'], queryFn: () => apiFetch('/entreprises') })
}

function useEntrepriseDetail(id: number | null) {
  return useQuery<EntrepriseDetail>({ queryKey: ['entreprise', id], queryFn: () => apiFetch(`/entreprises/${id}`), enabled: id !== null })
}

// ── Shared styling ─────────────────────────────────────

const inputClass = 'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

// ── Main Page ──────────────────────────────────────────

export function Entreprises() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [emailModalOpen, setEmailModalOpen] = useState(false)
  const [editNom, setEditNom] = useState('')
  const [editCommentaire, setEditCommentaire] = useState('')

  const originalDraftRef = useRef<{ nom: string; commentaire: string } | null>(null)
  // Per-key sub-form dirty registry. Each sub-form reports its own dirty bool
  // under a unique key; the page aggregates by Set size so multiple forms can
  // be dirty simultaneously without clobbering each other.
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set())
  const reportDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((prev) => {
      if (dirty === prev.has(key)) return prev
      const next = new Set(prev)
      if (dirty) next.add(key); else next.delete(key)
      return next
    })
  }, [])
  const subFormsDirty = dirtyKeys.size > 0

  const { data: entreprises, isLoading, isError, error } = useEntreprises()
  const { data: detail, isLoading: detailLoading } = useEntrepriseDetail(selectedId)

  const filtered = useMemo(() => {
    if (!entreprises) return []
    if (!searchQuery.trim()) return entreprises
    const q = searchQuery.toLowerCase()
    return entreprises.filter((e) => e.nom.toLowerCase().includes(q) || (e.commentaire && e.commentaire.toLowerCase().includes(q)))
  }, [entreprises, searchQuery])

  // Keep the selection valid against the search-filtered list: narrowing the
  // search re-targets the top row instead of leaving the previous one on screen.
  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (e) => e.IDentreprise,
    select: setSelectedId,
    suspended: isEditing,
  })

  const startEdit = useCallback(() => {
    if (detail) {
      const snapshot = { nom: detail.nom, commentaire: detail.commentaire ?? '' }
      setEditNom(snapshot.nom)
      setEditCommentaire(snapshot.commentaire)
      originalDraftRef.current = snapshot
      setIsEditing(true)
    }
  }, [detail])

  const cancelEdit = useCallback(() => setIsEditing(false), [])

  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o) return false
    if (editNom !== o.nom) return true
    if (editCommentaire !== o.commentaire) return true
    if (subFormsDirty) return true
    return false
  }, [isEditing, editNom, editCommentaire, subFormsDirty])

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['entreprises'] })
    queryClient.invalidateQueries({ queryKey: ['entreprise', selectedId] })
  }, [queryClient, selectedId])

  const saveMutation = useMutation({
    mutationFn: () => apiFetch(`/entreprises/${selectedId}`, { method: 'PUT', body: JSON.stringify({ nom: editNom, commentaire: editCommentaire }) }),
    onSuccess: () => { invalidateAll(); setIsEditing(false) },
  })

  const createMutation = useMutation({
    mutationFn: () => apiFetch('/entreprises', { method: 'POST', body: JSON.stringify({ nom: 'Nouvelle entreprise' }) }),
    onSuccess: (data: Entreprise) => {
      queryClient.invalidateQueries({ queryKey: ['entreprises'] })
      setSelectedId(data.IDentreprise); setEditNom(data.nom); setEditCommentaire(''); setIsEditing(true)
    },
  })

  const guard = useUnsavedGuard({
    isDirty,
    save: async () => { await saveMutation.mutateAsync() },
    onDiscard: () => setIsEditing(false),
  })

  const handleSelect = useCallback((id: number) => {
    guard.guardAction(() => {
      setIsEditing(false)
      setSelectedId(id)
    })
  }, [guard])

  return (
    <>
    <MasterDetailLayout
      list={<EntrepriseList entreprises={filtered} isLoading={isLoading} isError={isError} error={error as Error | null}
        selectedId={selectedId} onSelect={handleSelect} searchQuery={searchQuery} onSearchChange={setSearchQuery}
        onNew={() => createMutation.mutate()} isCreating={createMutation.isPending} isEditing={isEditing} />}
      detailHeader={<DetailHeader entreprise={detail ?? null} isLoading={detailLoading && selectedId !== null}
        isEditing={isEditing} editNom={editNom} onEditNomChange={setEditNom}
        onStartEdit={startEdit} onCancelEdit={cancelEdit} onSave={() => saveMutation.mutate()} isSaving={saveMutation.isPending}
        onEmailClick={() => setEmailModalOpen(true)} />}
      detail={<DetailMain entreprise={detail ?? null} isLoading={detailLoading && selectedId !== null}
        hasSelection={selectedId !== null} isEditing={isEditing} editCommentaire={editCommentaire}
        onEditCommentaireChange={setEditCommentaire} entrepriseId={selectedId} onMutationSuccess={invalidateAll}
        reportDirty={reportDirty} />}
      sidebar={selectedId !== null ? <DetailSidebar entreprise={detail ?? null} isLoading={detailLoading}
        isEditing={isEditing} entrepriseId={selectedId} onMutationSuccess={invalidateAll}
        reportDirty={reportDirty} /> : null}
      sidebarTitle="Informations" hasSelection={selectedId !== null}
      onBack={() => guard.guardAction(() => { setIsEditing(false); setSelectedId(null) })}
    />

    <UnsavedChangesDialog
      open={guard.showDialog}
      onAction={guard.handleAction}
      isSaving={guard.isSaving}
    />

    {selectedId !== null && (
      <SendEmailDialog
        open={emailModalOpen}
        onClose={() => setEmailModalOpen(false)}
        contextLabel={detail?.nom ?? undefined}
        queryKey={['entreprise-email-defaults', selectedId]}
        loadDefaults={() => apiFetch(`/entreprises/${selectedId}/email-defaults`)}
        onSend={(p) => postEmail(`${API_URL}/entreprises/${selectedId}/email`, p)}
      />
    )}
    </>
  )
}

// ── Left Panel: List ───────────────────────────────────

function EntrepriseList({ entreprises, isLoading, isError, error, selectedId, onSelect, searchQuery, onSearchChange, onNew, isCreating, isEditing }: {
  entreprises: Entreprise[]; isLoading: boolean; isError: boolean; error: Error | null
  selectedId: number | null; onSelect: (id: number) => void; searchQuery: string; onSearchChange: (q: string) => void
  onNew: () => void; isCreating: boolean; isEditing: boolean
}) {
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input type="text" placeholder="Rechercher..." value={searchQuery} onChange={(e) => onSearchChange(e.target.value)}
            autoComplete="off" className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-2 scrollbar-transparent">
        {isLoading ? <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
        : isError ? <div className="flex flex-col items-center justify-center py-8 text-destructive"><AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">{error?.message || 'Erreur'}</p></div>
        : entreprises.length === 0 ? <div className="flex flex-col items-center justify-center py-8 text-muted-foreground"><Building2 className="h-12 w-12 mb-3 opacity-50" /><p className="text-sm">Aucune entreprise</p></div>
        : entreprises.map((e) => (
          <div key={e.IDentreprise} onClick={() => onSelect(e.IDentreprise)}
            className={cn('p-3 border rounded-lg cursor-pointer transition-all',
              selectedId === e.IDentreprise ? 'border-accent bg-white ring-1 ring-accent' : 'border-border bg-white hover:border-accent/50')}>
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <p className="font-medium text-sm truncate">{e.nom}</p>
            </div>
            {e.commentaire && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{e.commentaire}</p>}
          </div>
        ))}
      </div>
      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{entreprises.length} entreprise{entreprises.length !== 1 ? 's' : ''}</span>
        {!isEditing && (
          <Button size="sm" variant="ghost" onClick={onNew} disabled={isCreating} className="text-accent hover:text-accent hover:bg-accent/10">
            <Plus className="h-3.5 w-3.5 mr-1" />Nouveau
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Center: Detail Header ──────────────────────────────

function DetailHeader({ entreprise, isLoading, isEditing, editNom, onEditNomChange, onStartEdit, onCancelEdit, onSave, isSaving, onEmailClick }: {
  entreprise: EntrepriseDetail | null; isLoading: boolean; isEditing: boolean; editNom: string; onEditNomChange: (v: string) => void
  onStartEdit: () => void; onCancelEdit: () => void; onSave: () => void; isSaving: boolean; onEmailClick: () => void
}) {
  if (!entreprise && !isLoading) return null
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center', isEditing ? 'bg-accent/15' : 'icon-box-gold')}>
          <Building2 className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? <div className="h-8 w-48 bg-muted animate-pulse rounded" />
          : isEditing ? (
            <div className="flex items-center gap-3">
              <input value={editNom} onChange={(e) => onEditNomChange(e.target.value)} autoFocus
                className="flex-1 text-xl font-heading font-bold h-10 px-3 rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
              <Badge className="bg-accent text-accent-foreground flex-shrink-0 gap-1 shadow-sm">
                <Pencil className="h-3 w-3" />Mode edition
              </Badge>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">{entreprise?.nom}</h1>
              {entreprise?.competences && entreprise.competences.length > 0 && (
                <div className="flex gap-1.5 mt-1 flex-wrap">
                  {entreprise.competences.map((c) => <Badge key={c.IDcompetence} variant="secondary" className="text-xs">{c.reference}</Badge>)}
                </div>
              )}
            </>
          )}
        </div>
        {!isLoading && entreprise && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {isEditing ? (
              <>
                <Button variant="outline" size="sm" onClick={onCancelEdit}><X className="h-3.5 w-3.5 mr-1.5" />Annuler</Button>
                <Button size="sm" onClick={onSave} disabled={isSaving}>
                  <Save className="h-3.5 w-3.5 mr-1.5" />{isSaving ? 'Enregistrement...' : 'Enregistrer'}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="icon" className="h-9 w-9" title="Envoyer un email" onClick={onEmailClick}><AtSign className="h-4 w-4" /></Button>
                <Button variant="gold" size="sm" onClick={onStartEdit}><Pencil className="h-3.5 w-3.5 mr-1.5" />Modifier</Button>
              </>
            )}
          </div>
        )}
      </div>
      <div className={cn('h-1 w-24 mt-3 rounded-full', isEditing ? 'bg-accent' : 'bg-gradient-to-r from-accent via-accent to-accent/30')} />
    </div>
  )
}

// ── Center: Detail Main ────────────────────────────────

function DetailMain({ entreprise, isLoading, hasSelection, isEditing, editCommentaire, onEditCommentaireChange, entrepriseId, onMutationSuccess, reportDirty }: {
  entreprise: EntrepriseDetail | null; isLoading: boolean; hasSelection: boolean; isEditing: boolean
  editCommentaire: string; onEditCommentaireChange: (v: string) => void; entrepriseId: number | null; onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  if (!hasSelection) return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="icon-box-gold h-16 w-16 mx-auto"><Globe className="h-8 w-8" /></div>
        <p className="text-muted-foreground text-sm">Selectionnez une entreprise dans la liste</p>
      </div>
    </div>
  )
  if (isLoading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
  if (!entreprise) return null

  return (
    <div className="flex-1 min-h-0 overflow-auto space-y-4">
      {/* Notes */}
      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Notes</CardTitle></CardHeader>
        <CardContent>
          {isEditing ? (
            <textarea value={editCommentaire} onChange={(e) => onEditCommentaireChange(e.target.value)} rows={4}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
          ) : entreprise.commentaire ? (
            <p className="text-sm text-muted-foreground whitespace-pre-line">{entreprise.commentaire}</p>
          ) : <p className="text-sm text-muted-foreground italic">Aucune note</p>}
        </CardContent>
      </Card>

      <CompetencesCard competences={entreprise.competences} isEditing={isEditing} entrepriseId={entrepriseId!} onMutationSuccess={onMutationSuccess} />
      <RecommandationsCard recommandations={entreprise.recommandations} isEditing={isEditing} entrepriseId={entrepriseId!} onMutationSuccess={onMutationSuccess} reportDirty={reportDirty} />
    </div>
  )
}

// ── Competences Card ───────────────────────────────────

function CompetencesCard({ competences, isEditing, entrepriseId, onMutationSuccess }: {
  competences: Competence[]; isEditing: boolean; entrepriseId: number; onMutationSuccess: () => void
}) {
  const [showAdd, setShowAdd] = useState(false)
  const { data: available } = useQuery<Competence[]>({
    queryKey: ['competences-available', entrepriseId],
    queryFn: () => apiFetch(`/entreprises/${entrepriseId}/competences/available`),
    enabled: isEditing && showAdd,
  })
  const addMut = useMutation({
    mutationFn: (compId: number) => apiFetch(`/entreprises/${entrepriseId}/competences`, { method: 'POST', body: JSON.stringify({ IDcompetence: compId }) }),
    onSuccess: () => { onMutationSuccess(); setShowAdd(false) },
  })
  const removeMut = useMutation({
    mutationFn: (compId: number) => apiFetch(`/entreprises/${entrepriseId}/competences/${compId}`, { method: 'DELETE' }),
    onSuccess: onMutationSuccess,
  })

  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardHeader className="flex flex-row items-center gap-2 p-4 space-y-0">
        <Award className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Competences</CardTitle>
        {isEditing && (
          <Button variant="ghost" size="icon" className="h-6 w-6 ml-auto" onClick={() => setShowAdd(!showAdd)}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {competences.map((c) => (
            <Badge key={c.IDcompetence} className="bg-accent/10 text-accent hover:bg-accent/20 border-accent/20">
              {c.reference}
              {isEditing && (
                <button className="ml-1.5 rounded-full hover:bg-destructive/20 hover:text-destructive p-0.5 -mr-1 transition-colors" onClick={() => removeMut.mutate(c.IDcompetence)}>
                  <X className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))}
          {competences.length === 0 && !isEditing && <p className="text-sm text-muted-foreground italic">Aucune competence</p>}
        </div>
        {isEditing && showAdd && available && (
          <div className="mt-3 pt-3 border-t border-border/50 flex flex-wrap gap-2">
            {available.length === 0 ? <p className="text-xs text-muted-foreground italic">Toutes assignees</p>
            : available.map((c) => (
              <Badge key={c.IDcompetence} variant="outline" className="cursor-pointer hover:bg-accent/10 transition-colors" onClick={() => addMut.mutate(c.IDcompetence)}>
                <Plus className="h-3 w-3 mr-1" />{c.reference}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Recommandations Card ───────────────────────────────

function RecommandationsCard({ recommandations, isEditing, entrepriseId, onMutationSuccess, reportDirty }: {
  recommandations: Recommandation[]; isEditing: boolean; entrepriseId: number; onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ société: '', contact: '', besoin: '', date_reco: '' })

  const reportDirtyRef = useRef(reportDirty)
  useEffect(() => { reportDirtyRef.current = reportDirty })
  useEffect(() => {
    reportDirtyRef.current('recommandations', showForm || editingId !== null)
  }, [showForm, editingId])
  useEffect(() => () => { reportDirtyRef.current('recommandations', false) }, [])

  const createMut = useMutation({
    mutationFn: () => apiFetch(`/entreprises/${entrepriseId}/recommandations`, { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => { onMutationSuccess(); resetForm() },
  })
  const updateMut = useMutation({
    mutationFn: (rid: number) => apiFetch(`/entreprises/${entrepriseId}/recommandations/${rid}`, { method: 'PUT', body: JSON.stringify(form) }),
    onSuccess: () => { onMutationSuccess(); setEditingId(null) },
  })
  const deleteMut = useMutation({
    mutationFn: (rid: number) => apiFetch(`/entreprises/${entrepriseId}/recommandations/${rid}`, { method: 'DELETE' }),
    onSuccess: onMutationSuccess,
  })

  const resetForm = () => { setForm({ société: '', contact: '', besoin: '', date_reco: '' }); setShowForm(false) }

  const startEditReco = (r: Recommandation) => {
    setEditingId(r.IDrecommandation)
    setForm({ société: r['société'] ?? '', contact: r.contact ?? '', besoin: r.besoin ?? '', date_reco: hfsqlDateToInput(r.date_reco) })
  }

  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardHeader className="flex flex-row items-center gap-2 p-4 space-y-0">
        <MessageSquare className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Recommandations</CardTitle>
        <Badge variant="secondary" className="text-xs ml-auto">{recommandations.length}</Badge>
        {isEditing && !showForm && editingId === null && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowForm(true)}><Plus className="h-3.5 w-3.5" /></Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {recommandations.length === 0 && !isEditing && <p className="text-sm text-muted-foreground italic">Aucune recommandation</p>}
        {recommandations.map((r) =>
          isEditing && editingId === r.IDrecommandation ? (
            <InlineForm key={r.IDrecommandation} title="Modifier la recommandation"
              onSave={() => updateMut.mutate(r.IDrecommandation)} onCancel={() => setEditingId(null)} isSaving={updateMut.isPending}>
              <div className="grid grid-cols-2 gap-2">
                <LabeledInput label="Societe" value={form.société} onChange={(v) => setForm({ ...form, société: v })} />
                <LabeledInput label="Contact" value={form.contact} onChange={(v) => setForm({ ...form, contact: v })} />
              </div>
              <LabeledInput label="Date" type="date" value={form.date_reco} onChange={(v) => setForm({ ...form, date_reco: v })} />
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Besoin</label>
                <textarea value={form.besoin} onChange={(e) => setForm({ ...form, besoin: e.target.value })} rows={2}
                  className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
              </div>
            </InlineForm>
          ) : (
            <div key={r.IDrecommandation} className="rounded-lg p-3 border border-border/60 bg-zinc-100/80 group relative">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Building className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm font-medium">{r['société'] || '—'}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {r.date_reco && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Calendar className="h-3 w-3" />{formatHfsqlDate(r.date_reco)}</span>}
                  {isEditing && (
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => startEditReco(r)}><Pencil className="h-3 w-3" /></Button>
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => deleteMut.mutate(r.IDrecommandation)}><Trash2 className="h-3 w-3" /></Button>
                    </div>
                  )}
                </div>
              </div>
              {r.contact && <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1"><User className="h-3 w-3" /><span>{r.contact}</span></div>}
              {r.besoin && <p className="text-sm text-muted-foreground whitespace-pre-line mt-1.5">{r.besoin}</p>}
            </div>
          )
        )}
        {isEditing && showForm && (
          <InlineForm title="Nouvelle recommandation" onSave={() => createMut.mutate()} onCancel={resetForm} isSaving={createMut.isPending}>
            <div className="grid grid-cols-2 gap-2">
              <LabeledInput label="Societe" value={form.société} onChange={(v) => setForm({ ...form, société: v })} autoFocus />
              <LabeledInput label="Contact" value={form.contact} onChange={(v) => setForm({ ...form, contact: v })} />
            </div>
            <LabeledInput label="Date" type="date" value={form.date_reco} onChange={(v) => setForm({ ...form, date_reco: v })} />
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Besoin</label>
              <textarea value={form.besoin} onChange={(e) => setForm({ ...form, besoin: e.target.value })} rows={2}
                className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
            </div>
          </InlineForm>
        )}
      </CardContent>
    </Card>
  )
}

// ── Shared form components ─────────────────────────────

function LabeledInput({ label, value, onChange, type = 'text', autoFocus }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; autoFocus?: boolean
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus}
        autoComplete="off" data-form-type="other" data-lpignore="true" className={inputClass} />
    </div>
  )
}

function InlineForm({ title, children, onSave, onCancel, isSaving }: {
  title: string; children: React.ReactNode; onSave: () => void; onCancel: () => void; isSaving: boolean
}) {
  return (
    <div className="rounded-lg border border-accent/25 bg-accent/[0.03] p-4 space-y-3">
      <p className="text-xs font-semibold text-accent uppercase tracking-wide">{title}</p>
      {children}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={onCancel}>Annuler</Button>
        <Button size="sm" onClick={onSave} disabled={isSaving}>{isSaving ? 'Enregistrement...' : 'Enregistrer'}</Button>
      </div>
    </div>
  )
}

// ── Right Panel: Sidebar with Tabs ─────────────────────

type SidebarTab = 'contacts' | 'adresses'

function DetailSidebar({ entreprise, isLoading, isEditing, entrepriseId, onMutationSuccess, reportDirty }: {
  entreprise: EntrepriseDetail | null; isLoading: boolean; isEditing: boolean; entrepriseId: number; onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('contacts')
  if (isLoading) return (
    <div className="w-96 flex-shrink-0 bg-zinc-100/80 rounded-xl border p-4 space-y-4">
      <div className="flex gap-2"><div className="h-8 flex-1 bg-muted animate-pulse rounded-md" /><div className="h-8 flex-1 bg-muted animate-pulse rounded-md" /></div>
      {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
    </div>
  )
  if (!entreprise) return null

  const tabs: { key: SidebarTab; label: string; icon: React.ElementType }[] = [
    { key: 'contacts', label: 'Contacts', icon: User },
    { key: 'adresses', label: 'Adresses', icon: MapPin },
  ]

  return (
    <div className="w-96 flex-shrink-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
      <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
        {tabs.map((tab) => {
          const Icon = tab.icon
          return (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              className={cn('flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                activeTab === tab.key ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10')}>
              <Icon className="h-3.5 w-3.5" />{tab.label}
            </button>
          )
        })}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {activeTab === 'contacts' && <ContactsTab contacts={entreprise.contacts} isEditing={isEditing} entrepriseId={entrepriseId} onMutationSuccess={onMutationSuccess} reportDirty={reportDirty} />}
        {activeTab === 'adresses' && <AdressesTab adresses={entreprise.adresses} isEditing={isEditing} entrepriseId={entrepriseId} onMutationSuccess={onMutationSuccess} reportDirty={reportDirty} />}
      </div>
    </div>
  )
}

// ── Sidebar Tab: Contacts ──────────────────────────────

function ContactsTab({ contacts, isEditing, entrepriseId, onMutationSuccess, reportDirty }: {
  contacts: Contact[]; isEditing: boolean; entrepriseId: number; onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState({ nom: '', prenom: '', tel: '', mail: '' })
  const [showForm, setShowForm] = useState(false)

  const reportDirtyRef = useRef(reportDirty)
  useEffect(() => { reportDirtyRef.current = reportDirty })
  useEffect(() => {
    reportDirtyRef.current('ent-contacts', showForm || editingId !== null)
  }, [showForm, editingId])
  useEffect(() => () => { reportDirtyRef.current('ent-contacts', false) }, [])

  const createMut = useMutation({
    mutationFn: () => apiFetch(`/entreprises/${entrepriseId}/contacts`, { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => { onMutationSuccess(); resetForm() },
  })
  const updateMut = useMutation({
    mutationFn: (cid: number) => apiFetch(`/entreprises/${entrepriseId}/contacts/${cid}`, { method: 'PUT', body: JSON.stringify(form) }),
    onSuccess: () => { onMutationSuccess(); setEditingId(null) },
  })
  const deleteMut = useMutation({
    mutationFn: (cid: number) => apiFetch(`/entreprises/${entrepriseId}/contacts/${cid}`, { method: 'DELETE' }),
    onSuccess: onMutationSuccess,
  })

  const resetForm = () => { setForm({ nom: '', prenom: '', tel: '', mail: '' }); setShowForm(false) }

  const startEditContact = (c: Contact) => {
    setEditingId(c.IDcontact)
    setForm({ nom: c.nom ?? '', prenom: c.prenom ?? '', tel: c.tel ?? '', mail: c.mail ?? '' })
  }

  if (contacts.length === 0 && !isEditing) return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground"><User className="h-10 w-10 mb-2 opacity-40" /><p className="text-sm">Aucun contact</p></div>
  )

  return (
    <>
      {contacts.map((c) =>
        isEditing && editingId === c.IDcontact ? (
          <InlineForm key={c.IDcontact} title="Modifier le contact" onSave={() => updateMut.mutate(c.IDcontact)} onCancel={() => setEditingId(null)} isSaving={updateMut.isPending}>
            <div className="grid grid-cols-2 gap-2">
              <LabeledInput label="Prenom" value={form.prenom} onChange={(v) => setForm({ ...form, prenom: v })} />
              <LabeledInput label="Nom" value={form.nom} onChange={(v) => setForm({ ...form, nom: v })} />
            </div>
            <LabeledInput label="Telephone" value={form.tel} onChange={(v) => setForm({ ...form, tel: v })} />
            <LabeledInput label="Email" value={form.mail} onChange={(v) => setForm({ ...form, mail: v })} />
          </InlineForm>
        ) : (
          <div key={c.IDcontact} className="p-3 rounded-lg border bg-card shadow-sm group relative">
            <div className="flex items-start justify-between">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm flex items-center gap-2">
                  {[c.prenom, c.nom].filter(Boolean).join(' ') || 'Contact'}
                  {!!c.est_defaut && <Badge variant="secondary" className="text-[10px] py-0"><Star className="h-2.5 w-2.5 mr-0.5" />Principal</Badge>}
                </div>
                {c.tel && <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-1"><Phone className="h-3 w-3" />{c.tel}</div>}
                {c.mail && <div className="text-xs text-muted-foreground flex items-center gap-1.5"><Mail className="h-3 w-3" /><span className="truncate">{c.mail}</span></div>}
              </div>
              {isEditing && (
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => startEditContact(c)}><Pencil className="h-3 w-3" /></Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => deleteMut.mutate(c.IDcontact)}><Trash2 className="h-3 w-3" /></Button>
                </div>
              )}
            </div>
          </div>
        )
      )}
      {isEditing && !showForm && editingId === null && (
        <Button variant="ghost" size="sm" className="w-full text-muted-foreground hover:text-foreground" onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4 mr-1.5" />Ajouter un contact
        </Button>
      )}
      {isEditing && showForm && (
        <InlineForm title="Nouveau contact" onSave={() => createMut.mutate()} onCancel={resetForm} isSaving={createMut.isPending}>
          <div className="grid grid-cols-2 gap-2">
            <LabeledInput label="Prenom" value={form.prenom} onChange={(v) => setForm({ ...form, prenom: v })} autoFocus />
            <LabeledInput label="Nom" value={form.nom} onChange={(v) => setForm({ ...form, nom: v })} />
          </div>
          <LabeledInput label="Telephone" value={form.tel} onChange={(v) => setForm({ ...form, tel: v })} />
          <LabeledInput label="Email" value={form.mail} onChange={(v) => setForm({ ...form, mail: v })} />
        </InlineForm>
      )}
    </>
  )
}

// ── Sidebar Tab: Adresses ──────────────────────────────

function AdressesTab({ adresses, isEditing, entrepriseId, onMutationSuccess, reportDirty }: {
  adresses: Adresse[]; isEditing: boolean; entrepriseId: number; onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState({ nom: '', adresse1: '', cp: '', ville: '', pays: '' })
  const [showForm, setShowForm] = useState(false)

  const reportDirtyRef = useRef(reportDirty)
  useEffect(() => { reportDirtyRef.current = reportDirty })
  useEffect(() => {
    reportDirtyRef.current('ent-adresses', showForm || editingId !== null)
  }, [showForm, editingId])
  useEffect(() => () => { reportDirtyRef.current('ent-adresses', false) }, [])

  const createMut = useMutation({
    mutationFn: () => apiFetch(`/entreprises/${entrepriseId}/adresses`, { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => { onMutationSuccess(); resetForm() },
  })
  const updateMut = useMutation({
    mutationFn: (aid: number) => apiFetch(`/entreprises/${entrepriseId}/adresses/${aid}`, { method: 'PUT', body: JSON.stringify(form) }),
    onSuccess: () => { onMutationSuccess(); setEditingId(null) },
  })
  const deleteMut = useMutation({
    mutationFn: (aid: number) => apiFetch(`/entreprises/${entrepriseId}/adresses/${aid}`, { method: 'DELETE' }),
    onSuccess: onMutationSuccess,
  })

  const resetForm = () => { setForm({ nom: '', adresse1: '', cp: '', ville: '', pays: '' }); setShowForm(false) }

  const startEditAddr = (a: Adresse) => {
    setEditingId(a.IDadresse)
    setForm({ nom: a.nom ?? '', adresse1: a.adresse1 ?? '', cp: a.cp ?? '', ville: a.ville ?? '', pays: a.pays ?? '' })
  }

  if (adresses.length === 0 && !isEditing) return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground"><MapPin className="h-10 w-10 mb-2 opacity-40" /><p className="text-sm">Aucune adresse</p></div>
  )

  return (
    <>
      {adresses.map((a) =>
        isEditing && editingId === a.IDadresse ? (
          <InlineForm key={a.IDadresse} title="Modifier l'adresse" onSave={() => updateMut.mutate(a.IDadresse)} onCancel={() => setEditingId(null)} isSaving={updateMut.isPending}>
            <LabeledInput label="Libelle" value={form.nom} onChange={(v) => setForm({ ...form, nom: v })} />
            <LabeledInput label="Adresse" value={form.adresse1} onChange={(v) => setForm({ ...form, adresse1: v })} />
            <div className="grid grid-cols-3 gap-2">
              <LabeledInput label="CP" value={form.cp} onChange={(v) => setForm({ ...form, cp: v })} />
              <div className="col-span-2"><LabeledInput label="Ville" value={form.ville} onChange={(v) => setForm({ ...form, ville: v })} /></div>
            </div>
            <LabeledInput label="Pays" value={form.pays} onChange={(v) => setForm({ ...form, pays: v })} />
          </InlineForm>
        ) : (
          <div key={a.IDadresse} className="p-3 rounded-lg border bg-card shadow-sm group relative">
            <div className="flex items-start justify-between">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm flex items-center gap-2">
                  {a.nom || 'Adresse'}
                  {!!a.est_defaut && <Badge variant="secondary" className="text-[10px] py-0"><Star className="h-2.5 w-2.5 mr-0.5" />Principale</Badge>}
                </div>
                <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                  {a.adresse1 && <p>{a.adresse1}</p>}
                  {a.adresse2 && <p>{a.adresse2}</p>}
                  {a.adresse3 && <p>{a.adresse3}</p>}
                  {(a.cp || a.ville) && <p>{[a.cp, a.ville].filter(Boolean).join(' ')}</p>}
                  {a.pays && <p>{a.pays}</p>}
                </div>
              </div>
              {isEditing && (
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => startEditAddr(a)}><Pencil className="h-3 w-3" /></Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => deleteMut.mutate(a.IDadresse)}><Trash2 className="h-3 w-3" /></Button>
                </div>
              )}
            </div>
          </div>
        )
      )}
      {isEditing && !showForm && editingId === null && (
        <Button variant="ghost" size="sm" className="w-full text-muted-foreground hover:text-foreground" onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4 mr-1.5" />Ajouter une adresse
        </Button>
      )}
      {isEditing && showForm && (
        <InlineForm title="Nouvelle adresse" onSave={() => createMut.mutate()} onCancel={resetForm} isSaving={createMut.isPending}>
          <LabeledInput label="Libelle" value={form.nom} onChange={(v) => setForm({ ...form, nom: v })} autoFocus />
          <LabeledInput label="Adresse" value={form.adresse1} onChange={(v) => setForm({ ...form, adresse1: v })} />
          <div className="grid grid-cols-3 gap-2">
            <LabeledInput label="CP" value={form.cp} onChange={(v) => setForm({ ...form, cp: v })} />
            <div className="col-span-2"><LabeledInput label="Ville" value={form.ville} onChange={(v) => setForm({ ...form, ville: v })} /></div>
          </div>
          <LabeledInput label="Pays" value={form.pays} onChange={(v) => setForm({ ...form, pays: v })} />
        </InlineForm>
      )}
    </>
  )
}
