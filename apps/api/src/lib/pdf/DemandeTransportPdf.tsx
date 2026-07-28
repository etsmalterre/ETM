// PDF document for a "Demande de transport" (fiche de transport) — the
// pickup request faxed/emailed to a carrier for a formelle expedition.
// Port of the legacy WinDev "Demande_transport_<id>" sheet, rebuilt inside
// MalterreDocument so it carries the same branding as the other documents.
//
// The legacy sheet is a fill-in form: the operator prints it, the carrier
// confirms the pickup slot by hand (or by return mail). The blank fields
// below are therefore intentional — they are meant to be written on.

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import {
  MalterreDocument,
  AddressCard,
  type AddressBlockData,
  type MetadataCardData,
} from './MalterreDocument.js'
import { colors, company, sizes } from './theme.js'

// ── Input shape ──────────────────────────────────────────

export interface TransportAdresse {
  nom: string | null
  adresse1: string | null
  adresse2: string | null
  adresse3: string | null
  cp: string | null
  ville: string | null
  pays: string | null
}

export interface DemandeTransportPdfData {
  /** Expedition id — the document number. */
  numero: number
  /** Long-form French date of the request (today), e.g. "28 Juillet 2026". */
  dateLong: string
  /** Short French date used in the fill-in "Le :" line, e.g. "28/07/2026". */
  dateCourte: string
  /** Sender line, e.g. "Patricia - Ets Malterre". */
  expediteur: string
  /** Carrier the request is addressed to (blank when none is set yet). */
  transporteurNom: string | null
  clientNom: string | null
  commandeNumero: number | null
  /** Total shipped weight, in kg. */
  poids: number
  /** Number of rolls making up the shipment. */
  nbRouleaux: number
  /** Pickup address (ETS Malterre). */
  enlevement: TransportAdresse
  /** Delivery address carried by the expedition. */
  livraison: TransportAdresse | null
}

// ── Helpers ──────────────────────────────────────────────

function fmtNum(value: number | null | undefined, decimals = 1): string {
  if (value == null || Number.isNaN(value)) return ''
  return value
    .toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace(/ | /g, ' ')
}

function addressLines(a: TransportAdresse | null): string[] {
  if (!a) return ['-']
  const lines: string[] = []
  if (a.adresse1) lines.push(a.adresse1)
  if (a.adresse2) lines.push(a.adresse2)
  if (a.adresse3) lines.push(a.adresse3)
  const cityLine = [a.cp, a.ville].filter(Boolean).join(' - ')
  if (cityLine) lines.push(cityLine)
  if (a.pays) lines.push(a.pays)
  return lines.length > 0 ? lines : ['-']
}

// ── Styles ───────────────────────────────────────────────

const styles = StyleSheet.create({
  // Centered document heading, mirroring the legacy underlined caps title.
  heading: {
    fontSize: sizes.fontLg,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 1,
    textAlign: 'center',
    marginBottom: 4,
  },
  headingRule: {
    alignSelf: 'center',
    width: 220,
    height: 2,
    backgroundColor: colors.gold,
    marginBottom: 18,
  },

  // "Merci d'enlever +/- X kg, en N rouleaux" — the payload line.
  payloadBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.bgCream,
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderLeftWidth: 2,
    borderLeftColor: colors.gold,
    borderLeftStyle: 'solid',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 18,
  },
  payloadLabel: {
    fontSize: sizes.fontBase,
    color: colors.muted,
    fontWeight: 700,
    lineHeight: 1.25,
  },
  payloadValue: {
    fontSize: sizes.fontLg,
    color: colors.primary,
    fontWeight: 900,
    lineHeight: 1.25,
  },

  // Two address cards side by side (pickup / delivery).
  cardsRow: {
    flexDirection: 'row',
    gap: 14,
    alignItems: 'stretch',
    marginBottom: 14,
  },
  cardsSlot: {
    flex: 1,
    flexDirection: 'column',
  },

  // Fill-in rows: label on the left, dotted rule (or value) on the right.
  fillRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginBottom: 8,
  },
  fillLabel: {
    fontSize: sizes.fontBase,
    color: colors.text,
    fontWeight: 700,
    lineHeight: 1.25,
  },
  fillValue: {
    fontSize: sizes.fontBase,
    color: colors.primary,
    fontWeight: 900,
    lineHeight: 1.25,
  },
  fillRule: {
    flexGrow: 1,
    borderBottomWidth: 0.75,
    borderBottomColor: colors.borderStrong,
    borderBottomStyle: 'dashed',
    height: 10,
  },

  // Confirmation callout — the legacy bold block asking for a return
  // confirmation, plus the slots the carrier fills in.
  callout: {
    marginTop: 6,
    padding: 12,
    backgroundColor: colors.bgTotal,
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderLeftWidth: 2,
    borderLeftColor: colors.primary,
    borderLeftStyle: 'solid',
    borderRadius: 6,
  },
  calloutText: {
    fontSize: sizes.fontBase,
    color: colors.text,
    fontWeight: 700,
    lineHeight: 1.45,
    marginBottom: 10,
  },
  slotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  checkbox: {
    width: 9,
    height: 9,
    borderWidth: 0.75,
    borderColor: colors.text,
    borderStyle: 'solid',
    borderRadius: 1,
  },
  checkboxLabel: {
    fontSize: sizes.fontBase,
    color: colors.text,
    fontWeight: 700,
    lineHeight: 1.25,
  },

  // Closing salutation.
  closing: {
    marginTop: 18,
    fontSize: sizes.fontBase,
    color: colors.text,
    lineHeight: 1.5,
  },
  signature: {
    marginTop: 10,
    fontSize: sizes.fontBase,
    color: colors.text,
    fontWeight: 900,
    lineHeight: 1.25,
  },
})

// ── Sub-components ───────────────────────────────────────

/** Label + either a filled value or a dashed rule to write on. */
function FillRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <View style={styles.fillRow}>
      <Text style={styles.fillLabel}>{label}</Text>
      {value ? <Text style={styles.fillValue}>{value}</Text> : null}
      <View style={styles.fillRule} />
    </View>
  )
}

// ── Component ────────────────────────────────────────────

export function DemandeTransportPdf({ data }: { data: DemandeTransportPdfData }) {
  const destinataire: AddressBlockData = {
    title: 'Destinataire',
    // Legacy leaves this block blank when no carrier is set — the operator
    // writes it in. We print it when the expedition already names one.
    name: data.transporteurNom || '',
    lines: data.transporteurNom ? [] : ['Transporteur à préciser'],
    icon: 'truck',
  }

  const infoItems: MetadataCardData['items'] = [
    { icon: 'user', label: 'Expéditeur', value: data.expediteur || company.tradeName },
    { icon: 'calendar', label: 'Date', value: data.dateLong || data.dateCourte },
    { icon: 'card', label: 'Facturation', value: 'Nous' },
  ]
  if (data.clientNom) infoItems.push({ icon: 'factory', label: 'Client', value: data.clientNom })
  if (data.commandeNumero) {
    infoItems.push({ icon: 'tag', label: 'Commande', value: `N°${data.commandeNumero}` })
  }

  const enlevementCard: AddressBlockData = {
    title: 'Enlèvement chez',
    name: data.enlevement.nom || company.legalName,
    lines: addressLines(data.enlevement),
    icon: 'factory',
  }
  const livraisonCard: AddressBlockData = {
    title: 'Pour livraison chez',
    name: data.livraison?.nom || data.clientNom || '-',
    lines: addressLines(data.livraison),
    icon: 'truck',
  }

  const rouleauxLabel = data.nbRouleaux > 1 ? 'rouleaux' : 'rouleau'

  return (
    <MalterreDocument
      documentType="Demande de transport"
      reference={`N°${data.numero}`}
      documentDate={data.dateLong}
      topLeftAddress={destinataire}
      topRightInfo={{ title: 'Informations', items: infoItems }}
      title={`Demande de transport ${data.numero}`}
    >
      <Text style={styles.heading}>DEMANDE D'ENLÈVEMENT MESSAGERIE</Text>
      <View style={styles.headingRule} />

      <View style={styles.payloadBox}>
        <Text style={styles.payloadLabel}>MERCI D'ENLEVER +/-</Text>
        <Text style={styles.payloadValue}>
          {fmtNum(data.poids, 1)} kg, en {data.nbRouleaux} {rouleauxLabel}
        </Text>
      </View>

      <View style={styles.cardsRow}>
        <View style={styles.cardsSlot}>
          <AddressCard data={enlevementCard} stretch />
        </View>
        <View style={styles.cardsSlot}>
          <AddressCard data={livraisonCard} stretch />
        </View>
      </View>

      <FillRow label="Date d'enlèvement souhaitée :" value={data.dateCourte} />
      <FillRow label="Date de livraison demandée :" />

      <View style={styles.callout}>
        <Text style={styles.calloutText}>
          AFIN DE NOUS ASSURER DE LA BONNE PRISE EN COMPTE DE CETTE DEMANDE, MERCI DE NOUS LA
          CONFIRMER PAR RETOUR AVEC LA DATE D'ENLÈVEMENT PRÉVUE :
        </Text>
        <View style={styles.slotRow}>
          <Text style={styles.checkboxLabel}>Le :</Text>
          <View style={styles.fillRule} />
          <View style={styles.checkbox} />
          <Text style={styles.checkboxLabel}>matin</Text>
          <View style={styles.checkbox} />
          <Text style={styles.checkboxLabel}>après-midi</Text>
        </View>
        <FillRow label="Date de livraison estimée :" />
      </View>

      <Text style={styles.closing}>
        Avec mes remerciements.{'\n'}
        Sincères salutations.
      </Text>
      <Text style={styles.signature}>{data.expediteur}</Text>
    </MalterreDocument>
  )
}
