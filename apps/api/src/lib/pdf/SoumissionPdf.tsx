// PDF document for a « Soumission étude coloris » (proposal of coloris samples
// sent to a client). Reuses MalterreDocument so the branding stays aligned with
// the rest of the MPS documents. Named in full since #1388: « Soumission »
// alone was also what the LOT soumissions are called (SoumissionLotPdf).
//
// The main area is a grid of up to four dashed placeholders where the
// employee staples the physical samples before handing the paper off to
// the client. Placeholder count and numbering are driven by the
// soumission's observation field ("1-2" → two placeholders numbered 1 & 2;
// "4-5-6" → three placeholders numbered 4, 5, 6).

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import {
  MalterreDocument,
  type AddressBlockData,
  type MetadataCardData,
} from './MalterreDocument.js'
import { colors, sizes } from './theme.js'

// ── Input shape ──────────────────────────────────────────

export interface SoumissionPdfData {
  numero: string
  dateDocument: string              // long-form French, e.g. "14 avril 2026"
  clientNom: string | null
  /** People at the client the samples are for (« Prénom Nom »): the contacts
   *  ticked « Soumission étude coloris » (lib/destinataires-etude-coloris.ts). */
  destinataires?: readonly string[]
  clientAdresse: {
    nom: string | null
    adresse1: string | null
    adresse2: string | null
    adresse3: string | null
    cp: string | null
    ville: string | null
    pays: string | null
  } | null
  refFini: string | null
  codeClient: string | null         // étude's desig_client (e.g. "0593 LILAS")
  codeMalterre: string | null       // ref_fini_colori.reference (full coloris name)
  /** Numbers driving the placeholder grid, parsed from soumission.observation.
   *  Up to 4 entries are rendered; more are truncated. */
  sampleNumbers: number[]
}

// ── Styles ───────────────────────────────────────────────

const styles = StyleSheet.create({
  // Sample grid — fills the remaining vertical space so it ends just
  // above the footer. Always a 2-column grid so 1-2 samples sit on one
  // row and 3-4 samples sit on two rows at consistent cell sizes.
  sampleGrid: {
    flexGrow: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'stretch',
    gap: 10,
  },
  sampleCell: {
    // 2-column layout: roughly 50% minus the row gap. @react-pdf's
    // flex-wrap doesn't respect gap when computing width, so we hardcode
    // a width that leaves room for the gap.
    width: '49%',
    minHeight: 120,
    borderWidth: 1.25,
    borderColor: colors.borderStrong,
    borderStyle: 'dashed',
    borderRadius: 8,
    backgroundColor: colors.bgTotal,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    position: 'relative',
  },
  sampleCellSingle: {
    // Single-sample layout gets the full width.
    width: '100%',
    flexGrow: 1,
  },
  sampleNumberBadge: {
    position: 'absolute',
    top: 8,
    left: 10,
    fontSize: sizes.fontLg,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.6,
  },
  samplePrimary: {
    fontSize: sizes.fontLg,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.6,
    textAlign: 'center',
    marginBottom: 4,
  },
  sampleSecondary: {
    fontSize: sizes.fontSm,
    color: colors.muted,
    textAlign: 'center',
  },
})

// ── Helpers ──────────────────────────────────────────────

export function buildClientAddress(data: SoumissionPdfData): AddressBlockData {
  const a = data.clientAdresse
  // The people the samples are for, as the block's strong line, above the
  // company and its address (#1388). Nobody ticked = the address alone.
  const personnes = (data.destinataires ?? []).map((p) => p.trim()).filter(Boolean)
  const dejaNommee = new Set(personnes.map((p) => p.toLowerCase()))
  const lines: string[] = []
  if (a) {
    if (a.nom) lines.push(a.nom)
    if (a.adresse1) lines.push(a.adresse1)
    if (a.adresse2) lines.push(a.adresse2)
    if (a.adresse3) lines.push(a.adresse3)
    const cityLine = [a.cp, a.ville].filter(Boolean).join(' ')
    if (cityLine) lines.push(cityLine)
    if (a.pays) lines.push(a.pays)
  }
  return {
    title: 'À l\'attention de',
    name: personnes.join(', '),
    // Until the tick existed the person was typed in the address itself
    // (« Judy SUBRYAN » as its first line): never print her twice.
    lines: lines.length > 0 ? lines.filter((l) => !dejaNommee.has(l.trim().toLowerCase())) : [data.clientNom || '—'],
    icon: 'user',
  }
}

function buildInfoCard(data: SoumissionPdfData): MetadataCardData {
  return {
    title: 'Informations',
    items: [
      { icon: 'calendar', label: 'Date', value: data.dateDocument || '—' },
      { icon: 'tag', label: 'Référence fini', value: data.refFini || '—' },
      { icon: 'user', label: 'Code client', value: data.codeClient || '—' },
      { icon: 'factory', label: 'Code Malterre', value: data.codeMalterre || '—' },
    ],
  }
}

// ── Component ────────────────────────────────────────────

export function SoumissionPdf({ data }: { data: SoumissionPdfData }) {
  const clientAddress = buildClientAddress(data)
  const infoCard = buildInfoCard(data)

  // Cap to 4 placeholders per the product spec.
  const samples = data.sampleNumbers.slice(0, 4)
  const isSingle = samples.length === 1

  return (
    <MalterreDocument
      documentType="Soumission étude coloris"
      reference={`N°${data.numero}`}
      documentDate={data.dateDocument || ''}
      topLeftAddress={clientAddress}
      topRightInfo={infoCard}
      title={`Soumission étude coloris ${data.numero}`}
    >
      <View style={styles.sampleGrid}>
        {samples.length === 0 ? (
          <View style={[styles.sampleCell, styles.sampleCellSingle]}>
            <Text style={styles.samplePrimary}>ÉCHANTILLON</Text>
            <Text style={styles.sampleSecondary}>
              Agrafer l'échantillon dans cet espace
            </Text>
          </View>
        ) : samples.map((num, i) => (
          <View
            key={`${num}-${i}`}
            style={isSingle ? [styles.sampleCell, styles.sampleCellSingle] : styles.sampleCell}
          >
            <Text style={styles.sampleNumberBadge}>N° {num}</Text>
            <Text style={styles.samplePrimary}>ÉCHANTILLON</Text>
            <Text style={styles.sampleSecondary}>
              Agrafer l'échantillon dans cet espace
            </Text>
          </View>
        ))}
      </View>
    </MalterreDocument>
  )
}

/** Parse a soumission observation string like "1-2" or "4-5-6" into an
 *  array of integers. Accepts separators: dash, slash, comma, whitespace.
 *  Dedupes consecutive duplicates and drops non-positive integers. */
export function parseSampleNumbers(observation: string | null | undefined): number[] {
  if (!observation) return []
  const tokens = observation.split(/[\s,\-/]+/).filter(Boolean)
  const out: number[] = []
  for (const t of tokens) {
    const n = parseInt(t, 10)
    if (!Number.isNaN(n) && n > 0) out.push(n)
  }
  return out
}
