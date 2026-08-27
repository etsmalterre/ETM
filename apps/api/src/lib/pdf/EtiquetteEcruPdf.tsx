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
// pyramid) becomes the current Malterre wordmark, the values get a real
// hierarchy against their labels, and a déclassé roll now says so on the
// label — the legacy prints the same label for both choix, which is the one
// thing a roll's own tag really ought to carry.
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

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ASSETS = path.resolve(__dirname, '../../assets')
// The square M badge, not the wide wordmark (user decision, 2026-08-27): the
// left band of a 89 × 36 label is tall and narrow, so a 2.5:1 wordmark has to
// shrink to fit the width and then leaves the band half empty. The badge fills
// it, and it survives the Dymo's thermal screen far better — the wordmark's
// script strokes are the first thing to break up at that size.
const LOGO_BUFFER: Buffer = fs.readFileSync(path.join(ASSETS, 'logo-m-email.png'))

// ── Input shape ──────────────────────────────────────────

export interface EtiquetteEcruData {
  /** stock_ecru.numero — "<IDordre_fabrication>/<num_piece_OF>", e.g. "3417/71". */
  numero: string
  /** kg, as weighed at the poste. */
  poids: number
  /** machine.emplacement (falls back to machine.nom) — the boxed code, "3E". */
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

function fmtPoids(value: number): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  // The legacy's %5,2f — two decimals, French comma.
  return n.toFixed(2).replace('.', ',')
}

/** The legacy's "JJ/MM/AAAA HH:mm:SS". */
function fmtDate(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// ── Styles ───────────────────────────────────────────────
//
// Monochrome by construction apart from the logo block: a Dymo LabelWriter is
// a thermal printer, so anything that is not near-black prints as grey. Hence
// black rules and a solid black DÉCLASSÉ pill rather than the app's amber.

const styles = StyleSheet.create({
  page: {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    flexDirection: 'row',
    fontFamily: 'Helvetica',
    color: '#000000',
    paddingVertical: 4,
    paddingHorizontal: 5,
  },

  // Left column — brand above, métier below.
  //
  // ⚠️ INVARIANT: `logo.width` and `metierBox.width` must stay EQUAL, and the
  // band is those 50pt plus the 6pt gutter. Two marks stacked at different
  // widths read as two floating objects instead of one stamp — which is what
  // happened when the label was scaled up to fill the tag and the two were
  // grown independently (fixed 2026-08-27). Change one, change all three.
  band: {
    width: 56,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 6,
  },
  // Square badge. Width tied to metierBox — see the band invariant above.
  logo: {
    width: 50,
    height: 50,
  },
  // The legacy's boxed métier code, kept — it is what the operator matches
  // against the machine she is standing at. Height and font are what give:
  // the width is fixed by the band invariant above.
  metierBox: {
    width: 50,
    height: 40,
    borderWidth: 1.6,
    borderColor: '#000000',
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metier: {
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
    borderLeftColor: '#000000',
  },
  headline: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  tag: {
    fontSize: 8.5,
    color: '#444444',
    marginRight: 4,
    marginBottom: 1.5,
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
    borderBottomColor: '#000000',
    marginTop: 5,
    marginBottom: 4,
  },
  line: {
    fontSize: 11,
    lineHeight: 1.25,
  },
  date: {
    fontSize: 9.5,
    color: '#333333',
    lineHeight: 1.25,
  },

  // The last line carries the date on the left and, on a déclassé roll, the
  // DÉCLASSÉ pill on the right — the one corner of the tag nothing else uses.
  // It sat absolutely positioned top-right until the type was scaled up to
  // fill the label; at 22pt a nine-character numéro ("3417/1001") reaches into
  // that corner, so the pill would eventually have printed over it.
  footRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  declasseBox: {
    backgroundColor: '#000000',
    borderRadius: 2,
    paddingHorizontal: 5,
    paddingVertical: 2.5,
  },
  declasse: {
    color: '#FFFFFF',
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
        <Image src={LOGO_BUFFER} style={styles.logo} />
        <View style={styles.metierBox}>
          <Text style={styles.metier}>{(d.metier ?? '').trim()}</Text>
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.headline}>
          <Text style={styles.tag}>N°</Text>
          <Text style={styles.numero}>{(d.numero ?? '').trim()}</Text>
        </View>
        <View style={[styles.headline, { marginTop: 6 }]}>
          <Text style={styles.tag}>Poids</Text>
          <Text style={styles.poids}>{fmtPoids(d.poids)}</Text>
          <Text style={styles.unite}>Kg</Text>
        </View>
        <View style={styles.rule} />
        <Text style={styles.line}>Réf. {refLine}</Text>
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
