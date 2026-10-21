// Dymo "étiquette" for a trial sample (Tombé Métier › Échantillons) — the tag
// stuck on the sample fabric. Same design as the ref_fini tag
// (EtiquetteRefFiniPdf), which it mirrors on purpose so the two tags read as
// one family: the number big on the left over its description, a rule, the
// figures that define the fabric in bold. Where the fini tag prints the care
// symbols, the sample prints its yarn composition. No QR code and no logo:
// the tag stays in the factory (Vincent, 2026-10-21), so the text takes the
// whole width. No legacy equivalent (the legacy printed an « OF échantillon »
// report).
//
// ⚠️ BLACK AND WHITE ONLY — a Dymo LabelWriter is a thermal printer: no
// colour, and anything not near-black comes out as grey dither. Ink #000,
// small labels #333.
//
// Page is the Dymo 99012 "Large Address" 89 × 36 mm. Centred on the physical
// label like the fini tag, content narrowed so its right edge stays
// inside the head limit (~234 pt) — pinned by the test (`LAYOUT`).
// Self-contained: built-in Helvetica.

import React from 'react'
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer'

const PAGE_WIDTH = 89 * 2.834646 // ≈ 252.3
const PAGE_HEIGHT = 36 * 2.834646 // ≈ 102.05
const PRINT_LIMIT = 234
const CONTENT_WIDTH = 210
const PAGE_PADDING_X = (PAGE_WIDTH - CONTENT_WIDTH) / 2 // ≈ 21.1 — both sides
export const LAYOUT = { PAGE_WIDTH, PRINT_LIMIT, CONTENT_WIDTH, PAGE_PADDING_X }


// ── Input shape ──────────────────────────────────────────

export interface EtiquetteEchantillonData {
  IDref_echantillon: number
  /** « E055 ». */
  numero: string
  contexture: string | null
  /** Display labels: « 28 », « 30" »; null when not set. */
  jauge: string | null
  diametre: string | null
  /** LFA per tour 1..4, 0 = not set. */
  lfa: number[]
  /** Yarns in percent, biggest share first. */
  composition: { pourcentage: number; fil: string }[]
}

/** French number, 2 dp max: 7.5 → « 7,5 ». */
function fr(n: number): string {
  return String(Math.round(n * 100) / 100).replace('.', ',')
}

/** The four LFA cells, tour 1 to 4, as the reference's « LFA / tour » tile
 *  writes them (« 7.50 », « — » for an empty tour) — a sample and the
 *  reference it becomes must read the same. */
export function lfaTours(lfa: number[]): string[] {
  return [0, 1, 2, 3].map((i) => ((lfa[i] ?? 0) > 0 ? lfa[i].toFixed(2) : '—'))
}

/** Up to 3 yarns (every sample so far: 27 × 1, 19 × 2, 6 × 3) one per row;
 *  more (a reference reaches 4) fold into two columns of 2 rows, smaller,
 *  names cut to one line — the bottom zone has room for 3 rows only. */
export const UNE_COLONNE_MAX = 3

/** The yarn rows: « 48 % » + the yarn's name, one per row, biggest share
 *  first, never clamped (a yarn name is at most 26 chars on the catalog —
 *  ~95 pt at 7.5 pt, well inside one row). */
export function compositionLignes(lignes: EtiquetteEchantillonData['composition']): { pct: string; fil: string }[] {
  // Two columns (4+ yarns) leave ~80 pt per name at 6.5 pt: about 22 chars.
  const max = lignes.length > UNE_COLONNE_MAX ? 22 : Infinity
  return lignes.map((l) => {
    const fil = l.fil.trim()
    return { pct: `${fr(l.pourcentage)} %`, fil: fil.length > max ? fil.slice(0, max - 1).trimEnd() + '…' : fil }
  })
}


// ── Styles ───────────────────────────────────────────────
//
// Three zones over the whole label (Vincent, 2026-10-21 — the first cut piled
// everything top-left, the LFA row ran off and the bottom stayed empty):
//
//   ┌─────────────────┬──────────────────────────┐
//   │ ÉCHANTILLON     │ JAUGE        Ø           │
//   │ E054            │ 18           30"         │
//   │ cote 1/1 vanisé │ LFA / TOUR               │
//   │                 │ [11.00][ — ][11.00][ — ] │
//   ├─────────────────┴──────────────────────────┤
//   │ COMPOSITION                                │
//   │  95 %  1/34 LYO/COT/CHA/PA                 │
//   │   5 %  44 ELASTHANNE                       │
//   └────────────────────────────────────────────┘
//
// Identity left, the knitting settings right behind a vertical rule, the
// yarns along the bottom. The LFA are four boxed cells, the screen's « LFA /
// tour » tile in ink; the yarns are a list, one per row (Vincent, 2026-10-21:
// the run-on line split names across lines). Vertical budget 102 − 2 × 4 =
// 94 pt: top block ≈ 51 (caption 7.5 + numéro 23 + contexture 2 × 8.5 | specs
// 20 + LFA 21.5) + rule 7.8 + caption 7.5 + 3 rows × 8.7 ≈ 92 at three yarns.

const LEFT = 84
const CELL_GAP = 3
const RIGHT = CONTENT_WIDTH - LEFT - 13 // after the vertical rule and its gutters
const CELL = (RIGHT - 3 * CELL_GAP) / 4

const styles = StyleSheet.create({
  page: {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    flexDirection: 'column',
    justifyContent: 'center',
    fontFamily: 'Helvetica',
    color: '#000000',
    paddingVertical: 4,
    paddingHorizontal: PAGE_PADDING_X,
  },
  top: { flexDirection: 'row', alignItems: 'stretch' },
  caption: { fontSize: 5.5, color: '#333333', letterSpacing: 0.8, lineHeight: 1, marginBottom: 2 },

  // Left: who it is
  ident: { width: LEFT, flexDirection: 'column', justifyContent: 'center' },
  numero: { fontFamily: 'Helvetica-Bold', fontSize: 23, lineHeight: 1 },
  contexture: { fontFamily: 'Helvetica-Bold', fontSize: 7.5, lineHeight: 1.12, marginTop: 3 },

  vrule: { width: 0.8, backgroundColor: '#000000', marginHorizontal: 6 },

  // Right: how it is knitted
  reglages: { width: RIGHT, flexDirection: 'column', justifyContent: 'space-between' },
  specs: { flexDirection: 'row' },
  spec: { flexDirection: 'column', width: RIGHT / 2 },
  specValue: { fontFamily: 'Helvetica-Bold', fontSize: 13, lineHeight: 1 },
  lfaRow: { flexDirection: 'row', justifyContent: 'space-between' },
  lfaCell: {
    width: CELL,
    height: 14,
    borderWidth: 0.8,
    borderColor: '#000000',
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lfaValue: { fontFamily: 'Helvetica-Bold', fontSize: 8.5, lineHeight: 1 },
  lfaEmpty: { fontSize: 8.5, lineHeight: 1, color: '#333333' },

  // Bottom: what it is made of
  hrule: { borderBottomWidth: 0.8, borderBottomColor: '#000000', marginTop: 4, marginBottom: 3 },
  // Yarns: a % column right-aligned in bold, then the name — one row each.
  fils: { flexDirection: 'row', flexWrap: 'wrap' },
  fil: { flexDirection: 'row', alignItems: 'baseline', width: '100%', marginBottom: 1.2 },
  filDemi: { flexDirection: 'row', alignItems: 'baseline', width: '50%', marginBottom: 1.2 },
  filPct: { width: 24, textAlign: 'right', fontFamily: 'Helvetica-Bold', fontSize: 7.5, lineHeight: 1 },
  filNom: { flex: 1, fontSize: 7.5, lineHeight: 1, marginLeft: 6 },
  filPctDemi: { width: 20, textAlign: 'right', fontFamily: 'Helvetica-Bold', fontSize: 6.5, lineHeight: 1 },
  filNomDemi: { flex: 1, fontSize: 6.5, lineHeight: 1, marginLeft: 4 },
  filVide: { fontSize: 7.5, lineHeight: 1, color: '#333333' },
})

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.spec}>
      <Text style={styles.caption}>{label}</Text>
      <Text style={styles.specValue}>{value || '—'}</Text>
    </View>
  )
}

function Etiquette({ d }: { d: EtiquetteEchantillonData }): React.ReactElement {
  const fils = compositionLignes(d.composition)
  const deux = fils.length > UNE_COLONNE_MAX
  return (
    <Page size={[PAGE_WIDTH, PAGE_HEIGHT]} style={styles.page}>
      <View style={styles.top}>
        <View style={styles.ident}>
          <Text style={styles.caption}>ÉCHANTILLON</Text>
          <Text style={styles.numero}>{d.numero}</Text>
          {d.contexture?.trim() ? <Text style={styles.contexture}>{d.contexture.trim()}</Text> : null}
        </View>
        <View style={styles.vrule} />
        <View style={styles.reglages}>
          <View style={styles.specs}>
            <Spec label="JAUGE" value={d.jauge ?? ''} />
            <Spec label="Ø" value={d.diametre ?? ''} />
          </View>
          <View>
            <Text style={styles.caption}>LFA / TOUR</Text>
            <View style={styles.lfaRow}>
              {lfaTours(d.lfa).map((v, i) => (
                <View key={i} style={styles.lfaCell}>
                  <Text style={v === '—' ? styles.lfaEmpty : styles.lfaValue}>{v}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>
      </View>
      <View style={styles.hrule} />
      <Text style={styles.caption}>COMPOSITION</Text>
      {fils.length === 0 ? (
        <Text style={styles.filVide}>—</Text>
      ) : (
        <View style={styles.fils}>
          {fils.map((f, i) => (
            <View key={i} style={deux ? styles.filDemi : styles.fil}>
              <Text style={deux ? styles.filPctDemi : styles.filPct}>{f.pct}</Text>
              <Text style={deux ? styles.filNomDemi : styles.filNom}>{f.fil}</Text>
            </View>
          ))}
        </View>
      )}
    </Page>
  )
}

/** One tag per print. */
export function EtiquetteEchantillonPdf({ data }: { data: EtiquetteEchantillonData }): React.ReactElement {
  return (
    <Document title={`Étiquette échantillon ${data.numero}`} author="ETS Malterre">
      <Etiquette d={data} />
    </Document>
  )
}
