// Monthly workload of one employee — RH › Charge de travail. Three lines:
// hours of tasks, the part to automate, the part already automated. Each
// point is the average week of the month (apps/api/src/lib/rh-charge.ts
// evolutionMensuelle). A gold dot marks a month with a relevé; months before
// the first relevé sit on a grey band; the running month is drawn dashed.
//
// Hand-written SVG like EvolutionCaWidget (no chart library in the app).
// Colours: lib/rh.ts COULEURS (validated). Legend + tooltip name every line,
// so identity never rests on colour alone.

import { useMemo, useState } from 'react'
import { useElementSize } from '@/hooks/useElementSize'
import { fmtNum } from '@/lib/format'
import { COULEURS, MOIS_COURT, formatDateFr, moisLong, type PointMensuel } from '@/lib/rh'

const H = 220
const M = { top: 14, right: 16, bottom: 26, left: 40 }

const fmtH = (h: number) => `${fmtNum(h, Math.abs(h - Math.round(h)) < 0.05 ? 0 : 1)} h`

interface Ligne {
  key: 'taches' | 'aAutomatiser' | 'automatise'
  label: string
  color: string
}

export function ChargeCourbe({ points }: { points: PointMensuel[] }) {
  const [ref, { w }] = useElementSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  const lignes = useMemo<Ligne[]>(() => {
    const l: Ligne[] = [
      { key: 'taches', label: 'Tâches', color: COULEURS.taches },
      { key: 'aAutomatiser', label: 'dont à automatiser', color: COULEURS.aAutomatiser },
    ]
    if (points.some((p) => p.automatise > 0)) l.push({ key: 'automatise', label: 'dont automatisé', color: COULEURS.automatise })
    return l
  }, [points])

  const geo = useMemo(() => {
    const max = Math.max(5, ...points.map((p) => p.taches))
    const pas = max > 20 ? 10 : 5
    const yMax = Math.ceil((max * 1.1) / pas) * pas
    const plotW = Math.max(0, w - M.left - M.right)
    const plotH = H - M.top - M.bottom
    const step = points.length > 1 ? plotW / (points.length - 1) : 0
    const x = (i: number) => (points.length > 1 ? M.left + i * step : M.left + plotW / 2)
    const y = (h: number) => M.top + plotH - (h / yMax) * plotH
    return { yMax, pas, plotH, step, x, y }
  }, [points, w])

  const premierIdx = points.findIndex((p) => !p.avantPremierReleve)
  const hp = hover !== null ? points[hover] : null

  /** Path of one line; the last segment dashed when the month is running. */
  const chemins = (key: Ligne['key']) => {
    const pts = points.map((p, i) => `${geo.x(i)},${geo.y(p[key])}`)
    const enCours = points.length > 1 && points[points.length - 1].enCours
    const plein = enCours ? pts.slice(0, -1) : pts
    return {
      plein: plein.length > 1 ? `M${plein.join(' L')}` : '',
      pointille: enCours ? `M${pts[pts.length - 2]} L${pts[pts.length - 1]}` : '',
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {lignes.map((l) => (
          <span key={l.key} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="w-4 h-0.5 rounded-full" style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-gold" />mise à jour de la charge
        </span>
      </div>

      <div ref={ref} className="relative w-full" style={{ height: H }} onMouseLeave={() => setHover(null)}>
        {w > 0 && points.length > 0 && (
          <svg width={w} height={H} role="img" aria-label="Évolution mensuelle de la charge de travail">
            {premierIdx > 0 && (
              <rect x={M.left} y={M.top} width={geo.x(premierIdx) - M.left} height={geo.plotH} fill="#f4f4f5" />
            )}
            {Array.from({ length: geo.yMax / geo.pas + 1 }, (_, i) => i * geo.pas).map((h) => (
              <g key={h}>
                <line x1={M.left} x2={w - M.right} y1={geo.y(h)} y2={geo.y(h)} stroke="#e4e4e7" strokeWidth={1} />
                <text x={M.left - 6} y={geo.y(h)} textAnchor="end" dominantBaseline="middle" fontSize={10} className="fill-muted-foreground">
                  {h} h
                </text>
              </g>
            ))}
            {hover !== null && (
              <line x1={geo.x(hover)} x2={geo.x(hover)} y1={M.top} y2={M.top + geo.plotH} stroke="#a1a1aa" strokeWidth={1} />
            )}

            {lignes.map((l) => {
              const c = chemins(l.key)
              return (
                <g key={l.key}>
                  {c.plein && <path d={c.plein} fill="none" stroke={l.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
                  {c.pointille && <path d={c.pointille} fill="none" stroke={l.color} strokeWidth={2} strokeDasharray="4 4" />}
                  {points.map((p, i) => (
                    <circle
                      key={p.mois}
                      cx={geo.x(i)}
                      cy={geo.y(p[l.key])}
                      r={hover === i ? 4.5 : 3}
                      fill={p.avantPremierReleve ? 'white' : l.color}
                      stroke={l.color}
                      strokeWidth={p.avantPremierReleve ? 1.5 : 0}
                    />
                  ))}
                </g>
              )
            })}

            {/* Relevés: a gold dot ringed in white on the Tâches line */}
            {points.map((p, i) => p.releves.length > 0 && (
              <circle key={`r-${p.mois}`} cx={geo.x(i)} cy={geo.y(p.taches)} r={5.5} fill="hsl(var(--gold))" stroke="white" strokeWidth={2} />
            ))}

            {points.map((p, i) => {
              // Every month when there is room, else every other one.
              if (geo.step < 34 && i % 2 === 1 && i !== points.length - 1) return null
              const m = Number(p.mois.slice(5, 7)) - 1
              const label = m === 0 || i === 0 ? `${MOIS_COURT[m]} ${p.mois.slice(2, 4)}` : MOIS_COURT[m]
              return (
                <text key={`m-${p.mois}`} x={geo.x(i)} y={H - 8} textAnchor="middle" fontSize={10} className="fill-muted-foreground">
                  {label}
                </text>
              )
            })}

            {points.map((p, i) => (
              <rect
                key={`hit-${p.mois}`}
                x={geo.x(i) - Math.max(geo.step, 24) / 2}
                y={M.top}
                width={Math.max(geo.step, 24)}
                height={geo.plotH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            ))}
          </svg>
        )}

        {hp && hover !== null && (
          <div
            className="pointer-events-none absolute z-10 w-56 rounded-lg border bg-white shadow-lg p-2.5 text-xs"
            style={{ top: 0, left: Math.min(Math.max(0, geo.x(hover) + 12), Math.max(0, w - 224)) }}
          >
            <p className="font-semibold capitalize">{moisLong(hp.mois)}</p>
            {hp.enCours && <p className="text-[11px] text-muted-foreground">Mois en cours</p>}
            {hp.avantPremierReleve && <p className="text-[11px] text-muted-foreground">Avant la première mise à jour</p>}
            <div className="mt-1.5 space-y-0.5">
              {lignes.map((l) => (
                <div key={l.key} className="flex items-center gap-1.5">
                  <span className="w-3 h-0.5 rounded-full flex-shrink-0" style={{ background: l.color }} />
                  <span className="flex-1 text-muted-foreground">{l.label}</span>
                  <span className="tabular-nums font-medium">{fmtH(hp[l.key])} / sem.</span>
                </div>
              ))}
            </div>
            {hp.releves.length > 0 && (
              <p className="mt-1.5 pt-1.5 border-t text-[11px]">
                Charge mise à jour le {hp.releves.map(formatDateFr).join(', ')}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
