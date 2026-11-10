// Qualité › Suivi lots — the right panel's « Journal » tab (Vincent 2026-11-10):
// « Prochaines étapes » on top (moved out of the center body), then what was
// done on the lot, by whom and when, newest first. Read from
// GET /suivi-lots/:id/journal (API lib/journal-lot.ts).

import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  AtSign,
  BellRing,
  Bot,
  CalendarCheck,
  CalendarClock,
  ClipboardCheck,
  FilePlus2,
  Droplets,
  FlaskConical,
  Loader2,
  Lock,
  MailCheck,
  MessageSquareText,
  Palette,
  Ruler,
  RotateCcw,
  Send,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Truck,
  type LucideIcon,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CycleCard, type AttenduLot, type ClientRc, type EtapeLot, type PrealableLot } from './LotCycle'

export interface EntreeJournal {
  le: string
  type: string
  titre: string
  detail: string | null
  par: string | null
  auteur: 'personne' | 'tricobot' | 'inconnu'
  /** Only in an order's journal (Sous-traitants): the lot the line is about. */
  lot?: string | null
}

const LOOK: Record<string, { icon: LucideIcon; color: string }> = {
  reception: { icon: Truck, color: 'text-sky-600 bg-sky-500/10' },
  mesures_ennoblisseur: { icon: Ruler, color: 'text-sky-600 bg-sky-500/10' },
  mesures_malterre: { icon: Ruler, color: 'text-amber-700 bg-amber-500/10' },
  coloris_malterre: { icon: Palette, color: 'text-amber-700 bg-amber-500/10' },
  tirelle_avant_lavage: { icon: FlaskConical, color: 'text-amber-700 bg-amber-500/10' },
  tirelle_apres_lavage: { icon: Droplets, color: 'text-amber-700 bg-amber-500/10' },
  tirelle_jete: { icon: Trash2, color: 'text-zinc-600 bg-zinc-500/10' },
  soumission: { icon: Send, color: 'text-violet-600 bg-violet-500/10' },
  reponse_ok: { icon: ThumbsUp, color: 'text-green-700 bg-green-500/10' },
  reponse_refus: { icon: ThumbsDown, color: 'text-red-600 bg-red-500/10' },
  ok_ramer: { icon: MailCheck, color: 'text-sky-600 bg-sky-500/10' },
  rc: { icon: ClipboardCheck, color: 'text-primary bg-primary/10' },
  reprise: { icon: RotateCcw, color: 'text-orange-600 bg-orange-500/10' },
  etat: { icon: ShieldCheck, color: 'text-green-700 bg-green-500/10' },
  // An order's own lines (Sous-traitants › Ennoblissement).
  creation: { icon: FilePlus2, color: 'text-zinc-600 bg-zinc-500/10' },
  bon_commande: { icon: AtSign, color: 'text-blue-700 bg-blue-500/10' },
  relance: { icon: BellRing, color: 'text-amber-700 bg-amber-500/10' },
  report: { icon: CalendarClock, color: 'text-orange-600 bg-orange-500/10' },
  delai_recu: { icon: CalendarCheck, color: 'text-green-700 bg-green-500/10' },
  point: { icon: MessageSquareText, color: 'text-sky-600 bg-sky-500/10' },
  cloture: { icon: Lock, color: 'text-zinc-600 bg-zinc-500/10' },
}

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
const deux = (n: number) => String(n).padStart(2, '0')

/** « mardi 03/11/2026 » in local time. */
function jourDe(iso: string): string {
  const d = new Date(iso)
  return `${JOURS[d.getDay()]} ${deux(d.getDate())}/${deux(d.getMonth() + 1)}/${d.getFullYear()}`
}

/** « 14:06 », or nothing for a fact known by its day only (stored at midnight UTC). */
function heureDe(iso: string): string {
  if (iso.endsWith('T00:00:00.000Z')) return ''
  const d = new Date(iso)
  return `${deux(d.getHours())}:${deux(d.getMinutes())}`
}

/** « Ce qui a été fait »: the entries grouped by day, newest first. */
export function JournalListe({ entrees, isLoading, error }: {
  entrees: EntreeJournal[]
  isLoading: boolean
  error: unknown
}) {
  // One band per day, newest first (the API already sorts).
  const jours: Array<{ jour: string; items: EntreeJournal[] }> = []
  for (const e of entrees) {
    const j = jourDe(e.le)
    const last = jours[jours.length - 1]
    if (last && last.jour === j) last.items.push(e)
    else jours.push({ jour: j, items: [e] })
  }

  return (
    <section className="space-y-1.5">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-primary/70 px-0.5">Ce qui a été fait</h3>
      {isLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-accent" /></div>
      ) : error ? (
        <p className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />Journal indisponible.</p>
      ) : entrees.length === 0 ? (
        <p className="text-sm text-muted-foreground italic px-0.5">Rien d’enregistré.</p>
      ) : (
        <div className="rounded-lg border bg-card shadow-sm divide-y divide-border/60">
          {jours.map(({ jour, items }) => (
            <div key={jour} className="px-3 py-2">
              <p className="text-[11px] font-semibold text-muted-foreground capitalize mb-1.5">{jour}</p>
              <ol className="space-y-2">
                {items.map((e, i) => {
                  const look = LOOK[e.type] ?? { icon: ClipboardCheck, color: 'text-muted-foreground bg-muted' }
                  const Icon = e.auteur === 'tricobot' ? Bot : look.icon
                  const heure = heureDe(e.le)
                  return (
                    <li key={`${e.le}-${i}`} className="flex items-start gap-2.5">
                      <div className={cn('h-6 w-6 flex-shrink-0 rounded-md flex items-center justify-center', look.color)}>
                        <Icon className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm leading-snug">
                          {e.lot && <span className="font-medium tabular-nums">Lot {e.lot} · </span>}
                          {e.titre}
                        </p>
                        {e.detail && (
                          <p className="text-xs text-muted-foreground truncate" title={e.detail}>{e.detail}</p>
                        )}
                        <p className="text-[11px] text-muted-foreground">
                          {[e.par ? `par ${e.par}` : 'auteur non enregistré', heure].filter(Boolean).join(' · ')}
                        </p>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export function JournalLotTab({
  lotId, etape, prealables, etapes, attendu, clients,
}: {
  lotId: number
  etape: EtapeLot | null | undefined
  prealables: string[]
  etapes?: PrealableLot[]
  attendu?: AttenduLot | null
  clients: ClientRc[]
}) {
  // Under ['suivi-lot', id]: every gesture on the lot already invalidates it.
  const { data, isLoading, error } = useQuery({
    queryKey: ['suivi-lot', lotId, 'journal'],
    queryFn: () => apiFetch<{ entrees: EntreeJournal[] }>(`/suivi-lots/${lotId}/journal`),
    // The reception and the lab tablet write it from other screens.
    staleTime: 0,
    refetchOnMount: 'always',
  })

  return (
    <>
      {etape && (
        <section className="space-y-1.5">
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-primary/70 px-0.5">Prochaines étapes</h3>
          <CycleCard etape={etape} prealables={prealables} etapes={etapes} attendu={attendu} clients={clients} />
        </section>
      )}
      <JournalListe entrees={data?.entrees ?? []} isLoading={isLoading} error={error} />
    </>
  )
}
