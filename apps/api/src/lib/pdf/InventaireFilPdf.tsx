// Feuille d'inventaire du stock de fil — TRM Fils › Stock, toolbar « Imprimer »
// (LIVA #1357). Nicolas prints it, walks the racks with a pen, ticks each lot he
// finds and writes what differs in « Note », then corrects the ERP at the desk.
//
// So the sheet is built for a pen, not for reading: rows sorted by emplacement
// then niveau (the walking order), tall rows, an empty Note column and an empty
// box on the far right. Landscape A4 on the shared MalterreDocument frame; the
// column header repeats on every page (`fixed`), a row never splits.
//
// Issued by Tricotage Malterre → `companyTrm` footer.

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import { MalterreDocument } from './MalterreDocument.js'
import { colors, companyTrm } from './theme.js'

// ── Input shape ──────────────────────────────────────────

export interface InventaireFilLigne {
  ref_fil: string
  colori_reference: string
  lot: string
  stock: number | null
  fournisseur_nom: string
  emplacement: string
  niveau: number | null
}

export interface InventaireFilData {
  /** Long-form print date, e.g. « 10 Novembre 2026 ». */
  date_edition: string
  /** What the screen was narrowed to (« Emplacement : B », « nylon »…), or ''
   *  for the whole stock. Printed so a partial sheet says it is partial. */
  filtre: string
  lignes: InventaireFilLigne[]
}

// ── Formatting ───────────────────────────────────────────

function fmtKg(value: number | null): string {
  if (value == null || Number.isNaN(value)) return '—'
  return value
    .toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/ | /g, ' ')
}

// ── Styles ───────────────────────────────────────────────

const ROW_HEIGHT = 21

const styles = StyleSheet.create({
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCream,
    borderLeftWidth: 3,
    borderLeftColor: colors.gold,
    borderRadius: 3,
    paddingVertical: 7,
    paddingHorizontal: 10,
    marginBottom: 10,
  },
  summaryMain: { flex: 1 },
  summaryValue: { fontSize: 10, color: colors.text, fontWeight: 700 },
  summaryFiltre: { fontSize: 8.5, color: colors.muted, marginTop: 2 },
  signature: { flexDirection: 'row', alignItems: 'flex-end' },
  signatureLabel: { fontSize: 8.5, color: colors.muted, marginLeft: 16 },
  signatureLine: {
    width: 110,
    borderBottomWidth: 0.75,
    borderBottomColor: colors.borderStrong,
    marginLeft: 4,
    marginBottom: 1,
  },

  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary,
    height: 20,
    paddingHorizontal: 6,
  },
  th: { fontSize: 8, lineHeight: 1.2, color: '#ffffff', fontWeight: 700, paddingHorizontal: 3 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: ROW_HEIGHT,
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.borderStrong,
  },
  rowAlt: { backgroundColor: '#FAFAFA' },
  td: { fontSize: 9, lineHeight: 1.2, color: colors.text, paddingHorizontal: 3 },
  tdStrong: { fontSize: 9, lineHeight: 1.2, color: colors.text, fontWeight: 700, paddingHorizontal: 3 },
  tdMuted: { fontSize: 9, lineHeight: 1.2, color: colors.muted, paddingHorizontal: 3 },
  right: { textAlign: 'right' },
  center: { textAlign: 'center' },

  // The two pen columns: a ruled Note cell and an empty box. The Note cell
  // stretches over the row's vertical padding so its rules touch the row lines
  // (a row grows when a long fil name wraps).
  noteCell: {
    alignSelf: 'stretch',
    marginVertical: -3,
    borderLeftWidth: 0.5,
    borderLeftColor: colors.borderStrong,
    borderRightWidth: 0.5,
    borderRightColor: colors.borderStrong,
  },
  checkCell: { alignItems: 'center', justifyContent: 'center' },
  checkBox: {
    width: 11,
    height: 11,
    borderWidth: 1,
    borderColor: colors.text,
    borderRadius: 1.5,
  },

  empty: { fontSize: 9, color: colors.muted, marginTop: 8 },
})

// Widths sum to 100 %. Note gets the room: it is where the sheet is written on.
const COL = {
  fil: { width: '17%' },
  coloris: { width: '13%' },
  lot: { width: '7%' },
  stock: { width: '8%' },
  fournisseur: { width: '14%' },
  emplacement: { width: '8%' },
  niveau: { width: '5%' },
  note: { width: '23%' },
  check: { width: '5%' },
} as const

// ── Component ─────────────────────────────────────────────

export function InventaireFilPdf({ data }: { data: InventaireFilData }) {
  const total = data.lignes.reduce((s, l) => s + (l.stock ?? 0), 0)
  const lots = data.lignes.length
  return (
    <MalterreDocument
      documentType="Inventaire du fil"
      reference={`${lots} lot${lots > 1 ? 's' : ''}`}
      documentDate={data.date_edition}
      orientation="landscape"
      title={`Inventaire du fil - ${data.date_edition}`}
      issuer={companyTrm}
    >
      <View style={styles.summary}>
        <View style={styles.summaryMain}>
          <Text style={styles.summaryValue}>
            {lots} lot{lots > 1 ? 's' : ''} · {fmtKg(total)} kg en stock
          </Text>
          <Text style={styles.summaryFiltre}>
            {data.filtre ? `Filtre : ${data.filtre}` : 'Tout le stock disponible'}
          </Text>
        </View>
        <View style={styles.signature}>
          <Text style={styles.signatureLabel}>Pointé par</Text>
          <View style={styles.signatureLine} />
          <Text style={styles.signatureLabel}>le</Text>
          <View style={[styles.signatureLine, { width: 70 }]} />
        </View>
      </View>

      {lots === 0 ? (
        <Text style={styles.empty}>Aucun lot à pointer.</Text>
      ) : (
        <View>
          <View style={styles.tableHeader} fixed>
            <Text style={[styles.th, COL.fil]}>Fil</Text>
            <Text style={[styles.th, COL.coloris]}>Coloris</Text>
            <Text style={[styles.th, COL.lot]}>Lot</Text>
            <Text style={[styles.th, COL.stock, styles.right]}>Stock (kg)</Text>
            <Text style={[styles.th, COL.fournisseur]}>Fournisseur</Text>
            <Text style={[styles.th, COL.emplacement]}>Empl.</Text>
            <Text style={[styles.th, COL.niveau, styles.right]}>Niv.</Text>
            <Text style={[styles.th, COL.note]}>Note</Text>
            <Text style={[styles.th, COL.check, styles.center]}>OK</Text>
          </View>
          {data.lignes.map((l, i) => (
            <View key={i} style={i % 2 === 1 ? [styles.row, styles.rowAlt] : styles.row} wrap={false}>
              <Text style={[styles.td, COL.fil]}>{l.ref_fil || '—'}</Text>
              <Text style={[styles.td, COL.coloris]}>{l.colori_reference || '—'}</Text>
              <Text style={[styles.tdStrong, COL.lot]}>{l.lot || '—'}</Text>
              <Text style={[styles.td, COL.stock, styles.right]}>{fmtKg(l.stock)}</Text>
              <Text style={[styles.td, COL.fournisseur]}>{l.fournisseur_nom || '—'}</Text>
              <Text style={[styles.tdStrong, COL.emplacement]}>{l.emplacement || '—'}</Text>
              <Text style={[styles.tdMuted, COL.niveau, styles.right]}>{l.niveau ?? '—'}</Text>
              <View style={[styles.noteCell, COL.note]} />
              <View style={[styles.checkCell, COL.check]}>
                <View style={styles.checkBox} />
              </View>
            </View>
          ))}
        </View>
      )}
    </MalterreDocument>
  )
}
