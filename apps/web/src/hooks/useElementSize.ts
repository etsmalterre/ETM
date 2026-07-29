// Pixel size of a box, tracked with a ResizeObserver.
//
// Charts use it to draw at real size rather than scaling a viewBox: a scaled
// viewBox stretches strokes and text along with the card, so the same chart
// reads thin in a wide widget and heavy in a narrow one.

import { useEffect, useRef, useState } from 'react'

export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      setSize({ w: Math.round(r.width), h: Math.round(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, size] as const
}
