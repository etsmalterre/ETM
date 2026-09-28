// RH › Employés — who works here: identity, photo, hire date, birthday.
// Fiche layout (mps_designer §4). Vincent and Isabelle only, behind the code
// RH (components/rh/RhGate.tsx, apps/api/src/lib/rh-acces.ts). Data in the
// PostgreSQL database `rh` (apps/api/src/lib/rh-store.ts), never in HFSQL.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  CalendarDays,
  Cake,
  IdCard,
  ImageIcon,
  Loader2,
  Mail,
  Pencil,
  Save,
  Trash2,
  User,
  X,
} from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SearchableCombobox } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { RhGate } from '@/components/rh/RhGate'
import { EmployeList, filtrerEmployes, useEmployeSelection, useEmployes } from '@/components/rh/EmployeList'
import { SuiviCard } from '@/components/rh/SuiviCard'
import { apiFetch, API_URL } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  age,
  fmtHeures,
  formatAnciennete,
  formatDateFr,
  initiales,
  joursAvantAnniversaire,
  nomComplet,
  photoUrl,
  type Employe,
} from '@/lib/rh'

const inputClass = 'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'
const MAX_PHOTO_BYTES = 10 * 1024 * 1024

interface Draft {
  prenom: string
  nom: string
  poste: string
  email: string
  dateEmbauche: string
  dateNaissance: string
  idutilisateur: number
  heuresContrat: string
}

function draftDe(e: Employe): Draft {
  return {
    prenom: e.prenom,
    nom: e.nom,
    poste: e.poste,
    email: e.email,
    dateEmbauche: e.dateEmbauche ?? '',
    dateNaissance: e.dateNaissance ?? '',
    idutilisateur: e.idutilisateur ?? 0,
    heuresContrat: String(e.heuresContrat).replace('.', ','),
  }
}

interface UtilisateurErp {
  IDutilisateur: number
  prenom: string | null
  nom: string | null
}

export function RhEmployes() {
  return (
    <RhGate>
      <RhEmployesScreen />
    </RhGate>
  )
}

function RhEmployesScreen() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useEmployeSelection()
  const [searchQuery, setSearchQuery] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const originalRef = useRef<Draft | null>(null)

  const { data: employes, isLoading, isError } = useEmployes()
  const filtered = useMemo(() => filtrerEmployes(employes, searchQuery), [employes, searchQuery])

  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (e) => e.id,
    select: setSelectedId,
    // Suspended while the list loads, or the remembered selection is dropped.
    suspended: isEditing || autoEditForId !== null || isLoading,
  })

  const { data: detail, isLoading: detailLoading } = useQuery<Employe>({
    queryKey: ['rh', 'employe', selectedId],
    queryFn: () => apiFetch(`/rh/employes/${selectedId}`),
    enabled: selectedId !== null,
    retry: false,
  })

  const startEdit = useCallback(() => {
    if (!detail) return
    const d = draftDe(detail)
    originalRef.current = d
    setDraft(d)
    setSaveError(null)
    setIsEditing(true)
  }, [detail])

  useEffect(() => {
    if (autoEditForId !== null && detail?.id === autoEditForId) {
      startEdit()
      setAutoEditForId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditForId, detail])

  const isDirty = useMemo(() => {
    if (!isEditing || !draft || !originalRef.current) return false
    return JSON.stringify(draft) !== JSON.stringify(originalRef.current)
  }, [isEditing, draft])

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['rh', 'employes'] })
    queryClient.invalidateQueries({ queryKey: ['rh', 'employe', selectedId] })
  }, [queryClient, selectedId])

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error('no draft')
      const heures = Number(draft.heuresContrat.replace(',', '.'))
      return apiFetch(`/rh/employes/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify({
          prenom: draft.prenom.trim(),
          nom: draft.nom.trim(),
          poste: draft.poste.trim(),
          email: draft.email.trim(),
          dateEmbauche: draft.dateEmbauche || null,
          dateNaissance: draft.dateNaissance || null,
          idutilisateur: draft.idutilisateur > 0 ? draft.idutilisateur : null,
          heuresContrat: heures,
        }),
      })
    },
    onSuccess: () => { invalidate(); setIsEditing(false) },
    onError: (err: Error & { body?: { issues?: Array<{ path: string[] }> } }) => {
      const champ = err.body?.issues?.[0]?.path?.[0]
      const libelles: Record<string, string> = {
        prenom: 'Le prénom est obligatoire.',
        email: 'L’adresse email n’est pas valide.',
        heuresContrat: 'Les heures du contrat doivent être un nombre entre 1 et 60.',
      }
      setSaveError((champ && libelles[champ]) || 'L’enregistrement a échoué.')
    },
  })

  const createMutation = useMutation({
    mutationFn: () => apiFetch<{ id: number }>('/rh/employes', { method: 'POST', body: JSON.stringify({ prenom: 'Nouvel employé', nom: '' }) }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['rh', 'employes'] })
      setSelectedId(data.id)
      setAutoEditForId(data.id)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/rh/employes/${id}`, { method: 'DELETE' }),
    onSuccess: (_d, deletedId) => {
      const cached = queryClient.getQueryData<Employe[]>(['rh', 'employes']) ?? []
      const remaining = filtrerEmployes(cached, searchQuery).filter((e) => e.id !== deletedId)
      queryClient.invalidateQueries({ queryKey: ['rh', 'employes'] })
      setConfirmDelete(false)
      setSelectedId(remaining[0]?.id ?? null)
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
  }, [guard, setSelectedId])

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d))

  return (
    <>
      <MasterDetailLayout
        list={
          <EmployeList
            employes={filtered}
            isLoading={isLoading}
            isError={isError}
            selectedId={selectedId}
            onSelect={handleSelect}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onNew={() => createMutation.mutate()}
            isCreating={createMutation.isPending}
            isEditing={isEditing}
          />
        }
        detailHeader={
          <DetailHeader
            employe={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            isEditing={isEditing}
            draft={draft}
            onDraft={set}
            onStartEdit={startEdit}
            onCancel={() => setIsEditing(false)}
            onSave={() => { setSaveError(null); saveMutation.mutate() }}
            isSaving={saveMutation.isPending}
            onDelete={() => setConfirmDelete(true)}
          />
        }
        detail={
          <DetailMain
            employe={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            hasSelection={selectedId !== null}
            isEditing={isEditing}
            draft={draft}
            onDraft={set}
            saveError={saveError}
            onPhotoChanged={invalidate}
          />
        }
        sidebar={null}
        hasSelection={selectedId !== null}
        onBack={() => guard.guardAction(() => { setIsEditing(false); setSelectedId(null) })}
      />

      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />

      <ConfirmDialog
        open={confirmDelete}
        title="Supprimer l’employé"
        description={detail ? `La fiche de ${nomComplet(detail)}, sa photo et tous ses relevés de charge seront supprimés. Cette action est irréversible.` : undefined}
        isPending={deleteMutation.isPending}
        error={deleteMutation.error ? ((deleteMutation.error as Error & { body?: { message?: string } }).body?.message ?? 'La suppression a échoué.') : null}
        onCancel={() => { setConfirmDelete(false); deleteMutation.reset() }}
        onConfirm={() => {
          if (selectedId === null) return
          setIsEditing(false)
          deleteMutation.mutate(selectedId)
        }}
      />
    </>
  )
}

// ── Header ─────────────────────────────────────────────

function DetailHeader({ employe, isLoading, isEditing, draft, onDraft, onStartEdit, onCancel, onSave, isSaving, onDelete }: {
  employe: Employe | null
  isLoading: boolean
  isEditing: boolean
  draft: Draft | null
  onDraft: <K extends keyof Draft>(k: K, v: Draft[K]) => void
  onStartEdit: () => void
  onCancel: () => void
  onSave: () => void
  isSaving: boolean
  onDelete: () => void
}) {
  if (!employe && !isLoading) return null
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        {employe && !isEditing ? (
          <Avatar className="h-11 w-11 rounded-lg text-sm" src={photoUrl(employe)} alt={nomComplet(employe)} fallback={initiales(employe)} />
        ) : (
          <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center', isEditing ? 'bg-accent/15' : 'icon-box-gold')}>
            <IdCard className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="h-8 w-48 bg-muted animate-pulse rounded" />
          ) : isEditing && draft ? (
            <div className="flex items-center gap-2 flex-wrap">
              <input
                value={draft.prenom}
                onChange={(e) => onDraft('prenom', e.target.value)}
                placeholder="Prénom"
                autoFocus
                className="flex-1 min-w-[8rem] text-xl font-heading font-bold h-10 px-3 rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                value={draft.nom}
                onChange={(e) => onDraft('nom', e.target.value)}
                placeholder="Nom"
                className="flex-1 min-w-[8rem] text-xl font-heading font-bold h-10 px-3 rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <Badge className="bg-accent text-accent-foreground flex-shrink-0 gap-1 shadow-sm">
                <Pencil className="h-3 w-3" />Mode edition
              </Badge>
            </div>
          ) : employe ? (
            <>
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">{nomComplet(employe)}</h1>
              {employe.poste && (
                <div className="flex gap-1.5 mt-1 flex-wrap">
                  <Badge variant="secondary" className="text-xs">{employe.poste}</Badge>
                </div>
              )}
            </>
          ) : null}
        </div>
        {!isLoading && employe && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {isEditing ? (
              <>
                <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive hover:text-destructive" title="Supprimer l’employé" onClick={onDelete}>
                  <Trash2 className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={onCancel}><X className="h-3.5 w-3.5 mr-1.5" />Annuler</Button>
                <Button size="sm" onClick={onSave} disabled={isSaving || !draft?.prenom.trim()}>
                  {isSaving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                  Enregistrer
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

// ── Body ───────────────────────────────────────────────

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs text-muted-foreground flex-shrink-0">{label}</span>
      <span className="text-sm text-right min-w-0 truncate">{children}</span>
    </div>
  )
}

const vide = <span className="text-muted-foreground italic">Non renseigné</span>

function DetailMain({ employe, isLoading, hasSelection, isEditing, draft, onDraft, saveError, onPhotoChanged }: {
  employe: Employe | null
  isLoading: boolean
  hasSelection: boolean
  isEditing: boolean
  draft: Draft | null
  onDraft: <K extends keyof Draft>(k: K, v: Draft[K]) => void
  saveError: string | null
  onPhotoChanged: () => void
}) {
  const { data: utilisateurs } = useQuery<UtilisateurErp[]>({
    queryKey: ['auth-users'],
    queryFn: () => apiFetch('/auth/users'),
    staleTime: 5 * 60_000,
  })

  if (!hasSelection) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="icon-box-gold h-16 w-16 mx-auto"><IdCard className="h-8 w-8" /></div>
          <p className="text-muted-foreground text-sm">Sélectionnez un employé dans la liste</p>
        </div>
      </div>
    )
  }
  if (isLoading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
  if (!employe) return null

  const compte = utilisateurs?.find((u) => u.IDutilisateur === employe.idutilisateur)
  const edit = isEditing && draft
  const anniv = joursAvantAnniversaire(employe.dateNaissance)

  return (
    <div className="flex-1 min-h-0 overflow-auto space-y-4 pb-1">
      {saveError && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />{saveError}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Identité */}
        <Card className={cn('card-premium', isEditing && editSectionClass)}>
          <CardHeader className="flex flex-row items-center gap-2 pb-2 space-y-0">
            <User className="h-4 w-4 text-accent" />
            <CardTitle className="text-sm font-semibold">Identité</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <PhotoBlock employe={employe} isEditing={isEditing} onChanged={onPhotoChanged} />
            {edit ? (
              <div className="space-y-2">
                <Field label="Poste">
                  <input className={inputClass} value={draft.poste} onChange={(e) => onDraft('poste', e.target.value)} placeholder="Ex. Accueil et expéditions" />
                </Field>
                <Field label="Email">
                  <input className={inputClass} type="email" value={draft.email} onChange={(e) => onDraft('email', e.target.value)} placeholder="prenom@etsmalterre.com" />
                </Field>
                <Field label="Compte ETM">
                  <SearchableCombobox
                    options={utilisateurs ?? []}
                    value={draft.idutilisateur}
                    onChange={(id) => onDraft('idutilisateur', id)}
                    getId={(u) => u.IDutilisateur}
                    getPrimary={(u) => [u.prenom, u.nom].filter(Boolean).join(' ')}
                    placeholder="Aucun — rechercher un utilisateur"
                  />
                </Field>
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                <KV label="Poste">{employe.poste || vide}</KV>
                <KV label="Email">
                  {employe.email ? (
                    <a href={`mailto:${employe.email}`} className="text-accent-blue hover:underline inline-flex items-center gap-1">
                      <Mail className="h-3 w-3" />{employe.email}
                    </a>
                  ) : vide}
                </KV>
                <KV label="Compte ETM">{compte ? [compte.prenom, compte.nom].filter(Boolean).join(' ') : vide}</KV>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Dates */}
        <Card className={cn('card-premium', isEditing && editSectionClass)}>
          <CardHeader className="flex flex-row items-center gap-2 pb-2 space-y-0">
            <CalendarDays className="h-4 w-4 text-accent" />
            <CardTitle className="text-sm font-semibold">Contrat et dates</CardTitle>
          </CardHeader>
          <CardContent>
            {edit ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Field label="Date d’embauche">
                  <input className={inputClass} type="date" value={draft.dateEmbauche} onChange={(e) => onDraft('dateEmbauche', e.target.value)} />
                </Field>
                <Field label="Date de naissance">
                  <input className={inputClass} type="date" value={draft.dateNaissance} onChange={(e) => onDraft('dateNaissance', e.target.value)} />
                </Field>
                <Field label="Heures par semaine (contrat)">
                  <input className={inputClass} inputMode="decimal" value={draft.heuresContrat} onChange={(e) => onDraft('heuresContrat', e.target.value)} />
                </Field>
              </div>
            ) : (
              <div className="space-y-3">
                <DateTile
                  icon={<CalendarDays className="h-4 w-4" />}
                  label="Dans l’entreprise depuis"
                  value={employe.dateEmbauche ? formatAnciennete(employe.dateEmbauche) : null}
                  detail={employe.dateEmbauche ? `Embauche le ${formatDateFr(employe.dateEmbauche)}` : 'Date d’embauche non renseignée'}
                />
                <DateTile
                  icon={<Cake className="h-4 w-4" />}
                  label="Anniversaire"
                  value={employe.dateNaissance ? `${age(employe.dateNaissance)} ans` : null}
                  detail={
                    employe.dateNaissance
                      ? `Né(e) le ${formatDateFr(employe.dateNaissance)} — ${anniv === 0 ? 'c’est aujourd’hui !' : `dans ${anniv} jour${anniv === 1 ? '' : 's'}`}`
                      : 'Date de naissance non renseignée'
                  }
                  highlight={anniv !== null && anniv <= 7}
                />
                <div className="divide-y divide-border/50">
                  <KV label="Contrat">{fmtHeures(employe.heuresContrat)} par semaine</KV>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {!isEditing && <SuiviCard employeId={employe.id} />}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

function DateTile({ icon, label, value, detail, highlight }: {
  icon: React.ReactNode
  label: string
  value: string | null
  detail: string
  highlight?: boolean
}) {
  return (
    <div className={cn('rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3', highlight ? 'border-l-accent' : 'border-l-amber-400/60')}>
      <div className="flex items-center gap-2">
        <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10 text-amber-600">{icon}</div>
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground">{label}</p>
          <p className={cn('text-base font-semibold', !value && 'text-muted-foreground italic font-normal text-sm')}>{value ?? 'Non renseigné'}</p>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground mt-1.5 ml-9">{detail}</p>
    </div>
  )
}

function PhotoBlock({ employe, isEditing, onChanged }: { employe: Employe; isEditing: boolean; onChanged: () => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData()
      fd.append('photo', file)
      const res = await fetch(`${API_URL}/rh/employes/${employe.id}/photo`, { method: 'PUT', body: fd, credentials: 'include' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.message ?? `Erreur HTTP ${res.status}`)
      }
      return res.json()
    },
    onSuccess: onChanged,
    onError: (err) => setErreur(err instanceof Error ? err.message : 'Erreur'),
  })
  const remove = useMutation({
    mutationFn: () => apiFetch(`/rh/employes/${employe.id}/photo`, { method: 'DELETE' }),
    onSuccess: onChanged,
  })

  return (
    <div className="flex items-center gap-4">
      <Avatar className="h-24 w-24 rounded-xl text-2xl shadow-sm" src={photoUrl(employe)} alt={nomComplet(employe)} fallback={initiales(employe)} />
      {isEditing ? (
        <div className="space-y-1.5">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onClick={(e) => { (e.target as HTMLInputElement).value = '' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (!f) return
              setErreur(null)
              if (f.size > MAX_PHOTO_BYTES) { setErreur('L’image dépasse 10 Mo.'); return }
              upload.mutate(f)
            }}
          />
          <Button variant="outline" size="sm" disabled={upload.isPending} onClick={() => fileRef.current?.click()}>
            {upload.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <ImageIcon className="h-3.5 w-3.5 mr-1.5" />}
            {employe.photoMaj ? 'Changer la photo…' : 'Choisir une photo…'}
          </Button>
          {employe.photoMaj && (
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />Supprimer la photo
            </Button>
          )}
          {erreur && <p className="text-xs text-destructive flex items-center gap-1"><AlertCircle className="h-3 w-3" />{erreur}</p>}
          <p className="text-[11px] text-muted-foreground">Enregistrée tout de suite, recadrée en carré.</p>
        </div>
      ) : !employe.photoMaj ? (
        <p className="text-xs text-muted-foreground italic">Pas encore de photo — « Modifier » pour en ajouter une.</p>
      ) : null}
    </div>
  )
}
