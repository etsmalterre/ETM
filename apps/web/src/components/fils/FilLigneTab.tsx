// Clients › Commandes › line drawer: the line's YARN, in two tabs, one per form of the matter
// (decision Vincent 2026-10-28, API lib/reservation-fil.ts, components/commandes/ZonesLigne.tsx):
//   « Fil »       = yarn reserved on SUPPLIER ORDERS (it does not exist yet; the line reads « attente
//                   fil »), bottom zone = those orders and where they stand (placed in Fils › Commandes);
//   « Tricotage » = yarn reserved on LOTS in stock at a knitter (the line reads « à lancer »), bottom
//                   zone = the knitting orders (ClientsCommandes, FilEnStockZone).
// Same zone in both (FilFormeZone): per yarn the need of THIS form — in stock: the line's whole yarn
// need (what its fini, écru and knitting leave); on order: what the stock left — then the sources the
// line holds of that form, in ONE clickable block that opens the selector: per yarn, its sources of
// that form, a box to tick (ReserverFilDialog). Ticking only fills the kilos: which lot, at which
// knitter, or which supplier order is the person's decision (Vincent 2026-10-28: no « réserver tout »
// nor « cocher le nécessaire » — planning, a lot to finish, yarn kept for another client). When an ordered
// lot arrives, its reservation moves onto the lot (basculerSurLot): it leaves Fil for Tricotage.
// A reservation never goes beyond what the line needs + 10 % (all forms together).
import { useState, type ComponentType, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, CheckCircle2, Loader2, Pencil, X } from 'lucide-react'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { KnitIcon } from '@/components/icons/KnitIcon'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Tooltip } from '@/components/ui/tooltip'
import { ZoneLigne } from '@/components/commandes/ZonesLigne'
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
  /** where the lot is (0 = the factory) and whether that place knits (the Tricotage tab launches there) */
  magasin_id: number
  tricoteur: boolean
  fournisseur: string
  date_entree: string
  stock: number
  /** free for any other line */
  dispo: number
  /** what this line holds on it */
  pour_ligne: number
}

export interface FilYarn {
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
  /** the knitting order line that took it (« consommée »), 0 otherwise */
  IDligne_commande_sous_traitant?: number
}

export interface FilPayload {
  applicable: boolean
  ecru_ref_label?: string
  ecru_coloris_label?: string
  /** the fini's rendement (Ml per kg of écru), 0 on an écru line */
  rendement?: number
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


/** Where a source sits: a knitter holding lots, or the suppliers (yarn not delivered yet). */
const GROUPE_COMMANDES = 'En commande chez les fournisseurs'

interface SourceFil extends Source {
  yarn: FilYarn
  groupe: string
  /** the knitter holding a lot (0 = the factory or a supplier order) and whether it knits */
  magasinId: number
  tricoteur: boolean
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
      magasinId: l.magasin_id ?? 0,
      tricoteur: !!l.tricoteur,
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
        magasinId: 0,
        tricoteur: false,
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

const ETAT_FIGE: Partial<Record<EtatReservation, { label: (r: Reservation) => string; icon: ComponentType<{ className?: string }> }>> = {
  consommee: { label: (r) => `Pris par le tricotage · lot ${r.lot ?? '—'}`, icon: KnitIcon },
  liberee: { label: (r) => `Libéré · ${r.motif ?? 'non livré'}`, icon: AlertCircle },
}

export const filLigneQueryKey = (commandeId: number, ligneId: number) => ['commande-client-fil', commandeId, ligneId]

/** The line's yarn (API GET …/lignes/:id/fil), shared by the Fil and Tricotage tabs. */
export function useFilLigne(commandeId: number, ligneId: number, enabled = true) {
  return useQuery<FilPayload>({
    queryKey: filLigneQueryKey(commandeId, ligneId),
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/lignes/${ligneId}/fil`),
    // Yarn orders and lots are written on other screens (Fils › Commandes, TRM Fils › Stock).
    staleTime: 0,
    refetchOnMount: 'always',
    enabled,
  })
}

/** What to refresh once a reservation moved: the yarn, the yarn screens, the line's status and gauge. */
function useRafraichirFil(commandeId: number, ligneId: number) {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: filLigneQueryKey(commandeId, ligneId) })
    queryClient.invalidateQueries({ queryKey: ['fil-etat'] })
    queryClient.invalidateQueries({ queryKey: ['stock-fil'] })
    // The line's status, its gauge and the order's colour follow its reservations.
    invalidateCommandeClientCaches(queryClient)
  }
}

const nomDuFil = (y: Pick<FilYarn, 'reference' | 'coloris'>) => `${y.reference}${y.coloris ? ` - ${y.coloris}` : ''}`

function Chargement() {
  return (
    <div className="flex-1 flex items-center justify-center py-8">
      <Loader2 className="h-6 w-6 animate-spin text-accent" />
    </div>
  )
}

function ErreurChargement() {
  return (
    <div className="flex-1 flex items-center justify-center gap-2 py-8 text-sm text-destructive">
      <AlertCircle className="h-4 w-4" />Impossible de charger le fil de la ligne
    </div>
  )
}

function PasDeFil() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center py-8 text-muted-foreground">
      <BobineIcon className="h-8 w-8 mb-2 opacity-50" />
      <p className="text-sm font-medium">Pas de fil à prévoir</p>
      <p className="text-xs mt-1">La référence n’a pas de composition en fil.</p>
    </div>
  )
}

type Forme = 'lot' | 'commande'

const FORME = {
  lot: {
    titre: 'Fil réservé en stock',
    libelle: 'En stock',
    reserverTitre: 'Cliquer pour réserver ou retirer des lots en stock chez les tricoteurs',
    selecteur: 'Réserver du fil en stock',
    selecteurSous: 'lots chez les tricoteurs',
    rien: 'Rien à tricoter',
    figees: ['consommee'] as EtatReservation[],
  },
  commande: {
    titre: 'Fil réservé en commande',
    libelle: 'En commande',
    reserverTitre: 'Cliquer pour réserver ou retirer des parts de commandes de fil fournisseur',
    selecteur: 'Réserver du fil en commande',
    selecteurSous: 'commandes de fil fournisseur',
    rien: 'Rien à commander : le fil réservé en stock couvre la ligne',
    figees: ['liberee'] as EtatReservation[],
  },
} as const

/** What a yarn holds in stock (lots) and on order (supplier orders) for the line. */
const enStock = (y: FilYarn) => y.lots.reduce((s, l) => s + l.pour_ligne, 0)
const enCommande = (y: FilYarn) => y.commandes.reduce((s, c) => s + c.pour_ligne, 0)
const besoinTotal = (y: FilYarn) => y.calcul?.besoin ?? y.reserve_kg + y.manque_kg

/** One form of the line's yarn (Vincent 2026-10-28, « pour simplifier »): ONE block, per yarn its
 *  need of this form and what the line holds, with the sources held listed under it; a click on the
 *  block opens the selector to reserve or release (no « Réserver » button, no caption: the need's
 *  calculation is in the hover of its kg). */
function FilFormeZone({ commandeId, ligneId, soldee, forme }: { commandeId: number; ligneId: number; soldee: boolean; forme: Forme }) {
  const F = FORME[forme]
  const { data, isLoading, isError } = useFilLigne(commandeId, ligneId)
  const refresh = useRafraichirFil(commandeId, ligneId)
  const [selecteur, setSelecteur] = useState(false)

  const applicable = !!data?.applicable && (data.yarns?.length ?? 0) > 0
  const yarns = data?.yarns ?? []

  let contenu: ReactNode
  if (isLoading) contenu = <Chargement />
  else if (isError || !data) contenu = <ErreurChargement />
  else if (!applicable) contenu = <PasDeFil />
  else {
    const kgAffecte = data.kg_affecte ?? 0
    const tenues = yarns.flatMap(sourcesDuFil).filter((s) => s.kind === forme && s.pour_ligne > 0)
    // Yarn a knitting order took is carried by that order (bottom zone, its lots in the row's hover):
    // never listed again up here (Vincent 2026-10-29, top = what still waits, bottom = the orders).
    const figees = forme === 'lot' ? [] : (data.reservations ?? []).filter((r) => F.figees.includes(r.etat))
    const partiAuTricotage = forme === 'lot' && (data.reservations ?? []).some((r) => r.etat === 'consommee')
    // On order, the need is what the stock leaves: nothing to order when the lots cover it.
    const besoinDe = forme === 'lot' ? besoinTotal : (y: FilYarn) => Math.max(0, besoinTotal(y) - enStock(y))
    // Nothing of this form to hold (need 0, nothing held): one sober line in the same clickable block,
    // never « 0,0 / 0,0 kg » rows with a green tick that read as « all good » (Vincent 2026-10-28).
    const rienAReserver = yarns.every((y) => besoinDe(y) <= 0.05) && tenues.length === 0
    const nomFil = (refFil: number, coloriFil: number) => {
      const y = yarns.find((x) => x.IDref_fil === refFil && x.IDcolori_fil === coloriFil)
      return y ? nomDuFil(y) : ''
    }
    contenu = (
      <>
        <BesoinsFil yarns={yarns} data={data} kgAffecte={kgAffecte} libelle={F.libelle}
          tenu={forme === 'lot' ? enStock : enCommande} besoinDe={besoinDe}
          details={(y) => tenues.filter((t) => t.yarn === y)}
          vide={!rienAReserver ? undefined
            // No yarn need at all: the fini / écru already held covers the line, whatever the form.
            : partiAuTricotage && yarns.every((y) => besoinTotal(y) <= 0.05) ? 'Rien à tricoter : le fil réservé est parti dans la commande de tricotage'
            : yarns.every((y) => besoinTotal(y) <= 0.05) ? `${forme === 'lot' ? 'Rien à tricoter' : 'Rien à commander'} : la matière déjà réservée couvre la ligne`
            : F.rien}
          onClick={soldee ? undefined : () => setSelecteur(true)} titre={F.reserverTitre} />
        {figees.length > 0 && (
          <div className="mt-2 rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
            <table className="w-full text-xs">
              <tbody>
                <tr className="text-[10px] uppercase tracking-wide text-primary/80 bg-primary/10 border-b border-primary/10">
                  <td colSpan={3} className="px-2.5 py-1.5 font-semibold">{forme === 'lot' ? 'Déjà pris par le tricotage' : 'Libéré, non livré'}</td>
                </tr>
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
        )}
      </>
    )
  }

  return (
    <>
      <ZoneLigne kind="matiere" titre={F.titre}>{contenu}</ZoneLigne>
      {data && (
        <ReserverFilDialog
          open={selecteur}
          data={data}
          soldee={soldee}
          forme={forme}
          commandeId={commandeId}
          ligneId={ligneId}
          onDone={refresh}
          onClose={() => setSelecteur(false)}
        />
      )}
    </>
  )
}

/** The « Fil » tab: yarn reserved on supplier orders (top), the supplier orders (bottom). */
export function FilLigneTab({ commandeId, ligneId, soldee, planifier }: {
  commandeId: number
  ligneId: number
  soldee: boolean
  /** « Planifier » (the line's launch date): ordering the yarn can be the next step to hold */
  planifier?: ReactNode
}) {
  const { data } = useFilLigne(commandeId, ligneId)
  const commandes = (data?.yarns ?? []).flatMap((y) => y.commandes.filter((c) => c.pour_ligne > 0).map((c) => ({ yarn: y, c })))
  const aujourdhui = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-4 scrollbar-transparent">
      <FilFormeZone commandeId={commandeId} ligneId={ligneId} soldee={soldee} forme="commande" />
      <ZoneLigne kind="commandes" titre="Commandes de fil" actions={planifier ?? undefined}
        aide="Le fil se commande dans Fils › Commandes, puis se réserve sur la ligne (zone du haut)">
        {commandes.length === 0 ? (
          // Same empty state as the Tricotage / Ennoblissement order tables (SupplyTable).
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <BobineIcon className="h-8 w-8 mb-2 opacity-50" />
            <p className="text-sm font-medium">Aucune commande de fil en cours</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-x-auto scrollbar-transparent">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-primary/80 bg-primary/10 border-b border-primary/10">
                  <th className="px-2.5 py-1.5 font-semibold text-left whitespace-nowrap">Cde</th>
                  <th className="px-2.5 py-1.5 font-semibold text-left whitespace-nowrap">Fournisseur</th>
                  <th className="px-2.5 py-1.5 font-semibold text-left w-full">Fil</th>
                  <th className="px-2.5 py-1.5 font-semibold text-left whitespace-nowrap">Prévue</th>
                  <th className="px-2.5 py-1.5 font-semibold text-right whitespace-nowrap">Reçu</th>
                  <th className="px-2.5 py-1.5 font-semibold text-right whitespace-nowrap">Pour la ligne</th>
                </tr>
              </thead>
              <tbody>
                {commandes.map(({ yarn, c }) => {
                  // Late = the supplier's date has passed (or none given): chasing it is ours (red).
                  const enRetard = !c.date_livraison || c.date_livraison < aujourdhui
                  return (
                    <tr key={c.IDref_fil_commande} className="border-b border-border/40 last:border-0">
                      <td className="px-2.5 py-2 whitespace-nowrap tabular-nums font-medium">{c.IDcommande_fil}</td>
                      <td className="px-2.5 py-2 whitespace-nowrap">{c.fournisseur || '—'}</td>
                      <td className="px-2.5 py-2 whitespace-nowrap">{nomDuFil(yarn)}</td>
                      <td className={cn('px-2.5 py-2 whitespace-nowrap tabular-nums', enRetard ? 'text-red-600 font-medium' : 'text-muted-foreground')}
                        title={enRetard ? 'Date du fournisseur dépassée ou absente : le relancer' : undefined}>
                        {c.date_livraison ? formatHfsqlDate(c.date_livraison) : 'sans date'}
                      </td>
                      <td className="px-2.5 py-2 whitespace-nowrap text-right tabular-nums">
                        {fmtNum(c.recu, 1)} / {fmtNum(c.quantite, 1)} kg
                      </td>
                      <td className="px-2.5 py-2 whitespace-nowrap text-right tabular-nums font-bold">{fmtNum(c.pour_ligne, 1)} kg</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </ZoneLigne>
    </div>
  )
}

/** What each yarn of the line still needs — the whole line has its matter only when all are covered.
 *  `tenu` / `besoinDe` = what counts as held / needed for this form; `details` = the sources held, shown
 *  as a count only (Vincent 2026-10-28, « on simplifie tout »: which ones is a click away); `onClick`
 *  makes the whole block the way to reserve (hover: gold edge + pencil). */
function BesoinsFil({ yarns, data, kgAffecte, tenu, besoinDe, details, vide, onClick, titre, libelle = 'Réservé' }: {
  yarns: FilYarn[]
  data: FilPayload
  kgAffecte: number
  tenu?: (y: FilYarn) => number
  /** the need shown (on order: what the stock leaves); default the yarn's whole need */
  besoinDe?: (y: FilYarn) => number
  details?: (y: FilYarn) => SourceFil[]
  /** nothing of this form to hold: this one line instead of the yarns */
  vide?: string
  onClick?: () => void
  titre?: string
  libelle?: string
}) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      title={onClick ? titre : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
      className={cn(
        'group relative rounded-lg border border-border/60 bg-card shadow-sm divide-y divide-border/40 transition-colors',
        onClick && 'cursor-pointer hover:border-accent/60 hover:bg-accent/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {onClick && (
        <Pencil className="absolute -top-2 -right-2 h-5 w-5 p-1 rounded-full bg-accent text-accent-foreground shadow-sm opacity-0 group-hover:opacity-100 transition-opacity" />
      )}
      {vide && <p className="px-3 py-2.5 text-xs text-muted-foreground">{vide}</p>}
      {!vide && yarns.map((y) => {
        // The need (it stays the denominator when the line holds more, up to + 10 %).
        const aCouvrir = besoinDe ? besoinDe(y) : besoinTotal(y)
        const tient = tenu ? tenu(y) : y.reserve_kg
        const couvert = tenu ? tient >= aCouvrir - 0.05 : y.manque_kg <= 0.05
        // Still held while the line needs none of it (reserved before the launch took the whole
        // reservation, or the line's quantity went down): yarn blocked for nothing, to release.
        const enTrop = !!tenu && aCouvrir <= 0.05 && tient > 0.05
        const pct = Math.round(y.pourcentage * 10) / 10
        const sources = details?.(y) ?? []
        return (
          <div key={`${y.IDref_fil}:${y.IDcolori_fil}`} className="px-2.5 py-2 text-xs">
            <div className="flex items-center gap-2">
              <BobineIcon className="h-3.5 w-3.5 flex-shrink-0 text-accent" />
              <span className="min-w-0 truncate font-medium">{nomDuFil(y)}</span>
              <span className="flex-shrink-0 text-muted-foreground">
                · {fmtNum(pct, Number.isInteger(pct) ? 0 : 1)} %
                {sources.length > 0 && <> · {sources.length} {sources[0].kind === 'lot' ? `lot${sources.length > 1 ? 's' : ''}` : `commande${sources.length > 1 ? 's' : ''}`}</>}
              </span>
              <span title={enTrop ? 'La ligne n’a plus besoin de ce fil : cliquez pour le libérer' : undefined}
                className={cn('ml-auto flex-shrink-0 inline-flex items-center gap-1 tabular-nums',
                  enTrop ? 'text-amber-700 font-medium' : couvert ? 'text-green-700 font-medium' : 'text-muted-foreground')}>
                {couvert && !enTrop && <CheckCircle2 className="h-3.5 w-3.5" />}
                {libelle} {fmtNum(tient, 1)} /{' '}
                <BesoinFilTooltip yarn={y} data={data} kgAffecte={kgAffecte}>
                  <span className="underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 cursor-help">{fmtNum(aCouvrir, 1)} kg</span>
                </BesoinFilTooltip>
                {enTrop && <span> · en trop</span>}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** « Réserver » (Vincent 2026-10-28: « simple et naturel »): one group per yarn of the recipe, its
 *  lots (Tricotage tab) or supplier orders (Fil tab) below, a box to tick. Ticking takes what the
 *  yarn still lacks on that source, within what is free on it — no kilos to type; the kg stay editable
 *  on a ticked row for the rare case. What the line already holds starts ticked: unticking releases it,
 *  so the same screen reserves and corrects. One « Réserver » applies every change (the API's per-source
 *  route, releases first so the need + 10 % cap never refuses a move). §18.D banded. */
function ReserverFilDialog({ open, data, soldee, forme, commandeId, ligneId, onDone, onClose }: {
  open: boolean
  data: FilPayload
  soldee: boolean
  forme: Forme
  commandeId: number
  ligneId: number
  /** after applying (even partly): refresh the yarn */
  onDone: () => void
  onClose: () => void
}) {
  const F = FORME[forme]
  const yarns = data.yarns ?? []
  const sourcesDe = (y: FilYarn) => sourcesDuFil(y).filter((x) => x.kind === forme && (x.libre > 0.05 || x.pour_ligne > 0))
  const cle = (x: SourceFil) => `${x.kind}:${x.id}`
  // kg the line takes per source, as typed (string); absent = not ticked.
  const [choix, setChoix] = useState<Map<string, string>>(new Map())
  const [ouvertPour, setOuvertPour] = useState(false)
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)
  if (open !== ouvertPour) {
    setOuvertPour(open)
    if (open) {
      const m = new Map<string, string>()
      for (const y of yarns) for (const x of sourcesDe(y)) if (x.pour_ligne > 0) m.set(cle(x), fmtSaisie(x.pour_ligne))
      setChoix(m)
      setErreur(null)
    }
  }
  const kgDe = (x: SourceFil) => {
    const v = Number((choix.get(cle(x)) ?? '').replace(',', '.').replace(/\s/g, ''))
    return Number.isFinite(v) && v > 0 ? v : 0
  }
  // What the other form already holds counts as covered (in stock, what is on order; on order, the lots).
  const autreForme = (y: FilYarn) => (forme === 'lot' ? enCommande(y) : enStock(y))
  const cibleDe = (y: FilYarn) => Math.max(0, besoinTotal(y) - autreForme(y))
  const prisDe = (y: FilYarn, sauf?: string) => sourcesDe(y).filter((x) => cle(x) !== sauf && choix.has(cle(x))).reduce((s, x) => s + kgDe(x), 0)
  // The most this source may take: what is free on it (the line's own hold included) and the yarn's
  // need + 10 % less what the other sources and the other form hold.
  const maxDe = (y: FilYarn, x: SourceFil) => Math.max(0, Math.min(x.libre + x.pour_ligne, y.plafond_kg - autreForme(y) - prisDe(y, cle(x))))
  const cocher = (y: FilYarn, x: SourceFil) => setChoix((prev) => {
    const next = new Map(prev)
    if (next.has(cle(x))) next.delete(cle(x))
    else next.set(cle(x), fmtSaisie(Math.min(x.libre + x.pour_ligne, Math.max(0, cibleDe(y) - prisDe(y, cle(x))))))
    return next
  })
  const saisir = (x: SourceFil, v: string) => setChoix((prev) => new Map(prev).set(cle(x), v))

  const toutes = yarns.flatMap(sourcesDe)
  const changements = toutes
    .map((x) => ({ x, kg: choix.has(cle(x)) ? Math.round(kgDe(x) * 100) / 100 : 0 }))
    .filter(({ x, kg }) => Math.abs(kg - x.pour_ligne) > 0.005)
  const depassement = yarns.find((y) => sourcesDe(y).some((x) => choix.has(cle(x)) && kgDe(x) > maxDe(y, x) + 0.05))
  // A knitting order leaves from ONE knitter with all its yarn: warn, never block, when the lots ticked sit at several.
  const tricoteurs = forme === 'lot'
    ? [...new Set(toutes.filter((x) => choix.has(cle(x)) && kgDe(x) > 0).map((x) => x.groupe))]
    : []

  const appliquer = async () => {
    setEnCours(true)
    setErreur(null)
    try {
      // Releases first, then the takes: the cap is checked against what is already held.
      const ordre = [...changements].sort((a, b) => (a.kg - a.x.pour_ligne) - (b.kg - b.x.pour_ligne))
      for (const { x, kg } of ordre) {
        await apiFetch(`/commandes-client/${commandeId}/lignes/${ligneId}/fil/reservations/source`, {
          method: 'PUT',
          body: JSON.stringify(x.kind === 'lot' ? { IDstock_fil: x.id, kg } : { IDref_fil_commande: x.id, kg }),
        })
      }
      onDone()
      onClose()
    } catch (e) {
      setErreur((e as { body?: { message?: string } })?.body?.message ?? 'La réservation a échoué')
      onDone()
    } finally {
      setEnCours(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !enCours) onClose() }}>
      <DialogContent className="max-w-3xl w-[94vw] p-0 border-0 bg-primary overflow-hidden max-h-[85dvh] flex flex-col">
        <div className="flex-shrink-0 flex items-center gap-2.5 rounded-t-lg border-b-2 border-gold bg-primary px-4 py-2.5">
          <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
            <BobineIcon className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">{F.selecteur}</h2>
            <p className="text-xs text-white/70 truncate">
              {data.ecru_ref_label ? `${data.ecru_ref_label}${data.ecru_coloris_label ? ` /${data.ecru_coloris_label}` : ''}` : 'Tombé de métier'}
              {` · ${F.selecteurSous}`}
            </p>
          </div>
          <Button variant="ghost" size="icon" title="Fermer" disabled={enCours} onClick={onClose}
            className="h-8 w-8 flex-shrink-0 text-white/80 hover:bg-white/15 hover:text-white">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-100 p-4 space-y-4 scrollbar-transparent">
          {yarns.map((y) => {
            const sources = sourcesDe(y)
            const cible = cibleDe(y)
            const pris = prisDe(y)
            const couvert = pris >= cible - 0.05
            const reste = Math.max(0, cible - pris)
            const pct = Math.round(y.pourcentage * 10) / 10
            return (
              <section key={`${y.IDref_fil}:${y.IDcolori_fil}`} className="space-y-1.5">
                {/* The yarn is a discreet heading on the dialog's ground, the card holds only what is picked
                    (Vincent 2026-10-28): name + share left, one figure right that follows the ticks. */}
                <div className="flex items-baseline gap-2 px-1 text-[11px] uppercase tracking-wide">
                  <span className="min-w-0 truncate font-semibold text-muted-foreground">{nomDuFil(y)}</span>
                  <span className="flex-shrink-0 normal-case tracking-normal text-muted-foreground/80">· {fmtNum(pct, Number.isInteger(pct) ? 0 : 1)} %</span>
                  <span className={cn('ml-auto flex-shrink-0 normal-case tracking-normal tabular-nums inline-flex items-center gap-1',
                    couvert ? 'text-green-700 font-semibold' : 'text-muted-foreground')}>
                    {couvert
                      ? <><CheckCircle2 className="h-3.5 w-3.5" />{fmtNum(pris, 1)} kg</>
                      : pris > 0.05
                        ? <>{fmtNum(pris, 1)} kg sur {fmtNum(cible, 1)}</>
                        : <>{fmtNum(reste, 1)} kg à réserver</>}
                  </span>
                  {/* « Aucun » releases the yarn's sources at once; no « Tous »: ticking fills the missing kilos,
                      which lot is the person's choice (Vincent 2026-10-28). */}
                  {!soldee && sources.some((x) => choix.has(cle(x))) && (
                    <button type="button" disabled={enCours} title={`Décocher tout ${nomDuFil(y)}`}
                      onClick={() => setChoix((prev) => { const next = new Map(prev); for (const x of sources) next.delete(cle(x)); return next })}
                      className="flex-shrink-0 normal-case tracking-normal font-medium text-accent hover:underline disabled:opacity-50">
                      Aucun
                    </button>
                  )}
                </div>
                <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
                {sources.length === 0 ? (
                  <p className="px-3.5 py-2.5 text-xs text-muted-foreground italic">
                    {forme === 'lot' ? 'Aucun lot libre de ce fil chez un tricoteur.' : 'Aucune commande ouverte de ce fil.'}
                  </p>
                ) : (
                  <div className="divide-y divide-border/40">
                    {sources.map((x) => {
                      const coche = choix.has(cle(x))
                      // Once the yarn is covered, the other sources step back (they stay tickable to swap).
                      const efface = !coche && couvert
                      const trop = coche && kgDe(x) > maxDe(y, x) + 0.05
                      const ouvrable = !soldee && !enCours
                      return (
                        <div
                          key={cle(x)}
                          role="checkbox"
                          aria-checked={coche}
                          tabIndex={ouvrable ? 0 : -1}
                          onClick={ouvrable ? () => cocher(y, x) : undefined}
                          onKeyDown={ouvrable ? (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); cocher(y, x) } } : undefined}
                          className={cn(
                            'flex items-center gap-3 px-3.5 py-2.5 select-none transition-colors',
                            ouvrable && 'cursor-pointer',
                            coche ? 'bg-accent/[0.07]' : 'hover:bg-zinc-50',
                            efface && 'opacity-50',
                          )}
                        >
                          <span className={cn('h-5 w-5 flex-shrink-0 rounded-md flex items-center justify-center border-2 transition-colors',
                            coche ? 'bg-accent border-accent text-accent-foreground' : 'border-zinc-300 bg-white')}>
                            {coche && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium tabular-nums">{x.kind === 'lot' ? `Lot ${x.numero}` : `Commande N° ${x.numero}`}</p>
                            <p className="text-[11px] text-muted-foreground truncate">
                              {x.kind === 'lot'
                                ? `${x.groupe} · ${x.fournisseur || 'fournisseur inconnu'} · entré le ${x.date}`
                                : `${x.fournisseur || 'fournisseur inconnu'} · prévue ${x.date === 'sans date' ? 'sans date' : `le ${x.date}`}`}
                            </p>
                          </div>
                          {coche ? (
                            <span className="flex-shrink-0 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                              <span className="text-[11px] text-muted-foreground tabular-nums" title={x.totalTitre}>sur {fmtNum(x.libre + x.pour_ligne, 1)} kg</span>
                              <span className="relative inline-block">
                                <input
                                  type="text" inputMode="decimal" value={choix.get(cle(x)) ?? ''} disabled={enCours}
                                  onChange={(e) => saisir(x, e.target.value)}
                                  title={`Au plus ${fmtNum(maxDe(y, x), 1)} kg ici (besoin + 10 %)`}
                                  className={cn('w-24 h-8 pl-2 pr-7 text-sm text-right tabular-nums font-semibold rounded-md border bg-white focus:outline-none focus:ring-2 focus:ring-ring',
                                    trop ? 'border-destructive text-destructive' : 'border-input')}
                                />
                                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground pointer-events-none">kg</span>
                              </span>
                            </span>
                          ) : (
                            <span className="flex-shrink-0 text-right text-xs tabular-nums" title={x.totalTitre}>
                              <span className="font-semibold">{fmtNum(x.libre + x.pour_ligne, 1)} kg</span>
                              <span className="block text-[11px] text-muted-foreground">libres</span>
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
                </div>
              </section>
            )
          })}
          {forme === 'lot' && tricoteurs.length > 1 && (
            <p className="flex items-start gap-1.5 rounded-lg border-l-4 border-l-amber-500/60 border border-border/60 bg-card p-2.5 text-xs">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-amber-600" />
              Lots chez plusieurs tricoteurs ({tricoteurs.join(', ')}) : un tricotage part de chez un seul tricoteur, avec tout son fil.
            </p>
          )}
        </div>

        <div className="flex-shrink-0 rounded-b-lg border-t border-border/60 bg-zinc-200 px-4 py-3 space-y-2">
          {erreur && (
            <p className="flex items-start gap-1.5 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" /><span className="break-words">{erreur}</span>
            </p>
          )}
          {depassement && (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              {nomDuFil(depassement)} : au plus le besoin + 10 %, et ce qui est libre sur chaque {forme === 'lot' ? 'lot' : 'commande'}.
            </p>
          )}
          <div className="flex items-center gap-2">
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" onClick={onClose} disabled={enCours}>Annuler</Button>
              <Button onClick={appliquer} disabled={soldee || enCours || changements.length === 0 || !!depassement}>
                {enCours ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <BobineIcon className="h-3.5 w-3.5 mr-1.5" />}
                Réserver
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** kg as typed in the selector: « 110 », « 2,5 ». */
function fmtSaisie(kg: number): string {
  return String(Math.round(kg * 100) / 100).replace('.', ',')
}

/** Where the line's knitting can be launched: per knitter holding yarn reserved to the line, whether
 *  EVERY yarn of the recipe is reserved there (a knitting order goes out with all its yarn), and the
 *  yarns missing. API lib/lancement-tricotage.ts filNonReserve is the gate. */
export function tricoteursPrets(data: FilPayload | undefined): { magasin_id: number; magasin_nom: string; complet: boolean; manquants: string[] }[] {
  const yarns = (data?.yarns ?? []).filter((y) => y.pourcentage > 0)
  const lieux = new Map<number, string>()
  for (const y of yarns) for (const l of y.lots) if (l.pour_ligne > 0 && l.tricoteur && l.magasin_id > 0) lieux.set(l.magasin_id, l.magasin || 'Tricoteur')
  return [...lieux.entries()].map(([id, nom]) => {
    const manquants = yarns
      .filter((y) => !y.lots.some((l) => l.magasin_id === id && l.pour_ligne > 0))
      .map(nomDuFil)
    return { magasin_id: id, magasin_nom: nom, complet: manquants.length === 0, manquants }
  }).sort((a, b) => Number(b.complet) - Number(a.complet) || a.magasin_nom.localeCompare(b.magasin_nom, 'fr'))
}

/** Tricotage tab, top zone: the yarn reserved to the line IN STOCK at a knitter — the only matter a
 *  knitting order can go out with (API lib/lancement-tricotage.ts). */
export function FilEnStockZone({ commandeId, ligneId, soldee }: { commandeId: number; ligneId: number; soldee: boolean }) {
  return <FilFormeZone commandeId={commandeId} ligneId={ligneId} soldee={soldee} forme="lot" />
}

/** How a yarn's need is obtained (decision Vincent 2026-10-26): écru still to make ÷ (1 − freinte)
 *  × (1 + safety margin), rounded up to ARRONDI_FIL_KG (the kilo). Same look as the « Rouleaux estimés » tooltip. */
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
            <CalculRow label={(data.arrondi_kg ?? 1) === 1 ? "arrondi au kilo supérieur" : `arrondi aux ${fmtNum(data.arrondi_kg ?? 1, 0)} kg supérieurs`} value={`${fmtNum(c.besoin, 0)} kg`} strong />
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
