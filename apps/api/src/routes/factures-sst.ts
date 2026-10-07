// Sous-traitants › Factures (LIVA #1255) — the dyers' invoices the agent
// « Factures Ennoblisseur » stored (lib/agents/factures-sst/), one row per
// invoice, its lines tied to the sst order lines they bill. A person checks
// them here line by line — confirming or contradicting the agent's verdict,
// which is how the agent is scored (lib/agents/factures-sst/avis.ts; never in
// Agents IA) — then closes the invoice: « Valider » or « Réclamer » (the dyer
// is asked for a correction). Which invoices wait for a person follows the
// agent's « confirmation » option (all, or only those with a gap). A
// réclamation waits for the dyer's answer and is closed with how it ended.
//
// Gate: seeing the screen (Écrans: Sous-traitants › Factures) — no action key;
// the per-order read is gated by Sous-traitants › Commandes, where it shows.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { mpsPg } from '../lib/mps-pg.js'
import { userCanOpenScreen } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { auteur } from './agents-ia.js'
import { ActionInvalide, decider, parDefaut, type VerdictFinal } from '../lib/agents/factures-sst/avis.js'
import type { Nature, Verdict } from '../lib/agents/factures-sst/controle.js'
import { confirmationSystematique, reporterAvisSurRun } from '../lib/agents/factures-sst/suivi.js'
import { recette, type RecettePrix } from '../lib/agents/factures-sst/recette.js'
import { codeLot } from '../lib/agents/factures-sst/db.js'
import { calcTarifSSTBreakdown } from '../lib/pricing-sst.js'
import { lireHistorique, noter } from '../lib/agents/factures-sst/historique.js'
import { FACTURES_SST_BOITE } from '../lib/agents/factures-sst/agent.js'
import { lireMessage } from '../lib/gmail-reader.js'
import { sendMail } from '../lib/gmail.js'
import { corpsEnTexte } from '../lib/email-riche.js'
import { getUserEmail } from '../lib/user-emails.js'

export const facturesSstRouter: RouterType = Router()

const MENU = '/sous-traitants'
export const ECRAN_FACTURES_SST = '/sous-traitants/factures'
const ECRAN_COMMANDES = '/sous-traitants/commandes'

async function garde(req: Request, res: Response, ecran: string): Promise<number | null> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return null
  }
  if (!(await userCanOpenScreen(req.userId, isEffectiveAdmin(req), MENU, ecran))) {
    res.status(403).json({ error: 'écran non accessible' })
    return null
  }
  return req.userId
}

const n = (v: unknown) => (v == null ? null : Number(v))
const idParam = (req: Request) => {
  const id = Number.parseInt(String(req.params.id), 10)
  return Number.isFinite(id) && id > 0 ? id : null
}

// ── GET / — the list ─────────────────────────────────────
// ?vue=a_traiter (open invoices waiting for a person, default) | en_reclamation
// (claimed, waiting for the dyer) | tout
facturesSstRouter.get('/', async (req, res) => {
  if ((await garde(req, res, ECRAN_FACTURES_SST)) === null) return
  try {
    const vue = req.query.vue === 'tout' || req.query.vue === 'en_reclamation' ? req.query.vue : 'a_traiter'
    const confirmation = await confirmationSystematique()
    const sql = mpsPg()
    const rows = await sql<Record<string, unknown>[]>`
      SELECT f.idfacture_sst AS id, f.idsous_traitant, COALESCE(s.nom, '') AS sous_traitant, f.numero, to_char(f.date_facture, 'YYYY-MM-DD') AS date_facture,
             to_char(f.date_echeance, 'YYYY-MM-DD') AS date_echeance, f.total_ht, f.total_ttc, f.statut, f.ecart_montant, f.cree_le, f.traitement, f.traite_le,
             f.traite_par_nom, f.traite_commentaire, f.cloture_le,
             (SELECT COUNT(DISTINCT l.lot) FROM ligne_facture_sst l WHERE l.idfacture_sst = f.idfacture_sst AND l.lot <> '') AS nb_lots,
             (SELECT COUNT(*) FROM ligne_facture_sst l WHERE l.idfacture_sst = f.idfacture_sst AND COALESCE(l.verdict_final, l.verdict) = 'ecart') AS nb_ecarts
      FROM facture_sst f
      LEFT JOIN sous_traitant s ON s.idsous_traitant = f.idsous_traitant
      WHERE ${vue === 'tout' ? sql`TRUE`
        : vue === 'en_reclamation' ? sql`f.traitement = 'reclamee'`
        : confirmation ? sql`f.traite_le IS NULL` : sql`f.statut <> 'conforme' AND f.traite_le IS NULL`}
      ORDER BY f.date_facture DESC NULLS LAST, f.idfacture_sst DESC
      LIMIT 500`
    res.json({
      rows: rows.map((r) => ({
        ...r,
        total_ht: n(r.total_ht),
        total_ttc: n(r.total_ttc),
        ecart_montant: n(r.ecart_montant),
        nb_lots: Number(r.nb_lots),
        nb_ecarts: Number(r.nb_ecarts),
      })),
    })
  } catch (err) {
    console.error('[factures-sst] list failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const LIGNE_COLS = (sql: ReturnType<typeof mpsPg>) => sql`
  l.idligne_facture_sst AS id, l.ordre, l.genre, l.designation, l.traitements, l.qualite, l.lot, l.numero_commande,
  l.quantite, l.unite, l.pieces, l.prix_unitaire, l.montant, l.idligne_commande_sous_traitant, l.idcommande_sous_traitant,
  l.idsuivilot, l.poids_etm, l.pieces_etm, l.prix_attendu, l.ecart_montant, l.verdict, l.nature, l.controles,
  l.verdict_final, l.avis_note, l.avis_commentaire, l.avis_par_nom, l.avis_le`

/** ETM's reference and coloris of each line's sst order line (« 027B · ecru »).
 *  A fini's coloris follows `avec_teinture`: 0 → the écru's `colori_ecru`,
 *  1/2 → `ref_fini_colori` (CLAUDE.md « A coloris LOOKUP for a fini »). */
async function refsEtm(sql: ReturnType<typeof mpsPg>, idsLigne: number[]): Promise<Map<number, { ref: string; coloris: string }>> {
  const out = new Map<number, { ref: string; coloris: string }>()
  if (!idsLigne.length) return out
  const lignes = await sql<{ id: number; ref: string | null; avec_teinture: number | null; idcoloris: number }[]>`
    SELECT l.idligne_commande_sous_traitant AS id, f.reference AS ref, f.avec_teinture, COALESCE(l.idcoloris, 0) AS idcoloris
    FROM ligne_commande_sous_traitant l LEFT JOIN ref_fini f ON f.idref_fini = l.idreference
    WHERE l.idligne_commande_sous_traitant = ANY(${idsLigne}) AND l.type = 2`
  const ecru = lignes.filter((l) => !Number(l.avec_teinture)).map((l) => Number(l.idcoloris)).filter((n) => n > 0)
  const teint = lignes.filter((l) => Number(l.avec_teinture)).map((l) => Number(l.idcoloris)).filter((n) => n > 0)
  const nomsEcru = new Map((ecru.length ? await sql<{ id: number; ref: string }[]>`SELECT idcolori_ecru AS id, reference AS ref FROM colori_ecru WHERE idcolori_ecru = ANY(${ecru})` : []).map((r) => [Number(r.id), r.ref]))
  const nomsTeint = new Map((teint.length ? await sql<{ id: number; ref: string }[]>`SELECT idref_fini_colori AS id, reference AS ref FROM ref_fini_colori WHERE idref_fini_colori = ANY(${teint})` : []).map((r) => [Number(r.id), r.ref]))
  for (const l of lignes) {
    const coloris = (Number(l.avec_teinture) ? nomsTeint : nomsEcru).get(Number(l.idcoloris)) ?? ''
    out.set(Number(l.id), { ref: (l.ref ?? '').trim(), coloris: coloris.trim() })
  }
  return out
}

const ligneJson = (r: Record<string, unknown>) => ({
  ...r,
  quantite: n(r.quantite),
  pieces: n(r.pieces),
  prix_unitaire: n(r.prix_unitaire),
  montant: n(r.montant),
  poids_etm: n(r.poids_etm),
  prix_attendu: n(r.prix_attendu),
  ecart_montant: n(r.ecart_montant),
})

// ── GET /commande/:id — the invoices billing one sst order ──
facturesSstRouter.get('/commande/:id', async (req, res) => {
  if ((await garde(req, res, ECRAN_COMMANDES)) === null) return
  const id = idParam(req)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  try {
    const sql = mpsPg()
    const rows = await sql<Record<string, unknown>[]>`
      SELECT f.idfacture_sst AS idfacture, f.numero, to_char(f.date_facture, 'YYYY-MM-DD') AS date_facture, f.statut AS statut_facture, f.traitement, ${LIGNE_COLS(sql)}
      FROM ligne_facture_sst l JOIN facture_sst f ON f.idfacture_sst = l.idfacture_sst
      WHERE l.idcommande_sous_traitant = ${id}
      ORDER BY f.date_facture DESC NULLS LAST, l.ordre`
    res.json({ rows: rows.map(ligneJson) })
  } catch (err) {
    console.error('[factures-sst] by order failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /lignes/:id/detail — everything behind one lot line (expanded) ──
// The sst order it bills, the rolls ETM received under that lot, other
// invoices billing the same lot, and how ETM's price is made (recette.ts)
// — rebuilt from TODAY's tariff, the same engine the agent used.
facturesSstRouter.get('/lignes/:id/detail', async (req, res) => {
  if ((await garde(req, res, ECRAN_FACTURES_SST)) === null) return
  const id = idParam(req)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  try {
    const sql = mpsPg()
    const [l] = await sql<{ lot: string; quantite: number | null; unite: string; poids_etm: number | null; idligne: number; idcommande: number; idfacture: number; idsous_traitant: number }[]>`
      SELECT l.lot, l.quantite, l.unite, l.poids_etm, COALESCE(l.idligne_commande_sous_traitant, 0) AS idligne,
             COALESCE(l.idcommande_sous_traitant, 0) AS idcommande, l.idfacture_sst AS idfacture, f.idsous_traitant
      FROM ligne_facture_sst l JOIN facture_sst f ON f.idfacture_sst = l.idfacture_sst
      WHERE l.idligne_facture_sst = ${id}`
    if (!l) { res.status(404).json({ error: 'ligne introuvable' }); return }
    const code = codeLot(l.lot)

    const [commande] = Number(l.idcommande) > 0
      ? await sql<{ id: number; date_commande: string | null }[]>`
        SELECT idcommande_sous_traitant AS id, to_char(date_commande, 'YYYY-MM-DD') AS date_commande
        FROM commande_sous_traitant WHERE idcommande_sous_traitant = ${l.idcommande}`
      : []

    const rouleaux = code
      ? (await sql<{ numero: string | null; lot: string; poids: number | null; metrage: number | null }[]>`
          SELECT numero::text AS numero, lot::text AS lot, poids, metrage FROM stock_fini WHERE lot::text ILIKE ${code + '%'}`)
          .filter((r) => codeLot(r.lot) === code)
          .map((r) => ({ numero: r.numero ?? '', poids: n(r.poids), metrage: n(r.metrage) }))
          .sort((a, b) => a.numero.localeCompare(b.numero, undefined, { numeric: true }))
      : []

    const autres = code
      ? (await sql<{ numero: string }[]>`
          SELECT DISTINCT f.numero FROM ligne_facture_sst x JOIN facture_sst f ON f.idfacture_sst = x.idfacture_sst
          WHERE x.lot = ${code} AND f.idsous_traitant = ${l.idsous_traitant} AND f.idfacture_sst <> ${l.idfacture}`).map((r) => r.numero)
      : []

    let prix: RecettePrix | null = null
    if (Number(l.idligne) > 0) {
      const [lc] = await sql<{ idreference: number; idcoloris: number; type: number; idsous_traitant: number }[]>`
        SELECT COALESCE(lc.idreference, 0) AS idreference, COALESCE(lc.idcoloris, 0) AS idcoloris, COALESCE(lc.type, 0) AS type,
               COALESCE(c.idsous_traitant, 0) AS idsous_traitant
        FROM ligne_commande_sous_traitant lc LEFT JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = lc.idcommande_sous_traitant
        WHERE lc.idligne_commande_sous_traitant = ${l.idligne}`
      if (lc && Number(lc.type) === 2 && Number(lc.idreference) > 0) {
        // Same band weight as the agent: the smaller of ETM's and the billed weight.
        const billed = /^k/i.test(l.unite) ? Number(l.quantite) || 0 : 0
        const p = Number(l.poids_etm) || 0
        const xPoids = p && billed ? Math.min(p, billed) : p || billed
        const bd = await calcTarifSSTBreakdown({ xPoids, IDsous_traitant: Number(lc.idsous_traitant), IDref_fini: Number(lc.idreference), IDref_fini_colori: Number(lc.idcoloris) })
        if (bd && bd.total > 0) {
          const idsTrt = [...bd.treatments.map((t) => t.IDtraitement), ...bd.unpriced_treatments, ...(bd.base?.kind === 'combination' ? bd.base.covered : [])]
          const trt = new Map((idsTrt.length ? await sql<{ id: number; nom: string | null }[]>`
            SELECT idtraitement AS id, designation AS nom FROM traitement WHERE idtraitement = ANY(${idsTrt})` : []).map((r) => [Number(r.id), String(r.nom ?? '').trim()]))
          const idTeint = bd.base?.kind === 'dye-only' ? bd.base.IDteinture : 0
          const [teint] = idTeint ? await sql<{ nom: string | null }[]>`SELECT COALESCE(NULLIF(designation_externe, ''), designation_interne) AS nom FROM teinture WHERE idteinture = ${idTeint}` : []
          const idTranche = bd.base?.IDtranche ?? bd.treatments[0]?.IDtranche ?? 0
          const [tr] = idTranche ? await sql<{ mini: number | null; maxi: number | null }[]>`
            SELECT quantite_mini AS mini, quantite_maxi AS maxi FROM tranche_tarif_ennoblissement WHERE idtranche_tarif_ennoblissement = ${idTranche}` : []
          prix = recette(bd, {
            traitement: (t) => trt.get(t) || `traitement ${t}`,
            teinture: () => String(teint?.nom ?? '').trim() || 'Teinture',
          }, { mini: n(tr?.mini), maxi: n(tr?.maxi) })
        }
      }
    }
    res.json({ commande: commande ? { id: Number(commande.id), date_commande: commande.date_commande } : null, rouleaux, autres_factures: autres, prix })
  } catch (err) {
    console.error('[factures-sst] line detail failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /:id — one invoice with its lines ────────────────
facturesSstRouter.get('/:id', async (req, res) => {
  if ((await garde(req, res, ECRAN_FACTURES_SST)) === null) return
  const id = idParam(req)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  try {
    const sql = mpsPg()
    const [f] = await sql<Record<string, unknown>[]>`
      SELECT f.idfacture_sst AS id, f.idsous_traitant, COALESCE(s.nom, '') AS sous_traitant, f.numero, to_char(f.date_facture, 'YYYY-MM-DD') AS date_facture,
             to_char(f.date_echeance, 'YYYY-MM-DD') AS date_echeance, f.total_ht, f.total_ttc, f.statut, f.ecart_montant, f.controles, f.pdf_nom,
             (f.pdf IS NOT NULL AND length(f.pdf) > 0) AS a_pdf, f.message_id, f.run_id, f.cree_le,
             f.traitement, f.traite_le, f.traite_par_nom, f.traite_commentaire,
             f.cloture_le, f.cloture_par_nom, f.cloture_commentaire
      FROM facture_sst f LEFT JOIN sous_traitant s ON s.idsous_traitant = f.idsous_traitant
      WHERE f.idfacture_sst = ${id}`
    if (!f) { res.status(404).json({ error: 'facture introuvable' }); return }
    const lignes = await sql<Record<string, unknown>[]>`
      SELECT ${LIGNE_COLS(sql)} FROM ligne_facture_sst l WHERE l.idfacture_sst = ${id} ORDER BY l.ordre`
    const refs = await refsEtm(sql, [...new Set(lignes.map((l) => Number(l.idligne_commande_sous_traitant)).filter((x) => x > 0))])
    res.json({
      ...f, total_ht: n(f.total_ht), total_ttc: n(f.total_ttc), ecart_montant: n(f.ecart_montant),
      lignes: lignes.map((l) => {
        const r = refs.get(Number(l.idligne_commande_sous_traitant))
        return { ...ligneJson(l), ref_etm: r?.ref ?? null, coloris_etm: r?.coloris ?? null }
      }),
    })
  } catch (err) {
    console.error('[factures-sst] detail failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /:id/pdf — the invoice as received ───────────────
// No extension in the path: the prod nginx serves *.pdf as a static file.
facturesSstRouter.get('/:id/pdf', async (req, res) => {
  if ((await garde(req, res, ECRAN_FACTURES_SST)) === null) return
  const id = idParam(req)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  try {
    const [r] = await mpsPg()<{ pdf: Buffer | null; pdf_nom: string | null; numero: string }[]>`
      SELECT pdf, pdf_nom, numero FROM facture_sst WHERE idfacture_sst = ${id}`
    const buf = r?.pdf
    if (!buf || buf.length < 5 || buf.subarray(0, 4).toString() !== '%PDF') { res.status(404).json({ error: 'aucun PDF' }); return }
    const nom = (r.pdf_nom || `${r.numero}.pdf`).replace(/["\r\n]/g, '')
    res.setHeader('Content-Type', 'application/pdf')
    // Shown in an iframe of the web app (another origin in dev): drop helmet's frame guards.
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.setHeader('Content-Disposition', `inline; filename="${nom.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(nom)}`)
    res.send(buf)
  } catch (err) {
    console.error('[factures-sst] pdf failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /lignes/:id/avis — a person's decision on one line ──
// The agent's score (lib/agents/factures-sst/avis.ts). Only while the invoice
// is open: a closed invoice is reopened first.
const putAvis = z.object({
  action: z.enum(['conforme', 'ecart', 'corriger']).nullable(),
  commentaire: z.string().max(2000).default(''),
})

facturesSstRouter.put('/lignes/:id/avis', async (req, res) => {
  const uid = await garde(req, res, ECRAN_FACTURES_SST)
  if (uid === null) return
  const id = idParam(req)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  const p = putAvis.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'corps invalide' }); return }
  const { action } = p.data
  const commentaire = p.data.commentaire.trim()
  try {
    const sql = mpsPg()
    const [l] = await sql<{ idfacture_sst: number; verdict: Verdict; nature: Nature | null; traite_le: Date | null; lot: string; designation: string }[]>`
      SELECT l.idfacture_sst, l.verdict, l.nature, f.traite_le, l.lot, l.designation FROM ligne_facture_sst l
      JOIN facture_sst f ON f.idfacture_sst = l.idfacture_sst WHERE l.idligne_facture_sst = ${id}`
    if (!l) { res.status(404).json({ error: 'ligne introuvable' }); return }
    if (l.traite_le) { res.status(409).json({ error: 'facture_traitee', message: 'La facture est close : remettez-la à traiter pour changer une ligne.' }); return }
    const qui = await auteur(uid)
    const quoi = l.lot || l.designation || `ligne ${id}`
    if (action === null) {
      await sql`UPDATE ligne_facture_sst SET verdict_final = NULL, avis_note = NULL, avis_commentaire = NULL, avis_par = NULL, avis_par_nom = NULL, avis_le = NULL
                WHERE idligne_facture_sst = ${id}`
      await noter(sql, { idFacture: Number(l.idfacture_sst), type: 'ligne', par: qui, resume: `${quoi} : décision annulée.` })
    } else {
      let d
      try { d = decider(l.verdict, l.nature, action) } catch (e) {
        if (e instanceof ActionInvalide) { res.status(400).json({ error: 'action_invalide', message: e.message }); return }
        throw e
      }
      if (d.commentaireRequis && !commentaire) { res.status(400).json({ error: 'commentaire_requis', message: 'Expliquez pourquoi : c’est ce qui fera progresser l’agent.' }); return }
      await sql`UPDATE ligne_facture_sst SET verdict_final = ${d.verdictFinal}, avis_note = ${d.note}, avis_commentaire = ${commentaire || null},
                       avis_par = ${uid}, avis_par_nom = ${qui.nom}, avis_le = now()
                WHERE idligne_facture_sst = ${id}`
      const libelle = action === 'corriger' ? 'Tricobot corrigé'
        : d.verdictFinal === 'ecart' ? (l.verdict === 'conforme' ? 'écart signalé' : 'écart confirmé') : 'passée conforme'
      await noter(sql, { idFacture: Number(l.idfacture_sst), type: 'ligne', par: qui, resume: `${quoi} : ${libelle}${commentaire ? ` — ${commentaire}` : ''}.` })
    }
    await reporterAvisSurRun(Number(l.idfacture_sst))
    res.json({ ok: true })
  } catch (err) {
    console.error('[factures-sst] avis ligne failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /:id/traitement — close (or reopen) an invoice ──
// « validee »: no gap left, or gaps accepted (comment required); « reclamee »:
// the dyer is asked to correct the gaps (comment = what is claimed). Lines
// nobody touched take the agent's verdict (réussite); a line the agent could
// not decide must be decided first.
const putTraitement = z.object({
  traitement: z.enum(['validee', 'reclamee']).nullable(),
  commentaire: z.string().max(4000).default(''),
})

type Refus = { status: number; error: string; message?: string }

/** Close (or reopen) an invoice — shared by PUT /:id/traitement and the
 *  réclamation email. `verifier` only runs the checks (the email route checks
 *  BEFORE sending, so a refused close never sends a mail). */
async function traiter(id: number, uid: number, traitement: 'validee' | 'reclamee' | null, commentaire: string,
  opts: { verifier?: boolean; email?: { to: string[]; cc: string[]; subject: string; messageId: string | null } } = {}): Promise<Refus | null> {
  const sql = mpsPg()
  const [f] = await sql<{ traite_le: Date | null; traitement: string | null; controles: Array<{ gravite: string }> }[]>`SELECT traite_le, traitement, controles FROM facture_sst WHERE idfacture_sst = ${id}`
  if (!f) return { status: 404, error: 'facture introuvable' }
  if (traitement === null) {
    if (opts.verifier) return null
    const qui = await auteur(uid)
    await sql.begin(async (t) => {
      const tx = t as unknown as typeof sql
      await tx`UPDATE facture_sst SET traitement = NULL, traite_le = NULL, traite_par = NULL, traite_par_nom = NULL, traite_commentaire = NULL,
                       cloture_le = NULL, cloture_par = NULL, cloture_par_nom = NULL, cloture_commentaire = NULL
                WHERE idfacture_sst = ${id}`
      await noter(tx, { idFacture: id, type: 'rouverte', par: qui, resume: 'Remise à traiter.' })
    })
    console.log(`[factures-sst] invoice ${id}: rouverte by user ${uid}`)
    return null
  }
  if (f.traite_le) return { status: 409, error: 'deja_traitee', message: 'La facture est déjà close.' }
  const lignes = await sql<{ id: number; verdict: Verdict; nature: Nature | null; verdict_final: VerdictFinal | null; lot: string }[]>`
    SELECT idligne_facture_sst AS id, verdict, nature, verdict_final, lot FROM ligne_facture_sst WHERE idfacture_sst = ${id} ORDER BY ordre`
  const defauts: Array<{ id: number; verdictFinal: VerdictFinal }> = []
  // A misread invoice (lines ≠ total) is an écart as a whole.
  let ecarts = (f.controles ?? []).some((c) => c.gravite === 'bloquant') ? 1 : 0
  for (const l of lignes) {
    if (l.verdict_final) { if (l.verdict_final === 'ecart') ecarts++; continue }
    const d = parDefaut(l.verdict, l.nature)
    if (d === 'sans_objet') continue
    defauts.push({ id: Number(l.id), verdictFinal: d.verdictFinal })
    if (d.verdictFinal === 'ecart') ecarts++
  }
  if (traitement === 'reclamee' && ecarts === 0) return { status: 409, error: 'aucun_ecart', message: 'Aucune ligne en écart : il n’y a rien à réclamer.' }
  if (!commentaire && (traitement === 'reclamee' || ecarts > 0)) {
    return { status: 400, error: 'commentaire_requis', message: traitement === 'reclamee' ? 'Dites ce qui est réclamé au sous-traitant.' : 'Des lignes restent en écart : dites pourquoi la facture est validée quand même.' }
  }
  if (opts.verifier) return null
  const qui = await auteur(uid)
  const resume = traitement === 'validee'
    ? `Validée${ecarts > 0 ? ` malgré ${ecarts} écart${ecarts > 1 ? 's' : ''}` : ''}${commentaire ? ` — ${commentaire}` : '.'}`
    : opts.email ? `Réclamation envoyée par email à ${opts.email.to.join(', ')}.` : `Réclamée au sous-traitant (sans email) — ${commentaire}`
  await sql.begin(async (t) => {
    const tx = t as unknown as typeof sql
    // An untouched line confirms the agent: réussite (avis.ts parDefaut).
    for (const d of defauts) {
      await tx`UPDATE ligne_facture_sst SET verdict_final = ${d.verdictFinal}, avis_note = 'reussite', avis_par = ${uid}, avis_par_nom = ${qui.nom}, avis_le = now()
               WHERE idligne_facture_sst = ${d.id} AND verdict_final IS NULL`
    }
    await tx`UPDATE facture_sst SET traitement = ${traitement}, traite_le = now(), traite_par = ${uid}, traite_par_nom = ${qui.nom},
                    traite_commentaire = ${commentaire || null}
             WHERE idfacture_sst = ${id}`
    await noter(tx, { idFacture: id, type: traitement, par: qui, resume, details: opts.email ? { email: { ...opts.email, corps: commentaire } } : {} })
  })
  await reporterAvisSurRun(id)
  console.log(`[factures-sst] invoice ${id}: ${traitement} (${ecarts} écart(s)) by user ${uid}`)
  return null
}

facturesSstRouter.put('/:id/traitement', async (req, res) => {
  const uid = await garde(req, res, ECRAN_FACTURES_SST)
  if (uid === null) return
  const id = idParam(req)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  const p = putTraitement.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'corps invalide', details: p.error.issues }); return }
  try {
    const refus = await traiter(id, uid, p.data.traitement, p.data.commentaire.trim())
    if (refus) { res.status(refus.status).json({ error: refus.error, message: refus.message }); return }
    res.json({ ok: true })
  } catch (err) {
    console.error('[factures-sst] traitement failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Réclamation by email (decision Vincent 2026-10-05) ──
// « Réclamer au sous-traitant » opens the email window: to = who sent the
// invoice + the dyer's contacts flagged for invoices, cc = contact@ (where
// invoices arrive), the invoice PDF attached, the écarts listed. Sending it IS
// the réclamation (its body becomes the comment) and it lands in the history.

const eurFr = (n: number) => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dateFr = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('fr-FR') : '')
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The écarts a person kept (or the agent's real ones left untouched), one line each. */
async function lignesReclamees(id: number): Promise<{ lignes: string[]; trop: number }> {
  const rows = await mpsPg()<{ lot: string; designation: string; verdict: Verdict; nature: Nature | null; verdict_final: VerdictFinal | null; avis_commentaire: string | null; ecart_montant: number | null; controles: Array<{ gravite: string; message: string }> }[]>`
    SELECT lot, designation, verdict, nature, verdict_final, avis_commentaire, ecart_montant, controles FROM ligne_facture_sst
    WHERE idfacture_sst = ${id} AND genre = 'lot' ORDER BY ordre`
  const gardees = rows.filter((l) => l.verdict_final === 'ecart' || (!l.verdict_final && l.verdict === 'ecart'))
  const lignes = gardees.map((l) => {
    const motif = l.avis_commentaire?.trim() || (l.controles ?? []).find((c) => c.gravite !== 'info')?.message || 'à vérifier'
    return `- lot ${l.lot || l.designation} : ${motif}`
  })
  const trop = gardees.reduce((s, l) => s + (l.verdict_final ? 0 : Number(l.ecart_montant) || 0), 0)
  return { lignes, trop }
}

facturesSstRouter.get('/:id/reclamation/email-defaults', async (req, res) => {
  if ((await garde(req, res, ECRAN_FACTURES_SST)) === null) return
  const id = idParam(req)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  try {
    const sql = mpsPg()
    const [f] = await sql<{ numero: string; date_facture: string | null; idsous_traitant: number; message_id: string | null; nom: string | null }[]>`
      SELECT f.numero, to_char(f.date_facture, 'YYYY-MM-DD') AS date_facture, f.idsous_traitant, f.message_id, s.nom
      FROM facture_sst f LEFT JOIN sous_traitant s ON s.idsous_traitant = f.idsous_traitant WHERE f.idfacture_sst = ${id}`
    if (!f) { res.status(404).json({ error: 'facture introuvable' }); return }
    type Dest = { email: string; name?: string; source: 'contact' | 'manual'; contactId?: number }
    const selected: Dest[] = []
    const suggestions: Dest[] = []
    const vus = new Set<string>()
    // Who sent the invoice (read back from contact@; best effort).
    if (f.message_id) {
      try {
        const m = await lireMessage(FACTURES_SST_BOITE, f.message_id)
        const match = /<([^>]+)>/.exec(m.de)
        const mail = (match ? match[1] : m.de).trim()
        const nom = match ? m.de.slice(0, match.index).replace(/"/g, '').trim() : ''
        if (EMAIL_RE.test(mail)) { selected.push({ email: mail, ...(nom ? { name: nom } : {}), source: 'manual' }); vus.add(mail.toLowerCase()) }
      } catch (e) { console.warn('[factures-sst] sender lookup failed:', e) }
    }
    const contacts = await sql<{ idcontact: number; nom: string | null; prenom: string | null; mail: string | null; envoi_facture: number | null; est_visible: number | null }[]>`
      SELECT idcontact, nom, prenom, mail, envoi_facture, est_visible FROM contact WHERE idsous_traitant = ${f.idsous_traitant}`
    for (const c of contacts) {
      const mail = String(c.mail ?? '').trim()
      if (Number(c.est_visible) === 0 || !EMAIL_RE.test(mail) || vus.has(mail.toLowerCase())) continue
      vus.add(mail.toLowerCase())
      const name = [c.prenom, c.nom].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ')
      const d: Dest = { email: mail, source: 'contact', contactId: Number(c.idcontact), ...(name ? { name } : {}) }
      if (Number(c.envoi_facture) === 1) selected.push(d)
      else suggestions.push(d)
    }
    const { lignes, trop } = await lignesReclamees(id)
    const body =
      `Bonjour,\n\n` +
      `Après contrôle de votre facture N° ${f.numero}${f.date_facture ? ` du ${dateFr(f.date_facture)}` : ''}, nous relevons les écarts suivants :\n` +
      `${lignes.join('\n')}\n` +
      (trop > 0 ? `\nMontant facturé en trop selon notre tarif : ${eurFr(trop)} €.\n` : '') +
      `\nMerci de nous adresser un avoir ou une facture rectificative.\n\n` +
      `Cordialement,`
    res.json({
      recipients: { selected, suggestions },
      cc: [FACTURES_SST_BOITE],
      subject: `Réclamation facture N° ${f.numero} — ETS Malterre`,
      body,
    })
  } catch (err) {
    console.error('[factures-sst] reclamation email-defaults failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const postReclamationEmail = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20000),
  attach_pdf: z.boolean().optional(),
  extra_attachments: z.array(z.object({ filename: z.string().min(1).max(255), content_base64: z.string().min(1), content_type: z.string().min(1).max(100) })).optional(),
  /** Dev « Faux envoi »: everything but the Gmail send. Ignored in production. */
  dev_skip_send: z.boolean().optional(),
})

facturesSstRouter.post('/:id/reclamation/email', async (req, res) => {
  const uid = await garde(req, res, ECRAN_FACTURES_SST)
  if (uid === null) return
  const id = idParam(req)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  const p = postReclamationEmail.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'Validation failed', details: p.error.issues }); return }
  const d = p.data
  try {
    // Refused close = no mail sent.
    const refus = await traiter(id, uid, 'reclamee', corpsEnTexte(d.body).trim(), { verifier: true })
    if (refus) { res.status(refus.status).json({ error: refus.error, message: refus.message }); return }
    const from = await getUserEmail(uid)
    if (!from) {
      res.status(400).json({ error: 'no_sender_email', message: "Aucune adresse email n'est associée à votre compte. Un administrateur doit en définir une dans Paramètres › Utilisateurs." })
      return
    }
    const qui = await auteur(uid)
    const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
    if (d.attach_pdf !== false) {
      const [f] = await mpsPg()<{ pdf: Buffer | null; pdf_nom: string | null; numero: string }[]>`SELECT pdf, pdf_nom, numero FROM facture_sst WHERE idfacture_sst = ${id}`
      if (f?.pdf && f.pdf.length > 0) attachments.push({ filename: f.pdf_nom || `facture-${f.numero}.pdf`, content: Buffer.from(f.pdf), contentType: 'application/pdf' })
    }
    for (const a of d.extra_attachments ?? []) attachments.push({ filename: a.filename, content: Buffer.from(a.content_base64, 'base64'), contentType: a.content_type })
    const faux = d.dev_skip_send === true && process.env.NODE_ENV !== 'production'
    const messageId = faux ? null : await sendMail({
      from, fromName: `${qui.nom} — ETS Malterre`, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, body: d.body,
      attachments: attachments.length ? attachments : undefined,
    })
    await traiter(id, uid, 'reclamee', corpsEnTexte(d.body).trim(), { email: { to: d.to, cc: d.cc ?? [], subject: d.subject, messageId } })
    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('[factures-sst] reclamation email failed:', err)
    res.status(500).json({ error: 'send_failed', message: err instanceof Error ? err.message : 'Internal server error' })
  }
})

// ── GET /:id/historique ──
facturesSstRouter.get('/:id/historique', async (req, res) => {
  if ((await garde(req, res, ECRAN_FACTURES_SST)) === null) return
  const id = idParam(req)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  try {
    res.json({ evenements: await lireHistorique(id) })
  } catch (err) {
    console.error('[factures-sst] historique failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /:id/reclamation — close a réclamation with how it ended ──
// (a credit note, a corrected invoice, an explanation accepted). Required:
// it is the only record of how the dispute was settled.
const putCloture = z.object({ commentaire: z.string().trim().min(1).max(2000) })

facturesSstRouter.put('/:id/reclamation', async (req, res) => {
  const uid = await garde(req, res, ECRAN_FACTURES_SST)
  if (uid === null) return
  const id = idParam(req)
  if (!id) { res.status(400).json({ error: 'id invalide' }); return }
  const p = putCloture.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'commentaire_requis', message: 'Dites comment la réclamation s’est terminée (avoir, remise, explication…).' }); return }
  try {
    const qui = await auteur(uid)
    const sql = mpsPg()
    const r = await sql`
      UPDATE facture_sst SET traitement = 'reclamation_close', cloture_le = now(), cloture_par = ${uid},
             cloture_par_nom = ${qui.nom}, cloture_commentaire = ${p.data.commentaire}
      WHERE idfacture_sst = ${id} AND traitement = 'reclamee'`
    if (r.count === 0) { res.status(409).json({ error: 'pas_en_reclamation', message: 'Cette facture n’est pas en réclamation.' }); return }
    await noter(sql, { idFacture: id, type: 'reclamation_close', par: qui, resume: `Réclamation close — ${p.data.commentaire}` })
    console.log(`[factures-sst] invoice ${id}: réclamation close by user ${uid}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('[factures-sst] cloture failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Invoices waiting for a person — the Notifications widget's cards. With the
 *  agent's « confirmation » option on, every open invoice; off, those with a gap. */
export async function facturesATraiter(): Promise<Array<{
  id: number; numero: string; sous_traitant: string; date_facture: string | null; statut: string; ecart_montant: number; nb_ecarts: number; nb_non_verifies: number
}>> {
  const tout = await confirmationSystematique()
  const sql = mpsPg()
  const rows = await sql<Record<string, unknown>[]>`
    SELECT f.idfacture_sst AS id, f.numero, COALESCE(s.nom, '') AS sous_traitant, to_char(f.date_facture, 'YYYY-MM-DD') AS date_facture,
           f.statut, f.ecart_montant,
           COUNT(*) FILTER (WHERE l.verdict = 'ecart' AND l.nature = 'reel') AS nb_ecarts,
           COUNT(*) FILTER (WHERE l.verdict = 'ecart' AND l.nature = 'non_verifie') AS nb_non_verifies
    FROM facture_sst f
    LEFT JOIN sous_traitant s ON s.idsous_traitant = f.idsous_traitant
    LEFT JOIN ligne_facture_sst l ON l.idfacture_sst = f.idfacture_sst
    WHERE f.traite_le IS NULL AND ${tout ? sql`TRUE` : sql`f.statut <> 'conforme'`}
    GROUP BY f.idfacture_sst, s.nom
    ORDER BY f.date_facture DESC NULLS LAST`
  return rows.map((r) => ({
    id: Number(r.id), numero: String(r.numero), sous_traitant: String(r.sous_traitant), date_facture: (r.date_facture as string | null) ?? null,
    statut: String(r.statut), ecart_montant: Number(r.ecart_montant), nb_ecarts: Number(r.nb_ecarts),
    nb_non_verifies: Number(r.nb_non_verifies),
  }))
}
