// Atelier > Maintenance — TRM knitting-machine upkeep (port of the legacy
// FI_Maintenance.wdw, reworked with Mickaël on 2026-10-01).
//
// Like the ordre_fabrication family, `machine` and `operation_maintenance` have
// NO IDsociete column: the knitting machines ARE Tricotage Malterre. There is
// nothing to scope, and nothing here is shared with an ETM screen.
//
// Native PostgreSQL (lib/mps-pg.ts) since the 2026-10-01 rework — the HFSQL
// accent folding the first version needed is gone with HFSQL.
//
// ── What a métier carries ──────────────────────────────────────────────────
//   Description                 → machine.commentaire  ⚠️ NOT `nom` (2E: nom='2E',
//                                                        commentaire='Terrot')
//   Simple / Double Fonture     → double_fonture
//   Rouloir · Dernière visite   → date_maintenance
//   Rouloir · Commentaire       → observation_maintenace   (typo is the real name)
//   Garniture (six items)       → nett_platines / nett_cylindre / nett_plateau /
//                                 chg_aiguilles / chg_platines / pulsonique, each
//                                 with comm_* (the pulsonique one is comm_pulsonque)
//   Entretiens périodiques      → operation_maintenance (portee = 'metier') ×
//                                 operation_maintenance_metier (one date per
//                                 métier) — Ventilateurs, Couronnes, Fuites d'air
// And for each of them, the kg knitted since (lib/maintenance-trm.ts).
//
// The atelier keeps its own dated items (portee = 'atelier': the building's air
// leaks, more to come) — /operations, listed apart from any métier.
//
// The machine UPDATE names ONLY the maintenance columns. `nom`, `jauge`,
// `diametre`, `nb_chutes*`, `vitesse`, `elasthanne`, `adresse_automate`,
// `connecte`, `archive` belong to FEN_Gestion_des_machines (not ported).

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import type { Sql } from 'postgres'
import { z } from 'zod'
import { mpsPg } from '../lib/mps-pg.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { trmUserHasPermission } from '../lib/permissions-trm.js'
import {
  etatPeriodique,
  etatRouloir,
  indexKg,
  kgDepuis,
  monthsSince,
  pireEtat,
  round2,
  type KgIndex,
  type MaintenanceEtat,
} from '../lib/maintenance-trm.js'

export const maintenanceTrmRouter: RouterType = Router()

/**
 * Kg knitted after which a métier's rouloir needs its next visit. Measured in
 * 2026-08 against the legacy screen (14/14 « Rouloir dans N Kgs » values), when
 * the counter still summed OF quantities; since 2026-10-01 it applies to the
 * weighed rolls (lib/maintenance-trm.ts), within ~10 % of the old measure.
 * ⚠️ A module constant applied to every past visit: if it ever changes, date
 * it like BAREMES_PRIME (lib/bareme-prime-trm.ts), never edit it in place.
 */
export const MAINTENANCE_ROULOIR_SEUIL_KG = 15_000

// The six garniture items, in the legacy form's top-to-bottom order.
const GARNITURE = [
  { key: 'nettPlatines', date: 'nett_platines', comm: 'comm_nett_platines' },
  { key: 'nettCylindre', date: 'nett_cylindre', comm: 'comm_nett_cylindre' },
  { key: 'nettPlateau', date: 'nett_plateau', comm: 'comm_nett_plateau' },
  { key: 'chgAiguilles', date: 'chg_aiguilles', comm: 'comm_chg_aiguilles' },
  { key: 'chgPlatines', date: 'chg_platines', comm: 'comm_chg_platines' },
  { key: 'pulsonique', date: 'pulsonique', comm: 'comm_pulsonque' },
] as const

type GarnitureKey = (typeof GARNITURE)[number]['key']

const ymd = (col: string) => `to_char(${col}, 'YYYYMMDD') AS ${col}`

function text(v: unknown): string | null {
  const s = String(v ?? '').replace(/\0/g, '').trim()
  return s === '' ? null : s
}

function hf(v: unknown): string | null {
  const s = String(v ?? '').trim()
  return /^\d{8}$/.test(s) && s !== '00000000' && s > '19000101' ? s : null
}

/** 'YYYYMMDD' → 'YYYY-MM-DD' for a PG date parameter, or null. */
function pgDate(v: string | null | undefined): string | null {
  return v && /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null
}

function todayHf(): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

// ════════════════════════════════════════════════════════
//  Readers
// ════════════════════════════════════════════════════════

type Row = Record<string, unknown>

async function selectMachines(sql: Sql, id?: number): Promise<Row[]> {
  const cols = [
    'idmachine', 'emplacement', 'nom', 'commentaire', 'double_fonture', 'archive',
    ymd('date_maintenance'), 'observation_maintenace',
    ...GARNITURE.flatMap((g) => [ymd(g.date), g.comm]),
    'jauge', 'diametre', 'nb_chutes', 'nb_chutes_max', 'elasthanne', 'vitesse',
    'adresse_automate', 'connecte',
  ].join(', ')
  return id === undefined
    ? sql.unsafe(`SELECT ${cols} FROM machine`)
    : sql.unsafe(`SELECT ${cols} FROM machine WHERE idmachine = $1`, [id])
}

interface Operation {
  id: number
  nom: string
  portee: 'atelier' | 'metier'
  frequenceMois: number
  date: string | null
}

async function selectOperations(sql: Sql): Promise<Operation[]> {
  const rows = await sql<Row[]>`
    SELECT idoperation_maintenance, nom::text AS nom, portee, frequence,
           to_char(date_derniere, 'YYYYMMDD') AS date_derniere
    FROM operation_maintenance WHERE NOT archive
    ORDER BY idoperation_maintenance`
  return rows.map((r) => ({
    id: Number(r.idoperation_maintenance),
    nom: text(r.nom) ?? '',
    portee: r.portee === 'metier' ? 'metier' : 'atelier',
    frequenceMois: Number(r.frequence) || 0,
    date: hf(r.date_derniere),
  }))
}

/** (op, machine) → its date + comment. */
async function selectOperationsMetier(sql: Sql, idmachine?: number) {
  const rows = idmachine === undefined
    ? await sql<Row[]>`SELECT idoperation_maintenance, idmachine, to_char(date_derniere, 'YYYYMMDD') AS d, commentaire FROM operation_maintenance_metier`
    : await sql<Row[]>`SELECT idoperation_maintenance, idmachine, to_char(date_derniere, 'YYYYMMDD') AS d, commentaire FROM operation_maintenance_metier WHERE idmachine = ${idmachine}`
  const out = new Map<string, { date: string | null; commentaire: string | null }>()
  for (const r of rows) {
    out.set(`${Number(r.idoperation_maintenance)}:${Number(r.idmachine)}`, { date: hf(r.d), commentaire: text(r.commentaire) })
  }
  return out
}

/** Weighed rolls per métier and day — one grouped pass for the whole parc. */
async function selectKg(sql: Sql, idmachine?: number): Promise<Map<number, KgIndex>> {
  const rows = idmachine === undefined
    ? await sql<Row[]>`
        SELECT o.idmachine, to_char(s.date_saisie, 'YYYYMMDD') AS jour, SUM(s.poids) AS kg
        FROM stock_ecru s JOIN ordre_fabrication o ON o.idordre_fabrication = s.idordre_fabrication
        WHERE s.idordre_fabrication > 0 AND s.date_saisie IS NOT NULL
        GROUP BY 1, 2`
    : await sql<Row[]>`
        SELECT o.idmachine, to_char(s.date_saisie, 'YYYYMMDD') AS jour, SUM(s.poids) AS kg
        FROM stock_ecru s JOIN ordre_fabrication o ON o.idordre_fabrication = s.idordre_fabrication
        WHERE s.idordre_fabrication > 0 AND s.date_saisie IS NOT NULL AND o.idmachine = ${idmachine}
        GROUP BY 1, 2`
  const per = new Map<number, { jour: string; kg: number }[]>()
  for (const r of rows) {
    const id = Number(r.idmachine)
    if (!per.has(id)) per.set(id, [])
    per.get(id)!.push({ jour: String(r.jour ?? ''), kg: Number(r.kg) || 0 })
  }
  return new Map([...per].map(([id, list]) => [id, indexKg(list)]))
}

function shapeMetier(
  m: Row,
  kg: KgIndex | undefined,
  ops: Operation[],
  opsMetier: Map<string, { date: string | null; commentaire: string | null }>,
) {
  const id = Number(m.idmachine)
  const visite = hf(m.date_maintenance)
  const produitKg = kgDepuis(kg, visite) ?? 0
  const ratio = produitKg / MAINTENANCE_ROULOIR_SEUIL_KG
  const rouloirEtat = etatRouloir(ratio, visite !== null)

  const garniture = Object.fromEntries(
    GARNITURE.map((g) => {
      const date = hf(m[g.date])
      return [g.key, { date, commentaire: text(m[g.comm]), kgDepuis: kgDepuis(kg, date) }]
    }),
  ) as Record<GarnitureKey, { date: string | null; commentaire: string | null; kgDepuis: number | null }>

  const entretiens = ops
    .filter((o) => o.portee === 'metier')
    .map((o) => {
      const slot = opsMetier.get(`${o.id}:${id}`) ?? { date: null, commentaire: null }
      const mois = monthsSince(slot.date)
      const { ratio: r, etat } = etatPeriodique(mois, o.frequenceMois)
      return {
        id: o.id,
        nom: o.nom,
        frequenceMois: o.frequenceMois,
        date: slot.date,
        commentaire: slot.commentaire,
        moisEcoules: mois,
        ratio: r,
        etat,
        kgDepuis: kgDepuis(kg, slot.date),
      }
    })

  const etat = pireEtat([rouloirEtat, ...entretiens.map((e) => e.etat)])
  const aFaire = [
    ...(rouloirEtat === 'due' ? ['Rouloir'] : []),
    ...entretiens.filter((e) => e.etat === 'due').map((e) => e.nom),
  ]

  return {
    id,
    emplacement: text(m.emplacement) ?? '',
    nom: text(m.nom) ?? '',
    description: text(m.commentaire),
    doubleFonture: Number(m.double_fonture) === 1,
    archive: Number(m.archive) === 1,
    etat: etat as MaintenanceEtat,
    aFaire,
    rouloir: {
      derniereVisite: visite,
      commentaire: text(m.observation_maintenace),
      produitKg: round2(produitKg),
      restantKg: round2(Math.max(0, MAINTENANCE_ROULOIR_SEUIL_KG - produitKg)),
      ratio: round2(ratio),
      etat: rouloirEtat,
    },
    garniture,
    entretiens,
    // Read-only: these belong to FEN_Gestion_des_machines, never written here.
    caracteristiques: {
      jauge: Number(m.jauge) || 0,
      diametre: Number(m.diametre) || 0,
      nbChutes: Number(m.nb_chutes) || 0,
      nbChutesMax: Number(m.nb_chutes_max) || 0,
      elasthanne: Number(m.elasthanne) === 1,
      vitesse: Number(m.vitesse) || 0,
      adresseAutomate: m.adresse_automate == null ? null : Number(m.adresse_automate),
      connecte: Number(m.connecte) === 1,
    },
  }
}

async function loadMetier(sql: Sql, id: number) {
  const [m] = await selectMachines(sql, id)
  if (!m) return null
  const [kg, ops, opsMetier] = await Promise.all([selectKg(sql, id), selectOperations(sql), selectOperationsMetier(sql, id)])
  return shapeMetier(m, kg.get(id), ops, opsMetier)
}

const RANG_ETAT: Record<string, number> = { due: 0, proche: 1, ok: 2, inconnu: 3 }

// ════════════════════════════════════════════════════════
//  GET /metiers — the left list + every fiche in one payload
// ════════════════════════════════════════════════════════

maintenanceTrmRouter.get('/metiers', async (_req: Request, res: Response) => {
  try {
    const sql = mpsPg()
    const [machines, kg, ops, opsMetier] = await Promise.all([
      selectMachines(sql),
      selectKg(sql),
      selectOperations(sql),
      selectOperationsMetier(sql),
    ])
    const metiers = machines
      .filter((m) => Number(m.archive) !== 1)
      .map((m) => shapeMetier(m, kg.get(Number(m.idmachine)), ops, opsMetier))
      // Most urgent first: worst state, then least rouloir kg left, then code.
      .sort(
        (a, b) =>
          RANG_ETAT[a.etat] - RANG_ETAT[b.etat] ||
          a.rouloir.restantKg - b.rouloir.restantKg ||
          a.emplacement.localeCompare(b.emplacement, 'fr'),
      )
    res.json({ seuilRouloirKg: MAINTENANCE_ROULOIR_SEUIL_KG, metiers })
  } catch (err) {
    console.error('GET /maintenance-trm/metiers failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  Write guard
// ════════════════════════════════════════════════════════

/** Guard for every write path. Reads stay open to anyone holding the Atelier
 *  menu. Sends the 401/403 itself and returns false when not allowed. */
async function requireEditMaintenance(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const allowed = await trmUserHasPermission(req.userId, isEffectiveAdmin(req), 'edit_maintenance')
  if (!allowed) {
    res.status(403).json({ error: 'permission denied: edit_maintenance' })
    return false
  }
  return true
}

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** 404 / 409 for a métier that cannot be written; null when it can. */
async function machineEcrivable(sql: Sql, id: number, res: Response): Promise<boolean> {
  const [m] = await sql<{ archive: number }[]>`SELECT archive FROM machine WHERE idmachine = ${id}`
  if (!m) {
    res.status(404).json({ error: 'métier introuvable' })
    return false
  }
  if (Number(m.archive) === 1) {
    res.status(409).json({
      error: 'machine_archivee',
      message: "Ce métier est archivé : sa fiche de maintenance n'est plus modifiable.",
    })
    return false
  }
  return true
}

async function upsertOperationMetier(
  sql: Sql,
  opId: number,
  idmachine: number,
  date: string | null,
  commentaire: string | null,
  userId: number,
) {
  await sql`
    INSERT INTO operation_maintenance_metier
      (idoperation_maintenance, idmachine, date_derniere, commentaire, modifie_le, modifie_par)
    VALUES (${opId}, ${idmachine}, ${pgDate(date)}, ${commentaire}, now(), ${userId})
    ON CONFLICT (idoperation_maintenance, idmachine) DO UPDATE
      SET date_derniere = EXCLUDED.date_derniere, commentaire = EXCLUDED.commentaire,
          modifie_le = now(), modifie_par = EXCLUDED.modifie_par`
}

// ════════════════════════════════════════════════════════
//  PUT /metiers/:id — the fiche
// ════════════════════════════════════════════════════════

const hfDate = z.string().regex(/^\d{8}$/, 'attendu YYYYMMDD').nullable()
const comment = z.string().max(4000).nullable().optional().default(null)
const slotBody = z.object({ date: hfDate.optional().default(null), commentaire: comment })

const metierBody = z.object({
  description: comment,
  doubleFonture: z.boolean(),
  rouloir: z.object({ derniereVisite: hfDate.optional().default(null), commentaire: comment }),
  garniture: z.object(
    Object.fromEntries(GARNITURE.map((g) => [g.key, slotBody])) as Record<GarnitureKey, typeof slotBody>,
  ),
  entretiens: z
    .array(z.object({ id: z.number().int().positive(), date: hfDate.optional().default(null), commentaire: comment }))
    .optional()
    .default([]),
})

maintenanceTrmRouter.put('/metiers/:id', async (req: Request, res: Response) => {
  if (!(await requireEditMaintenance(req, res))) return
  try {
    const id = parseId(req.params.id)
    if (id === null) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const parsed = metierBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const body = parsed.data
    const sql = mpsPg()
    if (!(await machineEcrivable(sql, id, res))) return

    const ops = await selectOperations(sql)
    const metierOps = new Set(ops.filter((o) => o.portee === 'metier').map((o) => o.id))
    const unknown = body.entretiens.find((e) => !metierOps.has(e.id))
    if (unknown) {
      res.status(400).json({ error: 'operation_inconnue', message: `Entretien ${unknown.id} inconnu.` })
      return
    }

    const g = body.garniture
    const nul = (s: string | null) => (s && s.trim() !== '' ? s.trim() : null)
    await sql.begin(async (tx) => {
      const t = tx as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
      await t`
        UPDATE machine SET
          commentaire            = ${nul(body.description)},
          double_fonture         = ${body.doubleFonture ? 1 : 0},
          date_maintenance       = ${pgDate(body.rouloir.derniereVisite)},
          observation_maintenace = ${nul(body.rouloir.commentaire)},
          nett_platines          = ${pgDate(g.nettPlatines.date)},
          comm_nett_platines     = ${nul(g.nettPlatines.commentaire)},
          nett_cylindre          = ${pgDate(g.nettCylindre.date)},
          comm_nett_cylindre     = ${nul(g.nettCylindre.commentaire)},
          nett_plateau           = ${pgDate(g.nettPlateau.date)},
          comm_nett_plateau      = ${nul(g.nettPlateau.commentaire)},
          chg_aiguilles          = ${pgDate(g.chgAiguilles.date)},
          comm_chg_aiguilles     = ${nul(g.chgAiguilles.commentaire)},
          chg_platines           = ${pgDate(g.chgPlatines.date)},
          comm_chg_platines      = ${nul(g.chgPlatines.commentaire)},
          pulsonique             = ${pgDate(g.pulsonique.date)},
          comm_pulsonque         = ${nul(g.pulsonique.commentaire)}
        WHERE idmachine = ${id}`
      for (const e of body.entretiens) {
        await upsertOperationMetier(t, e.id, id, e.date, nul(e.commentaire), req.userId!)
      }
    })

    res.json({ seuilRouloirKg: MAINTENANCE_ROULOIR_SEUIL_KG, metier: await loadMetier(sql, id) })
  } catch (err) {
    console.error('PUT /maintenance-trm/metiers/:id failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  « Effectué ce jour » on one item of one métier
// ════════════════════════════════════════════════════════

const faitBody = z.object({
  /** 'rouloir', a garniture key, or an entretien id. */
  item: z.union([z.literal('rouloir'), z.enum(GARNITURE.map((g) => g.key) as [GarnitureKey, ...GarnitureKey[]]), z.number().int().positive()]),
})

maintenanceTrmRouter.post('/metiers/:id/fait', async (req: Request, res: Response) => {
  if (!(await requireEditMaintenance(req, res))) return
  try {
    const id = parseId(req.params.id)
    const parsed = faitBody.safeParse(req.body)
    if (id === null || !parsed.success) {
      res.status(400).json({ error: 'Validation failed' })
      return
    }
    const sql = mpsPg()
    if (!(await machineEcrivable(sql, id, res))) return
    const today = pgDate(todayHf())
    const item = parsed.data.item
    if (item === 'rouloir') {
      await sql`UPDATE machine SET date_maintenance = ${today} WHERE idmachine = ${id}`
    } else if (typeof item === 'string') {
      const col = GARNITURE.find((g) => g.key === item)!.date
      await sql.unsafe(`UPDATE machine SET ${col} = $1 WHERE idmachine = $2`, [today, id])
    } else {
      const op = (await selectOperations(sql)).find((o) => o.id === item && o.portee === 'metier')
      if (!op) {
        res.status(404).json({ error: 'opération introuvable' })
        return
      }
      // Keeps the stored comment: « done today » is about the date only.
      const current = (await selectOperationsMetier(sql, id)).get(`${item}:${id}`)
      await upsertOperationMetier(sql, item, id, todayHf(), current?.commentaire ?? null, req.userId!)
    }
    res.json({ seuilRouloirKg: MAINTENANCE_ROULOIR_SEUIL_KG, metier: await loadMetier(sql, id) })
  } catch (err) {
    console.error('POST /maintenance-trm/metiers/:id/fait failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  The item catalogue + the atelier's own items
// ════════════════════════════════════════════════════════

async function operationsPayload(sql: Sql) {
  const operations = (await selectOperations(sql)).map((o) => {
    const mois = o.portee === 'atelier' ? monthsSince(o.date) : null
    const { ratio, etat } = o.portee === 'atelier' ? etatPeriodique(mois, o.frequenceMois) : { ratio: null, etat: 'inconnu' }
    return {
      id: o.id,
      nom: o.nom,
      portee: o.portee,
      frequenceMois: o.frequenceMois,
      derniereMaintenance: o.portee === 'atelier' ? o.date : null,
      moisEcoules: mois,
      ratio,
      etat,
    }
  })
  return { operations }
}

maintenanceTrmRouter.get('/operations', async (_req: Request, res: Response) => {
  try {
    res.json(await operationsPayload(mpsPg()))
  } catch (err) {
    console.error('GET /maintenance-trm/operations failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const operationBody = z.object({
  nom: z.string().trim().min(1).max(100),
  frequenceMois: z.number().int().min(1).max(120),
  portee: z.enum(['atelier', 'metier']),
}).strict()

maintenanceTrmRouter.post('/operations', async (req: Request, res: Response) => {
  if (!(await requireEditMaintenance(req, res))) return
  const parsed = operationBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
    return
  }
  try {
    const sql = mpsPg()
    const { nom, frequenceMois, portee } = parsed.data
    const [dup] = await sql`SELECT 1 FROM operation_maintenance WHERE NOT archive AND portee = ${portee} AND nom = ${nom}`
    if (dup) {
      res.status(409).json({ error: 'operation_existante', message: `« ${nom} » existe déjà.` })
      return
    }
    await sql.begin(async (tx) => {
      const t = tx as unknown as Sql
      await t`LOCK TABLE operation_maintenance IN EXCLUSIVE MODE`
      await t`
        INSERT INTO operation_maintenance (idoperation_maintenance, nom, date_derniere, frequence, portee)
        SELECT COALESCE(MAX(idoperation_maintenance), 0) + 1, ${nom}, NULL, ${frequenceMois}, ${portee}
        FROM operation_maintenance`
    })
    res.status(201).json(await operationsPayload(sql))
  } catch (err) {
    console.error('POST /maintenance-trm/operations failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

maintenanceTrmRouter.put('/operations/:id', async (req: Request, res: Response) => {
  if (!(await requireEditMaintenance(req, res))) return
  const id = parseId(req.params.id)
  const parsed = operationBody.omit({ portee: true }).safeParse(req.body)
  if (id === null || !parsed.success) {
    res.status(400).json({ error: 'Validation failed' })
    return
  }
  try {
    const sql = mpsPg()
    const r = await sql`
      UPDATE operation_maintenance SET nom = ${parsed.data.nom}, frequence = ${parsed.data.frequenceMois}
      WHERE idoperation_maintenance = ${id} AND NOT archive`
    if (r.count === 0) {
      res.status(404).json({ error: 'opération introuvable' })
      return
    }
    res.json(await operationsPayload(sql))
  } catch (err) {
    console.error('PUT /maintenance-trm/operations/:id failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Archives (never deletes): the per-métier dates stay in the base. */
maintenanceTrmRouter.delete('/operations/:id', async (req: Request, res: Response) => {
  if (!(await requireEditMaintenance(req, res))) return
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  try {
    const sql = mpsPg()
    const r = await sql`UPDATE operation_maintenance SET archive = true WHERE idoperation_maintenance = ${id} AND NOT archive`
    if (r.count === 0) {
      res.status(404).json({ error: 'opération introuvable' })
      return
    }
    res.json(await operationsPayload(sql))
  } catch (err) {
    console.error('DELETE /maintenance-trm/operations/:id failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** « Effectué ce jour » on an atelier item. A per-métier item is done métier
 *  by métier (POST /metiers/:id/fait), never all at once. */
maintenanceTrmRouter.post('/operations/:id/reset', async (req: Request, res: Response) => {
  if (!(await requireEditMaintenance(req, res))) return
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  try {
    const sql = mpsPg()
    const op = (await selectOperations(sql)).find((o) => o.id === id)
    if (!op) {
      res.status(404).json({ error: 'opération introuvable' })
      return
    }
    if (op.portee !== 'atelier') {
      res.status(409).json({ error: 'operation_par_metier', message: 'Cet entretien se fait métier par métier.' })
      return
    }
    await sql`UPDATE operation_maintenance SET date_derniere = ${pgDate(todayHf())} WHERE idoperation_maintenance = ${id}`
    res.json(await operationsPayload(sql))
  } catch (err) {
    console.error('POST /maintenance-trm/operations/:id/reset failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
