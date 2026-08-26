// ── Charges widget ────────────────────────────────────────────
// Charges fixes and charges variables for the current year, read as a RYTHME:
// how much of last year's whole envelope is already spent, against how much of
// the year has actually been lived.
//
// ── The question this card answers (2026-08-26, user's own words) ──
// « Si les charges fixes sont à 50 % à la moitié de l'année, on est bon ; moins,
// c'est encore mieux ; plus, il y a un problème à investiguer. » So the useful
// number was never the raw N/N-1 ratio — 19 % in March means nothing on its own
// — it is the ratio MINUS the share of the year elapsed. That difference, in
// points, is what the pill carries and what the gauge draws: the fill is what
// is consumed, the vertical tick is the repère, and everything to the left of
// the tick is money not yet spent.
//
// The two buckets do NOT get the same verdict scale, on purpose. Charges FIXES
// above the pace mean a fixed cost grew and someone should go look. Charges
// VARIABLES above the pace usually mean the company simply produced more — the
// user said as much — so they wear an informative blue and never an alert
// colour. Painting both red would teach the reader to ignore the colour on both
// cards.
//
// ── Same numbers as Rapports › Finance, a different question ──
// Backed by the SAME endpoint (`GET /api/rapports/finance`) and summing its
// `lignes` exactly the way that screen's totals bar does — deliberately, so the
// two can never quote different figures. The endpoint's pre-computed
// `totaux.frais_fixe` / `frais_variable` buckets agree today, but the screen is
// the reference the users read, so the widget follows the screen.
//
// The report's own per-compte pill stays the raw N/N-1 ratio (`lib/depassement`
// — « ce compte a-t-il dépassé l'an dernier ? »). This widget asks « sommes-nous
// dans les clous à cette date ? ». Two readings of the same two numbers; do not
// unify them without deciding which question the report should be asking.
//
// The payload is the full compte list (82 lines / ~15 KB here), which is small
// enough that a dedicated endpoint would buy nothing but a second place for the
// aggregation to drift.
//
// Gated on `view_rapport_finance` — the same right that governs the report, and
// what the endpoint itself enforces. A separate dashboard key would only create
// a state where the widget is visible and the data 403s.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Wallet, Loader2, ArrowUp, ArrowDown, Minus } from 'lucide-react'
import { CardContent } from '@/components/ui/card'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { WidgetFrame } from './WidgetFrame'

interface FinanceLine {
  variable: 0 | 1
  montant: number
  montant_precedent: number
}
interface FinanceResponse {
  annee: number | null
  annee_precedente: number | null
  date_arrete: string | null
  lignes: FinanceLine[]
}

// ── Le rythme ─────────────────────────────────────────────────
//
// Les deux seuils sont en POINTS de pourcentage, pas en euros : l'écart est
// déjà normalisé par le total N-1, donc un seuil en points se lit pareil sur un
// poste à 600 k€ et sur un poste à 10 k€.

/** En deçà, l'écart est du bruit : les uploads tombent une fois par semaine et
 *  une prime ou une facture d'assurance décalée de quinze jours en vaut deux ou
 *  trois. Un widget qui vire à l'orange là-dessus cesse d'être lu. */
const TOLERANCE_PTS = 3
/** Au-delà, ce n'est plus « à surveiller » : si le rythme tient, l'exercice
 *  finit dix points au-dessus du précédent, ce qui est un vrai sujet. */
const ALERTE_PTS = 10
/** Sous ce niveau d'année écoulée, extrapoler amplifie le bruit (×12 en
 *  janvier) — la projection n'est alors pas proposée. */
const PROJECTION_MIN_ECOULE = 12

type Rythme = 'economie' | 'conforme' | 'surveiller' | 'investiguer' | 'activite' | 'ralenti'

/** Le verdict. Échelle d'alerte sur les charges FIXES uniquement — voir l'en-
 *  tête du fichier pour la raison. */
function rythmeDe(ecart: number, variable: boolean): Rythme {
  // Les charges variables ont les trois mêmes ÉTATS que les fixes — dessous,
  // dedans, dessus — mais aucun n'est une alerte : c'est l'activité qu'on lit.
  // (Sans l'état « ralenti », un poste variable cinq points sous le rythme
  // affichait « au rythme », ce qui est faux.)
  if (variable) {
    if (ecart > TOLERANCE_PTS) return 'activite'
    return ecart < -TOLERANCE_PTS ? 'ralenti' : 'conforme'
  }
  if (ecart < -TOLERANCE_PTS) return 'economie'
  if (ecart <= TOLERANCE_PTS) return 'conforme'
  return ecart <= ALERTE_PTS ? 'surveiller' : 'investiguer'
}

/** Pastille — même langage d'intensité que `lib/depassement`, étendu du bleu
 *  informatif que les charges variables réclament. */
const RYTHME_PILL: Record<Rythme, string> = {
  economie: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  conforme: 'bg-zinc-100 text-zinc-700 border-zinc-300',
  surveiller: 'bg-amber-100 text-amber-800 border-amber-200',
  investiguer: 'bg-red-100 text-red-700 border-red-200',
  activite: 'bg-sky-100 text-sky-800 border-sky-200',
  ralenti: 'bg-sky-100 text-sky-800 border-sky-200',
}

/** Remplissage de la jauge — la version pleine de la même teinte. */
const RYTHME_FILL: Record<Rythme, string> = {
  economie: 'bg-emerald-500',
  conforme: 'bg-zinc-500',
  surveiller: 'bg-amber-500',
  investiguer: 'bg-red-500',
  activite: 'bg-sky-500',
  ralenti: 'bg-sky-500',
}

const RYTHME_TEXT: Record<Rythme, string> = {
  economie: 'text-emerald-700',
  conforme: 'text-muted-foreground',
  surveiller: 'text-amber-700',
  investiguer: 'text-red-700',
  activite: 'text-sky-700',
  ralenti: 'text-sky-700',
}

/** « 1 pt », « 2 pts » — l'écart tombe souvent à un point, et le pluriel fautif
 *  saute aux yeux sur une carte qui ne dit que quatre choses. */
function pluralPts(n: number): string {
  return Math.abs(n) > 1 ? 'pts' : 'pt'
}
function pluralPoints(n: number): string {
  return Math.abs(n) > 1 ? 'points' : 'point'
}

/** Le mot que le lecteur retient. Court : il partage sa ligne avec le montant
 *  N-1, et la carte descend à trois colonnes de large. */
const RYTHME_MOT: Record<Rythme, string> = {
  economie: 'sous le rythme',
  conforme: 'au rythme',
  surveiller: 'à surveiller',
  investiguer: 'à investiguer',
  activite: 'activité en hausse',
  ralenti: 'sous le rythme',
}

interface Bucket {
  label: string
  variable: boolean
  montant: number
  precedent: number
  /** montant / precedent en %. Null sans N-1 — « 0 % » se lirait « rien
   *  dépensé » plutôt que « rien à quoi comparer ». */
  pourcentage: number | null
  /** Points de rythme : pourcentage − part de l'année écoulée. Null sans N-1
   *  ou sans date d'arrêté. */
  ecart: number | null
  rythme: Rythme | null
  /** Ce que l'exercice ferait si le rythme tenait jusqu'au 31/12. Null quand
   *  l'année est trop jeune pour extrapoler. */
  projection: number | null
}

function eur(v: number): string {
  return `${fmtNum(v, 2)} €`
}
function eur0(v: number): string {
  return `${fmtNum(v, 0)} €`
}

/** Part de l'année civile écoulée à une date HFSQL (YYYYMMDD), en %.
 *
 *  Tout en UTC : une date construite à minuit local retombe la veille autour
 *  d'un changement d'heure, et le repère glisserait d'un jour. La date d'arrêté
 *  est INCLUSIVE — l'upload porte les mouvements de ce jour-là — donc le jour
 *  lui-même compte comme vécu. */
function partAnneeEcoulee(hfsql: string | null | undefined): number | null {
  if (!hfsql || !/^\d{8}$/.test(hfsql)) return null
  const annee = Number(hfsql.slice(0, 4))
  const mois = Number(hfsql.slice(4, 6))
  const jour = Number(hfsql.slice(6, 8))
  if (!mois || !jour) return null
  const debut = Date.UTC(annee, 0, 1)
  const fin = Date.UTC(annee + 1, 0, 1)
  const a = Date.UTC(annee, mois - 1, jour + 1)
  return Math.min(100, Math.max(0, ((a - debut) / (fin - debut)) * 100))
}

/** La phrase complète, portée par la pastille et par la jauge. C'est là que vit
 *  l'explication : la carte, elle, ne montre que des nombres. */
function titreRythme(b: Bucket, anneePrec: number | null, ecoule: number | null): string {
  if (b.ecart == null || b.pourcentage == null || ecoule == null) return ''
  const pts = Math.abs(Math.round(b.ecart))
  const base =
    `${Math.round(b.pourcentage)} % du total ${anneePrec ?? 'N-1'} consommé` +
    ` pour ${Math.round(ecoule)} % de l’année écoulée`
  const p = pluralPoints(pts)
  const verdict =
    b.rythme === 'economie'
      ? `${pts} ${p} d’avance`
      : b.rythme === 'conforme'
        ? `${pts} ${p} d’écart, dans la tolérance`
        : b.rythme === 'activite'
          ? `${pts} ${p} au-dessus du rythme, ce qui traduit d’abord une activité plus forte sur des charges variables`
          : b.rythme === 'ralenti'
            ? `${pts} ${p} sous le rythme, ce qui suit d’abord le volume produit sur des charges variables`
            : b.rythme === 'surveiller'
              ? `${pts} ${p} au-dessus du rythme, à surveiller`
              : `${pts} ${p} au-dessus du rythme, à investiguer`
  const projection =
    b.projection != null
      ? ` Projection à fin d’exercice si le rythme tient : ${eur0(b.projection)}.`
      : ''
  return `${base} — ${verdict}.${projection}`
}

function EcartPill({ bucket, title }: { bucket: Bucket; title: string }) {
  if (bucket.ecart == null || bucket.rythme == null) return null
  const pts = Math.round(bucket.ecart)
  const Icon = pts > 0 ? ArrowUp : pts < 0 ? ArrowDown : Minus
  return (
    <span
      title={title}
      className={cn(
        'inline-flex flex-shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
        RYTHME_PILL[bucket.rythme],
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {/* La flèche porte déjà le sens, et le signe le répète : couleur et icône
          ne doivent jamais être le seul canal. */}
      {pts > 0 ? '+' : pts < 0 ? '−' : ''}
      {Math.abs(pts)} {pluralPts(pts)}
    </span>
  )
}

export function ChargesWidget() {
  // Shared cache key with the Rapports › Finance screen: opening one warms the
  // other, and they are guaranteed to be looking at the same response.
  const query = useQuery<FinanceResponse>({
    queryKey: ['rapport-finance', null],
    queryFn: () => apiFetch('/rapports/finance'),
    // Same options as the report: fresh on every mount, but never on window
    // focus — this aggregate hits the shared HFSQL bridge and a dashboard left
    // open all day would re-run it on every tab switch.
    staleTime: 0,
    refetchOnWindowFocus: false,
  })

  const annee = query.data?.annee
  const anneePrec = query.data?.annee_precedente
  const dateArrete = query.data?.date_arrete

  /** Le repère : la part de l'année civile vécue à la DATE D'ARRÊTÉ, pas à
   *  aujourd'hui. Les deux peuvent être très éloignées — le dernier upload de
   *  l'expert-comptable peut dater de plusieurs mois — et c'est bien la date
   *  des montants qui doit borner la comparaison, sinon le rythme paraît
   *  faussement bon. */
  const ecoule = useMemo(() => partAnneeEcoulee(dateArrete), [dateArrete])

  const buckets = useMemo<Bucket[]>(() => {
    const lignes = query.data?.lignes ?? []
    return ([
      ['Charges fixes', 0],
      ['Charges variables', 1],
    ] as const).map(([label, variable]) => {
      const rows = lignes.filter((l) => l.variable === variable)
      const montant = rows.reduce((s, l) => s + l.montant, 0)
      const precedent = rows.reduce((s, l) => s + l.montant_precedent, 0)
      const pourcentage = precedent > 0 ? (montant / precedent) * 100 : null
      // L'écart se calcule sur les valeurs ARRONDIES, celles qui sont
      // affichées : la couleur ne peut alors jamais contredire les nombres à
      // côté d'elle. Même discipline que `depassement()`.
      const ecart =
        pourcentage != null && ecoule != null
          ? Math.round(pourcentage) - Math.round(ecoule)
          : null
      return {
        label,
        variable: variable === 1,
        montant,
        precedent,
        pourcentage,
        ecart,
        rythme: ecart != null ? rythmeDe(ecart, variable === 1) : null,
        projection:
          ecoule != null && ecoule >= PROJECTION_MIN_ECOULE && precedent > 0
            ? (montant / ecoule) * 100
            : null,
      }
    })
  }, [query.data, ecoule])

  return (
    <WidgetFrame icon={Wallet} title="Charges">
      <CardContent className="flex h-full flex-col gap-2 p-3">
        {query.isLoading && (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
          </div>
        )}

        {query.isError && (
          <p className="py-8 text-center text-sm text-destructive">
            Impossible de charger les charges.
          </p>
        )}

        {!query.isLoading && !query.isError && (
          <>
            {buckets.map((b) => {
              const titre = titreRythme(b, anneePrec ?? null, ecoule)
              return (
                <div
                  key={b.label}
                  className="rounded-lg border border-border/60 bg-zinc-100/80 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    {/* Label alone on this line: anything else beside it wraps at
                        the widget's narrower widths and shoves the pill out of
                        line with it. */}
                    <p className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
                      {b.label}
                    </p>
                    <EcartPill bucket={b} title={titre} />
                  </div>

                  <div className="flex items-baseline justify-between gap-2">
                    {/* whitespace-nowrap: a seven-figure total wraps mid-number
                        the moment the widget is dragged narrow. */}
                    <p className="whitespace-nowrap text-xl font-bold tabular-nums leading-tight">
                      {eur(b.montant)}
                    </p>
                    {b.pourcentage != null && (
                      <p
                        className={cn(
                          'flex-shrink-0 text-sm font-semibold tabular-nums',
                          b.rythme ? RYTHME_TEXT[b.rythme] : 'text-muted-foreground',
                        )}
                        title={titre}
                      >
                        {Math.round(b.pourcentage)} %
                      </p>
                    )}
                  </div>

                  {/* La jauge. Le remplissage est ce qui est CONSOMMÉ du total
                      N-1 ; le trait vertical est le repère, la part de l'année
                      écoulée. Tout est là : à gauche du trait on est en avance,
                      à droite on est en retard. L'échelle est fixe (0 → 100 %
                      de N-1) sur les deux cartes, sinon elles cesseraient de se
                      comparer entre elles ; un dépassement remplit la jauge et
                      c'est la pastille qui en porte l'ampleur. */}
                  {b.pourcentage != null && (
                    <div className="relative mb-1.5 mt-2 h-2 rounded-full bg-zinc-200" title={titre}>
                      <div
                        className={cn(
                          'h-2 rounded-full',
                          b.rythme ? RYTHME_FILL[b.rythme] : 'bg-zinc-500',
                        )}
                        style={{ width: `${Math.min(100, Math.max(0, b.pourcentage))}%` }}
                      />
                      {ecoule != null && (
                        <span
                          aria-hidden
                          className="absolute -top-1.5 h-5 w-[3px] rounded-full bg-primary ring-1 ring-white"
                          style={{ left: `calc(${ecoule}% - 1px)` }}
                        />
                      )}
                    </div>
                  )}

                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-xs text-muted-foreground">
                      {anneePrec != null
                        ? <>{anneePrec} : <span className="tabular-nums">{eur(b.precedent)}</span></>
                        // Strictly N-1: with a gap year the endpoint returns no
                        // comparison rather than silently comparing against N-2.
                        : 'Aucune année de comparaison'}
                    </p>
                    {b.rythme && (
                      <p
                        className={cn(
                          'flex-shrink-0 text-[11px] font-medium',
                          RYTHME_TEXT[b.rythme],
                        )}
                      >
                        {RYTHME_MOT[b.rythme]}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}

            {/* Ce que le trait vertical veut dire, écrit une fois pour les deux
                jauges — et la date, pas seulement l'année : ce sont des soldes
                cumulés, donc « 111 604 € en 2026 » ne dit rien sans la date à
                laquelle on s'est arrêté. Même ligne que le pied du rapport, pour
                la même raison. */}
            <p className="mt-auto flex-shrink-0 text-[11px] leading-snug text-muted-foreground">
              {ecoule != null && dateArrete ? (
                <>
                  Repère{' '}
                  <span className="inline-block h-2.5 w-[3px] translate-y-px rounded-full bg-primary align-middle" />
                  {' : '}
                  {Math.round(ecoule)} % de l’année écoulée au {formatHfsqlDate(dateArrete)}
                </>
              ) : dateArrete ? (
                <>Arrêté au {formatHfsqlDate(dateArrete)}</>
              ) : (
                annee != null && <>Exercice {annee}</>
              )}
              {anneePrec != null && <> · comparé à {anneePrec} en entier</>}
            </p>
          </>
        )}
      </CardContent>
    </WidgetFrame>
  )
}
