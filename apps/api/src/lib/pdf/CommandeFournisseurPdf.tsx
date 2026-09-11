// PDF document for a "Bon de commande fournisseur" (yarn order to a supplier).
// Uses the reusable MalterreDocument base so branding stays consistent with
// future documents. Style mirrors the HTML template the user approved.

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import {
  MalterreDocument,
  AddressCard,
  MessageSquareIcon,
  type AddressBlockData,
  type MetadataCardData,
} from './MalterreDocument.js'
import { colors, sizes, company } from './theme.js'

// ── Input shape ──────────────────────────────────────────

export interface CommandeFournisseurPdfData {
  numero: string
  dateCommande: string     // "14 Avril 2026" (long-form French)
  fournisseurNom: string
  fournisseurAdresse: {
    nom: string | null
    adresse1: string | null
    adresse2: string | null
    adresse3: string | null
    cp: string | null
    ville: string | null
    pays: string | null
  } | null
  adresseLivraison: {
    nom: string | null
    adresse1: string | null
    cp: string | null
    ville: string | null
    pays: string | null
  } | null
  modePaiement: string | null
  echeance: string | null
  /** Earliest delivery date across all line items (long-form French) */
  delaiLivraison: string | null
  commentaire: string | null
  lignes: Array<{
    ref_fil: string | null
    colori_reference: string | null
    bio: boolean
    quantite: number | null  // kg
    prix_unitaire: number | null  // €/kg
    date_livraison: string | null
  }>
}

// ── French number formatting ─────────────────────────────
function fmtNum(value: number | null | undefined, decimals = 0): string {
  if (value == null || Number.isNaN(value)) return ''
  return value
    .toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace(/\u202f|\u00a0/g, ' ')
}

// ── Styles ───────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── Articles table ──────────────────────────────────
  // v2: framed with a thin border + rounded corners. `overflow: hidden`
  // clips the header background to the rounded corners cleanly.
  // No marginBottom on the table: react-pdf's paginator counts a block's
  // bottom margin as part of its "presence", so a table that fits the page
  // by a few points but whose margin does not is pushed WHOLE to the next
  // page, leaving page 1 blank (LIVA #1148). The gap lives on the totals
  // block's marginTop instead.
  table: {
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
  tableHeaderCell: {
    fontSize: sizes.fontSm,
    color: colors.text,
    fontWeight: 900,
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 0.75,
    borderBottomColor: '#EEEEEE',
    borderBottomStyle: 'solid',
    alignItems: 'flex-start',
  },
  // Column widths
  colDesc:   { flex: 1, paddingRight: 8 },
  colQty:    { width: 60, textAlign: 'center', paddingHorizontal: 4 },
  colPU:     { width: 75, textAlign: 'right', paddingHorizontal: 4 },
  colTotal:  { width: 90, textAlign: 'right' },

  cellBase: {
    fontSize: sizes.fontBase,
    color: colors.text,
  },
  cellMono: {
    fontSize: sizes.fontBase,
    color: colors.text,
  },
  refMain: {
    fontSize: sizes.fontBase,
    color: colors.text,
    fontWeight: 700,
  },
  descMain: {
    fontSize: sizes.fontBase,
    color: colors.text,
    fontWeight: 400,
  },
  descSub: {
    fontSize: sizes.fontXs,
    color: '#888888',
    marginTop: 2,
  },
  bioBadge: {
    marginLeft: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    backgroundColor: '#DCFCE7',
    color: '#15803D',
    fontSize: 6,
    fontWeight: 900,
    letterSpacing: 0.5,
    borderRadius: 2,
  },

  // ── Totals ───────────────────────────────────────────
  // v2: framed box with rounded corners, sitting tighter against the table.
  totalsWrapper: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 8,
  },
  totals: {
    width: '50%',
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderRadius: 6,
    overflow: 'hidden',
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  totalLabel: {
    fontSize: sizes.fontBase,
    color: colors.text,
    fontWeight: 700,
  },
  totalValue: {
    fontSize: sizes.fontBase,
    color: colors.text,
    textAlign: 'right',
  },
  // Grand total row — bigger, bold, blue, with gold top border + cream bg
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
  grandLabel: {
    fontSize: sizes.fontLg,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.4,
  },
  grandValue: {
    fontSize: sizes.fontLg,
    color: colors.primary,
    fontWeight: 900,
    textAlign: 'right',
  },

  // ── Conditions de paiement ──────────────────────────
  meta: {
    marginTop: 22,
    marginBottom: 4,
  },
  metaTitle: {
    fontSize: sizes.fontXs,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  metaText: {
    fontSize: sizes.fontBase,
    color: colors.text,
    lineHeight: 1.45,
  },

  // ── Bottom cards (Adresse de Livraison + Commentaire) ──
  // Sit just above the footer, separated by the spacer above.
  bottomCardWrap: {
    flexShrink: 0,
    marginBottom: 10,
  },
  commentaireSpacer: {
    flexGrow: 1,
    minHeight: 24,
  },
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
  commentaireHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  commentaireTitle: {
    fontSize: sizes.fontXs,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.5,
  },
  commentaireText: {
    fontSize: sizes.fontBase,
    color: colors.text,
    lineHeight: 1.45,
  },
  commentaireEmpty: {
    fontSize: sizes.fontBase,
    color: colors.subtle,
  },
})

// ── Helpers ──────────────────────────────────────────────

function buildSupplierAddress(data: CommandeFournisseurPdfData): AddressBlockData {
  const a = data.fournisseurAdresse
  const lines: string[] = []
  if (a) {
    if (a.nom && a.nom !== data.fournisseurNom) lines.push(a.nom)
    if (a.adresse1) lines.push(a.adresse1)
    if (a.adresse2) lines.push(a.adresse2)
    if (a.adresse3) lines.push(a.adresse3)
    const cityLine = [a.cp, a.ville].filter(Boolean).join(' ')
    if (cityLine) lines.push(cityLine)
    if (a.pays) lines.push(a.pays)
  }
  return {
    title: 'Fournisseur',
    name: data.fournisseurNom,
    lines,
  }
}

function buildLivraisonAddress(data: CommandeFournisseurPdfData): AddressBlockData {
  const a = data.adresseLivraison
  const lines: string[] = []
  if (a) {
    if (a.adresse1) lines.push(a.adresse1)
    const cityLine = [a.cp, a.ville].filter(Boolean).join(' ')
    if (cityLine) lines.push(cityLine)
    if (a.pays) lines.push(a.pays)
  } else {
    lines.push(company.address1)
    lines.push(`${company.zip} ${company.city}`)
    lines.push(company.country)
  }
  return {
    title: 'Adresse de Livraison',
    name: a?.nom ?? company.legalName,
    lines,
    icon: 'truck',
  }
}

function buildPaymentInfo(data: CommandeFournisseurPdfData): MetadataCardData {
  return {
    title: 'Conditions',
    items: [
      { icon: 'card', label: 'Mode de paiement', value: data.modePaiement || '—' },
      { icon: 'calendar', label: 'Échéance', value: data.echeance || '—' },
      { icon: 'clock', label: 'Délai de livraison', value: data.delaiLivraison || '—' },
    ],
  }
}

// ── Component ────────────────────────────────────────────

export function CommandeFournisseurPdf({ data }: { data: CommandeFournisseurPdfData }) {
  const supplierAddress = buildSupplierAddress(data)
  const livraisonAddress = buildLivraisonAddress(data)
  const paymentInfo = buildPaymentInfo(data)

  const totalKg = data.lignes.reduce(
    (s, l) => s + (l.quantite != null ? Number(l.quantite) : 0),
    0,
  )
  const totalEur = data.lignes.reduce(
    (s, l) =>
      s +
      (l.quantite != null && l.prix_unitaire != null
        ? Number(l.quantite) * Number(l.prix_unitaire)
        : 0),
    0,
  )

  return (
    <MalterreDocument
      documentType="Bon de commande"
      reference={`N°${data.numero}`}
      documentDate={data.dateCommande || ''}
      topLeftAddress={supplierAddress}
      topRightInfo={paymentInfo}
      title={`Bon de commande ${data.numero}`}
    >
      {/* Articles table */}
      <View style={styles.table}>
        <View style={styles.tableHeader} fixed>
          <Text style={[styles.tableHeaderCell, styles.colDesc]}>DÉSIGNATION (RÉFÉRENCE / COLORIS)</Text>
          <Text style={[styles.tableHeaderCell, styles.colQty]}>QTÉ (KG)</Text>
          <Text style={[styles.tableHeaderCell, styles.colPU]}>PRIX UNITAIRE</Text>
          <Text style={[styles.tableHeaderCell, styles.colTotal]}>TOTAL HT</Text>
        </View>
        {data.lignes.map((l, i) => {
          const lineTotal = (Number(l.quantite) || 0) * (Number(l.prix_unitaire) || 0)
          return (
            <View key={i} style={styles.tableRow} wrap={false}>
              <View style={styles.colDesc}>
                <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Text style={styles.refMain}>{l.ref_fil || '—'}</Text>
                  {l.bio ? <Text style={styles.bioBadge}>BIO</Text> : null}
                </View>
                {l.colori_reference && (
                  <Text style={styles.descSub}>{l.colori_reference}</Text>
                )}
              </View>
              <Text style={[styles.cellBase, styles.colQty]}>
                {l.quantite != null ? fmtNum(Number(l.quantite), 1) : '—'}
              </Text>
              <Text style={[styles.cellBase, styles.colPU]}>
                {l.prix_unitaire != null ? `${fmtNum(Number(l.prix_unitaire), 2)} €` : '—'}
              </Text>
              <Text style={[styles.cellBase, styles.colTotal]}>
                {lineTotal > 0 ? `${fmtNum(lineTotal, 2)} €` : '—'}
              </Text>
            </View>
          )
        })}
      </View>

      {/* Totals — right below the table, kept together as a unit */}
      <View style={styles.totalsWrapper} wrap={false}>
        <View style={styles.totals}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Sous-total HT</Text>
            <Text style={styles.totalValue}>{fmtNum(totalEur, 2)} €</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Poids total</Text>
            <Text style={styles.totalValue}>{fmtNum(totalKg, 1)} kg</Text>
          </View>
          <View style={styles.grandRow}>
            <Text style={styles.grandLabel}>TOTAL HT</Text>
            <Text style={styles.grandValue}>{fmtNum(totalEur, 2)} €</Text>
          </View>
        </View>
      </View>

      {/* Spacer pushes the bottom cards to just above the footer */}
      <View style={styles.commentaireSpacer} />

      {/* Adresse de Livraison card (above commentaire) */}
      <View style={styles.bottomCardWrap} wrap={false}>
        <AddressCard data={livraisonAddress} />
      </View>

      {/* Commentaire box pinned just above the footer — only rendered when
          there's an actual commentaire to show. */}
      {data.commentaire && data.commentaire.trim() && (
        <View style={styles.commentaireBox} wrap={false}>
          <View style={styles.commentaireHeaderRow}>
            <MessageSquareIcon />
            <Text style={styles.commentaireTitle}>COMMENTAIRE</Text>
          </View>
          <Text style={styles.commentaireText}>{data.commentaire.trim()}</Text>
        </View>
      )}
    </MalterreDocument>
  )
}
