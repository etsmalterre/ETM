// /api/planning-prod-trm — TRM Production › Planning (LIVA #1250).
// Engine: lib/planning-prod-trm.ts (pure, tested). Loader + the two small
// stores: lib/planning-prod-trm-charge.ts.
//
//   GET    /                 the whole plan (métiers, segments, lines, OFs, calendar)
//   GET    /fins             per line and per commande: fin prévue + late flag
//                            (Clients › Commandes)
//   PUT    /reglage          the régime past the bonnetier planning   — edit_planning_prod
//   PUT    /lignes/:id       place a line on a métier, in an order    — edit_planning_prod
//   DELETE /lignes/:id       back to automatic placement              — edit_planning_prod
//   PUT    /of/:id           move a waiting OF / reorder a queue      — edit_of
//
// Nothing here writes a date: a move changes the métier and the order, the
// dates follow on the next read.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import type { Sql } from 'postgres'
import { mpsPg } from '../lib/mps-pg.js'
import { trmUserHasPermission } from '../lib/permissions-trm.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { rerankQueue } from '../lib/of-queue-trm.js'
import { horaireValide } from '../lib/planning-prod-trm.js'
import {
  chargerPlan, desepinglerLigne, ecrireReglage, epinglerLignes, machineCompatible, REGIMES_LIBELLES,
} from '../lib/planning-prod-trm-charge.js'

export const planningProdTrmRouter: RouterType = Router()

async function exigerConnexion(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  return true
}

async function exigerDroit(req: Request, res: Response, cle: 'edit_planning_prod' | 'edit_of'): Promise<boolean> {
  if (!(await exigerConnexion(req, res))) return false
  if (!(await trmUserHasPermission(req.userId!, isEffectiveAdmin(req), cle))) {
    res.status(403).json({ error: `permission denied: ${cle}` })
    return false
  }
  return true
}

planningProdTrmRouter.get('/', async (req: Request, res: Response) => {
  if (!(await exigerConnexion(req, res))) return
  try {
    res.json({ ...(await chargerPlan()), regimes: REGIMES_LIBELLES })
  } catch (err) {
    console.error('Error loading planning-prod-trm:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

planningProdTrmRouter.get('/fins', async (req: Request, res: Response) => {
  if (!(await exigerConnexion(req, res))) return
  try {
    const plan = await chargerPlan()
    const lignes: Record<number, { fin_prevue: number | null; en_retard: boolean; non_planifiable: boolean }> = {}
    const commandes: Record<number, { fin_prevue: number | null; en_retard: boolean; non_planifiable: boolean }> = {}
    for (const l of plan.lignes) {
      lignes[l.ligne_id] = { fin_prevue: l.fin_prevue, en_retard: l.en_retard, non_planifiable: l.non_planifiable }
      const c = commandes[l.commande_id] ?? { fin_prevue: null, en_retard: false, non_planifiable: false }
      if (l.fin_prevue !== null && (c.fin_prevue === null || l.fin_prevue > c.fin_prevue)) c.fin_prevue = l.fin_prevue
      c.en_retard ||= l.en_retard
      c.non_planifiable ||= l.non_planifiable
      commandes[l.commande_id] = c
    }
    res.json({ maintenant: plan.maintenant, reel_jusqua: plan.reel_jusqua, lignes, commandes })
  } catch (err) {
    console.error('Error loading planning-prod-trm fins:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const reglageBody = z.object({
  regime: z.enum(['3x8', '2x8', '2x7', 'custom']),
  horaires: z.array(z.unknown()).length(7).nullable().optional(),
}).strict()

planningProdTrmRouter.put('/reglage', async (req: Request, res: Response) => {
  if (!(await exigerDroit(req, res, 'edit_planning_prod'))) return
  const parsed = reglageBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
    return
  }
  const { regime } = parsed.data
  let horaires = null
  if (regime === 'custom') {
    const list = parsed.data.horaires ?? []
    if (list.length !== 7 || !list.every((h) => h === null || horaireValide(h))) {
      res.status(400).json({ error: 'horaires_invalides', message: 'Un horaire par jour, « HH:MM » à « HH:MM », ou vide.' })
      return
    }
    if (list.every((h) => h === null)) {
      res.status(400).json({ error: 'horaires_vides', message: 'Au moins un jour doit être travaillé.' })
      return
    }
    horaires = list.map((h) => (h === null ? null : { debut: (h as any).debut, fin: (h as any).fin }))
  }
  try {
    await ecrireReglage({ regime, horaires }, req.userId!)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error saving planning-prod-trm reglage:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const placerBody = z.object({
  idmachine: z.number().int().positive(),
  /** Every hand-placed line of the target métier in the wanted order, the
   *  moved one included. */
  ordre: z.array(z.number().int().positive()).min(1).max(200),
}).strict()

planningProdTrmRouter.put('/lignes/:id', async (req: Request, res: Response) => {
  if (!(await exigerDroit(req, res, 'edit_planning_prod'))) return
  const id = parseInt(req.params.id, 10)
  const parsed = placerBody.safeParse(req.body)
  if (isNaN(id) || !parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.success ? undefined : parsed.error.issues })
    return
  }
  const { idmachine } = parsed.data
  const ordre = Array.from(new Set(parsed.data.ordre))
  if (!ordre.includes(id)) {
    res.status(400).json({ error: 'ordre_incomplet', message: 'La ligne déplacée doit figurer dans l’ordre.' })
    return
  }
  try {
    // Every line of the order must be able to run on that métier — the moved
    // one is the real check, the others were already there.
    for (const ligneId of ordre) {
      if (!(await machineCompatible(ligneId, idmachine))) {
        res.status(409).json({
          error: 'machine_incompatible',
          message: 'Ce métier n’est pas réglé pour cette référence (aucun réglage métier sur la fiche écru).',
        })
        return
      }
    }
    await epinglerLignes(idmachine, ordre, req.userId!)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error placing planning-prod-trm line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

planningProdTrmRouter.delete('/lignes/:id', async (req: Request, res: Response) => {
  if (!(await exigerDroit(req, res, 'edit_planning_prod'))) return
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
  try {
    await desepinglerLigne(id)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error unpinning planning-prod-trm line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const ofBody = z.object({
  idmachine: z.number().int().positive(),
  /** The waiting OFs of the target métier in the wanted order, the moved one
   *  included. The running OF always stays first. */
  ordre: z.array(z.number().int().positive()).min(1).max(200),
}).strict()

// Same queue model as routes/of-trm.ts (priorite 1 = running, then 2..n) —
// rerankQueue() closes the gaps on the métier the OF left.
planningProdTrmRouter.put('/of/:id', async (req: Request, res: Response) => {
  if (!(await exigerDroit(req, res, 'edit_of'))) return
  const id = parseInt(req.params.id, 10)
  const parsed = ofBody.safeParse(req.body)
  if (isNaN(id) || !parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.success ? undefined : parsed.error.issues })
    return
  }
  const { idmachine } = parsed.data
  const ordre = Array.from(new Set(parsed.data.ordre))
  if (!ordre.includes(id)) {
    res.status(400).json({ error: 'ordre_incomplet', message: 'L’OF déplacé doit figurer dans l’ordre.' })
    return
  }
  const sql = mpsPg()
  try {
    const [of] = await sql<{ idmachine: number; est_actif: number; est_termine: number; idref_ecru: number }[]>`
      SELECT idmachine, est_actif, est_termine, idref_ecru FROM ordre_fabrication WHERE idordre_fabrication = ${id}`
    if (!of) { res.status(404).json({ error: 'Not found' }); return }
    if (Number(of.est_termine) === 1 || Number(of.est_actif) === 1) {
      res.status(409).json({
        error: 'of_non_deplacable',
        message: Number(of.est_actif) === 1 ? 'L’OF en cours ne se déplace pas : il tricote.' : 'OF terminé.',
      })
      return
    }
    const ancienne = Number(of.idmachine) || 0
    if (ancienne !== idmachine) {
      const [compat] = await sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM ref_ecru_machine r JOIN machine m ON m.idmachine = r.idmachine
        WHERE r.idref_ecru = ${Number(of.idref_ecru) || 0} AND r.idmachine = ${idmachine}
          AND m.archive = 0 AND r.trs_10kg_chute > 0 AND r.nb_chutes > 0`
      if (!compat || compat.n === 0) {
        res.status(409).json({
          error: 'machine_incompatible',
          message: 'Ce métier n’est pas réglé pour cette référence (aucun réglage métier sur la fiche écru).',
        })
        return
      }
    }
    // The target queue as it will be: running OF, then `ordre`, then any
    // waiting OF the client did not list (in their current order).
    const file = await sql<{ idordre_fabrication: number; est_actif: number; priorite: number }[]>`
      SELECT idordre_fabrication, est_actif, priorite FROM ordre_fabrication
      WHERE idmachine = ${idmachine} AND est_termine = 0
      ORDER BY est_actif DESC, priorite ASC, idordre_fabrication ASC`
    const enCours = file.filter((o) => Number(o.est_actif) === 1).map((o) => Number(o.idordre_fabrication))
    const enAttente = new Set(file.filter((o) => Number(o.est_actif) !== 1).map((o) => Number(o.idordre_fabrication)))
    enAttente.add(id)
    const voulu = ordre.filter((x) => enAttente.has(x))
    const reste = [...enAttente].filter((x) => !voulu.includes(x))
    const sequence = [...enCours, ...voulu, ...reste]
    await sql.begin(async (tx) => {
      const t = tx as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
      if (ancienne !== idmachine) {
        await t`UPDATE ordre_fabrication SET idmachine = ${idmachine} WHERE idordre_fabrication = ${id}`
      }
      let p = 1
      for (const ofId of sequence) {
        await t`UPDATE ordre_fabrication SET priorite = ${p} WHERE idordre_fabrication = ${ofId}`
        p++
      }
    })
    if (ancienne > 0 && ancienne !== idmachine) await rerankQueue(ancienne)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error moving OF from planning-prod-trm:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
