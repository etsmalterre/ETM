// ISO 3758-style care symbols, drawn inline as react-pdf SVG so every document
// stays asset-free. The legacy prints five of them — wash at temp_lavage, no
// bleach, no tumble dry, iron (one dot), professional dry clean (P) — and the
// same five appear on the fiche technique (A4, `FicheTechniquePdf`) and on the
// client-facing Dymo étiquette (`EtiquetteRefFiniPdf`). One drawing, two
// scales: `size` / `stroke` / `sw` are per-call so the fiche keeps its
// 34 pt / theme-coloured rendering and the label gets a 13 pt pure-black one
// (a thermal head prints anything that is not near-black as grey dither).
//
// Every symbol is a `size × size` box; the glyph inside a wash basin / a
// dry-clean circle is an absolutely positioned Text over the SVG. Those two
// texts scale their font and top offset off `size`, so the numbers stay
// centred at any scale — the fiche's original constants (7.5 pt at 34 pt,
// top 11) are what the ratios encode.

import React from 'react'
import { View, Text, StyleSheet, Svg, Path, Rect, Circle, Line } from '@react-pdf/renderer'

export interface CareSymbolProps {
  /** Box side in pt. */
  size?: number
  /** Stroke colour. */
  stroke?: string
  /** Stroke width in the 24 × 24 viewBox. */
  sw?: number
  /** Font family for the glyphs inside the symbols (wash temperature, P). */
  fontFamily?: string
  /** Multiplier on the glyph size (wash temperature, P). At label scale the
   *  proportional glyph drops under 3 pt — a thermal head cannot resolve that —
   *  so the étiquette passes ~1.4; the glyph stays centred on its original spot. */
  glyphScale?: number
}

const DEFAULTS = { size: 34, stroke: '#000000', sw: 1.4 }

/** Font size + top offset of a glyph, scaled off the fiche's 34 pt constants
 *  and grown by `glyphScale` about its own centre. */
function glyph(size: number, baseFont: number, baseTop: number, glyphScale: number) {
  const base = size * (baseFont / 34)
  const fontSize = base * glyphScale
  return { fontSize, top: size * (baseTop / 34) - (fontSize - base) / 2 }
}

function box(size: number) {
  return { width: size, height: size, alignItems: 'center' as const, justifyContent: 'center' as const, position: 'relative' as const }
}

const styles = StyleSheet.create({
  glyph: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontWeight: 700,
    lineHeight: 1,
  },
})

export function WashSymbol({ temp, size = DEFAULTS.size, stroke = DEFAULTS.stroke, sw = DEFAULTS.sw, fontFamily, glyphScale = 1 }: CareSymbolProps & { temp: number | null }) {
  return (
    <View style={box(size)}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        {/* Basin: wavy top edge + tapering sides */}
        <Path
          d="M2.5 6 C4 7.6 5.5 7.6 7 6 C8.5 4.4 10 4.4 11.5 6 C13 7.6 14.5 7.6 16 6 C17.5 4.4 19 4.4 20.5 6"
          stroke={stroke}
          strokeWidth={sw}
          fill="none"
        />
        <Path d="M3.2 7.5 L5.5 20 H18.5 L20.8 7.5" stroke={stroke} strokeWidth={sw} fill="none" />
      </Svg>
      {temp != null && temp > 0 ? (
        <Text style={[styles.glyph, { ...glyph(size, 7.5, 11, glyphScale), color: stroke }, fontFamily ? { fontFamily } : {}]}>
          {String(Math.round(temp))}
        </Text>
      ) : null}
    </View>
  )
}

export function NoBleachSymbol({ size = DEFAULTS.size, stroke = DEFAULTS.stroke, sw = DEFAULTS.sw }: CareSymbolProps) {
  return (
    <View style={box(size)}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d="M12 4 L21.5 20.5 H2.5 Z" stroke={stroke} strokeWidth={sw} fill="none" />
        <Line x1={4} y1={5} x2={20} y2={21.5} stroke={stroke} strokeWidth={sw} />
        <Line x1={20} y1={5} x2={4} y2={21.5} stroke={stroke} strokeWidth={sw} />
      </Svg>
    </View>
  )
}

export function NoTumbleDrySymbol({ size = DEFAULTS.size, stroke = DEFAULTS.stroke, sw = DEFAULTS.sw }: CareSymbolProps) {
  return (
    <View style={box(size)}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Rect x={3} y={3} width={18} height={18} stroke={stroke} strokeWidth={sw} fill="none" />
        <Circle cx={12} cy={12} r={7} stroke={stroke} strokeWidth={sw} fill="none" />
        <Line x1={3.5} y1={3.5} x2={20.5} y2={20.5} stroke={stroke} strokeWidth={sw} />
        <Line x1={20.5} y1={3.5} x2={3.5} y2={20.5} stroke={stroke} strokeWidth={sw} />
      </Svg>
    </View>
  )
}

export function IronSymbol({ size = DEFAULTS.size, stroke = DEFAULTS.stroke, sw = DEFAULTS.sw }: CareSymbolProps) {
  return (
    <View style={box(size)}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d="M21 18 H3 C3 13 7 9.5 12.5 9.5 H17.5 L21 18 Z" stroke={stroke} strokeWidth={sw} fill="none" />
        <Path d="M10 9.5 V7 H18" stroke={stroke} strokeWidth={sw} fill="none" />
      </Svg>
    </View>
  )
}

export function DryCleanPSymbol({ size = DEFAULTS.size, stroke = DEFAULTS.stroke, sw = DEFAULTS.sw, fontFamily, glyphScale = 1 }: CareSymbolProps) {
  return (
    <View style={box(size)}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Circle cx={12} cy={12} r={9.5} stroke={stroke} strokeWidth={sw} fill="none" />
      </Svg>
      <Text style={[styles.glyph, { ...glyph(size, 10, 10, glyphScale), color: stroke }, fontFamily ? { fontFamily } : {}]}>P</Text>
    </View>
  )
}
