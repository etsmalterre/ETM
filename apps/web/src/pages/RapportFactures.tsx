// Rapports › Factures — the legacy `FEN_Factures.wdw` grid, one row per
// definitive facture of a date range: numéro, date, client, type, HT, taux de
// TVA, TVA, TTC, plus what the desk asked for next (envoyée, mode de paiement,
// échéance, compte de vente). Read-only, flat, the Rapports shape (sticky
// sortable header, search over every column, Excel export with the per-user
// column picker) — the master-detail list of Clients › Facturation cannot
// carry these columns, and this is where the period gets totalised, with the
// split by TVA rate the CA3 needs.
//
// Shared with TRM the way Rapports › Finance is: the sister app imports THIS
// file through its `@etm` alias and passes `basePath="/rapports-trm/factures"`.
// Improve it here; never fork a TRM copy.
import { useState, useMemo, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  Search,
  Loader2,
  AlertCircle,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  ReceiptText,
  Undo2,
  MailCheck,
  MailX,
  FileSpreadsheet,
  Columns3,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { cn } from '@/lib/utils'
import { formatHfsqlDate, inputDateToHfsql } from '@/lib/dates'
import { apiFetch } from '@/lib/api'
import { useUser } from '@/contexts/UserContext'
import { fmtNum } from '@/lib/format'
import { aggregateFactures, signed } from '@/lib/rapport-factures-agg'

// ── Types ──────────────────────────────────────────────

interface FactureRapportRow {
  id: number
  numero: number | null
  date: string | null
  IDclient: number
  client_nom: string
  /** Country of the facture's billing address, '' when unknown. */
  pays: string
  /** 1 = Facture, 2 = Avoir — amounts are magnitudes, signed on display. */
  type: number
  tva_rate: number
  tva_label: string
  total_ht: number
  total_tva: number
  total_ttc: number
  nb_lignes: number
  est_envoye: number
  mode_paiement: string
  echeance_label: string
  date_echeance: string | null
  code_comptable: string
}

interface RapportPayload {
  du: string
  au: string
  truncated: boolean
  rows: FactureRapportRow[]
}

// ── Type pill ──────────────────────────────────────────

interface TypeMeta {
  label: string
  icon: LucideIcon
  solid: string
}
const TYPE_META: Record<number, TypeMeta> = {
  1: { label: 'Facture', icon: ReceiptText, solid: 'bg-primary border-primary' },
  2: { label: 'Avoir', icon: Undo2, solid: 'bg-orange-500 border-orange-500' },
}
function typeMeta(type: number): TypeMeta {
  return TYPE_META[type] ?? TYPE_META[1]
}

function TypePill({ type }: { type: number }) {
  const meta = typeMeta(type)
  const Icon = meta.icon
  return (
    <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white whitespace-nowrap', meta.solid)}>
      <Icon className="h-2.5 w-2.5 flex-shrink-0" />
      {meta.label}
    </Badge>
  )
}

// ── Formatting helpers ─────────────────────────────────

function dateFmt(v: string | null): string {
  return v && /^\d{8}$/.test(v) ? formatHfsqlDate(v) : ''
}
/** HFSQL "YYYYMMDD" → a real JS Date for Excel (true date cells sort right). */
function dateVal(v: string | null): Date | null {
  if (!v || !/^\d{8}$/.test(v)) return null
  return new Date(Number(v.slice(0, 4)), Number(v.slice(4, 6)) - 1, Number(v.slice(6, 8)))
}
function eurFmt(v: number): string {
  return `${fmtNum(v, 2)} €`
}
/** "20 %", "5,5 %", "0 %". */
function rateFmt(rate: number): string {
  return `${fmtNum(rate, Number.isInteger(rate) ? 0 : 1)} %`
}
/** Today / first day of the year as `<input type="date">` values. */
function inputDate(d: Date): string {
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ── Excel export column catalog ─────────────────────────

const eur2 = (v: number) => Math.round(v * 100) / 100

interface ExportColumn {
  key: string
  label: string
  width: number
  kind?: 'date'
  value: (r: FactureRapportRow) => string | number | Date | null
}
const EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'numero', label: 'Numéro', width: 9, value: (r) => r.numero ?? '' },
  { key: 'date', label: 'Date', width: 12, kind: 'date', value: (r) => dateVal(r.date) },
  { key: 'client', label: 'Client', width: 30, value: (r) => r.client_nom || '' },
  { key: 'pays', label: 'Pays', width: 14, value: (r) => r.pays || '' },
  { key: 'type', label: 'Type', width: 9, value: (r) => typeMeta(r.type).label },
  { key: 'total_ht', label: 'Total HT (€)', width: 13, value: (r) => eur2(signed(r.total_ht, r.type)) },
  { key: 'tva_rate', label: 'Taux TVA (%)', width: 11, value: (r) => r.tva_rate },
  { key: 'tva_label', label: 'Libellé TVA', width: 22, value: (r) => r.tva_label || '' },
  { key: 'total_tva', label: 'TVA (€)', width: 12, value: (r) => eur2(signed(r.total_tva, r.type)) },
  { key: 'total_ttc', label: 'Total TTC (€)', width: 13, value: (r) => eur2(signed(r.total_ttc, r.type)) },
  { key: 'envoyee', label: 'Envoyée', width: 9, value: (r) => (r.est_envoye ? 'Oui' : 'Non') },
  { key: 'mode_paiement', label: 'Mode de paiement', width: 16, value: (r) => r.mode_paiement || '' },
  { key: 'echeance', label: 'Échéance', width: 26, value: (r) => r.echeance_label || '' },
  { key: 'date_echeance', label: "Date d'échéance", width: 14, kind: 'date', value: (r) => dateVal(r.date_echeance) },
  { key: 'code_comptable', label: 'Compte de vente', width: 30, value: (r) => r.code_comptable || '' },
  { key: 'nb_lignes', label: 'Lignes', width: 8, value: (r) => r.nb_lignes },
]
const EXPORT_COLUMN_KEYS = EXPORT_COLUMNS.map((c) => c.key)

// Persisted column selection, keyed by user id (same scheme as the other
// rapports — localStorage until server-side preferences exist).
const EXPORT_PREF_KEY_BASE = 'mps:rapport-factures:export-columns'
const exportPrefKey = (userId: number | null) =>
  userId == null ? EXPORT_PREF_KEY_BASE : `${EXPORT_PREF_KEY_BASE}:${userId}`

function loadExportSelection(userId: number | null): string[] {
  try {
    const raw = localStorage.getItem(exportPrefKey(userId))
    if (!raw) return EXPORT_COLUMN_KEYS
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return EXPORT_COLUMN_KEYS
    const stored = new Set(parsed.filter((k): k is string => typeof k === 'string'))
    const kept = EXPORT_COLUMN_KEYS.filter((k) => stored.has(k))
    return kept.length > 0 ? kept : EXPORT_COLUMN_KEYS
  } catch {
    return EXPORT_COLUMN_KEYS
  }
}

function saveExportSelection(userId: number | null, keys: string[]): void {
  try {
    localStorage.setItem(exportPrefKey(userId), JSON.stringify(keys))
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

// ── Sort handling ──────────────────────────────────────

type SortKey =
  | 'numero'
  | 'date'
  | 'client_nom'
  | 'pays'
  | 'type'
  | 'total_ht'
  | 'tva_rate'
  | 'total_tva'
  | 'total_ttc'
  | 'est_envoye'
  | 'mode_paiement'
  | 'echeance_label'
  | 'date_echeance'
  | 'code_comptable'

interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

const COLUMNS: { key: SortKey; label: string; width: number; align?: 'left' | 'right' | 'center' }[] = [
  { key: 'numero', label: 'Numéro', width: 78, align: 'right' },
  { key: 'date', label: 'Date', width: 96, align: 'right' },
  { key: 'client_nom', label: 'Client', width: 220 },
  { key: 'pays', label: 'Pays', width: 110 },
  { key: 'type', label: 'Type', width: 96 },
  { key: 'total_ht', label: 'Total HT', width: 112, align: 'right' },
  { key: 'tva_rate', label: 'Taux', width: 70, align: 'right' },
  { key: 'total_tva', label: 'TVA', width: 104, align: 'right' },
  { key: 'total_ttc', label: 'Total TTC', width: 116, align: 'right' },
  { key: 'est_envoye', label: 'Envoyée', width: 80, align: 'center' },
  { key: 'mode_paiement', label: 'Paiement', width: 110 },
  { key: 'echeance_label', label: 'Échéance', width: 170 },
  { key: 'date_echeance', label: "Date d'éch.", width: 100, align: 'right' },
  { key: 'code_comptable', label: 'Compte de vente', width: 200 },
]
const TABLE_MIN_WIDTH = COLUMNS.reduce((s, c) => s + c.width, 0)

const COLLATOR = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })
function compareRows(a: FactureRapportRow, b: FactureRapportRow, key: SortKey): number {
  // Money columns sort on the SIGNED amount so avoirs land at the bottom of
  // an ascending sort, like the negative figures they print as.
  if (key === 'total_ht' || key === 'total_tva' || key === 'total_ttc') {
    return signed(a[key], a.type) - signed(b[key], b.type)
  }
  const va = a[key]
  const vb = b[key]
  if (va == null && vb == null) return 0
  if (va == null) return 1
  if (vb == null) return -1
  if (typeof va === 'number' && typeof vb === 'number') return va - vb
  return COLLATOR.compare(String(va), String(vb))
}

// ── Data hook ──────────────────────────────────────────

function useRapport(basePath: string, du: string, au: string) {
  const enabled = /^\d{8}$/.test(du) && /^\d{8}$/.test(au) && du <= au
  return useQuery<RapportPayload>({
    queryKey: ['rapport-factures', basePath, du, au],
    queryFn: () => apiFetch<RapportPayload>(`${basePath}?du=${du}&au=${au}`),
    enabled,
    // Read-only report: live on every visit, no refetch on alt-tab (the
    // period scan is a real query against the shared HFSQL server).
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
}

// ── Main Page ──────────────────────────────────────────

type TypeFilter = 'all' | 'facture' | 'avoir'
const TYPE_FILTER_OPTIONS: { id: number; key: TypeFilter; primary: string }[] = [
  { id: 1, key: 'all', primary: 'Factures et avoirs' },
  { id: 2, key: 'facture', primary: 'Factures seules' },
  { id: 3, key: 'avoir', primary: 'Avoirs seuls' },
]

interface RapportFacturesProps {
  /** API prefix — `/rapports/factures` here, `/rapports-trm/factures` in TRM. */
  basePath?: string
}

export function RapportFactures({ basePath = '/rapports/factures' }: RapportFacturesProps = {}) {
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState('')
  // Period — defaults to the current year to date, the desk's working window.
  const [du, setDu] = useState(() => inputDate(new Date(new Date().getFullYear(), 0, 1)))
  const [au, setAu] = useState(() => inputDate(new Date()))
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  // Index into the rates present in the period (0 = every rate).
  const [tvaFilterIdx, setTvaFilterIdx] = useState(0)
  const [nonEnvoyees, setNonEnvoyees] = useState(false)
  const [sort, setSort] = useState<SortState>({ key: 'numero', dir: 'desc' })

  const duDigits = inputDateToHfsql(du)
  const auDigits = inputDateToHfsql(au)
  const periodValid = /^\d{8}$/.test(duDigits) && /^\d{8}$/.test(auDigits) && duDigits <= auDigits
  const { data, isLoading, isError, error } = useRapport(basePath, duDigits, auDigits)
  const rows = data?.rows

  // TVA rates present in the loaded period, highest first — the filter's
  // options. Rebuilt per period so the list never offers a rate with no row.
  const rates = useMemo(() => {
    const set = new Set<number>()
    for (const r of rows ?? []) set.add(r.tva_rate)
    return Array.from(set).sort((a, b) => b - a)
  }, [rows])
  useEffect(() => {
    if (tvaFilterIdx > rates.length) setTvaFilterIdx(0)
  }, [rates, tvaFilterIdx])
  const tvaFilter = tvaFilterIdx > 0 ? rates[tvaFilterIdx - 1] : null

  const filteredSorted = useMemo(() => {
    let out = rows ?? []
    if (typeFilter === 'facture') out = out.filter((r) => r.type !== 2)
    else if (typeFilter === 'avoir') out = out.filter((r) => r.type === 2)
    if (tvaFilter != null) out = out.filter((r) => r.tva_rate === tvaFilter)
    if (nonEnvoyees) out = out.filter((r) => !r.est_envoye)
    const terms = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length > 0) {
      out = out.filter((r) => {
        const haystacks = [
          r.numero != null ? String(r.numero) : '',
          r.client_nom,
          r.pays,
          typeMeta(r.type).label,
          r.tva_label,
          r.mode_paiement,
          r.echeance_label,
          r.code_comptable,
        ]
          .filter((f): f is string => !!f)
          .map((f) => f.toLowerCase())
        return terms.every((t) => haystacks.some((h) => h.includes(t)))
      })
    }
    out = [...out].sort((a, b) => {
      const cmp = compareRows(a, b, sort.key)
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return out
  }, [rows, typeFilter, tvaFilter, nonEnvoyees, searchQuery, sort])

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }, [])

  // A row opens the facture in Clients › Facturation (definitive bucket,
  // searched by its numero so the master list holds exactly that document).
  const openFacture = useCallback((r: FactureRapportRow) => {
    if (r.numero == null) return
    navigate(`/clients/facturation?numero=${r.numero}`)
  }, [navigate])

  // Excel export of the visible rows through the column picker (§ same as
  // the other rapports — SheetJS lazy-loaded, selection remembered per user).
  const [exporting, setExporting] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const { user } = useUser()
  const userId = user?.IDutilisateur ?? null
  const [exportCols, setExportCols] = useState<string[]>(() => loadExportSelection(userId))
  useEffect(() => {
    setExportCols(loadExportSelection(userId))
  }, [userId])

  const handleExport = useCallback(async () => {
    if (filteredSorted.length === 0) return
    const cols = EXPORT_COLUMNS.filter((c) => exportCols.includes(c.key))
    if (cols.length === 0) return
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const aoa: (string | number | Date | null)[][] = [
        cols.map((c) => c.label),
        ...filteredSorted.map((r) => cols.map((c) => c.value(r))),
      ]
      const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true })
      ws['!cols'] = cols.map((c) => ({ wch: c.width }))
      cols.forEach((c, colIdx) => {
        if (c.kind !== 'date') return
        for (let rowIdx = 1; rowIdx <= filteredSorted.length; rowIdx++) {
          const cell = ws[XLSX.utils.encode_cell({ r: rowIdx, c: colIdx })]
          if (cell && cell.t === 'd') cell.z = 'dd/mm/yyyy'
        }
      })
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Factures')
      XLSX.writeFile(wb, `Factures_${duDigits}_${auDigits}.xlsx`)
      saveExportSelection(userId, exportCols)
      setExportOpen(false)
    } catch (err) {
      console.error('Export Excel échoué:', err)
    } finally {
      setExporting(false)
    }
  }, [filteredSorted, exportCols, userId, duDigits, auDigits])

  const toggleExportCol = useCallback((key: string) => {
    setExportCols((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    )
  }, [])

  // Totalizer over the visible rows — signed, and split by TVA rate.
  const totals = useMemo(() => aggregateFactures(filteredSorted), [filteredSorted])

  const dateInputClass =
    'h-9 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring tabular-nums'

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      {/* Toolbar */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Rechercher (n°, client, type, TVA, paiement, échéance, compte…)"
            className="h-9 w-full pl-8 pr-3 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="flex items-center gap-2 text-sm flex-shrink-0">
          <span className="text-muted-foreground">Du</span>
          <input type="date" value={du} onChange={(e) => setDu(e.target.value)} className={dateInputClass} title="Début de la période" />
          <span className="text-muted-foreground">au</span>
          <input type="date" value={au} onChange={(e) => setAu(e.target.value)} className={dateInputClass} title="Fin de la période" />
        </div>

        <PopoverSelect
          size="sm"
          widthClass="w-[160px]"
          hideEmpty
          options={TYPE_FILTER_OPTIONS.map((o) => ({ id: o.id, primary: o.primary }))}
          value={TYPE_FILTER_OPTIONS.find((o) => o.key === typeFilter)?.id ?? 1}
          onChange={(id) => setTypeFilter(TYPE_FILTER_OPTIONS.find((o) => o.id === id)?.key ?? 'all')}
        />

        <PopoverSelect
          size="sm"
          widthClass="w-[130px]"
          emptyLabel="Tous les taux"
          options={rates.map((rate, i) => ({ id: i + 1, primary: `TVA ${rateFmt(rate)}` }))}
          value={tvaFilterIdx}
          onChange={setTvaFilterIdx}
        />

        <label className="flex items-center gap-2 text-sm cursor-pointer select-none flex-shrink-0">
          <input
            type="checkbox"
            checked={nonEnvoyees}
            onChange={(e) => setNonEnvoyees(e.target.checked)}
            className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
          />
          <span>Non envoyées</span>
        </label>

        <Button
          size="sm"
          onClick={() => setExportOpen(true)}
          disabled={filteredSorted.length === 0}
          className="flex-shrink-0"
          title="Exporter Excel"
        >
          <FileSpreadsheet className="h-3.5 w-3.5 sm:mr-1.5" />
          <span className="hidden sm:inline">Exporter Excel</span>
        </Button>
      </div>

      {data?.truncated && (
        <div className="flex-shrink-0 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          Période tronquée aux 3 000 factures les plus récentes — réduisez la période pour un total exact.
        </div>
      )}

      {/* Table */}
      <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border/60 bg-white shadow-sm overflow-hidden">
        {!periodValid ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <AlertCircle className="h-8 w-8 opacity-40" />
            <p className="text-sm">Période invalide — la date de début doit précéder la date de fin</p>
          </div>
        ) : isLoading ? (
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
            <ReceiptText className="h-12 w-12 opacity-30" />
            <p className="text-sm">Aucune facture sur la période</p>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto scrollbar-transparent">
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
                {filteredSorted.map((r) => {
                  const isAvoir = r.type === 2
                  const money = cn('px-2.5 py-2 text-right tabular-nums', isAvoir && 'text-orange-700')
                  return (
                    <tr
                      key={r.id}
                      onClick={() => openFacture(r)}
                      title="Ouvrir dans Clients › Facturation"
                      className="border-b border-border/40 transition-colors cursor-pointer hover:bg-accent/5"
                    >
                      <td className="px-2.5 py-2 text-right tabular-nums font-medium">{r.numero ?? '—'}</td>
                      <td className="px-2.5 py-2 text-right tabular-nums">{dateFmt(r.date) || '—'}</td>
                      <td className="px-2.5 py-2 truncate" title={r.client_nom || undefined}>
                        {r.client_nom || '—'}
                      </td>
                      <td className="px-2.5 py-2 truncate text-muted-foreground" title={r.pays || undefined}>
                        {r.pays || '—'}
                      </td>
                      <td className="px-2.5 py-2">
                        <TypePill type={r.type} />
                      </td>
                      <td className={money}>{eurFmt(signed(r.total_ht, r.type))}</td>
                      <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground" title={r.tva_label || undefined}>
                        {rateFmt(r.tva_rate)}
                      </td>
                      <td className={cn(money, r.total_tva === 0 && 'text-muted-foreground')}>
                        {eurFmt(signed(r.total_tva, r.type))}
                      </td>
                      <td className={cn(money, 'font-medium')}>{eurFmt(signed(r.total_ttc, r.type))}</td>
                      <td className="px-2.5 py-2 text-center">
                        {r.est_envoye ? (
                          <MailCheck className="h-4 w-4 inline-block text-green-600" aria-label="Envoyée" />
                        ) : (
                          <MailX className="h-4 w-4 inline-block text-red-500" aria-label="Non envoyée" />
                        )}
                      </td>
                      <td className="px-2.5 py-2 truncate text-muted-foreground" title={r.mode_paiement || undefined}>
                        {r.mode_paiement || '—'}
                      </td>
                      <td className="px-2.5 py-2 truncate text-muted-foreground" title={r.echeance_label || undefined}>
                        {r.echeance_label || '—'}
                      </td>
                      <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">
                        {dateFmt(r.date_echeance) || '—'}
                      </td>
                      <td className="px-2.5 py-2 truncate text-muted-foreground" title={r.code_comptable || undefined}>
                        {r.code_comptable || '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Totalizer — signed totals of the visible rows + the split by TVA rate */}
      {periodValid && !isLoading && !isError && filteredSorted.length > 0 && (
        <div className="flex-shrink-0 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-lg border border-border/60 bg-zinc-100/80 shadow-sm px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            <div className="flex items-center gap-2">
              <ReceiptText className="h-4 w-4 text-accent" />
              <span className="font-semibold tabular-nums">{totals.nbFactures}</span>
              <span className="text-muted-foreground">facture{totals.nbFactures > 1 ? 's' : ''}</span>
              {totals.nbAvoirs > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="font-semibold tabular-nums">{totals.nbAvoirs}</span>
                  <span className="text-muted-foreground">avoir{totals.nbAvoirs > 1 ? 's' : ''}</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5 border-l border-border/60 pl-5">
              <span className="text-muted-foreground">HT</span>
              <span className="font-semibold tabular-nums">{eurFmt(totals.ht)}</span>
            </div>
            <div className="flex items-center gap-1.5 border-l border-border/60 pl-5">
              <span className="text-muted-foreground">TVA</span>
              <span className="font-semibold tabular-nums">{eurFmt(totals.tva)}</span>
            </div>
            <div className="flex items-center gap-1.5 border-l border-border/60 pl-5">
              <span className="text-muted-foreground">TTC</span>
              <span className="font-semibold tabular-nums">{eurFmt(totals.ttc)}</span>
            </div>
          </div>
          {/* Par taux — the split the TVA return needs, one chip per rate */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {totals.byRate.map((b) => (
              <div
                key={b.rate}
                className="flex items-center gap-2 rounded-md border border-border/60 bg-white px-2.5 py-1 tabular-nums"
                title={`${b.count} document${b.count > 1 ? 's' : ''} à ${rateFmt(b.rate)}`}
              >
                <span className="font-semibold text-accent-foreground bg-accent rounded px-1.5 py-0.5 text-[11px]">
                  {rateFmt(b.rate)}
                </span>
                <span className="text-muted-foreground">HT</span>
                <span className="font-medium">{eurFmt(b.ht)}</span>
                <span className="text-muted-foreground">TVA</span>
                <span className="font-medium">{eurFmt(b.tva)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Column-picker dialog for the Excel export */}
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="max-w-md" onClose={() => setExportOpen(false)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Columns3 className="h-5 w-5 text-accent" />
              Colonnes à exporter
            </DialogTitle>
          </DialogHeader>

          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                {exportCols.length} colonne{exportCols.length > 1 ? 's' : ''} sélectionnée
                {exportCols.length > 1 ? 's' : ''}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-accent hover:text-accent hover:bg-accent/10"
                  onClick={() => setExportCols(EXPORT_COLUMN_KEYS)}
                >
                  Tout sélectionner
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground"
                  onClick={() => setExportCols([])}
                >
                  Tout désélectionner
                </Button>
              </div>
            </div>

            <div className="max-h-[50vh] overflow-y-auto scrollbar-transparent rounded-md border border-border/60 divide-y divide-border/40">
              {EXPORT_COLUMNS.map((c) => {
                const checked = exportCols.includes(c.key)
                return (
                  <label
                    key={c.key}
                    className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer select-none hover:bg-accent/5 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleExportCol(c.key)}
                      className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
                    />
                    <span>{c.label}</span>
                  </label>
                )
              })}
            </div>
          </div>

          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setExportOpen(false)}>
              Annuler
            </Button>
            <Button onClick={handleExport} disabled={exporting || exportCols.length === 0}>
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" />
              )}
              Exporter
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Sort header cell ───────────────────────────────────

interface SortHeaderProps {
  label: string
  sortKey: SortKey
  sort: SortState
  onSort: (k: SortKey) => void
  align?: 'left' | 'right' | 'center'
}
function SortHeader({ label, sortKey, sort, onSort, align = 'left' }: SortHeaderProps) {
  const active = sort.key === sortKey
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={cn(
        'px-2.5 py-2 font-semibold cursor-pointer select-none',
        align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
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
