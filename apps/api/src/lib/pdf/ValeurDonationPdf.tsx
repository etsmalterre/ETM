// PDF document for "Calcul de la valeur" — the cost valuation of the stock
// pieces attached to a donation commande client. Ports the legacy WinDev report
// ETAT_ValeurDonation (DON<numero>.pdf) to the ETM document language:
// one block per piece (a banded header carrying the reference · coloris, the
// piece number and its Poids / Prix /kg / Prix total, then the cost lines that
// make up that €/kg — yarn lots first, production operations after).
//
// The figures come from buildDonationValeurData (apps/api/src/lib/donation-valeur.ts);
// this file only formats them. "?" marks a component the data can't price, in
// which case the piece has no valeur and is left out of the total — same as
// legacy.

import React from 'react'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'
import { View, Text, StyleSheet, Image } from '@react-pdf/renderer'
import { MalterreDocument } from './MalterreDocument.js'
import { colors, sizes } from './theme.js'
import { roundEuro, type DonationValeurPdfData, type DvLine, type DvPiece } from '../donation-valeur.js'

function fmtNum(value: number | null | undefined, decimals = 0): string {
  if (value == null || Number.isNaN(value)) return ''
  return value
    .toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace(/ | /g, ' ')
}

/** Cents-rounded before formatting so the printed figures add up the way the
 *  legacy report's do (see roundEuro). */
function fmtEur(v: number | null): string {
  return v === null ? '?' : `${fmtNum(roundEuro(v), 2)} €`
}
function fmtPrixKg(v: number | null): string {
  return v === null ? '?' : `${fmtNum(roundEuro(v), 2)} €/kg`
}
function fmtKg(v: number | null, decimals = 2): string {
  return v === null ? '?' : `${fmtNum(v, decimals)} kg`
}

// ── Piece-kind icons ──────────────────────────────────────
// The app's standard roll icons: outlined roll = écru / tombé de métier
// (TmRollIcon), filled roll = fini (FiniRollIcon). Same artwork the screens use
// (apps/web/public/icons/{tm,fini}.png), downscaled to 64px-tall RGBA copies in
// the API's assets so the PDF stays small. Loaded once — @react-pdf embeds one
// copy per distinct source.
const __filename = fileURLToPath(import.meta.url)
const ICONS = path.resolve(path.dirname(__filename), '../../assets/icons')
// Data URIs, not Buffers: @react-pdf caches decoded images by `src` identity,
// and a stable string means the artwork is embedded ONCE however many pieces
// the donation has (a Buffer src re-embeds per <Image>). A bare file path does
// NOT work — it renders nothing, silently.
function iconDataUri(file: string): string {
  return `data:image/png;base64,${fs.readFileSync(path.join(ICONS, file)).toString('base64')}`
}
const TM_ROLL_SRC = iconDataUri('tm.png')
const FINI_ROLL_SRC = iconDataUri('fini.png')

// ── Column geometry ───────────────────────────────────────
// Shared by the piece header band and its cost lines so the three numeric
// columns line up down the whole document.
const COL_POIDS = 62
const COL_PRIX_KG = 62
const COL_TOTAL = 68
const COL_LOT = 88
const COL_CMD = 104

const styles = StyleSheet.create({
  intro: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  introTitle: { fontSize: sizes.fontMd, color: colors.primary, fontWeight: 900, lineHeight: 1.2 },
  introMeta: { fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, lineHeight: 1.2 },

  piece: { marginBottom: 12 },

  // Header band: icon · reference · piece number · the three figures.
  pieceHeader: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: colors.bgMuted,
    borderTopWidth: 0.75,
    borderTopColor: colors.borderStrong,
    borderTopStyle: 'solid',
    borderBottomWidth: 2,
    borderBottomColor: colors.gold,
    borderBottomStyle: 'solid',
  },
  pieceHeaderIdentity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  // The roll artwork is ~1.7:1 — a fixed width with objectFit keeps both icons
  // optically the same size whatever their exact ratio.
  pieceIcon: { width: 16, height: 11, objectFit: 'contain' },
  // paddingRight keeps a long reference · coloris off the piece number, which
  // never shrinks (react-pdf has no truncation — the label wraps instead).
  pieceRef: { fontSize: sizes.fontMd, color: colors.text, fontWeight: 900, lineHeight: 1.2, flex: 1, paddingRight: 8 },
  pieceNumero: { fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, lineHeight: 1.2, flexShrink: 0 },

  // One stacked label/value cell per figure, separated by hairlines.
  figureCell: {
    borderLeftWidth: 0.75,
    borderLeftColor: colors.borderStrong,
    borderLeftStyle: 'solid',
    paddingHorizontal: 6,
    paddingVertical: 4,
    justifyContent: 'center',
  },
  figureLabel: {
    fontSize: sizes.fontXs,
    color: colors.muted,
    fontWeight: 700,
    letterSpacing: 0.4,
    textAlign: 'right',
    lineHeight: 1,
    marginBottom: 2,
  },
  figureValue: {
    fontSize: sizes.fontMd,
    color: colors.text,
    fontWeight: 900,
    textAlign: 'right',
    lineHeight: 1.15,
  },
  figureValueTotal: {
    fontSize: sizes.fontMd,
    color: colors.primary,
    fontWeight: 900,
    textAlign: 'right',
    lineHeight: 1.15,
  },

  // Cost lines
  lines: { paddingTop: 3 },
  line: { flexDirection: 'row', alignItems: 'center', paddingVertical: 1.5, paddingHorizontal: 8 },
  // paddingRight so a long treatment name ("Blanchissement Simple Teinture")
  // keeps a gap before the date column instead of butting against it.
  lineLabel: { flex: 1, fontSize: sizes.fontBase, color: colors.text, lineHeight: 1.25, paddingRight: 6 },
  lineDetail: { width: COL_LOT, fontSize: sizes.fontBase, color: colors.muted, lineHeight: 1.25 },
  lineDetail2: { width: COL_CMD, fontSize: sizes.fontBase, color: colors.muted, lineHeight: 1.25 },
  lineNum: {
    fontSize: sizes.fontBase,
    color: colors.text,
    textAlign: 'right',
    lineHeight: 1.25,
    paddingRight: 6,
  },

  // Document total — right-aligned recap band (§38.2 financial-doc language).
  totalWrap: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 6 },
  totalBox: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '45%',
    backgroundColor: colors.bgTotal,
    borderTopWidth: 2,
    borderTopColor: colors.gold,
    borderTopStyle: 'solid',
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  totalLabel: { flex: 1, fontSize: sizes.fontLg, color: colors.primary, fontWeight: 900, lineHeight: 1.2 },
  totalValue: {
    fontSize: sizes.fontLg,
    color: colors.primary,
    fontWeight: 900,
    textAlign: 'right',
    lineHeight: 1.2,
    paddingRight: 6,
  },

  note: {
    fontSize: sizes.fontXs,
    color: colors.muted,
    lineHeight: 1.35,
    marginTop: 8,
  },
})

function CostLine({ line }: { line: DvLine }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{line.label || '—'}</Text>
      <Text style={styles.lineDetail}>{line.detail}</Text>
      <Text style={styles.lineDetail2}>{line.detail2}</Text>
      <Text style={[styles.lineNum, { width: COL_POIDS }]}>{fmtKg(line.poids)}</Text>
      <Text style={[styles.lineNum, { width: COL_PRIX_KG }]}>{fmtPrixKg(line.prixKg)}</Text>
      <Text style={[styles.lineNum, { width: COL_TOTAL }]}>{fmtEur(line.total)}</Text>
    </View>
  )
}

function PieceBlock({ piece }: { piece: DvPiece }) {
  return (
    // A piece and its lines read as one unit — keep them on the same page when
    // they fit (long compositions still wrap rather than overflow).
    <View style={styles.piece} wrap={piece.lines.length > 10} minPresenceAhead={60}>
      <View style={styles.pieceHeader}>
        <View style={styles.pieceHeaderIdentity}>
          <Image
            src={piece.kind === 'ecru' ? TM_ROLL_SRC : FINI_ROLL_SRC}
            style={styles.pieceIcon}
          />
          <Text style={styles.pieceRef}>{piece.refLabel || '—'}</Text>
          <Text style={styles.pieceNumero}>Pièce N° {piece.numero}</Text>
        </View>
        <View style={[styles.figureCell, { width: COL_POIDS + 12 }]}>
          <Text style={styles.figureLabel}>POIDS</Text>
          <Text style={styles.figureValue}>{fmtKg(piece.poids)}</Text>
        </View>
        <View style={[styles.figureCell, { width: COL_PRIX_KG + 12 }]}>
          <Text style={styles.figureLabel}>PRIX /KG</Text>
          <Text style={styles.figureValue}>{fmtPrixKg(piece.prixKg)}</Text>
        </View>
        <View style={[styles.figureCell, { width: COL_TOTAL + 12 }]}>
          <Text style={styles.figureLabel}>PRIX TOTAL</Text>
          <Text style={styles.figureValueTotal}>{fmtEur(piece.total)}</Text>
        </View>
      </View>
      <View style={styles.lines}>
        {piece.lines.map((l, i) => <CostLine key={i} line={l} />)}
      </View>
    </View>
  )
}

export function ValeurDonationPdf({ data }: { data: DonationValeurPdfData }) {
  const nbPieces = data.pieces.length
  const hasUnpriced = data.pieces.some((p) => p.total === null)
  return (
    <MalterreDocument
      documentType="Calcul de la valeur"
      reference={`Donation N° ${data.numero}`}
      documentDate={data.dateLong}
      title={`Calcul de la valeur - Donation ${data.numero}`}
    >
      <View style={styles.intro}>
        <Text style={styles.introTitle}>{data.clientNom || 'Donation'}</Text>
        <Text style={styles.introMeta}>
          {nbPieces} pièce{nbPieces > 1 ? 's' : ''}
        </Text>
      </View>

      {data.pieces.map((p, i) => <PieceBlock key={i} piece={p} />)}

      {nbPieces === 0 ? (
        <Text style={styles.note}>Aucune pièce n'est rattachée à cette donation.</Text>
      ) : null}

      <View style={styles.totalWrap} wrap={false}>
        <View style={styles.totalBox}>
          <Text style={styles.totalLabel}>Valeur Total</Text>
          <Text style={styles.totalValue}>{fmtNum(data.totalValeur, 2)} €</Text>
        </View>
      </View>

      {hasUnpriced ? (
        <Text style={styles.note}>
          Les valeurs marquées « ? » n'ont pas pu être calculées : un composant de la référence
          n'a pas de lot de fil affecté, ou le lot affecté n'a pas de prix d'achat. Les pièces
          concernées ne sont pas comptées dans la valeur totale.
        </Text>
      ) : null}
    </MalterreDocument>
  )
}
