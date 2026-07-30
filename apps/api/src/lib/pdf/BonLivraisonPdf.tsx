// PDF document for a client shipment ("Avis d'expédition" / Bon de livraison),
// rendered inside the shared MalterreDocument frame. Ports the legacy WinDev
// "AVIS D'EXPEDITION" report (see BL 11645 reference) to the ETM design
// language:
//  - top row: delivery address card + shipment metadata card (client,
//    référence client, n° commande, transporteur, contact)
//  - the two fixed legacy quality notices (lots/métiers/passes warning +
//    charte france tissus maille), plus the free-text observation_bl
//  - one section per shipped article: article identity block (ref - coloris,
//    designation, finition, V/réf. client) then one framed table per lot
//    (pièce · poids · métrage · observations) with a per-lot totals row,
//    a per-article totals line, and a gold grand-total box for the whole avis.
// The Observations column follows expedition.affiche_observations, like legacy.

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import {
  MalterreDocument,
  AddressCard,
  UserIcon,
  MessageSquareIcon,
  TagIcon,
  TruckIcon,
  type AddressBlockData,
} from './MalterreDocument.js'
import { colors, sizes } from './theme.js'

interface AddrLite {
  nom: string | null
  adresse1: string | null
  adresse2: string | null
  adresse3: string | null
  cp: string | null
  ville: string | null
  pays: string | null
}

export interface BlPiece {
  numero: string
  poids: number
  metrage: number
  observations: string | null
}

export interface BlLot {
  lot: string
  pieces: BlPiece[]
}

export interface BlArticle {
  /** "227A - 0612 marine pant. 19-3922 TCX 63052/1" (ref · coloris) */
  titre: string
  /** "Jersey cot/elast - 0612 marine pant. …" (designation · coloris) */
  sousTitre: string | null
  /** "OUVERT AU LARGE" / "TUBULAIRE …" — legacy gtaFinition enum label */
  finition: string | null
  /** Client-side article reference → "V/réf. : 227A" */
  refClientArticle: string | null
  lots: BlLot[]
}

export interface BonLivraisonPdfData {
  /** The expedition id — the BL number IS the PK (no numero column). */
  numero: number
  /** "17 mars 2026" — long-form French. */
  dateLong: string
  clientNom: string
  refClient: string | null
  commandeNumero: number | null
  transporteurNom: string | null
  contactNom: string | null
  donation: boolean
  /** expedition.affiche_observations — toggles the Observations column. */
  showObservations: boolean
  observationBl: string | null
  adresseLivraison: AddrLite | null
  articles: BlArticle[]
}

// Fixed legacy notice texts — printed verbatim on every avis d'expédition.
const NOTICE_ATTENTION =
  "ATTENTION : NE PAS MELANGER EN FABRICATION DES LIVRAISONS PORTANT DES N° DE LOTS DIFFERENTS, " +
  'DES LIVRAISONS TRICOTES SUR DES METIERS DIFFERENTS, OU DES N° DE PASSES DE TEINTURE DIFFERENTS.'
const NOTICE_CHARTE =
  "D'une façon générale et par défaut de dispositions spécifiques, nous nous référons à la charte " +
  'france tissus maille pour la gestion de notre système qualité.'

function fmtNum(value: number | null | undefined, decimals = 2): string {
  if (value == null || Number.isNaN(value)) return ''
  return value
    .toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace(/ | /g, ' ')
}

const styles = StyleSheet.create({
  topRow: { flexDirection: 'row', gap: 14, marginBottom: 14, alignItems: 'stretch' },
  topRowSlot: { flex: 1, flexDirection: 'column' },

  // Metadata card — like MalterreDocument's MetadataCard but with wrapping
  // values (Référence client can be a full sentence).
  metaCard: {
    flexGrow: 1,
    backgroundColor: colors.bgCream,
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderLeftWidth: 2,
    borderLeftColor: colors.gold,
    borderLeftStyle: 'solid',
    borderRadius: 6,
    padding: 10,
  },
  // Tight explicit lineHeight — rows otherwise inherit the body's 1.45 and
  // the top cards balloon vertically.
  metaRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 1.5 },
  metaIconBox: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  metaLabel: { width: 88, fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, lineHeight: 1.25 },
  metaValue: { flex: 1, fontSize: sizes.fontBase, color: colors.text, fontWeight: 700, textAlign: 'right', lineHeight: 1.25 },

  // Quality notices block
  notices: { marginBottom: 14 },
  noticeAttention: {
    fontSize: sizes.fontSm,
    color: colors.text,
    fontWeight: 900,
    lineHeight: 1.4,
    marginBottom: 5,
  },
  noticeCharte: { fontSize: sizes.fontSm, color: colors.muted, lineHeight: 1.4 },
  noticeObs: { fontSize: sizes.fontSm, color: colors.text, fontWeight: 700, lineHeight: 1.4, marginTop: 5 },

  // Article identity block
  article: { marginBottom: 14 },
  articleTitre: { fontSize: 11.5, color: colors.primary, fontWeight: 900, lineHeight: 1.35 },
  articleLine: { fontSize: 10.5, color: colors.text, lineHeight: 1.35 },
  articleFinition: { fontSize: 10.5, color: colors.text, fontWeight: 700, lineHeight: 1.35 },
  articleVref: { fontSize: 10.5, color: colors.muted, lineHeight: 1.35 },

  // Lot label + pieces table
  lotBlock: { marginTop: 8 },
  lotLabel: { fontSize: sizes.fontSm, color: colors.text, fontWeight: 900, marginBottom: 3, letterSpacing: 0.3 },
  table: {
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderRadius: 6,
    overflow: 'hidden',
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: colors.bgMuted,
    borderBottomWidth: 2,
    borderBottomColor: colors.gold,
    borderBottomStyle: 'solid',
    paddingVertical: 6,
    paddingHorizontal: 10,
    // Explicit height: the `fixed` repeat on continuation pages otherwise
    // stretches the header box, leaving a blank gap above the gold rule.
    height: 24,
  },
  // lineHeight must stay tight and explicit: with the inherited 1.45 the text
  // box overflows the fixed-height header and react-pdf drops the labels.
  tableHeaderCell: { fontSize: sizes.fontXs, color: colors.text, fontWeight: 900, letterSpacing: 0.5, lineHeight: 1.2 },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderBottomWidth: 0.75,
    borderBottomColor: '#EEEEEE',
    borderBottomStyle: 'solid',
    alignItems: 'flex-start',
  },
  cellBase: { fontSize: 10, color: colors.text, lineHeight: 1.2 },
  colPiece: { width: 110, paddingRight: 6 },
  colNum: { width: 70, textAlign: 'right', paddingHorizontal: 4 },
  colObs: { flex: 1, paddingLeft: 10 },
  // Widths when the Observations column is hidden — piece takes the slack.
  colPieceWide: { flex: 1, paddingRight: 6 },

  // Per-lot totals row (inside the table frame)
  lotTotalRow: {
    flexDirection: 'row',
    paddingVertical: 5,
    paddingHorizontal: 10,
    backgroundColor: colors.bgMuted,
    alignItems: 'center',
  },
  lotTotalLabel: { fontSize: 10, color: colors.text, fontWeight: 900 },
  lotTotalCell: { fontSize: 10, color: colors.text, fontWeight: 900 },

  // Per-article totals line
  articleTotal: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 18,
    marginTop: 6,
    paddingRight: 2,
  },
  articleTotalLabel: { fontSize: 10.5, color: colors.text, fontWeight: 900 },
  articleTotalValue: { fontSize: 10.5, color: colors.text, fontWeight: 700 },

  // Grand-total box (whole avis)
  grandWrapper: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 4 },
  grand: {
    width: '62%',
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderRadius: 6,
    overflow: 'hidden',
  },
  grandRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderTopWidth: 2,
    borderTopColor: colors.gold,
    borderTopStyle: 'solid',
    backgroundColor: colors.bgTotal,
  },
  grandLabel: { fontSize: sizes.fontBase, color: colors.primary, fontWeight: 900, letterSpacing: 0.4 },
  grandValue: { fontSize: sizes.fontBase, color: colors.primary, fontWeight: 900, textAlign: 'right' },
})

function buildDeliveryAddress(data: BonLivraisonPdfData): AddressBlockData {
  const a = data.adresseLivraison
  const lines: string[] = []
  // Legacy address columns can hold whitespace-only values — trim before the
  // emptiness check or they render as blank lines in the card.
  const clean = (v: string | null | undefined) => (v ?? '').trim()
  if (a) {
    if (clean(a.adresse1)) lines.push(clean(a.adresse1))
    if (clean(a.adresse2)) lines.push(clean(a.adresse2))
    if (clean(a.adresse3)) lines.push(clean(a.adresse3))
    const cityLine = [clean(a.cp), clean(a.ville)].filter(Boolean).join(' ')
    if (cityLine) lines.push(cityLine)
    if (clean(a.pays)) lines.push(clean(a.pays))
  }
  return { title: 'Adresse de livraison', name: clean(a?.nom) || data.clientNom, lines, icon: 'truck' }
}

function MetaRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <View style={styles.metaIconBox}>{icon}</View>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  )
}

function lotAgg(lot: BlLot): { nb: number; poids: number; metrage: number } {
  return {
    nb: lot.pieces.length,
    poids: lot.pieces.reduce((s, p) => s + (Number(p.poids) || 0), 0),
    metrage: lot.pieces.reduce((s, p) => s + (Number(p.metrage) || 0), 0),
  }
}

export function BonLivraisonPdf({ data }: { data: BonLivraisonPdfData }) {
  const showObs = data.showObservations
  const deliveryAddress = buildDeliveryAddress(data)

  const grand = data.articles
    .flatMap((a) => a.lots)
    .reduce(
      (acc, lot) => {
        const t = lotAgg(lot)
        return { nb: acc.nb + t.nb, poids: acc.poids + t.poids, metrage: acc.metrage + t.metrage }
      },
      { nb: 0, poids: 0, metrage: 0 },
    )

  return (
    <MalterreDocument
      // No accent on purpose — the uppercased É renders badly in the header font.
      documentType="Avis d'expedition"
      reference={`N°${data.numero}`}
      documentDate={data.dateLong || ''}
      title={`Avis d'expédition ${data.numero}`}
    >
      {/* Top row: delivery address + shipment metadata */}
      <View style={styles.topRow}>
        <View style={styles.topRowSlot}>
          <AddressCard data={deliveryAddress} stretch />
        </View>
        <View style={styles.topRowSlot}>
          <View style={styles.metaCard}>
            <MetaRow icon={<UserIcon />} label="Client" value={data.clientNom || '—'} />
            {data.refClient ? (
              <MetaRow icon={<MessageSquareIcon />} label="Réf. client" value={data.refClient} />
            ) : null}
            {/* Raw number — it's an identifier, no thousands separator. */}
            {data.commandeNumero != null ? (
              <MetaRow icon={<TagIcon />} label="N° commande" value={String(data.commandeNumero)} />
            ) : null}
            {data.transporteurNom ? (
              <MetaRow icon={<TruckIcon />} label="Transporteur" value={data.transporteurNom} />
            ) : null}
            {data.contactNom ? (
              <MetaRow icon={<UserIcon />} label="Contact" value={data.contactNom} />
            ) : null}
            {data.donation ? (
              <MetaRow icon={<TagIcon />} label="Donation" value="Oui" />
            ) : null}
          </View>
        </View>
      </View>

      {/* Fixed legacy quality notices + free-text BL observation */}
      <View style={styles.notices}>
        <Text style={styles.noticeAttention}>{NOTICE_ATTENTION}</Text>
        <Text style={styles.noticeCharte}>{NOTICE_CHARTE}</Text>
        {data.observationBl?.trim() ? (
          <Text style={styles.noticeObs}>{data.observationBl.trim()}</Text>
        ) : null}
      </View>

      {/* One section per shipped article */}
      {data.articles.map((article, ai) => {
        const articleTotal = article.lots.reduce(
          (acc, lot) => {
            const t = lotAgg(lot)
            return { nb: acc.nb + t.nb, poids: acc.poids + t.poids, metrage: acc.metrage + t.metrage }
          },
          { nb: 0, poids: 0, metrage: 0 },
        )
        return (
          <View key={ai} style={styles.article}>
            {/* Keep the article identity glued to the start of its first lot
                (label + header + a row) instead of stranding it at a page
                bottom — same "keep with next" semantics as the lot label. */}
            <View wrap={false} minPresenceAhead={100}>
              <Text style={styles.articleTitre}>{article.titre}</Text>
              {article.sousTitre ? <Text style={styles.articleLine}>{article.sousTitre}</Text> : null}
              {article.finition ? <Text style={styles.articleFinition}>{article.finition}</Text> : null}
              {article.refClientArticle ? (
                <Text style={styles.articleVref}>V/réf. : {article.refClientArticle}</Text>
              ) : null}
            </View>

            {article.lots.map((lot, li) => {
              const t = lotAgg(lot)
              const pieceRow = (p: BlPiece, pi: number) => (
                <View key={pi} style={styles.tableRow}>
                  <Text style={[styles.cellBase, showObs ? styles.colPiece : styles.colPieceWide]}>{p.numero || '—'}</Text>
                  <Text style={[styles.cellBase, styles.colNum]}>{fmtNum(p.poids)}</Text>
                  <Text style={[styles.cellBase, styles.colNum]}>{fmtNum(p.metrage)}</Text>
                  {showObs ? (
                    <Text style={[styles.cellBase, styles.colObs]}>{p.observations?.trim() || ''}</Text>
                  ) : null}
                </View>
              )
              return (
                // minPresenceAhead goes on the LABEL, not the block: react-pdf
                // pushes the whole element to the next page when less than N pt
                // of the NEXT sibling fits below it — on the block that blanked
                // out page bottoms whenever a lot fit snugly (BL 12112). On the
                // label it just keeps "Lot : …" glued to the header + ~2 rows.
                <View key={li} style={styles.lotBlock}>
                  <Text style={styles.lotLabel} minPresenceAhead={70}>{`Lot : ${lot.lot || '—'}`}</Text>
                  <View style={styles.table}>
                    <View style={styles.tableHeader} fixed>
                      <Text style={[styles.tableHeaderCell, showObs ? styles.colPiece : styles.colPieceWide]}>PIÈCE</Text>
                      <Text style={[styles.tableHeaderCell, styles.colNum]}>POIDS (KG)</Text>
                      <Text style={[styles.tableHeaderCell, styles.colNum]}>MÉTRAGE (ML)</Text>
                      {showObs ? <Text style={[styles.tableHeaderCell, styles.colObs]}>OBSERVATIONS</Text> : null}
                    </View>
                    {lot.pieces.slice(0, -1).map(pieceRow)}
                    {/* Last piece row + totals row are glued together so a page
                        break can never leave the total orphaned under a bare
                        repeated header. */}
                    <View wrap={false}>
                      {lot.pieces.length > 0 ? pieceRow(lot.pieces[lot.pieces.length - 1], lot.pieces.length - 1) : null}
                      <View style={styles.lotTotalRow}>
                        <Text style={[styles.lotTotalLabel, showObs ? styles.colPiece : styles.colPieceWide]}>
                          {`Total lot - ${t.nb} pièce${t.nb > 1 ? 's' : ''}`}
                        </Text>
                        <Text style={[styles.lotTotalCell, styles.colNum]}>{fmtNum(t.poids)}</Text>
                        <Text style={[styles.lotTotalCell, styles.colNum]}>{fmtNum(t.metrage)}</Text>
                        {showObs ? <Text style={styles.colObs} /> : null}
                      </View>
                    </View>
                  </View>
                </View>
              )
            })}

            {article.lots.length > 1 ? (
              <View style={styles.articleTotal} wrap={false}>
                <Text style={styles.articleTotalLabel}>Total article</Text>
                <Text style={styles.articleTotalValue}>{`${articleTotal.nb} pièce${articleTotal.nb > 1 ? 's' : ''}`}</Text>
                <Text style={styles.articleTotalValue}>{`${fmtNum(articleTotal.poids)} Kg`}</Text>
                <Text style={styles.articleTotalValue}>{`${fmtNum(articleTotal.metrage)} Ml`}</Text>
              </View>
            ) : null}
          </View>
        )
      })}

      {/* Grand total for the whole avis */}
      <View style={styles.grandWrapper} wrap={false}>
        <View style={styles.grand}>
          <View style={styles.grandRow}>
            <Text style={styles.grandLabel}>{`TOTAL AVIS - ${grand.nb} PIÈCE${grand.nb > 1 ? 'S' : ''}`}</Text>
            <Text style={styles.grandValue}>{`${fmtNum(grand.poids)} Kg   ·   ${fmtNum(grand.metrage)} Ml`}</Text>
          </View>
        </View>
      </View>
    </MalterreDocument>
  )
}
