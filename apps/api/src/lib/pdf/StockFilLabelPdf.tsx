// Dymo "étiquette" label for a yarn lot (lot de fil) — TRM Fils › Stock.
//
// The legacy MPS project has no yarn-lot label report (the only Dymo report is
// ETAT_Etiquette_SP.wde, the finished-roll label ported as StockFiniLabelPdf).
// This label was specified with the user for the web port: same Dymo 99012
// "Large Address" page (89 × 36 mm) as the roll label (EtiquetteEcruPdf), and
// since 2026-09-07 the same dress — square M badge in the left band, a rule,
// a headline with its small tag, captions in a column, values beside them —
// so the two tags a bonnetier handles read as one family.
//
// 2026-09-07 (LIVA #1133, Nicolas Antonino, approved by the user): the label
// is read on pallets that are STACKED, so the lot number has to be legible
// from a distance. Three lines were dropped because they said nothing
// durable — the weight (moves every visitage), the supplier lot (never
// looked up on the floor) and the emplacement (misleading once the pallet is
// moved) — and the space went to the lot number. What stays: lot, référence,
// coloris, client.
//
// Self-contained: built-in Helvetica family (no Font.register) so the tiny
// label has no font-path dependency.

import React from 'react'
import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'

// 89 × 36 mm in PostScript points (1 mm = 2.834646 pt).
const PAGE_WIDTH = 89 * 2.834646 // ≈ 252.3
const PAGE_HEIGHT = 36 * 2.834646 // ≈ 102.05

// The LabelWriter's head stops ~6,5 mm short of the label's right edge —
// measured on the roll label (see SAFE_RIGHT in EtiquetteEcruPdf.tsx). Same
// printer, same constant: everything below lays out inside the printable band.
const SAFE_RIGHT = 26

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ASSETS = path.resolve(__dirname, '../../assets')
// The square M badge, as on the roll label (user decision 2026-08-27): the
// wordmark's script strokes break up on the Dymo's thermal screen, the badge
// does not, and it fills a tall narrow band instead of shrinking to its width.
const LOGO_BUFFER: Buffer = fs.readFileSync(path.join(ASSETS, 'logo-m-email.png'))

// ── Input shape ──────────────────────────────────────────

export interface StockFilLabelData {
  lot: string | null
  ref_fil: string | null
  colori_reference: string | null
  client_nom: string | null
}

function clean(value: string | null): string {
  return value == null ? '' : value.trim()
}

// ── Styles ───────────────────────────────────────────────

const styles = StyleSheet.create({
  page: {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    flexDirection: 'row',
    fontFamily: 'Helvetica',
    color: '#000000',
    paddingVertical: 4,
    paddingLeft: 5,
    paddingRight: SAFE_RIGHT,
  },

  // Left band — the badge alone, centred. Same 56 pt as the roll label's band
  // so the two tags line up when they sit side by side.
  band: {
    width: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingRight: 6,
  },
  logo: {
    width: 50,
    height: 50,
  },

  // Right column — headline, rule, three captioned lines.
  body: {
    flex: 1,
    flexDirection: 'column',
    justifyContent: 'center',
    paddingLeft: 7,
    borderLeftWidth: 0.8,
    borderLeftColor: '#000000',
  },
  headline: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  tag: {
    fontSize: 8.5,
    color: '#444444',
    marginRight: 4,
    marginBottom: 3,
  },
  // 36 pt bold: a 5-digit lot is ~100 pt wide on the ~158 pt body — legible
  // from a couple of metres on a stacked pallet, which is the point of #1133.
  // Height budget (94 pt printable): 36 + rule 9 + three 11,5 pt lines = 79,
  // leaving room for ONE wrapped line when a référence runs long
  // ("1/28 COTON BCI/RECYCLE 40/60 Z" does). Do not grow the number past this
  // without re-checking that case.
  lot: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 36,
    lineHeight: 1,
  },
  rule: {
    borderBottomWidth: 0.7,
    borderBottomColor: '#000000',
    marginTop: 4,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  // Wide enough for "COLORIS" plus a gutter — at 36 pt the caption ran into
  // its value. The value column keeps ~110 pt, which a long référence wraps
  // into (budgeted above).
  caption: {
    width: 44,
    paddingRight: 4,
    fontSize: 7.5,
    color: '#444444',
    letterSpacing: 0.4,
    paddingTop: 1.6,
  },
  value: {
    flex: 1,
    fontSize: 10,
    lineHeight: 1.15,
  },
})

// ── Component ─────────────────────────────────────────────

export function StockFilLabelPdf({ data }: { data: StockFilLabelData }): React.ReactElement {
  const rows: Array<[string, string]> = [
    ['RÉF.', clean(data.ref_fil)],
    ['COLORIS', clean(data.colori_reference)],
    ['CLIENT', clean(data.client_nom)],
  ]
  return (
    <Document>
      <Page size={[PAGE_WIDTH, PAGE_HEIGHT]} style={styles.page}>
        <View style={styles.band}>
          <Image src={LOGO_BUFFER} style={styles.logo} />
        </View>
        <View style={styles.body}>
          <View style={styles.headline}>
            <Text style={styles.tag}>LOT</Text>
            <Text style={styles.lot}>{clean(data.lot)}</Text>
          </View>
          <View style={styles.rule} />
          {rows.map(([caption, value]) => (
            <View key={caption} style={styles.row}>
              <Text style={styles.caption}>{caption}</Text>
              <Text style={styles.value}>{value}</Text>
            </View>
          ))}
        </View>
      </Page>
    </Document>
  )
}
