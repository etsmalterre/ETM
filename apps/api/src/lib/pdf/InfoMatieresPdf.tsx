// PDF document for the "Information matières" traceability sheet that can
// accompany a client expedition. Ports the legacy WinDev ETAT_Info_Matiere to
// the ETM design language: for each shipped article, one block per material
// stage — Tissu Fini (ennoblisseur), Tombé de métier (tricoteur), Fil
// (fournisseur) — with partner name, country, certifications (fil only) and
// the transport documents (ged BL scans) of that stage.
//  - Tissu fini: suivilot → ennoblisseur; ged type 3 (bl retour ennoblisseur)
//  - Tombé de métier: stock_ecru.IDref_commande_source → tricoteur (lcsst
//    type 1); ged type 4 (bl retour tricoteur)
//  - Fil: ordre_fabrication → asso_fil_of → stock_fil → fournisseur; certifs
//    via ref_fil_certif → certificat; ged type 6 (bl fournisseur)

import React from 'react'
import { View, Text, StyleSheet, Svg, Path } from '@react-pdf/renderer'
import { MalterreDocument } from './MalterreDocument.js'
import { colors, sizes } from './theme.js'

export interface ImEntry {
  /** Bold first line — material identity (ref fil, ref écru, lot…). */
  titre: string | null
  /** Partner name (sous-traitant or fournisseur). */
  nom: string
  pays: string | null
  /** Certification labels, fil entries only ("OEKO-TEX", "GOTS", "Bio"…). */
  certifications?: string[]
  /** ged document display names ("MA107976.pdf", "bl"…). */
  transportDocs: string[]
}

export interface ImArticle {
  /** "228/122 - 0481 rouge intense 61221/1" (ref · coloris) */
  titre: string
  /** "Jersey Coton 115g" (designation) */
  sousTitre: string | null
  tissuFini: ImEntry[]
  tombeMetier: ImEntry[]
  fils: ImEntry[]
}

export interface InfoMatieresPdfData {
  /** The expedition id (avis d'expédition number). */
  numero: number
  dateLong: string
  clientNom: string
  articles: ImArticle[]
}

// ── Stage icons (lucide-style line SVGs, matching MalterreDocument's set) ──

function RollIcon({ size = 16, color = colors.primary }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M5 7h13a3 5 0 0 1 0 10H5z" stroke={color} strokeWidth={1.6} fill="none" />
      <Path d="M5 7a2 5 0 1 0 0 10 2 5 0 0 0 0-10z" stroke={color} strokeWidth={1.6} fill="none" />
    </Svg>
  )
}

function KnitIcon({ size = 16, color = colors.primary }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M4 5l4 5-4 5" stroke={color} strokeWidth={1.6} fill="none" />
      <Path d="M10 5l4 5-4 5" stroke={color} strokeWidth={1.6} fill="none" />
      <Path d="M16 5l4 5-4 5" stroke={color} strokeWidth={1.6} fill="none" />
    </Svg>
  )
}

function YarnIcon({ size = 16, color = colors.primary }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" stroke={color} strokeWidth={1.6} fill="none" />
      <Path d="M5 6c3 2 5 5 5.5 9" stroke={color} strokeWidth={1.4} fill="none" />
      <Path d="M9 3.5c3.5 2.5 5.5 6 6 10.5" stroke={color} strokeWidth={1.4} fill="none" />
      <Path d="M19 6.5c-4 1-7 4-8 8" stroke={color} strokeWidth={1.4} fill="none" />
    </Svg>
  )
}

const styles = StyleSheet.create({
  // Article identity block
  article: { marginBottom: 16 },
  articleTitre: { fontSize: 11.5, color: colors.primary, fontWeight: 900, lineHeight: 1.35 },
  articleLine: { fontSize: 10.5, color: colors.text, lineHeight: 1.35 },

  // Stage block: icon+label column on the left, one card per entry.
  stage: { flexDirection: 'row', gap: 10, marginTop: 8, alignItems: 'stretch' },
  stageLabelBox: { width: 84, alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 6 },
  stageLabel: {
    fontSize: sizes.fontXs,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.4,
    textAlign: 'center',
    lineHeight: 1.2,
  },
  stageEntries: { flex: 1, flexDirection: 'column', gap: 6 },

  entryCard: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: colors.bgCream,
    borderWidth: 0.75,
    borderColor: colors.borderStrong,
    borderStyle: 'solid',
    borderLeftWidth: 2,
    borderLeftColor: colors.gold,
    borderLeftStyle: 'solid',
    borderRadius: 6,
    padding: 9,
  },
  entryInfo: { flex: 1.4, flexDirection: 'column' },
  entryDocs: {
    flex: 1,
    flexDirection: 'column',
    borderLeftWidth: 0.75,
    borderLeftColor: colors.borderStrong,
    borderLeftStyle: 'solid',
    paddingLeft: 10,
  },
  entryTitre: { fontSize: sizes.fontMd, color: colors.text, fontWeight: 900, lineHeight: 1.3, marginBottom: 2 },
  infoRow: { flexDirection: 'row', gap: 6, paddingVertical: 1 },
  infoLabel: { width: 78, fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, lineHeight: 1.25 },
  infoValue: { flex: 1, fontSize: sizes.fontBase, color: colors.text, fontWeight: 700, lineHeight: 1.25 },
  docsTitle: {
    fontSize: sizes.fontXs,
    color: colors.primary,
    fontWeight: 900,
    letterSpacing: 0.5,
    lineHeight: 1.2,
    marginBottom: 3,
  },
  docLine: { fontSize: sizes.fontBase, color: colors.text, lineHeight: 1.3 },
  docNone: { fontSize: sizes.fontBase, color: colors.subtle, lineHeight: 1.3 },
})

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  )
}

function EntryCard({ entry, partnerLabel }: { entry: ImEntry; partnerLabel: string }) {
  return (
    <View style={styles.entryCard} wrap={false}>
      <View style={styles.entryInfo}>
        {entry.titre?.trim() ? <Text style={styles.entryTitre}>{entry.titre.trim()}</Text> : null}
        <InfoRow label={partnerLabel} value={entry.nom || '—'} />
        {entry.pays?.trim() ? <InfoRow label="Pays" value={entry.pays.trim()} /> : null}
        {entry.certifications && entry.certifications.length > 0 ? (
          <InfoRow label="Certifié" value={entry.certifications.join(', ')} />
        ) : null}
      </View>
      <View style={styles.entryDocs}>
        <Text style={styles.docsTitle}>DOCUMENTS</Text>
        {entry.transportDocs.length > 0 ? (
          entry.transportDocs.map((d, i) => (
            <Text key={i} style={styles.docLine}>{`Transport : ${d}`}</Text>
          ))
        ) : (
          <Text style={styles.docNone}>—</Text>
        )}
      </View>
    </View>
  )
}

function Stage({
  label,
  icon,
  entries,
  partnerLabel,
}: {
  label: string
  icon: React.ReactNode
  entries: ImEntry[]
  partnerLabel: string
}) {
  if (entries.length === 0) return null
  return (
    <View style={styles.stage}>
      <View style={styles.stageLabelBox}>
        {icon}
        <Text style={styles.stageLabel}>{label}</Text>
      </View>
      <View style={styles.stageEntries}>
        {entries.map((e, i) => (
          <EntryCard key={i} entry={e} partnerLabel={partnerLabel} />
        ))}
      </View>
    </View>
  )
}

export function InfoMatieresPdf({ data }: { data: InfoMatieresPdfData }) {
  return (
    <MalterreDocument
      // No accent on purpose — uppercased È renders badly in the header font.
      documentType="Information matieres"
      reference={`N°${data.numero}`}
      documentDate={data.dateLong || ''}
      title={`Information matières ${data.numero}`}
    >
      {data.articles.map((article, ai) => (
        <View key={ai} style={styles.article}>
          <View wrap={false} minPresenceAhead={90}>
            <Text style={styles.articleTitre}>{article.titre}</Text>
            {article.sousTitre ? <Text style={styles.articleLine}>{article.sousTitre}</Text> : null}
          </View>

          <Stage label="TISSU FINI" icon={<RollIcon />} entries={article.tissuFini} partnerLabel="Sous-traitant" />
          <Stage label="TOMBÉ DE MÉTIER" icon={<KnitIcon />} entries={article.tombeMetier} partnerLabel="Sous-traitant" />
          <Stage label="FIL" icon={<YarnIcon />} entries={article.fils} partnerLabel="Fournisseur" />
        </View>
      ))}
    </MalterreDocument>
  )
}
