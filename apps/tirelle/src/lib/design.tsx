// Design comparison (2026-11-09): the lab screen exists in two designs while
// Vincent compares them — « Ancien » (pages/Labo.tsx) and « Nouveau »
// (pages/LaboNouveau.tsx). The choice is the tablet's own (localStorage);
// `?design=nouveau|ancien` in the URL sets it too. Once a design is chosen,
// delete the other page, this file and the switch in both headers.
import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

export type Design = 'ancien' | 'nouveau'

const CLE = 'tirelle.design'
const EVENEMENT = 'tirelle-design'

function lire(): Design {
  try {
    const url = new URLSearchParams(window.location.search).get('design')
    if (url === 'ancien' || url === 'nouveau') {
      localStorage.setItem(CLE, url)
      return url
    }
    return localStorage.getItem(CLE) === 'nouveau' ? 'nouveau' : 'ancien'
  } catch {
    return 'ancien'
  }
}

export function useDesign(): [Design, (d: Design) => void] {
  const [design, setDesign] = useState<Design>(lire)
  useEffect(() => {
    const suivre = () => setDesign(lire())
    window.addEventListener(EVENEMENT, suivre)
    return () => window.removeEventListener(EVENEMENT, suivre)
  }, [])
  const choisir = useCallback((d: Design) => {
    try {
      localStorage.setItem(CLE, d)
      // Drop a ?design= left in the URL, or the next reload would override the choice.
      const u = new URL(window.location.href)
      if (u.searchParams.has('design')) {
        u.searchParams.delete('design')
        window.history.replaceState(null, '', u.toString())
      }
    } catch {
      /* storage disabled: the choice lasts until the next reload */
    }
    setDesign(d)
    window.dispatchEvent(new Event(EVENEMENT))
  }, [])
  return [design, choisir]
}

/** The two-way switch, on the navy header of either design. */
export function ChoixDesign() {
  const [design, choisir] = useDesign()
  return (
    <div className="flex items-center rounded-full bg-white/10 p-0.5 ring-1 ring-white/20" title="Comparer les deux designs">
      {(['ancien', 'nouveau'] as const).map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => choisir(d)}
          aria-pressed={design === d}
          className={cn(
            'h-8 px-3 rounded-full text-xs font-semibold transition-colors',
            design === d ? 'bg-gold text-gold-foreground shadow-sm' : 'text-white/75 active:bg-white/15',
          )}
        >
          {d === 'ancien' ? 'Ancien' : 'Nouveau'}
        </button>
      ))}
    </div>
  )
}
