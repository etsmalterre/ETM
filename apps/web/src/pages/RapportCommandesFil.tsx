import { useState, useMemo, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Search,
  Loader2,
  AlertCircle,
  ArrowUp,
  ArrowDown,
  ClipboardList,
  Hourglass,
  Clock,
  PackageOpen,
  PackageCheck,
  CheckCircle2,
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
import { BobineIcon } from '@/components/icons/BobineIcon'
import { cn } from '@/lib/utils'
import { formatHfsqlDate } from '@/lib/dates'
import { apiFetch } from '@/lib/api'
import { useUser } from '@/contexts/UserContext'
import { fmtNum } from '@/lib/format'

// ── Types ──────────────────────────────────────────────

type Phase = 'terminee' | 'recue' | 'partielle' | 'attente_delai' | 'en_cours'

interface RapportFilLine {
  IDref_fil_commande: number
  IDcommande_fil: number
  phase: Phase
  fournisseur_nom: string
  reference: string
  coloris: string
  qte_commandee: number
  qte_recue: number
  qte_restante: number
  nb_lots: number
  prix_unitaire: number
  montant: number
  date_commande: string | null
  date_livraison: string | null
  date_notif: string | null
  retard_jours: number | null
  commentaire: string
  journal: string
  urgency: 'late' | 'soon' | null
  etat_ligne: number
  etat_commande: number
}

// ── Line phase pill meta ───────────────────────────────
//
// A yarn order line only carries etat 0/1, so the API derives a richer
// phase from the delivery date + the linked stock lots. Colors mirror the
// SST report's LINE_STATUT_META so both reports read the same way.
interface PhaseMeta {
  label: string
  icon: LucideIcon
  solid: string
}
const PHASE_META: Record<Phase, PhaseMeta> = {
  attente_delai: { label: 'Attente délai', icon: Hourglass, solid: 'bg-yellow-500 border-yellow-500' },
  en_cours: { label: 'En cours', icon: Clock, solid: 'bg-primary border-primary' },
  partielle: { label: 'Réception partielle', icon: PackageOpen, solid: 'bg-sky-500 border-sky-500' },
  // Fully delivered but the line is still open — the user hasn't clôturé it.
  recue: { label: 'Reçue', icon: PackageCheck, solid: 'bg-teal-500 border-teal-500' },
  terminee: { label: 'Terminée', icon: CheckCircle2, solid: 'bg-success border-success' },
}
function phaseMeta(phase: Phase): PhaseMeta {
  return PHASE_META[phase] ?? { label: '—', icon: ClipboardList, solid: 'bg-zinc-500 border-zinc-500' }
}

function PhasePill({ phase }: { phase: Phase }) {
  const meta = phaseMeta(phase)
  const Icon = meta.icon
  return (
    <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white whitespace-nowrap', meta.solid)}>
      <Icon className="h-2.5 w-2.5 flex-shrink-0" />
      {meta.label}
    </Badge>
  )
}

// ── Formatting helpers ─────────────────────────────────

/** Weight in kg — integers without decimals, else one decimal. */
function kgFmt(v: number): string {
  return `${fmtNum(v, Number.isInteger(v) ? 0 : 1)} Kg`
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
// Quantities arrive as floats with FP noise (e.g. 828.0000076). Round to 1
// decimal but keep them as numbers so Excel can still sum the columns.
const qty1 = (v: number) => Math.round(v * 10) / 10
const eur2 = (v: number) => Math.round(v * 100) / 100

interface ExportColumn {
  key: string
  label: string
  width: number
  /** 'date' columns emit real `Date` cells so Excel sorts them chronologically. */
  kind?: 'date'
  value: (r: RapportFilLine) => string | number | Date | null
}
const EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'statut', label: 'Statut', width: 18, value: (r) => phaseMeta(r.phase).label },
  { key: 'numero', label: 'Numéro', width: 8, value: (r) => r.IDcommande_fil },
  { key: 'fournisseur', label: 'Fournisseur', width: 22, value: (r) => r.fournisseur_nom || '' },
  { key: 'reference', label: 'Référence', width: 24, value: (r) => r.reference || '' },
  { key: 'coloris', label: 'Coloris', width: 14, value: (r) => r.coloris || '' },
  { key: 'qte_commandee', label: 'Qté commandée (Kg)', width: 16, value: (r) => qty1(r.qte_commandee) },
  { key: 'qte_recue', label: 'Qté reçue (Kg)', width: 14, value: (r) => qty1(r.qte_recue) },
  { key: 'qte_restante', label: 'Reste à recevoir (Kg)', width: 17, value: (r) => qty1(r.qte_restante) },
  { key: 'nb_lots', label: 'Lots reçus', width: 10, value: (r) => r.nb_lots },
  { key: 'prix_unitaire', label: 'Prix (€/Kg)', width: 11, value: (r) => eur2(r.prix_unitaire) },
  { key: 'montant', label: 'Montant (€)', width: 12, value: (r) => eur2(r.montant) },
  { key: 'date_commande', label: 'Date commande', width: 13, kind: 'date', value: (r) => dateVal(r.date_commande) },
  { key: 'date_livraison', label: 'Date livraison', width: 13, kind: 'date', value: (r) => dateVal(r.date_livraison) },
  { key: 'retard', label: 'Retard (j)', width: 9, value: (r) => r.retard_jours ?? '' },
  { key: 'date_notif', label: 'Délai notification', width: 15, kind: 'date', value: (r) => dateVal(r.date_notif) },
  { key: 'commentaire', label: 'Commentaire', width: 40, value: (r) => r.commentaire || '' },
  { key: 'journal', label: 'Journal', width: 40, value: (r) => r.journal || '' },
]
const EXPORT_COLUMN_KEYS = EXPORT_COLUMNS.map((c) => c.key)

// Persisted column selection, keyed by user id so people sharing (or
// switching users on) a PC don't overwrite each other's choice. Temporary:
// localStorage only — replace with a server-side per-user preference once
// proper user management lands post-migration.
const EXPORT_PREF_KEY_BASE = 'mps:rapport-fil:export-columns'
const exportPrefKey = (userId: number | null) =>
  userId == null ? EXPORT_PREF_KEY_BASE : `${EXPORT_PREF_KEY_BASE}:${userId}`

function loadExportSelection(userId: number | null): string[] {
  try {
    // Fall back to the pre-per-user shared key so existing selections survive.
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
  | 'phase'
  | 'IDcommande_fil'
  | 'fournisseur_nom'
  | 'reference'
  | 'coloris'
  | 'qte_commandee'
  | 'qte_recue'
  | 'qte_restante'
  | 'prix_unitaire'
  | 'montant'
  | 'date_commande'
  | 'date_livraison'
  | 'retard_jours'
  | 'date_notif'
  | 'commentaire'
  | 'journal'

interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

// Column widths (px) — the table is wider than the viewport, so the panel
// scrolls horizontally; the header is sticky vertically.
const COLUMNS: { key: SortKey; label: string; width: number; align?: 'left' | 'right' }[] = [
  { key: 'phase', label: 'Statut', width: 138 },
  { key: 'IDcommande_fil', label: 'Numéro', width: 78, align: 'right' },
  { key: 'fournisseur_nom', label: 'Fournisseur', width: 140 },
  { key: 'reference', label: 'Référence', width: 168 },
  { key: 'coloris', label: 'Coloris', width: 108 },
  { key: 'qte_commandee', label: 'Qté commandée', width: 112, align: 'right' },
  { key: 'qte_recue', label: 'Qté reçue', width: 100, align: 'right' },
  { key: 'qte_restante', label: 'Reste', width: 96, align: 'right' },
  { key: 'prix_unitaire', label: 'Prix €/Kg', width: 90, align: 'right' },
  { key: 'montant', label: 'Montant', width: 104, align: 'right' },
  { key: 'date_commande', label: 'Date commande', width: 104, align: 'right' },
  { key: 'date_livraison', label: 'Date livraison', width: 104, align: 'right' },
  { key: 'retard_jours', label: 'Retard', width: 78, align: 'right' },
  { key: 'date_notif', label: 'Délai notif.', width: 100, align: 'right' },
  { key: 'commentaire', label: 'Commentaire', width: 200 },
  { key: 'journal', label: 'Journal', width: 220 },
]
const TABLE_MIN_WIDTH = COLUMNS.reduce((s, c) => s + c.width, 0)

// Sorting the Statut column by the raw enum would order alphabetically
// ('attente_delai' < 'en_cours' < …) — rank it by workflow progress instead.
const PHASE_ORDER: Record<Phase, number> = {
  attente_delai: 0,
  en_cours: 1,
  partielle: 2,
  recue: 3,
  terminee: 4,
}

const COLLATOR = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })
function compareRows(a: RapportFilLine, b: RapportFilLine, key: SortKey): number {
  if (key === 'phase') return PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase]
  const va = a[key]
  const vb = b[key]
  if (va == null && vb == null) return 0
  if (va == null) return 1
  if (vb == null) return -1
  if (typeof va === 'number' && typeof vb === 'number') return va - vb
  return COLLATOR.compare(String(va), String(vb))
}

// ── Data hook ──────────────────────────────────────────

function useRapport(terminees: boolean) {
  return useQuery<RapportFilLine[]>({
    queryKey: ['rapport-commandes-fil', { terminees }],
    queryFn: () => apiFetch<RapportFilLine[]>(`/rapports/commandes-fil?terminees=${terminees ? '1' : '0'}`),
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

export function RapportCommandesFil() {
  const [searchQuery, setSearchQuery] = useState('')
  const [showTerminees, setShowTerminees] = useState(false)
  const [sort, setSort] = useState<SortState>({ key: 'IDcommande_fil', dir: 'desc' })

  const { data: rows, isLoading, isError, error } = useRapport(showTerminees)

  const filteredSorted = useMemo(() => {
    let out = rows ?? []
    const terms = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length > 0) {
      out = out.filter((r) => {
        const haystacks = [
          phaseMeta(r.phase).label,
          String(r.IDcommande_fil),
          r.fournisseur_nom,
          r.reference,
          r.coloris,
          r.commentaire,
          r.journal,
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
      // them chronologically; French text strings ("24/06/2026") would be
      // sorted lexically (by day-of-month) instead.
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
      XLSX.utils.book_append_sheet(wb, ws, 'Commandes de fils')
      const stamp = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `Commandes_de_fils_${stamp}.xlsx`)
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
  const totals = useMemo(() => {
    let commande = 0
    let recu = 0
    let montant = 0
    let late = 0
    let soon = 0
    for (const r of filteredSorted) {
      commande += r.qte_commandee
      recu += r.qte_recue
      montant += r.montant
      if (r.urgency === 'late') late++
      else if (r.urgency === 'soon') soon++
    }
    return { commande, recu, montant, late, soon, count: filteredSorted.length }
  }, [filteredSorted])

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
            placeholder="Rechercher (statut, n°, fournisseur, réf, coloris, commentaire, journal…)"
            className="h-9 w-full pl-8 pr-3 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer select-none flex-shrink-0">
          <input
            type="checkbox"
            checked={showTerminees}
            onChange={(e) => setShowTerminees(e.target.checked)}
            className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
          />
          <span>Voir les lignes terminées</span>
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
            <BobineIcon className="h-12 w-12 opacity-30" />
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
                    key={r.IDref_fil_commande}
                    className={cn(
                      'border-b border-border/40 transition-colors',
                      r.urgency === 'late'
                        ? 'bg-red-50 hover:bg-red-100/70'
                        : r.urgency === 'soon'
                          ? 'bg-amber-50 hover:bg-amber-100/70'
                          : 'hover:bg-accent/5',
                    )}
                  >
                    <td className="px-2.5 py-2">
                      <PhasePill phase={r.phase} />
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums font-medium">{r.IDcommande_fil}</td>
                    <td className="px-2.5 py-2 truncate" title={r.fournisseur_nom || undefined}>
                      {r.fournisseur_nom || '—'}
                    </td>
                    <td className="px-2.5 py-2 truncate" title={r.reference || undefined}>
                      {r.reference || '—'}
                    </td>
                    <td className="px-2.5 py-2 truncate" title={r.coloris || undefined}>
                      {r.coloris || '—'}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{kgFmt(r.qte_commandee)}</td>
                    <td
                      className="px-2.5 py-2 text-right tabular-nums text-muted-foreground"
                      title={r.nb_lots > 0 ? `${r.nb_lots} lot${r.nb_lots > 1 ? 's' : ''} lié${r.nb_lots > 1 ? 's' : ''}` : undefined}
                    >
                      {kgFmt(r.qte_recue)}
                    </td>
                    {/* Nothing is outstanding on a settled line — render a dash
                        rather than a column of "0 Kg" across the history. */}
                    <td
                      className={cn(
                        'px-2.5 py-2 text-right tabular-nums',
                        r.qte_restante === 0 && 'text-muted-foreground',
                      )}
                    >
                      {r.phase === 'terminee' || r.phase === 'recue' ? '—' : kgFmt(r.qte_restante)}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">
                      {r.prix_unitaire > 0 ? `${fmtNum(r.prix_unitaire, 2)} €` : '—'}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums">
                      {r.montant > 0 ? `${fmtNum(r.montant, 2)} €` : '—'}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">
                      {dateFmt(r.date_commande) || '—'}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{dateFmt(r.date_livraison) || '—'}</td>
                    <td
                      className={cn(
                        'px-2.5 py-2 text-right tabular-nums',
                        r.retard_jours != null && r.retard_jours > 0 && 'text-red-600 font-medium',
                      )}
                    >
                      {r.retard_jours != null ? daysFmt(r.retard_jours) : ''}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">
                      {dateFmt(r.date_notif) || '—'}
                    </td>
                    <td className="px-2.5 py-2 text-muted-foreground truncate" title={r.commentaire || undefined}>
                      {r.commentaire || ''}
                    </td>
                    <td className="px-2.5 py-2 text-muted-foreground truncate" title={r.journal || undefined}>
                      {r.journal || ''}
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
          <div className="flex items-center gap-5 text-sm">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-accent" />
              <span className="font-semibold tabular-nums">{totals.count}</span>
              <span className="text-muted-foreground">ligne{totals.count > 1 ? 's' : ''}</span>
            </div>
            <div className="flex items-center gap-1.5 border-l border-border/60 pl-5">
              <span className="text-muted-foreground">Commandé</span>
              <span className="font-semibold tabular-nums">{fmtNum(totals.commande, 0)} Kg</span>
            </div>
            <div className="flex items-center gap-1.5 border-l border-border/60 pl-5">
              <span className="text-muted-foreground">Reçu</span>
              <span className="font-semibold tabular-nums">{fmtNum(totals.recu, 0)} Kg</span>
            </div>
            <div className="flex items-center gap-1.5 border-l border-border/60 pl-5">
              <span className="text-muted-foreground">Montant</span>
              <span className="font-semibold tabular-nums">{fmtNum(totals.montant, 2)} €</span>
            </div>
          </div>
          <div className="flex items-center gap-5 text-sm">
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
              <span className="text-muted-foreground">En retard</span>
              <span className="font-semibold tabular-nums">{totals.late}</span>
            </div>
            <div className="flex items-center gap-1.5 border-l border-border/60 pl-5">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
              <span className="text-muted-foreground">À surveiller</span>
              <span className="font-semibold tabular-nums">{totals.soon}</span>
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
