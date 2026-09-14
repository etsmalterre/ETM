import { useEffect, useState } from 'react'

/** Tailwind's `md` breakpoint — the table-centric stock screens switch from
 *  the split table to the card list below it (mps_designer §40.2). */
export const MD_UP = '(min-width: 768px)'

/** True while `window.matchMedia(query)` matches; re-renders on change.
 *
 *  Why it exists (LIVA #1156 perf audit, 2026-09-14): the stock screens
 *  rendered BOTH the desktop table and the phone card list for every row,
 *  one hidden by `hidden md:flex` / `md:hidden`. CSS hides pixels, not work —
 *  762 écru rows became 1 524 row elements and ~34k DOM nodes, and React
 *  reconciled both trees on every filter keystroke. Gating each branch on
 *  this hook mounts exactly one of them; the Tailwind classes stay as belt
 *  and braces for the instant between a resize and the re-render. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : true,
  )

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const update = () => setMatches(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [query])

  return matches
}
