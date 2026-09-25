// PDF document for the "Fiche Technique" of a finished-fabric reference
// (ref_fini). Content of the legacy WinDev ETAT_Fiche_technique — laize /
// poids min-moy-max (shown as average ± tolérance), finition lavé / teint
// (#1213), composition (matières from the écru's yarns), stabilité
// dimensionnelle, conditionnement, customs / provenance, care symbols,
// observations — in the layout Vincent chose on 2026-09-25 (see § Layout).
// The customs code, provenance and footnote are static in the legacy report
// (no DB field); only their wording was modernised (« Provenance UE »).

import React from 'react'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { View, Text, StyleSheet, Image } from '@react-pdf/renderer'
import { MalterreDocument } from './MalterreDocument.js'
import { WashSymbol, NoBleachSymbol, NoTumbleDrySymbol, IronSymbol, DryCleanPSymbol } from './care-symbols.js'
import { colors, sizes } from './theme.js'

// ── Asset loading ────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ASSETS = path.resolve(__dirname, '../../assets')

// STANDARD 100 by OEKO-TEX® certification mark — ETS Malterre's own certificate
// (CQ 1357/1, issued by IFTH). The official green-on-white variant from the
// OEKO-TEX press kit; the certificate number is baked into the artwork, so no
// caption is needed next to it. The PNG has no alpha channel (its background is
// opaque white), which is why it sits on the white page background rather than
// inside one of the cream `Section` cards.
const OEKOTEX_BUFFER: Buffer = fs.readFileSync(path.join(ASSETS, 'oekotex-standard100-cq1357.png'))

export interface MinMoyMax {
  min: number | null
  moy: number | null
  max: number | null
}

export interface FicheTechniquePdfData {
  reference: string
  designation: string | null
  contexture: string | null
  /** Client-facing finishing process from `ref_fini.avec_teinture`: 0 → wash
   *  only, 1/2 (simple/double) → dyed. The simple/double split is internal
   *  and deliberately not printed (#1213). */
  finition: 'Lavé' | 'Teint'
  laizeHT: MinMoyMax
  laizeUtile: MinMoyMax
  poids: MinMoyMax
  /** Aggregated matière composition, percentages in 0-100. */
  composition: Array<{ matiere: string; pourcentage: number }>
  stabHauteur: number | null
  stabLargeur: number | null
  allongementH: MinMoyMax
  allongementL: MinMoyMax
  conditionnement: string | null
  observations: string | null
  tempLavage: number | null
  dateCreation: string | null
  dateModification: string | null
}

// ── French number formatting ─────────────────────────────

function fmt(n: number | null, dp = 0): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const v = dp > 0 ? n.toFixed(dp) : String(Math.round(n * 100) / 100)
  return v.replace('.', ',')
}


const SYM = { size: 28, stroke: colors.primaryDark, sw: 1.3 }

// ── Layout ───────────────────────────────────────────────
// Chosen by Vincent on 2026-09-25 among six drafts (« B — bandeau gris »):
// title + key-figures band (the numbers a buyer looks for first, with their
// tolerance), then sections in two columns, each headed by a light grey band,
// rows split by dotted rules. Gold stays in the header band only — rules and
// bars in gold read as « a lot of yellow lines ». No charts, no cards.
//
// Headings are sentence case with no letter-spacing, on purpose: accented
// CAPITALS (« CARACTÉRISTIQUES ») came out of react-pdf + Lato without their
// accent, and letter-spacing pushes the accent of any é off its letter. The
// uppercase figure labels below are accent-free words — keep them that way.
//
// The closing block is wrap={false} at the end of the flow — anything that
// grows the body eats the slack before it spills onto a second page. ALWAYS
// re-run scripts/check-fiche-page-counts after touching the layout.

const RULE = colors.border
const NAVY = colors.primaryDark
/** Inset shared by the grey heading bands and the rows under them. */
const INSET = 7

const styles = StyleSheet.create({
  // Title block
  titleBlock: { paddingTop: 16, paddingBottom: 14 },
  kicker: { fontSize: sizes.fontMd, color: colors.muted, lineHeight: 1 },
  designation: { fontSize: 20, color: NAVY, fontWeight: 700, lineHeight: 1.15, marginTop: 5 },

  // Key figures band
  figures: {
    flexDirection: 'row',
    borderTopWidth: 1.5,
    borderTopColor: NAVY,
    borderTopStyle: 'solid',
    borderBottomWidth: 0.75,
    borderBottomColor: RULE,
    borderBottomStyle: 'solid',
    marginBottom: 20,
  },
  figure: { flex: 1, paddingVertical: 9, paddingHorizontal: 10 },
  figureDivider: { borderLeftWidth: 0.75, borderLeftColor: RULE, borderLeftStyle: 'solid' },
  figureLabel: { fontSize: sizes.fontXs, color: colors.muted, fontWeight: 700, letterSpacing: 0.8, lineHeight: 1 },
  figureValueRow: { flexDirection: 'row', alignItems: 'flex-end', marginTop: 6 },
  figureValue: { fontSize: 19, color: NAVY, fontWeight: 700, lineHeight: 1 },
  figureUnit: { fontSize: sizes.fontBase, color: colors.muted, marginLeft: 3, lineHeight: 1.4 },
  figureSub: { fontSize: sizes.fontSm, color: colors.muted, marginTop: 4, lineHeight: 1 },

  // Two-column grid
  grid: { flexDirection: 'row', gap: 24 },
  col: { flex: 1 },

  // Section: grey heading band + body
  section: { marginBottom: 16 },
  headingBand: { backgroundColor: colors.bgMuted, paddingVertical: 5, paddingHorizontal: INSET, marginBottom: 5 },
  heading: { fontSize: sizes.fontBase, color: NAVY, fontWeight: 700, lineHeight: 1 },

  // Label / value rows, dotted rule between them
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3,
    paddingHorizontal: INSET,
  },
  rowRule: { borderBottomWidth: 0.75, borderBottomColor: colors.borderStrong, borderBottomStyle: 'dotted' },
  rowLabel: { fontSize: sizes.fontBase, color: colors.muted, lineHeight: 1.2 },
  rowValue: { fontSize: sizes.fontBase, color: colors.text, fontWeight: 700, lineHeight: 1.2 },

  // Free text (conditionnement, observations)
  freeText: { fontSize: sizes.fontBase, color: colors.text, lineHeight: 1.5, paddingHorizontal: INSET },

  // Care symbols with captions
  careRow: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 4 },
  careItem: { flex: 1, alignItems: 'center' },
  careCaption: { fontSize: sizes.fontXs, color: colors.muted, textAlign: 'center', lineHeight: 1.3, marginTop: 4 },

  // Closing block: OEKO-TEX mark bottom-left, note + dates bottom-right,
  // pushed to the bottom of the content area by the auto top margin.
  bottomBlock: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: 24,
    marginTop: 'auto',
    paddingTop: 10,
    // Clears the « Page n/N » line MalterreDocument prints on multi-page docs.
    paddingBottom: 12,
  },
  // Near-square artwork (536×520). Opaque white background, so it must stay on
  // the white page — never on a tinted ground.
  oekotexMark: { width: 66, height: 64, flexShrink: 0 },
  closing: { flex: 1, alignItems: 'flex-end' },
  footNote: { fontSize: sizes.fontXs, color: colors.muted, lineHeight: 1.4, textAlign: 'right', maxWidth: 400 },
  dates: { fontSize: sizes.fontSm, color: colors.muted, marginTop: 6, lineHeight: 1 },
  datesStrong: { color: colors.text, fontWeight: 700 },
})

// ── Formatting ───────────────────────────────────────────

/** Percentage without trailing zeros: 94 → « 94 », 66.5 → « 66,5 ». */
function fmtPct(n: number): string {
  return String(Math.round(n * 10) / 10).replace('.', ',')
}

/** « −5 » with a real minus sign — a hyphen reads as a dash on a datasheet. */
function fmtSigned(n: number | null): string {
  return fmt(n).replace(/^-/, '−')
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

const hasAny = (m: MinMoyMax) => [m.min, m.moy, m.max].some((v) => v != null && v !== 0)

/** Headline value of a min/moy/max triple: the average, else the only bound. */
function headline(m: MinMoyMax): string {
  if (m.moy != null && m.moy !== 0) return fmt(m.moy)
  if (m.min != null && m.max != null && m.min !== 0 && m.max !== 0) return `${fmt(m.min)}–${fmt(m.max)}`
  return fmt(m.min ?? m.max)
}

/** Tolerance line under a key figure: « Tolérance ± 10 g/m² » when the bounds
 *  sit symmetrically around the average, else the explicit interval. */
function tolerance(m: MinMoyMax, unit: string): string | null {
  if (m.min == null || m.max == null || (m.min === 0 && m.max === 0)) return null
  if (m.moy == null || m.moy === 0) return null
  const below = m.moy - m.min
  const above = m.max - m.moy
  if (Math.abs(below - above) < 1e-6) return `Tolérance ± ${fmt(below)} ${unit}`
  return `Tolérance ${fmt(m.min)} – ${fmt(m.max)} ${unit}`
}

// ── Building blocks ──────────────────────────────────────

function Figure({ label, value, unit, sub, first }: {
  label: string
  value: string
  unit?: string
  sub?: string | null
  first?: boolean
}) {
  return (
    <View style={first ? styles.figure : [styles.figure, styles.figureDivider]}>
      <Text style={styles.figureLabel}>{label}</Text>
      <View style={styles.figureValueRow}>
        <Text style={styles.figureValue}>{value}</Text>
        {unit ? <Text style={styles.figureUnit}>{unit}</Text> : null}
      </View>
      {sub ? <Text style={styles.figureSub}>{sub}</Text> : null}
    </View>
  )
}

/** `breakable` lets a long body (observations) continue on the next page
 *  instead of dragging the whole section there. */
function Section({ title, breakable, children }: { title: string; breakable?: boolean; children: React.ReactNode }) {
  return (
    <View style={styles.section} wrap={breakable ? true : false}>
      <View style={styles.headingBand} wrap={false}>
        <Text style={styles.heading}>{title}</Text>
      </View>
      {children}
    </View>
  )
}

function Rows({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <View>
      {rows.map((r, i) => (
        <View key={i} style={i === rows.length - 1 ? styles.row : [styles.row, styles.rowRule]}>
          <Text style={styles.rowLabel}>{r.label}</Text>
          <Text style={styles.rowValue}>{r.value}</Text>
        </View>
      ))}
    </View>
  )
}

function CareItem({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <View style={styles.careItem}>
      {children}
      <Text style={styles.careCaption}>{caption}</Text>
    </View>
  )
}

// ── Document ─────────────────────────────────────────────

export function FicheTechniquePdf({ data }: { data: FicheTechniquePdfData }) {
  const stabRows = [
    { label: 'Retrait en hauteur', value: `${fmtSigned(data.stabHauteur)} %` },
    { label: 'Retrait en largeur', value: `${fmtSigned(data.stabLargeur)} %` },
  ]
  const allong = (m: MinMoyMax) =>
    m.min == null && m.moy == null ? `${fmt(m.max)} %` : `${fmt(m.min)} / ${fmt(m.moy)} / ${fmt(m.max)} %`
  if (hasAny(data.allongementH)) stabRows.push({ label: 'Allongement hauteur (min / moy / max)', value: allong(data.allongementH) })
  if (hasAny(data.allongementL)) stabRows.push({ label: 'Allongement largeur (min / moy / max)', value: allong(data.allongementL) })

  const compoRows = data.composition.length
    ? data.composition.map((c) => ({ label: capitalize(c.matiere.trim()), value: `${fmtPct(c.pourcentage)} %` }))
    : [{ label: '—', value: '' }]

  const kicker = ['Tissu maille', capitalize(data.contexture?.trim() ?? '')].filter(Boolean).join('  ·  ')
  const tempLavage = data.tempLavage ?? 30
  const observations = data.observations?.trim()

  return (
    <MalterreDocument
      documentType="Fiche technique"
      reference={data.reference}
      documentDate=""
      title={`Fiche technique ${data.reference}`}
      // The title block below carries its own top spacing.
      contentPaddingTop={0}
    >
      {/* Title — the reference itself is already in the header band */}
      <View style={styles.titleBlock}>
        <Text style={styles.kicker}>{kicker}</Text>
        <Text style={styles.designation}>{data.designation?.trim() || data.reference}</Text>
      </View>

      {/* Key figures */}
      <View style={styles.figures} wrap={false}>
        <Figure first label="POIDS" value={headline(data.poids)} unit="g/m²" sub={tolerance(data.poids, 'g/m²')} />
        <Figure label="LAIZE UTILE" value={headline(data.laizeUtile)} unit="cm" sub={tolerance(data.laizeUtile, 'cm')} />
        <Figure label="LAIZE HORS TOUT" value={headline(data.laizeHT)} unit="cm" sub={tolerance(data.laizeHT, 'cm')} />
        <Figure label="FINITION" value={data.finition} />
      </View>

      <View style={styles.grid}>
        <View style={styles.col}>
          <Section title="Composition">
            <Rows rows={compoRows} />
          </Section>
          <Section title="Stabilité dimensionnelle">
            <Rows rows={stabRows} />
          </Section>
        </View>
        <View style={styles.col}>
          <Section title="Conditionnement">
            <Text style={styles.freeText}>{data.conditionnement?.trim() || '—'}</Text>
          </Section>
          {/* Static in the legacy report (no DB field) */}
          <Section title="Douane & origine">
            <Rows
              rows={[
                { label: 'Nomenclature douanière', value: '6006 21 00' },
                { label: 'Provenance UE', value: 'Oui' },
                { label: 'Pays de fabrication', value: 'France' },
              ]}
            />
          </Section>
        </View>
      </View>

      <Section title="Conseils d'entretien">
        <View style={styles.careRow}>
          <CareItem caption={`Lavage ${tempLavage} °C`}><WashSymbol temp={tempLavage} {...SYM} /></CareItem>
          <CareItem caption="Chlore interdit"><NoBleachSymbol {...SYM} /></CareItem>
          <CareItem caption="Sèche-linge interdit"><NoTumbleDrySymbol {...SYM} /></CareItem>
          <CareItem caption="Repassage"><IronSymbol {...SYM} /></CareItem>
          <CareItem caption="Nettoyage à sec (P)"><DryCleanPSymbol {...SYM} /></CareItem>
        </View>
      </Section>

      {/* Observations — only when there is something to say. May break across
          pages: a long one (Duo01, ~1 000 chars) continues on page 2. */}
      {observations ? (
        <Section title="Observations" breakable>
          <Text style={styles.freeText}>{observations}</Text>
        </Section>
      ) : null}

      {/* Closing block: OEKO-TEX mark (left) + quality note and dates (right).
          The note is static legal/quality text from the legacy report. */}
      <View style={styles.bottomBlock} wrap={false}>
        <Image src={OEKOTEX_BUFFER} style={styles.oekotexMark} />
        <View style={styles.closing}>
          <Text style={styles.footNote}>
            Spécifications élaborées conformément aux normes NF, et en particulier à la charte qualité
            de France Tissu Maille.
          </Text>
          {data.dateCreation || data.dateModification ? (
            <Text style={styles.dates}>
              {data.dateCreation ? <Text>Fiche créée le <Text style={styles.datesStrong}>{data.dateCreation}</Text></Text> : null}
              {data.dateCreation && data.dateModification ? '   ·   ' : ''}
              {data.dateModification ? <Text>Mise à jour le <Text style={styles.datesStrong}>{data.dateModification}</Text></Text> : null}
            </Text>
          ) : null}
        </View>
      </View>
    </MalterreDocument>
  )
}
