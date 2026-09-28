// PDF document for the ETS Malterre CGV (Conditions Générales de Vente).
// Attached to every devis and confirmation-de-commande email and served by
// GET /commandes-client/cgv/pdf (rendered and cached by lib/cgv.ts). The text
// below is the legal source of truth: version « septembre 2026 », written by
// Isabelle Malterre (CGV_ETS_Malterre_2026.docx, sent 2026-09-08) after the
// legal review of 2026-09-08. Transcribed verbatim, except the consumer
// sentence, printed once in the notice box instead of twice.
//
// Editing the text = bump CGV_VERSION in lib/cgv.ts — the devis and the
// confirmation print that version in their acceptance mention.
//
// Layout: two cartouches (seller / document) over two columns of articles.
// react-pdf never flows text from one column into the next, so the columns
// are filled here (layoutCgv) from an estimate of each paragraph's height,
// splitting a paragraph between words when a column is full. The estimate is
// not a measure, so lib/cgv.ts renders, counts the pages and, when a column
// overflowed (more pages than planned), lays out again with fuller margins.

import React from 'react'
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import { MalterreDocument, FactoryIcon, CalendarIcon, UserIcon, LandmarkIcon, TagIcon, CreditCardIcon } from './MalterreDocument.js'
import { colors, sizes } from './theme.js'

interface Article {
  title: string
  paragraphs: string[]
  /** Paragraph indexes printed in bold (the jurisdiction clause must be
   *  « très apparente », art. 48 CPC). */
  bold?: number[]
}

const AVERTISSEMENT =
  'IMPORTANT — Les présentes CGV sont réservées aux clients agissant à des fins professionnelles. Elles ne sont pas adaptées aux ventes conclues avec des consommateurs.'

const ARTICLES: Article[] = [
  {
    title: 'ARTICLE 1 — CHAMP D’APPLICATION ET COMMANDES',
    paragraphs: [
      'Les présentes conditions générales de vente (« CGV ») régissent toutes les ventes de produits, matières, étoffes, mailles, articles textiles ou techniques et opérations accessoires réalisées par ETS MALTERRE au profit de clients agissant à des fins professionnelles (« le Client »).',
      'Toute commande implique l’acceptation sans réserve des CGV en vigueur. Elles prévalent sur les conditions d’achat ou tout autre document du Client, sauf dérogation expressément acceptée par écrit par ETS MALTERRE. Les conditions particulières du devis, de la confirmation de commande, de la fiche technique ou d’un accord écrit complètent les CGV et prévalent en cas de contradiction.',
      'Les offres et devis sont valables pendant la durée indiquée ou, à défaut, trente jours, sous réserve de la disponibilité des matières et des capacités de production. Les engagements oraux ne deviennent définitifs qu’après confirmation écrite.',
      'La commande n’est ferme qu’après acceptation écrite par ETS MALTERRE, matérialisée par l’envoi de sa confirmation de commande, et, lorsqu’il est demandé, encaissement de l’acompte ou du paiement convenu.',
      'Toute modification après confirmation est soumise à l’accord d’ETS MALTERRE et peut entraîner une révision du prix, des quantités, des délais ou des conditions techniques. Les produits spéciaux, personnalisés, teints, ennoblis, découpés, fabriqués ou approvisionnés spécialement pour le Client ne peuvent être annulés sans accord écrit. En cas d’accord, le Client supporte les matières engagées, travaux réalisés, frais exposés et engagements irrévocables pris auprès de tiers.',
    ],
  },
  {
    title: 'ARTICLE 2 — PRODUITS, SPÉCIFICATIONS ET TOLÉRANCES TEXTILES',
    paragraphs: [
      'Les caractéristiques contractuelles résultent de la confirmation de commande, du devis accepté et, le cas échéant, de la fiche technique ou de l’échantillon de référence expressément validé. Les photographies, catalogues, nuanciers numériques et échantillons non validés sont indicatifs. Lors des échanges préalables relatifs au choix de la référence et à la communication du tarif, ETS MALTERRE transmet au Client la fiche technique correspondante. Cette fiche technique constitue le cahier des charges contractuel et définit les caractéristiques et tolérances auxquelles ETS MALTERRE s’engage pour la référence commandée.',
      'Le Client est responsable de l’exactitude de ses spécifications et doit vérifier que le produit convient à l’usage final envisagé. Avant tout lancement de série, il lui appartient d’effectuer les essais adaptés, notamment en matière de lavage, retrait, stabilité, vrillage, solidité, colorimétrie, confection et compatibilité avec les traitements ou contraintes prévus.',
      'Compte tenu de la nature des fibres, fils, mailles, teintures, apprêts et procédés industriels, le poids, la laize, la longueur, le rendement, le retrait, la stabilité, le vrillage, l’élasticité, la nuance, le toucher, l’aspect et les quantités peuvent varier dans les limites fixées par les documents contractuels ou, à défaut, par les tolérances professionnelles usuelles. Des différences normales peuvent apparaître entre échantillons, lots, bains et productions successives. Les écarts mineurs n’altérant pas l’usage convenu ne constituent pas une non-conformité.',
      'Les tolérances chiffrées spécifiques doivent être convenues par écrit dans la fiche technique, le cahier des charges ou la confirmation de commande.',
      'Lorsque le Client fournit des fils, matières, supports, modèles, fichiers, logos ou autres éléments, il garantit leur conformité, leur aptitude, les quantités nécessaires et les droits permettant leur utilisation. ETS MALTERRE n’est pas responsable des défauts ou pertes techniques résultant de ces éléments, sauf faute prouvée dans leur manipulation.',
    ],
  },
  {
    title: 'ARTICLE 3 — PRIX ET PAIEMENT',
    paragraphs: [
      'Les prix sont ceux du tarif en vigueur, du devis accepté ou de la confirmation de commande. Ils sont exprimés hors taxes. La TVA, les taxes, droits de douane, emballages spécifiques, assurances particulières, formalités, livraisons urgentes, spéciales ou fractionnées et autres prestations non prévues sont facturés en sus.',
      'Les prix tiennent compte notamment de la composition, du grammage, de la laize, des quantités, coloris, transformations, contrôles et modalités de livraison. Les éventuelles remises sont précisées dans les conditions particulières. Avant acceptation, ETS MALTERRE peut réviser son offre en cas d’évolution significative du coût des matières, de l’énergie, du transport, des changes, des taxes ou de la sous-traitance.',
      'Les modalités de paiement sont fixées pour chaque commande dans le devis, la confirmation de commande ou la facture. Elles peuvent prévoir un paiement à la commande, un acompte, un paiement avant expédition ou livraison, un paiement comptant ou une échéance postérieure dans les limites légales. À défaut de condition écrite, le paiement est exigible à trente jours à compter de la réception des marchandises ou de l’exécution de la prestation. Aucun escompte n’est accordé pour paiement anticipé, sauf accord contraire.',
      'Toute somme non payée à l’échéance entraîne, de plein droit et sans rappel préalable, des pénalités calculées au taux égal à trois fois le taux d’intérêt légal en vigueur, dès le lendemain de l’échéance jusqu’au paiement effectif. Le Client professionnel est également redevable d’une indemnité forfaitaire de quarante euros par facture pour frais de recouvrement, sans préjudice d’une indemnisation complémentaire sur justificatifs.',
      'En cas de retard, d’incident de paiement ou de dégradation du crédit du Client, ETS MALTERRE peut suspendre les commandes, refuser une livraison, exiger des garanties ou un paiement avant livraison et rendre exigibles les autres sommes dues, après mise en demeure lorsqu’elle est légalement requise. Toute compensation ou retenue unilatérale est interdite, sauf créance certaine, liquide et exigible reconnue par ETS MALTERRE ou constatée définitivement.',
    ],
  },
  {
    title: 'ARTICLE 4 — DÉLAIS, LIVRAISON ET TRANSPORT',
    paragraphs: [
      'Sauf engagement exprès qualifié d’impératif, les délais sont indicatifs. Ils commencent à courir après réception de toutes les informations, validations, matières et sommes nécessaires. Toute modification ou validation tardive du Client prolonge le délai. Un retard raisonnable ne justifie ni annulation, ni refus, ni pénalité sans mise en demeure préalable accordant un délai supplémentaire adapté. Les livraisons partielles sont autorisées lorsqu’elles ne privent pas la commande de son utilité essentielle.',
      'ETS MALTERRE organise habituellement le transport selon l’offre ou la confirmation de commande. Les conditions peuvent varier en cas de livraison spéciale, urgente, fractionnée ou internationale.',
      'Sauf condition particulière ou Incoterm expressément convenu, la livraison et le transfert des risques interviennent lors de la remise des marchandises au premier transporteur, même lorsque le transport est organisé, avancé ou annoncé franco par ETS MALTERRE. En cas d’enlèvement par le Client ou son transporteur, ils interviennent lors de la mise à disposition ou de la remise au transporteur mandaté.',
      'Le Client doit contrôler les colis à réception et formuler sur le document de transport des réserves précises et motivées en cas de perte, avarie ou manquant. Pour le transport national routier, il doit notifier au transporteur sa protestation motivée, par lettre recommandée ou acte extrajudiciaire, dans les trois jours, non compris les jours fériés, suivant la réception, conformément à l’article L. 133-3 du Code de commerce, et en transmettre immédiatement copie à ETS MALTERRE. Les transports internationaux sont soumis aux conventions, Incoterms et délais applicables.',
    ],
  },
  {
    title: 'ARTICLE 5 — RÉCEPTION, CONTRÔLE ET RÉCLAMATIONS',
    paragraphs: [
      'Le Client doit contrôler les marchandises dès leur réception et impérativement avant toute coupe, confection, transformation, assemblage, traitement, lavage, mise sur le marché ou remise à un tiers.',
      'Toute réclamation relative à un défaut apparent, une non-conformité décelable, une erreur de référence, de quantité, de coloris ou de dimensions doit être adressée par écrit dans les cinq jours ouvrés suivant la réception. Elle doit identifier la commande et le lot, préciser les quantités et le défaut et comporter les photographies, échantillons ou résultats de contrôle utiles. À défaut de réclamation formulée dans ce délai, les marchandises sont réputées conformes et acceptées au titre des défauts apparents ou décelables dans le cadre d’un contrôle professionnel normal. Cette disposition ne s’applique pas aux vices cachés.',
      'Les marchandises concernées doivent être conservées dans leur état initial et tenues à disposition d’ETS MALTERRE. Aucun retour n’est accepté sans accord écrit préalable. Leur transformation ou utilisation sans réserve vaut acceptation des défauts apparents décelables par un contrôle professionnel normal.',
      'En cas de non-conformité reconnue imputable à ETS MALTERRE, celle-ci peut, selon la solution appropriée, réparer, trier, remplacer les marchandises ou émettre un avoir. Les vices non décelables lors du contrôle initial doivent être signalés dès leur découverte, avec justificatifs, dans les délais légaux applicables.',
    ],
  },
  {
    title: 'ARTICLE 6 — RÉSERVE DE PROPRIÉTÉ',
    paragraphs: [
      'ETS MALTERRE conserve la propriété des marchandises jusqu’au paiement intégral du prix, des taxes et accessoires, entendu comme l’encaissement effectif des sommes dues.',
      'Jusqu’au paiement, le Client doit conserver les marchandises de manière à permettre leur identification, les assurer pour leur valeur et informer immédiatement ETS MALTERRE de toute saisie, revendication d’un tiers ou procédure collective.',
      'En cas de défaut de paiement, ETS MALTERRE peut revendiquer ou reprendre les marchandises encore identifiables dans le respect des règles applicables. Le Client supporte les frais raisonnables de conservation et de reprise. Cette clause n’empêche pas le transfert antérieur des risques prévu à l’article 4.',
    ],
  },
  {
    title: 'ARTICLE 7 — RESPONSABILITÉ ET FORCE MAJEURE',
    paragraphs: [
      'ETS MALTERRE répond des dommages directs, certains et prévisibles résultant d’un manquement qui lui est imputable. Lorsque sa responsabilité est établie, la réparation est limitée, selon le cas, à la réparation, au remplacement, au remboursement ou à l’avoir relatif aux marchandises reconnues non conformes.',
      'Sauf faute lourde ou dolosive, dommage corporel ou disposition impérative contraire, ETS MALTERRE ne répond pas des dommages indirects ou immatériels, notamment pertes de production, d’exploitation, de marge ou de clientèle, atteinte à l’image ou frais de rappel engagés sans son accord. Sous les mêmes réserves, la responsabilité totale d’ETS MALTERRE, toutes causes confondues, ne peut excéder le montant hors taxes facturé au titre des marchandises ou de la partie de la commande directement à l’origine du dommage.',
      'ETS MALTERRE n’est pas responsable d’un défaut résultant des spécifications ou éléments fournis par le Client, d’un stockage inadapté, d’un usage anormal, d’une transformation, d’un entretien non conforme, de l’usure normale ou du non-respect des recommandations et règles de l’art.',
      'Aucune partie n’est responsable d’un manquement résultant d’un événement répondant aux critères de la force majeure de l’article 1218 du Code civil. Les obligations affectées sont suspendues pendant l’empêchement. S’il dépasse soixante jours et prive la commande de son intérêt essentiel, chaque partie peut résilier la partie non exécutée sans indemnité, sous réserve du paiement des produits réalisés et frais irrévocablement engagés.',
    ],
  },
  {
    title: 'ARTICLE 8 — PROPRIÉTÉ INTELLECTUELLE, CONFIDENTIALITÉ ET DONNÉES',
    paragraphs: [
      'Les études, dessins, plans, échantillons, prototypes, procédés, savoir-faire, documents techniques et outils conçus ou fournis par ETS MALTERRE demeurent sa propriété, sauf cession écrite expresse. Ils ne peuvent être reproduits, exploités, transmis ou communiqués à un tiers en dehors de la commande.',
      'Chaque partie préserve la confidentialité des informations techniques, commerciales ou financières identifiées comme confidentielles ou dont ce caractère ressort des circonstances, à l’exception des informations publiques, déjà légitimement connues ou obtenues licitement d’un tiers.',
      'ETS MALTERRE traite les données professionnelles de contact nécessaires à la gestion des devis, commandes, livraisons, factures, paiements, réclamations et relations commerciales. Les personnes concernées peuvent exercer leurs droits à l’adresse contact@etsmalterre.com ou auprès du siège social.',
    ],
  },
  {
    title: 'ARTICLE 9 — DROIT APPLICABLE ET JURIDICTION',
    paragraphs: [
      'Les CGV et les ventes sont régies par le droit français. Pour les ventes internationales, la Convention des Nations unies du 11 avril 1980 sur la vente internationale de marchandises est exclue, sauf accord écrit contraire.',
      'TOUT LITIGE ENTRE COMMERÇANTS RELATIF À LA FORMATION, L’INTERPRÉTATION, L’EXÉCUTION OU LA RÉSILIATION D’UNE VENTE RELÈVE DE LA COMPÉTENCE EXCLUSIVE DU TRIBUNAL DE COMMERCE D’AMIENS, Y COMPRIS EN CAS D’APPEL EN GARANTIE OU DE PLURALITÉ DE DÉFENDEURS, SOUS RÉSERVE DES RÈGLES IMPÉRATIVES APPLICABLES.',
      'Lorsque le Client n’a pas contracté en qualité de commerçant, les règles légales de compétence territoriale s’appliquent. Avant toute action judiciaire, les parties s’efforcent de rechercher une solution amiable, sans renoncer aux mesures conservatoires ou urgentes.',
    ],
    bold: [1],
  },
  {
    title: 'ARTICLE 10 — DISPOSITIONS FINALES',
    paragraphs: [
      'Le fait pour ETS MALTERRE de ne pas se prévaloir d’une stipulation ne vaut pas renonciation. La nullité d’une clause n’affecte pas les autres dispositions. Toute dérogation doit être établie par écrit.',
      'La version applicable est celle remise au Client ou rendue accessible sur un support durable lors de la commande. ETS MALTERRE peut modifier les CGV pour les commandes futures.',
    ],
  },
]

// ── Two-column pagination ────────────────────────────────

// Geometry (pt). A4 = 595 × 842; MalterreDocument reserves a 96 pt header
// band, 80 pt at the bottom and 36 pt on each side.
const COLUMN_GAP = 16
const COLUMN_WIDTH = (595 - 2 * 36 - COLUMN_GAP) / 2
const PAGE_BODY_HEIGHT = 842 - 96 - 80
/** Page 1 loses the content padding, the cartouches and the notice box. */
const FIRST_PAGE_HEIGHT = PAGE_BODY_HEIGHT - 20 - 118 - 44
/** Continuation pages open with a small gap under the header band. */
const NEXT_PAGE_HEIGHT = PAGE_BODY_HEIGHT - 12
/** Kept free at the bottom of every column: the estimate is not a measure. */
const SAFETY = 10

const BODY_SIZE = 7.2
const BODY_LEADING = 1.38
const PARA_GAP = 2.5
const TITLE_SIZE = 7.8
const TITLE_LEADING = 1.2
const TITLE_GAP_ABOVE = 7
const TITLE_GAP_BELOW = 2.5
/** Average Lato glyph width in em, measured on this text (0.44) + margin for
 *  the words that do not fit at the end of a line. Bold / caps run wider. */
const EM_REGULAR = 0.475
const EM_BOLD = 0.6

type Chunk =
  | { kind: 'title'; text: string }
  | { kind: 'p'; text: string; bold: boolean }

function lineCount(text: string, size: number, em: number): number {
  const perLine = Math.floor(COLUMN_WIDTH / (size * em))
  // Word-by-word fill, like the real line breaker.
  let lines = 1
  let used = 0
  for (const w of text.split(' ')) {
    const len = w.length + (used > 0 ? 1 : 0)
    if (used + len > perLine) { lines++; used = w.length } else used += len
  }
  return lines
}

function chunkHeight(c: Chunk, first: boolean): number {
  if (c.kind === 'title') {
    return (first ? 0 : TITLE_GAP_ABOVE) + lineCount(c.text, TITLE_SIZE, EM_BOLD) * TITLE_SIZE * TITLE_LEADING + TITLE_GAP_BELOW
  }
  return lineCount(c.text, BODY_SIZE, c.bold ? EM_BOLD : EM_REGULAR) * BODY_SIZE * BODY_LEADING + PARA_GAP
}

/** Splits `text` so the head fits in `lines` lines; null when not even two
 *  lines fit (no widow line at the bottom of a column). */
function splitToFit(text: string, lines: number, em: number): [string, string] | null {
  if (lines < 2) return null
  const words = text.split(' ')
  let lo = 1
  let hi = words.length - 1
  let best = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lineCount(words.slice(0, mid).join(' '), BODY_SIZE, em) <= lines) { best = mid; lo = mid + 1 } else hi = mid - 1
  }
  // Leave at least a few words for the next column.
  if (best < 4 || words.length - best < 4) return null
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')]
}

/** Pages → [left column, right column] of chunks. */
export type CgvPlan = Chunk[][][]

/** Page plan filling each column to `fill` (0..1) of its estimated height. */
export function layoutCgv(fill = 1): CgvPlan {
  return layoutColumns(ARTICLES, fill)
}

function layoutColumns(articles: Article[], fill: number): CgvPlan {
  const queue: Chunk[] = []
  for (const a of articles) {
    queue.push({ kind: 'title', text: a.title })
    a.paragraphs.forEach((text, i) => queue.push({ kind: 'p', text, bold: a.bold?.includes(i) ?? false }))
  }
  const columns: Chunk[][] = []
  let col: Chunk[] = []
  const capacity = () => (columns.length < 2 ? FIRST_PAGE_HEIGHT : NEXT_PAGE_HEIGHT) * fill - SAFETY
  let room = capacity()
  const nextColumn = () => { columns.push(col); col = []; room = capacity() }

  while (queue.length > 0) {
    const c = queue.shift()!
    const h = chunkHeight(c, col.length === 0)
    if (c.kind === 'title') {
      // Keep the title with at least two lines of its first paragraph.
      const keep = h + 2 * BODY_SIZE * BODY_LEADING
      if (keep > room && col.length > 0) { nextColumn() }
      col.push(c)
      room -= chunkHeight(c, col.length === 1)
      continue
    }
    if (h <= room) { col.push(c); room -= h; continue }
    const em = c.bold ? EM_BOLD : EM_REGULAR
    const fit = Math.floor((room - PARA_GAP) / (BODY_SIZE * BODY_LEADING))
    const parts = splitToFit(c.text, fit, em)
    if (parts) {
      col.push({ ...c, text: parts[0] })
      queue.unshift({ ...c, text: parts[1] })
    } else {
      queue.unshift(c)
    }
    nextColumn()
  }
  if (col.length > 0) columns.push(col)
  const pages: Chunk[][][] = []
  for (let i = 0; i < columns.length; i += 2) pages.push([columns[i], columns[i + 1] ?? []])
  return pages
}

// ── Styles ───────────────────────────────────────────────

const styles = StyleSheet.create({
  topRow: { flexDirection: 'row', gap: COLUMN_GAP, marginBottom: 10, alignItems: 'stretch' },
  topRowSlot: { flex: 1, flexDirection: 'column' },
  // Same cream cartouche as the confirmation de commande / devis.
  card: {
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
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 5 },
  cardTitle: { fontSize: sizes.fontXs, color: colors.primary, fontWeight: 900, letterSpacing: 0.5, lineHeight: 1 },
  cardName: { fontSize: sizes.fontBase, fontWeight: 900, color: colors.text, marginBottom: 1 },
  cardLine: { fontSize: sizes.fontBase, color: colors.text, lineHeight: 1.4 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
  metaIconBox: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  metaLabel: { fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, flex: 1, lineHeight: 1 },
  metaValue: { fontSize: sizes.fontBase, color: colors.text, fontWeight: 700, textAlign: 'right', lineHeight: 1 },
  avertissement: {
    backgroundColor: colors.bgMuted,
    borderRadius: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontSize: 7.5,
    fontWeight: 700,
    color: colors.primary,
    lineHeight: 1.35,
    textAlign: 'center',
    marginBottom: 10,
  },
  columns: { flexDirection: 'row', gap: COLUMN_GAP },
  columnsNextPage: { paddingTop: 12 },
  column: { width: COLUMN_WIDTH },
  articleTitle: {
    fontSize: TITLE_SIZE,
    fontWeight: 900,
    color: colors.primary,
    letterSpacing: 0.3,
    lineHeight: TITLE_LEADING,
    marginTop: TITLE_GAP_ABOVE,
    marginBottom: TITLE_GAP_BELOW,
  },
  firstInColumn: { marginTop: 0 },
  paragraph: {
    fontSize: BODY_SIZE,
    color: colors.text,
    lineHeight: BODY_LEADING,
    textAlign: 'justify',
    marginBottom: PARA_GAP,
  },
  bold: { fontWeight: 900 },
  version: {
    marginTop: 8,
    fontSize: 6.8,
    color: colors.muted,
    textAlign: 'right',
  },
})

function MetaRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <View style={styles.metaIconBox}>{icon}</View>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  )
}

function ChunkView({ chunk, first }: { chunk: Chunk; first: boolean }) {
  if (chunk.kind === 'title') {
    return <Text style={first ? [styles.articleTitle, styles.firstInColumn] : styles.articleTitle}>{chunk.text}</Text>
  }
  return <Text style={chunk.bold ? [styles.paragraph, styles.bold] : styles.paragraph}>{chunk.text}</Text>
}

export function CgvPdf({ version, plan }: { version: string; plan: CgvPlan }) {
  const lastPage = plan.length - 1
  // The version line closes the text: under the last non-empty column.
  const lastColumn = plan[lastPage]?.[1]?.length ? 1 : 0
  return (
    <MalterreDocument
      // No accent on purpose — the uppercased É renders badly in the header font.
      documentType="Conditions Generales de Vente"
      compactTitle
      reference={`VERSION ${version.toUpperCase()}`}
      documentDate=""
      title={`Conditions Générales de Vente - ETS Malterre - version ${version}`}
    >
      <View style={styles.topRow} wrap={false}>
        <View style={styles.topRowSlot}>
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <FactoryIcon />
              <Text style={styles.cardTitle}>VENDEUR</Text>
            </View>
            <Text style={styles.cardName}>ETS MALTERRE</Text>
            <Text style={styles.cardLine}>SARL au capital de 7 750 €</Text>
            <Text style={styles.cardLine}>ZI Route de Thennes — 80110 Moreuil — France</Text>
            <Text style={styles.cardLine}>03 22 35 36 66 — contact@etsmalterre.com</Text>
          </View>
        </View>
        <View style={styles.topRowSlot}>
          <View style={styles.card}>
            <MetaRow icon={<CalendarIcon />} label="Version" value={version.charAt(0).toUpperCase() + version.slice(1)} />
            <MetaRow icon={<UserIcon size={11} />} label="Clientèle" value="Professionnels" />
            <MetaRow icon={<LandmarkIcon />} label="RCS" value="Amiens 430 382 135" />
            <MetaRow icon={<TagIcon />} label="SIRET" value="430 382 135 00019" />
            <MetaRow icon={<CreditCardIcon />} label="N° TVA" value="FR 78 430 382 135" />
          </View>
        </View>
      </View>
      <Text style={styles.avertissement} wrap={false}>
        Ventes de produits textiles et articles techniques. {AVERTISSEMENT}
      </Text>
      {plan.map((cols, p) => (
        <View key={p} style={p > 0 ? [styles.columns, styles.columnsNextPage] : styles.columns} {...(p > 0 ? { break: true } : {})} wrap={false}>
          {cols.map((chunks, c) => (
            <View key={c} style={styles.column}>
              {chunks.map((chunk, i) => <ChunkView key={i} chunk={chunk} first={i === 0} />)}
              {p === lastPage && c === lastColumn && (
                <Text style={styles.version}>CGV ETS MALTERRE — version {version}</Text>
              )}
            </View>
          ))}
        </View>
      ))}
    </MalterreDocument>
  )
}
