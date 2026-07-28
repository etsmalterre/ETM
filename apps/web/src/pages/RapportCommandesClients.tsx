import { useState, useMemo, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Search,
  Loader2,
  AlertCircle,
  ArrowUp,
  ArrowDown,
  ClipboardList,
  ReceiptText,
  FileSpreadsheet,
  Columns3,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { formatHfsqlDate } from '@/lib/dates'
import { apiFetch } from '@/lib/api'
import { useUser } from '@/contexts/UserContext'
import { fmtNum } from '@/lib/format'

// ── Types ──────────────────────────────────────────────
//
// One row per ligne_commande_client — see the endpoint header in
// apps/api/src/routes/rapports.ts for the exact meaning of the four
// quantity columns (expédiée / affectée / en sst / stock libre) and of
// `total_ht_non_facture`.

interface RapportClientLine {
  IDligne_commande_client: number
  IDcommande_client: number
  numero: number | null
  client_nom: string
  ref_client: string
  facturation_nom: string
  livraison_nom: string
  reference: string
  coloris: string
  designation: string
  type_kind: number
  unite_label: string
  poids: number
  qte_commandee: number
  qte_expediee: number
  qte_stock: number
  qte_affectee: number
  qte_en_sst: number
  prix: number
  total_ht: number
  total_ht_non_facture: number
  delai: string | null
  retard_jours: number | null
  commentaire_ligne: string
  commentaire_client: string
  commentaire_interne: string
  urgency: 'late' | 'soon' | null
  est_soldee: number
}

// ── Formatting helpers ─────────────────────────────────

/** Quantity with its unit — integers without decimals, else one decimal. */
function qtyFmt(v: number, unit: string): string {
  const num = fmtNum(v, Number.isInteger(v) ? 0 : 1)
  return unit ? `${num} ${unit}` : num
}
/** € amount, always two decimals. */
function eurFmt(v: number): string {
  return `${fmtNum(v, 2)} €`
}
/** Signed day count, e.g. "67 j". */
function daysFmt(v: number | null): string {
  if (v == null) return ''
  return `${fmtNum(v, 0)} j`
}
function dateFmt(v: string | null): string {
  return v && /^\d{8}$/.test(v) ? formatHfsqlDate(v) : ''
}
/**
 * Parse an HFSQL "YYYYMMDD" string into a real JS `Date` (local midnight) for
 * Excel export. Returning a `Date` (rather than a formatted string) lets
 * SheetJS write a true date cell, so Excel sorts the column chronologically
 * instead of lexically. Empty/invalid values → `null` (blank cell).
 */
function dateVal(v: string | null): Date | null {
  if (!v || !/^\d{8}$/.test(v)) return null
  return new Date(Number(v.slice(0, 4)), Number(v.slice(4, 6)) - 1, Number(v.slice(6, 8)))
}

// ── Excel export column catalog ─────────────────────────
//
// One entry per exportable column: a stable `key` (used to persist the user's
// selection), the header label, the cell value getter, and the Excel column
// width (`wch`). The user picks which of these go into the workbook via the
// column-picker dialog; the choice is remembered in localStorage.
//
// Quantities arrive as floats with FP noise. Round to 1 decimal (2 for money)
// but keep them as numbers so Excel can still sum the columns.
const qty1 = (v: number) => Math.round(v * 10) / 10
const eur2 = (v: number) => Math.round(v * 100) / 100

interface ExportColumn {
  key: string
  label: string
  width: number
  /** 'date' columns emit real `Date` cells so Excel sorts them chronologically. */
  kind?: 'date'
  value: (r: RapportClientLine) => string | number | Date | null
}
const EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'numero', label: 'Numéro commande', width: 14, value: (r) => r.numero ?? '' },
  { key: 'client', label: 'Client', width: 24, value: (r) => r.client_nom || '' },
  { key: 'ref_client', label: 'Ref commande client', width: 28, value: (r) => r.ref_client || '' },
  { key: 'facturation', label: 'Facturation', width: 24, value: (r) => r.facturation_nom || '' },
  { key: 'livraison', label: 'Livraison', width: 24, value: (r) => r.livraison_nom || '' },
  { key: 'reference', label: 'Référence', width: 12, value: (r) => r.reference || '' },
  { key: 'coloris', label: 'Coloris', width: 22, value: (r) => r.coloris || '' },
  { key: 'designation', label: 'Désignation', width: 26, value: (r) => r.designation || '' },
  { key: 'poids', label: 'Poids', width: 9, value: (r) => qty1(r.poids) },
  { key: 'qte_commandee', label: 'Qté commandée', width: 13, value: (r) => qty1(r.qte_commandee) },
  { key: 'qte_expediee', label: 'Qté expédiée', width: 12, value: (r) => qty1(r.qte_expediee) },
  { key: 'qte_stock', label: 'Qté stock', width: 11, value: (r) => qty1(r.qte_stock) },
  { key: 'qte_affectee', label: 'Affecté', width: 11, value: (r) => qty1(r.qte_affectee) },
  { key: 'qte_en_sst', label: 'En SST', width: 11, value: (r) => qty1(r.qte_en_sst) },
  { key: 'unite', label: 'Unité', width: 7, value: (r) => r.unite_label },
  { key: 'prix', label: 'Prix unitaire', width: 12, value: (r) => eur2(r.prix) },
  { key: 'total_ht', label: 'Total HT', width: 13, value: (r) => eur2(r.total_ht) },
  { key: 'total_ht_non_facture', label: 'Total HT non facturé', width: 18, value: (r) => eur2(r.total_ht_non_facture) },
  { key: 'delai', label: 'Délai', width: 12, kind: 'date', value: (r) => dateVal(r.delai) },
  { key: 'retard', label: 'Retard (j)', width: 9, value: (r) => r.retard_jours ?? '' },
  { key: 'commentaire_ligne', label: 'Commentaire de la ligne', width: 40, value: (r) => r.commentaire_ligne || '' },
  { key: 'commentaire_client', label: 'Commentaire pour le client', width: 40, value: (r) => r.commentaire_client || '' },
  { key: 'commentaire_interne', label: 'Commentaire interne', width: 40, value: (r) => r.commentaire_interne || '' },
]
const EXPORT_COLUMN_KEYS = EXPORT_COLUMNS.map((c) => c.key)

// Persisted column selection, keyed by user id so people sharing (or
// switching users on) a PC don't overwrite each other's choice. Temporary:
// localStorage only — replace with a server-side per-user preference once
// proper user management lands post-migration.
const EXPORT_PREF_KEY_BASE = 'mps:rapport-commandes-clients:export-columns'
const exportPrefKey = (userId: number | null) =>
  userId == null ? EXPORT_PREF_KEY_BASE : `${EXPORT_PREF_KEY_BASE}:${userId}`

function loadExportSelection(userId: number | null): string[] {
  try {
    const raw =
      localStorage.getItem(exportPrefKey(userId)) ??
      localStorage.getItem(EXPORT_PREF_KEY_BASE)
    if (!raw) return EXPORT_COLUMN_KEYS
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return EXPORT_COLUMN_KEYS
    // Keep only keys that still exist (and in canonical column order), so a
    // stored selection survives future column additions/removals gracefully.
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
  | 'client_nom'
  | 'ref_client'
  | 'facturation_nom'
  | 'livraison_nom'
  | 'reference'
  | 'coloris'
  | 'designation'
  | 'poids'
  | 'qte_commandee'
  | 'qte_expediee'
  | 'qte_stock'
  | 'qte_affectee'
  | 'qte_en_sst'
  | 'total_ht_non_facture'
  | 'delai'
  | 'retard_jours'
  | 'commentaire_ligne'
  | 'commentaire_client'
  | 'commentaire_interne'

interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

// Column widths (px) — the table is wider than the viewport, so the panel
// scrolls horizontally; the header is sticky vertically.
const COLUMNS: { key: SortKey; label: string; width: number; align?: 'left' | 'right' }[] = [
  { key: 'numero', label: 'Numéro', width: 78, align: 'right' },
  { key: 'client_nom', label: 'Client', width: 140 },
  { key: 'ref_client', label: 'Ref commande client', width: 170 },
  { key: 'facturation_nom', label: 'Facturation', width: 140 },
  { key: 'livraison_nom', label: 'Livraison', width: 150 },
  { key: 'reference', label: 'Référence', width: 90 },
  { key: 'coloris', label: 'Coloris', width: 150 },
  { key: 'designation', label: 'Désignation', width: 170 },
  { key: 'poids', label: 'Poids', width: 72, align: 'right' },
  { key: 'qte_commandee', label: 'Qté commandée', width: 108, align: 'right' },
  { key: 'qte_expediee', label: 'Qté expédiée', width: 104, align: 'right' },
  { key: 'qte_stock', label: 'Qté stock', width: 98, align: 'right' },
  { key: 'qte_affectee', label: 'Affecté', width: 98, align: 'right' },
  { key: 'qte_en_sst', label: 'En SST', width: 94, align: 'right' },
  { key: 'total_ht_non_facture', label: 'Total HT non facturé', width: 124, align: 'right' },
  { key: 'delai', label: 'Délai', width: 92, align: 'right' },
  { key: 'retard_jours', label: 'Retard', width: 78, align: 'right' },
  { key: 'commentaire_ligne', label: 'Commentaire de la ligne', width: 190 },
  { key: 'commentaire_client', label: 'Commentaire pour le client', width: 185 },
  { key: 'commentaire_interne', label: 'Commentaire interne', width: 185 },
]
const TABLE_MIN_WIDTH = COLUMNS.reduce((s, c) => s + c.width, 0)

const COLLATOR = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })
function compareRows(a: RapportClientLine, b: RapportClientLine, key: SortKey): number {
  const va = a[key]
  const vb = b[key]
  if (va == null && vb == null) return 0
  if (va == null) return 1
  if (vb == null) return -1
  if (typeof va === 'number' && typeof vb === 'number') return va - vb
  return COLLATOR.compare(String(va), String(vb))
}

// ── Data hook ──────────────────────────────────────────

function useRapport(soldees: boolean) {
  return useQuery<RapportClientLine[]>({
    queryKey: ['rapport-commandes-clients', { soldees }],
    queryFn: () =>
      apiFetch<RapportClientLine[]>(`/rapports/commandes-clients?soldees=${soldees ? '1' : '0'}`),
    // Read-only report: refetch every time the screen is consulted (each mount)
    // so the numbers are always live, with no manual "Actualiser" needed.
    // staleTime 0 = always stale → refetchOnMount (default true) refetches.
    // Disable window-focus refetch so alt-tabbing doesn't hammer the shared
    // HFSQL bridge (this aggregate query is heavy).
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
}

// ── Main Page ──────────────────────────────────────────

export function RapportCommandesClients() {
  const [searchQuery, setSearchQuery] = useState('')
  const [showSoldees, setShowSoldees] = useState(false)
  const [sort, setSort] = useState<SortState>({ key: 'numero', dir: 'desc' })

  const { data: rows, isLoading, isError, error } = useRapport(showSoldees)

  const filteredSorted = useMemo(() => {
    let out = rows ?? []
    const terms = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length > 0) {
      out = out.filter((r) => {
        const haystacks = [
          String(r.numero ?? ''),
          r.client_nom,
          r.ref_client,
          r.facturation_nom,
          r.livraison_nom,
          r.reference,
          r.coloris,
          r.designation,
          r.commentaire_ligne,
          r.commentaire_client,
          r.commentaire_interne,
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
  }, [rows, searchQuery, sort])

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }, [])

  // Excel export of the currently visible (search-filtered + sorted) rows.
  // Clicking "Exporter Excel" opens a column-picker dialog; the actual export
  // (SheetJS lazy-loaded so it stays out of the main bundle) runs on confirm,
  // limited to the columns the user selected. The selection is remembered.
  const [exporting, setExporting] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const { user } = useUser()
  const userId = user?.IDutilisateur ?? null
  const [exportCols, setExportCols] = useState<string[]>(() => loadExportSelection(userId))

  // Re-read the saved selection if the logged-in user changes (user picker /
  // admin impersonation) without the page remounting.
  useEffect(() => {
    setExportCols(loadExportSelection(userId))
  }, [userId])

  const handleExport = useCallback(async () => {
    if (filteredSorted.length === 0) return
    // Keep canonical column order regardless of click order, and never export
    // an empty workbook (guarded again at the button, belt-and-suspenders).
    const cols = EXPORT_COLUMNS.filter((c) => exportCols.includes(c.key))
    if (cols.length === 0) return
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const aoa: (string | number | Date | null)[][] = [
        cols.map((c) => c.label),
        ...filteredSorted.map((r) => cols.map((c) => c.value(r))),
      ]
      // cellDates → Date values become real date cells (t:'d'). Excel then sorts
      // them chronologically; formatted French text strings would sort lexically.
      const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true })
      ws['!cols'] = cols.map((c) => ({ wch: c.width }))
      // Stamp the French display format on each date cell — the underlying
      // serial number is what makes the column sortable.
      cols.forEach((c, colIdx) => {
        if (c.kind !== 'date') return
        for (let rowIdx = 1; rowIdx <= filteredSorted.length; rowIdx++) {
          const cell = ws[XLSX.utils.encode_cell({ r: rowIdx, c: colIdx })]
          if (cell && cell.t === 'd') cell.z = 'dd/mm/yyyy'
        }
      })
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Commandes clients')
      const stamp = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `Commandes_clients_${stamp}.xlsx`)
      saveExportSelection(userId, exportCols)
      setExportOpen(false)
    } catch (err) {
      console.error('Export Excel échoué:', err)
    } finally {
      setExporting(false)
    }
  }, [filteredSorted, exportCols, userId])

  const toggleExportCol = useCallback((key: string) => {
    setExportCols((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    )
  }, [])

  // Totalizer over the visible (filtered) rows.
  const lineCount = filteredSorted.length
  const lateCount = filteredSorted.filter((r) => r.urgency === 'late').length
  const soonCount = filteredSorted.filter((r) => r.urgency === 'soon').length
  const totalNonFacture = filteredSorted.reduce((s, r) => s + r.total_ht_non_facture, 0)

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      {/* Toolbar */}
      <div className="flex-shrink-0 flex items-center gap-3">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Rechercher (n°, client, réf commande, adresse, réf, coloris, désignation, commentaire…)"
            className="h-9 w-full pl-8 pr-3 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer select-none flex-shrink-0">
          <input
            type="checkbox"
            checked={showSoldees}
            onChange={(e) => setShowSoldees(e.target.checked)}
            className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
          />
          <span>Voir les commandes soldées</span>
        </label>

        <Button
          size="sm"
          onClick={() => setExportOpen(true)}
          disabled={filteredSorted.length === 0}
          className="flex-shrink-0"
        >
          <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" />
          Exporter Excel
        </Button>
      </div>

      {/* Table */}
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
            <ClipboardList className="h-12 w-12 opacity-30" />
            <p className="text-sm">Aucune ligne à afficher</p>
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
                {filteredSorted.map((r) => (
                  <tr
                    key={r.IDligne_commande_client}
                    className={cn(
                      'border-b border-border/40 transition-colors',
                      r.urgency === 'late'
                        ? 'bg-red-50 hover:bg-red-100/70'
                        : r.urgency === 'soon'
                          ? 'bg-amber-50 hover:bg-amber-100/70'
                          : 'hover:bg-accent/5',
                    )}
                  >
                    <td className="px-2.5 py-2 text-right tabular-nums font-medium">{r.numero ?? '—'}</td>
                    <td className="px-2.5 py-2 truncate" title={r.client_nom || undefined}>
                      {r.client_nom || '—'}
                    </td>
                    <td className="px-2.5 py-2 truncate text-muted-foreground" title={r.ref_client || undefined}>
                      {r.ref_client || ''}
                    </td>
                    <td className="px-2.5 py-2 truncate text-muted-foreground" title={r.facturation_nom || undefined}>
                      {r.facturation_nom || ''}
                    </td>
                    <td className="px-2.5 py-2 truncate text-muted-foreground" title={r.livraison_nom || undefined}>
                      {r.livraison_nom || ''}
                    </td>
                    <td className="px-2.5 py-2 truncate" title={r.reference || undefined}>
                      {r.reference || '—'}
                    </td>
                    <td className="px-2.5 py-2 truncate" title={r.coloris || undefined}>
                      {r.coloris || '—'}
                    </td>
                    <td className="px-2.5 py-2 truncate text-muted-foreground" title={r.designation || undefined}>
                      {r.designation || ''}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">
                      {fmtNum(r.poids, Number.isInteger(r.poids) ? 0 : 1)}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums font-medium">
                      {qtyFmt(r.qte_commandee, r.unite_label)}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">
                      {qtyFmt(r.qte_expediee, r.unite_label)}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">
                      {qtyFmt(r.qte_stock, r.unite_label)}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">
                      {qtyFmt(r.qte_affectee, r.unite_label)}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">
                      {qtyFmt(r.qte_en_sst, r.unite_label)}
                    </td>
                    <td
                      className={cn(
                        'px-2.5 py-2 text-right tabular-nums',
                        r.total_ht_non_facture > 0 ? 'font-medium' : 'text-muted-foreground',
                      )}
                    >
                      {eurFmt(r.total_ht_non_facture)}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{dateFmt(r.delai) || '—'}</td>
                    <td
                      className={cn(
                        'px-2.5 py-2 text-right tabular-nums',
                        r.retard_jours != null && r.retard_jours > 0 && 'text-red-600 font-medium',
                      )}
                    >
                      {r.retard_jours != null ? daysFmt(r.retard_jours) : ''}
                    </td>
                    <td className="px-2.5 py-2 text-muted-foreground truncate" title={r.commentaire_ligne || undefined}>
                      {r.commentaire_ligne || ''}
                    </td>
                    <td className="px-2.5 py-2 text-muted-foreground truncate" title={r.commentaire_client || undefined}>
                      {r.commentaire_client || ''}
                    </td>
                    <td className="px-2.5 py-2 text-muted-foreground truncate" title={r.commentaire_interne || undefined}>
                      {r.commentaire_interne || ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Totalizer */}
      {!isLoading && !isError && filteredSorted.length > 0 && (
        <div className="flex-shrink-0 flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-zinc-100/80 shadow-sm px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm">
            <ClipboardList className="h-4 w-4 text-accent" />
            <span className="font-semibold tabular-nums">{lineCount}</span>
            <span className="text-muted-foreground">ligne{lineCount > 1 ? 's' : ''}</span>
          </div>
          <div className="flex items-center gap-5 text-sm">
            <div className="flex items-center gap-1.5">
              <ReceiptText className="h-4 w-4 text-accent" />
              <span className="text-muted-foreground">Total HT non facturé</span>
              <span className="font-semibold tabular-nums">{eurFmt(totalNonFacture)}</span>
            </div>
            <div className="flex items-center gap-1.5 border-l border-border/60 pl-5">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
              <span className="text-muted-foreground">En retard</span>
              <span className="font-semibold tabular-nums">{lateCount}</span>
            </div>
            <div className="flex items-center gap-1.5 border-l border-border/60 pl-5">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
              <span className="text-muted-foreground">À surveiller</span>
              <span className="font-semibold tabular-nums">{soonCount}</span>
            </div>
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
