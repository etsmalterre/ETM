// RH › Charge de travail — where an employee's week goes, what can be
// automated, and how it moves month after month. One screen, three cards:
// the week (one bar), the tasks (one figure each, sorted), the monthly curve.
//
// Deliberately simple (Vincent, 2026-09-25: « sans que ce soit l'usine à gaz »):
// one figure per task (a measured task shows its current measure, with the
// formula written out), three automation states, « non attribué » = what is
// left of the contract. « Modifier » edits the tasks; every save is kept as a
// dated relevé behind « Historique ». Rules: apps/api/src/lib/rh-charge.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Bot,
  ChartColumnStacked,
  CheckCircle2,
  ChevronDown,
  History,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  Save,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { RhGate } from '@/components/rh/RhGate'
import { EmployeList, filtrerEmployes, useEmployeSelection, useEmployes } from '@/components/rh/EmployeList'
import { ChargeCourbe } from '@/components/rh/ChargeCourbe'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  COULEURS,
  etatAuto,
  fmtDuree,
  fmtHeures,
  fmtMinutes,
  fmtVolume,
  formatDateFr,
  initiales,
  kpiTache,
  pluriel,
  noteDe,
  nomComplet,
  photoUrl,
  todayIso,
  type ChargeResponse,
  type Employe,
  type EtatAuto,
  type EvolutionResponse,
  type Indicateur,
  type KpiTache,
  type TacheActuelle,
  type TacheCharge,
  type TotauxCharge,
} from '@/lib/rh'

const inputClass = 'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

/** How a row counts its time: hours typed (forfait), or minutes per unit ×
 *  a weekly volume — measured in ETM (etm) or typed (estime). */
type ModeLigne = 'forfait' | 'etm' | 'estime'

/** One row of the editor: the same three figures on every row — minutes per
 *  unit × units per week — or hours for a forfait, an automation state, a note. */
interface LigneDraft {
  uid: number
  base: TacheCharge
  nom: string
  /** Hours per week on a forfait, minutes per unit otherwise. */
  valeur: string
  mode: ModeLigne
  /** mode etm: the indicator key */
  indicateur: string
  /** mode estime: the unit, singular, and the units per week */
  uniteLibre: string
  volume: string
  etat: EtatAuto
  note: string
}

let nextUid = 1

const enTexte = (n: number) => String(n).replace('.', ',')

function versDraft(t: TacheActuelle): LigneDraft {
  const mode: ModeLigne = t.indicateur && t.minutesParUnite ? 'etm' : t.minutesParUnite && t.volumeSaisi != null ? 'estime' : 'forfait'
  return {
    uid: nextUid++,
    base: t,
    nom: t.nom,
    valeur: enTexte(mode === 'forfait' ? round1(t.heuresActuelles) : t.minutesParUnite!),
    mode,
    indicateur: mode === 'etm' ? t.indicateur! : '',
    uniteLibre: mode === 'estime' ? t.unite : '',
    volume: mode === 'estime' ? enTexte(t.volumeSaisi!) : '',
    etat: etatAuto(t),
    note: noteDe(t),
  }
}

const nombre = (s: string) => Number(s.replace(',', '.')) || 0
const round1 = (h: number) => Math.round(h * 10) / 10
const round2 = (h: number) => Math.round(h * 100) / 100

/** Current weekly volume per indicator, read off the measured tasks on screen. */
function volumesDe(taches: TacheActuelle[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of taches) if (t.indicateur && t.volumeHebdo != null) m.set(t.indicateur, t.volumeHebdo)
  return m
}

function versTache(l: LigneDraft, volumes: Map<string, number>): TacheCharge {
  const minutes = nombre(l.valeur)
  let heures = nombre(l.valeur)
  if (l.mode === 'etm') {
    // A measured task keeps, as its relevé value, the hours it measures today.
    const vol = volumes.get(l.indicateur)
    heures = vol != null ? round2((minutes * vol) / 60) : l.base.heures
  } else if (l.mode === 'estime') {
    heures = round2((minutes * nombre(l.volume)) / 60)
  }
  return {
    nom: l.nom.trim(),
    description: l.note.trim(),
    methode: '',
    heures,
    categorie: l.base.categorie,
    automatise: l.etat === 'automatise',
    // « — » keeps what the spreadsheet said (partiel / à évaluer / non).
    automatisable: l.etat ? 'oui' : l.base.automatisable === 'oui' ? 'non' : l.base.automatisable,
    indicateur: l.mode === 'etm' ? l.indicateur : null,
    minutesParUnite: l.mode === 'forfait' ? null : minutes,
    volumeSaisi: l.mode === 'estime' ? nombre(l.volume) : null,
    unite: l.mode === 'estime' ? l.uniteLibre.trim() : '',
  }
}

const LIGNE_VIDE: TacheActuelle = {
  nom: '', description: '', methode: '', heures: 0, automatisable: 'inconnu', automatise: false,
  categorie: 'tache', indicateur: null, minutesParUnite: null, volumeSaisi: null, unite: '',
  heuresActuelles: 0, volumeHebdo: null,
}

const PERIODES = [
  { id: 6, primary: '6 derniers mois' },
  { id: 12, primary: '12 derniers mois' },
  { id: 24, primary: '2 ans' },
]

export function RhCharge() {
  return (
    <RhGate>
      <RhChargeScreen />
    </RhGate>
  )
}

function RhChargeScreen() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useEmployeSelection()
  const [searchQuery, setSearchQuery] = useState('')
  const [versionId, setVersionId] = useState<number | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [lignes, setLignes] = useState<LigneDraft[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)
  const [historiqueOpen, setHistoriqueOpen] = useState(false)
  const originalRef = useRef('')

  const { data: employes, isLoading, isError } = useEmployes()
  const filtered = useMemo(() => filtrerEmployes(employes, searchQuery), [employes, searchQuery])
  // Suspended while the list loads, or the remembered selection is dropped.
  useAutoSelectFirst({ rows: filtered, selectedId, getId: (e) => e.id, select: setSelectedId, suspended: isEditing || isLoading })
  const employe = employes?.find((e) => e.id === selectedId) ?? null

  useEffect(() => { setVersionId(null) }, [selectedId])

  const { data: charge, isLoading: chargeLoading } = useQuery<ChargeResponse>({
    queryKey: ['rh', 'charge', selectedId, versionId ?? 'courante'],
    queryFn: () => apiFetch(`/rh/employes/${selectedId}/charge${versionId ? `?version=${versionId}` : ''}`),
    enabled: selectedId !== null,
    retry: false,
  })
  const { data: indicateurs } = useQuery<Indicateur[]>({
    queryKey: ['rh', 'indicateurs'],
    queryFn: () => apiFetch('/rh/indicateurs'),
    staleTime: Infinity,
    retry: false,
  })

  const version = charge?.version ?? null
  const volumes = useMemo(() => volumesDe(version?.taches ?? []), [version])
  const serialise = (ls: LigneDraft[]) => JSON.stringify(ls.map(({ uid: _u, base: _b, ...r }) => r))

  const startEdit = useCallback(() => {
    const ls = (version?.taches ?? []).map(versDraft)
    originalRef.current = serialise(ls)
    setLignes(ls)
    setSaveError(null)
    setIsEditing(true)
  }, [version])

  const isDirty = isEditing && serialise(lignes) !== originalRef.current

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['rh', 'charge', selectedId] })
    queryClient.invalidateQueries({ queryKey: ['rh', 'evolution', selectedId] })
  }, [queryClient, selectedId])

  const saveMutation = useMutation({
    mutationFn: () => {
      const taches = lignes.filter((l) => l.nom.trim()).map((l) => versTache(l, volumes))
      return apiFetch(`/rh/employes/${selectedId}/charge`, {
        method: 'POST',
        body: JSON.stringify({ dateReleve: todayIso(), note: '', taches }),
      })
    },
    onSuccess: () => {
      invalidate()
      setVersionId(null)
      setIsEditing(false)
    },
    onError: (err: Error & { body?: { message?: string } }) => setSaveError(err.body?.message ?? 'L’enregistrement a échoué.'),
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

  const totauxEdition = useMemo(() => {
    const t = { taches: 0, aAutomatiser: 0, automatise: 0 }
    for (const l of lignes) {
      const h = versTache(l, volumes).heures
      t.taches += h
      if (l.etat === 'automatise') t.automatise += h
      else if (l.etat === 'aAutomatiser') t.aAutomatiser += h
    }
    return t
  }, [lignes, volumes])

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
            isEditing={isEditing}
          />
        }
        detailHeader={
          employe && (
            <DetailHeader
              employe={employe}
              version={version}
              isEditing={isEditing}
              onRetour={() => setVersionId(null)}
              onStartEdit={startEdit}
              onCancel={() => setIsEditing(false)}
              onSave={() => { setSaveError(null); saveMutation.mutate() }}
              isSaving={saveMutation.isPending}
            />
          )
        }
        detail={
          selectedId === null ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-3">
                <div className="icon-box-gold h-16 w-16 mx-auto"><ChartColumnStacked className="h-8 w-8" /></div>
                <p className="text-muted-foreground text-sm">Sélectionnez un employé dans la liste</p>
              </div>
            </div>
          ) : chargeLoading || !employe ? (
            <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
          ) : (
            <div className="flex-1 min-h-0 overflow-auto space-y-4 pb-1">
              {saveError && (
                <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />{saveError}
                </div>
              )}
              {isEditing ? (
                <>
                  <SemaineCard totaux={totauxEdition} contrat={employe.heuresContrat} isEditing />
                  <EditeurTaches lignes={lignes} setLignes={setLignes} indicateurs={indicateurs ?? []} volumes={volumes} />
                </>
              ) : version ? (
                <>
                  <SemaineCard totaux={version.totaux} contrat={employe.heuresContrat} />
                  <TachesCard taches={version.taches} indicateurs={indicateurs ?? []} actuelle={version.actuelle} dateReleve={version.dateReleve} />
                  <EvolutionCard employe={employe} nbReleves={charge?.versions.length ?? 0} onHistorique={() => setHistoriqueOpen(true)} />
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <ListChecks className="h-12 w-12 mb-3 opacity-40" />
                  <p className="text-sm">Aucune tâche renseignée</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={startEdit}>
                    <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter une tâche
                  </Button>
                </div>
              )}
            </div>
          )
        }
        sidebar={null}
        hasSelection={selectedId !== null}
        onBack={() => guard.guardAction(() => { setIsEditing(false); setSelectedId(null) })}
      />

      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />

      {selectedId !== null && (
        <HistoriqueDialog
          open={historiqueOpen}
          onClose={() => setHistoriqueOpen(false)}
          employeId={selectedId}
          versions={charge?.versions ?? []}
          onVoir={(id, derniere) => { setVersionId(derniere ? null : id); setHistoriqueOpen(false) }}
          onSupprime={() => { setVersionId(null); invalidate() }}
        />
      )}
    </>
  )
}

// ── Header ─────────────────────────────────────────────

function DetailHeader({ employe, version, isEditing, onRetour, onStartEdit, onCancel, onSave, isSaving }: {
  employe: Employe
  version: ChargeResponse['version']
  isEditing: boolean
  onRetour: () => void
  onStartEdit: () => void
  onCancel: () => void
  onSave: () => void
  isSaving: boolean
}) {
  const historique = !!version && !version.actuelle
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3 flex-wrap">
        <Avatar className="h-11 w-11 rounded-lg text-sm" src={photoUrl(employe)} alt={nomComplet(employe)} fallback={initiales(employe)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-heading font-bold tracking-tight truncate">{nomComplet(employe)}</h1>
            {isEditing && (
              <Badge className="bg-accent text-accent-foreground flex-shrink-0 gap-1 shadow-sm">
                <Pencil className="h-3 w-3" />Mode edition
              </Badge>
            )}
          </div>
          <div className="flex gap-1.5 mt-1 flex-wrap items-center">
            {employe.poste && <Badge variant="secondary" className="text-xs">{employe.poste}</Badge>}
            {historique && (
              <Badge variant="outline" className="text-xs border-amber-500/40 bg-amber-500/10 text-amber-800">
                <History className="h-3 w-3 mr-1" />Charge au {formatDateFr(version.dateReleve)}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isEditing ? (
            <>
              <Button variant="outline" size="sm" onClick={onCancel}><X className="h-3.5 w-3.5 mr-1.5" />Annuler</Button>
              <Button size="sm" onClick={onSave} disabled={isSaving}>
                {isSaving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                Enregistrer
              </Button>
            </>
          ) : historique ? (
            <Button variant="outline" size="sm" onClick={onRetour}><ArrowLeft className="h-3.5 w-3.5 mr-1.5" />Revenir à aujourd’hui</Button>
          ) : (
            <Button variant="gold" size="sm" onClick={onStartEdit}><Pencil className="h-3.5 w-3.5 mr-1.5" />Modifier</Button>
          )}
        </div>
      </div>
      <div className={cn('h-1 w-24 mt-3 rounded-full', isEditing ? 'bg-accent' : 'bg-gradient-to-r from-accent via-accent to-accent/30')} />
    </div>
  )
}

// ── La semaine ─────────────────────────────────────────

function SemaineCard({ totaux, contrat, isEditing }: { totaux: TotauxCharge; contrat: number; isEditing?: boolean }) {
  const reste = contrat - totaux.taches
  const echelle = Math.max(contrat, totaux.taches)
  const autres = Math.max(0, totaux.taches - totaux.aAutomatiser - totaux.automatise)
  const parts = [
    { h: totaux.automatise, color: COULEURS.automatise, label: 'automatisé' },
    { h: totaux.aAutomatiser, color: COULEURS.aAutomatiser, label: 'à automatiser' },
    { h: autres, color: COULEURS.taches, label: 'autres tâches' },
    { h: Math.max(0, reste), color: COULEURS.nonAttribue, label: 'non attribué' },
  ].filter((p) => p.h > 0.01)

  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardContent className="pt-5 space-y-3">
        <p className="text-base">
          <span className="font-semibold tabular-nums">{fmtHeures(round1(totaux.taches))}</span> de tâches identifiées sur {fmtHeures(contrat)}
          {' — '}
          {reste >= 0 ? (
            <><span className="font-semibold tabular-nums">{fmtHeures(round1(reste))}</span> non attribuées</>
          ) : (
            <span className="font-semibold text-destructive">{fmtHeures(round1(-reste))} de dépassement</span>
          )}
        </p>
        <div className="flex h-6 w-full overflow-hidden rounded-md gap-0.5">
          {parts.map((p) => (
            <div
              key={p.label}
              className="h-full first:rounded-l-md last:rounded-r-md"
              style={{ width: `${(p.h / echelle) * 100}%`, background: p.color }}
              title={`${p.label} : ${fmtHeures(round1(p.h))}`}
            />
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          dont <span className="font-semibold" style={{ color: COULEURS.aAutomatiser }}>{fmtHeures(round1(totaux.aAutomatiser))} à automatiser</span>
          {' · '}
          <span className="font-semibold" style={{ color: COULEURS.automatise }}>{fmtHeures(round1(totaux.automatise))} déjà automatisée{totaux.automatise >= 2 ? 's' : ''}</span>
        </p>
      </CardContent>
    </Card>
  )
}

// ── Les tâches (lecture) ───────────────────────────────

function EtatIcone({ etat }: { etat: EtatAuto }) {
  if (etat === 'automatise') return <span title="Automatisé"><CheckCircle2 className="h-4 w-4" style={{ color: COULEURS.automatise }} /></span>
  if (etat === 'aAutomatiser') return <span title="À automatiser"><Bot className="h-4 w-4" style={{ color: COULEURS.aAutomatiser }} /></span>
  return <span className="h-4 w-4" />
}

/** « 10 min × 8 commandes / sem. » — the row's one-line formula. */
function formule(k: KpiTache): string {
  return `${fmtMinutes(k.minutes)} × ${fmtVolume(k.volume)} ${pluriel(k.unite, k.volume)} / sem.`
}

function KpiTuile({ valeur, legende, children, bordure }: {
  valeur: string
  legende: string
  children?: React.ReactNode
  /** Result tile: a left edge in the task's bar colour. */
  bordure?: string
}) {
  return (
    <div
      className={cn('rounded-md border border-border/60 bg-white px-3 py-2 min-w-[7.5rem] shadow-sm', bordure && 'border-l-4')}
      style={bordure ? { borderLeftColor: bordure } : undefined}
    >
      <p className="text-lg font-semibold tabular-nums leading-tight">{valeur}</p>
      <p className="text-[11px] text-muted-foreground">{legende}</p>
      {children}
    </div>
  )
}

const Operateur = ({ children }: { children: string }) => (
  <span className="self-center text-lg text-muted-foreground/70 px-0.5" aria-hidden>{children}</span>
)

/** The pane under a task: its three figures, then what it covers and how it was estimated. */
function DetailTache({ t, kpi, couleur, dateReleve }: { t: TacheActuelle; kpi: KpiTache | null; couleur: string; dateReleve: string }) {
  // A measured task also shows the volume its relevé was typed with, when it differs.
  const volumeReleve = kpi?.source === 'etm' ? (t.heures * 60) / kpi.minutes : null
  const ecart = volumeReleve != null && kpi && Math.abs(volumeReleve - kpi.volume) >= 0.5
  return (
    <div className="mx-2 mb-2 mt-0.5 rounded-md bg-zinc-100/80 border border-border/60 p-3 space-y-3">
      <div className="flex flex-wrap items-stretch gap-2">
        {kpi ? (
          <>
            <KpiTuile valeur={fmtMinutes(kpi.minutes)} legende={`par ${kpi.unite}`} />
            <Operateur>×</Operateur>
            <KpiTuile valeur={`${fmtVolume(kpi.volume)} ${pluriel(kpi.unite, kpi.volume)}`} legende="par semaine">
              {kpi.source === 'etm' ? (
                <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-accent-blue" title="Moyenne des 4 dernières semaines complètes">
                  <Activity className="h-3 w-3" />mesuré dans ETM
                </p>
              ) : (
                <p className="mt-1 text-[11px] italic text-muted-foreground">{kpi.source === 'estime' ? 'estimé' : 'au relevé'}</p>
              )}
              {ecart && (
                <p className="text-[11px] text-muted-foreground">relevé du {formatDateFr(dateReleve)} : {fmtVolume(volumeReleve!)}</p>
              )}
            </KpiTuile>
            <Operateur>=</Operateur>
            <KpiTuile valeur={fmtDuree(kpi.minutesSemaine)} legende="par semaine" bordure={couleur} />
          </>
        ) : (
          <>
            <KpiTuile valeur={fmtDuree(t.heuresActuelles * 60)} legende="par semaine · forfait" bordure={couleur} />
            <p className="self-center text-xs text-muted-foreground max-w-sm">Temps fixe : la tâche n’a pas d’unité que l’on puisse compter.</p>
          </>
        )}
      </div>
      {t.description.trim() ? (
        <p className="text-sm whitespace-pre-line">{t.description.trim()}</p>
      ) : !t.methode.trim() && (
        <p className="text-sm italic text-muted-foreground">Pas de note</p>
      )}
      {t.methode.trim() && (
        <div>
          <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Estimation</p>
          <p className="text-xs text-muted-foreground whitespace-pre-line mt-0.5">{t.methode.trim()}</p>
        </div>
      )}
    </div>
  )
}

function TachesCard({ taches, indicateurs, actuelle, dateReleve }: { taches: TacheActuelle[]; indicateurs: Indicateur[]; actuelle: boolean; dateReleve: string }) {
  const [ouverte, setOuverte] = useState<string | null>(null)
  const triees = useMemo(() => [...taches].sort((a, b) => b.heuresActuelles - a.heuresActuelles), [taches])
  const max = Math.max(...triees.map((t) => t.heuresActuelles), 0.1)

  return (
    <Card className="card-premium">
      <CardHeader className="flex flex-row items-center gap-2 pb-2 space-y-0">
        <ListChecks className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Tâches</CardTitle>
        <span className="ml-auto text-xs text-muted-foreground">temps par semaine</span>
      </CardHeader>
      <CardContent className="space-y-0.5">
        {triees.map((t) => {
          const kpi = kpiTache(t, indicateurs, actuelle)
          const f = kpi ? formule(kpi) : 'forfait'
          const open = ouverte === t.nom
          const etat = etatAuto(t)
          const couleur = etat ? COULEURS[etat] : COULEURS.taches
          return (
            <div key={t.nom}>
              <button
                type="button"
                onClick={() => setOuverte(open ? null : t.nom)}
                className={cn(
                  'w-full grid grid-cols-[minmax(0,12rem)_1fr_4rem_1.25rem] lg:grid-cols-[minmax(0,15rem)_1fr_4.5rem_minmax(0,12rem)_1.25rem] items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors',
                  open ? 'bg-accent/10' : 'hover:bg-accent/5',
                )}
              >
                <span className="text-sm truncate" title={t.nom}>{t.nom}</span>
                <span className="h-2.5 rounded-full bg-zinc-100 overflow-hidden">
                  <span className="block h-full rounded-full" style={{ width: `${(t.heuresActuelles / max) * 100}%`, background: couleur }} />
                </span>
                <span className="text-sm text-right tabular-nums font-medium whitespace-nowrap">{fmtDuree(t.heuresActuelles * 60)}</span>
                <span className={cn('hidden lg:inline-flex items-center gap-1 min-w-0 text-xs text-muted-foreground', !kpi && 'italic')} title={f}>
                  {kpi?.source === 'etm' && <Activity className="h-3 w-3 flex-shrink-0 text-accent-blue" />}
                  <span className="truncate">{f}</span>
                </span>
                <EtatIcone etat={etat} />
              </button>
              {open && <DetailTache t={t} kpi={kpi} couleur={couleur} dateReleve={dateReleve} />}
            </div>
          )
        })}
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 mt-1 border-t border-border/50 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><Bot className="h-3.5 w-3.5" style={{ color: COULEURS.aAutomatiser }} />à automatiser</span>
          <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" style={{ color: COULEURS.automatise }} />automatisé</span>
          <span className="inline-flex items-center gap-1.5"><Activity className="h-3.5 w-3.5 text-accent-blue" />volume mesuré dans ETM (4 dernières semaines) ; sinon estimé</span>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Les tâches (édition) ───────────────────────────────

const ETATS: Array<{ id: number; etat: EtatAuto; primary: string }> = [
  { id: 1, etat: null, primary: '—' },
  { id: 2, etat: 'aAutomatiser', primary: 'À automatiser' },
  { id: 3, etat: 'automatise', primary: 'Automatisé' },
]

const GRILLE_EDITEUR = 'md:grid-cols-[1fr_4.5rem_11rem_5.5rem_4rem_9rem_3.5rem]'

function EditeurTaches({ lignes, setLignes, indicateurs, volumes }: {
  lignes: LigneDraft[]
  setLignes: React.Dispatch<React.SetStateAction<LigneDraft[]>>
  indicateurs: Indicateur[]
  volumes: Map<string, number>
}) {
  const [ouverte, setOuverte] = useState<number | null>(null)
  const patch = (uid: number, p: Partial<LigneDraft>) => setLignes((ls) => ls.map((l) => (l.uid === uid ? { ...l, ...p } : l)))
  // 1 = forfait, 2..n+1 = an ETM indicator, n + 2 = a unit of one's own (volume
  // typed). Never 0: PopoverSelect reads 0 as « nothing selected ».
  const idForfait = 1
  const idAutre = indicateurs.length + 2
  const unites = [
    { id: idForfait, primary: 'h / semaine', description: 'Forfait : la tâche n’a pas d’unité à compter' },
    ...indicateurs.map((i, k) => ({ id: k + 2, primary: `min par ${i.unite}`, description: `${i.label} — volume mesuré dans ETM` })),
    { id: idAutre, primary: 'min par … (autre unité)', description: 'Volume estimé, saisi à la main' },
  ]
  const choisirUnite = (l: LigneDraft, id: number) => {
    if (id === idForfait) patch(l.uid, { mode: 'forfait', indicateur: '' })
    else if (id === idAutre) patch(l.uid, { mode: 'estime', indicateur: '' })
    else patch(l.uid, { mode: 'etm', indicateur: indicateurs[id - 2].cle })
  }
  const numerique = (uid: number, champ: 'valeur' | 'volume') => (e: React.ChangeEvent<HTMLInputElement>) => {
    if (/^\d*[.,]?\d*$/.test(e.target.value)) patch(uid, { [champ]: e.target.value })
  }

  return (
    <Card className={cn('card-premium', editSectionClass)}>
      <CardHeader className="flex flex-row items-center gap-2 pb-2 space-y-0">
        <ListChecks className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Tâches</CardTitle>
        <span className="ml-auto text-xs text-muted-foreground">Enregistrer garde la charge d’avant dans l’historique</span>
      </CardHeader>
      <CardContent className="space-y-1.5">
        <div className={cn('hidden md:grid gap-2 px-1 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold', GRILLE_EDITEUR)}>
          <span>Tâche</span><span className="text-right">Temps</span><span>Unité</span>
          <span className="text-right">Volume / sem.</span><span className="text-right">Charge</span><span>Automatisation</span><span />
        </div>
        {lignes.map((l) => {
          const open = ouverte === l.uid
          const uniteId = l.mode === 'forfait' ? idForfait : l.mode === 'estime' ? idAutre : indicateurs.findIndex((i) => i.cle === l.indicateur) + 2
          const volEtm = l.mode === 'etm' ? volumes.get(l.indicateur) : undefined
          const heures = versTache(l, volumes).heures
          return (
            <div key={l.uid} className="group rounded-md">
              <div className={cn('grid grid-cols-1 gap-2 items-center', GRILLE_EDITEUR)}>
                <input className={inputClass} value={l.nom} placeholder="Nom de la tâche" onChange={(e) => patch(l.uid, { nom: e.target.value })} />
                <input
                  className={cn(inputClass, 'text-right tabular-nums')}
                  inputMode="decimal"
                  value={l.valeur}
                  title={l.mode === 'forfait' ? 'Heures par semaine' : 'Minutes par unité'}
                  onChange={numerique(l.uid, 'valeur')}
                />
                {l.mode === 'estime' ? (
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground flex-shrink-0">min par</span>
                    <input
                      className={inputClass}
                      value={l.uniteLibre}
                      placeholder="appel, lot…"
                      onChange={(e) => patch(l.uid, { uniteLibre: e.target.value })}
                    />
                    <Button variant="ghost" size="icon" className="h-7 w-7 flex-shrink-0" title="Choisir une autre unité" onClick={() => patch(l.uid, { mode: 'forfait' })}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : (
                  <PopoverSelect
                    size="sm"
                    widthClass="w-full"
                    hideEmpty
                    value={uniteId}
                    onChange={(id) => choisirUnite(l, id)}
                    options={unites}
                  />
                )}
                {l.mode === 'estime' ? (
                  <input
                    className={cn(inputClass, 'text-right tabular-nums')}
                    inputMode="decimal"
                    value={l.volume}
                    placeholder="0"
                    title="Unités par semaine (estimation)"
                    onChange={numerique(l.uid, 'volume')}
                  />
                ) : l.mode === 'etm' ? (
                  <span className="inline-flex items-center justify-end gap-1 text-sm tabular-nums text-muted-foreground" title="Mesuré dans ETM : moyenne des 4 dernières semaines">
                    <Activity className="h-3 w-3 text-accent-blue" />{volEtm != null ? fmtVolume(volEtm) : '—'}
                  </span>
                ) : (
                  <span className="text-sm text-right text-muted-foreground">—</span>
                )}
                <span className="text-sm text-right tabular-nums font-medium whitespace-nowrap">{fmtDuree(heures * 60)}</span>
                <PopoverSelect
                  size="sm"
                  widthClass="w-full"
                  hideEmpty
                  value={ETATS.find((e) => e.etat === l.etat)!.id}
                  onChange={(id) => patch(l.uid, { etat: ETATS.find((e) => e.id === id)!.etat })}
                  options={ETATS.map(({ id, primary }) => ({ id, primary }))}
                />
                <div className="flex items-center justify-end gap-0.5">
                  <Button variant="ghost" size="icon" className={cn('h-7 w-7', l.note && 'text-accent')} title={open ? 'Fermer la note' : 'Note'} onClick={() => setOuverte(open ? null : l.uid)}>
                    <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" title="Retirer la tâche" onClick={() => setLignes((ls) => ls.filter((x) => x.uid !== l.uid))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {open && (
                <textarea
                  rows={4}
                  className="mt-1.5 mb-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                  value={l.note}
                  placeholder="Ce que recouvre la tâche, comment le temps a été estimé…"
                  onChange={(e) => patch(l.uid, { note: e.target.value })}
                />
              )}
            </div>
          )
        })}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLignes((ls) => [...ls, versDraft(LIGNE_VIDE)])}
          className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter une tâche
        </Button>
        <p className="text-[11px] text-muted-foreground pt-1">
          Chaque tâche se compte en minutes par unité × unités par semaine. Unité mesurée dans ETM (commande, lot…) : le volume suit l’activité réelle ;
          « autre unité » : volume estimé, saisi à la main ; « h / semaine » : forfait, pour une tâche sans unité.
        </p>
      </CardContent>
    </Card>
  )
}

// ── Évolution ──────────────────────────────────────────

function EvolutionCard({ employe, nbReleves, onHistorique }: { employe: Employe; nbReleves: number; onHistorique: () => void }) {
  const [mois, setMois] = useState(12)
  const { data, isLoading, isError } = useQuery<EvolutionResponse>({
    queryKey: ['rh', 'evolution', employe.id, mois],
    queryFn: () => apiFetch(`/rh/employes/${employe.id}/charge/evolution?mois=${mois}`),
    retry: false,
  })
  return (
    <Card className="card-premium">
      <CardHeader className="flex flex-row items-center gap-2 pb-2 space-y-0 flex-wrap">
        <TrendingUp className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Évolution</CardTitle>
        <span className="text-xs text-muted-foreground">heures par semaine, moyenne du mois</span>
        <div className="ml-auto">
          <PopoverSelect size="sm" widthClass="w-[150px]" hideEmpty value={mois} onChange={setMois} options={PERIODES} />
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <div className="h-[220px] flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
        ) : isError || !data ? (
          <div className="h-[220px] flex items-center justify-center text-sm text-destructive gap-2"><AlertCircle className="h-4 w-4" />Impossible de calculer l’évolution</div>
        ) : (
          <ChargeCourbe points={data.points} />
        )}
        <button type="button" onClick={onHistorique} className="inline-flex items-center gap-1.5 text-xs text-accent-blue hover:underline">
          <History className="h-3.5 w-3.5" />Historique des mises à jour ({nbReleves})
        </button>
      </CardContent>
    </Card>
  )
}

function HistoriqueDialog({ open, onClose, employeId, versions, onVoir, onSupprime }: {
  open: boolean
  onClose: () => void
  employeId: number
  versions: ChargeResponse['versions']
  onVoir: (id: number, derniere: boolean) => void
  onSupprime: () => void
}) {
  const [aSupprimer, setASupprimer] = useState<ChargeResponse['versions'][number] | null>(null)
  const suppression = useMutation({
    mutationFn: (id: number) => apiFetch(`/rh/employes/${employeId}/charge/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setASupprimer(null); onSupprime() },
  })
  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
        <DialogContent className="max-w-md" onClose={onClose}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><History className="h-5 w-5 text-accent" />Historique de la charge</DialogTitle>
          </DialogHeader>
          <div className="mt-4 space-y-1.5">
            {versions.map((v, i) => (
              <div key={v.id} className="group flex items-center gap-2 rounded-md border border-border/60 bg-zinc-100/80 px-3 py-2">
                <button type="button" className="flex-1 min-w-0 text-left" onClick={() => onVoir(v.id, i === 0)}>
                  <p className="text-sm font-medium">
                    {formatDateFr(v.dateReleve)}
                    {i === 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">en cours</span>}
                  </p>
                  {v.note && <p className="text-xs text-muted-foreground truncate">{v.note}</p>}
                </button>
                {versions.length > 1 && (
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" title="Supprimer" onClick={() => setASupprimer(v)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Chaque enregistrement garde la charge telle qu’elle était ; la courbe applique à chaque mois celle en vigueur.
          </p>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={aSupprimer !== null}
        title="Supprimer la mise à jour"
        description={aSupprimer ? `La charge enregistrée le ${formatDateFr(aSupprimer.dateReleve)} sera supprimée de l’historique.` : undefined}
        isPending={suppression.isPending}
        onCancel={() => setASupprimer(null)}
        onConfirm={() => { if (aSupprimer) suppression.mutate(aSupprimer.id) }}
      />
    </>
  )
}
