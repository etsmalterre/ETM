// PDF document for a "Soumission Lot" — sent to a client after a fini lot
// returns from the ennoblisseur. The legacy WinDev report is the visual
// reference: a one-page document with a reference strip (Référence Client
// / Référence Malterre / Coloris), an order detail table, a livraison
// address panel, a soumission metadata table, and a large empty frame
// where the operator physically staples the dyed-fabric swatch before
// handing the printed page to the client.
//
// Eligibility (whether the client requires a soumission for a given
// ref_fini) is computed server-side in the route file via the
// `designation_client.soumettre` flag — this component receives the data
// already filtered and just renders.

import React from 'react'
import { View, Text, StyleSheet, Svg, Path } from '@react-pdf/renderer'
import {
  MalterreDocument,
  AddressCard,
  TruckIcon,
  type AddressBlockData,
} from './MalterreDocument.js'
import { colors, sizes } from './theme.js'

// ── Custom icons (not in MalterreDocument's catalog) ──────
// Drawn as inline line SVGs to match the existing icon style.

function FabricRollIcon({ size = 12, color = colors.primary, strokeWidth = 1.8 }: {
  size?: number; color?: string; strokeWidth?: number
}) {
  // A horizontal textile roll: ellipse cap on the left + a swooping body.
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M7 5v14" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M11 5v14" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M15 5v14" stroke={color} strokeWidth={strokeWidth} fill="none" />
    </Svg>
  )
}

function PaletteIcon({ size = 12, color = colors.primary, strokeWidth = 1.8 }: {
  size?: number; color?: string; strokeWidth?: number
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 2a10 10 0 1 0 0 20 2.5 2.5 0 0 0 1.8-4.2 2.5 2.5 0 0 1 1.8-4.2H18a4 4 0 0 0 4-4 10 10 0 0 0-10-7.6z"
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
      />
      <Path d="M7 13.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" stroke={color} strokeWidth={strokeWidth} fill={color} />
      <Path d="M10 8.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" stroke={color} strokeWidth={strokeWidth} fill={color} />
      <Path d="M15 8.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" stroke={color} strokeWidth={strokeWidth} fill={color} />
    </Svg>
  )
}

// ── Input shape ──────────────────────────────────────────

export interface SoumissionLotPdfData {
  /** commande_client.numero — the small human-friendly client-order number
   *  shown in the "Détails de la commande" table (e.g. 3578). */
  numeroCommande: string
  /** today, long-form FR, e.g. "13 mai 2026" */
  dateSoumission: string
  /** commande_client.date_commande, long-form FR */
  dateCommande: string
  /** ligne_commande_client.date_livraison, long-form FR */
  dateLivraison: string
  /** commande_client.ref_client — free-text client reference */
  refCommandeClient: string
  /** Σ stock_fini.metrage for this lot, in Ml */
  quantiteMl: number
  /** Top-right header: the client name (e.g. "Le slip Francais") */
  clientNom: string
  /** Reference strip cells */
  refClient: string         // designation_client.designation
  refMalterre: string       // ref_fini.reference
  coloris: string           // ref_fini_colori.reference
  /** Adresse de livraison panel */
  adresseLivraison: {
    nom: string | null
    adresse1: string | null
    adresse2: string | null
    adresse3: string | null
    cp: string | null
    ville: string | null
    pays: string | null
  } | null
  /** Soumission table cells */
  expediteur: string        // current user's prénom
  destinataire: string      // client contact with envoi_soumission=1
  lot: string               // stock_fini.lot ("Lot / Bain" cell)
  /** What the client checks (LIVA #1313): the coloris on a sample cut after
   *  the dye, before the stenter — or the dimensional stability of the rolls. */
  nature: 'coloris' | 'stabilites'
}

// ── Helpers ──────────────────────────────────────────────

function fmtNum(value: number | null | undefined, decimals = 0): string {
  if (value == null || Number.isNaN(value)) return '—'
  return value
    .toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace(/ | /g, ' ')
}

function buildLivraisonAddress(data: SoumissionLotPdfData): AddressBlockData {
  const a = data.adresseLivraison
  const lines: string[] = []
  if (a) {
    if (a.adresse1) lines.push(a.adresse1)
    if (a.adresse2) lines.push(a.adresse2)
    if (a.adresse3) lines.push(a.adresse3)
    const cityLine = [a.cp, a.ville].filter(Boolean).join(' ')
    if (cityLine) lines.push(cityLine)
    if (a.pays) lines.push(a.pays)
  }
  return {
    title: 'Adresse de livraison',
    name: a?.nom ?? '',
    lines,
    icon: 'truck',
  }
}

// ── Styles ───────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── Reference strip (3 cells) ────────────────────────
  refStrip: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 18,
  },
  refCell: {
    flex: 1,
    backgroundColor: colors.bgCream,
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderLeftWidth: 2,
    borderLeftColor: colors.gold,
    borderLeftStyle: 'solid',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  refCellTextBlock: {
    flex: 1,
    flexDirection: 'column',
    gap: 2,
  },
  refCellLabel: {
    fontSize: 8,
    color: colors.muted,
    fontWeight: 900,
    letterSpacing: 0.6,
  },
  refCellValue: {
    fontSize: 12,
    color: colors.text,
    fontWeight: 900,
  },

  // ── Section title (underlined) ───────────────────────
  sectionTitle: {
    fontSize: 13,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.4,
    marginBottom: 6,
    marginTop: 8,
  },

  // ── Tables (Détails / Soumission) ────────────────────
  table: {
    marginBottom: 14,
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderRadius: 6,
    overflow: 'hidden',
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: colors.bgMuted,
    borderBottomWidth: 1.5,
    borderBottomColor: colors.gold,
    borderBottomStyle: 'solid',
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  tableHeaderCell: {
    fontSize: 9,
    color: colors.text,
    fontWeight: 900,
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  tableCell: {
    fontSize: 10,
    color: colors.text,
    textAlign: 'center',
  },

  // ── Adresse livraison wrapper ────────────────────────
  adresseWrap: {
    marginBottom: 14,
  },

  // ── Sample frame ─────────────────────────────────────
  sampleFrame: {
    flexGrow: 1,
    // Fills what the page leaves. 200 pushed the whole frame onto a blank
    // 2nd page when the delivery address runs to 6 lines (Agape, Maroc).
    minHeight: 100,
    marginTop: 4,
    borderWidth: 1.25,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  sampleText: {
    fontSize: 16,
    color: colors.subtle,
    fontWeight: 700,
    letterSpacing: 0.4,
    textAlign: 'center',
  },
})

// ── Component ────────────────────────────────────────────

export function SoumissionLotPdf({ data }: { data: SoumissionLotPdfData }) {
  const livraisonAddress = buildLivraisonAddress(data)

  return (
    <MalterreDocument
      // ALL CAPS without diacritics: Lato Black renders detached
      // diacritics on uppercase À/É/Œ — keep the title accent-free.
      documentType={data.nature === 'coloris' ? 'Soumission Coloris' : 'Soumission Lot'}
      reference={data.clientNom}
      documentDate={data.dateSoumission || ''}
      title={`Soumission ${data.nature === 'coloris' ? 'coloris' : 'lot'} ${data.lot} — ${data.clientNom}`}
    >
      {/* Reference strip — 3 cells with icon + label/value */}
      <View style={styles.refStrip}>
        <View style={styles.refCell}>
          <FabricRollIcon />
          <View style={styles.refCellTextBlock}>
            <Text style={styles.refCellLabel}>RÉFÉRENCE CLIENT</Text>
            <Text style={styles.refCellValue}>{data.refClient || '—'}</Text>
          </View>
        </View>
        <View style={styles.refCell}>
          <View style={styles.refCellTextBlock}>
            <Text style={styles.refCellLabel}>RÉFÉRENCE MALTERRE</Text>
            <Text style={styles.refCellValue}>{data.refMalterre || '—'}</Text>
          </View>
        </View>
        <View style={styles.refCell}>
          <PaletteIcon />
          <View style={styles.refCellTextBlock}>
            <Text style={styles.refCellLabel}>COLORIS</Text>
            <Text style={styles.refCellValue}>{data.coloris || '—'}</Text>
          </View>
        </View>
      </View>

      {/* "Détails de la commande" */}
      <Text style={styles.sectionTitle}>Détails de la commande :</Text>
      <View style={styles.table} wrap={false}>
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Date Commande</Text>
          <Text style={[styles.tableHeaderCell, { flex: 2 }]}>Ref commande client</Text>
          <Text style={[styles.tableHeaderCell, { flex: 1 }]}>N° Commande</Text>
          <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Quantité</Text>
          <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Date livraison</Text>
        </View>
        <View style={styles.tableRow}>
          <Text style={[styles.tableCell, { flex: 1 }]}>{data.dateCommande || '—'}</Text>
          <Text style={[styles.tableCell, { flex: 2 }]}>{data.refCommandeClient || '—'}</Text>
          <Text style={[styles.tableCell, { flex: 1 }]}>{data.numeroCommande || '—'}</Text>
          <Text style={[styles.tableCell, { flex: 1 }]}>
            {data.quantiteMl > 0 ? `${fmtNum(data.quantiteMl, 1)} Ml` : '—'}
          </Text>
          <Text style={[styles.tableCell, { flex: 1 }]}>{data.dateLivraison || '—'}</Text>
        </View>
      </View>

      {/* "Adresse de livraison" panel */}
      <View style={styles.adresseWrap} wrap={false}>
        <AddressCard data={livraisonAddress} />
      </View>

      {/* "Soumission" */}
      <Text style={styles.sectionTitle}>Soumission :</Text>
      <View style={styles.table} wrap={false}>
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Date Soumission</Text>
          <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Objet</Text>
          <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Expéditeur</Text>
          <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Destinataire</Text>
          <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Lot / Bain</Text>
        </View>
        <View style={styles.tableRow}>
          <Text style={[styles.tableCell, { flex: 1 }]}>{data.dateSoumission || '—'}</Text>
          <Text style={[styles.tableCell, { flex: 1 }]}>{data.nature === 'coloris' ? 'Coloris (avant rame)' : 'Stabilités'}</Text>
          <Text style={[styles.tableCell, { flex: 1 }]}>{data.expediteur || '—'}</Text>
          <Text style={[styles.tableCell, { flex: 1 }]}>{data.destinataire || '—'}</Text>
          <Text style={[styles.tableCell, { flex: 1 }]}>{data.lot || '—'}</Text>
        </View>
      </View>

      {/* Large empty frame — operator staples the physical swatch here */}
      <View style={styles.sampleFrame}>
        <Text style={styles.sampleText}>Attacher l'échantillon ici</Text>
      </View>
    </MalterreDocument>
  )
}
