import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query } from '../lib/hfsql-auto.js'
import { batchRepair } from '../lib/batch-repair.js'
import { sqlText } from '../lib/clients-common.js'
import {
  rectiligneLock,
  readRefRectiligneRow,
  normalizeRefRectiligne,
  loadAllRefRectiligne,
  rectiligneReferenceTaken,
  nextRectiligneReference,
  duplicateReference,
  setRectiligneArchive,
  loadGuides,
  loadColorisGuideFils,
  loadFilLabels,
  montagesOf,
  nextMontage,
  montageReadyForColoris,
  pctFromStored,
  pctToStored,
  rectiligneUsage,
} from '../lib/rectiligne.js'
import { LINE_TYPE_RECTILIGNE } from '../lib/sst-line-kind.js'

/**
 * Tombé Métier › Références, « Rectiligne » mode (LIVA #1185) — the cols and
 * bandes catalog, shared by ETM and TRM through the one screen. Port of the
 * legacy FI_Ref_TombéMetier rectiligne branch + FEN_Gestion_Guide_Fil +
 * FEN_Gestion_Coloris_Guide_Fil; rules and HFSQL constraints in
 * lib/rectiligne.ts.
 *
 * Deliberate differences with the legacy (Vincent, 2026-09-23):
 *  - a reference or a coloris an order line points at cannot be deleted —
 *    409, archive instead (the legacy cascaded blindly; 4 sst lines point at
 *    a deleted coloris in prod);
 *  - « Dupliquer » copies the whole reference: guides, coloris AND each
 *    coloris' yarn colours (the legacy skipped coloris_guide_fil);
 *  - no Stock tab (`stock_rectiligne` was never written by anyone).
 *
 * No permission key, like the écru side (screen access only).
 */
export const referencesRectiligneRouter: RouterType = Router()

const num = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const idParam = (v: string): number => {
  const x = parseInt(v, 10)
  return Number.isInteger(x) && x > 0 ? x : 0
}

// ── Lookups ──────────────────────────────────────────────

// GET /api/references-rectiligne/lookups/refs-fil — yarn picker for a guide
referencesRectiligneRouter.get('/lookups/refs-fil', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDref_fil: number; reference: string | null }>(
      `SELECT IDref_fil, reference FROM ref_fil ORDER BY reference`,
    )
    const fixed = await batchRepair(rows, 'ref_fil', 'IDref_fil', ['reference'])
    res.json(
      fixed
        .map((r) => ({ IDref_fil: num(r.IDref_fil), reference: String(r.reference ?? '').trim() }))
        .filter((r) => r.reference !== ''),
    )
  } catch (err) {
    console.error('Error fetching rectiligne refs-fil lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/references-rectiligne/lookups/colori-fil?ref_fil= — the colours a
// guide's yarn comes in (legacy TABLE_ColorisFil: colori_fil of the ref_fil).
referencesRectiligneRouter.get('/lookups/colori-fil', async (req: Request, res: Response) => {
  try {
    const refFil = idParam(String(req.query.ref_fil ?? ''))
    if (!refFil) { res.status(400).json({ error: 'ref_fil query parameter required' }); return }
    const rows = await query<{ IDcolori_fil: number; reference: string | null }>(
      `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDref_fil = ${refFil} ORDER BY reference`,
    )
    const fixed = await batchRepair(rows, 'colori_fil', 'IDcolori_fil', ['reference'])
    res.json(fixed.map((r) => ({ IDcolori_fil: num(r.IDcolori_fil), reference: String(r.reference ?? '').trim() })))
  } catch (err) {
    console.error('Error fetching rectiligne colori-fil lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/references-rectiligne/lookups/coloris?ref= — the coloris of a
// reference, for the order-line pickers (sst and TRM).
referencesRectiligneRouter.get('/lookups/coloris', async (req: Request, res: Response) => {
  try {
    const ref = idParam(String(req.query.ref ?? ''))
    if (!ref) { res.status(400).json({ error: 'ref query parameter required' }); return }
    const rows = await query<{ IDcoloris_rectiligne: number; coloris: string | null }>(
      `SELECT IDcoloris_rectiligne, coloris FROM coloris_rectiligne WHERE IDref_rectiligne = ${ref} ORDER BY coloris`,
    )
    const fixed = await batchRepair(rows, 'coloris_rectiligne', 'IDcoloris_rectiligne', ['coloris'])
    res.json(fixed.map((r) => ({ IDcoloris_rectiligne: num(r.IDcoloris_rectiligne), coloris: String(r.coloris ?? '').trim() })))
  } catch (err) {
    console.error('Error fetching rectiligne coloris lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── List ─────────────────────────────────────────────────

// GET /api/references-rectiligne?archived=0|1
referencesRectiligneRouter.get('/', async (req: Request, res: Response) => {
  try {
    const wantArchived = req.query.archived === '1' ? 1 : 0
    const refs = (await loadAllRefRectiligne()).filter((r) => r.archive === wantArchived)
    const [colorisCounts, guideRows] = await Promise.all([
      query<{ IDref_rectiligne: number; n: number }>(
        `SELECT IDref_rectiligne, COUNT(*) AS n FROM coloris_rectiligne GROUP BY IDref_rectiligne`,
      ),
      query<{ IDref_rectiligne: number; montage: number }>(
        `SELECT IDref_rectiligne, montage FROM guide_fil_rectiligne`,
      ),
    ])
    const colorisByRef = new Map(colorisCounts.map((r) => [num(r.IDref_rectiligne), num(r.n)]))
    const montagesByRef = new Map<number, Set<number>>()
    for (const g of guideRows) {
      const s = montagesByRef.get(num(g.IDref_rectiligne)) ?? new Set<number>()
      s.add(num(g.montage))
      montagesByRef.set(num(g.IDref_rectiligne), s)
    }
    res.json(refs.map((r) => ({
      IDref_rectiligne: r.IDref_rectiligne,
      reference: r.reference,
      designation: r.designation,
      prix: r.prix,
      unite: r.unite,
      archive: r.archive,
      coloris_count: colorisByRef.get(r.IDref_rectiligne) ?? 0,
      montage_count: montagesByRef.get(r.IDref_rectiligne)?.size ?? 0,
    })))
  } catch (err) {
    console.error('Error fetching ref_rectiligne list:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Detail ───────────────────────────────────────────────

/** The fiche: reference + montages/guides + coloris with their yarn colours
 *  + who ordered it. */
async function loadDetail(id: number) {
  const row = await readRefRectiligneRow(id)
  if (!row) return null
  const ref = normalizeRefRectiligne(row)

  const [guides, colorisRows, usage, recent] = await Promise.all([
    loadGuides([id]),
    query<{ IDcoloris_rectiligne: number; coloris: string | null }>(
      `SELECT IDcoloris_rectiligne, coloris FROM coloris_rectiligne WHERE IDref_rectiligne = ${id} ORDER BY coloris`,
    ),
    rectiligneUsage({ refId: id }),
    // Last orders of this reference (sst side — every legacy order went there).
    query<{ IDligne_commande_sous_traitant: number; IDcommande_sous_traitant: number; IDColoris: number; quantite: number | null; prix: number | null }>(
      `SELECT TOP 8 IDligne_commande_sous_traitant, IDcommande_sous_traitant, IDColoris, quantite, prix
       FROM ligne_commande_sous_traitant WHERE TYPE = ${LINE_TYPE_RECTILIGNE} AND IDreference = ${id}
       ORDER BY IDligne_commande_sous_traitant DESC`,
    ),
  ])
  const coloris = await batchRepair(colorisRows, 'coloris_rectiligne', 'IDcoloris_rectiligne', ['coloris'])
  const cgf = await loadColorisGuideFils(coloris.map((c) => num(c.IDcoloris_rectiligne)))
  const { fils, coloris: coloriFil } = await loadFilLabels(
    guides.map((g) => g.IDref_fil),
    Array.from(cgf.values()).flatMap((m) => Array.from(m.values())),
  )

  // Order dates for the « Commandes » card, one flat lookup.
  const cmdIds = Array.from(new Set(recent.map((r) => num(r.IDcommande_sous_traitant)).filter((x) => x > 0)))
  const dates = new Map<number, string>()
  if (cmdIds.length > 0) {
    const d = await query<{ IDcommande_sous_traitant: number; date_commande: string | null }>(
      `SELECT IDcommande_sous_traitant, date_commande FROM commande_sous_traitant WHERE IDcommande_sous_traitant IN (${cmdIds.join(',')})`,
    )
    for (const r of d) dates.set(num(r.IDcommande_sous_traitant), String(r.date_commande ?? ''))
  }
  const colorisName = new Map(coloris.map((c) => [num(c.IDcoloris_rectiligne), String(c.coloris ?? '').trim()]))

  return {
    ...ref,
    montages: montagesOf(guides),
    guides: guides.map((g) => ({
      IDguide_fil_rectiligne: g.IDguide_fil_rectiligne,
      montage: g.montage,
      IDref_fil: g.IDref_fil,
      fil: fils.get(g.IDref_fil) ?? '',
      nb_fil: g.nb_fil,
      pct: pctFromStored(g.pourcentage),
    })),
    coloris: coloris.map((c) => {
      const cid = num(c.IDcoloris_rectiligne)
      const m = cgf.get(cid) ?? new Map<number, number>()
      return {
        IDcoloris_rectiligne: cid,
        coloris: String(c.coloris ?? '').trim(),
        fils: Array.from(m.entries()).map(([gid, cf]) => ({
          IDguide_fil_rectiligne: gid,
          IDcolori_fil: cf,
          colori: coloriFil.get(cf) ?? '',
        })),
      }
    }),
    usage,
    commandes: recent.map((r) => ({
      IDcommande_sous_traitant: num(r.IDcommande_sous_traitant),
      date_commande: dates.get(num(r.IDcommande_sous_traitant)) ?? '',
      coloris: colorisName.get(num(r.IDColoris)) ?? '',
      quantite: num(r.quantite),
      prix: num(r.prix),
    })),
  }
}

// GET /api/references-rectiligne/:id
referencesRectiligneRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = idParam(req.params.id)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const detail = await loadDetail(id)
    if (!detail) { res.status(404).json({ error: 'Référence introuvable' }); return }
    res.json(detail)
  } catch (err) {
    console.error('Error fetching ref_rectiligne detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Create / edit / archive / duplicate / delete ─────────

/** New id of a row just inserted — no RETURNING in HFSQL; every caller runs
 *  under rectiligneLock so the newest row is ours. */
async function newestId(table: string, pk: string, where: string): Promise<number> {
  const r = await query<Record<string, unknown>>(`SELECT TOP 1 ${pk} FROM ${table} WHERE ${where} ORDER BY ${pk} DESC`)
  return num(r[0]?.[pk])
}

// POST /api/references-rectiligne — inline create, server-picked R### name.
referencesRectiligneRouter.post('/', async (_req: Request, res: Response) => {
  try {
    const id = await rectiligneLock.run(async () => {
      const existing = (await loadAllRefRectiligne()).map((r) => r.reference)
      const reference = nextRectiligneReference(existing)
      // archivé is never NAMED (Linux) — left out, it zero-fills. Unité 4 =
      // pièce, what every col and bande is sold in.
      await query(
        `INSERT INTO ref_rectiligne (reference, designation, programme, nb_aiguilles, nb_guide_fil, prix, unite, commentaire)
         VALUES (${sqlText(reference)}, '', '', 0, 0, 0, 4, '')`,
      )
      return newestId('ref_rectiligne', 'IDref_rectiligne', `reference = ${sqlText(reference)}`)
    })
    res.status(201).json({ IDref_rectiligne: id })
  } catch (err) {
    console.error('Error creating ref_rectiligne:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const refBody = z.object({
  reference: z.string().trim().min(1).max(50),
  designation: z.string().max(100).optional().nullable(),
  programme: z.string().max(50).optional().nullable(),
  nb_aiguilles: z.number().int().min(0).optional().nullable(),
  prix: z.number().min(0).optional().nullable(),
  unite: z.number().int().min(0).max(255).optional().nullable(),
  commentaire: z.string().optional().nullable(),
})

// PUT /api/references-rectiligne/:id
referencesRectiligneRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = idParam(req.params.id)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = refBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    const outcome = await rectiligneLock.run(async () => {
      if (await rectiligneReferenceTaken(d.reference, id)) return 'taken' as const
      await query(
        `UPDATE ref_rectiligne SET reference = ${sqlText(d.reference)}, designation = ${sqlText(d.designation ?? '')},
           programme = ${sqlText(d.programme ?? '')}, nb_aiguilles = ${d.nb_aiguilles ?? 0}, prix = ${d.prix ?? 0},
           unite = ${d.unite ?? 4}, commentaire = ${sqlText(d.commentaire ?? '')}
         WHERE IDref_rectiligne = ${id}`,
      )
      return 'ok' as const
    })
    if (outcome === 'taken') { res.status(409).json({ error: 'reference_existe', message: 'Cette référence existe déjà.' }); return }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating ref_rectiligne:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

for (const [path, value] of [['archive', 1], ['unarchive', 0]] as const) {
  referencesRectiligneRouter.post(`/:id/${path}`, async (req: Request, res: Response) => {
    try {
      const id = idParam(req.params.id)
      if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
      const ok = await rectiligneLock.run(() => setRectiligneArchive(id, value))
      if (!ok) { res.status(404).json({ error: 'Référence introuvable' }); return }
      res.json({ ok: true })
    } catch (err) {
      console.error(`Error on ref_rectiligne ${path}:`, err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })
}

// POST /api/references-rectiligne/:id/duplicate — the whole reference: fiche,
// guides of every montage, coloris and their yarn colours.
referencesRectiligneRouter.post('/:id/duplicate', async (req: Request, res: Response) => {
  try {
    const id = idParam(req.params.id)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const newId = await rectiligneLock.run(async () => {
      const row = await readRefRectiligneRow(id)
      if (!row) return 0
      const src = normalizeRefRectiligne(row)
      const reference = duplicateReference(src.reference, (await loadAllRefRectiligne()).map((r) => r.reference))
      await query(
        `INSERT INTO ref_rectiligne (reference, designation, programme, nb_aiguilles, nb_guide_fil, prix, unite, commentaire)
         VALUES (${sqlText(reference)}, ${sqlText(src.designation)}, ${sqlText(src.programme)}, ${src.nb_aiguilles},
                 ${num(row.nb_guide_fil)}, ${src.prix}, ${src.unite}, ${sqlText(src.commentaire)})`,
      )
      const created = await newestId('ref_rectiligne', 'IDref_rectiligne', `reference = ${sqlText(reference)}`)
      if (!created) throw new Error('duplicate: new ref_rectiligne not found')

      const guideMap = new Map<number, number>()
      for (const g of await loadGuides([id])) {
        await query(
          `INSERT INTO guide_fil_rectiligne (IDref_rectiligne, IDref_fil, nb_fil, pourcentage, montage)
           VALUES (${created}, ${g.IDref_fil}, ${g.nb_fil}, ${g.pourcentage}, ${g.montage})`,
        )
        guideMap.set(g.IDguide_fil_rectiligne, await newestId('guide_fil_rectiligne', 'IDguide_fil_rectiligne', `IDref_rectiligne = ${created}`))
      }
      const coloris = await query<{ IDcoloris_rectiligne: number; coloris: string | null }>(
        `SELECT IDcoloris_rectiligne, coloris FROM coloris_rectiligne WHERE IDref_rectiligne = ${id}`,
      )
      const fixedColoris = await batchRepair(coloris, 'coloris_rectiligne', 'IDcoloris_rectiligne', ['coloris'])
      const cgf = await loadColorisGuideFils(fixedColoris.map((c) => num(c.IDcoloris_rectiligne)))
      for (const c of fixedColoris) {
        await query(
          `INSERT INTO coloris_rectiligne (IDref_rectiligne, coloris) VALUES (${created}, ${sqlText(String(c.coloris ?? ''))})`,
        )
        const newColoris = await newestId('coloris_rectiligne', 'IDcoloris_rectiligne', `IDref_rectiligne = ${created}`)
        for (const [gid, cf] of cgf.get(num(c.IDcoloris_rectiligne)) ?? []) {
          const newGuide = guideMap.get(gid)
          if (!newGuide) continue
          await query(
            `INSERT INTO coloris_guide_fil (IDcolori_fil, IDguide_fil_rectiligne, IDcoloris_rectiligne)
             VALUES (${cf}, ${newGuide}, ${newColoris})`,
          )
        }
      }
      return created
    })
    if (!newId) { res.status(404).json({ error: 'Référence introuvable' }); return }
    res.status(201).json({ IDref_rectiligne: newId })
  } catch (err) {
    console.error('Error duplicating ref_rectiligne:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-rectiligne/:id — refused once an order uses it.
referencesRectiligneRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = idParam(req.params.id)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const usage = await rectiligneUsage({ refId: id })
    if (usage.sst + usage.trm > 0) {
      res.status(409).json({
        error: 'reference_utilisee',
        message: `Cette référence est utilisée par ${usage.sst + usage.trm} ligne(s) de commande — archivez-la plutôt.`,
      })
      return
    }
    const guides = await loadGuides([id])
    if (guides.length > 0) {
      await query(`DELETE FROM coloris_guide_fil WHERE IDguide_fil_rectiligne IN (${guides.map((g) => g.IDguide_fil_rectiligne).join(',')})`)
    }
    await query(`DELETE FROM guide_fil_rectiligne WHERE IDref_rectiligne = ${id}`)
    await query(`DELETE FROM coloris_rectiligne WHERE IDref_rectiligne = ${id}`)
    await query(`DELETE FROM ref_rectiligne WHERE IDref_rectiligne = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting ref_rectiligne:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Montages & guides ────────────────────────────────────

const montageBody = z.object({ nb_guides: z.number().int().min(1).max(20) })

// POST /api/references-rectiligne/:id/montages — legacy « + montage »: asks
// how many guides, creates them with no yarn yet (« Choisir fil »).
referencesRectiligneRouter.post('/:id/montages', async (req: Request, res: Response) => {
  try {
    const id = idParam(req.params.id)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = montageBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const montage = await rectiligneLock.run(async () => {
      const m = nextMontage(await loadGuides([id]))
      for (let i = 0; i < parsed.data.nb_guides; i++) {
        await query(
          `INSERT INTO guide_fil_rectiligne (IDref_rectiligne, IDref_fil, nb_fil, pourcentage, montage)
           VALUES (${id}, 0, 1, 0, ${m})`,
        )
      }
      return m
    })
    res.status(201).json({ montage })
  } catch (err) {
    console.error('Error creating rectiligne montage:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-rectiligne/:id/montages/:montage
referencesRectiligneRouter.delete('/:id/montages/:montage', async (req: Request, res: Response) => {
  try {
    const id = idParam(req.params.id)
    const montage = parseInt(req.params.montage, 10)
    if (!id || !Number.isInteger(montage)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const guides = (await loadGuides([id])).filter((g) => g.montage === montage)
    if (guides.length > 0) {
      const ids = guides.map((g) => g.IDguide_fil_rectiligne).join(',')
      await query(`DELETE FROM coloris_guide_fil WHERE IDguide_fil_rectiligne IN (${ids})`)
      await query(`DELETE FROM guide_fil_rectiligne WHERE IDguide_fil_rectiligne IN (${ids})`)
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting rectiligne montage:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/references-rectiligne/:id/montages/:montage/guides — one more guide
referencesRectiligneRouter.post('/:id/montages/:montage/guides', async (req: Request, res: Response) => {
  try {
    const id = idParam(req.params.id)
    const montage = parseInt(req.params.montage, 10)
    if (!id || !Number.isInteger(montage) || montage < 1) { res.status(400).json({ error: 'Invalid ID' }); return }
    await query(
      `INSERT INTO guide_fil_rectiligne (IDref_rectiligne, IDref_fil, nb_fil, pourcentage, montage)
       VALUES (${id}, 0, 1, 0, ${montage})`,
    )
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('Error adding rectiligne guide:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const guideBody = z.object({
  IDref_fil: z.number().int().min(0),
  nb_fil: z.number().int().min(1).max(20),
  pct: z.number().min(0).max(100),
})

// PUT /api/references-rectiligne/guides/:gid — FEN_Gestion_Guide_Fil. Changing
// the yarn drops the colours the coloris had picked for the old yarn (a
// colori_fil belongs to one ref_fil).
referencesRectiligneRouter.put('/guides/:gid', async (req: Request, res: Response) => {
  try {
    const gid = idParam(req.params.gid)
    if (!gid) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = guideBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const cur = await query<{ IDref_fil: number }>(`SELECT IDref_fil FROM guide_fil_rectiligne WHERE IDguide_fil_rectiligne = ${gid}`)
    if (cur.length === 0) { res.status(404).json({ error: 'Guide introuvable' }); return }
    const d = parsed.data
    if (num(cur[0].IDref_fil) !== d.IDref_fil) {
      await query(`DELETE FROM coloris_guide_fil WHERE IDguide_fil_rectiligne = ${gid}`)
    }
    await query(
      `UPDATE guide_fil_rectiligne SET IDref_fil = ${d.IDref_fil}, nb_fil = ${d.nb_fil}, pourcentage = ${pctToStored(d.pct)}
       WHERE IDguide_fil_rectiligne = ${gid}`,
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating rectiligne guide:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-rectiligne/guides/:gid
referencesRectiligneRouter.delete('/guides/:gid', async (req: Request, res: Response) => {
  try {
    const gid = idParam(req.params.gid)
    if (!gid) { res.status(400).json({ error: 'Invalid ID' }); return }
    await query(`DELETE FROM coloris_guide_fil WHERE IDguide_fil_rectiligne = ${gid}`)
    await query(`DELETE FROM guide_fil_rectiligne WHERE IDguide_fil_rectiligne = ${gid}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting rectiligne guide:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Coloris ──────────────────────────────────────────────

const colorisBody = z.object({
  coloris: z.string().trim().min(1).max(100),
  montage: z.number().int().min(1),
  fils: z.array(z.object({
    IDguide_fil_rectiligne: z.number().int().positive(),
    IDcolori_fil: z.number().int().min(0),
  })),
})

/** Guides of `montage` on reference `refId`, or a 409 reason. */
async function colorisGuard(refId: number, montage: number): Promise<{ guides: number[] } | { error: string; message: string }> {
  const guides = (await loadGuides([refId])).filter((g) => g.montage === montage)
  if (!montageReadyForColoris(guides)) {
    return {
      error: 'guides_incomplets',
      message: 'Choisissez le fil de chaque guide du montage avant de créer un coloris.',
    }
  }
  return { guides: guides.map((g) => g.IDguide_fil_rectiligne) }
}

/** Replace the yarn colours of a coloris on the given guides. */
async function writeColorisFils(colorisId: number, guideIds: number[], fils: Array<{ IDguide_fil_rectiligne: number; IDcolori_fil: number }>) {
  if (guideIds.length > 0) {
    await query(
      `DELETE FROM coloris_guide_fil WHERE IDcoloris_rectiligne = ${colorisId} AND IDguide_fil_rectiligne IN (${guideIds.join(',')})`,
    )
  }
  for (const f of fils) {
    if (!guideIds.includes(f.IDguide_fil_rectiligne) || f.IDcolori_fil <= 0) continue
    await query(
      `INSERT INTO coloris_guide_fil (IDcolori_fil, IDguide_fil_rectiligne, IDcoloris_rectiligne)
       VALUES (${f.IDcolori_fil}, ${f.IDguide_fil_rectiligne}, ${colorisId})`,
    )
  }
}

// POST /api/references-rectiligne/:id/coloris
referencesRectiligneRouter.post('/:id/coloris', async (req: Request, res: Response) => {
  try {
    const id = idParam(req.params.id)
    if (!id) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = colorisBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const guard = await colorisGuard(id, parsed.data.montage)
    if ('error' in guard) { res.status(409).json(guard); return }
    const colorisId = await rectiligneLock.run(async () => {
      await query(`INSERT INTO coloris_rectiligne (IDref_rectiligne, coloris) VALUES (${id}, ${sqlText(parsed.data.coloris)})`)
      return newestId('coloris_rectiligne', 'IDcoloris_rectiligne', `IDref_rectiligne = ${id}`)
    })
    await writeColorisFils(colorisId, guard.guides, parsed.data.fils)
    res.status(201).json({ IDcoloris_rectiligne: colorisId })
  } catch (err) {
    console.error('Error creating coloris_rectiligne:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/references-rectiligne/coloris/:cid
referencesRectiligneRouter.put('/coloris/:cid', async (req: Request, res: Response) => {
  try {
    const cid = idParam(req.params.cid)
    if (!cid) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = colorisBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const cur = await query<{ IDref_rectiligne: number }>(`SELECT IDref_rectiligne FROM coloris_rectiligne WHERE IDcoloris_rectiligne = ${cid}`)
    if (cur.length === 0) { res.status(404).json({ error: 'Coloris introuvable' }); return }
    const guard = await colorisGuard(num(cur[0].IDref_rectiligne), parsed.data.montage)
    if ('error' in guard) { res.status(409).json(guard); return }
    await query(`UPDATE coloris_rectiligne SET coloris = ${sqlText(parsed.data.coloris)} WHERE IDcoloris_rectiligne = ${cid}`)
    await writeColorisFils(cid, guard.guides, parsed.data.fils)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating coloris_rectiligne:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-rectiligne/coloris/:cid — refused once ordered.
referencesRectiligneRouter.delete('/coloris/:cid', async (req: Request, res: Response) => {
  try {
    const cid = idParam(req.params.cid)
    if (!cid) { res.status(400).json({ error: 'Invalid ID' }); return }
    const usage = await rectiligneUsage({ colorisId: cid })
    if (usage.sst + usage.trm > 0) {
      res.status(409).json({
        error: 'coloris_utilise',
        message: `Ce coloris est utilisé par ${usage.sst + usage.trm} ligne(s) de commande — il ne peut pas être supprimé.`,
      })
      return
    }
    await query(`DELETE FROM coloris_guide_fil WHERE IDcoloris_rectiligne = ${cid}`)
    await query(`DELETE FROM coloris_rectiligne WHERE IDcoloris_rectiligne = ${cid}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting coloris_rectiligne:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
