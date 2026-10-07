// Fils › Références › « Stock & conso » (2026-10-07).
//
// Answers ONE question per coloris: « if I don't order today, when do I run
// out, and does a new lot arrive in time? ». Top: every coloris of the yarn
// with its stock position and cover; below: the selected coloris — four
// figures, the run-out projection and 24 months of knitted consumption.
//
// Every figure comes from GET /references-fil/:id/consommation, whose rules
// (consumption = knitted weight × the yarn's share in the OF, « disponible »
// = the État des stocks figure, suggested minimum = kg/week × (délai + marge))
// live in apps/api/src/lib/fil-consommation.ts.
//
// Charts are hand-rolled SVG drawn at the container's real pixel size, like the
// dashboard's (no viewBox stretching). Single series each → no legend; the
// reference lines carry their own labels; every chart has a hover tooltip.

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, ArrowDownRight, ArrowUpRight, BarChart3, CheckCircle2, ExternalLink, LineChart, Loader2, Minus, Save, TrendingDown, Truck, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { niceScale } from '@/lib/chart-scale'
import { useElementSize } from '@/hooks/useElementSize'
import { simulerRayon, type Rayon, type VerdictLivraison } from '@/lib/stock-rayon'

// ── Data ───────────────────────────────────────────────

export type StatutStock = 'sans_mini' | 'ok' | 'bientot' | 'commander'

export interface LigneAppro {
  idref_fil_commande: number
  idcommande_fil: number
  fournisseur: string | null
  date_commande: string
  date_promise: string | null
  premiere_reception: string | null
  derniere_reception: string | null
  quantite: number
  recu_kg: number
  ouverte: boolean
  delai_jours: number | null
  retard_jours: number | null
  en_retard: boolean
}

export interface LigneEnCours extends LigneAppro {
  /** Still to receive: ordered − already received. */
  reste_kg: number
}

export interface AnalyseAppro {
  /** Every open line with something still to receive, earliest promise first. */
  en_cours: LigneEnCours[]
  lignes: LigneAppro[]
  delai_mesure_jours: number | null
  delai_min_jours: number | null
  delai_max_jours: number | null
  nb_commandes_mesurees: number
  delai_annonce_jours: number | null
  nb_comparees: number
  a_l_heure: number
  retard_moyen_jours: number | null
}

export interface ConsoColoris {
  IDcolori_fil: number
  reference: string | null
  stock_mini: number
  delai_appro: number
  /** The délai the suggestion used: typed on the coloris, else measured. */
  delai_utilise_semaines: number | null
  delai_source: 'saisi' | 'mesure' | null
  appro: AnalyseAppro
  en_stock: number
  commande: number
  besoin: number
  disponible: number
  mensuel: { mois: string; kg: number; partiel: boolean }[]
  kg_semaine_12m: number
  kg_semaine_3m: number
  semaines_couvertes: number | null
  date_rupture: string | null
  semaines_mini: number | null
  semaines_avant_mini: number | null
  date_commande: string | null
  mini_suggere: number | null
  statut: StatutStock
}

export interface ConsoResponse {
  marge_semaines: number
  coloris: ConsoColoris[]
}

/** Shared by this tab, the Coloris section and the coloris dialog — one fetch. */
export function useConsommationFil(refFilId: number | null) {
  return useQuery<ConsoResponse>({
    queryKey: ['ref-fil-consommation', refFilId],
    queryFn: () => apiFetch(`/references-fil/${refFilId}/consommation`),
    enabled: refFilId != null,
    staleTime: 0,
  })
}

/** kg/week × (délai + marge), rounded up to 10 kg — same rule as the API, for
 *  the coloris dialog where the délai is being typed. */
export function miniSuggere(kgSemaine: number, delai: number, marge: number): number | null {
  if (!(kgSemaine > 0) || !(delai > 0)) return null
  return Math.ceil((kgSemaine * (delai + marge)) / 10) * 10
}

// ── Formatting ─────────────────────────────────────────

const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']
const MOIS_LONGS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export function fmtDate(s: string | null): string {
  if (!s) return '—'
  return parseYmd(s).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
}
function fmtSemaines(w: number | null): string {
  if (w == null) return '—'
  if (w >= 104) return '> 2 ans'
  return `${fmtNum(w, w < 10 ? 1 : 0)} sem.`
}
function moisLabel(key: string, long = false): string {
  const [y, m] = key.split('-').map(Number)
  return long ? `${MOIS_LONGS[m - 1]} ${y}` : `${MOIS_COURTS[m - 1]} ${String(y).slice(2)}`
}

export const STATUT_META: Record<StatutStock, { label: string; badge: string } | null> = {
  sans_mini: null,
  ok: null,
  bientot: { label: 'À commander bientôt', badge: 'bg-amber-500/15 text-amber-800 ring-1 ring-amber-500/30' },
  commander: { label: 'À commander', badge: 'bg-destructive text-destructive-foreground' },
}

export function StatutBadge({ statut, className }: { statut: StatutStock; className?: string }) {
  const meta = STATUT_META[statut]
  if (!meta) return null
  return (
    <Badge className={cn('text-[10px] py-0 px-1.5 gap-1 flex-shrink-0 border-transparent', meta.badge, className)}>
      <AlertCircle className="h-2.5 w-2.5" />
      {meta.label}
    </Badge>
  )
}

/// ── Tab ────────────────────────────────────────────────

/** A coloris with something going on: stock, an order or a reservation in
 *  progress, knitting in the last 24 months, or a minimum to watch. */
function estActif(c: ConsoColoris): boolean {
  return c.en_stock > 0 || c.commande > 0 || c.besoin > 0 || c.stock_mini > 0 || c.mensuel.some((m) => m.kg > 0)
}

export function StockConsoTab({ refFilId, refReference }: { refFilId: number; refReference: string }) {
  const navigate = useNavigate()
  const { data, isLoading, isError } = useConsommationFil(refFilId)
  const coloris = useMemo(() => data?.coloris ?? [], [data])
  const [showInactive, setShowInactive] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    )
  }
  if (isError || !data) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive px-1 py-4">
        <AlertCircle className="h-4 w-4" />Impossible de calculer la consommation.
      </div>
    )
  }
  if (coloris.length === 0) return <p className="text-sm text-muted-foreground italic px-1">Aucun coloris</p>

  const actifs = coloris.filter(estActif)
  const inactifs = coloris.length - actifs.length
  const rows = showInactive ? coloris : actifs
  const opened = coloris.find((c) => c.IDcolori_fil === openId) ?? null
  const lotsUrl = (c: ConsoColoris) => `/fils/stock?q=${encodeURIComponent(`${refReference} ${c.reference ?? ''}`)}`

  return (
    <>
      {inactifs > 0 && (
        <div className="flex items-center justify-end px-1">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
            />
            <span className="text-muted-foreground">
              Afficher les {inactifs} coloris inactif{inactifs > 1 ? 's' : ''}
            </span>
          </label>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground italic px-1">
          Aucun coloris en stock, en commande ni tricoté depuis 24 mois.
        </p>
      ) : (
        <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-200/60 border-b border-border/60">
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 text-left font-semibold">Coloris</th>
                <th className="px-3 py-2 text-right font-semibold">En stock</th>
                <th className="px-3 py-2 text-right font-semibold" title="Commandé, pas encore reçu">Commandé</th>
                <th className="px-3 py-2 text-right font-semibold" title="Réservé sur des commandes en cours, pas encore tricoté">Réservé</th>
                <th className="px-3 py-2 text-right font-semibold" title="En stock + commandé − réservé">Disponible</th>
                <th className="px-3 py-2 text-right font-semibold" title="Consommation moyenne sur 12 mois">Conso / sem.</th>
                <th className="px-3 py-2 text-right font-semibold" title="Semaines avant que le disponible atteigne le stock mini — le moment de commander">Réappro dans</th>
                <th className="px-3 py-2 text-right font-semibold">Stock mini</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const inactif = !estActif(c)
                return (
                  <tr
                    key={c.IDcolori_fil}
                    onClick={() => setOpenId(c.IDcolori_fil)}
                    title="Voir l'analyse du coloris"
                    className={cn(
                      'border-b border-border/40 last:border-b-0 cursor-pointer transition-colors hover:bg-accent/5',
                      inactif && 'text-muted-foreground',
                    )}
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={cn('truncate', !inactif && 'font-medium')}>{c.reference ?? '—'}</span>
                        <StatutBadge statut={c.statut} />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{fmtNum(c.en_stock, 1)} kg</td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-muted-foreground">
                      {c.commande > 0 ? `${fmtNum(c.commande, 0)} kg` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-muted-foreground">
                      {c.besoin > 0 ? `${fmtNum(c.besoin, 0)} kg` : '—'}
                    </td>
                    <td className={cn('px-3 py-2 text-right tabular-nums whitespace-nowrap font-semibold', c.statut === 'commander' && 'text-destructive')}>
                      {fmtNum(c.disponible, 1)} kg
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                      {c.kg_semaine_12m > 0 ? `${fmtNum(c.kg_semaine_12m, 1)} kg` : '—'}
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2 text-right tabular-nums whitespace-nowrap',
                        c.statut === 'commander' && 'text-destructive font-semibold',
                        c.statut === 'bientot' && 'text-amber-700 font-semibold',
                      )}
                      title={c.date_commande ? `Commander avant le ${fmtDate(c.date_commande)}` : c.stock_mini > 0 ? 'Pas de consommation mesurée' : 'Aucun stock mini défini'}
                    >
                      {c.statut === 'commander' ? 'Maintenant' : fmtSemaines(c.semaines_avant_mini)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-muted-foreground">
                      {c.stock_mini > 0 ? `${fmtNum(c.stock_mini, 0)} kg` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <AnalyseDialog
        c={opened}
        refFilId={refFilId}
        refReference={refReference}
        marge={data.marge_semaines}
        onClose={() => setOpenId(null)}
        onVoirLots={(c) => navigate(lotsUrl(c))}
      />
    </>
  )
}

// ── Live projection ────────────────────────────────────
// The dialog's settings (minimum, délai) are edited live: the tiles, the chart
// and the verdict are recomputed here from the same rules as the API
// (lib/fil-consommation.ts) so the user SEES what a minimum does before saving.

export interface Projection {
  rate: number
  disponible: number
  mini: number
  /** Délai used (weeks): typed, else measured; null = unknown. */
  delai: number | null
  delaiSource: 'saisi' | 'mesure' | null
  /** Measured délai in weeks (null without delivered orders). */
  delaiMesure: number | null
  marge: number
  /** Weeks the available stock lasts (null = no consumption). */
  couverture: number | null
  /** Weeks until the available stock reaches the minimum (0 = order now). */
  avantMini: number | null
  dateCommande: string | null
  dateRupture: string | null
  suggere: number | null
  statut: StatutStock
  /** Weeks from today when a lot ordered at the minimum arrives. */
  arrivee: number | null
  /** Stock left when it arrives, in weeks of consumption (< 0 = rupture first). */
  margeReelle: number | null
  /** Shelf stock falling, stepping up on each pending delivery (lib/stock-rayon.ts). */
  rayon: Rayon
  enStock: number
  /** Pending deliveries with their expected week and verdict. */
  livraisons: (LigneEnCours & { arriveeW: number; verdict: VerdictLivraison | null })[]
}

/** Weeks from today to a 'YYYY-MM-DD' (negative when past). */
function semainesJusqua(ymd: string): number {
  const t = new Date()
  t.setHours(0, 0, 0, 0)
  return (parseYmd(ymd).getTime() - t.getTime()) / (7 * 86_400_000)
}

/** Weeks the shelf simulation runs over — the chart clips to its own horizon. */
const HORIZON_SIMULATION = 104

function ymdIn(weeks: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + Math.round(weeks * 7))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function projeter(c: ConsoColoris, mini: number, delaiSaisi: number, marge: number): Projection {
  const rate = c.kg_semaine_12m
  const disponible = c.disponible
  const delaiMesure = c.appro.delai_mesure_jours != null ? Math.max(1, Math.ceil(c.appro.delai_mesure_jours / 7)) : null
  const delai = delaiSaisi > 0 ? delaiSaisi : delaiMesure
  const couverture = rate > 0 ? Math.max(0, disponible) / rate : null
  const avantMini = rate > 0 && mini > 0 ? Math.max(0, (disponible - mini) / rate) : null
  const arrivee = avantMini != null && delai != null ? avantMini + delai : null
  let statut: StatutStock
  if (mini <= 0) statut = 'sans_mini'
  else if (disponible <= mini) statut = 'commander'
  else if (avantMini != null && avantMini <= marge) statut = 'bientot'
  else statut = 'ok'
  // A late or undated delivery is assumed to arrive today (flagged in the card).
  const enCours = c.appro.en_cours.map((l) => ({ ...l, arriveeW: l.date_promise ? Math.max(0, semainesJusqua(l.date_promise)) : 0 }))
  const rayon = simulerRayon({
    enStock: c.en_stock,
    rate,
    livraisons: enCours.map((l) => ({ id: l.idref_fil_commande, kg: l.reste_kg, arriveeW: l.arriveeW })),
    horizon: HORIZON_SIMULATION,
    marge,
  })
  const livraisons = enCours.map((l) => ({ ...l, verdict: rate > 0 ? rayon.verdicts.find((v) => v.id === l.idref_fil_commande) ?? null : null }))

  return {
    rayon,
    enStock: c.en_stock,
    livraisons,
    rate,
    disponible,
    mini,
    delai,
    delaiSource: delaiSaisi > 0 ? 'saisi' : delaiMesure != null ? 'mesure' : null,
    delaiMesure,
    marge,
    couverture,
    avantMini,
    dateCommande: avantMini != null ? ymdIn(avantMini) : null,
    dateRupture: couverture != null ? ymdIn(couverture) : null,
    suggere: miniSuggere(rate, delai ?? 0, marge),
    statut,
    arrivee,
    margeReelle: arrivee != null && couverture != null ? couverture - arrivee : null,
  }
}

/** One sentence: does a lot ordered at the minimum arrive in time? */
function verdict(p: Projection): { tone: 'ok' | 'warning' | 'danger'; text: string } | null {
  if (!(p.rate > 0)) return null
  if (p.mini <= 0) {
    return { tone: 'warning', text: `Aucun stock mini : rien ne déclenche la commande. Sans commande, rupture vers le ${fmtDate(p.dateRupture)}.` }
  }
  if (p.delai == null || p.margeReelle == null) {
    return { tone: 'warning', text: 'Délai d’approvisionnement inconnu : renseignez-le pour vérifier que la livraison arrive à temps.' }
  }
  const quand = p.statut === 'commander' ? 'En commandant aujourd’hui' : `Avec ${fmtNum(p.mini, 0)} kg de stock mini`
  const m = p.margeReelle
  if (m < 0) return { tone: 'danger', text: `${quand}, la livraison arrive ${fmtNum(-m, 0)} sem. après la rupture.` }
  if (m < p.marge) return { tone: 'warning', text: `${quand}, la livraison arrive avec seulement ${fmtNum(m, 1)} sem. de stock (marge visée : ${p.marge} sem.).` }
  return { tone: 'ok', text: `${quand}, la livraison arrive avec ${fmtNum(m, 0)} sem. de stock d’avance.` }
}

// ── Analysis dialog — banded « bilan » (mps_designer §18.D) ──
// Two tabs: Projection (decide: figures, chart, the two settings) and Analyse
// (the evidence: consumption per month, supply delays). The minimum and the
// délai are WRITTEN here — the only fields of the dialog, gold-edged — and
// saved with the footer's « Enregistrer ».

type DialogTab = 'projection' | 'analyse'

function AnalyseDialog({
  c, refFilId, refReference, marge, onClose, onVoirLots,
}: {
  c: ConsoColoris | null
  refFilId: number
  refReference: string
  marge: number
  onClose: () => void
  onVoirLots: (c: ConsoColoris) => void
}) {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<DialogTab>('projection')
  const [miniDraft, setMiniDraft] = useState('')
  const [delaiDraft, setDelaiDraft] = useState('')
  const [closeBlocked, setCloseBlocked] = useState(false)

  // Fresh drafts each time a coloris is opened.
  useEffect(() => {
    if (!c) return
    setTab('projection')
    setMiniDraft(c.stock_mini > 0 ? String(c.stock_mini) : '')
    setDelaiDraft(c.delai_appro > 0 ? String(c.delai_appro) : '')
    setCloseBlocked(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.IDcolori_fil])

  const mini = Math.max(0, Math.round(Number(miniDraft) || 0))
  const delaiSaisi = Math.max(0, Math.round(Number(delaiDraft) || 0))
  const dirty = c != null && (mini !== c.stock_mini || delaiSaisi !== c.delai_appro)

  const saveMut = useMutation({
    mutationFn: () =>
      apiFetch(`/references-fil/${refFilId}/variantes/${c!.IDcolori_fil}/reappro`, {
        method: 'PUT',
        body: JSON.stringify({ stock_mini: mini, delai_appro: delaiSaisi }),
      }),
    onSuccess: () => {
      setCloseBlocked(false)
      queryClient.invalidateQueries({ queryKey: ['ref-fil-consommation', refFilId] })
      queryClient.invalidateQueries({ queryKey: ['ref-fil', refFilId] })
    },
  })

  const requestClose = () => {
    if (dirty) { setCloseBlocked(true); return }
    onClose()
  }
  const discardAndClose = () => {
    saveMut.reset()
    onClose()
  }

  const p = c ? projeter(c, mini, delaiSaisi, marge) : null
  const saveError = saveMut.error
    ? String(((saveMut.error as { body?: { message?: string } }).body?.message) ?? 'L’enregistrement a échoué.')
    : null

  return (
    <Dialog open={c !== null} onOpenChange={(o) => { if (!o) requestClose() }}>
      {/* p-0 border-0 bg-primary + opaque body/footer: no white edge (§18.D) */}
      <DialogContent className="max-w-5xl w-[94vw] p-0 border-0 bg-primary overflow-hidden max-h-[90dvh] flex flex-col">
        {c && p && (
          <>
            <div className="flex-shrink-0 flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5 rounded-t-lg">
              <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
                <TrendingDown className="h-[18px] w-[18px]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">
                    Stock & consommation — {c.reference ?? '—'}
                  </h2>
                  <StatutBadge statut={p.statut} />
                </div>
                <p className="text-xs text-white/70 truncate">{refReference}</p>
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8 text-white/80 hover:bg-white/15 hover:text-white" title="Fermer" onClick={requestClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-100 p-4 space-y-3 scrollbar-transparent">
              {/* Tabs — the app's gold pills */}
              <div className="flex items-center gap-1">
                {([['projection', 'Projection', LineChart], ['analyse', 'Analyse', BarChart3]] as const).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTab(key)}
                    className={cn(
                      'flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors',
                      tab === key ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10 hover:text-accent',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />{label}
                  </button>
                ))}
              </div>
              {tab === 'projection' ? (
                <ProjectionTab
                  c={c}
                  p={p}
                  miniDraft={miniDraft}
                  delaiDraft={delaiDraft}
                  onMini={setMiniDraft}
                  onDelai={setDelaiDraft}
                />
              ) : (
                <AnalyseTab c={c} />
              )}
            </div>

            <div className="flex-shrink-0 flex items-center gap-3 border-t border-border/60 bg-zinc-200 px-4 py-3 rounded-b-lg">
              {(saveError || closeBlocked) && (
                <div className="flex items-center gap-2 text-sm text-destructive min-w-0">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span className="truncate">{saveError ?? 'Réglage modifié : enregistrez ou annulez.'}</span>
                </div>
              )}
              <div className="ml-auto flex items-center gap-2">
                <Button variant="outline" onClick={() => onVoirLots(c)}>
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" />Voir les lots
                </Button>
                {dirty ? (
                  <>
                    <Button variant="outline" onClick={discardAndClose} disabled={saveMut.isPending}>Annuler</Button>
                    <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
                      {saveMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                      Enregistrer
                    </Button>
                  </>
                ) : (
                  <Button onClick={onClose}>Fermer</Button>
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ── Tiles ──────────────────────────────────────────────

function Tile({ label, children, sub, tone }: { label: string; children: React.ReactNode; sub?: React.ReactNode; tone?: 'danger' | 'warning' }) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2.5 min-w-0',
        tone === 'danger' ? 'border-destructive/30 bg-destructive/5'
          : tone === 'warning' ? 'border-amber-500/30 bg-amber-500/5'
            : 'border-border/60 bg-zinc-100/80',
      )}
    >
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold truncate">{label}</p>
      <div className="mt-1">{children}</div>
      {sub && <p className="mt-1 text-[11px] text-muted-foreground leading-snug">{sub}</p>}
    </div>
  )
}

function Big({ value, unit, tone }: { value: string; unit?: string; tone?: 'danger' | 'warning' }) {
  return (
    <span className={cn('text-2xl font-bold tabular-nums leading-none', tone === 'danger' && 'text-destructive', tone === 'warning' && 'text-amber-700')}>
      {value}
      {unit ? <span className="text-xs text-muted-foreground font-normal ml-1">{unit}</span> : null}
    </span>
  )
}

// ── Projection tab ─────────────────────────────────────

function ProjectionTab({
  c, p, miniDraft, delaiDraft, onMini, onDelai,
}: {
  c: ConsoColoris
  p: Projection
  miniDraft: string
  delaiDraft: string
  onMini: (v: string) => void
  onDelai: (v: string) => void
}) {
  const hasConso = p.rate > 0
  const trend = hasConso ? (c.kg_semaine_3m - p.rate) / p.rate : 0
  const TrendIcon = Math.abs(trend) < 0.1 ? Minus : trend > 0 ? ArrowUpRight : ArrowDownRight
  const orderTone = p.statut === 'commander' ? 'danger' : p.statut === 'bientot' ? 'warning' : undefined
  const v = verdict(p)

  return (
    <>
      <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <Tile
            label="Consommation"
            sub={hasConso ? (
              <span className="inline-flex items-center gap-1">
                <TrendIcon className="h-3 w-3" />
                3 derniers mois : {fmtNum(c.kg_semaine_3m, 1)} kg/sem.
              </span>
            ) : 'Rien tricoté sur 12 mois'}
          >
            <Big value={hasConso ? fmtNum(p.rate, 1) : '—'} unit="kg/sem." />
          </Tile>
          <Tile
            label="Disponible"
            sub={`${fmtNum(c.en_stock, 0)} en stock + ${fmtNum(c.commande, 0)} commandé − ${fmtNum(c.besoin, 0)} réservé`}
          >
            <Big value={fmtNum(p.disponible, 0)} unit="kg" tone={p.statut === 'commander' ? 'danger' : undefined} />
          </Tile>
          <Tile label="Couverture" sub={p.dateRupture ? `Rupture vers le ${fmtDate(p.dateRupture)}` : undefined}>
            <Big
              value={p.couverture != null ? fmtSemaines(p.couverture).replace(' sem.', '') : '—'}
              unit={p.couverture != null && p.couverture < 104 ? 'semaines' : undefined}
            />
          </Tile>
          <Tile
            label="Commander avant"
            tone={orderTone}
            sub={p.mini > 0 ? `quand le disponible atteint ${fmtNum(p.mini, 0)} kg` : 'Aucun stock mini défini'}
          >
            <Big value={p.statut === 'commander' ? 'Maintenant' : p.dateCommande ? fmtDate(p.dateCommande) : '—'} tone={orderTone} />
          </Tile>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 min-w-0 rounded-lg border border-border/60 bg-card shadow-sm p-3">
          <div className="flex items-baseline gap-2 mb-1.5">
            <h4 className="text-xs font-semibold">Projection du disponible</h4>
            <span className="text-[11px] text-muted-foreground">Au rythme des 12 derniers mois, sans nouvelle commande</span>
          </div>
          {hasConso ? (
            <>
              <ProjectionChart p={p} />
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0.5 w-5 bg-primary" />Disponible (stock + commandé − réservé) — quand commander</span>
                {p.livraisons.length > 0 && (
                  <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0.5 w-5 bg-teal-600" />Stock en rayon, avec les livraisons attendues</span>
                )}
              </div>
              {v && (
                <p
                  className={cn(
                    'mt-2 rounded-md px-3 py-2 text-xs font-medium flex items-start gap-1.5',
                    v.tone === 'danger' ? 'bg-destructive/10 text-destructive'
                      : v.tone === 'warning' ? 'bg-amber-500/10 text-amber-800'
                        : 'bg-green-500/10 text-green-700',
                  )}
                >
                  {v.tone === 'ok' ? <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-px" /> : <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />}
                  {v.text}
                </p>
              )}
            </>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground italic">
              Aucun tricotage mesuré sur ce coloris depuis 24 mois — pas de projection possible.
            </p>
          )}
        </div>

        <ReglageCard p={p} miniDraft={miniDraft} delaiDraft={delaiDraft} onMini={onMini} onDelai={onDelai} />
      </div>

      {p.livraisons.length > 0 && <CommandesEnCours p={p} />}
    </>
  )
}

/** Pending deliveries against the shelf stock: should one be chased? */
function CommandesEnCours({ p }: { p: Projection }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3 space-y-2">
      <div className="flex items-baseline gap-2">
        <Truck className="h-3.5 w-3.5 text-accent self-center" />
        <h4 className="text-xs font-semibold">Commandes en cours</h4>
        <span className="text-[11px] text-muted-foreground">
          Arrivent-elles avant que le stock en rayon ({fmtNum(p.enStock, 0)} kg) soit épuisé ?
        </span>
      </div>
      <div className="divide-y divide-border/50">
        {p.livraisons.map((l) => {
          const v = l.verdict
          const tone = v?.tone
          const Icon = tone === 'ok' ? CheckCircle2 : AlertCircle
          const semaines = v && p.rate > 0 ? v.stockAvantKg / p.rate : null
          let texte: string
          if (!v) texte = 'Pas de consommation mesurée : rien à comparer.'
          else if (v.ruptureW != null) {
            texte = `À relancer : le stock en rayon s'épuise le ${fmtDate(ymdIn(v.ruptureW))}, ${fmtNum(Math.max(0, l.arriveeW - v.ruptureW), 0)} sem. avant cette livraison.`
          } else if (tone === 'warning') {
            texte = `Arrive avec seulement ${fmtNum(semaines ?? 0, 1)} sem. de stock en rayon (${fmtNum(v.stockAvantKg, 0)} kg) — à surveiller.`
          } else {
            texte = `Arrive avec ~${fmtNum(semaines ?? 0, 0)} sem. de stock en rayon d'avance (${fmtNum(v.stockAvantKg, 0)} kg).`
          }
          return (
            <div key={l.idref_fil_commande} className="py-2 first:pt-0 last:pb-0 flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <span className="font-semibold tabular-nums">N°{l.idcommande_fil}</span>
                  <span className="text-muted-foreground"> · {l.fournisseur ?? '—'} · </span>
                  <span className="font-medium tabular-nums">{fmtNum(l.reste_kg, 0)} kg</span>
                  {l.recu_kg > 0 && <span className="text-muted-foreground tabular-nums"> (sur {fmtNum(l.quantite, 0)} kg)</span>}
                  <span className="text-muted-foreground">
                    {' · '}{l.date_promise ? `promise le ${fmtDate(l.date_promise)}` : 'sans date promise'}
                  </span>
                  {l.en_retard && (
                    <Badge className="ml-2 text-[10px] py-0 px-1.5 border-transparent bg-amber-500/15 text-amber-800 ring-1 ring-amber-500/30">
                      en retard de {l.retard_jours} j
                    </Badge>
                  )}
                </p>
                <p
                  className={cn(
                    'mt-0.5 text-xs flex items-start gap-1',
                    tone === 'danger' ? 'text-destructive font-medium' : tone === 'warning' ? 'text-amber-800' : tone === 'ok' ? 'text-green-700' : 'text-muted-foreground',
                  )}
                >
                  {tone && <Icon className="h-3.5 w-3.5 flex-shrink-0 mt-px" />}
                  {texte}
                </p>
              </div>
            </div>
          )
        })}
      </div>
      {p.livraisons.some((l) => l.en_retard || !l.date_promise) && (
        <p className="text-[11px] text-muted-foreground">Une livraison en retard ou sans date promise est supposée arriver aujourd'hui.</p>
      )}
    </div>
  )
}

/** The two settings, written from here — gold edge = « what you are writing » (§18.D). */
function ReglageCard({
  p, miniDraft, delaiDraft, onMini, onDelai,
}: {
  p: Projection
  miniDraft: string
  delaiDraft: string
  onMini: (v: string) => void
  onDelai: (v: string) => void
}) {
  const input = 'h-9 w-full px-2.5 text-sm tabular-nums rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
  const delaiTyped = Math.max(0, Math.round(Number(delaiDraft) || 0))
  return (
    <div className="rounded-lg border-l-4 border-l-accent/70 border border-border/60 bg-card shadow-sm p-3 space-y-3">
      <h4 className="text-xs font-semibold">Réglage du réapprovisionnement</h4>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Délai d'approvisionnement (semaines)</label>
        <input
          type="number" min={0} step={1} value={delaiDraft} onChange={(e) => onDelai(e.target.value)}
          placeholder={p.delaiMesure != null ? `${p.delaiMesure} (mesuré)` : ''}
          className={input}
        />
        {p.delaiMesure != null ? (
          <p className="text-[11px] text-muted-foreground">
            Mesuré : <span className="font-semibold text-foreground tabular-nums">{p.delaiMesure} sem.</span>
            {delaiTyped === 0 ? ' — utilisé tant que le champ est vide' : (
              <button type="button" onClick={() => onDelai(String(p.delaiMesure))} className="ml-1.5 text-accent font-medium hover:underline">
                Utiliser
              </button>
            )}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">Aucune livraison passée pour le mesurer.</p>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Stock mini (kg)</label>
        <input type="number" min={0} step={10} value={miniDraft} onChange={(e) => onMini(e.target.value)} className={input} />
        {p.rate > 0 && p.mini > 0 && (
          <p className="text-[11px] text-muted-foreground">
            ≈ <span className="font-semibold text-foreground tabular-nums">{fmtNum(p.mini / p.rate, 0)} sem.</span> de consommation
          </p>
        )}
        {p.suggere != null && (
          <div className="rounded-md bg-accent/[0.06] border border-accent/25 px-2.5 py-1.5 text-[11px]">
            <div className="flex items-center gap-2">
              <span>Suggéré : <span className="font-semibold text-sm tabular-nums">{fmtNum(p.suggere, 0)} kg</span></span>
              {p.suggere !== p.mini && (
                <button type="button" onClick={() => onMini(String(p.suggere))} className="ml-auto text-accent font-medium hover:underline">
                  Utiliser
                </button>
              )}
            </div>
            <p className="text-muted-foreground mt-0.5">
              {fmtNum(p.rate, 1)} kg/sem. × ({p.delai} sem. de délai{p.delaiSource === 'mesure' ? ' mesuré' : ''} + {p.marge} sem. de marge)
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Analyse tab ────────────────────────────────────────

function AnalyseTab({ c }: { c: ConsoColoris }) {
  return (
    <>
      {c.kg_semaine_12m > 0 || c.mensuel.some((m) => m.kg > 0) ? (
        <ChartBlock title="Consommation par mois" hint="Kilos tricotés, 24 derniers mois">
          <MonthlyChart c={c} />
        </ChartBlock>
      ) : (
        <p className="rounded-lg border border-border/60 bg-card shadow-sm p-3 text-sm text-muted-foreground italic">
          Aucun tricotage mesuré sur ce coloris depuis 24 mois.
        </p>
      )}
      <ApproSection c={c} />
    </>
  )
}

// ── Supply: lead time and punctuality from past orders ──

function joursEnSemaines(j: number | null): string {
  if (j == null) return '—'
  if (j < 14) return `${j} j`
  return `${fmtNum(j / 7, 0)} sem.`
}

function ApproSection({ c }: { c: ConsoColoris }) {
  const a = c.appro
  if (a.lignes.length === 0) {
    return (
      <p className="rounded-lg border border-border/60 bg-card shadow-sm p-3 text-sm text-muted-foreground italic">
        Aucune commande fournisseur sur ce coloris — délai d'approvisionnement non mesurable.
      </p>
    )
  }
  const enAttenteRetard = a.lignes.filter((l) => !l.premiere_reception && l.en_retard)
  const ponctuel = a.nb_comparees > 0 ? a.a_l_heure / a.nb_comparees : null
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3 space-y-3">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold">Approvisionnement</h4>
        <span className="text-[11px] text-muted-foreground">Commandes fournisseur de ce coloris</span>
        {enAttenteRetard.length > 0 && (
          <Badge className="ml-auto text-[10px] py-0 px-1.5 gap-1 border-transparent bg-amber-500/15 text-amber-800 ring-1 ring-amber-500/30">
            <AlertCircle className="h-2.5 w-2.5" />
            {enAttenteRetard.map((l) => `N°${l.idcommande_fil}`).join(', ')} attendue{enAttenteRetard.length > 1 ? 's' : ''} depuis{' '}
            {Math.max(...enAttenteRetard.map((l) => l.retard_jours ?? 0))} j
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Tile
          label="Délai mesuré"
          sub={a.nb_commandes_mesurees > 0
            ? `Médiane de ${a.nb_commandes_mesurees} commande${a.nb_commandes_mesurees > 1 ? 's' : ''} · de ${joursEnSemaines(a.delai_min_jours)} à ${joursEnSemaines(a.delai_max_jours)}`
            : 'Aucune livraison mesurable'}
        >
          <Big value={joursEnSemaines(a.delai_mesure_jours)} />
        </Tile>
        <Tile label="Délai annoncé" sub="Date promise par le fournisseur, depuis la commande">
          <Big value={joursEnSemaines(a.delai_annonce_jours)} />
        </Tile>
        <Tile
          label="Ponctualité"
          tone={ponctuel != null && ponctuel < 0.7 ? 'warning' : undefined}
          sub={a.retard_moyen_jours != null ? `Retard moyen quand en retard : ${a.retard_moyen_jours} j` : a.nb_comparees > 0 ? 'Jamais en retard' : 'Pas de date promise à comparer'}
        >
          <Big value={a.nb_comparees > 0 ? `${a.a_l_heure} / ${a.nb_comparees}` : '—'} unit={a.nb_comparees > 0 ? 'à l’heure' : undefined} />
        </Tile>
      </div>
      <OrdersChart lignes={a.lignes} />
      {c.delai_source === 'mesure' && (
        <p className="text-[11px] text-muted-foreground">
          Le stock mini suggéré utilise ce délai mesuré tant qu'aucun délai n'est renseigné sur le coloris.
        </p>
      )}
    </div>
  )
}

const ROW_H = 28
const LABEL_W = 150
const VALUE_W = 72

/** One row per order line, every bar starting at its own order date (day 0):
 *  the bar's length IS the lead time, so the rows compare at a glance — a
 *  calendar axis over 5 years turned an 11-day delivery into a sliver. Tick
 *  at the promised day; an awaited line runs to today, dashed. */
function OrdersChart({ lignes }: { lignes: LigneAppro[] }) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const W = size.w
  const H = lignes.length * ROW_H + 22
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const jours = (a: string, b: string) => Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / 86_400_000)

  const rows = lignes.map((l) => ({
    l,
    duree: Math.max(0, jours(l.date_commande, l.premiere_reception ?? todayKey)),
    promis: l.date_promise ? Math.max(0, jours(l.date_commande, l.date_promise)) : null,
  }))
  const scale = niceScale(0, Math.max(14, ...rows.flatMap((r) => [r.duree, r.promis ?? 0])))
  const innerW = Math.max(0, W - LABEL_W - VALUE_W)
  const x = (d: number) => LABEL_W + (innerW * d) / (scale.hi || 1)

  const hr = hover != null ? rows[hover] : null
  const tip: Tip | null = hr == null ? null : {
    x: x(hr.duree),
    y: hover! * ROW_H + ROW_H / 2,
    title: `N°${hr.l.idcommande_fil} · ${hr.l.fournisseur ?? '—'} · ${fmtNum(hr.l.quantite, 0)} kg — commandée le ${fmtDate(hr.l.date_commande)}`,
    value: hr.l.premiere_reception
      ? `Reçue le ${fmtDate(hr.l.premiere_reception)} (${hr.duree} j)${hr.l.date_promise ? ` · promise le ${fmtDate(hr.l.date_promise)}${hr.l.retard_jours != null && hr.l.retard_jours > 0 ? `, +${hr.l.retard_jours} j` : ''}` : ''}`
      : `En attente depuis ${hr.duree} j${hr.l.date_promise ? ` · promise le ${fmtDate(hr.l.date_promise)}` : ''}${hr.l.en_retard ? `, en retard de ${hr.l.retard_jours} j` : ''}`,
  }

  return (
    <div>
      <div ref={ref} className="relative w-full" style={{ height: H }}>
        {W > 0 && (
          <svg width={W} height={H} className="block">
            {scale.ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={0} y2={H - 18} className="text-border" stroke="currentColor" strokeWidth={1} />
                <text x={x(t)} y={H - 5} textAnchor="middle" className="fill-muted-foreground text-[10px] tabular-nums">{t} j</text>
              </g>
            ))}
            {rows.map(({ l, duree, promis }, i) => {
              const yMid = i * ROW_H + ROW_H / 2
              const w = Math.max(3, x(duree) - x(0))
              const recue = !!l.premiere_reception
              const r = Math.min(4, w / 2)
              return (
                <g key={l.idref_fil_commande} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <rect x={0} y={i * ROW_H} width={W} height={ROW_H} fill="transparent" />
                  <text x={0} y={yMid} dy="0.32em" className="fill-foreground text-[11px] tabular-nums">
                    N°{l.idcommande_fil}
                    <tspan className="fill-muted-foreground"> · {fmtDate(l.date_commande)}</tspan>
                  </text>
                  <rect
                    x={x(0)} y={yMid - 6} width={w} height={12} rx={r}
                    className={l.en_retard ? 'text-orange-600' : 'text-accent'} fill="currentColor"
                    fillOpacity={recue ? (hover == null || hover === i ? 1 : 0.6) : 0.25}
                    stroke={recue ? undefined : 'currentColor'}
                    strokeDasharray={recue ? undefined : '3 2'}
                  />
                  {promis != null && (
                    <line x1={x(promis)} x2={x(promis)} y1={yMid - 9} y2={yMid + 9} className="text-primary" stroke="currentColor" strokeWidth={2} />
                  )}
                  <text x={W - VALUE_W + 8} y={yMid} dy="0.32em" className={cn('text-[11px] tabular-nums', l.en_retard ? 'fill-orange-700 font-semibold' : 'fill-foreground')}>
                    {recue ? `${duree} j` : 'attendue'}
                    {l.en_retard && l.retard_jours ? <tspan className="text-[10px]"> +{l.retard_jours}</tspan> : null}
                  </text>
                </g>
              )
            })}
          </svg>
        )}
        <TooltipBox tip={tip} width={W} />
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-4 rounded-sm bg-accent" />délai réel</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-4 rounded-sm bg-orange-600" />livrée en retard</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-accent bg-accent/25" />en attente</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-0.5 bg-primary" />date promise</span>
      </p>
    </div>
  )
}

function ChartBlock({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-card shadow-sm p-3">
      <div className="flex items-baseline gap-2 mb-1.5">
        <h4 className="text-xs font-semibold">{title}</h4>
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      </div>
      {children}
    </div>
  )
}

// ── Charts ─────────────────────────────────────────────

const PAD = { top: 14, right: 14, bottom: 24, left: 48 }
const CHART_H = 220

function kgTick(v: number): string {
  return Math.abs(v) >= 1000 ? `${fmtNum(v / 1000, 1)} t` : `${fmtNum(v, 0)} kg`
}

interface Tip { x: number; y: number; title: string; value: string }

function TooltipBox({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null
  const flip = tip.x > width - 150
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-md border bg-white px-2.5 py-1.5 shadow-md text-xs whitespace-nowrap"
      style={{ left: tip.x, top: tip.y, transform: `translate(${flip ? 'calc(-100% - 10px)' : '10px'}, -50%)` }}
    >
      <p className="text-muted-foreground">{tip.title}</p>
      <p className="font-semibold tabular-nums">{tip.value}</p>
    </div>
  )
}

/** Available stock falling at the 12-month rate, read as a decision:
 *  Commander (the stock reaches the minimum) → livraison (délai) → marge. A
 *  minimum that fits makes the line reach zero only after the margin band;
 *  one too low hits « Rupture » inside the delivery window. */
function ProjectionChart({ p }: { p: Projection }) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const [hoverW, setHoverW] = useState<number | null>(null)
  const W = size.w
  const H = CHART_H
  const rate = p.rate
  const start = Math.max(0, p.disponible)
  const cover = p.couverture ?? 0
  const orderW = p.avantMini
  const delai = p.delai ?? 0
  const arrivee = p.arrivee
  const marge = p.marge
  const ruptureAvantLivraison = p.margeReelle != null && p.margeReelle < 0
  const ruptureSansCommande = p.mini <= 0

  // Horizon: past the run-out and the end of the margin, at least 6 months.
  const lastDelivery = p.livraisons.reduce((m, l) => Math.max(m, l.arriveeW), 0)
  const horizon = Math.min(104, Math.max(26, Math.ceil(Math.max(cover, (arrivee ?? 0) + marge, lastDelivery + 6) + 4)))
  const rayonMax = p.livraisons.length ? Math.max(...p.rayon.points.filter(([w]) => w <= horizon).map(([, kg]) => kg)) : 0
  const scale = niceScale(0, Math.max(start, p.mini, rayonMax) * 1.05)
  const innerW = Math.max(0, W - PAD.left - PAD.right)
  const innerH = H - PAD.top - PAD.bottom
  const x = (w: number) => PAD.left + (innerW * Math.min(w, horizon)) / horizon
  const y = (kg: number) => PAD.top + innerH - (innerH * (kg - scale.lo)) / (scale.hi - scale.lo || 1)
  const kgAt = (w: number) => Math.max(0, start - rate * w)

  const today = new Date()
  const dateAt = (w: number) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    d.setDate(d.getDate() + Math.round(w * 7))
    return d
  }
  // Month ticks: the 1st of each month inside the horizon, thinned to fit.
  const monthTicks = useMemo(() => {
    const out: { w: number; label: string }[] = []
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    for (let i = 1; i <= 30; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() + i, 1)
      const w = (d.getTime() - base) / (7 * 86_400_000)
      if (w > horizon) break
      out.push({ w, label: `${MOIS_COURTS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}` })
    }
    const every = Math.max(1, Math.ceil(out.length / Math.max(1, Math.floor(innerW / 70))))
    return out.filter((_, i) => i % every === 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horizon, innerW])

  const runOut = Math.min(cover, horizon)
  const line = `M ${x(0)} ${y(start)} L ${x(runOut)} ${y(kgAt(runOut))} L ${x(horizon)} ${y(kgAt(horizon))}`
  const tip: Tip | null = hoverW == null ? null : {
    x: x(hoverW),
    y: y(kgAt(hoverW)),
    title: dateAt(hoverW).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }),
    value: `${fmtNum(kgAt(hoverW), 0)} kg disponibles`,
  }
  const livraison = orderW != null && arrivee != null ? { x: x(orderW), w: Math.max(0, x(arrivee) - x(orderW)) } : null
  const margeBand = arrivee != null ? { x: x(arrivee), w: Math.max(0, x(arrivee + marge) - x(arrivee)) } : null

  return (
    <div ref={ref} className="relative w-full" style={{ height: H }}>
      {W > 0 && (
        <svg width={W} height={H} className="block">
          {/* Grid + y ticks */}
          {scale.ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="text-border" stroke="currentColor" strokeWidth={1} />
              <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">{kgTick(t)}</text>
            </g>
          ))}
          {monthTicks.map((t) => (
            <text key={t.w} x={x(t.w)} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">{t.label}</text>
          ))}

          {/* Under the minimum: the zone to stay out of */}
          {p.mini > 0 && (
            <rect x={PAD.left} y={y(p.mini)} width={innerW} height={Math.max(0, y(0) - y(p.mini))} className="text-destructive" fill="currentColor" opacity={0.05} />
          )}

          {/* Delivery window, then the safety margin */}
          {livraison && orderW != null && arrivee != null && delai > 0 && orderW < horizon && (
            <g>
              <rect x={livraison.x} width={livraison.w} y={PAD.top} height={innerH} className="text-accent" fill="currentColor" opacity={0.1} />
              <text x={x((orderW + arrivee) / 2)} y={PAD.top + 10} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                livraison ({delai} sem.)
              </text>
              {margeBand && arrivee < horizon && (
                <>
                  <rect x={margeBand.x} width={margeBand.w} y={PAD.top} height={innerH} className="text-amber-500" fill="currentColor" opacity={0.16} />
                  <text x={x(arrivee + marge / 2)} y={PAD.top + 22} textAnchor="middle" className="fill-amber-700 text-[10px] font-medium">
                    marge
                  </text>
                </>
              )}
            </g>
          )}

          {/* Minimum */}
          {p.mini > 0 && (
            <g>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(p.mini)} y2={y(p.mini)} className="text-destructive" stroke="currentColor" strokeWidth={1.5} strokeDasharray="5 4" />
              <text x={W - PAD.right} y={y(p.mini) - 5} textAnchor="end" className="fill-destructive text-[10px] font-medium">
                Stock mini {fmtNum(p.mini, 0)} kg
              </text>
            </g>
          )}

          {/* Order date */}
          {orderW != null && orderW > 0 && orderW <= horizon && (
            <g>
              <line x1={x(orderW)} x2={x(orderW)} y1={PAD.top} y2={y(0)} className="text-amber-600" stroke="currentColor" strokeWidth={1.5} />
              <text x={x(orderW) - 4} y={y(0) - 6} textAnchor="end" className="fill-amber-700 text-[10px] font-medium">Commander</text>
            </g>
          )}

          {/* Shelf stock with the pending deliveries (only when there are some) */}
          {p.livraisons.length > 0 && (
            <g>
              <path
                d={p.rayon.points.filter(([w]) => w <= horizon).map(([w, kg], i) => `${i ? 'L' : 'M'} ${x(w)} ${y(kg)}`).join(' ')}
                fill="none" className="text-teal-600" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" opacity={0.85}
              />
              {p.livraisons.filter((l) => l.arriveeW <= horizon).map((l) => {
                // The level just after the step: the last point at that week.
                const at = Math.min(Math.max(0, l.arriveeW), HORIZON_SIMULATION)
                const after = [...p.rayon.points].reverse().find(([w]) => w === at)
                const ky = after ? y(after[1]) : y(0)
                return (
                  <g key={l.idref_fil_commande}>
                    <circle cx={x(l.arriveeW)} cy={ky} r={4} className="text-teal-600" fill="currentColor" stroke="#fff" strokeWidth={2} />
                    <text x={x(l.arriveeW) + 6} y={ky - 6} className="fill-teal-700 text-[10px] font-medium">
                      N°{l.idcommande_fil} +{fmtNum(l.reste_kg, 0)} kg
                    </text>
                  </g>
                )
              })}
              {p.rayon.verdicts.filter((v) => v.ruptureW != null && v.ruptureW <= horizon).map((v) => (
                <g key={'r' + v.id}>
                  <circle cx={x(v.ruptureW!)} cy={y(0)} r={5} className="text-destructive" fill="currentColor" stroke="#fff" strokeWidth={2} />
                  <text x={x(v.ruptureW!)} y={y(0) - 10} textAnchor="middle" className="fill-destructive text-[10px] font-semibold">Rayon vide</text>
                </g>
              ))}
            </g>
          )}

          {/* The projection */}
          <path d={line} fill="none" className="text-primary" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
          <circle cx={x(0)} cy={y(start)} r={4} className="text-primary" fill="currentColor" stroke="#fff" strokeWidth={2} />

          {/* Rupture — only when nothing arrives before it */}
          {(ruptureAvantLivraison || ruptureSansCommande) && cover <= horizon && (
            <g>
              <circle cx={x(cover)} cy={y(0)} r={5} className="text-destructive" fill="currentColor" stroke="#fff" strokeWidth={2} />
              <text x={x(cover)} y={y(0) - 10} textAnchor="middle" className="fill-destructive text-[10px] font-semibold">Rupture</text>
            </g>
          )}

          {/* Crosshair */}
          {hoverW != null && (
            <g>
              <line x1={x(hoverW)} x2={x(hoverW)} y1={PAD.top} y2={y(0)} className="text-muted-foreground" stroke="currentColor" strokeWidth={1} opacity={0.5} />
              <circle cx={x(hoverW)} cy={y(kgAt(hoverW))} r={4} className="text-primary" fill="currentColor" stroke="#fff" strokeWidth={2} />
            </g>
          )}
          <rect
            x={PAD.left} y={PAD.top} width={innerW} height={innerH} fill="transparent"
            onMouseMove={(e) => {
              const r = (e.currentTarget as SVGRectElement).getBoundingClientRect()
              setHoverW(Math.max(0, Math.min(horizon, ((e.clientX - r.left) / r.width) * horizon)))
            }}
            onMouseLeave={() => setHoverW(null)}
          />
        </svg>
      )}
      <TooltipBox tip={tip} width={W} />
    </div>
  )
}

/** 24 months of knitted kilos; the running month drawn lighter. */
function MonthlyChart({ c }: { c: ConsoColoris }) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const W = size.w
  const H = CHART_H
  const months = c.mensuel
  const avgMonth = (c.kg_semaine_12m * 365.25) / 7 / 12
  const scale = niceScale(0, Math.max(avgMonth, ...months.map((m) => m.kg)))
  const innerW = Math.max(0, W - PAD.left - PAD.right)
  const innerH = H - PAD.top - PAD.bottom
  const slot = innerW / Math.max(1, months.length)
  const barW = Math.max(2, slot - 2) // 2px surface gap between bars
  const y = (kg: number) => PAD.top + innerH - (innerH * kg) / (scale.hi || 1)
  const labelEvery = slot < 22 ? 3 : slot < 34 ? 2 : 1

  const tip: Tip | null = hover == null ? null : {
    x: PAD.left + slot * hover + slot / 2,
    y: Math.min(y(months[hover].kg), y(0) - 20),
    title: `${moisLabel(months[hover].mois, true)}${months[hover].partiel ? ' (en cours)' : ''}`,
    value: `${fmtNum(months[hover].kg, 0)} kg tricotés`,
  }

  return (
    <div ref={ref} className="relative w-full" style={{ height: H }}>
      {W > 0 && (
        <svg width={W} height={H} className="block">
          {scale.ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="text-border" stroke="currentColor" strokeWidth={1} />
              <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">{kgTick(t)}</text>
            </g>
          ))}
          {months.map((m, i) => {
            const bx = PAD.left + slot * i + (slot - barW) / 2
            const top = y(m.kg)
            const h = Math.max(0, y(0) - top)
            const r = Math.min(4, barW / 2, h)
            // Rounded data end, square on the baseline.
            const d = h > 0
              ? `M ${bx} ${y(0)} V ${top + r} Q ${bx} ${top} ${bx + r} ${top} H ${bx + barW - r} Q ${bx + barW} ${top} ${bx + barW} ${top + r} V ${y(0)} Z`
              : ''
            return (
              <g key={m.mois}>
                {d && (
                  <path d={d} className="text-accent" fill="currentColor" opacity={m.partiel ? 0.4 : hover == null || hover === i ? 1 : 0.55} />
                )}
                {i % labelEvery === 0 && (
                  <text x={bx + barW / 2} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                    {moisLabel(m.mois)}
                  </text>
                )}
                <rect
                  x={PAD.left + slot * i} y={PAD.top} width={slot} height={innerH} fill="transparent"
                  onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                />
              </g>
            )
          })}
          {/* 12-month average */}
          {avgMonth > 0 && (
            <g className="pointer-events-none">
              <line x1={PAD.left} x2={W - PAD.right} y1={y(avgMonth)} y2={y(avgMonth)} className="text-primary" stroke="currentColor" strokeWidth={1.5} strokeDasharray="5 4" />
              <text x={W - PAD.right} y={y(avgMonth) - 5} textAnchor="end" className="fill-primary text-[10px] font-medium">
                moyenne {fmtNum(avgMonth, 0)} kg/mois
              </text>
            </g>
          )}
        </svg>
      )}
      <TooltipBox tip={tip} width={W} />
    </div>
  )
}
