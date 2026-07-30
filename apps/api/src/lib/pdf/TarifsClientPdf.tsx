// PDF document for the "Fiche Tarifs" sent to a client — the ETM port of
// the legacy Choix_Matiere_Tarif → Fiche Tarif report, restyled to the ETM
// document design language (shared with Devis / Commande / Facture): cream
// gold-left cards, primary-blue references, icon + caps section titles, and a
// gold-underlined table header.
//
// One section per client référence: a header card (Tag icon + Ref in French
// blue + contexture, with Laize / Poids metric tiles and a BIO chip on the
// right) above a quantity-tranche price grid with one price column per selected
// coloris. The two quantity columns are tinted as an "axis panel" so the eye
// separates the tranche axis from the price matrix. Prices are the
// PrixDeVenteV4 €/Ml values (calcTarifRefFini), filtered by the
// ref_client_colori.lst_tranche indices — matching the legacy figures exactly.

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import { MalterreDocument, TagIcon, CalendarIcon } from './MalterreDocument.js'
import { colors, sizes } from './theme.js'

// ── Input shape ──────────────────────────────────────────

export interface TarifsSectionData {
  /** Client-facing reference, e.g. "049A" (designation_client.designation) */
  ref: string
  /** Knit-structure label, e.g. "double face piqué" (contexture.nom) */
  contexture: string | null
  /** Width in cm (ref_fini.laizeHT_Moy) */
  laize: number | null
  /** Weight in g/m² (ref_fini.poids_Moy) */
  poids: number | null
  /** Organic cotton flag (ref_ecru.bio) */
  bio: boolean
  /** One label per selected coloris — the table's price columns */
  colorisLabels: string[]
  /** Tranche rows (union of the coloris' lst_tranche indices, ascending) */
  rows: Array<{
    /** "< 1", "1", "2", … "30" */
    rlx: string
    /** "< 44", "44", "89", … */
    ml: string
    /** €/Ml per coloris column — null renders an empty cell */
    prices: Array<number | null>
  }>
}

export interface TarifsClientPdfData {
  clientNom: string
  /** Long-form French date shown in the header, e.g. "7 Juillet 2026" */
  dateDocument: string
  /** Short French date the tarifs stay valid until, e.g. "07/07/2027" */
  validUntil: string
  sections: TarifsSectionData[]
}

// ── French number formatting ─────────────────────────────
function fmtNum(value: number | null | undefined, decimals = 0): string {
  if (value == null || Number.isNaN(value)) return ''
  return value
    .toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace(/ | /g, ' ')
}

// ── Styles ───────────────────────────────────────────────

const COL_QTY_WIDTH = 66
const COL_PRICE_WIDTH = 88

const styles = StyleSheet.create({
  // ── Document conditions strip (once, top) ───────────
  // Consolidates the two legacy fixed notes (HT / mètre linéaire + validity)
  // into a single cream gold-left card matching the app's info-card language.
  intro: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    backgroundColor: colors.bgCream,
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderLeftWidth: 2,
    borderLeftColor: colors.gold,
    borderLeftStyle: 'solid',
    borderRadius: 6,
    paddingVertical: 7,
    paddingHorizontal: 10,
    marginBottom: 16,
  },
  introItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  introLabel: { fontSize: sizes.fontSm, color: colors.muted, fontWeight: 700, lineHeight: 1 },
  introStrong: { fontSize: sizes.fontSm, color: colors.text, fontWeight: 900, lineHeight: 1 },

  section: {
    marginBottom: 16,
  },

  // ── Section header card ─────────────────────────────
  // Cream card, gold left edge, thin border — the app's card frame. Tag icon +
  // "RÉF." caps label + the ref in French blue on the left; Laize / Poids
  // metric tiles and a BIO chip pinned right.
  band: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCream,
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderLeftWidth: 2,
    borderLeftColor: colors.gold,
    borderLeftStyle: 'solid',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 7,
  },
  refCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  // NOTE: no fontStyle:'italic' anywhere in this doc — the bundled Lato has no
  // italic face and @react-pdf hard-fails on unresolvable font variants.
  refLabel: {
    fontSize: sizes.fontXs,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.5,
    lineHeight: 1,
    marginLeft: 6,
  },
  refValue: {
    fontSize: sizes.fontLg,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.3,
    lineHeight: 1,
    marginLeft: 5,
  },
  contexture: {
    fontSize: sizes.fontBase,
    color: colors.muted,
    marginLeft: 10,
    lineHeight: 1,
    flexShrink: 1,
  },
  bandSpacer: {
    flexGrow: 1,
  },

  // Metric tile: caps micro-label stacked over a bold value, right-aligned.
  metricsGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metric: {
    flexDirection: 'column',
    alignItems: 'flex-end',
    marginLeft: 18,
  },
  metricLabel: {
    fontSize: 6.5,
    color: colors.muted,
    fontWeight: 700,
    letterSpacing: 0.5,
    lineHeight: 1,
    marginBottom: 2.5,
  },
  metricValue: {
    fontSize: sizes.fontMd,
    color: colors.text,
    fontWeight: 900,
    lineHeight: 1,
  },
  bioBadge: {
    marginLeft: 18,
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: '#DCFCE7',
    color: '#15803D',
    fontSize: 6.5,
    fontWeight: 900,
    letterSpacing: 0.6,
    borderRadius: 3,
    lineHeight: 1,
  },

  // ── Tranche price grid ──────────────────────────────
  // Framed, rounded, sized to its columns (not full width) — matches the
  // Devis / Commande line tables.
  table: {
    alignSelf: 'flex-start',
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderRadius: 6,
    overflow: 'hidden',
  },
  headerRow: {
    flexDirection: 'row',
    backgroundColor: colors.bgMuted,
    borderBottomWidth: 2,
    borderBottomColor: colors.gold,
    borderBottomStyle: 'solid',
  },
  // Tight explicit lineHeight on all table text — the content container's
  // inherited 1.45 inflates every row and drops the doc to one section per
  // page (legacy packs two).
  headerCell: {
    fontSize: sizes.fontSm,
    fontWeight: 900,
    color: colors.text,
    letterSpacing: 0.4,
    textAlign: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    lineHeight: 1.2,
  },
  // The two quantity columns carry the tranche axis, not price data — a slightly
  // stronger caps treatment marks them as headers of that axis.
  headerCellAxis: {
    color: colors.muted,
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.75,
    borderBottomColor: '#EEEEEE',
    borderBottomStyle: 'solid',
  },
  rowLast: {
    flexDirection: 'row',
  },
  cell: {
    fontSize: sizes.fontMd,
    color: colors.text,
    textAlign: 'center',
    paddingVertical: 4.5,
    paddingHorizontal: 4,
    lineHeight: 1.15,
  },
  // Quantity (axis) cells: muted, tinted background so the two columns read as a
  // distinct panel separating the tranche axis from the price matrix.
  cellAxis: {
    color: colors.muted,
    fontWeight: 700,
    backgroundColor: '#F7F8FA',
  },
  // Price cells: the payload — a touch heavier so figures stand out.
  cellPrice: {
    fontWeight: 700,
    color: colors.text,
  },
  colQty: {
    width: COL_QTY_WIDTH,
  },
  colQtyDivider: {
    borderRightWidth: 0.75,
    borderRightColor: colors.borderStrong,
    borderRightStyle: 'solid',
  },
  colPrice: {
    width: COL_PRICE_WIDTH,
  },
})

// ── Component ────────────────────────────────────────────

export function TarifsClientPdf({ data }: { data: TarifsClientPdfData }) {
  return (
    <MalterreDocument
      documentType="Tarifs"
      reference={data.clientNom}
      documentDate={data.dateDocument}
      title={`Fiche Tarifs ${data.clientNom}`}
    >
      {/* Conditions strip — HT / mètre linéaire + validity, once at the top */}
      <View style={styles.intro}>
        <View style={styles.introItem}>
          <TagIcon size={11} />
          <Text style={styles.introLabel}>
            Prix Hors Taxes en <Text style={styles.introStrong}>€ / mètre linéaire</Text> (Ml)
          </Text>
        </View>
        {data.validUntil ? (
          <View style={styles.introItem}>
            <CalendarIcon size={11} />
            <Text style={styles.introLabel}>
              Valables jusqu'au <Text style={styles.introStrong}>{data.validUntil}</Text>
            </Text>
          </View>
        ) : null}
      </View>

      {data.sections.map((s, si) => (
        <View key={si} style={styles.section} wrap={false}>
          {/* Section header card */}
          <View style={styles.band}>
            <View style={styles.refCluster}>
              <TagIcon size={12} />
              <Text style={styles.refLabel}>RÉF.</Text>
              <Text style={styles.refValue}>{s.ref}</Text>
              {s.contexture ? <Text style={styles.contexture}>{s.contexture}</Text> : null}
            </View>
            <View style={styles.bandSpacer} />
            <View style={styles.metricsGroup}>
              {s.laize != null && s.laize > 0 ? (
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>LAIZE</Text>
                  <Text style={styles.metricValue}>{fmtNum(s.laize)} cm</Text>
                </View>
              ) : null}
              {s.poids != null && s.poids > 0 ? (
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>POIDS</Text>
                  <Text style={styles.metricValue}>{fmtNum(s.poids)} g/m²</Text>
                </View>
              ) : null}
              {s.bio ? <Text style={styles.bioBadge}>BIO</Text> : null}
            </View>
          </View>

          {/* Tranche price grid */}
          <View style={styles.table}>
            <View style={styles.headerRow}>
              <Text style={[styles.headerCell, styles.headerCellAxis, styles.colQty]}>Qté (Rlx)</Text>
              <Text style={[styles.headerCell, styles.headerCellAxis, styles.colQty, styles.colQtyDivider]}>Qté (Ml)</Text>
              {s.colorisLabels.map((label, ci) => (
                <Text key={ci} style={[styles.headerCell, styles.colPrice]}>{label}</Text>
              ))}
            </View>
            {s.rows.map((r, ri) => {
              const last = ri === s.rows.length - 1
              return (
                <View key={ri} style={last ? styles.rowLast : styles.row}>
                  <Text style={[styles.cell, styles.cellAxis, styles.colQty]}>{r.rlx}</Text>
                  <Text style={[styles.cell, styles.cellAxis, styles.colQty, styles.colQtyDivider]}>{r.ml}</Text>
                  {r.prices.map((p, ci) => (
                    <Text key={ci} style={[styles.cell, styles.cellPrice, styles.colPrice]}>
                      {p != null ? `${fmtNum(p, 2)} €` : ''}
                    </Text>
                  ))}
                </View>
              )
            })}
          </View>
        </View>
      ))}
    </MalterreDocument>
  )
}
