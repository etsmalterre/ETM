// Pixel size of a box, tracked with a ResizeObserver.
//
// Charts use it to draw at real size rather than scaling a viewBox: a scaled
// viewBox stretches strokes and text along with the card, so the same chart
// reads thin in a wide widget and heavy in a narrow one.
//
// ⚠️ Returns a CALLBACK ref, not a RefObject, and that is load-bearing. With a
// `useRef` + `useEffect([])` pair, a target rendered CONDITIONALLY
// (`{data && <div ref={…}>}`) is null on the mount the effect runs on, so the
// observer never attaches and the size stays {0,0} for good — the chart then
// silently never appears, because its own `w > 0 && h > 0` guard is false. A
// callback ref fires whenever the node attaches or detaches, so it works
// wherever the div is mounted. Consumers only spread it into `ref={…}`; none
// read `.current`.

import { useCallback, useEffect, useRef, useState } from 'react'

export function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ w: 0, h: 0 })
  const observerRef = useRef<ResizeObserver | null>(null)

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!node) return
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      setSize({ w: Math.round(r.width), h: Math.round(r.height) })
    })
    ro.observe(node)
    observerRef.current = ro
    // Seed immediately: ResizeObserver delivers its first entry asynchronously,
    // and a chart guarding on a non-zero size would otherwise skip a paint.
    const r = node.getBoundingClientRect()
    setSize({ w: Math.round(r.width), h: Math.round(r.height) })
  }, [])

  // Detach on unmount — the callback ref covers node swaps, not teardown of
  // the component itself.
  useEffect(() => () => observerRef.current?.disconnect(), [])

  return [ref, size] as const
}
