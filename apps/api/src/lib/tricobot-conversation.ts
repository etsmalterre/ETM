// What Tricobot did with one Gmail conversation — read by the Tricobot Gmail
// extension (apps/gmail-extension: side panel next to a mail opened in
// contact@). For each message of the conversation: the Triage's categories
// and reasoning, what it handed to which agent, and what those agents did
// (BL Ennoblisseur: the rolls pre-filled; Factures Ennoblisseur: the invoice
// and its checked lines). Read-only: the panel corrects through the existing
// routes (Triage categories, run evaluation / « vérifié », invoice line avis).
//
// Matching: Gmail web exposes the Gmail API's hex ids (data-legacy-thread-id /
// data-legacy-message-id), which is what every run stores in `message`.
// Those ids are PER MAILBOX: the same mail in isabelle@ has other ids, so a
// conversation is only matched against the agents that read that mailbox.

import { lireRuns, noteBinaire, type AgentRun, type Evaluation, type RunStatut } from './agents/store.js'
import { TRIAGE_BOITE, TRIAGE_SLUG, resultatTriage } from './agents/triage/agent.js'
import { CATEGORIES } from './agents/triage/categories.js'
import { BL_ENNOBLISSEUR_BOITE, BL_ENNOBLISSEUR_SLUG, type ResultatBl } from './agents/bl-ennoblisseur.js'
import { FACTURES_SST_BOITE, FACTURES_SST_SLUG, type ResultatFacture } from './agents/factures-sst/agent.js'
import { mpsPg } from './mps-pg.js'
import { lireFil, sansCitation, type MessageComplet } from './gmail-reader.js'
import { estInterne } from './agents/triage/annuaire.js'

// ── Shapes sent to the extension (apps/gmail-extension/src/types.ts) ──

export interface Avis {
  note: 'reussite' | 'echec'
  commentaire: string
  par: string
  le: string
}

export interface TriageVue {
  runId: string
  statut: RunStatut
  mode: AgentRun['mode']
  erreur: string | null
  /** What stands: the model's, or a person's correction. */
  categories: string[]
  categoriesAgent: string[]
  sousCategories: Record<string, string | null>
  raison: string
  organisation: { type: string; nom: string } | null
  piecesJointes: string[]
  transmissions: Array<{
    agent: string
    nom: string
    statut: 'transmis' | 'deja_traite' | 'non_transmis' | 'erreur'
    raison: string | null
    runs: Array<{ id: string; statut: string; resume: string }>
  }>
  corrections: Array<{ avant: string[]; apres: string[]; commentaire: string; par: string; le: string }>
  /** Where the correction is PUT (routes/agents-ia.ts). */
  cheminCorrection: string
  lien: string
}

export interface BlVue {
  runId: string
  statut: RunStatut
  mode: AgentRun['mode']
  resume: string
  erreur: string | null
  typeDocument: string | null
  bordereau: string | null
  commande: string | null
  lot: string | null
  pieces: Array<{ numero: string; poids: number | null; metrage: number | null; observations: string; statut: string | null }>
  totaux: { pieces: number | null; poids: number | null; metrage: number | null } | null
  controles: Array<{ gravite: string; message: string }>
  evaluation: Avis | null
  verification: { commentaire: string; par: string; le: string } | null
  cheminEvaluation: string
  cheminVerifie: string
  lien: string
  lienCommande: string | null
}

export interface LigneFactureVue {
  /** ligne_facture_sst id, null while the invoice is not in ETM (essai, error). */
  id: number | null
  designation: string
  lot: string
  quantite: number | null
  unite: string
  prixUnitaire: number | null
  montant: number | null
  prixAttendu: number | null
  verdict: 'conforme' | 'ecart' | 'info'
  nature: 'reel' | 'non_verifie' | null
  ecartMontant: number
  controles: string[]
  verdictFinal: 'conforme' | 'ecart' | null
  avis: Avis | null
}

export interface FactureVue {
  runId: string
  statut: RunStatut
  mode: AgentRun['mode']
  resume: string
  erreur: string | null
  idFacture: number | null
  numero: string | null
  fournisseur: string | null
  date: string | null
  totalHt: number | null
  statutFacture: 'conforme' | 'ecarts' | null
  ecartMontant: number
  /** validee / reclamee / reclamation_close — closed: lines are read-only. */
  traitement: string | null
  traitePar: string | null
  controles: string[]
  lignes: LigneFactureVue[]
  lien: string
  lienRun: string
}

export interface MessageVue {
  id: string
  threadId: string
  de: string
  sujet: string
  date: string
  triage: TriageVue | null
  bl: BlVue[]
  factures: FactureVue[]
}

export interface ConversationVue {
  boite: string | null
  /** Whether some agent reads this mailbox at all. */
  suivie: boolean
  messages: MessageVue[]
  categories: Array<{ cle: string; libelle: string; description: string; agent: string | null }>
}

/** An invoice as stored in PG (facture_sst + its lines). */
export interface FacturePg {
  id: number
  runId: string | null
  messageId: string | null
  numero: string
  traitement: string | null
  traitePar: string | null
  statut: 'conforme' | 'ecarts'
  ecartMontant: number
  lignes: LigneFactureVue[]
}

// ── Pure builder ─────────────────────────────────────────

const lienRun = (slug: string, id: string) => `/agents-ia/agents?agent=${encodeURIComponent(slug)}&run=${encodeURIComponent(id)}`

function avis(e: Evaluation | null | undefined): Avis | null {
  if (!e) return null
  return { note: noteBinaire(e.note), commentaire: e.commentaire ?? '', par: e.par?.nom ?? '', le: e.le }
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** The agents that read a mailbox (case-insensitive address). */
export function agentsDeLaBoite(boite: string | null): Set<string> {
  const b = boite?.trim().toLowerCase() ?? null
  const out = new Set<string>()
  const lit = (adresse: string) => b === null || adresse.toLowerCase() === b
  if (lit(TRIAGE_BOITE)) out.add(TRIAGE_SLUG)
  if (lit(BL_ENNOBLISSEUR_BOITE)) out.add(BL_ENNOBLISSEUR_SLUG)
  if (lit(FACTURES_SST_BOITE)) out.add(FACTURES_SST_SLUG)
  return out
}

function concerne(r: AgentRun, threadId: string | null, ids: ReadonlySet<string>): boolean {
  const m = r.message
  if (!m) return false
  return ids.has(m.id.toLowerCase()) || (threadId !== null && m.threadId.toLowerCase() === threadId)
}

function triageVue(r: AgentRun): TriageVue {
  const t = resultatTriage(r)
  const org = t.expediteur?.organisation ?? null
  return {
    runId: r.id,
    statut: r.statut,
    mode: r.mode,
    erreur: r.erreur ?? null,
    categories: t.categories ?? [],
    categoriesAgent: t.categoriesAgent ?? [],
    sousCategories: t.sousCategories ?? {},
    raison: t.raison ?? '',
    organisation: org ? { type: org.type, nom: org.nom } : null,
    piecesJointes: t.piecesJointes ?? [],
    transmissions: (t.transmissions ?? []).map((x) => ({ agent: x.agent, nom: x.nom, statut: x.statut, raison: x.raison, runs: x.runs ?? [] })),
    corrections: (t.corrections ?? []).map((c) => ({ avant: c.avant, apres: c.apres, commentaire: c.commentaire, par: c.par?.nom ?? '', le: c.le })),
    cheminCorrection: `/agents-ia/${TRIAGE_SLUG}/runs/${encodeURIComponent(r.id)}/categories`,
    lien: lienRun(TRIAGE_SLUG, r.id),
  }
}

function blVue(r: AgentRun): BlVue {
  const b = r.resultat as unknown as Partial<ResultatBl>
  const x = b.extraction ?? null
  const statutPiece = new Map((b.resolution?.pieces ?? []).map((p) => [p.numero_piece, p.statut]))
  const v = r.verification ?? null
  return {
    runId: r.id,
    statut: r.statut,
    mode: r.mode,
    resume: r.resume,
    erreur: r.erreur ?? null,
    typeDocument: b.typeDocument ?? null,
    bordereau: x?.numero_bordereau || null,
    commande: x?.numero_commande || null,
    lot: b.resolution?.lot ?? null,
    pieces: (x?.pieces ?? []).map((p) => ({
      numero: p.numero_piece,
      poids: num(p.poids),
      metrage: num(p.metrage),
      observations: p.observations ?? '',
      statut: statutPiece.get(p.numero_piece) ?? null,
    })),
    totaux: x ? { pieces: num(x.nombre_pieces), poids: num(x.poids_total), metrage: num(x.metrage_total) } : null,
    controles: (b.controles ?? []).map((c) => ({ gravite: c.gravite, message: c.message })),
    evaluation: avis(r.evaluation),
    verification: v ? { commentaire: v.commentaire, par: v.par?.nom ?? '', le: v.le } : null,
    cheminEvaluation: `/agents-ia/${BL_ENNOBLISSEUR_SLUG}/runs/${encodeURIComponent(r.id)}/evaluation`,
    cheminVerifie: `/agents-ia/${BL_ENNOBLISSEUR_SLUG}/runs/${encodeURIComponent(r.id)}/verifie`,
    lien: lienRun(BL_ENNOBLISSEUR_SLUG, r.id),
    lienCommande: b.resolution?.commandeId ? `/sous-traitants/ennoblissement?commande=${b.resolution.commandeId}` : null,
  }
}

/** The stored invoice a run wrote: by the id on the run, else by the run id
 *  facture_sst keeps, else by mail + invoice number (a re-imported invoice,
 *  or a copy of the database where the ids differ). */
export function factureDuRun(r: AgentRun, pg: readonly FacturePg[]): FacturePg | null {
  const f = r.resultat as unknown as Partial<ResultatFacture>
  const id = f.ecriture?.idFacture
  const numero = f.extraction?.numero_facture
  return (
    pg.find((x) => x.id === id) ??
    pg.find((x) => x.runId === r.id) ??
    pg.find((x) => !!numero && x.numero === numero && x.messageId === r.message?.id) ??
    null
  )
}

function factureVue(r: AgentRun, pg: readonly FacturePg[]): FactureVue {
  const f = r.resultat as unknown as Partial<ResultatFacture>
  const x = f.extraction ?? null
  const stockee = factureDuRun(r, pg)
  // The run's own lines while the invoice is not (or no longer) in ETM.
  const lignesRun: LigneFactureVue[] = (f.verification?.lignes ?? []).map((l) => ({
    id: null,
    designation: l.ligne.description ?? '',
    lot: l.lotEtm || l.ligne.lot || '',
    quantite: num(l.ligne.quantite),
    unite: l.ligne.unite ?? '',
    prixUnitaire: num(l.ligne.prix_unitaire),
    montant: num(l.ligne.montant),
    prixAttendu: num(l.etm?.prixAttendu),
    verdict: l.verdict,
    nature: l.nature ?? null,
    ecartMontant: num(l.ecartMontant) ?? 0,
    controles: (l.controles ?? []).map((c) => c.message),
    verdictFinal: null,
    avis: null,
  }))
  return {
    runId: r.id,
    statut: r.statut,
    mode: r.mode,
    resume: r.resume,
    erreur: r.erreur ?? null,
    idFacture: stockee ? stockee.id : null,
    numero: x?.numero_facture ?? null,
    fournisseur: x?.fournisseur ?? null,
    date: x?.date_facture ?? null,
    totalHt: num(x?.total_ht),
    statutFacture: stockee?.statut ?? f.statutFacture ?? null,
    ecartMontant: stockee?.ecartMontant ?? num(f.verification?.ecartMontant) ?? 0,
    traitement: stockee?.traitement ?? null,
    traitePar: stockee?.traitePar ?? null,
    controles: (f.verification?.controles ?? []).map((c) => c.message),
    lignes: stockee ? stockee.lignes : lignesRun,
    lien: stockee ? `/sous-traitants/factures?facture=${stockee.id}` : lienRun(FACTURES_SST_SLUG, r.id),
    lienRun: lienRun(FACTURES_SST_SLUG, r.id),
  }
}

export interface EntreeConversation {
  boite: string | null
  threadId: string | null
  messageIds: readonly string[]
  runs: Partial<Record<string, readonly AgentRun[]>>
  factures: readonly FacturePg[]
}

/** Every message of the conversation some agent handled, oldest first. Pure. */
export function construireConversation(e: EntreeConversation): ConversationVue {
  const agents = agentsDeLaBoite(e.boite)
  const threadId = e.threadId?.toLowerCase() ?? null
  const ids = new Set(e.messageIds.map((i) => i.toLowerCase()))
  const messages = new Map<string, MessageVue>()
  const message = (r: AgentRun): MessageVue => {
    const m = r.message!
    let v = messages.get(m.id)
    if (!v) {
      v = { id: m.id, threadId: m.threadId, de: m.de, sujet: m.sujet, date: m.date, triage: null, bl: [], factures: [] }
      messages.set(m.id, v)
    }
    return v
  }
  const runsDe = (slug: string) => (agents.has(slug) ? (e.runs[slug] ?? []) : []).filter((r) => concerne(r, threadId, ids))

  // Newest triage of a message wins (a failed one retried leaves several).
  const triageLe = new Map<string, string>()
  for (const r of runsDe(TRIAGE_SLUG)) {
    const v = message(r)
    if (!v.triage || r.createdAt >= triageLe.get(v.id)!) {
      v.triage = triageVue(r)
      triageLe.set(v.id, r.createdAt)
    }
  }
  for (const r of runsDe(BL_ENNOBLISSEUR_SLUG)) message(r).bl.push(blVue(r))
  for (const r of runsDe(FACTURES_SST_SLUG)) message(r).factures.push(factureVue(r, e.factures))

  return {
    boite: e.boite,
    suivie: agents.size > 0,
    messages: [...messages.values()].sort((a, b) => a.date.localeCompare(b.date)),
    categories: CATEGORIES.map((c) => ({ cle: c.cle, libelle: c.libelle, description: c.description, agent: c.cible ?? null })),
  }
}

// ── Loader ───────────────────────────────────────────────

async function facturesPg(runs: readonly AgentRun[]): Promise<FacturePg[]> {
  const out = new Map<number, FacturePg>()
  const ids = runs.map((r) => (r.resultat as Partial<ResultatFacture>).ecriture?.idFacture).filter((x): x is number => typeof x === 'number' && x > 0)
  const sql = mpsPg()
  const entetes = await sql<Array<{
    id: number; run_id: string | null; message_id: string | null; numero: string
    statut: 'conforme' | 'ecarts'; ecart_montant: string; traitement: string | null; traite_par_nom: string | null
  }>>`
    SELECT idfacture_sst AS id, run_id, message_id, numero, statut, ecart_montant, traitement, traite_par_nom FROM facture_sst
    WHERE idfacture_sst IN ${sql(ids.length ? ids : [0])}
       OR run_id IN ${sql(runs.map((r) => r.id))}
       OR message_id IN ${sql(runs.map((r) => r.message?.id ?? ''))}`
  if (!entetes.length) return []
  const trouvees = entetes.map((f) => Number(f.id))
  const lignes = await sql<Record<string, unknown>[]>`
    SELECT idligne_facture_sst AS id, idfacture_sst, designation, lot, quantite, unite, prix_unitaire, montant, prix_attendu,
           verdict, nature, ecart_montant, controles, verdict_final, avis_note, avis_commentaire, avis_par_nom, avis_le
    FROM ligne_facture_sst WHERE idfacture_sst IN ${sql(trouvees)} ORDER BY idfacture_sst, ordre`
  for (const f of entetes) {
    out.set(Number(f.id), { id: Number(f.id), runId: f.run_id, messageId: f.message_id, numero: f.numero, statut: f.statut, ecartMontant: num(f.ecart_montant) ?? 0, traitement: f.traitement, traitePar: f.traite_par_nom, lignes: [] })
  }
  for (const l of lignes) {
    const f = out.get(Number(l.idfacture_sst))
    if (!f) continue
    const controles = Array.isArray(l.controles) ? (l.controles as Array<{ message?: string }>) : []
    f.lignes.push({
      id: Number(l.id),
      designation: String(l.designation ?? ''),
      lot: String(l.lot ?? ''),
      quantite: num(l.quantite),
      unite: String(l.unite ?? ''),
      prixUnitaire: num(l.prix_unitaire),
      montant: num(l.montant),
      prixAttendu: num(l.prix_attendu),
      verdict: l.verdict as LigneFactureVue['verdict'],
      nature: (l.nature as LigneFactureVue['nature']) ?? null,
      ecartMontant: num(l.ecart_montant) ?? 0,
      controles: controles.map((c) => String(c.message ?? '')).filter(Boolean),
      verdictFinal: (l.verdict_final as LigneFactureVue['verdictFinal']) ?? null,
      avis: l.avis_note
        ? { note: noteBinaire(String(l.avis_note)), commentaire: String(l.avis_commentaire ?? ''), par: String(l.avis_par_nom ?? ''), le: new Date(l.avis_le as string).toISOString() }
        : null,
    })
  }
  return [...out.values()]
}

export async function chargerConversation(boite: string | null, threadId: string | null, messageIds: readonly string[]): Promise<ConversationVue> {
  const agents = agentsDeLaBoite(boite)
  const runs: Record<string, AgentRun[]> = {}
  await Promise.all([...agents].map(async (slug) => { runs[slug] = await lireRuns(slug) }))
  // Only the invoices of this conversation's runs are read from PG.
  const vide = construireConversation({ boite, threadId, messageIds, runs, factures: [] })
  const ids = new Set(vide.messages.flatMap((m) => m.factures.map((f) => f.runId)))
  if (!ids.size) return vide
  const runsFactures = (runs[FACTURES_SST_SLUG] ?? []).filter((r) => ids.has(r.id))
  return construireConversation({ boite, threadId, messageIds, runs, factures: await facturesPg(runsFactures) })
}

// ── The thread itself (the panel's « Conversation » tab) ──

/** One mail of the thread, as a chat bubble: the quoted history of a reply
 *  is cut (sansCitation), the full text stays in Gmail. */
export interface MessageFil {
  id: string
  de: string
  a: string
  cc: string
  date: string
  /** Sent by someone of the Malterre group: the bubble goes to the right. */
  interne: boolean
  texte: string
  /** Quoted history was cut from `texte`. */
  coupe: boolean
  piecesJointes: Array<{ n: number; nom: string; mimeType: string; taille: number }>
}

const TEXTE_MAX = 8_000
/** A smaller image is a signature logo or an inline icon, not a document. */
const IMAGE_SIGNATURE_MAX = 20_000

/** Pure (tests). */
export function messageFil(m: MessageComplet): MessageFil {
  // Gmail's plain text keeps « [image: logo.png] » where an inline image sat,
  // and « <https://…> » alone on a line where a linked logo was (signatures).
  const propre = redresser(sansCitation(m.texte).replace(/\[image: [^\]]*\]/g, '').replace(/^[ \t]*<https?:\/\/[^>\s]+>[ \t]*$/gm, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const texte = propre.length > TEXTE_MAX ? `${propre.slice(0, TEXTE_MAX)}…` : propre
  return {
    id: m.id,
    de: m.de,
    a: m.a,
    cc: m.cc,
    date: m.date,
    interne: estInterne(m.de),
    texte,
    coupe: texte.length < m.texte.trim().length,
    // `n` stays the index in the message (the attachment route reads it).
    piecesJointes: m.piecesJointes
      .map((p, n) => ({ n, nom: p.nom, mimeType: p.mimeType, taille: p.taille }))
      .filter((p) => !(p.mimeType.startsWith('image/') && p.taille < IMAGE_SIGNATURE_MAX)),
  }
}

/** Whether some agent reading that mailbox handled a mail of that thread.
 *  The panel only reads threads Tricobot saw, like Agents IA's « mail » tab:
 *  the route never opens the mailbox at large. */
export async function filConnu(boite: string, threadId: string): Promise<boolean> {
  const t = threadId.toLowerCase()
  for (const slug of agentsDeLaBoite(boite)) {
    if ((await lireRuns(slug)).some((r) => r.message?.threadId.toLowerCase() === t)) return true
  }
  return false
}

/** A plain-text mail is hard-wrapped near 76 columns (« …afin de⏎valider si
 *  cela convient »): a long line that does not end a sentence, followed by
 *  one starting in lowercase, is the same sentence. Short lines, list items
 *  and sentence ends stay as written. Pure. */
export function redresser(texte: string): string {
  const lignes = texte.split('\n')
  const out: string[] = []
  for (const l of lignes) {
    const prec = out[out.length - 1]
    const suite = prec !== undefined && prec.length >= 55 && !/[.!?:;]\s*$/.test(prec) && /^[a-zà-ÿ0-9(«"]/.test(l)
    if (suite) out[out.length - 1] = `${prec.trimEnd()} ${l.trimStart()}`
    else out.push(l)
  }
  return out.join('\n')
}

/** The thread as bubbles. An attachment shows on the first mail carrying it:
 *  replies re-attach the images of the quoted history (signatures, photos). */
export function filSansDoublons(messages: readonly MessageFil[]): MessageFil[] {
  const vues = new Set<string>()
  return messages.map((m) => ({
    ...m,
    piecesJointes: m.piecesJointes.filter((p) => {
      const cle = `${p.nom}|${p.taille}`
      if (vues.has(cle)) return false
      vues.add(cle)
      return true
    }),
  }))
}

export async function lireFilConversation(boite: string, threadId: string): Promise<MessageFil[]> {
  return filSansDoublons((await lireFil(boite, threadId)).map(messageFil))
}
