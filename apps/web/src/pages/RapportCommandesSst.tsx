import { useState, useMemo, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Search,
  Loader2,
  AlertCircle,
  ArrowUp,
  ArrowDown,
  BellRing,
  ClipboardList,
  Mail,
  Hourglass,
  Clock,
  Eye,
  Send,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
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
import { cn } from '@/lib/utils'
import { formatHfsqlDate } from '@/lib/dates'
import { apiFetch } from '@/lib/api'
import { useUser } from '@/contexts/UserContext'
import { fmtNum } from '@/lib/format'

// ── Types ──────────────────────────────────────────────

interface RapportLine {
  IDligne_commande_sous_traitant: number
  IDcommande_sous_traitant: number
  sstatut: string | null
  sous_traitant_nom: string
  reference: string
  coloris: string
  type_kind: number
  unite_label: 'Ml' | 'Kg' | 'U'
  qte_commandee: number
  qte_affectee: number
  qte_receptionnee: number
  date_commande: string | null
  delai_initial: string | null
  delai_actuel: string | null
  delai_client: string | null
  date_relance: string | null
  retard_jours: number | null
  marge_jours: number | null
  client_nom: string
  commentaire: string
  journal: string
  urgency: 'late' | 'soon' | null
  est_soldee: number
}

// ── Line status pill meta ──────────────────────────────
//
// Maps the raw legacy `sstatut` enum to a friendly French label + solid
// color, mirroring SST_PHASE_META in SousTraitantsCommandes.tsx. Unknown
// legacy values fall back to a humanised label on a neutral pill.
interface StatutMeta {
  label: string
  icon: LucideIcon
  solid: string
}
const LINE_STATUT_META: Record<string, StatutMeta> = {
  Non_Envoye: { label: 'Non envoyé', icon: Mail, solid: 'bg-slate-500 border-slate-500' },
  Attente_Delai: { label: 'Attente délai', icon: Hourglass, solid: 'bg-yellow-500 border-yellow-500' },
  En_Cours: { label: 'En cours', icon: Clock, solid: 'bg-primary border-primary' },
  Notification: { label: 'Notifié', icon: BellRing, solid: 'bg-sky-500 border-sky-500' },
  Soumis_Au_Client: { label: 'Soumis au client', icon: Send, solid: 'bg-violet-500 border-violet-500' },
  A_Soumettre: { label: 'À soumettre', icon: Send, solid: 'bg-teal-500 border-teal-500' },
  'En_Contrôle': { label: 'En contrôle', icon: Eye, solid: 'bg-amber-500 border-amber-500' },
  En_Reprise: { label: 'En reprise', icon: RotateCcw, solid: 'bg-orange-500 border-orange-500' },
  'Delai_Expiré': { label: 'Délai expiré', icon: AlertTriangle, solid: 'bg-red-500 border-red-500' },
  'Non_Affecté': { label: 'Non affecté', icon: Hourglass, solid: 'bg-zinc-400 border-zinc-400' },
  'En_Création': { label: 'En création', icon: ClipboardList, solid: 'bg-zinc-400 border-zinc-400' },
  'Terminé': { label: 'Terminé', icon: CheckCircle2, solid: 'bg-success border-success' },
}
function statutMeta(sstatut: string | null): StatutMeta {
  const key = (sstatut ?? '').trim()
  if (key && LINE_STATUT_META[key]) return LINE_STATUT_META[key]
  return {
    label: key ? key.replace(/_/g, ' ') : '—',
    icon: ClipboardList,
    solid: 'bg-zinc-500 border-zinc-500',
  }
}

function StatutPill({ sstatut }: { sstatut: string | null }) {
  const meta = statutMeta(sstatut)
  const Icon = meta.icon
  return (
    <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white whitespace-nowrap', meta.solid)}>
      <Icon className="h-2.5 w-2.5 flex-shrink-0" />
      {meta.label}
    </Badge>
  )
}

// ── Formatting helpers ─────────────────────────────────

/** Quantity with its unit — integers without decimals, else one decimal. */
function qtyFmt(v: number, unit: string): string {
  return `${fmtNum(v, Number.isInteger(v) ? 0 : 1)} ${unit}`
}
/** Signed day count, e.g. "67 j" / "-1 095 j". */
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
// Quantities arrive as floats with FP noise (e.g. 36.20000076). Round to 1
// decimal but keep them as numbers so Excel can still sum the columns.
const qty1 = (v: number) => Math.round(v * 10) / 10

interface ExportColumn {
  key: string
  label: string
  width: number
  /** 'date' columns emit real `Date` cells so Excel sorts them chronologically. */
  kind?: 'date'
  value: (r: RapportLine) => string | number | Date | null
}
const EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'statut', label: 'Statut', width: 16, value: (r) => statutMeta(r.sstatut).label },
  { key: 'numero', label: 'Numéro', width: 8, value: (r) => r.IDcommande_sous_traitant },
  { key: 'sous_traitant', label: 'Sous-traitant', width: 22, value: (r) => r.sous_traitant_nom || '' },
  { key: 'reference', label: 'Référence', width: 12, value: (r) => r.reference || '' },
  { key: 'coloris', label: 'Coloris', width: 18, value: (r) => r.coloris || '' },
  { key: 'qte_commandee', label: 'Qté commandée', width: 13, value: (r) => qty1(r.qte_commandee) },
  { key: 'qte_affectee', label: 'Qté affectée', width: 12, value: (r) => qty1(r.qte_affectee) },
  { key: 'qte_receptionnee', label: 'Qté réceptionnée', width: 14, value: (r) => qty1(r.qte_receptionnee) },
  { key: 'unite', label: 'Unité', width: 7, value: (r) => r.unite_label },
  { key: 'date_commande', label: 'Date commande', width: 13, kind: 'date', value: (r) => dateVal(r.date_commande) },
  { key: 'delai_initial', label: 'Délai initial', width: 12, kind: 'date', value: (r) => dateVal(r.delai_initial) },
  { key: 'delai_actuel', label: 'Délai actuel', width: 12, kind: 'date', value: (r) => dateVal(r.delai_actuel) },
  { key: 'retard', label: 'Retard (j)', width: 9, value: (r) => r.retard_jours ?? '' },
  { key: 'delai_client', label: 'Délai client', width: 12, kind: 'date', value: (r) => dateVal(r.delai_client) },
  { key: 'marge', label: 'Marge (j)', width: 9, value: (r) => r.marge_jours ?? '' },
  { key: 'client', label: 'Client', width: 22, value: (r) => r.client_nom || '' },
  { key: 'relance', label: 'Relance', width: 12, kind: 'date', value: (r) => dateVal(r.date_relance) },
  { key: 'commentaire', label: 'Commentaire', width: 40, value: (r) => r.commentaire || '' },
  { key: 'journal', label: 'Journal', width: 40, value: (r) => r.journal || '' },
]
const EXPORT_COLUMN_KEYS = EXPORT_COLUMNS.map((c) => c.key)

// Persisted column selection, keyed by user id so people sharing (or
// switching users on) a PC don't overwrite each other's choice. Temporary:
// localStorage only — replace with a server-side per-user preference once
// proper user management lands post-migration.
const EXPORT_PREF_KEY_BASE = 'mps:rapport-sst:export-columns'
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
  | 'sstatut'
  | 'IDcommande_sous_traitant'
  | 'sous_traitant_nom'
  | 'reference'
  | 'coloris'
  | 'qte_commandee'
  | 'qte_affectee'
  | 'qte_receptionnee'
  | 'date_commande'
  | 'delai_initial'
  | 'delai_actuel'
  | 'retard_jours'
  | 'delai_client'
  | 'marge_jours'
  | 'client_nom'
  | 'date_relance'
  | 'commentaire'
  | 'journal'

interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

// Column widths (px) — the table is wider than the viewport, so the panel
// scrolls horizontally; the header is sticky vertically.
const COLUMNS: { key: SortKey; label: string; width: number; align?: 'left' | 'right' }[] = [
  { key: 'sstatut', label: 'Statut', width: 130 },
  { key: 'IDcommande_sous_traitant', label: 'Numéro', width: 78, align: 'right' },
  { key: 'sous_traitant_nom', label: 'Sous-traitant', width: 130 },
  { key: 'reference', label: 'Référence', width: 92 },
  { key: 'coloris', label: 'Coloris', width: 132 },
  { key: 'qte_commandee', label: 'Qté commandée', width: 110, align: 'right' },
  { key: 'qte_affectee', label: 'Qté affectée', width: 110, align: 'right' },
  { key: 'qte_receptionnee', label: 'Qté réceptionnée', width: 116, align: 'right' },
  { key: 'date_commande', label: 'Date commande', width: 100, align: 'right' },
  { key: 'delai_initial', label: 'Délai initial', width: 92, align: 'right' },
  { key: 'delai_actuel', label: 'Délai actuel', width: 92, align: 'right' },
  { key: 'retard_jours', label: 'Retard', width: 78, align: 'right' },
  { key: 'delai_client', label: 'Délai client', width: 92, align: 'right' },
  { key: 'marge_jours', label: 'Marge', width: 78, align: 'right' },
  { key: 'client_nom', label: 'Client', width: 130 },
  { key: 'date_relance', label: 'Relance', width: 96, align: 'right' },
  { key: 'commentaire', label: 'Commentaire', width: 200 },
  { key: 'journal', label: 'Journal', width: 220 },
]
const TABLE_MIN_WIDTH = COLUMNS.reduce((s, c) => s + c.width, 0)

const COLLATOR = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })
function compareRows(a: RapportLine, b: RapportLine, key: SortKey): number {
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
  return useQuery<RapportLine[]>({
    queryKey: ['rapport-commandes-sst', { soldees }],
    queryFn: () => apiFetch<RapportLine[]>(`/rapports/commandes-sst?soldees=${soldees ? '1' : '0'}`),
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

export function RapportCommandesSst() {
  const [searchQuery, setSearchQuery] = useState('')
  const [showSoldees, setShowSoldees] = useState(false)
  const [sort, setSort] = useState<SortState>({ key: 'IDcommande_sous_traitant', dir: 'desc' })

  const { data: rows, isLoading, isError, error } = useRapport(showSoldees)

  const filteredSorted = useMemo(() => {
    let out = rows ?? []
    const terms = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length > 0) {
      out = out.filter((r) => {
        const haystacks = [
          statutMeta(r.sstatut).label,
          String(r.IDcommande_sous_traitant),
          r.sous_traitant_nom,
          r.reference,
          r.coloris,
          r.client_nom,
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
      // them chronologically; before this fix the column held French text strings
      // ("24/06/2026") that Excel sorted lexically (by day-of-month).
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
      XLSX.utils.book_append_sheet(wb, ws, 'Commandes sous-traitants')
      const stamp = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `Commandes_sous-traitants_${stamp}.xlsx`)
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
            placeholder="Rechercher (statut, n°, sous-traitant, réf, coloris, client, commentaire, journal…)"
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
                    key={r.IDligne_commande_sous_traitant}
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
                      <StatutPill sstatut={r.sstatut} />
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums font-medium">{r.IDcommande_sous_traitant}</td>
                    <td className="px-2.5 py-2 truncate" title={r.sous_traitant_nom || undefined}>
                      {r.sous_traitant_nom || '—'}
                    </td>
                    <td className="px-2.5 py-2 truncate" title={r.reference || undefined}>
                      {r.reference || '—'}
                    </td>
                    <td className="px-2.5 py-2 truncate" title={r.coloris || undefined}>
                      {r.coloris || '—'}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{qtyFmt(r.qte_commandee, r.unite_label)}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">
                      {qtyFmt(r.qte_affectee, r.unite_label)}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">
                      {qtyFmt(r.qte_receptionnee, r.unite_label)}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">{dateFmt(r.date_commande) || '—'}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">{dateFmt(r.delai_initial) || '—'}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{dateFmt(r.delai_actuel) || '—'}</td>
                    <td
                      className={cn(
                        'px-2.5 py-2 text-right tabular-nums',
                        r.retard_jours != null && r.retard_jours > 0 && 'text-red-600 font-medium',
                      )}
                    >
                      {r.retard_jours != null ? daysFmt(r.retard_jours) : ''}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">{dateFmt(r.delai_client) || '—'}</td>
                    <td
                      className={cn(
                        'px-2.5 py-2 text-right tabular-nums',
                        r.marge_jours != null && r.marge_jours < 0 && 'text-red-600 font-medium',
                      )}
                    >
                      {r.marge_jours != null ? daysFmt(r.marge_jours) : ''}
                    </td>
                    <td className="px-2.5 py-2 truncate" title={r.client_nom || undefined}>
                      {r.client_nom || '—'}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-muted-foreground">{dateFmt(r.date_relance) || '—'}</td>
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
          <div className="flex items-center gap-2 text-sm">
            <ClipboardList className="h-4 w-4 text-accent" />
            <span className="font-semibold tabular-nums">{lineCount}</span>
            <span className="text-muted-foreground">ligne{lineCount > 1 ? 's' : ''}</span>
          </div>
          <div className="flex items-center gap-5 text-sm">
            <div className="flex items-center gap-1.5">
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
