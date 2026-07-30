// PDF document for a client "Devis" (quotation). Renders inside the shared
// MalterreDocument frame. Mirrors CommandeClientPdf: a header with the client
// (billing) address + payment terms (and the devis validity date), a lines
// table (ref/coloris · qté+unité · prix u. · montant · livraison), the delivery
// address as a box below the table, and a totals block (HT, remise, frais de
// port, TVA, TTC). Keeping the delivery address out of the header keeps the
// header compact.
//
// NOTE: devis_etm.remise is a FRACTION (0.05 = 5%), unlike commande_client where
// it's a euro amount — so the remise line shows the percentage and its computed
// euro discount.

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import {
  MalterreDocument,
  CreditCardIcon,
  CalendarIcon,
  ClockIcon,
  TruckIcon,
  TagIcon,
  MessageSquareIcon,
  UserIcon,
} from './MalterreDocument.js'
import { colors, sizes, tvaRowLabel } from './theme.js'

interface AddrLite {
  nom: string | null
  adresse1: string | null
  adresse2: string | null
  adresse3: string | null
  cp: string | null
  ville: string | null
  pays: string | null
}

export interface DevisEtmPdfData {
  numero: string
  /** "25 mars 2026" — long-form French. */
  dateDevis: string
  /** "25 avril 2026" — long-form French; '' when none set. */
  dateExpiration: string
  clientNom: string
  refClient: string | null
  adresseFacturation: AddrLite | null
  adresseLivraison: AddrLite | null
  modePaiement: string | null
  echeance: string | null
  commentaire: string | null
  /** Discount as a 0..1 fraction (0.05 = 5%). */
  remise: number
  /** € shipping cost added to the HT subtotal. */
  fraisPort: number
  /** TVA rate as a percentage (e.g. 20). */
  tvaRate: number
  lignes: Array<{
    ref_label: string | null
    colori_reference: string | null
    quantite: number
    unite_label: string
    prix: number
    montant: number
    /** dd/mm/yyyy or '' */
    date_livraison: string
  }>
}

function fmtNum(value: number | null | undefined, decimals = 0): string {
  if (value == null || Number.isNaN(value)) return ''
  return value
    .toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace(/ | /g, ' ')
}

const styles = StyleSheet.create({
  // Two compact header cards side-by-side. Both share the same tight padding so
  // the row stays short — the client address (left) drives the height, so it is
  // rendered with a tight line-height; conditions (right) sit in a 2-column grid
  // so they never push the row taller than the address.
  topRow: { flexDirection: 'row', gap: 12, marginBottom: 14, alignItems: 'stretch' },
  topRowSlot: { flex: 1, flexDirection: 'column' },
  headerCard: {
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
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 5 },
  cardTitle: { fontSize: sizes.fontXs, color: colors.primary, fontWeight: 900, letterSpacing: 0.5, lineHeight: 1 },
  cardName: { fontSize: sizes.fontBase, fontWeight: 900, color: colors.text, marginBottom: 1 },
  cardLine: { fontSize: sizes.fontBase, color: colors.text, lineHeight: 1.25 },

  // Conditions as a 2-column grid: each cell is an icon beside a stacked
  // caps-label + value. The icon sits in a row next to the (taller) text
  // column so it vertically centers cleanly — react-pdf won't center an Svg
  // against a single short line. Two items per row halves the row count vs
  // the old full-width stack, so the card no longer drives the header height.
  metaGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4 },
  metaCell: { width: '50%', flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 4, paddingVertical: 4 },
  metaIconBox: { width: 11, height: 11, alignItems: 'center', justifyContent: 'center' },
  metaText: { flexDirection: 'column', flex: 1 },
  // Tight line-heights (the content area inherits 1.45, which inflates the line
  // box and pushes the row's centered icon visually below the glyphs).
  metaLabel: { fontSize: 6, color: colors.muted, fontWeight: 700, letterSpacing: 0.4, lineHeight: 1, marginBottom: 2 },
  metaValue: { fontSize: sizes.fontBase, color: colors.text, fontWeight: 700, lineHeight: 1 },

  table: {
    marginBottom: 8,
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
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  tableHeaderCell: { fontSize: sizes.fontSm, color: colors.text, fontWeight: 900, letterSpacing: 0.5 },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderBottomWidth: 0.75,
    borderBottomColor: '#EEEEEE',
    borderBottomStyle: 'solid',
    alignItems: 'flex-start',
  },
  colDesc: { flex: 1, paddingRight: 8 },
  colQty: { width: 70, textAlign: 'right', paddingHorizontal: 4 },
  colPU: { width: 70, textAlign: 'right', paddingHorizontal: 4 },
  colMontant: { width: 80, textAlign: 'right', paddingHorizontal: 4 },
  colLiv: { width: 70, textAlign: 'right' },
  cellBase: { fontSize: 11, color: colors.text },
  refMainBig: { fontSize: 13, color: colors.primary, fontWeight: 900, letterSpacing: 0.2, lineHeight: 1.2 },
  coloriProminent: { fontSize: 10.5, color: colors.text, fontWeight: 700, marginTop: 3, lineHeight: 1.3 },

  totalsWrapper: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 0 },
  totals: {
    width: '52%',
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderRadius: 6,
    overflow: 'hidden',
  },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14 },
  totalLabel: { fontSize: 11, color: colors.text, fontWeight: 700 },
  totalValue: { fontSize: 11, color: colors.text, textAlign: 'right' },
  grandRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderTopWidth: 2,
    borderTopColor: colors.gold,
    borderTopStyle: 'solid',
    backgroundColor: colors.bgTotal,
  },
  grandLabel: { fontSize: sizes.fontLg, color: colors.primary, fontWeight: 900, letterSpacing: 0.4 },
  grandValue: { fontSize: sizes.fontLg, color: colors.primary, fontWeight: 900, textAlign: 'right' },

  // Grows to fill the empty vertical space, pushing the delivery address block
  // down to sit just above the footer band.
  bottomSpacer: { flexGrow: 1, minHeight: 16 },
  livraisonBox: {
    alignSelf: 'flex-start',
    minWidth: '52%',
    marginTop: 12,
    padding: 12,
    backgroundColor: colors.bgCream,
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderLeftWidth: 2,
    borderLeftColor: colors.gold,
    borderLeftStyle: 'solid',
    borderRadius: 6,
  },
  livraisonHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  livraisonTitle: { fontSize: sizes.fontXs, color: colors.primary, fontWeight: 900, letterSpacing: 0.5, lineHeight: 1 },

  commentaireBottom: { marginTop: 24 },
  commentaireBox: {
    flexShrink: 0,
    padding: 14,
    backgroundColor: colors.bgCream,
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderLeftWidth: 2,
    borderLeftColor: colors.gold,
    borderLeftStyle: 'solid',
    borderRadius: 6,
  },
  commentaireHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  commentaireTitle: { fontSize: sizes.fontXs, color: colors.primary, fontWeight: 900, letterSpacing: 0.5, lineHeight: 1 },
  commentaireText: { fontSize: sizes.fontBase, color: colors.text, lineHeight: 1.45 },
})

function buildClientAddress(data: DevisEtmPdfData): { name: string; lines: string[] } {
  const a = data.adresseFacturation
  const lines: string[] = []
  if (a) {
    if (a.nom && a.nom !== data.clientNom) lines.push(a.nom)
    if (a.adresse1) lines.push(a.adresse1)
    if (a.adresse2) lines.push(a.adresse2)
    if (a.adresse3) lines.push(a.adresse3)
    const cityLine = [a.cp, a.ville].filter(Boolean).join(' ')
    if (cityLine) lines.push(cityLine)
    if (a.pays) lines.push(a.pays)
  }
  return { name: data.clientNom, lines }
}

function buildLivraisonLines(data: DevisEtmPdfData): { name: string; lines: string[] } {
  const a = data.adresseLivraison
  const lines: string[] = []
  let name = ''
  if (a) {
    name = a.nom ?? data.clientNom
    if (a.adresse1) lines.push(a.adresse1)
    if (a.adresse2) lines.push(a.adresse2)
    const cityLine = [a.cp, a.ville].filter(Boolean).join(' ')
    if (cityLine) lines.push(cityLine)
    if (a.pays) lines.push(a.pays)
  } else {
    name = data.clientNom
  }
  return { name, lines }
}

export function DevisEtmPdf({ data }: { data: DevisEtmPdfData }) {
  const clientAddress = buildClientAddress(data)
  const livraison = buildLivraisonLines(data)

  const totalHT = data.lignes.reduce((s, l) => s + (Number(l.montant) || 0), 0)
  const remiseFraction = Number(data.remise) || 0
  const remiseAmount = totalHT * remiseFraction
  const fraisPort = Number(data.fraisPort) || 0
  const netHT = totalHT - remiseAmount + fraisPort
  const tvaRate = Number(data.tvaRate) || 0
  // Client flagged "Exonération" in Clients › Gestion (export customers).
  const exonere = tvaRate === 0
  const tva = netHT * (tvaRate / 100)
  const ttc = netHT + tva
  const remisePctLabel = fmtNum(remiseFraction * 100, remiseFraction * 100 % 1 === 0 ? 0 : 1)

  // Conditions grid — one cell per non-empty field, each with a distinct,
  // concept-relevant icon (reference tag / validity calendar / payment card /
  // due-date clock) so they're never indistinguishable at this size.
  const metaItems: Array<{ key: string; icon: React.ReactNode; label: string; value: string }> = []
  if (data.refClient) metaItems.push({ key: 'ref', icon: <TagIcon size={9} />, label: 'RÉF. CLIENT', value: data.refClient })
  if (data.dateExpiration) metaItems.push({ key: 'exp', icon: <CalendarIcon size={9} />, label: 'VALIDITÉ', value: data.dateExpiration })
  if (data.modePaiement) metaItems.push({ key: 'pay', icon: <CreditCardIcon size={9} />, label: 'PAIEMENT', value: data.modePaiement })
  if (data.echeance) metaItems.push({ key: 'ech', icon: <ClockIcon size={9} />, label: 'ÉCHÉANCE', value: data.echeance })

  return (
    <MalterreDocument
      documentType="Devis"
      reference={`DEVIS N°${data.numero}`}
      documentDate={data.dateDevis || ''}
      title={`Devis ${data.numero}`}
    >
      {/* Top row: client (billing) on the left; conditions on the right. The
          delivery address moved to the bottom of the page (above the footer) so
          these two cards stay short. */}
      <View style={styles.topRow}>
        <View style={styles.topRowSlot}>
          <View style={styles.headerCard}>
            <View style={styles.cardHeaderRow}>
              <UserIcon />
              <Text style={styles.cardTitle}>CLIENT</Text>
            </View>
            {clientAddress.name ? <Text style={styles.cardName}>{clientAddress.name}</Text> : null}
            {clientAddress.lines.map((l, i) => (
              <Text key={i} style={styles.cardLine}>{l}</Text>
            ))}
          </View>
        </View>
        <View style={styles.topRowSlot}>
          <View style={styles.headerCard}>
            <View style={styles.cardHeaderRow}>
              <CreditCardIcon />
              <Text style={styles.cardTitle}>CONDITIONS</Text>
            </View>
            <View style={styles.metaGrid}>
              {metaItems.map((it) => (
                <View key={it.key} style={styles.metaCell}>
                  <View style={styles.metaIconBox}>{it.icon}</View>
                  <View style={styles.metaText}>
                    <Text style={styles.metaLabel}>{it.label}</Text>
                    <Text style={styles.metaValue}>{it.value}</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        </View>
      </View>

      <View style={styles.table}>
        <View style={styles.tableHeader} fixed>
          <Text style={[styles.tableHeaderCell, styles.colDesc]}>DÉSIGNATION (RÉFÉRENCE / COLORIS)</Text>
          <Text style={[styles.tableHeaderCell, styles.colQty]}>QTÉ</Text>
          <Text style={[styles.tableHeaderCell, styles.colPU]}>PRIX U.</Text>
          <Text style={[styles.tableHeaderCell, styles.colMontant]}>MONTANT</Text>
          <Text style={[styles.tableHeaderCell, styles.colLiv]}>LIVRAISON</Text>
        </View>
        {data.lignes.map((l, i) => (
          <View key={i} style={styles.tableRow}>
            <View style={styles.colDesc}>
              <Text style={styles.refMainBig}>{l.ref_label || '—'}</Text>
              {l.colori_reference ? <Text style={styles.coloriProminent}>{l.colori_reference}</Text> : null}
            </View>
            <Text style={[styles.cellBase, styles.colQty]}>
              {fmtNum(l.quantite, 1)}{l.unite_label ? ` ${l.unite_label}` : ''}
            </Text>
            <Text style={[styles.cellBase, styles.colPU]}>{`${fmtNum(l.prix, 2)} €`}</Text>
            <Text style={[styles.cellBase, styles.colMontant]}>{`${fmtNum(l.montant, 2)} €`}</Text>
            <Text style={[styles.cellBase, styles.colLiv]}>{l.date_livraison || '—'}</Text>
          </View>
        ))}
      </View>

      <View style={styles.totalsWrapper} wrap={false}>
        <View style={styles.totals}>
          {/* Exonerated client: no VAT, so the block collapses to TOTAL HT.
              The sub-total row is then printed only when a remise or frais de
              port makes it differ from the grand total. */}
          {(!exonere || remiseAmount > 0 || fraisPort > 0) && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total HT</Text>
              <Text style={styles.totalValue}>{`${fmtNum(totalHT, 2)} €`}</Text>
            </View>
          )}
          {remiseAmount > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>{`Remise (${remisePctLabel} %)`}</Text>
              <Text style={styles.totalValue}>{`- ${fmtNum(remiseAmount, 2)} €`}</Text>
            </View>
          )}
          {fraisPort > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Frais de port</Text>
              <Text style={styles.totalValue}>{`${fmtNum(fraisPort, 2)} €`}</Text>
            </View>
          )}
          {!exonere && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>{tvaRowLabel(tvaRate)}</Text>
              <Text style={styles.totalValue}>{`${fmtNum(tva, 2)} €`}</Text>
            </View>
          )}
          <View style={styles.grandRow}>
            <Text style={styles.grandLabel}>{exonere ? 'TOTAL HT' : 'TOTAL TTC'}</Text>
            <Text style={styles.grandValue}>{`${fmtNum(exonere ? netHT : ttc, 2)} €`}</Text>
          </View>
        </View>
      </View>

      {data.commentaire && data.commentaire.trim() && (
        <View style={[styles.commentaireBox, styles.commentaireBottom]} wrap={false}>
          <View style={styles.commentaireHeaderRow}>
            <MessageSquareIcon />
            <Text style={styles.commentaireTitle}>COMMENTAIRE</Text>
          </View>
          <Text style={styles.commentaireText}>{data.commentaire.trim()}</Text>
        </View>
      )}

      {/* Spacer grows to push the delivery address to the bottom of the page,
          just above the footer band. */}
      <View style={styles.bottomSpacer} />

      <View style={styles.livraisonBox} wrap={false}>
        <View style={styles.livraisonHeaderRow}>
          <TruckIcon />
          <Text style={styles.livraisonTitle}>ADRESSE DE LIVRAISON</Text>
        </View>
        {livraison.name ? <Text style={styles.cardName}>{livraison.name}</Text> : null}
        {livraison.lines.map((l, i) => (
          <Text key={i} style={styles.cardLine}>{l}</Text>
        ))}
      </View>
    </MalterreDocument>
  )
}
