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
import { userCanOpenScreen } from '../lib/permissions.js'
import { trmUserCanOpenScreen } from '../lib/permissions-trm.js'
import { resolveMachineLabels } from '../lib/production-trm.js'
import { nextRefNumber } from './references-ecru.js'
import React from 'react'
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer'
import { EtiquetteEchantillonPdf, type EtiquetteEchantillonData } from '../lib/pdf/EtiquetteEchantillonPdf.js'
import {
  DIAMETRE_ORD_MAX,
  JAUGE_ORD_MAX,
  compositionComplete,
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
}

export const ECHANTILLONS_SCOPE_ETM: EchantillonsScope = {
  canOpen: (userId, admin) => userCanOpenScreen(userId, admin, MENU, ECRAN),
  societeClients: 1,
}
export const ECHANTILLONS_SCOPE_TRM: EchantillonsScope = {
  canOpen: (userId, admin) => trmUserCanOpenScreen(userId, admin, MENU, ECRAN),
  societeClients: 2,
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
  commentaire: string | null
  idclient: number | null
  archive: number | null
  idref_ecru: number | null
  contexture_nom: string | null
  client_nom: string | null
  ref_reference: string | null
  ref_designation: string | null
}

const SELECT_ECHANTILLON = (sql: Sql) => sql`
  SELECT e.idref_echantillon, e.idcontexture, e.jauge, e.diametre, e.lfa1, e.lfa2, e.lfa3, e.lfa4,
         e.commentaire, e.idclient, e.archive, e.idref_ecru,
         c.nom AS contexture_nom, cl.nom AS client_nom,
         r.reference AS ref_reference, r.designation AS ref_designation
    FROM ref_echantillon e
    LEFT JOIN contexture c ON c.idcontexture = e.idcontexture AND e.idcontexture > 0
    LEFT JOIN client cl ON cl.idclient = e.idclient AND e.idclient > 0
    LEFT JOIN ref_ecru r ON r.idref_ecru = e.idref_ecru AND e.idref_ecru > 0`

function shape(e: EchantillonRow) {
  return {
    IDref_echantillon: e.idref_echantillon,
    numero: numeroEchantillon(e.idref_echantillon),
    statut: statutEchantillon(e),
    IDcontexture: Number(e.idcontexture) || 0,
    contexture_nom: e.contexture_nom?.trim() || null,
    Jauge: ordinalValide(e.jauge, JAUGE_ORD_MAX),
    diametre: ordinalValide(e.diametre, DIAMETRE_ORD_MAX),
    lfa: [e.lfa1, e.lfa2, e.lfa3, e.lfa4].map((v) => Number(v) || 0),
    commentaire: e.commentaire ?? '',
    IDclient: Number(e.idclient) || 0,
    client_nom: e.client_nom?.trim() || null,
    reference: (Number(e.idref_ecru) || 0) > 0
      ? { IDref_ecru: Number(e.idref_ecru), reference: e.ref_reference?.trim() ?? '', designation: e.ref_designation?.trim() ?? '' }
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

async function loadComposition(sql: Sql, id: number) {
  const rows = await sql<CompoRow[]>`
    SELECT f.idfil_ref_echantillon, f.idref_fil, f.idcolori_fil, f.pourcentage,
           rf.reference AS ref_fil_reference, cf.reference AS colori_fil_reference
      FROM fil_ref_echantillon f
      LEFT JOIN ref_fil rf ON rf.idref_fil = f.idref_fil
      LEFT JOIN colori_fil cf ON cf.idcolori_fil = f.idcolori_fil AND f.idcolori_fil > 0
     WHERE f.idref_echantillon = ${id}
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

/** The Dymo tag's fields (lib/pdf/EtiquetteEchantillonPdf.tsx). */
export async function buildEtiquetteEchantillonData(id: number): Promise<EtiquetteEchantillonData | null> {
  const sql = mpsPg()
  const row = await loadEchantillon(sql, id)
  if (!row) return null
  const compo = await loadComposition(sql, id)
  return {
    IDref_echantillon: id,
    numero: numeroEchantillon(id),
    contexture: row.contexture_nom?.trim() || null,
    jauge: jaugeLibelle(ordinalValide(row.jauge, JAUGE_ORD_MAX)),
    diametre: diametreLibelle(ordinalValide(row.diametre, DIAMETRE_ORD_MAX)),
    lfa: [row.lfa1, row.lfa2, row.lfa3, row.lfa4].map((v) => Number(v) || 0),
    composition: compo.map((c) => ({ pourcentage: c.pourcentage, fil: c.ref_fil_reference ?? '' })),
  }
}

// ── Bodies ──────────────────────────────────────────────

const enteteBody = z.object({
  IDcontexture: z.number().int().min(0),
  Jauge: z.number().int().min(0).max(JAUGE_ORD_MAX),
  diametre: z.number().int().min(0).max(DIAMETRE_ORD_MAX),
  lfa: z.array(z.number().min(0)).length(4),
  commentaire: z.string().max(4000),
  IDclient: z.number().int().min(0),
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
})

const STATUTS: readonly StatutEchantillon[] = ['en_cours', 'reference', 'archive']

const MSG_CLOS = "L'échantillon n'est plus en cours : rouvrez-le pour le modifier."

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
   *  sample that is no longer en cours. */
  async function charger(req: Request, res: Response, opts: { ouvert?: boolean } = {}) {
    const id = parseInt(req.params.id, 10)
    if (!(id > 0)) { res.status(400).json({ error: 'Invalid ID' }); return null }
    const row = await loadEchantillon(mpsPg(), id)
    if (!row) { res.status(404).json({ error: 'Échantillon introuvable' }); return null }
    if (opts.ouvert && statutEchantillon(row) !== 'en_cours') {
      res.status(409).json({ error: 'echantillon_clos', message: MSG_CLOS })
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
      const statut = STATUTS.includes(req.query.statut as StatutEchantillon) ? (req.query.statut as StatutEchantillon) : 'en_cours'
      const sql = mpsPg()
      const rows = await sql<EchantillonRow[]>`${SELECT_ECHANTILLON(sql)} ORDER BY e.idref_echantillon DESC`
      const pieces = await sql<{ idref_echantillon: number; n: number }[]>`
        SELECT idref_echantillon, COUNT(*)::int AS n FROM piece_echantillon GROUP BY idref_echantillon`
      const nbPieces = new Map(pieces.map((p) => [Number(p.idref_echantillon), p.n]))
      res.json(rows
        .filter((r) => statutEchantillon(r) === statut)
        .map((r) => ({ ...shape(r), pieces_count: nbPieces.get(r.idref_echantillon) ?? 0 })))
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
      res.json({
        ...shape(row),
        composition: await loadComposition(sql, row.idref_echantillon),
        pieces: await loadPieces(sql, row.idref_echantillon),
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
          INSERT INTO ref_echantillon (idcontexture, jauge, diametre, lfa1, lfa2, lfa3, lfa4, commentaire, idclient, archive, idref_ecru)
          VALUES (0, 0, 0, 0, 0, 0, 0, '', 0, 0, 0)
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
      await mpsPg()`
        UPDATE ref_echantillon SET
          idcontexture = ${b.IDcontexture}, jauge = ${b.Jauge}, diametre = ${b.diametre},
          lfa1 = ${b.lfa[0]}, lfa2 = ${b.lfa[1]}, lfa3 = ${b.lfa[2]}, lfa4 = ${b.lfa[3]},
          commentaire = ${b.commentaire}, idclient = ${b.IDclient}
        WHERE idref_echantillon = ${row.idref_echantillon}`
      res.json({ ok: true })
    } catch (err) {
      console.error('Error updating échantillon:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // DELETE /:id — only a sample still en cours with no trial piece: one that
  // was knitted is history, it gets archived instead.
  router.delete('/:id', async (req, res) => {
    try {
      const row = await charger(req, res, { ouvert: true })
      if (!row) return
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
      const row = await charger(req, res, { ouvert: true })
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
      res.json({ composition: await loadComposition(mpsPg(), id) })
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

  // POST /:id/archiver · POST /:id/rouvrir — the status pill (§29.3)
  router.post('/:id/archiver', async (req, res) => {
    try {
      const row = await charger(req, res, { ouvert: true })
      if (!row) return
      await mpsPg()`UPDATE ref_echantillon SET archive = 1 WHERE idref_echantillon = ${row.idref_echantillon}`
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
      await mpsPg()`UPDATE ref_echantillon SET archive = 0 WHERE idref_echantillon = ${row.idref_echantillon}`
      res.json({ ok: true })
    } catch (err) {
      console.error('Error reopening échantillon:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /:id/reference-proposee — the number the dialog suggests (editable)
  router.get('/:id/reference-proposee', async (req, res) => {
    try {
      const row = await charger(req, res)
      if (!row) return
      res.json({ reference: await prochaineReference(mpsPg()) })
    } catch (err) {
      console.error('Error proposing a reference number:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /:id/creer-reference — the sample becomes a ref_ecru: what it knows
  // is copied (contexture, jauge, Ø, client, LFA, composition), the rest of the
  // fiche is filled on Références; then the sample is closed and linked. Once.
  router.post('/:id/creer-reference', async (req, res) => {
    try {
      const parsed = creerReferenceBody.safeParse(req.body)
      if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
      const id = parseInt(req.params.id, 10)
      if (!(id > 0)) { res.status(400).json({ error: 'Invalid ID' }); return }
      const { reference, designation } = parsed.data

      const idRef = await mpsPg().begin(async (t) => {
        const tx = t as unknown as Sql
        // Row lock: two clicks (or two users) cannot both create a reference.
        const [e] = await tx<EchantillonRow[]>`
          SELECT idref_echantillon, idcontexture, jauge, diametre, lfa1, lfa2, lfa3, lfa4,
                 commentaire, idclient, archive, idref_ecru
            FROM ref_echantillon WHERE idref_echantillon = ${id} FOR UPDATE`
        if (!e) throw new RefusError('introuvable', 'Échantillon introuvable', 404)
        const compo = await tx<{ idref_fil: number; idcolori_fil: number; pourcentage: number | null }[]>`
          SELECT idref_fil, idcolori_fil, pourcentage FROM fil_ref_echantillon
           WHERE idref_echantillon = ${id} ORDER BY idfil_ref_echantillon`
        const refus = refusCreationReference(e, compo.map((c) => fractionVersPourcent(c.pourcentage)))
        if (refus === 'deja_reference') throw new RefusError(refus, "L'échantillon est déjà devenu une référence.")
        if (refus === 'archive') throw new RefusError(refus, "L'échantillon est archivé : rouvrez-le d'abord.")
        if (refus === 'composition_incomplete') throw new RefusError(refus, 'La composition de l\'échantillon doit totaliser 100 % avant de créer la référence.')

        // ref_ecru.reference is citext: = ignores case; trim for trailing spaces.
        const [dup] = await tx`SELECT 1 FROM ref_ecru WHERE TRIM(reference) = ${reference} LIMIT 1`
        if (dup) throw new RefusError('reference_existante', `La référence ${reference} existe déjà.`)

        const [ref] = await tx<{ idref_ecru: number }[]>`
          INSERT INTO ref_ecru (reference, designation, idclient, idcontexture, jauge, diametre,
                                lfa_tour_1, lfa_tour_2, lfa_tour_3, lfa_tour_4, commentaire, date_maj_ft)
          VALUES (${reference}, ${designation}, ${Number(e.idclient) || 0}, ${Number(e.idcontexture) || 0},
                  ${ordinalValide(e.jauge, JAUGE_ORD_MAX)}, ${ordinalValide(e.diametre, DIAMETRE_ORD_MAX)},
                  ${lfaTexte(e.lfa1)}, ${lfaTexte(e.lfa2)}, ${lfaTexte(e.lfa3)}, ${lfaTexte(e.lfa4)},
                  '', CURRENT_DATE)
          RETURNING idref_ecru`
        // Same #1290 caution as a new sample: nothing may hang off the new id.
        await tx`DELETE FROM composition_ecru WHERE idref_ecru = ${ref.idref_ecru}`
        for (const c of compo) {
          // The reference's own recipe (idcolori_ecru = 0), in percent.
          await tx`
            INSERT INTO composition_ecru (idref_ecru, idcolori_ecru, idref_fil, idcolori_fil, pourcentage, commentaire)
            VALUES (${ref.idref_ecru}, 0, ${c.idref_fil}, ${Number(c.idcolori_fil) || 0}, ${fractionVersPourcent(c.pourcentage)}, '')`
        }
        await tx`UPDATE ref_echantillon SET idref_ecru = ${ref.idref_ecru}, archive = 1 WHERE idref_echantillon = ${id}`
        return ref.idref_ecru
      })
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

async function prochaineReference(sql: Sql): Promise<string> {
  const rows = await sql<{ reference: string | null }[]>`SELECT reference FROM ref_ecru`
  return nextRefNumber(rows.map((r) => r.reference ?? ''))
}

export const echantillonsRouter = createEchantillonsRouter(ECHANTILLONS_SCOPE_ETM)
export const echantillonsTrmRouter = createEchantillonsRouter(ECHANTILLONS_SCOPE_TRM)
