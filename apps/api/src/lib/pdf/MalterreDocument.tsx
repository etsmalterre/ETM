// Reusable Malterre-branded PDF document frame. Every MPS document PDF
// (commande fournisseur, devis, facture, bon de livraison, etc.) renders its
// content inside this wrapper so the header, footer, and brand chrome stay
// identical across the company.
//
// Design language matches the HTML template the user approved:
//  - Full-width yellow header band with logo + company info on white text
//  - French flag stripe (bleu-blanc-rouge) at the bottom of the header
//  - Gold-accent document title in the body
//  - Cream-tinted address block with a gold left border
//  - Centered legal footer at the bottom of the page

import React from 'react'
import { Document, Page, View, Text, Image, StyleSheet, Font, Svg, Path } from '@react-pdf/renderer'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'
import { colors, company, sizes, type CompanyInfo } from './theme.js'

// ── Inline icon components (lucide-style line SVGs) ─────
// Reusable from any specific document via the named exports below.

interface IconProps {
  size?: number
  color?: string
  strokeWidth?: number
}

export function MessageSquareIcon({ size = 11, color = colors.primary, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
      />
    </Svg>
  )
}

export function CreditCardIcon({ size = 11, color = colors.primary, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M2 5h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M1 10h22" stroke={color} strokeWidth={strokeWidth} fill="none" />
    </Svg>
  )
}

export function CalendarIcon({ size = 11, color = colors.primary, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M3 5h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M2 10h20" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M8 3v4" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M16 3v4" stroke={color} strokeWidth={strokeWidth} fill="none" />
    </Svg>
  )
}

export function ClockIcon({ size = 11, color = colors.primary, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z"
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
      />
      <Path d="M12 6v6l4 2" stroke={color} strokeWidth={strokeWidth} fill="none" />
    </Svg>
  )
}

export function TruckIcon({ size = 12, color = colors.primary, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M1 4h13v12H1z" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M14 8h4l4 5v3h-8" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M7 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0z" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M19 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0z" stroke={color} strokeWidth={strokeWidth} fill="none" />
    </Svg>
  )
}

export function TagIcon({ size = 11, color = colors.primary, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
      />
      <Path d="M7 7h.01" stroke={color} strokeWidth={strokeWidth * 1.5} fill="none" />
    </Svg>
  )
}

export function LandmarkIcon({ size = 11, color = colors.primary, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M3 22h18" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M6 18v-7" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M10 18v-7" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M14 18v-7" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M18 18v-7" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M12 2l8 5H4z" stroke={color} strokeWidth={strokeWidth} fill="none" />
    </Svg>
  )
}

export function UserIcon({ size = 12, color = colors.primary, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
      />
      <Path
        d="M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
      />
    </Svg>
  )
}

export function FactoryIcon({ size = 12, color = colors.primary, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
      />
      <Path d="M7 18h1" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M12 18h1" stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Path d="M17 18h1" stroke={color} strokeWidth={strokeWidth} fill="none" />
    </Svg>
  )
}

// Maps a metadata icon kind to the right SVG component.
type IconKind = 'card' | 'calendar' | 'clock' | 'truck' | 'message' | 'factory' | 'tag' | 'user'
function ResolveIcon({ kind, ...props }: { kind: IconKind } & IconProps) {
  switch (kind) {
    case 'card': return <CreditCardIcon {...props} />
    case 'calendar': return <CalendarIcon {...props} />
    case 'clock': return <ClockIcon {...props} />
    case 'truck': return <TruckIcon {...props} />
    case 'message': return <MessageSquareIcon {...props} />
    case 'factory': return <FactoryIcon {...props} />
    case 'tag': return <TagIcon {...props} />
    case 'user': return <UserIcon {...props} />
  }
}

// ── Asset loading ────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ASSETS = path.resolve(__dirname, '../../assets')

// Wide horizontal logo (white text on transparent) — designed to sit on the
// yellow header band.
const LOGO_BUFFER: Buffer = fs.readFileSync(path.join(ASSETS, 'logo-malterre-wide.png'))

// Register Lato (matches the app's body font in apps/web/src/index.css).
Font.register({
  family: 'Lato',
  fonts: [
    { src: path.join(ASSETS, 'fonts/Lato-Light.ttf'), fontWeight: 300 },
    { src: path.join(ASSETS, 'fonts/Lato-Regular.ttf'), fontWeight: 400 },
    { src: path.join(ASSETS, 'fonts/Lato-Bold.ttf'), fontWeight: 700 },
    { src: path.join(ASSETS, 'fonts/Lato-Black.ttf'), fontWeight: 900 },
  ],
})

Font.registerHyphenationCallback((word) => [word])

// ── Styles ───────────────────────────────────────────────

const styles = StyleSheet.create({
  page: {
    // Page padding: 0 top/horizontal so the yellow header band reaches the
    // edges, and a bottom band so flow content stops before the absolute
    // footer area. The Page's bottom padding IS respected by the wrapping
    // engine, unlike inner padding which just adds visual whitespace.
    // 80pt clears the ~66pt footer band plus the page-number line (bottom:72)
    // while reclaiming dead reserve, so a borderline single-line front page
    // keeps its wrap={false} totals block on page 1 instead of spilling a
    // near-empty page. Going much lower risks content touching the page number.
    paddingTop: 0,
    paddingBottom: 80,
    paddingHorizontal: 0,
    fontSize: sizes.fontBase,
    color: colors.text,
    fontFamily: 'Lato',
    fontWeight: 400,
    // NOTE: lineHeight intentionally lives on `content`/`contentLean` (the body
    // text containers), NOT here. A page-level lineHeight is inherited by the
    // `fixed`+`render` page-number Text and makes its empty-at-layout box
    // stretch to the full page height, which suppresses the paint-time text
    // entirely. Keeping it off the Page is what lets "Page X/Y" actually render.
    flexDirection: 'column',
  },

  // ── Yellow header band ──────────────────────────────
  header: {
    backgroundColor: colors.gold,
    paddingHorizontal: 36,
    paddingTop: 14,
    paddingBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  logo: {
    width: 160,
    height: 50,
    objectFit: 'contain',
  },
  // Document title block sits in the top-right of the yellow header band.
  // White text on the gold background. Each line is wrapped in its own View
  // so @react-pdf stacks them cleanly — flex-stacking Text children with very
  // different font sizes causes them to overlap into the same Y-line.
  headerDocBlock: {
    flexDirection: 'column',
    alignItems: 'flex-end',
    width: 280,
  },
  headerDocTypeRow: {
    width: '100%',
  },
  headerDocType: {
    width: '100%',
    textAlign: 'right',
    fontSize: 18,
    fontWeight: 900,
    color: colors.white,
    letterSpacing: 1.2,
    lineHeight: 1.15,
  },
  headerDocRefRow: {
    width: '100%',
    marginTop: 4,
  },
  headerDocRef: {
    width: '100%',
    textAlign: 'right',
    fontSize: 16,
    fontWeight: 900,
    color: colors.white,
    letterSpacing: 0.6,
  },
  headerDocDateRow: {
    width: '100%',
    marginTop: 4,
  },
  headerDocDate: {
    width: '100%',
    textAlign: 'right',
    fontSize: sizes.fontSm,
    color: colors.white,
  },


  // Thin dark blue bar at the bottom of the yellow header band
  topDarkBar: {
    height: 1.5,
    backgroundColor: colors.primaryDark,
  },
  // Absolute wrapper used when the header is repeated (fixed) on a
  // continuation page — pins the branded band to the top edge of every
  // physical page. Flow content clears it via the Page's paddingTop
  // (HEADER_HEIGHT), exactly mirroring how the footer reserves space via
  // paddingBottom.
  headerFixedWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },

  // ── Content area ────────────────────────────────────
  content: {
    paddingHorizontal: 36,
    paddingTop: 20,
    flexGrow: 1,
    flexDirection: 'column',
    lineHeight: 1.45,
  },
  // Variant used by the optional secondPage: same horizontal gutters but
  // no top padding — the Page-level paddingTop already provides the top
  // margin (and applies on every physical overflow page).
  contentLean: {
    paddingHorizontal: 36,
    paddingTop: 0,
    flexGrow: 1,
    flexDirection: 'column',
    lineHeight: 1.45,
  },


  // ── Top row: two card slots side-by-side ────────────
  topRow: {
    flexDirection: 'row',
    gap: 14,
    marginBottom: 32,
    alignItems: 'stretch',
  },
  topRowSlot: {
    flex: 1,
    flexDirection: 'column',
  },

  // Reusable card frame — cream bg, gold left edge, thin border on all
  // sides, rounded corners. Used by AddressCard and MetadataCard.
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
  // Applied when the card sits inside a flex row that needs equal heights —
  // the card grows to fill the slot's available space.
  cardStretch: {
    flexGrow: 1,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  cardTitle: {
    fontSize: sizes.fontXs,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.5,
    // lineHeight 1 so the text box hugs the glyphs — the inherited body
    // lineHeight adds leading that pushes the label down relative to the
    // center-aligned icon sitting next to it.
    lineHeight: 1,
  },
  cardName: {
    fontSize: sizes.fontBase,
    fontWeight: 900,
    color: colors.text,
    marginBottom: 1,
    lineHeight: 1.3,
  },
  cardLine: {
    fontSize: sizes.fontBase,
    color: colors.text,
    lineHeight: 1.3,
  },

  // Metadata card rows: icon · label · value, vertically stacked.
  // Explicit tight lineHeight — the rows would otherwise inherit the body's
  // 1.45 and make the top cards needlessly tall.
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 1.5,
  },
  metaIconBox: {
    width: 14,
    height: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metaLabel: {
    fontSize: sizes.fontBase,
    color: colors.muted,
    fontWeight: 700,
    flex: 1,
    lineHeight: 1.25,
  },
  metaValue: {
    fontSize: sizes.fontBase,
    color: colors.text,
    fontWeight: 700,
    textAlign: 'right',
    lineHeight: 1.25,
  },
  // ── Footer ──────────────────────────────────────────
  // Full-width gray band at the bottom of every page. A thin tricolore strip
  // sits at the very top of the band, with a transparent middle so the gray
  // footer background shows through as the "white" of the French flag.
  // `fixed` so it appears on every page of a multi-page document.
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.bgMuted,
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  footerStripe: {
    flexDirection: 'row',
    height: 3,
  },
  footerStripeBlue: {
    flex: 1,
    backgroundColor: colors.flagBlue,
  },
  footerStripeMiddle: {
    flex: 1,
    backgroundColor: colors.bgFlagWhite,
  },
  footerStripeRed: {
    flex: 1,
    backgroundColor: colors.flagRed,
  },
  footerInner: {
    paddingHorizontal: 36,
    paddingTop: 8,
    paddingBottom: 10,
    alignItems: 'center',
  },
  footerCompany: {
    fontSize: 8,
    color: colors.text,
    fontWeight: 900,
    textAlign: 'center',
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  footerLine: {
    fontSize: 7,
    color: colors.text,
    textAlign: 'center',
    lineHeight: 1.4,
  },
  footerContact: {
    fontSize: 7,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 1.4,
  },
  footerLegal: {
    fontSize: 6.5,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 1.4,
    marginTop: 3,
  },
  footerJurisdiction: {
    fontSize: 6.5,
    color: colors.subtle,
    textAlign: 'center',
    letterSpacing: 0.3,
    marginTop: 1,
  },

  // Page X/Y indicator — sits in the bottom-right corner, just above the
  // fixed footer band (which is ~66pt tall; this clears it at bottom 72).
  pageNumber: {
    position: 'absolute',
    bottom: 72,
    // Span the full content width and right-align the glyphs to the 36pt
    // gutter (an absolute Text with only `right` and no width collapses).
    left: 36,
    right: 36,
    textAlign: 'right',
    fontSize: 8,
    color: colors.muted,
    fontWeight: 700,
  },
})

// Page-level paddingTop reserving the branded header band + dark bar. The
// band's real height is driven by the right-side title block (~85pt after
// the 2026-07 tightening); 96 keeps a safety gap so repeated fixed table
// headers on continuation pages can never paint into the band.
const HEADER_HEIGHT = 96

// Page-level paddingTop for a `withHeader` continuation page: the header band
// height plus a breathing gap, so flow content (and especially the first row
// of a repeated table on an overflow page) doesn't butt right against the
// branded band. Applies to every physical page the continuation Page spans.
const HEADER_PAGE_PADDING_TOP = HEADER_HEIGHT + 10

// ── Types ────────────────────────────────────────────────

export interface AddressBlockData {
  /** Section heading e.g. "Fournisseur", "Adresse de Livraison" */
  title: string
  /** Strong first line — usually the company name */
  name: string
  /** Address lines below the name */
  lines: string[]
  /** Optional icon for the card title */
  icon?: IconKind
}

export interface MetadataCardData {
  /** Section heading e.g. "Conditions" */
  title: string
  /** Rows: { icon, label, value } */
  items: Array<{
    icon: IconKind
    label: string
    value: string
  }>
}

export interface MalterreDocumentProps {
  /** Title-cased doc type rendered in the body, e.g. "Bon de commande" */
  documentType: string
  /** Reference label, e.g. "BC-672" */
  reference: string
  /** Free-text date (long form, e.g. "14 Avril 2026") */
  documentDate: string
  /** Top-left card — typically the supplier or client address. Optional:
   *  when both topLeftAddress and topRightInfo are omitted, the stock
   *  2-card top row is skipped and `children` gets the full content area. */
  topLeftAddress?: AddressBlockData
  /** Top-right card — metadata icon list (paiement, échéance, etc.) */
  topRightInfo?: MetadataCardData
  /** PDF document title (browser tab) */
  title?: string
  /** Page orientation — defaults to portrait. Landscape is used by wide
   *  grid documents (e.g. the atelier weekly planning). */
  orientation?: 'portrait' | 'landscape'
  /** Override the gap between the yellow header band and the first body
   *  section (default `styles.content.paddingTop` = 20). Opt-in per document:
   *  the fiche technique tightens it to reclaim bottom-of-page space for its
   *  wrap={false} closing block. Only ever reduces a document's own top gap —
   *  leave it unset to keep the shared spacing. */
  contentPaddingTop?: number
  /** Body sections — table, totals, etc. */
  children: React.ReactNode
  /** Optional second logical <Page> appended after the primary one. Has no
   *  yellow header band (the body uses its own section title), but inherits
   *  the same fixed footer chrome. Its `paddingTop` is applied at the Page
   *  level so every physical overflow page that the second-page content
   *  spans gets the same top margin — gives wrapped tables breathing room
   *  on continuation pages. */
  secondPage?: {
    paddingTop?: number
    /** When true, repeat the branded yellow header band (logo + doc title)
     *  at the top of the second page and every physical overflow page it
     *  spans. The header is rendered `fixed`+absolute and the Page's
     *  paddingTop is forced to HEADER_HEIGHT so flow content clears it. */
    withHeader?: boolean
    children: React.ReactNode
  }
  /** Legal entity issuing the document — drives the footer block (SIRET / TVA /
   *  capital) and the PDF author. Defaults to ETS Malterre; pass `companyTrm`
   *  for documents Tricotage Malterre signs (its avis d'expédition). The logo
   *  is NOT switched here: there is only one artwork file today (see the TRM
   *  repo's CLAUDE.md — `logo-*.png` are still ETM placeholders). */
  issuer?: CompanyInfo
}

// ── Reusable card components (exported) ────────────────
// Both accept an optional `stretch` prop that applies `flex: 1` so the card
// fills its parent flex slot (used in the top row to equalize card heights).

export function AddressCard({ data, stretch }: { data: AddressBlockData; stretch?: boolean }) {
  return (
    <View style={stretch ? [styles.card, styles.cardStretch] : styles.card}>
      <View style={styles.cardHeader}>
        {data.icon ? <ResolveIcon kind={data.icon} /> : null}
        <Text style={styles.cardTitle}>{data.title.toUpperCase()}</Text>
      </View>
      {data.name ? <Text style={styles.cardName}>{data.name}</Text> : null}
      {data.lines.map((l, i) => (
        <Text key={i} style={styles.cardLine}>{l}</Text>
      ))}
    </View>
  )
}

export function MetadataCard({ data, stretch }: { data: MetadataCardData; stretch?: boolean }) {
  return (
    <View style={stretch ? [styles.card, styles.cardStretch] : styles.card}>
      {data.items.map((item, i) => (
        <View key={i} style={styles.metaRow}>
          <View style={styles.metaIconBox}>
            <ResolveIcon kind={item.icon} />
          </View>
          <Text style={styles.metaLabel}>{item.label}</Text>
          <Text style={styles.metaValue}>{item.value}</Text>
        </View>
      ))}
    </View>
  )
}

// Branded yellow header band (logo + document title block) with the thin
// dark blue bar beneath it. Rendered in-flow on the primary page and, when
// `fixed`, repeated absolutely on every physical page of a continuation page.
function PageHeader({
  documentType,
  reference,
  documentDate,
  fixed = false,
}: {
  documentType: string
  reference: string
  documentDate: string
  fixed?: boolean
}) {
  return (
    <View style={fixed ? styles.headerFixedWrap : undefined} fixed={fixed}>
      <View style={styles.header}>
        <Image src={LOGO_BUFFER} style={styles.logo} />
        <View style={styles.headerDocBlock}>
          <View style={styles.headerDocTypeRow}>
            <Text style={styles.headerDocType}>{documentType.toUpperCase()}</Text>
          </View>
          <View style={styles.headerDocRefRow}>
            <Text style={styles.headerDocRef}>{reference}</Text>
          </View>
          {documentDate ? (
            <View style={styles.headerDocDateRow}>
              <Text style={styles.headerDocDate}>Date : {documentDate}</Text>
            </View>
          ) : null}
        </View>
      </View>
      {/* Thin dark blue bar separating the yellow header from the body */}
      <View style={styles.topDarkBar} />
    </View>
  )
}

// "Page X/Y" indicator, fixed to every physical page. Hidden on single-page
// documents so a lone "Page 1/1" doesn't clutter short docs.
function PageNumber() {
  return (
    <Text
      style={styles.pageNumber}
      fixed
      render={({ pageNumber, totalPages }) =>
        totalPages > 1 ? `Page ${pageNumber}/${totalPages}` : ''
      }
    />
  )
}

// Footer: gray band with thin tricolore strip at the very top. Wrapped
// as its own component so each <Page> in the Document can render its own
// copy (each Page needs its own `fixed` footer node to appear on every
// physical page within that logical page).
function PageFooter({ issuer }: { issuer: CompanyInfo }) {
  return (
    <View style={styles.footer} fixed>
      <View style={styles.footerStripe}>
        <View style={styles.footerStripeBlue} />
        <View style={styles.footerStripeMiddle} />
        <View style={styles.footerStripeRed} />
      </View>
      <View style={styles.footerInner}>
        <Text style={styles.footerLine}>
          {issuer.address1} - {issuer.zip} {issuer.city}
        </Text>
        <Text style={styles.footerContact}>
          Tél: {issuer.phone}   ·   Mail: {issuer.email}
        </Text>
        <Text style={styles.footerLegal}>
          SIRET: {issuer.siret} - Code NAF: {issuer.naf} - N° TVA: {issuer.vat} - Capital: {issuer.capital}
        </Text>
        <Text style={styles.footerJurisdiction}>{issuer.legalJurisdiction}</Text>
      </View>
    </View>
  )
}

// ── Component ────────────────────────────────────────────

export function MalterreDocument({
  documentType,
  reference,
  documentDate,
  topLeftAddress,
  topRightInfo,
  title,
  orientation = 'portrait',
  contentPaddingTop,
  children,
  secondPage,
  issuer = company,
}: MalterreDocumentProps) {
  return (
    <Document
      title={title ?? `${documentType} ${reference}`}
      author={issuer.legalName}
    >
      {/* paddingTop reserves the branded header's height so the now-`fixed`
          header (repeated on every physical overflow page) doesn't overlap the
          flow content. Matches HEADER_HEIGHT exactly so page-1 content keeps the
          same vertical position it had when the header was in-flow — no change
          to per-page capacity, just a header on the continuation pages too. */}
      <Page size="A4" orientation={orientation} style={[styles.page, { paddingTop: HEADER_HEIGHT }]}>
        {/* Yellow header band: logo on the left, document title in the
            top-right (on the gold background, in white text). `fixed` so it
            repeats at the top of every physical page this logical Page spans
            (e.g. when the line-items table overflows onto a second page). */}
        <PageHeader
          documentType={documentType}
          reference={reference}
          documentDate={documentDate}
          fixed
        />

        {/* Content body */}
        <View
          style={
            contentPaddingTop != null
              ? [styles.content, { paddingTop: contentPaddingTop }]
              : styles.content
          }
        >
          {/* Top row — stock 2-card layout (address + metadata). Rendered
              only when either card is supplied; otherwise the body gets
              the full content area (documents with a custom top layout
              render their own cards inside `children`). */}
          {(topLeftAddress || topRightInfo) && (
            <View style={styles.topRow}>
              <View style={styles.topRowSlot}>
                {topLeftAddress ? <AddressCard data={topLeftAddress} stretch /> : null}
              </View>
              <View style={styles.topRowSlot}>
                {topRightInfo ? <MetadataCard data={topRightInfo} stretch /> : null}
              </View>
            </View>
          )}

          {/* Body — specific document content (table + totals) */}
          {children}
        </View>

        <PageNumber />
        <PageFooter issuer={issuer} />
      </Page>

      {/* Optional second logical Page. When `withHeader`, the branded header
          band is repeated (fixed) at the top and the Page paddingTop is
          forced to HEADER_HEIGHT to reserve flow space below it; otherwise
          paddingTop gives overflow pages a clean white top margin. */}
      {secondPage && (
        <Page
          size="A4"
          orientation={orientation}
          style={[
            styles.page,
            {
              paddingTop: secondPage.withHeader
                ? HEADER_PAGE_PADDING_TOP
                : secondPage.paddingTop ?? 36,
            },
          ]}
        >
          {secondPage.withHeader && (
            <PageHeader
              documentType={documentType}
              reference={reference}
              documentDate={documentDate}
              fixed
            />
          )}
          <View style={styles.contentLean}>
            {secondPage.children}
          </View>
          <PageNumber />
          <PageFooter issuer={issuer} />
        </Page>
      )}
    </Document>
  )
}
