// PDF document for a bon de transfert ("Bordereau de livraison N° X"),
// rendered inside the shared MalterreDocument frame. Ports the legacy WinDev
// report ETAT_Bon_de_transfert to the ETM design language:
//  - top row: destination address card + transfer metadata card (source,
//    destination, transporteur)
//  - rouleaux (type_matiere 1): one section per reference — identity block
//    ("128/101" / "interlock - 100% polyester") then a framed table
//    (coloris · numéro · lot · poids · métrage) with a per-article totals row —
//    and a gold grand-total box (n pièces · Σ kg · Σ Ml)
//  - fils (type_matiere 2): a single framed table (lot · référence · coloris ·
//    poids · fournisseur) with a gold total box (n lots · Σ kg)

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import {
  MalterreDocument,
  AddressCard,
  FactoryIcon,
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

export interface BtPiece {
  reference: string
  coloris: string
  numero: string
  lot: string
  poids: number
  metrage: number
}

export interface BtArticle {
  /** "128/101" */
  titre: string
  /** "interlock - 100% polyester" (designation - composition) */
  sousTitre: string | null
  pieces: BtPiece[]
}

export interface BtFilRow {
  lot: string
  reference: string
  coloris: string
  poids: number
  fournisseur: string
}

export interface BonTransfertPdfData {
  /** The bon id — the bordereau number IS the PK. */
  numero: number
  typeMatiere: 1 | 2
  /** "24 juillet 2026" — long-form French. */
  dateLong: string
  sourceNom: string
  destinationNom: string
  transporteurNom: string | null
  adresseDestination: AddrLite | null
  commentaire: string | null
  /** rouleaux (type_matiere 1) */
  articles: BtArticle[]
  /** fils (type_matiere 2) */
  filRows: BtFilRow[]
}

function fmtNum(value: number | null | undefined, decimals = 2): string {
  if (value == null || Number.isNaN(value)) return ''
  return value
    .toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace(/ | /g, ' ')
}

const styles = StyleSheet.create({
  topRow: { flexDirection: 'row', gap: 14, marginBottom: 14, alignItems: 'stretch' },
  topRowSlot: { flex: 1, flexDirection: 'column' },

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
  // the icon sits visually below the label (§38.1).
  metaRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 1.5 },
  metaIconBox: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  metaLabel: { width: 88, fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, lineHeight: 1.25 },
  metaValue: { flex: 1, fontSize: sizes.fontBase, color: colors.text, fontWeight: 700, textAlign: 'right', lineHeight: 1.25 },

  commentaire: { fontSize: sizes.fontSm, color: colors.text, lineHeight: 1.4, marginBottom: 12 },

  // Article identity block (rouleaux)
  article: { marginBottom: 14 },
  articleTitre: { fontSize: 11.5, color: colors.primary, fontWeight: 900, lineHeight: 1.35 },
  articleLine: { fontSize: 10.5, color: colors.text, lineHeight: 1.35 },

  table: {
    marginTop: 6,
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

  // Rouleaux columns
  colColoris: { flex: 1, paddingRight: 6 },
  colNumero: { width: 90, paddingRight: 6 },
  colLot: { width: 90, paddingRight: 6 },
  colNum: { width: 78, textAlign: 'right', paddingHorizontal: 4 },

  // Fils columns
  colFilLot: { width: 80, paddingRight: 6 },
  colFilRef: { flex: 1, paddingRight: 6 },
  colFilColoris: { width: 100, paddingRight: 6 },
  colFilFournisseur: { width: 110, paddingLeft: 6 },

  totalRow: {
    flexDirection: 'row',
    paddingVertical: 5,
    paddingHorizontal: 10,
    backgroundColor: colors.bgMuted,
    alignItems: 'center',
  },
  totalLabel: { fontSize: 10, color: colors.text, fontWeight: 900 },
  totalCell: { fontSize: 10, color: colors.text, fontWeight: 900 },

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

function buildDestinationAddress(data: BonTransfertPdfData): AddressBlockData {
  const a = data.adresseDestination
  const lines: string[] = []
  const clean = (v: string | null | undefined) => (v ?? '').trim()
  if (a) {
    if (clean(a.adresse1)) lines.push(clean(a.adresse1))
    if (clean(a.adresse2)) lines.push(clean(a.adresse2))
    if (clean(a.adresse3)) lines.push(clean(a.adresse3))
    const cityLine = [clean(a.cp), clean(a.ville)].filter(Boolean).join(' ')
    if (cityLine) lines.push(cityLine)
    if (clean(a.pays)) lines.push(clean(a.pays))
  }
  return { title: 'Adresse de destination', name: clean(a?.nom) || data.destinationNom, lines, icon: 'truck' }
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

function articleAgg(article: BtArticle): { nb: number; poids: number; metrage: number } {
  return {
    nb: article.pieces.length,
    poids: article.pieces.reduce((s, p) => s + (Number(p.poids) || 0), 0),
    metrage: article.pieces.reduce((s, p) => s + (Number(p.metrage) || 0), 0),
  }
}

export function BonTransfertPdf({ data }: { data: BonTransfertPdfData }) {
  const destinationAddress = buildDestinationAddress(data)
  const isRouleaux = data.typeMatiere === 1

  const grand = isRouleaux
    ? data.articles.reduce(
        (acc, a) => {
          const t = articleAgg(a)
          return { nb: acc.nb + t.nb, poids: acc.poids + t.poids, metrage: acc.metrage + t.metrage }
        },
        { nb: 0, poids: 0, metrage: 0 },
      )
    : {
        nb: data.filRows.length,
        poids: data.filRows.reduce((s, r) => s + (Number(r.poids) || 0), 0),
        metrage: 0,
      }

  return (
    <MalterreDocument
      documentType="Bordereau de livraison"
      reference={`N°${data.numero}`}
      documentDate={data.dateLong || ''}
      title={`Bordereau de livraison ${data.numero}`}
    >
      {/* Top row: destination address + transfer metadata */}
      <View style={styles.topRow}>
        <View style={styles.topRowSlot}>
          <AddressCard data={destinationAddress} stretch />
        </View>
        <View style={styles.topRowSlot}>
          <View style={styles.metaCard}>
            <MetaRow icon={<FactoryIcon />} label="Source" value={data.sourceNom || '—'} />
            <MetaRow icon={<FactoryIcon />} label="Destination" value={data.destinationNom || '—'} />
            {data.transporteurNom ? (
              <MetaRow icon={<TruckIcon />} label="Transporteur" value={data.transporteurNom} />
            ) : null}
          </View>
        </View>
      </View>

      {data.commentaire?.trim() ? <Text style={styles.commentaire}>{data.commentaire.trim()}</Text> : null}

      {isRouleaux ? (
        <>
          {data.articles.map((article, ai) => {
            const t = articleAgg(article)
            const pieceRow = (p: BtPiece, pi: number) => (
              <View key={pi} style={styles.tableRow}>
                <Text style={[styles.cellBase, styles.colColoris]}>{p.coloris || '—'}</Text>
                <Text style={[styles.cellBase, styles.colNumero]}>{p.numero || '—'}</Text>
                <Text style={[styles.cellBase, styles.colLot]}>{p.lot || '—'}</Text>
                <Text style={[styles.cellBase, styles.colNum]}>{fmtNum(p.poids)}</Text>
                <Text style={[styles.cellBase, styles.colNum]}>{fmtNum(p.metrage)}</Text>
              </View>
            )
            return (
              <View key={ai} style={styles.article}>
                {/* Keep the article identity glued to its table start instead of
                    stranding it at a page bottom (same semantics as the BL). */}
                <View wrap={false} minPresenceAhead={100}>
                  <Text style={styles.articleTitre}>{article.titre}</Text>
                  {article.sousTitre ? <Text style={styles.articleLine}>{article.sousTitre}</Text> : null}
                </View>
                <View style={styles.table}>
                  <View style={styles.tableHeader} fixed>
                    <Text style={[styles.tableHeaderCell, styles.colColoris]}>COLORIS</Text>
                    <Text style={[styles.tableHeaderCell, styles.colNumero]}>NUMÉRO</Text>
                    <Text style={[styles.tableHeaderCell, styles.colLot]}>LOT</Text>
                    <Text style={[styles.tableHeaderCell, styles.colNum]}>POIDS (KG)</Text>
                    <Text style={[styles.tableHeaderCell, styles.colNum]}>MÉTRAGE (ML)</Text>
                  </View>
                  {article.pieces.slice(0, -1).map(pieceRow)}
                  {/* Last piece row + totals row glued together so a page break
                      can never leave the total orphaned under a bare header. */}
                  <View wrap={false}>
                    {article.pieces.length > 0 ? pieceRow(article.pieces[article.pieces.length - 1], article.pieces.length - 1) : null}
                    <View style={styles.totalRow}>
                      <Text style={[styles.totalLabel, styles.colColoris]}>
                        {`Total - ${t.nb} pièce${t.nb > 1 ? 's' : ''}`}
                      </Text>
                      <Text style={styles.colNumero} />
                      <Text style={styles.colLot} />
                      <Text style={[styles.totalCell, styles.colNum]}>{fmtNum(t.poids)}</Text>
                      <Text style={[styles.totalCell, styles.colNum]}>{fmtNum(t.metrage)}</Text>
                    </View>
                  </View>
                </View>
              </View>
            )
          })}

          <View style={styles.grandWrapper} wrap={false}>
            <View style={styles.grand}>
              <View style={styles.grandRow}>
                <Text style={styles.grandLabel}>{`TOTAL - ${grand.nb} PIÈCE${grand.nb > 1 ? 'S' : ''}`}</Text>
                <Text style={styles.grandValue}>{`${fmtNum(grand.poids)} Kg   ·   ${fmtNum(grand.metrage)} Ml`}</Text>
              </View>
            </View>
          </View>
        </>
      ) : (
        <>
          <View style={styles.table}>
            <View style={styles.tableHeader} fixed>
              <Text style={[styles.tableHeaderCell, styles.colFilLot]}>LOT</Text>
              <Text style={[styles.tableHeaderCell, styles.colFilRef]}>RÉFÉRENCE</Text>
              <Text style={[styles.tableHeaderCell, styles.colFilColoris]}>COLORIS</Text>
              <Text style={[styles.tableHeaderCell, styles.colNum]}>POIDS (KG)</Text>
              <Text style={[styles.tableHeaderCell, styles.colFilFournisseur]}>FOURNISSEUR</Text>
            </View>
            {data.filRows.map((r, ri) => (
              <View key={ri} style={styles.tableRow}>
                <Text style={[styles.cellBase, styles.colFilLot]}>{r.lot || '—'}</Text>
                <Text style={[styles.cellBase, styles.colFilRef]}>{r.reference || '—'}</Text>
                <Text style={[styles.cellBase, styles.colFilColoris]}>{r.coloris || ''}</Text>
                <Text style={[styles.cellBase, styles.colNum]}>{fmtNum(r.poids)}</Text>
                <Text style={[styles.cellBase, styles.colFilFournisseur]}>{r.fournisseur || ''}</Text>
              </View>
            ))}
          </View>

          <View style={styles.grandWrapper} wrap={false}>
            <View style={styles.grand}>
              <View style={styles.grandRow}>
                <Text style={styles.grandLabel}>{`TOTAL - ${grand.nb} LOT${grand.nb > 1 ? 'S' : ''}`}</Text>
                <Text style={styles.grandValue}>{`${fmtNum(grand.poids)} Kg`}</Text>
              </View>
            </View>
          </View>
        </>
      )}
    </MalterreDocument>
  )
}
