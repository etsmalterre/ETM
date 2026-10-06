// « Ml non facturés » on a finished roll (decision Vincent 2026-10-06,
// API lib/ml-non-factures.ts). One component family for the three places
// that write it — sst reception, Clients › Commandes, Finis › Stock — and
// every place that shows it. The métrage stays the roll's real length; this
// is the part the client invoice will not bill, with its motif.
//
// Everyone SEES the value; only `edit_ml_non_factures` writes it (the API
// re-checks), and never on a roll already on an invoice (409 → avoir).

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, BadgeEuro, History, Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { STOCK_QUERY_FRESHNESS, invalidateStockCaches } from '@/lib/cache-sync'

export const ML_NON_FACTURES_PERMISSION = 'edit_ml_non_factures'

/** « 10 », « 2,5 » — no trailing zeros, like the invoice mention. */
function fmtMl(v: number): string {
  const r = Math.round(v * 100) / 100
  return fmtNum(r, Number.isInteger(r) ? 0 : Number.isInteger(r * 10) ? 1 : 2)
}

export interface JournalMlNonFactures {
  id: number
  le: string
  auteur: string
  ml_avant: number
  ml_apres: number
  motif_avant: string | null
  motif_apres: string | null
  origine: string
}

export interface MlNonFacturesEtat {
  ml_non_factures: number
  motif: string | null
  modifiable: { ok: boolean; raison?: 'facture' | 'donne'; message?: string }
  journal: JournalMlNonFactures[]
}

export function useMlNonFactures(id: number | null) {
  return useQuery<MlNonFacturesEtat>({
    queryKey: ['stock-fini', 'ml-non-factures', id],
    queryFn: () => apiFetch<MlNonFacturesEtat>(`/stock/fini/${id}/ml-non-factures`),
    enabled: id !== null,
    ...STOCK_QUERY_FRESHNESS,
  })
}

/** Same rule as the API's validerSaisie: 0 ≤ ml ≤ métrage, motif required
 *  when ml > 0. Returns the message to show, or null when valid. */
export function erreurMlNonFactures(ml: string, motif: string, metrage: number | null): string | null {
  const t = ml.trim()
  if (t === '') return null // empty = 0
  const v = Number(t.replace(',', '.'))
  if (!Number.isFinite(v) || v < 0) return 'Ml non facturés : saisissez un nombre positif.'
  if (metrage != null && v > Math.round(metrage * 100) / 100) {
    return `Ml non facturés : pas plus que le métrage (${fmtNum(metrage, 2)} Ml).`
  }
  if (v > 0 && !motif.trim()) return 'Ml non facturés : indiquez le motif (ex. « taches »).'
  return null
}

/** The typed value as a number (empty → 0). */
export function parseMlNonFactures(ml: string): number {
  const v = Number(ml.trim().replace(',', '.'))
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0
}

/** The pair of inputs — quantity + motif. `compact` is the one-line variant
 *  for a reception row; the default stacks the motif under the quantity. */
export function MlNonFacturesInputs({
  ml,
  motif,
  onMl,
  onMotif,
  compact,
  disabled,
  alignEnd,
}: {
  ml: string
  motif: string
  onMl: (v: string) => void
  onMotif: (v: string) => void
  compact?: boolean
  disabled?: boolean
  /** Right-align the stack — the value slot of a drawer KV row. */
  alignEnd?: boolean
}) {
  const positive = parseMlNonFactures(ml) > 0
  const inputBase =
    'h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60'
  return (
    <div className={cn(compact ? 'flex items-center gap-1.5' : alignEnd ? 'flex flex-col items-end gap-1.5' : 'space-y-1.5')}>
      {/* Unit inside the field, right-aligned after the figure. */}
      <span className="relative inline-flex flex-shrink-0">
        <input
          type="text"
          inputMode="decimal"
          value={ml}
          disabled={disabled}
          onChange={(e) => onMl(e.target.value)}
          placeholder="0"
          title="Mètres du rouleau qui ne seront pas facturés au client"
          className={cn(inputBase, 'w-24 pr-8 text-right tabular-nums')}
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">Ml</span>
      </span>
      {(positive || motif.trim() !== '') && (
        <input
          type="text"
          value={motif}
          disabled={disabled}
          onChange={(e) => onMotif(e.target.value)}
          placeholder="Motif (ex. taches sur 10 m)"
          maxLength={500}
          className={cn(inputBase, compact ? 'flex-1 min-w-0' : 'w-full')}
        />
      )}
    </div>
  )
}

/** Read display: « dont 10 non facturés — taches ». Renders nothing at 0. */
export function MlNonFacturesMention({
  ml,
  motif,
  className,
}: {
  ml: number | null | undefined
  motif: string | null | undefined
  className?: string
}) {
  const v = Number(ml) || 0
  if (v <= 0) return null
  const m = (motif ?? '').trim()
  return (
    <span className={cn('inline-flex items-start gap-1 text-xs text-amber-800', className)}>
      <BadgeEuro className="h-3.5 w-3.5 flex-shrink-0 mt-px text-amber-600" />
      <span>
        dont <span className="font-semibold tabular-nums">{fmtMl(v)}</span> non facturés{m ? ` — ${m}` : ''}
      </span>
    </span>
  )
}

/** Compact list indicator: an amber « −10 » chip, the motif in its title.
 *  `iconOnly` for a narrow table cell — the figure moves to the tooltip. */
export function MlNonFacturesBadge({
  ml,
  motif,
  className,
  iconOnly,
}: {
  ml: number | null | undefined
  motif: string | null | undefined
  className?: string
  iconOnly?: boolean
}) {
  const v = Number(ml) || 0
  if (v <= 0) return null
  const m = (motif ?? '').trim()
  const title = `${fmtMl(v)} Ml non facturés${m ? ` — ${m}` : ''}`
  if (iconOnly) {
    return (
      <span title={title} className={cn('inline-flex flex-shrink-0 text-amber-600', className)}>
        <BadgeEuro className="h-3.5 w-3.5" />
      </span>
    )
  }
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-[10px] font-semibold text-amber-800 tabular-nums whitespace-nowrap',
        className,
      )}
    >
      <BadgeEuro className="h-2.5 w-2.5" />−{fmtMl(v)}
    </span>
  )
}

/** Who changed it, when, before → after. Visible to everyone. */
export function MlNonFacturesJournal({ journal }: { journal: JournalMlNonFactures[] }) {
  if (journal.length === 0) return null
  const origine: Record<string, string> = { reception: 'réception', commande: 'commande client', rouleau: 'stock' }
  return (
    <div className="pt-2 mt-1 border-t border-border/40 space-y-1.5">
      <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
        <History className="h-3 w-3" />
        Ml non facturés — historique
      </p>
      {journal.map((j) => (
        <div key={j.id} className="text-[11px] leading-snug">
          <div className="flex items-baseline justify-between gap-2 text-muted-foreground">
            <span className="truncate">
              {j.auteur}
              {origine[j.origine] ? ` · ${origine[j.origine]}` : ''}
            </span>
            <span className="flex-shrink-0 tabular-nums">
              {new Date(j.le).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          </div>
          <div>
            <span className="tabular-nums">
              {fmtMl(j.ml_avant)} → <span className="font-semibold">{fmtMl(j.ml_apres)} Ml</span>
            </span>
            {(j.motif_apres ?? '') !== (j.motif_avant ?? '') && j.motif_apres && (
              <span className="text-muted-foreground italic"> — {j.motif_apres}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Write the value from anywhere (Finis › Stock, Clients › Commandes). */
export function saveMlNonFactures(id: number, ml: string, motif: string, origine: 'rouleau' | 'commande') {
  const v = parseMlNonFactures(ml)
  return apiFetch<MlNonFacturesEtat>(`/stock/fini/${id}/ml-non-factures`, {
    method: 'PUT',
    body: JSON.stringify({ ml_non_factures: v, motif: v > 0 ? motif.trim() : '', origine }),
  })
}

/** The error message an API refusal carries (409 facturé / donné, 400 saisie). */
export function messageErreurMlNonFactures(err: unknown): string {
  const msg = (err as { body?: { message?: unknown } } | undefined)?.body?.message
  return typeof msg === 'string' ? msg : "L'enregistrement a échoué. Réessayez ou contactez l'administrateur."
}

/** Dialog for one roll — read-only for anyone, editable with the right while
 *  the roll is not invoiced. Used from the pieces of a client order line. */
export function MlNonFacturesDialog({
  roll,
  onClose,
  onSaved,
  readOnly,
}: {
  roll: { id: number; numero: string | null; metrage: number } | null
  onClose: () => void
  onSaved?: () => void
  /** Display only (value + history), whatever the user's rights. */
  readOnly?: boolean
}) {
  const queryClient = useQueryClient()
  const canEdit = useHasPermission(ML_NON_FACTURES_PERMISSION)
  const { data, isLoading } = useMlNonFactures(roll?.id ?? null)
  const [ml, setMl] = useState('')
  const [motif, setMotif] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!data) return
    setMl(data.ml_non_factures > 0 ? String(data.ml_non_factures).replace('.', ',') : '')
    setMotif(data.motif ?? '')
    setError(null)
  }, [data, roll?.id])

  const mutation = useMutation({
    mutationFn: () => saveMlNonFactures(roll!.id, ml, motif, 'commande'),
    onSuccess: (fresh) => {
      queryClient.setQueryData(['stock-fini', 'ml-non-factures', roll!.id], fresh)
      invalidateStockCaches(queryClient)
      onSaved?.()
      onClose()
    },
    onError: (err) => setError(messageErreurMlNonFactures(err)),
  })

  const editable = canEdit && !readOnly && !!data?.modifiable.ok
  const localError = editable ? erreurMlNonFactures(ml, motif, roll?.metrage ?? null) : null

  return (
    <Dialog open={roll !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BadgeEuro className="h-5 w-5 text-accent" />
            Ml non facturés{roll?.numero ? ` — pièce ${roll.numero}` : ''}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          {isLoading || !data ? (
            <div className="flex justify-center py-6"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Métrage réel du rouleau : <span className="font-semibold text-foreground tabular-nums">{fmtNum(roll?.metrage ?? 0, 2)} Ml</span>.
                La facture déduit les mètres non facturés et les mentionne sous la ligne.
              </p>
              {editable ? (
                <MlNonFacturesInputs ml={ml} motif={motif} onMl={setMl} onMotif={setMotif} />
              ) : data.ml_non_factures > 0 ? (
                <MlNonFacturesMention ml={data.ml_non_factures} motif={data.motif} className="text-sm" />
              ) : (
                <p className="text-sm text-muted-foreground italic">Tout le métrage est facturé.</p>
              )}
              {canEdit && !readOnly && !data.modifiable.ok && (
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  <span>{data.modifiable.message}</span>
                </p>
              )}
              <MlNonFacturesJournal journal={data.journal} />
              {(localError || error) && (
                <p className="flex items-start gap-1.5 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>{localError ?? error}</span>
                </p>
              )}
            </>
          )}
        </div>
        {editable && (
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={onClose}>Annuler</Button>
            <Button onClick={() => mutation.mutate()} disabled={!!localError || mutation.isPending}>
              {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
              Enregistrer
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
