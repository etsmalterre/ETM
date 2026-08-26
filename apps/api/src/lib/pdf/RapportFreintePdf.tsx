// Rapport de freinte d'un lot de fil — TRM Fils › Stock, Archivage dialog's
// « Imprimer ». Ports the legacy ETAT_Rapport_Freinte.wde (PCS-compressed, so
// the layout is re-designed on the shared MalterreDocument frame).
//
// Issued by Tricotage Malterre → the frame receives `companyTrm` (its own
// SIRET / TVA / capital in the footer — legal identity, not branding).
//
// Content mirrors the Archivage dialog: lot identity, the OF consumption table
// (1er / 2nd choix kg per ordre de fabrication), the freinte de tricotage and
// second choix percentages (same thresholds as the screen: freinte green ≤ 10%,
// red above or negative; 2nd choix green at 0, amber ≤ 5%, red above), the
// visitage defects found on the lot's pieces, and the observation.

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import { MalterreDocument } from './MalterreDocument.js'
import { colors, companyTrm } from './theme.js'

// ── Input shape ──────────────────────────────────────────

export interface RapportFreinteOfRow {
  of: number
  ref_ecru: string
  premier_choix: number
  second_choix: number
}

export interface RapportFreinteIncorporeRow {
  of: number
  ref_ecru: string
  poids: number
}

export interface RapportFreinteData {
  lot: string
  ref_fil: string
  colori_reference: string
  client_nom: string
  fournisseur_nom: string
  lot_frs: string
  date_entree: string
  date_edition: string
  stock_initial: number
  ofs: RapportFreinteOfRow[]
  produit: number
  /** Lots of THIS fil dumped into a run through "Incorporer un fil". Declared
   *  in Kg on the OF, never shared as a percentage, so `produit` cannot see
   *  them — but they are consumption, and leaving them out reported the whole
   *  weight as freinte. Printed as their own table, and `freinte_kg` is net of
   *  them. */
  incorpore: RapportFreinteIncorporeRow[]
  incorpore_total: number
  freinte_kg: number
  freinte_pct: number | null
  second_choix_pct: number | null
  defauts: Array<{ label: string; nombre: number }>
  observation_freinte: string
}

// ── Formatting ───────────────────────────────────────────

function fmtKg(value: number | null | undefined, decimals = 2): string {
  if (value == null || Number.isNaN(value)) return '—'
  return `${value
    .toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace(/ | /g, ' ')} kg`
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  return `${value
    .toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/ | /g, ' ')} %`
}

// Same thresholds as the ArchiverDialog pills (user-confirmed).
const GREEN = '#15803d'
const AMBER = '#b45309'
const RED = '#b91c1c'

function freinteColor(pct: number | null): string {
  if (pct == null) return colors.text
  if (pct < 0 || pct > 10) return RED
  return GREEN
}

function secondChoixColor(pct: number | null): string {
  if (pct == null) return colors.text
  if (pct === 0) return GREEN
  if (pct <= 5) return AMBER
  return RED
}

// ── Styles ───────────────────────────────────────────────

const styles = StyleSheet.create({
  identity: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: colors.bgCream,
    borderLeftWidth: 3,
    borderLeftColor: colors.gold,
    borderRadius: 3,
    padding: 10,
    marginBottom: 14,
  },
  identityCell: { width: '33.33%', marginBottom: 5 },
  identityLabel: { fontSize: 7, color: colors.muted, textTransform: 'uppercase', marginBottom: 1.5 },
  identityValue: { fontSize: 9.5, color: colors.text },

  sectionTitle: {
    fontSize: 10,
    color: colors.primary,
    fontWeight: 700,
    marginBottom: 6,
  },

  table: { marginBottom: 14 },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: colors.primary,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  th: { fontSize: 8, color: '#ffffff', fontWeight: 700 },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
    paddingVertical: 3.5,
    paddingHorizontal: 6,
  },
  td: { fontSize: 9, color: colors.text },
  tdNum: { fontSize: 9, color: colors.text, textAlign: 'right' },
  totalRow: {
    flexDirection: 'row',
    backgroundColor: colors.bgMuted,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  totalCell: { fontSize: 9, fontWeight: 700, color: colors.text },
  totalCellNum: { fontSize: 9, fontWeight: 700, color: colors.text, textAlign: 'right' },

  colOf: { width: '15%' },
  colRef: { width: '43%' },
  colKg: { width: '14%' },

  statsRow: { flexDirection: 'row', marginBottom: 14 },
  statBox: {
    flex: 1,
    borderWidth: 0.5,
    borderColor: colors.border,
    borderRadius: 3,
    padding: 10,
    alignItems: 'center',
  },
  statBoxSpacer: { width: 12 },
  statLabel: { fontSize: 8, color: colors.muted, textTransform: 'uppercase', marginBottom: 3 },
  statDetail: { fontSize: 9, color: colors.text, marginBottom: 2 },
  statValue: { fontSize: 16, fontWeight: 700 },

  defautsNone: { fontSize: 10, color: GREEN, fontWeight: 700, marginBottom: 14 },
  defautRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
    paddingVertical: 3,
    paddingHorizontal: 6,
  },
  defautLabel: { fontSize: 9, color: colors.text },
  defautCount: { fontSize: 9, color: colors.text, fontWeight: 700 },
  defautsWrap: { marginBottom: 14 },

  obs: {
    backgroundColor: colors.bgMuted,
    borderRadius: 3,
    padding: 8,
    marginBottom: 14,
  },
  // No italic face is registered for Lato (MalterreDocument registers 300/400/
  // 700/900 uprights only) — muted color carries the "annotation" tone instead.
  obsText: { fontSize: 9, color: colors.muted },
})

// ── Component ─────────────────────────────────────────────

function IdentityCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.identityCell}>
      <Text style={styles.identityLabel}>{label}</Text>
      <Text style={styles.identityValue}>{value || '—'}</Text>
    </View>
  )
}

export function RapportFreintePdf({ data }: { data: RapportFreinteData }) {
  const totalPremier = data.ofs.reduce((s, o) => s + o.premier_choix, 0)
  const totalSecond = data.ofs.reduce((s, o) => s + o.second_choix, 0)
  return (
    <MalterreDocument
      documentType="Rapport de freinte"
      reference={`Lot ${data.lot}`}
      documentDate={data.date_edition}
      title={`Rapport de freinte - Lot ${data.lot}`}
      issuer={companyTrm}
    >
      {/* Lot identity */}
      <View style={styles.identity}>
        <IdentityCell label="Référence fil" value={data.ref_fil} />
        <IdentityCell label="Coloris" value={data.colori_reference} />
        <IdentityCell label="Client" value={data.client_nom} />
        <IdentityCell label="Fournisseur" value={data.fournisseur_nom} />
        <IdentityCell label="Lot fournisseur" value={data.lot_frs} />
        <IdentityCell label="Date d'entrée" value={data.date_entree} />
      </View>

      {/* OF consumption table */}
      <Text style={styles.sectionTitle}>Ordres de fabrication</Text>
      {data.ofs.length === 0 ? (
        <Text style={[styles.statDetail, { marginBottom: 14 }]}>
          Aucun ordre de fabrication n'a consommé ce lot.
        </Text>
      ) : (
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, styles.colOf]}>OF</Text>
            <Text style={[styles.th, styles.colRef]}>Référence écru</Text>
            <Text style={[styles.th, styles.colKg, { textAlign: 'right' }]}>1er choix</Text>
            <Text style={[styles.th, styles.colKg, { textAlign: 'right' }]}>2nd choix</Text>
            <Text style={[styles.th, styles.colKg, { textAlign: 'right' }]}>Total</Text>
          </View>
          {data.ofs.map((o) => (
            <View key={o.of} style={styles.tableRow}>
              <Text style={[styles.td, styles.colOf]}>{o.of}</Text>
              <Text style={[styles.td, styles.colRef]}>{o.ref_ecru || '—'}</Text>
              <Text style={[styles.tdNum, styles.colKg]}>{fmtKg(o.premier_choix)}</Text>
              <Text style={[styles.tdNum, styles.colKg]}>{fmtKg(o.second_choix)}</Text>
              <Text style={[styles.tdNum, styles.colKg]}>{fmtKg(o.premier_choix + o.second_choix)}</Text>
            </View>
          ))}
          <View style={styles.totalRow}>
            <Text style={[styles.totalCell, styles.colOf]}>Somme</Text>
            <Text style={[styles.totalCell, styles.colRef]}></Text>
            <Text style={[styles.totalCellNum, styles.colKg]}>{fmtKg(totalPremier)}</Text>
            <Text style={[styles.totalCellNum, styles.colKg]}>{fmtKg(totalSecond)}</Text>
            <Text style={[styles.totalCellNum, styles.colKg]}>{fmtKg(totalPremier + totalSecond)}</Text>
          </View>
        </View>
      )}

      {/* Incorporations — printed only when there are any, since 33 lots out
          of ~1.7k carry one. The weight is declared by the régleur on the OF,
          not weighed, so it gets its own table and its own caption rather than
          being merged into the OF consumption above. */}
      {data.incorpore.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Fil incorporé</Text>
          <View style={styles.table}>
            <View style={styles.tableHeader}>
              <Text style={[styles.th, styles.colOf]}>OF</Text>
              <Text style={[styles.th, styles.colRef]}>Référence écru</Text>
              <Text style={[styles.th, styles.colKg, { textAlign: 'right' }]}>Poids</Text>
            </View>
            {data.incorpore.map((i, idx) => (
              <View key={`${i.of}-${idx}`} style={styles.tableRow}>
                <Text style={[styles.td, styles.colOf]}>{i.of}</Text>
                <Text style={[styles.td, styles.colRef]}>{i.ref_ecru || '—'}</Text>
                <Text style={[styles.tdNum, styles.colKg]}>{fmtKg(i.poids)}</Text>
              </View>
            ))}
            <View style={styles.totalRow}>
              <Text style={[styles.totalCell, styles.colOf]}>Somme</Text>
              <Text style={[styles.totalCell, styles.colRef]}></Text>
              <Text style={[styles.totalCellNum, styles.colKg]}>{fmtKg(data.incorpore_total)}</Text>
            </View>
          </View>
          <Text style={[styles.statDetail, { marginBottom: 14 }]}>
            Poids déclaré au lancement de l'OF, compté comme consommé : la freinte
            ci-dessous en est déduite.
          </Text>
        </>
      )}

      {/* Freinte + second choix stats */}
      <View style={styles.statsRow} wrap={false}>
        <View style={styles.statBox}>
          <Text style={styles.statLabel}>Freinte de tricotage</Text>
          <Text style={styles.statDetail}>
            {fmtKg(data.freinte_kg)} / {fmtKg(data.stock_initial)}
          </Text>
          <Text style={[styles.statValue, { color: freinteColor(data.freinte_pct) }]}>
            {fmtPct(data.freinte_pct)}
          </Text>
        </View>
        <View style={styles.statBoxSpacer} />
        <View style={styles.statBox}>
          <Text style={styles.statLabel}>Second choix</Text>
          <Text style={styles.statDetail}>
            {fmtKg(totalSecond)} / {fmtKg(totalPremier + totalSecond)}
          </Text>
          <Text style={[styles.statValue, { color: secondChoixColor(data.second_choix_pct) }]}>
            {fmtPct(data.second_choix_pct)}
          </Text>
        </View>
      </View>

      {/* Defects verdict */}
      <Text style={styles.sectionTitle}>Défauts relevés au visitage</Text>
      {data.defauts.length === 0 ? (
        <Text style={styles.defautsNone}>Aucun défaut</Text>
      ) : (
        <View style={styles.defautsWrap}>
          {data.defauts.map((d, i) => (
            <View key={i} style={styles.defautRow}>
              <Text style={styles.defautLabel}>{d.label}</Text>
              <Text style={styles.defautCount}>×{d.nombre}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Observation */}
      {data.observation_freinte ? (
        <View style={styles.obs}>
          <Text style={styles.obsText}>{data.observation_freinte}</Text>
        </View>
      ) : null}
    </MalterreDocument>
  )
}
