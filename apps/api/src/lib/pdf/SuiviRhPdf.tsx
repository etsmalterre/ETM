// RH › Employés › Suivi — the dossier exported for a lawyer: every entry of
// one employee's suivi, oldest first, with who wrote it and when (server
// time), its attachments and their SHA-256, and the result of the chain check
// at export time. The attachments themselves are not embedded: they are handed
// over as files, and the fingerprints printed here prove they are the ones
// recorded.

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import { MalterreDocument } from './MalterreDocument.js'
import { colors, sizes } from './theme.js'
import { libelleType } from '../rh-suivi.js'
import type { Evenement } from '../rh-store.js'

export interface SuiviRhPdfData {
  employe: { nom: string; poste: string; dateEmbauche: string | null }
  evenements: Evenement[]
  /** Who exported, and when (ISO). */
  exportePar: string
  exporteLe: string
  verification: { ok: boolean; nombre: number; detail: string }
}

const frDate = (ymd: string) => {
  const [y, m, d] = ymd.split('-')
  return `${d}/${m}/${y}`
}
const frDateHeure = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' })
const taille = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} Ko` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`)

// Typed text (titles, minutes, names) is set in Helvetica, a PDF standard font:
// the bundled Lato drops the accent of a capital (« Évolution » printed
// « Evolution », claude_doc/pdf_email.md) and this document must reproduce what
// was written, character for character.
const TAPE = 'Helvetica'
const TAPE_GRAS = 'Helvetica-Bold'

const styles = StyleSheet.create({
  intro: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  introCard: { flex: 1, borderWidth: 0.75, borderColor: colors.border, borderRadius: 4, padding: 8 },
  introLabel: { fontSize: sizes.fontSm, color: colors.muted, fontWeight: 700, lineHeight: 1 },
  introValue: { fontSize: sizes.fontMd, color: colors.text, fontFamily: TAPE_GRAS, marginTop: 3, lineHeight: 1.25 },
  introDetail: { fontSize: sizes.fontSm, color: colors.muted, marginTop: 2, lineHeight: 1.3 },
  entry: { borderLeftWidth: 2, borderLeftColor: colors.gold, paddingLeft: 8, paddingVertical: 4, marginBottom: 10 },
  entryHead: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  entryDate: { fontSize: sizes.fontMd, fontWeight: 900, color: colors.text, lineHeight: 1.2 },
  entryType: { fontSize: sizes.fontSm, fontWeight: 700, color: colors.primary, lineHeight: 1.2 },
  entryNum: { fontSize: sizes.fontXs, color: colors.subtle, marginLeft: 'auto', lineHeight: 1.2 },
  entryTitle: { fontSize: sizes.fontMd, fontFamily: TAPE_GRAS, color: colors.text, marginTop: 2, lineHeight: 1.3 },
  entryMeta: { fontSize: sizes.fontSm, fontFamily: TAPE, color: colors.muted, marginTop: 1, lineHeight: 1.3 },
  entryBody: { fontSize: sizes.fontBase, fontFamily: TAPE, color: colors.text, marginTop: 4, lineHeight: 1.45 },
  piece: { fontSize: sizes.fontSm, fontFamily: TAPE, color: colors.text, marginTop: 2, lineHeight: 1.3 },
  hash: { fontSize: 6.5, color: colors.subtle, fontFamily: 'Courier', lineHeight: 1.3 },
  seal: { fontSize: sizes.fontXs, color: colors.subtle, marginTop: 4, lineHeight: 1.3 },
  empty: { fontSize: sizes.fontBase, color: colors.muted, fontStyle: 'italic' },
})

export function SuiviRhPdf({ data }: { data: SuiviRhPdfData }) {
  const chrono = [...data.evenements].sort((a, b) => a.dateEvenement.localeCompare(b.dateEvenement) || a.id - b.id)
  return (
    <MalterreDocument
      documentType="Dossier de suivi"
      reference={data.employe.nom}
      documentDate={frDateHeure(data.exporteLe)}
      title={`Dossier de suivi — ${data.employe.nom}`}
    >
      <View style={styles.intro}>
        <View style={styles.introCard}>
          <Text style={styles.introLabel}>Salarié</Text>
          <Text style={styles.introValue}>{data.employe.nom}</Text>
          <Text style={styles.introDetail}>
            {[data.employe.poste, data.employe.dateEmbauche ? `embauché le ${frDate(data.employe.dateEmbauche)}` : ''].filter(Boolean).join(' — ') || ' '}
          </Text>
        </View>
        <View style={styles.introCard}>
          <Text style={styles.introLabel}>Intégrité du registre</Text>
          <Text style={[styles.introValue, { color: data.verification.ok ? '#15803D' : colors.flagRed }]}>
            {data.verification.ok ? 'Vérifiée' : 'ALTÉRATION DÉTECTÉE'}
          </Text>
          <Text style={styles.introDetail}>{data.verification.detail}</Text>
        </View>
      </View>

      {chrono.length === 0 && <Text style={styles.empty}>Aucun événement enregistré.</Text>}

      {chrono.map((e) => (
        <View key={e.id} style={styles.entry} wrap={e.contenu.length > 1500}>
          <View style={styles.entryHead}>
            <Text style={styles.entryDate}>{frDate(e.dateEvenement)}</Text>
            <Text style={styles.entryType}>{libelleType(e.type)}</Text>
            <Text style={styles.entryNum}>N° {e.id}</Text>
          </View>
          <Text style={styles.entryTitle}>{e.titre}</Text>
          {e.rectifie !== null && <Text style={styles.entryMeta}>Rectifie l’événement N° {e.rectifie}</Text>}
          {e.rectifiePar.length > 0 && <Text style={styles.entryMeta}>Rectifié par l’événement N° {e.rectifiePar.join(', ')}</Text>}
          {e.presents.trim() !== '' && <Text style={styles.entryMeta}>Présents : {e.presents}</Text>}
          <Text style={styles.entryBody}>{e.contenu}</Text>
          {e.pieces.map((p) => (
            <View key={p.id}>
              <Text style={styles.piece}>Pièce jointe : {p.nom} ({taille(p.taille)})</Text>
              <Text style={styles.hash}>SHA-256 {p.sha256}</Text>
            </View>
          ))}
          <Text style={styles.seal}>
            Enregistré le {frDateHeure(e.creeLe)} par {e.creePar} — empreinte {e.hash.slice(0, 16)}…
          </Text>
        </View>
      ))}

      <Text style={[styles.seal, { marginTop: 8 }]}>
        Exporté le {frDateHeure(data.exporteLe)} par {data.exportePar}. Registre en ajout seul : un événement enregistré
        ne peut être ni modifié ni supprimé ; une correction est un nouvel événement « Rectificatif ». Chaque événement est
        scellé par une empreinte SHA-256 couvrant son contenu, ses pièces jointes et l’empreinte de l’événement précédent.
      </Text>
    </MalterreDocument>
  )
}
