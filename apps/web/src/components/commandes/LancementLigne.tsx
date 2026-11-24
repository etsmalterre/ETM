// Clients › Commandes: the launch date of a line's next step (doctrine des délais §5, decision
// Vincent 2026-10-28, API lib/lancement-ligne.ts). The only way to hold a line « à lancer » on
// purpose: before the date the line is neutral, from it red. It is set from « Planifier », next to the
// order buttons of the line drawer's Fil / Tricotage / Ennoblissement tabs: the tab IS the step that
// waits (commander le fil, tricoter, ennoblir), so no why is typed. The line card only shows it.
//
// A date planned too late for the client's date is red at once. « Prévoir une urgence » (Vincent
// 2026-11-23) answers it in the plan itself: launched that day « en urgence », the partner is asked
// with the order for the date the API computes. A plan, not a promise — offered only for a close
// launch, and the line is neutral until then.
//
// …and without a launch date (LIVA #1396, Vincent 2026-11-24): a line « en tricotage » has no launch
// to hold, its dyeing starts when the knitting ends. The Ennoblissement tab then offers « Prévoir une
// urgence » alone (UrgencePrevueBouton), where « Planifier » would sit — same rules, the end of the
// knitting standing for the launch date.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CalendarClock, Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { UrgenceIcon } from '@/components/sst/UrgenceIcon'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { apiFetch } from '@/lib/api'
import { formatHfsqlDate, hfsqlDateToInput, inputDateToHfsql } from '@/lib/dates'
import { invalidateCommandeClientCaches } from '@/lib/cache-sync'
import { cn } from '@/lib/utils'

export type EtapeLancement = 'fil' | 'tricotage' | 'ennoblissement'

/** The urgency a launch is planned with (API lancementPlanifie): the date to ask of the partner
 *  (YYYYMMDD), the working days that leaves it against its standard, whether the client's date holds. */
export interface UrgencePrevue {
  souhaitee: string; jours: number; standard: number; tient: boolean
  /** it would leave a dyer less than its floor (API URGENCE_ENNOBLISSEUR_MIN_J): never offered */
  trop_court?: boolean
  /** YYYYMMDD the day the step starts: the launch date, or the end of the knitting it follows */
  du?: string
}

/** A line « en tricotage »: the urgency its dyeing can be planned with, without a launch date (API
 *  urgence_apres_tricotage). `prevue` = it is planned; `urgence` null = the line is in time. */
export interface UrgenceApresTricotage {
  prevue: boolean
  urgence: (UrgencePrevue & { trop_loin: boolean }) | null
}

/** The line's launch date (the API also returns its history, kept in the journal, not shown here). */
interface LancementPayload { date: string | null; etape: EtapeLancement | null; urgence_prevue: boolean }
/** What a launch date gives (API effetLancement). */
interface EffetLancement {
  prete_le: string | null
  delai: string | null
  trop_tard: boolean
  urgence: (UrgencePrevue & { trop_loin: boolean }) | null
}

/** What waits, as a verb: « Ennoblir le 16/11 ». */
const VERBE: Record<EtapeLancement, string> = { fil: 'Commander le fil', tricotage: 'Tricoter', ennoblissement: 'Ennoblir' }
/** Who an urgency is asked of, per step. */
const PARTENAIRE: Partial<Record<EtapeLancement, string>> = { tricotage: 'tricoteur', ennoblissement: 'ennoblisseur' }
const jjmm = (d: string) => formatHfsqlDate(d).slice(0, 5)
const libelle = (date: string, etape: EtapeLancement | null) => `${etape ? VERBE[etape] : 'Lancer'} le ${jjmm(date)}`
/** A launch date planned too late: the delay is known today (API lib/urgence-commande-client.ts). */
const messageTropTard = (lance: string, prete: string, delai: string) =>
  `Lancée le ${jjmm(lance)}, la ligne sera prête au plus tôt le ${formatHfsqlDate(prete)}, après son délai du ${formatHfsqlDate(delai)}`
/** What can be done about it, in the order to try them. */
export const GESTES_TROP_TARD = 'Avancer la planification, prévoir une urgence ou reporter le délai avec le client'
/** Why a line planned too late is red and what to do (the launch label's hover). */
export const texteTropTard = (lance: string, prete: string, delai: string) =>
  `${messageTropTard(lance, prete, delai)}. ${GESTES_TROP_TARD}.`
/** What a planned urgency asks: « Retour ennoblisseur souhaité le 11/12 : 12 j ouvrés au lieu de 15 ». */
export const texteUrgencePrevue = (u: Pick<UrgencePrevue, 'souhaitee' | 'jours' | 'standard'>, etape: EtapeLancement | null) =>
  `Retour ${(etape && PARTENAIRE[etape]) || 'partenaire'} souhaité le ${jjmm(u.souhaitee)} : ${u.jours} j ouvrés au lieu de ${u.standard}`

/** The date that will be asked and how many working days it takes off the partner's standard, nothing
 *  else (Vincent 2026-11-23). */
function DateDemandee({ urgence, actif }: { urgence: Pick<UrgencePrevue, 'souhaitee' | 'jours' | 'standard'>; actif: boolean }) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span>Date demandée</span>
      <span className={cn('text-sm font-semibold tabular-nums', actif && 'text-foreground')}>{jjmm(urgence.souhaitee)}</span>
      {/* The urgency's navy (mps_designer §47), never red nor amber: nothing to do here. */}
      <span title={`${urgence.jours} j ouvrés au lieu de ${urgence.standard}`}
        className={cn('rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums', actif ? 'bg-primary/10 text-primary' : 'bg-zinc-100')}>
        −{urgence.standard - urgence.jours} j
      </span>
    </p>
  )
}

/** Beside the line card's status pill, an urgency planned WITHOUT a launch date (LIVA #1396): the siren
 *  and its two words, neutral — nobody was asked yet (mps_designer §47). */
export function UrgencePrevueLabel({ urgence, etape }: { urgence: UrgencePrevue; etape: EtapeLancement | null }) {
  return (
    <span title={`${etape === 'ennoblissement' ? 'Ennoblissement' : 'Lancement'} prévu en urgence. ${texteUrgencePrevue(urgence, etape)}, demandé avec la commande.`}
      className="inline-flex items-center gap-1 text-[11px] font-medium whitespace-nowrap text-muted-foreground">
      <UrgenceIcon /><span>urgence prévue</span>
    </span>
  )
}

/** Why the dyeing after the knitting cannot be planned « en urgence » (or no longer holds), null when it can. */
function refusApresTricotage(u: UrgenceApresTricotage['urgence'], prevue: boolean): string | null {
  if (!u) return 'La ligne tient sa date sans urgence'
  if (u.trop_court) return `Trop court pour une urgence (${u.jours} j ouvrés pour l’ennoblisseur) : reportez le délai`
  if (!u.tient) return 'Même en urgence, la ligne ne serait pas prête à sa date : reportez le délai'
  // Too far only stops a NEW plan: one already made still holds the date.
  return u.trop_loin && !prevue ? 'Fin du tricotage trop lointaine pour prévoir une urgence' : null
}

/** « Prévoir une urgence » / « Urgence prévue » where « Planifier » sits, in the Ennoblissement tab of a
 *  line « en tricotage » (LIVA #1396): no launch date to type, the dyeing starts when the knitting
 *  ends. Greyed with its reason when an urgency is not the answer; red once planned and no longer
 *  enough (the hover says what to do, the click is where to give it up). */
export function UrgencePrevueBouton({ commandeId, ligneId, plan }: { commandeId: number; ligneId: number; plan: UrgenceApresTricotage }) {
  const peutModifier = useHasPermission('edit_commandes_client')
  const [ouvert, setOuvert] = useState(false)
  if (!plan.prevue && !peutModifier) return null
  const u = plan.urgence
  const refus = refusApresTricotage(u, plan.prevue)
  const titre = refus
    ? `${plan.prevue ? 'Urgence prévue. ' : ''}${refus}.`
    : `${plan.prevue ? 'Ennoblissement prévu en urgence' : 'Ennoblir en urgence dès la fin du tricotage'}. ${texteUrgencePrevue(u!, 'ennoblissement')}, demandé avec la commande.`
  return (
    <>
      <span title={titre} className="inline-flex">
        <Button variant="outline" size="sm" disabled={!peutModifier || (!plan.prevue && !!refus)} onClick={() => setOuvert(true)}
          className={cn('h-7 px-2.5 text-xs bg-white', plan.prevue && u && refus && 'border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700')}>
          <UrgenceIcon className="h-3.5 w-3.5 mr-1.5" />
          {plan.prevue ? 'Urgence prévue' : 'Prévoir une urgence'}
        </Button>
      </span>
      {ouvert && <UrgencePrevueDialog commandeId={commandeId} ligneId={ligneId} plan={plan} refus={refus} onClose={() => setOuvert(false)} />}
    </>
  )
}

function UrgencePrevueDialog({ commandeId, ligneId, plan, refus, onClose }: {
  commandeId: number; ligneId: number; plan: UrgenceApresTricotage; refus: string | null; onClose: () => void
}) {
  const queryClient = useQueryClient()
  const mut = useMutation({
    mutationFn: (active: boolean) => apiFetch(`/commandes-client/${commandeId}/lignes/${ligneId}/urgence-prevue`, { method: 'PUT', body: JSON.stringify({ active }) }),
    onSuccess: () => {
      // The line's colour, the order's liseré and the list's counters follow the plan.
      invalidateCommandeClientCaches(queryClient)
      onClose()
    },
  })
  const u = plan.urgence
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !mut.isPending) onClose() }}>
      <DialogContent className="max-w-sm" onClose={mut.isPending ? undefined : onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UrgenceIcon className="h-5 w-5" />
            {plan.prevue ? 'Urgence prévue' : 'Prévoir une urgence'}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          {refus ? (
            <p className={cn('text-xs font-medium', u ? 'text-amber-700' : 'text-muted-foreground')}>{refus}.</p>
          ) : u && (
            <>
              {u.du && <p className="text-xs text-muted-foreground tabular-nums">Ennoblissement dès la fin du tricotage, le {jjmm(u.du)}.</p>}
              <div className="rounded-lg border border-border/60 bg-white px-3 py-2.5 shadow-sm">
                <DateDemandee urgence={u} actif />
              </div>
            </>
          )}
          {mut.error && (
            <p className="flex items-center gap-1.5 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />{(mut.error as any).body?.message ?? 'L’enregistrement a échoué'}
            </p>
          )}
        </div>
        <DialogFooter className="mt-4">
          {plan.prevue && (
            <Button variant="ghost" className="mr-auto text-destructive hover:text-destructive" disabled={mut.isPending} onClick={() => mut.mutate(false)}>
              Retirer l’urgence
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={mut.isPending}>{plan.prevue ? 'Fermer' : 'Annuler'}</Button>
          {!plan.prevue && (
            <Button onClick={() => mut.mutate(true)} disabled={!!refus || mut.isPending}>
              {mut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
              Prévoir
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Next to the line card's status pill, read only: « 📅 Ennoblir le 16/11 » (Vincent 2026-10-28, was a
 *  « Lancement » stat). The pill says « Planifiée » before the date; from it the line is « À lancer »
 *  again and this label turns red. Nothing without a date — planning is done from the drawer's tabs. */
export function LancementLabel({ date, etape, rouge, tropTard = null, urgence = null }: {
  /** YYYYMMDD or null */
  date: string | null
  etape: EtapeLancement | null
  /** the line is red because its launch date has come */
  rouge: boolean
  /** launched on this date, the line is ready after its délai (Vincent 2026-10-30): red now, says what to do */
  tropTard?: { preteLe: string; delai: string } | null
  /** the launch is planned « en urgence » and that holds the client's date: the siren, neutral */
  urgence?: UrgencePrevue | null
}) {
  if (!date) return null
  return (
    <span title={tropTard
      ? texteTropTard(date, tropTard.preteLe, tropTard.delai)
      : urgence
        ? `Lancement prévu en urgence. ${texteUrgencePrevue(urgence, etape)}, demandé avec la commande.`
        : 'Lancement prévu : la ligne reste neutre jusqu’à cette date, puis passe au rouge (« Planifier » dans les onglets de la ligne)'}
      className={cn('inline-flex items-center gap-1 text-[11px] font-medium tabular-nums whitespace-nowrap', rouge || tropTard ? 'text-red-600' : 'text-muted-foreground')}>
      <CalendarClock className="h-3.5 w-3.5" />
      {libelle(date, etape)}
      {urgence && !tropTard && <><UrgenceIcon className="ml-0.5" /><span>urgence prévue</span></>}
    </span>
  )
}

/** « Planifier » / « Planifié le 16/11 » left of the order button of the line drawer's bottom zones:
 *  one decides to wait where one would launch, and the tab gives the step. One launch date per line:
 *  planning from another tab replaces it and its step (doctrine des délais §5). An outline button,
 *  second to the order button beside it (mps_designer §31.4); red when the date is too late — its
 *  hover says what to do, the click is where to do it. */
export function PlanifierBouton({ commandeId, ligneId, date, etapeActuelle, etape, proposee = null, tropTard = null, urgence = null }: {
  commandeId: number
  ligneId: number
  date: string | null
  /** the step the current date holds */
  etapeActuelle: EtapeLancement | null
  /** this tab's step */
  etape: EtapeLancement
  /** the doctrine's date (YYYYMMDD), offered when none is set yet, with why */
  proposee?: { date: string; pourquoi: string } | null
  /** the date set misses the client's date (and no urgency planned holds it) */
  tropTard?: { preteLe: string; delai: string } | null
  /** the launch is planned « en urgence » */
  urgence?: UrgencePrevue | null
}) {
  const peutModifier = useHasPermission('edit_commandes_client')
  const [ouvert, setOuvert] = useState(false)
  if (!date && !peutModifier) return null
  const titre = !date
    ? `Attendre avant de ${VERBE[etape].toLowerCase()} : la ligne reste neutre jusqu’à la date choisie`
    : tropTard
      ? texteTropTard(date, tropTard.preteLe, tropTard.delai)
      : urgence
        ? `${libelle(date, etapeActuelle)}, en urgence. ${texteUrgencePrevue(urgence, etapeActuelle)}.`
        : `${libelle(date, etapeActuelle)} : la ligne reste neutre jusqu’à cette date, puis passe au rouge`
  return (
    <>
      <span title={titre} className="inline-flex">
        <Button variant="outline" size="sm" disabled={!peutModifier} onClick={() => setOuvert(true)}
          className={cn('h-7 px-2.5 text-xs bg-white tabular-nums', date && tropTard && 'border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700')}>
          <CalendarClock className="h-3.5 w-3.5 mr-1.5" />
          {date ? `Planifié le ${jjmm(date)}` : 'Planifier'}
          {date && urgence && !tropTard && <UrgenceIcon className="ml-1.5" />}
        </Button>
      </span>
      {ouvert && <LancementDialog commandeId={commandeId} ligneId={ligneId} etape={etape} proposee={proposee} onClose={() => setOuvert(false)} />}
    </>
  )
}

function LancementDialog({ commandeId, ligneId, etape, proposee, onClose }: {
  commandeId: number; ligneId: number; etape: EtapeLancement; proposee: { date: string; pourquoi: string } | null; onClose: () => void
}) {
  const queryClient = useQueryClient()
  const url = `/commandes-client/${commandeId}/lignes/${ligneId}/lancement`
  const { data, isLoading } = useQuery<LancementPayload>({ queryKey: ['commande-client-lancement', ligneId], queryFn: () => apiFetch(url) })
  const [date, setDate] = useState('')
  // « Prévoir une urgence »: what the user wants; it only counts while the date typed allows it.
  const [urgenceVoulue, setUrgenceVoulue] = useState(false)
  const [pret, setPret] = useState(false)
  if (!pret && data) {
    setPret(true)
    // No date yet: the doctrine's proposal, to accept or change.
    setDate(hfsqlDateToInput(data.date ?? proposee?.date ?? null))
    setUrgenceVoulue(data.urgence_prevue)
  }

  const actuelle = data?.date ?? null
  const choisie = date ? inputDateToHfsql(date) : null
  // Launched on the date typed, when would the line be ready? Warned before saving, never refused.
  const { data: effet } = useQuery<EffetLancement>({
    queryKey: ['commande-client-lancement-prete', ligneId, choisie, etape],
    queryFn: () => apiFetch(`${url}/prete-le?date=${choisie}&etape=${etape}`),
    enabled: !!choisie && /^\d{8}$/.test(choisie),
  })
  const tropTard = !!(effet?.trop_tard && effet.prete_le && effet.delai && choisie)
  // The urgency is offered where it is the answer: it holds the client's date and the launch is close.
  const urgence = tropTard && effet?.urgence && effet.urgence.tient && !effet.urgence.trop_loin ? effet.urgence : null
  const enUrgence = urgenceVoulue && !!urgence

  const mut = useMutation({
    mutationFn: (d: string | null) => apiFetch<LancementPayload>(url, { method: 'PUT', body: JSON.stringify({ date: d, etape, urgence_prevue: d !== null && enUrgence }) }),
    onSuccess: (p) => {
      queryClient.setQueryData(['commande-client-lancement', ligneId], p)
      // The line's colour, the order's liseré and the list's counters follow the date.
      invalidateCommandeClientCaches(queryClient)
      onClose()
    },
  })
  // Same date planned from another tab = a change of step, worth saving; so is the urgency alone.
  const change = choisie !== actuelle || (choisie !== null && (data?.etape !== etape || enUrgence !== (data?.urgence_prevue ?? false)))

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !mut.isPending) onClose() }}>
      <DialogContent className="max-w-sm" onClose={mut.isPending ? undefined : onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-accent" />
            {VERBE[etape]} le…
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          {isLoading ? (
            <div className="h-10 bg-muted animate-pulse rounded-md" />
          ) : (
            <>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={mut.isPending} autoFocus
                className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
              {/* One short line, only when the date is too late and no urgency answers it (Vincent
                  2026-11-23: no paragraph, no history here — the line's hover tells the rest). */}
              {tropTard && !enUrgence && (
                <p className="text-xs font-medium text-amber-700 tabular-nums">
                  Prête le {formatHfsqlDate(effet!.prete_le!)}, après le délai du {formatHfsqlDate(effet!.delai!)}.
                </p>
              )}
              {/* §35 pill: the urgency planned with the launch (the partner is asked with the order). */}
              {urgence && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-white px-3 py-2.5 shadow-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-xs font-semibold">
                      <UrgenceIcon className={cn('h-3.5 w-3.5', !enUrgence && 'text-muted-foreground')} />
                      <span>Prévoir une urgence</span>
                    </div>
                    <div className="mt-1"><DateDemandee urgence={urgence} actif={enUrgence} /></div>
                  </div>
                  <button
                    type="button" role="switch" aria-checked={enUrgence} disabled={mut.isPending} title="Prévoir une urgence"
                    onClick={() => setUrgenceVoulue(!enUrgence)}
                    className={cn(
                      'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                      enUrgence ? 'bg-accent shadow-inner' : 'bg-zinc-300 hover:bg-zinc-400/80',
                    )}
                  >
                    <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out', enUrgence ? 'translate-x-[18px]' : 'translate-x-0.5')} />
                  </button>
                </div>
              )}
              {tropTard && effet?.urgence?.tient && effet.urgence.trop_loin && (
                <p className="text-xs text-muted-foreground">Lancement trop lointain pour prévoir une urgence : avancez la date.</p>
              )}
              {tropTard && effet?.urgence?.trop_court && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  Trop court pour une urgence ({effet.urgence.jours} j ouvrés pour l’{PARTENAIRE[etape] ?? 'ennoblisseur'}) : avancez la date ou reportez le délai.
                </p>
              )}
              {!actuelle && proposee && (
                <p className="text-xs text-muted-foreground">Proposée : {proposee.pourquoi}.</p>
              )}
              {actuelle && data?.etape && data.etape !== etape && (
                <p className="text-xs text-amber-700">Remplace « {libelle(actuelle, data.etape)} » : une seule date de lancement par ligne.</p>
              )}
            </>
          )}
          {mut.error && (
            <p className="flex items-center gap-1.5 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />{(mut.error as any).body?.message ?? 'L’enregistrement a échoué'}
            </p>
          )}
        </div>
        <DialogFooter className="mt-4">
          {actuelle && (
            <Button variant="ghost" className="mr-auto text-destructive hover:text-destructive" disabled={mut.isPending}
              onClick={() => mut.mutate(null)} title="La ligne redevient rouge : il y a quelque chose à faire maintenant">
              Retirer la date
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={mut.isPending}>Annuler</Button>
          <Button onClick={() => mut.mutate(choisie)} disabled={!choisie || !change || mut.isPending}>
            {mut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
