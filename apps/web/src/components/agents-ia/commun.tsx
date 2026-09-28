// Agents IA — what the two screens share: Agents (pages/AgentsIa.tsx, LLM
// agents) and Automates (pages/Automates.tsx, deterministic scripts). Same
// engine server-side (lib/agents/scheduler.ts), same mode pill, same
// « Lancer maintenant » that answers at once and is polled until it ends.

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ChevronUp, CircleSlash, FlaskConical, Loader2, Power } from 'lucide-react'
import { apiFetch, API_URL } from '@/lib/api'
import { cn } from '@/lib/utils'

export type Mode = 'off' | 'essai' | 'actif'

/** A manual launch (scheduler.ts `Lancement`). */
export interface Lancement {
  id: string
  debut: string
  fin: string | null
  runs: Array<{ id: string; statut: string; resume: string }>
  erreur: string | null
}

export interface Sondage {
  dernierSondage: string | null
  dernierSucces: string | null
  derniereErreur: string | null
  dernierLancement: Lancement | null
  enCours: boolean
}

/** fetch that keeps the API's French `error` message (apiFetch drops it). */
export async function callApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: init?.body instanceof FormData ? init?.headers : { 'Content-Type': 'application/json', ...init?.headers },
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(json?.error || `Erreur HTTP ${res.status}`)
  return json as T
}

export const fmtDateHeure = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—'

export function ilYA(iso: string | null | undefined): string {
  if (!iso) return 'jamais'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'à l’instant'
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`
  if (s < 86_400) return `il y a ${Math.round(s / 3600)} h`
  return fmtDateHeure(iso)
}

export const fmtDateCourte = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

// Per-agent / per-automate mode descriptions come from their catalog.
export const MODE_META: Record<Mode, { label: string; icon: ComponentType<{ className?: string }>; solid: string }> = {
  off: { label: 'À l’arrêt', icon: CircleSlash, solid: 'bg-zinc-500 border-zinc-500' },
  essai: { label: 'En essai', icon: FlaskConical, solid: 'bg-sky-600 border-sky-600' },
  actif: { label: 'En service', icon: Power, solid: 'bg-success border-success' },
}
export const MODE_ORDER: Mode[] = ['off', 'essai', 'actif']

export function KV({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-sm text-right truncate', mono && 'tabular-nums')}>{value}</span>
    </div>
  )
}

/** §29.4 multi-state status footer — the mode of an agent or an automate. */
export function ModeFooter({ current, descriptions, onChange, isChanging, disabled }: {
  current: Mode; descriptions: Partial<Record<Mode, string>>; onChange: (m: Mode) => void; isChanging: boolean; disabled: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const meta = MODE_META[current]
  const Icon = meta.icon
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  return (
    <div ref={rootRef} className="flex-shrink-0 relative">
      <div className={cn('rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11', meta.solid)}>
        <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
          <Icon className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-bold uppercase tracking-wide truncate">{meta.label}</span>
        </div>
        <button type="button" onClick={() => setMenuOpen((v) => !v)} disabled={disabled || isChanging}
          title={disabled ? 'Droit « Piloter les agents IA et les automates » requis' : 'Changer le mode'}
          className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors">
          {isChanging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronUp className={cn('h-3.5 w-3.5 transition-transform', menuOpen && 'rotate-180')} />}
          Changer
        </button>
      </div>
      {menuOpen && (
        <div className="absolute bottom-full right-0 mb-1 w-full min-w-[220px] rounded-lg border bg-white shadow-lg overflow-hidden z-50">
          {MODE_ORDER.filter((m) => descriptions[m]).map((m) => {
            const mm = MODE_META[m]
            const active = current === m
            const MIcon = mm.icon
            return (
              <button key={m} type="button" onClick={() => { if (!active) onChange(m); setMenuOpen(false) }}
                className={cn('w-full flex items-start gap-2 px-3 py-2 text-sm text-left transition-colors',
                  active ? 'bg-accent/10 text-accent cursor-default' : 'hover:bg-zinc-100')}>
                <MIcon className="h-4 w-4 mt-0.5" />
                <span className="flex-1">
                  <span className="block">{mm.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{descriptions[m]}</span>
                </span>
                {active && <CheckCircle2 className="h-4 w-4 ml-auto text-accent" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** « Lancer maintenant »: the POST answers 202 with a launch id at once (a run
 *  can outlast nginx's 60 s); this polls the detail every 2 s until that
 *  launch has ended, then calls `onFin` with it — null when it vanished (API
 *  restarted mid-run). The polling query is keyed on the launch id, so it only
 *  sees answers fetched AFTER the POST. */
export function useLancement<T extends { sondage: Sondage }>({ detailKey, detailPath, onFin }: {
  detailKey: readonly unknown[]
  detailPath: string | null
  onFin: (l: Lancement | null, suivi: T) => void
}) {
  const queryClient = useQueryClient()
  const [attente, setAttente] = useState<string | null>(null)
  const onFinRef = useRef(onFin)
  useEffect(() => { onFinRef.current = onFin })

  const { data: suivi } = useQuery({
    queryKey: [...detailKey, 'lancement', attente],
    queryFn: () => apiFetch<T>(detailPath!),
    enabled: attente !== null && detailPath !== null,
    refetchInterval: 2_000,
    gcTime: 0,
  })

  useEffect(() => {
    if (!suivi || attente === null) return
    queryClient.setQueryData(detailKey, suivi)
    const l = suivi.sondage.dernierLancement
    if (l?.id === attente && !l.fin) return
    if (l?.id !== attente && suivi.sondage.enCours) return
    setAttente(null)
    onFinRef.current(l?.id === attente ? l : null, suivi)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suivi, attente])

  return { enAttente: attente !== null, attendre: setAttente, abandonner: () => setAttente(null) }
}
