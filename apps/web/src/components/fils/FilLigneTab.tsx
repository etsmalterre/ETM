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
import { AlertCircle, Check, CheckCircle2, Loader2, Pencil, Save, X } from 'lucide-react'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { KnitIcon } from '@/components/icons/KnitIcon'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Tooltip } from '@/components/ui/tooltip'
import { ZoneLigne } from '@/components/commandes/ZonesLigne'
import { AffecteGauge, ChoixQuantite, RepartitionCommande, COULEURS_AUTRES_LIGNES, type PartCommande } from '@/components/commandes/ReservationParts'
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
  /** what the other client lines hold on it (still waiting): the reservation dialog's répartition */
  autres_reservations?: { client_nom: string | null; commande_numero: number | null; article: string | null; kg: number }[]
}

/** The client line's own gauge, for the reservation dialog's footer: what its other stages already
 *  cover (shipped, ready, at the dyer, being knitted) and its quantity, in the line's unit. */
export interface JaugeLigne {
  horsFil: number
  cible: number
  uniteLabel: string
  /** a line in Ml (its yarn counts through the rendement) */
  metrage: boolean
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
  /** the line's yarn of this lot already in knitting orders of its écru (it receives the pieces) */
  en_tricotage?: number
  /** what the line can add with nobody losing: the lot's free yarn + what those orders knit for the stock */
  sans_arbitrage?: number
  /** what an arbitration can add: other lines' shares of those orders, and the orders of another écru,
   *  which then knit less (API lib/engagement-tricotage.ts) */
  prenable?: number
  /** who else holds yarn of the lot: client lines, and knitting « pour le stock » (the gauge) */
  repartition?: PartLot[]
  /** the knitting orders holding yarn of the lot */
  engagements?: EngagementLot[]
}

interface EngagementLot { commande: number; article: string; kg: number; meme_ecru: boolean }
interface PartLot { type: 'ligne' | 'stock'; client_nom: string | null; commande_numero: number | null; article: string | null; kg: number }

/** What an arbitration costs (API 409 `arbitrage_requis`): each knitting order knits less, some client
 *  lines lose a share of it. */
interface PlanArbitrage {
  libre: number
  kg: number
  effets: {
    commande: number
    article: string
    de: number
    a: number
    fil: number
    stock: number
    lignes: { client_nom: string | null; commande_numero: number | null; article: string | null; delai: string | null; perd: number }[]
    /** the order knits as much: the yarn changes hands between two client lines of it */
    interne?: boolean
  }[]
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
  /** the yarn knitting orders of the line's écru hold, lot by lot: reserved there, the line receives
   *  the pieces (API lib/engagement-tricotage.ts) */
  tricotages?: {
    IDstock_fil: number
    lot: string
    IDligne_commande_sous_traitant: number
    commande: number
    /** what the order knits for the stock, in yarn: free for the line */
    libre: number
    pour_ligne: number
    /** what other client lines hold there: theirs unless an arbitration is validated */
    autres: number
    /** the line's share of that order (écru kg) and the pieces of it already received */
    part_ecru?: number
    recu_ecru?: number
  }[]
  /** yarn the line holds in a knitting order that makes no share yet (another yarn is missing there) */
  sans_part_kg?: number
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
  /** what an arbitration can add on a lot (0 on a supplier order) */
  prenable: number
  engagements: EngagementLot[]
  /** inside pour_ligne: the line's yarn of the lot already in knitting orders (not « en stock ») */
  enTricotage: number
  /** the lot's free yarn, and who else holds yarn of it (the gauge) */
  libreLot: number
  repartition: PartLot[]
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
      // One row per lot: its yarn in stock and in knitting orders of the line's écru together.
      libre: l.sans_arbitrage ?? l.dispo,
      pour_ligne: l.pour_ligne + (l.en_tricotage ?? 0),
      prenable: l.prenable ?? 0,
      engagements: l.engagements ?? [],
      enTricotage: l.en_tricotage ?? 0,
      libreLot: l.dispo,
      repartition: l.repartition ?? [],
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
        prenable: 0,
        engagements: [],
        enTricotage: 0,
        libreLot: c.libre,
        repartition: [],
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
    // In stock or already in a knitting order: the line's yarn, wherever it is (Vincent 2026-11-13).
    titre: 'Fil réservé',
    libelle: 'En stock',
    reserverTitre: 'Cliquer pour réserver ou retirer des lots en stock chez les tricoteurs',
    selecteur: 'Réserver du fil',
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
    // The zone shows the line's matter for as long as it is yarn (Vincent 2026-11-13): a knitting
    // order only transforms it. The yarn the line holds in an order stays listed here, « en
    // tricotage », and goes down as the pieces are delivered (they then show as tombé de métier).
    const figees = forme === 'lot' ? [] : (data.reservations ?? []).filter((r) => F.figees.includes(r.etat))
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
        <BesoinsFil yarns={yarns} data={data} kgAffecte={kgAffecte}
          tenu={forme === 'lot' ? enStock : enCommande} besoinDe={besoinDe}
          details={(y) => tenues.filter((t) => t.yarn === y)}
          vide={!rienAReserver ? undefined
            // No yarn need at all: the fini / écru already held covers the line, whatever the form.
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

/** The « Fil » tab (Vincent 2026-10-30): yarn is reserved on supplier ORDERS, not on physical matter,
 *  so matter and orders are one list. Per yarn of the recipe a band with what the line holds on order
 *  against its need (what the stock leaves), then every supplier order of that yarn the line can use,
 *  first to arrive on top (« Pour la ligne » shows which ones it uses). A click on a row opens the
 *  order's reservation dialog (Vincent 2026-11-13, same window as a knitting order's): how much the
 *  line takes there, who else holds yarn on that order, and the line's own gauge. */
export function FilLigneTab({ commandeId, ligneId, soldee, planifier, clientNom, articleLabel, jauge }: {
  commandeId: number
  ligneId: number
  soldee: boolean
  /** « Planifier » (the line's launch date): ordering the yarn can be the next step to hold */
  planifier?: ReactNode
  /** the client of the order, and the line's « REF - coloris » (the reservation dialog) */
  clientNom?: string
  articleLabel?: string | null
  jauge?: JaugeLigne
}) {
  const { data, isLoading, isError } = useFilLigne(commandeId, ligneId)
  const refresh = useRafraichirFil(commandeId, ligneId)
  // The supplier order line whose reservation dialog is open.
  const [cible, setCible] = useState<number | null>(null)
  const aujourdhui = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const yarns = data?.yarns ?? []
  const applicable = !!data?.applicable && yarns.length > 0
  const yarnCible = cible === null ? undefined : yarns.find((y) => y.commandes.some((c) => c.IDref_fil_commande === cible))
  const commandeCible = yarnCible?.commandes.find((c) => c.IDref_fil_commande === cible)

  // On order, the need is what the stock leaves (the Tricotage tab holds the lots).
  const besoinCommande = (y: FilYarn) => Math.max(0, besoinTotal(y) - enStock(y))

  const liberees = (data?.reservations ?? []).filter((r) => r.etat === 'liberee')

  let contenu: ReactNode
  if (isLoading) contenu = <Chargement />
  else if (isError || !data) contenu = <ErreurChargement />
  else if (!applicable) contenu = <PasDeFil />
  else contenu = (
    <>
      {/* One table per yarn of the recipe (Vincent 2026-10-30): the yarn and what the line holds of it
          as the table's title, its usable supplier orders below. */}
      <div className="space-y-3">
          {yarns.map((y) => {
            const besoin = besoinCommande(y)
            const tient = enCommande(y)
            const couvert = tient >= besoin - 0.05
            const enTrop = besoin <= 0.05 && tient > 0.05
            const pct = Math.round(y.pourcentage * 10) / 10
            const lignes = y.commandes
              .filter((c) => c.libre > 0.05 || c.pour_ligne > 0)
              // First to arrive on top, rows never move on a click (Vincent 2026-10-30); « sans date » last.
              .sort((a, b) => (a.date_livraison ?? '99999999').localeCompare(b.date_livraison ?? '99999999')
                || a.IDcommande_fil - b.IDcommande_fil)
            return (
              <section key={`${y.IDref_fil}:${y.IDcolori_fil}`} className="space-y-1.5">
                    <div className="flex items-center gap-2 px-1 text-xs">
                      <BobineIcon className="h-3.5 w-3.5 flex-shrink-0 text-accent" />
                      <span className="min-w-0 truncate font-semibold">{nomDuFil(y)}</span>
                      <span className="flex-shrink-0 text-muted-foreground">· {fmtNum(pct, Number.isInteger(pct) ? 0 : 1)} %</span>
                      <span className={cn('ml-auto flex-shrink-0 inline-flex items-center gap-1 tabular-nums',
                        enTrop ? 'text-amber-700 font-medium' : couvert ? 'text-green-700 font-medium' : 'text-muted-foreground')}
                        title={enTrop ? 'La ligne n’a plus besoin de ce fil en commande : cliquez la commande pour le libérer' : undefined}>
                        {couvert && !enTrop && <CheckCircle2 className="h-3.5 w-3.5" />}
                        {besoin <= 0.05 && tient <= 0.05 ? 'Couvert par le stock'
                          : <>En commande {fmtNum(tient, 1)} /{' '}
                            <BesoinFilTooltip yarn={y} data={data} kgAffecte={data.kg_affecte ?? 0}>
                              <span className="underline decoration-dotted underline-offset-2 cursor-help">{fmtNum(besoin, 1)} kg</span>
                            </BesoinFilTooltip>
                            {enTrop && ' · en trop'}</>}
                      </span>
                    </div>
                <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-x-auto scrollbar-transparent">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-primary/80 bg-primary/10 border-b border-primary/10">
                      <th className="px-2.5 py-1.5 font-semibold text-left whitespace-nowrap">Cde</th>
                      <th className="px-2.5 py-1.5 font-semibold text-left w-full">Fournisseur</th>
                      <th className="px-2.5 py-1.5 font-semibold text-left whitespace-nowrap">Prévue</th>
                      <th className="px-2.5 py-1.5 font-semibold text-right whitespace-nowrap">Libre</th>
                      <th className="px-2.5 py-1.5 font-semibold text-right whitespace-nowrap">Pour la ligne</th>
                    </tr>
                  </thead>
                  <tbody>
                {lignes.length === 0 ? (
                  <tr className="border-b border-border/40 last:border-0">
                    <td colSpan={5} className="px-2.5 py-2.5 text-muted-foreground italic">
                      Aucune commande en cours de ce fil : commandez-le dans Fils › Commandes.
                    </td>
                  </tr>
                ) : lignes.map((c) => {
                  const utilisee = c.pour_ligne > 0
                  const cliquable = !soldee
                  // Late = the supplier's date has passed (or none given): chasing it is ours, but only
                  // when the line waits on it (red = a Malterre action).
                  const enRetard = utilisee && (!c.date_livraison || c.date_livraison < aujourdhui)
                  const titre = soldee ? undefined
                    : utilisee ? 'Cliquer pour modifier ou libérer la réservation de la ligne sur cette commande'
                    : 'Cliquer pour réserver du fil de cette commande pour la ligne'
                  return (
                    <tr key={c.IDref_fil_commande} title={titre}
                      role={cliquable ? 'button' : undefined} tabIndex={cliquable ? 0 : undefined}
                      onClick={cliquable ? () => setCible(c.IDref_fil_commande) : undefined}
                      onKeyDown={cliquable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCible(c.IDref_fil_commande) } } : undefined}
                      className={cn('border-b border-border/40 last:border-0 select-none transition-colors',
                        utilisee ? 'bg-accent/[0.07]' : 'text-muted-foreground',
                        cliquable && 'cursor-pointer hover:bg-accent/10')}>
                      <td className={cn('px-2.5 py-2 whitespace-nowrap tabular-nums', utilisee && 'font-medium text-foreground')}>{c.IDcommande_fil}</td>
                      <td className="px-2.5 py-2 whitespace-nowrap">{c.fournisseur || '—'}</td>
                      <td className={cn('px-2.5 py-2 whitespace-nowrap tabular-nums', enRetard && 'text-red-600 font-medium')}
                        title={enRetard ? 'Date du fournisseur dépassée ou absente : le relancer' : undefined}>
                        {c.date_livraison ? formatHfsqlDate(c.date_livraison) : 'sans date'}
                      </td>
                      <td className="px-2.5 py-2 whitespace-nowrap text-right tabular-nums"
                        title={`${fmtNum(c.quantite, 1)} kg commandés, ${fmtNum(c.recu, 1)} kg reçus`}>
                        {fmtNum(c.libre, 1)} kg
                      </td>
                      <td className={cn('px-2.5 py-2 whitespace-nowrap text-right tabular-nums', utilisee && 'font-bold text-foreground')}>
                        {utilisee ? `${fmtNum(c.pour_ligne, 1)} kg` : '—'}
                      </td>
                    </tr>
                  )
                })}
                  </tbody>
                </table>
                </div>
              </section>
            )
          })}
      </div>
      {liberees.length > 0 && (
        <div className="mt-2 rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
          <table className="w-full text-xs">
            <tbody>
              <tr className="text-[10px] uppercase tracking-wide text-primary/80 bg-primary/10 border-b border-primary/10">
                <td colSpan={3} className="px-2.5 py-1.5 font-semibold">Libéré, non livré</td>
              </tr>
              {liberees.map((r) => {
                const meta = ETAT_FIGE[r.etat]!
                const Icon = meta.icon
                const y = yarns.find((x) => x.IDref_fil === r.IDref_fil && x.IDcolori_fil === r.IDcolori_fil)
                return (
                  <tr key={r.id} className="border-b border-border/40 last:border-0 text-muted-foreground">
                    <td className="px-2.5 py-2 whitespace-nowrap"><span className="inline-flex items-center gap-1.5"><Icon className="h-3.5 w-3.5" />{meta.label(r)}</span></td>
                    <td className="px-2.5 py-2 w-full truncate">{y ? nomDuFil(y) : ''}</td>
                    <td className="px-2.5 py-2 whitespace-nowrap text-right tabular-nums line-through">{fmtNum(r.kg, 1)} kg</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )

  return (
    <div className="flex-1 overflow-y-auto p-3 scrollbar-transparent">
      <ZoneLigne kind="commandes" seule titre="Commandes de fil" actions={planifier ?? undefined}
        aide="Le fil se commande dans Fils › Commandes ; un clic sur une commande ouvre sa réservation pour la ligne">
        {contenu}
      </ZoneLigne>
      {data && yarnCible && commandeCible && (
        <ReservationCommandeFilDialog
          key={commandeCible.IDref_fil_commande}
          data={data}
          yarn={yarnCible}
          commande={commandeCible}
          commandeId={commandeId}
          ligneId={ligneId}
          clientNom={clientNom}
          articleLabel={articleLabel}
          jauge={jauge}
          onDone={refresh}
          onClose={() => setCible(null)}
        />
      )}
    </div>
  )
}

/** The reserved yarn as the écru it lets the line make, in the line's unit: the scarcest yarn of the
 *  recipe decides, after the freinte de tricotage — the rule of the order's gauge (« Fil réservé »,
 *  API filReserveParLigne), replayed here to project a reservation before it is saved. */
function filEnUniteLigne(data: FilPayload, metrage: boolean, reserveDe: (y: FilYarn) => number): number {
  let kg = Infinity
  for (const y of data.yarns ?? []) {
    if (!(y.pourcentage > 0)) continue
    const r = reserveDe(y)
    // + the centime a reservation of the rounded need may lack (as the API does)
    kg = Math.min(kg, r > 0 ? (r + 0.01) / (y.pourcentage / 100) : 0)
  }
  if (!Number.isFinite(kg) || !(kg > 0)) return 0
  kg *= 1 - (data.freinte_tricotage?.taux ?? 0)
  return metrage ? kg * (data.rendement ?? 0) : kg
}

type ModeReservation = 'besoin' | 'tout' | 'exacte' | 'rien'

/** « Réservation — Commande de fil N° … » (Vincent 2026-11-13): the Fil tab's row dialog, the twin of a
 *  knitting order's. 1 · how much the line takes on this supplier order: its need (what its other
 *  sources leave), everything free there when that stays within need + 10 %, another quantity, or
 *  nothing (release). 2 · the order's répartition: this line, the other client lines waiting on it,
 *  what is free. Footer: the client line's own gauge, with the yarn this choice adds. Saved through
 *  the API's per-source route (same caps). */
function ReservationCommandeFilDialog({ data, yarn, commande: c, commandeId, ligneId, clientNom, articleLabel, jauge, onDone, onClose }: {
  data: FilPayload
  yarn: FilYarn
  commande: CommandeFilLigne
  commandeId: number
  ligneId: number
  clientNom?: string
  articleLabel?: string | null
  jauge?: JaugeLigne
  /** after saving (or a refusal): refresh the yarn */
  onDone: () => void
  onClose: () => void
}) {
  const r2 = (x: number) => Math.round(x * 100) / 100
  const tient = c.pour_ligne
  const autres = c.autres_reservations ?? []
  // What the line may take here: what is free on the order, its own hold included.
  const dispoIci = r2(c.libre + tient)
  // On order, the need is what the stock leaves; here, what the other supplier orders leave of it.
  const besoinIci = r2(Math.max(0, besoinTotal(yarn) - enStock(yarn) - (enCommande(yarn) - tient)))
  // Never beyond the yarn's need + 10 %, every source together (API plafondReservation).
  const maxIci = r2(Math.max(0, Math.min(dispoIci, yarn.plafond_kg - (yarn.reserve_kg - tient))))
  const besoinPossible = besoinIci > 0.05 && besoinIci <= dispoIci + 0.005
  // Everything free there: when it is less than the need, or a little more (a whole 660 kg order for 650 kg).
  const toutPossible = dispoIci > 0.05 && dispoIci <= maxIci + 0.005 && Math.abs(dispoIci - besoinIci) > 0.005
  const libelleTout = autres.length > 0 || c.recu > 0.005 ? 'Tout le reste' : 'Toute la commande'

  const [mode, setMode] = useState<ModeReservation>(() => {
    if (tient > 0) {
      if (besoinPossible && Math.abs(tient - besoinIci) < 0.005) return 'besoin'
      if (toutPossible && Math.abs(tient - dispoIci) < 0.005) return 'tout'
      return 'exacte'
    }
    return besoinPossible ? 'besoin' : toutPossible ? 'tout' : 'exacte'
  })
  const [valueStr, setValueStr] = useState(() => (tient > 0 ? fmtSaisie(tient) : ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = parseFloat(valueStr.replace(',', '.').replace(/\s/g, ''))
  const saisi = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  // What the line holds on this order once saved, kg.
  const value = r2(mode === 'besoin' ? besoinIci : mode === 'tout' ? dispoIci : mode === 'rien' ? 0 : saisi)
  const over = mode === 'exacte' && saisi > maxIci + 0.005
  const sansChangement = Math.abs(value - tient) <= 0.005
  const canSubmit = !busy && !over && !sansChangement
  // Why « Enregistrer » is greyed, on its hover: a disabled button with no reason reads as broken.
  const pourquoiGrise = busy ? null
    : over ? 'La quantité dépasse le maximum pour la ligne sur cette commande.'
    : sansChangement ? (tient > 0 ? 'Déjà enregistré : changez la quantité.' : 'Saisissez une quantité.')
    : null

  // The order's répartition, on what is still to receive: this line, the other lines, what is free.
  const parts: PartCommande[] = [
    { cle: 'moi', nom: 'Cette ligne', article: articleLabel ?? '', kg: value, couleur: 'bg-accent', fort: true },
    ...autres.map((a, i) => ({
      cle: `a${i}`,
      nom: a.client_nom ?? 'Autre client',
      detail: a.commande_numero ? `N° ${a.commande_numero}` : '',
      article: a.article ?? '',
      kg: a.kg,
      couleur: COULEURS_AUTRES_LIGNES[i % COULEURS_AUTRES_LIGNES.length],
    })),
  ]
  const libre = r2(Math.max(0, c.reste - parts.reduce((s, p) => s + Math.max(0, p.kg), 0)))

  // The client line's gauge with this choice: its other stages + the yarn reserved, as écru.
  const projete = jauge
    ? jauge.horsFil + filEnUniteLigne(data, jauge.metrage, (y) => (y === yarn ? y.reserve_kg + (value - tient) : y.reserve_kg))
    : 0

  const enregistrer = async () => {
    if (!canSubmit) return
    setError(null)
    setBusy(true)
    try {
      await apiFetch(`/commandes-client/${commandeId}/lignes/${ligneId}/fil/reservations/source`, {
        method: 'PUT',
        body: JSON.stringify({ IDref_fil_commande: c.IDref_fil_commande, kg: value }),
      })
      onDone()
      onClose()
    } catch (e) {
      setError((e as { body?: { message?: string } })?.body?.message ?? 'La réservation a échoué')
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent className="max-w-lg p-0 border-0 bg-primary overflow-hidden flex flex-col">
        <div className="flex-shrink-0 flex items-center gap-2.5 rounded-t-lg border-b-2 border-gold bg-primary px-4 py-2.5">
          <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
            <BobineIcon className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">
              Réservation — Commande de fil N° {c.IDcommande_fil}
            </h2>
            <p className="text-xs text-white/70 truncate">
              {c.fournisseur || 'Fournisseur'} · {c.date_livraison ? formatHfsqlDate(c.date_livraison) : 'sans date'} · {fmtNum(c.quantite, 1)} kg de {nomDuFil(yarn)}
            </p>
          </div>
          <Button variant="ghost" size="icon" title="Fermer" disabled={busy} onClick={onClose}
            className="h-8 w-8 flex-shrink-0 text-white/80 hover:bg-white/15 hover:text-white">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-4 bg-zinc-100 space-y-3">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Réserver pour {clientNom ?? 'cette ligne'}</p>
            <ChoixQuantite
              mode={mode}
              onChange={setMode}
              disabled={busy}
              options={[
                ...(besoinPossible ? [{ cle: 'besoin' as const, label: 'Besoin de la ligne', detail: `${fmtNum(besoinIci, 1)} kg` }] : []),
                ...(toutPossible ? [{ cle: 'tout' as const, label: libelleTout, detail: `${fmtNum(dispoIci, 1)} kg` }] : []),
                { cle: 'exacte' as const, label: 'Autre quantité', detail: 'à saisir' },
                // the words of a knitting order (Vincent 2026-11-13): what no line reserves is « stock », never « libre »
                ...(tient > 0 ? [{ cle: 'rien' as const, label: 'Ne rien réserver', detail: '0 kg' }] : []),
              ]}
            />
            {mode === 'exacte' && (
              <div className="pt-1 space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Quantité réservée</label>
                <div className="relative">
                  <input
                    type="text" inputMode="decimal" value={valueStr} disabled={busy} placeholder="0" autoFocus
                    onChange={(e) => setValueStr(e.target.value)}
                    // what the line already holds is pre-filled: selected, so typing replaces it
                    onFocus={(e) => e.target.select()}
                    className="w-full h-10 pl-3 pr-10 text-base font-semibold text-right tabular-nums rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">kg</span>
                </div>
                {/* the most the line may take here: said when the need + 10 % cap lowers it below what is
                    free on the order (already in the répartition), or once the typed quantity goes past it */}
                {(over || maxIci < dispoIci - 0.005) && (
                  <div className={cn('flex items-baseline justify-between gap-2 text-[11px] tabular-nums', over ? 'text-destructive font-medium' : 'text-muted-foreground')}
                    title="Au plus le besoin de la ligne en ce fil + 10 %, et ce qu’aucune autre ligne ne réserve sur la commande">
                    <span>Maximum pour la ligne sur cette commande</span>
                    <span>{fmtNum(maxIci, 1)} kg</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <RepartitionCommande
            titre={c.recu > 0.005 ? `Répartition du fil encore à recevoir · ${fmtNum(c.recu, 1)} kg déjà reçus` : 'Répartition de la commande de fil'}
            total={c.reste}
            parts={parts}
            reste={{ nom: 'Stock', kg: libre }}
          />
        </div>

        <div className="flex-shrink-0 rounded-b-lg px-4 py-3 border-t border-border/60 bg-zinc-200">
          {!!error && (
            <div className="mb-2 flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /><span className="break-words">{error}</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            {jauge
              ? <AffecteGauge projected={projete} target={jauge.cible} uniteLabel={jauge.uniteLabel} libelle="réservé pour la ligne" />
              : <div className="flex-1" />}
            <div className="flex gap-2 flex-shrink-0">
              <Button variant="outline" onClick={onClose} disabled={busy}>Annuler</Button>
              {/* the span carries the reason: a disabled button shows no tooltip */}
              <span title={pourquoiGrise ?? undefined}>
                <Button onClick={enregistrer} disabled={!canSubmit}>
                  {busy
                    ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Enregistrement…</>
                    : <><Save className="h-3.5 w-3.5 mr-1.5" />Enregistrer</>}
                </Button>
              </span>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The line's reserved yarn, as simply as it can be said (Vincent 2026-11-13): one row per yarn lot
 *  the line holds — in stock or already in a knitting order, the same matter — with its kg, and at the
 *  right what that yarn makes, in the line's unit (« potentiel »: the scarcest yarn of the recipe
 *  decides, after the freinte). A yarn still to reserve adds one muted row with what is missing (the
 *  calculation in its hover). `onClick` makes the whole block the way to reserve (hover: gold edge +
 *  pencil); `vide` = nothing to hold: one sober line. */
function BesoinsFil({ yarns, data, kgAffecte, tenu, besoinDe, details, vide, onClick, titre }: {
  yarns: FilYarn[]
  data: FilPayload
  kgAffecte: number
  tenu?: (y: FilYarn) => number
  /** the need shown; default the yarn's whole need */
  besoinDe?: (y: FilYarn) => number
  /** the lots the line holds (their yarn in stock and in knitting together) */
  details?: (y: FilYarn) => SourceFil[]
  /** nothing to hold: this one line instead of the yarns */
  vide?: string
  onClick?: () => void
  titre?: string
}) {
  const lotsDe = (y: FilYarn) => details?.(y) ?? []
  // A fini line reads in Ml (its rendement), a tombé de métier in kg of écru.
  const metrage = (data.rendement ?? 0) > 0
  const potentiel = filEnUniteLigne(data, metrage, (y) => lotsDe(y).reduce((x, l) => x + l.pour_ligne, 0))
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      title={onClick ? titre : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
      className={cn(
        'group relative flex rounded-lg border border-border/60 bg-card shadow-sm transition-colors',
        onClick && 'cursor-pointer hover:border-accent/60 hover:bg-accent/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {onClick && (
        <Pencil className="absolute -top-2 -right-2 h-5 w-5 p-1 rounded-full bg-accent text-accent-foreground shadow-sm opacity-0 group-hover:opacity-100 transition-opacity" />
      )}
      {vide && <p className="px-3 py-2.5 text-xs text-muted-foreground">{vide}</p>}
      {!vide && (
        <div className="min-w-0 flex-1 divide-y divide-border/40">
          {yarns.flatMap((y) => {
            const aCouvrir = besoinDe ? besoinDe(y) : besoinTotal(y)
            const tient = tenu ? tenu(y) : y.reserve_kg
            const reste = Math.max(0, aCouvrir - tient)
            // Held in stock while the line needs none of it: yarn blocked for nothing, to release.
            const enTrop = !!tenu && aCouvrir <= 0.05 && tient > 0.05
            const pct = Math.round(y.pourcentage * 10) / 10
            const nom = <><span className="min-w-0 truncate font-medium">{nomDuFil(y)}</span>
              <span className="flex-shrink-0 text-muted-foreground">· {fmtNum(pct, Number.isInteger(pct) ? 0 : 1)} %</span></>
            const cle = `${y.IDref_fil}:${y.IDcolori_fil}`
            return [
              ...lotsDe(y).map((l) => (
                <div key={`${cle}:${l.kind}:${l.id}`} className="flex items-center gap-2 px-2.5 py-2 text-xs">
                  <BobineIcon className="h-3.5 w-3.5 flex-shrink-0 text-accent" />
                  {nom}
                  <span className="flex-shrink-0 text-muted-foreground">· lot {l.numero}</span>
                  <span title={enTrop && l.pour_ligne - l.enTricotage > 0.05 ? 'La ligne n’a plus besoin de ce fil : cliquez pour le libérer' : undefined}
                    className={cn('ml-auto flex-shrink-0 tabular-nums font-medium', enTrop && l.pour_ligne - l.enTricotage > 0.05 && 'text-amber-700')}>
                    {fmtNum(l.pour_ligne, 1)} kg{enTrop && l.pour_ligne - l.enTricotage > 0.05 ? ' · en trop' : ''}
                  </span>
                </div>
              )),
              ...(reste > 0.05 ? [(
                <div key={`${cle}:reste`} className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
                  <BobineIcon className="h-3.5 w-3.5 flex-shrink-0 opacity-50" />
                  {nom}
                  <span className="ml-auto flex-shrink-0 tabular-nums">
                    reste à réserver{' '}
                    <BesoinFilTooltip yarn={y} data={data} kgAffecte={kgAffecte}>
                      <span className="underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 cursor-help">{fmtNum(reste, 1)} kg</span>
                    </BesoinFilTooltip>
                  </span>
                </div>
              )] : []),
            ]
          })}
        </div>
      )}
      {!vide && potentiel > 0.05 && (
        <div className="flex-shrink-0 flex flex-col items-end justify-center border-l border-border/40 px-3.5 py-2"
          title="Ce que le fil réservé permet de faire : le fil le plus rare de la recette décide, freinte de tricotage déduite">
          <span className="text-base font-bold tabular-nums leading-tight">{fmtNum(potentiel, 1)} {metrage ? 'Ml' : 'kg'}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">potentiel</span>
        </div>
      )}
    </div>
  )
}

/** « Réserver » (Vincent 2026-10-28: « simple et naturel »): one group per yarn of the recipe, its
 *  lots (Tricotage tab) or supplier orders (Fil tab) below, a box to tick. Ticking takes what the
 *  yarn still lacks on that source, within what is free on it — no kilos to type; the kg stay editable
 *  on a ticked row for the rare case. What the line already holds starts ticked: unticking releases it,
 *  so the same screen reserves and corrects. One « Réserver » applies every change (the API's per-source
 *  route, releases first so the need + 10 % cap never refuses a move). §18.D banded.
 *
 *  A lot whose yarn is held by a knitting order of another écru is listed too (Vincent 2026-11-13):
 *  taking more than it has free makes that order knit less. Nothing is written before the person has
 *  seen who loses what and validated it (API 409 `arbitrage_requis`, then the same call with
 *  `arbitrage: true`). */
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
  const sourcesDe = (y: FilYarn) => sourcesDuFil(y).filter((x) => x.kind === forme && (x.libre > 0.05 || x.pour_ligne > 0 || x.prenable > 0.05))
  const cle = (x: SourceFil) => `${x.kind}:${x.id}`
  // What a source can give the line: what is free on it, its own hold, and what knitting orders can give back.
  const prenableDe = (x: SourceFil) => x.libre + x.pour_ligne + x.prenable
  // The changes still to apply once an arbitration is validated, and what it costs.
  const [arbitrage, setArbitrage] = useState<{ ordre: { x: SourceFil; kg: number }[]; plan: PlanArbitrage } | null>(null)
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
      setArbitrage(null)
    }
  }
  const kgDe = (x: SourceFil) => {
    const v = Number((choix.get(cle(x)) ?? '').replace(',', '.').replace(/\s/g, ''))
    return Number.isFinite(v) && v > 0 ? v : 0
  }
  // What the other form already holds counts as covered (in stock, what is on order; on order, the lots).
  const autreForme = (y: FilYarn) => (forme === 'lot' ? enCommande(y) : enStock(y))
  const cibleDe = (y: FilYarn) => Math.max(0, besoinTotal(y) - autreForme(y))
  // Yarn held in a knitting order is already taken off the need by its share: only what a tick adds
  // (or releases) there counts, plus the yarn held there that makes no share yet.
  const prisDe = (y: FilYarn, sauf?: string) => (y.sans_part_kg ?? 0) + sourcesDe(y).filter((x) => cle(x) !== sauf).reduce((s, x) =>
    s + (choix.has(cle(x)) ? kgDe(x) : 0) - x.enTricotage, 0)
  // The most this source may take: what is free on it (the line's own hold included) and the yarn's
  // need + 10 % less what the other sources and the other form hold.
  const maxDe = (y: FilYarn, x: SourceFil) => {
    const place = y.plafond_kg - autreForme(y) - prisDe(y, cle(x))
    // The line keeps what it holds in knitting; the cap bounds the rest.
    return x.enTricotage + Math.max(0, Math.min(prenableDe(x) - x.enTricotage, place))
  }
  const cocher = (y: FilYarn, x: SourceFil) => setChoix((prev) => {
    const next = new Map(prev)
    if (next.has(cle(x))) next.delete(cle(x))
    else {
      const manque = Math.max(0, cibleDe(y) - prisDe(y, cle(x)))
      next.set(cle(x), fmtSaisie(x.enTricotage + Math.min(prenableDe(x) - x.enTricotage, manque)))
    }
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
    ? [...new Set(toutes.filter((x) => x.kind === 'lot' && choix.has(cle(x)) && kgDe(x) > 0).map((x) => x.groupe))]
    : []

  // `valide` = the first change is an arbitration the person has just validated.
  const appliquer = async (ordre: { x: SourceFil; kg: number }[], valide = false) => {
    setEnCours(true)
    setErreur(null)
    let i = 0
    try {
      for (; i < ordre.length; i++) {
        const { x, kg } = ordre[i]
        await apiFetch(`/commandes-client/${commandeId}/lignes/${ligneId}/fil/reservations/source`, {
          method: 'PUT',
          body: JSON.stringify(x.kind === 'lot' ? { IDstock_fil: x.id, kg, arbitrage: valide && i === 0 } : { IDref_fil_commande: x.id, kg }),
        })
      }
      setArbitrage(null)
      onDone()
      onClose()
    } catch (e) {
      const body = (e as { body?: { error?: string; message?: string; arbitrage?: PlanArbitrage } })?.body
      if (body?.error === 'arbitrage_requis' && body.arbitrage) {
        // What came before is applied; this change and the next ones wait for the validation.
        setArbitrage({ ordre: ordre.slice(i), plan: body.arbitrage })
      } else {
        setArbitrage(null)
        setErreur(body?.message ?? 'La réservation a échoué')
      }
      onDone()
    } finally {
      setEnCours(false)
    }
  }
  // Releases first, then the takes: the cap is checked against what is already held.
  const reserver = () => appliquer([...changements].sort((a, b) => (a.kg - a.x.pour_ligne) - (b.kg - b.x.pour_ligne)))

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
              {data.ecru_ref_label ? `${data.ecru_ref_label}${data.ecru_coloris_label ? ` - ${data.ecru_coloris_label}` : ''}` : 'Tombé de métier'}
              {` · ${F.selecteurSous}`}
            </p>
          </div>
          <Button variant="ghost" size="icon" title="Fermer" disabled={enCours} onClick={onClose}
            className="h-8 w-8 flex-shrink-0 text-white/80 hover:bg-white/15 hover:text-white">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-100 p-4 space-y-4 scrollbar-transparent">
          {arbitrage && <ArbitrageFil lot={arbitrage.ordre[0]?.x.numero ?? ''} kg={arbitrage.ordre[0]?.kg ?? 0} plan={arbitrage.plan} />}
          {!arbitrage && yarns.map((y) => {
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
                      // Nothing left to reserve and nothing ticked beyond: nothing to say.
                      ? (pris > 0.05 ? <><CheckCircle2 className="h-3.5 w-3.5" />{fmtNum(pris, 1)} kg</> : null)
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
                            'flex items-start gap-3 px-3.5 py-2.5 select-none transition-colors',
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
                            <p className="text-sm font-medium tabular-nums">{x.kind === 'commande' ? `Commande N° ${x.numero}` : `Lot ${x.numero}`}</p>
                            <p className="text-[11px] text-muted-foreground truncate">
                              {x.kind === 'lot'
                                ? `${x.groupe} · ${x.fournisseur || 'fournisseur inconnu'} · entré le ${x.date}`
                                : `${x.fournisseur || 'fournisseur inconnu'} · prévue ${x.date === 'sans date' ? 'sans date' : `le ${x.date}`}`}
                            </p>
                            {x.kind === 'lot' && <JaugeLot source={x} kgLigne={coche ? kgDe(x) : 0} />}
                          </div>
                          {coche ? (
                            <span className="flex-shrink-0 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                              {x.kind === 'commande' && (
                                <span className="text-[11px] text-muted-foreground tabular-nums" title={x.totalTitre}>sur {fmtNum(x.libre + x.pour_ligne, 1)} kg libres</span>
                              )}
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
          {!arbitrage && forme === 'lot' && tricoteurs.length > 1 && (
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
          {!arbitrage && depassement && (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              {nomDuFil(depassement)} : au plus le besoin + 10 %, et ce que chaque {forme === 'lot' ? 'lot' : 'commande'} peut donner.
            </p>
          )}
          <div className="flex items-center gap-2">
            {arbitrage ? (
              <div className="ml-auto flex items-center gap-2">
                <Button variant="outline" onClick={() => setArbitrage(null)} disabled={enCours}>Retour</Button>
                <Button onClick={() => appliquer(arbitrage.ordre, true)} disabled={soldee || enCours}>
                  {enCours ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1.5" />}
                  Valider l'arbitrage
                </Button>
              </div>
            ) : (
              <div className="ml-auto flex items-center gap-2">
                <Button variant="outline" onClick={onClose} disabled={enCours}>Annuler</Button>
                <Button onClick={reserver} disabled={soldee || enCours || changements.length === 0 || !!depassement}>
                  {enCours ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <BobineIcon className="h-3.5 w-3.5 mr-1.5" />}
                  Réserver
                </Button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Who holds a lot's yarn (Vincent 2026-11-13: one gauge per lot, nothing else to read), in the app's
 *  one répartition format — the bar, then one row per client line (who · « REF - coloris » · kg),
 *  ending on « Stock »: the same component as the répartition of a yarn supplier order
 *  (components/commandes/ReservationParts). This line is gold and moves with the kg typed; « Stock »
 *  is what no client line holds: the lot's free yarn and what knitting orders make for the stock. */
function JaugeLot({ source: x, kgLigne }: { source: SourceFil; kgLigne: number }) {
  // What the line adds comes off the free yarn first (beyond, an arbitration says who loses).
  const libre = Math.max(0, x.libreLot - Math.max(0, kgLigne - x.pour_ligne))
  const autres = x.repartition.filter((p) => p.type === 'ligne')
  const stock = libre + x.repartition.filter((p) => p.type === 'stock').reduce((t, p) => t + p.kg, 0)
  const parts: PartCommande[] = [
    { cle: 'moi', nom: 'Cette ligne', kg: kgLigne, couleur: 'bg-accent', fort: true },
    ...autres.map((p, i) => ({
      cle: `l${i}`,
      nom: p.client_nom || 'Client',
      detail: p.commande_numero ? `N° ${p.commande_numero}` : undefined,
      article: p.article ?? undefined,
      kg: p.kg,
      couleur: COULEURS_AUTRES_LIGNES[i % COULEURS_AUTRES_LIGNES.length],
    })),
  ]
  const total = parts.reduce((t, p) => t + p.kg, 0) + stock
  if (!(total > 0.05)) return null
  return (
    <div className="mt-2.5">
      <RepartitionCommande titre="Répartition du lot" total={total} parts={parts} reste={{ nom: 'Stock', kg: stock }} />
    </div>
  )
}

/** What taking yarn held by knitting orders costs, before anything is written (Vincent 2026-11-13): each
 *  order with its quantity before → after, and the client lines that lose a share of it. */
function ArbitrageFil({ lot, kg, plan }: { lot: string; kg: number; plan: PlanArbitrage }) {
  const th = 'px-2.5 py-2 font-semibold whitespace-nowrap'
  const td = 'px-2.5 py-1.5 whitespace-nowrap'
  return (
    <>
      <div className="rounded-lg border-l-4 border-l-accent/70 border border-border/60 bg-card p-3 shadow-sm">
        <p className="text-sm font-semibold">Réserver {fmtNum(kg, 1)} kg sur le lot {lot}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Le lot n'a que {fmtNum(plan.libre, 1)} kg que personne ne tient : {fmtNum(plan.kg, 1)} kg sont repris à ceux qui les tiennent.
          {' '}Rien n'est écrit avant votre validation.
        </p>
      </div>
      {plan.effets.map((e) => (
        <div key={e.commande} className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
          <div className="flex items-center gap-3 px-3.5 py-2.5">
            <div className="h-8 w-8 rounded-md flex items-center justify-center flex-shrink-0 bg-zinc-100 text-muted-foreground">
              <KnitIcon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold truncate">Commande de tricotage N° {e.commande}</p>
              <p className="text-[11px] text-muted-foreground truncate">
                {e.article || 'tombé de métier'} · {e.interne ? `${fmtNum(e.fil, 1)} kg de fil changent de ligne client` : `rend ${fmtNum(e.fil, 1)} kg de fil`}
              </p>
            </div>
            {e.interne ? (
              <p className="flex-shrink-0 text-right tabular-nums">
                <span className="text-xl font-bold">{fmtNum(e.a, 1)} kg</span>
                <span className="block text-[11px] text-muted-foreground">quantité inchangée</span>
              </p>
            ) : (
              <p className="flex-shrink-0 text-right tabular-nums">
                <span className="text-sm text-muted-foreground line-through">{fmtNum(e.de, 1)} kg</span>
                <span className="mx-1.5 text-muted-foreground">→</span>
                <span className="text-xl font-bold">{fmtNum(e.a, 1)} kg</span>
              </p>
            )}
          </div>
          <table className="w-full text-xs border-t border-border/40">
            <thead className="bg-zinc-200/60 border-b border-border/60">
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className={cn(th, 'text-left')}>Qui reçoit moins</th>
                <th className={cn(th, 'text-left')}>Article</th>
                <th className={cn(th, 'text-left')}>Prête le</th>
                <th className={cn(th, 'text-right')}>Perd</th>
              </tr>
            </thead>
            <tbody>
              {e.stock > 0.05 && (
                <tr className="border-b border-border/40 last:border-0">
                  <td className={cn(td, 'font-medium')}>Stock</td>
                  <td className={cn(td, 'text-muted-foreground')} colSpan={2}>ce qu'aucune ligne client ne réservait</td>
                  <td className={cn(td, 'text-right tabular-nums font-semibold')}>{fmtNum(e.stock, 1)} kg</td>
                </tr>
              )}
              {e.lignes.map((l, i) => (
                <tr key={i} className="border-b border-border/40 last:border-0">
                  <td className={td}>
                    <span className="font-medium">{l.client_nom || 'Client'}</span>
                    {l.commande_numero ? <span className="text-muted-foreground tabular-nums"> · Cde {l.commande_numero}</span> : null}
                  </td>
                  <td className={td}>{l.article || '—'}</td>
                  <td className={cn(td, 'text-muted-foreground tabular-nums')}>{l.delai ? formatHfsqlDate(l.delai) : 'sans date'}</td>
                  <td className={cn(td, 'text-right tabular-nums font-semibold')}>{fmtNum(l.perd, 1)} kg</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <p className="px-1 text-[11px] text-muted-foreground">
        Les kilos perdus sont en tombé de métier. {plan.effets.some((e) => !e.interne) ? "La commande du tricoteur baisse d'autant ; les" : 'Les'} lignes client
        qui perdent une part la retrouvent « à tricoter », à couvrir avec un autre fil.
      </p>
    </>
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
