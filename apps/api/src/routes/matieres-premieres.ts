// Fils › Matières premières (LIVA #1359): the matières a yarn is made of, and
// the fibre FAMILY of each — the family decides which coloris can be copied
// from one finished reference to another (lib/familles-fibres.ts). Before this
// screen nothing in ETM could create a matière.
//
// Reads are open (the list is a lookup); writes need the screen (Écrans axis,
// no action key). The families are a fixed list in code, never edited here.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { mpsPg } from '../lib/mps-pg.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { userCanOpenScreen } from '../lib/permissions.js'
import { FAMILLES_FIBRES, SEUIL_FAMILLE } from '../lib/familles-fibres.js'

export const matieresPremieresRouter: RouterType = Router()

const CODES = FAMILLES_FIBRES.map((f) => f.code) as [string, ...string[]]

const corps = z.object({
  libelle: z.string().trim().min(1).max(60),
  famille: z.enum(CODES).nullable(),
})

async function peutEcrire(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return false }
  if (!(await userCanOpenScreen(req.userId, isEffectiveAdmin(req), '/fils', '/fils/matieres'))) {
    res.status(403).json({ error: 'forbidden', message: 'Vous n’avez pas accès aux matières premières.' })
    return false
  }
  return true
}

interface MatiereOut {
  IDmatiere: number
  libelle: string
  famille: string | null
  fils: Array<{ IDref_fil: number; reference: string }>
}

async function lister(): Promise<MatiereOut[]> {
  const sql = mpsPg()
  const [matieres, fils] = await Promise.all([
    sql<{ idmatiere_premiere: number; libelle: string | null; famille: string | null }[]>`
      SELECT idmatiere_premiere, trim(libelle::text) AS libelle, famille FROM matiere_premiere`,
    sql<{ idmatiere: number; idref_fil: number; reference: string | null }[]>`
      SELECT DISTINCT a.idmatiere, f.idref_fil, trim(f.reference::text) AS reference
      FROM asso_fil_matiere a JOIN ref_fil f ON f.idref_fil = a.idref_fil`,
  ])
  const parMatiere = new Map<number, MatiereOut['fils']>()
  for (const f of fils) {
    if (!parMatiere.has(f.idmatiere)) parMatiere.set(f.idmatiere, [])
    parMatiere.get(f.idmatiere)!.push({ IDref_fil: f.idref_fil, reference: f.reference ?? '' })
  }
  return matieres
    .map((m) => ({
      IDmatiere: m.idmatiere_premiere,
      libelle: m.libelle ?? '',
      famille: m.famille,
      fils: (parMatiere.get(m.idmatiere_premiere) ?? []).sort((a, b) => a.reference.localeCompare(b.reference, 'fr')),
    }))
    .sort((a, b) => a.libelle.localeCompare(b.libelle, 'fr'))
}

// GET /api/matieres-premieres — { familles, seuil, matieres }
matieresPremieresRouter.get('/', async (_req: Request, res: Response) => {
  try {
    res.json({ familles: FAMILLES_FIBRES, seuil: SEUIL_FAMILLE, matieres: await lister() })
  } catch (err) {
    console.error('Error listing matieres premieres:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** libelle is citext: the comparison ignores case. */
async function nomPris(libelle: string, saufId = 0): Promise<boolean> {
  const r = await mpsPg()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM matiere_premiere
    WHERE trim(libelle::text)::citext = ${libelle}::citext AND idmatiere_premiere <> ${saufId}`
  return r[0].n > 0
}

// POST /api/matieres-premieres — create
matieresPremieresRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = corps.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed' }); return }
    if (!(await peutEcrire(req, res))) return
    const { libelle, famille } = parsed.data
    if (await nomPris(libelle)) { res.status(409).json({ error: 'existe', message: `« ${libelle} » existe déjà.` }); return }
    const [cree] = await mpsPg()<{ idmatiere_premiere: number }[]>`
      INSERT INTO matiere_premiere (libelle, famille) VALUES (${libelle}, ${famille}) RETURNING idmatiere_premiere`
    res.status(201).json({ IDmatiere: cree.idmatiere_premiere })
  } catch (err) {
    console.error('Error creating matiere premiere:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/matieres-premieres/:id — rename / classify
matieresPremieresRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = corps.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed' }); return }
    if (!(await peutEcrire(req, res))) return
    const { libelle, famille } = parsed.data
    if (await nomPris(libelle, id)) { res.status(409).json({ error: 'existe', message: `« ${libelle} » existe déjà.` }); return }
    const r = await mpsPg()`UPDATE matiere_premiere SET libelle = ${libelle}, famille = ${famille} WHERE idmatiere_premiere = ${id}`
    if (r.count === 0) { res.status(404).json({ error: 'Matière introuvable' }); return }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating matiere premiere:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/matieres-premieres/:id — only a matière no yarn uses
matieresPremieresRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await peutEcrire(req, res))) return
    const sql = mpsPg()
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(DISTINCT idref_fil)::int AS n FROM asso_fil_matiere WHERE idmatiere = ${id}`
    if (n > 0) {
      res.status(409).json({ error: 'matiere_utilisee', message: `${n} fil${n > 1 ? 's l’utilisent' : ' l’utilise'} : elle ne peut pas être supprimée.` })
      return
    }
    const r = await sql`DELETE FROM matiere_premiere WHERE idmatiere_premiere = ${id}`
    if (r.count === 0) { res.status(404).json({ error: 'Matière introuvable' }); return }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting matiere premiere:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
