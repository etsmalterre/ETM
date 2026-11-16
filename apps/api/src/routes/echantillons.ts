// Tombé Métier › Échantillons — trial écru fabrics and their life until they
// are archived or become a `ref_ecru` (claude_doc/echantillons_plan.md,
// rules in lib/echantillons.ts).
//
// One router factory mounted twice (CLAUDE.md § Sociétés): the samples are not
// partitioned — ETM and TRM show the same ones on one shared screen — but each
// app gates the routes with its own Écrans grant and picks clients from its own
// ledger. Native PostgreSQL throughout (lib/mps-pg.ts): new code since the
// cutover, lowercase columns, parameterised.

import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import type { Sql } from 'postgres'
import { mpsPg } from '../lib/mps-pg.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { userCanOpenScreen, userHasPermission } from '../lib/permissions.js'
import type { PermissionKey } from '../lib/permission-keys.js'
import { refFiniReferenceLock, refFiniReferenceTaken } from '../lib/ref-fini-reference.js'
import { trmUserCanOpenScreen } from '../lib/permissions-trm.js'
import { resolveMachineLabels } from '../lib/production-trm.js'
import { nextRefNumber } from './references-ecru.js'
import React from 'react'
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer'
import { EtiquetteEchantillonPdf, type EtiquetteEchantillonData } from '../lib/pdf/EtiquetteEchantillonPdf.js'
import {
  DIAMETRE_ORD_MAX,
  JAUGE_ORD_MAX,
  DELAI_RELANCE_JOURS,
  ajouterJours,
  aujourdhuiParis,
  compositionComplete,
  estSuivi,
  ficheSurReference,
  lfaNombre,
  nomFiniRetenu,
  refusEssaiIndustriel,
  situationPiece,
  urgenceRelance,
  diametreLibelle,
  jaugeLibelle,
  fractionVersPourcent,
  lfaTexte,
  numeroEchantillon,
  ordinalValide,
  pourcentVersFraction,
  refusCreationReference,
  statutEchantillon,
  type StatutEchantillon,
} from '../lib/echantillons.js'

const MENU = '/tombe-metier'
const ECRAN = '/tombe-metier/echantillons'

export interface EchantillonsScope {
  /** Écrans › Tombé Métier › Échantillons in the app's own store. Admins pass. */
  canOpen(userId: number, admin: boolean): Promise<boolean>
  /** The client ledger the Client picker lists (IDsociete). */
  societeClients: 1 | 2
  /** May this user rename a finished reference? « Retenu » offers to rename
   *  the trial's finis with their écru (E055A → 104A); the right stays the
   *  Finis › Références one. TRM has no Finis: never. */
  peutRenommerFini(userId: number, admin: boolean): Promise<boolean>
}

export const ECHANTILLONS_SCOPE_ETM: EchantillonsScope = {
  canOpen: (userId, admin) => userCanOpenScreen(userId, admin, MENU, ECRAN),
  societeClients: 1,
  peutRenommerFini(userId, admin) {
    return userHasPermission(userId, admin, 'edit_ref_fini' satisfies PermissionKey)
  },
}
export const ECHANTILLONS_SCOPE_TRM: EchantillonsScope = {
  canOpen: (userId, admin) => trmUserCanOpenScreen(userId, admin, MENU, ECRAN),
  societeClients: 2,
  async peutRenommerFini() {
    return false
  },
}

// ── Shapes ──────────────────────────────────────────────

interface EchantillonRow {
  idref_echantillon: number
  idcontexture: number | null
  jauge: number | null
  diametre: number | null
  lfa1: number | null
  lfa2: number | null
  lfa3: number | null
  lfa4: number | null
  laize_tbm: number | null
  poids_m2_tbm: number | null
  laize_lave: number | null
  poids_m2_lave: number | null
  commentaire: string | null
  idclient: number | null
  archive: number | null
  idref_ecru: number | null
  /** YYYY-MM-DD (to_char), null when unset. */
  date_relance?: string | null
  contexture_nom: string | null
  client_nom: string | null
  ref_reference: string | null
  ref_designation: string | null
  /** The linked reference's flag: 1 while it is the sample's industrial trial. */
  ref_essai: number | null
  ref_idcontexture: number | null
  ref_jauge: number | null
  ref_diametre: number | null
  ref_lfa1: string | null
  ref_lfa2: string | null
  ref_lfa3: string | null
  ref_lfa4: string | null
  ref_laize_tbm: number | null
  ref_poids_m2_tbm: number | null
}

const SELECT_ECHANTILLON = (sql: Sql) => sql`
  SELECT e.idref_echantillon, e.idcontexture, e.jauge, e.diametre, e.lfa1, e.lfa2, e.lfa3, e.lfa4,
         e.laize_tbm, e.poids_m2_tbm, e.laize_lave, e.poids_m2_lave,
         e.commentaire, e.idclient, e.archive, e.idref_ecru, to_char(e.date_relance, 'YYYY-MM-DD') AS date_relance,
         c.nom AS contexture_nom, cl.nom AS client_nom,
         r.reference AS ref_reference, r.designation AS ref_designation, r.essai AS ref_essai,
         r.idcontexture AS ref_idcontexture, r.jauge AS ref_jauge, r.diametre AS ref_diametre,
         r.lfa_tour_1 AS ref_lfa1, r.lfa_tour_2 AS ref_lfa2, r.lfa_tour_3 AS ref_lfa3, r.lfa_tour_4 AS ref_lfa4,
         r.laize_tbm AS ref_laize_tbm, r.poids_m2_tbm AS ref_poids_m2_tbm
    FROM ref_echantillon e
    LEFT JOIN ref_ecru r ON r.idref_ecru = e.idref_ecru AND e.idref_ecru > 0
    -- The contexture named is the one of the sheet shown (ficheTechnique()).
    LEFT JOIN contexture c ON c.idcontexture = CASE WHEN r.essai = 1 THEN r.idcontexture ELSE e.idcontexture END
    LEFT JOIN client cl ON cl.idclient = e.idclient AND e.idclient > 0`

/** The technical sheet to show: the provisional reference's while the sample
 *  is at its industrial trial (ONE sheet, the one the OF reads), the sample's
 *  own otherwise (laboratory, or the snapshot written by « retenu »). */
function ficheTechnique(e: EchantillonRow) {
  if (ficheSurReference(e)) {
    return {
      idcontexture: e.ref_idcontexture, jauge: e.ref_jauge, diametre: e.ref_diametre,
      lfa: [e.ref_lfa1, e.ref_lfa2, e.ref_lfa3, e.ref_lfa4].map(lfaNombre),
      laize_tbm: e.ref_laize_tbm, poids_m2_tbm: e.ref_poids_m2_tbm,
    }
  }
  return {
    idcontexture: e.idcontexture, jauge: e.jauge, diametre: e.diametre,
    lfa: [e.lfa1, e.lfa2, e.lfa3, e.lfa4].map((v) => Number(v) || 0),
    laize_tbm: e.laize_tbm, poids_m2_tbm: e.poids_m2_tbm,
  }
}

function shape(e: EchantillonRow) {
  const f = ficheTechnique(e)
  return {
    IDref_echantillon: e.idref_echantillon,
    numero: numeroEchantillon(e.idref_echantillon),
    statut: statutEchantillon(e),
    // true = contexture, jauge, Ø, LFA, TBM and composition are the provisional
    // reference's and are edited there (Tombé Métier › Références).
    fiche_sur_reference: ficheSurReference(e),
    IDcontexture: Number(f.idcontexture) || 0,
    contexture_nom: e.contexture_nom?.trim() || null,
    Jauge: ordinalValide(f.jauge, JAUGE_ORD_MAX),
    diametre: ordinalValide(f.diametre, DIAMETRE_ORD_MAX),
    lfa: f.lfa,
    // Off the machine, and after the internal wash (« pré-industriel »): cm, g/m², 0 = not measured.
    tbm: { laize: Number(f.laize_tbm) || 0, poids: Number(f.poids_m2_tbm) || 0 },
    lave: { laize: Number(e.laize_lave) || 0, poids: Number(e.poids_m2_lave) || 0 },
    commentaire: e.commentaire ?? '',
    IDclient: Number(e.idclient) || 0,
    client_nom: e.client_nom?.trim() || null,
    // Next follow-up and how pressing it is (amber 7 days before, red from it).
    relance: { date: e.date_relance ?? null, ...urgenceRelance({ statut: statutEchantillon(e), date_relance: e.date_relance ?? null }, aujourdhuiParis()) },
    reference: (Number(e.idref_ecru) || 0) > 0
      ? { IDref_ecru: Number(e.idref_ecru), reference: e.ref_reference?.trim() ?? '', designation: e.ref_designation?.trim() ?? '', essai: !!Number(e.ref_essai) }
      : null,
  }
}

async function loadEchantillon(sql: Sql, id: number): Promise<EchantillonRow | null> {
  const [row] = await sql<EchantillonRow[]>`${SELECT_ECHANTILLON(sql)} WHERE e.idref_echantillon = ${id}`
  return row ?? null
}

interface CompoRow {
  idfil_ref_echantillon: number
  idref_fil: number
  idcolori_fil: number
  pourcentage: number | null
  ref_fil_reference: string | null
  colori_fil_reference: string | null
}

/** The composition shown: the provisional reference's own recipe
 *  (`composition_ecru`, idcolori_ecru = 0, in %) while the sample is at its
 *  industrial trial, the sample's (`fil_ref_echantillon`, a fraction) otherwise. */
async function loadComposition(sql: Sql, e: EchantillonRow) {
  const rows = ficheSurReference(e)
    ? await sql<CompoRow[]>`
        SELECT c.idcomposition_ecru AS idfil_ref_echantillon, c.idref_fil, c.idcolori_fil, c.pourcentage / 100.0 AS pourcentage,
               rf.reference AS ref_fil_reference, cf.reference AS colori_fil_reference
          FROM composition_ecru c
          LEFT JOIN ref_fil rf ON rf.idref_fil = c.idref_fil
          LEFT JOIN colori_fil cf ON cf.idcolori_fil = c.idcolori_fil AND c.idcolori_fil > 0
         WHERE c.idref_ecru = ${Number(e.idref_ecru)} AND (c.idcolori_ecru = 0 OR c.idcolori_ecru IS NULL)
         ORDER BY c.pourcentage DESC, c.idcomposition_ecru`
    : await sql<CompoRow[]>`
        SELECT f.idfil_ref_echantillon, f.idref_fil, f.idcolori_fil, f.pourcentage,
               rf.reference AS ref_fil_reference, cf.reference AS colori_fil_reference
          FROM fil_ref_echantillon f
          LEFT JOIN ref_fil rf ON rf.idref_fil = f.idref_fil
          LEFT JOIN colori_fil cf ON cf.idcolori_fil = f.idcolori_fil AND f.idcolori_fil > 0
         WHERE f.idref_echantillon = ${e.idref_echantillon}
         ORDER BY f.pourcentage DESC, f.idfil_ref_echantillon`
  return rows.map((r) => ({
    IDfil_ref_echantillon: r.idfil_ref_echantillon,
    IDref_fil: Number(r.idref_fil) || 0,
    ref_fil_reference: r.ref_fil_reference?.trim() || null,
    IDcolori_fil: Number(r.idcolori_fil) || 0,
    colori_fil_reference: r.colori_fil_reference?.trim() || null,
    pourcentage: fractionVersPourcent(r.pourcentage),
  }))
}

async function loadRelances(sql: Sql, id: number) {
  const rows = await sql<{ id: number; le: Date; auteur: string; note: string; prochaine_relance: string | null }[]>`
    SELECT id, le, auteur, note, to_char(prochaine_relance, 'YYYY-MM-DD') AS prochaine_relance
      FROM echantillon_relance WHERE idref_echantillon = ${id} ORDER BY le DESC, id DESC`
  return rows.map((r) => ({ id: r.id, le: r.le.toISOString(), auteur: r.auteur, note: r.note, prochaine_relance: r.prochaine_relance }))
}

interface PieceRow {
  idpiece_echantillon: number
  numero: string | null
  date: string | null
  idmachine: number | null
  poids: number | null
  longueur: number | null
  laize: number | null
}

async function loadPieces(sql: Sql, id: number) {
  const rows = await sql<PieceRow[]>`
    SELECT idpiece_echantillon, numero, to_char(date, 'YYYY-MM-DD') AS date, idmachine, poids, longueur, laize
      FROM piece_echantillon WHERE idref_echantillon = ${id}
     ORDER BY date NULLS LAST, idpiece_echantillon`
  const labels = await resolveMachineLabels(rows.map((r) => Number(r.idmachine) || 0))
  return rows.map((r) => ({
    IDpiece_echantillon: r.idpiece_echantillon,
    numero: r.numero?.trim() ?? '',
    date: r.date,
    IDmachine: Number(r.idmachine) || 0,
    machine_nom: labels.get(Number(r.idmachine)) ?? null,
    poids: Number(r.poids) || 0,
    longueur: Number(r.longueur) || 0,
    laize: Number(r.laize) || 0,
  }))
}

interface PieceStockRow {
  idstock_ecru: number
  numero: string | null
  lot: string | null
  poids: number | null
  date: string | null
  idordre_fabrication: number | null
  idsociete: number | null
  second_choix: number | null
  idligne_expedition_etm: number | null
  idcommande_donation: number | null
  coloris: string | null
  magasin_nom: string | null
  aff_commande: number | null
  aff_nom: string | null
}

/** The real pieces of the industrial trial: every `stock_ecru` roll of the
 *  provisional reference (knitted on an OF, visited, in stock, at the dyer…),
 *  with where each stands. Read only — they are moved by the screens that own
 *  them (TRM visitage, Sous-traitants, Transferts). */
async function loadPiecesStock(sql: Sql, idRefEcru: number) {
  const rows = await sql<PieceStockRow[]>`
    SELECT s.idstock_ecru, s.numero, s.lot, s.poids, to_char(s.date_saisie, 'YYYY-MM-DD') AS date,
           s.idordre_fabrication, s.idsociete, s.second_choix, s.idligne_expedition_etm, s.idcommande_donation,
           ce.reference AS coloris, m.nom AS magasin_nom,
           l.idcommande_sous_traitant AS aff_commande, st.nom AS aff_nom
      FROM stock_ecru s
      LEFT JOIN colori_ecru ce ON ce.idcolori_ecru = s.idcolori_ecru
      LEFT JOIN sous_traitant m ON m.idsous_traitant = s.idmagasin AND s.idmagasin > 0
      LEFT JOIN ligne_commande_sous_traitant l
             ON l.idligne_commande_sous_traitant = s.idref_commande_affectation AND s.idref_commande_affectation > 0
      LEFT JOIN commande_sous_traitant cs ON cs.idcommande_sous_traitant = l.idcommande_sous_traitant
      LEFT JOIN sous_traitant st ON st.idsous_traitant = cs.idsous_traitant
     WHERE s.idref_ecru = ${idRefEcru}
     ORDER BY s.date_saisie NULLS LAST, s.idstock_ecru`
  // The fini roll(s) each piece became: its own child, or a merged roll it is
  // a component of (stock_fini_source, #1149).
  const ids = rows.map((r) => Number(r.idstock_ecru))
  const finiParEcru = new Map<number, { lot: string | null; reference: string | null }>()
  if (ids.length > 0) {
    const finis = await sql<{ idstock_ecru: number; lot: string | null; reference: string | null }[]>`
      SELECT f.idstock_ecru, f.lot, rf.reference
        FROM stock_fini f LEFT JOIN ref_fini rf ON rf.idref_fini = f.idref_fini
       WHERE f.idstock_ecru = ANY(${ids})
      UNION ALL
      SELECT fs.idstock_ecru, f.lot, rf.reference
        FROM stock_fini_source fs
        JOIN stock_fini f ON f.idstock_fini = fs.idstock_fini
        LEFT JOIN ref_fini rf ON rf.idref_fini = f.idref_fini
       WHERE fs.idstock_ecru = ANY(${ids})`
    for (const f of finis) {
      if (!finiParEcru.has(Number(f.idstock_ecru))) {
        finiParEcru.set(Number(f.idstock_ecru), { lot: f.lot?.trim() || null, reference: f.reference?.trim() || null })
      }
    }
  }
  return rows.map((r) => {
    const situation = situationPiece({
      idsociete: Number(r.idsociete) || 0,
      magasin_nom: r.magasin_nom?.trim() || null,
      expediee: (Number(r.idligne_expedition_etm) || 0) > 0,
      donnee: (Number(r.idcommande_donation) || 0) > 0,
      ennoblisseur: (Number(r.aff_commande) || 0) > 0 ? { nom: r.aff_nom?.trim() || null, commande: Number(r.aff_commande) } : null,
      fini: finiParEcru.get(Number(r.idstock_ecru)) ?? null,
    })
    return {
      IDstock_ecru: Number(r.idstock_ecru),
      numero: String(r.numero ?? '').trim(),
      lot: r.lot?.trim() || null,
      date: r.date,
      poids: Number(r.poids) || 0,
      IDordre_fabrication: Number(r.idordre_fabrication) || 0,
      coloris: r.coloris?.trim() || null,
      second_choix: !!Number(r.second_choix),
      situation: situation.libelle,
      en_stock: situation.enStock,
    }
  })
}

interface FiniEssaiRow { idref_fini: number; reference: string | null; designation: string | null; archive: number | null }

/** The finished references built on the provisional écru (the dyer trials). */
async function loadFinisEssai(sql: Sql, idRefEcru: number) {
  const rows = await sql<FiniEssaiRow[]>`
    SELECT idref_fini, reference, designation, archive FROM ref_fini WHERE idref_ecru = ${idRefEcru} ORDER BY reference`
  return rows.map((r) => ({
    IDref_fini: Number(r.idref_fini),
    reference: String(r.reference ?? '').trim(),
    designation: String(r.designation ?? '').trim(),
    archive: !!Number(r.archive),
  }))
}

/** The Dymo tag's fields (lib/pdf/EtiquetteEchantillonPdf.tsx). */
export async function buildEtiquetteEchantillonData(id: number): Promise<EtiquetteEchantillonData | null> {
  const sql = mpsPg()
  const row = await loadEchantillon(sql, id)
  if (!row) return null
  const compo = await loadComposition(sql, row)
  const f = ficheTechnique(row)
  return {
    IDref_echantillon: id,
    numero: numeroEchantillon(id),
    contexture: row.contexture_nom?.trim() || null,
    jauge: jaugeLibelle(ordinalValide(f.jauge, JAUGE_ORD_MAX)),
    diametre: diametreLibelle(ordinalValide(f.diametre, DIAMETRE_ORD_MAX)),
    lfa: f.lfa,
    composition: compo.map((c) => ({ pourcentage: c.pourcentage, fil: c.ref_fil_reference ?? '' })),
  }
}

// ── Bodies ──────────────────────────────────────────────

const enteteBody = z.object({
  IDcontexture: z.number().int().min(0),
  Jauge: z.number().int().min(0).max(JAUGE_ORD_MAX),
  diametre: z.number().int().min(0).max(DIAMETRE_ORD_MAX),
  lfa: z.array(z.number().min(0)).length(4),
  tbm: z.object({ laize: z.number().min(0), poids: z.number().min(0) }),
  lave: z.object({ laize: z.number().min(0), poids: z.number().min(0) }),
  commentaire: z.string().max(4000),
  IDclient: z.number().int().min(0),
  date_relance: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
})

const compositionBody = z.object({
  lignes: z.array(z.object({
    IDref_fil: z.number().int().positive(),
    IDcolori_fil: z.number().int().min(0),
    pourcentage: z.number().positive().max(100),
  })).max(20),
})

const pieceBody = z.object({
  numero: z.string().trim().max(50),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  IDmachine: z.number().int().min(0),
  poids: z.number().min(0),
  longueur: z.number().min(0),
  laize: z.number().min(0),
})

const creerReferenceBody = z.object({
  reference: z.string().trim().min(1).max(50),
  designation: z.string().trim().max(200),
  /** Finis of the provisional reference to rename with it (E055A → 104A). */
  renommer_finis: z.array(z.number().int().positive()).max(50).optional(),
})

const essaiIndustrielBody = z.object({
  designation: z.string().trim().max(200),
})

const relanceBody = z.object({
  note: z.string().max(2000),
  prochaine_relance: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
})

/** The list's three filters. « En cours » holds every followed sample:
 *  laboratory trials and industrial ones. */
const FILTRES = ['en_cours', 'reference', 'archive'] as const
type Filtre = (typeof FILTRES)[number]
const filtreDe = (s: StatutEchantillon): Filtre => (s === 'essai' ? 'en_cours' : s)

const MSG_CLOS = "L'échantillon n'est plus en cours : rouvrez-le pour le modifier."
const msgSurReference = (ref: string | null | undefined) =>
  `L'échantillon est à l'essai industriel : sa fiche technique se modifie sur la référence ${ref?.trim() ?? ''} (Tombé Métier › Références).`

// ── Router ──────────────────────────────────────────────

export function createEchantillonsRouter(scope: EchantillonsScope): RouterType {
  const router: RouterType = Router()

  // Every route, reads included: the screen IS the right (no action key —
  // CLAUDE.md « Écrans = what a user SEES »), and there is no global guard.
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
      if (!(await scope.canOpen(req.userId, isEffectiveAdmin(req)))) {
        res.status(403).json({ error: 'écran non accordé : Tombé Métier › Échantillons' })
        return
      }
      next()
    } catch (err) {
      next(err)
    }
  })

  /** Loads the sample or answers 404; with `ouvert`, also refuses (409) a
   *  sample that is no longer followed (laboratory or industrial trial); with
   *  `labo`, one whose technical sheet has moved onto its provisional reference. */
  async function charger(req: Request, res: Response, opts: { ouvert?: boolean; labo?: boolean } = {}) {
    const id = parseInt(req.params.id, 10)
    if (!(id > 0)) { res.status(400).json({ error: 'Invalid ID' }); return null }
    const row = await loadEchantillon(mpsPg(), id)
    if (!row) { res.status(404).json({ error: 'Échantillon introuvable' }); return null }
    const statut = statutEchantillon(row)
    if ((opts.ouvert || opts.labo) && !estSuivi(statut)) {
      res.status(409).json({ error: 'echantillon_clos', message: MSG_CLOS })
      return null
    }
    if (opts.labo && statut === 'essai') {
      res.status(409).json({ error: 'fiche_sur_reference', message: msgSurReference(row.ref_reference) })
      return null
    }
    return row
  }

  // GET /lookups/clients — the app's own client ledger
  router.get('/lookups/clients', async (_req, res) => {
    try {
      const rows = await mpsPg()<{ idclient: number; nom: string | null }[]>`
        SELECT idclient, nom FROM client
         WHERE idsociete = ${scope.societeClients} AND est_visible = 1 AND COALESCE(TRIM(nom), '') <> ''
         ORDER BY nom`
      res.json(rows.map((r) => ({ IDclient: r.idclient, nom: r.nom!.trim(), ville: null })))
    } catch (err) {
      console.error('Error fetching échantillon clients lookup:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /?statut=en_cours|reference|archive
  router.get('/', async (req, res) => {
    try {
      const filtre = FILTRES.includes(req.query.statut as Filtre) ? (req.query.statut as Filtre) : 'en_cours'
      const sql = mpsPg()
      const rows = await sql<EchantillonRow[]>`${SELECT_ECHANTILLON(sql)} ORDER BY e.idref_echantillon DESC`
      const pieces = await sql<{ idref_echantillon: number; n: number }[]>`
        SELECT idref_echantillon, COUNT(*)::int AS n FROM piece_echantillon GROUP BY idref_echantillon`
      const nbPieces = new Map(pieces.map((p) => [Number(p.idref_echantillon), p.n]))
      // Real pieces of the industrial trials (rolls of the provisional references).
      const stock = await sql<{ idref_ecru: number; n: number }[]>`
        SELECT s.idref_ecru, COUNT(*)::int AS n FROM stock_ecru s
          JOIN ref_ecru r ON r.idref_ecru = s.idref_ecru AND r.essai = 1
         GROUP BY s.idref_ecru`
      const nbStock = new Map(stock.map((p) => [Number(p.idref_ecru), p.n]))
      res.json(rows
        .filter((r) => filtreDe(statutEchantillon(r)) === filtre)
        .map((r) => ({
          ...shape(r),
          pieces_count: (nbPieces.get(r.idref_echantillon) ?? 0) + (ficheSurReference(r) ? nbStock.get(Number(r.idref_ecru)) ?? 0 : 0),
        })))
    } catch (err) {
      console.error('Error listing échantillons:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /:id
  router.get('/:id', async (req, res) => {
    try {
      const row = await charger(req, res)
      if (!row) return
      const sql = mpsPg()
      const essai = ficheSurReference(row)
      res.json({
        ...shape(row),
        composition: await loadComposition(sql, row),
        relances: await loadRelances(sql, row.idref_echantillon),
        pieces: await loadPieces(sql, row.idref_echantillon),
        // The industrial trial: real rolls and the finis built on the
        // provisional reference. Empty once retained — the reference then
        // lives its own life on Références / Stock.
        pieces_stock: essai ? await loadPiecesStock(sql, Number(row.idref_ecru)) : [],
        finis: essai ? await loadFinisEssai(sql, Number(row.idref_ecru)) : [],
      })
    } catch (err) {
      console.error('Error fetching échantillon:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /:id/etiquette — the Dymo tag (89 × 36 mm), one per print, inline.
  // Any status: a sample archived or kept keeps its fabric and its tag.
  router.get('/:id/etiquette', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      if (!(id > 0)) { res.status(400).json({ error: 'Invalid ID' }); return }
      const data = await buildEtiquetteEchantillonData(id)
      if (!data) { res.status(404).json({ error: 'Échantillon introuvable' }); return }
      const buffer = await renderToBuffer(
        React.createElement(EtiquetteEchantillonPdf, { data }) as unknown as React.ReactElement<DocumentProps>,
      )
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `inline; filename="etiquette-${data.numero}.pdf"`)
      res.removeHeader('X-Frame-Options')
      res.removeHeader('Content-Security-Policy')
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      res.send(buffer)
    } catch (err) {
      console.error('Error rendering échantillon étiquette PDF:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST / — a blank sample, filled in edit mode right after (§25.1)
  router.post('/', async (_req, res) => {
    try {
      const id = await mpsPg().begin(async (t) => {
        const tx = t as unknown as Sql
        const [row] = await tx<{ idref_echantillon: number }[]>`
          INSERT INTO ref_echantillon (idcontexture, jauge, diametre, lfa1, lfa2, lfa3, lfa4, commentaire, idclient, archive, idref_ecru, date_relance)
          VALUES (0, 0, 0, 0, 0, 0, 0, '', 0, 0, 0, ${ajouterJours(aujourdhuiParis(), DELAI_RELANCE_JOURS)})
          RETURNING idref_echantillon`
        // An identity may hand back the id of a sample the legacy deleted
        // without its children (#1290): a new sample starts empty.
        await tx`DELETE FROM fil_ref_echantillon WHERE idref_echantillon = ${row.idref_echantillon}`
        await tx`DELETE FROM piece_echantillon WHERE idref_echantillon = ${row.idref_echantillon}`
        return row.idref_echantillon
      })
      res.status(201).json({ IDref_echantillon: id })
    } catch (err) {
      console.error('Error creating échantillon:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // PUT /:id — header fields
  router.put('/:id', async (req, res) => {
    try {
      const parsed = enteteBody.safeParse(req.body)
      if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
      const row = await charger(req, res, { ouvert: true })
      if (!row) return
      const b = parsed.data
      if (ficheSurReference(row)) {
        // Industrial trial: the technical sheet is the provisional reference's.
        // Only what belongs to the research stays here.
        await mpsPg()`
          UPDATE ref_echantillon SET
            laize_lave = ${b.lave.laize}, poids_m2_lave = ${b.lave.poids},
            commentaire = ${b.commentaire}, idclient = ${b.IDclient}, date_relance = ${b.date_relance}
          WHERE idref_echantillon = ${row.idref_echantillon}`
        res.json({ ok: true })
        return
      }
      await mpsPg()`
        UPDATE ref_echantillon SET
          idcontexture = ${b.IDcontexture}, jauge = ${b.Jauge}, diametre = ${b.diametre},
          lfa1 = ${b.lfa[0]}, lfa2 = ${b.lfa[1]}, lfa3 = ${b.lfa[2]}, lfa4 = ${b.lfa[3]},
          laize_tbm = ${b.tbm.laize}, poids_m2_tbm = ${b.tbm.poids},
          laize_lave = ${b.lave.laize}, poids_m2_lave = ${b.lave.poids},
          commentaire = ${b.commentaire}, idclient = ${b.IDclient}, date_relance = ${b.date_relance}
        WHERE idref_echantillon = ${row.idref_echantillon}`
      res.json({ ok: true })
    } catch (err) {
      console.error('Error updating échantillon:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // DELETE /:id — only a laboratory sample with no trial piece: one that was
  // knitted is history, it gets archived instead (and one at its industrial
  // trial has a reference, orders and rolls behind it).
  router.delete('/:id', async (req, res) => {
    try {
      const row = await charger(req, res, { ouvert: true })
      if (!row) return
      if (ficheSurReference(row)) {
        res.status(409).json({
          error: 'essai_industriel',
          message: `L'échantillon est à l'essai industriel sur la référence ${row.ref_reference?.trim() ?? ''} : abandonnez l'essai (archiver) plutôt que de le supprimer.`,
        })
        return
      }
      const id = row.idref_echantillon
      await mpsPg().begin(async (t) => {
        const tx = t as unknown as Sql
        const [{ n }] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM piece_echantillon WHERE idref_echantillon = ${id}`
        if (n > 0) throw new RefusError('pieces_existantes', 'Des pièces d\'essai ont été tricotées : archivez l\'échantillon plutôt que de le supprimer.')
        await tx`DELETE FROM fil_ref_echantillon WHERE idref_echantillon = ${id}`
        await tx`DELETE FROM ref_echantillon WHERE idref_echantillon = ${id}`
      })
      res.json({ ok: true })
    } catch (err) {
      if (err instanceof RefusError) { res.status(409).json({ error: err.code, message: err.message }); return }
      console.error('Error deleting échantillon:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // PUT /:id/composition — the whole yarn list at once (empty or 100 %)
  router.put('/:id/composition', async (req, res) => {
    try {
      const parsed = compositionBody.safeParse(req.body)
      if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
      const lignes = parsed.data.lignes
      if (!compositionComplete(lignes.map((l) => l.pourcentage))) {
        res.status(400).json({ error: 'composition_incomplete', message: 'La composition doit totaliser 100 %.' })
        return
      }
      const row = await charger(req, res, { labo: true })
      if (!row) return
      const id = row.idref_echantillon
      await mpsPg().begin(async (t) => {
        const tx = t as unknown as Sql
        await tx`DELETE FROM fil_ref_echantillon WHERE idref_echantillon = ${id}`
        for (const l of lignes) {
          await tx`
            INSERT INTO fil_ref_echantillon (idref_echantillon, idref_fil, idcolori_fil, pourcentage)
            VALUES (${id}, ${l.IDref_fil}, ${l.IDcolori_fil}, ${pourcentVersFraction(l.pourcentage)})`
        }
      })
      res.json({ composition: await loadComposition(mpsPg(), row) })
    } catch (err) {
      console.error('Error saving échantillon composition:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /:id/pieces · PUT /:id/pieces/:pieceId · DELETE /:id/pieces/:pieceId
  // — trial pieces are typed by hand (Vincent 2026-10-21), on an open sample.
  router.post('/:id/pieces', async (req, res) => {
    try {
      const parsed = pieceBody.safeParse(req.body)
      if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
      const row = await charger(req, res, { ouvert: true })
      if (!row) return
      const p = parsed.data
      const [created] = await mpsPg()<{ idpiece_echantillon: number }[]>`
        INSERT INTO piece_echantillon (idref_echantillon, numero, date, idmachine, poids, longueur, laize)
        VALUES (${row.idref_echantillon}, ${p.numero}, ${p.date}, ${p.IDmachine}, ${p.poids}, ${p.longueur}, ${p.laize})
        RETURNING idpiece_echantillon`
      res.status(201).json({ IDpiece_echantillon: created.idpiece_echantillon })
    } catch (err) {
      console.error('Error creating piece_echantillon:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  router.put('/:id/pieces/:pieceId', async (req, res) => {
    try {
      const parsed = pieceBody.safeParse(req.body)
      if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
      const pieceId = parseInt(req.params.pieceId, 10)
      const row = await charger(req, res, { ouvert: true })
      if (!row) return
      const p = parsed.data
      const updated = await mpsPg()`
        UPDATE piece_echantillon SET
          numero = ${p.numero}, date = ${p.date}, idmachine = ${p.IDmachine},
          poids = ${p.poids}, longueur = ${p.longueur}, laize = ${p.laize}
        WHERE idpiece_echantillon = ${pieceId} AND idref_echantillon = ${row.idref_echantillon}
        RETURNING idpiece_echantillon`
      if (updated.length === 0) { res.status(404).json({ error: 'Pièce introuvable' }); return }
      res.json({ ok: true })
    } catch (err) {
      console.error('Error updating piece_echantillon:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  router.delete('/:id/pieces/:pieceId', async (req, res) => {
    try {
      const pieceId = parseInt(req.params.pieceId, 10)
      const row = await charger(req, res, { ouvert: true })
      if (!row) return
      const deleted = await mpsPg()`
        DELETE FROM piece_echantillon WHERE idpiece_echantillon = ${pieceId} AND idref_echantillon = ${row.idref_echantillon}
        RETURNING idpiece_echantillon`
      if (deleted.length === 0) { res.status(404).json({ error: 'Pièce introuvable' }); return }
      res.json({ ok: true })
    } catch (err) {
      console.error('Error deleting piece_echantillon:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /:id/relances — « Relancé » : the follow-up was done (who, a note),
  // the next one moves to `prochaine_relance` (default today + 30). Open
  // samples only; the journal is append-only.
  router.post('/:id/relances', async (req, res) => {
    try {
      const parsed = relanceBody.safeParse(req.body)
      if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
      const row = await charger(req, res, { ouvert: true })
      if (!row) return
      const prochaine = parsed.data.prochaine_relance ?? ajouterJours(aujourdhuiParis(), DELAI_RELANCE_JOURS)
      const sql = mpsPg()
      const [u] = await sql<{ prenom: string | null; nom: string | null }[]>`
        SELECT prenom, nom FROM utilisateur WHERE idutilisateur = ${req.userId!}`
      const auteur = [u?.prenom, u?.nom].map((x) => (x ?? '').trim()).filter(Boolean).join(' ') || `#${req.userId}`
      await sql.begin(async (t) => {
        const tx = t as unknown as Sql
        await tx`
          INSERT INTO echantillon_relance (idref_echantillon, idutilisateur, auteur, note, prochaine_relance)
          VALUES (${row.idref_echantillon}, ${req.userId!}, ${auteur}, ${parsed.data.note.trim()}, ${prochaine})`
        await tx`UPDATE ref_echantillon SET date_relance = ${prochaine} WHERE idref_echantillon = ${row.idref_echantillon}`
      })
      res.status(201).json({ ok: true, date_relance: prochaine })
    } catch (err) {
      console.error('Error recording échantillon relance:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /:id/archiver · POST /:id/rouvrir — the status pill (§29.3). A
  // sample at its industrial trial is abandoned WITH its provisional
  // reference (archived together, reopened together): the reference only
  // exists for the trial.
  router.post('/:id/archiver', async (req, res) => {
    try {
      const row = await charger(req, res, { ouvert: true })
      if (!row) return
      await mpsPg().begin(async (t) => {
        const tx = t as unknown as Sql
        await tx`UPDATE ref_echantillon SET archive = 1 WHERE idref_echantillon = ${row.idref_echantillon}`
        if (ficheSurReference(row)) {
          await tx`UPDATE ref_ecru SET archive = 1 WHERE idref_ecru = ${Number(row.idref_ecru)} AND essai = 1`
        }
      })
      res.json({ ok: true })
    } catch (err) {
      console.error('Error archiving échantillon:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  router.post('/:id/rouvrir', async (req, res) => {
    try {
      const row = await charger(req, res)
      if (!row) return
      // A sample that became a reference stays closed: the reference is
      // where its life goes on.
      if (statutEchantillon(row) === 'reference') {
        res.status(409).json({ error: 'deja_reference', message: `L'échantillon est devenu la référence ${row.ref_reference?.trim() ?? ''} : il ne peut pas être rouvert.` })
        return
      }
      // Back in the follow-up: a fresh relance date, never an old one already red.
      await mpsPg().begin(async (t) => {
        const tx = t as unknown as Sql
        await tx`UPDATE ref_echantillon SET archive = 0, date_relance = ${ajouterJours(aujourdhuiParis(), DELAI_RELANCE_JOURS)} WHERE idref_echantillon = ${row.idref_echantillon}`
        if (ficheSurReference(row)) {
          await tx`UPDATE ref_ecru SET archive = 0 WHERE idref_ecru = ${Number(row.idref_ecru)} AND essai = 1`
        }
      })
      res.json({ ok: true })
    } catch (err) {
      console.error('Error reopening échantillon:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /:id/essai-industriel — the sample goes to its industrial trial: it
  // creates its PROVISIONAL reference, named like the sample (« E055 », never a
  // free name: the hand-typed « ech 55 » twins linked to nothing are what this
  // replaces, LIVA #1370) and flagged `essai`. From here the knitting order,
  // the OF, the stock and the dyer order run on that reference like on any
  // other, and the technical sheet lives there. The sample stays open.
  router.post('/:id/essai-industriel', async (req, res) => {
    try {
      const parsed = essaiIndustrielBody.safeParse(req.body)
      if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
      const id = parseInt(req.params.id, 10)
      if (!(id > 0)) { res.status(400).json({ error: 'Invalid ID' }); return }
      const reference = numeroEchantillon(id)

      const idRef = await mpsPg().begin(async (t) => {
        const tx = t as unknown as Sql
        const e = await verrouiller(tx, id)
        const compo = await compositionEchantillon(tx, id)
        const refus = refusEssaiIndustriel(e, compo.map((c) => fractionVersPourcent(c.pourcentage)))
        if (refus === 'deja_reference') throw new RefusError(refus, "L'échantillon est déjà devenu une référence.")
        if (refus === 'deja_essai') throw new RefusError(refus, "L'échantillon est déjà à l'essai industriel.")
        if (refus === 'archive') throw new RefusError(refus, "L'échantillon est archivé : rouvrez-le d'abord.")
        if (refus === 'composition_incomplete') throw new RefusError(refus, "La composition de l'échantillon doit totaliser 100 % avant de lancer l'essai industriel.")
        await refuserDoublon(tx, reference, 0)
        const idNew = await insererReference(tx, e, compo, reference, parsed.data.designation, 1)
        await tx`UPDATE ref_echantillon SET idref_ecru = ${idNew} WHERE idref_echantillon = ${id}`
        return idNew
      })
      res.status(201).json({ IDref_ecru: idRef, reference })
    } catch (err) {
      if (err instanceof RefusError) { res.status(err.status).json({ error: err.code, message: err.message }); return }
      console.error('Error starting the industrial trial of an échantillon:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /:id/reference-proposee[?reference=104] — what « Retenu » proposes:
  // the next free number (editable), and for a sample at its industrial trial
  // the provisional reference's designation and the finis that would be
  // renamed with it for the reference typed so far.
  router.get('/:id/reference-proposee', async (req, res) => {
    try {
      const row = await charger(req, res)
      if (!row) return
      const sql = mpsPg()
      const proposee = await prochaineReference(sql)
      const essai = ficheSurReference(row)
      const cible = typeof req.query.reference === 'string' && req.query.reference.trim() ? req.query.reference.trim() : proposee
      const ancienne = row.ref_reference?.trim() ?? ''
      const finis = essai ? await loadFinisEssai(sql, Number(row.idref_ecru)) : []
      res.json({
        reference: proposee,
        designation: essai ? row.ref_designation?.trim() ?? '' : '',
        finis: finis.map((f) => ({ ...f, proposee: nomFiniRetenu(ancienne, cible, f.reference) })),
        peut_renommer_finis: req.userId !== undefined && (await scope.peutRenommerFini(req.userId, isEffectiveAdmin(req))),
      })
    } catch (err) {
      console.error('Error proposing a reference number:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /:id/creer-reference — « Retenu »: the sample becomes a running
  // reference, once, and is closed.
  //   • from its industrial trial: the provisional reference is RENAMED and
  //     loses its flag — same row, so its pieces, OFs, orders and lots follow
  //     with nothing to convert; the sheet retained is written back onto the
  //     sample as a snapshot; the trial's finis ticked are renamed with it.
  //   • straight from the laboratory (no industrial trial): a new ref_ecru
  //     takes what the sample knows (contexture, jauge, Ø, client, LFA, laize +
  //     poids TBM, composition — the washed measures stay on the sample).
  router.post('/:id/creer-reference', async (req, res) => {
    try {
      const parsed = creerReferenceBody.safeParse(req.body)
      if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
      const id = parseInt(req.params.id, 10)
      if (!(id > 0)) { res.status(400).json({ error: 'Invalid ID' }); return }
      const { reference, designation } = parsed.data
      const aRenommer = parsed.data.renommer_finis ?? []
      if (aRenommer.length > 0 && !(req.userId !== undefined && (await scope.peutRenommerFini(req.userId, isEffectiveAdmin(req))))) {
        res.status(403).json({ error: 'permission denied: edit_ref_fini', message: 'Vous ne pouvez pas renommer les références finies : décochez-les, elles se renomment sur Finis › Références.' })
        return
      }

      // The fini names are checked and written under the lock every writer of
      // ref_fini.reference takes (lib/ref-fini-reference.ts).
      const idRef = await refFiniReferenceLock.run(() => mpsPg().begin(async (t) => {
        const tx = t as unknown as Sql
        // Row lock: two clicks (or two users) cannot both create a reference.
        const e = await verrouiller(tx, id)

        if (ficheSurReference(e)) {
          const idEcru = Number(e.idref_ecru)
          const [ref] = await tx<RefEssaiRow[]>`
            SELECT reference, idcontexture, jauge, diametre, lfa_tour_1, lfa_tour_2, lfa_tour_3, lfa_tour_4, laize_tbm, poids_m2_tbm
              FROM ref_ecru WHERE idref_ecru = ${idEcru} FOR UPDATE`
          if (!ref) throw new RefusError('introuvable', 'La référence provisoire a disparu.', 404)
          const compoRef = await tx<{ idref_fil: number; idcolori_fil: number; pourcentage: number | null }[]>`
            SELECT idref_fil, idcolori_fil, pourcentage FROM composition_ecru
             WHERE idref_ecru = ${idEcru} AND (idcolori_ecru = 0 OR idcolori_ecru IS NULL) ORDER BY idcomposition_ecru`
          const refus = refusCreationReference(e, compoRef.map((c) => Number(c.pourcentage) || 0))
          if (refus === 'archive') throw new RefusError(refus, "L'échantillon est archivé : rouvrez-le d'abord.")
          if (refus === 'composition_incomplete') throw new RefusError(refus, `La composition de la référence ${String(ref.reference ?? '').trim()} doit totaliser 100 % avant de la retenir.`)
          await refuserDoublon(tx, reference, idEcru)

          // The trial's finis ticked: « E055A » → « 104A ».
          const ancienne = String(ref.reference ?? '').trim()
          if (aRenommer.length > 0) {
            const finis = await tx<FiniEssaiRow[]>`
              SELECT idref_fini, reference, designation, archive FROM ref_fini WHERE idref_ecru = ${idEcru} AND idref_fini = ANY(${aRenommer})`
            for (const f of finis) {
              const nouveau = nomFiniRetenu(ancienne, reference, String(f.reference ?? ''))
              if (!nouveau) continue
              if (await refFiniReferenceTaken(nouveau, Number(f.idref_fini))) {
                throw new RefusError('fini_existant', `La référence finie ${nouveau} existe déjà : renommez ${String(f.reference ?? '').trim()} sur Finis › Références.`)
              }
              await tx`UPDATE ref_fini SET reference = ${nouveau} WHERE idref_fini = ${Number(f.idref_fini)}`
            }
          }

          if (designation) {
            await tx`UPDATE ref_ecru SET reference = ${reference}, designation = ${designation}, essai = 0, date_maj_ft = CURRENT_DATE WHERE idref_ecru = ${idEcru}`
          } else {
            await tx`UPDATE ref_ecru SET reference = ${reference}, essai = 0, date_maj_ft = CURRENT_DATE WHERE idref_ecru = ${idEcru}`
          }
          // Snapshot: what was retained, frozen on the closed sample.
          await tx`
            UPDATE ref_echantillon SET
              idcontexture = ${Number(ref.idcontexture) || 0},
              jauge = ${ordinalValide(ref.jauge, JAUGE_ORD_MAX)}, diametre = ${ordinalValide(ref.diametre, DIAMETRE_ORD_MAX)},
              lfa1 = ${lfaNombre(ref.lfa_tour_1)}, lfa2 = ${lfaNombre(ref.lfa_tour_2)},
              lfa3 = ${lfaNombre(ref.lfa_tour_3)}, lfa4 = ${lfaNombre(ref.lfa_tour_4)},
              laize_tbm = ${Number(ref.laize_tbm) || 0}, poids_m2_tbm = ${Number(ref.poids_m2_tbm) || 0},
              archive = 1
            WHERE idref_echantillon = ${id}`
          await tx`DELETE FROM fil_ref_echantillon WHERE idref_echantillon = ${id}`
          for (const c of compoRef) {
            await tx`
              INSERT INTO fil_ref_echantillon (idref_echantillon, idref_fil, idcolori_fil, pourcentage)
              VALUES (${id}, ${Number(c.idref_fil) || 0}, ${Number(c.idcolori_fil) || 0}, ${pourcentVersFraction(Number(c.pourcentage) || 0)})`
          }
          return idEcru
        }

        const compo = await compositionEchantillon(tx, id)
        const refus = refusCreationReference(e, compo.map((c) => fractionVersPourcent(c.pourcentage)))
        if (refus === 'deja_reference') throw new RefusError(refus, "L'échantillon est déjà devenu une référence.")
        if (refus === 'archive') throw new RefusError(refus, "L'échantillon est archivé : rouvrez-le d'abord.")
        if (refus === 'composition_incomplete') throw new RefusError(refus, 'La composition de l\'échantillon doit totaliser 100 % avant de créer la référence.')
        await refuserDoublon(tx, reference, 0)
        const idNew = await insererReference(tx, e, compo, reference, designation, 0)
        await tx`UPDATE ref_echantillon SET idref_ecru = ${idNew}, archive = 1 WHERE idref_echantillon = ${id}`
        return idNew
      }))
      res.status(201).json({ IDref_ecru: idRef })
    } catch (err) {
      if (err instanceof RefusError) { res.status(err.status).json({ error: err.code, message: err.message }); return }
      console.error('Error creating ref_ecru from échantillon:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  return router
}

class RefusError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message) }
}

interface RefEssaiRow {
  reference: string | null
  idcontexture: number | null
  jauge: number | null
  diametre: number | null
  lfa_tour_1: string | null
  lfa_tour_2: string | null
  lfa_tour_3: string | null
  lfa_tour_4: string | null
  laize_tbm: number | null
  poids_m2_tbm: number | null
}

type LigneCompo = { idref_fil: number; idcolori_fil: number; pourcentage: number | null }

/** The sample, row-locked, with its linked reference's flag. 404 when gone. */
async function verrouiller(tx: Sql, id: number): Promise<EchantillonRow> {
  const [e] = await tx<EchantillonRow[]>`
    SELECT idref_echantillon, idcontexture, jauge, diametre, lfa1, lfa2, lfa3, lfa4,
           laize_tbm, poids_m2_tbm, commentaire, idclient, archive, idref_ecru
      FROM ref_echantillon WHERE idref_echantillon = ${id} FOR UPDATE`
  if (!e) throw new RefusError('introuvable', 'Échantillon introuvable', 404)
  if ((Number(e.idref_ecru) || 0) > 0) {
    const [r] = await tx<{ essai: number | null }[]>`SELECT essai FROM ref_ecru WHERE idref_ecru = ${Number(e.idref_ecru)}`
    e.ref_essai = r ? Number(r.essai) || 0 : 0
  }
  return e
}

/** The sample's own composition (fractions 0..1), in entry order. */
async function compositionEchantillon(tx: Sql, id: number): Promise<LigneCompo[]> {
  return tx<LigneCompo[]>`
    SELECT idref_fil, idcolori_fil, pourcentage FROM fil_ref_echantillon
     WHERE idref_echantillon = ${id} ORDER BY idfil_ref_echantillon`
}

/** ref_ecru.reference is citext: = ignores case; trim for trailing spaces. */
async function refuserDoublon(tx: Sql, reference: string, saufId: number): Promise<void> {
  const [dup] = await tx`SELECT 1 FROM ref_ecru WHERE TRIM(reference) = ${reference} AND idref_ecru <> ${saufId} LIMIT 1`
  if (dup) throw new RefusError('reference_existante', `La référence ${reference} existe déjà.`)
}

/** A new ref_ecru from what the sample knows; `essai` = 1 for the provisional
 *  reference of an industrial trial. The rest of the fiche is filled on
 *  Références. Returns its id. */
async function insererReference(tx: Sql, e: EchantillonRow, compo: LigneCompo[], reference: string, designation: string, essai: 0 | 1): Promise<number> {
  const [ref] = await tx<{ idref_ecru: number }[]>`
    INSERT INTO ref_ecru (reference, designation, idclient, idcontexture, jauge, diametre,
                          lfa_tour_1, lfa_tour_2, lfa_tour_3, lfa_tour_4, laize_tbm, poids_m2_tbm,
                          commentaire, date_maj_ft, essai)
    VALUES (${reference}, ${designation}, ${Number(e.idclient) || 0}, ${Number(e.idcontexture) || 0},
            ${ordinalValide(e.jauge, JAUGE_ORD_MAX)}, ${ordinalValide(e.diametre, DIAMETRE_ORD_MAX)},
            ${lfaTexte(e.lfa1)}, ${lfaTexte(e.lfa2)}, ${lfaTexte(e.lfa3)}, ${lfaTexte(e.lfa4)},
            ${Math.round(Number(e.laize_tbm) || 0)}, ${Math.round(Number(e.poids_m2_tbm) || 0)},
            '', CURRENT_DATE, ${essai})
    RETURNING idref_ecru`
  // #1290 caution: nothing may hang off the new id.
  await tx`DELETE FROM composition_ecru WHERE idref_ecru = ${ref.idref_ecru}`
  for (const c of compo) {
    // The reference's own recipe (idcolori_ecru = 0), in percent.
    await tx`
      INSERT INTO composition_ecru (idref_ecru, idcolori_ecru, idref_fil, idcolori_fil, pourcentage, commentaire)
      VALUES (${ref.idref_ecru}, 0, ${c.idref_fil}, ${Number(c.idcolori_fil) || 0}, ${fractionVersPourcent(c.pourcentage)}, '')`
  }
  return ref.idref_ecru
}

async function prochaineReference(sql: Sql): Promise<string> {
  const rows = await sql<{ reference: string | null }[]>`SELECT reference FROM ref_ecru`
  return nextRefNumber(rows.map((r) => r.reference ?? ''))
}

export const echantillonsRouter = createEchantillonsRouter(ECHANTILLONS_SCOPE_ETM)
export const echantillonsTrmRouter = createEchantillonsRouter(ECHANTILLONS_SCOPE_TRM)
