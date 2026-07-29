// PDF document for a "Bon de commande sous-traitant" (subcontractor order).
// Mirrors the shape of CommandeFournisseurPdf but adapted for sous-traitant
// orders:
//   - top-right column stacks the délai-livraison card and the "Adresse de
//     Livraison" card (no mode_paiement / echeance)
//   - per-line "Délai initial: …" subscript when the line has been
//     rescheduled (date_delai differs from date_livraison)

import React from 'react'
import { View, Text, StyleSheet, Svg, Path } from '@react-pdf/renderer'
import {
  MalterreDocument,
  AddressCard,
  ClockIcon,
  TruckIcon,
  MessageSquareIcon,
  type AddressBlockData,
} from './MalterreDocument.js'
import { colors, sizes, company } from './theme.js'

// Input shape

export interface CommandeSoustraitantPdfData {
  numero: string
  /** "14 avril 2026" - long-form French */
  dateCommande: string
  /** Unit for the QTÉ column header + totals. Derived from line types:
   *  all tricoteur (type=1) lines → 'Kg' (yarn input weight to produce écru),
   *  otherwise 'Ml' (ennoblisseur convention). Mixed-type commandes are
   *  not expected today; the helper falls back to 'Ml' for them. */
  qty_unit: 'Ml' | 'Kg'
  sousTraitantNom: string
  sousTraitantAdresse: {
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
  /** Earliest delivery date across all open lines (long-form French) */
  delaiLivraison: string | null
  commentaire: string | null
  /** Automatic quality comments from Qualité › Actions that apply to this
   *  order's lines (deduped, order-level). Rendered in their own boxed block so
   *  the sst can't mistake a standing quality instruction for the order's
   *  one-off comment. Empty/absent ⇒ the block is not drawn at all. */
  mentionsQualite?: string[]
  lignes: Array<{
    ref_label: string | null
    colori_reference: string | null
    /** ref_fini.designation — e.g. "DOUBLE FACE PES/COTON". */
    ref_designation: string | null
    /** Distilled `ref_fini.conditionnement` ("OUVERT AU LARGE", "TUBULAIRE",
     *  "PLIÉ" or null) — the legacy report's one-line presentation tag. */
    ref_presentation: string | null
    /** Ordered list of treatment names from `traitement_ref_fini` joined to
     *  `traitement`, sorted by `traitement.ordre`. */
    traitements: string[]
    /** ref_fini.poids_Moy in g/m². */
    poids_gm2: number | null
    /** ref_fini.laizeHT_Moy in cm. */
    laize_cm: number | null
    /** ref_fini.rendement in Ml/kg. */
    rendement_ml_kg: number | null
    /** Article initial — ref_ecru reference + designation + composition,
     *  composed server-side ("DF85/55 — jersey coton/pes J28 30\" — 69 coton 31 PES"). */
    ecru_label: string | null
    /** Nominal quantity, in Ml (mètre linéaire). User-entered projection. */
    quantite: number | null
    /** Price per kg of finished fabric. User-entered projection. */
    prix: number | null
    /** Sum of attached écru rolls' weight, in kg. Drives the line € total
     *  (kg × prix) — bon de commande shows blank totals when no rolls are
     *  attached yet, since Ml × €/Kg is unitless garbage. */
    total_kg_ecru_lie: number
    /** Current agreed delivery (dd/mm/yyyy or null) */
    date_livraison: string | null
    /** Original delivery (dd/mm/yyyy) only when it differs from date_livraison */
    date_delai: string | null
    /** Attached écru rolls (Stock à mettre en oeuvre). */
    pieces: Array<{
      numero: string | null
      poids_kg: number | null
      metrage_m: number | null
      observations: string | null
    }>
  }>
}

// French number formatting
function fmtNum(value: number | null | undefined, decimals = 0): string {
  if (value == null || Number.isNaN(value)) return ''
  return value
    .toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace(/ | /g, ' ')
}

// Styles

const styles = StyleSheet.create({
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
  colDesc: { flex: 1, paddingRight: 8 },
  colQty: { width: 60, textAlign: 'center', paddingHorizontal: 4 },
  colPU: { width: 75, textAlign: 'right', paddingHorizontal: 4 },
  colTotal: { width: 90, textAlign: 'right' },

  cellBase: {
    fontSize: 11,
    color: colors.text,
  },
  // ── DÉSIGNATION column hierarchy ──
  // Ref + coloris dominate; designation is the subtitle; treatments,
  // presentation, and tech specs are surfaced as separate visual blocks
  // (chips, callouts) so the eye can scan them without confusion.
  refMainBig: {
    fontSize: 14,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.2,
    lineHeight: 1.2,
  },
  coloriProminent: {
    fontSize: 11,
    color: colors.text,
    fontWeight: 700,
    marginTop: 3,
    lineHeight: 1.3,
  },
  designationSub: {
    fontSize: 9.5,
    color: '#666666',
    marginTop: 4,
    lineHeight: 1.35,
  },

  // Treatment tag chips — light pill with a thin border, sized to wrap.
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 8,
  },
  chip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: '#F5F5F5',
    borderWidth: 0.5,
    borderColor: '#D0D0D0',
    borderRadius: 3,
  },
  chipText: {
    fontSize: 8.5,
    color: '#444444',
    fontWeight: 700,
    letterSpacing: 0.3,
  },

  // Presentation callout (e.g. "OUVERT AU LARGE") — reads as a comment:
  // a MessageSquare icon paired with muted (gray) text so it visually
  // separates from the primary-blue ref title above.
  presentationCallout: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 8,
  },
  presentationCalloutText: {
    fontSize: 9.5,
    fontWeight: 700,
    color: colors.muted,
    letterSpacing: 0.6,
  },

  // Tech spec chips — labeled value (POIDS / LAIZE / RENDEMENT). Label
  // and value share the same fontSize so their baselines align inside the
  // chip; differentiation comes from weight + color + letterspacing.
  // Sized to fit all three on one line (~266pt desc col width).
  specsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    marginTop: 8,
  },
  specChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: '#FAFAFA',
    borderWidth: 0.5,
    borderColor: colors.borderStrong,
    borderRadius: 3,
    gap: 4,
  },
  specLabel: {
    fontSize: 8.5,
    color: colors.muted,
    fontWeight: 900,
    letterSpacing: 0.5,
  },
  specValue: {
    fontSize: 8.5,
    color: colors.text,
    fontWeight: 700,
  },
  // "Article initial" block — a thin gold rule on top, then ref_ecru info.
  ecruRow: {
    marginTop: 10,
    paddingTop: 7,
    borderTopWidth: 0.5,
    borderTopColor: colors.gold,
    borderTopStyle: 'solid',
  },
  ecruTitle: {
    fontSize: 8.5,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.6,
    marginBottom: 3,
  },
  ecruLabel: {
    fontSize: 10.5,
    color: colors.text,
    lineHeight: 1.35,
  },
  // ── Dedicated "Stock à mettre en œuvre" page (secondPage) ──
  // No top margin: the secondPage's paddingTop already provides the gap below
  // the repeated header. An extra marginTop here pushed the title + first line
  // group past the page boundary, orphaning the title on its own near-empty
  // page (and spilling a blank trailing page on short single-line stock lists).
  v2Section: {},
  // Page 2 fonts are sized to mirror page 1's hierarchy: the line header
  // matches page 1's refMainBig (primary blue, weight 900); the écru
  // subheader matches page 1's designationSub; the table content sits at
  // the same body size as page 1's ecruLabel.
  v2Title: {
    fontSize: 18,
    fontWeight: 900,
    color: colors.primary,
    letterSpacing: 0.8,
    // ALL CAPS without diacritics — uppercase accented chars (À, É, Œ)
    // render with detached diacritics in Lato Black under @react-pdf,
    // so we strip the accents from this title only.
    lineHeight: 1.2,
    marginBottom: 4,
  },
  v2Subtitle: {
    fontSize: 10,
    color: colors.muted,
    marginBottom: 10,
  },
  v2TitleRule: {
    height: 2,
    backgroundColor: colors.gold,
    marginBottom: 12,
  },
  v2LineGroup: {
    marginBottom: 18,
  },
  // Page 2 line header — mirrors page 1's refMainBig / coloriProminent
  // hierarchy: ref in primary blue + bold, coloris in black + medium,
  // écru subtitle in muted gray. The "(suite N/M)" indicator for wrapped
  // lines rides as a smaller muted suffix on the ref line.
  v2RefMain: {
    fontSize: 13,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.2,
    marginBottom: 3,
  },
  v2Coloris: {
    fontSize: 11,
    color: colors.text,
    fontWeight: 700,
    marginBottom: 4,
  },
  v2SuiteSuffix: {
    fontSize: 9,
    color: colors.muted,
    fontWeight: 700,
  },
  v2LineSubheader: {
    fontSize: 9.5,
    color: '#666666',
    marginBottom: 8,
  },
  v2Table: {
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderRadius: 6,
    overflow: 'hidden',
  },
  v2TableHeader: {
    flexDirection: 'row',
    backgroundColor: colors.bgMuted,
    borderBottomWidth: 1.5,
    borderBottomColor: colors.gold,
    borderBottomStyle: 'solid',
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  v2HeaderCell: {
    fontSize: 9,
    color: colors.text,
    fontWeight: 900,
    letterSpacing: 0.5,
  },
  v2Row: {
    flexDirection: 'row',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: '#EEEEEE',
    borderBottomStyle: 'solid',
  },
  // Tighter line-height than the body default (contentLean's 1.45): table rows
  // are single-line, and the extra leading needlessly inflated each row, which
  // pushed long piece lists onto extra/blank pages.
  v2Cell: { fontSize: 10.5, color: colors.text, lineHeight: 1.2 },
  v2ColNumero: { width: 110 },
  v2ColPoids: { width: 90, textAlign: 'right' },
  v2ColObs: { flex: 1, paddingLeft: 14, color: '#5A5A5A' },
  v2TotalRow: {
    flexDirection: 'row',
    paddingVertical: 9,
    paddingHorizontal: 10,
    backgroundColor: colors.bgTotal,
  },
  v2TotalLabel: {
    width: 110,
    fontSize: 11,
    color: colors.text,
    fontWeight: 900,
  },
  v2TotalValue: {
    width: 90,
    fontSize: 11,
    color: colors.text,
    fontWeight: 900,
    textAlign: 'right',
  },

  totalsWrapper: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 0,
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

  // Custom top row — replaces MalterreDocument's stock 2-card row so the
  // right column can fit délai + livraison address in a single card.
  topRow: {
    flexDirection: 'row',
    gap: 14,
    marginBottom: 16,
    alignItems: 'stretch',
  },
  topRowSlot: {
    flex: 1,
    flexDirection: 'column',
  },
  // Combo card (right slot): same chrome as AddressCard / MetadataCard but
  // hosts a metadata row at the top, a thin divider, then the livraison
  // address block underneath — all inside one frame.
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
  comboMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 3,
  },
  comboMetaIconBox: {
    width: 14,
    height: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Tight lineHeight so the text box hugs the glyphs — the inherited 1.45
  // pushes the label visually below the center-aligned icon (§38 mps_designer).
  comboMetaLabel: {
    fontSize: sizes.fontBase,
    color: colors.muted,
    fontWeight: 700,
    flex: 1,
    lineHeight: 1.25,
  },
  comboMetaValue: {
    fontSize: sizes.fontBase,
    color: colors.text,
    fontWeight: 700,
    textAlign: 'right',
    lineHeight: 1.25,
  },
  comboDivider: {
    height: 0.75,
    backgroundColor: colors.borderStrong,
    marginVertical: 10,
  },
  comboCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  comboCardTitle: {
    fontSize: sizes.fontXs,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.5,
  },
  comboCardName: {
    fontSize: sizes.fontBase,
    fontWeight: 900,
    color: colors.text,
    marginBottom: 1,
  },
  comboCardLine: {
    fontSize: sizes.fontBase,
    color: colors.text,
    lineHeight: 1.4,
  },
  // Commentaire flows right below the totals with a fixed gap. We deliberately
  // do NOT bottom-pin it (neither a flexGrow spacer nor marginTop:'auto'):
  // bottom-aligning a wrap={false} box inside the full-height flex content area
  // shoves it past the page edge and emits a blank/near-empty overflow page.
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
  commentaireText: { fontSize: sizes.fontBase, color: colors.text, lineHeight: 1.45 },

  // ── Mentions qualité ───────────────────────────────────
  // Same box language as the commentaire so the page keeps one visual system,
  // but flagged red on the left edge: these are standing quality instructions
  // from Qualité › Actions, not this order's one-off note, and the sst must not
  // read them as interchangeable.
  mentionsBox: {
    flexShrink: 0,
    marginTop: 12,
    padding: 14,
    backgroundColor: colors.bgCream,
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderLeftWidth: 2,
    borderLeftColor: colors.flagRed,
    borderLeftStyle: 'solid',
    borderRadius: 6,
  },
  mentionsTitle: {
    fontSize: sizes.fontXs,
    color: colors.flagRed,
    fontWeight: 900,
    letterSpacing: 0.5,
    // Tight lineHeight so the title centres against its icon (§38.1) — the
    // inherited 1.45 would drop the glyphs below the SVG's box.
    lineHeight: 1,
  },
  mentionRow: { flexDirection: 'row', gap: 6, marginTop: 4 },
  mentionBullet: { fontSize: sizes.fontBase, color: colors.flagRed, lineHeight: 1.45 },
  mentionText: { flex: 1, fontSize: sizes.fontBase, color: colors.text, lineHeight: 1.45 },
})

/** Lucide-style "alert triangle" — local to this document since it's the only
 *  one that flags standing quality instructions. */
function AlertTriangleIcon({ size = 11, color = colors.flagRed, strokeWidth = 1.8 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
      />
      <Path d="M12 9v4" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M12 17h.01" stroke={color} strokeWidth={strokeWidth} fill="none" />
    </Svg>
  )
}

function buildSousTraitantAddress(data: CommandeSoustraitantPdfData): AddressBlockData {
  const a = data.sousTraitantAdresse
  const lines: string[] = []
  if (a) {
    if (a.nom && a.nom !== data.sousTraitantNom) lines.push(a.nom)
    if (a.adresse1) lines.push(a.adresse1)
    if (a.adresse2) lines.push(a.adresse2)
    if (a.adresse3) lines.push(a.adresse3)
    const cityLine = [a.cp, a.ville].filter(Boolean).join(' ')
    if (cityLine) lines.push(cityLine)
    if (a.pays) lines.push(a.pays)
  }
  return {
    title: 'Sous-traitant',
    name: data.sousTraitantNom,
    lines,
    icon: 'factory',
  }
}

function buildLivraisonAddress(data: CommandeSoustraitantPdfData): AddressBlockData {
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

export function CommandeSoustraitantPdf({
  data,
}: {
  data: CommandeSoustraitantPdfData
}) {
  const sousTraitantAddress = buildSousTraitantAddress(data)
  const livraisonAddress = buildLivraisonAddress(data)
  const hasAnyPieces = data.lignes.some((l) => (l.pieces?.length ?? 0) > 0)

  // Bon de commande totals.
  // - Quantité: sum of `quantite` (Ml for ennoblisseur, kg for tricoteur —
  //   driven by data.qty_unit; mixed not expected).
  // - Poids affecté (ennoblisseur only): sum of attached écru weight.
  // - TOTAL HT:
  //     tricoteur (qty_unit='Kg') → Σ(quantite × prix), known up front
  //     because quantite is already kg.
  //     ennoblisseur (qty_unit='Ml') → Σ(total_kg_ecru_lie × prix); blank
  //     until écru rolls are attached (Ml × €/Kg is unitless garbage).
  const totalQte = data.lignes.reduce(
    (s, l) => s + (l.quantite != null ? Number(l.quantite) : 0),
    0,
  )
  const totalKgAffecte = data.lignes.reduce(
    (s, l) => s + (Number(l.total_kg_ecru_lie) || 0),
    0,
  )
  const totalEur = data.qty_unit === 'Kg'
    ? data.lignes.reduce(
        (s, l) => s + ((Number(l.quantite) || 0) * (Number(l.prix) || 0)),
        0,
      )
    : data.lignes.reduce(
        (s, l) => s + ((Number(l.total_kg_ecru_lie) || 0) * (Number(l.prix) || 0)),
        0,
      )

  return (
    <MalterreDocument
      documentType="Bon de commande"
      reference={`SOUS-TRAITANT N°${data.numero}`}
      documentDate={data.dateCommande || ''}
      title={`Bon de commande sous-traitant ${data.numero}`}
      secondPage={hasAnyPieces ? {
        withHeader: true,
        children: <V2StockSection data={data} />,
      } : undefined}
    >
      {/* Custom top row: sous-traitant on the left; on the right, a single
          card that holds the délai de livraison row at the top, a divider,
          then the adresse de livraison block below. */}
      <View style={styles.topRow}>
        <View style={styles.topRowSlot}>
          <AddressCard data={sousTraitantAddress} stretch />
        </View>
        <View style={styles.topRowSlot}>
          <View style={styles.comboCard}>
            <View style={styles.comboMetaRow}>
              <View style={styles.comboMetaIconBox}>
                <ClockIcon />
              </View>
              <Text style={styles.comboMetaLabel}>Délai de livraison</Text>
              <Text style={styles.comboMetaValue}>{data.delaiLivraison || '—'}</Text>
            </View>
            <View style={styles.comboDivider} />
            <View style={styles.comboCardHeader}>
              <TruckIcon />
              <Text style={styles.comboCardTitle}>{livraisonAddress.title.toUpperCase()}</Text>
            </View>
            {livraisonAddress.name ? (
              <Text style={styles.comboCardName}>{livraisonAddress.name}</Text>
            ) : null}
            {livraisonAddress.lines.map((l, i) => (
              <Text key={i} style={styles.comboCardLine}>{l}</Text>
            ))}
          </View>
        </View>
      </View>

      <View style={styles.table}>
        <View style={styles.tableHeader} fixed>
          <Text style={[styles.tableHeaderCell, styles.colDesc]}>DÉSIGNATION (RÉFÉRENCE FINI / COLORIS)</Text>
          <Text style={[styles.tableHeaderCell, styles.colQty]}>QTÉ ({data.qty_unit})</Text>
          <Text style={[styles.tableHeaderCell, styles.colPU]}>PRIX (€/Kg)</Text>
          {/* "POIDS AFFECTE" tracks `total_kg_ecru_lie` — only meaningful
              for ennoblisseur lines (écru rolls linked for dyeing). Tricoteur
              commandes consume yarn (asso_fil_lignecmdsst) and produce
              écru; that flow has no "affected weight" to show on the BC. */}
          {data.qty_unit !== 'Kg' && (
            <Text style={[styles.tableHeaderCell, styles.colTotal]}>POIDS AFFECTE</Text>
          )}
        </View>
        {data.lignes.map((l, i) => {
          const kg = Number(l.total_kg_ecru_lie) || 0
          return (
            <View key={i} style={styles.tableRow}>
              <View style={styles.colDesc}>
                <Text style={styles.refMainBig}>{l.ref_label || '—'}</Text>
                {l.colori_reference && (
                  <Text style={styles.coloriProminent}>{l.colori_reference}</Text>
                )}
                {l.ref_designation && (
                  <Text style={styles.designationSub}>{l.ref_designation}</Text>
                )}
                {l.traitements.length > 0 && (
                  <View style={styles.chipsRow}>
                    {l.traitements.map((t, j) => (
                      <View key={j} style={styles.chip}>
                        <Text style={styles.chipText}>{t}</Text>
                      </View>
                    ))}
                  </View>
                )}
                {l.ref_presentation && (
                  <View style={styles.presentationCallout}>
                    <MessageSquareIcon size={9} color={colors.muted} />
                    <Text style={styles.presentationCalloutText}>{l.ref_presentation}</Text>
                  </View>
                )}
                {(l.poids_gm2 != null || l.laize_cm != null || l.rendement_ml_kg != null) && (
                  <View style={styles.specsRow}>
                    {l.poids_gm2 != null && (
                      <View style={styles.specChip}>
                        <Text style={styles.specLabel}>POIDS</Text>
                        <Text style={styles.specValue}>{fmtNum(l.poids_gm2, 0)} g/m²</Text>
                      </View>
                    )}
                    {l.laize_cm != null && (
                      <View style={styles.specChip}>
                        <Text style={styles.specLabel}>LAIZE</Text>
                        <Text style={styles.specValue}>{fmtNum(l.laize_cm, 0)} cm</Text>
                      </View>
                    )}
                    {l.rendement_ml_kg != null && (
                      <View style={styles.specChip}>
                        <Text style={styles.specLabel}>RENDEMENT</Text>
                        <Text style={styles.specValue}>{fmtNum(l.rendement_ml_kg, 2)}</Text>
                      </View>
                    )}
                  </View>
                )}
                {l.ecru_label && (
                  <View style={styles.ecruRow}>
                    <Text style={styles.ecruTitle}>ARTICLE INITIAL</Text>
                    <Text style={styles.ecruLabel}>{l.ecru_label}</Text>
                  </View>
                )}
              </View>
              <Text style={[styles.cellBase, styles.colQty]}>
                {l.quantite != null ? fmtNum(Number(l.quantite), 1) : '—'}
              </Text>
              <Text style={[styles.cellBase, styles.colPU]}>
                {l.prix != null ? `${fmtNum(Number(l.prix), 2)} €` : '—'}
              </Text>
              {data.qty_unit !== 'Kg' && (
                <Text style={[styles.cellBase, styles.colTotal]}>
                  {kg > 0 ? `${fmtNum(kg, 1)} kg` : '—'}
                </Text>
              )}
            </View>
          )
        })}
      </View>

      <View style={styles.totalsWrapper} wrap={false}>
        <View style={styles.totals}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Quantité prévue</Text>
            <Text style={styles.totalValue}>{fmtNum(totalQte, 1)} {data.qty_unit}</Text>
          </View>
          {data.qty_unit !== 'Kg' && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Poids affecté</Text>
              <Text style={styles.totalValue}>
                {totalKgAffecte > 0 ? `${fmtNum(totalKgAffecte, 1)} kg` : '— (à expédier)'}
              </Text>
            </View>
          )}
          <View style={styles.grandRow}>
            <Text style={styles.grandLabel}>TOTAL HT</Text>
            <Text style={styles.grandValue}>
              {totalEur > 0 ? `${fmtNum(totalEur, 2)} €` : '—'}
            </Text>
          </View>
        </View>
      </View>

      {/* Commentaire box, pushed to the bottom of the front page via
          `marginTop: 'auto'`. A flexGrow spacer is NOT used: it would grow to
          fill ALL remaining space, then the box's own height would stack on top
          and overflow into a blank page. `marginTop: auto` bottom-aligns the box
          while still accounting for its height, so the front page stays single. */}
      {data.commentaire && data.commentaire.trim() && (
        <View style={[styles.commentaireBox, styles.commentaireBottom]} wrap={false}>
          <View style={styles.commentaireHeaderRow}>
            <MessageSquareIcon />
            <Text style={styles.commentaireTitle}>COMMENTAIRE</Text>
          </View>
          <Text style={styles.commentaireText}>{data.commentaire.trim()}</Text>
        </View>
      )}

      {/* Standing quality instructions (Qualité › Actions). Its own box below
          the commentaire — never merged into it, so the sst can tell a recurring
          requirement from this order's one-off note. `commentaireBottom` only
          when there is no commentaire above, since that box already spaced it. */}
      {(data.mentionsQualite ?? []).length > 0 && (
        <View
          style={
            data.commentaire && data.commentaire.trim()
              ? styles.mentionsBox
              : [styles.mentionsBox, styles.commentaireBottom]
          }
          wrap={false}
        >
          <View style={styles.commentaireHeaderRow}>
            <AlertTriangleIcon />
            <Text style={styles.mentionsTitle}>MENTIONS QUALITÉ</Text>
          </View>
          {(data.mentionsQualite ?? []).map((m, i) => (
            <View key={i} style={styles.mentionRow}>
              <Text style={styles.mentionBullet}>•</Text>
              <Text style={styles.mentionText}>{m.trim()}</Text>
            </View>
          ))}
        </View>
      )}

    </MalterreDocument>
  )
}

// ── V2 stock section (page 2 onward) ─────────────────────
// Rendered into MalterreDocument's `secondPage` slot — a fresh <Page>
// with a Page-level paddingTop that propagates to every physical overflow
// page, so wrapped tables get clean breathing room at the top.
//
// To keep rounded corners on every visible table fragment (the user
// explicitly asked for "as if this was a new independent table"), we
// chunk each line's pieces into self-contained mini-tables and mark each
// chunk `wrap={false}`. @react-pdf then flows them naturally and shifts
// any chunk that doesn't fit onto the next physical page — which gets
// the Page-level top margin AND its own rounded box.

/** Pieces per chunk. Sized so the first chunk still fits on the secondPage
 *  first physical page alongside the section title (~80pt). After Page
 *  paddingTop (36) + paddingBottom (100), the usable height is 706pt;
 *  subtract section title (~80) + line-group chrome (~145pt with split
 *  ref/coloris header + écru subheader + table header + total row), the
 *  remaining ≈ 480pt fits 17 rows × 27pt. Lower if row heights grow. */
const V2_CHUNK_SIZE = 17

function chunkPieces<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) return []
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function V2StockSection({ data }: { data: CommandeSoustraitantPdfData }) {
  return (
    <View style={styles.v2Section}>
      <Text style={styles.v2Title}>STOCK A METTRE EN OEUVRE</Text>
      <Text style={styles.v2Subtitle}>
        Bon de commande sous-traitant N°{data.numero}
        {data.sousTraitantNom ? ` · ${data.sousTraitantNom}` : ''}
      </Text>
      <View style={styles.v2TitleRule} />
      {data.lignes.map((l, li) => {
        const pieces = l.pieces ?? []
        if (pieces.length === 0) return null
        const totalKg = pieces.reduce((s, p) => s + (Number(p.poids_kg) || 0), 0)
        const chunks = chunkPieces(pieces, V2_CHUNK_SIZE)
        return (
          <View key={li}>
            {chunks.map((chunk, ci) => {
              const isFirst = ci === 0
              const isLast = ci === chunks.length - 1
              return (
                <View key={ci} style={styles.v2LineGroup} wrap={false}>
                  <Text style={styles.v2RefMain}>
                    {l.ref_label || '—'}
                    {!isFirst && (
                      <Text style={styles.v2SuiteSuffix}>
                        {`  (suite ${ci + 1}/${chunks.length})`}
                      </Text>
                    )}
                  </Text>
                  {l.colori_reference && (
                    <Text style={styles.v2Coloris}>{l.colori_reference}</Text>
                  )}
                  {isFirst && l.ecru_label && (
                    <Text style={styles.v2LineSubheader}>{l.ecru_label}</Text>
                  )}
                  <View style={styles.v2Table}>
                    <View style={styles.v2TableHeader}>
                      <Text style={[styles.v2HeaderCell, styles.v2ColNumero]}>N° PIECE</Text>
                      <Text style={[styles.v2HeaderCell, styles.v2ColPoids]}>POIDS</Text>
                      <Text style={[styles.v2HeaderCell, styles.v2ColObs]}>OBSERVATIONS</Text>
                    </View>
                    {chunk.map((p, pi) => (
                      <View key={pi} style={styles.v2Row}>
                        <Text style={[styles.v2Cell, styles.v2ColNumero]}>{p.numero || '—'}</Text>
                        <Text style={[styles.v2Cell, styles.v2ColPoids]}>
                          {p.poids_kg != null ? `${fmtNum(p.poids_kg, 2)} kg` : '—'}
                        </Text>
                        <Text style={[styles.v2Cell, styles.v2ColObs]}>{p.observations ?? ''}</Text>
                      </View>
                    ))}
                    {isLast && (
                      <View style={styles.v2TotalRow}>
                        <Text style={styles.v2TotalLabel}>
                          {pieces.length} pièce{pieces.length > 1 ? 's' : ''}
                        </Text>
                        <Text style={styles.v2TotalValue}>{fmtNum(totalKg, 2)} kg</Text>
                        <Text style={[styles.v2Cell, styles.v2ColObs]}></Text>
                      </View>
                    )}
                  </View>
                </View>
              )
            })}
          </View>
        )
      })}
    </View>
  )
}
