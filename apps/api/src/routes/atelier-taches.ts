// Tâches d'atelier — `/api/atelier/taches`, the atelier phones' list of general
// factory jobs (decision Vincent 2026-11-05). Rules: lib/taches-atelier.ts.
// Native PostgreSQL (lib/mps-pg.ts), tables of migration 0061.
//
// Every write goes through gateSaisie() (routes/atelier.ts): an enrolled
// atelier phone, speaking for a live bonnetier it may speak for. Task writes
// additionally require that bonnetier to be a régleur.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { mpsPg } from '../lib/mps-pg.js'
import { selectBonnetiers } from '../lib/production-trm.js'
import { gateSaisie } from './atelier.js'
import {
  ageJours,
  annulableJusqua,
  equipeRealisation,
  niveauTache,
  FREQUENCE_MAX,
  peutAnnuler,
  trierTaches,
  DESCRIPTION_MAX,
  LIBELLE_MAX,
} from '../lib/taches-atelier.js'

export const atelierTachesRouter: RouterType = Router()

interface Membre {
  id: number
  prenom: string
  nom: string
}

async function annuaire(): Promise<Map<number, Membre & { archive: number; regleur: number }>> {
  return new Map((await selectBonnetiers()).map((b) => [b.id, b]))
}

function parseId(raw: unknown): number | null {
  const id = parseInt(String(raw), 10)
  return Number.isInteger(id) && id > 0 ? id : null
}

function membre(dir: Map<number, Membre>, id: number): Membre {
  const b = dir.get(id)
  return { id, prenom: b?.prenom ?? '', nom: b?.nom ?? '' }
}

// ── GET /api/atelier/taches ───────────────────────────────
// The open tasks, each with its last réalisation (hour + team), never-done and
// oldest-done first. Read by both roles.
atelierTachesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const sql = mpsPg()
    const taches = await sql<{ id: number; libelle: string; description: string; frequence_jours: number | null }[]>`
      SELECT id, libelle, description, frequence_jours FROM tache_atelier WHERE archivee_le IS NULL`
    const ids = taches.map((t) => t.id)
    const dernieres = ids.length
      ? await sql<{ id: number; idtache: number; fait_le: Date; declare_par: number; nb: number }[]>`
          SELECT DISTINCT ON (r.idtache) r.id, r.idtache, r.fait_le, r.declare_par,
                 count(*) OVER (PARTITION BY r.idtache)::int AS nb
          FROM tache_atelier_realisation r
          WHERE r.idtache = ANY(${ids})
          ORDER BY r.idtache, r.fait_le DESC, r.id DESC`
      : []
    const rids = dernieres.map((d) => d.id)
    const participants = rids.length
      ? await sql<{ idrealisation: number; idbonnetier: number }[]>`
          SELECT idrealisation, idbonnetier FROM tache_atelier_participant WHERE idrealisation = ANY(${rids})`
      : []
    const dir = await annuaire()
    const parTache = new Map(dernieres.map((d) => [d.idtache, d]))
    const now = Date.now()
    const out = taches.map((t) => {
      const d = parTache.get(t.id)
      const faitMs = d ? d.fait_le.getTime() : null
      return {
        id: t.id,
        libelle: t.libelle,
        description: t.description,
        frequence_jours: t.frequence_jours,
        nb_realisations: d?.nb ?? 0,
        derniere_ms: faitMs,
        age_jours: ageJours(faitMs, now),
        niveau: niveauTache(t.frequence_jours, faitMs, now),
        derniere: d
          ? {
              id: d.id,
              fait_le_ms: faitMs!,
              declare_par: d.declare_par,
              annulable_jusqua_ms: annulableJusqua(faitMs!),
              // Declarer first, then the coéquipiers.
              equipe: [
                membre(dir, d.declare_par),
                ...participants
                  .filter((p) => p.idrealisation === d.id && p.idbonnetier !== d.declare_par)
                  .map((p) => membre(dir, p.idbonnetier)),
              ],
            }
          : null,
      }
    })
    res.json(trierTaches(out))
  } catch (err) {
    console.error('Error fetching atelier taches:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/atelier/taches/equipe ────────────────────────
// Who can be ticked as a coéquipier: every live bonnetier, régleurs included.
atelierTachesRouter.get('/equipe', async (_req: Request, res: Response) => {
  try {
    const rows = (await selectBonnetiers())
      .filter((b) => b.archive === 0)
      .map((b) => ({ IDbonnetier: b.id, prenom: b.prenom, nom: b.nom, regleur: b.regleur }))
      .sort((a, b) => a.prenom.localeCompare(b.prenom, 'fr'))
    res.json(rows)
  } catch (err) {
    console.error('Error fetching atelier equipe:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/atelier/taches/:id/realisations ──────────────
// The task's history, newest first (last 50).
atelierTachesRouter.get('/:id/realisations', async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id)
    if (id === null) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const sql = mpsPg()
    const rows = await sql<{ id: number; fait_le: Date; declare_par: number }[]>`
      SELECT id, fait_le, declare_par FROM tache_atelier_realisation
      WHERE idtache = ${id} ORDER BY fait_le DESC, id DESC LIMIT 50`
    const rids = rows.map((r) => r.id)
    const participants = rids.length
      ? await sql<{ idrealisation: number; idbonnetier: number }[]>`
          SELECT idrealisation, idbonnetier FROM tache_atelier_participant WHERE idrealisation = ANY(${rids})`
      : []
    const dir = await annuaire()
    res.json(
      rows.map((r) => ({
        id: r.id,
        fait_le_ms: r.fait_le.getTime(),
        declare_par: r.declare_par,
        annulable_jusqua_ms: annulableJusqua(r.fait_le.getTime()),
        equipe: [
          membre(dir, r.declare_par),
          ...participants
            .filter((p) => p.idrealisation === r.id && p.idbonnetier !== r.declare_par)
            .map((p) => membre(dir, p.idbonnetier)),
        ],
      })),
    )
  } catch (err) {
    console.error('Error fetching atelier tache realisations:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Task writes: régleur only ─────────────────────────────

const tacheBody = z
  .object({
    IDbonnetier: z.number().int().positive(),
    libelle: z.string().trim().min(1).max(LIBELLE_MAX),
    description: z.string().trim().max(DESCRIPTION_MAX).default(''),
    // null = no frequency (the tag stays grey).
    frequence_jours: z.number().int().min(1).max(FREQUENCE_MAX).nullable().default(null),
  })
  .strict()

const quiBody = z.object({ IDbonnetier: z.number().int().positive() }).strict()

async function gateRegleur(req: Request, res: Response, IDbonnetier: number) {
  const who = await gateSaisie(req, res, IDbonnetier)
  if (!who) return null
  if (who.regleur !== 1) {
    res.status(403).json({ error: 'regleur_requis', message: 'Seul un régleur peut modifier la liste des tâches.' })
    return null
  }
  return who
}

atelierTachesRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = tacheBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const who = await gateRegleur(req, res, parsed.data.IDbonnetier)
    if (!who) return
    const [row] = await mpsPg()<{ id: number }[]>`
      INSERT INTO tache_atelier (libelle, description, frequence_jours, cree_par)
      VALUES (${parsed.data.libelle}, ${parsed.data.description}, ${parsed.data.frequence_jours}, ${who.id})
      RETURNING id`
    res.status(201).json({ id: row.id })
  } catch (err) {
    console.error('Error creating atelier tache:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

atelierTachesRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id)
    if (id === null) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const parsed = tacheBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const who = await gateRegleur(req, res, parsed.data.IDbonnetier)
    if (!who) return
    const rows = await mpsPg()`
      UPDATE tache_atelier
      SET libelle = ${parsed.data.libelle}, description = ${parsed.data.description},
          frequence_jours = ${parsed.data.frequence_jours}, modifie_le = now()
      WHERE id = ${id} AND archivee_le IS NULL
      RETURNING id`
    if (!rows.length) {
      res.status(404).json({ error: 'tache_introuvable' })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating atelier tache:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// « Supprimer » archives: the réalisations keep their task.
atelierTachesRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id)
    if (id === null) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const parsed = quiBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const who = await gateRegleur(req, res, parsed.data.IDbonnetier)
    if (!who) return
    const rows = await mpsPg()`
      UPDATE tache_atelier SET archivee_le = now(), archivee_par = ${who.id}
      WHERE id = ${id} AND archivee_le IS NULL
      RETURNING id`
    if (!rows.length) {
      res.status(404).json({ error: 'tache_introuvable' })
      return
    }
    res.status(204).end()
  } catch (err) {
    console.error('Error archiving atelier tache:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Réalisations: any identified bonnetier ────────────────

const realisationBody = z
  .object({
    IDbonnetier: z.number().int().positive(),
    coequipiers: z.array(z.number().int().positive()).max(20).default([]),
  })
  .strict()

atelierTachesRouter.post('/:id/realisations', async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id)
    if (id === null) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const parsed = realisationBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const who = await gateSaisie(req, res, parsed.data.IDbonnetier)
    if (!who) return
    const equipe = equipeRealisation(who.id, parsed.data.coequipiers)
    if (!equipe) {
      res.status(400).json({ error: 'equipe_trop_grande', message: 'Trop de coéquipiers.' })
      return
    }
    const dir = await annuaire()
    const inconnu = equipe.find((b) => !dir.get(b) || dir.get(b)!.archive !== 0)
    if (inconnu !== undefined) {
      res.status(400).json({ error: 'coequipier_inconnu', message: 'Un coéquipier est inconnu ou archivé.' })
      return
    }
    const sql = mpsPg()
    const created = await sql.begin(async (t) => {
      const tx = t as unknown as typeof sql
      const [tache] = await tx`SELECT id FROM tache_atelier WHERE id = ${id} AND archivee_le IS NULL FOR SHARE`
      if (!tache) return null
      const [r] = await tx<{ id: number; fait_le: Date }[]>`
        INSERT INTO tache_atelier_realisation (idtache, declare_par)
        VALUES (${id}, ${who.id}) RETURNING id, fait_le`
      for (const b of equipe) {
        await tx`INSERT INTO tache_atelier_participant (idrealisation, idbonnetier) VALUES (${r.id}, ${b})`
      }
      return r
    })
    if (!created) {
      res.status(404).json({ error: 'tache_introuvable', message: 'Cette tâche a été supprimée.' })
      return
    }
    res.status(201).json({ id: created.id, fait_le_ms: created.fait_le.getTime() })
  } catch (err) {
    console.error('Error creating atelier tache realisation:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// A wrong tap: the declarer only, within DELAI_ANNULATION_MS.
atelierTachesRouter.delete('/:id/realisations/:rid', async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id)
    const rid = parseId(req.params.rid)
    if (id === null || rid === null) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const parsed = quiBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const who = await gateSaisie(req, res, parsed.data.IDbonnetier)
    if (!who) return
    const sql = mpsPg()
    const [r] = await sql<{ idtache: number; declare_par: number; fait_le: Date }[]>`
      SELECT idtache, declare_par, fait_le FROM tache_atelier_realisation WHERE id = ${rid}`
    if (!r || r.idtache !== id) {
      res.status(404).json({ error: 'realisation_introuvable' })
      return
    }
    if (!peutAnnuler({ declare_par: r.declare_par, fait_le_ms: r.fait_le.getTime() }, who.id, Date.now())) {
      res.status(409).json({
        error: 'annulation_impossible',
        message: r.declare_par === who.id
          ? 'Trop tard pour annuler : la tâche est enregistrée.'
          : 'Seul celui qui a déclaré la tâche peut l’annuler.',
      })
      return
    }
    await sql`DELETE FROM tache_atelier_realisation WHERE id = ${rid}`
    res.status(204).end()
  } catch (err) {
    console.error('Error deleting atelier tache realisation:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
