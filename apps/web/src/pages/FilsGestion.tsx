import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  Factory,
  Search,
  Loader2,
  AlertCircle,
  MapPin,
  Mail,
  User,
  Star,
  Pencil,
  Plus,
  X,
  Save,
  Trash2,
  FileText,
  ShoppingCart,
  Send,
  Shield,
  Leaf,
  Recycle,
  Info,
  Phone,
  ChevronDown,
  Upload,
  MessageSquare,
  Palette,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { cn } from '@/lib/utils'
import { formatHfsqlDate, hfsqlDateToInput, inputDateToHfsql } from '@/lib/dates'
import { apiFetch, API_URL } from '@/lib/api'

// ── Types ──────────────────────────────────────────────

interface Fournisseur {
  IDfournisseur: number
  nom: string
  tel: string | null
  fax: string | null
  commentaire: string | null
  est_visible: number
  IDsociete: number | null
}

interface LigneCommande {
  IDref_fil_commande: number
  IDcommande_fil: number
  quantite: number | null
  unite: number | null
  prix_unitaire: number | null
  date_livraison: string | null
  etat: number | null
  ref_fil: string | null
  colori_reference: string | null
}

interface CommandeFil {
  IDcommande_fil: number
  date_commande: string | null
  etat: number | null
  commentaire: string | null
  lignes: LigneCommande[]
}

interface FournisseurDetail extends Fournisseur {
  adresses: Adresse[]
  contacts: Contact[]
  refsFil: RefFil[]
  certificats: Certificat[]
  commandes: CommandeFil[]
}

interface RefFil {
  IDcolori_fil: number
  colori_reference: string | null
  colori_prix_kg: number | null
  IDref_fil: number
  reference: string | null
  prix_kg: number | null
  titrage: number | null
  nb_fil: number | null
  nb_brin: number | null
  bio: number
  recycle: number
}

interface Certificat {
  IDcertificat: number
  nom: string | null
  numero_ref: string | null
  debut_validite: string | null
  date_expiration: string | null
  type_doc: string | null
  IDtype_doc: number | null
  has_fichier: boolean
}

interface TypeDoc {
  IDtype_doc: number
  nom: string
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
  est_defaut_facturation: boolean
  est_defaut_livraison: boolean
}

interface Contact {
  IDcontact: number
  nom: string | null
  prenom: string | null
  tel: string | null
  mail: string | null
  commentaire: string | null
  est_defaut: boolean
  envoi_bl: boolean
  envoi_facture: boolean
  envoi_commande: boolean
  envoi_soumission: boolean
}

// ── API helpers ────────────────────────────────────────
// Shared apiFetch + API_URL — see apps/web/src/lib/api.ts

function useFournisseurs() {
  return useQuery<Fournisseur[]>({ queryKey: ['fournisseurs'], queryFn: () => apiFetch('/fournisseurs') })
}

function useFournisseurDetail(id: number | null) {
  return useQuery<FournisseurDetail>({ queryKey: ['fournisseur', id], queryFn: () => apiFetch(`/fournisseurs/${id}`), enabled: id !== null })
}

// ── Shared styling ─────────────────────────────────────

const inputClass = 'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

// ── Main Page ──────────────────────────────────────────

export function FilsGestion() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [editNom, setEditNom] = useState('')
  const [editCommentaire, setEditCommentaire] = useState('')

  // Snapshot of header draft at edit-start for dirty computation
  const originalDraftRef = useRef<{ nom: string; commentaire: string } | null>(null)
  // Dirty state from sub-forms (Contacts, Adresses tabs — surfaced via callback)
  const [subFormsDirty, setSubFormsDirty] = useState(false)

  const { data: fournisseurs, isLoading, isError, error } = useFournisseurs()
  const { data: detail, isLoading: detailLoading } = useFournisseurDetail(selectedId)

  const filtered = useMemo(() => {
    if (!fournisseurs) return []
    if (!searchQuery.trim()) return fournisseurs
    const q = searchQuery.toLowerCase()
    return fournisseurs.filter((f) => f.nom.toLowerCase().includes(q))
  }, [fournisseurs, searchQuery])

  // Keep the selection valid against the search-filtered list: narrowing the
  // search re-targets the top row instead of leaving the previous one on screen.
  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (f) => f.IDfournisseur,
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
    queryClient.invalidateQueries({ queryKey: ['fournisseurs'] })
    queryClient.invalidateQueries({ queryKey: ['fournisseur', selectedId] })
  }, [queryClient, selectedId])

  const saveMutation = useMutation({
    mutationFn: () => apiFetch(`/fournisseurs/${selectedId}`, { method: 'PUT', body: JSON.stringify({ nom: editNom, commentaire: editCommentaire }) }),
    onSuccess: () => { invalidateAll(); setIsEditing(false) },
  })

  const createMutation = useMutation({
    mutationFn: () => apiFetch('/fournisseurs', { method: 'POST', body: JSON.stringify({ nom: 'Nouveau fournisseur' }) }),
    onSuccess: (data: Fournisseur) => {
      queryClient.invalidateQueries({ queryKey: ['fournisseurs'] })
      setSelectedId(data.IDfournisseur); setEditNom(data.nom); setEditCommentaire(''); setIsEditing(true)
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
        list={<FournisseurList fournisseurs={filtered} isLoading={isLoading} isError={isError} error={error as Error | null}
          selectedId={selectedId} onSelect={handleSelect} searchQuery={searchQuery} onSearchChange={setSearchQuery}
          onNew={() => createMutation.mutate()} isCreating={createMutation.isPending} isEditing={isEditing} />}
        detailHeader={<DetailHeader fournisseur={detail ?? null} isLoading={detailLoading && selectedId !== null}
          isEditing={isEditing} editNom={editNom} onEditNomChange={setEditNom}
          onStartEdit={startEdit} onCancelEdit={cancelEdit} onSave={() => saveMutation.mutate()} isSaving={saveMutation.isPending} />}
        detail={<DetailMain fournisseur={detail ?? null} isLoading={detailLoading && selectedId !== null}
          hasSelection={selectedId !== null} isEditing={isEditing} fournisseurId={selectedId} onMutationSuccess={invalidateAll} />}
        sidebar={selectedId !== null ? <DetailSidebar fournisseur={detail ?? null} isLoading={detailLoading}
          isEditing={isEditing} fournisseurId={selectedId} onMutationSuccess={invalidateAll}
          editCommentaire={editCommentaire} onEditCommentaireChange={setEditCommentaire}
          onSubFormsDirtyChange={setSubFormsDirty} /> : null}
        sidebarTitle="Informations" hasSelection={selectedId !== null}
        onBack={() => guard.guardAction(() => { setIsEditing(false); setSelectedId(null) })}
      />
      <UnsavedChangesDialog
        open={guard.showDialog}
        onAction={guard.handleAction}
        isSaving={guard.isSaving}
      />
    </>
  )
}

// ── Left Panel: List ───────────────────────────────────

function FournisseurList({ fournisseurs, isLoading, isError, error, selectedId, onSelect, searchQuery, onSearchChange, onNew, isCreating, isEditing }: {
  fournisseurs: Fournisseur[]; isLoading: boolean; isError: boolean; error: Error | null
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
        : fournisseurs.length === 0 ? <div className="flex flex-col items-center justify-center py-8 text-muted-foreground"><Factory className="h-12 w-12 mb-3 opacity-50" /><p className="text-sm">Aucun fournisseur</p></div>
        : fournisseurs.map((f) => (
          <div key={f.IDfournisseur} onClick={() => onSelect(f.IDfournisseur)}
            className={cn('p-3 border rounded-lg cursor-pointer transition-all',
              selectedId === f.IDfournisseur ? 'border-accent bg-white ring-1 ring-accent' : 'border-border bg-white hover:border-accent/50')}>
            <div className="flex items-center gap-2">
              <Factory className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <p className="font-medium text-sm truncate">{f.nom}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{fournisseurs.length} fournisseur{fournisseurs.length !== 1 ? 's' : ''}</span>
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

function DetailHeader({ fournisseur, isLoading, isEditing, editNom, onEditNomChange, onStartEdit, onCancelEdit, onSave, isSaving }: {
  fournisseur: FournisseurDetail | null; isLoading: boolean; isEditing: boolean
  editNom: string; onEditNomChange: (v: string) => void
  onStartEdit: () => void; onCancelEdit: () => void; onSave: () => void; isSaving: boolean
}) {
  if (!fournisseur && !isLoading) return null
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center', isEditing ? 'bg-accent/15' : 'icon-box-gold')}>
          <Factory className="h-5 w-5" />
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
            <h1 className="text-2xl font-heading font-bold tracking-tight truncate">{fournisseur?.nom}</h1>
          )}
        </div>
        {!isLoading && fournisseur && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {isEditing ? (
              <>
                <Button variant="outline" size="sm" onClick={onCancelEdit}><X className="h-3.5 w-3.5 mr-1.5" />Annuler</Button>
                <Button size="sm" onClick={onSave} disabled={isSaving}>
                  <Save className="h-3.5 w-3.5 mr-1.5" />{isSaving ? 'Enregistrement...' : 'Enregistrer'}
                </Button>
              </>
            ) : (
              <Button variant="gold" size="sm" onClick={onStartEdit}><Pencil className="h-3.5 w-3.5 mr-1.5" />Modifier</Button>
            )}
          </div>
        )}
      </div>
      <div className={cn('h-1 w-24 mt-3 rounded-full', isEditing ? 'bg-accent' : 'bg-gradient-to-r from-accent via-accent to-accent/30')} />
    </div>
  )
}

// ── Center: Detail Main ────────────────────────────────

function isCertExpired(dateExp: string | null): boolean {
  if (!dateExp) return false
  const d = dateExp.length === 8 ? `${dateExp.substring(0, 4)}-${dateExp.substring(4, 6)}-${dateExp.substring(6, 8)}` : dateExp
  return new Date(d) < new Date()
}

function CommandeEtatBadge({ etat }: { etat: number | null }) {
  switch (etat) {
    case 0: return <Badge variant="secondary" className="text-[10px] py-0">Brouillon</Badge>
    case 1: return <Badge className="badge-warning text-[10px] py-0">En cours</Badge>
    case 2: return <Badge className="badge-success text-[10px] py-0">Livree</Badge>
    case 3: return <Badge variant="outline" className="text-[10px] py-0">Cloturee</Badge>
    default: return etat != null ? <Badge variant="secondary" className="text-[10px] py-0">Etat {etat}</Badge> : null
  }
}

function DetailMain({ fournisseur, isLoading, hasSelection, isEditing, fournisseurId, onMutationSuccess }: {
  fournisseur: FournisseurDetail | null; isLoading: boolean; hasSelection: boolean
  isEditing: boolean; fournisseurId: number | null; onMutationSuccess: () => void
}) {
  const [certifsOpen, setCertifsOpen] = useState(false)
  const [showExpired, setShowExpired] = useState(false)
  const [refsOpen, setRefsOpen] = useState(false)
  const [commandesOpen, setCommandesOpen] = useState(false)
  const [viewCert, setViewCert] = useState<Certificat | null>(null)
  const [editCert, setEditCert] = useState<Certificat | null>(null)
  const [createCert, setCreateCert] = useState(false)

  const deleteCertMut = useMutation({
    mutationFn: (certId: number) => apiFetch(`/fournisseurs/certificats/${certId}`, { method: 'DELETE' }),
    onSuccess: onMutationSuccess,
  })

  // Group yarn refs by base reference (must be before early returns to keep hook order stable)
  const refsGrouped = useMemo(() => {
    if (!fournisseur) return []
    const map = new Map<number, { reference: string; titrage: number | null; nb_fil: number | null; nb_brin: number | null; bio: boolean; recycle: boolean; coloris: { colori_reference: string; colori_prix_kg: number | null }[] }>()
    for (const r of fournisseur.refsFil) {
      if (!map.has(r.IDref_fil)) {
        map.set(r.IDref_fil, {
          reference: r.reference ?? '—',
          titrage: r.titrage,
          nb_fil: r.nb_fil,
          nb_brin: r.nb_brin,
          bio: !!r.bio,
          recycle: !!(r as any)['recyclé'] || !!(r as any)['recycl'] || !!(r as any)['recyclb'] || !!(r as any)['recycle'],
          coloris: [],
        })
      }
      map.get(r.IDref_fil)!.coloris.push({ colori_reference: r.colori_reference ?? '—', colori_prix_kg: r.colori_prix_kg })
    }
    return Array.from(map.values())
  }, [fournisseur?.refsFil])

  if (!hasSelection) return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="icon-box-gold h-16 w-16 mx-auto"><Factory className="h-8 w-8" /></div>
        <p className="text-muted-foreground text-sm">Selectionnez un fournisseur dans la liste</p>
      </div>
    </div>
  )
  if (isLoading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
  if (!fournisseur) return null

  const validCertificats = fournisseur.certificats.filter((c) => !isCertExpired(c.date_expiration))
  const displayedCertificats = showExpired ? fournisseur.certificats : validCertificats

  const handleCertClick = (c: Certificat) => {
    if (isEditing) {
      setEditCert(c)
    } else {
      setViewCert(c)
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto space-y-4">
      {/* Certificats */}
      <Card className="card-premium">
        <CardHeader className="flex flex-row items-center gap-2 p-4 space-y-0 cursor-pointer select-none" onClick={() => setCertifsOpen(!certifsOpen)}>
          <Shield className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Certificats</CardTitle>
          {isEditing && (
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-accent hover:text-accent hover:bg-accent/10"
              onClick={(e) => { e.stopPropagation(); setCreateCert(true) }}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          <Badge variant="secondary" className="text-xs ml-auto">{validCertificats.length}</Badge>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', certifsOpen && 'rotate-180')} />
        </CardHeader>
        {certifsOpen && <CardContent className="space-y-2">
          {fournisseur.certificats.length > validCertificats.length && (
            <button
              onClick={() => setShowExpired(!showExpired)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {showExpired ? 'Masquer expirés' : `Afficher expirés (${fournisseur.certificats.length - validCertificats.length})`}
            </button>
          )}
          {displayedCertificats.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Aucun certificat</p>
          ) : displayedCertificats.map((c) => {
            const expired = isCertExpired(c.date_expiration)
            return (
              <div key={c.IDcertificat} onClick={() => handleCertClick(c)}
                className={cn('group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 cursor-pointer transition-all hover:shadow-md p-3',
                  expired ? 'border-l-destructive/60' : 'border-l-green-500/60',
                  isEditing && editSectionClass)}>
                <div>
                    {/* Top row: name + status */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className={cn('h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0',
                          expired ? 'bg-destructive/10' : 'bg-green-500/10')}>
                          <Shield className={cn('h-3.5 w-3.5', expired ? 'text-destructive/70' : 'text-green-600')} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{c.nom || '—'}</p>
                          {c.type_doc && <p className="text-[11px] text-muted-foreground truncate">{c.type_doc}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {c.has_fichier && <FileText className="h-3.5 w-3.5 text-accent/50" />}
                        {isEditing && (
                          <button onClick={(e) => { e.stopPropagation(); if (confirm('Supprimer ce certificat ?')) deleteCertMut.mutate(c.IDcertificat) }}
                            className="opacity-0 group-hover:opacity-100 p-0.5 text-destructive hover:text-destructive/80 transition-opacity">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {expired ? (
                          <Badge variant="destructive" className="text-[10px] py-0 px-1.5">Expiré</Badge>
                        ) : (
                          <Badge className="badge-success text-[10px] py-0 px-1.5">Valide</Badge>
                        )}
                      </div>
                    </div>
                    {/* Bottom row: ref + dates */}
                    {(c.numero_ref || c.debut_validite || c.date_expiration) && (
                      <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
                        {c.numero_ref && (
                          <span className="truncate max-w-[320px]" title={c.numero_ref}>
                            Ref: {c.numero_ref}
                          </span>
                        )}
                        {(c.debut_validite || c.date_expiration) && (
                          <span className="flex-shrink-0 ml-auto">
                            {c.debut_validite && formatHfsqlDate(c.debut_validite)}
                            {c.debut_validite && c.date_expiration && ' → '}
                            {c.date_expiration && formatHfsqlDate(c.date_expiration)}
                          </span>
                        )}
                      </div>
                    )}
                </div>
              </div>
            )
          })}
        </CardContent>}
      </Card>

      {/* View mode dialog */}
      <CertificatViewDialog cert={viewCert} onClose={() => setViewCert(null)} />

      {/* Edit mode dialog */}
      <CertificatEditDialog cert={editCert} onClose={() => setEditCert(null)}
        fournisseurId={fournisseurId!} onSuccess={onMutationSuccess} />

      {/* Create mode dialog */}
      <CertificatEditDialog cert={createCert ? { IDcertificat: 0, nom: '', numero_ref: '', debut_validite: '', date_expiration: '', type_doc: null, IDtype_doc: null, has_fichier: false } : null}
        onClose={() => setCreateCert(false)} fournisseurId={fournisseurId!} onSuccess={onMutationSuccess} isNew />

      {/* References de fil */}
      <Card className="card-premium">
        <CardHeader className="flex flex-row items-center gap-2 p-4 space-y-0 cursor-pointer select-none" onClick={() => setRefsOpen(!refsOpen)}>
          <BobineIcon className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">References de fil</CardTitle>
          <Badge variant="secondary" className="text-xs ml-auto">{refsGrouped.length}</Badge>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', refsOpen && 'rotate-180')} />
        </CardHeader>
        {refsOpen && <CardContent className="space-y-2">
          {refsGrouped.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Aucune reference</p>
          ) : refsGrouped.map((ref, i) => (
            <div key={i} className={cn('group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3', 'border-l-amber-400/60')}>
              {/* Top row: icon + reference + badges */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
                    <BobineIcon className="h-3.5 w-3.5 text-amber-600" />
                  </div>
                  <p className="text-sm font-medium truncate">{ref.reference}</p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {ref.bio && <Badge className="bg-green-500/10 text-green-700 text-[10px] py-0 px-1.5 gap-0.5"><Leaf className="h-2.5 w-2.5" />Bio</Badge>}
                  {ref.recycle && <Badge className="bg-blue-500/10 text-blue-700 text-[10px] py-0 px-1.5 gap-0.5"><Recycle className="h-2.5 w-2.5" />Recycle</Badge>}
                </div>
              </div>
              {/* Bottom row: specs */}
              {(ref.titrage != null || (ref.nb_fil != null && ref.nb_fil > 0) || (ref.nb_brin != null && ref.nb_brin > 0)) && (
                <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
                  {ref.titrage != null && <span>Titrage: {ref.titrage}</span>}
                  {ref.nb_fil != null && ref.nb_fil > 0 && <span>{ref.nb_fil} fil{ref.nb_fil > 1 ? 's' : ''}</span>}
                  {ref.nb_brin != null && ref.nb_brin > 0 && <span>{ref.nb_brin} brin{ref.nb_brin > 1 ? 's' : ''}</span>}
                  <span className="ml-auto">{ref.coloris.length} coloris</span>
                </div>
              )}
              {/* Coloris chips: actual references this fournisseur supplies */}
              {ref.coloris.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {ref.coloris.map((c, ci) => (
                    <Badge
                      key={ci}
                      variant="secondary"
                      className="text-[10px] py-0 px-1.5 gap-1"
                      title={c.colori_prix_kg != null && c.colori_prix_kg > 0
                        ? `${c.colori_prix_kg} €/kg`
                        : undefined}
                    >
                      <Palette className="h-2.5 w-2.5" />
                      {c.colori_reference}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
        </CardContent>}
      </Card>

      {/* Commandes */}
      <Card className="card-premium">
        <CardHeader className="flex flex-row items-center gap-2 p-4 space-y-0 cursor-pointer select-none" onClick={() => setCommandesOpen(!commandesOpen)}>
          <ShoppingCart className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Commandes</CardTitle>
          <Badge variant="secondary" className="text-xs ml-auto">{fournisseur.commandes?.length ?? 0}</Badge>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', commandesOpen && 'rotate-180')} />
        </CardHeader>
        {commandesOpen && <CardContent className="space-y-2">
          {!fournisseur.commandes || fournisseur.commandes.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Aucune commande</p>
          ) : fournisseur.commandes.map((cmd) => {
            const borderColor = cmd.etat === 1 ? 'border-l-amber-400/60' : cmd.etat === 2 ? 'border-l-green-500/60' : 'border-l-border'
            const iconBg = cmd.etat === 1 ? 'bg-amber-400/10' : cmd.etat === 2 ? 'bg-green-500/10' : 'bg-muted'
            const iconColor = cmd.etat === 1 ? 'text-amber-600' : cmd.etat === 2 ? 'text-green-600' : 'text-muted-foreground'
            const totalKg = cmd.lignes.reduce((sum, l) => sum + (l.quantite != null ? Number(l.quantite) : 0), 0)
            const totalPrice = cmd.lignes.reduce((sum, l) => sum + (l.quantite != null && l.prix_unitaire != null ? Number(l.quantite) * Number(l.prix_unitaire) : 0), 0)
            return (
              <div key={cmd.IDcommande_fil} className={cn('group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3', borderColor)}>
                {/* Top row: icon + order number + summary */}
                <div className="flex items-center gap-2">
                  <div className={cn('h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0', iconBg)}>
                    <ShoppingCart className={cn('h-3.5 w-3.5', iconColor)} />
                  </div>
                  <p className="text-sm font-medium">N° {cmd.IDcommande_fil}</p>
                  <div className="flex items-center gap-2 ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                    {cmd.date_commande && <span>{formatHfsqlDate(cmd.date_commande)}</span>}
                    {totalKg > 0 && <span className="px-1.5 py-0.5 rounded bg-zinc-200/80">{totalKg.toFixed(1)} kg</span>}
                    {totalPrice > 0 && <span className="px-1.5 py-0.5 rounded bg-accent/10 font-medium text-foreground">{totalPrice.toFixed(2)} €</span>}
                  </div>
                </div>
                {/* Order lines */}
                {cmd.lignes.length > 0 && (
                  <div className="mt-2 space-y-1 ml-9">
                    {cmd.lignes.map((l) => (
                      <div key={l.IDref_fil_commande} className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span className="truncate max-w-[220px]">
                          {l.ref_fil || '—'}
                          {l.colori_reference ? ` / ${l.colori_reference}` : ''}
                        </span>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          {l.quantite != null && <span>{Number(l.quantite).toFixed(1)} kg</span>}
                          {l.prix_unitaire != null && Number(l.prix_unitaire) > 0 && <span>{Number(l.prix_unitaire).toFixed(2)} €/kg</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {cmd.commentaire?.trim() && (
                  <div className="flex items-start gap-1.5 mt-2 ml-9">
                    <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
                    <p className="text-[11px] text-muted-foreground italic">{cmd.commentaire.trim()}</p>
                  </div>
                )}
              </div>
            )
          })}
        </CardContent>}
      </Card>
    </div>
  )
}

// ── Certificate Dialogs ───────────────────────────────

function CertificatViewDialog({ cert, onClose }: { cert: Certificat | null; onClose: () => void }) {
  const [fichierOk, setFichierOk] = useState<boolean | null>(null)

  useEffect(() => {
    if (!cert) { setFichierOk(null); return }
    setFichierOk(null)
    fetch(`${API_URL}/fournisseurs/certificats/${cert.IDcertificat}/fichier`, { method: 'HEAD' })
      .then(r => setFichierOk(r.ok))
      .catch(() => setFichierOk(false))
  }, [cert?.IDcertificat])

  if (!cert) return null

  return (
    <Dialog open={!!cert} onOpenChange={() => onClose()}>
      {fichierOk ? (
        <div className="relative z-50 w-[60vw] max-w-3xl h-[95vh]" onClick={(e) => e.stopPropagation()}>
          <iframe
            src={`${API_URL}/fournisseurs/certificats/${cert.IDcertificat}/fichier#view=FitH`}
            className="w-full h-full rounded-lg"
            title="Document"
          />
        </div>
      ) : (
        <DialogContent className="max-w-sm" onClose={onClose}>
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <div className="text-center space-y-2">
              <FileText className="h-12 w-12 mx-auto opacity-30" />
              <p className="text-sm">{fichierOk === null ? 'Chargement...' : 'Aucun document attaché'}</p>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}

function CertificatEditDialog({ cert, onClose, fournisseurId, onSuccess, isNew }: {
  cert: Certificat | null; onClose: () => void; fournisseurId: number; onSuccess: () => void; isNew?: boolean
}) {
  const [nom, setNom] = useState('')
  const [numeroRef, setNumeroRef] = useState('')
  const [debutValidite, setDebutValidite] = useState('')
  const [dateExpiration, setDateExpiration] = useState('')
  const [idTypeDoc, setIdTypeDoc] = useState<number>(0)
  const [newFile, setNewFile] = useState<File | null>(null)
  const [newFileUrl, setNewFileUrl] = useState<string | null>(null)
  const [removeFichier, setRemoveFichier] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  const { data: typeDocs } = useQuery<TypeDoc[]>({
    queryKey: ['types-doc'],
    queryFn: () => apiFetch('/fournisseurs/type-doc'),
  })

  // Reset form when cert changes
  useEffect(() => {
    if (cert) {
      setNom(cert.nom ?? '')
      setNumeroRef(cert.numero_ref ?? '')
      setDebutValidite(hfsqlDateToInput(cert.debut_validite))
      setDateExpiration(hfsqlDateToInput(cert.date_expiration))
      setIdTypeDoc(cert.IDtype_doc ?? 0)
      if (newFileUrl) URL.revokeObjectURL(newFileUrl)
      setNewFile(null)
      setNewFileUrl(null)
      setRemoveFichier(false)
    }
  }, [cert])

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const formData = new FormData()
      formData.append('nom', nom)
      formData.append('numero_ref', numeroRef)
      formData.append('debut_validite', inputDateToHfsql(debutValidite))
      formData.append('date_expiration', inputDateToHfsql(dateExpiration))
      formData.append('IDtype_doc', String(idTypeDoc))
      if (removeFichier && !newFile) formData.append('remove_fichier', '1')
      if (newFile) formData.append('fichier', newFile)

      const url = isNew
        ? `${API_URL}/fournisseurs/${fournisseurId}/certificats`
        : `${API_URL}/fournisseurs/certificats/${cert!.IDcertificat}`

      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PUT',
        body: formData,
      })
      if (!res.ok) throw new Error('Erreur API')
      onSuccess()
      onClose()
    } catch (err) {
      console.error('Error saving certificat:', err)
    } finally {
      setIsSaving(false)
    }
  }

  if (!cert) return null

  const hasFichier = cert.has_fichier && !removeFichier

  return (
    <Dialog open={!!cert} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-5xl h-[85vh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-accent" />
            {isNew ? 'Nouveau certificat' : 'Modifier le certificat'}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 flex gap-4">
          {/* Left: Form fields */}
          <div className="w-80 flex-shrink-0 overflow-y-auto space-y-3 px-1">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Nom</label>
              <input value={nom} onChange={(e) => setNom(e.target.value)} autoFocus
                className={inputClass} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Référence</label>
              <input value={numeroRef} onChange={(e) => setNumeroRef(e.target.value)}
                className={inputClass} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Début validité</label>
              <input type="date" value={debutValidite} onChange={(e) => setDebutValidite(e.target.value)}
                autoComplete="off" data-form-type="other" data-lpignore="true" className={inputClass} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Date expiration</label>
              <input type="date" value={dateExpiration} onChange={(e) => setDateExpiration(e.target.value)}
                autoComplete="off" data-form-type="other" data-lpignore="true" className={inputClass} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Type de document</label>
              <PopoverSelect
                options={(typeDocs ?? [])
                  .filter((t) => t.nom.toLowerCase().includes('cert'))
                  .map((t) => ({ id: t.IDtype_doc, primary: t.nom }))}
                value={idTypeDoc}
                onChange={setIdTypeDoc}
                emptyLabel="— Aucun —"
              />
            </div>
          </div>

          {/* Right: Document viewer + file controls */}
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <div className="flex-1 min-h-0 rounded-lg border border-border/60 bg-zinc-50 overflow-hidden">
              {newFileUrl ? (
                <iframe src={newFileUrl + '#view=FitH'} className="w-full h-full" title="Document" />
              ) : hasFichier && !isNew ? (
                <iframe
                  src={`${API_URL}/fournisseurs/certificats/${cert.IDcertificat}/fichier#view=FitH`}
                  className="w-full h-full"
                  title="Document"
                />
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  <div className="text-center space-y-2">
                    <FileText className="h-12 w-12 mx-auto opacity-30" />
                    <p className="text-sm">{removeFichier ? 'Document supprimé' : 'Aucun document'}</p>
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <label className="cursor-pointer">
                <input type="file" className="hidden" onClick={(e) => { (e.target as HTMLInputElement).value = '' }} onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) {
                    if (newFileUrl) URL.revokeObjectURL(newFileUrl)
                    setNewFile(f)
                    setNewFileUrl(URL.createObjectURL(f))
                    setRemoveFichier(false)
                  }
                }} />
                <span className={cn(inputClass, 'inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/5 w-auto px-3')}>
                  <Upload className="h-3.5 w-3.5" />
                  {newFile ? newFile.name : 'Choisir un fichier'}
                </span>
              </label>
              {newFile && (
                <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => {
                  if (newFileUrl) URL.revokeObjectURL(newFileUrl)
                  setNewFile(null); setNewFileUrl(null); setRemoveFichier(true)
                }}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
              {hasFichier && !newFile && !isNew && (
                <Button variant="ghost" size="sm" className="h-8 px-2 text-destructive hover:text-destructive"
                  onClick={() => setRemoveFichier(true)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
              <div className="flex items-center gap-2 ml-auto">
                <Button variant="outline" onClick={onClose}>Annuler</Button>
                <Button onClick={handleSave} disabled={isSaving}>
                  {isSaving ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Enregistrement...</> : <><Save className="h-3.5 w-3.5 mr-1.5" />Enregistrer</>}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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

type SidebarTab = 'info' | 'contacts' | 'adresses'

function DetailSidebar({ fournisseur, isLoading, isEditing, fournisseurId, onMutationSuccess, editCommentaire, onEditCommentaireChange, onSubFormsDirtyChange }: {
  fournisseur: FournisseurDetail | null; isLoading: boolean; isEditing: boolean; fournisseurId: number; onMutationSuccess: () => void
  editCommentaire: string; onEditCommentaireChange: (v: string) => void
  onSubFormsDirtyChange: (dirty: boolean) => void
}) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('info')
  if (isLoading) return (
    <div className="w-96 flex-shrink-0 bg-muted/30 rounded-xl border p-4 space-y-4">
      <div className="flex gap-2"><div className="h-8 flex-1 bg-muted animate-pulse rounded-md" /><div className="h-8 flex-1 bg-muted animate-pulse rounded-md" /><div className="h-8 flex-1 bg-muted animate-pulse rounded-md" /></div>
      {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
    </div>
  )
  if (!fournisseur) return null

  const tabs: { key: SidebarTab; label: string; icon: React.ElementType }[] = [
    { key: 'info', label: 'Info', icon: Info },
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
        {activeTab === 'info' && <InfoTab fournisseur={fournisseur} isEditing={isEditing} editCommentaire={editCommentaire} onEditCommentaireChange={onEditCommentaireChange} />}
        {activeTab === 'contacts' && <ContactsTab contacts={fournisseur.contacts} isEditing={isEditing} fournisseurId={fournisseurId} onMutationSuccess={onMutationSuccess} onDirtyChange={onSubFormsDirtyChange} />}
        {activeTab === 'adresses' && <AdressesTab adresses={fournisseur.adresses} isEditing={isEditing} fournisseurId={fournisseurId} onMutationSuccess={onMutationSuccess} onDirtyChange={onSubFormsDirtyChange} />}
      </div>
    </div>
  )
}

// ── Sidebar Tab: Info ─────────────────────────────────

function InfoTab({ fournisseur, isEditing, editCommentaire, onEditCommentaireChange }: {
  fournisseur: FournisseurDetail; isEditing: boolean; editCommentaire: string; onEditCommentaireChange: (v: string) => void
}) {
  return (
    <div className="space-y-3">
      {/* Commentaire */}
      <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
        <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" />Commentaire</p>
        {isEditing ? (
          <textarea value={editCommentaire} onChange={(e) => onEditCommentaireChange(e.target.value)} rows={4}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
        ) : fournisseur.commentaire ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{fournisseur.commentaire}</p>
        ) : <p className="text-sm text-muted-foreground italic">Aucun commentaire</p>}
      </div>
    </div>
  )
}

// ── Sidebar Tab: Contacts ──────────────────────────────

const ENVOI_FLAGS = [
  { key: 'envoi_commande' as const, label: 'Commande', icon: ShoppingCart },
  { key: 'envoi_bl' as const, label: 'BL', icon: FileText },
  { key: 'envoi_facture' as const, label: 'Facture', icon: FileText },
  { key: 'envoi_soumission' as const, label: 'Soumission', icon: Send },
]

function ContactsTab({ contacts, isEditing, fournisseurId, onMutationSuccess, onDirtyChange }: {
  contacts: Contact[]; isEditing: boolean; fournisseurId: number; onMutationSuccess: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState({ nom: '', prenom: '', tel: '', mail: '', envoi_bl: false, envoi_facture: false, envoi_commande: false, envoi_soumission: false })
  const [showForm, setShowForm] = useState(false)

  // Surface dirty state to the page-level guard. Keep the callback in a ref
  // so the unmount cleanup always uses the latest reference.
  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange })
  useEffect(() => {
    onDirtyChangeRef.current(showForm || editingId !== null)
  }, [showForm, editingId])
  useEffect(() => () => { onDirtyChangeRef.current(false) }, [])

  const createMut = useMutation({
    mutationFn: () => apiFetch(`/fournisseurs/${fournisseurId}/contacts`, { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => { onMutationSuccess(); resetForm() },
  })
  const updateMut = useMutation({
    mutationFn: (cid: number) => apiFetch(`/fournisseurs/${fournisseurId}/contacts/${cid}`, { method: 'PUT', body: JSON.stringify(form) }),
    onSuccess: () => { onMutationSuccess(); setEditingId(null) },
  })
  const deleteMut = useMutation({
    mutationFn: (cid: number) => apiFetch(`/fournisseurs/${fournisseurId}/contacts/${cid}`, { method: 'DELETE' }),
    onSuccess: onMutationSuccess,
  })

  const resetForm = () => { setForm({ nom: '', prenom: '', tel: '', mail: '', envoi_bl: false, envoi_facture: false, envoi_commande: false, envoi_soumission: false }); setShowForm(false) }

  const startEditContact = (c: Contact) => {
    setEditingId(c.IDcontact)
    setForm({ nom: c.nom ?? '', prenom: c.prenom ?? '', tel: c.tel ?? '', mail: c.mail ?? '', envoi_bl: !!c.envoi_bl, envoi_facture: !!c.envoi_facture, envoi_commande: !!c.envoi_commande, envoi_soumission: !!c.envoi_soumission })
  }

  const contactForm = (
    <>
      <div className="grid grid-cols-2 gap-2">
        <LabeledInput label="Prenom" value={form.prenom} onChange={(v) => setForm({ ...form, prenom: v })} autoFocus />
        <LabeledInput label="Nom" value={form.nom} onChange={(v) => setForm({ ...form, nom: v })} />
      </div>
      <LabeledInput label="Telephone" value={form.tel} onChange={(v) => setForm({ ...form, tel: v })} />
      <LabeledInput label="Email" value={form.mail} onChange={(v) => setForm({ ...form, mail: v })} />
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Envoi documents</label>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {ENVOI_FLAGS.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="checkbox" checked={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
                className="h-3.5 w-3.5 rounded border-input accent-accent" />
              {label}
            </label>
          ))}
        </div>
      </div>
    </>
  )

  if (contacts.length === 0 && !isEditing) return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground"><User className="h-10 w-10 mb-2 opacity-40" /><p className="text-sm">Aucun contact</p></div>
  )

  return (
    <>
      {contacts.map((c) =>
        isEditing && editingId === c.IDcontact ? (
          <InlineForm key={c.IDcontact} title="Modifier le contact" onSave={() => updateMut.mutate(c.IDcontact)} onCancel={() => setEditingId(null)} isSaving={updateMut.isPending}>
            {contactForm}
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
                {/* Envoi flags */}
                {ENVOI_FLAGS.some(({ key }) => !!c[key]) && (
                  <div className="flex gap-1 mt-1.5 flex-wrap">
                    {ENVOI_FLAGS.map(({ key, label }) => !!c[key] && (
                      <Badge key={key} variant="outline" className="text-[10px] py-0 px-1.5">{label}</Badge>
                    ))}
                  </div>
                )}
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
          {contactForm}
        </InlineForm>
      )}
    </>
  )
}

// ── Sidebar Tab: Adresses ──────────────────────────────

function AdressesTab({ adresses, isEditing, fournisseurId, onMutationSuccess, onDirtyChange }: {
  adresses: Adresse[]; isEditing: boolean; fournisseurId: number; onMutationSuccess: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState({ nom: '', adresse1: '', adresse2: '', adresse3: '', cp: '', ville: '', pays: '', commentaire: '', est_defaut_facturation: false, est_defaut_livraison: false })
  const [showForm, setShowForm] = useState(false)

  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange })
  useEffect(() => {
    onDirtyChangeRef.current(showForm || editingId !== null)
  }, [showForm, editingId])
  useEffect(() => () => { onDirtyChangeRef.current(false) }, [])

  const createMut = useMutation({
    mutationFn: () => apiFetch(`/fournisseurs/${fournisseurId}/adresses`, { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => { onMutationSuccess(); resetForm() },
  })
  const updateMut = useMutation({
    mutationFn: (aid: number) => apiFetch(`/fournisseurs/${fournisseurId}/adresses/${aid}`, { method: 'PUT', body: JSON.stringify(form) }),
    onSuccess: () => { onMutationSuccess(); setEditingId(null) },
  })
  const deleteMut = useMutation({
    mutationFn: (aid: number) => apiFetch(`/fournisseurs/${fournisseurId}/adresses/${aid}`, { method: 'DELETE' }),
    onSuccess: onMutationSuccess,
  })

  const resetForm = () => { setForm({ nom: '', adresse1: '', adresse2: '', adresse3: '', cp: '', ville: '', pays: '', commentaire: '', est_defaut_facturation: false, est_defaut_livraison: false }); setShowForm(false) }

  const startEditAddr = (a: Adresse) => {
    setEditingId(a.IDadresse)
    setForm({ nom: a.nom ?? '', adresse1: a.adresse1 ?? '', adresse2: a.adresse2 ?? '', adresse3: a.adresse3 ?? '', cp: a.cp ?? '', ville: a.ville ?? '', pays: a.pays ?? '', commentaire: a.commentaire ?? '', est_defaut_facturation: !!a.est_defaut_facturation, est_defaut_livraison: !!a.est_defaut_livraison })
  }

  const adresseForm = (
    <>
      <LabeledInput label="Libelle" value={form.nom} onChange={(v) => setForm({ ...form, nom: v })} autoFocus />
      <LabeledInput label="Adresse 1" value={form.adresse1} onChange={(v) => setForm({ ...form, adresse1: v })} />
      <LabeledInput label="Adresse 2" value={form.adresse2} onChange={(v) => setForm({ ...form, adresse2: v })} />
      <LabeledInput label="Adresse 3" value={form.adresse3} onChange={(v) => setForm({ ...form, adresse3: v })} />
      <div className="grid grid-cols-3 gap-2">
        <LabeledInput label="CP" value={form.cp} onChange={(v) => setForm({ ...form, cp: v })} />
        <div className="col-span-2"><LabeledInput label="Ville" value={form.ville} onChange={(v) => setForm({ ...form, ville: v })} /></div>
      </div>
      <LabeledInput label="Pays" value={form.pays} onChange={(v) => setForm({ ...form, pays: v })} />
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Type d'adresse</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="checkbox" checked={form.est_defaut_facturation} onChange={(e) => setForm({ ...form, est_defaut_facturation: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-input accent-accent" />
            Facturation
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="checkbox" checked={form.est_defaut_livraison} onChange={(e) => setForm({ ...form, est_defaut_livraison: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-input accent-accent" />
            Livraison
          </label>
        </div>
      </div>
    </>
  )

  if (adresses.length === 0 && !isEditing) return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground"><MapPin className="h-10 w-10 mb-2 opacity-40" /><p className="text-sm">Aucune adresse</p></div>
  )

  return (
    <>
      {adresses.map((a) =>
        isEditing && editingId === a.IDadresse ? (
          <InlineForm key={a.IDadresse} title="Modifier l'adresse" onSave={() => updateMut.mutate(a.IDadresse)} onCancel={() => setEditingId(null)} isSaving={updateMut.isPending}>
            {adresseForm}
          </InlineForm>
        ) : (
          <div key={a.IDadresse} className="p-3 rounded-lg border bg-card shadow-sm group relative">
            <div className="flex items-start justify-between">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm flex items-center gap-2">
                  {a.nom || 'Adresse'}
                  {!!a.est_defaut && <Badge variant="secondary" className="text-[10px] py-0"><Star className="h-2.5 w-2.5 mr-0.5" />Principale</Badge>}
                </div>
                {/* Address type badges */}
                {(!!a.est_defaut_facturation || !!a.est_defaut_livraison) && (
                  <div className="flex gap-1 mt-0.5">
                    {!!a.est_defaut_facturation && <Badge variant="outline" className="text-[10px] py-0 px-1.5">Facturation</Badge>}
                    {!!a.est_defaut_livraison && <Badge variant="outline" className="text-[10px] py-0 px-1.5">Livraison</Badge>}
                  </div>
                )}
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
          {adresseForm}
        </InlineForm>
      )}
    </>
  )
}
