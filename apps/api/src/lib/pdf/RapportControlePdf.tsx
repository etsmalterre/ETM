// PDF document for the "Rapport de contrôle" (quality control report) of ONE
// lot, sent to one client from Qualité › Suivi lots (LIVA #1304; it used to
// ride on the BL of each shipment — the legacy WinDev ETAT_RapportQualité,
// RC<expeditionId>.pdf). Layout, in the ETM design language:
//  - top row: metadata card (client, n° commande(s), réf. client, lot)
//  - the article: identity block (ref - coloris, designation), then a framed
//    5-column table: LOT · PARAMÈTRE · VALEUR MIN · VALEUR MAX · VALEUR RELEVÉE
//  - the client's pieces of the lot (numéro, poids, métrage) — only theirs
// Tolerances come from ref_fini (laizeHT/poids min-max, stab_hauteur/largeur)
// and the "valeur relevée" is the in-house tirelle measurement from suivilot.
// Legacy prints the same fixed 4 parameters (Laize HT, Poids, Stab H, Stab L)
// per lot; a lot with no suivilot row keeps its tolerance rows with a blank
// relevé column.

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import { MalterreDocument, UserIcon, MessageSquareIcon, TagIcon } from './MalterreDocument.js'
import { colors, sizes } from './theme.js'

export interface RcRow {
  /** "Laize HT" · "Poids" · "Stab H" · "Stab L" */
  parametre: string
  min: number | null
  max: number | null
  /** In-house measured value (suivilot *_tirelle). null → blank cell. */
  releve: number | null
}

export interface RcLot {
  lot: string
  /** false when the lot has no suivilot row — relevés all blank. */
  hasSuivilot: boolean
  rows: RcRow[]
}

export interface RcPiece {
  numero: string
  poids: number
  metrage: number
}

export interface RcArticle {
  /** "228/122 - 0481 rouge intense 61221/1" (ref · coloris) */
  titre: string
  /** "Jersey Coton 115g" (designation) */
  sousTitre: string | null
  lots: RcLot[]
  /** The client's pieces of the lot. */
  pieces: RcPiece[]
}

export interface RapportControlePdfData {
  /** The lot — the report's reference in the branded header. */
  lot: string
  /** "17 mars 2026" — long-form French. */
  dateLong: string
  clientNom: string
  /** The client's order numbers the pieces are affected to. */
  commandes: string[]
  refClient: string | null
  articles: RcArticle[]
}

// Integer-friendly fr-FR formatting: "147", "-8", "108,5" — the tolerances
// and relevés are mostly integers and the legacy report prints them bare.
function fmtVal(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return ''
  return value
    .toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    .replace(/ | /g, ' ')
}

const styles = StyleSheet.create({
  topRow: { flexDirection: 'row', gap: 14, marginBottom: 14, alignItems: 'stretch' },
  topRowSlot: { flex: 1, flexDirection: 'column' },

  metaCard: {
    flexGrow: 1,
    backgroundColor: colors.bgCream,
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderLeftWidth: 2,
    borderLeftColor: colors.gold,
    borderLeftStyle: 'solid',
    borderRadius: 6,
    padding: 10,
  },
  metaRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 1.5 },
  metaIconBox: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  metaLabel: { width: 88, fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, lineHeight: 1.25 },
  metaValue: { flex: 1, fontSize: sizes.fontBase, color: colors.text, fontWeight: 700, textAlign: 'right', lineHeight: 1.25 },

  // Article identity block
  article: { marginBottom: 14 },
  articleTitre: { fontSize: 11.5, color: colors.primary, fontWeight: 900, lineHeight: 1.35 },
  articleLine: { fontSize: 10.5, color: colors.text, lineHeight: 1.35 },

  // Parameters table
  table: {
    marginTop: 8,
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderRadius: 6,
    overflow: 'hidden',
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: colors.bgMuted,
    borderBottomWidth: 2,
    borderBottomColor: colors.gold,
    borderBottomStyle: 'solid',
    paddingVertical: 6,
    paddingHorizontal: 10,
    height: 24,
  },
  tableHeaderCell: { fontSize: sizes.fontXs, color: colors.text, fontWeight: 900, letterSpacing: 0.5, lineHeight: 1.2 },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderBottomWidth: 0.75,
    borderBottomColor: '#EEEEEE',
    borderBottomStyle: 'solid',
    alignItems: 'flex-start',
  },
  // First row of a new lot group gets a stronger top edge to separate groups.
  lotGroupStart: {
    borderTopWidth: 0.75,
    borderTopColor: colors.borderStrong,
    borderTopStyle: 'solid',
  },
  cellBase: { fontSize: 10, color: colors.text, lineHeight: 1.2 },
  colLot: { width: 110, paddingRight: 6, fontWeight: 900 },
  colParam: { flex: 1, paddingRight: 6 },
  colNum: { width: 86, textAlign: 'right', paddingHorizontal: 4 },
  releveValue: { fontWeight: 900 },
  releveOk: { color: '#16A34A' },      // within tolerance — green (matches legacy RC)
  releveOut: { color: '#DC2626' },     // out of tolerance — red
  releveMissing: { color: colors.muted },

  piecesTitle: { marginTop: 12, fontSize: sizes.fontXs, color: colors.muted, fontWeight: 900, letterSpacing: 0.5 },
  colPiece: { flex: 1, paddingRight: 6 },
  totalRow: { flexDirection: 'row', paddingVertical: 5, paddingHorizontal: 10, backgroundColor: colors.bgMuted },
})

function fmtDec(value: number, digits: number): string {
  return value
    .toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    .replace(/[  ]/g, ' ')
}

/** Tolerance check for a measured value. Bounds are open-ended when null
 *  (stab rows only carry a min). No bounds at all → no verdict (neutral). */
function releveStatus(row: RcRow): 'ok' | 'out' | 'neutral' {
  if (row.releve == null) return 'neutral'
  if (row.min == null && row.max == null) return 'neutral'
  if (row.min != null && row.releve < row.min) return 'out'
  if (row.max != null && row.releve > row.max) return 'out'
  return 'ok'
}

function MetaRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <View style={styles.metaIconBox}>{icon}</View>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  )
}

export function RapportControlePdf({ data }: { data: RapportControlePdfData }) {
  return (
    <MalterreDocument
      // No accent on purpose — the uppercased Ô renders badly in the header font.
      documentType="Rapport de controle"
      reference={`Lot ${data.lot}`}
      documentDate={data.dateLong || ''}
      title={`Rapport de contrôle ${data.lot}`}
    >
      {/* Lot metadata */}
      <View style={styles.topRow}>
        <View style={styles.topRowSlot}>
          <View style={styles.metaCard}>
            <MetaRow icon={<UserIcon />} label="Client" value={data.clientNom || '—'} />
            {data.commandes.length > 0 ? (
              <MetaRow
                icon={<TagIcon />}
                label={data.commandes.length > 1 ? 'N° commandes' : 'N° commande'}
                value={data.commandes.join(', ')}
              />
            ) : null}
            {data.refClient ? (
              <MetaRow icon={<MessageSquareIcon />} label="Réf. client" value={data.refClient} />
            ) : null}
            <MetaRow icon={<TagIcon />} label="Lot" value={data.lot} />
          </View>
        </View>
      </View>

      {/* The lot's article (one; the shape keeps a list) */}
      {data.articles.map((article, ai) => (
        <View key={ai} style={styles.article}>
          <View wrap={false} minPresenceAhead={100}>
            <Text style={styles.articleTitre}>{article.titre}</Text>
            {article.sousTitre ? <Text style={styles.articleLine}>{article.sousTitre}</Text> : null}
          </View>

          <View style={styles.table}>
            <View style={styles.tableHeader} fixed>
              <Text style={[styles.tableHeaderCell, styles.colLot]}>LOT</Text>
              <Text style={[styles.tableHeaderCell, styles.colParam]}>PARAMÈTRE</Text>
              <Text style={[styles.tableHeaderCell, styles.colNum]}>VALEUR MIN</Text>
              <Text style={[styles.tableHeaderCell, styles.colNum]}>VALEUR MAX</Text>
              <Text style={[styles.tableHeaderCell, styles.colNum]}>VALEUR RELEVÉE</Text>
            </View>
            {article.lots.map((lot, li) =>
              lot.rows.map((row, ri) => (
                <View
                  key={`${li}-${ri}`}
                  style={li > 0 && ri === 0 ? [styles.tableRow, styles.lotGroupStart] : styles.tableRow}
                  wrap={false}
                >
                  {/* Lot printed on the first row of its group only */}
                  <Text style={[styles.cellBase, styles.colLot]}>{ri === 0 ? lot.lot || '—' : ''}</Text>
                  <Text style={[styles.cellBase, styles.colParam]}>{row.parametre}</Text>
                  <Text style={[styles.cellBase, styles.colNum]}>{fmtVal(row.min)}</Text>
                  <Text style={[styles.cellBase, styles.colNum]}>{fmtVal(row.max)}</Text>
                  <Text
                    style={
                      lot.hasSuivilot
                        ? [
                            styles.cellBase,
                            styles.colNum,
                            styles.releveValue,
                            ...(releveStatus(row) === 'ok'
                              ? [styles.releveOk]
                              : releveStatus(row) === 'out'
                                ? [styles.releveOut]
                                : []),
                          ]
                        : [styles.cellBase, styles.colNum, styles.releveMissing]
                    }
                  >
                    {lot.hasSuivilot ? fmtVal(row.releve) : ''}
                  </Text>
                </View>
              )),
            )}
          </View>

          {article.pieces.length > 0 ? (
            <>
              <Text style={styles.piecesTitle}>
                {article.pieces.length > 1 ? `VOS ${article.pieces.length} PIÈCES DE CE LOT` : 'VOTRE PIÈCE DE CE LOT'}
              </Text>
              <View style={[styles.table, { marginTop: 4 }]}>
                <View style={styles.tableHeader} fixed>
                  <Text style={[styles.tableHeaderCell, styles.colPiece]}>PIÈCE</Text>
                  <Text style={[styles.tableHeaderCell, styles.colNum]}>POIDS (KG)</Text>
                  <Text style={[styles.tableHeaderCell, styles.colNum]}>MÉTRAGE (ML)</Text>
                </View>
                {article.pieces.map((p, pi) => (
                  <View key={pi} style={styles.tableRow} wrap={false}>
                    <Text style={[styles.cellBase, styles.colPiece]}>{p.numero}</Text>
                    <Text style={[styles.cellBase, styles.colNum]}>{fmtDec(p.poids, 1)}</Text>
                    <Text style={[styles.cellBase, styles.colNum]}>{fmtDec(p.metrage, 1)}</Text>
                  </View>
                ))}
                {article.pieces.length > 1 ? (
                  <View style={styles.totalRow} wrap={false}>
                    <Text style={[styles.cellBase, styles.colPiece, { fontWeight: 900 }]}>Total</Text>
                    <Text style={[styles.cellBase, styles.colNum, { fontWeight: 900 }]}>
                      {fmtDec(article.pieces.reduce((t, p) => t + p.poids, 0), 1)}
                    </Text>
                    <Text style={[styles.cellBase, styles.colNum, { fontWeight: 900 }]}>
                      {fmtDec(article.pieces.reduce((t, p) => t + p.metrage, 0), 1)}
                    </Text>
                  </View>
                ) : null}
              </View>
            </>
          ) : null}
        </View>
      ))}
    </MalterreDocument>
  )
}
