// Agent « BL Ennoblisseur » — reads the delivery notes (bordereaux de livraison)
// the dyers (MATEL, Bontemps, TAD — bl-profils.ts) mail to contact@ and feeds
// the réception of Sous-traitants › Commandes. Replaces the n8n workflow « BL
// Processing (Gemini) » + the WebDev REST service localapi.malterre
// (load_bl_doc / load_bl_data), which read MATEL only.
//
// Pipeline per mail: a mail from one of the dyers' contacts → its PDF
// attachments (minus our own documents sent back) → Mistral OCR → the OCR text
// says which dyer's delivery document it is, if any (anything else — palettes,
// plans de charge, invoices — is set aside silently) → that dyer's prompt with
// a strict JSON schema → normalisation + checks (bl-extraction.ts) → order line
// and pieces resolved against HFSQL (bl-ennoblisseur-db.ts) → written when EVERY
// blocking check passes and the run's mode is « actif »; otherwise the run is
// « à vérifier » and the subscribers of notif_agent_bl are mailed.
//
// Mode « essai » runs the whole pipeline and writes nothing, not even a Gmail
// label. A dyer still being benchmarked (profil.modeMax = 'essai') runs in
// essai whatever the agent's mode.

import { ocrPdf, chatJson } from '../mistral.js'
import { notify } from '../notify.js'
import { listerMessages, lireMessage, lirePieceJointe, assurerLibelle, ajouterLibelle, type MessageInfo } from '../gmail-reader.js'
import { relaisTriage, triesParTriage } from './triage/relais.js'
import {
  BL_PROMPT_V1,
  controlerExtraction,
  estBloquant,
  fusionnerPages,
  grouperPages,
  normaliserExtraction,
  type BlExtraction,
  type Controle,
} from './bl-extraction.js'
import {
  detecterProfil,
  estPieceCandidate,
  modeEffectif,
  profilDe,
  profilDuSousTraitant,
  promptDe,
  reglesDe,
  requeteExpediteurs,
  sousTraitantExpediteur,
  termesExpediteurs,
  type ProfilCle,
  type ProfilEnnoblisseur,
  type TypeDocument,
} from './bl-profils.js'
import { cleDeLigne, contactsEnnoblisseurs, ecrireBl, poidsEcrit, resoudreBl, retirerPieces, type Ecriture, type Resolution } from './bl-ennoblisseur-db.js'
import {
  ajouterRun,
  enregistrerFichier as enregistrerFichierRun,
  lireRuns,
  messagesTraites,
  nouvelIdRun,
  optionDe,
  type AgentMode,
  type AgentRun,
  type AgentState,
  type AgentVersion,
  type Auteur,
  type RunSource,
  type RunStatut,
  type VersionInitiale,
} from './store.js'

export const BL_ENNOBLISSEUR_SLUG = 'bl-ennoblisseur'

export const BL_ENNOBLISSEUR_VERSION_INITIALE: VersionInitiale = {
  model: 'mistral-small-latest',
  prompt: BL_PROMPT_V1,
  note: 'Version initiale — benchmark du 22/09/2026 : 119/120 BL lus exactement (OCR Mistral + Mistral Small).',
}

/** v2 (2026-09-28): every dyer, BLs only (bl-profils.ts). MATEL's prompt is
 *  unchanged — Bontemps and TAD ship their own with their profile — but the
 *  agent's behaviour changed, so its runs are scored under a new version. */
export const BL_ENNOBLISSEUR_PROMPT_LIVRE: VersionInitiale = {
  model: 'mistral-small-latest',
  prompt: BL_PROMPT_V1,
  note: 'Version 2 — MATEL, Bontemps et TAD, BL uniquement : le texte du document décide de ce qui est un BL, le reste est écarté sans notification (prompt MATEL inchangé, ceux de Bontemps et TAD sont livrés avec leur profil).',
}

/** The mailbox n8n polled. Every dyer mails its BLs there (Bontemps asked to
 *  on 2026-09-28 — they used to write to Pierre-Emmanuel only). */
export const BL_ENNOBLISSEUR_BOITE = process.env.AGENT_BL_BOITE?.trim() || 'contact@etsmalterre.com'
const LIBELLE_TRAITE = 'ETM/BL traité'
const LIBELLE_A_VERIFIER = 'ETM/BL à vérifier'

// ── One PDF batch → runs ─────────────────────────────────

interface Lecture {
  nom: string
  contenu: Buffer
  ocr?: string
  /** The dyer and document the OCR text was recognised as; absent = not a delivery document. */
  profil?: ProfilEnnoblisseur
  type?: TypeDocument
  extraction?: BlExtraction
  erreur?: string
  coutUsd: number
}

/** What a BL Ennoblisseur run stores in `resultat` (read by the web screen). */
export interface ResultatBl {
  /** Absent on runs before 2026-09-28 (MATEL only). */
  profil?: ProfilCle | null
  typeDocument?: TypeDocument | null
  pages: Array<{ nom: string; ocr: string | null; erreur: string | null }>
  extraction: BlExtraction | null
  resolution: Omit<Resolution, 'controles'> | null
  controles: Controle[]
  ecriture: Ecriture | null
}

const jourParisYmd = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date()).replace(/-/g, '')

/** OCR, recognise, extract. A PDF that is no dyer's delivery document costs
 *  the OCR page only — no model call. */
async function lire(pdf: { nom: string; contenu: Buffer }, v: AgentVersion): Promise<Lecture> {
  const l: Lecture = { ...pdf, coutUsd: 0 }
  try {
    const o = await ocrPdf(pdf.contenu)
    l.ocr = o.text
    l.coutUsd += o.usd
    const d = detecterProfil(o.text)
    if (!d) return l
    l.profil = d.profil
    l.type = d.type
    const r = await chatJson({
      model: v.model,
      system: promptDe(d.profil, v.prompt),
      user: `Texte OCR du ${d.type === 'mise_a_dispo' ? 'document' : 'BL'} :\n\n${o.text}`,
      schemaName: 'bordereau_livraison',
      schema: d.profil.schema,
    })
    l.coutUsd += r.usd
    l.extraction = normaliserExtraction(r.data)
  } catch (err) {
    l.erreur = err instanceof Error ? err.message : String(err)
  }
  return l
}

export interface Contexte {
  mode: AgentMode
  version: AgentVersion
  source: RunSource
  message?: AgentRun['message']
  lancePar?: Auteur | null
  retraiteDe?: string
  /** The dyer the mail came from, by its contacts — a document recognised as
   *  another dyer's only warns (a forward, a shared scanner…). */
  profilAttendu?: ProfilCle | null
  /** Benchmark: runs are returned but neither stored nor their files kept (mode must be essai). */
  simulation?: boolean
}

const LIBELLE_TYPE: Record<TypeDocument, string> = { bl: 'BL', mise_a_dispo: 'Mise à dispo' }

/** Run a set of PDFs (the attachments of one mail) through the pipeline.
 *  One run per delivery document (pages of the same one are merged first);
 *  when there is none, one « ignoré » run records the mail as handled. */
export async function traiterPdfs(pdfs: Array<{ nom: string; contenu: Buffer }>, ctx: Contexte): Promise<AgentRun[]> {
  if (ctx.simulation && ctx.mode === 'actif') throw new Error('simulation en mode actif')
  const t0 = Date.now()
  const enregistrerFichier = ctx.simulation ? async () => '' : enregistrerFichierRun
  const lectures = await Promise.all(pdfs.map((p) => lire(p, ctx.version)))
  const runs: AgentRun[] = []

  const base = (mode: AgentMode = ctx.mode): Omit<AgentRun, 'statut' | 'resultat' | 'resume' | 'fichiers' | 'coutUsd'> => ({
    id: nouvelIdRun(),
    slug: BL_ENNOBLISSEUR_SLUG,
    createdAt: new Date().toISOString(),
    source: ctx.source,
    mode,
    retraiteDe: ctx.retraiteDe,
    lancePar: ctx.lancePar ?? null,
    message: ctx.message ?? null,
    version: ctx.version.version,
    model: ctx.version.model,
    dureeMs: 0,
  })

  // A PDF that could not be read at all is a run of its own.
  for (const l of lectures.filter((x) => x.erreur)) {
    const b = base()
    const resultat: ResultatBl = { profil: l.profil?.cle ?? null, typeDocument: l.type ?? null, pages: [{ nom: l.nom, ocr: l.ocr ?? null, erreur: l.erreur ?? null }], extraction: null, resolution: null, controles: [], ecriture: null }
    runs.push({
      ...b,
      fichiers: [{ nom: l.nom, fichier: await enregistrerFichier(b.id, 0, l.contenu), taille: l.contenu.length }],
      statut: 'erreur',
      erreur: l.erreur,
      resultat: resultat as unknown as Record<string, unknown>,
      resume: `Lecture impossible : ${l.nom}`,
      coutUsd: l.coutUsd,
      dureeMs: Date.now() - t0,
    })
  }

  const lues = lectures.filter((l) => l.extraction)
  // Nothing but documents that are no delivery note (palettes, our own avis
  // sent back, a plan de charge…): one quiet run, the files kept so a
  // misrecognised BL can still be looked at and « Retraiter ».
  const autres = lectures.filter((l) => !l.erreur && !l.extraction)
  if (lues.length === 0 && autres.length > 0) {
    const b = base()
    const fichiers = []
    for (let i = 0; i < autres.length; i++) {
      fichiers.push({ nom: autres[i].nom, fichier: await enregistrerFichier(b.id, i, autres[i].contenu), taille: autres[i].contenu.length })
    }
    const resultat: ResultatBl = {
      profil: null, typeDocument: null,
      pages: autres.map((l) => ({ nom: l.nom, ocr: l.ocr ?? null, erreur: null })),
      extraction: null, resolution: null, controles: [], ecriture: null,
    }
    runs.push({
      ...b, fichiers, statut: 'ignore', resultat: resultat as unknown as Record<string, unknown>,
      resume: `Pas un BL d’ennoblisseur : ${autres.map((l) => l.nom).join(', ')}`,
      coutUsd: autres.reduce((s, l) => s + l.coutUsd, 0), dureeMs: Date.now() - t0,
    })
  }

  // Pages of one document: same dyer, same kind, same lot (an unreadable lot stays alone).
  const cle = (e: BlExtraction, i: number) => {
    const l = lues[i]
    const lot = l.profil!.lot(e)
    return lot ? `${l.profil!.cle}|${l.type}|${lot}` : ''
  }
  const extractions = lues.map((l) => l.extraction!)
  const groupes = grouperPages(extractions, cle)
  const fusions = fusionnerPages(extractions, cle)
  for (let g = 0; g < groupes.length; g++) {
    const pages = groupes[g].map((i) => lues[i])
    const profil = pages[0].profil!
    const type = pages[0].type!
    const mode = modeEffectif(ctx.mode, profil)
    const e = fusions[g]
    const b = base(mode)
    const controles = controlerExtraction(e, reglesDe(profil))
    for (const c of profil.controlesTexte?.(pages.map((p) => p.ocr ?? '').join('\n')) ?? []) controles.push({ ...c, gravite: 'bloquant' })
    if (ctx.profilAttendu && ctx.profilAttendu !== profil.cle) {
      controles.push({ code: 'expediteur', gravite: 'avertissement', message: `Document ${profil.nom} reçu d’un contact ${profilDe(ctx.profilAttendu)?.nom ?? ctx.profilAttendu}.` })
    }
    let resolution: Resolution | null = null
    let ecriture: ResultatBl['ecriture'] = null
    let statut: RunStatut
    let erreur: string | undefined
    try {
      if (!controles.some((c) => c.code === 'commande_format')) {
        resolution = await resoudreBl(e, profil, type)
        controles.push(...resolution.controles)
      }
      const deja = new Set(resolution?.dejaImportees ?? [])
      if (estBloquant(controles)) statut = 'a_verifier'
      else if (e.pieces.every((p) => deja.has(cleDeLigne(p.numero_piece, poidsEcrit(profil, p.poids), p.metrage)))) statut = 'deja_importe'
      else if (mode === 'actif') {
        ecriture = await ecrireBl(e, resolution!, pages.map((p) => p.contenu), jourParisYmd(), profil)
        statut = 'ecrit'
      } else statut = 'simule'
    } catch (err) {
      statut = 'erreur'
      erreur = err instanceof Error ? err.message : String(err)
    }
    const fichiers = []
    for (let i = 0; i < pages.length; i++) {
      fichiers.push({ nom: pages[i].nom, fichier: await enregistrerFichier(b.id, i, pages[i].contenu), taille: pages[i].contenu.length })
    }
    const { controles: _c, ...resolutionSansControles } = resolution ?? ({ controles: [] } as unknown as Resolution)
    const resultat: ResultatBl = {
      profil: profil.cle,
      typeDocument: type,
      pages: pages.map((p) => ({ nom: p.nom, ocr: p.ocr ?? null, erreur: null })),
      extraction: e,
      resolution: resolution ? resolutionSansControles : null,
      controles,
      ecriture,
    }
    runs.push({
      ...b,
      fichiers,
      statut,
      erreur,
      resultat: resultat as unknown as Record<string, unknown>,
      resume: resumer(e, profil, type, statut, ecriture, controles),
      coutUsd: pages.reduce((s, p) => s + p.coutUsd, 0),
      dureeMs: Date.now() - t0,
    })
  }
  if (!ctx.simulation) for (const r of runs) await ajouterRun(r)
  return runs
}

function resumer(e: BlExtraction, profil: ProfilEnnoblisseur, type: TypeDocument, statut: RunStatut, ecriture: ResultatBl['ecriture'], controles: Controle[]): string {
  const num = type === 'mise_a_dispo' ? (e.numero_of ? `OF ${e.numero_of}` : '') : e.numero_bordereau
  const bl = `${profil.nom} · ${LIBELLE_TYPE[type]}${num ? ` ${num}` : ' illisible'}`
  const cmd = e.numero_commande ? ` · commande ${e.numero_commande}` : ''
  const n = `${e.pieces.length} pièce${e.pieces.length > 1 ? 's' : ''}`
  switch (statut) {
    case 'ecrit': return `${bl}${cmd} · ${ecriture?.lignesEcrites ?? 0} pièce(s) enregistrée(s)`
    case 'simule': return `${bl}${cmd} · ${n} prête(s) à enregistrer (mode essai)`
    case 'deja_importe': return `${bl}${cmd} · déjà importé`
    case 'a_verifier': return `${bl}${cmd} · ${controles.find((c) => c.gravite === 'bloquant')?.message ?? 'à vérifier'}`
    default: return `${bl}${cmd} · ${n}`
  }
}

// ── « Échec » ────────────────────────────────────────────

/** What an « échec » does to this run: removes the pieces it wrote for the
 *  réception (the PDF stays). Returns the French line stored on the evaluation
 *  and mutates the run's `resultat.ecriture.retire`, or null when there is
 *  nothing to remove (essai, blocked, already removed). */
export async function retirerEcritures(run: AgentRun): Promise<string | null> {
  const res = run.resultat as unknown as ResultatBl
  const ec = res.ecriture
  if (run.statut !== 'ecrit' || !ec || !res.extraction || !res.resolution || ec.retire) return null
  const n = await retirerPieces(res.extraction, res.resolution, ec)
  ec.retire = { le: new Date().toISOString(), lignes: n }
  return n > 0
    ? `${n} pièce${n > 1 ? 's' : ''} retirée${n > 1 ? 's' : ''} du pré-remplissage de la réception (le PDF reste dans les documents de la commande).`
    : 'Aucune pièce à retirer : elles n’étaient plus dans les données de réception.'
}

// ── Mailbox polling ──────────────────────────────────────

/** The dyers' contacts, re-read at most hourly (a contact added in
 *  Sous-traitants › Gestion is picked up without a restart). */
let contactsCache: { le: number; contacts: Array<{ mail: string; idSousTraitant: number }> } | null = null
async function contacts(): Promise<Array<{ mail: string; idSousTraitant: number }>> {
  if (!contactsCache || Date.now() - contactsCache.le > 3_600_000) contactsCache = { le: Date.now(), contacts: await contactsEnnoblisseurs() }
  return contactsCache.contacts
}

/** Read the new mails of the dyers since the agent started. Returns the runs
 *  made. Nothing while the Triage is in service and hands this agent its mail
 *  (triage/relais.ts); never a mail the Triage already sorted. */
export async function sonderBoite(state: AgentState, version: AgentVersion, lancePar: Auteur | null = null): Promise<AgentRun[]> {
  if (state.mode === 'off' || !state.startedAt) return []
  if ((await relaisTriage()).source === 'triage') return []
  const cs = await contacts()
  const termes = termesExpediteurs(cs.map((c) => c.mail))
  if (termes.length === 0) return []
  const apres = Math.floor(new Date(state.startedAt).getTime() / 1000)
  const q = `${requeteExpediteurs(termes)} has:attachment after:${apres}`
  const ids = await listerMessages(BL_ENNOBLISSEUR_BOITE, q, 50)
  const deja = await messagesTraites(BL_ENNOBLISSEUR_SLUG)
  const tries = await triesParTriage()
  const nouveaux = ids.filter((id) => !deja.has(id) && !tries.has(id)).reverse() // oldest first
  const tous: AgentRun[] = []
  for (const id of nouveaux) {
    const m = await lireMessage(BL_ENNOBLISSEUR_BOITE, id)
    tous.push(...(await traiterMessage(m, { mode: state.mode, version, source: 'gmail', lancePar })))
  }
  return tous
}

/** One mail of contact@ through the pipeline: its candidate PDFs, the Gmail
 *  label, the « à vérifier » email. Every mail leaves at least one run (an
 *  « ignoré » one when there is no PDF to read), so it is never read twice.
 *  Called by this agent's own poll and by the Triage (source « triage »). */
export async function traiterMessage(
  m: MessageInfo,
  ctx: { mode: AgentMode; version: AgentVersion; source: RunSource; lancePar: Auteur | null },
): Promise<AgentRun[]> {
  const { mode, version, source, lancePar } = ctx
  const message = { id: m.id, threadId: m.threadId, de: m.de, sujet: m.sujet, date: m.date }
  const pjs = m.piecesJointes.filter(estPieceCandidate)
  if (pjs.length === 0) {
    const run: AgentRun = {
      id: nouvelIdRun(), slug: BL_ENNOBLISSEUR_SLUG, createdAt: new Date().toISOString(), source, mode,
      lancePar, message, fichiers: [], version: version.version, model: version.model, statut: 'ignore',
      resultat: {}, resume: `Aucun PDF à lire dans « ${m.sujet} »`, coutUsd: 0, dureeMs: 0,
    }
    await ajouterRun(run)
    return [run]
  }
  const sst = sousTraitantExpediteur(m.de, await contacts())
  const pdfs = await Promise.all(pjs.map(async (p) => ({ nom: p.nom, contenu: await lirePieceJointe(BL_ENNOBLISSEUR_BOITE, m.id, p.attachmentId) })))
  const runs = await traiterPdfs(pdfs, {
    mode, version, source, message, lancePar,
    profilAttendu: sst != null ? profilDuSousTraitant(sst)?.cle ?? null : null,
  })
  await etiqueter(m.id, runs)
  await prevenir(runs)
  return runs
}

/** Label the mail, from its « actif » runs only: « traité » when every
 *  document was written or already there, « à vérifier » otherwise. A mail
 *  with no delivery document, or read in essai, keeps no label. Best effort. */
async function etiqueter(messageId: string, runs: AgentRun[]): Promise<void> {
  const actifs = runs.filter((r) => r.mode === 'actif' && r.statut !== 'ignore')
  if (actifs.length === 0) return
  try {
    const ok = actifs.every((r) => r.statut === 'ecrit' || r.statut === 'deja_importe')
    const label = await assurerLibelle(BL_ENNOBLISSEUR_BOITE, ok ? LIBELLE_TRAITE : LIBELLE_A_VERIFIER)
    await ajouterLibelle(BL_ENNOBLISSEUR_BOITE, messageId, label)
  } catch (err) {
    console.error(`[agents] ${BL_ENNOBLISSEUR_SLUG}: label failed for ${messageId}:`, err)
  }
}

/** Mail the subscribers of notif_agent_bl about the runs a human must look at. */
export async function prevenir(runs: AgentRun[]): Promise<void> {
  const aVoir = runs.filter((r) => r.statut === 'a_verifier' || r.statut === 'erreur')
  if (!aVoir.length) return
  const base = process.env.ERP_BASE_URL?.trim() || 'https://etm.intra.etsmalterre.com'
  for (const r of aVoir) {
    const res = r.resultat as unknown as ResultatBl
    const profil = profilDe(res.profil)
    await notify('notif_agent_bl', {
      subject: `BL Ennoblisseur à vérifier${profil ? ` — ${profil.nom}` : ''}${res.extraction?.numero_bordereau ? ` ${res.extraction.numero_bordereau}` : ''}`,
      content: {
        title: r.statut === 'erreur' ? 'BL Ennoblisseur : lecture en erreur' : 'BL Ennoblisseur à vérifier',
        tone: 'alert',
        intro: 'L’agent « BL Ennoblisseur » n’a rien enregistré pour ce bordereau : une vérification est nécessaire avant la réception.',
        rows: [
          { label: 'Ennoblisseur', value: profil?.nom ?? '—' },
          { label: 'Bordereau', value: res.extraction?.numero_bordereau || '—' },
          { label: 'Commande', value: res.extraction?.numero_commande || '—' },
          { label: 'Mail', value: r.message ? `${r.message.sujet} (${r.message.de})` : '—' },
          { label: 'Motif', value: r.erreur ?? res.controles?.filter((c) => c.gravite === 'bloquant').map((c) => c.message).join(' ') ?? '—' },
        ],
        callout: `Voir l’exécution dans ETM : ${base}/agents-ia/agents?agent=${BL_ENNOBLISSEUR_SLUG}&run=${r.id}`,
      },
    })
  }
}

// ── Tricobot feedback at réception ───────────────────────

const lotNormal = (l: string) => l.toUpperCase().replace(/s+/g, '')

/** The run that wrote the pre-filled pieces of this lot on this order line —
 *  the latest written one (a corrected BL re-read writes again). Its
 *  feedback is given when the rolls are received (routes/tricobot.ts). */
export async function runDuLot(ligneId: number, lot: string): Promise<AgentRun | null> {
  const cible = lotNormal(lot)
  const runs = await lireRuns(BL_ENNOBLISSEUR_SLUG)
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]
    const res = r.resultat as unknown as Partial<ResultatBl>
    if (r.statut === 'ecrit' && res.resolution?.ligneId === ligneId && lotNormal(res.resolution.lot ?? '') === cible) return r
  }
  return null
}
