// TRM menu « Fournitures » + the Aiguilles tab of Atelier › Maintenance
// (LIVA #1263, Nicolas + Vincent, 2026-10-07). Every material that is not
// yarn — aiguilles and platines for now (types are rows, not code). Replaces
// Nicolas's Google sheet « Stock aiguille ».
//
// Native PostgreSQL, migration 0012_fournitures_trm (lib/mps-schema.ts — the
// header there describes every table). The pure stock rules live in
// lib/fournitures-trm.ts.
//
// Two write rights:
//  - edit_fournitures — the catalogue, stock entries and counts, suppliers
//    (Fournitures › Références / Stock / Gestion);
//  - edit_maintenance — what is on a métier: its references, the quantity a
//    montage takes, and the set change itself (which takes stock out).
// Reads are open to any signed-in TRM screen, like Atelier › Maintenance.
//
// ⚠️ A métier runs ALL its references at once (cylindre / plateau lengths ×
// butt positions). A « set change » (POST /metiers/:id/montages) replaces one
// or several of them at once, each with the constructeur put on, and takes
// the quantities out of stock right then (Nicolas, 2026-10-07).

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import type { Sql } from 'postgres'
import { z } from 'zod'
import { mpsPg } from '../lib/mps-pg.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { trmUserHasPermission } from '../lib/permissions-trm.js'
import {
  commandesParAnnee,
  correctionInventaire,
  normaliserLibelle,
  repartirSortie,
  type Seau,
} from '../lib/fournitures-trm.js'
import { machineEcrivable, pgDate, requireEditMaintenance, todayHf } from './maintenance-trm.js'

export const fournituresTrmRouter: RouterType = Router()

type Row = Record<string, unknown>
type Tx = Sql

const text = (v: unknown): string | null => {
  const s = String(v ?? '').trim()
  return s === '' ? null : s
}

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

function fail(res: Response, err: unknown, where: string) {
  if (err instanceof Refus) {
    res.status(err.status).json({ error: err.code, message: err.message })
    return
  }
  console.error(`${where} failed:`, err)
  res.status(500).json({ error: 'Internal server error' })
}

/** A business refusal thrown from inside a transaction. */
class Refus extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function requireEditFournitures(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  if (!(await trmUserHasPermission(req.userId, isEffectiveAdmin(req), 'edit_fournitures'))) {
    res.status(403).json({ error: 'permission denied: edit_fournitures' })
    return false
  }
  return true
}


// ════════════════════════════════════════════════════════
//  GET /catalogue — everything the three screens and the tab read (~60 articles)
// ════════════════════════════════════════════════════════

async function catalogue(sql: Sql, avecArchives = false) {
  const [types, constructeurs, fournisseurs, fournTypes, articles, accept, liens, stock, entrees, derniers] =
    await Promise.all([
      sql<Row[]>`SELECT idfourniture_type, nom, avec_position FROM trm_fourniture_type ORDER BY rang, nom`,
      sql<Row[]>`SELECT idfourniture_constructeur, nom FROM trm_fourniture_constructeur ORDER BY lower(nom)`,
      sql<Row[]>`SELECT idfourniture_fournisseur, nom FROM trm_fourniture_fournisseur WHERE NOT archive ORDER BY lower(nom)`,
      sql<Row[]>`SELECT idfourniture_fournisseur, idfourniture_type FROM trm_fourniture_fournisseur_type`,
      avecArchives
        ? sql<Row[]>`SELECT * FROM trm_fourniture_article`
        : sql<Row[]>`SELECT * FROM trm_fourniture_article WHERE NOT archive`,
      sql<Row[]>`SELECT idfourniture_article, idfourniture_constructeur FROM trm_fourniture_article_constructeur`,
      sql<Row[]>`
        SELECT a.idmachine, a.idfourniture_article, a.rang, a.quantite, a.idfourniture_constructeur,
               to_char(a.date_montage, 'YYYYMMDD') AS date_montage,
               COALESCE(NULLIF(trim(m.emplacement::text), ''), m.nom::text) AS metier
        FROM trm_fourniture_article_metier a JOIN machine m ON m.idmachine = a.idmachine
        WHERE COALESCE(m.archive, 0) <> 1`,
      sql<Row[]>`
        SELECT idfourniture_article, idfourniture_constructeur, SUM(quantite)::int AS stock
        FROM trm_fourniture_mouvement GROUP BY 1, 2`,
      sql<Row[]>`
        SELECT idfourniture_article, idfourniture_constructeur,
               to_char(date_mouvement, 'YYYY-MM-DD') AS date, quantite
        FROM trm_fourniture_mouvement WHERE type = 'entree'`,
      sql<Row[]>`
        SELECT idfourniture_article, idfourniture_constructeur, to_char(MAX(date_mouvement), 'YYYYMMDD') AS d
        FROM trm_fourniture_mouvement GROUP BY 1, 2`,
    ])

  const nomC = new Map(constructeurs.map((c) => [Number(c.idfourniture_constructeur), String(c.nom)]))
  const constructeur = (id: unknown) => {
    const n = Number(id)
    return n > 0 && nomC.has(n) ? { id: n, nom: nomC.get(n)! } : null
  }
  const nomType = new Map(types.map((t) => [Number(t.idfourniture_type), String(t.nom)]))
  const group = <T>(rows: Row[], key: string, map: (r: Row) => T) => {
    const out = new Map<number, T[]>()
    for (const r of rows) {
      const k = Number(r[key])
      if (!out.has(k)) out.set(k, [])
      out.get(k)!.push(map(r))
    }
    return out
  }
  const acceptParArticle = group(accept, 'idfourniture_article', (r) => constructeur(r.idfourniture_constructeur))
  const liensParArticle = group(liens, 'idfourniture_article', (r) => ({
    id: Number(r.idmachine),
    emplacement: String(r.metier ?? ''),
    rang: Number(r.rang) || 0,
    quantite: r.quantite == null ? null : Number(r.quantite),
    monte: constructeur(r.idfourniture_constructeur),
    dateMontage: text(r.date_montage),
  }))
  const stockParArticle = group(stock, 'idfourniture_article', (r) => ({
    idC: Number(r.idfourniture_constructeur) || null,
    stock: Number(r.stock) || 0,
  }))
  const entreesParArticle = group(entrees, 'idfourniture_article', (r) => ({
    idC: Number(r.idfourniture_constructeur) || null,
    type: 'entree',
    date: String(r.date),
    quantite: Number(r.quantite) || 0,
  }))
  const derniersParArticle = group(derniers, 'idfourniture_article', (r) => ({
    idC: Number(r.idfourniture_constructeur) || null,
    d: text(r.d),
  }))
  const maxDate = (ds: (string | null)[]) => ds.reduce<string | null>((m, d) => (d && (!m || d > m) ? d : m), null)

  // The stock buckets of an article — one line of Fournitures › Stock each
  // (Nicolas, 2026-10-07: a stock line is a reference × a constructeur):
  // every accepted constructeur and every constructeur that ever moved, even
  // at 0, plus « non précisé » (null) while it holds something, or as the
  // only line of an article with nothing else.
  const seauxDe = (id: number, acceptes: number[]) => {
    const st = stockParArticle.get(id) ?? []
    const en = entreesParArticle.get(id) ?? []
    const de = derniersParArticle.get(id) ?? []
    const ids = new Set<number>([...acceptes, ...st.map((x) => x.idC ?? 0), ...de.map((x) => x.idC ?? 0)])
    ids.delete(0)
    const seau = (idC: number | null) => ({
      constructeur: idC === null ? null : constructeur(idC),
      stock: st.filter((x) => x.idC === idC).reduce((n, x) => n + x.stock, 0),
      commandesParAnnee: commandesParAnnee(en.filter((x) => x.idC === idC)),
      dernierMouvement: maxDate(de.filter((x) => x.idC === idC).map((x) => x.d)),
    })
    const out = [...ids].map(seau).filter((x) => x.constructeur !== null)
    out.sort((x, y) => x.constructeur!.nom.localeCompare(y.constructeur!.nom, 'fr'))
    const nonVentile = seau(null)
    if (nonVentile.stock !== 0 || out.length === 0) out.push(nonVentile)
    return out
  }

  return {
    types: types.map((t) => ({
      id: Number(t.idfourniture_type),
      nom: String(t.nom),
      avecPosition: !!t.avec_position,
    })),
    constructeurs: constructeurs.map((c) => ({ id: Number(c.idfourniture_constructeur), nom: String(c.nom) })),
    fournisseurs: fournisseurs.map((f) => ({
      id: Number(f.idfourniture_fournisseur),
      nom: String(f.nom),
      types: fournTypes
        .filter((t) => Number(t.idfourniture_fournisseur) === Number(f.idfourniture_fournisseur))
        .map((t) => Number(t.idfourniture_type)),
    })),
    articles: articles
      .map((a) => {
        const id = Number(a.idfourniture_article)
        const acceptes = (acceptParArticle.get(id) ?? []).filter((c): c is { id: number; nom: string } => c !== null)
        const seaux = seauxDe(id, acceptes.map((c) => c.id))
        return {
          id,
          idType: Number(a.idfourniture_type),
          type: nomType.get(Number(a.idfourniture_type)) ?? '',
          reference: String(a.reference),
          position: (text(a.position) as 'cylindre' | 'plateau' | null) ?? null,
          commentaire: text(a.commentaire),
          archive: !!a.archive,
          constructeurs: acceptes.sort((x, y) => x.nom.localeCompare(y.nom, 'fr')),
          metiers: (liensParArticle.get(id) ?? []).sort((x, y) => x.emplacement.localeCompare(y.emplacement, 'fr')),
          stock: seaux.reduce((n, s) => n + s.stock, 0),
          stockParConstructeur: seaux,
          commandesParAnnee: commandesParAnnee(entreesParArticle.get(id) ?? []),
          dernierMouvement: maxDate((derniersParArticle.get(id) ?? []).map((x) => x.d)),
        }
      })
      .sort((x, y) => x.reference.localeCompare(y.reference, 'fr', { numeric: true })),
  }
}

fournituresTrmRouter.get('/catalogue', async (req: Request, res: Response) => {
  try {
    res.json(await catalogue(mpsPg(), req.query.archives === '1'))
  } catch (err) {
    fail(res, err, 'GET /fournitures-trm/catalogue')
  }
})

// ════════════════════════════════════════════════════════
//  Constructeurs — an existing one by id, or a new one by name
// ════════════════════════════════════════════════════════

const libelle = z.string().transform(normaliserLibelle).pipe(z.string().min(1).max(100))
const constructeurChoix = z.union([
  z.object({ id: z.number().int().positive() }).strict(),
  z.object({ nom: libelle }).strict(),
])
type ConstructeurChoix = z.infer<typeof constructeurChoix>

async function resoudreConstructeur(t: Tx, choix: ConstructeurChoix, userId: number): Promise<number> {
  if ('id' in choix) {
    const [c] = await t`SELECT 1 FROM trm_fourniture_constructeur WHERE idfourniture_constructeur = ${choix.id}`
    if (!c) throw new Refus(404, 'constructeur_introuvable', 'Constructeur introuvable.')
    return choix.id
  }
  await t`INSERT INTO trm_fourniture_constructeur (nom, modifie_par) VALUES (${choix.nom}, ${userId}) ON CONFLICT DO NOTHING`
  const [c] = await t<Row[]>`
    SELECT idfourniture_constructeur FROM trm_fourniture_constructeur WHERE lower(nom) = lower(${choix.nom})`
  return Number(c.idfourniture_constructeur)
}

async function accepter(t: Tx, articleId: number, constructeurId: number) {
  await t`
    INSERT INTO trm_fourniture_article_constructeur (idfourniture_article, idfourniture_constructeur)
    VALUES (${articleId}, ${constructeurId}) ON CONFLICT DO NOTHING`
}

// ════════════════════════════════════════════════════════
//  Articles (Fournitures › Références)
// ════════════════════════════════════════════════════════

const articleBody = z
  .object({
    idType: z.number().int().positive(),
    reference: libelle,
    position: z.enum(['cylindre', 'plateau']).nullable().optional().default(null),
    commentaire: z.string().max(1000).nullable().optional().default(null),
    constructeurs: z.array(constructeurChoix).max(30).optional().default([]),
  })
  .strict()

async function ecrireArticle(t: Tx, id: number | null, body: z.infer<typeof articleBody>, userId: number) {
  const [type] = await t<Row[]>`SELECT avec_position FROM trm_fourniture_type WHERE idfourniture_type = ${body.idType}`
  if (!type) throw new Refus(400, 'type_inconnu', 'Type inconnu.')
  const position = type.avec_position ? body.position : null
  const [doublon] = await t`
    SELECT 1 FROM trm_fourniture_article
    WHERE idfourniture_type = ${body.idType} AND lower(reference) = lower(${body.reference})
      AND idfourniture_article <> ${id ?? 0}`
  if (doublon) throw new Refus(409, 'reference_existante', `« ${body.reference} » existe déjà.`)
  const commentaire = body.commentaire?.trim() || null
  let articleId = id
  if (articleId === null) {
    const [r] = await t<Row[]>`
      INSERT INTO trm_fourniture_article (idfourniture_type, reference, position, commentaire, modifie_par)
      VALUES (${body.idType}, ${body.reference}, ${position}, ${commentaire}, ${userId})
      RETURNING idfourniture_article`
    articleId = Number(r.idfourniture_article)
  } else {
    await t`
      UPDATE trm_fourniture_article
      SET idfourniture_type = ${body.idType}, reference = ${body.reference}, position = ${position},
          commentaire = ${commentaire}, modifie_le = now(), modifie_par = ${userId}
      WHERE idfourniture_article = ${articleId}`
  }
  const ids: number[] = []
  for (const c of body.constructeurs) ids.push(await resoudreConstructeur(t, c, userId))
  // A constructeur mounted on a métier stays accepted: un-accepting it would
  // leave a métier running needles the reference says it does not take.
  const montes = await t<Row[]>`
    SELECT DISTINCT idfourniture_constructeur FROM trm_fourniture_article_metier
    WHERE idfourniture_article = ${articleId} AND idfourniture_constructeur IS NOT NULL`
  for (const m of montes) ids.push(Number(m.idfourniture_constructeur))
  await t`DELETE FROM trm_fourniture_article_constructeur WHERE idfourniture_article = ${articleId}`
  for (const cId of new Set(ids)) await accepter(t, articleId, cId)
  return articleId
}

fournituresTrmRouter.post('/articles', async (req: Request, res: Response) => {
  if (!(await requireEditFournitures(req, res))) return
  const parsed = articleBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
    return
  }
  try {
    const sql = mpsPg()
    const id = await sql.begin((t) => ecrireArticle(t as unknown as Sql, null, parsed.data, req.userId!))
    res.status(201).json({ id, ...(await catalogue(sql)) })
  } catch (err) {
    fail(res, err, 'POST /fournitures-trm/articles')
  }
})

fournituresTrmRouter.put('/articles/:id', async (req: Request, res: Response) => {
  if (!(await requireEditFournitures(req, res))) return
  const id = parseId(req.params.id)
  const parsed = articleBody.safeParse(req.body)
  if (id === null || !parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.success ? undefined : parsed.error.issues })
    return
  }
  try {
    const sql = mpsPg()
    const [a] = await sql`SELECT 1 FROM trm_fourniture_article WHERE idfourniture_article = ${id}`
    if (!a) {
      res.status(404).json({ error: 'article introuvable' })
      return
    }
    await sql.begin((t) => ecrireArticle(t as unknown as Sql, id, parsed.data, req.userId!))
    res.json({ id, ...(await catalogue(sql)) })
  } catch (err) {
    fail(res, err, 'PUT /fournitures-trm/articles/:id')
  }
})

/** Archives (never deletes: movements and montages point at it). Refused
 *  while a métier still takes it. `?restaurer=1` brings it back. */
fournituresTrmRouter.delete('/articles/:id', async (req: Request, res: Response) => {
  if (!(await requireEditFournitures(req, res))) return
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  try {
    const sql = mpsPg()
    const restaurer = req.query.restaurer === '1'
    if (!restaurer) {
      const surMetier = await sql<Row[]>`
        SELECT COALESCE(NULLIF(trim(m.emplacement::text), ''), m.nom::text) AS metier
        FROM trm_fourniture_article_metier a JOIN machine m ON m.idmachine = a.idmachine
        WHERE a.idfourniture_article = ${id} AND COALESCE(m.archive, 0) <> 1`
      if (surMetier.length) {
        res.status(409).json({
          error: 'article_sur_metier',
          message: `Encore sur ${surMetier.map((m) => m.metier).join(', ')} : retirez-la de ces métiers d'abord.`,
        })
        return
      }
    }
    const r = await sql`
      UPDATE trm_fourniture_article SET archive = ${!restaurer}, modifie_le = now(), modifie_par = ${req.userId!}
      WHERE idfourniture_article = ${id}`
    if (r.count === 0) {
      res.status(404).json({ error: 'article introuvable' })
      return
    }
    res.json(await catalogue(sql, true))
  } catch (err) {
    fail(res, err, 'DELETE /fournitures-trm/articles/:id')
  }
})

// ════════════════════════════════════════════════════════
//  Stock movements (Fournitures › Stock)
// ════════════════════════════════════════════════════════

const TYPE_MOUVEMENT: Record<string, string> = { entree: 'Entrée', sortie: 'Montage', inventaire: 'Inventaire' }

fournituresTrmRouter.get('/articles/:id/mouvements', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  try {
    const rows = await mpsPg()<Row[]>`
      SELECT v.idfourniture_mouvement, v.type, v.quantite, to_char(v.date_mouvement, 'YYYYMMDD') AS date,
             v.commentaire, c.nom AS constructeur, f.nom AS fournisseur, v.idfourniture_montage,
             COALESCE(NULLIF(trim(m.emplacement::text), ''), m.nom::text) AS metier,
             COALESCE(NULLIF(trim(COALESCE(u.prenom::text, '') || ' ' || COALESCE(u.nom::text, '')), ''), u.identifiant::text) AS saisi_par
      FROM trm_fourniture_mouvement v
      LEFT JOIN trm_fourniture_constructeur c ON c.idfourniture_constructeur = v.idfourniture_constructeur
      LEFT JOIN trm_fourniture_fournisseur f ON f.idfourniture_fournisseur = v.idfourniture_fournisseur
      LEFT JOIN trm_fourniture_montage mo ON mo.idfourniture_montage = v.idfourniture_montage
      LEFT JOIN machine m ON m.idmachine = mo.idmachine
      LEFT JOIN utilisateur u ON u.idutilisateur = v.saisi_par
      WHERE v.idfourniture_article = ${id}
      ORDER BY v.date_mouvement DESC, v.idfourniture_mouvement DESC`
    res.json({
      mouvements: rows.map((r) => ({
        id: Number(r.idfourniture_mouvement),
        type: String(r.type),
        libelle: TYPE_MOUVEMENT[String(r.type)] ?? String(r.type),
        quantite: Number(r.quantite),
        date: text(r.date),
        constructeur: text(r.constructeur),
        fournisseur: text(r.fournisseur),
        metier: text(r.metier),
        montage: r.idfourniture_montage == null ? null : Number(r.idfourniture_montage),
        commentaire: text(r.commentaire),
        saisiPar: text(r.saisi_par),
      })),
    })
  } catch (err) {
    fail(res, err, 'GET /fournitures-trm/articles/:id/mouvements')
  }
})

const hfDate = z.string().regex(/^\d{8}$/, 'attendu YYYYMMDD')

const mouvementBody = z
  .object({
    idArticle: z.number().int().positive(),
    /** entree: quantity received (> 0). inventaire: the quantity COUNTED (≥ 0)
     *  for that constructeur — the server writes the correction. */
    type: z.enum(['entree', 'inventaire']),
    constructeur: constructeurChoix.nullable(),
    quantite: z.number().int().min(0).max(1_000_000),
    date: hfDate,
    idFournisseur: z.number().int().positive().nullable().optional().default(null),
    commentaire: z.string().max(1000).nullable().optional().default(null),
  })
  .strict()

fournituresTrmRouter.post('/mouvements', async (req: Request, res: Response) => {
  if (!(await requireEditFournitures(req, res))) return
  const parsed = mouvementBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
    return
  }
  const b = parsed.data
  if (b.date > todayHf()) {
    res.status(400).json({ error: 'date_future', message: 'La date ne peut pas être dans le futur.' })
    return
  }
  if (b.type === 'entree' && b.quantite === 0) {
    res.status(400).json({ error: 'quantite_nulle', message: 'Une entrée porte une quantité.' })
    return
  }
  try {
    const sql = mpsPg()
    const ecrit = await sql.begin(async (tx) => {
      const t = tx as unknown as Sql
      await t`LOCK TABLE trm_fourniture_mouvement IN SHARE ROW EXCLUSIVE MODE`
      const [a] = await t`SELECT 1 FROM trm_fourniture_article WHERE idfourniture_article = ${b.idArticle}`
      if (!a) throw new Refus(404, 'article_introuvable', 'Article introuvable.')
      const cId = b.constructeur ? await resoudreConstructeur(t, b.constructeur, req.userId!) : null
      if (cId !== null) await accepter(t, b.idArticle, cId)
      let quantite = b.quantite
      if (b.type === 'inventaire') {
        const [s] = await t<Row[]>`
          SELECT COALESCE(SUM(quantite), 0)::int AS stock FROM trm_fourniture_mouvement
          WHERE idfourniture_article = ${b.idArticle}
            AND idfourniture_constructeur IS NOT DISTINCT FROM ${cId}`
        quantite = correctionInventaire(Number(s.stock), b.quantite)
        if (quantite === 0) return false
      }
      const note =
        b.type === 'inventaire'
          ? [`Compté : ${b.quantite}`, b.commentaire?.trim()].filter(Boolean).join(' · ')
          : b.commentaire?.trim() || null
      await t`
        INSERT INTO trm_fourniture_mouvement
          (idfourniture_article, idfourniture_constructeur, type, quantite, date_mouvement,
           idfourniture_fournisseur, commentaire, saisi_par)
        VALUES (${b.idArticle}, ${cId}, ${b.type}, ${quantite}, ${pgDate(b.date)},
                ${b.type === 'entree' ? b.idFournisseur : null}, ${note}, ${req.userId!})`
      return true
    })
    res.status(201).json({ ecrit, ...(await catalogue(sql)) })
  } catch (err) {
    fail(res, err, 'POST /fournitures-trm/mouvements')
  }
})

/** Deletes a mistaken entry or count. A montage's own movements go with the
 *  montage, never one by one. */
fournituresTrmRouter.delete('/mouvements/:id', async (req: Request, res: Response) => {
  if (!(await requireEditFournitures(req, res))) return
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  try {
    const sql = mpsPg()
    const [m] = await sql<Row[]>`SELECT type FROM trm_fourniture_mouvement WHERE idfourniture_mouvement = ${id}`
    if (!m) {
      res.status(404).json({ error: 'mouvement introuvable' })
      return
    }
    if (m.type === 'sortie') {
      res.status(409).json({ error: 'mouvement_de_montage', message: 'Un montage se corrige depuis la fiche du métier.' })
      return
    }
    await sql`DELETE FROM trm_fourniture_mouvement WHERE idfourniture_mouvement = ${id}`
    res.json(await catalogue(sql))
  } catch (err) {
    fail(res, err, 'DELETE /fournitures-trm/mouvements/:id')
  }
})

// ════════════════════════════════════════════════════════
//  Fournisseurs (Fournitures › Gestion)
// ════════════════════════════════════════════════════════

fournituresTrmRouter.get('/fournisseurs', async (_req: Request, res: Response) => {
  try {
    const sql = mpsPg()
    const [rows, types, entrees] = await Promise.all([
      sql<Row[]>`SELECT * FROM trm_fourniture_fournisseur ORDER BY lower(nom)`,
      sql<Row[]>`SELECT idfourniture_fournisseur, idfourniture_type FROM trm_fourniture_fournisseur_type`,
      sql<Row[]>`
        SELECT v.idfourniture_fournisseur, COUNT(*)::int AS n, to_char(MAX(v.date_mouvement), 'YYYYMMDD') AS derniere
        FROM trm_fourniture_mouvement v WHERE v.idfourniture_fournisseur IS NOT NULL GROUP BY 1`,
    ])
    const stats = new Map(entrees.map((e) => [Number(e.idfourniture_fournisseur), e]))
    res.json({
      fournisseurs: rows.map((f) => {
        const id = Number(f.idfourniture_fournisseur)
        const s = stats.get(id)
        return {
          id,
          nom: String(f.nom),
          contact: text(f.contact),
          tel: text(f.tel),
          email: text(f.email),
          commentaire: text(f.commentaire),
          archive: !!f.archive,
          types: types.filter((t) => Number(t.idfourniture_fournisseur) === id).map((t) => Number(t.idfourniture_type)),
          nbEntrees: s ? Number(s.n) : 0,
          derniereEntree: s ? text(s.derniere) : null,
        }
      }),
    })
  } catch (err) {
    fail(res, err, 'GET /fournitures-trm/fournisseurs')
  }
})

fournituresTrmRouter.get('/fournisseurs/:id/entrees', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  try {
    const rows = await mpsPg()<Row[]>`
      SELECT v.idfourniture_mouvement, to_char(v.date_mouvement, 'YYYYMMDD') AS date, v.quantite,
             a.reference, t.nom AS type, c.nom AS constructeur, v.commentaire
      FROM trm_fourniture_mouvement v
      JOIN trm_fourniture_article a ON a.idfourniture_article = v.idfourniture_article
      JOIN trm_fourniture_type t ON t.idfourniture_type = a.idfourniture_type
      LEFT JOIN trm_fourniture_constructeur c ON c.idfourniture_constructeur = v.idfourniture_constructeur
      WHERE v.idfourniture_fournisseur = ${id} AND v.type = 'entree'
      ORDER BY v.date_mouvement DESC, v.idfourniture_mouvement DESC
      LIMIT 200`
    res.json({
      entrees: rows.map((r) => ({
        id: Number(r.idfourniture_mouvement),
        date: text(r.date),
        quantite: Number(r.quantite),
        reference: String(r.reference),
        type: String(r.type),
        constructeur: text(r.constructeur),
        commentaire: text(r.commentaire),
      })),
    })
  } catch (err) {
    fail(res, err, 'GET /fournitures-trm/fournisseurs/:id/entrees')
  }
})

const fournisseurBody = z
  .object({
    nom: libelle,
    contact: z.string().max(200).nullable().optional().default(null),
    tel: z.string().max(50).nullable().optional().default(null),
    email: z.string().max(200).nullable().optional().default(null),
    commentaire: z.string().max(2000).nullable().optional().default(null),
    types: z.array(z.number().int().positive()).max(30).optional().default([]),
  })
  .strict()

async function ecrireFournisseur(t: Tx, id: number | null, b: z.infer<typeof fournisseurBody>, userId: number) {
  const [doublon] = await t`
    SELECT 1 FROM trm_fourniture_fournisseur WHERE lower(nom) = lower(${b.nom}) AND idfourniture_fournisseur <> ${id ?? 0}`
  if (doublon) throw new Refus(409, 'fournisseur_existant', `« ${b.nom} » existe déjà.`)
  const v = (s: string | null) => s?.trim() || null
  let fid = id
  if (fid === null) {
    const [r] = await t<Row[]>`
      INSERT INTO trm_fourniture_fournisseur (nom, contact, tel, email, commentaire, modifie_par)
      VALUES (${b.nom}, ${v(b.contact)}, ${v(b.tel)}, ${v(b.email)}, ${v(b.commentaire)}, ${userId})
      RETURNING idfourniture_fournisseur`
    fid = Number(r.idfourniture_fournisseur)
  } else {
    await t`
      UPDATE trm_fourniture_fournisseur
      SET nom = ${b.nom}, contact = ${v(b.contact)}, tel = ${v(b.tel)}, email = ${v(b.email)},
          commentaire = ${v(b.commentaire)}, modifie_le = now(), modifie_par = ${userId}
      WHERE idfourniture_fournisseur = ${fid}`
  }
  await t`DELETE FROM trm_fourniture_fournisseur_type WHERE idfourniture_fournisseur = ${fid}`
  for (const typeId of new Set(b.types)) {
    await t`
      INSERT INTO trm_fourniture_fournisseur_type (idfourniture_fournisseur, idfourniture_type)
      SELECT ${fid}, idfourniture_type FROM trm_fourniture_type WHERE idfourniture_type = ${typeId}`
  }
  return fid
}

fournituresTrmRouter.post('/fournisseurs', async (req: Request, res: Response) => {
  if (!(await requireEditFournitures(req, res))) return
  const parsed = fournisseurBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
    return
  }
  try {
    const id = await mpsPg().begin((t) => ecrireFournisseur(t as unknown as Sql, null, parsed.data, req.userId!))
    res.status(201).json({ id })
  } catch (err) {
    fail(res, err, 'POST /fournitures-trm/fournisseurs')
  }
})

fournituresTrmRouter.put('/fournisseurs/:id', async (req: Request, res: Response) => {
  if (!(await requireEditFournitures(req, res))) return
  const id = parseId(req.params.id)
  const parsed = fournisseurBody.safeParse(req.body)
  if (id === null || !parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.success ? undefined : parsed.error.issues })
    return
  }
  try {
    const sql = mpsPg()
    const [f] = await sql`SELECT 1 FROM trm_fourniture_fournisseur WHERE idfourniture_fournisseur = ${id}`
    if (!f) {
      res.status(404).json({ error: 'fournisseur introuvable' })
      return
    }
    await sql.begin((t) => ecrireFournisseur(t as unknown as Sql, id, parsed.data, req.userId!))
    res.json({ id })
  } catch (err) {
    fail(res, err, 'PUT /fournitures-trm/fournisseurs/:id')
  }
})

/** Archives (its past entries keep pointing at it). `?restaurer=1` undoes. */
fournituresTrmRouter.delete('/fournisseurs/:id', async (req: Request, res: Response) => {
  if (!(await requireEditFournitures(req, res))) return
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  try {
    const r = await mpsPg()`
      UPDATE trm_fourniture_fournisseur SET archive = ${req.query.restaurer !== '1'}, modifie_le = now(), modifie_par = ${req.userId!}
      WHERE idfourniture_fournisseur = ${id}`
    if (r.count === 0) {
      res.status(404).json({ error: 'fournisseur introuvable' })
      return
    }
    res.json({ id })
  } catch (err) {
    fail(res, err, 'DELETE /fournitures-trm/fournisseurs/:id')
  }
})

// ════════════════════════════════════════════════════════
//  A métier's references (Atelier › Maintenance, tab Aiguilles) — edit_maintenance
// ════════════════════════════════════════════════════════

const ajoutBody = z.union([
  z.object({ idArticle: z.number().int().positive() }).strict(),
  z
    .object({
      reference: libelle,
      idType: z.number().int().positive(),
      position: z.enum(['cylindre', 'plateau']).nullable().optional().default(null),
    })
    .strict(),
])

fournituresTrmRouter.post('/metiers/:id/articles', async (req: Request, res: Response) => {
  if (!(await requireEditMaintenance(req, res))) return
  const id = parseId(req.params.id)
  const parsed = ajoutBody.safeParse(req.body)
  if (id === null || !parsed.success) {
    res.status(400).json({ error: 'Validation failed' })
    return
  }
  try {
    const sql = mpsPg()
    if (!(await machineEcrivable(sql, id, res))) return
    const b = parsed.data
    await sql.begin(async (tx) => {
      const t = tx as unknown as Sql
      let articleId: number
      if ('idArticle' in b) {
        const [a] = await t`SELECT 1 FROM trm_fourniture_article WHERE idfourniture_article = ${b.idArticle} AND NOT archive`
        if (!a) throw new Refus(404, 'article_introuvable', 'Référence introuvable.')
        articleId = b.idArticle
      } else {
        // A name that already exists in that type (any case) is that article.
        const [existant] = await t<Row[]>`
          SELECT idfourniture_article, archive FROM trm_fourniture_article
          WHERE idfourniture_type = ${b.idType} AND lower(reference) = lower(${b.reference})`
        if (existant) {
          if (existant.archive) throw new Refus(409, 'article_archive', `« ${b.reference} » est archivée (Fournitures › Références).`)
          articleId = Number(existant.idfourniture_article)
        } else {
          articleId = await ecrireArticle(
            t,
            null,
            { idType: b.idType, reference: b.reference, position: b.position, commentaire: null, constructeurs: [] },
            req.userId!,
          )
        }
      }
      const [deja] = await t`
        SELECT 1 FROM trm_fourniture_article_metier WHERE idmachine = ${id} AND idfourniture_article = ${articleId}`
      if (deja) throw new Refus(409, 'deja_sur_metier', 'Cette référence est déjà sur ce métier.')
      await t`
        INSERT INTO trm_fourniture_article_metier (idmachine, idfourniture_article, rang, modifie_par)
        SELECT ${id}, ${articleId}, COALESCE(MAX(rang), 0) + 1, ${req.userId!}
        FROM trm_fourniture_article_metier WHERE idmachine = ${id}`
    })
    res.status(201).json(await catalogue(sql))
  } catch (err) {
    fail(res, err, 'POST /fournitures-trm/metiers/:id/articles')
  }
})

const lienBody = z.object({ quantite: z.number().int().positive().max(100_000).nullable() }).strict()

/** The quantity a montage of this reference takes on this métier (typed by
 *  Nicolas once, then pre-filled in every set change). */
fournituresTrmRouter.put('/metiers/:id/articles/:articleId', async (req: Request, res: Response) => {
  if (!(await requireEditMaintenance(req, res))) return
  const id = parseId(req.params.id)
  const articleId = parseId(req.params.articleId)
  const parsed = lienBody.safeParse(req.body)
  if (id === null || articleId === null || !parsed.success) {
    res.status(400).json({ error: 'Validation failed' })
    return
  }
  try {
    const sql = mpsPg()
    if (!(await machineEcrivable(sql, id, res))) return
    const r = await sql`
      UPDATE trm_fourniture_article_metier SET quantite = ${parsed.data.quantite}, modifie_le = now(), modifie_par = ${req.userId!}
      WHERE idmachine = ${id} AND idfourniture_article = ${articleId}`
    if (r.count === 0) {
      res.status(404).json({ error: "cette référence n'est pas sur ce métier" })
      return
    }
    res.json(await catalogue(sql))
  } catch (err) {
    fail(res, err, 'PUT /fournitures-trm/metiers/:id/articles/:articleId')
  }
})

/** Removes a reference from a métier (the reference, its stock and the
 *  montage history stay). */
fournituresTrmRouter.delete('/metiers/:id/articles/:articleId', async (req: Request, res: Response) => {
  if (!(await requireEditMaintenance(req, res))) return
  const id = parseId(req.params.id)
  const articleId = parseId(req.params.articleId)
  if (id === null || articleId === null) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  try {
    const sql = mpsPg()
    if (!(await machineEcrivable(sql, id, res))) return
    const r = await sql`DELETE FROM trm_fourniture_article_metier WHERE idmachine = ${id} AND idfourniture_article = ${articleId}`
    if (r.count === 0) {
      res.status(404).json({ error: "cette référence n'est pas sur ce métier" })
      return
    }
    res.json(await catalogue(sql))
  } catch (err) {
    fail(res, err, 'DELETE /fournitures-trm/metiers/:id/articles/:articleId')
  }
})

// ════════════════════════════════════════════════════════
//  Set changes — « Changer le jeu »
// ════════════════════════════════════════════════════════

fournituresTrmRouter.get('/metiers/:id/montages', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  try {
    const sql = mpsPg()
    const [montages, lignes] = await Promise.all([
      sql<Row[]>`
        SELECT mo.idfourniture_montage, to_char(mo.date_montage, 'YYYYMMDD') AS date, mo.commentaire,
               COALESCE(NULLIF(trim(COALESCE(u.prenom::text, '') || ' ' || COALESCE(u.nom::text, '')), ''), u.identifiant::text) AS saisi_par
        FROM trm_fourniture_montage mo LEFT JOIN utilisateur u ON u.idutilisateur = mo.saisi_par
        WHERE mo.idmachine = ${id}
        ORDER BY mo.date_montage DESC, mo.idfourniture_montage DESC
        LIMIT 50`,
      sql<Row[]>`
        SELECT l.idfourniture_montage, l.quantite, a.reference, a.position, c.nom AS constructeur
        FROM trm_fourniture_montage_ligne l
        JOIN trm_fourniture_montage mo ON mo.idfourniture_montage = l.idfourniture_montage
        JOIN trm_fourniture_article a ON a.idfourniture_article = l.idfourniture_article
        LEFT JOIN trm_fourniture_constructeur c ON c.idfourniture_constructeur = l.idfourniture_constructeur
        WHERE mo.idmachine = ${id}
        ORDER BY l.id`,
    ])
    res.json({
      montages: montages.map((m) => ({
        id: Number(m.idfourniture_montage),
        date: text(m.date),
        commentaire: text(m.commentaire),
        saisiPar: text(m.saisi_par),
        lignes: lignes
          .filter((l) => Number(l.idfourniture_montage) === Number(m.idfourniture_montage))
          .map((l) => ({
            reference: String(l.reference),
            position: text(l.position),
            constructeur: text(l.constructeur),
            quantite: Number(l.quantite),
          })),
      })),
    })
  } catch (err) {
    fail(res, err, 'GET /fournitures-trm/metiers/:id/montages')
  }
})

const montageBody = z
  .object({
    date: hfDate,
    commentaire: z.string().max(1000).nullable().optional().default(null),
    /** Also stamp the garniture's « Changement des aiguilles » / « des platines ». */
    reporterGarniture: z.boolean().optional().default(true),
    lignes: z
      .array(
        z
          .object({
            idArticle: z.number().int().positive(),
            constructeur: constructeurChoix.nullable(),
            quantite: z.number().int().positive().max(100_000),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict()

/** Garniture column stamped by a set change, per article type. */
const GARNITURE_PAR_TYPE: Record<string, string> = { aiguille: 'chg_aiguilles', platine: 'chg_platines' }

fournituresTrmRouter.post('/metiers/:id/montages', async (req: Request, res: Response) => {
  if (!(await requireEditMaintenance(req, res))) return
  const id = parseId(req.params.id)
  const parsed = montageBody.safeParse(req.body)
  if (id === null || !parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.success ? undefined : parsed.error.issues })
    return
  }
  const b = parsed.data
  if (b.date > todayHf()) {
    res.status(400).json({ error: 'date_future', message: 'La date du montage ne peut pas être dans le futur.' })
    return
  }
  if (new Set(b.lignes.map((l) => l.idArticle)).size !== b.lignes.length) {
    res.status(400).json({ error: 'ligne_en_double', message: 'Une même référence figure deux fois.' })
    return
  }
  try {
    const sql = mpsPg()
    if (!(await machineEcrivable(sql, id, res))) return
    await sql.begin(async (tx) => {
      const t = tx as unknown as Sql
      // One set change at a time: the stock read and the take must not interleave.
      await t`LOCK TABLE trm_fourniture_mouvement IN SHARE ROW EXCLUSIVE MODE`
      const surMetier = await t<Row[]>`
        SELECT a.idfourniture_article, a.quantite, lower(t.nom) AS type
        FROM trm_fourniture_article_metier a
        JOIN trm_fourniture_article ar ON ar.idfourniture_article = a.idfourniture_article
        JOIN trm_fourniture_type t ON t.idfourniture_type = ar.idfourniture_type
        WHERE a.idmachine = ${id}`
      const lien = new Map(surMetier.map((r) => [Number(r.idfourniture_article), r]))
      const absent = b.lignes.find((l) => !lien.has(l.idArticle))
      if (absent) throw new Refus(409, 'pas_sur_metier', "Une des références n'est pas acceptée par ce métier.")

      const [mo] = await t<Row[]>`
        INSERT INTO trm_fourniture_montage (idmachine, date_montage, commentaire, saisi_par)
        VALUES (${id}, ${pgDate(b.date)}, ${b.commentaire?.trim() || null}, ${req.userId!})
        RETURNING idfourniture_montage`
      const montageId = Number(mo.idfourniture_montage)
      const types = new Set<string>()

      for (const l of b.lignes) {
        const cId = l.constructeur ? await resoudreConstructeur(t, l.constructeur, req.userId!) : null
        if (cId !== null) await accepter(t, l.idArticle, cId)
        await t`
          INSERT INTO trm_fourniture_montage_ligne (idfourniture_montage, idfourniture_article, idfourniture_constructeur, quantite)
          VALUES (${montageId}, ${l.idArticle}, ${cId}, ${l.quantite})`
        const seaux = await t<Row[]>`
          SELECT idfourniture_constructeur, SUM(quantite)::int AS stock FROM trm_fourniture_mouvement
          WHERE idfourniture_article = ${l.idArticle} GROUP BY 1`
        const prises = repartirSortie(
          seaux.map((s): Seau => ({
            constructeur: s.idfourniture_constructeur == null ? null : Number(s.idfourniture_constructeur),
            stock: Number(s.stock) || 0,
          })),
          cId,
          l.quantite,
        )
        for (const p of prises) {
          await t`
            INSERT INTO trm_fourniture_mouvement
              (idfourniture_article, idfourniture_constructeur, type, quantite, date_mouvement, idfourniture_montage, saisi_par)
            VALUES (${l.idArticle}, ${p.constructeur}, 'sortie', ${-p.quantite}, ${pgDate(b.date)}, ${montageId}, ${req.userId!})`
        }
        // The first quantity typed becomes the métier's own (pre-filled next time).
        await t`
          UPDATE trm_fourniture_article_metier
          SET idfourniture_constructeur = ${cId}, date_montage = ${pgDate(b.date)},
              quantite = COALESCE(quantite, ${l.quantite}), modifie_le = now(), modifie_par = ${req.userId!}
          WHERE idmachine = ${id} AND idfourniture_article = ${l.idArticle}`
        types.add(String(lien.get(l.idArticle)!.type))
      }

      if (b.reporterGarniture) {
        for (const type of types) {
          const col = GARNITURE_PAR_TYPE[type]
          if (!col) continue
          // Never moves the garniture date backwards.
          await t.unsafe(
            `UPDATE machine SET ${col} = $1 WHERE idmachine = $2 AND (${col} IS NULL OR ${col} < $1::date)`,
            [pgDate(b.date), id],
          )
        }
      }
    })
    res.status(201).json(await catalogue(sql))
  } catch (err) {
    fail(res, err, 'POST /fournitures-trm/metiers/:id/montages')
  }
})

/** Undoes a set change typed by mistake: its stock comes back (its movements
 *  go with it, ON DELETE CASCADE). The métier's « mounted » state is not
 *  rewound — correct it with a new set change if needed. */
fournituresTrmRouter.delete('/metiers/:id/montages/:montageId', async (req: Request, res: Response) => {
  if (!(await requireEditMaintenance(req, res))) return
  const id = parseId(req.params.id)
  const montageId = parseId(req.params.montageId)
  if (id === null || montageId === null) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  try {
    const sql = mpsPg()
    const r = await sql`DELETE FROM trm_fourniture_montage WHERE idfourniture_montage = ${montageId} AND idmachine = ${id}`
    if (r.count === 0) {
      res.status(404).json({ error: 'montage introuvable' })
      return
    }
    res.json(await catalogue(sql))
  } catch (err) {
    fail(res, err, 'DELETE /fournitures-trm/metiers/:id/montages/:montageId')
  }
})

