import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle, ArrowDown, ArrowUp, BadgeEuro, CheckCircle2, ClipboardCheck, Clock, Info, Leaf, Loader2, Package, Recycle, Sparkles, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SearchableCombobox } from '@/components/ui/popover-select'
import { FiniRollIcon } from '@/components/icons/FiniRollIcon'
import { KnitIcon } from '@/components/icons/KnitIcon'
import { CardKV, MobileSortRow } from '@/components/stock/StockCardParts'
import {
  SmartSearchInput,
  filterRowsByChips,
  type SearchChip,
  type SearchTagDef,
} from '@/components/stock/SmartSearchInput'
import { useMediaQuery, MD_UP } from '@/hooks/useMediaQuery'
import { apiFetch } from '@/lib/api'
import { STOCK_QUERY_FRESHNESS } from '@/lib/cache-sync'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'

// Finis › Stock potentiel — what Malterre can deliver from free stock, built
// for the phone call with a client (Isabelle, 2026-10-22): fini rolls on hand
// (Dispo = validé only, the rest À valider), free écru to dye or wash (À
// ennoblir), free yarn to knit (À tricoter). One line = a quantity of a
// reference, not a roll. Rules in the API's lib/stock-potentiel.ts. ⚠️ The
// potential lines are « jusqu'à »: one écru or yarn feeds several references,
// so they are never totalled. A click opens the reference's catalogue price.

type Statut = 'dispo' | 'a_valider' | 'a_ennoblir' | 'a_tricoter'

interface LignePotentiel {
  key: string
  statut: Statut
  idref_fini: number
  reference: string
  designation: string | null
  grammage: number | null
  contexture: string | null
  bio: boolean
  recycle: boolean
  coloris: string | null
  idcoloris: number | null
  tous_coloris: boolean
  second_choix: boolean
  ecru: string | null
  metrage: number | null
  poids: number
  pieces: number | null
  limite: string | null
  repartition: Record<string, number>
}

// Lead times quoted on the phone (Vincent, 2026-10-22): indicative, from the
// order to the goods ready to leave.
const STATUT_META: Record<Statut, { label: string; className: string; icon: React.ElementType; ordre: number; delai: string }> = {
  dispo: { label: 'Dispo', className: 'bg-emerald-100 text-emerald-800 border-emerald-200', icon: CheckCircle2, ordre: 0, delai: 'Immédiat' },
  a_valider: { label: 'À valider', className: 'bg-zinc-100 text-zinc-700 border-zinc-300', icon: ClipboardCheck, ordre: 1, delai: 'Après contrôle' },
  a_ennoblir: { label: 'À ennoblir', className: 'bg-sky-500/10 text-sky-700 border-sky-500/25', icon: Sparkles, ordre: 2, delai: '≈ 4 semaines' },
  a_tricoter: { label: 'À tricoter', className: 'bg-amber-500/15 text-amber-800 border-amber-500/30', icon: KnitIcon, ordre: 3, delai: '≈ 5 semaines' },
}
const STATUTS: Statut[] = ['dispo', 'a_valider', 'a_ennoblir', 'a_tricoter']

function StatutPill({ statut, children }: { statut: Statut; children?: React.ReactNode }) {
  const m = STATUT_META[statut]
  const Icon = m.icon
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', m.className)}>
      <Icon className="h-3 w-3" />{m.label}{children}
    </span>
  )
}

/** Same chip as the Finis › Stock drawer: 2nd choice is announced to the client. */
function SecondChoixBadge() {
  return (
    <span className="inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-medium bg-red-100 text-red-700 border-red-200 whitespace-nowrap">
      2ᵉ choix
    </span>
  )
}

// Certification badges, as Fils › Stock draws them (the écru's flags).
function BioBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium bg-green-100 text-green-700 border-green-200 whitespace-nowrap">
      <Leaf className="h-3 w-3" />Bio
    </span>
  )
}
function RecycleBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium bg-blue-100 text-blue-700 border-blue-200 whitespace-nowrap">
      <Recycle className="h-3 w-3" />Recyclé
    </span>
  )
}

const SEARCH_FIELDS = [
  { key: 'reference', label: 'Référence' },
  { key: 'coloris', label: 'Coloris' },
  { key: 'contexture', label: 'Contexture' },
  { key: 'grammage', label: 'Poids/m²' },
  { key: 'limite', label: 'Fil limitant' },
] as const
type SearchFieldKey = (typeof SEARCH_FIELDS)[number]['key']

// Poids/m² comparisons: « 160 » / « =160 », « >=200 » (≥), « <=150 » (≤),
// « >200 », « <200 », « 150-200 » (inclusive). In free text only the forms
// with an operator or a range count — a bare number still searches every
// column (a reference like « 160A »). Returns null when it is not one.
function filtreGrammage(term: string, nombreSeul: boolean): ((g: number) => boolean) | null {
  const t = term.replace(/\s+/g, '').replace(',', '.').replace('≥', '>=').replace('≤', '<=')
  const range = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(t)
  if (range) {
    const [lo, hi] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b)
    return (g) => g >= lo && g <= hi
  }
  const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)?)$/.exec(t)
  if (!m || (!m[1] && !nombreSeul)) return null
  const v = Number(m[2])
  switch (m[1]) {
    case '>=': return (g) => g >= v
    case '<=': return (g) => g <= v
    case '>': return (g) => g > v
    case '<': return (g) => g < v
    default: return (g) => g === v
  }
}

const passeGrammage = (l: { grammage: number | null }, f: (g: number) => boolean) => l.grammage != null && f(l.grammage)

type SortKey = 'statut' | 'reference' | 'designation' | 'contexture' | 'grammage' | 'coloris' | 'metrage' | 'poids' | 'delai' | 'detail'
const COLUMNS: { key: SortKey; label: string; width: string; align?: 'right' }[] = [
  { key: 'statut', label: 'Statut', width: '8%' },
  { key: 'reference', label: 'Référence', width: '6%' },
  { key: 'coloris', label: 'Coloris', width: '15%' },
  { key: 'contexture', label: 'Contexture', width: '9%' },
  { key: 'designation', label: 'Désignation', width: '12%' },
  { key: 'grammage', label: 'Poids/m²', width: '6%', align: 'right' },
  { key: 'metrage', label: 'Métrage', width: '10%', align: 'right' },
  { key: 'poids', label: 'Poids', width: '7%', align: 'right' },
  { key: 'delai', label: 'Délai', width: '8%' },
  { key: 'detail', label: 'Détail', width: '19%' },
]

const colorisLabel = (l: LignePotentiel) => (l.tous_coloris ? 'Tous coloris' : l.coloris || '—')
const metrageLabel = (l: LignePotentiel) =>
  l.metrage != null ? `${l.statut === 'dispo' || l.statut === 'a_valider' ? '' : 'jusqu’à '}${fmtNum(l.metrage, 1)} Ml` : '—'

function detailLabel(l: LignePotentiel): string {
  if (l.statut === 'a_tricoter') return l.limite ? `limité par ${l.limite}` : ''
  if (l.pieces == null) return ''
  if (l.statut === 'dispo') return `${l.pieces} rouleau${l.pieces > 1 ? 'x' : ''}`
  if (l.statut === 'a_valider') {
    const parEtat = Object.entries(l.repartition).map(([etat, n]) => `${n} ${etat}`).join(', ')
    return `${l.pieces} rouleau${l.pieces > 1 ? 'x' : ''}${parEtat ? ` : ${parEtat}` : ''}`
  }
  const deuxieme = l.repartition['2e choix'] ?? 0
  return `${l.pieces} pièce${l.pieces > 1 ? 's' : ''} écru${deuxieme > 0 ? ` dont ${deuxieme} en 2ᵉ choix` : ''}`
}

function compare(a: LignePotentiel, b: LignePotentiel, key: SortKey): number {
  switch (key) {
    case 'statut':
    case 'delai':
      return STATUT_META[a.statut].ordre - STATUT_META[b.statut].ordre || (b.metrage ?? 0) - (a.metrage ?? 0)
    case 'metrage': return (a.metrage ?? -1) - (b.metrage ?? -1)
    case 'poids': return a.poids - b.poids
    case 'grammage': return (a.grammage ?? -1) - (b.grammage ?? -1)
    case 'coloris': return colorisLabel(a).localeCompare(colorisLabel(b), 'fr')
    case 'detail': return detailLabel(a).localeCompare(detailLabel(b), 'fr')
    default: return String(a[key] ?? '').localeCompare(String(b[key] ?? ''), 'fr', { numeric: true })
  }
}

const haystacks = (l: LignePotentiel) =>
  [l.reference, l.designation, l.contexture, colorisLabel(l), l.ecru, l.limite, STATUT_META[l.statut].label,
    l.second_choix ? '2e choix' : null, l.bio ? 'bio' : null, l.recycle ? 'recyclé' : null]
    .filter((s): s is string => !!s)
    .map((s) => s.toLowerCase())

export function FinisStockPotentiel() {
  const isMdUp = useMediaQuery(MD_UP)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchChips, setSearchChips] = useState<SearchChip<SearchFieldKey>[]>([])
  const [activeTags, setActiveTags] = useState<string[]>([])
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'statut', dir: 'asc' })
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const deferredSearch = useDeferredValue(searchQuery)

  const { data: rows, isLoading, isError, error } = useQuery<LignePotentiel[]>({
    queryKey: ['stock-fini', 'potentiel'],
    queryFn: () => apiFetch<LignePotentiel[]>('/stock/potentiel'),
    ...STOCK_QUERY_FRESHNESS,
  })

  const tags = useMemo<SearchTagDef<LignePotentiel>[]>(
    () => [
      ...STATUTS.map((s): SearchTagDef<LignePotentiel> => ({
        key: s,
        label: STATUT_META[s].label,
        renderPill: (trailing) => <StatutPill statut={s}>{trailing}</StatutPill>,
        count: (rows ?? []).filter((r) => r.statut === s).length,
        predicate: (r) => r.statut === s,
      })),
      {
        key: 'bio', label: 'Bio',
        renderPill: (trailing) => <span className="inline-flex">{<BioBadge />}{trailing}</span>,
        count: (rows ?? []).filter((r) => r.bio).length,
        predicate: (r) => r.bio,
      },
      {
        key: 'recycle', label: 'Recyclé',
        renderPill: (trailing) => <span className="inline-flex">{<RecycleBadge />}{trailing}</span>,
        count: (rows ?? []).filter((r) => r.recycle).length,
        predicate: (r) => r.recycle,
      },
    ],
    [rows],
  )

  const visible = useMemo(() => {
    // A line has one status: several status tags are an OR; Bio / Recyclé AND.
    const statutsActifs = activeTags.filter((t): t is Statut => (STATUTS as string[]).includes(t))
    let out = statutsActifs.length > 0 ? (rows ?? []).filter((r) => statutsActifs.includes(r.statut)) : rows ?? []
    if (activeTags.includes('bio')) out = out.filter((r) => r.bio)
    if (activeTags.includes('recycle')) out = out.filter((r) => r.recycle)
    // A Poids/m² chip compares numbers; an unreadable one matches nothing.
    for (const chip of searchChips.filter((c) => c.field === 'grammage')) {
      const f = filtreGrammage(chip.value, true)
      out = f ? out.filter((r) => passeGrammage(r, f)) : []
    }
    out = filterRowsByChips(out, searchChips.filter((c) => c.field !== 'grammage'), haystacks)
    // « >= 200 » typed with a space is still one term.
    const terms = deferredSearch.trim().toLowerCase().replace(/([<>=≤≥]=?)\s+(?=\d)/g, '$1').split(/\s+/).filter(Boolean)
    for (const t of terms) {
      const f = filtreGrammage(t, false)
      out = f ? out.filter((r) => passeGrammage(r, f)) : out.filter((r) => haystacks(r).some((x) => x.includes(t)))
    }
    return [...out].sort((a, b) => (sort.dir === 'asc' ? 1 : -1) * compare(a, b, sort.key))
  }, [rows, activeTags, searchChips, deferredSearch, sort])

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'metrage' || key === 'poids' ? 'desc' : 'asc' }))
  }, [])

  const handleRowClick = useCallback((key: string) => setSelectedKey((prev) => (prev === key ? null : key)), [])
  const handleClose = useCallback(() => setSelectedKey(null), [])
  const selected = useMemo(() => (rows ?? []).find((r) => r.key === selectedKey) ?? null, [rows, selectedKey])

  // Only the real stock adds up; the potential lines overlap.
  const dispo = visible.filter((l) => l.statut === 'dispo')
  const dispoMl = dispo.reduce((s, l) => s + (l.metrage ?? 0), 0)
  const dispoKg = dispo.reduce((s, l) => s + l.poids, 0)
  const avecPotentiel = visible.some((l) => l.statut === 'a_ennoblir' || l.statut === 'a_tricoter')

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      <div className="flex-shrink-0 flex flex-wrap items-center gap-3">
        <SmartSearchInput<SearchFieldKey, LignePotentiel>
          className="flex-1 min-w-0"
          value={searchQuery}
          onValueChange={setSearchQuery}
          chips={searchChips}
          onChipsChange={setSearchChips}
          fields={SEARCH_FIELDS}
          tags={tags}
          activeTags={activeTags}
          onActiveTagsChange={setActiveTags}
          placeholder="Rechercher (réf, contexture, coloris, bio, recyclé… ou poids/m² : >=200, <=150, 150-200)"
        />
      </div>

      <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border/60 bg-white shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
        ) : isError ? (
          <div className="flex-1 flex items-center justify-center gap-2 text-destructive text-sm">
            <AlertCircle className="h-4 w-4" />{(error as Error)?.message ?? 'Erreur de chargement'}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
            <FiniRollIcon className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucune ligne</p>
          </div>
        ) : (
          <>
            <div className="hidden md:flex md:flex-col flex-1 min-h-0">
              <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
                <colgroup>{COLUMNS.map((c) => <col key={c.key} style={{ width: c.width }} />)}</colgroup>
                <thead className="bg-zinc-200/60 border-b border-border/60">
                  <tr className="text-xs text-muted-foreground">
                    {COLUMNS.map((c) => (
                      <th
                        key={c.key}
                        onClick={() => handleSort(c.key)}
                        className={cn('px-2 py-2 font-semibold cursor-pointer select-none', c.align === 'right' ? 'text-right' : 'text-left', sort.key === c.key && 'text-accent')}
                      >
                        {c.label}
                        {sort.key === c.key && (sort.dir === 'asc'
                          ? <ArrowUp className="inline-block h-3 w-3 ml-1 align-middle" />
                          : <ArrowDown className="inline-block h-3 w-3 ml-1 align-middle" />)}
                      </th>
                    ))}
                  </tr>
                </thead>
              </table>
              <div className="flex-1 min-h-0 overflow-auto scrollbar-transparent">
                <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
                  <colgroup>{COLUMNS.map((c) => <col key={c.key} style={{ width: c.width }} />)}</colgroup>
                  <tbody>
                    {isMdUp && visible.map((l) => (
                      <tr
                        key={l.key}
                        data-stock-row
                        onClick={() => handleRowClick(l.key)}
                        className={cn('border-b border-border/40 cursor-pointer transition-colors', l.key === selectedKey ? 'bg-accent/10' : 'hover:bg-accent/5')}
                      >
                        <td className="px-2 py-2"><StatutPill statut={l.statut} /></td>
                        <td className="px-2 py-2 font-medium">
                          <div className="flex items-center gap-1 min-w-0">
                            <span className="truncate">{l.reference}</span>
                            {l.bio && <Leaf className="h-3.5 w-3.5 flex-shrink-0 text-green-600" aria-label="Bio" />}
                            {l.recycle && <Recycle className="h-3.5 w-3.5 flex-shrink-0 text-blue-600" aria-label="Recyclé" />}
                          </div>
                        </td>
                        <td className="px-2 py-2" title={colorisLabel(l)}>
                          <div className="flex items-center gap-1 min-w-0">
                            <span className={cn('truncate', l.tous_coloris && 'italic text-muted-foreground')}>{colorisLabel(l)}</span>
                            {l.second_choix && <SecondChoixBadge />}
                          </div>
                        </td>
                        <td className="px-2 py-2 truncate" title={l.contexture ?? undefined}>{l.contexture || '—'}</td>
                        <td className="px-2 py-2 truncate" title={l.designation ?? undefined}>{l.designation || '—'}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{l.grammage != null ? `${fmtNum(l.grammage)} g/m²` : '—'}</td>
                        <td className="px-2 py-2 text-right tabular-nums font-semibold">{metrageLabel(l)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{fmtNum(l.poids, 1)} kg</td>
                        <td className="px-2 py-2 truncate">{STATUT_META[l.statut].delai}</td>
                        <td className="px-2 py-2 truncate text-muted-foreground" title={detailLabel(l)}>{detailLabel(l)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="md:hidden flex-1 min-h-0 flex flex-col">
              <MobileSortRow columns={COLUMNS} sort={sort} onSortChange={setSort} />
              <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent p-2 space-y-2 bg-zinc-100/80">
                {!isMdUp && visible.map((l) => (
                  <div
                    key={l.key}
                    data-stock-row
                    onClick={() => handleRowClick(l.key)}
                    className={cn(
                      'rounded-lg border p-3 cursor-pointer transition-colors shadow-sm',
                      l.key === selectedKey ? 'bg-accent/10 border-accent ring-1 ring-accent' : 'bg-white border-border/60 hover:border-accent/40',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium truncate">{l.reference} · {colorisLabel(l)}</p>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {l.bio && <Leaf className="h-3.5 w-3.5 text-green-600" />}
                        {l.recycle && <Recycle className="h-3.5 w-3.5 text-blue-600" />}
                        {l.second_choix && <SecondChoixBadge />}
                        <StatutPill statut={l.statut} />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{l.designation || '—'}</p>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <CardKV label="Métrage" value={metrageLabel(l)} mono strong />
                      <CardKV label="Poids" value={`${fmtNum(l.poids, 1)} kg`} mono />
                      <CardKV label="Contexture" value={l.contexture || '—'} />
                      <CardKV label="Poids/m²" value={l.grammage != null ? `${fmtNum(l.grammage)} g/m²` : '—'} mono />
                      <CardKV label="Délai" value={STATUT_META[l.statut].delai} />
                      <CardKV label="Détail" value={detailLabel(l) || '—'} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {!isLoading && !isError && visible.length > 0 && (
        <div className="flex-shrink-0 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-zinc-100/80 shadow-sm px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm">
            <Package className="h-4 w-4 text-accent" />
            <span className="font-semibold">{visible.length}</span>
            <span className="text-muted-foreground">ligne{visible.length > 1 ? 's' : ''}</span>
            {avecPotentiel && (
              <span className="hidden sm:inline-flex items-center gap-1 text-xs text-muted-foreground ml-2">
                <Info className="h-3.5 w-3.5" />
                À ennoblir / à tricoter : « jusqu'à », un même écru ou fil sert plusieurs références — ne s'additionnent pas
              </span>
            )}
          </div>
          {dispo.length > 0 && (
            <div className="flex items-center gap-3 sm:gap-5 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground hidden sm:inline">Dispo</span>
              <span className="font-semibold tabular-nums text-sm sm:text-base">{fmtNum(dispoKg, 1)} kg</span>
              <span className="border-l border-border/60 pl-3 sm:pl-5 font-semibold tabular-nums text-sm sm:text-base">{fmtNum(dispoMl, 1)} Ml</span>
            </div>
          )}
        </div>
      )}

      <PotentielDrawer ligne={selected} onClose={handleClose} />
    </div>
  )
}

// ── Drawer: the line + the reference's catalogue price ────────────────────

interface ColorisRef { id: number; reference: string | null; teinture?: string | null }
interface RefFiniDetail { IDref_fini: number; coloris: ColorisRef[] }
interface TarifTranche { rolls: number; isMetrage: boolean; qte_ml: number; moPrixDeVenteAuMl: number; moPrixDeVenteAuKg: number }
interface TarifResult { rendement: number; ref_ecru: unknown | null; tranches: TarifTranche[] }

function PotentielDrawer({ ligne, onClose }: { ligne: LignePotentiel | null; onClose: () => void }) {
  const [searchParams] = useSearchParams()
  const embed = searchParams.get('embed') === 'true'
  const drawerRef = useRef<HTMLDivElement>(null)
  const open = ligne !== null
  // The line's own coloris; « Tous coloris » lines pick one (the price
  // depends on the dye).
  const [colorisChoisi, setColorisChoisi] = useState(0)
  useEffect(() => { setColorisChoisi(0) }, [ligne?.key])
  // Clicked tranche; -1 = the line's own (the default).
  const [trancheChoisie, setTrancheChoisie] = useState(-1)

  useEffect(() => {
    if (!open) return
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node | null
      if (!target) return
      if (drawerRef.current?.contains(target)) return
      // Rows and cards switch the selection themselves.
      if ((target as Element).closest?.('[data-stock-row]')) return
      onClose()
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [open, onClose])

  const choixLibre = !!ligne && ligne.idcoloris == null
  const { data: detail } = useQuery<RefFiniDetail>({
    queryKey: ['ref-fini', ligne?.idref_fini],
    queryFn: () => apiFetch<RefFiniDetail>(`/references-fini/${ligne!.idref_fini}`),
    enabled: choixLibre,
  })
  const colorisId = ligne?.idcoloris ?? (colorisChoisi || detail?.coloris[0]?.id || 0)
  const { data: tarif, isLoading: tarifLoading, isError: tarifError } = useQuery<TarifResult>({
    queryKey: ['ref-fini-tarif', ligne?.idref_fini, colorisId],
    queryFn: () => apiFetch<TarifResult>(`/references-fini/${ligne!.idref_fini}/tarif?coloris=${colorisId}`),
    enabled: !!ligne && colorisId > 0,
  })

  // The tranche the line's whole quantity falls in: the largest one it reaches.
  const tranches = tarif?.tranches ?? []
  let trancheLigne = -1
  if (ligne?.metrage != null) tranches.forEach((t, i) => { if (!t.isMetrage && t.qte_ml <= ligne.metrage!) trancheLigne = i })
  useEffect(() => { setTrancheChoisie(-1) }, [ligne?.key, colorisId])
  const selection = trancheChoisie >= 0 && trancheChoisie < tranches.length ? trancheChoisie : trancheLigne
  const tSel = selection >= 0 ? tranches[selection] : null
  // The amount quoted: the whole line on its own tranche, else the clicked tranche's quantity.
  const qteSel = tSel ? (selection === trancheLigne && ligne?.metrage != null ? ligne.metrage : tSel.qte_ml) : 0

  return (
    <div
      ref={drawerRef}
      className={cn(
        'fixed right-0 bottom-0 w-full max-w-[440px] bg-white border-l border-border/60 shadow-xl z-30 transition-transform duration-300 flex flex-col',
        embed ? 'top-0' : 'top-14',
        open ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      {ligne && (
        <div className="flex-1 min-h-0 flex flex-col bg-zinc-100/80">
          <div className="flex-shrink-0 flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5">
            <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
              <FiniRollIcon className="h-[18px] w-[18px]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">
                  {ligne.reference} · {colorisLabel(ligne)}
                </h2>
                <StatutPill statut={ligne.statut} />
                {ligne.bio && <BioBadge />}
                {ligne.recycle && <RecycleBadge />}
                {ligne.second_choix && <SecondChoixBadge />}
              </div>
              <p className="text-xs text-white/70 truncate">
                {[ligne.designation, ligne.contexture, ligne.grammage != null ? `${fmtNum(ligne.grammage)} g/m²` : null].filter(Boolean).join(' · ') || '—'}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 md:hidden text-white/80 hover:bg-white/15 hover:text-white"
              title="Fermer"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3 scrollbar-transparent">
            <DrawerCard icon={<Clock className="h-4 w-4 text-accent" />} title="Disponibilité">
              <div className="space-y-1">
                <KV label="Métrage" value={metrageLabel(ligne)} mono />
                <KV label="Poids" value={`${fmtNum(ligne.poids, 1)} kg`} mono />
                <KV label="Délai" value={STATUT_META[ligne.statut].delai} />
                {ligne.ecru && <KV label="Écru" value={ligne.ecru} />}
                {detailLabel(ligne) && <KV label="Détail" value={detailLabel(ligne)} />}
              </div>
              {(ligne.statut === 'a_ennoblir' || ligne.statut === 'a_tricoter') && (
                <p className="mt-2 text-[11px] text-muted-foreground italic">
                  « Jusqu’à » : le même écru ou fil sert d’autres références. Rien n’est réservé tant que la commande n’est pas saisie.
                </p>
              )}
            </DrawerCard>

            <DrawerCard icon={<BadgeEuro className="h-4 w-4 text-accent" />} title="Prix catalogue">
              {choixLibre && (
                <div className="mb-2">
                  {detail && detail.coloris.length > 0 ? (
                    <SearchableCombobox<ColorisRef>
                      options={detail.coloris}
                      value={colorisId}
                      onChange={setColorisChoisi}
                      getId={(c) => c.id}
                      getPrimary={(c) => c.reference ?? `#${c.id}`}
                      getSecondary={(c) => c.teinture ?? undefined}
                      placeholder="Coloris"
                    />
                  ) : detail ? (
                    <p className="text-xs text-muted-foreground italic">Aucun coloris sur la référence.</p>
                  ) : null}
                  <p className="mt-1 text-[11px] text-muted-foreground">Le prix dépend de la teinture : choisissez le coloris demandé.</p>
                </div>
              )}
              {colorisId <= 0 ? (
                detail || !choixLibre ? <p className="text-sm text-muted-foreground italic">Pas de coloris : tarif indisponible.</p> : null
              ) : tarifLoading ? (
                <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-accent" /></div>
              ) : tarifError ? (
                <p className="text-sm text-destructive">Erreur lors du calcul du tarif.</p>
              ) : tranches.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">
                  {tarif && !(tarif.rendement > 0) ? 'Rendement non défini sur la référence — tarif indisponible.' : 'Tarif indisponible pour ce coloris.'}
                </p>
              ) : (
                <>
                  <div className="rounded-md border border-border/60 overflow-hidden">
                    <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
                      <colgroup>
                        <col style={{ width: '46%' }} />
                        <col style={{ width: '27%' }} />
                        <col style={{ width: '27%' }} />
                      </colgroup>
                      <thead className="bg-zinc-100/80 border-b border-border/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-2.5 py-1.5 text-left font-semibold">Quantité</th>
                          <th className="px-2.5 py-1.5 text-right font-semibold">€/Ml</th>
                          <th className="px-2.5 py-1.5 text-right font-semibold">€/Kg</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tranches.map((t, i) => (
                          <tr
                            key={i}
                            onClick={() => setTrancheChoisie(i)}
                            className={cn(
                              'border-b border-border/40 last:border-b-0 cursor-pointer transition-colors',
                              i === selection ? 'bg-accent/10 font-semibold' : 'hover:bg-accent/5',
                            )}
                          >
                            <td className="px-2.5 py-1.5 tabular-nums">
                              {t.isMetrage ? `< 1 rouleau` : `${t.rolls} rouleau${t.rolls > 1 ? 'x' : ''}`}
                              <span className="text-muted-foreground font-normal"> · {t.isMetrage ? '< ' : ''}{fmtNum(t.qte_ml)} Ml</span>
                              {i === trancheLigne && (
                                <span className="ml-1.5 rounded-full border border-accent/40 bg-accent/10 px-1.5 text-[10px] font-medium text-accent-foreground">cette ligne</span>
                              )}
                            </td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums">{fmtNum(t.moPrixDeVenteAuMl, 2)}</td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums">{fmtNum(t.moPrixDeVenteAuKg, 2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {tSel && qteSel > 0 && (
                    <div className="mt-2 rounded-md bg-accent/10 px-2.5 py-1.5 text-xs flex items-baseline justify-between gap-2">
                      <span className="text-muted-foreground">
                        {selection === trancheLigne && ligne.metrage != null ? 'Toute la ligne' : 'Cette tranche'} : {fmtNum(qteSel, 1)} Ml × {fmtNum(tSel.moPrixDeVenteAuMl, 2)} €/Ml
                      </span>
                      <span className="font-semibold tabular-nums whitespace-nowrap">≈ {fmtNum(qteSel * tSel.moPrixDeVenteAuMl, 0)} € HT</span>
                    </div>
                  )}
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Prix de vente HT du catalogue, hors contrat client. Cliquez une tranche pour la quantité dont parle le client.
                  </p>
                </>
              )}
            </DrawerCard>
          </div>
        </div>
      )}
    </div>
  )
}

function DrawerCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function KV({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground flex-shrink-0">{label}</span>
      <span className={cn('text-sm text-right truncate', mono && 'tabular-nums')}>{value}</span>
    </div>
  )
}
