// PDF « Fiche technique » of an écru (tombé de métier) reference: the
// knitting sheet: what the fabric is (contexture, jauge, diamètre, yarns) and
// how it is knitted (LFA / tour, pignons, réglages par métier, schéma de
// liage). No legacy report existed for it (the WinDev fiche only had the
// screen); the layout borrows the fini fiche's « bandeau gris » grammar
// (FicheTechniquePdf.tsx: key-figures band, grey-headed sections, dotted
// rows, gold only in the header band) so both sheets read as one family.
//
// Internal document: no price, nothing the client should not see beyond the
// knitting recipe. Headings stay sentence case (accented capitals lose their
// accent in react-pdf + Lato, see FicheTechniquePdf.tsx § Layout).

import React from 'react'
import { View, Text, StyleSheet, Svg, Polyline, Line, Path, Circle } from '@react-pdf/renderer'
import { MalterreDocument } from './MalterreDocument.js'
import { colors, sizes, company, type CompanyInfo } from './theme.js'

export interface FicheTechniqueEcruData {
  reference: string
  designation: string | null
  contexture: string | null
  jauge: string | null
  diametre: string | null
  bio: boolean
  recycle: boolean
  client: string | null
  referenceClient: string | null
  laizeTbm: number | null
  poidsM2Tbm: number | null
  rendement: number | null
  poidsPiece: number | null
  vitesseCible: number | null
  ecarteur: number | null
  tombeMetier: string | null
  mailleOuverture: boolean
  ouvertLarge: boolean
  sonneter: boolean
  lfaTour: string[]
  pignons: string[]
  composition: Array<{ fil: string; pourcentage: number | null; commentaire: string | null }>
  machines: Array<{
    metier: string
    reperes: string[]
    hauteurPl: string
    abattage: string
    trs10kgChute: number | null
    nbChutes: number | null
    compteur: number
  }>
  liage: {
    numCols: number
    chutes: Array<{ num: number; fil1: string; lfa1: number | null; fil2: string | null; lfa2: number | null; symboles: Array<string | null> }>
  }
  coloris: Array<{ reference: string; composition: string | null }>
  commentaire: string | null
  observations: string | null
  dateMaj: string | null
}

// ── Building the data from the screen's detail payload ───

// ref_ecru.Jauge / diametre are 1-based ordinals into the legacy combo lists
// (1 = « _ » placeholder), same tables as the web screen.
const JAUGE: Record<number, string> = { 2: '14', 3: '18', 4: '20', 5: '28' }
const DIAMETRE: Record<number, string> = { 2: '26"', 3: '30"' }

/** Subset of the detail payload this sheet reads (loadRefEcruDetail). */
export interface RefEcruDetailForFiche {
  reference: string | null
  designation: string | null
  contexture_nom: string | null
  Jauge: number | null
  diametre: number | null
  bio: number
  recycle: number
  client_nom: string | null
  reference_client: string | null
  laize_tbm: number | null
  poids_m2_tbm: number | null
  rendement: number | null
  poids: number | null
  vitesse_cible: number | null
  ecarteur: number | null
  tombe_metier: string | null
  maille_ouverture: number
  ouvert_visiteuse: number
  sonneter: number
  lfa_tour_1: string | null; lfa_tour_2: string | null; lfa_tour_3: string | null; lfa_tour_4: string | null
  poulies_1: string | null; poulies_2: string | null; poulies_3: string | null; poulies_4: string | null
  commentaire: string | null
  observations: string | null
  date_maj_ft: string | null
  composition_lines: Array<{ IDcomposition_ecru: number; ref_fil_reference: string | null; pourcentage: number | null; commentaire: string | null }>
  coloris: Array<{
    reference: string | null
    composition: Array<{ ref_fil_reference: string | null; colori_fil_reference: string | null; pourcentage: number | null }>
  }>
  machines: Array<{
    machine_nom: string | null
    IDmachine: number
    repere_1: string | null; repere_2: string | null; repere_3: string | null; repere_4: string | null; repere_5: string | null
    hauteur_pl: string | null
    abattage: string | null
    trs_10kg_chute: number | null
    nb_chutes: number | null
    compteur_saisie: number
  }>
  chutes: Array<{ IDchute_liage: number; num_chute: number; IDcomposition_ecru1: number; IDcomposition_ecru2: number; lfa1: number | null; lfa2: number | null }>
  cells: Array<{ IDchute_liage: number; num_symbole: number; IDsymbole_liage: number }>
  symboles: Array<{ IDsymbole_liage: number; icone: string | null }>
}

const txt = (s: string | null | undefined) => (s ?? '').trim()
const blank = (s: string | null | undefined) => (txt(s) === '' || txt(s) === '-1' ? null : txt(s))

/** « 20251124 » or « 2025-11-24 … » → « 24/11/2025 ». */
function frDate(raw: string | null): string | null {
  const s = txt(raw).replace(/-/g, '')
  if (!/^\d{8}/.test(s)) return null
  const [y, m, d] = [s.slice(0, 4), s.slice(4, 6), s.slice(6, 8)]
  if (y === '0000') return null
  return `${d}/${m}/${y}`
}

export function ficheTechniqueEcruData(d: RefEcruDetailForFiche): FicheTechniqueEcruData {
  const compoById = new Map(d.composition_lines.map((c) => [c.IDcomposition_ecru, txt(c.ref_fil_reference) || '—']))
  const iconeById = new Map(d.symboles.map((s) => [s.IDsymbole_liage, s.icone]))
  const maxSym = d.cells.reduce((mx, c) => Math.max(mx, c.num_symbole), 0)
  const chutes = [...d.chutes].sort((a, b) => a.num_chute - b.num_chute).map((ch) => {
    const symboles: Array<string | null> = Array.from({ length: maxSym }, () => null)
    for (const c of d.cells) {
      if (c.IDchute_liage === ch.IDchute_liage && c.num_symbole >= 1 && c.num_symbole <= maxSym) {
        symboles[c.num_symbole - 1] = iconeById.get(c.IDsymbole_liage) ?? null
      }
    }
    return {
      num: ch.num_chute,
      fil1: ch.IDcomposition_ecru1 > 0 ? compoById.get(ch.IDcomposition_ecru1) ?? '—' : '—',
      lfa1: ch.lfa1 || null,
      fil2: ch.IDcomposition_ecru2 > 0 ? compoById.get(ch.IDcomposition_ecru2) ?? '—' : null,
      lfa2: ch.lfa2 || null,
      symboles,
    }
  })
  return {
    reference: txt(d.reference) || '—',
    designation: blank(d.designation),
    contexture: blank(d.contexture_nom),
    jauge: d.Jauge != null ? JAUGE[d.Jauge] ?? null : null,
    diametre: d.diametre != null ? DIAMETRE[d.diametre] ?? null : null,
    bio: !!d.bio,
    recycle: !!d.recycle,
    client: blank(d.client_nom),
    referenceClient: blank(d.reference_client),
    laizeTbm: d.laize_tbm || null,
    poidsM2Tbm: d.poids_m2_tbm || null,
    rendement: d.rendement || null,
    poidsPiece: d.poids || null,
    vitesseCible: d.vitesse_cible || null,
    ecarteur: d.ecarteur || null,
    tombeMetier: blank(d.tombe_metier),
    mailleOuverture: !!d.maille_ouverture,
    ouvertLarge: !!d.ouvert_visiteuse,
    sonneter: !!d.sonneter,
    lfaTour: [d.lfa_tour_1, d.lfa_tour_2, d.lfa_tour_3, d.lfa_tour_4].map((v) => txt(v)),
    pignons: [d.poulies_1, d.poulies_2, d.poulies_3, d.poulies_4].map((v) => txt(v)),
    composition: d.composition_lines.map((c) => ({ fil: txt(c.ref_fil_reference) || '—', pourcentage: c.pourcentage, commentaire: blank(c.commentaire) })),
    machines: d.machines.map((m) => ({
      metier: txt(m.machine_nom) || `#${m.IDmachine}`,
      reperes: [m.repere_1, m.repere_2, m.repere_3, m.repere_4, m.repere_5].map((v) => txt(v)),
      hauteurPl: txt(m.hauteur_pl),
      abattage: txt(m.abattage),
      trs10kgChute: m.trs_10kg_chute,
      nbChutes: m.nb_chutes,
      compteur: m.compteur_saisie,
    })),
    liage: { numCols: maxSym, chutes },
    coloris: d.coloris.map((c) => ({
      reference: txt(c.reference) || '—',
      composition: c.composition.length
        ? c.composition.map((l) => `${fmtPct(l.pourcentage)} ${txt(l.ref_fil_reference) || '—'}${blank(l.colori_fil_reference) ? ` ${txt(l.colori_fil_reference)}` : ''}`).join(' · ')
        : null,
    })),
    commentaire: blank(d.commentaire),
    observations: blank(d.observations),
    dateMaj: frDate(d.date_maj_ft),
  }
}

// ── Formatting ───────────────────────────────────────────

function fmt(n: number | null, dp?: number): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const digits = dp ?? (Number.isInteger(n) ? 0 : 2)
  return n.toFixed(digits).replace('.', ',')
}
function fmtPct(n: number | null): string {
  return n == null ? '—' : `${String(Math.round(n * 10) / 10).replace('.', ',')} %`
}

// ── Layout ───────────────────────────────────────────────

const RULE = colors.border
const NAVY = colors.primaryDark
const INSET = 7

const styles = StyleSheet.create({
  titleBlock: { paddingTop: 16, paddingBottom: 14 },
  kicker: { fontSize: sizes.fontMd, color: colors.muted, lineHeight: 1 },
  designation: { fontSize: 20, color: NAVY, fontWeight: 700, lineHeight: 1.15, marginTop: 5 },
  tags: { fontSize: sizes.fontSm, color: colors.muted, marginTop: 6, lineHeight: 1 },

  figures: {
    flexDirection: 'row',
    borderTopWidth: 1.5, borderTopColor: NAVY, borderTopStyle: 'solid',
    borderBottomWidth: 0.75, borderBottomColor: RULE, borderBottomStyle: 'solid',
    marginBottom: 18,
  },
  figure: { flex: 1, paddingVertical: 9, paddingHorizontal: 10 },
  figureDivider: { borderLeftWidth: 0.75, borderLeftColor: RULE, borderLeftStyle: 'solid' },
  figureLabel: { fontSize: sizes.fontXs, color: colors.muted, fontWeight: 700, letterSpacing: 0.8, lineHeight: 1 },
  figureValueRow: { flexDirection: 'row', alignItems: 'flex-end', marginTop: 6 },
  figureValue: { fontSize: 19, color: NAVY, fontWeight: 700, lineHeight: 1 },
  figureUnit: { fontSize: sizes.fontBase, color: colors.muted, marginLeft: 3, lineHeight: 1.4 },

  grid: { flexDirection: 'row', gap: 24 },
  col: { flex: 1 },

  section: { marginBottom: 14 },
  headingBand: { backgroundColor: colors.bgMuted, paddingVertical: 5, paddingHorizontal: INSET, marginBottom: 5 },
  heading: { fontSize: sizes.fontBase, color: NAVY, fontWeight: 700, lineHeight: 1 },

  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 3, paddingHorizontal: INSET },
  rowRule: { borderBottomWidth: 0.75, borderBottomColor: colors.borderStrong, borderBottomStyle: 'dotted' },
  rowLabel: { fontSize: sizes.fontBase, color: colors.muted, lineHeight: 1.2 },
  rowValue: { fontSize: sizes.fontBase, color: colors.text, fontWeight: 700, lineHeight: 1.2, textAlign: 'right', maxWidth: '65%' },
  rowNote: { fontSize: sizes.fontSm, color: colors.muted, paddingHorizontal: INSET, paddingBottom: 3, lineHeight: 1.2 },

  quad: { flexDirection: 'row', gap: 4, paddingHorizontal: INSET, paddingVertical: 3, alignItems: 'center' },
  quadLabel: { fontSize: sizes.fontBase, color: colors.muted, width: 62, lineHeight: 1.2 },
  quadCell: {
    flex: 1, borderWidth: 0.75, borderColor: colors.borderStrong, borderStyle: 'solid', borderRadius: 2,
    paddingVertical: 3, fontSize: sizes.fontBase, fontWeight: 700, color: colors.text, textAlign: 'center', lineHeight: 1.2,
  },

  freeText: { fontSize: sizes.fontBase, color: colors.text, lineHeight: 1.5, paddingHorizontal: INSET },
  empty: { fontSize: sizes.fontBase, color: colors.muted, paddingHorizontal: INSET, lineHeight: 1.2 },

  table: { marginHorizontal: 0 },
  tHead: { flexDirection: 'row', borderBottomWidth: 0.75, borderBottomColor: colors.borderStrong, borderBottomStyle: 'solid' },
  tRow: { flexDirection: 'row', borderBottomWidth: 0.75, borderBottomColor: RULE, borderBottomStyle: 'solid', alignItems: 'center' },
  th: { fontSize: sizes.fontXs, color: colors.muted, fontWeight: 700, paddingVertical: 3, paddingHorizontal: 3, lineHeight: 1.1 },
  td: { fontSize: sizes.fontSm, color: colors.text, paddingVertical: 3, paddingHorizontal: 3, lineHeight: 1.2 },
  tdStrong: { fontWeight: 700 },

  footer: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 'auto', paddingTop: 8, paddingBottom: 12 },
  dates: { fontSize: sizes.fontSm, color: colors.muted, lineHeight: 1 },
  datesStrong: { color: colors.text, fontWeight: 700 },
})

// ── Building blocks ──────────────────────────────────────

function Figure({ label, value, unit, first }: { label: string; value: string; unit?: string; first?: boolean }) {
  return (
    <View style={first ? styles.figure : [styles.figure, styles.figureDivider]}>
      <Text style={styles.figureLabel}>{label}</Text>
      <View style={styles.figureValueRow}>
        <Text style={styles.figureValue}>{value}</Text>
        {unit && value !== '—' ? <Text style={styles.figureUnit}>{unit}</Text> : null}
      </View>
    </View>
  )
}

function Section({ title, breakable, children }: { title: string; breakable?: boolean; children: React.ReactNode }) {
  return (
    <View style={styles.section} wrap={breakable ? true : false}>
      <View style={styles.headingBand} wrap={false} minPresenceAhead={30}>
        <Text style={styles.heading}>{title}</Text>
      </View>
      {children}
    </View>
  )
}

function Rows({ rows }: { rows: Array<{ label: string; value: string; note?: string | null }> }) {
  return (
    <View>
      {rows.map((r, i) => (
        <View key={i} style={i === rows.length - 1 ? undefined : styles.rowRule}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>{r.label}</Text>
            <Text style={styles.rowValue}>{r.value}</Text>
          </View>
          {r.note ? <Text style={styles.rowNote}>{r.note}</Text> : null}
        </View>
      ))}
    </View>
  )
}

function Quad({ label, values }: { label: string; values: string[] }) {
  return (
    <View style={styles.quad}>
      <Text style={styles.quadLabel}>{label}</Text>
      {values.map((v, i) => <Text key={i} style={styles.quadCell}>{v || '—'}</Text>)}
    </View>
  )
}

/** One knit-binding symbol, drawn like the screen's SymboleGlyph: front in
 *  navy, back in light blue with a dashed ring. */
function Glyph({ icone, size }: { icone: string | null; size: number }) {
  if (!icone) return null
  const isFront = icone.startsWith('front')
  const kind = icone.includes('stitch') ? 'stitch' : icone.includes('float') ? 'float' : icone.includes('tuck') ? 'tuck' : null
  const color = isFront ? '#143D6B' : '#3B7DC9'
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18">
      {kind === 'stitch' ? <Polyline points="3,5 9,13 15,5" stroke={color} strokeWidth={1.8} fill="none" /> : null}
      {kind === 'float' ? <Line x1="3" y1="9" x2="15" y2="9" stroke={color} strokeWidth={1.8} /> : null}
      {kind === 'tuck' ? <Path d="M4 4 L4 9 Q4 14 9 14 Q14 14 14 9 L14 4" stroke={color} strokeWidth={1.8} fill="none" /> : null}
      {!isFront ? <Circle cx="9" cy="9" r="8" stroke={color} strokeWidth={0.6} strokeDasharray="2 2" fill="none" /> : null}
    </Svg>
  )
}

// Usable width of the A4 content area (595 pt minus MalterreDocument's side
// padding); the liage grid sizes its symbol cells from it.
const CONTENT_WIDTH = 515

function LiageTable({ liage }: { liage: FicheTechniqueEcruData['liage'] }) {
  const fixed = { chute: 32, fil: 92 }
  const cols = Math.max(liage.numCols, 1)
  const cell = Math.min(18, Math.floor((CONTENT_WIDTH - fixed.chute - 2 * fixed.fil) / cols))
  return (
    <View style={styles.table}>
      <View style={styles.tHead} wrap={false}>
        <Text style={[styles.th, { width: fixed.chute }]}>Chute</Text>
        <Text style={[styles.th, { width: fixed.fil }]}>Fil 1 · LFA</Text>
        <Text style={[styles.th, { width: fixed.fil }]}>Fil 2 · LFA</Text>
        {Array.from({ length: liage.numCols }, (_, i) => (
          <Text key={i} style={[styles.th, { width: cell, paddingHorizontal: 0, textAlign: 'center' }]}>{i + 1}</Text>
        ))}
      </View>
      {liage.chutes.map((ch) => (
        <View key={ch.num} style={styles.tRow} wrap={false}>
          <Text style={[styles.td, styles.tdStrong, { width: fixed.chute }]}>{ch.num}</Text>
          <Text style={[styles.td, { width: fixed.fil }]}>{ch.fil1}{ch.lfa1 ? ` · ${fmt(ch.lfa1)}` : ''}</Text>
          <Text style={[styles.td, { width: fixed.fil }]}>{ch.fil2 ? `${ch.fil2}${ch.lfa2 ? ` · ${fmt(ch.lfa2)}` : ''}` : '—'}</Text>
          {ch.symboles.map((s, i) => (
            <View key={i} style={{ width: cell, alignItems: 'center', paddingVertical: 2 }}>
              <Glyph icone={s} size={Math.min(12, cell - 2)} />
            </View>
          ))}
        </View>
      ))}
    </View>
  )
}

function MachinesTable({ machines }: { machines: FicheTechniqueEcruData['machines'] }) {
  const w = { metier: 52, rep: 34, h: 50, ab: 50, trs: 52, nb: 40, cpt: 52 }
  return (
    <View style={styles.table}>
      <View style={styles.tHead} wrap={false}>
        <Text style={[styles.th, { width: w.metier }]}>Métier</Text>
        {[1, 2, 3, 4, 5].map((i) => <Text key={i} style={[styles.th, { width: w.rep, textAlign: 'center' }]}>Rep. {i}</Text>)}
        <Text style={[styles.th, { width: w.h }]}>Haut. pl.</Text>
        <Text style={[styles.th, { width: w.ab }]}>Abattage</Text>
        <Text style={[styles.th, { width: w.trs, textAlign: 'right' }]}>Trs/10kg/ch.</Text>
        <Text style={[styles.th, { width: w.nb, textAlign: 'right' }]}>Chutes</Text>
        <Text style={[styles.th, { width: w.cpt, textAlign: 'right' }]}>Compteur</Text>
      </View>
      {machines.map((m, i) => (
        <View key={i} style={styles.tRow} wrap={false}>
          <Text style={[styles.td, styles.tdStrong, { width: w.metier }]}>{m.metier}</Text>
          {m.reperes.map((r, j) => <Text key={j} style={[styles.td, { width: w.rep, textAlign: 'center' }]}>{r}</Text>)}
          <Text style={[styles.td, { width: w.h }]}>{m.hauteurPl}</Text>
          <Text style={[styles.td, { width: w.ab }]}>{m.abattage}</Text>
          <Text style={[styles.td, { width: w.trs, textAlign: 'right' }]}>{m.trs10kgChute != null ? fmt(m.trs10kgChute, 0) : ''}</Text>
          <Text style={[styles.td, { width: w.nb, textAlign: 'right' }]}>{m.nbChutes != null ? fmt(m.nbChutes, 0) : ''}</Text>
          <Text style={[styles.td, styles.tdStrong, { width: w.cpt, textAlign: 'right' }]}>{m.compteur ? fmt(m.compteur, 0) : ''}</Text>
        </View>
      ))}
    </View>
  )
}

// ── Document ─────────────────────────────────────────────

export function FicheTechniqueEcruPdf({ data, issuer = company }: { data: FicheTechniqueEcruData; issuer?: CompanyInfo }) {
  const kicker = [
    'Tombé de métier',
    data.contexture,
    data.jauge ? `Jauge ${data.jauge}` : null,
    data.diametre ? `Ø ${data.diametre}` : null,
  ].filter(Boolean).join('  ·  ')
  const tags = [data.bio ? 'Bio' : null, data.recycle ? 'Recyclé' : null].filter(Boolean).join('  ·  ')
  const flags = [
    data.mailleOuverture ? "Maille d'ouverture" : null,
    data.ouvertLarge ? 'Ouvert au large' : null,
    data.sonneter ? 'Sonneter' : null,
  ].filter(Boolean).join(', ')
  const total = data.composition.reduce((s, c) => s + (Number(c.pourcentage) || 0), 0)

  const tricotage = [
    { label: 'Vitesse cible', value: data.vitesseCible ? `${fmt(data.vitesseCible)} tr/min` : '—' },
    { label: 'Écarteur', value: fmt(data.ecarteur) },
    { label: 'Tombé du métier', value: data.tombeMetier ?? '—' },
    { label: 'Particularités', value: flags || '—' },
  ]
  const identification = [
    { label: 'Client', value: data.client ?? '—' },
    ...(data.referenceClient ? [{ label: 'Référence client', value: data.referenceClient }] : []),
    { label: 'Contexture', value: data.contexture ?? '—' },
    { label: 'Jauge · Ø', value: `${data.jauge ?? '—'} · ${data.diametre ?? '—'}` },
  ]

  return (
    <MalterreDocument
      documentType="Fiche technique"
      reference={data.reference}
      documentDate=""
      title={`Fiche technique ${data.reference}`}
      contentPaddingTop={0}
      issuer={issuer}
    >
      <View style={styles.titleBlock}>
        <Text style={styles.kicker}>{kicker}</Text>
        <Text style={styles.designation}>{data.designation ?? data.reference}</Text>
        {tags ? <Text style={styles.tags}>{tags}</Text> : null}
      </View>

      <View style={styles.figures} wrap={false}>
        <Figure first label="LAIZE TBM" value={fmt(data.laizeTbm)} unit="cm" />
        <Figure label="POIDS TBM" value={fmt(data.poidsM2Tbm)} unit="g/m²" />
        <Figure label="RENDEMENT" value={fmt(data.rendement)} />
        <Figure label="POIDS PIECE" value={fmt(data.poidsPiece)} unit="kg" />
      </View>

      <View style={styles.grid}>
        <View style={styles.col}>
          <Section title="Composition">
            {data.composition.length ? (
              <Rows
                rows={[
                  ...data.composition.map((c) => ({ label: c.fil, value: fmtPct(c.pourcentage), note: c.commentaire })),
                  ...(data.composition.length > 1 ? [{ label: 'Total', value: fmtPct(Math.round(total * 100) / 100) }] : []),
                ]}
              />
            ) : (
              <Text style={styles.empty}>Aucun fil</Text>
            )}
          </Section>
          <Section title="Identification">
            <Rows rows={identification} />
          </Section>
        </View>
        <View style={styles.col}>
          <Section title="Tricotage">
            <Quad label="LFA / tour" values={data.lfaTour} />
            <Quad label="Pignons" values={data.pignons} />
            <Rows rows={tricotage} />
          </Section>
        </View>
      </View>

      <Section title="Réglages par métier">
        {data.machines.length ? <MachinesTable machines={data.machines} /> : <Text style={styles.empty}>Aucun réglage machine</Text>}
      </Section>

      {data.liage.chutes.length ? (
        <Section title="Schéma de liage" breakable>
          <LiageTable liage={data.liage} />
        </Section>
      ) : null}

      {data.coloris.length ? (
        <Section title={`Coloris (${data.coloris.length})`} breakable>
          <Rows
            rows={data.coloris.map((c) => ({ label: c.reference, value: c.composition ?? 'Composition de la référence' }))}
          />
        </Section>
      ) : null}

      {data.commentaire ? (
        <Section title="Commentaire" breakable>
          <Text style={styles.freeText}>{data.commentaire}</Text>
        </Section>
      ) : null}
      {data.observations ? (
        <Section title="Observations" breakable>
          <Text style={styles.freeText}>{data.observations}</Text>
        </Section>
      ) : null}

      {data.dateMaj ? (
        <View style={styles.footer} wrap={false}>
          <Text style={styles.dates}>Fiche mise à jour le <Text style={styles.datesStrong}>{data.dateMaj}</Text></Text>
        </View>
      ) : null}
    </MalterreDocument>
  )
}
