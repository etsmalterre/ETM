// Qualité › Analyse (LIVA #1289) — history of every validated lot: the
// référentiel, the dyer's control (« Sous-traitant ») and ours (the tirelle,
// « Interne »), each with its écart to the référentiel, in the measure's unit.
// Port of the legacy FI_Analyse_Qualite_ETM; rules in API lib/analyse-qualite.ts.
// Tableau layout (mps_designer §27), read-only: no drawer — a row opens the
// lot in Suivi lots. Filtering, sorting, synthesis and the Excel export all
// run on the one list the API returns.
import { useCallback, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  FileSpreadsheet,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PopoverSelect } from '@/components/ui/popover-select'
import {
  SmartSearchInput,
  filterRowsByChips,
  type SearchChip,
} from '@/components/stock/SmartSearchInput'
import { apiFetch } from '@/lib/api'
import { formatHfsqlDate } from '@/lib/dates'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'

// ── Types (null fields are left out of the JSON) ───────

type Mesure = 'laize' | 'poids' | 'rendement' | 'stabh' | 'stabl'
type Champ = 'ref' | 'sst' | 'ecart_sst' | 'interne' | 'ecart_interne'

interface ValeursMesure {
  ref?: number
  sst?: number
  interne?: number
  ecart_sst?: number
  ecart_interne?: number
  hors_sst?: boolean
  hors_interne?: boolean
}

interface LotAnalyse {
  idsuivilot: number
  date?: string
  lot: string
  reference: string
  coloris: string
  idsous_traitant: number
  sous_traitant: string
  idcommande_sous_traitant: number
  ref_retraits_fiche: boolean
  rendement_sst_calcule: boolean
  mesures: Record<Mesure, ValeursMesure>
}

// ── Measures ───────────────────────────────────────────

interface MesureMeta {
  key: Mesure
  label: string
  unit: string
  /** Decimals of the values and of the écart. */
  dec: number
  /** No internal control exists for it (rendement: never measured on the tirelle). */
  sansInterne?: boolean
}
const MESURES: MesureMeta[] = [
  { key: 'laize', label: 'Laize', unit: 'cm', dec: 1 },
  { key: 'poids', label: 'Poids', unit: 'g/m²', dec: 1 },
  { key: 'rendement', label: 'Rendement', unit: 'Ml/kg', dec: 2, sansInterne: true },
  { key: 'stabh', label: 'Retrait hauteur', unit: '%', dec: 1 },
  { key: 'stabl', label: 'Retrait largeur', unit: '%', dec: 1 },
]

const CHAMP_LABEL: Record<Champ, string> = {
  ref: 'Réf.',
  sst: 'STT',
  ecart_sst: 'Écart',
  interne: 'Interne',
  ecart_interne: 'Écart',
}

/** Excel headers stand alone, without the grouped header row above them. */
const EXPORT_CHAMP_LABEL: Record<Champ, string> = {
  ref: 'réf.',
  sst: 'STT',
  ecart_sst: 'écart STT',
  interne: 'interne',
  ecart_interne: 'écart interne',
}

/** The sub-columns of a measure for the sources on display. */
function champsDe(m: MesureMeta, showSst: boolean, showInterne: boolean): Champ[] {
  const out: Champ[] = ['ref']
  if (showSst) out.push('sst', 'ecart_sst')
  if (showInterne && !m.sansInterne) out.push('interne', 'ecart_interne')
  return out
}

/** A value without trailing zeros: 155 → « 155 », 155.5 → « 155,5 ». */
function fmtVal(v: number | undefined, dec: number): string {
  if (v == null) return ''
  const d = Number.isInteger(v) ? 0 : dec
  return fmtNum(v, d)
}
/** A signed écart: « +1 », « −2,5 », « 0 ». */
function fmtEcart(v: number | undefined, dec: number): string {
  if (v == null) return ''
  // Round first, so −0,003 at 2 decimals reads « 0 », not « −0,00 ».
  const r = Math.round(v * 10 ** dec) / 10 ** dec
  if (r === 0) return '0'
  const s = fmtVal(Math.abs(r), dec)
  return r > 0 ? `+${s}` : `−${s}`
}

// ── Sort ───────────────────────────────────────────────

type InfoKey = 'date' | 'reference' | 'coloris' | 'sous_traitant' | 'lot'
type SortKey = InfoKey | `${Mesure}.${Champ}`
interface SortState { key: SortKey; dir: 'asc' | 'desc' }

const INFO_COLUMNS: { key: InfoKey; label: string; width: number; align?: 'right' }[] = [
  { key: 'date', label: 'Date', width: 88, align: 'right' },
  { key: 'reference', label: 'Référence', width: 104 },
  { key: 'coloris', label: 'Coloris', width: 180 },
  { key: 'sous_traitant', label: 'Sous-traitant', width: 112 },
  { key: 'lot', label: 'Lot', width: 100 },
]
const MESURE_COL_WIDTH = 64

const COLLATOR = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })

function sortValue(r: LotAnalyse, key: SortKey): string | number | undefined {
  if (key.includes('.')) {
    const [m, c] = key.split('.') as [Mesure, Champ]
    return r.mesures[m]?.[c]
  }
  const v = r[key as InfoKey]
  return v || undefined
}
function compareRows(a: LotAnalyse, b: LotAnalyse, key: SortKey): number {
  const va = sortValue(a, key)
  const vb = sortValue(b, key)
  if (va == null && vb == null) return 0
  if (va == null) return 1
  if (vb == null) return -1
  if (typeof va === 'number' && typeof vb === 'number') return va - vb
  return COLLATOR.compare(String(va), String(vb))
}

// ── Filters ────────────────────────────────────────────

const SEARCH_FIELDS = [
  { key: 'reference', label: 'Référence' },
  { key: 'coloris', label: 'Coloris' },
  { key: 'sous_traitant', label: 'Sous-traitant' },
  { key: 'lot', label: 'Lot' },
] as const
type SearchFieldKey = (typeof SEARCH_FIELDS)[number]['key']

const rowHaystacks = (r: LotAnalyse) =>
  [r.reference, r.coloris, r.sous_traitant, r.lot].map((s) => s.toLowerCase())

const PERIODES = [
  { id: 1, primary: "Tout l'historique", mois: 0 },
  { id: 2, primary: '12 derniers mois', mois: 12 },
  { id: 3, primary: '2 dernières années', mois: 24 },
  { id: 4, primary: '5 dernières années', mois: 60 },
]

/** YYYYMMDD of today minus `mois` months. */
function depuis(mois: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - mois)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** Rows drawn at most — the export always takes every filtered lot. */
const MAX_LIGNES = 500

// ── Synthesis ──────────────────────────────────────────

interface StatSource { n: number; moyenne: number | null; hors: number; jugees: number }
function statSource(rows: LotAnalyse[], m: Mesure, src: 'sst' | 'interne'): StatSource {
  let n = 0
  let somme = 0
  let hors = 0
  let jugees = 0
  for (const r of rows) {
    const v = r.mesures[m]
    const e = src === 'sst' ? v?.ecart_sst : v?.ecart_interne
    if (e != null) { n += 1; somme += e }
    const h = src === 'sst' ? v?.hors_sst : v?.hors_interne
    if (h != null) { jugees += 1; if (h) hors += 1 }
  }
  return { n, moyenne: n > 0 ? somme / n : null, hors, jugees }
}

// ── Page ───────────────────────────────────────────────

export function QualiteAnalyse() {
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchChips, setSearchChips] = useState<SearchChip<SearchFieldKey>[]>([])
  const [periode, setPeriode] = useState(1)
  const [showSst, setShowSst] = useState(true)
  const [showInterne, setShowInterne] = useState(true)
  const [sort, setSort] = useState<SortState>({ key: 'date', dir: 'desc' })
  const [exporting, setExporting] = useState(false)

  const { data: lots, isLoading, isError, error } = useQuery({
    queryKey: ['analyse-qualite-lots'],
    queryFn: () => apiFetch<LotAnalyse[]>('/analyse-qualite/lots'),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  const filteredSorted = useMemo(() => {
    let out = filterRowsByChips(lots ?? [], searchChips, rowHaystacks)
    const terms = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length > 0) {
      out = out.filter((r) => {
        const hs = rowHaystacks(r)
        return terms.every((t) => hs.some((h) => h.includes(t)))
      })
    }
    const mois = PERIODES.find((p) => p.id === periode)?.mois ?? 0
    if (mois > 0) {
      const min = depuis(mois)
      out = out.filter((r) => (r.date ?? '') >= min)
    }
    return [...out].sort((a, b) => {
      const cmp = compareRows(a, b, sort.key)
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [lots, searchChips, searchQuery, periode, sort])

  const groupes = useMemo(
    () => MESURES.map((m) => ({ meta: m, champs: champsDe(m, showSst, showInterne) })),
    [showSst, showInterne],
  )
  const tableWidth =
    INFO_COLUMNS.reduce((s, c) => s + c.width, 0) +
    groupes.reduce((s, g) => s + g.champs.length * MESURE_COL_WIDTH, 0)

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }, [])

  const handleExport = useCallback(async () => {
    if (filteredSorted.length === 0) return
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const header: string[] = INFO_COLUMNS.map((c) => c.label)
      const widths: number[] = [11, 12, 26, 16, 12]
      for (const g of groupes) {
        for (const c of g.champs) {
          header.push(`${g.meta.label} ${EXPORT_CHAMP_LABEL[c]} (${g.meta.unit})`)
          widths.push(14)
        }
      }
      const aoa: (string | number | Date | null)[][] = [header]
      for (const r of filteredSorted) {
        const d = r.date && /^\d{8}$/.test(r.date)
          ? new Date(Number(r.date.slice(0, 4)), Number(r.date.slice(4, 6)) - 1, Number(r.date.slice(6, 8)))
          : null
        const row: (string | number | Date | null)[] = [d, r.reference, r.coloris, r.sous_traitant, r.lot]
        for (const g of groupes) for (const c of g.champs) row.push(r.mesures[g.meta.key]?.[c] ?? null)
        aoa.push(row)
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true })
      ws['!cols'] = widths.map((wch) => ({ wch }))
      for (let i = 1; i <= filteredSorted.length; i++) {
        const cell = ws[XLSX.utils.encode_cell({ r: i, c: 0 })]
        if (cell && cell.t === 'd') cell.z = 'dd/mm/yyyy'
      }
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Analyse qualité')
      XLSX.writeFile(wb, `Analyse_qualite_${new Date().toISOString().slice(0, 10)}.xlsx`)
    } catch (err) {
      console.error('Export Excel échoué:', err)
    } finally {
      setExporting(false)
    }
  }, [filteredSorted, groupes])

  const visibles = filteredSorted.slice(0, MAX_LIGNES)

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      {/* Toolbar */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-3">
        <SmartSearchInput<SearchFieldKey>
          className="order-1 flex-1 min-w-[240px]"
          value={searchQuery}
          onValueChange={setSearchQuery}
          chips={searchChips}
          onChipsChange={setSearchChips}
          fields={SEARCH_FIELDS}
          placeholder="Rechercher (référence, coloris, sous-traitant, lot…)"
        />
        <div className="order-3 sm:order-2 w-full sm:w-auto flex items-center gap-3">
          <PopoverSelect
            size="sm"
            widthClass="w-[170px]"
            hideEmpty
            value={periode}
            onChange={setPeriode}
            options={PERIODES.map((p) => ({ id: p.id, primary: p.primary }))}
          />
          <div className="flex items-center gap-1 rounded-md bg-zinc-200/50 p-0.5">
            <SourceToggle label="Sous-traitant" on={showSst} onToggle={() => setShowSst((v) => !v)} />
            <SourceToggle label="Interne" on={showInterne} onToggle={() => setShowInterne((v) => !v)} />
          </div>
        </div>
        <Button
          size="sm"
          onClick={handleExport}
          disabled={exporting || filteredSorted.length === 0}
          className="order-2 sm:order-3 flex-shrink-0"
          title="Exporter les lots filtrés vers Excel"
        >
          {exporting
            ? <Loader2 className="h-3.5 w-3.5 sm:mr-1.5 animate-spin" />
            : <FileSpreadsheet className="h-3.5 w-3.5 sm:mr-1.5" />}
          <span className="hidden sm:inline">Exporter Excel</span>
        </Button>
      </div>

      {/* Synthesis of the filtered lots */}
      {!isLoading && !isError && filteredSorted.length > 0 && (
        <Synthese rows={filteredSorted} showSst={showSst} showInterne={showInterne} />
      )}

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
            <BarChart3 className="h-12 w-12 opacity-30" />
            <p className="text-sm">Aucun lot validé ne correspond</p>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto scrollbar-transparent">
            <table className="w-full text-[13px]" style={{ minWidth: tableWidth, tableLayout: 'fixed' }}>
              <colgroup>
                {INFO_COLUMNS.map((c) => <col key={c.key} style={{ width: c.width }} />)}
                {groupes.flatMap((g) => g.champs.map((c) => <col key={`${g.meta.key}.${c}`} style={{ width: MESURE_COL_WIDTH }} />))}
              </colgroup>
              <thead className="sticky top-0 z-10 bg-zinc-200">
                <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th colSpan={INFO_COLUMNS.length} />
                  {groupes.map((g) => (
                    <th
                      key={g.meta.key}
                      colSpan={g.champs.length}
                      className="px-2 pt-2 pb-1 text-center font-semibold border-l border-border/60 text-foreground/80"
                    >
                      {g.meta.label} <span className="normal-case font-normal text-muted-foreground">({g.meta.unit})</span>
                    </th>
                  ))}
                </tr>
                <tr className="text-xs uppercase tracking-wide text-muted-foreground border-b border-border/60">
                  {INFO_COLUMNS.map((c) => (
                    <SortHeader key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={handleSort} align={c.align} />
                  ))}
                  {groupes.flatMap((g) =>
                    g.champs.map((c, i) => (
                      <SortHeader
                        key={`${g.meta.key}.${c}`}
                        label={CHAMP_LABEL[c]}
                        sortKey={`${g.meta.key}.${c}`}
                        sort={sort}
                        onSort={handleSort}
                        align="right"
                        className={i === 0 ? 'border-l border-border/60' : undefined}
                      />
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                {visibles.map((r) => (
                  <tr
                    key={r.idsuivilot}
                    onClick={() => navigate(`/qualite/suivi-lots?lot=${r.idsuivilot}`)}
                    title="Ouvrir le lot dans Suivi lots"
                    className="border-b border-border/40 cursor-pointer hover:bg-accent/5 transition-colors"
                  >
                    <td className="px-2.5 py-1.5 text-right tabular-nums text-muted-foreground">
                      {r.date ? formatHfsqlDate(r.date) : '—'}
                    </td>
                    <td className="px-2.5 py-1.5 truncate font-medium" title={r.reference}>{r.reference || '—'}</td>
                    <td className="px-2.5 py-1.5 truncate" title={r.coloris}>{r.coloris || '—'}</td>
                    <td className="px-2.5 py-1.5 truncate" title={r.sous_traitant}>{r.sous_traitant || '—'}</td>
                    <td className="px-2.5 py-1.5 truncate tabular-nums" title={r.lot}>{r.lot || '—'}</td>
                    {groupes.flatMap((g) =>
                      g.champs.map((c, i) => (
                        <MesureCell key={`${g.meta.key}.${c}`} lot={r} meta={g.meta} champ={c} first={i === 0} />
                      )),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!isLoading && !isError && filteredSorted.length > 0 && (
          <div className="flex-shrink-0 flex items-center justify-between gap-3 border-t border-border/60 bg-zinc-100/80 px-3 py-2 text-xs text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground tabular-nums">{fmtNum(filteredSorted.length)}</span>{' '}
              lot{filteredSorted.length > 1 ? 's' : ''} validé{filteredSorted.length > 1 ? 's' : ''}
              {filteredSorted.length > MAX_LIGNES && (
                <> — les {MAX_LIGNES} premiers affichés, affinez la recherche (l'export Excel les reprend tous)</>
              )}
            </span>
            <span className="hidden md:inline">
              Écart = mesure − référentiel · <span className="text-red-600 font-semibold">rouge</span> = hors tolérance de la fiche
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Pieces ─────────────────────────────────────────────

function SourceToggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      title={on ? `Masquer les mesures ${label.toLowerCase()}` : `Afficher les mesures ${label.toLowerCase()}`}
      className={cn(
        'px-2.5 py-1 text-xs rounded-md transition-colors',
        on ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10',
      )}
    >
      {label}
    </button>
  )
}

function MesureCell({ lot, meta, champ, first }: { lot: LotAnalyse; meta: MesureMeta; champ: Champ; first: boolean }) {
  const v = lot.mesures[meta.key] ?? {}
  const base = cn('px-2 py-1.5 text-right tabular-nums', first && 'border-l border-border/40')
  if (champ === 'ecart_sst' || champ === 'ecart_interne') {
    const e = v[champ]
    const hors = champ === 'ecart_sst' ? v.hors_sst : v.hors_interne
    return (
      <td
        className={cn(base, hors ? 'bg-red-50 text-red-600 font-semibold' : 'text-muted-foreground')}
        title={hors ? 'Hors tolérance de la fiche' : undefined}
      >
        {fmtEcart(e, meta.dec)}
      </td>
    )
  }
  const val = v[champ]
  // The référentiel retraits read from the fiche, and the STT rendement
  // recomputed from the pieces, are not what the lot recorded: say so.
  const derive =
    (champ === 'ref' && (meta.key === 'stabh' || meta.key === 'stabl') && lot.ref_retraits_fiche) ||
    (champ === 'sst' && meta.key === 'rendement' && lot.rendement_sst_calcule)
  return (
    <td
      className={cn(base, champ === 'ref' && 'text-muted-foreground', derive && 'italic')}
      title={
        derive
          ? champ === 'ref'
            ? 'Référentiel de la fiche (non enregistré sur le lot)'
            : 'Calculé sur les pièces du lot (Σ métrage / Σ poids)'
          : undefined
      }
    >
      {fmtVal(val, meta.dec)}
    </td>
  )
}

function Synthese({ rows, showSst, showInterne }: { rows: LotAnalyse[]; showSst: boolean; showInterne: boolean }) {
  const stats = useMemo(
    () => MESURES.map((m) => ({ meta: m, sst: statSource(rows, m.key, 'sst'), interne: statSource(rows, m.key, 'interne') })),
    [rows],
  )
  return (
    <div className="flex-shrink-0 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2">
      {stats.map(({ meta, sst, interne }) => (
        <div key={meta.key} className="rounded-lg border border-border/60 bg-white shadow-sm px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold">{meta.label}</span>
            <span className="text-[11px] text-muted-foreground">écart moyen · hors tol.</span>
          </div>
          <div className="mt-1 space-y-0.5">
            {showSst && <StatLigne label="STT" stat={sst} meta={meta} />}
            {showInterne && !meta.sansInterne && <StatLigne label="Interne" stat={interne} meta={meta} />}
          </div>
        </div>
      ))}
    </div>
  )
}

function StatLigne({ label, stat, meta }: { label: string; stat: StatSource; meta: MesureMeta }) {
  const pct = stat.jugees > 0 ? Math.round((stat.hors / stat.jugees) * 100) : null
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="w-12 text-muted-foreground">{label}</span>
      {stat.n === 0 ? (
        <span className="text-muted-foreground italic">aucune mesure</span>
      ) : (
        <>
          <span className="tabular-nums font-semibold">
            {fmtEcart(stat.moyenne != null ? Math.round(stat.moyenne * 10 ** meta.dec) / 10 ** meta.dec : undefined, meta.dec)} {meta.unit}
          </span>
          {pct != null && (
            <span className={cn('tabular-nums', pct > 0 ? 'text-red-600 font-semibold' : 'text-muted-foreground')}>
              {pct} %
            </span>
          )}
          <span className="ml-auto tabular-nums text-muted-foreground" title="Lots mesurés">{fmtNum(stat.n)} lots</span>
        </>
      )}
    </div>
  )
}

function SortHeader({ label, sortKey, sort, onSort, align = 'left', className }: {
  label: string
  sortKey: SortKey
  sort: SortState
  onSort: (k: SortKey) => void
  align?: 'left' | 'right'
  className?: string
}) {
  const active = sort.key === sortKey
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={cn(
        'px-2 py-2 font-semibold cursor-pointer select-none whitespace-nowrap',
        align === 'right' ? 'text-right' : 'text-left',
        active && 'text-accent',
        className,
      )}
    >
      <span className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
        {label}
        {active && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </span>
    </th>
  )
}
