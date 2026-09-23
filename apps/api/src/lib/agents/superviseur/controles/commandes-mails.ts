// Agent « Superviseur » — « every order received by mail is entered in ETM and
// correct ». Candidates: messages from a client (reponses.ts address book)
// in the window whose subject, attachment name or text speaks of an order.
// Each is read ONCE (cache data/agents/superviseur-commandes.json): PDF
// attachments through Mistral OCR, then Mistral extracts the order; the
// extraction is matched against the client's ETM orders (rapprochement.ts).
//
//   - not found after 1 working day → « commande reçue non saisie » (urgent at 2);
//   - found with a quantity or price difference → « commande à vérifier ».
//
// Limits (v1): spreadsheet attachments are not read (only the mail text and
// PDFs); a modification of an existing order is recognised but not checked.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { query, fixEncoding } from '../../../hfsql-auto.js'
import { chatJson, ocrPdf } from '../../../mistral.js'
import { AGENTS_DIR } from '../../store.js'
import { lireMessage, lirePieceJointe, type EnteteMessage } from '../boites.js'
import { chargerAnnuaire, entetesDuRun, FENETRE_JOURS, sansCitation } from '../mails.js'
import { heuresOuvrees, identifierClient, racine, type ClientConnu } from '../reponses.js'
import { rapprocher, type CommandeEtm, type CommandeExtraite } from '../rapprochement.js'
import type { Constat, Controle } from '../types.js'
import { fmt, REPONSE_ATTENTION_H, REPONSE_URGENT_H } from './regles.js'

/** Words that make a client mail worth reading as a possible order. */
export const SIGNAL_COMMANDE = /\b(commande|order|purchase|bon de commande|b\.?c\.?|p\.?o\.?|achat|o\.?a\.?)\b/i

export const EXTRACTION_PROMPT = `Tu lis un mail (et le texte de ses pièces jointes PDF) reçu par ETS Malterre, fabricant de tissus tricotés (jersey, bord-côte…) vendus au mètre linéaire (Ml) ou au kilo.
Dis s'il s'agit d'une NOUVELLE commande ferme du client, d'une MODIFICATION d'une commande existante, ou d'AUTRE chose (demande de prix, question, confirmation, relance, accusé de réception, prévisionnel non ferme).
Pour une commande ou une modification, extrais :
- numero_commande_client : le numéro de commande / bon de commande / PO du client, tel qu'écrit ("" s'il n'y en a pas) ;
- lignes : une ligne par article commandé — designation, reference_client (référence ou code article du client), coloris, quantite (nombre), unite (telle qu'écrite : m, ml, mètres, kg…), prix_unitaire (nombre hors taxe, null si absent), delai (date ou semaine demandée, telle qu'écrite).
Un mail qui parle d'une commande DÉJÀ passée — point sur la commande, suivi, appel d'une partie d'une commande cadre, date de livraison, réponse à notre confirmation — n'est PAS une nouvelle commande : c'est "modification" s'il change une quantité, un article ou une date, sinon "autre".
N'invente rien : laisse vide ou null ce qui n'est pas écrit. Pour AUTRE, lignes = [].`

export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type_message: { type: 'string', enum: ['nouvelle_commande', 'modification', 'autre'] },
    numero_commande_client: { type: 'string' },
    lignes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          designation: { type: 'string' },
          reference_client: { type: 'string' },
          coloris: { type: 'string' },
          quantite: { type: ['number', 'null'] },
          unite: { type: 'string' },
          prix_unitaire: { type: ['number', 'null'] },
          delai: { type: 'string' },
        },
        required: ['designation', 'reference_client', 'coloris', 'quantite', 'unite', 'prix_unitaire', 'delai'],
      },
    },
  },
  required: ['type_message', 'numero_commande_client', 'lignes'],
} as const

// ── Cache (one extraction per message and model) ─────────

const CACHE = path.join(AGENTS_DIR, 'superviseur-commandes.json')
interface Entree { le: string; model: string; extraction: CommandeExtraite; usd: number }

async function lireCache(): Promise<Record<string, Entree>> {
  try {
    return JSON.parse(await fs.readFile(CACHE, 'utf8')) as Record<string, Entree>
  } catch {
    return {}
  }
}

async function ecrireCache(c: Record<string, Entree>, nowMs: number): Promise<void> {
  const limite = nowMs - 2 * FENETRE_JOURS * 86_400_000
  for (const [k, v] of Object.entries(c)) if (Date.parse(v.le) < limite) delete c[k]
  await fs.mkdir(path.dirname(CACHE), { recursive: true })
  const tmp = `${CACHE}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(c), 'utf8')
  await fs.rename(tmp, CACHE)
}

const estPdf = (p: { nom: string; mimeType: string }) => p.mimeType === 'application/pdf' || /\.pdf$/i.test(p.nom)

/** Mail text + OCR of up to 3 PDF attachments → Mistral extraction. */
export async function extraireCommande(m: EnteteMessage, model: string, cout: (usd: number) => void): Promise<CommandeExtraite> {
  const msg = await lireMessage(m.boite, m.id)
  // The same PDF attached twice would double every line (N°3884: 888 Ml read, 444 ordered).
  const vusPj = new Set<string>()
  const pdfs = msg.piecesJointes.filter((p) => estPdf(p) && !vusPj.has(`${p.nom}|${p.taille}`) && !!vusPj.add(`${p.nom}|${p.taille}`)).slice(0, 3)
  const blocs: string[] = [`Objet : ${m.sujet}\nDe : ${m.de}\n\n${sansCitation(msg.texte).slice(0, 6000)}`]
  for (const p of pdfs) {
    const o = await ocrPdf(await lirePieceJointe(m.boite, m.id, p.attachmentId))
    cout(o.usd)
    blocs.push(`--- Pièce jointe ${p.nom} ---\n${o.text.slice(0, 12000)}`)
  }
  const autres = msg.piecesJointes.filter((p) => !estPdf(p)).map((p) => p.nom)
  if (autres.length) blocs.push(`(Autres pièces jointes non lues : ${autres.join(', ')})`)
  const r = await chatJson({ model, system: EXTRACTION_PROMPT, user: blocs.join('\n\n'), schemaName: 'commande_mail', schema: EXTRACTION_SCHEMA })
  cout(r.usd)
  return r.data as CommandeExtraite
}

// ── ETM side ─────────────────────────────────────────────

type LigneCmd = { IDcommande_client: number; numero: number; IDsociete: number; est_soldee: number | null; date_commande: string | null; ref_client: string | null }

/** The ETM orders a mailed order may be: the client's own since `depuis`, plus
 *  — when the order carries a number of 5+ digits — every order, ETM or TRM
 *  and whatever the client row, whose `ref_client` quotes it (a knitting job
 *  for Sofileta is a TRM order under another client row, benchmark 2026-09-23). */
export async function commandesCandidates(idClient: number, depuis: string, numeroClient: string): Promise<CommandeEtm[]> {
  const propres = await query<LigneCmd>(
    `SELECT IDcommande_client, numero, IDsociete, est_soldee, date_commande, ref_client FROM commande_client
     WHERE IDsociete = 1 AND IDcommande_ETM = 0 AND IDclient = ${Math.trunc(idClient)} AND (date_commande >= '${depuis}' OR est_soldee = 0)`,
  )
  // The longest digit run is ASCII-safe in a LIKE; the exact test is normRef in JS.
  const chiffres = (numeroClient.match(/\d{5,}/g) ?? []).sort((a, b) => b.length - a.length)[0]
  const parNumero = chiffres
    ? (await query<LigneCmd>(
      `SELECT IDcommande_client, numero, IDsociete, est_soldee, date_commande, ref_client FROM commande_client
       WHERE IDsociete IN (1, 2) AND IDcommande_ETM = 0 AND ref_client LIKE '%${chiffres}%'`,
    )).filter((c) => !propres.some((p) => Number(p.IDcommande_client) === Number(c.IDcommande_client)))
    : []
  return versCommandes([...propres, ...parNumero])
}

async function versCommandes(cmds: LigneCmd[]): Promise<CommandeEtm[]> {
  if (!cmds.length) return []
  const fixed = await fixEncoding(cmds, 'commande_client', 'IDcommande_client', ['ref_client'])
  const lignes = await query<{ IDcommande_client: number; quantite: number | null; unite: number | null; prix: number | null }>(
    `SELECT IDcommande_client, quantite, unite, prix FROM ligne_commande_client WHERE IDcommande_client IN (${fixed.map((c) => Number(c.IDcommande_client)).join(',')})`,
  )
  return fixed.map((c) => ({
    id: Number(c.IDcommande_client),
    numero: Number(c.numero) || 0,
    dateCommande: String(c.date_commande ?? '').slice(0, 8),
    refClient: String(c.ref_client ?? ''),
    societe: Number(c.IDsociete) || 1,
    ouverte: Number(c.est_soldee) !== 1,
    lignes: lignes.filter((l) => Number(l.IDcommande_client) === Number(c.IDcommande_client))
      .map((l) => ({ quantite: Number(l.quantite) || 0, unite: Number(l.unite) || 0, prix: Number(l.prix) || 0 })),
  }))
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '')
const court = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// ── The check ────────────────────────────────────────────

export const controleCommandesMails: Controle = {
  id: 'commande_mail',
  domaine: 'commandes_client',
  libelle: 'Commande reçue par mail non saisie ou différente',
  description:
    `Mail d’un client (${FENETRE_JOURS} derniers jours) contenant une nouvelle commande — lue par Mistral dans le texte et les PDF joints — sans commande correspondante dans ETM après 1 jour ouvré (urgent à 2), ou dont la commande saisie diffère en quantité (±5 %) ou en prix (±1 %). Rapprochement par le n° de commande du client dans « Réf. client », sinon par date et quantité totale.`,
  async executer(ctx) {
    const [{ entetes, erreurs }, annuaire] = await Promise.all([entetesDuRun(ctx.nowMs), chargerAnnuaire()])
    if (erreurs.length) throw new Error(`boîte(s) illisible(s) — ${erreurs.join(' ; ')}`)
    const depuis = ctx.nowMs - FENETRE_JOURS * 86_400_000
    // One copy per Message-ID (contact@ + cc arrive twice).
    // One candidate per conversation — its latest client message (Idylle wrote
    // twice in the same « point commande » thread and was reported twice).
    const parConversation = new Map<string, { m: EnteteMessage; client: ClientConnu; conv: string }>()
    for (const m of [...entetes].sort((a, b) => a.date - b.date)) {
      if (m.envoye || m.automatique || m.date < depuis || m.date > ctx.nowMs) continue
      const client = identifierClient(m.de, annuaire)
      if (!client || !SIGNAL_COMMANDE.test(m.sujet)) continue
      const conv = racine(m)
      parConversation.set(conv, { m, client, conv })
    }
    const candidats = [...parConversation.values()]
    const cache = await lireCache()
    let modifie = false
    const out: Constat[] = []
    for (const { m, client, conv } of candidats) {
      const k = `${m.messageId || m.id}@${ctx.version.model}`
      let ext = cache[k]?.extraction
      if (!ext) {
        let usd = 0
        ext = await extraireCommande(m, ctx.version.model, (u) => { usd += u; ctx.cout(u) })
        cache[k] = { le: new Date(ctx.nowMs).toISOString(), model: ctx.version.model, extraction: ext, usd }
        modifie = true
      }
      if (ext.type_message !== 'nouvelle_commande' || !ext.lignes.length) continue
      const attente = heuresOuvrees(m.date, ctx.nowMs)
      if (attente < REPONSE_ATTENTION_H) continue // the office has a working day to enter it
      const r = rapprocher(
        ext,
        { dateMin: ymd(m.date - 7 * 86_400_000), dateEntree: ymd(m.date - 2 * 86_400_000) },
        await commandesCandidates(client.idClient, ymd(m.date - 45 * 86_400_000), ext.numero_commande_client),
      )
      const po = ext.numero_commande_client ? ` n° ${ext.numero_commande_client}` : ''
      const resume = ext.lignes.slice(0, 3).map((l) => [l.quantite != null ? `${fmt(l.quantite)} ${l.unite}` : '', l.reference_client || l.designation].filter(Boolean).join(' ')).join(', ')
      if (r.statut === 'absente') {
        out.push({
          cle: `commande_mail:${conv}`,
          controle: 'commande_mail',
          domaine: 'commandes_client',
          gravite: attente >= REPONSE_URGENT_H ? 'urgent' : 'attention',
          titre: `${client.nom} — commande${po} non saisie`,
          message: `Reçue le ${new Date(m.date).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })} (${m.boite.split('@')[0]}, « ${court(m.sujet)} ») : ${resume}${ext.lignes.length > 3 ? '…' : ''}. Aucune commande correspondante dans ETM.`,
          lien: null,
        })
      } else if (r.ecarts.length) {
        out.push({
          cle: `commande_mail:${conv}`,
          controle: 'commande_mail',
          domaine: 'commandes_client',
          gravite: 'attention',
          titre: `${client.nom} — commande${po} à vérifier (N°${r.commande.numero})`,
          // A date-only match is a guess: say so, the écart may just mean « not entered ».
          message: r.par === 'date'
            ? `Commande reçue le ${new Date(m.date).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })} (${resume}) : aucune commande avec ce numéro ou cette quantité. La plus proche est N°${r.commande.numero} (${r.ecarts.join(' ; ')}) — vérifier qu’elle a bien été saisie.`
            : `La commande reçue le ${new Date(m.date).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })} diffère de la saisie : ${r.ecarts.join(' ; ')}.`,
          lien: `/clients/commandes?commande=${r.commande.id}`,
        })
      }
    }
    if (modifie) await ecrireCache(cache, ctx.nowMs)
    return out
  },
}
