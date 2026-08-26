// PDF for a TRM client return — the sheet the atelier gets when a complaint
// comes back from Ets Malterre. Ports the legacy WinDev ETAT_Retour_Client,
// which prints, in order: the "Retour Client" title with the defect label under
// it, an « Observation du responsable d'atelier » box, « Impact sur la prime »,
// and the affected pieces.
//
// Issued by TRICOTAGE MALTERRE (`companyTrm`), not Ets Malterre: it is TRM's
// own record, and the footer carries TRM's SIRET / TVA / capital — a legal
// requirement, same rule as the avis d'expédition TRM.
//
// Two deliberate additions over the legacy sheet (same precedent as FncPdf,
// which prints the réponse the legacy FNC omits):
//   • « Observations du client » — the legacy prints only the atelier's box, so
//     a printed sheet never said what was actually wrong. Unreadable on the
//     shop floor, and the whole point of the page.
//   • « Réponse » — what TRM answered, so the sheet is the record of the whole
//     exchange rather than half of it.
// The atelier box keeps its generous min-height on purpose: it is empty on most
// rows because it gets filled in by hand after printing.
//
// « Impact sur la prime » is kept even though `retour_client.impact_prime` is 0
// on every row and the legacy window has no input for it (user decision,
// 2026-08-26) — same call as the dead « Retour client » tile on Production ›
// Prime. The day a barème exists, this line already has its place.

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import { MalterreDocument, UserIcon, TagIcon, CalendarIcon, FactoryIcon } from './MalterreDocument.js'
import { colors, sizes, companyTrm } from './theme.js'

export interface RetourClientPdfPiece {
  numero: string
  /** "22/01/2026" — the weighing date. */
  date: string
  /** machine.nom — the métier that knitted it. */
  metier: string
  poids: number
  second_choix: boolean
}

export interface RetourClientPdfData {
  /** retour_client id — printed as "N° 92" in the branded header. */
  numero: number
  date: string
  clientNom: string
  /** ETM's own end client, when this came from an FNC — who really complained. */
  clientEtm: string
  defautNom: string
  /** "Numéro de pièce" / "Numéro de lot" + the reference itself. */
  affectationLabel: string
  reference: string
  observationClient: string
  observationAtelier: string
  /** resolution_qualite libellé — empty when unanswered. */
  resolution: string
  reponse: string
  impactPrime: number
  pieces: RetourClientPdfPiece[]
  /** ETM dossier number, when this retour came from an FNC. */
  fncNumero: number | null
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
  cardSub: { fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, lineHeight: 1.35, marginTop: 3 },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
  metaIconBox: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  metaLabel: { width: 66, fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, lineHeight: 1.25 },
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
    marginBottom: 16,
  },
  blockTall: { minHeight: 96 },
  blockText: { fontSize: sizes.fontMd, color: colors.text, lineHeight: 1.5 },
  verdict: { fontSize: sizes.fontMd, color: colors.primary, fontWeight: 900, lineHeight: 1.35, marginBottom: 6 },
  empty: { fontSize: sizes.fontBase, color: colors.subtle, lineHeight: 1.4 },

  primeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 18 },
  primeLabel: { fontSize: sizes.fontMd, color: colors.text, fontWeight: 700, lineHeight: 1.25 },
  primeValue: {
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderRadius: 4,
    backgroundColor: colors.bgTotal,
    paddingVertical: 4,
    paddingHorizontal: 14,
    fontSize: sizes.fontMd,
    color: colors.primary,
    fontWeight: 900,
    lineHeight: 1.25,
  },

  pieceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  piece: {
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderRadius: 4,
    backgroundColor: colors.white,
    paddingVertical: 6,
    paddingHorizontal: 12,
    minWidth: 128,
  },
  pieceSecond: { borderLeftWidth: 2, borderLeftColor: colors.flagRed, borderLeftStyle: 'solid' },
  pieceNum: { fontSize: sizes.fontMd, color: colors.text, fontWeight: 900, lineHeight: 1.25 },
  pieceMeta: { fontSize: sizes.fontXs, color: colors.muted, fontWeight: 700, lineHeight: 1.3, marginTop: 2 },
})

function fmtKg(v: number): string {
  return `${v.toFixed(2).replace('.', ',')} kg`
}

function fmtEuro(v: number): string {
  return `${v.toFixed(2).replace('.', ',')} €`
}

export function RetourClientPdf({ data }: { data: RetourClientPdfData }) {
  const hasReponse = data.resolution.trim() !== '' || data.reponse.trim() !== ''

  return (
    <MalterreDocument
      documentType="Retour client"
      reference={`N° ${data.numero}`}
      documentDate={data.date}
      title={`Retour client ${data.numero} - Tricotage Malterre`}
      issuer={companyTrm}
    >
      <View style={styles.topRow}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>CLIENT</Text>
          <Text style={styles.cardName}>{data.clientNom || '—'}</Text>
          {data.clientEtm ? <Text style={styles.cardSub}>pour {data.clientEtm}</Text> : null}
          {data.fncNumero ? <Text style={styles.cardSub}>FNC N° {data.fncNumero}</Text> : null}
        </View>
        <View style={styles.card}>
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
          <View style={styles.metaRow}>
            <View style={styles.metaIconBox}><FactoryIcon /></View>
            <Text style={styles.metaLabel}>{data.affectationLabel || 'Affectation'}</Text>
            <Text style={styles.metaValue}>{data.reference || '—'}</Text>
          </View>
        </View>
      </View>

      <Text style={styles.sectionTitle}>OBSERVATIONS DU CLIENT</Text>
      <View style={styles.block}>
        {data.observationClient.trim() ? (
          <Text style={styles.blockText}>{data.observationClient.trim()}</Text>
        ) : (
          <Text style={styles.empty}>Aucune observation transmise.</Text>
        )}
      </View>

      <Text style={styles.sectionTitle}>OBSERVATION DU RESPONSABLE D&apos;ATELIER</Text>
      <View style={[styles.block, styles.blockTall]}>
        {data.observationAtelier.trim() ? (
          <Text style={styles.blockText}>{data.observationAtelier.trim()}</Text>
        ) : null}
      </View>

      <View style={styles.primeRow}>
        <Text style={styles.primeLabel}>Impact sur la prime :</Text>
        <Text style={styles.primeValue}>{fmtEuro(data.impactPrime)}</Text>
      </View>

      <Text style={styles.sectionTitle}>
        {data.pieces.length > 1 ? 'PIÈCES AFFECTÉES' : 'PIÈCE(S) AFFECTÉE(S)'}
      </Text>
      <View style={{ marginBottom: 16 }}>
        {data.pieces.length > 0 ? (
          <View style={styles.pieceRow}>
            {data.pieces.map((p, i) => (
              <View key={i} style={p.second_choix ? [styles.piece, styles.pieceSecond] : styles.piece}>
                <Text style={styles.pieceNum}>{p.numero}</Text>
                <Text style={styles.pieceMeta}>
                  {[p.date, p.metier ? `métier ${p.metier}` : '', p.poids > 0 ? fmtKg(p.poids) : '']
                    .filter(Boolean)
                    .join('  ·  ')}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.empty}>
            {data.reference
              ? `La référence « ${data.reference} » ne correspond à aucune pièce en stock.`
              : 'Aucune affectation.'}
          </Text>
        )}
      </View>

      <Text style={styles.sectionTitle}>RÉPONSE</Text>
      <View style={[styles.block, styles.blockTall]}>
        {hasReponse ? (
          <>
            {data.resolution.trim() ? <Text style={styles.verdict}>{data.resolution.trim()}</Text> : null}
            {data.reponse.trim() ? <Text style={styles.blockText}>{data.reponse.trim()}</Text> : null}
          </>
        ) : (
          <Text style={styles.empty}>En attente de réponse.</Text>
        )}
      </View>
    </MalterreDocument>
  )
}

export async function renderRetourClientPdfBuffer(data: RetourClientPdfData): Promise<Buffer> {
  const { renderToBuffer } = await import('@react-pdf/renderer')
  return renderToBuffer(
    React.createElement(RetourClientPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}
