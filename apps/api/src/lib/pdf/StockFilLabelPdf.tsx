// Dymo "étiquette" label for a yarn lot (lot de fil) — TRM Fils › Stock.
//
// The legacy MPS project has no yarn-lot label report (the only Dymo report is
// ETAT_Etiquette_SP.wde, the finished-roll label ported as StockFiniLabelPdf).
// This label was specified with the user for the web port: same Dymo 99012
// "Large Address" page (89 × 36 mm), same left vertical Malterre-logo band,
// with the lot number as the headline and the yarn-lot identity lines.
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

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ASSETS = path.resolve(__dirname, '../../assets')
const LOGO_BUFFER: Buffer = fs.readFileSync(path.join(ASSETS, 'logo-malterre.png'))

// ── Input shape ──────────────────────────────────────────

export interface StockFilLabelData {
  lot: string | null
  ref_fil: string | null
  colori_reference: string | null
  client_nom: string | null
  lot_frs: string | null
  /** kg received — the label states the lot's nominal weight, not the moving stock. */
  stock_initial: number | string | null
  emplacement: string | null
  niveau: number | null
}

function fmtKg(value: number | string | null): string {
  if (value == null || value === '') return ''
  const n = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(n)) return ''
  return `${Math.round(n * 10) / 10} Kg`
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
    paddingRight: 8,
  },
  band: {
    width: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 88,
    height: 33,
    transform: 'rotate(-90deg)',
  },
  body: {
    flex: 1,
    flexDirection: 'column',
    justifyContent: 'center',
    paddingLeft: 6,
  },
  lot: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 15,
    marginBottom: 1,
  },
  line: {
    fontSize: 10,
    lineHeight: 1.16,
  },
})

// ── Component ─────────────────────────────────────────────

export function StockFilLabelPdf({ data }: { data: StockFilLabelData }): React.ReactElement {
  const empl = [clean(data.emplacement), data.niveau != null && data.niveau > 0 ? `Niv. ${data.niveau}` : '']
    .filter(Boolean)
    .join(' / ')
  return (
    <Document>
      <Page size={[PAGE_WIDTH, PAGE_HEIGHT]} style={styles.page}>
        <View style={styles.band}>
          <Image src={LOGO_BUFFER} style={styles.logo} />
        </View>
        <View style={styles.body}>
          <Text style={styles.lot}>Lot : {clean(data.lot)}</Text>
          <Text style={styles.line}>Réf. : {clean(data.ref_fil)}</Text>
          <Text style={styles.line}>Col. : {clean(data.colori_reference)}</Text>
          <Text style={styles.line}>Client : {clean(data.client_nom)}</Text>
          <Text style={styles.line}>Lot frs : {clean(data.lot_frs)}</Text>
          <Text style={styles.line}>Poids : {fmtKg(data.stock_initial)}</Text>
          <Text style={styles.line}>Empl. : {empl}</Text>
        </View>
      </Page>
    </Document>
  )
}
