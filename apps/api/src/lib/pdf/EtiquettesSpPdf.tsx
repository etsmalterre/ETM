// Simone Pérèle roll labels (LIVA #1200) — port of the legacy
// ETAT_Etiquette_SP. Four labels per A4 landscape page, 2 × 2, exactly where
// the legacy put them: MATEL prints the sheet, cuts it in four and sticks one
// label on each roll. A last page with fewer rolls keeps the grid (top-left
// first), so the cut lines never move.
//
// Layout and wording copied from the legacy PDFs Vincent supplied
// (« 108966 - CAB.pdf », « 106910 - CAB.pdf »). Only the two GS1 barcodes
// differ: the legacy's could not be scanned (see gs1-barcode.ts); the text
// under them is identical.
//
// Built-in Helvetica only (no Font.register): the label is read by scanners
// and warehouse staff, not styled.

import React from 'react'
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer'
import { Code128Bars } from './Code128Bars.js'
import type { SpLabelCodes } from '../gs1-barcode.js'

export interface SpLabelData {
  articleClient: string
  commandeClient: string
  articleFournisseur: string
  ean13: string
  libelleArticle: string
  coloris: string
  tare: number
  /** Net weight in kg, printed rounded like the legacy (« 19 Kg »). */
  poids: number
  codes: SpLabelCodes
}

// A4 landscape.
const PAGE_W = 841.89
const PAGE_H = 595.28
// Rounded down: two cells of exactly half the page overflow it by a hair and
// react-pdf pushes the second row onto a new page.
const CELL_W = Math.floor(PAGE_W / 2)
const CELL_H = Math.floor(PAGE_H / 2)
const PAD_X = 22
const PAD_Y = 14
const LABEL_W = CELL_W - 2 * PAD_X
export const LAYOUT = { PAGE_W, PAGE_H, CELL_W, CELL_H, LABEL_W }

// The legacy's band was the brand gold behind the white script « Malterre ».
const GOLD = '#F2B33D'
const RULE = '#000000'

const s = StyleSheet.create({
  page: { fontFamily: 'Helvetica', color: '#000000' },
  cellRow: { flexDirection: 'row', height: CELL_H },
  cell: { width: CELL_W, height: CELL_H, paddingHorizontal: PAD_X, paddingVertical: PAD_Y },
  label: { width: LABEL_W, flexDirection: 'column' },
  lab: { fontSize: 8, fontFamily: 'Helvetica-Bold', lineHeight: 1.15 },
  val: { fontSize: 8, lineHeight: 1.15 },
  rule: { borderBottomWidth: 1.2, borderBottomColor: RULE },
  top: { flexDirection: 'row', alignItems: 'center', paddingBottom: 3 },
  topCol: { alignItems: 'center' },
  mid: { flexDirection: 'row' },
  band: { width: 26, backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  bandText: {
    fontFamily: 'Helvetica-BoldOblique', fontSize: 13, color: '#FFFFFF',
    width: 90, textAlign: 'center', transform: 'rotate(-90deg)',
  },
  midBody: { flex: 1, paddingLeft: 8, paddingVertical: 3 },
  row: { flexDirection: 'row', alignItems: 'baseline' },
  coloris: { fontSize: 15, fontFamily: 'Helvetica-Bold', textAlign: 'center', marginTop: 2, lineHeight: 1.1 },
  qty: { flexDirection: 'row', paddingVertical: 3 },
  qtyCol: { flex: 1 },
  hri: { fontSize: 6.8, textAlign: 'center', lineHeight: 1.1, marginTop: 1 },
})

function Label({ l }: { l: SpLabelData }) {
  const c = l.codes
  return (
    <View style={s.label}>
      {/* Article client · N° de commande · order barcode */}
      <View style={[s.top, s.rule]}>
        <View style={[s.topCol, { width: 92 }]}>
          <Text style={s.lab}>ARTICLE CLIENT</Text>
          <Text style={s.val}>{l.articleClient}</Text>
        </View>
        <View style={[s.topCol, { width: 112 }]}>
          <Text style={s.lab}>N° DE CDE CLIENT</Text>
          <Text style={s.val}>{l.commandeClient}</Text>
        </View>
        <View style={{ flex: 1, alignItems: 'flex-end' }}>
          <Code128Bars symbol={c.order} width={LABEL_W - 92 - 112 - 4} height={30} />
        </View>
      </View>

      {/* Gold band · article, EAN, bain, lot · coloris */}
      <View style={[s.mid, s.rule]}>
        <View style={s.band}>
          <Text style={s.bandText}>Malterre</Text>
        </View>
        <View style={s.midBody}>
          <View style={[s.row, { justifyContent: 'space-between' }]}>
            <Text style={s.lab}>ARTICLE FOURNISSEUR</Text>
            <Text style={s.val}>{l.articleFournisseur}</Text>
          </View>
          <View style={[s.row, { justifyContent: 'flex-end', marginTop: 2 }]}>
            <Text style={[s.lab, { marginRight: 8 }]}>CODE EAN 13</Text>
            <Text style={[s.val, { width: 64, textAlign: 'right' }]}>{l.ean13}</Text>
          </View>
          <View style={[s.row, { marginTop: 2 }]}>
            <View style={{ flex: 1 }}>
              <Text style={[s.lab, { marginTop: 5 }]}>LIBELLE ARTICLE</Text>
              <Text style={s.val}>{l.libelleArticle}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <View style={s.row}>
                <Text style={[s.lab, { marginRight: 8 }]}>N° DE BAIN DE TEINTURE</Text>
                <Text style={[s.val, { width: 64, textAlign: 'right' }]}>{c.bain8}</Text>
              </View>
              <View style={[s.row, { marginTop: 3 }]}>
                <Text style={[s.lab, { marginRight: 8 }]}>N° DE LOT</Text>
                <Text style={[s.val, { width: 64, textAlign: 'right' }]}>{c.lot8}</Text>
              </View>
            </View>
          </View>
          <Text style={s.coloris}>{l.coloris}</Text>
        </View>
      </View>

      {/* Quantities */}
      <View style={[s.qty, s.rule]}>
        <View style={s.qtyCol}>
          <Text style={[s.lab, { textAlign: 'center' }]}>QUANTITE BRUTE</Text>
          <Text style={[s.val, { textAlign: 'center', marginTop: 2 }]}>{c.brut6}</Text>
          <View style={[s.row, { justifyContent: 'center', marginTop: 7 }]}>
            <Text style={[s.lab, { marginRight: 5 }]}>TARE</Text>
            <Text style={s.val}>{String(l.tare)}</Text>
          </View>
        </View>
        <View style={[s.qtyCol, { flex: 1.3 }]}>
          <View style={s.row}>
            <Text style={[s.lab, { marginRight: 5 }]}>UNITE DE MESURE</Text>
            <Text style={s.val}>MTR</Text>
          </View>
          <View style={[s.row, { marginTop: 3 }]}>
            <Text style={[s.lab, { marginRight: 14 }]}>LAIZE REELLE</Text>
            <Text style={s.val}>{c.laize6}</Text>
          </View>
          <View style={[s.row, { marginTop: 5 }]}>
            <Text style={[s.lab, { marginRight: 5 }]}>SSCC</Text>
            <Text style={s.val}>{c.sscc}</Text>
          </View>
        </View>
        <View style={[s.qtyCol, { alignItems: 'flex-end' }]}>
          <Text style={s.lab}>QUANTITE NETTE</Text>
          <Text style={[s.val, { marginTop: 2 }]}>{c.net6}</Text>
          <Text style={[s.lab, { marginTop: 5 }]}>POIDS TOTAL</Text>
          <View style={s.row}>
            <Text style={[s.val, { marginRight: 8 }]}>{String(Math.round(l.poids))}</Text>
            <Text style={s.lab}>Kg</Text>
          </View>
        </View>
      </View>

      {/* GS1-128 */}
      <View style={{ alignItems: 'center', marginTop: 5 }}>
        <Code128Bars symbol={c.logistic} width={LABEL_W - 60} height={30} />
        <Text style={s.hri}>{c.hri1}</Text>
      </View>
      <View style={{ alignItems: 'center', marginTop: 3 }}>
        <Code128Bars symbol={c.product} width={LABEL_W - 20} height={30} />
        <Text style={s.hri}>{c.hri2}</Text>
      </View>
    </View>
  )
}

export function EtiquettesSpPdf({ labels }: { labels: SpLabelData[] }) {
  const pages: SpLabelData[][] = []
  for (let i = 0; i < labels.length; i += 4) pages.push(labels.slice(i, i + 4))
  return (
    <Document title="Étiquettes Simone Pérèle" author="ETS Malterre">
      {pages.map((group, p) => (
        <Page key={p} size="A4" orientation="landscape" style={s.page}>
          {[group.slice(0, 2), group.slice(2, 4)].filter((r) => r.length > 0).map((row, r) => (
            <View key={r} style={s.cellRow}>
              {row.map((l, i) => (
                <View key={i} style={s.cell} wrap={false}>
                  <Label l={l} />
                </View>
              ))}
            </View>
          ))}
        </Page>
      ))}
    </Document>
  )
}
