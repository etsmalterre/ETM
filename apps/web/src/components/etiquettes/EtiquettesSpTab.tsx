// « Étiquettes » tab of a Clients › Commandes order line — Simone Pérèle roll
// labels (LIVA #1200). Shown only for clients whose labels are switched on in
// Clients › Gestion.
//
// Flow: print or send MATEL the « tableau de métrage » → MATEL returns it
// filled by hand → type its numbers in the grid (saved as you type) → print
// or send MATEL the labels. Rules and storage: apps/api/src/lib/etiquettes-sp.ts.

import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle, AtSign, Barcode, Check, ChevronUp, ClipboardList, Loader2, Printer, Truck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PopoverSelect } from '@/components/ui/popover-select'
import { SendEmailDialog } from '@/components/email/SendEmailDialog'
import { apiFetch, API_URL } from '@/lib/api'
import { postEmail } from '@/lib/email'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'

interface RollMesure { brut: number | null; net: number | null; laizeCm: number | null; tare: number | null; poids: number | null }
interface LineRoll {
  id: number
  numero: string
  lot: string
  metrage: number
  poids: number
  expedie: boolean
  mesure: RollMesure | null
}
interface CodeSp {
  IDcode_sp: number
  coloris: string
  code_ean_13: string
  article_client: string
  article_fournisseur: string
  libelle_article: string
  num_bain: string
  ean13: string | null
}
interface LinePayload {
  ligneId: number
  coloris: string
  rolls: LineRoll[]
  codes: CodeSp[]
  sousTraitant: { id: number; nom: string } | null
  commandeClient: string
  bain: string
  IDcode_sp: number
}

type Doc = 'tableau' | 'etiquettes'
const DOCS: Array<{ key: Doc; label: string; icon: ComponentType<{ className?: string }> }> = [
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

const inputCls = 'h-7 w-full px-1.5 text-sm text-right tabular-nums rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'

export function EtiquettesSpTab({ ligneId }: { ligneId: number }) {
  const { data, isLoading, isError } = useQuery<LinePayload>({
    queryKey: ['etiquettes-sp-ligne', ligneId],
    queryFn: () => apiFetch(`/etiquettes-sp/lignes/${ligneId}`),
    // Local draft is the source of truth once hydrated; never refetch under it.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  // ── Draft (hydrated once, auto-saved) ────────────────────
  const [codeId, setCodeId] = useState(0)
  const [commandeClient, setCommandeClient] = useState('')
  const [bain, setBain] = useState('')
  const [drafts, setDrafts] = useState<Record<number, Draft>>({})
  const [hydrated, setHydrated] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const lastSelRef = useRef<number | null>(null)

  useEffect(() => {
    if (!data || hydrated) return
    setCodeId(data.IDcode_sp)
    setCommandeClient(data.commandeClient)
    setBain(data.bain)
    const d: Record<number, Draft> = {}
    for (const r of data.rolls) {
      const m = r.mesure
      d[r.id] = {
        brut: toText(m?.brut),
        // The net length MATEL declared on its delivery note is already on the
        // roll — offered until the tableau says otherwise.
        net: toText(m?.net ?? (r.metrage > 0 ? r.metrage : null)),
        laizeCm: toText(m?.laizeCm), tare: toText(m?.tare), poids: toText(m?.poids),
      }
    }
    setDrafts(d)
    setSelected(new Set(data.rolls.filter((r) => !r.expedie).map((r) => r.id)))
    setHydrated(true)
  }, [data, hydrated])

  const payload = useMemo(() => ({
    commandeClient, bain, IDcode_sp: codeId,
    rolls: Object.entries(drafts).map(([id, d]) => ({
      id: Number(id), brut: toNum(d.brut), net: toNum(d.net), laizeCm: toNum(d.laizeCm), tare: toNum(d.tare), poids: toNum(d.poids),
    })),
  }), [commandeClient, bain, codeId, drafts])
  const payloadJson = JSON.stringify(payload)

  const [saveState, setSaveState] = useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle')
  const lastSavedRef = useRef<string | null>(null)
  /** The draft as first shown. Opening the tab saves nothing; but the net
   *  lengths pre-filled from ETM are not on the server yet, so lastSavedRef
   *  stays null and the first print/send saves them. */
  const initialJsonRef = useRef<string | null>(null)
  const pendingRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const save = async (json: string) => {
    if (json === lastSavedRef.current) return
    setSaveState('saving')
    try {
      await apiFetch(`/etiquettes-sp/lignes/${ligneId}`, { method: 'PUT', body: json })
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
    if (initialJsonRef.current === null) { initialJsonRef.current = payloadJson; return }
    if (payloadJson === lastSavedRef.current) return
    if (lastSavedRef.current === null && payloadJson === initialJsonRef.current) return
    pendingRef.current = payloadJson
    setSaveState('pending')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { save(payloadJson).catch(() => {}) }, 700)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadJson, hydrated])

  // Leaving the tab (or the line) flushes what is still waiting.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const json = pendingRef.current
    if (json && json !== lastSavedRef.current) {
      apiFetch(`/etiquettes-sp/lignes/${ligneId}`, { method: 'PUT', body: json }).catch(() => {})
    }
  }, [ligneId])

  const flush = async () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    await save(payloadJson)
  }

  // ── Selection (§44 Shift+click) ──────────────────────────
  const rolls = data?.rolls ?? []
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

  // ── Documents ────────────────────────────────────────────
  const [docError, setDocError] = useState<string | null>(null)
  const [busyDoc, setBusyDoc] = useState<Doc | null>(null)
  const [emailDoc, setEmailDoc] = useState<Doc | null>(null)
  const pdfPath = (doc: Doc) => `/etiquettes-sp/lignes/${ligneId}/${doc}/pdf?rolls=${selectedIds.join(',')}`

  /** Saves, then asks the API for the document so a refusal (missing measure,
   *  bad EAN) shows here in words instead of as JSON in a new tab. */
  const fetchDoc = async (doc: Doc): Promise<Blob | null> => {
    setDocError(null)
    if (selectedIds.length === 0) { setDocError('Cochez au moins un rouleau.'); return null }
    setBusyDoc(doc)
    try {
      await flush()
      const res = await fetch(`${API_URL}${pdfPath(doc)}`, { credentials: 'include' })
      if (!res.ok) {
        let msg = `Erreur HTTP ${res.status}`
        try { const j = await res.json(); if (typeof j?.message === 'string') msg = j.message } catch { /* keep */ }
        setDocError(msg)
        return null
      }
      return await res.blob()
    } catch {
      setDocError("L'enregistrement a échoué — réessayez.")
      return null
    } finally {
      setBusyDoc(null)
    }
  }
  const printDoc = async (doc: Doc) => {
    const blob = await fetchDoc(doc)
    if (blob) window.open(URL.createObjectURL(blob), '_blank')
  }
  const sendDoc = async (doc: Doc) => {
    const blob = await fetchDoc(doc)
    if (blob) setEmailDoc(doc)
  }

  // ── Render ───────────────────────────────────────────────
  if (isLoading || (data && !hydrated)) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
  }
  if (isError || !data) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-destructive">
        <AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">Erreur de chargement</p>
      </div>
    )
  }

  const code = data.codes.find((c) => c.IDcode_sp === codeId) ?? null
  const setField = (id: number, f: Field, v: string) => setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [f]: v } }))

  return (
    <>
      <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-transparent">
        {/* Batch fields */}
        <div className="rounded-lg border bg-card p-3 shadow-sm space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1 col-span-full">
              <label className="text-xs font-medium text-muted-foreground">Coloris Simone Pérèle</label>
              <PopoverSelect
                options={data.codes.map((c) => ({ id: c.IDcode_sp, primary: c.coloris, secondary: c.ean13 ? undefined : 'EAN à corriger' }))}
                value={codeId}
                onChange={setCodeId}
                emptyLabel="— choisir —"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">N° de commande SP</label>
              <input value={commandeClient} onChange={(e) => setCommandeClient(e.target.value)}
                className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">N° de bain de teinture</label>
              <input value={bain} onChange={(e) => setBain(e.target.value)}
                className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
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
            <p className="text-[11px] text-muted-foreground italic">Aucun code ne correspond au coloris de la ligne ({data.coloris || '—'}) : choisissez-le.</p>
          )}
        </div>

        {/* Rolls */}
        {rolls.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Barcode className="h-8 w-8 mb-2 opacity-50" />
            <p className="text-sm font-medium">Aucun rouleau affecté</p>
            <p className="text-xs mt-1">Affectez les rouleaux à la ligne pour préparer leurs étiquettes.</p>
          </div>
        ) : (
          <div className="rounded-lg border bg-card shadow-sm overflow-x-auto">
            <table className="w-full text-sm min-w-[470px]">
              <thead className="bg-zinc-200/60 border-b border-border/60">
                <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="w-8 px-2 py-2">
                    <input type="checkbox" checked={allSelected} title="Tout cocher"
                      onChange={() => { setSelected(allSelected ? new Set() : new Set(rolls.map((r) => r.id))); lastSelRef.current = allSelected ? null : rolls[rolls.length - 1].id }}
                      className="h-4 w-4 rounded border-input text-accent cursor-pointer" />
                  </th>
                  <th className="px-2 py-2 text-left font-semibold">Pièce</th>
                  <th className="px-1 py-2 text-right font-semibold" title="Métrage connu d'ETM (bon de livraison MATEL)">ETM</th>
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
                  const isSel = selected.has(r.id)
                  return (
                    <tr key={r.id} className={cn('border-b border-border/40 last:border-b-0', isSel ? 'bg-accent/[0.06]' : '')}>
                      <td className="px-2 py-1 text-center select-none">
                        <input type="checkbox" checked={isSel}
                          onClick={(e) => { e.preventDefault(); toggle(r.id, e.shiftKey) }}
                          onChange={() => {}}
                          className="h-4 w-4 rounded border-input text-accent cursor-pointer" />
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap leading-tight">
                        <span className="font-medium tabular-nums">{r.numero}</span>
                        {r.expedie && <span title="Expédié"><Truck className="inline h-3 w-3 ml-1.5 text-muted-foreground" /></span>}
                        <div className="text-[10px] text-muted-foreground">{r.lot || '—'}</div>
                      </td>
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
                          ? <span title="Prêt pour l'étiquette"><Check className="h-4 w-4 text-green-600 inline" /></span>
                          : <span title={`Manque : ${problems.join(', ')}`}><AlertCircle className="h-4 w-4 text-amber-500 inline" /></span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Footer: save state + documents */}
      <div className="flex-shrink-0 flex items-center gap-3 border-t bg-zinc-200/50 px-3 py-2">
        <div className="min-w-0 flex-1 text-xs">
          {docError ? (
            <span className="flex items-center gap-1.5 text-destructive"><AlertCircle className="h-3.5 w-3.5 flex-shrink-0" /><span className="truncate" title={docError}>{docError}</span></span>
          ) : (
            <span className="text-muted-foreground">
              {selectedIds.length} coché{selectedIds.length > 1 ? 's' : ''}
              {' · '}
              {saveState === 'saving' || saveState === 'pending' ? 'Enregistrement…'
                : saveState === 'error' ? <span className="text-destructive">Échec de l'enregistrement</span>
                : <span title="La saisie est enregistrée automatiquement">Enregistré</span>}
            </span>
          )}
        </div>
        <DocMenu icon={Printer} title="Imprimer" busy={busyDoc !== null} onSelect={printDoc} />
        <DocMenu icon={AtSign} title={`Envoyer à ${data.sousTraitant?.nom || 'MATEL'}`} busy={busyDoc !== null} onSelect={sendDoc} />
      </div>

      <SendEmailDialog
        open={emailDoc !== null}
        onClose={() => setEmailDoc(null)}
        contextLabel={data.sousTraitant?.nom ?? undefined}
        queryKey={['etiquettes-sp-email', ligneId, emailDoc]}
        loadDefaults={() => apiFetch(`/etiquettes-sp/lignes/${ligneId}/${emailDoc}/email-defaults`)}
        pdfUrl={emailDoc ? `${API_URL}${pdfPath(emailDoc)}` : undefined}
        pdfAttachmentLabel={emailDoc === 'tableau' ? 'tableau-metrage.pdf' : 'etiquettes.pdf'}
        onSend={(p) => postEmail(`${API_URL}/etiquettes-sp/lignes/${ligneId}/${emailDoc}/email`, p, {
          includeAttachPdf: true,
          extraBody: { rolls: selectedIds },
        })}
      />
    </>
  )
}

/** Icon button opening an upward menu of the two documents (§42, anchored
 *  above because it sits in the drawer's bottom strip). */
function DocMenu({ icon: Icon, title, busy, onSelect }: {
  icon: ComponentType<{ className?: string }>
  title: string
  busy: boolean
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
  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      <Button variant="outline" size="sm" className="h-8 bg-white" title={title} onClick={() => setOpen((v) => !v)} disabled={busy}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin sm:mr-1.5" /> : <Icon className="h-3.5 w-3.5 sm:mr-1.5" />}
        <span className="hidden sm:inline">{title}</span>
        <ChevronUp className={cn('h-3 w-3 ml-1 transition-transform', open && 'rotate-180')} />
      </Button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 w-56 rounded-lg border bg-white shadow-lg overflow-hidden z-50">
          {DOCS.map((d) => {
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
