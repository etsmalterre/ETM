// « Pointage stock de fil » — TRM Fils › Stock, toolbar « Pointage »
// (LIVA #1357). Nicolas prints it, walks the racks with a pen, ticks each lot he
// finds and writes what differs in « Note », then corrects the ERP at the desk.
//
// So the sheet is built for a pen, not for reading: rows sorted by emplacement
// then niveau (the walking order), roomy rows, an empty Note column and an
// empty box on the far right. No totals band (Vincent 2026-11-10): the sheet is
// the list, nothing else. Landscape A4 on the shared MalterreDocument frame;
// the table is the house one (BonLivraisonPdf: grey header, gold rule, framed),
// its header repeats on every page (`fixed`) and a row never splits.
//
// Issued by Tricotage Malterre → `companyTrm` footer.

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import { MalterreDocument } from './MalterreDocument.js'
import { colors, companyTrm, sizes } from './theme.js'

// ── Input shape ──────────────────────────────────────────

export interface PointageFilLigne {
  ref_fil: string
  colori_reference: string
  lot: string
  stock: number | null
  fournisseur_nom: string
  emplacement: string
  niveau: number | null
}

export interface PointageFilData {
  /** Long-form print date, e.g. « 10 Novembre 2026 ». */
  date_edition: string
  /** What the screen was narrowed to (« Emplacement : B », « nylon »…), or ''
   *  for the whole stock. Printed under the title so a partial sheet says so. */
  filtre: string
  lignes: PointageFilLigne[]
}

// ── Formatting ───────────────────────────────────────────

function fmtKg(value: number | null): string {
  if (value == null || Number.isNaN(value)) return '—'
  return value
    .toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/ | /g, ' ')
}

// ── Styles ───────────────────────────────────────────────

const styles = StyleSheet.create({
  // Same frame / header / row recipe as BonLivraisonPdf's piece table.
  table: {
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderRadius: 6,
    overflow: 'hidden',
  },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgMuted,
    borderBottomWidth: 2,
    borderBottomColor: colors.gold,
    borderBottomStyle: 'solid',
    paddingHorizontal: 8,
    // Explicit height: the `fixed` repeat on continuation pages otherwise
    // stretches the header box (see BonLivraisonPdf).
    height: 24,
  },
  // lineHeight tight and explicit: with the inherited 1.45 the text box
  // overflows the fixed-height header and react-pdf drops the labels.
  th: {
    fontSize: sizes.fontXs,
    color: colors.text,
    fontWeight: 900,
    letterSpacing: 0.5,
    lineHeight: 1.2,
    paddingHorizontal: 3,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 22,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderBottomWidth: 0.75,
    borderBottomColor: '#EEEEEE',
    borderBottomStyle: 'solid',
  },
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

export function PointageFilPdf({ data }: { data: PointageFilData }) {
  return (
    <MalterreDocument
      documentType="Pointage stock de fil"
      reference={data.filtre || 'Tout le stock'}
      subtleReference
      documentDate={data.date_edition}
      orientation="landscape"
      title={`Pointage stock de fil - ${data.date_edition}`}
      issuer={companyTrm}
    >
      {data.lignes.length === 0 ? (
        <Text style={styles.empty}>Aucun lot à pointer.</Text>
      ) : (
        <View style={styles.table}>
          <View style={styles.tableHeader} fixed>
            <Text style={[styles.th, COL.fil]}>FIL</Text>
            <Text style={[styles.th, COL.coloris]}>COLORIS</Text>
            <Text style={[styles.th, COL.lot]}>LOT</Text>
            <Text style={[styles.th, COL.stock, styles.right]}>STOCK (KG)</Text>
            <Text style={[styles.th, COL.fournisseur]}>FOURNISSEUR</Text>
            <Text style={[styles.th, COL.emplacement]}>EMPL.</Text>
            <Text style={[styles.th, COL.niveau, styles.right]}>NIV.</Text>
            <Text style={[styles.th, COL.note]}>NOTE</Text>
            <Text style={[styles.th, COL.check, styles.center]}>OK</Text>
          </View>
          {data.lignes.map((l, i) => (
            <View key={i} style={styles.row} wrap={false}>
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
