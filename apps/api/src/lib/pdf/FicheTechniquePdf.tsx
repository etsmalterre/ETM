// PDF document for the "Fiche Technique" of a finished-fabric reference
// (ref_fini). Ports the legacy WinDev ETAT_Fiche_technique to the ETM
// design language: caractéristiques (laize / poids min-moy-max), composition
// (matières from the écru's yarns), stabilités dimensionnelles,
// conditionnement, observations, customs / provenance lines, care symbols
// and the quality-validation footer. The customs code, provenance and the
// footnote texts are static in the legacy report (no DB field) and are kept
// identical here.

import React from 'react'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { View, Text, StyleSheet, Image, Svg, Path, Rect, Circle, Line } from '@react-pdf/renderer'
import { MalterreDocument } from './MalterreDocument.js'
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

// ── Care symbols (ISO 3758-style line drawings) ──────────
// The legacy fiche prints five symbols: wash at temp_lavage, no bleach,
// no tumble dry, iron, professional dry clean (P). Drawn inline so the PDF
// stays asset-free.

const SYM = { size: 34, stroke: colors.text, sw: 1.4 }

function WashSymbol({ temp }: { temp: number | null }) {
  return (
    <View style={careStyles.symBox}>
      <Svg width={SYM.size} height={SYM.size} viewBox="0 0 24 24">
        {/* Basin: wavy top edge + tapering sides */}
        <Path
          d="M2.5 6 C4 7.6 5.5 7.6 7 6 C8.5 4.4 10 4.4 11.5 6 C13 7.6 14.5 7.6 16 6 C17.5 4.4 19 4.4 20.5 6"
          stroke={SYM.stroke}
          strokeWidth={SYM.sw}
          fill="none"
        />
        <Path d="M3.2 7.5 L5.5 20 H18.5 L20.8 7.5" stroke={SYM.stroke} strokeWidth={SYM.sw} fill="none" />
      </Svg>
      {temp != null && temp > 0 ? <Text style={careStyles.washTemp}>{String(Math.round(temp))}</Text> : null}
    </View>
  )
}

function NoBleachSymbol() {
  return (
    <View style={careStyles.symBox}>
      <Svg width={SYM.size} height={SYM.size} viewBox="0 0 24 24">
        <Path d="M12 4 L21.5 20.5 H2.5 Z" stroke={SYM.stroke} strokeWidth={SYM.sw} fill="none" />
        <Line x1={4} y1={5} x2={20} y2={21.5} stroke={SYM.stroke} strokeWidth={SYM.sw} />
        <Line x1={20} y1={5} x2={4} y2={21.5} stroke={SYM.stroke} strokeWidth={SYM.sw} />
      </Svg>
    </View>
  )
}

function NoTumbleDrySymbol() {
  return (
    <View style={careStyles.symBox}>
      <Svg width={SYM.size} height={SYM.size} viewBox="0 0 24 24">
        <Rect x={3} y={3} width={18} height={18} stroke={SYM.stroke} strokeWidth={SYM.sw} fill="none" />
        <Circle cx={12} cy={12} r={7} stroke={SYM.stroke} strokeWidth={SYM.sw} fill="none" />
        <Line x1={3.5} y1={3.5} x2={20.5} y2={20.5} stroke={SYM.stroke} strokeWidth={SYM.sw} />
        <Line x1={20.5} y1={3.5} x2={3.5} y2={20.5} stroke={SYM.stroke} strokeWidth={SYM.sw} />
      </Svg>
    </View>
  )
}

function IronSymbol() {
  return (
    <View style={careStyles.symBox}>
      <Svg width={SYM.size} height={SYM.size} viewBox="0 0 24 24">
        <Path
          d="M21 18 H3 C3 13 7 9.5 12.5 9.5 H17.5 L21 18 Z"
          stroke={SYM.stroke}
          strokeWidth={SYM.sw}
          fill="none"
        />
        <Path d="M10 9.5 V7 H18" stroke={SYM.stroke} strokeWidth={SYM.sw} fill="none" />
      </Svg>
    </View>
  )
}

function DryCleanPSymbol() {
  return (
    <View style={careStyles.symBox}>
      <Svg width={SYM.size} height={SYM.size} viewBox="0 0 24 24">
        <Circle cx={12} cy={12} r={9.5} stroke={SYM.stroke} strokeWidth={SYM.sw} fill="none" />
      </Svg>
      <Text style={careStyles.dryCleanLetter}>P</Text>
    </View>
  )
}

const careStyles = StyleSheet.create({
  symBox: {
    width: SYM.size,
    height: SYM.size,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  washTemp: {
    position: 'absolute',
    top: 11,
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 7.5,
    fontWeight: 700,
    color: colors.text,
    lineHeight: 1,
  },
  dryCleanLetter: {
    position: 'absolute',
    top: 10,
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 10,
    fontWeight: 700,
    color: colors.text,
    lineHeight: 1,
  },
})

// ── Section chrome ───────────────────────────────────────

const styles = StyleSheet.create({
  section: {
    backgroundColor: colors.bgCream,
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderLeftWidth: 2,
    borderLeftColor: colors.gold,
    borderLeftStyle: 'solid',
    borderRadius: 6,
    padding: 10,
    // 7 rather than 10: across the fiche's ~7 sections that frees ~21pt, which
    // is what funds the OEKO-TEX mark at the bottom (see `oekotexMark`). The
    // 3pt tightening is imperceptible between cream cards; the mark it buys is
    // not. Re-run scripts/check-fiche-page-counts if you restore it to 10.
    marginBottom: 7,
  },
  sectionTitle: {
    fontSize: sizes.fontXs,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.5,
    lineHeight: 1,
    marginBottom: 6,
  },

  // Label / value identity rows (Référence, Désignation, Contexture)
  idRow: { flexDirection: 'row', gap: 6, paddingVertical: 1 },
  idLabel: { width: 90, fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, lineHeight: 1.3 },
  idValue: { flex: 1, fontSize: sizes.fontBase, color: colors.text, fontWeight: 700, lineHeight: 1.3 },

  // Min / Moyen / Max spec table
  specTable: { marginTop: 6 },
  specHeaderRow: {
    flexDirection: 'row',
    backgroundColor: colors.bgMuted,
    borderBottomWidth: 1.5,
    borderBottomColor: colors.gold,
    borderBottomStyle: 'solid',
  },
  specRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.75,
    borderBottomColor: colors.border,
    borderBottomStyle: 'solid',
  },
  specRowLast: { flexDirection: 'row' },
  specCellLabel: {
    flex: 2,
    fontSize: sizes.fontBase,
    color: colors.text,
    fontWeight: 700,
    paddingVertical: 3.5,
    paddingHorizontal: 4,
    lineHeight: 1.2,
  },
  specCellHead: {
    flex: 1,
    fontSize: sizes.fontSm,
    color: colors.muted,
    fontWeight: 900,
    letterSpacing: 0.4,
    textAlign: 'center',
    paddingVertical: 3.5,
    paddingHorizontal: 4,
    lineHeight: 1.2,
  },
  specCellValue: {
    flex: 1,
    fontSize: sizes.fontBase,
    color: colors.text,
    textAlign: 'center',
    paddingVertical: 3.5,
    paddingHorizontal: 4,
    lineHeight: 1.2,
  },

  // Two side-by-side sections
  twoCols: { flexDirection: 'row', gap: 10, alignItems: 'stretch' },
  colSlot: { flex: 1, flexDirection: 'column' },
  sectionStretch: { flexGrow: 1 },

  // Free-text sections (conditionnement / observations)
  freeText: { fontSize: sizes.fontBase, color: colors.text, lineHeight: 1.4 },

  // Customs / provenance line
  customsRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 1 },
  customsText: { fontSize: sizes.fontBase, color: colors.text, lineHeight: 1.35 },
  customsLabel: { fontWeight: 700, color: colors.muted },

  // Care symbols row
  careRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 4,
  },

  // Footnotes — sit directly under the last section (Code entretien), flush
  // with the section's left edge (both are direct children of the content
  // wrapper, so neither carries a horizontal inset).
  footNotes: { marginTop: 2 },
  footNote: { fontSize: sizes.fontXs, color: colors.muted, lineHeight: 1.4 },

  // Closing block: OEKO-TEX mark bottom-left, fiche dates bottom-right, pushed
  // to the bottom of the content area by the auto top margin.
  //
  // This block is wrap={false} at the very end of the flow, so every point of
  // height here eats the slack before the whole block spills onto a second,
  // near-empty page. The budget for the mark comes from `contentPaddingTop`
  // being tightened on this document (see the MalterreDocument call below) —
  // do not grow the mark without re-running scripts/check-fiche-page-counts.
  bottomBlock: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: 16,
    marginTop: 'auto',
  },

  // Near-square artwork (536×520), so the height keeps that ratio.
  //
  // 74pt is at the measured ceiling, and the ceiling is the whole story here:
  // the closing block is wrap={false} at the end of the flow, so the mark's
  // height is paid for out of the page's leftover space. The budget was
  // assembled deliberately — contentPaddingTop 20 → 0, the footnotes' 8pt
  // bottom margin, and section marginBottom 10 → 7 (~21pt over 7 sections).
  // Without the section tightening the ceiling is only ~57pt.
  //
  // Verified against the 30 most text-heavy references: 74 holds the baseline
  // (1 pre-existing spill, Duo01), 80 regresses. ALWAYS re-run
  // scripts/check-fiche-page-counts after touching this.
  oekotexMark: { width: 74, height: 71.8, flexShrink: 0 },

  // Dates — bottom-right of the block above (the content wrapper is a flex
  // column that stretches down to the page's bottom padding, just above the
  // footer band).
  validationDates: { flexDirection: 'column', alignItems: 'flex-end' },
  validationDateLine: { fontSize: sizes.fontBase, color: colors.text, lineHeight: 1.45 },
})

// ── Small building blocks ────────────────────────────────

function IdRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.idRow}>
      <Text style={styles.idLabel}>{label}</Text>
      <Text style={styles.idValue}>{value}</Text>
    </View>
  )
}

function SpecTable({ rows }: { rows: Array<{ label: string; values: MinMoyMax; dp?: number }> }) {
  return (
    <View style={styles.specTable}>
      <View style={styles.specHeaderRow}>
        <Text style={styles.specCellLabel} />
        <Text style={styles.specCellHead}>MINIMUM</Text>
        <Text style={styles.specCellHead}>MOYEN</Text>
        <Text style={styles.specCellHead}>MAXIMUM</Text>
      </View>
      {rows.map((r, i) => (
        <View key={i} style={i === rows.length - 1 ? styles.specRowLast : styles.specRow}>
          <Text style={styles.specCellLabel}>{r.label}</Text>
          <Text style={styles.specCellValue}>{fmt(r.values.min, r.dp ?? 0)}</Text>
          <Text style={styles.specCellValue}>{fmt(r.values.moy, r.dp ?? 0)}</Text>
          <Text style={styles.specCellValue}>{fmt(r.values.max, r.dp ?? 0)}</Text>
        </View>
      ))}
    </View>
  )
}

function Section({
  title,
  stretch,
  children,
}: {
  title: string
  stretch?: boolean
  children: React.ReactNode
}) {
  return (
    <View style={stretch ? [styles.section, styles.sectionStretch] : styles.section} wrap={false}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  )
}

const hasAny = (m: MinMoyMax) => [m.min, m.moy, m.max].some((v) => v != null && v !== 0)

// ── Document ─────────────────────────────────────────────

export function FicheTechniquePdf({ data }: { data: FicheTechniquePdfData }) {
  const stabRows: Array<{ label: string; values: MinMoyMax; dp?: number }> = [
    { label: 'Stabilité hauteur (%)', values: { min: null, moy: null, max: data.stabHauteur } },
    { label: 'Stabilité largeur (%)', values: { min: null, moy: null, max: data.stabLargeur } },
  ]
  if (hasAny(data.allongementH)) stabRows.push({ label: 'Allongement hauteur (%)', values: data.allongementH })
  if (hasAny(data.allongementL)) stabRows.push({ label: 'Allongement largeur (%)', values: data.allongementL })

  return (
    <MalterreDocument
      documentType="Fiche technique"
      reference={data.reference}
      documentDate=""
      title={`Fiche technique ${data.reference}`}
      // Tighter than the shared default (20). The fiche carries no top address
      // /metadata cards, so the band-to-first-section gap was pure dead space —
      // reclaiming it funds the OEKO-TEX mark at the bottom without pushing
      // content-heavy references onto a second page.
      contentPaddingTop={0}
    >
      {/* Caractéristiques */}
      <Section title="CARACTÉRISTIQUES">
        <IdRow label="Référence" value={data.reference} />
        <IdRow label="Désignation" value={data.designation?.trim() || '—'} />
        <IdRow label="Contexture" value={data.contexture?.trim() || '—'} />
        <SpecTable
          rows={[
            { label: 'Laize hors tout (cm)', values: data.laizeHT },
            { label: 'Laize utile (cm)', values: data.laizeUtile },
            { label: 'Poids (g/m²)', values: data.poids },
          ]}
        />
      </Section>

      {/* Composition + Stabilités side by side */}
      <View style={styles.twoCols}>
        <View style={styles.colSlot}>
          <Section title="COMPOSITION" stretch>
            {data.composition.length === 0 ? (
              <Text style={styles.freeText}>—</Text>
            ) : (
              data.composition.map((c, i) => (
                <View key={i} style={styles.idRow}>
                  <Text style={[styles.idLabel, { width: 120 }]}>{c.matiere}</Text>
                  <Text style={styles.idValue}>{fmt(c.pourcentage, 2)} %</Text>
                </View>
              ))
            )}
          </Section>
        </View>
        <View style={styles.colSlot}>
          <Section title="STABILITÉS DIMENSIONNELLES" stretch>
            {stabRows.map((r, i) => (
              <View key={i} style={styles.idRow}>
                <Text style={[styles.idLabel, { width: 120 }]}>{r.label}</Text>
                <Text style={styles.idValue}>
                  {r.values.min == null && r.values.moy == null
                    ? fmt(r.values.max)
                    : `${fmt(r.values.min)} / ${fmt(r.values.moy)} / ${fmt(r.values.max)}`}
                </Text>
              </View>
            ))}
          </Section>
        </View>
      </View>

      {/* Conditionnement */}
      <Section title="CONDITIONNEMENT">
        <Text style={styles.freeText}>{data.conditionnement?.trim() || '—'}</Text>
      </Section>

      {/* Observations — only when there is something to say */}
      {data.observations?.trim() ? (
        <Section title="OBSERVATIONS">
          <Text style={styles.freeText}>{data.observations.trim()}</Text>
        </Section>
      ) : null}

      {/* Douane / provenance — static in the legacy report (no DB field) */}
      <Section title="DOUANE & PROVENANCE">
        <View style={styles.customsRow}>
          <Text style={styles.customsText}>
            <Text style={styles.customsLabel}>Tarification douanière : </Text>60062100
          </Text>
          <Text style={styles.customsText}>
            <Text style={styles.customsLabel}>Provenance C.E.E : </Text>oui
          </Text>
          <Text style={styles.customsText}>
            <Text style={styles.customsLabel}>Pays : </Text>FRANCE
          </Text>
        </View>
      </Section>

      {/* Code entretien */}
      <Section title="CODE ENTRETIEN">
        <View style={styles.careRow}>
          <WashSymbol temp={data.tempLavage ?? 30} />
          <NoBleachSymbol />
          <NoTumbleDrySymbol />
          <IronSymbol />
          <DryCleanPSymbol />
        </View>
      </Section>

      {/* Footnote — static legal/quality text from the legacy report. Kept
          immediately under the Code entretien section, not pushed to the page
          bottom, so it reads as that section's annotation.
          The legacy report had a second line here ("** Tous nos sous-traitants
          sont certifiés OEKOTEX"); it was dropped once the OEKO-TEX mark below
          started carrying ETS Malterre's own certificate (CQ 1357/1), so the
          page no longer mixes two different certification claims. Neither note
          was ever keyed to a marker in the body, so nothing dangles. */}
      <View style={styles.footNotes} wrap={false}>
        <Text style={styles.footNote}>
          * Ces spécifications ont été élaborées conformément aux normes NF et en particulier à celles
          contenues dans la charte qualité de France Tissu Maille
        </Text>
      </View>

      {/* Closing block: OEKO-TEX mark (left) + fiche dates (right) */}
      <View style={styles.bottomBlock} wrap={false}>
        <Image src={OEKOTEX_BUFFER} style={styles.oekotexMark} />
        <View style={styles.validationDates}>
          {data.dateCreation ? (
            <Text style={styles.validationDateLine}>
              <Text style={styles.customsLabel}>Date de création de la fiche : </Text>
              {data.dateCreation}
            </Text>
          ) : null}
          {data.dateModification ? (
            <Text style={styles.validationDateLine}>
              <Text style={styles.customsLabel}>Date de modification de la fiche : </Text>
              {data.dateModification}
            </Text>
          ) : null}
        </View>
      </View>
    </MalterreDocument>
  )
}
