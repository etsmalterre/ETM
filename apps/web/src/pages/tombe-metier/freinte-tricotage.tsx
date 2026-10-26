// « Freinte tricotage » of a tombé de métier (decision Vincent 2026-10-26, API
// lib/freinte-tricotage.ts): the yarn in that does not come out as écru, in %. It replaces the
// old « Rendement » tile of Spécifications. The value is measured on the archived TRM lots,
// else the matière default, unless it is forced on the fiche; the tile opens the measures.
// Imported RELATIVELY (TRM renders the Tombé Métier screens through `@etm`).
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Loader2, TrendingDown, X } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { SpecTile, tileInput } from './spec-tiles'

export interface FreinteTricotage {
  taux: number
  source: 'forcee' | 'mesuree' | 'defaut'
  mesuree: number | null
  nbMesures: number
  defaut: number
  origine: string
}

interface MesureFreinte {
  date: string
  entree: number
  sortie: number
  taux: number
  lots: string[]
  ofs: number[]
  valide: boolean
}

const pct = (x: number, digits = 1) => `${fmtNum(x * 100, digits)} %`

/** The Spécifications tile: the value + where it comes from; edit mode = the forced value. */
export function FreinteTricotageTile({ idRefEcru, reference, freinte, forcee, isEditing, draft, onDraftChange }: {
  idRefEcru: number
  reference: string | null
  freinte: FreinteTricotage | null | undefined
  /** ref_ecru.freinte_tricotage (0..1), null = not forced */
  forcee: number | null
  isEditing: boolean
  /** the forced value being typed, in %; '' = back to the measured one */
  draft: string
  onDraftChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (isEditing) {
    const repli = freinte?.mesuree ?? freinte?.defaut ?? null
    return (
      <SpecTile label="Freinte tricotage">
        <div className="relative">
          <input
            type="number" step="0.1" min="0" max="49"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            placeholder={repli != null ? fmtNum(repli * 100, 1) : ''}
            className={cn(tileInput, 'pr-6')}
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground leading-tight">
          {draft.trim() === '' ? 'Vide = valeur mesurée' : 'Valeur forcée'}
        </p>
      </SpecTile>
    )
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="text-left min-w-0" title="Voir les mesures">
        <SpecTile label="Freinte tricotage" className="h-full hover:border-accent/50 transition-colors cursor-pointer">
          {freinte ? (
            <>
              <span className="text-2xl font-bold tabular-nums leading-none">
                {fmtNum(freinte.taux * 100, 1)}<span className="text-xs text-muted-foreground font-normal ml-1">%</span>
              </span>
              <p className={cn('mt-1 text-[10px] leading-tight truncate', freinte.source === 'forcee' ? 'text-accent font-medium' : 'text-muted-foreground')}>
                {freinte.origine}
              </p>
            </>
          ) : (
            <span className="text-2xl font-bold text-muted-foreground/60 leading-none">—</span>
          )}
        </SpecTile>
      </button>
      <FreinteTricotageDialog open={open} onOpenChange={setOpen} idRefEcru={idRefEcru} reference={reference} forcee={forcee} />
    </>
  )
}

/** §18.D banded dialog: the value, then every measure (group of archived lots + their OFs). */
function FreinteTricotageDialog({ open, onOpenChange, idRefEcru, reference, forcee }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  idRefEcru: number
  reference: string | null
  forcee: number | null
}) {
  const { data, isLoading, isError } = useQuery<FreinteTricotage & { mesures: MesureFreinte[] }>({
    queryKey: ['ref-ecru-freinte', idRefEcru],
    queryFn: () => apiFetch(`/references-ecru/${idRefEcru}/freinte-tricotage`),
    enabled: open && idRefEcru > 0,
  })
  const recentes = useMemo(() => [...(data?.mesures ?? [])].reverse(), [data])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0 border-0 bg-primary overflow-hidden max-h-[90dvh] flex flex-col">
        <div className="flex-shrink-0 flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5 rounded-t-lg">
          <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
            <TrendingDown className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">Freinte de tricotage</h2>
            <p className="text-xs text-white/70 truncate">Tombé de métier {reference ?? ''} · fil entré → écru sorti</p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-white/80 hover:bg-white/15 hover:text-white" title="Fermer" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-100 p-4 space-y-3 scrollbar-transparent">
          {isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
          ) : isError || !data ? (
            <div className="flex items-center gap-2 text-sm text-destructive py-6 justify-center"><AlertCircle className="h-4 w-4" />Impossible de charger les mesures</div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Figure label="Retenue" value={pct(data.taux)} detail={data.origine} strong />
                <Figure label="Mesurée" value={data.mesuree != null ? pct(data.mesuree) : '—'}
                  detail={data.mesuree != null ? `médiane des ${Math.min(10, data.nbMesures)} derniers bilans` : `${data.nbMesures} bilan${data.nbMesures > 1 ? 's' : ''} valable${data.nbMesures > 1 ? 's' : ''} (3 requis)`} />
                <Figure label="Par défaut" value={pct(data.defaut)} detail={forcee != null ? 'remplacée par la valeur forcée' : 'quand la mesure manque'} />
              </div>

              <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm">
                <h3 className="text-sm font-semibold mb-2">Bilans de lots archivés</h3>
                {data.mesures.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic py-4 text-center">Aucun lot archivé pour ce tombé de métier.</p>
                ) : (
                  <>
                    <FreinteChart mesures={data.mesures} retenue={data.taux} />
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Un point = un groupe de lots de fil archivés chez TRM et les OF qui les ont tricotés. Gris = écarté (avant 2023, ou hors −5 % / 25 % : erreur de données).
                    </p>
                    <div className="mt-3 max-h-56 overflow-y-auto scrollbar-transparent">
                      <table className="w-full text-xs">
                        <thead className="bg-zinc-200/60 sticky top-0">
                          <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            <th className="px-2 py-1.5 text-left font-semibold">Date</th>
                            <th className="px-2 py-1.5 text-left font-semibold">OF</th>
                            <th className="px-2 py-1.5 text-left font-semibold">Lots</th>
                            <th className="px-2 py-1.5 text-right font-semibold">Fil</th>
                            <th className="px-2 py-1.5 text-right font-semibold">Écru</th>
                            <th className="px-2 py-1.5 text-right font-semibold">Freinte</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recentes.map((m, i) => (
                            <tr key={i} className={cn('border-b border-border/40', !m.valide && 'text-muted-foreground/60')}>
                              <td className="px-2 py-1 tabular-nums">{m.date ? new Date(m.date).toLocaleDateString('fr-FR') : '—'}</td>
                              <td className="px-2 py-1 truncate max-w-[110px]" title={m.ofs.join(', ')}>{m.ofs.join(', ')}</td>
                              <td className="px-2 py-1 truncate max-w-[110px]" title={m.lots.join(', ')}>{m.lots.join(', ')}</td>
                              <td className="px-2 py-1 text-right tabular-nums">{fmtNum(m.entree, 1)} kg</td>
                              <td className="px-2 py-1 text-right tabular-nums">{fmtNum(m.sortie, 1)} kg</td>
                              <td className="px-2 py-1 text-right tabular-nums font-medium">{pct(m.taux)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Figure({ label, value, detail, strong }: { label: string; value: string; detail: string; strong?: boolean }) {
  return (
    <div className={cn('rounded-lg border border-border/60 bg-card p-3 shadow-sm min-w-0', strong && 'border-l-4 border-l-accent/70')}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</p>
      <p className="text-2xl font-bold tabular-nums leading-tight mt-0.5">{value}</p>
      <p className="text-[11px] text-muted-foreground leading-snug">{detail}</p>
    </div>
  )
}

/** Inline SVG: one dot per measure over time, the retained value as a dashed line. */
function FreinteChart({ mesures, retenue }: { mesures: MesureFreinte[]; retenue: number }) {
  const W = 600, H = 180, L = 36, R = 8, T = 8, B = 22
  const pts = mesures.filter((m) => m.date)
  const times = pts.map((m) => new Date(m.date).getTime())
  const t0 = Math.min(...times), t1 = Math.max(...times)
  const valides = pts.filter((m) => m.valide).map((m) => m.taux)
  const yMax = Math.max(0.1, retenue, ...valides) * 1.15
  const yMin = Math.min(0, ...valides)
  const x = (t: number) => (t1 > t0 ? L + ((t - t0) / (t1 - t0)) * (W - L - R) : (L + W - R) / 2)
  const clampY = (v: number) => Math.min(yMax, Math.max(yMin, v))
  const y = (v: number) => T + (1 - (clampY(v) - yMin) / (yMax - yMin)) * (H - T - B)
  const step = yMax > 0.2 ? 0.05 : 0.02
  const ticks: number[] = []
  // `+ 0` turns a -0 tick into 0 (« -0 % » otherwise).
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) ticks.push(Math.round(v * 1000) / 1000 + 0)
  const years = [...new Set(times.map((t) => new Date(t).getFullYear()))]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Freinte par bilan de lots">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="currentColor" className="text-border" strokeWidth={1} />
          <text x={L - 4} y={y(v) + 3} textAnchor="end" className="fill-muted-foreground" fontSize={10}>{fmtNum(v * 100, 0)} %</text>
        </g>
      ))}
      {years.map((yr) => {
        const t = new Date(yr, 0, 1).getTime()
        if (t < t0 || t > t1) return null
        return <text key={yr} x={x(t)} y={H - 6} textAnchor="middle" className="fill-muted-foreground" fontSize={10}>{yr}</text>
      })}
      <line x1={L} x2={W - R} y1={y(retenue)} y2={y(retenue)} stroke="hsl(var(--accent))" strokeWidth={1.5} strokeDasharray="5 4" />
      {pts.map((m, i) => (
        <circle key={i} cx={x(new Date(m.date).getTime())} cy={y(m.taux)} r={m.valide ? 4 : 3}
          fill={m.valide ? 'hsl(var(--primary))' : 'transparent'} stroke={m.valide ? 'white' : 'hsl(var(--muted-foreground))'} strokeWidth={m.valide ? 1.5 : 1}>
          <title>{`${new Date(m.date).toLocaleDateString('fr-FR')} · ${pct(m.taux)} · ${fmtNum(m.entree, 1)} kg de fil → ${fmtNum(m.sortie, 1)} kg d'écru`}</title>
        </circle>
      ))}
    </svg>
  )
}
