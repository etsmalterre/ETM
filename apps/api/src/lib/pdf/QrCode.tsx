// Vector QR code for react-pdf documents.
//
// `qrcode` only gives us the module matrix (its renderers target canvas / PNG /
// SVG strings, none of which react-pdf accepts), so the modules are drawn here
// as ONE `<Path>` of horizontal runs — a run per row segment rather than a
// rect per module, which keeps the PDF small and avoids the hairline seams a
// viewer paints between adjacent anti-aliased squares. Being vector, it comes
// out pixel-exact at the Dymo's 300 dpi whatever `size` is.
//
// Error correction: M (15 % recovery) by default — the usual trade-off between
// scuff tolerance and module count, and the WinDev default the legacy label
// used. A caller that paints a logo over the centre passes H (30 %): the
// overlay eats modules, and the level is what pays for them.

import React from 'react'
import { View, Svg, Path, Rect } from '@react-pdf/renderer'
import QRCode from 'qrcode'

export interface QrCodeProps {
  /** The encoded text — for a URL, keep it short: fewer bytes, bigger modules. */
  value: string
  /** Rendered side in pt, quiet zone included. */
  size: number
  /** Blank modules around the symbol. ISO wants 4; on a tag with white all
   *  around, 1–2 is enough and buys ~15 % bigger modules. */
  quietZone?: number
  color?: string
  /** Error correction level. Default M; use H under a centre overlay. */
  level?: QRCodeErrorCorrectionLevel
}

export type QRCodeErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H'

/** Build the SVG path data for the dark modules, as horizontal runs, offset
 *  by `offset` modules (the quiet zone). */
export function qrModulesPath(value: string, offset = 0, level: QRCodeErrorCorrectionLevel = 'M'): { path: string; modules: number } {
  const qr = QRCode.create(value, { errorCorrectionLevel: level })
  const n = qr.modules.size
  const parts: string[] = []
  for (let y = 0; y < n; y++) {
    let x = 0
    while (x < n) {
      if (!qr.modules.get(y, x)) { x++; continue }
      let run = 1
      while (x + run < n && qr.modules.get(y, x + run)) run++
      parts.push(`M${x + offset} ${y + offset}h${run}v1h-${run}z`)
      x += run
    }
  }
  return { path: parts.join(''), modules: n }
}

export function QrCode({ value, size, quietZone = 1, color = '#000000', level = 'M' }: QrCodeProps): React.ReactElement {
  const { path, modules } = qrModulesPath(value, quietZone, level)
  const side = modules + 2 * quietZone
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${side} ${side}`}>
        <Rect x={0} y={0} width={side} height={side} fill="#FFFFFF" />
        <Path d={path} fill={color} />
      </Svg>
    </View>
  )
}
