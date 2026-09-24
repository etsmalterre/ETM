// Vector Code 128 bars for @react-pdf — one <Rect> per bar, so the symbol is
// exact at any print resolution (MATEL prints on a laser, no dithering).

import React from 'react'
import { Svg, Rect } from '@react-pdf/renderer'
import type { Code128Symbol } from '../gs1-barcode.js'

/** Draws `symbol` at `width` × `height` points. The quiet zones are the
 *  caller's margin, not part of the drawing. */
export function Code128Bars({ symbol, width, height }: { symbol: Code128Symbol; width: number; height: number }) {
  const total = symbol.modules.reduce((a, b) => a + b, 0)
  const unit = width / total
  const bars: React.ReactElement[] = []
  let x = 0
  symbol.modules.forEach((w, i) => {
    if (i % 2 === 0) bars.push(<Rect key={i} x={x * unit} y={0} width={w * unit} height={height} fill="#000000" />)
    x += w
  })
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {bars}
    </Svg>
  )
}
