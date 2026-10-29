// Sous-traitants › Gestion › Qualité de service: one dot per order (or line) over time, its délai in working
// days, against a dashed target line (Vincent 2026-10-29: the dyer's délai standard, the 3-day answer
// threshold). Single series: no legend box, the card title names it; a hollow dot = still open (no answer,
// nothing received), counted up to today. Drawn at real size (useElementSize), hover = nearest dot's tooltip.
import { useMemo, useState } from 'react'
import { useElementSize } from '@/hooks/useElementSize'
import { cn } from '@/lib/utils'

export interface PointDelai {
  key: string | number
  /** YYYY-MM-DD */
  date: string
  jours: number
  /** still open: hollow dot */
  ouvert: boolean
  /** tooltip lines */
  infos: string[]
}

const H = 180
const M = { top: 12, right: 12, bottom: 22, left: 30 }
const DAY = 86_400_000
const t = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))
const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

export function GrapheDelais({ points, cible, legendeOuvert }: {
  points: PointDelai[]
  /** the dashed target, e.g. { jours: 15, libelle: 'Standard 15 j' } */
  cible?: { jours: number; libelle: string }
  /** what a hollow dot means, e.g. « en attente » */
  legendeOuvert: string
}) {
  const [ref, { w }] = useElementSize<HTMLDivElement>()
  const [survol, setSurvol] = useState<PointDelai | null>(null)

  const g = useMemo(() => {
    if (points.length === 0 || w <= 0) return null
    const xs = points.map((p) => t(p.date))
    let x0 = Math.min(...xs), x1 = Math.max(...xs)
    if (x1 - x0 < 14 * DAY) { x0 -= 7 * DAY; x1 += 7 * DAY }
    const ymax = Math.max(...points.map((p) => p.jours), cible?.jours ?? 0, 1) * 1.15
    const iw = w - M.left - M.right, ih = H - M.top - M.bottom
    const sx = (v: number) => M.left + ((v - x0) / (x1 - x0)) * iw
    const sy = (v: number) => M.top + ih - (v / ymax) * ih
    // ~4 round y ticks
    const pas = [1, 2, 5, 10, 20, 50].find((p) => ymax / p <= 4) ?? 100
    const yticks: number[] = []
    for (let v = 0; v <= ymax; v += pas) yticks.push(v)
    // month ticks, thinned to fit
    const mois: { x: number; label: string }[] = []
    const d = new Date(x0); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1)
    while (d.getTime() <= x1) { mois.push({ x: sx(d.getTime()), label: MOIS[d.getUTCMonth()] }); d.setUTCMonth(d.getUTCMonth() + 1) }
    const saut = Math.max(1, Math.ceil(mois.length / Math.max(1, Math.floor(iw / 56))))
    // Monthly median (once there are enough dots to hide the trend): the solid line read over the dots.
    const parMois = new Map<string, number[]>()
    for (const p of points) parMois.set(p.date.slice(0, 7), [...(parMois.get(p.date.slice(0, 7)) ?? []), p.jours])
    const mediane = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
    const medianes = points.length >= 30 && parMois.size >= 2
      ? [...parMois.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => ({ x: sx(t(`${m}-15`)), y: sy(mediane(v)), n: v.length }))
      : []
    return { sx, sy, yticks, mois: mois.filter((_, i) => i % saut === 0), iw, ih, medianes }
  }, [points, cible, w])

  const proche = (mx: number, my: number) => {
    if (!g) return null
    let best: PointDelai | null = null, dmin = 18 * 18
    for (const p of points) {
      const dx = g.sx(t(p.date)) - mx, dy = g.sy(p.jours) - my
      const d2 = dx * dx + dy * dy
      if (d2 < dmin) { dmin = d2; best = p }
    }
    return best
  }

  return (
    <div className="space-y-1">
      <div ref={ref} className="relative w-full" style={{ height: H }}>
        {g && (
          <svg width={w} height={H} className="block"
            onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setSurvol(proche(e.clientX - r.left, e.clientY - r.top)) }}
            onMouseLeave={() => setSurvol(null)}>
            {g.yticks.map((v) => (
              <g key={v}>
                <line x1={M.left} x2={w - M.right} y1={g.sy(v)} y2={g.sy(v)} className="stroke-border" strokeWidth={1} />
                <text x={M.left - 6} y={g.sy(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">{v}</text>
              </g>
            ))}
            {g.mois.map((m) => (
              <text key={m.x} x={m.x} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">{m.label}</text>
            ))}
            {points.map((p) => {
              const actif = survol?.key === p.key
              // Many dots: smaller and lighter, the median line carries the reading.
              const dense = g.medianes.length > 0
              return (
                <circle key={p.key} cx={g.sx(t(p.date))} cy={g.sy(p.jours)} r={actif ? 5.5 : dense ? 3 : 4}
                  className={p.ouvert ? 'fill-background stroke-primary' : cn(dense && !actif ? 'fill-primary/35' : 'fill-primary', 'stroke-background')}
                  strokeWidth={dense ? 1 : 2} />
              )
            })}
            {g.medianes.length > 0 && (
              <path d={g.medianes.map((m, i) => `${i ? 'L' : 'M'}${m.x},${m.y}`).join(' ')} fill="none"
                className="stroke-primary" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            )}
            {cible && (
              <g>
                <line x1={M.left} x2={w - M.right} y1={g.sy(cible.jours)} y2={g.sy(cible.jours)}
                  className="stroke-foreground/70" strokeWidth={1.5} strokeDasharray="5 4" />
                {/* Left, over a surface halo, so the dots never hide it. */}
                <text x={M.left + 4} y={g.sy(cible.jours) - 5} className="fill-foreground text-[10px] font-semibold stroke-background"
                  strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">{cible.libelle}</text>
              </g>
            )}
          </svg>
        )}
        {g && survol && (
          <div className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md whitespace-nowrap"
            style={{
              left: Math.min(g.sx(t(survol.date)) + 10, Math.max(0, w - 200)),
              top: Math.max(0, g.sy(survol.jours) - 10),
            }}>
            {survol.infos.map((l, i) => <p key={i} className={i === 0 ? 'font-semibold' : 'text-muted-foreground'}>{l}</p>)}
          </div>
        )}
      </div>
      <p className="flex items-center gap-3 text-[10px] text-muted-foreground pl-[30px]">
        <span>Jours ouvrés</span>
        {g && g.medianes.length > 0 && (
          <span className="inline-flex items-center gap-1"><svg width="14" height="6"><line x1="0" x2="14" y1="3" y2="3" className="stroke-primary" strokeWidth={2} /></svg>médiane du mois</span>
        )}
        <span className="inline-flex items-center gap-1"><svg width="10" height="10"><circle cx="5" cy="5" r="3.5" className="fill-background stroke-primary" strokeWidth={1.5} /></svg>{legendeOuvert}</span>
      </p>
    </div>
  )
}
