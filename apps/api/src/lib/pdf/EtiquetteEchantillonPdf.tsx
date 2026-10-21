// Dymo "étiquette" for a trial sample (Tombé Métier › Échantillons) — the tag
// stuck on the sample fabric. Same design as the ref_fini tag
// (EtiquetteRefFiniPdf), which it mirrors on purpose so the two tags read as
// one family: the number big on the left over its description, a rule, the
// figures that define the fabric in bold. Where the fini tag prints the care
// symbols, the sample prints its yarn composition. No QR code and no logo:
// the tag stays in the factory (Vincent, 2026-10-21), so the text takes the
// whole width. No legacy equivalent (the legacy printed an « OF échantillon »
// report).
//
// ⚠️ BLACK AND WHITE ONLY — a Dymo LabelWriter is a thermal printer: no
// colour, and anything not near-black comes out as grey dither. Ink #000,
// small labels #333.
//
// Page is the Dymo 99012 "Large Address" 89 × 36 mm. Centred on the physical
// label like the fini tag, content narrowed so its right edge stays
// inside the head limit (~234 pt) — pinned by the test (`LAYOUT`).
// Self-contained: built-in Helvetica.

import React from 'react'
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer'

const PAGE_WIDTH = 89 * 2.834646 // ≈ 252.3
const PAGE_HEIGHT = 36 * 2.834646 // ≈ 102.05
const PRINT_LIMIT = 234
const CONTENT_WIDTH = 210
const PAGE_PADDING_X = (PAGE_WIDTH - CONTENT_WIDTH) / 2 // ≈ 21.1 — both sides
export const LAYOUT = { PAGE_WIDTH, PRINT_LIMIT, CONTENT_WIDTH, PAGE_PADDING_X }


// ── Input shape ──────────────────────────────────────────

export interface EtiquetteEchantillonData {
  IDref_echantillon: number
  /** « E055 ». */
  numero: string
  contexture: string | null
  /** Display labels: « 28 », « 30" »; null when not set. */
  jauge: string | null
  diametre: string | null
  /** LFA per tour 1..4, 0 = not set. */
  lfa: number[]
  /** Yarns in percent, biggest share first. */
  composition: { pourcentage: number; fil: string }[]
}

/** French number, 2 dp max: 7.5 → « 7,5 ». */
function fr(n: number): string {
  return String(Math.round(n * 100) / 100).replace('.', ',')
}

/** The LFA cell: the distinct values set, « 7,50 » or « 3,35 / 7,6 / 5,1 ».
 *  The legacy fills tour 1 and 3 with the same value — printing « 7,50 /
 *  7,50 » would only cost width. One value keeps the legacy's two decimals;
 *  several drop the trailing zeros and print smaller (`lfaMultiple`), or they
 *  run off the label. */
export function lfaCellule(lfa: number[]): string {
  const vals = [...new Set(lfa.filter((v) => v > 0))]
  if (vals.length <= 1) return vals.length ? vals[0].toFixed(2).replace('.', ',') : ''
  return vals.map(fr).join(' / ')
}
const lfaMultiple = (lfa: number[]) => new Set(lfa.filter((v) => v > 0)).size > 1

/** « 48 % 1/60 LYOCELL · 47 % 78/68/2 PA66 Z · 5 % 22 ELASTHANNE », clamped
 *  to what two 7 pt lines hold over the ~205 pt text column (~56 chars a
 *  line); a third line would push the block off the 36 mm page. */
export function compositionTexte(lignes: EtiquetteEchantillonData['composition']): string {
  // Non-breaking spaces bind « 36 % » to its yarn: a line never ends on a bare figure.
  const t = lignes.map((l) => `${fr(l.pourcentage)} % ${l.fil.trim()}`).join(' · ')
  const budget = 110
  if (t.length <= budget) return t
  const cut = t.slice(0, budget - 1)
  const at = cut.lastIndexOf(' ')
  return (at > budget * 0.6 ? cut.slice(0, at) : cut).trimEnd() + '…'
}

// ── Styles ───────────────────────────────────────────────
//
// The fini tag's styles, verbatim where the element is the same (headline,
// rule, spec cells). Vertical budget 102 − 2 × 3 = 96 pt: numéro
// 22 + contexture 9 + 2.5 + rule 7.8 + specs 20.5 + composition 2 × 8 + 3
// ≈ 81 at a two-line composition, the worst case after the clamp.

const styles = StyleSheet.create({
  page: {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    flexDirection: 'row',
    fontFamily: 'Helvetica',
    color: '#000000',
    paddingVertical: 3,
    paddingHorizontal: PAGE_PADDING_X,
  },
  body: { flex: 1, flexDirection: 'column', justifyContent: 'center', paddingBottom: 3 },
  headline: { flexDirection: 'row', alignItems: 'flex-end' },
  tag: { fontSize: 9, color: '#333333', marginRight: 5, marginBottom: 2, lineHeight: 1 },
  numero: { fontFamily: 'Helvetica-Bold', fontSize: 22, lineHeight: 1 },
  contexture: { fontSize: 8, lineHeight: 1.12, marginTop: 2.5 },
  rule: { borderBottomWidth: 0.8, borderBottomColor: '#000000', marginTop: 4, marginBottom: 3 },
  specs: { flexDirection: 'row', alignItems: 'flex-end' },
  spec: { flexDirection: 'column', marginRight: 10, minWidth: 26 },
  // The LFA takes what is left of the row and may wrap (several tours).
  specLast: { flexDirection: 'column', flex: 1, flexShrink: 1, marginRight: 0 },
  specLabel: { fontSize: 6, color: '#333333', letterSpacing: 0.6, lineHeight: 1, marginBottom: 1.5 },
  specValue: { fontFamily: 'Helvetica-Bold', fontSize: 13, lineHeight: 1 },
  specValueSmall: { fontFamily: 'Helvetica-Bold', fontSize: 8.5, lineHeight: 1.1, marginBottom: 1 },
  composition: { fontSize: 7, lineHeight: 1.12, marginTop: 3 },
})

function Spec({ label, value, small, last }: { label: string; value: string; small?: boolean; last?: boolean }) {
  return (
    <View style={last ? styles.specLast : styles.spec}>
      <Text style={styles.specLabel}>{label}</Text>
      <Text style={small ? styles.specValueSmall : styles.specValue}>{value || '—'}</Text>
    </View>
  )
}

function Etiquette({ d }: { d: EtiquetteEchantillonData }): React.ReactElement {
  const compo = compositionTexte(d.composition)
  return (
    <Page size={[PAGE_WIDTH, PAGE_HEIGHT]} style={styles.page}>
      <View style={styles.body}>
        <View style={styles.headline}>
          <Text style={styles.tag}>Éch.</Text>
          <Text style={styles.numero}>{d.numero}</Text>
        </View>
        {d.contexture?.trim() ? <Text style={styles.contexture}>{d.contexture.trim()}</Text> : null}
        <View style={styles.rule} />
        <View style={styles.specs}>
          <Spec label="JAUGE" value={d.jauge ?? ''} />
          <Spec label="Ø" value={d.diametre ?? ''} />
          <Spec label="LFA" value={lfaCellule(d.lfa)} small={lfaMultiple(d.lfa)} last />
        </View>
        {compo ? <Text style={styles.composition}>{compo}</Text> : null}
      </View>

    </Page>
  )
}

/** One tag per print. */
export function EtiquetteEchantillonPdf({ data }: { data: EtiquetteEchantillonData }): React.ReactElement {
  return (
    <Document title={`Étiquette échantillon ${data.numero}`} author="ETS Malterre">
      <Etiquette d={data} />
    </Document>
  )
}
