// Qualité › Actions — CRUD over action_qualite + its mention_qualite children,
// plus the read-only "Conformité des commandes" roll-up.
//
// Ports legacy FI_Action_Qualité.wdw. The data model, the mention→sst-line
// matching rule and every HFSQL accented-column workaround live in
// lib/actions-qualite.ts — read that file's header before touching this one.
//
// Reads are open to everyone (the Qualité module is view-for-all); every write
// is gated behind `responsable_qualite`, matching suivi-lots.ts and
// dossiers-qualite.ts.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { userHasPermission } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import {
  CONFORMITE_VALUES,
  createAction,
  createMention,
  deleteAction,
  deleteMention,
  loadAction,
  loadActions,
  loadAllMentions,
  loadConformites,
  loadLinesForMentions,
  loadMentionsForAction,
  mentionsForLine,
  setActionTermine,
  updateActionText,
  updateMention,
  type Conformite,
  type MentionRow,
} from '../lib/actions-qualite.js'
import { MAX_TARGET, MIN_TARGET, getAllTargets, getTarget, setTarget } from '../lib/action-qualite-targets.js'

export const actionsQualiteRouter: RouterType = Router()

// ── Guards ───────────────────────────────────────────────

async function ensureResponsable(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'responsable_qualite')
  if (!allowed) {
    res.status(403).json({ error: 'permission denied: responsable_qualite' })
    return false
  }
  return true
}

// ── Label resolution ─────────────────────────────────────
//
// A mention's IDreference / IDColoris are polymorphic on IDtype_sst exactly like
// the sst line's own (claude_doc/hfsql_odbc.md):
//   type 1 (tricoteur)    → ref_ecru        + colori_ecru
//   type 2 (ennoblisseur) → ref_fini        + ref_fini_colori, unless
//                           ref_fini.avec_teinture = 0 (wash) → colori_ecru
// Getting the coloris catalog wrong returns another référence's coloris because
// the two id spaces overlap (memory [[project-coloris-id-spaces-collide]]).

interface LabelMaps {
  ecru: Map<number, string>
  fini: Map<number, string>
  finiAvecTeinture: Map<number, number>
  coloriEcru: Map<number, string>
  finiColori: Map<number, string>
  sst: Map<number, string>
}

async function loadLabelMaps(mentions: MentionRow[]): Promise<LabelMaps> {
  const refIds = Array.from(new Set(mentions.map((m) => m.IDreference).filter((x) => x > 0)))
  const colIds = Array.from(new Set(mentions.map((m) => m.IDColoris).filter((x) => x > 0)))
  const sstIds = Array.from(new Set(mentions.map((m) => m.IDsous_traitant).filter((x) => x > 0)))

  const ecru = new Map<number, string>()
  const fini = new Map<number, string>()
  const finiAvecTeinture = new Map<number, number>()
  const coloriEcru = new Map<number, string>()
  const finiColori = new Map<number, string>()
  const sst = new Map<number, string>()

  if (refIds.length > 0) {
    const list = refIds.join(',')
    // The same numeric id can exist in both catalogs — read both, then pick by
    // the mention's IDtype_sst at render time.
    const [ecruRows, finiRows] = await Promise.all([
      query<{ IDref_ecru: number; reference: string | null }>(
        `SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru IN (${list})`,
      ),
      query<{ IDref_fini: number; reference: string | null; avec_teinture: number | null }>(
        `SELECT IDref_fini, reference, avec_teinture FROM ref_fini WHERE IDref_fini IN (${list})`,
      ),
    ])
    for (const r of await fixEncoding(ecruRows, 'ref_ecru', 'IDref_ecru', ['reference']))
      ecru.set(Number(r.IDref_ecru), (r.reference ?? '').toString())
    for (const r of await fixEncoding(finiRows, 'ref_fini', 'IDref_fini', ['reference'])) {
      fini.set(Number(r.IDref_fini), (r.reference ?? '').toString())
      finiAvecTeinture.set(Number(r.IDref_fini), Number(r.avec_teinture) || 0)
    }
  }

  if (colIds.length > 0) {
    const list = colIds.join(',')
    const [ecruC, finiC] = await Promise.all([
      query<{ IDcolori_ecru: number; reference: string | null }>(
        `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${list})`,
      ),
      query<{ IDref_fini_colori: number; reference: string | null }>(
        `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori IN (${list})`,
      ),
    ])
    for (const c of await fixEncoding(ecruC, 'colori_ecru', 'IDcolori_ecru', ['reference']))
      coloriEcru.set(Number(c.IDcolori_ecru), (c.reference ?? '').toString())
    for (const c of await fixEncoding(finiC, 'ref_fini_colori', 'IDref_fini_colori', ['reference']))
      finiColori.set(Number(c.IDref_fini_colori), (c.reference ?? '').toString())
  }

  if (sstIds.length > 0) {
    const rows = await query<{ IDsous_traitant: number; nom: string | null }>(
      `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${sstIds.join(',')})`,
    )
    for (const r of await fixEncoding(rows, 'sous_traitant', 'IDsous_traitant', ['nom']))
      sst.set(Number(r.IDsous_traitant), (r.nom ?? '').toString())
  }

  return { ecru, fini, finiAvecTeinture, coloriEcru, finiColori, sst }
}

/** Decorate a mention with the human labels the UI shows. `''` for the wildcards
 *  so the client can render "Tous les sous-traitants" / "Tous les coloris". */
function decorateMention(m: MentionRow, maps: LabelMaps) {
  const isTricoteur = m.IDtype_sst === 1
  const reference = isTricoteur
    ? maps.ecru.get(m.IDreference) ?? ''
    : maps.fini.get(m.IDreference) ?? ''
  let coloris = ''
  if (m.IDColoris > 0) {
    if (isTricoteur) {
      coloris = maps.coloriEcru.get(m.IDColoris) ?? ''
    } else {
      // avec_teinture decides the catalog; fall back to the other one rather
      // than showing nothing when legacy data disagrees with the flag.
      const dyed = (maps.finiAvecTeinture.get(m.IDreference) ?? 1) !== 0
      coloris = dyed
        ? maps.finiColori.get(m.IDColoris) ?? maps.coloriEcru.get(m.IDColoris) ?? ''
        : maps.coloriEcru.get(m.IDColoris) ?? maps.finiColori.get(m.IDColoris) ?? ''
    }
  }
  return {
    IDmention_qualite: m.IDmention_qualite,
    IDaction_qualite: m.IDaction_qualite,
    IDtype_sst: m.IDtype_sst,
    IDsous_traitant: m.IDsous_traitant,
    sous_traitant_nom: m.IDsous_traitant > 0 ? maps.sst.get(m.IDsous_traitant) ?? '' : '',
    IDreference: m.IDreference,
    reference,
    IDColoris: m.IDColoris,
    coloris,
    mention: m.mention,
  }
}

// ── List ─────────────────────────────────────────────────
//
// GET /actions-qualite?status=en_cours|termine|tous&q=
actionsQualiteRouter.get('/', async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || 'en_cours'
    const q = ((req.query.q as string) || '').trim().toLowerCase()

    let actions = await loadActions()
    if (status === 'en_cours') actions = actions.filter((a) => a.termine === 0)
    else if (status === 'termine') actions = actions.filter((a) => a.termine === 1)
    if (q) {
      actions = actions.filter(
        (a) => a.titre.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
      )
    }

    // Progress toward each action's objectif, for the list-card cue. One read of
    // each child table for the whole page rather than per-row queries.
    const mentions = await loadAllMentions()
    const conformites = await loadConformites()
    const targets = await getAllTargets()
    const mentionsByAction = new Map<number, number[]>()
    for (const m of mentions) {
      const arr = mentionsByAction.get(m.IDaction_qualite) ?? []
      arr.push(m.IDmention_qualite)
      mentionsByAction.set(m.IDaction_qualite, arr)
    }

    res.json(
      actions
        // Newest first — legacy lists by creation date descending.
        .sort((a, b) =>
          b.date_creation.localeCompare(a.date_creation) || b.IDaction_qualite - a.IDaction_qualite,
        )
        .map((a) => {
          const mine = new Set(mentionsByAction.get(a.IDaction_qualite) ?? [])
          const rows = conformites.filter((c) => mine.has(c.IDmention_qualite))
          const conforme = rows.filter((c) => c.conformite === 'conforme').length
          const nonConforme = rows.filter((c) => c.conformite === 'non_conforme').length
          const target = targets.get(a.IDaction_qualite) ?? null
          return {
            IDaction_qualite: a.IDaction_qualite,
            titre: a.titre,
            description: a.description,
            date_creation: a.date_creation,
            termine: a.termine,
            mentions_count: mine.size,
            conforme_count: conforme,
            non_conforme_count: nonConforme,
            objectif: target,
            objectif_atteint: target !== null && conforme >= target,
          }
        }),
    )
  } catch (err) {
    console.error('Error listing actions-qualite:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Lookups for the mention dialog ───────────────────────
//
// GET /actions-qualite/lookups/sous-traitants?type=1|2
actionsQualiteRouter.get('/lookups/sous-traitants', async (req: Request, res: Response) => {
  try {
    const type = parseInt(String(req.query.type ?? ''), 10)
    if (type !== 1 && type !== 2) { res.status(400).json({ error: 'type must be 1 or 2' }); return }
    // NB: no JOIN + CONVERT here — that combination collapses the result set to
    // one row in HFSQL ODBC (see commandes-sous-traitant.ts /lookups/sous-traitants).
    const rows = await query<{ IDsous_traitant: number; nom: string | null }>(
      `SELECT IDsous_traitant, nom FROM sous_traitant
       WHERE est_visible = 1 AND IDtype_sst = ${type}
       ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'sous_traitant', 'IDsous_traitant', ['nom'])
    res.json(
      fixed.map((r) => ({
        IDsous_traitant: Number(r.IDsous_traitant),
        nom: (r.nom ?? '').toString(),
      })),
    )
  } catch (err) {
    console.error('Error loading sous-traitant lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /actions-qualite/lookups/references?type=1|2
//
// type 1 → ref_ecru ("tombé de métier"), type 2 → ref_fini.
actionsQualiteRouter.get('/lookups/references', async (req: Request, res: Response) => {
  try {
    const type = parseInt(String(req.query.type ?? ''), 10)
    if (type !== 1 && type !== 2) { res.status(400).json({ error: 'type must be 1 or 2' }); return }
    if (type === 1) {
      const rows = await query<{ IDref_ecru: number; reference: string | null; designation: string | null }>(
        `SELECT IDref_ecru, reference, designation FROM ref_ecru ORDER BY reference`,
      )
      const fixed = await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['reference', 'designation'])
      res.json(
        fixed.map((r) => ({
          id: Number(r.IDref_ecru),
          reference: (r.reference ?? '').toString(),
          designation: (r.designation ?? '').toString(),
          // Drives which coloris catalog the client asks for next.
          avec_teinture: null as number | null,
        })),
      )
      return
    }
    const rows = await query<{
      IDref_fini: number; reference: string | null; designation: string | null; avec_teinture: number | null
    }>(
      `SELECT IDref_fini, reference, designation, avec_teinture FROM ref_fini ORDER BY reference`,
    )
    const fixed = await fixEncoding(rows, 'ref_fini', 'IDref_fini', ['reference', 'designation'])
    res.json(
      fixed.map((r) => ({
        id: Number(r.IDref_fini),
        reference: (r.reference ?? '').toString(),
        designation: (r.designation ?? '').toString(),
        avec_teinture: Number(r.avec_teinture) || 0,
      })),
    )
  } catch (err) {
    console.error('Error loading reference lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /actions-qualite/lookups/coloris?type=1|2&reference=<id>
//
// Resolves the coloris catalog exactly like the sst line does: écru lines use
// colori_ecru; fini lines use ref_fini_colori UNLESS ref_fini.avec_teinture = 0
// (wash-only), in which case the coloris come from colori_ecru via the fini's
// source écru. Skipping this gate returns another référence's coloris because
// the two id spaces overlap — memory [[project-coloris-id-spaces-collide]].
actionsQualiteRouter.get('/lookups/coloris', async (req: Request, res: Response) => {
  try {
    const type = parseInt(String(req.query.type ?? ''), 10)
    const refId = parseInt(String(req.query.reference ?? ''), 10)
    if ((type !== 1 && type !== 2) || isNaN(refId) || refId <= 0) {
      res.status(400).json({ error: 'type must be 1 or 2 and reference a positive id' }); return
    }

    // Which écru do we read colori_ecru for? For a tricoteur line the référence
    // IS the écru; for a wash-only fini it's the fini's source écru.
    let ecruId = 0
    if (type === 1) {
      ecruId = refId
    } else {
      const rf = await query<{ avec_teinture: number | null; IDref_ecru: number | null }>(
        `SELECT avec_teinture, IDref_ecru FROM ref_fini WHERE IDref_fini = ${refId}`,
      )
      const avecTeinture = Number(rf[0]?.avec_teinture) || 0
      if (avecTeinture !== 0) {
        const rows = await query<{ IDref_fini_colori: number; reference: string | null }>(
          `SELECT IDref_fini_colori, reference FROM ref_fini_colori
           WHERE IDref_fini = ${refId} ORDER BY reference`,
        )
        const fixed = await fixEncoding(rows, 'ref_fini_colori', 'IDref_fini_colori', ['reference'])
        res.json(
          fixed.map((r) => ({
            id: Number(r.IDref_fini_colori),
            reference: (r.reference ?? '').toString(),
          })),
        )
        return
      }
      ecruId = Number(rf[0]?.IDref_ecru) || 0
    }

    if (ecruId <= 0) { res.json([]); return }
    const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(
      `SELECT IDcolori_ecru, reference FROM colori_ecru
       WHERE IDref_ecru = ${ecruId} ORDER BY reference`,
    )
    const fixed = await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference'])
    res.json(
      fixed.map((r) => ({
        id: Number(r.IDcolori_ecru),
        reference: (r.reference ?? '').toString(),
      })),
    )
  } catch (err) {
    console.error('Error loading coloris lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// NOTE: these MUST stay above the `/:id` routes. Express matches in
// declaration order, so a `/:id` handler declared first would swallow
// `/lookups/...` and answer 400 (parseInt("lookups") is NaN).

// ── Detail ───────────────────────────────────────────────
//
// GET /actions-qualite/:id
actionsQualiteRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const action = await loadAction(id)
    if (!action) { res.status(404).json({ error: 'Action not found' }); return }

    const mentions = await loadMentionsForAction(id)
    const maps = await loadLabelMaps(mentions)

    // "Conformité des commandes": every sst line the action's mentions apply to,
    // with its current verdict. Lines are found by IDreference (indexable) then
    // narrowed in JS with the same matching rule the sst screen and PDF use.
    const candidateLines = await loadLinesForMentions(mentions)
    const conformites = await loadConformites({
      mentionIds: mentions.map((m) => m.IDmention_qualite),
    })
    const verdictByPair = new Map<string, Conformite>()
    for (const c of conformites) {
      verdictByPair.set(`${c.IDligne_commande_sous_traitant}|${c.IDmention_qualite}`, c.conformite)
    }

    const pairs: Array<{ line: (typeof candidateLines)[number]; mention: MentionRow }> = []
    for (const line of candidateLines) {
      for (const m of mentionsForLine(line, mentions)) pairs.push({ line, mention: m })
    }

    // Sous-traitant names for the table's second column.
    const sstIds = Array.from(new Set(pairs.map((p) => p.line.IDsous_traitant).filter((x) => x > 0)))
    const sstNames = new Map<number, string>()
    if (sstIds.length > 0) {
      const rows = await query<{ IDsous_traitant: number; nom: string | null }>(
        `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${sstIds.join(',')})`,
      )
      for (const r of await fixEncoding(rows, 'sous_traitant', 'IDsous_traitant', ['nom']))
        sstNames.set(Number(r.IDsous_traitant), (r.nom ?? '').toString())
    }

    const commandes = pairs
      .map((p) => ({
        IDcommande_sous_traitant: p.line.IDcommande_sous_traitant,
        IDligne_commande_sous_traitant: p.line.IDligne_commande_sous_traitant,
        IDmention_qualite: p.mention.IDmention_qualite,
        sous_traitant_nom: sstNames.get(p.line.IDsous_traitant) ?? '',
        conformite:
          verdictByPair.get(
            `${p.line.IDligne_commande_sous_traitant}|${p.mention.IDmention_qualite}`,
          ) ?? ('non_controle' as Conformite),
      }))
      // Most recent orders first — that's what the responsable is chasing.
      .sort((a, b) => b.IDcommande_sous_traitant - a.IDcommande_sous_traitant)

    const conformeCount = commandes.filter((c) => c.conformite === 'conforme').length
    const objectif = await getTarget(id)

    res.json({
      IDaction_qualite: action.IDaction_qualite,
      titre: action.titre,
      description: action.description,
      date_creation: action.date_creation,
      termine: action.termine,
      objectif,
      objectif_atteint: objectif !== null && conformeCount >= objectif,
      conforme_count: conformeCount,
      non_conforme_count: commandes.filter((c) => c.conformite === 'non_conforme').length,
      non_controle_count: commandes.filter((c) => c.conformite === 'non_controle').length,
      mentions: mentions.map((m) => decorateMention(m, maps)),
      commandes,
    })
  } catch (err) {
    console.error('Error loading action-qualite detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Create / update / delete the action ──────────────────

const actionBody = z.object({
  titre: z.string().trim().min(1).max(200),
  description: z.string().max(20000).optional(),
})

actionsQualiteRouter.post('/', async (req: Request, res: Response) => {
  try {
    if (!(await ensureResponsable(req, res))) return
    const parsed = actionBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return
    }
    const newId = await createAction(parsed.data.titre, parsed.data.description ?? '')
    res.status(201).json({ IDaction_qualite: newId })
  } catch (err) {
    console.error('Error creating action-qualite:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

actionsQualiteRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    if (!(await ensureResponsable(req, res))) return
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = actionBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return
    }
    if (!(await loadAction(id))) { res.status(404).json({ error: 'Action not found' }); return }
    await updateActionText(id, parsed.data.titre, parsed.data.description ?? '')
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating action-qualite:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /actions-qualite/:id/etat { termine: 0 | 1 }
//
// Closing is ALWAYS a deliberate user action — an action never auto-archives on
// reaching its objectif, by explicit product decision. The objectif only drives
// a visual cue.
actionsQualiteRouter.post('/:id/etat', async (req: Request, res: Response) => {
  try {
    if (!(await ensureResponsable(req, res))) return
    const id = parseInt(req.params.id, 10)
    const termine = Number(req.body?.termine)
    if (isNaN(id) || (termine !== 0 && termine !== 1)) {
      res.status(400).json({ error: 'Invalid input' }); return
    }
    if (!(await loadAction(id))) { res.status(404).json({ error: 'Action not found' }); return }
    await setActionTermine(id, termine as 0 | 1)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error changing action-qualite état:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /actions-qualite/:id/objectif { objectif: number | null }
actionsQualiteRouter.put('/:id/objectif', async (req: Request, res: Response) => {
  try {
    if (!(await ensureResponsable(req, res))) return
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const raw = req.body?.objectif
    if (raw !== null && raw !== undefined) {
      const num = Number(raw)
      if (!Number.isInteger(num) || num < MIN_TARGET || num > MAX_TARGET) {
        res.status(400).json({ error: `objectif must be an integer between ${MIN_TARGET} and ${MAX_TARGET}` })
        return
      }
      await setTarget(id, num)
    } else {
      await setTarget(id, null)
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error setting action-qualite objectif:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

actionsQualiteRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    if (!(await ensureResponsable(req, res))) return
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await loadAction(id))) { res.status(404).json({ error: 'Action not found' }); return }
    await deleteAction(id)
    await setTarget(id, null)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting action-qualite:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Mentions (commentaires automatiques) ─────────────────

const mentionBody = z.object({
  // 1 = tricoteur, 2 = ennoblisseur — mirrors ligne_commande_sous_traitant.type.
  IDtype_sst: z.union([z.literal(1), z.literal(2)]),
  // 0 = tous les sous-traitants de ce type.
  IDsous_traitant: z.number().int().min(0),
  // Required: it is the matching key AND the only ASCII handle we have on the
  // row (see lib/actions-qualite.ts — deletes rewrite the IDreference bucket).
  IDreference: z.number().int().positive(),
  // 0 = tous les coloris.
  IDColoris: z.number().int().min(0),
  mention: z.string().trim().min(1).max(5000),
})

actionsQualiteRouter.post('/:id/mentions', async (req: Request, res: Response) => {
  try {
    if (!(await ensureResponsable(req, res))) return
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = mentionBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return
    }
    if (!(await loadAction(id))) { res.status(404).json({ error: 'Action not found' }); return }
    const newId = await createMention({ ...parsed.data, IDaction_qualite: id })
    res.status(201).json({ IDmention_qualite: newId })
  } catch (err) {
    console.error('Error creating mention_qualite:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

actionsQualiteRouter.put('/:id/mentions/:mentionId', async (req: Request, res: Response) => {
  try {
    if (!(await ensureResponsable(req, res))) return
    const id = parseInt(req.params.id, 10)
    const mentionId = parseInt(req.params.mentionId, 10)
    if (isNaN(id) || isNaN(mentionId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = mentionBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return
    }
    // Scope guard: the mention must belong to the action in the URL.
    const mine = await loadMentionsForAction(id)
    if (!mine.some((m) => m.IDmention_qualite === mentionId)) {
      res.status(404).json({ error: 'Mention not found' }); return
    }
    await updateMention(mentionId, parsed.data)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating mention_qualite:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

actionsQualiteRouter.delete('/:id/mentions/:mentionId', async (req: Request, res: Response) => {
  try {
    if (!(await ensureResponsable(req, res))) return
    const id = parseInt(req.params.id, 10)
    const mentionId = parseInt(req.params.mentionId, 10)
    if (isNaN(id) || isNaN(mentionId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const mine = await loadMentionsForAction(id)
    if (!mine.some((m) => m.IDmention_qualite === mentionId)) {
      res.status(404).json({ error: 'Mention not found' }); return
    }
    await deleteMention(mentionId)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting mention_qualite:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export { CONFORMITE_VALUES }
