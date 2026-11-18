// The box of the lab's shelf where a lot's square and tirelle are stored
// (Qualité › Suivi lots « Emplacement », LIVA #1380). Picked on the shelf's
// grid, never typed: the lab tablet's « vider la boîte » finds a box's lots by
// that exact name, and a hand-typed « A1 et A3 » or « a 1 » is no box. Same
// grid as the tablet (apps/tirelle GrilleBoites): 48 boxes, each with how many
// tirelles it already holds.
//
// The list is portalled (the KV value cell clips, mps_designer §11bis).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { Archive, ChevronDown } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { NUMEROS, RANGEES, lireBoite, type EtatBoite } from '@/lib/boites-tirelle'
import { cn } from '@/lib/utils'

const LARGEUR = 316
/** The grid's height, about: only to choose between under and above the field. */
const HAUTEUR = 310
const MARGE = 8

/** Read mode: a box as a navy chip, what was typed before the boxes as plain text. */
export function BoiteTirelleValeur({ valeur }: { valeur: string | null | undefined }) {
  const boite = lireBoite(valeur)
  if (boite) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-primary px-1.5 py-0.5 text-xs font-bold tabular-nums text-primary-foreground" title={`Boîte ${boite} de l’étagère du labo`}>
        <Archive className="h-3 w-3" />{boite}
      </span>
    )
  }
  const ancien = (valeur ?? '').trim()
  return <>{ancien ? <span className="text-muted-foreground" title="Rangement noté avant les boîtes">{ancien}</span> : '—'}</>
}

export function BoiteTirellePicker({ valeur, onChange }: {
  /** A box (« B3 »), '' for none, or what was typed before the boxes (« Carton »). */
  valeur: string
  onChange: (boite: string) => void
}) {
  const [ouvert, setOuvert] = useState(false)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  const declencheur = useRef<HTMLButtonElement>(null)
  const liste = useRef<HTMLDivElement>(null)
  const boite = lireBoite(valeur)
  const ancien = !boite ? valeur.trim() : ''

  const boites = useQuery({
    queryKey: ['suivi-lots-boites-tirelle'],
    queryFn: () => apiFetch<{ boites: EtatBoite[] }>('/suivi-lots/boites-tirelle'),
    enabled: ouvert,
    staleTime: 0,
  })
  const par = new Map((boites.data?.boites ?? []).map((b) => [b.boite, b.n]))

  // Under the trigger, above it when there is more room there, kept on screen.
  useLayoutEffect(() => {
    if (!ouvert) return
    const r = declencheur.current?.getBoundingClientRect()
    if (!r) return
    const left = Math.max(MARGE, Math.min(r.right - LARGEUR, window.innerWidth - LARGEUR - MARGE))
    const dessous = window.innerHeight - r.bottom - MARGE
    // Above: anchored by its bottom edge, so it never covers the field whatever its height.
    setPos(dessous >= HAUTEUR || dessous >= r.top ? { left, top: r.bottom + 4 } : { left, bottom: window.innerHeight - r.top + 4 })
  }, [ouvert])

  useEffect(() => {
    if (!ouvert) return
    const dehors = (e: Event) => {
      const t = e.target as Node
      if (declencheur.current?.contains(t) || liste.current?.contains(t)) return
      setOuvert(false)
    }
    const touche = (e: KeyboardEvent) => { if (e.key === 'Escape') setOuvert(false) }
    document.addEventListener('mousedown', dehors)
    window.addEventListener('scroll', dehors, true)
    window.addEventListener('resize', dehors)
    document.addEventListener('keydown', touche)
    return () => {
      document.removeEventListener('mousedown', dehors)
      window.removeEventListener('scroll', dehors, true)
      window.removeEventListener('resize', dehors)
      document.removeEventListener('keydown', touche)
    }
  }, [ouvert])

  const choisir = (b: string) => {
    onChange(b)
    setOuvert(false)
  }

  return (
    <>
      <button
        ref={declencheur}
        type="button"
        onClick={() => setOuvert((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={ouvert}
        className="h-7 w-[160px] px-2 inline-flex items-center justify-between gap-1.5 rounded-md border border-input bg-white text-sm focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
      >
        <span className="min-w-0 flex items-center gap-1.5 truncate">
          <Archive className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          {boite
            ? <span className="font-semibold tabular-nums">{boite}</span>
            : ancien
              ? <span className="truncate text-muted-foreground">{ancien}</span>
              : <span className="text-muted-foreground">Choisir la boîte</span>}
        </span>
        <ChevronDown className={cn('h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform', ouvert && 'rotate-180')} />
      </button>
      {ouvert && pos && createPortal(
        <div
          ref={liste}
          role="dialog"
          aria-label="Boîte de rangement de la tirelle"
          style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, width: LARGEUR }}
          className="z-50 rounded-lg border bg-white p-2 shadow-lg"
        >
          <div className="grid grid-cols-8 gap-1">
            {RANGEES.flatMap((r) => NUMEROS.map((numero) => {
              const nom = `${r}${numero}`
              const n = par.get(nom) ?? 0
              const active = boite === nom
              return (
                <button
                  key={nom}
                  type="button"
                  aria-pressed={active}
                  onClick={() => choisir(nom)}
                  title={`Boîte ${nom} : ${n} tirelle${n > 1 ? 's' : ''}`}
                  className={cn(
                    'h-10 rounded-md border flex flex-col items-center justify-center leading-none transition-colors cursor-pointer',
                    active ? 'bg-primary border-primary text-primary-foreground shadow-sm'
                      : n > 0 ? 'bg-white border-primary/40 text-primary hover:bg-primary/10'
                        : 'bg-zinc-100/80 border-border/60 text-muted-foreground hover:bg-accent/10 hover:border-accent/40',
                  )}
                >
                  <span className="text-xs font-bold">{nom}</span>
                  {/* An empty box shows its name alone, so the full ones stand out. */}
                  {n > 0 && <span className={cn('mt-0.5 text-[10px] tabular-nums', active ? 'text-white/80' : 'text-muted-foreground')}>{n}</span>}
                </button>
              )
            }))}
          </div>
          {/* No legend under the grid (« Sous chaque boîte… » puzzled, 2026-11-18): the
              count reads by itself, the hover says « Boîte A1 : 19 tirelles ». */}
          {valeur.trim() !== '' && (
            <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
              <p className="min-w-0 text-[11px] text-muted-foreground">
                {ancien ? <>Noté avant les boîtes : « {ancien} ».</> : null}
              </p>
              <button type="button" onClick={() => choisir('')} className="flex-shrink-0 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/10 hover:text-accent cursor-pointer">
                Aucune boîte
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
