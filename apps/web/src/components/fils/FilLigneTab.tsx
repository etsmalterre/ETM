// Clients › Commandes › line drawer › « Fil » (decision Vincent 2026-10-23, API lib/reservation-fil.ts).
// Puts the line's matter in the circuit as soon as the order is taken. Laid out like the Tricotage
// tab: one table grouped per yarn of the écru's recipe, one row per source — a lot in stock at a
// knitter, or a supplier order still to receive — with what is free on it and what THIS line holds
// on it. A row click opens the dialog that sets that hold (as a Tricotage row sets its « poids
// affecté »); 0 cancels it.
//   « Réserver tout le fil »: per yarn, Tricotage Malterre's free stock first (oldest lot first),
//   then supplier orders by arrival date; it says what nothing could cover.
// A line has its matter only when EVERY yarn is covered; the order line's gauge shows the reserved
// yarn as its last stage. Yarn on a supplier order makes the line read « attente fil » (neutral
// until the supplier's date); yarn on a lot leaves it « à lancer », and the launch dialog ticks that
// lot first. A reservation never goes beyond what the line needs.
import { Fragment, useState, type ComponentType } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, Loader2, Package, Plus, Truck, X } from 'lucide-react'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { KnitIcon } from '@/components/icons/KnitIcon'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate } from '@/lib/dates'
import { invalidateCommandeClientCaches } from '@/lib/cache-sync'
import { cn } from '@/lib/utils'

type EtatReservation = 'commande' | 'lot' | 'consommee' | 'liberee'

interface CommandeFilLigne {
  IDref_fil_commande: number
  IDcommande_fil: number
  fournisseur: string
  date_livraison: string | null
  reste: number
  /** free for any line (what is still to receive, less every waiting reservation) */
  libre: number
  /** what this line holds on it */
  pour_ligne: number
}

interface LotReservable {
  IDstock_fil: number
  lot: string
  magasin: string
  fournisseur: string
  date_entree: string
  /** free for any other line */
  dispo: number
  /** what this line holds on it */
  pour_ligne: number
}

interface FilYarn {
  IDref_fil: number
  IDcolori_fil: number
  reference: string
  coloris: string
  pourcentage: number
  reserve_kg: number
  /** still to cover once rolls, knitting orders and reservations are counted */
  manque_kg: number
  lots: LotReservable[]
  commandes: CommandeFilLigne[]
}

interface Reservation {
  id: number
  IDref_fil: number
  IDcolori_fil: number
  kg: number
  etat: EtatReservation
  lot: string | null
  motif: string | null
}

interface FilPayload {
  applicable: boolean
  ecru_ref_label?: string
  ecru_coloris_label?: string
  kg_ligne?: number
  kg_affecte?: number
  yarns?: FilYarn[]
  reservations?: Reservation[]
}

/** One row of a yarn's table: a lot or a supplier order line. */
interface Source {
  kind: 'lot' | 'commande'
  id: number
  titre: string
  fournisseur: string
  ou: string
  /** free for anyone else */
  libre: number
  pour_ligne: number
}

type Bilan = { reserve: { fil: string; kind: 'lot' | 'commande'; kg: number }[]; manques: { fil: string; kg: number }[] }

/** Where a source sits: a knitter holding lots, or the suppliers (yarn not delivered yet). */
const GROUPE_COMMANDES = 'En commande chez les fournisseurs'

interface SourceFil extends Source {
  yarn: FilYarn
  groupe: string
  /** the lot number or the supplier order number */
  numero: string
  /** lot entry date or supplier date, already formatted */
  date: string
}

function sourcesDuFil(y: FilYarn): SourceFil[] {
  return [
    ...y.lots.map((l) => ({
      yarn: y,
      groupe: l.magasin || 'Malterre',
      kind: 'lot' as const,
      id: l.IDstock_fil,
      numero: l.lot || '—',
      titre: `Lot ${l.lot || '—'}`,
      fournisseur: l.fournisseur,
      date: l.date_entree ? formatHfsqlDate(l.date_entree) : '—',
      ou: [l.magasin, l.date_entree ? `entré le ${formatHfsqlDate(l.date_entree)}` : ''].filter(Boolean).join(' · '),
      libre: l.dispo,
      pour_ligne: l.pour_ligne,
    })),
    ...y.commandes
      .filter((c) => c.libre > 0 || c.pour_ligne > 0)
      .map((c) => ({
        yarn: y,
        groupe: GROUPE_COMMANDES,
        kind: 'commande' as const,
        id: c.IDref_fil_commande,
        numero: String(c.IDcommande_fil),
        titre: `Cde N° ${c.IDcommande_fil}`,
        fournisseur: c.fournisseur,
        date: c.date_livraison ? formatHfsqlDate(c.date_livraison) : 'sans date',
        ou: c.date_livraison ? `En commande · prévue le ${formatHfsqlDate(c.date_livraison)}` : 'En commande · sans date',
        libre: c.libre,
        pour_ligne: c.pour_ligne,
      })),
  ]
}

/** Knitters first — Tricotage Malterre at the top, the others by name — then the suppliers. */
function groupesDeSources(sources: readonly SourceFil[]): { groupe: string; rows: SourceFil[] }[] {
  const noms = [...new Set(sources.map((s) => s.groupe))].sort((a, b) =>
    (a === GROUPE_COMMANDES ? 1 : 0) - (b === GROUPE_COMMANDES ? 1 : 0)
    || (b === 'Tricotage Malterre' ? 1 : 0) - (a === 'Tricotage Malterre' ? 1 : 0)
    || a.localeCompare(b, 'fr'))
  return noms.map((groupe) => ({ groupe, rows: sources.filter((s) => s.groupe === groupe) }))
}

const ETAT_FIGE: Partial<Record<EtatReservation, { label: (r: Reservation) => string; icon: ComponentType<{ className?: string }> }>> = {
  consommee: { label: (r) => `Pris par le tricotage · lot ${r.lot ?? '—'}`, icon: KnitIcon },
  liberee: { label: (r) => `Libéré · ${r.motif ?? 'non livré'}`, icon: AlertCircle },
}

export function FilLigneTab({ commandeId, ligneId, soldee }: { commandeId: number; ligneId: number; soldee: boolean }) {
  const queryClient = useQueryClient()
  const queryKey = ['commande-client-fil', commandeId, ligneId]
  const { data, isLoading, isError } = useQuery<FilPayload>({
    queryKey,
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/lignes/${ligneId}/fil`),
    // Yarn orders and lots are written on other screens (Fils › Commandes, TRM Fils › Stock).
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const [cible, setCible] = useState<{ yarn: FilYarn; source: Source } | null>(null)
  const [bilan, setBilan] = useState<Bilan | null>(null)

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey })
    queryClient.invalidateQueries({ queryKey: ['fil-etat'] })
    queryClient.invalidateQueries({ queryKey: ['stock-fil'] })
    // The line's status, its gauge and the order's colour follow its reservations.
    invalidateCommandeClientCaches(queryClient)
  }
  const toutMut = useMutation({
    mutationFn: () => apiFetch<Bilan>(`/commandes-client/${commandeId}/lignes/${ligneId}/fil/reserver-tout`, { method: 'POST' }),
    onSuccess: (r) => { setBilan(r); refresh() },
  })

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    )
  }
  if (isError || !data) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />Impossible de charger le fil de la ligne
      </div>
    )
  }
  if (!data.applicable || !data.yarns || data.yarns.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-8 text-muted-foreground">
        <BobineIcon className="h-8 w-8 mb-2 opacity-50" />
        <p className="text-sm font-medium">Pas de fil à prévoir</p>
        <p className="text-xs mt-1">La référence n’a pas de composition en fil.</p>
      </div>
    )
  }

  const yarns = data.yarns
  const resteAReserver = yarns.some((y) => y.manque_kg > 0.05)
  const kgAffecte = data.kg_affecte ?? 0
  const figees = (data.reservations ?? []).filter((r) => ETAT_FIGE[r.etat])
  const nomFil = (refFil: number, coloriFil: number) => {
    const y = yarns.find((x) => x.IDref_fil === refFil && x.IDcolori_fil === coloriFil)
    return y ? `${y.reference}${y.coloris ? ` - ${y.coloris}` : ''}` : ''
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto p-3 space-y-4 scrollbar-transparent">
        <section>
          <div className="flex items-center gap-2 mb-1.5">
            <h3 className="min-w-0 flex-1 text-[10px] uppercase tracking-wide text-primary/70 font-semibold truncate">
              {data.ecru_ref_label ? `${data.ecru_ref_label}${data.ecru_coloris_label ? ` /${data.ecru_coloris_label}` : ''}` : 'Tombé de métier'} — fil de la ligne : {fmtNum(data.kg_ligne ?? 0, 1)} kg
              {kgAffecte > 0.05 && <span className="normal-case tracking-normal font-normal"> (dont {fmtNum(kgAffecte, 1)} kg déjà en production ou en stock)</span>}
            </h3>
            {!soldee && (
              <Button
                variant="ghost" size="sm"
                disabled={!resteAReserver || toutMut.isPending}
                title={resteAReserver ? 'Réserve ce qui manque de chaque fil : le stock d’abord, puis les commandes fournisseur' : 'Tout le fil de la ligne est réservé'}
                onClick={() => toutMut.mutate()}
                className="h-6 px-2 flex-shrink-0 text-[11px] text-accent hover:text-accent hover:bg-accent/10"
              >
                {toutMut.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}
                Réserver tout le fil
              </Button>
            )}
          </div>

          {toutMut.error && (
            <p className="mb-2 flex items-center gap-1.5 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {(toutMut.error as any).body?.message ?? 'La réservation a échoué'}
            </p>
          )}
          {bilan && (
            <div className={cn(
              'mb-2 rounded-lg border-l-4 border border-border/60 bg-card p-2.5 shadow-sm text-xs space-y-1',
              bilan.manques.length > 0 ? 'border-l-destructive/60' : 'border-l-green-500/60',
            )}>
              {bilan.reserve.length === 0 && bilan.manques.length === 0 && <p>Rien à réserver.</p>}
              {bilan.reserve.length > 0 && (
                <p className="flex items-start gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-green-600" />
                  <span>Réservé : {bilan.reserve.map((r) => `${fmtNum(r.kg, 1)} kg de ${r.fil} ${r.kind === 'lot' ? 'en stock' : 'en commande'}`).join(' ; ')}.</span>
                </p>
              )}
              {bilan.manques.length > 0 && (
                <p className="flex items-start gap-1.5 text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  <span>Introuvable : {bilan.manques.map((m) => `${fmtNum(m.kg, 1)} kg de ${m.fil}`).join(' ; ')}. Commandez ce fil au fournisseur, puis réservez-le ici.</span>
                </p>
              )}
            </div>
          )}

          {/* What each yarn of the line still needs — the whole line has its matter only when all are covered. */}
          <div className="mb-2 rounded-lg border border-border/60 bg-card shadow-sm divide-y divide-border/40">
            {yarns.map((y) => {
              const aCouvrir = y.reserve_kg + y.manque_kg
              const couvert = y.manque_kg <= 0.05
              const pct = Math.round(y.pourcentage * 10) / 10
              return (
                <div key={`${y.IDref_fil}:${y.IDcolori_fil}`} className="flex items-center gap-2 px-2.5 py-2 text-xs">
                  <BobineIcon className="h-3.5 w-3.5 flex-shrink-0 text-accent" />
                  <span className="min-w-0 truncate font-medium">{y.reference}{y.coloris ? ` - ${y.coloris}` : ''}</span>
                  <span className="flex-shrink-0 text-muted-foreground">· {fmtNum(pct, Number.isInteger(pct) ? 0 : 1)} %</span>
                  <span className={cn('ml-auto flex-shrink-0 inline-flex items-center gap-1 tabular-nums', couvert ? 'text-green-700 font-medium' : 'text-muted-foreground')}>
                    {couvert && <CheckCircle2 className="h-3.5 w-3.5" />}
                    Réservé {fmtNum(y.reserve_kg, 1)} / {fmtNum(aCouvrir, 1)} kg
                  </span>
                </div>
              )
            })}
          </div>

          {(() => {
            const groupes = groupesDeSources(yarns.flatMap(sourcesDuFil))
            if (groupes.length === 0) {
              return (
                <p className="text-xs text-muted-foreground italic">
                  Aucun lot ni commande de ces fils : commandez-les au fournisseur.
                </p>
              )
            }
            return (
              <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
                <table className="w-full text-xs">
                  <tbody>
                    {groupes.map(({ groupe, rows }) => {
                      const enCommande = groupe === GROUPE_COMMANDES
                      return (
                        <Fragment key={groupe}>
                          {/* Group band doubles as the header row, as on the Tricotage tab's stock table. */}
                          <tr className="text-[10px] uppercase tracking-wide text-primary/80 bg-primary/10 border-b border-primary/10">
                            <td className="px-2.5 py-1.5 font-semibold whitespace-nowrap w-full">{groupe}</td>
                            <td className="px-2.5 py-1.5 font-semibold whitespace-nowrap">{enCommande ? 'Cde' : 'Lot'}</td>
                            <td className="px-2.5 py-1.5 font-semibold whitespace-nowrap">Fournisseur</td>
                            <td className="px-2.5 py-1.5 font-semibold whitespace-nowrap">{enCommande ? 'Prévue' : 'Entrée'}</td>
                            <td className="px-2.5 py-1.5 font-semibold whitespace-nowrap text-right">Libre</td>
                            <td className="px-2.5 py-1.5 font-semibold whitespace-nowrap text-right">Pour la ligne</td>
                          </tr>
                          {rows.map((src) => {
                            const ouvrable = !soldee && (src.pour_ligne > 0 || (src.libre > 0 && src.yarn.manque_kg > 0.05))
                            return (
                              <tr
                                key={`${src.kind}:${src.id}`}
                                onClick={ouvrable ? () => setCible({ yarn: src.yarn, source: src }) : undefined}
                                title={ouvrable ? 'Réserver pour la ligne' : undefined}
                                className={cn(
                                  'border-b border-border/40 last:border-0',
                                  ouvrable ? 'cursor-pointer hover:bg-accent/10' : 'hover:bg-accent/5',
                                  src.pour_ligne > 0 && 'bg-accent/[0.06]',
                                )}
                              >
                                <td className="px-2.5 py-2 whitespace-nowrap">
                                  <span className="inline-flex items-center gap-1.5 font-medium">
                                    <BobineIcon className="h-3.5 w-3.5 flex-shrink-0 text-accent" />
                                    {src.yarn.reference}{src.yarn.coloris ? ` - ${src.yarn.coloris}` : ''}
                                  </span>
                                </td>
                                <td className="px-2.5 py-2 whitespace-nowrap tabular-nums">{src.numero}</td>
                                <td className="px-2.5 py-2 whitespace-nowrap">{src.fournisseur || '—'}</td>
                                <td className="px-2.5 py-2 whitespace-nowrap tabular-nums text-muted-foreground">{src.date}</td>
                                <td className="px-2.5 py-2 whitespace-nowrap text-right tabular-nums">{fmtNum(src.libre, 1)} kg</td>
                                <td className={cn('px-2.5 py-2 whitespace-nowrap text-right tabular-nums', src.pour_ligne > 0 ? 'font-bold' : 'text-muted-foreground')}>
                                  {src.pour_ligne > 0 ? `${fmtNum(src.pour_ligne, 1)} kg` : '—'}
                                </td>
                              </tr>
                            )
                          })}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          })()}
        </section>

        {figees.length > 0 && (
          <section>
            <h3 className="text-[10px] uppercase tracking-wide text-primary/70 font-semibold mb-1.5">Déjà pris ou libéré</h3>
            <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
              <table className="w-full text-xs">
                <tbody>
                  {figees.map((r) => {
                    const meta = ETAT_FIGE[r.etat]!
                    const Icon = meta.icon
                    return (
                      <tr key={r.id} className="border-b border-border/40 last:border-0 text-muted-foreground">
                        <td className="px-2.5 py-2 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5"><Icon className="h-3.5 w-3.5" />{meta.label(r)}</span>
                        </td>
                        <td className="px-2.5 py-2 w-full truncate">{nomFil(r.IDref_fil, r.IDcolori_fil)}</td>
                        <td className={cn('px-2.5 py-2 whitespace-nowrap text-right tabular-nums', r.etat === 'liberee' && 'line-through')}>
                          {fmtNum(r.kg, 1)} kg
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      <ReservationDialog
        commandeId={commandeId}
        ligneId={ligneId}
        cible={cible}
        onClose={() => setCible(null)}
        onSuccess={() => { setCible(null); setBilan(null); refresh() }}
      />
    </>
  )
}

/** Sets what the line holds on one source — opened by a row click, like the Tricotage tab's
 *  « poids affecté » dialog. Starts on the current hold, or on what the line still needs within
 *  what is free; 0 cancels. */
function ReservationDialog({ commandeId, ligneId, cible, onClose, onSuccess }: {
  commandeId: number
  ligneId: number
  cible: { yarn: FilYarn; source: Source } | null
  onClose: () => void
  onSuccess: () => void
}) {
  const [kg, setKg] = useState('')
  const [lastKey, setLastKey] = useState<string | null>(null)
  const key = cible ? `${cible.source.kind}:${cible.source.id}` : null
  const mien = cible?.source.pour_ligne ?? 0
  // Never beyond what the line still needs of this yarn, nor beyond what is free on the source.
  const plafond = cible ? mien + Math.max(0, Math.min(cible.yarn.manque_kg, cible.source.libre)) : 0
  if (key !== lastKey) {
    setLastKey(key)
    if (cible) {
      const depart = mien > 0 ? mien : plafond
      setKg(depart > 0 ? String(Math.round(depart * 100) / 100).replace('.', ',') : '')
    }
  }
  const mut = useMutation({
    mutationFn: (v: number) => apiFetch(`/commandes-client/${commandeId}/lignes/${ligneId}/fil/reservations/source`, {
      method: 'PUT',
      body: JSON.stringify(cible!.source.kind === 'lot'
        ? { IDstock_fil: cible!.source.id, kg: v }
        : { IDref_fil_commande: cible!.source.id, kg: v }),
    }),
    onSuccess,
  })
  const brut = kg.trim() === '' ? 0 : Number(kg.replace(',', '.').replace(/\s/g, ''))
  const value = Number.isFinite(brut) ? brut : NaN
  const valid = !!cible && Number.isFinite(value) && value >= 0 && value <= plafond + 0.05 && Math.abs(value - mien) > 0.005
  const close = () => { mut.reset(); onClose() }

  // Read live while typing — same columns + bar as a ticked lot in « Lancer le tricotage ».
  const pourLigne = Number.isFinite(value) ? Math.max(0, value) : 0
  const total = cible ? cible.source.libre + mien : 0
  const resteLibre = Math.max(0, total - pourLigne)
  const aCouvrir = cible ? cible.yarn.reserve_kg + cible.yarn.manque_kg : 0
  const reserveApres = cible ? cible.yarn.reserve_kg - mien + pourLigne : 0
  const couvert = aCouvrir > 0 && reserveApres >= aCouvrir - 0.05
  const annule = mien > 0 && pourLigne === 0
  const blocage = !cible || mut.isPending
    ? null
    : !Number.isFinite(value) || value < 0
      ? 'Saisissez une quantité'
      : value > total + 0.05
        ? `Il n’y a que ${fmtNum(total, 1)} kg ici`
        : value > plafond + 0.05
          ? `La ligne n’a besoin que de ${fmtNum(plafond, 1)} kg de ce fil ici`
          : null
  const SourceIcon = cible?.source.kind === 'lot' ? Package : Truck

  return (
    <Dialog open={cible !== null} onOpenChange={(o) => { if (!o && !mut.isPending) close() }}>
      {/* §18.D banded dialog — the same composition as « Lancer le tricotage ». */}
      <DialogContent className="max-w-lg p-0 border-0 bg-primary overflow-hidden max-h-[90dvh] flex flex-col">
        <div className="flex-shrink-0 flex items-center gap-2.5 rounded-t-lg border-b-2 border-gold bg-primary px-4 py-2.5">
          <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
            <BobineIcon className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">Réserver du fil pour la ligne</h2>
            {cible && (
              <p className="text-xs text-white/70 truncate">
                {cible.yarn.reference}{cible.yarn.coloris ? ` - ${cible.yarn.coloris}` : ''}
              </p>
            )}
          </div>
          <Button
            variant="ghost" size="icon" title="Fermer" disabled={mut.isPending} onClick={close}
            className="h-8 w-8 flex-shrink-0 text-white/80 hover:bg-white/15 hover:text-white"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {cible && (
          <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-100 p-4 space-y-3 scrollbar-transparent">
            {/* What the user decides */}
            <div className="rounded-lg border-l-4 border-l-accent/70 border border-border/60 bg-card shadow-sm p-4 space-y-2">
              <label className="text-sm font-semibold">Réservé pour la ligne</label>
              <div className="relative">
                <input
                  type="text" inputMode="decimal" value={kg} autoFocus placeholder="0"
                  onChange={(e) => setKg(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && valid) mut.mutate(value) }}
                  className="w-full h-10 pl-3 pr-10 text-base font-semibold text-right tabular-nums rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">kg</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {cible.source.kind === 'lot'
                  ? 'Ce lot sera pris en premier au lancement du tricotage de la ligne.'
                  : 'À la réception, ce fil passera sur le lot créé depuis cette commande, puis sur la commande de tricotage lancée depuis la ligne.'}
                {mien > 0 && ' Mettez 0 pour annuler la réservation.'}
              </p>
            </div>

            {/* What it takes: the source, read live */}
            <div className="rounded-lg border border-border/60 bg-card shadow-sm p-4 space-y-3">
              <div className="flex items-center gap-2.5">
                <div className={cn(
                  'h-8 w-8 rounded-md flex items-center justify-center flex-shrink-0',
                  cible.source.kind === 'lot' ? 'bg-emerald-500/10 text-emerald-700' : 'bg-sky-500/10 text-sky-700',
                )}>
                  <SourceIcon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">
                    {cible.source.titre}{cible.source.fournisseur ? ` · ${cible.source.fournisseur}` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">{cible.source.ou}</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Chiffre label="Libre" kg={total} />
                <Chiffre label="Pour cette ligne" kg={pourLigne} couleur={COULEUR_LIGNE} />
                <Chiffre label="Reste libre" kg={resteLibre} fort />
              </div>
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-200">
                {pourLigne > 0 && total > 0 && (
                  <div
                    className="h-full transition-[width] duration-200"
                    style={{ width: `${Math.min(100, (pourLigne / total) * 100)}%`, backgroundColor: COULEUR_LIGNE }}
                  />
                )}
              </div>
            </div>
          </div>
        )}

        <div className="flex-shrink-0 rounded-b-lg border-t border-border/60 bg-zinc-200 px-4 py-3 space-y-2">
          {mut.error && (
            <div className="flex items-start gap-1.5 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span className="break-words">{(mut.error as any).body?.message ?? 'Erreur lors de la réservation'}</span>
            </div>
          )}
          {/* What the line needs of this yarn, and how much of it is reserved after this change */}
          <div className="min-w-0">
            <p className={cn('text-xs font-medium tabular-nums truncate', couvert ? 'text-green-600' : 'text-muted-foreground')}>
              <span className={cn('font-bold', !couvert && 'text-foreground')}>{fmtNum(reserveApres, 1)}</span>
              {' / '}{fmtNum(aCouvrir, 1)} kg de ce fil réservés pour la ligne
            </p>
            <div className="h-1.5 mt-1.5 rounded-full bg-white overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', couvert ? 'bg-green-500' : 'bg-accent')}
                style={{ width: `${aCouvrir > 0 ? Math.min(100, (reserveApres / aCouvrir) * 100) : 0}%` }}
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            {blocage && <span className="min-w-0 flex-1 text-sm text-muted-foreground">{blocage}</span>}
            <div className="ml-auto flex gap-2 flex-shrink-0">
              <Button variant="outline" onClick={close} disabled={mut.isPending}>Annuler</Button>
              <Button
                variant={annule ? 'destructive' : 'default'}
                onClick={() => mut.mutate(value)} disabled={!valid || mut.isPending} title={blocage ?? undefined}
              >
                {mut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <BobineIcon className="h-3.5 w-3.5 mr-1.5" />}
                {annule ? 'Annuler la réservation' : 'Enregistrer'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The source's part for this client line: the « Pour la commande » colour of the launch dialog. */
const COULEUR_LIGNE = '#2a78d6'

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
