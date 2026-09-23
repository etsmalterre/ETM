// Agent « BL Ennoblisseur » — reads the delivery notes (bordereaux de livraison) the
// dyer MATEL mails to contact@ and feeds the réception of Sous-traitants ›
// Commandes. Replaces the n8n workflow « BL Processing (Gemini) » + the WebDev
// REST service localapi.malterre (load_bl_doc / load_bl_data).
//
// Pipeline per mail: PDF attachments → Mistral OCR → mistral-small with a
// strict JSON schema → normalisation + checks (bl-extraction.ts) → order line
// and pieces resolved against HFSQL (bl-ennoblisseur-db.ts) → written when EVERY
// blocking check passes and the agent is « actif »; otherwise the run is
// « à vérifier » and the subscribers of notif_agent_bl are mailed.
//
// Mode « essai » runs the whole pipeline and writes nothing, not even a Gmail
// label — the shadow run next to n8n before the switch.

import { ocrPdf, chatJson } from '../mistral.js'
import { notify } from '../notify.js'
import { listerMessages, lireMessage, lirePieceJointe, assurerLibelle, ajouterLibelle } from '../gmail-reader.js'
import {
  BL_PROMPT_V1,
  BL_SCHEMA,
  controlerExtraction,
  estBloquant,
  fusionnerPages,
  grouperPages,
  normaliserExtraction,
  type BlExtraction,
  type Controle,
} from './bl-extraction.js'
import { cleDeLigne, ecrireBl, resoudreBl, retirerPieces, type Ecriture, type Resolution } from './bl-ennoblisseur-db.js'
import {
  ajouterRun,
  enregistrerFichier,
  messagesTraites,
  nouvelIdRun,
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

/** The mailbox n8n polled, and the sender it filtered on. */
export const BL_ENNOBLISSEUR_BOITE = process.env.AGENT_BL_BOITE?.trim() || 'contact@etsmalterre.com'
export const BL_ENNOBLISSEUR_EXPEDITEURS = (process.env.AGENT_BL_EXPEDITEURS?.trim() || 'mct.celine@mateltextiles.fr')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const LIBELLE_TRAITE = 'ETM/BL traité'
const LIBELLE_A_VERIFIER = 'ETM/BL à vérifier'

// ── One PDF batch → runs ─────────────────────────────────

interface Lecture {
  nom: string
  contenu: Buffer
  ocr?: string
  extraction?: BlExtraction
  erreur?: string
  coutUsd: number
}

/** What a BL Ennoblisseur run stores in `resultat` (read by the web screen). */
export interface ResultatBl {
  pages: Array<{ nom: string; ocr: string | null; erreur: string | null }>
  extraction: BlExtraction | null
  resolution: Omit<Resolution, 'controles'> | null
  controles: Controle[]
  ecriture: Ecriture | null
}

const jourParisYmd = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date()).replace(/-/g, '')

async function lire(pdf: { nom: string; contenu: Buffer }, v: AgentVersion): Promise<Lecture> {
  const l: Lecture = { ...pdf, coutUsd: 0 }
  try {
    const o = await ocrPdf(pdf.contenu)
    l.ocr = o.text
    l.coutUsd += o.usd
    const r = await chatJson({
      model: v.model,
      system: v.prompt,
      user: `Texte OCR du BL :\n\n${o.text}`,
      schemaName: 'bordereau_livraison',
      schema: BL_SCHEMA,
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
}

/** Run a set of PDFs (the attachments of one mail) through the pipeline.
 *  One run per BL: pages of the same bordereau are merged first. */
export async function traiterPdfs(pdfs: Array<{ nom: string; contenu: Buffer }>, ctx: Contexte): Promise<AgentRun[]> {
  const t0 = Date.now()
  const lectures = await Promise.all(pdfs.map((p) => lire(p, ctx.version)))
  const runs: AgentRun[] = []

  const base = (): Omit<AgentRun, 'statut' | 'resultat' | 'resume' | 'fichiers' | 'coutUsd'> => ({
    id: nouvelIdRun(),
    slug: BL_ENNOBLISSEUR_SLUG,
    createdAt: new Date().toISOString(),
    source: ctx.source,
    mode: ctx.mode,
    retraiteDe: ctx.retraiteDe,
    lancePar: ctx.lancePar ?? null,
    message: ctx.message ?? null,
    version: ctx.version.version,
    model: ctx.version.model,
    dureeMs: 0,
  })

  // A PDF that could not be read at all is a run of its own.
  const lues = lectures.filter((l) => l.extraction)
  for (const l of lectures.filter((x) => !x.extraction)) {
    const b = base()
    const resultat: ResultatBl = { pages: [{ nom: l.nom, ocr: l.ocr ?? null, erreur: l.erreur ?? null }], extraction: null, resolution: null, controles: [], ecriture: null }
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

  const extractions = lues.map((l) => l.extraction!)
  const groupes = grouperPages(extractions)
  const fusions = fusionnerPages(extractions)
  for (let g = 0; g < groupes.length; g++) {
    const pages = groupes[g].map((i) => lues[i])
    const e = fusions[g]
    const b = base()
    const controles = controlerExtraction(e)
    let resolution: Resolution | null = null
    let ecriture: ResultatBl['ecriture'] = null
    let statut: RunStatut
    let erreur: string | undefined
    try {
      if (!controles.some((c) => c.code === 'commande_format')) {
        resolution = await resoudreBl(e)
        controles.push(...resolution.controles)
      }
      const deja = new Set(resolution?.dejaImportees ?? [])
      if (estBloquant(controles)) statut = 'a_verifier'
      else if (e.pieces.every((p) => deja.has(cleDeLigne(p.numero_piece, p.poids, p.metrage)))) statut = 'deja_importe'
      else if (ctx.mode === 'actif') {
        ecriture = await ecrireBl(e, resolution!, pages.map((p) => p.contenu), jourParisYmd())
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
      resume: resumer(e, statut, ecriture, controles),
      coutUsd: pages.reduce((s, p) => s + p.coutUsd, 0),
      dureeMs: Date.now() - t0,
    })
  }
  for (const r of runs) await ajouterRun(r)
  return runs
}

function resumer(e: BlExtraction, statut: RunStatut, ecriture: ResultatBl['ecriture'], controles: Controle[]): string {
  const bl = e.numero_bordereau ? `BL ${e.numero_bordereau}` : 'BL illisible'
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

const estPdf = (p: { nom: string; mimeType: string }) => p.mimeType === 'application/pdf' || /\.pdf$/i.test(p.nom)

/** Read the new MATEL mails since the agent started. Returns the runs made. */
export async function sonderBoite(state: AgentState, version: AgentVersion, lancePar: Auteur | null = null): Promise<AgentRun[]> {
  if (state.mode === 'off' || !state.startedAt) return []
  const apres = Math.floor(new Date(state.startedAt).getTime() / 1000)
  const q = `from:(${BL_ENNOBLISSEUR_EXPEDITEURS.join(' OR ')}) has:attachment after:${apres}`
  const ids = await listerMessages(BL_ENNOBLISSEUR_BOITE, q, 50)
  const deja = await messagesTraites(BL_ENNOBLISSEUR_SLUG)
  const nouveaux = ids.filter((id) => !deja.has(id)).reverse() // oldest first
  const tous: AgentRun[] = []
  for (const id of nouveaux) {
    const m = await lireMessage(BL_ENNOBLISSEUR_BOITE, id)
    const message = { id: m.id, threadId: m.threadId, de: m.de, sujet: m.sujet, date: m.date }
    const pjs = m.piecesJointes.filter(estPdf)
    if (pjs.length === 0) {
      const run: AgentRun = {
        id: nouvelIdRun(), slug: BL_ENNOBLISSEUR_SLUG, createdAt: new Date().toISOString(), source: 'gmail', mode: state.mode,
        lancePar, message, fichiers: [], version: version.version, model: version.model, statut: 'ignore',
        resultat: {}, resume: `Aucun PDF dans « ${m.sujet} »`, coutUsd: 0, dureeMs: 0,
      }
      await ajouterRun(run)
      tous.push(run)
      continue
    }
    const pdfs = await Promise.all(pjs.map(async (p) => ({ nom: p.nom, contenu: await lirePieceJointe(BL_ENNOBLISSEUR_BOITE, m.id, p.attachmentId) })))
    const runs = await traiterPdfs(pdfs, { mode: state.mode, version, source: 'gmail', message, lancePar })
    tous.push(...runs)
    if (state.mode === 'actif') await etiqueter(m.id, runs)
  }
  await prevenir(tous)
  return tous
}

/** Label the mail (actif only): « traité » when every BL of it was written
 *  or already there, « à vérifier » otherwise. Best effort. */
async function etiqueter(messageId: string, runs: AgentRun[]): Promise<void> {
  try {
    const ok = runs.every((r) => r.statut === 'ecrit' || r.statut === 'deja_importe')
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
    await notify('notif_agent_bl', {
      subject: `BL Ennoblisseur à vérifier${res.extraction?.numero_bordereau ? ` — ${res.extraction.numero_bordereau}` : ''}`,
      content: {
        title: r.statut === 'erreur' ? 'BL Ennoblisseur : lecture en erreur' : 'BL Ennoblisseur à vérifier',
        tone: 'alert',
        intro: 'L’agent « BL Ennoblisseur » n’a rien enregistré pour ce bordereau : une vérification est nécessaire avant la réception.',
        rows: [
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
