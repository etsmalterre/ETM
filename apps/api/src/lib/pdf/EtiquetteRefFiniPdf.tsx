// Dymo "étiquette" for a finished-fabric REFERENCE (ref_fini) — the tag that
// travels with a fabric sample to a customer. Client-facing, unlike the three
// stock labels (StockFini / StockFil / EtiquetteEcru), which are internal.
//
// ── Provenance ──────────────────────────────────────────
// Legacy: FI_Ref_Fini.wdw → « Clic sur IMG_Etiquette » (the étiquette button in
// the fiche's sub-menu). The window is PCS-compressed, but the handler's string
// literals survive in the WinDev compile cache —
// MPS\MPS.cpl\<user>\00000000\FI_Ref_Fini.DAA510D5.wdw.wcw — and spell it out:
//
//     "Voulez-vous imprimer avec le QRCode ?"      (a Oui/Non prompt)
//     Arial
//     "Réf. : "  SAI_Reference
//                SAI_Designation
//     "Laize : " SAI_LaizeHT_Moy
//     "Poids/m² : " SAI_PoidsMoy
//     lavage30.png / lavage40.png                  (picked on ref_fini.temp_lavage)
//     picto2.png picto3.png picto4.png picto5.png  (no bleach · no tumble dry ·
//                                                   iron · dry clean P)
//     "http://etsmalterre.fr/echantillon/?ID=%1"   (the QR payload, %1 = IDref_fini)
//     "L'impression a été effectuée"
//
// So the fields are the legacy's, verbatim: reference, designation, laize HT
// moyenne, poids moyen, the five care symbols, and a QR code to the sample
// page on etsmalterre.fr. The pictos were the legacy's PNGs; here they are
// the same vector symbols as the fiche technique (`care-symbols.tsx`), and
// the QR is drawn as vector too (`QrCode.tsx`) — both pixel-exact on the
// Dymo's thermal head. The legacy's « avec le QRCode ? » prompt is gone: the
// tag ALWAYS carries the QR and prints one at a time (user decision
// 2026-09-08 — no options dialog between the menu row and the printer). The
// QR's caption is « TARIFS » (the sample page is where the customer gets the
// prices).
//
// ⚠️ BLACK AND WHITE ONLY. A Dymo LabelWriter is a thermal printer: no colour,
// and anything not near-black comes out as grey dither. The first cut had the
// gold M badge in a left band; it cannot print (user, 2026-09-08). The brand
// is now the monochrome M in the centre of the QR code — which is what freed
// the width for the larger type.
//
// Page is the Dymo 99012 "Large Address" 89 × 36 mm like its siblings.
// Self-contained: built-in Helvetica (no Font.register).

import React from 'react'
import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'
import { QrCode } from './QrCode.js'
import { WashSymbol, NoBleachSymbol, NoTumbleDrySymbol, IronSymbol, DryCleanPSymbol } from './care-symbols.js'

// 89 × 36 mm in PostScript points (1 mm = 2.834646 pt).
const PAGE_WIDTH = 89 * 2.834646 // ≈ 252.3
const PAGE_HEIGHT = 36 * 2.834646 // ≈ 102.05

// ⚠️ The LabelWriter's head does NOT reach the end of the label: printing stops
// ~234 pt in (~82,5 mm of the 89), measured on the écru tag (2026-08-27, see
// EtiquetteEcruPdf). The left edge prints exactly where the PDF puts it.
const PRINT_LIMIT = 234
//
// Centring (user, 2026-09-08 — the first print read shifted left). The écru
// tag pads 5 pt left and 26 pt right and calls that "centred in the printable
// band"; on this client-facing tag the customer sees the whole 89 mm, so the
// block is centred on the PHYSICAL label instead: equal padding on both sides,
// and the content narrowed to 210 pt so that its right edge — the QR code, the
// one thing that must never be clipped — still stops ~3 pt short of the head
// limit. Both constraints are pinned by the test; grow CONTENT_WIDTH only
// against PRINT_LIMIT.
const CONTENT_WIDTH = 210
const PAGE_PADDING_X = (PAGE_WIDTH - CONTENT_WIDTH) / 2 // ≈ 21.1 — both sides
export const LAYOUT = { PAGE_WIDTH, PRINT_LIMIT, CONTENT_WIDTH, PAGE_PADDING_X }

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ASSETS = path.resolve(__dirname, '../../assets')
// The script M alone, black on white — derived from the gold badge
// (logo-m-email.png: every non-gold pixel → ink, trimmed, squared). Goes in
// the centre of the QR, which is drawn at level H so the overlay is paid for.
const LOGO_MONO_BUFFER: Buffer = fs.readFileSync(path.join(ASSETS, 'logo-m-mono.png'))

/** The legacy QR payload, https'd. The site 302s it to the live
 *  /client/echantillon/ page, and it is the URL already printed on every tag
 *  in customers' hands — keep it, do not "shorten" to the current path. */
export function echantillonUrl(idRefFini: number): string {
  return `https://etsmalterre.fr/echantillon/?ID=${idRefFini}`
}

// ── Input shape ──────────────────────────────────────────

export interface EtiquetteRefFiniData {
  IDref_fini: number
  /** ref_fini.reference, e.g. "001A". */
  reference: string
  /** ref_fini.designation — "Molleton coton non gratté". Up to ~50 chars. */
  designation: string | null
  /** ref_fini.laizeHT_Moy, cm. */
  laizeHT: number | null
  /** ref_fini.poids_Moy, g/m². */
  poids: number | null
  /** ref_fini.temp_lavage, °C. Null / 0 falls back to 30 like the fiche technique. */
  tempLavage: number | null
}

/** Clamp the designation to what two 8 pt lines hold beside the QR
 *  (≈ 30 chars a line over 121 pt — Helvetica averages ~0.5 em a glyph).
 *  react-pdf 4.4 has no maxLines, and a third line would push the care
 *  symbols off the 36 mm page at the type sizes below; cut on a word boundary
 *  with an ellipsis instead. The longest designation in the catalog (50
 *  chars) fits untouched. */
export function clampDesignation(text: string): string {
  const budget = 60
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= budget) return t
  const cut = t.slice(0, budget - 1)
  const atWord = cut.lastIndexOf(' ')
  return (atWord > budget * 0.6 ? cut.slice(0, atWord) : cut).trimEnd() + '…'
}

/** French integer-or-2dp: 150 → "150", 182.5 → "182,5". Blank for null. */
function fmtNum(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return ''
  const v = Math.round(n * 100) / 100
  return String(v).replace('.', ',')
}

// ── Styles ───────────────────────────────────────────────
//
// Black and white by construction (see the header): solid black type, rules,
// symbols and QR; the only "grey" is the two small labels, and even those stay
// dark (#333) so they print as text, not fog. Two columns inside the centred
// 210 pt block — the text takes 126 pt, the QR the remaining 78 + 6 gutter.
//
// Vertical budget: 102 pt page − 2 × 3 pt padding = 96 pt. Réf 22 + designation
// 2 × 9 + 2.5 + rule 7.8 + specs 20.5 + care 20 ≈ 91 at a two-line designation,
// which the clamp above makes the worst case. Grow a size only against that
// sum — a third designation line would already overflow. The body carries
// 3 pt of bottom padding on top of that: the 22 pt réf line box has ~5 pt of
// air above the capitals while the care row ends on ink, so a mathematically
// centred stack read ~3 pt low on the render.

const SYM = 17
const QR_SIZE = 78
// Centre overlay: a white box of ~28 % of the QR side (≈ 8 % of the modules,
// paid for by level H's 30 % recovery), the M drawn at ~21 %.
const QR_LOGO_BOX = 22
const QR_LOGO = 16

const styles = StyleSheet.create({
  page: {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    flexDirection: 'row',
    fontFamily: 'Helvetica',
    color: '#000000',
    paddingVertical: 3,
    paddingHorizontal: PAGE_PADDING_X,
  },

  // Left column — the legacy's four lines, given a hierarchy.
  body: {
    flex: 1,
    flexDirection: 'column',
    justifyContent: 'center',
    paddingRight: 5,
    paddingBottom: 3,
  },
  headline: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  tag: {
    fontSize: 9,
    color: '#333333',
    marginRight: 5,
    marginBottom: 2,
    lineHeight: 1,
  },
  reference: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 22,
    lineHeight: 1,
  },
  designation: {
    fontSize: 8,
    lineHeight: 1.12,
    marginTop: 2.5,
  },
  rule: {
    borderBottomWidth: 0.8,
    borderBottomColor: '#000000',
    marginTop: 4,
    marginBottom: 3,
  },
  specs: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  spec: {
    flexDirection: 'column',
    marginRight: 16,
  },
  specLabel: {
    fontSize: 6,
    color: '#333333',
    letterSpacing: 0.6,
    lineHeight: 1,
    marginBottom: 1.5,
  },
  specValueRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  specValue: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 13,
    lineHeight: 1,
  },
  specUnit: {
    fontSize: 8,
    lineHeight: 1,
    marginLeft: 2,
    marginBottom: 0.5,
  },
  care: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 3,
    marginLeft: -1.5, // the symbols' viewBox has ~1.5pt of air on the left
  },
  careGap: {
    width: 4,
  },

  // Right column — the QR code with the M in its centre, its right edge on
  // the content block's (≈ 3 pt inside the head limit), and a one-word caption
  // so the customer knows what scanning it gets them.
  qrCol: {
    width: QR_SIZE,
    marginLeft: 6,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 2.5, // same optical lift as the body: the caption's box has air below its caps
  },
  qrWrap: {
    width: QR_SIZE,
    height: QR_SIZE,
    position: 'relative',
  },
  qrLogoBox: {
    position: 'absolute',
    left: (QR_SIZE - QR_LOGO_BOX) / 2,
    top: (QR_SIZE - QR_LOGO_BOX) / 2,
    width: QR_LOGO_BOX,
    height: QR_LOGO_BOX,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrLogo: {
    width: QR_LOGO,
    height: QR_LOGO,
  },
  qrCaption: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 6.5,
    letterSpacing: 0.8,
    marginTop: 2.5,
    lineHeight: 1,
  },
})

// ── Component ─────────────────────────────────────────────

function Spec({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <View style={styles.spec}>
      <Text style={styles.specLabel}>{label}</Text>
      <View style={styles.specValueRow}>
        <Text style={styles.specValue}>{value || '—'}</Text>
        {value ? <Text style={styles.specUnit}>{unit}</Text> : null}
      </View>
    </View>
  )
}

function Etiquette({ d }: { d: EtiquetteRefFiniData }): React.ReactElement {
  const designation = clampDesignation(d.designation ?? '')
  const temp = d.tempLavage != null && d.tempLavage > 0 ? d.tempLavage : 30
  const sym = { size: SYM, stroke: '#000000', sw: 1.6, fontFamily: 'Helvetica-Bold', glyphScale: 1.4 }
  return (
    <Page size={[PAGE_WIDTH, PAGE_HEIGHT]} style={styles.page}>
      <View style={styles.body}>
        <View style={styles.headline}>
          <Text style={styles.tag}>Réf.</Text>
          <Text style={styles.reference}>{(d.reference ?? '').trim()}</Text>
        </View>
        {designation ? <Text style={styles.designation}>{designation}</Text> : null}
        <View style={styles.rule} />
        <View style={styles.specs}>
          <Spec label="LAIZE" value={fmtNum(d.laizeHT)} unit="cm" />
          <Spec label="POIDS" value={fmtNum(d.poids)} unit="g/m²" />
        </View>
        <View style={styles.care}>
          <WashSymbol temp={temp} {...sym} />
          <View style={styles.careGap} />
          <NoBleachSymbol {...sym} />
          <View style={styles.careGap} />
          <NoTumbleDrySymbol {...sym} />
          <View style={styles.careGap} />
          <IronSymbol {...sym} />
          <View style={styles.careGap} />
          <DryCleanPSymbol {...sym} />
        </View>
      </View>

      <View style={styles.qrCol}>
        <View style={styles.qrWrap}>
          <QrCode value={echantillonUrl(d.IDref_fini)} size={QR_SIZE} quietZone={1} level="H" />
          <View style={styles.qrLogoBox}>
            <Image src={LOGO_MONO_BUFFER} style={styles.qrLogo} />
          </View>
        </View>
        <Text style={styles.qrCaption}>TARIFS</Text>
      </View>
    </Page>
  )
}

/** One tag per print. */
export function EtiquetteRefFiniPdf({ data }: { data: EtiquetteRefFiniData }): React.ReactElement {
  return (
    <Document title={`Étiquette ${data.reference}`} author="ETS Malterre">
      <Etiquette d={data} />
    </Document>
  )
}
