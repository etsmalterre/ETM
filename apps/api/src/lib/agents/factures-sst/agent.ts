// Agent « Factures Ennoblisseur » (LIVA #1255) — checks the dyers' invoices
// against ETM, the way Pierre-Emmanuel did by hand with the legacy Suivi lots
// « Lire facture » button (FI_Lot.wdw: PDF text + one regex, MATEL only).
//
// Pipeline per mail: a mail from one of the dyers' contacts (the same contacts
// as BL Ennoblisseur, which sets invoices aside) with an invoice-looking PDF →
// Mistral OCR → the OCR text says which dyer's invoice it is, if any → the
// version's prompt with a strict JSON schema (extraction.ts) → the reading's
// own checks (lines × prices, total) → each lot resolved in ETM and its
// weight and price compared with ETM's tariff (db.ts, controle.ts) → in
// « actif », the invoice is stored once with its lines, each tied to the sst
// order line it bills, and the invoice number is written on those lines.
// An invoice with gaps is one card in the dashboard Notifications widget
// (subscription « Factures sous-traitants — écarts », abonnements-etm.ts) and
// is handled on Sous-traitants › Factures.
//
// Mode « essai » reads and checks everything and writes nothing.

import { ocrPdf, chatJson } from '../../mistral.js'
import { listerMessages, lireMessage, lirePieceJointe } from '../../gmail-reader.js'
import { contactsEnnoblisseurs } from '../bl-ennoblisseur-db.js'
import { requeteExpediteurs, sousTraitantExpediteur, termesExpediteurs } from '../bl-profils.js'
import { BL_ENNOBLISSEUR_BOITE } from '../bl-ennoblisseur.js'
import {
  ajouterRun,
  enregistrerFichier as enregistrerFichierRun,
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
} from '../store.js'
import {
  FACTURE_PROMPT_V1,
  FACTURE_SCHEMA,
  controlerLecture,
  estBloquant,
  estFactureCandidate,
  fournisseurDe,
  fournisseurDuSousTraitant,
  normaliserFacture,
  reconnaitreFacture,
  type Controle,
  type FactureLue,
  type FournisseurCle,
} from './extraction.js'
import { resumerVerification, verifierFacture, type FactureVerifiee, type StatutFacture } from './controle.js'
import { ecrireFacture, factureExistante, lotsEtm, type EcritureFacture } from './db.js'

export const FACTURES_SST_SLUG = 'factures-ennoblisseur'

/** Agent option: every invoice, even conforme, waits for a person (the trust
 *  period — how the agent gets scored). Off: only invoices with a gap do. */
export const OPTION_CONFIRMATION = 'confirmation_systematique'

export const FACTURES_SST_VERSION_INITIALE: VersionInitiale = {
  model: 'mistral-small-latest',
  prompt: FACTURE_PROMPT_V1,
  note: 'Version initiale (LIVA #1255) — MATEL contrôlé au tarif ETM (poids, rendement, traitements) ; les autres ennoblisseurs lus et rattachés à leurs commandes, prix non contrôlés.',
}

/** Same mailbox as the BLs: every dyer must mail contact@ (Bontemps asked to). */
export const FACTURES_SST_BOITE = BL_ENNOBLISSEUR_BOITE

export interface ResultatFacture {
  fournisseur: FournisseurCle | null
  pages: Array<{ nom: string; ocr: string | null; erreur: string | null }>
  extraction: FactureLue | null
  verification: FactureVerifiee | null
  statutFacture: StatutFacture | null
  ecriture: EcritureFacture | null
}

export interface Contexte {
  mode: AgentMode
  version: AgentVersion
  source: RunSource
  message?: AgentRun['message']
  lancePar?: Auteur | null
  retraiteDe?: string
  /** The dyer the mail came from, by its contacts. */
  sousTraitantExpediteur?: number | null
  simulation?: boolean
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** One PDF → one run (an invoice is one document; pages are its own). */
async function traiterUn(pdf: { nom: string; contenu: Buffer }, ctx: Contexte, idx: number): Promise<AgentRun> {
  const t0 = Date.now()
  const id = nouvelIdRun()
  const enregistrer = ctx.simulation ? async () => '' : enregistrerFichierRun
  const res: ResultatFacture = { fournisseur: null, pages: [{ nom: pdf.nom, ocr: null, erreur: null }], extraction: null, verification: null, statutFacture: null, ecriture: null }
  let coutUsd = 0
  let statut: RunStatut = 'ignore'
  let resume = ''
  let erreur: string | undefined
  try {
    const o = await ocrPdf(pdf.contenu)
    coutUsd += o.usd
    res.pages[0].ocr = o.text
    const fournisseur = reconnaitreFacture(o.text)
    if (!fournisseur) {
      resume = `Pas une facture d’ennoblisseur : ${pdf.nom}`
    } else {
      res.fournisseur = fournisseur.cle
      const r = await chatJson({
        model: ctx.version.model,
        system: ctx.version.prompt,
        user: `Texte OCR de la facture :\n\n${o.text}`,
        schemaName: 'facture_ennoblisseur',
        schema: FACTURE_SCHEMA,
      })
      coutUsd += r.usd
      const f = normaliserFacture(r.data)
      res.extraction = f
      const titre = `${fournisseur.nom} · ${f.type_document === 'avoir' ? 'Avoir' : 'Facture'} ${f.numero_facture || 'illisible'}`
      if (f.type_document === 'avoir') {
        statut = 'a_verifier'
        resume = `${titre} · avoir : non traité par l’agent, à pointer à la main`
      } else {
        const lecture: Controle[] = controlerLecture(f)
        if (ctx.sousTraitantExpediteur && ctx.sousTraitantExpediteur !== fournisseur.idSousTraitant) {
          const exp = fournisseurDuSousTraitant(ctx.sousTraitantExpediteur)
          lecture.push({ code: 'expediteur', gravite: 'avertissement', message: `Facture ${fournisseur.nom} reçue d’un contact ${exp?.nom ?? `du sous-traitant ${ctx.sousTraitantExpediteur}`}.` })
        }
        const kgParLot = new Map<string, number>()
        for (const l of f.lignes) {
          const code = l.genre === 'lot' ? fournisseur.lotEtm(l.lot) : ''
          if (code && /^k/i.test(l.unite) && l.quantite != null) kgParLot.set(code, round2((kgParLot.get(code) ?? 0) + l.quantite))
        }
        const lots = await lotsEtm(f, fournisseur, kgParLot)
        const v = verifierFacture(f, fournisseur, lots, lecture)
        res.verification = v
        res.statutFacture = v.statut
        const deja = f.numero_facture ? await factureExistante(fournisseur.idSousTraitant, f.numero_facture) : null
        if (deja) {
          statut = 'deja_importe'
          resume = `${titre} · déjà enregistrée`
        } else if (ctx.mode === 'actif' && f.numero_facture && !estBloquant(lecture.filter((c) => c.code === 'numero'))) {
          res.ecriture = await ecrireFacture({
            fournisseur, facture: f, verification: v, pdf: pdf.contenu, pdfNom: pdf.nom,
            messageId: ctx.message?.id ?? null, runId: id, pointer: !estBloquant(lecture),
          })
          statut = v.statut === 'conforme' ? 'ecrit' : 'a_verifier'
          resume = `${titre} · ${resumerVerification(v)}`
        } else {
          statut = ctx.mode === 'actif' ? 'a_verifier' : 'simule'
          resume = `${titre} · ${resumerVerification(v)}${ctx.mode === 'actif' ? '' : ' (mode essai)'}`
        }
      }
    }
  } catch (err) {
    statut = 'erreur'
    erreur = err instanceof Error ? err.message : String(err)
    res.pages[0].erreur = erreur
    resume = `Lecture impossible : ${pdf.nom}`
  }
  const run: AgentRun = {
    id,
    slug: FACTURES_SST_SLUG,
    createdAt: new Date().toISOString(),
    source: ctx.source,
    mode: ctx.mode,
    retraiteDe: ctx.retraiteDe,
    lancePar: ctx.lancePar ?? null,
    message: ctx.message ?? null,
    fichiers: [{ nom: pdf.nom, fichier: await enregistrer(id, idx, pdf.contenu), taille: pdf.contenu.length }],
    version: ctx.version.version,
    model: ctx.version.model,
    statut,
    erreur,
    resultat: res as unknown as Record<string, unknown>,
    resume,
    coutUsd,
    dureeMs: Date.now() - t0,
  }
  return run
}

/** Run a mail's PDFs through the pipeline (also the « Essai » upload and the benchmark). */
export async function traiterPdfs(pdfs: Array<{ nom: string; contenu: Buffer }>, ctx: Contexte): Promise<AgentRun[]> {
  if (ctx.simulation && ctx.mode === 'actif') throw new Error('simulation en mode actif')
  const runs: AgentRun[] = []
  for (let i = 0; i < pdfs.length; i++) runs.push(await traiterUn(pdfs[i], ctx, 0))
  if (!ctx.simulation) for (const r of runs) await ajouterRun(r)
  return runs
}

// ── Mailbox polling ──────────────────────────────────────

let contactsCache: { le: number; contacts: Array<{ mail: string; idSousTraitant: number }> } | null = null
async function contacts(): Promise<Array<{ mail: string; idSousTraitant: number }>> {
  if (!contactsCache || Date.now() - contactsCache.le > 3_600_000) contactsCache = { le: Date.now(), contacts: await contactsEnnoblisseurs() }
  return contactsCache.contacts
}

/** Read the dyers' new invoice mails since the agent started. */
export async function sonderBoite(state: AgentState, version: AgentVersion, lancePar: Auteur | null = null): Promise<AgentRun[]> {
  if (state.mode === 'off' || !state.startedAt) return []
  const cs = await contacts()
  const termes = termesExpediteurs(cs.map((c) => c.mail))
  if (termes.length === 0) return []
  const apres = Math.floor(new Date(state.startedAt).getTime() / 1000)
  // Gmail narrows to invoice-looking mails: a dyer sends ~2 700 mails a year
  // (BLs, palettes…) and ~25 invoices.
  const q = `${requeteExpediteurs(termes)} has:attachment (filename:facture OR filename:fa OR subject:facture) after:${apres}`
  const ids = await listerMessages(FACTURES_SST_BOITE, q, 50)
  const deja = await messagesTraites(FACTURES_SST_SLUG)
  const nouveaux = ids.filter((id) => !deja.has(id)).reverse()
  const tous: AgentRun[] = []
  for (const id of nouveaux) {
    const m = await lireMessage(FACTURES_SST_BOITE, id)
    const message = { id: m.id, threadId: m.threadId, de: m.de, sujet: m.sujet, date: m.date }
    const pjs = m.piecesJointes.filter(estFactureCandidate)
    if (pjs.length === 0) {
      const run: AgentRun = {
        id: nouvelIdRun(), slug: FACTURES_SST_SLUG, createdAt: new Date().toISOString(), source: 'gmail', mode: state.mode,
        lancePar, message, fichiers: [], version: version.version, model: version.model, statut: 'ignore',
        resultat: {}, resume: `Aucune facture jointe à « ${m.sujet} »`, coutUsd: 0, dureeMs: 0,
      }
      await ajouterRun(run)
      tous.push(run)
      continue
    }
    const pdfs = await Promise.all(pjs.map(async (p) => ({ nom: p.nom, contenu: await lirePieceJointe(FACTURES_SST_BOITE, m.id, p.attachmentId) })))
    tous.push(...(await traiterPdfs(pdfs, {
      mode: state.mode, version, source: 'gmail', message, lancePar,
      sousTraitantExpediteur: sousTraitantExpediteur(m.de, cs),
    })))
  }
  return tous
}

export { fournisseurDe }
