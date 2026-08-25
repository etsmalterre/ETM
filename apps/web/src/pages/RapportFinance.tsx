import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Search,
  Loader2,
  AlertCircle,
  ArrowUp,
  ArrowDown,
  FileSpreadsheet,
  Landmark,
  Lock,
  Pencil,
  Save,
  X,
  Wallet,
  TrendingUp,
  History,
  StickyNote,
  Scale,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PopoverSelect } from '@/components/ui/popover-select'
import { CardKV, MobileSortRow } from '@/components/stock/StockCardParts'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { cn } from '@/lib/utils'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate } from '@/lib/dates'
import { apiFetch } from '@/lib/api'
// The N/N-1 traffic light is shared with the "Charges" dashboard widget so the
// two surfaces can never disagree about what counts as a dépassement.
import { depassement, estNouveau, DEPASSEMENT_ROW, PctPill } from '@/lib/depassement'
import { useSearchParams } from 'react-router-dom'

// Rapports › Finance — ports the legacy WinDev "Analyse › Finance" tab.
//
// The legacy screen is a flat balance table with a Charges fixes / Charges
// variables radio, one row per compte comptable, and a N vs N-1 comparison.
// Amounts come from the accountant's weekly balance upload; see the API
// route (apps/api/src/lib/finance-common.ts) for the exact rule that turns those
// cumulative uploads into a per-year figure.
//
// SHARED WITH TRM. `compte_compta` / `upload_compta` are partitioned by
// id_societe and the two halves are the same object, so the sister app imports
// THIS file via its `@etm` alias and passes its own `basePath`; the API is the
// same router factory mounted twice. Never fork a TRM copy — improve this one.
// Everything else (permission keys, `@/` component imports) resolves per app.
//
// Layout: "Tableau" (mps_designer §27) — toolbar, split sortable table,
// right slide-in drawer, responsive card list below md (§40).

// ── Types ──────────────────────────────────────────────

interface FinanceLine {
  IDcompte_compta: number
  numero: number
  libelle: string
  description: string
  /** 1 = charge variable, 0 = charge fixe. */
  variable: number
  montant: number
  montant_precedent: number
  ecart: number
  pourcentage: number
  /** Le montant n'est pas comptabilisé : c'est l'estimation de la variation de
   *  stock, posée tant que l'écriture annuelle n'est pas passée. */
  estime?: boolean
}

interface FinanceTotaux {
  produits: number
  charges: number
  frais_fixe: number
  frais_variable: number
  provisions: number
  produits_precedent: number
  charges_precedent: number
  frais_fixe_precedent: number
  frais_variable_precedent: number
  provisions_precedent: number
}

interface FinancePayload {
  annees: number[]
  annee: number | null
  annee_precedente: number | null
  date_arrete: string | null
  date_arrete_precedente: string | null
  totaux: FinanceTotaux | null
  lignes: FinanceLine[]
}

interface HistoriquePoint {
  annee: number
  montant: number
}

type Bucket = 'fixe' | 'variable'

// ── Formatting ─────────────────────────────────────────

/** Money, always with cents, French grouping. */
function eur(v: number): string {
  return `${fmtNum(v, 2)} €`
}

/** An account with no libellé still has to be identifiable in the list. */
function libelleOf(l: FinanceLine): string {
  return l.libelle || '(sans libellé)'
}

// ── Sort ───────────────────────────────────────────────

type SortKey = 'numero' | 'libelle' | 'description' | 'montant' | 'montant_precedent' | 'pourcentage'

interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

const COLLATOR = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })
function compareRows(a: FinanceLine, b: FinanceLine, key: SortKey): number {
  const va = key === 'libelle' ? libelleOf(a) : a[key]
  const vb = key === 'libelle' ? libelleOf(b) : b[key]
  if (typeof va === 'number' && typeof vb === 'number') return va - vb
  return COLLATOR.compare(String(va ?? ''), String(vb ?? ''))
}

const BUCKETS: { key: Bucket; label: string }[] = [
  { key: 'fixe', label: 'Charges fixes' },
  { key: 'variable', label: 'Charges variables' },
]

// ── Page ───────────────────────────────────────────────

/** Where this app's finance endpoints live: `/rapports/finance` for ETM,
 *  `/rapports-trm/finance` for TRM. The only thing that differs between the
 *  two mounts of this screen. */
interface RapportFinanceProps {
  basePath?: string
}

export function RapportFinance({ basePath = '/rapports/finance' }: RapportFinanceProps = {}) {
  // Every hook runs before the permission early-return (mps_designer §28.6 —
  // hooks after a conditional return crash production builds, React #310).
  const canView = useHasPermission('view_rapport_finance')
  const canEdit = useHasPermission('edit_compte_description')

  const [searchParams] = useSearchParams()
  const embed = searchParams.get('embed') === 'true'

  const [searchQuery, setSearchQuery] = useState('')
  const [bucket, setBucket] = useState<Bucket>('fixe')
  const [annee, setAnnee] = useState<number | null>(null)
  const [sort, setSort] = useState<SortState>({ key: 'numero', dir: 'asc' })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)

  const { data, isLoading, isError, error } = useQuery<FinancePayload>({
    queryKey: ['rapport-finance', annee],
    queryFn: () => apiFetch<FinancePayload>(`${basePath}${annee != null ? `?annee=${annee}` : ''}`),
    // Read-only report: always refetch on mount so the figures are live, but
    // never on window focus — the aggregate hits the shared HFSQL bridge.
    staleTime: 0,
    refetchOnWindowFocus: false,
    enabled: canView,
  })

  const anneeAffichee = data?.annee ?? null
  const anneePrec = data?.annee_precedente ?? null

  // Column labels carry the years, so they follow the payload.
  const COLUMNS = useMemo(
    () =>
      [
        { key: 'numero' as const, label: 'Compte', width: 110 },
        { key: 'libelle' as const, label: 'Libellé', width: 250 },
        { key: 'description' as const, label: 'Description', width: 300 },
        {
          key: 'montant' as const,
          label: anneeAffichee ? `Montant ${anneeAffichee}` : 'Montant',
          width: 145,
          align: 'right' as const,
        },
        {
          key: 'montant_precedent' as const,
          label: anneePrec ? `Montant ${anneePrec}` : 'Montant N-1',
          width: 145,
          align: 'right' as const,
        },
        { key: 'pourcentage' as const, label: 'Pourcentage', width: 115, align: 'right' as const },
      ] satisfies { key: SortKey; label: string; width: number; align?: 'left' | 'right' }[],
    [anneeAffichee, anneePrec],
  )
  const TABLE_MIN_WIDTH = useMemo(() => COLUMNS.reduce((s, c) => s + c.width, 0), [COLUMNS])

  const filteredSorted = useMemo(() => {
    let out = (data?.lignes ?? []).filter((l) => (bucket === 'variable' ? l.variable === 1 : l.variable === 0))
    const terms = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length > 0) {
      out = out.filter((l) => {
        const haystacks = [String(l.numero), libelleOf(l), l.description].map((f) => f.toLowerCase())
        return terms.every((t) => haystacks.some((h) => h.includes(t)))
      })
    }
    return [...out].sort((a, b) => {
      const cmp = compareRows(a, b, sort.key)
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [data, bucket, searchQuery, sort])

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }, [])

  // ── Unsaved-changes guard (§28.3.c — the editable field lives in the drawer)
  const [drawerDirty, setDrawerDirty] = useState(false)
  const drawerSaveRef = useRef<() => Promise<void>>(async () => {})
  const drawerDiscardRef = useRef<() => void>(() => {})

  const guard = useUnsavedGuard({
    isDirty: drawerDirty,
    save: async () => {
      await drawerSaveRef.current()
    },
    onDiscard: () => drawerDiscardRef.current(),
  })

  const handleRowClick = useCallback(
    (id: number) => {
      guard.guardAction(() => setSelectedId((prev) => (prev === id ? null : id)))
    },
    [guard],
  )
  const handleDrawerClose = useCallback(() => {
    guard.guardAction(() => setSelectedId(null))
  }, [guard])

  // Switching bucket or year would otherwise leave the drawer on a row that
  // is no longer in the table. The one exception is the drawer reclassifying
  // its own compte: it moves the table to the other bucket precisely so the
  // user keeps looking at the row they just edited.
  const keepSelectionRef = useRef(false)
  useEffect(() => {
    if (keepSelectionRef.current) {
      keepSelectionRef.current = false
      return
    }
    setSelectedId(null)
  }, [bucket, anneeAffichee])

  // Called by the drawer once a fixe/variable change is persisted.
  const handleCompteMoved = useCallback(
    (variable: number) => {
      const next: Bucket = variable === 1 ? 'variable' : 'fixe'
      setBucket((prev) => {
        if (prev === next) return prev
        keepSelectionRef.current = true
        return next
      })
    },
    [],
  )

  // ── Excel export of the visible (filtered + sorted) rows.
  const handleExport = useCallback(async () => {
    if (filteredSorted.length === 0) return
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const aoa: (string | number)[][] = [
        COLUMNS.map((c) => c.label),
        ...filteredSorted.map((l) => [
          l.numero,
          libelleOf(l),
          l.description,
          // Numbers, not formatted strings, so Excel can still sum the column.
          Math.round(l.montant * 100) / 100,
          Math.round(l.montant_precedent * 100) / 100,
          // Same rule as the on-screen column: a compte with no N-1 amount has
          // no ratio, so the cell stays empty instead of claiming 0 %.
          depassement(l.pourcentage, l.montant_precedent) ? l.pourcentage : '',
        ]),
      ]
      const ws = XLSX.utils.aoa_to_sheet(aoa)
      ws['!cols'] = COLUMNS.map((c) => ({ wch: Math.round(c.width / 8) }))
      const wb = XLSX.utils.book_new()
      const sheet = bucket === 'fixe' ? 'Charges fixes' : 'Charges variables'
      XLSX.utils.book_append_sheet(wb, ws, sheet)
      XLSX.writeFile(wb, `Finance_${sheet.replace(/ /g, '_')}_${anneeAffichee ?? ''}.xlsx`)
    } catch (err) {
      console.error('Export Excel échoué:', err)
    } finally {
      setExporting(false)
    }
  }, [filteredSorted, COLUMNS, bucket, anneeAffichee])

  // ── Totalizer over the visible rows.
  const totalMontant = filteredSorted.reduce((s, l) => s + l.montant, 0)
  const totalPrec = filteredSorted.reduce((s, l) => s + l.montant_precedent, 0)
  const totalPct = totalPrec ? Math.round((totalMontant / totalPrec) * 100) : 0

  const selected = filteredSorted.find((l) => l.IDcompte_compta === selectedId) ?? null

  if (!canView) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <Lock className="h-12 w-12 opacity-30" />
        <p className="text-sm font-medium">Accès restreint</p>
        <p className="text-xs max-w-sm text-center">
          Ce rapport contient la balance comptable complète. Demandez la permission « Consulter le rapport
          finance » à un administrateur.
        </p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      {/* Toolbar */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-3">
        <div className="relative order-1 flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Rechercher (compte, libellé, description…)"
            className="h-9 w-full pl-8 pr-3 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Below sm this wrapper forces its own full-width row; at sm+ it
            dissolves so the controls rejoin the toolbar flex (§40.5). */}
        <div className="order-4 w-full flex items-center gap-3 sm:contents">
          <div className="flex flex-wrap gap-1 sm:order-2 flex-shrink-0">
            {BUCKETS.map((b) => (
              <button
                key={b.key}
                type="button"
                onClick={() => setBucket(b.key)}
                className={cn(
                  'px-3 py-1.5 text-xs rounded-md transition-colors whitespace-nowrap',
                  bucket === b.key
                    ? 'bg-accent text-accent-foreground shadow-sm font-medium'
                    : 'text-muted-foreground hover:bg-accent/10',
                )}
              >
                {b.label}
              </button>
            ))}
          </div>

          <div className="w-28 flex-shrink-0 sm:order-2">
            <PopoverSelect
              hideEmpty
              options={(data?.annees ?? []).map((y) => ({ id: y, primary: String(y) }))}
              value={anneeAffichee ?? 0}
              onChange={(y) => setAnnee(y)}
            />
          </div>
        </div>

        <Button
          size="sm"
          onClick={handleExport}
          disabled={exporting || filteredSorted.length === 0}
          className="order-2 sm:order-3 flex-shrink-0"
          title="Exporter Excel"
        >
          {exporting ? (
            <Loader2 className="h-3.5 w-3.5 sm:mr-1.5 animate-spin" />
          ) : (
            <FileSpreadsheet className="h-3.5 w-3.5 sm:mr-1.5" />
          )}
          <span className="hidden sm:inline">Exporter Excel</span>
        </Button>
      </div>

      {/* Table card */}
      <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border/60 bg-white shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-8 w-8 animate-spin text-accent" />
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center h-full text-destructive gap-2">
            <AlertCircle className="h-8 w-8" />
            <p className="text-sm">{(error as Error)?.message || 'Erreur de chargement'}</p>
          </div>
        ) : filteredSorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <Landmark className="h-12 w-12 opacity-30" />
            <p className="text-sm">Aucun compte à afficher</p>
          </div>
        ) : (
          <>
            {/* Desktop table (md+) */}
            <div className="hidden md:flex md:flex-col flex-1 min-h-0 overflow-auto scrollbar-transparent">
              <table className="w-full text-[13px]" style={{ minWidth: TABLE_MIN_WIDTH, tableLayout: 'fixed' }}>
                <colgroup>
                  {COLUMNS.map((c) => (
                    <col key={c.key} style={{ width: c.width }} />
                  ))}
                </colgroup>
                <thead className="sticky top-0 z-10 bg-zinc-200 border-b border-border/60">
                  <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                    {COLUMNS.map((c) => (
                      <SortHeader
                        key={c.key}
                        label={c.label}
                        sortKey={c.key}
                        sort={sort}
                        onSort={handleSort}
                        align={c.align}
                      />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredSorted.map((l) => {
                    const isSelected = selectedId === l.IDcompte_compta
                    const d = depassement(l.pourcentage, l.montant_precedent)
                    return (
                      <tr
                        key={l.IDcompte_compta}
                        data-stock-row
                        onClick={() => handleRowClick(l.IDcompte_compta)}
                        className={cn(
                          'border-b border-border/40 cursor-pointer transition-colors',
                          // Selection always wins over the dépassement tint.
                          isSelected
                            ? 'bg-accent/10'
                            : d
                              ? DEPASSEMENT_ROW[d]
                              : estNouveau(l.montant, l.montant_precedent)
                                ? 'bg-zinc-100/70 hover:bg-zinc-200/70'
                                : 'hover:bg-accent/5',
                        )}
                      >
                        <td className="px-2.5 py-2 tabular-nums font-medium">{l.numero}</td>
                        <td className="px-2.5 py-2 truncate" title={libelleOf(l)}>
                          {libelleOf(l)}
                        </td>
                        <td className="px-2.5 py-2 truncate text-muted-foreground" title={l.description || undefined}>
                          {l.description}
                        </td>
                        <td className="px-2.5 py-2 text-right tabular-nums font-medium">
                          {l.estime && (
                            <span
                              className="mr-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0 align-middle text-[10px] font-medium text-amber-700"
                              title="Estimation — l'écriture de variation de stock est annuelle ; elle sera remplacée par le montant réel à la clôture."
                            >
                              estimation
                            </span>
                          )}
                          {eur(l.montant)}
                        </td>
                        <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">
                          {eur(l.montant_precedent)}
                        </td>
                        <td className="px-2.5 py-2 text-right">
                          <PctPill pourcentage={l.pourcentage} precedent={l.montant_precedent} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile card list (< md) — same rows, state and guard (§40.2) */}
            <div className="md:hidden flex-1 min-h-0 flex flex-col">
              <MobileSortRow
                columns={COLUMNS}
                sort={sort}
                onSortChange={(next) => setSort(next)}
              />
              <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent p-2 space-y-2 bg-zinc-100/80">
                {filteredSorted.map((l) => {
                  const isSelected = selectedId === l.IDcompte_compta
                  const d = depassement(l.pourcentage, l.montant_precedent)
                  return (
                    <div
                      key={l.IDcompte_compta}
                      data-stock-row
                      onClick={() => handleRowClick(l.IDcompte_compta)}
                      className={cn(
                        'rounded-lg border p-3 cursor-pointer transition-colors shadow-sm',
                        isSelected
                          ? 'bg-accent/10 border-accent ring-1 ring-accent'
                          : d === 'depasse'
                            ? 'bg-red-50 border-red-200 hover:border-red-300'
                            : d === 'proche'
                              ? 'bg-amber-50 border-amber-200 hover:border-amber-300'
                              : estNouveau(l.montant, l.montant_precedent)
                                ? 'bg-zinc-100 border-zinc-300 hover:border-zinc-400'
                                : 'bg-white border-border/60 hover:border-accent/40',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium tabular-nums truncate">{l.numero}</p>
                        <span className="flex-shrink-0">
                          <PctPill pourcentage={l.pourcentage} precedent={l.montant_precedent} />
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{libelleOf(l)}</p>
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <CardKV label={anneeAffichee ? String(anneeAffichee) : 'Montant'} value={eur(l.montant)} mono strong />
                        <CardKV
                          label={anneePrec ? String(anneePrec) : 'N-1'}
                          value={eur(l.montant_precedent)}
                          mono
                        />
                      </div>
                      {!!l.description && (
                        <p className="text-[11px] text-muted-foreground italic truncate mt-2 pt-2 border-t border-border/40">
                          {l.description}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Totalizer */}
      {!isLoading && !isError && filteredSorted.length > 0 && (
        <div className="flex-shrink-0 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-zinc-100/80 shadow-sm px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm">
            <Landmark className="h-4 w-4 text-accent" />
            <span className="font-semibold tabular-nums">{filteredSorted.length}</span>
            <span className="text-muted-foreground">compte{filteredSorted.length > 1 ? 's' : ''}</span>
            {!!data?.date_arrete && (
              <span className="hidden sm:inline text-xs text-muted-foreground">
                · arrêté au {formatHfsqlDate(data.date_arrete)}
              </span>
            )}
          </div>
          {/* Three figures on one bar read as one long number string when the
              labels sit inline with them. Stack each label over its value so
              the words stop competing with the digits, and keep the year
              labels desktop-only so the bar still fits one line on phones
              (§40.5bis). */}
          <div className="flex items-end gap-4 sm:gap-6 text-sm">
            <div className="flex flex-col items-end leading-tight">
              <span className="hidden sm:block text-[10px] uppercase tracking-wide text-muted-foreground">
                Total {anneeAffichee}
              </span>
              <span className="font-semibold tabular-nums text-sm sm:text-base">{eur(totalMontant)}</span>
            </div>
            <div className="flex flex-col items-end leading-tight border-l border-border/60 pl-4 sm:pl-6">
              <span className="hidden sm:block text-[10px] uppercase tracking-wide text-muted-foreground">
                Total {anneePrec ?? 'N-1'}
              </span>
              <span className="tabular-nums text-muted-foreground text-sm sm:text-base">{eur(totalPrec)}</span>
            </div>
            {/* Nothing to compare against = no pill, and no empty divided
                column left hanging on the bar either. */}
            {!!depassement(totalPct, totalPrec) && (
              <div className="flex items-center border-l border-border/60 pl-4 sm:pl-6">
                <PctPill pourcentage={totalPct} precedent={totalPrec} />
              </div>
            )}
          </div>
        </div>
      )}

      <CompteDrawer
        compte={selected}
        basePath={basePath}
        annee={anneeAffichee}
        anneePrecedente={anneePrec}
        canEdit={canEdit}
        embed={embed}
        onClose={handleDrawerClose}
        onCompteMoved={handleCompteMoved}
        onDirtyChange={setDrawerDirty}
        saveRef={drawerSaveRef}
        discardRef={drawerDiscardRef}
      />

      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />
    </div>
  )
}

// ── Sort header cell ───────────────────────────────────

interface SortHeaderProps {
  label: string
  sortKey: SortKey
  sort: SortState
  onSort: (k: SortKey) => void
  align?: 'left' | 'right'
}
function SortHeader({ label, sortKey, sort, onSort, align = 'left' }: SortHeaderProps) {
  const active = sort.key === sortKey
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={cn(
        'px-2.5 py-2 font-semibold cursor-pointer select-none',
        align === 'right' ? 'text-right' : 'text-left',
        active && 'text-accent',
      )}
    >
      <span className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
        {label}
        {active && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </span>
    </th>
  )
}

// ── Drawer ─────────────────────────────────────────────

function DrawerCard({
  icon,
  title,
  highlight,
  children,
}: {
  icon: React.ReactNode
  title: string
  highlight?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 bg-card p-3 shadow-sm',
        highlight && 'border-l-4 border-l-accent/70 bg-accent/[0.03]',
      )}
    >
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
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-sm text-right truncate', mono && 'tabular-nums')}>{value}</span>
    </div>
  )
}

interface CompteDrawerProps {
  compte: FinanceLine | null
  /** Same endpoint prefix the page was given. */
  basePath: string
  annee: number | null
  anneePrecedente: number | null
  canEdit: boolean
  embed: boolean
  onClose: () => void
  /** Fired after a persisted fixe/variable change so the table can follow the
   *  compte into its new bucket instead of dropping it out of view. */
  onCompteMoved: (variable: number) => void
  onDirtyChange: (dirty: boolean) => void
  saveRef: React.MutableRefObject<() => Promise<void>>
  discardRef: React.MutableRefObject<() => void>
}

/** What the drawer edits: the free-text note and the fixe/variable bucket. */
interface CompteDraft {
  description: string
  variable: number
}

interface ComptePatchResult {
  IDcompte_compta: number
  description: string
  variable: number
}

function CompteDrawer({
  compte,
  basePath,
  annee,
  anneePrecedente,
  canEdit,
  embed,
  onClose,
  onCompteMoved,
  onDirtyChange,
  saveRef,
  discardRef,
}: CompteDrawerProps) {
  const queryClient = useQueryClient()
  const drawerRef = useRef<HTMLDivElement>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<CompteDraft>({ description: '', variable: 0 })
  const originalRef = useRef<CompteDraft>({ description: '', variable: 0 })
  const id = compte?.IDcompte_compta ?? null

  // Keep the last selected account on screen while the panel slides out, so
  // the closing animation doesn't play against an empty white sheet
  // (FilsStock keeps its chrome mounted for the same reason).
  const [lastCompte, setLastCompte] = useState<FinanceLine | null>(null)
  useEffect(() => {
    if (compte) setLastCompte(compte)
  }, [compte])
  const shown = compte ?? lastCompte

  const { data: historique, isLoading: histLoading } = useQuery<HistoriquePoint[]>({
    queryKey: ['rapport-finance-historique', id],
    queryFn: () => apiFetch<HistoriquePoint[]>(`${basePath}/comptes/${id}/historique`),
    enabled: id !== null,
    staleTime: 5 * 60 * 1000,
  })

  const saveMut = useMutation({
    mutationFn: (patch: Partial<CompteDraft>) =>
      apiFetch<ComptePatchResult>(`${basePath}/comptes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (updated) => {
      // Patch the cached row before invalidating: a reclassification switches
      // the table to the other bucket immediately, and a stale cache would
      // filter the row out for one render — the drawer would blink shut.
      queryClient.setQueriesData<FinancePayload>({ queryKey: ['rapport-finance'] }, (prev) =>
        prev
          ? {
              ...prev,
              lignes: prev.lignes.map((l) =>
                l.IDcompte_compta === updated.IDcompte_compta
                  ? { ...l, description: updated.description, variable: updated.variable }
                  : l,
              ),
            }
          : prev,
      )
      queryClient.invalidateQueries({ queryKey: ['rapport-finance'] })
      setIsEditing(false)
      if (updated.variable !== originalRef.current.variable) onCompteMoved(updated.variable)
    },
  })

  // Leaving edit mode whenever the drawer targets another account keeps the
  // draft from bleeding across rows.
  useEffect(() => {
    setIsEditing(false)
  }, [id])

  const startEdit = useCallback(() => {
    const snapshot: CompteDraft = {
      description: compte?.description ?? '',
      variable: compte?.variable === 1 ? 1 : 0,
    }
    originalRef.current = snapshot
    setDraft(snapshot)
    setIsEditing(true)
  }, [compte])

  const cancelEdit = useCallback(() => {
    setIsEditing(false)
    setDraft(originalRef.current)
  }, [])

  const isDirty =
    isEditing &&
    (draft.description !== originalRef.current.description || draft.variable !== originalRef.current.variable)

  /** Sends only what actually changed — an untouched field must never be
   *  rewritten (and `variable` in particular must not be reasserted). */
  const commit = useCallback(async () => {
    const o = originalRef.current
    const patch: Partial<CompteDraft> = {}
    if (draft.description !== o.description) patch.description = draft.description
    if (draft.variable !== o.variable) patch.variable = draft.variable
    if (Object.keys(patch).length === 0) {
      setIsEditing(false)
      return
    }
    await saveMut.mutateAsync(patch)
  }, [draft, saveMut])

  useEffect(() => {
    onDirtyChange(isDirty)
  }, [isDirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  // Refs are rewritten every render so the page-level guard always invokes
  // the current closure (§28.3.c).
  useEffect(() => {
    saveRef.current = async () => {
      if (isDirty) await commit()
    }
  })
  useEffect(() => {
    discardRef.current = () => cancelEdit()
  })

  // Outside-click dismissal, ignoring clicks on another row/card (§27.5).
  useEffect(() => {
    if (id === null) return
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node | null
      if (!target) return
      if (drawerRef.current?.contains(target)) return
      if ((target as Element).closest?.('[data-stock-row]')) return
      onClose()
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [id, onClose])

  const open = compte !== null
  // The largest absolute year value sets the bar scale.
  const histMax = Math.max(1, ...(historique ?? []).map((p) => Math.abs(p.montant)))
  // Most recent year on top — the user reads the current exercice first and
  // scans backwards, the same direction as the année picker in the toolbar.
  const histRows = useMemo(
    () => [...(historique ?? [])].sort((a, b) => b.annee - a.annee),
    [historique],
  )

  // The badge and the Nature card follow the pending choice while editing, so
  // the header never contradicts the selector two cards below it.
  const shownVariable = isEditing ? draft.variable : (shown?.variable ?? 0)

  return (
    <div
      ref={drawerRef}
      className={cn(
        'fixed right-0 bottom-0 w-full max-w-[440px] bg-white border-l border-border/60 shadow-xl z-30 transition-transform duration-300 flex flex-col',
        embed ? 'top-0' : 'top-14',
        open ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      {shown && (
        <div className="flex-1 min-h-0 flex flex-col bg-zinc-100/80">
          {/* Header band — the dashboard widget treatment (mps_designer §43):
              navy surface, gold icon tile, white title, gold hairline under.
              The record's actions live here, top-right, like every other
              detail header in the app (§6.1). */}
          <div className="flex-shrink-0 flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5">
            {/* §9/§43: the tile flips to white in edit mode — the tint used on
                light headers is invisible on navy. */}
            <div
              className={cn(
                'h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm transition-colors',
                isEditing ? 'bg-white text-primary' : 'bg-gold text-gold-foreground',
              )}
            >
              <Landmark className="h-[18px] w-[18px]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-heading font-bold tracking-tight tabular-nums truncate text-primary-foreground">
                  {shown.numero}
                </h2>
                <span className="flex-shrink-0 rounded-full border border-white/25 bg-white/15 px-1.5 py-0 text-[10px] font-medium text-white">
                  {shownVariable === 1 ? 'Variable' : 'Fixe'}
                </span>
              </div>
              <p className="text-xs text-white/70 truncate" title={libelleOf(shown)}>
                {libelleOf(shown)}
              </p>
            </div>

            <div className="flex items-center gap-1.5 flex-shrink-0">
              {canEdit &&
                (isEditing ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="px-2 text-white/80 hover:bg-white/15 hover:text-white"
                      onClick={cancelEdit}
                      disabled={saveMut.isPending}
                      title="Annuler"
                    >
                      <X className="h-3.5 w-3.5 sm:mr-1.5" />
                      <span className="hidden sm:inline">Annuler</span>
                    </Button>
                    <Button
                      variant="gold"
                      size="sm"
                      onClick={() => void commit()}
                      disabled={saveMut.isPending}
                      title="Enregistrer"
                    >
                      {saveMut.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 sm:mr-1.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5 sm:mr-1.5" />
                      )}
                      <span className="hidden sm:inline">Enregistrer</span>
                    </Button>
                  </>
                ) : (
                  <Button variant="gold" size="sm" onClick={startEdit} title="Modifier">
                    <Pencil className="h-3.5 w-3.5 sm:mr-1.5" />
                    <span className="hidden sm:inline">Modifier</span>
                  </Button>
                ))}
              {/* Full-width below md means there is no "outside" to click (§40.4) */}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 md:hidden flex-shrink-0 text-white/80 hover:bg-white/15 hover:text-white"
                onClick={onClose}
                title="Fermer"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3 scrollbar-transparent">
            {/* Which of the two lists the compte belongs to — the classification
                the accountant's export gets wrong often enough that the user
                has to be able to correct it here. First card: it qualifies
                every figure below it. */}
            <DrawerCard
              icon={<Scale className="h-3.5 w-3.5 text-accent" />}
              title="Nature de la charge"
              highlight={isEditing}
            >
              {isEditing ? (
                <div className="space-y-2">
                  <div className="flex gap-1">
                    {BUCKETS.map((b) => {
                      const active = (draft.variable === 1 ? 'variable' : 'fixe') === b.key
                      return (
                        <button
                          key={b.key}
                          type="button"
                          onClick={() => setDraft((prev) => ({ ...prev, variable: b.key === 'variable' ? 1 : 0 }))}
                          className={cn(
                            'flex-1 px-2 py-1.5 text-xs rounded-md transition-colors',
                            active
                              ? 'bg-accent text-accent-foreground shadow-sm font-medium'
                              : 'text-muted-foreground hover:bg-accent/10',
                          )}
                        >
                          {b.label}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Le compte change de liste et bascule d’un total à l’autre.
                  </p>
                </div>
              ) : (
                <KV label="Catégorie" value={shown.variable === 1 ? 'Charge variable' : 'Charge fixe'} />
              )}
            </DrawerCard>

            <DrawerCard
              icon={<Wallet className="h-3.5 w-3.5 text-accent" />}
              title="Montants"
              highlight={isEditing}
            >
              <div className="space-y-1.5">
                <KV label={annee ? `Montant ${annee}` : 'Montant'} value={eur(shown.montant)} mono />
                <KV
                  label={anneePrecedente ? `Montant ${anneePrecedente}` : 'Montant N-1'}
                  value={eur(shown.montant_precedent)}
                  mono
                />
                <KV
                  label="Écart"
                  value={
                    <span className={cn(shown.ecart > 0 && 'text-red-600', shown.ecart < 0 && 'text-emerald-700')}>
                      {shown.ecart > 0 ? '+' : ''}
                      {eur(shown.ecart)}
                    </span>
                  }
                  mono
                />
                <KV
                  label="Pourcentage"
                  value={
                    // A labeled row still needs a value, so the drawer falls
                    // back to the app's usual em-dash rather than a blank.
                    depassement(shown.pourcentage, shown.montant_precedent) ? (
                      <PctPill pourcentage={shown.pourcentage} precedent={shown.montant_precedent} />
                    ) : (
                      '—'
                    )
                  }
                />
              </div>
            </DrawerCard>

            <DrawerCard
              icon={<StickyNote className="h-3.5 w-3.5 text-accent" />}
              title="Description"
              highlight={isEditing}
            >
              {isEditing ? (
                <div className="space-y-2">
                  <textarea
                    rows={3}
                    value={draft.description}
                    maxLength={255}
                    onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                    placeholder="Annotation libre (ex. « Salaires Isa, Pierrot »)"
                  />
                  {saveMut.isError && (
                    <p className="text-xs text-destructive">
                      {(saveMut.error as Error)?.message || 'Enregistrement impossible'}
                    </p>
                  )}
                </div>
              ) : shown.description ? (
                <p className="text-sm text-muted-foreground whitespace-pre-line">{shown.description}</p>
              ) : (
                <p className="text-sm text-muted-foreground italic">Aucune description</p>
              )}
            </DrawerCard>

            <DrawerCard icon={<History className="h-3.5 w-3.5 text-accent" />} title="Historique annuel">
              {histLoading ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="h-5 w-5 animate-spin text-accent" />
                </div>
              ) : !historique || historique.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">Aucun historique</p>
              ) : (
                // Single series over a handful of years: direct-labeled
                // horizontal bars, one hue, recessive baseline. No legend —
                // the card title names the series.
                <div className="space-y-2">
                  {histRows.map((p) => {
                    const width = Math.max(2, (Math.abs(p.montant) / histMax) * 100)
                    return (
                      <div key={p.annee} className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground tabular-nums w-9 flex-shrink-0">{p.annee}</span>
                        <div className="flex-1 min-w-0 h-4 bg-zinc-200/70 rounded-sm overflow-hidden">
                          <div
                            className={cn('h-full rounded-r-sm', p.montant < 0 ? 'bg-zinc-400' : 'bg-accent')}
                            style={{ width: `${width}%` }}
                          />
                        </div>
                        <span className="text-xs tabular-nums text-right w-[92px] flex-shrink-0">
                          {eur(p.montant)}
                        </span>
                      </div>
                    )
                  })}
                  <p className="text-[10px] text-muted-foreground pt-1 flex items-center gap-1">
                    <TrendingUp className="h-3 w-3" />
                    Solde de fin d’exercice, dernier arrêté de chaque année.
                  </p>
                </div>
              )}
            </DrawerCard>
          </div>
        </div>
      )}
    </div>
  )
}
