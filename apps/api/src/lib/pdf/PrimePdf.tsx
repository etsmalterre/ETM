// Production prime PDF — printable state of the TRM Production › Prime screen:
// semester production blocks (1er / 2nd choix / retour client), the current
// week, and the per-bonnetier répartition. Rendered inside the shared
// MalterreDocument frame with the Tricotage Malterre identity (the prime is a
// TRM document — its footer must carry TRM's SIRET / TVA, not ETS Malterre's).

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import { MalterreDocument, CalendarIcon } from './MalterreDocument.js'
import { colors, companyTrm, sizes } from './theme.js'
import type { PrimePayload } from '../../routes/prime-trm.js'

export interface PrimePdfData {
  payload: PrimePayload
  /** Long-form print date for the header, e.g. "24 Août 2026" */
  printedDate: string
}

// ── French number formatting (plain spaces — the default PDF font has no
// narrow no-break space glyph) ────────────────────────────

function fmtKg(v: number): string {
  const rounded = Math.round(v)
  return `${rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} kg`
}

function fmtEur(v: number): string {
  const abs = Math.abs(v)
  const [int, dec] = abs.toFixed(2).split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${v < 0 ? '-' : ''}${grouped},${dec} €`
}

/** A barème rate, €/Kg.
 *
 * ⚠️ Two decimals are NOT enough. The barème runs to a tenth of a centime since
 * S2 2026 (+0,055 €/Kg on the 1er choix), so a fixed toFixed(2) printed
 * « +0,06 €/Kg » — a rate nobody is paid, on the document that pays it. The
 * third decimal appears only when it carries something: -0,40 and -0,60 still
 * read with two.
 */
function fmtTaux(v: number): string {
  const cents = v * 100
  const decimals = Math.abs(cents - Math.round(cents)) < 1e-9 ? 2 : 3
  const s = Math.abs(v).toFixed(decimals).replace('.', ',')
  return `${v >= 0 ? '+' : '-'}${s} €/Kg`
}

function fmtShortDate(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(2).replace('.', ',')} %`
}

/** kg with one decimal, for the per-type breakdown rows. */
function fmtKg1(v: number): string {
  const [int, dec] = Math.abs(v).toFixed(1).split('.')
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${dec} kg`
}

// ── Styles ───────────────────────────────────────────────

const styles = StyleSheet.create({
  periodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 12,
  },
  periodeIconBox: {
    width: 12,
    height: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  periodeLabel: {
    fontSize: sizes.fontMd,
    fontWeight: 900,
    color: colors.text,
  },

  sectionTitle: {
    fontSize: sizes.fontSm,
    fontWeight: 900,
    color: colors.primary,
    letterSpacing: 0.6,
    marginBottom: 5,
  },
  sectionGap: {
    marginTop: 16,
  },

  table: {
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderRadius: 4,
    overflow: 'hidden',
  },
  headRow: {
    flexDirection: 'row',
    backgroundColor: colors.bgMuted,
    borderBottomWidth: 0.75,
    borderBottomColor: colors.borderStrong,
    borderBottomStyle: 'solid',
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
    borderBottomStyle: 'solid',
  },
  rowAlt: {
    backgroundColor: '#FAFAFA',
  },
  totalRow: {
    flexDirection: 'row',
    backgroundColor: colors.bgTotal,
    borderTopWidth: 0.75,
    borderTopColor: colors.borderStrong,
    borderTopStyle: 'solid',
  },

  headCell: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    fontSize: sizes.fontSm,
    fontWeight: 900,
    color: colors.primary,
  },
  cell: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    fontSize: sizes.fontBase,
    color: colors.text,
  },
  cellStrong: {
    fontWeight: 700,
  },
  cellMuted: {
    color: colors.muted,
  },
  right: {
    textAlign: 'right',
  },
  negative: {
    color: '#B91C1C',
  },
  positive: {
    color: '#15803D',
  },

  colLibelle: { flex: 2.2 },
  colTaux: { flex: 1 },
  colProd: { flex: 1.2 },
  colMontant: { flex: 1.2 },

  colBonnetier: { flex: 2.2 },
  colJours: { flex: 1 },
  colPart: { flex: 1.2 },

  totalLabel: {
    paddingVertical: 7,
    paddingHorizontal: 8,
    fontSize: sizes.fontBase,
    fontWeight: 900,
    color: colors.primary,
  },
  totalValue: {
    paddingVertical: 7,
    paddingHorizontal: 8,
    fontSize: sizes.fontMd,
    fontWeight: 900,
  },

  tauxLine: {
    fontSize: sizes.fontBase,
    color: colors.text,
    marginBottom: 5,
  },
  tauxStrong: {
    fontWeight: 900,
    color: colors.primary,
  },

  mention: {
    marginTop: 'auto',
    paddingTop: 12,
    fontSize: sizes.fontSm,
    color: colors.muted,
    textAlign: 'center',
    letterSpacing: 0.3,
  },
})

// ── Production block table (semester + week share the shape) ──────────────

interface BlocRow {
  libelle: string
  taux: number
  kg: number
  montant: number
}

function ProductionTable({ rows, total }: { rows: BlocRow[]; total: number }) {
  return (
    <View style={styles.table}>
      <View style={styles.headRow}>
        <Text style={[styles.headCell, styles.colLibelle]}>Production</Text>
        <Text style={[styles.headCell, styles.colTaux, styles.right]}>Barème</Text>
        <Text style={[styles.headCell, styles.colProd, styles.right]}>Poids</Text>
        <Text style={[styles.headCell, styles.colMontant, styles.right]}>Montant</Text>
      </View>
      {rows.map((r, i) => (
        <View key={r.libelle} style={i % 2 === 1 ? [styles.row, styles.rowAlt] : styles.row}>
          <Text style={[styles.cell, styles.cellStrong, styles.colLibelle]}>{r.libelle}</Text>
          <Text style={[styles.cell, styles.cellMuted, styles.colTaux, styles.right]}>{fmtTaux(r.taux)}</Text>
          <Text style={[styles.cell, styles.colProd, styles.right]}>{fmtKg(r.kg)}</Text>
          <Text
            style={[
              styles.cell,
              styles.cellStrong,
              styles.colMontant,
              styles.right,
              r.montant < 0 ? styles.negative : r.montant > 0 ? styles.positive : {},
            ]}
          >
            {fmtEur(r.montant)}
          </Text>
        </View>
      ))}
      <View style={styles.totalRow}>
        <Text style={[styles.totalLabel, styles.colLibelle]}>TOTAL</Text>
        <Text style={[styles.totalValue, styles.colTaux]} />
        <Text style={[styles.totalValue, styles.colProd]} />
        <Text
          style={[
            styles.totalValue,
            styles.colMontant,
            styles.right,
            total < 0 ? styles.negative : styles.positive,
          ]}
        >
          {fmtEur(total)}
        </Text>
      </View>
    </View>
  )
}

// ── Component ────────────────────────────────────────────

export function PrimePdf({ data }: { data: PrimePdfData }) {
  const p = data.payload
  const blocRows = (b: typeof p.semestre): BlocRow[] => [
    { libelle: 'Production 1er Choix', taux: p.taux.premierChoix, kg: b.premierChoix.kg, montant: b.premierChoix.montant },
    { libelle: 'Production 2nd Choix', taux: p.taux.secondChoix, kg: b.secondChoix.kg, montant: b.secondChoix.montant },
    { libelle: 'Retour client', taux: p.taux.retourClient, kg: b.retourClient.kg, montant: b.retourClient.montant },
  ]

  return (
    <MalterreDocument
      documentType="Prime de production"
      reference={p.periode.label}
      documentDate={data.printedDate}
      title={`Prime de production — ${p.periode.label}`}
      issuer={companyTrm}
    >
      {/* Période */}
      <View style={styles.periodeRow}>
        <View style={styles.periodeIconBox}>
          <CalendarIcon size={11} />
        </View>
        <Text style={styles.periodeLabel}>
          Période du {fmtShortDate(p.periode.debut)} au {fmtShortDate(p.periode.fin)}
        </Text>
      </View>

      {/* Semester block — the header band already names the semester */}
      <Text style={styles.sectionTitle}>PRODUCTION DU SEMESTRE</Text>
      <ProductionTable rows={blocRows(p.semestre)} total={p.semestre.total} />

      {/* Déclassements 2nd choix — defect-type breakdown (mirrors the screen) */}
      {p.declassements.kg > 0 ? (
        <>
          <Text style={[styles.sectionTitle, styles.sectionGap]}>DÉCLASSEMENTS 2ND CHOIX</Text>
          <Text style={styles.tauxLine}>
            Taux de 2nd choix :{' '}
            <Text style={styles.tauxStrong}>
              {p.declassements.taux !== null ? fmtPct(p.declassements.taux) : '—'}
            </Text>{' '}
            ({fmtKg(p.declassements.kg)} sur {fmtKg(p.declassements.kgTotal)} produits)
            {p.declassements.comparaison.taux !== null
              ? `   ·   ${p.declassements.comparaison.label} : ${fmtPct(p.declassements.comparaison.taux)}`
              : ''}
          </Text>
          <View style={styles.table}>
            <View style={styles.headRow}>
              <Text style={[styles.headCell, styles.colLibelle]}>Type de défaut</Text>
              <Text style={[styles.headCell, styles.colTaux, styles.right]}>Pièces</Text>
              <Text style={[styles.headCell, styles.colProd, styles.right]}>Poids</Text>
              <Text style={[styles.headCell, styles.colProd, styles.right]}>Part</Text>
              <Text style={[styles.headCell, styles.colMontant, styles.right]}>Manque à gagner</Text>
            </View>
            {p.declassements.types.map((t, i) => (
              <View key={t.type} style={i % 2 === 1 ? [styles.row, styles.rowAlt] : styles.row} wrap={false}>
                <Text style={[styles.cell, styles.cellStrong, styles.colLibelle]}>{t.type}</Text>
                <Text style={[styles.cell, styles.cellMuted, styles.colTaux, styles.right]}>{t.pieces}</Text>
                <Text style={[styles.cell, styles.colProd, styles.right]}>{fmtKg1(t.kg)}</Text>
                <Text style={[styles.cell, styles.cellMuted, styles.colProd, styles.right]}>
                  {(t.pct * 100).toFixed(1).replace('.', ',')} %
                </Text>
                <Text style={[styles.cell, styles.cellStrong, styles.colMontant, styles.right, styles.negative]}>
                  -{fmtEur(t.montant)}
                </Text>
              </View>
            ))}
          </View>
        </>
      ) : null}

      {/* Current week block — only on the current semester (the week always
          describes the RUNNING week, meaningless under a past period) */}
      {p.periode.estCourante ? (
        <>
          <Text style={[styles.sectionTitle, styles.sectionGap]}>
            SEMAINE {p.semaine.numero} — DU {fmtShortDate(p.semaine.debut)} AU {fmtShortDate(p.semaine.fin)}
          </Text>
          <ProductionTable rows={blocRows(p.semaine)} total={p.semaine.total} />
        </>
      ) : null}

      {/* Répartition */}
      <Text style={[styles.sectionTitle, styles.sectionGap]}>RÉPARTITION PAR BONNETIER</Text>
      <View style={styles.table}>
        <View style={styles.headRow}>
          <Text style={[styles.headCell, styles.colBonnetier]}>Bonnetier</Text>
          <Text style={[styles.headCell, styles.colJours, styles.right]}>Jours</Text>
          <Text style={[styles.headCell, styles.colPart, styles.right]}>Montant</Text>
        </View>
        {p.repartition.map((r, i) => (
          <View
            key={r.IDbonnetier}
            style={i % 2 === 1 ? [styles.row, styles.rowAlt] : styles.row}
            wrap={false}
          >
            <Text style={[styles.cell, styles.cellStrong, styles.colBonnetier]}>
              {r.prenom} {r.nom}
            </Text>
            <Text style={[styles.cell, styles.colJours, styles.right]}>{r.jours} jours</Text>
            <Text
              style={[
                styles.cell,
                styles.cellStrong,
                styles.colPart,
                styles.right,
                r.montant < 0 ? styles.negative : styles.positive,
              ]}
            >
              {fmtEur(r.montant)}
            </Text>
          </View>
        ))}
        <View style={styles.totalRow}>
          <Text style={[styles.totalLabel, styles.colBonnetier]}>TOTAL</Text>
          <Text style={[styles.totalValue, styles.colJours, styles.right, { fontSize: sizes.fontBase }]}>
            {p.joursTotal} jours
          </Text>
          <Text
            style={[
              styles.totalValue,
              styles.colPart,
              styles.right,
              p.semestre.total < 0 ? styles.negative : styles.positive,
            ]}
          >
            {fmtEur(p.semestre.total)}
          </Text>
        </View>
      </View>

      <Text style={styles.mention}>
        Retour client : {fmtTaux(p.taux.retourClient)} — aucun retour comptabilisé sur la période
      </Text>
    </MalterreDocument>
  )
}
