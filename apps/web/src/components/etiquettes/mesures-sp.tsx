// MATEL's measures of Simone Pérèle rolls, shared by the order line's
// « Étiquettes » tab (Clients › Commandes) and the lot's tableau de métrage
// (Qualité › Suivi lots, LIVA #1303). Both read and write the SAME per-roll
// measures (apps/api/src/lib/etiquettes-sp.ts): only the rolls whose measures
// changed are sent, so one screen never overwrites what the other typed.

import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { AlertCircle, Barcode, Check, ChevronUp, ClipboardList, Loader2, Truck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PopoverSelect } from '@/components/ui/popover-select'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'

export interface RollMesure { brut: number | null; net: number | null; laizeCm: number | null; tare: number | null; poids: number | null }
export interface MesureRoll {
  id: number
  numero: string
  lot: string
  metrage: number
  poids: number
  expedie: boolean
  mesure: RollMesure | null
  /** Lot view only: « 3875 · SIMONE PERELE », empty when the roll is free. */
  affectation?: string
}
export interface CodeSp {
  IDcode_sp: number
  coloris: string
  code_ean_13: string
  article_client: string
  article_fournisseur: string
  libelle_article: string
  num_bain: string
  ean13: string | null
}
export interface SaveResponse { ok: boolean; net?: { appliques: string[]; factures: string[]; sousNonFactures?: string[] } }

/** What the API hands both screens. */
export interface EtiquettesPayload {
  coloris: string
  rolls: MesureRoll[]
  codes: CodeSp[]
  sousTraitant: { id: number; nom: string } | null
  commandeClient: string
  bain: string
  IDcode_sp: number
}

export type Doc = 'tableau' | 'etiquettes'
export const DOCS: Array<{ key: Doc; label: string; icon: ComponentType<{ className?: string }> }> = [
  { key: 'tableau', label: 'Tableau de métrage', icon: ClipboardList },
  { key: 'etiquettes', label: 'Étiquettes', icon: Barcode },
]

/** The five MATEL columns, as typed (French decimal comma accepted). */
type Field = 'brut' | 'net' | 'laizeCm' | 'tare' | 'poids'
const FIELDS: Array<{ key: Field; label: string; unit: string; hint: string }> = [
  { key: 'brut', label: 'Brut', unit: 'm', hint: 'Métrage brut' },
  { key: 'net', label: 'Net', unit: 'm', hint: 'Métrage net (brut moins les défauts)' },
  { key: 'laizeCm', label: 'Laize', unit: 'cm', hint: 'Laize nette entre lisières encollées, en cm' },
  { key: 'tare', label: 'Tare', unit: '', hint: 'Nombre de défauts' },
  { key: 'poids', label: 'Poids', unit: 'kg', hint: 'Poids de la pièce nette' },
]
type Draft = Record<Field, string>

const toText = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v).replace('.', ','))
const toNum = (s: string): number | null => {
  const t = s.trim().replace(',', '.')
  if (t === '') return null
  const v = Number(t)
  return Number.isFinite(v) && v >= 0 ? v : null
}

/** Same rule as the API's missingMesures(): what keeps a roll off the labels. */
function rollProblems(d: Draft): string[] {
  const out: string[] = []
  const brut = toNum(d.brut); const net = toNum(d.net)
  if (!(brut && brut > 0)) out.push('brut')
  if (!(net && net > 0)) out.push('net')
  if (!(toNum(d.laizeCm) ?? 0)) out.push('laize')
  if (!(toNum(d.poids) ?? 0)) out.push('poids')
  if (brut && net && net > brut) out.push('net > brut')
  return out
}

/** The measures as saved on the server, as text. */
function savedDraft(m: RollMesure | null): Draft {
  return { brut: toText(m?.brut), net: toText(m?.net), laizeCm: toText(m?.laizeCm), tare: toText(m?.tare), poids: toText(m?.poids) }
}

const sameDraft = (a: Draft, b: Draft) => FIELDS.every((f) => a[f.key] === b[f.key])

// ── Draft + auto-save ──────────────────────────────────────

/** The batch fields and the roll grid of one screen, hydrated once from a
 *  FRESH payload and saved 700 ms after the last keystroke. Opening saves
 *  nothing; the gross lengths pre-filled from ETM are sent with the first
 *  save (or the first print / send, through `flush`). */
export function useEtiquettesDraft({ data, ready, putUrl, onSaved }: {
  data: EtiquettesPayload | undefined
  /** False while a refetch is in flight: never hydrate from a cached copy. */
  ready: boolean
  putUrl: string
  onSaved: (res: SaveResponse | undefined) => void
}) {
  const [codeId, setCodeId] = useState(0)
  const [commandeClient, setCommandeClient] = useState('')
  const [bain, setBain] = useState('')
  const [drafts, setDrafts] = useState<Record<number, Draft>>({})
  const [hydrated, setHydrated] = useState(false)
  /** Per roll, the measures the server holds — what a save compares against. */
  const baseRef = useRef<Record<number, Draft>>({})

  useEffect(() => {
    if (!data || !ready || hydrated) return
    setCodeId(data.IDcode_sp)
    setCommandeClient(data.commandeClient)
    setBain(data.bain)
    const d: Record<number, Draft> = {}
    const base: Record<number, Draft> = {}
    for (const r of data.rolls) {
      base[r.id] = savedDraft(r.mesure)
      // The roll's length in ETM is the one on MATEL's delivery note: the
      // GROSS length (LIVA #1242 — it was offered as the net). The net
      // (brut minus the defects) is only on MATEL's tableau, typed by hand.
      d[r.id] = { ...base[r.id], brut: toText(r.mesure?.brut ?? (r.metrage > 0 ? r.metrage : null)) }
    }
    baseRef.current = base
    setDrafts(d)
    setHydrated(true)
  }, [data, ready, hydrated])

  const stateJson = useMemo(() => JSON.stringify({ commandeClient, bain, codeId, drafts }), [commandeClient, bain, codeId, drafts])
  const latest = useRef({ commandeClient, bain, codeId, drafts })
  latest.current = { commandeClient, bain, codeId, drafts }

  const [saveState, setSaveState] = useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle')
  const lastSavedRef = useRef<string | null>(null)
  const initialJsonRef = useRef<string | null>(null)
  const pendingRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved

  /** The body of a save: the batch fields + the rolls that differ from the server. */
  const body = () => {
    const s = latest.current
    const changed = Object.entries(s.drafts).filter(([id, d]) => {
      const b = baseRef.current[Number(id)]
      return !b || !sameDraft(b, d)
    })
    return {
      sent: changed,
      json: JSON.stringify({
        commandeClient: s.commandeClient, bain: s.bain, IDcode_sp: s.codeId,
        rolls: changed.map(([id, d]) => ({
          id: Number(id), brut: toNum(d.brut), net: toNum(d.net), laizeCm: toNum(d.laizeCm), tare: toNum(d.tare), poids: toNum(d.poids),
        })),
      }),
    }
  }

  const save = async (json: string) => {
    if (json === lastSavedRef.current) return
    setSaveState('saving')
    const { sent, json: payload } = body()
    try {
      onSavedRef.current(await apiFetch<SaveResponse>(putUrl, { method: 'PUT', body: payload }))
      for (const [id, d] of sent) baseRef.current[Number(id)] = d
      lastSavedRef.current = json
      if (pendingRef.current === json) pendingRef.current = null
      setSaveState('saved')
    } catch {
      setSaveState('error')
      throw new Error('save_failed')
    }
  }

  useEffect(() => {
    if (!hydrated) return
    if (initialJsonRef.current === null) { initialJsonRef.current = stateJson; return }
    if (stateJson === lastSavedRef.current) return
    if (lastSavedRef.current === null && stateJson === initialJsonRef.current) return
    pendingRef.current = stateJson
    setSaveState('pending')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { save(stateJson).catch(() => {}) }, 700)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateJson, hydrated])

  // Leaving (tab, line, dialog) flushes what is still waiting.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const json = pendingRef.current
    if (json && json !== lastSavedRef.current) {
      apiFetch<SaveResponse>(putUrl, { method: 'PUT', body: body().json }).then((r) => onSavedRef.current(r)).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [putUrl])

  const flush = async () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    await save(stateJson)
  }

  const setField = (id: number, f: Field, v: string) => setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [f]: v } }))

  return { codeId, setCodeId, commandeClient, setCommandeClient, bain, setBain, drafts, setField, hydrated, saveState, flush }
}

// ── Selection (§44 Shift+click) ────────────────────────────

export function useRollSelection(rolls: MesureRoll[]) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const lastSelRef = useRef<number | null>(null)
  const toggle = (id: number, shiftKey: boolean) => {
    const ids = rolls.map((r) => r.id)
    const anchor = lastSelRef.current
    if (shiftKey && anchor !== null && anchor !== id) {
      const a = ids.indexOf(anchor); const b = ids.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelected((prev) => {
          const next = new Set(prev)
          const deselect = prev.has(id)
          for (let i = lo; i <= hi; i++) { if (deselect) next.delete(ids[i]); else next.add(ids[i]) }
          return next
        })
        return
      }
    }
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
    lastSelRef.current = id
  }
  const selectedIds = rolls.filter((r) => selected.has(r.id)).map((r) => r.id)
  const allSelected = rolls.length > 0 && selectedIds.length === rolls.length
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(rolls.map((r) => r.id)))
    lastSelRef.current = allSelected ? null : rolls[rolls.length - 1]?.id ?? null
  }
  /** Rolls still in stock — the default batch. */
  const selectUnshipped = () => setSelected(new Set(rolls.filter((r) => !r.expedie).map((r) => r.id)))
  return { selected, selectedIds, allSelected, toggle, toggleAll, selectUnshipped }
}

// ── Batch fields ───────────────────────────────────────────

const fieldCls = 'w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'

export function BatchFields({ codes, coloris, codeId, onCodeId, commandeClient, onCommandeClient, bain, onBain, commandeHint }: {
  codes: CodeSp[]
  coloris: string
  codeId: number
  onCodeId: (id: number) => void
  commandeClient: string
  onCommandeClient: (v: string) => void
  bain: string
  onBain: (v: string) => void
  commandeHint?: string
}) {
  const code = codes.find((c) => c.IDcode_sp === codeId) ?? null
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="space-y-1 col-span-full">
          <label className="text-xs font-medium text-muted-foreground">Coloris Simone Pérèle</label>
          <PopoverSelect
            options={codes.map((c) => ({ id: c.IDcode_sp, primary: c.coloris, secondary: c.ean13 ? undefined : 'EAN à corriger' }))}
            value={codeId}
            onChange={onCodeId}
            emptyLabel="— choisir —"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">N° de commande SP</label>
          <input value={commandeClient} onChange={(e) => onCommandeClient(e.target.value)} title={commandeHint} className={fieldCls} />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">N° de bain de teinture</label>
          <input value={bain} onChange={(e) => onBain(e.target.value)} className={fieldCls} />
        </div>
      </div>
      {code && (
        code.ean13 ? (
          <p className="text-[11px] text-muted-foreground truncate">
            {code.article_client} · EAN <span className="tabular-nums">{code.ean13}</span> · {code.libelle_article}
          </p>
        ) : (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <span>
              Le code EAN de ce coloris est incomplet (<span className="tabular-nums">{code.code_ean_13 || 'vide'}</span>) : le tableau de métrage
              s'imprime, pas les étiquettes. Corrigez-le dans Clients › Gestion › Étiquettes.
            </span>
          </div>
        )
      )}
      {!code && codeId === 0 && (
        <p className="text-[11px] text-muted-foreground italic">Aucun code ne correspond au coloris ({coloris || '—'}) : choisissez-le.</p>
      )}
    </div>
  )
}

// ── Roll grid ──────────────────────────────────────────────

const inputCls = 'h-7 w-full px-1.5 text-sm text-right tabular-nums rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'

function SelectBox({ checked, title, onClick }: { checked: boolean; title: string; onClick: (e: React.MouseEvent) => void }) {
  // A button, not a native checkbox: preventDefault on a controlled
  // checkbox's click makes the browser revert the tick after React sets it,
  // so rolls could not be checked (LIVA #1207).
  return (
    <button type="button" role="checkbox" aria-checked={checked} title={title} onClick={onClick}
      className={cn(
        'h-4 w-4 rounded border inline-flex items-center justify-center align-middle transition-colors cursor-pointer',
        checked ? 'bg-accent border-accent text-accent-foreground' : 'border-input bg-background hover:border-accent/60',
      )}>
      {checked && <Check className="h-3 w-3" strokeWidth={3} />}
    </button>
  )
}

export function MesuresTable({ rolls, drafts, setField, selection, showAffectation }: {
  rolls: MesureRoll[]
  drafts: Record<number, Draft>
  setField: (id: number, f: Field, v: string) => void
  selection: ReturnType<typeof useRollSelection>
  /** Lot view: which client order each roll serves (« libre » when none). */
  showAffectation?: boolean
}) {
  return (
    <div className="rounded-lg border bg-card shadow-sm overflow-x-auto">
      <table className={cn('w-full text-sm', showAffectation ? 'min-w-[600px]' : 'min-w-[470px]')}>
        <thead className="bg-zinc-200/60 border-b border-border/60">
          <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
            <th className="w-8 px-2 py-2">
              <SelectBox checked={selection.allSelected} title={selection.allSelected ? 'Tout décocher' : 'Tout cocher'} onClick={selection.toggleAll} />
            </th>
            <th className="px-2 py-2 text-left font-semibold">Pièce</th>
            {showAffectation && <th className="px-2 py-2 text-left font-semibold">Commande</th>}
            <th className="px-1 py-2 text-right font-semibold" title="Métrage du rouleau dans ETM, celui du BL et de la facture : le brut du BL MATEL, remplacé par le net une fois toutes les mesures saisies">ETM</th>
            {FIELDS.map((f) => (
              <th key={f.key} className="px-1 py-2 text-right font-semibold w-[58px]" title={f.hint}>
                {f.label}{f.unit && <span className="normal-case font-normal"> ({f.unit})</span>}
              </th>
            ))}
            <th className="w-7" />
          </tr>
        </thead>
        <tbody>
          {rolls.map((r) => {
            const d = drafts[r.id]
            const problems = d ? rollProblems(d) : []
            const isSel = selection.selected.has(r.id)
            return (
              <tr key={r.id} className={cn('border-b border-border/40 last:border-b-0', isSel ? 'bg-accent/[0.06]' : '')}>
                <td className="px-2 py-1 text-center select-none">
                  <SelectBox checked={isSel} title={isSel ? 'Retirer de la sélection' : 'Sélectionner'} onClick={(e) => selection.toggle(r.id, e.shiftKey)} />
                </td>
                <td className="px-2 py-1 whitespace-nowrap leading-tight">
                  <span className="font-medium tabular-nums">{r.numero}</span>
                  {r.expedie && <span title="Expédié"><Truck className="inline h-3 w-3 ml-1.5 text-muted-foreground" /></span>}
                  <div className="text-[10px] text-muted-foreground">{r.lot || '—'}</div>
                </td>
                {showAffectation && (
                  <td className="px-2 py-1 text-xs max-w-[140px] truncate" title={r.affectation || 'Pièce non affectée'}>
                    {r.affectation || <span className="italic text-muted-foreground">libre</span>}
                  </td>
                )}
                <td className="px-1 py-1 text-right text-xs text-muted-foreground tabular-nums">{r.metrage ? fmtNum(r.metrage, 1) : '—'}</td>
                {FIELDS.map((f) => (
                  <td key={f.key} className="px-1 py-1">
                    <input value={d?.[f.key] ?? ''} inputMode="decimal" title={f.hint}
                      onChange={(e) => setField(r.id, f.key, e.target.value)}
                      className={cn(inputCls, d && d[f.key].trim() !== '' && toNum(d[f.key]) === null && 'border-destructive')} />
                  </td>
                ))}
                <td className="px-1 text-center">
                  {problems.length === 0
                    ? <span title="Mesures complètes"><Check className="h-4 w-4 text-green-600 inline" /></span>
                    : <span title={`Manque : ${problems.join(', ')}`}><AlertCircle className="h-4 w-4 text-amber-500 inline" /></span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Save state + the net-length notes (LIVA #1246), for a footer. */
export function SaveStatus({ count, saveState, netFactures, netSousNf }: {
  count: number
  saveState: 'idle' | 'pending' | 'saving' | 'saved' | 'error'
  netFactures: string[]
  netSousNf: string[]
}) {
  return (
    <span className="text-muted-foreground">
      {count} coché{count > 1 ? 's' : ''}
      {' · '}
      {saveState === 'saving' || saveState === 'pending' ? 'Enregistrement…'
        : saveState === 'error' ? <span className="text-destructive">Échec de l'enregistrement</span>
        : <span title="La saisie est enregistrée automatiquement">Enregistré</span>}
      {netFactures.length > 0 && (
        <span className="block text-amber-700 truncate" title={`Déjà facturé : le métrage facturé reste le brut pour ${netFactures.join(', ')}`}>
          Déjà facturé, métrage non modifié : {netFactures.join(', ')}
        </span>
      )}
      {netSousNf.length > 0 && (
        <span className="block text-amber-700 truncate" title={`Le net MATEL est plus court que les Ml non facturés du rouleau : le métrage brut est conservé pour ${netSousNf.join(', ')}`}>
          Net inférieur aux Ml non facturés, métrage non modifié : {netSousNf.join(', ')}
        </span>
      )}
    </span>
  )
}

/** Icon button opening an upward menu of documents (§42, anchored above
 *  because it sits in a bottom strip). A single document acts directly. */
export function DocMenu({ icon: Icon, title, busy, docs, onSelect }: {
  icon: ComponentType<{ className?: string }>
  title: string
  busy: boolean
  docs: Doc[]
  onSelect: (doc: Doc) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  const single = docs.length === 1
  const items = DOCS.filter((d) => docs.includes(d.key))
  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      <Button variant="outline" size="sm" className="h-8 bg-white" title={title} disabled={busy}
        onClick={() => (single ? onSelect(docs[0]) : setOpen((v) => !v))}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin sm:mr-1.5" /> : <Icon className="h-3.5 w-3.5 sm:mr-1.5" />}
        <span className="hidden sm:inline">{title}</span>
        {!single && <ChevronUp className={cn('h-3 w-3 ml-1 transition-transform', open && 'rotate-180')} />}
      </Button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 w-56 rounded-lg border bg-white shadow-lg overflow-hidden z-50">
          {items.map((d) => {
            const DIcon = d.icon
            return (
              <button key={d.key} type="button" onClick={() => { setOpen(false); onSelect(d.key) }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-zinc-100">
                <DIcon className="h-4 w-4 text-muted-foreground" />
                {d.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Loading / error placeholder, shared by both screens. */
export function LoadState({ error }: { error?: boolean }): ReactNode {
  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-destructive py-8">
        <AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">Erreur de chargement</p>
      </div>
    )
  }
  return <div className="flex-1 flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
}
