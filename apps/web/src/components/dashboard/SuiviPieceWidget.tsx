// ── Suivi pièce widget ────────────────────────────────────────
// Port of the legacy FI_Suivi_pièce.wdw dashboard panel: type a piece number,
// get its life story. Backed by GET /api/stock/ecru/suivi?numero=…
//
// ── How this is organised, and why ──
// Legacy printed one block of coloured text in chronological order. Two changes:
//
//  1. REVERSE CHRONOLOGICAL. The question people actually open this for is
//     "where is this piece and what happened to it *lately*" — so the newest
//     event is at the top and the story reads backwards to the raw yarn at the
//     bottom. A header strip answers "where is it now" before any scrolling.
//
//  2. OBJECTS vs EVENTS. The chain alternates between things the piece WAS
//     (tombé de métier → rouleau fini) and things that HAPPENED to it
//     (transferts, expéditions, tricotage). Objects are solid cards with a
//     coloured left edge; events are lighter dashed rows. That distinction is
//     what lets someone skim the spine of the timeline and still find the two
//     or three facts they came for.
//
// Order, top to bottom: expédition client → rouleau fini → ses transferts →
// transferts + expédition de l'écru → tombé de métier → tricotage (OF) → fils.

import { useState, type FormEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Loader2, Search, PackageSearch, ArrowRight, Truck, Send, Factory, MapPin, Beaker,
  AlertTriangle, MessageSquare,
} from 'lucide-react'
import { CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { TmRollIcon } from '@/components/icons/TmRollIcon'
import { FiniRollIcon } from '@/components/icons/FiniRollIcon'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { Tooltip } from '@/components/ui/tooltip'
import { EtatPill } from '@/lib/etat-stock-fini'
import { apiFetch } from '@/lib/api'
import { formatHfsqlDate } from '@/lib/dates'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { WidgetFrame } from './WidgetFrame'

interface CommandeRef {
  commande: number
  sous_traitant: string | null
  date_commande: string | null
}
interface Expedition {
  IDexpedition: number
  date: string | null
  expediteur: string
  client: string | null
  commande_numero: number | null
  IDsociete: number
}
interface Transfert {
  IDbon_transfert: number
  date: string | null
  de: string
  vers: string
  valide: boolean
}
interface Fil {
  reference: string
  coloris: string
  pourcentage: number | null
  lot: string
  fournisseur: string | null
  commande_fil: number | null
  date_commande: string | null
  date_livraison: string | null
}
interface Fabrication {
  IDordre_fabrication: number
  date_creation: string | null
  machine: string | null
}
interface FiniRoll {
  IDstock_fini: number
  numero: string
  reference: string
  designation: string
  coloris: string
  lot: string
  poids: number
  metrage: number
  magasin: string
  etat: string
  commande_source: CommandeRef | null
  expedition: Expedition | null
  observations: string
  defauts: string
  second_choix: boolean
  transferts: Transfert[]
}
interface Piece {
  ecru: {
    IDstock_ecru: number
    numero: string
    reference: string
    designation: string
    coloris: string
    lot: string
    poids: number
    metrage: number
    magasin: string
    date_saisie: string | null
    IDsociete: number
    observations: string
    second_choix: boolean
    defauts: string
  }
  commande_source: CommandeRef | null
  commande_affectee: CommandeRef | null
  fabrication: Fabrication | null
  fils: Fil[]
  expedition_ecru: Expedition | null
  transferts: Transfert[]
  finis: FiniRoll[]
}
interface SuiviResponse { numero: string; pieces: Piece[]; truncated: boolean }

export function SuiviPieceWidget() {
  const [draft, setDraft] = useState('')
  // The lookup is an exact match on a number the user types in full, so it runs
  // on submit rather than on every keystroke — a live query would fire a dozen
  // misses per search.
  const [submitted, setSubmitted] = useState('')

  const suiviQuery = useQuery<SuiviResponse>({
    queryKey: ['suivi-piece', submitted],
    queryFn: () => apiFetch(`/stock/ecru/suivi?numero=${encodeURIComponent(submitted)}`),
    enabled: submitted.trim().length > 0,
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitted(draft.trim())
  }

  const pieces = suiviQuery.data?.pieces ?? []

  return (
    <WidgetFrame icon={TmRollIcon} title="Suivi pièce">
      <CardContent className="flex h-full flex-col gap-3 p-3">
        <form onSubmit={handleSubmit} className="flex flex-shrink-0 items-center gap-2">
          <label htmlFor="suivi-piece-num" className="flex-shrink-0 text-xs font-medium text-muted-foreground">
            N° pièce
          </label>
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              id="suivi-piece-num"
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="ex. 3397/30"
              className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <Button type="submit" size="sm" disabled={draft.trim().length === 0} className="flex-shrink-0">
            OK
          </Button>
        </form>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-transparent p-1">
          {submitted === '' && (
            <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
              <PackageSearch className="mb-3 h-12 w-12 opacity-40" />
              <p className="text-sm">Saisissez un numéro de pièce</p>
              <p className="mt-1 text-xs">Son parcours du fil au rouleau expédié s’affichera ici.</p>
            </div>
          )}

          {submitted !== '' && suiviQuery.isLoading && (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
            </div>
          )}

          {submitted !== '' && suiviQuery.isError && (
            <p className="py-8 text-center text-sm text-destructive">
              Impossible de tracer cette pièce.
            </p>
          )}

          {submitted !== '' && !suiviQuery.isLoading && !suiviQuery.isError && pieces.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
              <PackageSearch className="mb-3 h-12 w-12 opacity-40" />
              <p className="text-sm">Aucune pièce n° {submitted}</p>
              <p className="mt-1 text-xs">Vérifiez le numéro (écru ou fini).</p>
            </div>
          )}

          {pieces.length > 0 && (
            <div className="space-y-5">
              {/* A numero is not unique — say so rather than silently showing
                  the first match as if it were the only one. */}
              {pieces.length > 1 && (
                <p className="text-xs italic text-muted-foreground">
                  {pieces.length} pièces portent ce numéro.
                </p>
              )}
              {pieces.map((p) => <PieceTimeline key={p.ecru.IDstock_ecru} piece={p} />)}
              {suiviQuery.data?.truncated && (
                <p className="text-xs italic text-muted-foreground">
                  Seules les {pieces.length} pièces les plus récentes sont affichées.
                </p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </WidgetFrame>
  )
}

// ── One piece's chain, newest first ──────────────────────

function PieceTimeline({ piece }: { piece: Piece }) {
  const { ecru } = piece
  // The piece's current identity is its latest stage: once dyed, the fini roll
  // is where it lives and what state it's in.
  const latestFini = piece.finis.length > 0 ? piece.finis[piece.finis.length - 1] : null
  // Once shipped, the piece is at the CUSTOMER — `IDmagasin` still points at the
  // last internal depot (often 0 = Ets Malterre), which would claim a delivered
  // roll is still in the building.
  const location = latestFini && isShipped(latestFini)
    ? (latestFini.expedition?.client ?? latestFini.magasin)
    : (latestFini?.magasin ?? ecru.magasin)

  // Écru-stage events, newest first — its transferts plus its own shipment.
  const ecruEvents: Array<{ key: string; node: ReactNode; date: string | null }> = [
    ...piece.transferts.map((t) => ({
      key: `t${t.IDbon_transfert}`, date: t.date, node: <TransfertRow t={t} />,
    })),
    ...(piece.expedition_ecru
      ? [{
        key: `xe${piece.expedition_ecru.IDexpedition}`,
        date: piece.expedition_ecru.date,
        node: <ExpeditionRow e={piece.expedition_ecru} />,
      }]
      : []),
  ].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  return (
    <div className="space-y-2">
      {/* Where is it NOW — the question this widget gets opened for. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-zinc-200/50 px-2.5 py-1.5">
        <span className="text-xs font-semibold">Pièce n° {ecru.numero}</span>
        {/* Location and état sit together on the right: they're the two halves
            of one answer ("where is it, and in what state"), so keeping them
            adjacent beats splitting them across the strip. */}
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <MapPin className="h-3 w-3" />
          {location}
        </span>
        {latestFini?.etat && <EtatPill libelle={latestFini.etat} />}
      </div>

      <ol className="relative ml-1 space-y-2 border-l border-border/70 pl-4">
        {/* ── Fini stage (newest first) ── */}
        {[...piece.finis].reverse().map((f) => (
          <div key={f.IDstock_fini} className="space-y-2">
            {f.expedition && (
              <Step tone="expedition"><ExpeditionRow e={f.expedition} /></Step>
            )}
            <Step tone="fini">
              <StageCard
                icon={<FiniRollIcon className="h-3.5 w-3.5 text-emerald-600" />}
                tone="fini"
                // Same shape as the tombé de métier card: reference on the
                // first line, designation as the subtitle — so the two stages
                // of the same piece are read the same way.
                title={f.reference || '—'}
                subtitle={f.designation}
                // The état pill already identifies this as a fini roll (and the
                // emerald edge + roll icon back it up), so the "Fini" badge only
                // appears when there's no état — two chips would eat the width
                // the reference needs.
                badge={f.etat ? null : 'Fini'}
                trailing={
                  <>
                    <RollNotes
                      defauts={f.defauts}
                      secondChoix={f.second_choix}
                      observations={f.observations}
                    />
                    {f.etat ? <EtatPill libelle={f.etat} /> : null}
                  </>
                }
              >
                <Facts
                  items={[
                    // A cut roll gets its own numero ("3417/57-2"); when it
                    // differs from the piece's, it identifies THIS roll.
                    f.numero && f.numero !== ecru.numero ? ['N° rouleau', f.numero] : null,
                    f.coloris ? ['Coloris', f.coloris] : null,
                    f.poids > 0 ? ['Poids', `${fmtNum(f.poids, 1)} Kg`] : null,
                    f.metrage > 0 ? ['Métrage', `${fmtNum(f.metrage)} Ml`] : null,
                    f.lot ? ['Lot', f.lot] : null,
                    // Once the roll has shipped, its magasin is where it used to
                    // sit — the expédition above says where it went, so showing
                    // a stale location here would contradict it.
                    isShipped(f) ? null : ['Magasin', f.magasin],
                  ]}
                />
              </StageCard>
            </Step>
            {/* The order that turned the écru into this roll. Its own card, so
                the roll card stays about the roll and the commande's details
                (sous-traitant, n°, date) have somewhere to live. */}
            {(f.commande_source ?? piece.commande_affectee) && (
              <Step tone="fini">
                <CommandeCard
                  label="Commande ennoblissement"
                  cmd={(f.commande_source ?? piece.commande_affectee)!}
                  icon={<Beaker className="h-3.5 w-3.5 flex-shrink-0 text-emerald-600" />}
                  tone="ennoblissement"
                />
              </Step>
            )}
            {[...f.transferts].reverse().map((t) => (
              <Step key={`f${t.IDbon_transfert}`} tone="transfert"><TransfertRow t={t} /></Step>
            ))}
          </div>
        ))}

        {/* Affected to an ennoblisseur but not yet dyed — the order exists with
            no fini roll to hang it under, so it sits above the écru instead. */}
        {piece.finis.length === 0 && piece.commande_affectee && (
          <Step tone="fini">
            <CommandeCard
              label="Commande ennoblissement"
              cmd={piece.commande_affectee}
              icon={<Beaker className="h-3.5 w-3.5 flex-shrink-0 text-emerald-600" />}
              tone="ennoblissement"
            />
          </Step>
        )}

        {/* ── Écru-stage events ── */}
        {ecruEvents.map((ev) => (
          <Step key={ev.key} tone="transfert">{ev.node}</Step>
        ))}

        {/* ── The piece as knitted ── */}
        <Step tone="ecru">
          <StageCard
            icon={<TmRollIcon className="h-3.5 w-3.5 text-amber-600" />}
            tone="ecru"
            title={ecru.reference || '—'}
            subtitle={ecru.designation}
            badge="Tombé de métier"
            trailing={<RollNotes
              defauts={ecru.defauts}
              secondChoix={ecru.second_choix}
              observations={ecru.observations}
            />}
          >
            {/* Deliberately no Magasin and no ennoblisseur here. `stock_ecru.
                IDmagasin` is where the record sits TODAY, which is a fact about
                the finished roll, not about the piece as it came off the loom —
                the header strip already states the current location. The
                ennoblissement order belongs to its own card above, since it is
                the step that ENDED this stage rather than a property of it. */}
            <Facts
              items={[
                ecru.coloris ? ['Coloris', ecru.coloris] : null,
                ecru.poids > 0 ? ['Poids', `${fmtNum(ecru.poids, 1)} Kg`] : null,
                ecru.metrage > 0 ? ['Métrage', `${fmtNum(ecru.metrage)} Ml`] : null,
                ecru.lot ? ['Lot', ecru.lot] : null,
              ]}
            />
          </StageCard>
        </Step>

        {/* ── Tricotage ──
            The OF and its machine used to show here; they were noise next to
            the order itself. The OF is still what the yarn list below is read
            through (`asso_fil_of`), it's just no longer displayed. */}
        {piece.commande_source && (
          <Step tone="ecru">
            <CommandeCard
              label="Commande tricotage"
              cmd={piece.commande_source}
              icon={<Factory className="h-3.5 w-3.5 flex-shrink-0 text-amber-600" />}
              tone="tricotage"
            />
          </Step>
        )}

        {/* ── The raw yarn: the oldest thing we know ── */}
        {piece.fils.length > 0 && (
          <Step tone="fil">
            <div className="rounded-lg border border-border/60 border-l-4 border-l-stone-400/60 bg-zinc-100/80 p-2.5">
              <div className="mb-1.5 flex items-center gap-2">
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-stone-400/10">
                  <BobineIcon className="h-3.5 w-3.5 text-stone-600" />
                </div>
                <p className="text-sm font-medium">
                  Fils utilisés
                  <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                    {piece.fils.length}
                  </span>
                </p>
              </div>
              <div className="ml-9 space-y-2">
                {piece.fils.map((f, i) => <FilRow key={`${f.lot}-${i}`} fil={f} />)}
              </div>
            </div>
          </Step>
        )}
      </ol>
    </div>
  )
}

function commandeLabel(c: CommandeRef): string {
  return c.sous_traitant ? `${c.commande} - ${c.sous_traitant}` : String(c.commande)
}

/** Has this roll left the building? Either it carries an expédition, or its
 *  état says so. The libellé is "Expédié", so the comparison strips accents
 *  (decompose to NFD, drop the combining marks) rather than hard-coding the
 *  accented spelling — `etat_stock_fini.libelle` is user-maintained data. */
/** Défauts and observations as hover icons, the same affordance the roll rows
 *  in Clients › Commandes use: a red triangle for anything quality-related and
 *  a blue speech bubble for free text, each carrying its content in a tooltip.
 *  Read-only here — this widget traces a piece, it doesn't edit it — but they
 *  still take `cursor-pointer`: the hand is what tells you the badge is worth
 *  hovering, and without it the tooltip goes undiscovered. */
function RollNotes({
  defauts, secondChoix, observations,
}: {
  defauts: string
  secondChoix: boolean
  observations: string
}) {
  const hasDefect = secondChoix || defauts.trim().length > 0
  const obs = observations.trim()
  if (!hasDefect && obs.length === 0) return null
  return (
    <>
      {hasDefect && (
        <Tooltip
          side="left"
          content={
            <div className="w-max max-w-[320px] space-y-1.5 py-1">
              <p className="whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-red-700">
                Défauts
              </p>
              {secondChoix && (
                <p className="text-xs font-bold uppercase tracking-wide text-red-700">2e choix</p>
              )}
              {defauts.trim().length > 0 && (
                <p className="whitespace-pre-line text-sm font-normal">{defauts}</p>
              )}
            </div>
          }
        >
          <span className="flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded-md border border-red-200 bg-red-50">
            <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
          </span>
        </Tooltip>
      )}
      {obs.length > 0 && (
        <Tooltip
          side="left"
          content={
            <div className="w-max max-w-[320px] space-y-1.5 py-1">
              <p className="whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-blue-700">
                Observations
              </p>
              <p className="whitespace-pre-line text-sm font-normal">{obs}</p>
            </div>
          }
        >
          <span className="flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded-md border border-blue-200 bg-blue-50">
            <MessageSquare className="h-3.5 w-3.5 text-blue-600" />
          </span>
        </Tooltip>
      )}
    </>
  )
}

const COMBINING_MARKS = /[̀-ͯ]/g

function isShipped(f: FiniRoll): boolean {
  if (f.expedition) return true
  const plain = f.etat.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase()
  return plain.startsWith('expedi')
}

/** A sous-traitance order as its own step. The two production orders in a
 *  piece's life share this shape and are tinted to the stage they produce —
 *  green for the ennoblissement that yields the rouleau fini, amber for the
 *  tricotage that yields the tombé de métier — so each order sits visually with
 *  its output instead of reading as one more neutral event row. */
function CommandeCard({
  label, cmd, icon, tone, children,
}: {
  label: string
  cmd: CommandeRef
  icon: ReactNode
  tone: 'ennoblissement' | 'tricotage'
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-dashed px-2.5 py-1.5',
        tone === 'ennoblissement'
          ? 'border-emerald-500/50 bg-emerald-50/50'
          : 'border-amber-400/60 bg-amber-50/50',
      )}
    >
      <p className="flex flex-wrap items-center gap-x-1.5 text-[11px]">
        {icon}
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          n° {cmd.commande}
          {cmd.date_commande && ` du ${formatHfsqlDate(cmd.date_commande)}`}
        </span>
      </p>
      <div className="ml-5">
        <Facts items={[cmd.sous_traitant ? ['Sous-traitant', cmd.sous_traitant] : null]} />
        {children}
      </div>
    </div>
  )
}

const DOT_TONE: Record<'ecru' | 'transfert' | 'fini' | 'expedition' | 'fil', string> = {
  expedition: 'bg-primary',
  fini: 'bg-emerald-600',
  transfert: 'bg-zinc-400',
  ecru: 'bg-amber-500',
  fil: 'bg-stone-400',
}

function Step({
  tone, children,
}: {
  tone: keyof typeof DOT_TONE
  children: ReactNode
}) {
  return (
    <li className="relative">
      <span
        className={cn(
          'absolute -left-[22px] top-3 h-2.5 w-2.5 rounded-full ring-2 ring-white',
          DOT_TONE[tone],
        )}
        aria-hidden
      />
      {children}
    </li>
  )
}

function StageCard({
  icon, tone, title, subtitle, badge, trailing, children,
}: {
  icon: ReactNode
  tone: 'ecru' | 'fini'
  title: string
  subtitle?: string
  badge?: string | null
  trailing?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 border-l-4 bg-zinc-100/80 p-2.5',
        tone === 'ecru' ? 'border-l-amber-400/60' : 'border-l-emerald-500/60',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className={cn(
              'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md',
              tone === 'ecru' ? 'bg-amber-400/10' : 'bg-emerald-500/10',
            )}
          >
            {icon}
          </div>
          <div className="min-w-0">
            {/* Two lines rather than an ellipsis: "029A - Jersey coton bio
                elas" doesn't fit one line at 6 grid columns next to the état
                pill, and the reference is the whole point of the card. */}
            <p className="line-clamp-2 text-sm font-medium leading-snug" title={title}>{title}</p>
            {subtitle && (
              <p className="truncate text-[11px] text-muted-foreground" title={subtitle}>{subtitle}</p>
            )}
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1">
          {trailing}
          {badge && (
            <span
              className={cn(
                'whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium',
                tone === 'ecru' ? 'bg-amber-400/15 text-amber-700' : 'bg-emerald-500/15 text-emerald-700',
              )}
            >
              {badge}
            </span>
          )}
        </div>
      </div>
      <div className="ml-9 mt-2">{children}</div>
    </div>
  )
}

/** Label/value pairs, nulls dropped so an absent fact leaves no empty row.
 *  Values WRAP rather than truncate: at 6 grid columns the label column eats
 *  enough width that "8488 - Tricotage Malterre" would clip to "8488 - Trico…",
 *  and the sous-traitant name is the half worth reading. */
function Facts({ items }: { items: Array<[string, string] | null> }) {
  const rows = items.filter((x): x is [string, string] => x !== null && x[1] !== '')
  if (rows.length === 0) return null
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[11px] leading-snug text-muted-foreground">{k}</dt>
          <dd className="break-words text-[11px] font-medium leading-snug">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function TransfertRow({ t }: { t: Transfert }) {
  return (
    <EventRow
      icon={<Truck className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
      title={`Transfert n° ${t.IDbon_transfert}`}
      date={t.date}
      // No "non validé" tag: `est_valide` doesn't gate the movement — the legacy
      // model applies a bon to the stock immediately — so flagging it here read
      // as a problem where there is none.
    >
      <span className="flex items-center gap-1 truncate">
        {t.de}
        <ArrowRight className="h-3 w-3 flex-shrink-0" />
        {t.vers}
      </span>
    </EventRow>
  )
}

function ExpeditionRow({ e }: { e: Expedition }) {
  return (
    <EventRow
      icon={<Send className="h-3.5 w-3.5 flex-shrink-0 text-primary" />}
      title={`Expédition n° ${e.IDexpedition}`}
      date={e.date}
      // Blue frame, matching the timeline's expédition dot — the same
      // stage-tinting the two commande cards use.
      tone="expedition"
    >
      {/* Sender → recipient, not just the recipient: the écru leg is
          "Tricotage Malterre → Ets Malterre", and printing only the client
          made that shipment look like it went nowhere. */}
      <span className="flex flex-wrap items-center gap-x-1">
        <span className="inline-flex items-center gap-1">
          {e.expediteur}
          <ArrowRight className="h-3 w-3 flex-shrink-0" />
          {e.client ?? '—'}
        </span>
        {e.commande_numero != null && (
          <span className="text-muted-foreground">· commande n° {e.commande_numero}</span>
        )}
      </span>
    </EventRow>
  )
}

function EventRow({
  icon, title, date, tag, tone, children,
}: {
  icon: ReactNode
  title: string
  date: string | null
  tag?: string | null
  /** Tints the dashed frame to the stage. Omitted = neutral (transferts). */
  tone?: 'expedition'
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5',
        tone === 'expedition'
          ? 'border-primary/40 bg-primary/[0.04]'
          : 'border-border/70 bg-white/60',
      )}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-1.5 text-[11px]">
          <span className="font-medium">{title}</span>
          {date && <span className="text-muted-foreground">le {formatHfsqlDate(date)}</span>}
        </p>
        <p className="text-[11px] text-muted-foreground">{children}</p>
      </div>
      {tag && (
        <span className="flex-shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
          {tag}
        </span>
      )}
    </div>
  )
}

/** One yarn of the composition: what it is, which lot, and where that lot
 *  came from (supplier + purchase order). Older lots predate the purchase-order
 *  link, so the order line is conditional. */
function FilRow({ fil }: { fil: Fil }) {
  const origin = [
    fil.lot ? `lot ${fil.lot}` : null,
    fil.fournisseur,
  ].filter(Boolean).join(' · ')
  const order = fil.commande_fil
    ? [
      `Commande fil n° ${fil.commande_fil}`,
      fil.date_commande ? `du ${formatHfsqlDate(fil.date_commande)}` : null,
      fil.date_livraison ? `· livrée le ${formatHfsqlDate(fil.date_livraison)}` : null,
    ].filter(Boolean).join(' ')
    : null
  return (
    <div className="border-l-2 border-stone-300/70 pl-2">
      <p className="flex items-baseline gap-1.5 text-[11px] font-medium leading-snug">
        {fil.pourcentage != null && (
          <span className="whitespace-nowrap tabular-nums text-stone-600">
            {fmtNum(fil.pourcentage)} %
          </span>
        )}
        <span className="break-words">
          {fil.reference}
          {fil.coloris && <span className="font-normal text-muted-foreground"> · {fil.coloris}</span>}
        </span>
      </p>
      {origin && <p className="text-[11px] leading-snug text-muted-foreground">{origin}</p>}
      {order && <p className="text-[11px] leading-snug text-muted-foreground">{order}</p>}
    </div>
  )
}
