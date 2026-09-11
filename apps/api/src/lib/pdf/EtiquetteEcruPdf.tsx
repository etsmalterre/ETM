// Dymo "étiquette" label for a tombé-métier roll (stock_ecru), printed by the
// TRM visitage poste the moment a piece is validated — one label per roll the
// cut produced, which is why this renders a MULTI-PAGE document.
//
// ── Provenance ──────────────────────────────────────────
// The legacy prints this from the global procedure `ImprimeEtiquetteTM`
// (MPS project, collection `Utilitaire`). FI_Visitage.wdw and the .wdg are
// PCS-compressed, but the procedure's string literals survive in the WinDev
// compile cache — MPS\MPS.cpl\<user>\00000000\Utilitaire.AF726741.wdg.wcg —
// and they spell the whole label out:
//
//     TRM.jpg · Arial
//     ordre_fabrication → machine        (the boxed métier code)
//     "N° : "                            (the roll's numero)
//     "Poids : " %5,2f " Kg"
//     ref_ecru → colori_ecru → "Réf. : "
//     "Date : " "JJ/MM/AAAA HH:mm:SS"
//
// So the fields below are the legacy's, verbatim and in its order. What
// changed is the dress: `TRM.jpg` (the old "Tricotage Malterre S.A.R.L."
// pyramid) becomes the Malterre M, the values get a real hierarchy against
// their labels, and a déclassé roll now says so on the label — the legacy
// prints the same label for both choix, which is the one thing a roll's own
// tag really ought to carry.
//
// ⚠️ BLACK AND WHITE ONLY — by construction, and pinned by the test. A Dymo
// LabelWriter is a thermal printer: no colour, and anything not near-black
// comes out as grey dither. The first cut carried the gold M badge in the
// left band; it printed as a mottled grey square, and there will never be a
// colour label printer at the poste (user, 2026-09-11). The band is now a
// single "stamp": the script M in black above the métier code knocked out of
// a solid black cell, both inside one outlined frame — one object, the way a
// rubber stamp reads, and every mark on the tag is solid ink or bare paper.
// The same monochrome M already carries the brand on the ref_fini tag
// (EtiquetteRefFiniPdf), for the same reason.
//
// Page is the Dymo 99012 "Large Address" 89 × 36 mm, same as
// StockFiniLabelPdf / StockFilLabelPdf. Self-contained: built-in Helvetica
// (no Font.register) so a shop-floor print has no font-path dependency.

import React from 'react'
import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'

// 89 × 36 mm in PostScript points (1 mm = 2.834646 pt).
const PAGE_WIDTH = 89 * 2.834646 // ≈ 252.3
const PAGE_HEIGHT = 36 * 2.834646 // ≈ 102.05
const PAGE_PADDING_Y = 4

// ⚠️ The LabelWriter's head does NOT reach the end of the label. Measured off a
// printed tag (2026-08-27 — the DÉCLASSÉ pill came out sliced mid-word, "DÉCLASS"):
// the left edge prints exactly where the PDF puts it (so nothing is offset or
// scaled), but printing simply stops ~234 pt in, i.e. ~82,5 mm of the 89 mm label.
// The last ~6,5 mm are unprintable.
//
// So this is a SAFE AREA, not a margin: it is deliberately far larger than the 5 pt
// on the left, and everything flush-right (the rule, the DÉCLASSÉ pill) aligns on
// it. On the physical tag the result reads centred, because it is centred in the
// PRINTABLE band. Do not "balance" it back against the left padding.
//
// The sister labels (StockFiniLabelPdf / StockFilLabelPdf) never hit this because
// every line they print is left-aligned — their paddingRight: 8 is not a precedent.
const SAFE_RIGHT = 26

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ASSETS = path.resolve(__dirname, '../../assets')
// The script M alone, black on transparent — derived from the gold badge
// (logo-m-email.png: every non-gold pixel → ink, trimmed, squared). Shared
// with EtiquetteRefFiniPdf. Not the badge itself: gold prints as dither, and a
// black badge with the M knocked out was tried (2026-09-11) — a heavy block
// that fought the DÉCLASSÉ pill, with the tricolour ribbon left as an odd
// white notch.
const LOGO_MONO_BUFFER: Buffer = fs.readFileSync(path.join(ASSETS, 'logo-m-mono.png'))

// The two colours this tag is allowed to use — see the header. `INK` for type,
// rules, the frame and the two solid cells; `PAPER` only for what is knocked
// out of them. The test walks the stylesheet and fails on anything else.
export const INK = '#000000'
export const PAPER = '#FFFFFF'

// ── Input shape ──────────────────────────────────────────

export interface EtiquetteEcruData {
  /** stock_ecru.numero — "<IDordre_fabrication>/<num_piece_OF>", e.g. "3417/71". */
  numero: string
  /** kg, as weighed at the poste. */
  poids: number
  /** machine.emplacement (falls back to machine.nom) — the stamped code, "3E". */
  metier: string
  /** ref_ecru.reference, e.g. "029". */
  ref: string
  /** colori_ecru.reference, e.g. "ecru". */
  coloris: string
  /** stock_ecru.date_saisie, epoch ms. Null prints an empty date line. */
  date_ms: number | null
  /** 1 → the DÉCLASSÉ marker. */
  second_choix: 0 | 1
}

export function fmtPoids(value: number): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  // The legacy's %5,2f — two decimals, French comma.
  return n.toFixed(2).replace('.', ',')
}

/** The legacy's "JJ/MM/AAAA HH:mm:SS". */
export function fmtDate(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// ── Styles ───────────────────────────────────────────────
//
// Hierarchy is carried by size, weight and letter-spacing alone — there is no
// grey to lean on. The small labels (N° · POIDS · RÉF.) are light, tracked
// capitals beside their bold values: the legacy's "N° : " made typographic.

// The stamp: the band is 56 pt (50 of frame + 6 of gutter). Its height is the
// page's inner height, so the frame runs the full depth of the body beside it.
const STAMP_WIDTH = 50
const STAMP_BORDER = 1.6
const STAMP_RADIUS = 4
const METIER_CELL_HEIGHT = 40

export const styles = StyleSheet.create({
  page: {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    flexDirection: 'row',
    fontFamily: 'Helvetica',
    color: INK,
    paddingVertical: PAGE_PADDING_Y,
    paddingLeft: 5,
    paddingRight: SAFE_RIGHT,
  },

  // Left band — the stamp.
  band: {
    width: STAMP_WIDTH + 6,
    paddingRight: 6,
  },
  // One outlined frame holding both cells. `overflow: 'hidden'` clips the
  // black cell to the frame's rounded corners; the cell's own bottom radius is
  // the frame's inner radius (outer − border), so the two agree even where a
  // renderer ignores the clip.
  stamp: {
    width: STAMP_WIDTH,
    height: PAGE_HEIGHT - 2 * PAGE_PADDING_Y,
    borderWidth: STAMP_BORDER,
    borderColor: INK,
    borderRadius: STAMP_RADIUS,
    flexDirection: 'column',
    overflow: 'hidden',
  },
  // Top cell — the brand, ink on paper.
  brandCell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 33,
    height: 33,
  },
  // Bottom cell — the legacy's boxed métier code, kept as the thing the
  // operator matches against the machine she is standing at, now knocked out
  // of solid ink so it reads from across the atelier.
  metierCell: {
    height: METIER_CELL_HEIGHT,
    backgroundColor: INK,
    borderBottomLeftRadius: STAMP_RADIUS - STAMP_BORDER,
    borderBottomRightRadius: STAMP_RADIUS - STAMP_BORDER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metier: {
    color: PAPER,
    fontFamily: 'Helvetica-Bold',
    fontSize: 21,
    letterSpacing: 0.5,
  },

  // Right column — the four legacy lines, given a hierarchy.
  body: {
    flex: 1,
    flexDirection: 'column',
    justifyContent: 'center',
    paddingLeft: 7,
    borderLeftWidth: 0.8,
    borderLeftColor: INK,
  },
  headline: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  tag: {
    fontSize: 7.5,
    letterSpacing: 0.6,
    marginRight: 4,
    marginBottom: 2,
  },
  numero: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 22,
    lineHeight: 1,
  },
  poids: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 18,
    lineHeight: 1,
  },
  unite: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
    marginLeft: 2,
    marginBottom: 1,
  },
  rule: {
    borderBottomWidth: 0.7,
    borderBottomColor: INK,
    marginTop: 5,
    marginBottom: 4,
  },
  refTag: {
    fontSize: 7.5,
    letterSpacing: 0.6,
    marginRight: 4,
    marginBottom: 1.5,
  },
  ref: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 11.5,
    lineHeight: 1,
  },
  date: {
    fontSize: 9,
    lineHeight: 1.25,
  },

  // The last line carries the date on the left and, on a déclassé roll, the
  // DÉCLASSÉ pill on the right — the one corner of the tag nothing else uses.
  // It sat absolutely positioned top-right until the type was scaled up to
  // fill the label; at 22pt a nine-character numéro ("3417/1001") reaches into
  // that corner, so the pill would eventually have printed over it.
  //
  // "Right" here means the SAFE_RIGHT edge, not the page edge — see the constant.
  footRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 3,
  },
  declasseBox: {
    backgroundColor: INK,
    borderRadius: 2,
    paddingHorizontal: 5,
    paddingVertical: 2.5,
  },
  declasse: {
    color: PAPER,
    fontFamily: 'Helvetica-Bold',
    fontSize: 8,
    letterSpacing: 0.6,
    lineHeight: 1,
  },
})

// ── Component ─────────────────────────────────────────────

function Etiquette({ d }: { d: EtiquetteEcruData }): React.ReactElement {
  const refLine = [d.ref, d.coloris].map((s) => (s ?? '').trim()).filter(Boolean).join(' · ')
  return (
    <Page size={[PAGE_WIDTH, PAGE_HEIGHT]} style={styles.page}>
      <View style={styles.band}>
        <View style={styles.stamp}>
          <View style={styles.brandCell}>
            <Image src={LOGO_MONO_BUFFER} style={styles.logo} />
          </View>
          <View style={styles.metierCell}>
            <Text style={styles.metier}>{(d.metier ?? '').trim()}</Text>
          </View>
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.headline}>
          <Text style={styles.tag}>N°</Text>
          <Text style={styles.numero}>{(d.numero ?? '').trim()}</Text>
        </View>
        <View style={[styles.headline, { marginTop: 6 }]}>
          <Text style={styles.tag}>POIDS</Text>
          <Text style={styles.poids}>{fmtPoids(d.poids)}</Text>
          <Text style={styles.unite}>Kg</Text>
        </View>
        <View style={styles.rule} />
        <View style={styles.headline}>
          <Text style={styles.refTag}>RÉF.</Text>
          <Text style={styles.ref}>{refLine}</Text>
        </View>
        <View style={styles.footRow}>
          <Text style={styles.date}>{fmtDate(d.date_ms)}</Text>
          {d.second_choix === 1 && (
            <View style={styles.declasseBox}>
              <Text style={styles.declasse}>DÉCLASSÉ</Text>
            </View>
          )}
        </View>
      </View>
    </Page>
  )
}

/** One page per roll — a cut piece yields several labels in a single print job,
 *  which is what the Dymo needs to spool them back to back. */
export function EtiquetteEcruPdf({ data }: { data: EtiquetteEcruData[] }): React.ReactElement {
  return (
    <Document>
      {data.map((d, i) => (
        <Etiquette key={`${d.numero}-${i}`} d={d} />
      ))}
    </Document>
  )
}
