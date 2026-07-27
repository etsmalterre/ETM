// PDF document for the "Fiche de non-conformité" (FNC) issued from a Qualité ›
// Dossier. Ports the legacy WinDev ETAT_FNC to the MPS_NG design language:
//   - top row: recipient company card + metadata card (client, défaut, date)
//   - "Observation du responsable qualité" framed block (the FNC message)
//   - "Pièce(s) affectée(s)" chips, one per affected roll / yarn lot
//   - "Réponse" block, only when the recipient has answered: the résolution
//     libellé reads as a verdict line above the free-text answer
// Legacy prints the observation and the affected pieces only; the réponse block
// is the app's addition so the printed sheet carries the whole exchange.

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import { MalterreDocument, UserIcon, TagIcon, CalendarIcon } from './MalterreDocument.js'
import { colors, sizes } from './theme.js'

export interface FncPdfData {
  /** Dossier id — printed as "Référence N° 183" in the branded header. */
  numero: number
  /** "20/02/2026" — the FNC send date, falling back to the dossier date. */
  date: string
  /** Recipient sister company, e.g. "Tricotage Malterre". */
  societeNom: string
  clientNom: string
  defautNom: string
  observation: string
  pieces: string[]
  /** "Pièce(s) affectée(s)" or "Lot(s) de fil concerné(s)". */
  piecesLabel: string
  /** resolution_qualite libellé — empty when unanswered. */
  resolution: string
  reponse: string
}

const styles = StyleSheet.create({
  topRow: { flexDirection: 'row', gap: 14, marginBottom: 16, alignItems: 'stretch' },

  card: {
    flex: 1,
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
  cardTitle: {
    fontSize: sizes.fontXs,
    color: colors.muted,
    fontWeight: 900,
    letterSpacing: 0.8,
    marginBottom: 5,
    lineHeight: 1,
  },
  cardName: { fontSize: sizes.fontMd, color: colors.primary, fontWeight: 900, lineHeight: 1.3 },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
  metaIconBox: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  metaLabel: { width: 60, fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, lineHeight: 1.25 },
  metaValue: { flex: 1, fontSize: sizes.fontBase, color: colors.text, fontWeight: 700, textAlign: 'right', lineHeight: 1.25 },

  sectionTitle: {
    fontSize: sizes.fontXs,
    color: colors.text,
    fontWeight: 900,
    letterSpacing: 0.8,
    marginBottom: 6,
    lineHeight: 1,
  },
  block: {
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderTopWidth: 2,
    borderTopColor: colors.gold,
    borderTopStyle: 'solid',
    borderRadius: 6,
    backgroundColor: colors.bgMuted,
    padding: 12,
    minHeight: 90,
    marginBottom: 18,
  },
  blockText: { fontSize: sizes.fontMd, color: colors.text, lineHeight: 1.5 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 18 },
  chip: {
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderRadius: 4,
    backgroundColor: colors.white,
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  chipText: { fontSize: sizes.fontMd, color: colors.text, fontWeight: 700, lineHeight: 1.2 },

  verdict: {
    fontSize: sizes.fontMd,
    color: colors.primary,
    fontWeight: 900,
    lineHeight: 1.35,
    marginBottom: 6,
  },
  empty: { fontSize: sizes.fontBase, color: colors.subtle, lineHeight: 1.4 },

  signRow: { flexDirection: 'row', gap: 24, marginTop: 10 },
  signBox: { flex: 1 },
  signLabel: { fontSize: sizes.fontXs, color: colors.muted, fontWeight: 700, letterSpacing: 0.6, lineHeight: 1 },
  signRule: {
    marginTop: 34,
    borderTopWidth: 0.75,
    borderTopColor: colors.borderStrong,
    borderTopStyle: 'solid',
  },
})

export function FncPdf({ data }: { data: FncPdfData }) {
  const hasReponse = data.resolution.trim() !== '' || data.reponse.trim() !== ''

  return (
    <MalterreDocument
      documentType="Fiche de non-conformité"
      reference={`N° ${data.numero}`}
      documentDate={data.date}
      title={`FNC ${data.numero} - Malterre`}
    >
      <View style={styles.topRow}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>DESTINATAIRE</Text>
          <Text style={styles.cardName}>{data.societeNom}</Text>
        </View>
        <View style={styles.card}>
          <View style={styles.metaRow}>
            <View style={styles.metaIconBox}><UserIcon /></View>
            <Text style={styles.metaLabel}>Client</Text>
            <Text style={styles.metaValue}>{data.clientNom || '—'}</Text>
          </View>
          <View style={styles.metaRow}>
            <View style={styles.metaIconBox}><TagIcon /></View>
            <Text style={styles.metaLabel}>Défaut</Text>
            <Text style={styles.metaValue}>{data.defautNom || '—'}</Text>
          </View>
          <View style={styles.metaRow}>
            <View style={styles.metaIconBox}><CalendarIcon /></View>
            <Text style={styles.metaLabel}>Date</Text>
            <Text style={styles.metaValue}>{data.date || '—'}</Text>
          </View>
        </View>
      </View>

      <Text style={styles.sectionTitle}>OBSERVATION DU RESPONSABLE QUALITÉ</Text>
      <View style={styles.block}>
        <Text style={styles.blockText}>{data.observation}</Text>
      </View>

      {data.pieces.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>{data.piecesLabel.toUpperCase()}</Text>
          <View style={styles.chipRow}>
            {data.pieces.map((p, i) => (
              <View key={i} style={styles.chip}>
                <Text style={styles.chipText}>{p}</Text>
              </View>
            ))}
          </View>
        </>
      ) : null}

      <Text style={styles.sectionTitle}>RÉPONSE</Text>
      <View style={styles.block}>
        {hasReponse ? (
          <>
            {data.resolution.trim() ? (
              <Text style={styles.verdict}>{data.resolution.trim()}</Text>
            ) : null}
            {data.reponse.trim() ? (
              <Text style={styles.blockText}>{data.reponse.trim()}</Text>
            ) : null}
          </>
        ) : (
          <Text style={styles.empty}>En attente de réponse.</Text>
        )}
      </View>

      <View style={styles.signRow}>
        <View style={styles.signBox}>
          <Text style={styles.signLabel}>RESPONSABLE QUALITÉ</Text>
          <View style={styles.signRule} />
        </View>
        <View style={styles.signBox}>
          <Text style={styles.signLabel}>{data.societeNom.toUpperCase() || 'DESTINATAIRE'}</Text>
          <View style={styles.signRule} />
        </View>
      </View>
    </MalterreDocument>
  )
}

export async function renderFncPdfBuffer(data: FncPdfData): Promise<Buffer> {
  const { renderToBuffer } = await import('@react-pdf/renderer')
  return renderToBuffer(
    React.createElement(FncPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}
