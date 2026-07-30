// PDF document for a client invoice ("Facture") or credit note ("Avoir"),
// rendered inside the shared MalterreDocument frame. Mirrors CommandeClientPdf
// but for the facture/ligne_facture model: a header with the client billing
// address + payment terms (N° TVA, mode de paiement, échéance), a lines table
// (free-text désignation · qté+unité · prix u. · montant), and a totals block
// (HT, TVA, TTC). An Avoir uses the same layout — only the document title and
// reference change; amounts are shown positive (the "AVOIR" heading conveys the
// credit nature, matching legacy practice).

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import {
  MalterreDocument,
  AddressCard,
  CreditCardIcon,
  CalendarIcon,
  ClockIcon,
  MessageSquareIcon,
  LandmarkIcon,
  TagIcon,
  type AddressBlockData,
} from './MalterreDocument.js'
import { colors, company, sizes, tvaRowLabel, type CompanyInfo } from './theme.js'

interface AddrLite {
  nom: string | null
  adresse1: string | null
  adresse2: string | null
  adresse3: string | null
  cp: string | null
  ville: string | null
  pays: string | null
}

export interface FacturePdfData {
  numero: string
  /** 1 = Facture, 2 = Avoir. */
  type: number
  /** When true, render as a proforma (draft): "Facture proforma" title + a
   *  non-contractual mention. The numero is the proforma sequence number. */
  isProforma?: boolean
  /** "25 mars 2026" — long-form French. */
  dateFacture: string
  clientNom: string
  /** Client VAT number (free text on the invoice). */
  numTva: string | null
  adresseFacturation: AddrLite | null
  modePaiement: string | null
  echeance: string | null
  /** "31/08/2026" — due date computed from the facture date + the echeance
   *  rule (see computeDateEcheance in factures.ts). Null when the terms have
   *  no computable date (à réception, avant livraison, acomptes…). */
  echeanceDate?: string | null
  /** TVA rate as a percentage (e.g. 20). */
  tvaRate: number
  /** Optional absolute discount in € (commande-based proformas). Rendered as
   *  a negative totals row when > 0; regular factures never pass it. */
  remise?: number
  /** Optional shipping cost in € HT (commande-based proformas). */
  fraisPort?: number
  /** Commande numero this document derives from (commande-based proformas) —
   *  shown as an "N° commande" meta row so the client can link the proforma
   *  back to their order despite the offset proforma numero. */
  refCommande?: string
  /** Issuing société's legal identity (footer + bank card). Defaults to ETS
   *  Malterre; Tricotage Malterre invoices pass `companyTrm`. An invoice is a
   *  legal document — this is not branding, it is whose SIRET and IBAN the
   *  client is told to pay. */
  company?: CompanyInfo
  lignes: Array<{
    designation: string
    quantite: number
    unite: string
    prix: number
    montant: number
  }>
}

function fmtNum(value: number | null | undefined, decimals = 0): string {
  if (value == null || Number.isNaN(value)) return ''
  return value
    .toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace(/ | /g, ' ')
}

const styles = StyleSheet.create({
  topRow: { flexDirection: 'row', gap: 14, marginBottom: 16, alignItems: 'stretch' },
  topRowSlot: { flex: 1, flexDirection: 'column' },
  comboCard: {
    flexGrow: 1,
    backgroundColor: colors.bgCream,
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderLeftWidth: 2,
    borderLeftColor: colors.gold,
    borderLeftStyle: 'solid',
    borderRadius: 6,
    padding: 14,
  },
  comboMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 },
  comboMetaIconBox: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  // Tight lineHeight so the text box hugs the glyphs — the content area's
  // inherited 1.45 inflates the line box and pushes the label visually below
  // the center-aligned icon next to it (same fix as MalterreDocument metaLabel).
  comboMetaLabel: { fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, flex: 1, lineHeight: 1.25 },
  comboMetaValue: { fontSize: sizes.fontBase, color: colors.text, fontWeight: 700, textAlign: 'right', lineHeight: 1.25 },

  // ── Lines table — formal ledger styling ──────────────
  // No rounded outer box: a muted header band with a gold rule beneath, thin
  // hairline rules between rows, and a matching gold rule closing the table.
  table: {
    marginBottom: 16,
    borderBottomWidth: 2,
    borderBottomColor: colors.gold,
    borderBottomStyle: 'solid',
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: colors.bgMuted,
    borderBottomWidth: 2,
    borderBottomColor: colors.gold,
    borderBottomStyle: 'solid',
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  tableHeaderCell: { fontSize: sizes.fontSm, color: colors.text, fontWeight: 900, letterSpacing: 0.8, lineHeight: 1 },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 0.75,
    borderBottomColor: colors.border,
    borderBottomStyle: 'solid',
    alignItems: 'flex-start',
  },
  tableRowLast: { borderBottomWidth: 0 },
  colDesc: { flex: 1, paddingRight: 8 },
  colQty: { width: 80, textAlign: 'right', paddingHorizontal: 4 },
  colPU: { width: 75, textAlign: 'right', paddingHorizontal: 4 },
  colMontant: { width: 85, textAlign: 'right', paddingHorizontal: 4 },
  cellBase: { fontSize: 10, color: colors.text },
  cellMontant: { fontSize: 10, color: colors.text, fontWeight: 700 },
  descFirst: { fontSize: 10.5, color: colors.text, fontWeight: 700, lineHeight: 1.35 },
  descLine: { fontSize: 9, color: colors.muted, lineHeight: 1.4 },

  // ── Totals — compact ruled rows, gold-ruled TTC row ──
  // Values share the MONTANT column's right inset (12 row padding + 4 cell
  // padding) so every figure on the page lines up in one column. Rows are
  // deliberately tight (3.5pt vertical) — the block should read as a small
  // arithmetic recap, not a second table.
  totalsWrapper: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 0 },
  totals: { width: '45%' },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3.5,
    paddingLeft: 14,
    paddingRight: 16,
  },
  totalRowDivided: {
    borderTopWidth: 0.75,
    borderTopColor: colors.border,
    borderTopStyle: 'solid',
  },
  totalLabel: { fontSize: 10, color: colors.muted, fontWeight: 700, letterSpacing: 0.3, lineHeight: 1.25 },
  totalValue: { fontSize: 10, color: colors.text, fontWeight: 700, textAlign: 'right', lineHeight: 1.25 },
  grandRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 3,
    paddingVertical: 6,
    paddingLeft: 14,
    paddingRight: 16,
    backgroundColor: colors.bgTotal,
    borderTopWidth: 2,
    borderTopColor: colors.gold,
    borderTopStyle: 'solid',
  },
  grandLabel: { fontSize: sizes.fontLg, color: colors.primary, fontWeight: 900, letterSpacing: 0.6, lineHeight: 1.25 },
  grandValue: { fontSize: sizes.fontLg, color: colors.primary, fontWeight: 900, textAlign: 'right', lineHeight: 1.25 },

  // ── Bank coordinates card ────────────────────────────
  // Pinned to the bottom of the last page, just above the footer band: the
  // spacer soaks up the remaining vertical space, the card never splits.
  bottomSpacer: { flexGrow: 1, minHeight: 14 },
  bankCard: {
    alignSelf: 'flex-start',
    minWidth: '55%',
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
  bankHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 5 },
  bankTitle: { fontSize: sizes.fontXs, color: colors.primary, fontWeight: 900, letterSpacing: 0.5, lineHeight: 1 },
  bankRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 1.5 },
  bankLabel: { width: 110, fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, lineHeight: 1.25 },
  bankValue: { fontSize: sizes.fontBase, color: colors.text, fontWeight: 700, lineHeight: 1.25 },
})

function buildClientAddress(data: FacturePdfData): AddressBlockData {
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
  return { title: 'Client', name: data.clientNom, lines, icon: 'user' }
}

export function FacturePdf({ data }: { data: FacturePdfData }) {
  const isAvoir = Number(data.type) === 2
  const isProforma = data.isProforma === true
  const baseWord = isAvoir ? 'Avoir' : 'Facture'
  const docWord = isProforma ? `${baseWord} proforma` : baseWord
  const clientAddress = buildClientAddress(data)
  const issuer = data.company ?? company

  // Round every step to the centime: the client adds up the printed lines and
  // must land on the printed total. `montant` already arrives rounded from the
  // API (see `lineMontant` in routes/factures.ts) — this settles the sums.
  const r2 = (v: number) => Math.round(v * 100) / 100
  const totalHT = r2(data.lignes.reduce((s, l) => s + (Number(l.montant) || 0), 0))
  const remise = Number(data.remise) || 0
  const fraisPort = Number(data.fraisPort) || 0
  const netHT = r2(totalHT - remise + fraisPort)
  const tvaRate = Number(data.tvaRate) || 0
  // Client flagged "Exonération" in Clients › Gestion (export customers).
  const exonere = tvaRate === 0
  const tva = r2(netHT * (tvaRate / 100))
  const ttc = r2(netHT + tva)

  return (
    <MalterreDocument
      documentType={docWord}
      reference={`N°${data.numero}`}
      documentDate={data.dateFacture || ''}
      title={`${docWord} ${data.numero}`}
      issuer={issuer}
    >
      <View style={styles.topRow}>
        <View style={styles.topRowSlot}>
          <AddressCard data={clientAddress} stretch />
        </View>
        <View style={styles.topRowSlot}>
          <View style={styles.comboCard}>
            {data.refCommande ? (
              <View style={styles.comboMetaRow}>
                <View style={styles.comboMetaIconBox}><TagIcon /></View>
                <Text style={styles.comboMetaLabel}>N° commande</Text>
                <Text style={styles.comboMetaValue}>{`N°${data.refCommande}`}</Text>
              </View>
            ) : null}
            {data.numTva ? (
              <View style={styles.comboMetaRow}>
                <View style={styles.comboMetaIconBox}><MessageSquareIcon /></View>
                <Text style={styles.comboMetaLabel}>N° TVA</Text>
                <Text style={styles.comboMetaValue}>{data.numTva}</Text>
              </View>
            ) : null}
            {data.modePaiement ? (
              <View style={styles.comboMetaRow}>
                <View style={styles.comboMetaIconBox}><CreditCardIcon /></View>
                <Text style={styles.comboMetaLabel}>Mode de paiement</Text>
                <Text style={styles.comboMetaValue}>{data.modePaiement}</Text>
              </View>
            ) : null}
            {data.echeance ? (
              <View style={styles.comboMetaRow}>
                <View style={styles.comboMetaIconBox}><ClockIcon /></View>
                <Text style={styles.comboMetaLabel}>Échéance</Text>
                <Text style={styles.comboMetaValue}>{data.echeance}</Text>
              </View>
            ) : null}
            {data.echeanceDate ? (
              <View style={styles.comboMetaRow}>
                <View style={styles.comboMetaIconBox}><CalendarIcon /></View>
                <Text style={styles.comboMetaLabel}>Date d'échéance</Text>
                <Text style={styles.comboMetaValue}>{data.echeanceDate}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>

      <View style={styles.table}>
        <View style={styles.tableHeader} fixed>
          <Text style={[styles.tableHeaderCell, styles.colDesc]}>DÉSIGNATION</Text>
          <Text style={[styles.tableHeaderCell, styles.colQty]}>QTÉ</Text>
          <Text style={[styles.tableHeaderCell, styles.colPU]}>PRIX U.</Text>
          <Text style={[styles.tableHeaderCell, styles.colMontant]}>MONTANT</Text>
        </View>
        {data.lignes.map((l, i) => {
          const descLines = String(l.designation || '').split(/\r?\n/).filter((s) => s.length > 0)
          const isLast = i === data.lignes.length - 1
          return (
            <View key={i} style={isLast ? [styles.tableRow, styles.tableRowLast] : styles.tableRow}>
              <View style={styles.colDesc}>
                {descLines.length === 0 ? (
                  <Text style={styles.descFirst}>—</Text>
                ) : descLines.map((dl, j) => (
                  <Text key={j} style={j === 0 ? styles.descFirst : styles.descLine}>{dl}</Text>
                ))}
              </View>
              <Text style={[styles.cellBase, styles.colQty]}>
                {fmtNum(l.quantite, 1)}{l.unite ? ` ${l.unite}` : ''}
              </Text>
              <Text style={[styles.cellBase, styles.colPU]}>{`${fmtNum(l.prix, 2)} €`}</Text>
              <Text style={[styles.cellMontant, styles.colMontant]}>{`${fmtNum(l.montant, 2)} €`}</Text>
            </View>
          )
        })}
      </View>

      <View style={styles.totalsWrapper} wrap={false}>
        <View style={styles.totals}>
          {/* Exonerated client: no VAT, so the block collapses to TOTAL HT.
              The sub-total row is then printed only when a remise or frais de
              port makes it differ from the grand total. */}
          {(!exonere || remise > 0 || fraisPort > 0) ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total HT</Text>
              <Text style={styles.totalValue}>{`${fmtNum(totalHT, 2)} €`}</Text>
            </View>
          ) : null}
          {remise > 0 ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Remise</Text>
              <Text style={styles.totalValue}>{`-${fmtNum(remise, 2)} €`}</Text>
            </View>
          ) : null}
          {fraisPort > 0 ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Frais de port</Text>
              <Text style={styles.totalValue}>{`${fmtNum(fraisPort, 2)} €`}</Text>
            </View>
          ) : null}
          {!exonere ? (
            <View style={[styles.totalRow, styles.totalRowDivided]}>
              <Text style={styles.totalLabel}>{tvaRowLabel(tvaRate)}</Text>
              <Text style={styles.totalValue}>{`${fmtNum(tva, 2)} €`}</Text>
            </View>
          ) : null}
          <View style={styles.grandRow}>
            <Text style={styles.grandLabel}>
              {exonere
                ? (isAvoir ? 'TOTAL AVOIR HT' : 'TOTAL HT')
                : (isAvoir ? 'TOTAL AVOIR TTC' : 'TOTAL TTC')}
            </Text>
            <Text style={styles.grandValue}>{`${fmtNum(exonere ? netHT : ttc, 2)} €`}</Text>
          </View>
        </View>
      </View>

      {/* Bank coordinates at the bottom of the last page, just above the
          footer — on the proforma (paid before delivery) AND the definitive
          invoice (the client pays against it). */}
      <View style={styles.bottomSpacer} />
      <View style={styles.bankCard} wrap={false}>
        <View style={styles.bankHeaderRow}>
          <LandmarkIcon />
          <Text style={styles.bankTitle}>COORDONNÉES BANCAIRES</Text>
        </View>
        <View style={styles.bankRow}>
          <Text style={styles.bankLabel}>Titulaire du compte</Text>
          <Text style={styles.bankValue}>{issuer.bank.holder}</Text>
        </View>
        <View style={styles.bankRow}>
          <Text style={styles.bankLabel}>IBAN</Text>
          <Text style={styles.bankValue}>{issuer.bank.iban}</Text>
        </View>
        <View style={styles.bankRow}>
          <Text style={styles.bankLabel}>BIC</Text>
          <Text style={styles.bankValue}>{issuer.bank.bic}</Text>
        </View>
      </View>
    </MalterreDocument>
  )
}
