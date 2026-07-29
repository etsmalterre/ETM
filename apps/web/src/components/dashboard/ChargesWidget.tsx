// ── Charges widget ────────────────────────────────────────────
// Charges fixes and charges variables for the current year, each against the
// same period of N-1, with the N/N-1 ratio as a traffic-light pill.
//
// Backed by the SAME endpoint as Rapports › Finance (`GET /api/rapports/finance`)
// and summing its `lignes` exactly the way that screen's totals bar does —
// deliberately, so the two can never quote different figures. The endpoint's
// pre-computed `totaux.frais_fixe` / `frais_variable` buckets agree today, but
// the screen is the reference the users read, so the widget follows the screen.
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
import { Wallet, Loader2 } from 'lucide-react'
import { CardContent } from '@/components/ui/card'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate } from '@/lib/dates'
import { PctPill } from '@/lib/depassement'
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

interface Bucket {
  label: string
  montant: number
  precedent: number
  /** Rounded the same way the pill renders it, so colour and number agree. */
  pourcentage: number
}

function eur(v: number): string {
  return `${fmtNum(v, 2)} €`
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

  const buckets = useMemo<Bucket[]>(() => {
    const lignes = query.data?.lignes ?? []
    return ([
      ['Charges fixes', 0],
      ['Charges variables', 1],
    ] as const).map(([label, variable]) => {
      const rows = lignes.filter((l) => l.variable === variable)
      const montant = rows.reduce((s, l) => s + l.montant, 0)
      const precedent = rows.reduce((s, l) => s + l.montant_precedent, 0)
      return {
        label,
        montant,
        precedent,
        pourcentage: precedent ? Math.round((montant / precedent) * 100) : 0,
      }
    })
  }, [query.data])

  const annee = query.data?.annee
  const anneePrec = query.data?.annee_precedente
  const dateArrete = query.data?.date_arrete

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
            {buckets.map((b) => (
              <div
                key={b.label}
                className="rounded-lg border border-border/60 bg-zinc-100/80 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  {/* Label alone on this line: anything else beside it wraps at
                      the widget's narrower widths and shoves the pill out of
                      line with it. */}
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {b.label}
                  </p>
                  {/* Renders nothing when N-1 is empty — "0 %" would read as
                      "spent nothing" rather than "nothing to compare to". */}
                  <PctPill
                    pourcentage={b.pourcentage}
                    precedent={b.precedent}
                    className="flex-shrink-0"
                  />
                </div>
                {/* whitespace-nowrap: a seven-figure total wraps mid-number the
                    moment the widget is dragged narrow. */}
                <p className="whitespace-nowrap text-xl font-bold tabular-nums leading-tight">
                  {eur(b.montant)}
                </p>
                {/* Just the N-1 figure. The compte count used to sit here too,
                    which wrapped this line in two and pushed the footer out of
                    the card at the default height — and it's the least useful
                    number on the card. */}
                <p className="whitespace-nowrap text-xs text-muted-foreground">
                  {anneePrec != null
                    ? <>{anneePrec} : <span className="tabular-nums">{eur(b.precedent)}</span></>
                    // Strictly N-1: with a gap year the endpoint returns no
                    // comparison rather than silently comparing against N-2.
                    : 'Aucune année de comparaison'}
                </p>
              </div>
            ))}

            {/* The arrêté date, not just the year: these are cumulative YTD
                uploads, so "111 604 € en 2026" only means anything alongside
                the date it was stopped at. Same line the report's footer
                shows, for the same reason. */}
            <p className="mt-auto flex-shrink-0 text-[11px] text-muted-foreground">
              {dateArrete
                ? <>Arrêté au {formatHfsqlDate(dateArrete)}</>
                : annee != null && <>Exercice {annee}</>}
              {anneePrec != null && <> · comparé à {anneePrec}</>}
            </p>
          </>
        )}
      </CardContent>
    </WidgetFrame>
  )
}
