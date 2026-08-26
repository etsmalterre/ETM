// PDF document for a client "Confirmation de commande" (order
// confirmation / bon de commande client). Renders inside the shared
// MalterreDocument frame. Single-flow (no page-2 stock section): a header with
// the client + billing/delivery addresses + payment terms, a lines table
// (ref/coloris · qté+unité · prix u. · montant · expédition), and a totals block
// (HT, remise, frais de port, TVA, TTC).
//
// ── Two issuers, one template ──
// Tricotage Malterre confirms its own client orders with this same document
// (TRM › Clients › Commandes, `routes/commandes-trm.ts`). The two companies
// confirm an order the same way, so this file is NOT forked — `data.company`
// carries the issuing entity to MalterreDocument's footer, exactly like
// FacturePdf. TRM's rows are all tombé métier priced per Kg, which is why the
// optional per-line `designation` exists: its catalogue label ("Piqué DF coton
// J20 30\"") is the article, and printing only the numeric ref would leave the
// client reading "005 / ecru". ETM omits it and loses nothing.

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import {
  MalterreDocument,
  UserIcon,
  CreditCardIcon,
  CalendarIcon,
  TruckIcon,
  MessageSquareIcon,
} from './MalterreDocument.js'
import { colors, sizes, tvaRowLabel, type CompanyInfo } from './theme.js'

interface AddrLite {
  nom: string | null
  adresse1: string | null
  adresse2: string | null
  adresse3: string | null
  cp: string | null
  ville: string | null
  pays: string | null
}

export interface CommandeClientPdfData {
  numero: string
  /** "25 mars 2026" — long-form French. */
  dateCommande: string
  clientNom: string
  refClient: string | null
  adresseFacturation: AddrLite | null
  adresseLivraison: AddrLite | null
  modePaiement: string | null
  echeance: string | null
  commentaire: string | null
  /** € discount applied to the HT subtotal. */
  remise: number
  /** € shipping cost added to the HT subtotal. */
  fraisPort: number
  /** TVA rate as a percentage (e.g. 20). */
  tvaRate: number
  /** Legal entity signing the confirmation — drives the footer's SIRET / TVA /
   *  capital. Omitted = ETS Malterre; Tricotage Malterre passes `companyTrm`. */
  company?: CompanyInfo
  lignes: Array<{
    ref_label: string | null
    colori_reference: string | null
    /** Catalogue wording under the ref (TRM: the écru designation). */
    designation?: string | null
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
  topRow: { flexDirection: 'row', gap: 14, marginBottom: 14, alignItems: 'stretch' },
  topRowSlot: { flex: 1, flexDirection: 'column' },
  // Compact cream card — shared by the two header slots and the bottom
  // livraison card. Tighter padding than the stock AddressCard on purpose:
  // the header row must stay short so the lines table starts high.
  card: {
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
  cardStretch: { flexGrow: 1 },
  // lineHeight 1 on every text that sits in a row next to an icon — the
  // inherited 1.45 adds leading above the glyphs, which pushes the text down
  // and leaves the center-aligned icon visually too high/low.
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2.5 },
  metaIconBox: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  metaLabel: { fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, flex: 1, lineHeight: 1 },
  metaValue: { fontSize: sizes.fontBase, color: colors.text, fontWeight: 700, textAlign: 'right', lineHeight: 1 },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 5 },
  cardTitle: { fontSize: sizes.fontXs, color: colors.primary, fontWeight: 900, letterSpacing: 0.5, lineHeight: 1 },
  cardName: { fontSize: sizes.fontBase, fontWeight: 900, color: colors.text, marginBottom: 1 },
  cardLine: { fontSize: sizes.fontBase, color: colors.text, lineHeight: 1.4 },
  // Livraison card is pinned to the bottom of the last page: the wrapper
  // grows to fill the leftover space and bottom-aligns the card just above
  // the footer. wrap={false} on the wrapper (not just the card) so when the
  // card doesn't fit under the totals, the whole pin block moves to a fresh
  // page and fills it — the card still lands at the bottom, never at the top.
  bottomPin: { flexGrow: 1, flexDirection: 'column', justifyContent: 'flex-end' },
  // marginBottom lifts the card off the flow floor (paddingBottom 80) so the
  // "Page X/Y" line (bottom: 72) keeps clear air under the card border.
  livraisonBottom: { marginTop: 16, marginBottom: 10 },

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
  designationLine: { fontSize: 10, color: colors.muted, marginTop: 2, lineHeight: 1.3 },

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

// HFSQL keeps ' ' (a single space) in empty text columns — trim before the
// truthiness check or blank address parts render as empty lines in the card.
function pushLine(lines: string[], raw: string | null) {
  const t = raw?.trim()
  if (t) lines.push(t)
}

function buildClientAddress(data: CommandeClientPdfData): { name: string; lines: string[] } {
  const a = data.adresseFacturation
  const lines: string[] = []
  if (a) {
    const nom = a.nom?.trim()
    if (nom && nom !== data.clientNom) lines.push(nom)
    pushLine(lines, a.adresse1)
    pushLine(lines, a.adresse2)
    pushLine(lines, a.adresse3)
    pushLine(lines, [a.cp?.trim(), a.ville?.trim()].filter(Boolean).join(' '))
    pushLine(lines, a.pays)
  }
  return { name: data.clientNom, lines }
}

function buildLivraisonLines(data: CommandeClientPdfData): { name: string; lines: string[] } {
  const a = data.adresseLivraison
  const lines: string[] = []
  let name = data.clientNom
  if (a) {
    name = a.nom?.trim() || data.clientNom
    pushLine(lines, a.adresse1)
    pushLine(lines, a.adresse2)
    pushLine(lines, [a.cp?.trim(), a.ville?.trim()].filter(Boolean).join(' '))
    pushLine(lines, a.pays)
  }
  return { name, lines }
}

export function CommandeClientPdf({ data }: { data: CommandeClientPdfData }) {
  const clientAddress = buildClientAddress(data)
  const livraison = buildLivraisonLines(data)

  const totalHT = data.lignes.reduce((s, l) => s + (Number(l.montant) || 0), 0)
  const remise = Number(data.remise) || 0
  const fraisPort = Number(data.fraisPort) || 0
  const netHT = totalHT - remise + fraisPort
  const tvaRate = Number(data.tvaRate) || 0
  // Client flagged "Exonération" in Clients › Gestion (export customers).
  const exonere = tvaRate === 0
  const tva = netHT * (tvaRate / 100)
  const ttc = netHT + tva

  return (
    <MalterreDocument
      // "Confirmation de commande" doesn't fit the header block on one line
      // at the doc-type font size, and the natural wrap strands "COMMANDE"
      // alone. Splitting across the type/reference rows gives the wanted
      // two-line header: CONFIRMATION DE / COMMANDE N°X.
      documentType="Confirmation de"
      reference={`COMMANDE N°${data.numero}`}
      documentDate={data.dateCommande || ''}
      title={`Confirmation de commande ${data.numero}`}
      issuer={data.company}
    >
      {/* Top row: client (billing) on the left; payment terms on the right.
          The delivery address lives in its own card at the bottom of the
          last page (just above the footer). */}
      <View style={styles.topRow}>
        <View style={styles.topRowSlot}>
          <View style={[styles.card, styles.cardStretch]}>
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
          <View style={[styles.card, styles.cardStretch]}>
            {data.refClient ? (
              <View style={styles.metaRow}>
                <View style={styles.metaIconBox}><MessageSquareIcon /></View>
                <Text style={styles.metaLabel}>Réf. client</Text>
                <Text style={styles.metaValue}>{data.refClient}</Text>
              </View>
            ) : null}
            {data.modePaiement ? (
              <View style={styles.metaRow}>
                <View style={styles.metaIconBox}><CreditCardIcon /></View>
                <Text style={styles.metaLabel}>Mode de paiement</Text>
                <Text style={styles.metaValue}>{data.modePaiement}</Text>
              </View>
            ) : null}
            {data.echeance ? (
              <View style={styles.metaRow}>
                <View style={styles.metaIconBox}><CalendarIcon /></View>
                <Text style={styles.metaLabel}>Échéance</Text>
                <Text style={styles.metaValue}>{data.echeance}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>

      <View style={styles.table}>
        <View style={styles.tableHeader} fixed>
          <Text style={[styles.tableHeaderCell, styles.colDesc]}>DÉSIGNATION (RÉFÉRENCE / COLORIS)</Text>
          <Text style={[styles.tableHeaderCell, styles.colQty]}>QTÉ</Text>
          <Text style={[styles.tableHeaderCell, styles.colPU]}>PRIX U.</Text>
          <Text style={[styles.tableHeaderCell, styles.colMontant]}>MONTANT</Text>
          <Text style={[styles.tableHeaderCell, styles.colLiv]}>EXPÉDITION</Text>
        </View>
        {data.lignes.map((l, i) => (
          <View key={i} style={styles.tableRow}>
            <View style={styles.colDesc}>
              <Text style={styles.refMainBig}>{l.ref_label || '—'}</Text>
              {l.colori_reference ? <Text style={styles.coloriProminent}>{l.colori_reference}</Text> : null}
              {l.designation && l.designation.trim()
                ? <Text style={styles.designationLine}>{l.designation.trim()}</Text>
                : null}
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
          {(!exonere || remise > 0 || fraisPort > 0) && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total HT</Text>
              <Text style={styles.totalValue}>{`${fmtNum(totalHT, 2)} €`}</Text>
            </View>
          )}
          {remise > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Remise</Text>
              <Text style={styles.totalValue}>{`- ${fmtNum(remise, 2)} €`}</Text>
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

      {/* Delivery address — pinned to the bottom of the last page, just above
          the footer band. */}
      <View style={styles.bottomPin} wrap={false}>
        <View style={[styles.card, styles.livraisonBottom]}>
          <View style={styles.cardHeaderRow}>
            <TruckIcon />
            <Text style={styles.cardTitle}>ADRESSE DE LIVRAISON</Text>
          </View>
          {livraison.name ? <Text style={styles.cardName}>{livraison.name}</Text> : null}
          {livraison.lines.map((l, i) => (
            <Text key={i} style={styles.cardLine}>{l}</Text>
          ))}
        </View>
      </View>
    </MalterreDocument>
  )
}
