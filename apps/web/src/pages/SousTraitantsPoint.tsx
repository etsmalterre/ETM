// Sous-traitants › Point — the daily « Point du JJ/MM » sent to a dyer (MATEL
// first; Pierre-Emmanuel wrote it by hand in Word every evening since 2015).
// The automate « Point sous-traitant » prepares the next working day's point
// at 17:00 (apps/api/src/lib/point-sst/); here a person checks it line by
// line, corrects it, then sends it — now, or scheduled for 8:00 (the API's HEURE_ENVOI).
//
// Fiche layout: left the points, center the six numbered sections (MATEL
// answers « 2) … 5) … » by number, so the numbering never moves), right the
// sending (recipients, greeting, Word file) + a live preview, and the status
// pill that sends.
//
// Every line says why it is there (`pourquoi`) and carries the Tricobot
// button: the remark lands in the automate's « Retours » (Agents IA ›
// Automates), tied to the line — read before each new version of the rules
// (decision Vincent 2026-10-05: automates are not scored, their users'
// remarks are). Edits and removals are kept too, so the point never forgets
// what the automate first proposed.
//
// No global « Modifier » cycle: a point is a working draft, edited line by
// line (a dialog to add or correct one, like « Retirer » and « Tricobot s’est
// trompé ? »), until it is sent.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  AtSign,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  ArrowRight,
  Clock,
  FileDown,
  History,
  Info,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { TricobotBouton, TricobotCorrection, TricobotRetourDialog } from '@/components/tricobot/TricobotRetour'
import { TricobotMascot } from '@/components/icons/TricobotMascot'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { SendEmailDialog } from '@/components/email/SendEmailDialog'
import { postEmail, type EmailDefaults } from '@/lib/email'
import { apiFetch, API_URL } from '@/lib/api'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────

type StatutPoint = 'brouillon' | 'programme' | 'envoye'
type Section = 1 | 2 | 3 | 4 | 5 | 6

interface Destinataire { email: string; nom: string }

interface PointLigne {
  id: number
  section: Section
  ordre: number
  origine: 'auto' | 'manuel'
  cle: string | null
  idcommande: number
  idligne: number
  commande: string
  reference: string
  coloris: string
  datePrevue: string | null
  commentaire: string
  pourquoi: string
  auto: { commande: string; reference: string; coloris: string; datePrevue: string | null; commentaire: string } | null
  modifiee: boolean
  retiree: boolean
  retour: { id: string; texte: string; par: string | null } | null
  modifieLe: string | null
  modifiePar: string | null
}

interface Point {
  id: number
  idsousTraitant: number
  sousTraitant: string
  jour: string
  statut: StatutPoint
  genereLe: string
  generePar: string
  actualiseLe: string | null
  version: number
  introduction: string
  conclusion: string
  destinataires: Destinataire[]
  cc: Destinataire[]
  cci: Destinataire[]
  sujet: string
  avecDocx: boolean
  piecesJointes: { nom: string; taille: number }[]
  envoiPrevuLe: string | null
  programmePar: string | null
  envoyeLe: string | null
  envoyePar: string | null
  erreurEnvoi: string | null
  lignes: PointLigne[]
}

interface PointResume {
  id: number
  idsousTraitant: number
  sousTraitant: string
  jour: string
  statut: StatutPoint
  envoiPrevuLe: string | null
  envoyeLe: string | null
  nbLignes: number
  nbModifiees: number
}

interface SectionMeta { n: Section; titre: string; court: string }

interface ListeReponse {
  points: PointResume[]
  automate: { mode: 'off' | 'essai' | 'actif'; version: number }
  sousTraitants: Array<{ id: number; nom: string; automatique: boolean }>
  prochainJour: string
  expediteur: string
  heureEnvoi: number
  sections: SectionMeta[]
}

type Vue = 'a_envoyer' | 'envoyes' | 'tous'

// ── Helpers ────────────────────────────────────────────

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
const jourLong = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`)
  return `${JOURS[d.getUTCDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`
}
const jjmmaaaa = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
const dateHeure = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const heure = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
/** Today and the hour in Paris — the factory's clock, whatever the PC's. */
const aujourdhuiParis = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())
const heureParis = () => Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(new Date()))

const erreurDe = (e: unknown) => {
  const b = (e as { body?: { error?: string; message?: string } })?.body
  return b?.error ?? b?.message ?? (e instanceof Error ? e.message : 'Erreur')
}

const STATUT_META: Record<StatutPoint, { label: string; solid: string; icon: typeof Clock }> = {
  brouillon: { label: 'À envoyer', solid: 'bg-primary border-primary', icon: Pencil },
  programme: { label: 'Programmé', solid: 'bg-amber-500 border-amber-500', icon: CalendarClock },
  envoye: { label: 'Envoyé', solid: 'bg-success border-success', icon: CheckCircle2 },
}

function StatutPill({ statut, className }: { statut: StatutPoint; className?: string }) {
  const m = STATUT_META[statut]
  const Icon = m.icon
  return (
    <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white', m.solid, className)}>
      <Icon className="h-2.5 w-2.5" />{m.label}
    </Badge>
  )
}

const inputClass = 'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'
const textareaClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y'

// ── Page ───────────────────────────────────────────────

export function SousTraitantsPoint() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const lien = (() => {
    const n = parseInt(searchParams.get('point') ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : null
  })()
  const [selectedId, setSelectedId] = useState<number | null>(lien)
  const [vue, setVue] = useState<Vue>(lien ? 'tous' : 'a_envoyer')
  const [searchQuery, setSearchQuery] = useState('')
  const [nouveauOpen, setNouveauOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)

  useEffect(() => {
    if (searchParams.has('point')) {
      const next = new URLSearchParams(searchParams)
      next.delete('point')
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const listQuery = useQuery({
    queryKey: ['points-sst'],
    queryFn: () => apiFetch<ListeReponse>('/points-sst'),
  })
  const detailQuery = useQuery({
    queryKey: ['point-sst', selectedId],
    queryFn: () => apiFetch<{ point: Point }>(`/points-sst/${selectedId}`).then((r) => r.point),
    enabled: selectedId !== null,
  })

  const liste = listQuery.data
  const rows = useMemo(() => liste?.points ?? [], [liste])
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const aujourdhui = aujourdhuiParis()
    return rows.filter((r) => {
      if (vue === 'a_envoyer' && r.statut === 'envoye') return false
      // A day gone by without sending: nothing left to send (it stays under « Tous »).
      if (vue === 'a_envoyer' && r.statut === 'brouillon' && r.jour < aujourdhui) return false
      if (vue === 'envoyes' && r.statut !== 'envoye') return false
      if (!q) return true
      return `${r.sousTraitant} ${jourLong(r.jour)} ${jjmmaaaa(r.jour)}`.toLowerCase().includes(q)
    })
  }, [rows, searchQuery, vue])

  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (r) => r.id,
    select: setSelectedId,
    suspended: listQuery.isFetching,
  })

  const point = detailQuery.data ?? null
  /** Every mutation answers with the refreshed point: hydrate it, refresh the list. */
  const appliquer = (p: Point) => {
    queryClient.setQueryData(['point-sst', p.id], p)
    queryClient.invalidateQueries({ queryKey: ['points-sst'] })
    queryClient.invalidateQueries({ queryKey: ['point-sst-email', p.id] })
  }
  const apresEnvoi = () => {
    queryClient.invalidateQueries({ queryKey: ['points-sst'] })
    queryClient.invalidateQueries({ queryKey: ['point-sst', selectedId] })
    queryClient.invalidateQueries({ queryKey: ['point-sst-email', selectedId] })
  }

  return (
    <>
      <MasterDetailLayout
        list={
          <PointList
            rows={filtered}
            isLoading={listQuery.isLoading}
            error={listQuery.error as Error | null}
            selectedId={selectedId}
            onSelect={setSelectedId}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            vue={vue}
            onVueChange={setVue}
            onNouveau={() => setNouveauOpen(true)}
          />
        }
        detailHeader={<DetailHeader point={point} isLoading={detailQuery.isLoading && selectedId !== null} onChanged={appliquer} onEmail={() => setEmailOpen(true)} />}
        detail={
          <DetailMain
            point={point}
            sections={liste?.sections ?? []}
            isLoading={detailQuery.isLoading && selectedId !== null}
            hasSelection={selectedId !== null}
            onChanged={appliquer}
            bandeau={point && (
              <PointSuivant
                point={point}
                prochainJour={liste?.prochainJour ?? ''}
                suivantId={rows.find((r) => r.idsousTraitant === point.idsousTraitant && r.jour === liste?.prochainJour)?.id ?? null}
                onOuvrir={(id) => { setVue('a_envoyer'); setSelectedId(id) }}
              />
            )}
          />
        }
        sidebar={selectedId !== null ? (
          <DetailSidebar point={point} onEnvoyer={() => setEmailOpen(true)} onChanged={appliquer} />
        ) : null}
        sidebarTitle="Suivi"
        hasSelection={selectedId !== null}
        onBack={() => setSelectedId(null)}
      />
      {point && (
        <EmailPointDialog
          open={emailOpen}
          point={point}
          automateActif={liste?.automate.mode === 'actif'}
          heureEnvoi={liste?.heureEnvoi ?? 8}
          onClose={() => setEmailOpen(false)}
          onSent={apresEnvoi}
        />
      )}
      <NouveauDialog
        open={nouveauOpen}
        onClose={() => setNouveauOpen(false)}
        sousTraitants={liste?.sousTraitants ?? []}
        prochainJour={liste?.prochainJour ?? ''}
        onCreated={(id) => {
          setNouveauOpen(false)
          setVue('tous')
          queryClient.invalidateQueries({ queryKey: ['points-sst'] })
          queryClient.invalidateQueries({ queryKey: ['point-sst', id] })
          setSelectedId(id)
        }}
      />
    </>
  )
}

// ── Left panel ─────────────────────────────────────────

function PointList({
  rows, isLoading, error, selectedId, onSelect, searchQuery, onSearchChange, vue, onVueChange, onNouveau,
}: {
  rows: PointResume[]; isLoading: boolean; error: Error | null
  selectedId: number | null; onSelect: (id: number) => void
  searchQuery: string; onSearchChange: (q: string) => void
  vue: Vue; onVueChange: (v: Vue) => void
  onNouveau: () => void
}) {
  const VUES: Array<{ key: Vue; label: string }> = [
    { key: 'a_envoyer', label: 'À envoyer' },
    { key: 'envoyes', label: 'Envoyés' },
    { key: 'tous', label: 'Tous' },
  ]
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50 space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Sous-traitant, date…"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            autoComplete="off"
            className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {VUES.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => onVueChange(v.key)}
              className={cn(
                'px-2 py-1 text-xs rounded-md transition-colors flex-grow basis-[calc(33.333%-0.25rem)]',
                vue === v.key ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
        {isLoading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-8 text-destructive text-sm gap-2"><AlertCircle className="h-5 w-5" />{erreurDe(error)}</div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <ClipboardList className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucun point</p>
          </div>
        ) : rows.map((r) => (
          <div
            key={r.id}
            onClick={() => onSelect(r.id)}
            className={cn(
              'p-3 border rounded-lg cursor-pointer transition-all bg-white',
              selectedId === r.id ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-accent/50',
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              <CalendarDays className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="font-medium text-sm truncate">Point du {jourLong(r.jour)}</span>
              <StatutPill statut={r.statut} className="ml-auto flex-shrink-0" />
            </div>
            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
              <span className="truncate">{r.sousTraitant}</span>
              <span className="ml-auto flex-shrink-0 tabular-nums">
                {r.nbLignes} ligne{r.nbLignes > 1 ? 's' : ''}{r.nbModifiees > 0 ? ` · ${r.nbModifiees} corrigée${r.nbModifiees > 1 ? 's' : ''}` : ''}
              </span>
            </div>
            {r.statut === 'programme' && r.envoiPrevuLe && (
              <p className="text-[11px] text-amber-700 mt-1">Part le {dateHeure(r.envoiPrevuLe)}</p>
            )}
          </div>
        ))}
      </div>
      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{rows.length} point{rows.length > 1 ? 's' : ''}</span>
        <Button size="sm" variant="ghost" className="text-accent hover:text-accent hover:bg-accent/10" onClick={onNouveau}>
          <Plus className="h-3.5 w-3.5 mr-1" />Nouveau
        </Button>
      </div>
    </div>
  )
}

// ── Detail header ──────────────────────────────────────

function DetailHeader({ point, isLoading, onChanged, onEmail }: { point: Point | null; isLoading: boolean; onChanged: (p: Point) => void; onEmail: () => void }) {
  const [erreur, setErreur] = useState<string | null>(null)
  const actualiser = useMutation({
    mutationFn: () => apiFetch(`/points-sst/${point!.id}/actualiser`, { method: 'POST' }),
    onSuccess: async () => {
      setErreur(null)
      onChanged((await apiFetch<{ point: Point }>(`/points-sst/${point!.id}`)).point)
    },
    onError: (e) => setErreur(erreurDe(e)),
  })
  if (isLoading) return <div className="h-14 flex items-center"><div className="h-8 w-64 bg-muted animate-pulse rounded" /></div>
  if (!point) return null
  const envoye = point.statut === 'envoye'
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className="h-11 w-11 rounded-lg flex items-center justify-center icon-box-gold">
          <ClipboardList className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-heading font-bold tracking-tight truncate">Point du {jourLong(point.jour)}</h1>
          <div className="flex gap-1.5 mt-1 flex-wrap items-center">
            <Badge variant="secondary" className="text-xs">{point.sousTraitant}</Badge>
            <span className="text-xs text-muted-foreground">
              {point.generePar === 'automate' ? 'Préparé par Tricobot' : `Préparé par ${point.generePar}`} le {dateHeure(point.genereLe)}
              {point.actualiseLe && ` · actualisé le ${dateHeure(point.actualiseLe)}`}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {erreur && <span className="text-xs text-destructive max-w-[240px] truncate" title={erreur}>{erreur}</span>}
          {!envoye && (
            <Button variant="outline" size="sm" onClick={() => actualiser.mutate()} disabled={actualiser.isPending}
              title="Relire les données d’ETM : les nouvelles lignes arrivent, celles qui n’ont plus lieu d’être partent ; vos corrections restent">
              {actualiser.isPending ? <Loader2 className="h-3.5 w-3.5 sm:mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 sm:mr-1.5" />}
              <span className="hidden sm:inline">Actualiser</span>
            </Button>
          )}
          <Button variant="outline" size="icon" className="h-9 w-9" title="Télécharger le fichier Word"
            onClick={() => window.open(`${API_URL}/points-sst/${point.id}/word`, '_blank')}>
            <FileDown className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" className="h-9 w-9" onClick={onEmail} disabled={point.statut !== 'brouillon'}
            title={point.statut === 'envoye' ? 'Point déjà envoyé' : point.statut === 'programme' ? 'Envoi déjà programmé — annulez-le pour le modifier' : 'Envoyer le point par e-mail'}>
            <AtSign className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="h-1 w-24 mt-3 rounded-full bg-gradient-to-r from-accent via-accent to-accent/30" />
    </div>
  )
}

// ── « Ce n'est pas le point de demain » ────────────────
// Pierre-Emmanuel corrected the point du 07/10 on 07/10 at 16:40, believing it was
// tomorrow's: the 08/10 point only appears at 17:00, and nothing said the one on
// screen was today's. An unsent point that is not the next one says so, and leads
// to the next one — opening it, or preparing it now.

function PointSuivant({ point, prochainJour, suivantId, onOuvrir }: {
  point: Point; prochainJour: string; suivantId: number | null; onOuvrir: (id: number) => void
}) {
  const queryClient = useQueryClient()
  const preparer = useMutation({
    mutationFn: () => apiFetch<{ id: number }>('/points-sst/preparer', { method: 'POST', body: JSON.stringify({ idsousTraitant: point.idsousTraitant, jour: prochainJour }) }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['points-sst'] })
      onOuvrir(r.id)
    },
  })
  const aujourdhui = aujourdhuiParis()
  if (point.statut === 'envoye' || !prochainJour || point.jour >= prochainJour) return null
  const depasse = point.jour < aujourdhui
  // Today's point is the one to send in the morning: only point the way once the morning is over.
  if (!depasse && (point.jour > aujourdhui || heureParis() < 12)) return null
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 flex items-center gap-3 flex-wrap">
      <CalendarClock className="h-4 w-4 text-amber-600 flex-shrink-0" />
      <p className="text-sm min-w-0 flex-1">
        {depasse
          ? <><span className="font-semibold">Ce point est dépassé</span> : il était pour {jourLong(point.jour)} et n’est pas parti.</>
          : <><span className="font-semibold">C’est le point d’aujourd’hui</span> ({jourLong(point.jour)}). Pour le prochain, c’est le point du {jourLong(prochainJour)}.</>}
        {!suivantId && <span className="text-muted-foreground"> Tricobot le prépare à 17 h ; vous pouvez le préparer dès maintenant, il sera actualisé à 17 h sans perdre vos corrections.</span>}
        {preparer.isError && <span className="text-destructive"> {erreurDe(preparer.error)}</span>}
      </p>
      {suivantId ? (
        <Button size="sm" onClick={() => onOuvrir(suivantId)}>
          <ArrowRight className="h-3.5 w-3.5 mr-1.5" />Ouvrir le point du {jourLong(prochainJour)}
        </Button>
      ) : (
        <Button size="sm" onClick={() => preparer.mutate()} disabled={preparer.isPending}>
          {preparer.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
          Préparer le point du {jourLong(prochainJour)}
        </Button>
      )}
    </div>
  )
}

// ── Center: the six sections ───────────────────────────

function DetailMain({ point, sections, isLoading, hasSelection, onChanged, bandeau }: {
  point: Point | null; sections: SectionMeta[]; isLoading: boolean; hasSelection: boolean; onChanged: (p: Point) => void; bandeau?: ReactNode
}) {
  const [ajoutSection, setAjoutSection] = useState<Section | null>(null)
  const [editionId, setEditionId] = useState<number | null>(null)
  const [retourPour, setRetourPour] = useState<PointLigne | null>(null)
  useEffect(() => { setAjoutSection(null); setEditionId(null) }, [point?.id])

  const retourMut = useMutation({
    mutationFn: ({ ligne, texte }: { ligne: PointLigne; texte: string }) =>
      apiFetch<{ point: Point }>(`/points-sst/${point!.id}/lignes/${ligne.id}/retour`, { method: 'POST', body: JSON.stringify({ texte }) }),
    onSuccess: (r) => { onChanged(r.point); setRetourPour(null) },
  })

  if (!hasSelection) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
        <div className="icon-box-gold h-16 w-16 rounded-xl flex items-center justify-center mb-3"><ClipboardList className="h-8 w-8" /></div>
        <p className="text-sm">Sélectionnez un point</p>
      </div>
    )
  }
  if (isLoading || !point) return <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>

  const modifiable = point.statut !== 'envoye'
  const edition = editionId !== null ? point.lignes.find((l) => l.id === editionId) ?? null : null
  return (
    <div className="flex-1 min-h-0 overflow-auto space-y-4 p-1 scrollbar-transparent">
      {bandeau}
      {point.erreurEnvoi && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />L’envoi programmé a échoué : {point.erreurEnvoi}
        </div>
      )}
      {sections.map((s) => {
        const lignes = point.lignes.filter((l) => l.section === s.n)
        const actives = lignes.filter((l) => !l.retiree).length
        return (
          <div key={s.n} className="card-premium p-4">
            <div className="flex items-start gap-2">
              <span className="h-6 w-6 rounded-md bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center flex-shrink-0">{s.n}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{s.court}</p>
                <p className="text-xs text-muted-foreground">{s.titre}</p>
              </div>
              <Badge variant="secondary" className="text-xs flex-shrink-0">{actives}</Badge>
            </div>
            <div className="mt-3 space-y-2">
              {lignes.length === 0 && (
                <p className="text-sm text-muted-foreground italic">Rien à demander{s.n === 6 ? ' — la question est posée quand même.' : ' : la section part vide (« — »).'}</p>
              )}
              {lignes.map((l) => (
                <LigneCard
                  key={l.id}
                  pointId={point.id}
                  ligne={l}
                  avecDate={s.n === 1}
                  modifiable={modifiable}
                  onEditer={() => setEditionId(l.id)}
                  onRetour={() => setRetourPour(l)}
                  onChanged={onChanged}
                />
              ))}
              {modifiable && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAjoutSection(s.n)}
                  className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter une ligne
                </Button>
              )}
            </div>
          </div>
        )
      })}
      <LigneDialog
        open={ajoutSection !== null || edition !== null}
        pointId={point.id}
        section={edition?.section ?? ajoutSection ?? 1}
        sections={sections}
        ligne={edition}
        onClose={() => { setAjoutSection(null); setEditionId(null) }}
        onSaved={onChanged}
      />
      <TricobotRetourDialog
        open={retourPour !== null}
        sujet={retourPour ? [retourPour.commande, retourPour.reference].filter(Boolean).join(' · ') || 'cette ligne' : null}
        titre="Je me suis trompé sur cette ligne ?"
        texte="Dis-moi ce qui n’allait pas : elle n’avait rien à faire là, elle n’est pas dans la bonne section, il manquait une remarque… Je lis tout avant ma prochaine version."
        placeholder="Ex. : cette commande est en reprise, il fallait demander le délai, pas les métrages."
        isPending={retourMut.isPending}
        onClose={() => setRetourPour(null)}
        onConfirm={async (texte) => { await retourMut.mutateAsync({ ligne: retourPour!, texte }) }}
      />
    </div>
  )
}

function LigneCard({ pointId, ligne: l, avecDate, modifiable, onEditer, onRetour, onChanged }: {
  pointId: number; ligne: PointLigne; avecDate: boolean; modifiable: boolean
  onEditer: () => void; onRetour: () => void; onChanged: (p: Point) => void
}) {
  const [erreur, setErreur] = useState<string | null>(null)
  const [aRetirer, setARetirer] = useState<PointLigne | null>(null)
  const act = useMutation({
    mutationFn: (quoi: 'retirer' | 'restaurer' | 'annuler-retour') =>
      apiFetch<{ point: Point }>(
        quoi === 'retirer' ? `/points-sst/${pointId}/lignes/${l.id}`
          : quoi === 'restaurer' ? `/points-sst/${pointId}/lignes/${l.id}/restaurer`
          : `/points-sst/${pointId}/lignes/${l.id}/retour`,
        { method: quoi === 'restaurer' ? 'POST' : 'DELETE' },
      ),
    onSuccess: (r) => { setErreur(null); onChanged(r.point) },
    onError: (e) => setErreur(erreurDe(e)),
  })
  const edge = l.retiree ? 'border-l-border' : l.origine === 'manuel' ? 'border-l-teal-500/60' : l.modifiee ? 'border-l-accent/70' : 'border-l-amber-400/60'
  const autoTexte = l.auto ? [l.auto.commande, l.auto.reference, [l.auto.coloris, l.auto.commentaire].filter(Boolean).join(' - '), l.auto.datePrevue ? jjmmaaaa(l.auto.datePrevue) : ''].filter(Boolean).join(' · ') : ''
  return (
    <div className={cn('group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3', edge, l.retiree && 'opacity-60')}>
      <div className="flex items-center gap-3 min-w-0">
        <span className={cn('text-sm font-semibold tabular-nums text-primary w-12 flex-shrink-0', l.retiree && 'line-through')}>{l.commande || '—'}</span>
        <span className={cn('text-sm w-20 flex-shrink-0 truncate', l.retiree && 'line-through')} title={l.reference}>{l.reference}</span>
        <span className={cn('text-sm min-w-0 flex-1 truncate', l.retiree && 'line-through')} title={[l.coloris, l.commentaire].filter(Boolean).join(' - ')}>
          {l.coloris}
          {l.commentaire && <span className="font-semibold">{l.coloris ? ' - ' : ''}{l.commentaire}</span>}
        </span>
        {avecDate && <span className="text-sm tabular-nums text-muted-foreground flex-shrink-0">{l.datePrevue ? jjmmaaaa(l.datePrevue) : ''}</span>}
        <div className="flex items-center gap-1 flex-shrink-0">
          {l.origine === 'manuel' && <Badge variant="outline" className="text-[10px] py-0 bg-teal-500/10 text-teal-700 border-teal-500/25">ajoutée</Badge>}
          {l.modifiee && !l.retiree && <Badge variant="outline" className="text-[10px] py-0 bg-accent/10 text-accent border-accent/25">corrigée</Badge>}
          {l.retiree && <Badge variant="outline" className="text-[10px] py-0 text-muted-foreground">retirée</Badge>}
          {modifiable && (
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              {(l.retiree || l.modifiee) && l.origine === 'auto' ? (
                <Button variant="ghost" size="icon" className="h-6 w-6" title="Revenir à la ligne de Tricobot" onClick={() => act.mutate('restaurer')} disabled={act.isPending}>
                  <RotateCcw className="h-3 w-3" />
                </Button>
              ) : null}
              {!l.retiree && (
                <Button variant="ghost" size="icon" className="h-6 w-6" title="Corriger la ligne" onClick={onEditer}>
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
              {!l.retiree && (
                <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" title={l.origine === 'manuel' ? 'Supprimer la ligne' : 'Retirer la ligne du point'}
                  onClick={() => (l.origine === 'manuel' ? act.mutate('retirer') : setARetirer(l))} disabled={act.isPending}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-start gap-2 mt-1.5">
        <div className="min-w-0 flex-1 space-y-0.5">
          {l.pourquoi && (
            <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
              <Info className="h-3 w-3 flex-shrink-0 mt-0.5 opacity-60" />{l.pourquoi}
            </p>
          )}
          {l.modifiee && autoTexte && (
            <p className="text-[11px] text-muted-foreground italic">Tricobot proposait : {autoTexte}</p>
          )}
          {l.origine === 'manuel' && l.modifiePar && <p className="text-[11px] text-muted-foreground italic">Ajoutée par {l.modifiePar}</p>}
          {erreur && <p className="text-[11px] text-destructive">{erreur}</p>}
        </div>
        {!l.retour && (
          <div className="flex-shrink-0">
            <TricobotBouton onClick={onRetour} label={l.origine === 'manuel' ? 'Tricobot l’a oubliée ?' : 'Tricobot s’est trompé ?'} />
          </div>
        )}
      </div>
      {l.retour && (
        <TricobotCorrection className="mt-2" commentaire={l.retour.texte} par={l.retour.par} onAnnuler={() => act.mutate('annuler-retour')} disabled={act.isPending} />
      )}
      <RetirerDialog ligne={aRetirer} pointId={pointId} onClose={() => setARetirer(null)} onChanged={onChanged} />
    </div>
  )
}

/** Adding or correcting a line — a dialog, like « Retirer » and « Tricobot s’est
 *  trompé ? », so the form never pushes the section's other lines around. */
function LigneDialog({ open, pointId, section, sections, ligne, onClose, onSaved }: {
  open: boolean; pointId: number; section: Section; sections: SectionMeta[]; ligne: PointLigne | null
  onClose: () => void; onSaved: (p: Point) => void
}) {
  const vide = (l: PointLigne | null) => ({
    section: l?.section ?? section,
    commande: l?.commande ?? '',
    reference: l?.reference ?? '',
    coloris: l?.coloris ?? '',
    commentaire: l?.commentaire ?? '',
    datePrevue: l?.datePrevue ?? '',
  })
  const [f, setF] = useState(() => vide(ligne))
  const [pourquoi, setPourquoi] = useState(ligne?.retour?.texte ?? '')
  const [erreur, setErreur] = useState<string | null>(null)
  // Fresh form on every opening (another line, another section).
  useEffect(() => {
    if (!open) return
    setF(vide(ligne))
    setPourquoi(ligne?.retour?.texte ?? '')
    setErreur(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ligne?.id, section])
  // Tricobot speaks on a line he missed (new) or wrote (auto); a person's own line is theirs.
  const tricobot = !ligne || ligne.origine === 'auto'
  const save = useMutation({
    mutationFn: async () => {
      const body = JSON.stringify({ ...f, datePrevue: f.datePrevue || null })
      const r: { id?: number; point: Point } = ligne
        ? await apiFetch<{ point: Point }>(`/points-sst/${pointId}/lignes/${ligne.id}`, { method: 'PATCH', body })
        : await apiFetch<{ id: number; point: Point }>(`/points-sst/${pointId}/lignes`, { method: 'POST', body })
      // The why, when given, is Tricobot feedback on the line he missed or got wrong.
      if (!tricobot || !pourquoi.trim() || pourquoi.trim() === ligne?.retour?.texte) return r
      const lid = ligne?.id ?? r.id!
      return apiFetch<{ point: Point }>(`/points-sst/${pointId}/lignes/${lid}/retour`, { method: 'POST', body: JSON.stringify({ texte: pourquoi.trim() }) })
    },
    onSuccess: (r) => { onSaved(r.point); onClose() },
    onError: (e) => setErreur(erreurDe(e)),
  })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }))
  const sujet = ligne ? [ligne.commande, ligne.reference].filter(Boolean).join(' · ') : ''
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {ligne ? <Pencil className="h-5 w-5 text-accent" /> : <Plus className="h-5 w-5 text-accent" />}
            {ligne ? `Corriger la ligne${sujet ? ` — ${sujet}` : ''}` : 'Ajouter une ligne'}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
      {!ligne && (
        <TricobotBulle titre="J’ai oublié une ligne ?"
          texte="Écris-la ici, elle partira avec le point. J’en tiendrai compte lors de ma prochaine mise à jour — dis-moi pourquoi en bas si tu peux." />
      )}
      {ligne && tricobot && (
        <TricobotBulle titre="Je me suis trompé sur cette ligne ?"
          texte="Corrige-la ici, elle partira corrigée. J’en tiendrai compte lors de ma prochaine mise à jour — dis-moi pourquoi en bas si tu peux." />
      )}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
        <Labeled label="Commande"><input className={inputClass} value={f.commande} onChange={set('commande')} autoFocus /></Labeled>
        <Labeled label="Référence"><input className={inputClass} value={f.reference} onChange={set('reference')} /></Labeled>
        <div className="sm:col-span-2"><Labeled label="Coloris"><input className={inputClass} value={f.coloris} onChange={set('coloris')} /></Labeled></div>
        <div className="sm:col-span-2"><Labeled label="Remarque (« solde », « reprise », « TRES URGENT »…)"><input className={inputClass} value={f.commentaire} onChange={set('commentaire')} /></Labeled></div>
        <Labeled label="Date de sortie"><input type="date" className={inputClass} value={f.datePrevue} onChange={set('datePrevue')} /></Labeled>
        <Labeled label="Section">
          <PopoverSelect
            size="sm"
            widthClass="w-full"
            hideEmpty
            value={f.section}
            onChange={(id) => setF((p) => ({ ...p, section: id as Section }))}
            options={sections.map((s) => ({ id: s.n, primary: `${s.n}. ${s.court}` }))}
          />
        </Labeled>
      </div>
      {tricobot && (
        <Labeled label={ligne ? 'Qu’est-ce qui n’allait pas ? (facultatif — pour Tricobot)' : 'Pourquoi fallait-il la demander ? (facultatif — pour Tricobot)'}>
          <textarea rows={2} className={textareaClass} value={pourquoi} onChange={(e) => setPourquoi(e.target.value)}
            placeholder={ligne ? 'Ex. : c’est une reprise, il fallait demander le délai, pas les métrages.' : 'Ex. : la 8982 est repartie en reprise, on attend un nouveau délai.'} />
        </Labeled>
      )}
      {erreur && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="h-4 w-4" />{erreur}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Tricobot speaks for himself — the same mascot + bubble as TricobotRetourDialog, smaller. */
function TricobotBulle({ titre, texte }: { titre: string; texte: string }) {
  return (
    <div className="flex items-end gap-3">
      <TricobotMascot className="h-14 w-14 -mb-1 flex-shrink-0" />
      <div className="relative min-w-0 flex-1 rounded-xl rounded-bl-none border border-accent/30 bg-accent/10 px-3 py-2">
        <p className="text-sm font-semibold">{titre}</p>
        <p className="text-sm text-foreground/80">{texte}</p>
      </div>
    </div>
  )
}

/** Removing one of Tricobot's lines: he asks why (optional) before it goes. */
function RetirerDialog({ ligne, pointId, onClose, onChanged }: {
  ligne: PointLigne | null; pointId: number; onClose: () => void; onChanged: (p: Point) => void
}) {
  const [pourquoi, setPourquoi] = useState('')
  const [erreur, setErreur] = useState<string | null>(null)
  useEffect(() => { if (ligne) { setPourquoi(''); setErreur(null) } }, [ligne])
  const retirer = useMutation({
    mutationFn: async () => {
      const r = await apiFetch<{ point: Point }>(`/points-sst/${pointId}/lignes/${ligne!.id}`, { method: 'DELETE' })
      if (!pourquoi.trim()) return r
      return apiFetch<{ point: Point }>(`/points-sst/${pointId}/lignes/${ligne!.id}/retour`, { method: 'POST', body: JSON.stringify({ texte: pourquoi.trim() }) })
    },
    onSuccess: (r) => { onChanged(r.point); onClose() },
    onError: (e) => setErreur(erreurDe(e)),
  })
  return (
    <Dialog open={ligne !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-accent" />
            Retirer la ligne{ligne ? ` — ${[ligne.commande, ligne.reference].filter(Boolean).join(' · ')}` : ''}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <TricobotBulle titre="Cette ligne n’avait rien à faire là ?"
            texte="Je la retire du point. J’en tiendrai compte lors de ma prochaine mise à jour — dis-moi pourquoi si tu peux." />
          <textarea rows={3} autoFocus className={textareaClass} value={pourquoi} onChange={(e) => setPourquoi(e.target.value)}
            placeholder="Facultatif. Ex. : la 9023 est livrée par une autre commande, il ne faut plus la demander." />
          {erreur && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="h-4 w-4" />{erreur}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button variant="destructive" onClick={() => retirer.mutate()} disabled={retirer.isPending}>
            {retirer.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 mr-1.5" />}Retirer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

// ── Right panel: what happened to the point ────────────

function DetailSidebar({ point, onEnvoyer, onChanged }: {
  point: Point | null; onEnvoyer: () => void; onChanged: (p: Point) => void
}) {
  const annuler = useMutation({
    mutationFn: () => apiFetch<{ point: Point }>(`/points-sst/${point!.id}/programme`, { method: 'DELETE' }),
    onSuccess: (r) => onChanged(r.point),
  })
  if (!point) {
    return (
      <div className="w-96 flex-shrink-0 bg-muted/30 rounded-xl border p-4 space-y-4">
        {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
      </div>
    )
  }
  const meta = STATUT_META[point.statut]
  const Icon = meta.icon
  const lignes = point.lignes
  const nb = (f: (l: PointLigne) => boolean) => lignes.filter(f).length
  const qui = (d: Destinataire[]) => d.map((x) => x.nom || x.email).join(', ')
  return (
    <div className="w-96 flex-shrink-0 flex flex-col gap-3 min-h-0">
      <div className="flex-1 min-h-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
        <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
          <div className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-accent text-accent-foreground shadow-sm">
            <History className="h-3.5 w-3.5" />Suivi
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><ClipboardList className="h-3.5 w-3.5" />Le point</p>
            <Kv label="Lignes envoyées" value={nb((l) => !l.retiree)} />
            <Kv label="Proposées par Tricobot" value={nb((l) => l.origine === 'auto')} />
            <Kv label="Corrigées" value={nb((l) => l.modifiee && !l.retiree)} />
            <Kv label="Retirées" value={nb((l) => l.retiree)} />
            <Kv label="Ajoutées à la main" value={nb((l) => l.origine === 'manuel')} />
            <Kv label="Remarques à Tricobot" value={nb((l) => !!l.retour)} />
          </div>
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />Historique</p>
            <Kv label="Préparé" value={`${point.generePar === 'automate' ? 'Tricobot' : point.generePar} · ${dateHeure(point.genereLe)}`} />
            {point.actualiseLe && <Kv label="Actualisé" value={dateHeure(point.actualiseLe)} />}
            {point.statut === 'programme' && point.envoiPrevuLe && (
              <Kv label="Programmé" value={`${point.programmePar ?? ''} · part le ${dateHeure(point.envoiPrevuLe)}`} />
            )}
            {point.statut === 'envoye' && point.envoyeLe && <Kv label="Envoyé" value={`${point.envoyePar ?? ''} · ${dateHeure(point.envoyeLe)}`} />}
          </div>
          {point.statut !== 'brouillon' && (
            <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
              <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><AtSign className="h-3.5 w-3.5" />E-mail</p>
              <Kv label="À" value={qui(point.destinataires) || '—'} />
              {point.cc.length > 0 && <Kv label="Cc" value={qui(point.cc)} />}
              {point.cci.length > 0 && <Kv label="Cci" value={qui(point.cci)} />}
              <Kv label="Objet" value={point.sujet} />
              {point.avecDocx && <Kv label="Fichier Word" value="joint" />}
              {point.piecesJointes.length > 0 && <Kv label="Pièces jointes" value={point.piecesJointes.map((f) => f.nom).join(', ')} />}
            </div>
          )}
        </div>
      </div>

      {/* §29.3 status pill — the action that sends */}
      <div className={cn('flex-shrink-0 rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11', meta.solid)}>
        <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
          <Icon className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-bold uppercase tracking-wide truncate">
            {point.statut === 'programme' && point.envoiPrevuLe ? `Part à ${heure(point.envoiPrevuLe)}`
              : point.statut === 'envoye' && point.envoyeLe ? `Envoyé ${dateHeure(point.envoyeLe)}`
              : meta.label}
          </span>
        </div>
        {point.statut === 'brouillon' && (
          <button type="button" onClick={onEnvoyer}
            className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors">
            <Send className="h-3.5 w-3.5" />Envoyer
          </button>
        )}
        {point.statut === 'programme' && (
          <button type="button" onClick={() => annuler.mutate()} disabled={annuler.isPending}
            title="Le point redevient un brouillon : vous pourrez le corriger et le renvoyer"
            className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:opacity-60 text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors">
            {annuler.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}Annuler l’envoi
          </button>
        )}
      </div>
    </div>
  )
}

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground flex-shrink-0">{label}</span>
      <span className="text-sm text-right truncate tabular-nums" title={typeof value === 'string' ? value : undefined}>{value}</span>
    </div>
  )
}

/** The standard email dialog, with the point always in the body and the Word file optional. */
function EmailPointDialog({ open, point, automateActif, heureEnvoi, onClose, onSent }: {
  open: boolean; point: Point; automateActif: boolean; heureEnvoi: number; onClose: () => void; onSent: () => void
}) {
  const depart = new Date(`${point.jour}T${String(heureEnvoi).padStart(2, '0')}:00:00`)
  const raison = !automateActif
    ? 'L’automate « Point sous-traitant » n’est pas actif (Agents IA › Automates) : un envoi programmé ne partirait pas.'
    : depart.getTime() <= Date.now() ? `${heureEnvoi} h est déjà passé pour ce point.` : null
  const apercu = `${API_URL}/points-sst/${point.id}/apercu`
  const nomWord = `point ${point.sousTraitant.toLowerCase()} ${point.jour.slice(8, 10)}${point.jour.slice(5, 7)}${point.jour.slice(0, 4)}.docx`
  return (
    <SendEmailDialog
      open={open}
      onClose={onClose}
      title={`Envoyer le point du ${jourLong(point.jour)}`}
      contextLabel={point.sousTraitant}
      queryKey={['point-sst-email', point.id]}
      loadDefaults={() => apiFetch<EmailDefaults>(`/points-sst/${point.id}/email-defaults`)}
      extraServerAttachments={[{ id: 'point', label: 'Le point (dans le message)', url: apercu }]}
      optionalServerAttachments={[{ id: 'word', label: nomWord, url: apercu, defaultChecked: point.avecDocx }]}
      programmer={{ label: `Programmer à ${heureEnvoi} h`, title: `Part tout seul le ${jourLong(point.jour)} à ${heureEnvoi} h ; vous pouvez encore le corriger ou annuler l’envoi jusque-là.`, disabledReason: raison }}
      onSend={async (p) => {
        await postEmail(`${API_URL}/points-sst/${point.id}/email`, p, {
          extraBody: { word: p.optionalAttachments?.word === true, programme: p.programme === true },
        })
        onSent()
      }}
    />
  )
}

// ── « Nouveau » — prepare a point by hand ──────────────

function NouveauDialog({ open, onClose, sousTraitants, prochainJour, onCreated }: {
  open: boolean; onClose: () => void
  sousTraitants: ListeReponse['sousTraitants']; prochainJour: string
  onCreated: (id: number) => void
}) {
  const defaut = sousTraitants.find((s) => s.automatique)?.id ?? sousTraitants[0]?.id ?? 0
  const [sst, setSst] = useState(defaut)
  const [jour, setJour] = useState(prochainJour)
  const [erreur, setErreur] = useState<string | null>(null)
  useEffect(() => { if (open) { setSst(defaut); setJour(prochainJour); setErreur(null) } }, [open, defaut, prochainJour])
  const creer = useMutation({
    mutationFn: () => apiFetch<{ id: number }>('/points-sst/preparer', { method: 'POST', body: JSON.stringify({ idsousTraitant: sst, jour }) }),
    onSuccess: (r) => onCreated(r.id),
    onError: (e) => {
      const id = (e as { body?: { id?: number } }).body?.id
      if (id) onCreated(id)
      else setErreur(erreurDe(e))
    },
  })
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ClipboardList className="h-5 w-5 text-accent" />Préparer un point</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">Tricobot prépare chaque jour ouvré à 17 h le point du lendemain pour MATEL. Ici, vous le préparez tout de suite — ou pour un autre teinturier. S’il existe déjà, il est actualisé.</p>
          <Labeled label="Sous-traitant">
            <PopoverSelect hideEmpty value={sst} onChange={setSst} options={sousTraitants.map((s) => ({ id: s.id, primary: s.nom, secondary: s.automatique ? 'automatique' : undefined }))} />
          </Labeled>
          <Labeled label="Point du">
            <input type="date" className={cn(inputClass, 'h-9')} value={jour} onChange={(e) => setJour(e.target.value)} />
          </Labeled>
          {erreur && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="h-4 w-4" />{erreur}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => creer.mutate()} disabled={creer.isPending || !sst || !jour}>
            {creer.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Préparer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
