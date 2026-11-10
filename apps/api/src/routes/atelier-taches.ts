// Tâches d'atelier — `/api/atelier/taches`, the atelier phones' list of general
// factory jobs (decision Vincent 2026-11-05). Rules: lib/taches-atelier.ts.
// Native PostgreSQL (lib/mps-pg.ts), tables of migration 0061.
//
// Two categories (lib/taches-atelier.ts): the standing « récurrentes »
// (régleur-managed, migration 0061) and the one-off « ponctuelles » addressed
// to a group (Vincent 2026-11-10, migration 0072).
//
// Every write goes through gateSaisie() (routes/atelier.ts): an enrolled
// atelier phone, speaking for a live bonnetier it may speak for. Writes on a
// récurrente additionally require that bonnetier to be a régleur; on a
// ponctuelle, the rights come from `actionsPonctuelle`.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { mpsPg } from '../lib/mps-pg.js'
import { selectBonnetiers } from '../lib/production-trm.js'
import { gateSaisie } from './atelier.js'
import {
  actionsPonctuelle,
  ageJours,
  annulableJusqua,
  aujourdhuiParis,
  echeanceACreation,
  echeanceValide,
  equipeRealisation,
  motifValide,
  niveauPonctuelle,
  niveauTache,
  FREQUENCE_MAX,
  MOTIF_MAX,
  MOTIFS_ABANDON,
  MOTIFS_REPORT,
  peutAnnuler,
  ponctuelleVisible,
  trierTaches,
  DESCRIPTION_MAX,
  LIBELLE_MAX,
  VUE_CLOTUREE_JOURS,
  type Groupe,
  type Lecteur,
  type Ponctuelle,
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

// ── GET /api/atelier/taches?moi=<IDbonnetier> ─────────────
// The standing tasks, each with its last réalisation (hour + team), sorted by
// trierTaches; before them the ponctuelles the viewer `moi` may see (his
// group's, and the ones he created — those also for VUE_CLOTUREE_JOURS once
// closed), with their colour and what HE may do on them. Without `moi`,
// standing tasks only. The colour of a ponctuelle depends on who looks.

interface TacheRow {
  id: number
  libelle: string
  description: string
  frequence_jours: number | null
  categorie: 'recurrente' | 'ponctuelle'
  groupe: Groupe | null
  echeance: string | null
  cree_par: number
  cloture: 'faite' | 'abandonnee' | null
  cloturee_le: Date | null
  cloturee_par: number | null
  cree_le: Date
}

function ponctuelleDe(t: TacheRow): Ponctuelle {
  return { groupe: t.groupe!, cree_par: t.cree_par, echeance: t.echeance, cloture: t.cloture }
}

function lecteurDe(who: { id: number; regleur: number }): Lecteur {
  return { id: who.id, regleur: who.regleur === 1 }
}

atelierTachesRouter.get('/', async (req: Request, res: Response) => {
  try {
    const sql = mpsPg()
    const dir = await annuaire()
    const moiId = parseId(req.query.moi)
    const moiRow = moiId !== null ? dir.get(moiId) : undefined
    const moi: Lecteur | null = moiRow && moiRow.archive === 0 ? lecteurDe(moiRow) : null
    const now = Date.now()
    const today = aujourdhuiParis(now)
    const rows = await sql<TacheRow[]>`
      SELECT id, libelle, description, frequence_jours, categorie, groupe,
             to_char(echeance, 'YYYY-MM-DD') AS echeance, cree_par, cree_le, cloture, cloturee_le, cloturee_par
      FROM tache_atelier
      WHERE archivee_le IS NULL
        AND (categorie = 'recurrente'
             OR cloture IS NULL
             OR (cloture = 'abandonnee' AND cloturee_le > now() - make_interval(days => ${VUE_CLOTUREE_JOURS})))`
    const taches = rows.filter(
      (t) =>
        t.categorie === 'recurrente' ||
        (moi !== null &&
          ponctuelleVisible({ ...ponctuelleDe(t), cloturee_le_ms: t.cloturee_le?.getTime() ?? null }, moi, now)),
    )
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
    const pids = taches.filter((t) => t.categorie === 'ponctuelle').map((t) => t.id)
    const evenements = pids.length
      ? await sql<{ idtache: number; type: string; motif_code: string | null; motif: string }[]>`
          SELECT idtache, type, motif_code, motif FROM tache_atelier_evenement
          WHERE idtache = ANY(${pids}) ORDER BY le, id`
      : []
    const parTache = new Map(dernieres.map((d) => [d.idtache, d]))
    const out = taches.map((t) => {
      const d = parTache.get(t.id)
      const faitMs = d ? d.fait_le.getTime() : null
      const ponctuelle = t.categorie === 'ponctuelle'
      const evts = ponctuelle ? evenements.filter((e) => e.idtache === t.id) : []
      const abandon = evts.filter((e) => e.type === 'abandon').at(-1)
      return {
        id: t.id,
        libelle: t.libelle,
        description: t.description,
        categorie: t.categorie,
        frequence_jours: t.frequence_jours,
        nb_realisations: d?.nb ?? 0,
        derniere_ms: faitMs,
        age_jours: ageJours(faitMs, now),
        niveau: ponctuelle
          ? moi
            ? niveauPonctuelle(ponctuelleDe(t), moi, today)
            : null
          : niveauTache(t.frequence_jours, faitMs, now),
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
        // Ponctuelle only (null / 0 / [] on a récurrente).
        groupe: t.groupe,
        echeance: t.echeance,
        cree_par: ponctuelle ? membre(dir, t.cree_par) : null,
        // The Ponctuelles tab lists the régleurs' requests first (Vincent 2026-11-10).
        cree_par_regleur: ponctuelle ? dir.get(t.cree_par)?.regleur === 1 : null,
        cree_le_ms: t.cree_le.getTime(),
        cloture: t.cloture,
        cloturee_le_ms: t.cloturee_le?.getTime() ?? null,
        cloturee_par: t.cloturee_par !== null ? membre(dir, t.cloturee_par) : null,
        motif_abandon: abandon ? libelleMotif(abandon.motif_code, abandon.motif, MOTIFS_ABANDON) : null,
        nb_reports: evts.filter((e) => e.type === 'report').length,
        actions: ponctuelle && moi ? actionsPonctuelle(ponctuelleDe(t), moi) : [],
      }
    })
    const ponctuelles = out
      .filter((t) => t.categorie === 'ponctuelle')
      .sort((a, b) => {
        // Open before closed; red first; then the nearest due date (undated first).
        const rang = (t: typeof a) => (t.cloture !== null ? 2 : t.niveau === 'rouge' ? 0 : 1)
        return (
          rang(a) - rang(b) ||
          (a.echeance ?? '').localeCompare(b.echeance ?? '') ||
          a.libelle.localeCompare(b.libelle, 'fr')
        )
      })
    res.json([...ponctuelles, ...trierTaches(out.filter((t) => t.categorie === 'recurrente'))])
  } catch (err) {
    console.error('Error fetching atelier taches:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** « Pas eu le temps », « <texte> » for « autre », or « <label> : <texte> ». */
function libelleMotif(code: string | null, texte: string, codes: Record<string, string>): string {
  const base = code && codes[code] ? codes[code] : ''
  if (!texte) return base
  return code === 'autre' || !base ? texte : `${base} : ${texte}`
}

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
    // null = no frequency (the tag stays grey). Récurrente only.
    frequence_jours: z.number().int().min(1).max(FREQUENCE_MAX).nullable().default(null),
    categorie: z.enum(['recurrente', 'ponctuelle']).default('recurrente'),
    // Ponctuelle only: the group it is addressed to, and its due date (ISO).
    groupe: z.enum(['bonnetiers', 'regleurs']).nullable().default(null),
    echeance: z.string().nullable().default(null),
  })
  .strict()

/** A ponctuelle, row-locked for the transaction; null when absent or not one. */
async function lirePonctuelle(tx: ReturnType<typeof mpsPg>, id: number): Promise<TacheRow | null> {
  const [t] = await tx<TacheRow[]>`
    SELECT id, libelle, description, frequence_jours, categorie, groupe,
           to_char(echeance, 'YYYY-MM-DD') AS echeance, cree_par, cloture, cloturee_le, cloturee_par
    FROM tache_atelier WHERE id = ${id} AND archivee_le IS NULL FOR UPDATE`
  return t && t.categorie === 'ponctuelle' ? t : null
}

/** A refusal raised inside a transaction (rolls it back), answered as is. */
class Refus extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

function envoyerRefus(res: Response, e: unknown): boolean {
  if (!(e instanceof Refus)) return false
  res.status(e.status).json({ error: e.code, message: e.message })
  return true
}

const DEJA_CLOSE = 'Cette tâche est déjà close.'

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
    const b = parsed.data
    if (b.categorie === 'ponctuelle') {
      const who = await gateSaisie(req, res, b.IDbonnetier)
      if (!who) return
      if (b.groupe === null || b.frequence_jours !== null) {
        res.status(400).json({ error: 'ponctuelle_invalide', message: 'Une tâche ponctuelle a un destinataire et pas de fréquence.' })
        return
      }
      const regle = echeanceACreation(lecteurDe(who), b.groupe)
      if (regle === 'interdite' && b.echeance !== null) {
        res.status(400).json({ error: 'echeance_regleurs', message: 'Ce sont les régleurs qui fixent l’échéance de cette demande.' })
        return
      }
      if (regle === 'requise' && (b.echeance === null || !echeanceValide(b.echeance, aujourdhuiParis(Date.now())))) {
        res.status(400).json({ error: 'echeance_invalide', message: 'Choisissez une échéance dans les 30 prochains jours.' })
        return
      }
      const [row] = await mpsPg()<{ id: number }[]>`
        INSERT INTO tache_atelier (libelle, description, cree_par, categorie, groupe, echeance)
        VALUES (${b.libelle}, ${b.description}, ${who.id}, 'ponctuelle', ${b.groupe}, ${b.echeance})
        RETURNING id`
      res.status(201).json({ id: row.id })
      return
    }
    if (b.groupe !== null || b.echeance !== null) {
      res.status(400).json({ error: 'recurrente_invalide', message: 'Une tâche récurrente n’a ni destinataire ni échéance.' })
      return
    }
    const who = await gateRegleur(req, res, b.IDbonnetier)
    if (!who) return
    const [row] = await mpsPg()<{ id: number }[]>`
      INSERT INTO tache_atelier (libelle, description, frequence_jours, cree_par)
      VALUES (${b.libelle}, ${b.description}, ${b.frequence_jours}, ${who.id})
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
    const sql = mpsPg()
    const [cible] = await sql<{ categorie: string }[]>`
      SELECT categorie FROM tache_atelier WHERE id = ${id} AND archivee_le IS NULL`
    if (!cible) {
      res.status(404).json({ error: 'tache_introuvable' })
      return
    }
    if (cible.categorie === 'ponctuelle') {
      // Its creator fixes the wording; nothing else changes here (the date has
      // its own route, with its motif).
      const who = await gateSaisie(req, res, parsed.data.IDbonnetier)
      if (!who) return
      try {
        await sql.begin(async (t) => {
          const tx = t as unknown as typeof sql
          const p = await lirePonctuelle(tx, id)
          if (!p) throw new Refus(404, 'tache_introuvable', 'Cette tâche n’existe plus.')
          if (!actionsPonctuelle(ponctuelleDe(p), lecteurDe(who)).includes('modifier')) {
            throw new Refus(403, 'modification_interdite', p.cloture ? DEJA_CLOSE : 'Seul l’auteur de la demande peut la modifier.')
          }
          await tx`UPDATE tache_atelier SET libelle = ${parsed.data.libelle}, description = ${parsed.data.description},
                   modifie_le = now() WHERE id = ${id}`
        })
      } catch (e) {
        if (envoyerRefus(res, e)) return
        throw e
      }
      res.json({ ok: true })
      return
    }
    const who = await gateRegleur(req, res, parsed.data.IDbonnetier)
    if (!who) return
    const rows = await sql`
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
    // A ponctuelle is never deleted: it is abandoned, with its motif.
    const rows = await mpsPg()`
      UPDATE tache_atelier SET archivee_le = now(), archivee_par = ${who.id}
      WHERE id = ${id} AND archivee_le IS NULL AND categorie = 'recurrente'
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
      const [tache] = await tx<{ categorie: string }[]>`
        SELECT categorie FROM tache_atelier WHERE id = ${id} AND archivee_le IS NULL FOR UPDATE`
      if (!tache) return null
      if (tache.categorie === 'ponctuelle') {
        // « Fait » closes a ponctuelle; its réalisation keeps who did it.
        const p = await lirePonctuelle(tx, id)
        if (!p || !actionsPonctuelle(ponctuelleDe(p), lecteurDe(who)).includes('fait')) {
          return new Refus(409, 'fait_impossible', p?.cloture ? DEJA_CLOSE : 'Cette demande ne vous est pas adressée.')
        }
        await tx`UPDATE tache_atelier SET cloture = 'faite', cloturee_le = now(), cloturee_par = ${who.id} WHERE id = ${id}`
      }
      const [r] = await tx<{ id: number; fait_le: Date }[]>`
        INSERT INTO tache_atelier_realisation (idtache, declare_par)
        VALUES (${id}, ${who.id}) RETURNING id, fait_le`
      for (const b of equipe) {
        await tx`INSERT INTO tache_atelier_participant (idrealisation, idbonnetier) VALUES (${r.id}, ${b})`
      }
      return r
    })
    if (created instanceof Refus) {
      envoyerRefus(res, created)
      return
    }
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
    await sql.begin(async (t) => {
      const tx = t as unknown as typeof sql
      await tx`DELETE FROM tache_atelier_realisation WHERE id = ${rid}`
      // A ponctuelle closed by this « Fait » opens again (a wrong tap).
      await tx`UPDATE tache_atelier SET cloture = NULL, cloturee_le = NULL, cloturee_par = NULL
               WHERE id = ${id} AND categorie = 'ponctuelle' AND cloture = 'faite'`
    })
    res.status(204).end()
  } catch (err) {
    console.error('Error deleting atelier tache realisation:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Ponctuelles: date, postpone, abandon ──────────────────

const echeanceBody = z
  .object({
    IDbonnetier: z.number().int().positive(),
    echeance: z.string(),
    // Required when the request already had a date (a postponement).
    motif_code: z.string().nullable().default(null),
    motif: z.string().trim().max(MOTIF_MAX).default(''),
  })
  .strict()

// First date of an undated request (a régleur, no motif), or a postponement
// (new date + motif, kept as an event).
atelierTachesRouter.post('/:id/echeance', async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id)
    if (id === null) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const parsed = echeanceBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const b = parsed.data
    const who = await gateSaisie(req, res, b.IDbonnetier)
    if (!who) return
    if (!echeanceValide(b.echeance, aujourdhuiParis(Date.now()))) {
      res.status(400).json({ error: 'echeance_invalide', message: 'Choisissez une échéance dans les 30 prochains jours.' })
      return
    }
    const sql = mpsPg()
    try {
      await sql.begin(async (t) => {
        const tx = t as unknown as typeof sql
        const p = await lirePonctuelle(tx, id)
        if (!p) throw new Refus(404, 'tache_introuvable', 'Cette tâche n’existe plus.')
        const actions = actionsPonctuelle(ponctuelleDe(p), lecteurDe(who))
        const premiere = p.echeance === null
        if (!actions.includes(premiere ? 'echeance' : 'reporter')) {
          throw new Refus(
            403,
            'echeance_interdite',
            p.cloture ? DEJA_CLOSE : premiere ? 'Ce sont les régleurs qui fixent cette échéance.' : 'Cette demande ne vous est pas adressée.',
          )
        }
        if (!premiere) {
          if (b.echeance === p.echeance) throw new Refus(400, 'echeance_inchangee', 'Choisissez une autre date.')
          if (b.motif_code === null || !motifValide(b.motif_code, b.motif, MOTIFS_REPORT)) {
            throw new Refus(400, 'motif_requis', 'Dites pourquoi la tâche est repoussée.')
          }
        }
        await tx`UPDATE tache_atelier SET echeance = ${b.echeance} WHERE id = ${id}`
        await tx`
          INSERT INTO tache_atelier_evenement (idtache, par, type, echeance_avant, echeance_apres, motif_code, motif)
          VALUES (${id}, ${who.id}, ${premiere ? 'echeance' : 'report'}, ${p.echeance}, ${b.echeance},
                  ${premiere ? null : b.motif_code}, ${premiere ? '' : b.motif})`
      })
    } catch (e) {
      if (envoyerRefus(res, e)) return
      throw e
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error dating atelier tache:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const abandonBody = z
  .object({
    IDbonnetier: z.number().int().positive(),
    motif_code: z.string(),
    motif: z.string().trim().max(MOTIF_MAX).default(''),
  })
  .strict()

atelierTachesRouter.post('/:id/abandon', async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id)
    if (id === null) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const parsed = abandonBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const b = parsed.data
    const who = await gateSaisie(req, res, b.IDbonnetier)
    if (!who) return
    if (!motifValide(b.motif_code, b.motif, MOTIFS_ABANDON)) {
      res.status(400).json({ error: 'motif_requis', message: 'Dites pourquoi la tâche est abandonnée.' })
      return
    }
    const sql = mpsPg()
    try {
      await sql.begin(async (t) => {
        const tx = t as unknown as typeof sql
        const p = await lirePonctuelle(tx, id)
        if (!p) throw new Refus(404, 'tache_introuvable', 'Cette tâche n’existe plus.')
        if (!actionsPonctuelle(ponctuelleDe(p), lecteurDe(who)).includes('abandonner')) {
          throw new Refus(403, 'abandon_interdit', p.cloture ? DEJA_CLOSE : 'Cette demande ne vous est pas adressée.')
        }
        await tx`UPDATE tache_atelier SET cloture = 'abandonnee', cloturee_le = now(), cloturee_par = ${who.id} WHERE id = ${id}`
        await tx`
          INSERT INTO tache_atelier_evenement (idtache, par, type, echeance_avant, motif_code, motif)
          VALUES (${id}, ${who.id}, 'abandon', ${p.echeance}, ${b.motif_code}, ${b.motif})`
      })
    } catch (e) {
      if (envoyerRefus(res, e)) return
      throw e
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error abandoning atelier tache:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
