// The yarn lots a knitting order goes out with (decision Vincent 2026-10-23, API
// lib/lancement-tricotage.ts): one card per yarn of the écru's composition, the knitter's lots
// ticked by default (the client line's own reservation first, then the oldest lot) until the
// need is covered. The order cannot be created while a yarn is short — the parent reads it with
// `couvertureFils()`. Used by Clients › Commandes › Tricotage « Nouvelle commande » and by the
// new-line form of Sous-traitants › Tricotage at Tricotage Malterre.
//
// Each lot reads only what the user can take here (Vincent: no initial stock, no « already
// promised elsewhere »): Disponible, then how this order splits it — pour la commande / pour le
// stock / reste libre — with a bar that moves while the weight is typed.
import { useRef } from 'react'
import { AlertCircle, CalendarClock, CheckCircle2 } from 'lucide-react'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate } from '@/lib/dates'
import { cn } from '@/lib/utils'

export interface LotFilALancer {
  id: number
  lot: string
  fournisseur: string
  /** YYYYMMDD or '' */
  date_entree: string
  stock: number
  /** free kg on the lot */
  poids: number
  /** kg reserved on it for the client line launching (inside `poids`) */
  reserve_ligne: number
}

export interface FilALancer {
  IDref_fil: number
  IDcolori_fil: number
  reference: string
  coloris: string
  /** 0..100 */
  pourcentage: number
  /** the écru's freinte de tricotage (0..1): this yarn covers écru × % ÷ (1 − freinte) */
  freinte?: number
  stock: LotFilALancer[]
  /** open supplier orders of this yarn — information only, yarn on order never launches */
  pending?: { id: number; date_livraison: string | null; fournisseur: string; poids: number }[]
}

/** Lots ticked per yarn; a yarn absent from the record follows the default. */
export type ChoixLots = Record<string, number[]>

export const cleFil = (y: Pick<FilALancer, 'IDref_fil' | 'IDcolori_fil'>) => `${y.IDref_fil}:${y.IDcolori_fil}`

/** The yarn kg an écru weight takes, after the freinte de tricotage (same rule as the server's plan). */
const filPour = (y: FilALancer, kgEcru: number) => (kgEcru * (y.pourcentage / 100)) / (1 - Math.min(0.49, y.freinte ?? 0))
const besoinDe = (y: FilALancer, totalKg: number) => Math.round(filPour(y, totalKg) * 100) / 100

/** Same order as the server's plan (the lots arrive sorted): as many lots as the need takes. */
function lotsParDefaut(y: FilALancer, besoin: number): number[] {
  const out: number[] = []
  let reste = besoin
  for (const l of y.stock) {
    if (!(reste > 0.005)) break
    if (!(l.poids > 0)) continue
    out.push(l.id)
    reste -= l.poids
  }
  return out
}

export function lotsDuFil(y: FilALancer, totalKg: number, choix: ChoixLots): number[] {
  return choix[cleFil(y)] ?? lotsParDefaut(y, besoinDe(y, totalKg))
}

/** What the order sends (POST `lots`) and whether every yarn is covered. */
export function couvertureFils(yarns: readonly FilALancer[], totalKg: number, choix: ChoixLots): { lots: number[]; couvert: boolean } {
  const lots: number[] = []
  let couvert = yarns.length > 0
  for (const y of yarns) {
    const ids = lotsDuFil(y, totalKg, choix)
    lots.push(...ids)
    const kg = y.stock.filter((l) => ids.includes(l.id)).reduce((s, l) => s + l.poids, 0)
    if (kg < besoinDe(y, totalKg) - 0.005) couvert = false
  }
  return { lots, couvert }
}

/** Bar + column colours: this order's two parts in the CA widget's validated palette slots, the
 *  rest grey (what is left, not a series). */
const COULEUR = { commande: '#2a78d6', stock: '#1baf7a', reste: '#e4e4e7' }

interface Prise { commande: number; stock: number }

/** Per ticked lot, in the plan's order: the client part first, then the stock part. */
function prises(y: FilALancer, ids: readonly number[], kgCommande: number, kgStock: number): Map<number, Prise> {
  const out = new Map<number, Prise>()
  let resteCmd = filPour(y, kgCommande)
  let resteStock = filPour(y, kgStock)
  for (const l of y.stock) {
    if (!ids.includes(l.id)) continue
    const commande = Math.max(0, Math.min(l.poids, resteCmd))
    const stock = Math.max(0, Math.min(l.poids - commande, resteStock))
    resteCmd -= commande
    resteStock -= stock
    out.set(l.id, { commande, stock })
  }
  return out
}

export function LotsFilPicker({
  yarns, kgCommande, kgStock, choix, onChoix, magasinNom, disabled, aideEnCommande, libelleCommande = 'Pour la commande',
}: {
  yarns: readonly FilALancer[]
  /** kg of écru for the client order (or the sst line) */
  kgCommande: number
  /** kg of écru for the Ets Malterre stock; undefined hides the column (sst line form) */
  kgStock?: number
  choix: ChoixLots
  onChoix: (next: ChoixLots) => void
  /** « chez Tricotage Malterre » in the empty state */
  magasinNom?: string
  disabled?: boolean
  /** what to do with yarn still on order, under a short yarn's supplier orders */
  aideEnCommande?: string
  libelleCommande?: string
}) {
  // §44 Shift+click range, one anchor per yarn.
  const ancres = useRef<Record<string, number>>({})
  const totalKg = kgCommande + (kgStock ?? 0)
  const avecStock = kgStock !== undefined

  if (yarns.length === 0) {
    return (
      <div className="rounded-lg border-l-4 border-l-destructive/60 border border-border/60 bg-card p-3 shadow-sm text-sm text-destructive">
        La composition de l’écru n’a pas de fil pour ce coloris : complétez-la avant de commander.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {yarns.map((y) => {
        const k = cleFil(y)
        const besoin = besoinDe(y, totalKg)
        const ids = lotsDuFil(y, totalKg, choix)
        const choisi = y.stock.filter((l) => ids.includes(l.id)).reduce((s, l) => s + l.poids, 0)
        const saisi = totalKg > 0
        const ok = saisi && choisi >= besoin - 0.005
        const manque = saisi && !ok
        // Yarn on order is only worth showing when the knitter's lots, all of them, fall short:
        // otherwise the answer is to tick a lot, right above.
        const stockInsuffisant = saisi && y.stock.reduce((s, l) => s + l.poids, 0) < besoin - 0.005
        const parLot = prises(y, ids, kgCommande, kgStock ?? 0)
        const toggle = (id: number, shift: boolean) => {
          const order = y.stock.filter((l) => l.poids > 0).map((l) => l.id)
          const next = new Set(ids)
          const anchor = ancres.current[k]
          if (shift && anchor !== undefined && anchor !== id && order.includes(anchor)) {
            const [a, b] = [order.indexOf(anchor), order.indexOf(id)]
            const [lo, hi] = a < b ? [a, b] : [b, a]
            const deselect = next.has(id)
            for (let i = lo; i <= hi; i++) { if (deselect) next.delete(order[i]); else next.add(order[i]) }
          } else {
            if (next.has(id)) next.delete(id); else next.add(id)
            ancres.current[k] = id
          }
          onChoix({ ...choix, [k]: order.filter((x) => next.has(x)) })
        }
        return (
          <div
            key={k}
            className={cn(
              'rounded-lg border-l-4 border border-border/60 bg-card shadow-sm overflow-hidden',
              ok ? 'border-l-green-500/60' : manque ? 'border-l-destructive/60' : 'border-l-amber-400/60',
            )}
          >
            {/* Yarn header: what it is, its share, whether the ticked lots cover it */}
            <div className="flex items-center gap-2.5 px-3 pt-3 pb-2">
              <div className={cn(
                'h-8 w-8 rounded-md flex items-center justify-center flex-shrink-0',
                ok ? 'bg-green-500/10 text-green-600' : manque ? 'bg-destructive/10 text-destructive/70' : 'bg-amber-400/10 text-amber-600',
              )}>
                <BobineIcon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate">{y.reference}{y.coloris ? ` - ${y.coloris}` : ''}</p>
              </div>
              <div className={cn(
                'flex items-center gap-1.5 text-sm flex-shrink-0',
                ok ? 'text-green-700 font-semibold' : manque ? 'text-destructive font-semibold' : 'text-muted-foreground',
              )}>
                {ok && <CheckCircle2 className="h-4 w-4" />}
                {manque && <AlertCircle className="h-4 w-4" />}
                {!saisi ? 'Saisissez le poids' : ok ? 'Couvert' : `Il manque ${fmtNum(besoin - choisi, 1)} kg`}
              </div>
            </div>

            {y.stock.length === 0 ? (
              <p className="px-3 pb-3 text-sm text-muted-foreground italic">
                Aucun lot{magasinNom ? ` chez ${magasinNom}` : ''}
              </p>
            ) : (
              <div className="px-3 pb-3 space-y-2">
                {y.stock.map((l) => {
                  const coche = ids.includes(l.id)
                  const vide = !(l.poids > 0)
                  const p = parLot.get(l.id) ?? { commande: 0, stock: 0 }
                  const reste = Math.max(0, l.poids - p.commande - p.stock)
                  const w = (x: number) => (l.poids > 0 ? `${(x / l.poids) * 100}%` : '0%')
                  return (
                    <div
                      key={l.id}
                      onClick={(e) => { if (!vide && !disabled) toggle(l.id, e.shiftKey) }}
                      className={cn(
                        'rounded-md border px-2.5 py-2 select-none transition-colors',
                        coche ? 'border-accent/50 bg-accent/[0.06]' : 'border-border/60 bg-zinc-50',
                        vide || disabled ? 'opacity-50' : 'cursor-pointer hover:border-accent/50',
                      )}
                    >
                      <div className="flex items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={coche}
                          disabled={vide || disabled}
                          readOnly
                          className="h-4 w-4 rounded border-input text-accent pointer-events-none flex-shrink-0"
                        />
                        <span className="text-sm font-semibold tabular-nums">Lot {l.lot || '—'}</span>
                        <span className="min-w-0 truncate text-xs text-muted-foreground">
                          {[l.fournisseur, l.date_entree ? `entré le ${formatHfsqlDate(l.date_entree)}` : ''].filter(Boolean).join(' · ')}
                        </span>
                        {l.reserve_ligne > 0 && (
                          <span className="flex-shrink-0 rounded-full border border-emerald-200 bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
                            {fmtNum(l.reserve_ligne, 1)} kg réservés pour cette ligne
                          </span>
                        )}
                        {/* Not ticked: one line, what can be taken. Ticked: the detail opens below. */}
                        {!coche && (
                          <span className="ml-auto flex-shrink-0 text-sm tabular-nums">
                            <span className="font-semibold">{fmtNum(l.poids, 1)} kg</span>
                            <span className="text-muted-foreground"> disponibles</span>
                          </span>
                        )}
                      </div>

                      {coche && (
                        <>
                          <div className={cn('mt-2.5 grid gap-2', avecStock ? 'grid-cols-4' : 'grid-cols-3')}>
                            <Chiffre label="Disponible" kg={l.poids} />
                            <Chiffre label={libelleCommande} kg={p.commande} couleur={COULEUR.commande} />
                            {avecStock && <Chiffre label="Pour le stock" kg={p.stock} couleur={COULEUR.stock} />}
                            <Chiffre label="Reste libre" kg={reste} fort />
                          </div>

                          <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full" style={{ backgroundColor: COULEUR.reste }}>
                            {p.commande > 0 && (
                              <div className="h-full transition-[width] duration-200" style={{ width: w(p.commande), backgroundColor: COULEUR.commande }} />
                            )}
                            {p.stock > 0 && (
                              <div className="h-full border-l-2 border-white transition-[width] duration-200" style={{ width: w(p.stock), backgroundColor: COULEUR.stock }} />
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {stockInsuffisant && (y.pending ?? []).length > 0 && (
              <div className="mx-3 mb-3 rounded-md bg-zinc-100 px-2.5 py-2 text-xs text-muted-foreground space-y-1">
                {(y.pending ?? []).map((o) => (
                  <p key={o.id} className="flex items-center gap-1.5">
                    <CalendarClock className="h-3.5 w-3.5 flex-shrink-0" />
                    En commande : {fmtNum(o.poids, 1)} kg{o.fournisseur ? ` chez ${o.fournisseur}` : ''}
                    {o.date_livraison ? `, prévus le ${formatHfsqlDate(o.date_livraison)}` : ''}
                  </p>
                ))}
                {aideEnCommande && <p className="text-foreground">{aideEnCommande}</p>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** One labelled figure of a ticked lot. */
function Chiffre({ label, kg, couleur, fort }: { label: string; kg: number; couleur?: string; fort?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground truncate">
        {couleur && <span className="h-2 w-2 flex-shrink-0 rounded-sm" style={{ backgroundColor: couleur }} />}
        {label}
      </p>
      <p className={cn('text-sm tabular-nums', fort ? 'font-bold' : 'font-medium')}>{fmtNum(kg, 1)} kg</p>
    </div>
  )
}
