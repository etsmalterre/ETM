// « Tableau de métrage » sent to MATEL for a Simone Pérèle order line
// (LIVA #1200). MATEL fills it by hand — gross length, net length, laize,
// tare (number of defects), samples taken, net weight — and scans it back;
// those numbers then feed the roll labels (EtiquettesSpPdf).
//
// Copied from the Word sheet Pierrot used to fill by hand (« 107052 - tableau
// métrage 469 rose fumee.pdf »): same header lines, same seven columns, same
// explanation row under the headings. What changes is that ETM prints the
// header and the roll numbers itself.

import React from 'react'
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer'

export interface TableauMetrageData {
  commandeClient: string
  articleClient: string
  libelle: string
  lot: string
  bain: string
  coloris: string
  rolls: string[]
}

/** Blank rows the sheet always offers, so MATEL can add a roll by hand. */
const MIN_ROWS = 8

const COLS: Array<{ title: string; hint: string; width: string }> = [
  { title: 'N° pièce fournisseur', hint: '', width: '13%' },
  { title: 'Métrage brut', hint: '= métrage de la pièce totale que le client va recevoir', width: '16%' },
  { title: 'Métrage net', hint: '= métrage brut - les défauts : ce que le client va pouvoir utiliser', width: '16%' },
  { title: 'Laize nette', hint: 'Entre lisières encollées', width: '16%' },
  { title: 'Tare', hint: '= Total des défauts : frottements, trous…', width: '13%' },
  { title: 'Prélèvements', hint: '', width: '12%' },
  { title: 'Poids de la pièce nette', hint: '', width: '14%' },
]

const s = StyleSheet.create({
  page: { fontFamily: 'Helvetica', fontSize: 11, paddingHorizontal: 42, paddingVertical: 36, color: '#000000' },
  title: { fontSize: 22, fontFamily: 'Helvetica-Bold', textAlign: 'center', marginBottom: 14 },
  line: { flexDirection: 'row', marginBottom: 4, lineHeight: 1.2 },
  key: { fontFamily: 'Helvetica-Bold', textDecoration: 'underline', marginRight: 6 },
  table: { marginTop: 14, borderTopWidth: 0.8, borderLeftWidth: 0.8 },
  tr: { flexDirection: 'row' },
  cell: { borderRightWidth: 0.8, borderBottomWidth: 0.8, paddingHorizontal: 4, justifyContent: 'center' },
  th: { fontSize: 10, textAlign: 'center', paddingVertical: 5 },
  hint: { fontSize: 8, textAlign: 'center', paddingVertical: 4, lineHeight: 1.2 },
  td: { fontSize: 11, textAlign: 'center', height: 30, paddingTop: 9 },
})

export function TableauMetragePdf({ data }: { data: TableauMetrageData }) {
  const rows = [...data.rolls]
  while (rows.length < MIN_ROWS) rows.push('')
  return (
    <Document title={`Tableau de métrage ${data.lot}`} author="ETS Malterre">
      <Page size="A4" orientation="landscape" style={s.page}>
        <Text style={s.title}>ETS MALTERRE</Text>
        <View style={s.line}><Text style={s.key}>N° de commande SP :</Text><Text>{data.commandeClient}</Text></View>
        <View style={s.line}><Text style={s.key}>Code article SP :</Text><Text>{[data.articleClient, data.bain].filter(Boolean).join(' ')}</Text></View>
        <View style={s.line}><Text style={s.key}>Libellé SP :</Text><Text>{[data.libelle, data.coloris].filter(Boolean).join(' – ')}</Text></View>
        <View style={s.line}><Text style={s.key}>N° de lot de teinture :</Text><Text>{data.lot}</Text></View>
        <View style={s.line}>
          <Text style={s.key}>Bain de teinture :</Text><Text style={{ marginRight: 14 }}>{data.bain}</Text>
          <Text style={s.key}>Code coloris</Text><Text>{data.coloris}</Text>
        </View>

        <View style={s.table}>
          <View style={s.tr}>
            {COLS.map((c) => <View key={c.title} style={[s.cell, { width: c.width }]}><Text style={s.th}>{c.title}</Text></View>)}
          </View>
          <View style={s.tr}>
            {COLS.map((c) => <View key={c.title} style={[s.cell, { width: c.width }]}><Text style={s.hint}>{c.hint}</Text></View>)}
          </View>
          {rows.map((numero, i) => (
            <View key={i} style={s.tr} wrap={false}>
              {COLS.map((c, j) => (
                <View key={c.title} style={[s.cell, { width: c.width }]}>
                  <Text style={s.td}>{j === 0 ? numero : ''}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </Page>
    </Document>
  )
}
