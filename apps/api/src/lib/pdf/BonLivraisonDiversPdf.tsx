// PDF document for a miscellaneous client shipment ("Avis d'expédition"
// divers), rendered inside the shared MalterreDocument frame. The legacy
// ETAT_Expédition_diverse report is PCS-compressed, so this ports the divers
// data model (expedition_divers → cartons → ref_divers_expedie items) into the
// same design language as the formelle BonLivraisonPdf:
//  - top row: delivery address card + shipment metadata card (client,
//    référence client, transporteur)
//  - one section per carton: the free-text carton label (first line bold,
//    following lines muted) then a framed items table (désignation · quantité)
//    with a per-carton count row
//  - a gold grand-total box counting cartons, articles and pieces.
// ⚠️ NO PRICE ANYWHERE, by design (LIVA #1127, Isabelle, 2026-09). An avis
// d'expédition is a delivery document: the legacy ETAT_Expédition_diverse
// (model: DIV632 for Unicycle) prints designation + "N Pièce" and nothing else,
// and the client must not read a price off it. Until #1127 the columns
// P.U. / TOTAL (€) and a euro grand total rendered whenever an item carried a
// price — i.e. on every priced Unicycle shipment. The money lives on the
// facture (`factures.ts`), which is where the tarif_divers price belongs; the
// item type therefore carries no `prix` at all, so a price cannot creep back
// in through the data builder.

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import {
  MalterreDocument,
  AddressCard,
  UserIcon,
  MessageSquareIcon,
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

export interface BlDiversItem {
  /** Free-text legacy override, else the catalog ref designation. */
  designation: string
  /** "Bleu · Taille M" — resolved variation labels, already joined. */
  variations: string | null
  quantite: number
  /** 4 = "unité" (pluralized when quantite > 1). */
  unite: number
  unite_label: string
}

export interface BlDiversCarton {
  /** stripRtf'd detail_ligne — free multi-line carton label. */
  detail: string
  items: BlDiversItem[]
}

export interface BonLivraisonDiversPdfData {
  /** The expedition_divers id — the document number IS the PK. */
  numero: number
  /** "17 mars 2026" — long-form French. */
  dateLong: string
  clientNom: string
  refClient: string | null
  transporteurNom: string | null
  adresseLivraison: AddrLite | null
  cartons: BlDiversCarton[]
}

function fmtNum(value: number | null | undefined, decimals = 2): string {
  if (value == null || Number.isNaN(value)) return ''
  return value
    .toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace(/ | /g, ' ')
}

/** Quantities keep their natural precision: "3" not "3,00", "2,5" stays. */
function fmtQty(value: number): string {
  return fmtNum(value, Number.isInteger(value) ? 0 : 2)
}

function qtyLabel(it: Pick<BlDiversItem, 'quantite' | 'unite' | 'unite_label'>): string {
  const plural = it.unite === 4 && it.quantite > 1 ? 's' : ''
  return `${fmtQty(it.quantite)}${it.unite_label ? ` ${it.unite_label}${plural}` : ''}`
}

/** "9 unités · 2,50 Ml" — quantities summed per unit, in first-seen order.
 *  A carton usually holds one unit kind, so this reads as a plain piece
 *  count — the one figure the client checks against the parcel (#1127). */
export function quantiteParUnite(items: BlDiversItem[]): string {
  const byUnit = new Map<string, { unite: number; quantite: number }>()
  for (const it of items) {
    const key = it.unite_label || ''
    const cur = byUnit.get(key) ?? { unite: it.unite, quantite: 0 }
    cur.quantite += it.quantite
    byUnit.set(key, cur)
  }
  return [...byUnit.entries()]
    .map(([unite_label, { unite, quantite }]) => qtyLabel({ quantite, unite, unite_label }))
    .join(' · ')
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
  metaRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 1.5 },
  metaIconBox: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  metaLabel: { width: 88, fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, lineHeight: 1.25 },
  metaValue: { flex: 1, fontSize: sizes.fontBase, color: colors.text, fontWeight: 700, textAlign: 'right', lineHeight: 1.25 },

  // Carton identity block
  carton: { marginBottom: 14 },
  cartonTitre: { fontSize: 11.5, color: colors.primary, fontWeight: 900, lineHeight: 1.35 },
  cartonLine: { fontSize: 10.5, color: colors.text, lineHeight: 1.35 },
  cartonEmpty: { fontSize: sizes.fontSm, color: colors.muted, lineHeight: 1.35, marginTop: 3 },

  // Items table
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
  cellMuted: { fontSize: 10, color: colors.muted, lineHeight: 1.2 },
  colDesignation: { flex: 1, paddingRight: 6 },
  colQty: { width: 110, textAlign: 'right', paddingHorizontal: 4 },

  // Per-carton totals row (inside the table frame)
  cartonTotalRow: {
    flexDirection: 'row',
    paddingVertical: 5,
    paddingHorizontal: 10,
    backgroundColor: colors.bgMuted,
    alignItems: 'center',
  },
  // Tight explicit lineHeight — empty spacer cells otherwise inherit the
  // body's 1.45 and the muted totals band balloons below its text.
  cartonTotalLabel: { fontSize: 10, color: colors.text, fontWeight: 900, lineHeight: 1.2 },
  cartonTotalCell: { fontSize: 10, color: colors.text, fontWeight: 900, lineHeight: 1.2 },

  // Grand-total box (whole expedition)
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

function buildDeliveryAddress(data: BonLivraisonDiversPdfData): AddressBlockData {
  const a = data.adresseLivraison
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

export function BonLivraisonDiversPdf({ data }: { data: BonLivraisonDiversPdfData }) {
  const deliveryAddress = buildDeliveryAddress(data)
  const allItems = data.cartons.flatMap((c) => c.items)
  const nbCartons = data.cartons.length
  const nbArticles = allItems.length
  const grandQty = quantiteParUnite(allItems)

  return (
    <MalterreDocument
      // No accent on purpose — the uppercased É renders badly in the header font.
      documentType="Avis d'expedition"
      reference={`BL divers N°${data.numero}`}
      documentDate={data.dateLong || ''}
      title={`Avis d'expédition diverse ${data.numero}`}
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
            {data.transporteurNom ? (
              <MetaRow icon={<TruckIcon />} label="Transporteur" value={data.transporteurNom} />
            ) : null}
          </View>
        </View>
      </View>

      {/* One section per carton */}
      {data.cartons.map((carton, ci) => {
        const lines = carton.detail.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)
        const titre = lines[0] || `Carton ${ci + 1}`
        const rest = lines.slice(1)
        return (
          <View key={ci} style={styles.carton}>
            {/* Keep the carton label glued to the start of its items table
                instead of stranding it at a page bottom. */}
            <View wrap={false} minPresenceAhead={90}>
              <Text style={styles.cartonTitre}>{titre}</Text>
              {rest.map((r, ri) => (
                <Text key={ri} style={styles.cartonLine}>{r}</Text>
              ))}
            </View>

            {carton.items.length === 0 ? (
              <Text style={styles.cartonEmpty}>Aucun article</Text>
            ) : (
              <View style={styles.table}>
                <View style={styles.tableHeader} fixed>
                  <Text style={[styles.tableHeaderCell, styles.colDesignation]}>DÉSIGNATION</Text>
                  <Text style={[styles.tableHeaderCell, styles.colQty]}>QUANTITÉ</Text>
                </View>
                {carton.items.map((it, ii) => (
                  <View key={ii} style={styles.tableRow}>
                    <Text style={[styles.cellBase, styles.colDesignation]}>
                      {it.designation || '—'}
                      {it.variations ? <Text style={styles.cellMuted}>{`  ·  ${it.variations}`}</Text> : null}
                    </Text>
                    <Text style={[styles.cellBase, styles.colQty]}>{qtyLabel(it)}</Text>
                  </View>
                ))}
                <View style={styles.cartonTotalRow}>
                  <Text style={[styles.cartonTotalLabel, styles.colDesignation]}>
                    {`Total carton - ${carton.items.length} article${carton.items.length > 1 ? 's' : ''}`}
                  </Text>
                  <Text style={[styles.cartonTotalCell, styles.colQty]}>{quantiteParUnite(carton.items)}</Text>
                </View>
              </View>
            )}
          </View>
        )
      })}

      {/* Grand total for the whole expedition */}
      <View style={styles.grandWrapper} wrap={false}>
        <View style={styles.grand}>
          <View style={styles.grandRow}>
            <Text style={styles.grandLabel}>
              {`TOTAL EXPÉDITION - ${nbCartons} CARTON${nbCartons > 1 ? 'S' : ''} · ${nbArticles} ARTICLE${nbArticles > 1 ? 'S' : ''}`}
            </Text>
            {grandQty ? <Text style={styles.grandValue}>{grandQty}</Text> : null}
          </View>
        </View>
      </View>
    </MalterreDocument>
  )
}
