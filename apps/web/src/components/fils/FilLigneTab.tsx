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
import { Fragment, useState, type ComponentType, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, Loader2, Plus, X } from 'lucide-react'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { KnitIcon } from '@/components/icons/KnitIcon'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Tooltip } from '@/components/ui/tooltip'
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
  quantite: number
  recu: number
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
  stock: number
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
  /** the most the line may hold of this yarn: need + 10 % (API plafondReservation) */
  plafond_kg: number
  /** how the need is obtained, on the écru still to make (API besoinFil) */
  calcul: { kg_ecru: number; fil: number; avec_marge: number; besoin: number } | null
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
  /** the line's quantity in écru kg */
  kg_ligne?: number
  /** the yarn that écru takes: kg_ligne ÷ (1 − freinte de tricotage) */
  kg_fil_ligne?: number
  freinte_tricotage?: { taux: number; source: string; origine: string }
  /** safety margin on top of the freinte (0.05) and the rounding step of a need (kg) */
  marge_securite?: number
  arrondi_kg?: number
  /** one roll of the écru (catalogue), 0 = unknown */
  poids_rouleau?: number
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
  /** what is on the source: a lot's stock, an order line's kg still to receive */
  total: number
  /** the « Commandé » cell's hover: ordered / received */
  totalTitre?: string
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
      total: l.stock,
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
        total: c.reste,
        totalTitre: `${fmtNum(c.quantite, 1)} kg commandés, ${fmtNum(c.recu, 1)} kg reçus`,
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
              {data.ecru_ref_label ? `${data.ecru_ref_label}${data.ecru_coloris_label ? ` /${data.ecru_coloris_label}` : ''}` : 'Tombé de métier'} — {fmtNum(data.kg_ligne ?? 0, 1)} kg d’écru
              {data.freinte_tricotage && data.freinte_tricotage.taux > 0 && (
                <span title={`Freinte de tricotage ${data.freinte_tricotage.origine}`}> → fil {fmtNum(data.kg_fil_ligne ?? 0, 0)} kg (freinte {fmtNum(data.freinte_tricotage.taux * 100, 1)} % + marge {fmtNum((data.marge_securite ?? 0) * 100, 0)} %)</span>
              )}
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
              // The need (it stays the denominator when the line holds more, up to + 10 %).
              const aCouvrir = y.calcul?.besoin ?? y.reserve_kg + y.manque_kg
              const couvert = y.manque_kg <= 0.05
              const pct = Math.round(y.pourcentage * 10) / 10
              return (
                <div key={`${y.IDref_fil}:${y.IDcolori_fil}`} className="flex items-center gap-2 px-2.5 py-2 text-xs">
                  <BobineIcon className="h-3.5 w-3.5 flex-shrink-0 text-accent" />
                  <span className="min-w-0 truncate font-medium">{y.reference}{y.coloris ? ` - ${y.coloris}` : ''}</span>
                  <span className="flex-shrink-0 text-muted-foreground">· {fmtNum(pct, Number.isInteger(pct) ? 0 : 1)} %</span>
                  <span className={cn('ml-auto flex-shrink-0 inline-flex items-center gap-1 tabular-nums', couvert ? 'text-green-700 font-medium' : 'text-muted-foreground')}>
                    {couvert && <CheckCircle2 className="h-3.5 w-3.5" />}
                    Réservé {fmtNum(y.reserve_kg, 1)} /{' '}
                    <BesoinFilTooltip yarn={y} data={data} kgAffecte={kgAffecte}>
                      <span className="underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 cursor-help">{fmtNum(aCouvrir, 1)} kg</span>
                    </BesoinFilTooltip>
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
                            <td className="px-2.5 py-1.5 font-semibold whitespace-nowrap text-right">{enCommande ? 'Commandé' : 'Stock'}</td>
                            <td className="px-2.5 py-1.5 font-semibold whitespace-nowrap text-right">Libre</td>
                            <td className="px-2.5 py-1.5 font-semibold whitespace-nowrap text-right">Pour la ligne</td>
                          </tr>
                          {rows.map((src) => {
                            const ouvrable = !soldee && (src.pour_ligne > 0 || (src.libre > 0 && src.yarn.plafond_kg - src.yarn.reserve_kg > 0.05))
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
                                <td className="px-2.5 py-2 whitespace-nowrap text-right tabular-nums" title={src.totalTitre}>{fmtNum(src.total, 1)} kg</td>
                                <td className={cn('px-2.5 py-2 whitespace-nowrap text-right tabular-nums', src.libre <= 0.05 && 'text-muted-foreground')}>{fmtNum(src.libre, 1)} kg</td>
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

/** Sets what the line holds on one source — opened by a row click (the row already says which
 *  order or lot, Vincent 2026-10-26): type a value, « Tout enlever », « Réserver le besoin » or « Tout réserver ». A line
 *  may hold up to its need + 10 % of a yarn (a whole 660 kg order for a 650 kg need). */
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
  const besoin = cible ? cible.yarn.calcul?.besoin ?? cible.yarn.reserve_kg + cible.yarn.manque_kg : 0
  // What the line holds elsewhere, then what it may take here: never beyond need + 10 %,
  // nor beyond what is free on the source.
  const ailleurs = cible ? Math.max(0, cible.yarn.reserve_kg - mien) : 0
  const surSource = cible ? mien + cible.source.libre : 0
  const plafond = cible ? Math.min(surSource, Math.max(0, cible.yarn.plafond_kg - ailleurs)) : 0
  // What the line still needs, taken here (within what is free).
  const leBesoin = Math.min(surSource, Math.max(0, besoin - ailleurs))
  const fmtKg = (x: number) => String(Math.round(x * 100) / 100).replace('.', ',')
  // Button labels: no decimals on a round number, so three buttons fit on one row.
  const kgBouton = (x: number) => `${fmtNum(x, Math.abs(x - Math.round(x)) < 0.005 ? 0 : 1)} kg`
  if (key !== lastKey) {
    setLastKey(key)
    if (cible) {
      // Starts on the current hold, else on what the line still needs within what is free here.
      const depart = mien > 0 ? mien : Math.min(surSource, Math.max(0, besoin - ailleurs))
      setKg(depart > 0 ? fmtKg(depart) : '')
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

  const pourLigne = Number.isFinite(value) ? Math.max(0, value) : 0
  const reserveApres = ailleurs + pourLigne
  const couvert = besoin > 0 && reserveApres >= besoin - 0.05
  const audela = reserveApres - besoin
  const annule = mien > 0 && pourLigne === 0
  const blocage = !cible || mut.isPending
    ? null
    : !Number.isFinite(value) || value < 0
      ? 'Saisissez une quantité'
      : value > surSource + 0.05
        ? `Il n’y a que ${fmtNum(surSource, 1)} kg ici`
        : value > plafond + 0.05
          ? `Au plus ${fmtNum(plafond, 1)} kg ici (besoin + 10 %)`
          : null

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
                {cible.source.titre} · {cible.yarn.reference}{cible.yarn.coloris ? ` - ${cible.yarn.coloris}` : ''}
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
          <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-100 p-4 scrollbar-transparent">
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
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="flex-1 min-w-0 h-auto min-h-8 px-2 py-1.5 whitespace-normal leading-tight" disabled={mut.isPending || pourLigne === 0} onClick={() => setKg('0')}>
                  Tout enlever
                </Button>
                {/* Hidden when it would do what « Tout réserver » does (the source cannot cover the need). */}
                {leBesoin > 0.005 && leBesoin < plafond - 0.005 && (
                  <Button variant="outline" size="sm" className="flex-1 min-w-0 h-auto min-h-8 px-2 py-1.5 whitespace-normal leading-tight" disabled={mut.isPending} onClick={() => setKg(fmtKg(leBesoin))}>
                    Réserver le besoin ({kgBouton(leBesoin)})
                  </Button>
                )}
                <Button
                  variant="outline" size="sm" className="flex-1 min-w-0 h-auto min-h-8 px-2 py-1.5 whitespace-normal leading-tight" disabled={mut.isPending || plafond <= 0.005}
                  title={plafond < surSource - 0.05 ? 'Jusqu’au besoin + 10 %' : 'Tout ce qui est libre ici'}
                  onClick={() => setKg(fmtKg(plafond))}
                >
                  Tout réserver ({kgBouton(plafond)})
                </Button>
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
              {' / '}{fmtNum(besoin, 1)} kg de ce fil réservés pour la ligne
              {audela > 0.05 && <span className="font-normal text-muted-foreground"> · {fmtNum(audela, 1)} kg au-delà du besoin</span>}
            </p>
            <div className="h-1.5 mt-1.5 rounded-full bg-white overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', couvert ? 'bg-green-500' : 'bg-accent')}
                style={{ width: `${besoin > 0 ? Math.min(100, (reserveApres / besoin) * 100) : 0}%` }}
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

/** How a yarn's need is obtained (decision Vincent 2026-10-26): écru still to make ÷ (1 − freinte)
 *  × (1 + safety margin), rounded up to 10 kg. Same look as the « Rouleaux estimés » tooltip. */
function BesoinFilTooltip({ yarn, data, kgAffecte, children }: { yarn: FilYarn; data: FilPayload; kgAffecte: number; children: ReactNode }) {
  const c = yarn.calcul
  const f = data.freinte_tricotage
  if (!c || !f) return <>{children}</>
  const pct = Math.round(yarn.pourcentage * 10) / 10
  const ecruAFaire = Math.max(0, (data.kg_ligne ?? 0) - kgAffecte)
  const rouleaux = data.poids_rouleau ? Math.round(ecruAFaire / data.poids_rouleau) : 0
  return (
    <Tooltip
      side="bottom"
      content={
        <div className="w-max min-w-[290px] py-1 font-normal">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-primary/70">Besoin en fil</p>
          <p className="mt-0.5 flex items-baseline gap-1.5">
            <span className="text-2xl font-bold tabular-nums text-primary">{fmtNum(c.besoin, 0)}</span>
            <span className="text-sm text-muted-foreground">kg</span>
          </p>
          <div className="mt-2 pt-2 border-t border-border/60 space-y-1 text-xs tabular-nums">
            <CalculRow
              label={`${kgAffecte > 0.05 ? 'Écru encore à produire' : 'Écru de la ligne'}${pct < 100 ? ` × ${fmtNum(pct, Number.isInteger(pct) ? 0 : 1)} %` : ''}`}
              value={`${fmtNum(c.kg_ecru, 1)} kg`}
            />
            <CalculRow label={`÷ (1 − ${fmtNum(f.taux * 100, 1)} % freinte tricotage)`} value={`${fmtNum(c.fil, 1)} kg`} />
            <CalculRow label={`× ${fmtNum(1 + (data.marge_securite ?? 0), 2)} marge de sécurité`} value={`${fmtNum(c.avec_marge, 1)} kg`} />
            <CalculRow label={`arrondi aux ${fmtNum(data.arrondi_kg ?? 10, 0)} kg supérieurs`} value={`${fmtNum(c.besoin, 0)} kg`} strong />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Freinte {f.origine}.
            {rouleaux > 0 && <> ≈ {fmtNum(rouleaux)} rouleau{rouleaux >= 2 ? 'x' : ''} d’écru de {fmtNum(data.poids_rouleau ?? 0, 0)} kg.</>}
          </p>
        </div>
      }
    >
      {children}
    </Tooltip>
  )
}

function CalculRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn(strong && 'font-semibold text-foreground')}>{value}</span>
    </div>
  )
}
