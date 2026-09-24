import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, queryRaw, fixEncoding } from '../lib/hfsql-auto.js'
import { selectMachines, machineLabel, resolveMachineLabels } from '../lib/production-trm.js'
import { prixDeRevientTRMDetail } from '../lib/pricing-trm.js'
import { compositionEcart, planColorisComposition, totalOk } from '../lib/composition-coloris.js'

export const referencesEcruRouter: RouterType = Router()

// ref_ecru is the écru (loom-output / "tombé métier") knitting-fabric reference.
// Three of its column NAMES are accented — archivé, diamètre, recyclé — which the
// Linux HFSQL bridge cannot resolve when NAMED (it truncates at the accent and
// naming a then-"unknown" column triggers a respawn storm on the shared prod
// server). So:
//   • reads  — SELECT * (Windows returns accented keys verbatim; Linux truncates).
//              normalizeRefEcru() resolves each by a case-insensitive prefix regex.
//   • writes — Windows SETs the accented columns directly; Linux SKIPs diamètre /
//              recyclé in the main PUT (a documented, pre-existing limitation,
//              same as references-fil.ts skips recyclé). The Archiver action flips
//              archivé via a delete + positional-reinsert preserving the ASCII PK
//              (Object.values keeps physical column order through the mangled keys).
// Accented VALUES (designation, observations, …) corrupt to U+FFFD through ODBC
// and are repaired via fixEncoding (single rows) or a batched CONVERT (lists).
//
// NB: `SELECT *` works on ref_ecru but FAILS (0 rows) on colori_ecru — that table
// is only ever read with an explicit column list.

const IS_WINDOWS = process.platform === 'win32'

/** Escape a string for SQL (single quotes doubled). */
function esc(value: string): string {
  return value.replace(/'/g, "''")
}

/** SQL literal for user text. ASCII → quoted; accented → Latin-1 hex literal
 *  (raw multi-byte UTF-8 in a SQL line corrupts the Linux bridge). Mirrors
 *  sqlText() in references-fil.ts / references-fini.ts. */
function sqlText(value: string | null | undefined): string {
  const v = (value ?? '').toString()
  if (v === '') return "''"
  if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(v)) return `'${esc(v)}'`
  const ascii = v
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
  const bytes = Buffer.from(
    Array.from(ascii, (ch) => {
      const c = ch.codePointAt(0) ?? 0x3f
      return c <= 0xff ? c : 0x3f
    }),
  )
  return `x'${bytes.toString('hex')}'`
}

function toNumOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function round(v: unknown, dp: number): number | null {
  const n = toNumOrNull(v)
  if (n == null) return null
  const f = 10 ** dp
  return Math.round(n * f) / f
}

/** Value of the first row key matching `re` (accented names come back truncated
 *  on the Linux bridge — archivé → archiv, diamètre → diam, recyclé → recycl). */
function pickKey(row: Record<string, unknown>, re: RegExp): unknown {
  const k = Object.keys(row).find((key) => re.test(key))
  return k === undefined ? undefined : row[k]
}

/** Today as YYYYMMDD (HFSQL date string) for date_maj_ft auto-stamp. */
function todayHfsql(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

/** Shape a raw ref_ecru row (from SELECT *) into an ASCII-keyed object. */
function normalizeRefEcru(row: Record<string, unknown>) {
  return {
    IDref_ecru: Number(row.IDref_ecru) || 0,
    reference: (row.reference ?? null) as string | null,
    designation: (row.designation ?? null) as string | null,
    composition: (row.composition ?? null) as string | null,
    IDclient: Number(row.IDclient) || 0,
    reference_client: (row.reference_client ?? null) as string | null,
    prix: toNumOrNull(row.prix),
    poids: toNumOrNull(row.poids),
    IDcontexture: Number(row.IDcontexture) || 0,
    Jauge: toNumOrNull(row.Jauge),
    diametre: toNumOrNull(pickKey(row, /^diam/i)),
    bio: Number(row.bio) ? 1 : 0,
    recycle: Number(pickKey(row, /^recyc/i)) ? 1 : 0,
    archive: Number(pickKey(row, /^archiv/i)) ? 1 : 0,
    commentaire: (row.commentaire ?? null) as string | null,
    observations: (row.observations ?? null) as string | null,
    tombe_metier: (row.tombe_metier ?? null) as string | null,
    date_maj_ft: (row.date_maj_ft ?? null) as string | null,
    lfa_tour_1: (row.lfa_tour_1 ?? null) as string | null,
    lfa_tour_2: (row.lfa_tour_2 ?? null) as string | null,
    lfa_tour_3: (row.lfa_tour_3 ?? null) as string | null,
    lfa_tour_4: (row.lfa_tour_4 ?? null) as string | null,
    poulies_1: (row.poulies_1 ?? null) as string | null,
    poulies_2: (row.poulies_2 ?? null) as string | null,
    poulies_3: (row.poulies_3 ?? null) as string | null,
    poulies_4: (row.poulies_4 ?? null) as string | null,
    ecarteur: toNumOrNull(row.ecarteur),
    laize_tbm: toNumOrNull(row.laize_tbm),
    poids_m2_tbm: toNumOrNull(row.poids_m2_tbm),
    rendement: round(row.rendement, 4),
    vitesse_cible: toNumOrNull(row.vitesse_cible),
    nb_chutes: toNumOrNull(row.nb_chutes),
    nb_aiguilles: toNumOrNull(row.nb_aiguilles),
    maille_ouverture: Number(row.maille_ouverture) ? 1 : 0,
    ouvert_visiteuse: Number(row.ouvert_visiteuse) ? 1 : 0,
    sonneter: Number(row.sonneter) ? 1 : 0,
  }
}

type RefEcru = ReturnType<typeof normalizeRefEcru>

function isArchive(row: Record<string, unknown>): boolean {
  return Number(pickKey(row, /^archiv/i)) === 1
}

/** Batched accent repair for a flat list: one CONVERT(...) WHERE pk IN (...) per
 *  source column (only for ids whose value contains U+FFFD). `fields` must be
 *  ASCII-named columns. Mirrors batchRepair() in references-fini.ts. */
async function batchRepair<T extends Record<string, unknown>>(
  rows: T[],
  table: string,
  idField: string,
  fields: string[],
): Promise<T[]> {
  const idsByField: Record<string, Set<number>> = {}
  let any = false
  for (const f of fields) idsByField[f] = new Set<number>()
  for (const row of rows) {
    const id = Number(row[idField])
    if (!Number.isInteger(id)) continue
    for (const f of fields) {
      const v = row[f]
      if (typeof v === 'string' && v.includes('�')) {
        idsByField[f].add(id)
        any = true
      }
    }
  }
  if (!any) return rows
  const valueByField: Record<string, Map<number, string>> = {}
  for (const f of fields) {
    valueByField[f] = new Map<number, string>()
    const ids = idsByField[f]
    if (ids.size === 0) continue
    try {
      const r = await query<{ id: number; v: unknown }>(
        `SELECT ${idField} AS id, CONVERT(${f} USING 'UTF-8') AS v FROM ${table} WHERE ${idField} IN (${Array.from(ids).join(',')})`,
      )
      for (const rec of r) {
        if (rec.v == null) continue
        valueByField[f].set(
          Number(rec.id),
          rec.v instanceof ArrayBuffer ? Buffer.from(rec.v).toString('utf8') : String(rec.v),
        )
      }
    } catch {
      /* keep originals on failure */
    }
  }
  return rows.map((row) => {
    const id = Number(row[idField])
    let fixed: T | null = null
    for (const f of fields) {
      const v = row[f]
      if (typeof v === 'string' && v.includes('�')) {
        const nv = valueByField[f].get(id)
        if (nv != null) {
          if (!fixed) fixed = { ...row }
          ;(fixed as Record<string, unknown>)[f] = nv
        }
      }
    }
    return fixed ?? row
  })
}

// ──────────────────────────────────────────────────────────
// LOOKUPS
// ──────────────────────────────────────────────────────────

// GET /api/references-ecru/lookups/contextures
referencesEcruRouter.get('/lookups/contextures', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDcontexture: number; nom: string | null }>(
      `SELECT IDcontexture, nom FROM contexture ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'contexture', 'IDcontexture', ['nom'])
    res.json(fixed.map((r) => ({ IDcontexture: Number(r.IDcontexture) || 0, nom: r.nom ?? null })))
  } catch (err) {
    console.error('Error fetching contextures lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/references-ecru/lookups/clients
referencesEcruRouter.get('/lookups/clients', async (_req: Request, res: Response) => {
  try {
    // client is IDsociete-partitioned; legacy filters to ETM (=1). nom corrupts.
    const rows = await query<{ IDclient: number; nom: string | null }>(
      `SELECT IDclient, nom FROM client WHERE IDsociete = 1 ORDER BY nom`,
    )
    const fixed = await batchRepair(
      rows.map((r) => ({ IDclient: Number(r.IDclient) || 0, nom: r.nom ?? null, ville: null as string | null })),
      'client',
      'IDclient',
      ['nom'],
    )
    res.json(fixed.filter((r) => r.nom && String(r.nom).trim().length > 0))
  } catch (err) {
    console.error('Error fetching clients lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/references-ecru/lookups/refs-fil — yarn picker (reference + base prix_kg)
referencesEcruRouter.get('/lookups/refs-fil', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDref_fil: number; reference: string | null; prix_kg: number | null }>(
      `SELECT IDref_fil, reference, prix_kg FROM ref_fil ORDER BY reference`,
    )
    const fixed = await batchRepair(
      rows.map((r) => ({
        IDref_fil: Number(r.IDref_fil) || 0,
        reference: r.reference ?? null,
        prix_kg: toNumOrNull(r.prix_kg),
      })),
      'ref_fil',
      'IDref_fil',
      ['reference'],
    )
    res.json(fixed.filter((r) => r.reference && String(r.reference).trim().length > 0))
  } catch (err) {
    console.error('Error fetching refs-fil lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/references-ecru/lookups/colori-fil?ref_fil=<id> — the yarn colours
// of one fil, for a coloris composition line (LIVA #1205). All-ASCII table.
referencesEcruRouter.get('/lookups/colori-fil', async (req: Request, res: Response) => {
  try {
    const refFil = parseInt(String(req.query.ref_fil ?? ''), 10)
    if (!(refFil > 0)) { res.status(400).json({ error: 'ref_fil required' }); return }
    const rows = await query<{ IDcolori_fil: number; reference: string | null }>(
      `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDref_fil = ${refFil} ORDER BY reference`,
    )
    const fixed = await fixEncoding(rows, 'colori_fil', 'IDcolori_fil', ['reference'])
    // colori_fil reuses names across ids (nine « ecru » on one fil) — the
    // stock on hand is what tells the right one apart. stock_fil has an
    // accented `terminé`: name every column, never SELECT *.
    const stockRows = await query<{ IDcolori_fil: number; kg: number | null }>(
      `SELECT IDcolori_fil, SUM(stock) AS kg FROM stock_fil WHERE IDref_fil = ${refFil} AND stock > 0 GROUP BY IDcolori_fil`,
    )
    const kg = new Map(stockRows.map((s) => [Number(s.IDcolori_fil), Number(s.kg) || 0]))
    res.json(fixed.map((r) => ({
      IDcolori_fil: Number(r.IDcolori_fil) || 0,
      reference: (r.reference ?? '').toString().trim(),
      stock_kg: Math.round((kg.get(Number(r.IDcolori_fil)) ?? 0) * 10) / 10,
    })))
  } catch (err) {
    console.error('Error fetching colori-fil lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/references-ecru/lookups/machines — knitting machines (Métier picker)
referencesEcruRouter.get('/lookups/machines', async (_req: Request, res: Response) => {
  try {
    // `nom` carries the métier's label — its emplacement ("1G"), the brand in
    // machine.nom only as a fallback (machineLabel(), LIVA #1199).
    const machines = (await selectMachines())
      .map((m) => ({ IDmachine: m.id, nom: machineLabel(m), Jauge: m.jauge }))
      .filter((m) => m.nom.length > 0)
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr', { numeric: true }))
    res.json(machines)
  } catch (err) {
    console.error('Error fetching machines lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/references-ecru/lookups/symboles — liage symbol palette
referencesEcruRouter.get('/lookups/symboles', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDsymbole_liage: number; icone: string | null }>(
      `SELECT IDsymbole_liage, icone FROM symbole_liage ORDER BY IDsymbole_liage`,
    )
    res.json(rows.map((r) => ({ IDsymbole_liage: Number(r.IDsymbole_liage) || 0, icone: r.icone ?? null })))
  } catch (err) {
    console.error('Error fetching symboles lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// LIST
// ──────────────────────────────────────────────────────────

// GET /api/references-ecru?archived=0|1
referencesEcruRouter.get('/', async (req: Request, res: Response) => {
  try {
    const wantArchived = req.query.archived === '1'
    const rawRows = await query<Record<string, unknown>>(`SELECT * FROM ref_ecru ORDER BY reference`)
    const filtered = rawRows.filter((r) => isArchive(r) === wantArchived)
    let refs = filtered.map((r) => normalizeRefEcru(r))
    refs = (await batchRepair(refs as any, 'ref_ecru', 'IDref_ecru', ['reference', 'designation'])) as RefEcru[]

    if (refs.length === 0) {
      res.json([])
      return
    }

    // Coloris count per ref (colori_ecru — explicit columns).
    const coloriCountByRef = new Map<number, number>()
    try {
      const c = await query<{ IDref_ecru: number; n: number }>(
        `SELECT IDref_ecru, COUNT(*) AS n FROM colori_ecru GROUP BY IDref_ecru`,
      )
      for (const r of c) coloriCountByRef.set(Number(r.IDref_ecru), Number(r.n))
    } catch { /* tolerate */ }

    // Contexture names.
    const ctxByid = new Map<number, string>()
    try {
      const ctx = await query<{ IDcontexture: number; nom: string | null }>(`SELECT IDcontexture, nom FROM contexture`)
      const ctxFixed = await fixEncoding(ctx, 'contexture', 'IDcontexture', ['nom'])
      for (const r of ctxFixed) ctxByid.set(Number(r.IDcontexture), String(r.nom ?? ''))
    } catch { /* tolerate */ }

    const out = refs.map((r) => ({
      IDref_ecru: r.IDref_ecru,
      reference: r.reference,
      designation: r.designation,
      contexture_nom: ctxByid.get(r.IDcontexture) ?? null,
      bio: r.bio,
      recycle: r.recycle,
      archive: r.archive,
      prix: r.prix,
      Jauge: r.Jauge,
      diametre: r.diametre,
      coloris_count: coloriCountByRef.get(r.IDref_ecru) ?? 0,
    }))
    res.json(out)
  } catch (err) {
    console.error('Error fetching ref_ecru list:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// DETAIL
// ──────────────────────────────────────────────────────────

// GET /api/references-ecru/:id
referencesEcruRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await query<Record<string, unknown>>(`SELECT * FROM ref_ecru WHERE IDref_ecru = ${id}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Ref ecru not found' }); return }
    let ref = normalizeRefEcru(rows[0])
    const fixed = (await fixEncoding(
      [ref] as any,
      'ref_ecru',
      'IDref_ecru',
      ['reference', 'designation', 'composition', 'reference_client', 'commentaire', 'observations', 'tombe_metier'],
    )) as RefEcru[]
    ref = fixed[0]

    // Contexture + client names.
    let contexture_nom: string | null = null
    if (ref.IDcontexture > 0) {
      const c = await query<{ nom: string | null }>(`SELECT nom FROM contexture WHERE IDcontexture = ${ref.IDcontexture}`)
      if (c.length > 0) {
        const cf = await fixEncoding(c.map((x) => ({ IDcontexture: ref.IDcontexture, nom: x.nom })), 'contexture', 'IDcontexture', ['nom'])
        contexture_nom = cf[0]?.nom ?? null
      }
    }
    let client_nom: string | null = null
    if (ref.IDclient > 0) {
      const c = await query<{ nom: string | null }>(`SELECT nom FROM client WHERE IDclient = ${ref.IDclient}`)
      if (c.length > 0) {
        const cf = await batchRepair(c.map((x) => ({ IDclient: ref.IDclient, nom: x.nom })), 'client', 'IDclient', ['nom'])
        client_nom = cf[0]?.nom ?? null
      }
    }

    // Base composition (IDcolori_ecru = 0) — composition_ecru is all ASCII.
    const compRows = await query<{
      IDcomposition_ecru: number
      IDref_fil: number
      IDcolori_fil: number
      pourcentage: number | null
      commentaire: string | null
    }>(
      `SELECT IDcomposition_ecru, IDref_fil, IDcolori_fil, pourcentage, commentaire
       FROM composition_ecru WHERE IDref_ecru = ${id} AND IDcolori_ecru = 0 ORDER BY IDcomposition_ecru`,
    )
    const compFixed = await fixEncoding(compRows, 'composition_ecru', 'IDcomposition_ecru', ['commentaire'])

    // Resolve yarn reference + price for each composition line + cost/kg.
    const refFilIds = Array.from(new Set(compFixed.map((c) => Number(c.IDref_fil)).filter((n) => n > 0)))
    const yarnById = new Map<number, { reference: string | null; prix_kg: number | null }>()
    if (refFilIds.length > 0) {
      const yarns = await query<{ IDref_fil: number; reference: string | null; prix_kg: number | null }>(
        `SELECT IDref_fil, reference, prix_kg FROM ref_fil WHERE IDref_fil IN (${refFilIds.join(',')})`,
      )
      const yarnsFixed = await batchRepair(
        yarns.map((y) => ({ IDref_fil: Number(y.IDref_fil) || 0, reference: y.reference ?? null, prix_kg: toNumOrNull(y.prix_kg) })),
        'ref_fil',
        'IDref_fil',
        ['reference'],
      )
      for (const y of yarnsFixed) yarnById.set(y.IDref_fil, { reference: y.reference, prix_kg: y.prix_kg })
    }
    const compositionLines = compFixed.map((c) => {
      const y = yarnById.get(Number(c.IDref_fil))
      return {
        IDcomposition_ecru: Number(c.IDcomposition_ecru) || 0,
        IDref_fil: Number(c.IDref_fil) || 0,
        IDcolori_fil: Number(c.IDcolori_fil) || 0,
        ref_fil_reference: y?.reference ?? null,
        prix_kg: y?.prix_kg ?? null,
        pourcentage: toNumOrNull(c.pourcentage),
        commentaire: c.commentaire ?? null,
      }
    })
    // Coût/kg = façon price (ref_ecru.prix) + Σ(pourcentage × yarn prix_kg)/100.
    const yarnCost = compositionLines.reduce(
      (sum, c) => sum + ((Number(c.pourcentage) || 0) * (Number(c.prix_kg) || 0)) / 100,
      0,
    )
    const cout_kg = Math.round(((ref.prix ?? 0) + yarnCost) * 100) / 100

    // Coloris (colori_ecru — explicit columns; SELECT * fails).
    const colRows = await query<{ IDcolori_ecru: number; reference: string | null; commentaire: string | null; suivis: number | null }>(
      `SELECT IDcolori_ecru, reference, commentaire, suivis FROM colori_ecru WHERE IDref_ecru = ${id} ORDER BY reference`,
    )
    const colFixed = await fixEncoding(colRows, 'colori_ecru', 'IDcolori_ecru', ['reference', 'commentaire'])
    const coloris = colFixed.map((c) => ({
      IDcolori_ecru: Number(c.IDcolori_ecru) || 0,
      reference: c.reference ?? null,
      commentaire: c.commentaire ?? null,
      suivis: Number(c.suivis) ? 1 : 0,
    }))

    // Per-coloris usage → drives the delete padlock. Same reader as the DELETE
    // guard, so the screen and the server always agree (LIVA #1203).
    const usage = await colorisUsage(coloris.map((c) => c.IDcolori_ecru))
    // Each coloris's own composition — the one orders, OFs and the sst
    // affectation actually use (LIVA #1205) — with an écart flag against the
    // reference's recipe and its own lock.
    const colorisCompo = await loadColorisCompositions(id, coloris.map((c) => c.IDcolori_ecru))
    const colorisOut = coloris.map((c) => {
      const lines = colorisCompo.lines.get(c.IDcolori_ecru) ?? []
      return {
        ...c,
        in_use: usage.get(c.IDcolori_ecru) ?? null,
        composition: lines,
        composition_ecart: compositionEcart(compFixed, lines),
        composition_lock: colorisCompo.locks.get(c.IDcolori_ecru) ?? null,
      }
    })

    // Machine grid (ref_ecru_machine — all ASCII) + Métier name + computed compteurs.
    const machRows = await query<{
      IDref_ecru_machine: number
      IDmachine: number
      repere_1: string | null
      repere_2: string | null
      repere_3: string | null
      repere_4: string | null
      repere_5: string | null
      hauteur_pl: string | null
      abattage: string | null
      trs_10kg_chute: number | null
      nb_chutes: number | null
    }>(
      `SELECT IDref_ecru_machine, IDmachine, repere_1, repere_2, repere_3, repere_4, repere_5, hauteur_pl, abattage, trs_10kg_chute, nb_chutes
       FROM ref_ecru_machine WHERE IDref_ecru = ${id} ORDER BY IDref_ecru_machine`,
    )
    const machIds = Array.from(new Set(machRows.map((m) => Number(m.IDmachine)).filter((n) => n > 0)))
    // Métier label = emplacement ("1G"), brand as fallback (LIVA #1199).
    const machNameById = await resolveMachineLabels(machIds)
    const poidsPiece = Number(ref.poids) || 0
    const machines = machRows.map((m) => {
      const trs = Number(m.trs_10kg_chute) || 0
      const nb = Number(m.nb_chutes) || 0
      // Legacy compteur (GWDFFEN_Action_Machine): round((trs/nb)*(poids_piece/20)/10)*10.
      const compteur_saisie = nb > 0 ? Math.round((trs / nb) * (poidsPiece / 20) / 10) * 10 : 0
      return {
        IDref_ecru_machine: Number(m.IDref_ecru_machine) || 0,
        IDmachine: Number(m.IDmachine) || 0,
        machine_nom: machNameById.get(Number(m.IDmachine)) ?? null,
        repere_1: m.repere_1 ?? null,
        repere_2: m.repere_2 ?? null,
        repere_3: m.repere_3 ?? null,
        repere_4: m.repere_4 ?? null,
        repere_5: m.repere_5 ?? null,
        hauteur_pl: m.hauteur_pl ?? null,
        abattage: m.abattage ?? null,
        trs_10kg_chute: toNumOrNull(m.trs_10kg_chute),
        nb_chutes: toNumOrNull(m.nb_chutes),
        compteur_saisie,
        // Compteur Calculé is contextual (needs a live ordre_fabrication poids_piece),
        // which doesn't exist on the references screen → 0 (matches legacy).
        compteur_calcule: 0,
      }
    })

    // Composition lock: rolls (stock_ecru) or tricoteur orders for this ref.
    const lock = await refEcruLock(id)

    // Number of écru rolls (stock_ecru) created for this ref + their total weight.
    let rolls_count = 0
    let rolls_poids_total = 0
    try {
      const rc = await query<{ n: number; poids: number | null }>(
        `SELECT COUNT(*) AS n, SUM(poids) AS poids FROM stock_ecru WHERE IDref_ecru = ${id}`,
      )
      rolls_count = Number(rc[0]?.n ?? 0)
      rolls_poids_total = Number(rc[0]?.poids ?? 0) || 0
    } catch { /* stock_ecru unreachable on some envs — leave 0 */ }

    // Schéma de liage — chutes (rows) + cells.
    const liage = await loadLiage(id)

    // Obs OF — obs_ref_ecru (DATE is reserved → alias). Machine + coloris names.
    const obsRows = await query<{ IDobs_ref_ecru: number; IDmachine: number; IDcolori_ecru: number; observation: string | null; obs_date: string | null }>(
      `SELECT IDobs_ref_ecru, IDmachine, IDcolori_ecru, observation, DATE AS obs_date FROM obs_ref_ecru WHERE IDref_ecru = ${id} ORDER BY DATE DESC, IDobs_ref_ecru DESC`,
    )
    const obsFixed = await fixEncoding(obsRows, 'obs_ref_ecru', 'IDobs_ref_ecru', ['observation'])
    const colNameById = new Map<number, string>()
    for (const c of coloris) colNameById.set(c.IDcolori_ecru, String(c.reference ?? ''))
    const obs_of = obsFixed.map((o) => ({
      IDobs_ref_ecru: Number(o.IDobs_ref_ecru) || 0,
      IDmachine: Number(o.IDmachine) || 0,
      machine_nom: machNameById.get(Number(o.IDmachine)) ?? null,
      IDcolori_ecru: Number(o.IDcolori_ecru) || 0,
      colori_reference: colNameById.get(Number(o.IDcolori_ecru)) ?? null,
      observation: o.observation ?? null,
      date: o.obs_date ?? null,
    }))

    res.json({
      ...ref,
      contexture_nom,
      client_nom,
      composition_lines: compositionLines,
      cout_kg,
      coloris: colorisOut,
      machines,
      ...liage,
      obs_of,
      has_rolls: lock.rolls,
      has_orders: lock.orders,
      rolls_count,
      rolls_poids_total,
    })
  } catch (err) {
    console.error('Error fetching ref_ecru detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/references-ecru/:id/cout-tricotage?qty=<number>
// Detailed breakdown of the TRM knitting cost (PrixDeRevientTRM) for a ref at a
// given quantity. Quantity-dependent (labor amortizes over kg); default 1000.
referencesEcruRouter.get('/:id/cout-tricotage', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await refEcruExists(id))) { res.status(404).json({ error: 'Ref ecru not found' }); return }
    const raw = Number(req.query.qty)
    const qty = Number.isFinite(raw) && raw >= 1 ? raw : 1000
    res.json(await prixDeRevientTRMDetail(id, qty))
  } catch (err) {
    console.error('Error computing cout-tricotage:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Load the liage diagram (chutes + cells + symbol palette) for a ref. */
async function loadLiage(id: number) {
  const chuteRows = await query<{
    IDchute_liage: number
    num_chute: number
    IDcomposition_ecru1: number
    IDcomposition_ecru2: number
    lfa1: number | null
    lfa2: number | null
  }>(
    `SELECT IDchute_liage, num_chute, IDcomposition_ecru1, IDcomposition_ecru2, lfa1, lfa2
     FROM chute_liage WHERE IDref_ecru = ${id} ORDER BY num_chute`,
  )
  const cellRows = await query<{ IDschema_liage: number; IDchute_liage: number; num_symbole: number; IDsymbole_liage: number }>(
    `SELECT IDschema_liage, IDchute_liage, num_symbole, IDsymbole_liage FROM schema_liage WHERE IDref_ecru = ${id} ORDER BY IDchute_liage, num_symbole`,
  )
  const symRows = await query<{ IDsymbole_liage: number; icone: string | null }>(
    `SELECT IDsymbole_liage, icone FROM symbole_liage ORDER BY IDsymbole_liage`,
  )
  return {
    chutes: chuteRows.map((c) => ({
      IDchute_liage: Number(c.IDchute_liage) || 0,
      num_chute: Number(c.num_chute) || 0,
      IDcomposition_ecru1: Number(c.IDcomposition_ecru1) || 0,
      IDcomposition_ecru2: Number(c.IDcomposition_ecru2) || 0,
      lfa1: toNumOrNull(c.lfa1),
      lfa2: toNumOrNull(c.lfa2),
    })),
    cells: cellRows.map((c) => ({
      IDschema_liage: Number(c.IDschema_liage) || 0,
      IDchute_liage: Number(c.IDchute_liage) || 0,
      num_symbole: Number(c.num_symbole) || 0,
      IDsymbole_liage: Number(c.IDsymbole_liage) || 0,
    })),
    symboles: symRows.map((s) => ({ IDsymbole_liage: Number(s.IDsymbole_liage) || 0, icone: s.icone ?? null })),
  }
}

// ──────────────────────────────────────────────────────────
// REF_ECRU CRUD
// ──────────────────────────────────────────────────────────

const refEcruBody = z.object({
  reference: z.string().min(1).max(100),
  designation: z.string().optional().nullable(),
  composition: z.string().optional().nullable(),
  reference_client: z.string().optional().nullable(),
  IDclient: z.number().int().nonnegative().optional().nullable(),
  IDcontexture: z.number().int().nonnegative().optional().nullable(),
  prix: z.number().optional().nullable(),
  poids: z.number().optional().nullable(),
  Jauge: z.number().optional().nullable(),
  diametre: z.number().optional().nullable(),
  bio: z.boolean().optional(),
  recycle: z.boolean().optional(),
  commentaire: z.string().optional().nullable(),
  observations: z.string().optional().nullable(),
  tombe_metier: z.string().optional().nullable(),
  lfa_tour_1: z.string().optional().nullable(),
  lfa_tour_2: z.string().optional().nullable(),
  lfa_tour_3: z.string().optional().nullable(),
  lfa_tour_4: z.string().optional().nullable(),
  poulies_1: z.string().optional().nullable(),
  poulies_2: z.string().optional().nullable(),
  poulies_3: z.string().optional().nullable(),
  poulies_4: z.string().optional().nullable(),
  ecarteur: z.number().optional().nullable(),
  laize_tbm: z.number().optional().nullable(),
  poids_m2_tbm: z.number().optional().nullable(),
  rendement: z.number().optional().nullable(),
  vitesse_cible: z.number().optional().nullable(),
  nb_chutes: z.number().optional().nullable(),
  nb_aiguilles: z.number().optional().nullable(),
  maille_ouverture: z.boolean().optional(),
  ouvert_visiteuse: z.boolean().optional(),
  sonneter: z.boolean().optional(),
})

type RefEcruBody = z.infer<typeof refEcruBody>

/** Build the SET clauses for a ref_ecru UPDATE. ASCII columns always; the
 *  accented diamètre / recyclé only on Windows (Linux can't name them — same
 *  documented limitation as references-fil.ts skips recyclé). archivé is never
 *  set here (use the archive endpoint). */
function buildRefEcruSets(b: RefEcruBody): string[] {
  const sets: string[] = []
  sets.push(`reference = ${sqlText(b.reference)}`)
  sets.push(`designation = ${sqlText(b.designation ?? '')}`)
  sets.push(`composition = ${sqlText(b.composition ?? '')}`)
  sets.push(`reference_client = ${sqlText(b.reference_client ?? '')}`)
  sets.push(`IDclient = ${Number(b.IDclient) || 0}`)
  sets.push(`IDcontexture = ${Number(b.IDcontexture) || 0}`)
  sets.push(`prix = ${toNumOrNull(b.prix) ?? 0}`)
  sets.push(`poids = ${toNumOrNull(b.poids) ?? 0}`)
  sets.push(`Jauge = ${toNumOrNull(b.Jauge) ?? 0}`)
  sets.push(`bio = ${b.bio ? 1 : 0}`)
  sets.push(`commentaire = ${sqlText(b.commentaire ?? '')}`)
  sets.push(`observations = ${sqlText(b.observations ?? '')}`)
  sets.push(`tombe_metier = ${sqlText(b.tombe_metier ?? '')}`)
  sets.push(`lfa_tour_1 = ${sqlText(b.lfa_tour_1 ?? '')}`)
  sets.push(`lfa_tour_2 = ${sqlText(b.lfa_tour_2 ?? '')}`)
  sets.push(`lfa_tour_3 = ${sqlText(b.lfa_tour_3 ?? '')}`)
  sets.push(`lfa_tour_4 = ${sqlText(b.lfa_tour_4 ?? '')}`)
  sets.push(`poulies_1 = ${sqlText(b.poulies_1 ?? '')}`)
  sets.push(`poulies_2 = ${sqlText(b.poulies_2 ?? '')}`)
  sets.push(`poulies_3 = ${sqlText(b.poulies_3 ?? '')}`)
  sets.push(`poulies_4 = ${sqlText(b.poulies_4 ?? '')}`)
  sets.push(`ecarteur = ${toNumOrNull(b.ecarteur) ?? 0}`)
  sets.push(`laize_tbm = ${toNumOrNull(b.laize_tbm) ?? 0}`)
  sets.push(`poids_m2_tbm = ${toNumOrNull(b.poids_m2_tbm) ?? 0}`)
  sets.push(`rendement = ${toNumOrNull(b.rendement) ?? 0}`)
  sets.push(`vitesse_cible = ${toNumOrNull(b.vitesse_cible) ?? 0}`)
  sets.push(`nb_chutes = ${toNumOrNull(b.nb_chutes) ?? 0}`)
  sets.push(`nb_aiguilles = ${toNumOrNull(b.nb_aiguilles) ?? 0}`)
  sets.push(`maille_ouverture = ${b.maille_ouverture ? 1 : 0}`)
  sets.push(`ouvert_visiteuse = ${b.ouvert_visiteuse ? 1 : 0}`)
  sets.push(`sonneter = ${b.sonneter ? 1 : 0}`)
  sets.push(`date_maj_ft = '${todayHfsql()}'`)
  if (IS_WINDOWS) {
    sets.push(`diamètre = ${toNumOrNull(b.diametre) ?? 0}`)
    sets.push(`recyclé = ${b.recycle ? 1 : 0}`)
  }
  return sets
}

/** Next free 3-digit zero-padded reference (001, 002, …). The sequence is the
 *  zero-padded numeric scheme (`0NN`) only — independent of legacy non-padded
 *  numbers (180, 2785) and alphanumeric codes (MADF, 228/122). Increments past
 *  any collision so it never returns an existing reference. */
function nextRefNumber(existing: string[]): string {
  const used = new Set(existing.map((r) => r.trim().toLowerCase()).filter(Boolean))
  let maxN = 0
  for (const r of existing) {
    const t = r.trim()
    if (/^0\d\d$/.test(t)) maxN = Math.max(maxN, Number(t))
  }
  let n = maxN + 1
  let candidate = String(n).padStart(3, '0')
  while (used.has(candidate.toLowerCase())) {
    n += 1
    candidate = String(n).padStart(3, '0')
  }
  return candidate
}

// POST /api/references-ecru — inline-create a row, auto-named with the next
// free 3-digit zero-padded reference (server-generated; client input ignored so
// two concurrent creates can't collide on the same placeholder name).
referencesEcruRouter.post('/', async (_req: Request, res: Response) => {
  try {
    const existingRows = await query<{ reference: string | null }>(`SELECT reference FROM ref_ecru`)
    const reference = nextRefNumber(existingRows.map((r) => r.reference ?? ''))
    // archivé is never NAMED — the Linux bridge cannot resolve it and an unknown
    // column storms the shared server (same fix as « Dupliquer », #1186). Left
    // out, it zero-fills, which is what a new reference wants.
    await query(
      `INSERT INTO ref_ecru (reference, designation, IDclient, IDcontexture, prix, bio, date_maj_ft)
       VALUES (${sqlText(reference)}, '', 0, 0, 0, 0, '${todayHfsql()}')`,
    )
    const rows = await query<{ IDref_ecru: number }>(
      `SELECT IDref_ecru FROM ref_ecru WHERE reference = ${sqlText(reference)} ORDER BY IDref_ecru DESC`,
    )
    res.status(201).json({ IDref_ecru: rows[0]?.IDref_ecru ?? null })
  } catch (err) {
    console.error('Error creating ref_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/references-ecru/:id
referencesEcruRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = refEcruBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    // Reject a reference already used by another row (HFSQL `=` ignores case and
    // trailing spaces, which matches how the user perceives a duplicate).
    const dup = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ref_ecru WHERE reference = ${sqlText(parsed.data.reference.trim())} AND IDref_ecru <> ${id}`,
    )
    if (Number(dup[0]?.n ?? 0) > 0) {
      res.status(409).json({ error: 'Cette référence existe déjà.' })
      return
    }
    // Freeze the fabric-defining fields (contexture, jauge, diamètre, bio,
    // recyclé) once rolls or orders exist — changing them would desync produced
    // stock from its declared nature. Silently keep the stored values so a
    // stale/tampering client can't change them (other header fields still save).
    const lock = await refEcruLock(id)
    if (lock.rolls || lock.orders) {
      const curRows = await query<Record<string, unknown>>(`SELECT * FROM ref_ecru WHERE IDref_ecru = ${id}`)
      if (curRows.length > 0) {
        const cur = normalizeRefEcru(curRows[0])
        parsed.data.IDcontexture = cur.IDcontexture
        parsed.data.Jauge = cur.Jauge
        parsed.data.diametre = cur.diametre
        parsed.data.bio = !!cur.bio
        parsed.data.recycle = !!cur.recycle
      }
    }
    const sets = buildRefEcruSets(parsed.data)
    await query(`UPDATE ref_ecru SET ${sets.join(', ')} WHERE IDref_ecru = ${id}`)
    res.json({ ok: true, _linux_accented_skipped: !IS_WINDOWS })
  } catch (err) {
    console.error('Error updating ref_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Physical column order of ref_ecru (from SELECT * key order). Used only for the
// Linux archive path (delete + positional reinsert preserving the ASCII PK).
const REF_ECRU_PHYSICAL_COLS = [
  'IDref_ecru', 'IDclient', 'reference_client', 'poids', 'ouvert_visiteuse', 'maille_ouverture',
  'prix', 'commentaire', 'reference', 'designation', 'composition', 'date_maj_ft',
  'lfa_tour_1', 'lfa_tour_2', 'lfa_tour_3', 'lfa_tour_4', 'poulies_1', 'poulies_2', 'poulies_3', 'poulies_4',
  'ecarteur', 'laize_tbm', 'poids_m2_tbm', 'rendement', 'tombe_metier', 'observations',
  'archive', 'IDcontexture', 'Jauge', 'diametre', 'bio', 'recycle', 'sonneter',
  'nb_chutes', 'nb_aiguilles', 'vitesse_cible',
] as const
const TEXT_COL_IDX = new Set([2, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 24, 25]) // text/memo/date columns

/** Flip ref_ecru.archivé. Windows: named UPDATE. Linux: read SELECT * (values in
 *  physical order survive the mangled accented keys), flip the archive slot,
 *  delete and positional-reinsert preserving the PK. */
async function setArchive(id: number, value: 0 | 1): Promise<void> {
  if (IS_WINDOWS) {
    await query(`UPDATE ref_ecru SET archivé = ${value} WHERE IDref_ecru = ${id}`)
    return
  }
  const rows = await queryRaw(`SELECT * FROM ref_ecru WHERE IDref_ecru = ${id}`)
  if (rows.length === 0) return
  const vals = Object.values(rows[0])
  const archiveIdx = REF_ECRU_PHYSICAL_COLS.indexOf('archive' as any)
  vals[archiveIdx] = value
  const literals = vals.map((v, i) => {
    if (v == null) return TEXT_COL_IDX.has(i) ? "''" : '0'
    if (TEXT_COL_IDX.has(i)) {
      const s = v instanceof ArrayBuffer ? Buffer.from(v).toString('latin1') : String(v)
      return sqlText(s)
    }
    const n = Number(v)
    return Number.isFinite(n) ? String(n) : '0'
  })
  await query(`DELETE FROM ref_ecru WHERE IDref_ecru = ${id}`)
  await query(`INSERT INTO ref_ecru VALUES (${literals.join(', ')})`)
}

// POST /api/references-ecru/:id/archive  &  /unarchive
referencesEcruRouter.post('/:id/archive', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await setArchive(id, 1)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error archiving ref_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

referencesEcruRouter.post('/:id/unarchive', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await setArchive(id, 0)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error unarchiving ref_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/references-ecru/:id/duplicate — copy ref + composition + coloris +
// machine grid + liage diagram into a fresh reference. Windows-complete; on Linux
// the accented columns of the cloned ref default to 0 (documented limitation).
// The INSERT must never NAME an accented column: `archivé` there made every prod
// duplicate fail before the first row (found on LIVA #1186) — left out, it
// defaults to 0, which is what a fresh copy wants anyway.
referencesEcruRouter.post('/:id/duplicate', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const srcRows = await query<Record<string, unknown>>(`SELECT * FROM ref_ecru WHERE IDref_ecru = ${id}`)
    if (srcRows.length === 0) { res.status(404).json({ error: 'Ref ecru not found' }); return }
    let src = normalizeRefEcru(srcRows[0])
    src = ((await fixEncoding([src] as any, 'ref_ecru', 'IDref_ecru',
      ['reference', 'designation', 'composition', 'reference_client', 'commentaire', 'observations', 'tombe_metier'])) as RefEcru[])[0]

    const newRef = `${src.reference ?? 'ref'}-copie`
    // Insert via the same SET builder (named columns) — reuse buildRefEcruSets by
    // faking a body, then turning SETs into an INSERT-from-defaults UPDATE.
    await query(
      `INSERT INTO ref_ecru (reference, designation, IDclient, IDcontexture, prix, bio, date_maj_ft)
       VALUES (${sqlText(newRef)}, '', 0, 0, 0, 0, '${todayHfsql()}')`,
    )
    const created = await query<{ IDref_ecru: number }>(
      `SELECT IDref_ecru FROM ref_ecru WHERE reference = ${sqlText(newRef)} ORDER BY IDref_ecru DESC`,
    )
    const newId = created[0]?.IDref_ecru
    if (!newId) { res.status(500).json({ error: 'Duplicate failed' }); return }

    const body: RefEcruBody = {
      reference: newRef,
      designation: src.designation,
      composition: src.composition,
      reference_client: src.reference_client,
      IDclient: src.IDclient,
      IDcontexture: src.IDcontexture,
      prix: src.prix,
      poids: src.poids,
      Jauge: src.Jauge,
      diametre: src.diametre,
      bio: !!src.bio,
      recycle: !!src.recycle,
      commentaire: src.commentaire,
      observations: src.observations,
      tombe_metier: src.tombe_metier,
      lfa_tour_1: src.lfa_tour_1, lfa_tour_2: src.lfa_tour_2, lfa_tour_3: src.lfa_tour_3, lfa_tour_4: src.lfa_tour_4,
      poulies_1: src.poulies_1, poulies_2: src.poulies_2, poulies_3: src.poulies_3, poulies_4: src.poulies_4,
      ecarteur: src.ecarteur, laize_tbm: src.laize_tbm, poids_m2_tbm: src.poids_m2_tbm, rendement: src.rendement,
      vitesse_cible: src.vitesse_cible, nb_chutes: src.nb_chutes, nb_aiguilles: src.nb_aiguilles,
      maille_ouverture: !!src.maille_ouverture, ouvert_visiteuse: !!src.ouvert_visiteuse, sonneter: !!src.sonneter,
    }
    await query(`UPDATE ref_ecru SET ${buildRefEcruSets(body).join(', ')} WHERE IDref_ecru = ${newId}`)

    // Coloris (colori_ecru) — old→new id map for composition remap.
    const coloriMap = new Map<number, number>()
    const cols = await query<{ IDcolori_ecru: number; reference: string | null; commentaire: string | null; suivis: number | null }>(
      `SELECT IDcolori_ecru, reference, commentaire, suivis FROM colori_ecru WHERE IDref_ecru = ${id}`,
    )
    for (const c of cols) {
      await query(
        `INSERT INTO colori_ecru (IDref_ecru, reference, commentaire, suivis) VALUES (${newId}, ${sqlText(c.reference ?? '')}, ${sqlText(c.commentaire ?? '')}, ${Number(c.suivis) ? 1 : 0})`,
      )
      const nc = await query<{ IDcolori_ecru: number }>(
        `SELECT IDcolori_ecru FROM colori_ecru WHERE IDref_ecru = ${newId} AND reference = ${sqlText(c.reference ?? '')} ORDER BY IDcolori_ecru DESC`,
      )
      if (nc[0]?.IDcolori_ecru) coloriMap.set(Number(c.IDcolori_ecru), Number(nc[0].IDcolori_ecru))
    }

    // Composition (composition_ecru) — remap IDcolori_ecru (0 stays 0).
    const compMap = new Map<number, number>()
    const comps = await query<{ IDcomposition_ecru: number; IDcolori_ecru: number; IDref_fil: number; IDcolori_fil: number; pourcentage: number | null; commentaire: string | null }>(
      `SELECT IDcomposition_ecru, IDcolori_ecru, IDref_fil, IDcolori_fil, pourcentage, commentaire FROM composition_ecru WHERE IDref_ecru = ${id}`,
    )
    for (const c of comps) {
      const newColori = Number(c.IDcolori_ecru) === 0 ? 0 : (coloriMap.get(Number(c.IDcolori_ecru)) ?? 0)
      await query(
        `INSERT INTO composition_ecru (IDref_ecru, IDcolori_ecru, IDref_fil, IDcolori_fil, pourcentage, commentaire)
         VALUES (${newId}, ${newColori}, ${Number(c.IDref_fil) || 0}, ${Number(c.IDcolori_fil) || 0}, ${toNumOrNull(c.pourcentage) ?? 0}, ${sqlText(c.commentaire ?? '')})`,
      )
      const ncomp = await query<{ IDcomposition_ecru: number }>(
        `SELECT IDcomposition_ecru FROM composition_ecru WHERE IDref_ecru = ${newId} AND IDref_fil = ${Number(c.IDref_fil) || 0} ORDER BY IDcomposition_ecru DESC`,
      )
      if (ncomp[0]?.IDcomposition_ecru) compMap.set(Number(c.IDcomposition_ecru), Number(ncomp[0].IDcomposition_ecru))
    }

    // Machine grid (ref_ecru_machine).
    const machs = await query<Record<string, unknown>>(
      `SELECT IDmachine, repere_1, repere_2, repere_3, repere_4, repere_5, hauteur_pl, abattage, trs_10kg_chute, nb_chutes FROM ref_ecru_machine WHERE IDref_ecru = ${id}`,
    )
    for (const m of machs) {
      await query(
        `INSERT INTO ref_ecru_machine (IDref_ecru, IDmachine, repere_1, repere_2, repere_3, repere_4, repere_5, hauteur_pl, abattage, trs_10kg_chute, nb_chutes)
         VALUES (${newId}, ${Number(m.IDmachine) || 0}, ${sqlText(String(m.repere_1 ?? ''))}, ${sqlText(String(m.repere_2 ?? ''))}, ${sqlText(String(m.repere_3 ?? ''))}, ${sqlText(String(m.repere_4 ?? ''))}, ${sqlText(String(m.repere_5 ?? ''))}, ${sqlText(String(m.hauteur_pl ?? ''))}, ${sqlText(String(m.abattage ?? ''))}, ${toNumOrNull(m.trs_10kg_chute) ?? 0}, ${toNumOrNull(m.nb_chutes) ?? 0})`,
      )
    }

    // Liage — chutes (remap composition ids) then cells (remap chute ids).
    const chuteMap = new Map<number, number>()
    const chutes = await query<{ IDchute_liage: number; num_chute: number; IDcomposition_ecru1: number; IDcomposition_ecru2: number; lfa1: number | null; lfa2: number | null }>(
      `SELECT IDchute_liage, num_chute, IDcomposition_ecru1, IDcomposition_ecru2, lfa1, lfa2 FROM chute_liage WHERE IDref_ecru = ${id}`,
    )
    for (const c of chutes) {
      const comp1 = compMap.get(Number(c.IDcomposition_ecru1)) ?? 0
      const comp2 = compMap.get(Number(c.IDcomposition_ecru2)) ?? 0
      await query(
        `INSERT INTO chute_liage (IDref_ecru, num_chute, IDcomposition_ecru1, IDcomposition_ecru2, lfa1, lfa2)
         VALUES (${newId}, ${Number(c.num_chute) || 0}, ${comp1}, ${comp2}, ${toNumOrNull(c.lfa1) ?? 0}, ${toNumOrNull(c.lfa2) ?? 0})`,
      )
      const nch = await query<{ IDchute_liage: number }>(
        `SELECT IDchute_liage FROM chute_liage WHERE IDref_ecru = ${newId} AND num_chute = ${Number(c.num_chute) || 0} ORDER BY IDchute_liage DESC`,
      )
      if (nch[0]?.IDchute_liage) chuteMap.set(Number(c.IDchute_liage), Number(nch[0].IDchute_liage))
    }
    const cells = await query<{ IDchute_liage: number; num_symbole: number; IDsymbole_liage: number }>(
      `SELECT IDchute_liage, num_symbole, IDsymbole_liage FROM schema_liage WHERE IDref_ecru = ${id}`,
    )
    for (const c of cells) {
      const newChute = chuteMap.get(Number(c.IDchute_liage)) ?? 0
      if (!newChute) continue
      await query(
        `INSERT INTO schema_liage (IDref_ecru, num_symbole, IDsymbole_liage, IDchute_liage)
         VALUES (${newId}, ${Number(c.num_symbole) || 0}, ${Number(c.IDsymbole_liage) || 0}, ${newChute})`,
      )
    }

    res.status(201).json({ IDref_ecru: newId })
  } catch (err) {
    console.error('Error duplicating ref_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-ecru/:id — guarded against in-use references.
referencesEcruRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const refFini = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ref_fini WHERE IDref_ecru = ${id}`)
    if (Number(refFini[0]?.n ?? 0) > 0) {
      res.status(409).json({ error: 'Cette référence écru est utilisée par des références finies.' })
      return
    }
    try {
      const stock = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_ecru WHERE IDref_ecru = ${id}`)
      if (Number(stock[0]?.n ?? 0) > 0) {
        res.status(409).json({ error: 'Cette référence écru est utilisée par des lots de stock.' })
        return
      }
    } catch { /* stock_ecru may not be reachable on all envs — tolerate */ }

    // Cascade the owned sub-resources, then the ref.
    await query(`DELETE FROM schema_liage WHERE IDref_ecru = ${id}`)
    await query(`DELETE FROM chute_liage WHERE IDref_ecru = ${id}`)
    await query(`DELETE FROM ref_ecru_machine WHERE IDref_ecru = ${id}`)
    await query(`DELETE FROM composition_ecru WHERE IDref_ecru = ${id}`)
    await query(`DELETE FROM colori_ecru WHERE IDref_ecru = ${id}`)
    await query(`DELETE FROM ref_ecru WHERE IDref_ecru = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting ref_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// COMPOSITION (composition_ecru) — base composition (IDcolori_ecru = 0), ASCII cols
// ──────────────────────────────────────────────────────────

const compositionBody = z.object({
  IDref_fil: z.number().int().positive(),
  IDcolori_fil: z.number().int().nonnegative().optional(),
  pourcentage: z.number().min(0).max(100),
  commentaire: z.string().optional().nullable(),
})

async function refEcruExists(id: number): Promise<boolean> {
  const r = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ref_ecru WHERE IDref_ecru = ${id}`)
  return Number(r[0]?.n ?? 0) > 0
}

/** Whether a ref_ecru has rolls (stock_ecru) or tricoteur orders
 *  (ligne_commande_sous_traitant, type 0/1 → IDreference is a ref_ecru). Used to
 *  lock composition edits: changing the yarn mix after rolls/orders exist would
 *  desync produced stock from its declared composition. */
async function refEcruLock(id: number): Promise<{ rolls: boolean; orders: boolean }> {
  let rolls = false
  try {
    const r = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_ecru WHERE IDref_ecru = ${id}`)
    rolls = Number(r[0]?.n ?? 0) > 0
  } catch { /* stock_ecru may be unreachable on some envs — treat as no rolls */ }
  let orders = false
  try {
    const o = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ligne_commande_sous_traitant WHERE IDreference = ${id} AND type IN (0, 1)`,
    )
    orders = Number(o[0]?.n ?? 0) > 0
  } catch { /* tolerate */ }
  return { rolls, orders }
}

const COMPO_LOCK_MSG =
  'La composition ne peut pas être modifiée : des rouleaux ou des commandes existent déjà pour cette référence.'

// POST /api/references-ecru/:id/compositions
referencesEcruRouter.post('/:id/compositions', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = compositionBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    if (!(await refEcruExists(id))) { res.status(404).json({ error: 'Reference not found' }); return }
    const lock = await refEcruLock(id)
    if (lock.rolls || lock.orders) { res.status(409).json({ error: COMPO_LOCK_MSG }); return }
    const b = parsed.data
    await query(
      `INSERT INTO composition_ecru (IDref_ecru, IDcolori_ecru, IDref_fil, IDcolori_fil, pourcentage, commentaire)
       VALUES (${id}, 0, ${b.IDref_fil}, ${b.IDcolori_fil ?? 0}, ${b.pourcentage}, ${sqlText(b.commentaire ?? '')})`,
    )
    const rows = await query<{ IDcomposition_ecru: number }>(
      `SELECT IDcomposition_ecru FROM composition_ecru WHERE IDref_ecru = ${id} AND IDcolori_ecru = 0 AND IDref_fil = ${b.IDref_fil} ORDER BY IDcomposition_ecru DESC`,
    )
    res.status(201).json({ IDcomposition_ecru: rows[0]?.IDcomposition_ecru ?? null })
  } catch (err) {
    console.error('Error creating composition_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/references-ecru/:id/compositions/:compoId
referencesEcruRouter.put('/:id/compositions/:compoId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const compoId = parseInt(req.params.compoId, 10)
    if (isNaN(id) || isNaN(compoId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = compositionBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM composition_ecru WHERE IDcomposition_ecru = ${compoId} AND IDref_ecru = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) { res.status(404).json({ error: 'Composition not found for this reference' }); return }
    const lock = await refEcruLock(id)
    if (lock.rolls || lock.orders) { res.status(409).json({ error: COMPO_LOCK_MSG }); return }
    const b = parsed.data
    await query(
      `UPDATE composition_ecru SET IDref_fil = ${b.IDref_fil}, IDcolori_fil = ${b.IDcolori_fil ?? 0}, pourcentage = ${b.pourcentage}, commentaire = ${sqlText(b.commentaire ?? '')} WHERE IDcomposition_ecru = ${compoId}`,
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating composition_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-ecru/:id/compositions/:compoId
referencesEcruRouter.delete('/:id/compositions/:compoId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const compoId = parseInt(req.params.compoId, 10)
    if (isNaN(id) || isNaN(compoId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM composition_ecru WHERE IDcomposition_ecru = ${compoId} AND IDref_ecru = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) { res.status(404).json({ error: 'Composition not found for this reference' }); return }
    const lock = await refEcruLock(id)
    if (lock.rolls || lock.orders) { res.status(409).json({ error: COMPO_LOCK_MSG }); return }
    await query(`DELETE FROM composition_ecru WHERE IDcomposition_ecru = ${compoId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting composition_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// COLORIS (colori_ecru) — explicit columns only (SELECT * fails)
// ──────────────────────────────────────────────────────────

/** What still points at a colori_ecru, in the order the padlock explains it.
 *  Deleting it would leave that row naming a coloris that no longer exists.
 *  The coloris's own composition (composition_ecru rows keyed to it) is NOT a
 *  use: the screen never shows it, so it goes with the coloris (LIVA #1204) —
 *  unless a liage chute names one of its rows. */
type ColorisUse = 'rolls' | 'orders' | 'ofs' | 'ref_fini' | 'chute'

const COLORIS_USE_MSG: Record<ColorisUse, string> = {
  rolls: 'Ce coloris est utilisé par des rouleaux.',
  orders: 'Ce coloris est utilisé par une commande.',
  ofs: 'Ce coloris est utilisé par un ordre de fabrication.',
  ref_fini: 'Ce coloris est utilisé par une référence finie.',
  chute: 'La composition de ce coloris est utilisée par le schéma de liage.',
}

/** First blocking use per coloris id (absent = deletable), one batched query
 *  per table — the single reader behind the detail's padlock and the DELETE
 *  guard. Covers both companies: ETM sst lines (type 0/1 → écru), écru client
 *  lines (TYPE 1, the TRM orders — type 4 is rectiligne, another id space),
 *  TRM OFs and ETM finished refs. LIVA #1203: only rolls, sst lines and
 *  compositions used to be checked. `strict` (the DELETE) lets a failed read
 *  fail the request instead of reading as "unused"; stock_ecru stays tolerated
 *  because some dev envs cannot reach it. */
async function colorisUsage(ids: number[], strict = false): Promise<Map<number, ColorisUse>> {
  const out = new Map<number, ColorisUse>()
  const list = Array.from(new Set(ids.filter((n) => n > 0)))
  if (list.length === 0) return out
  const inList = list.join(',')
  const hits = async (table: string, col: string, extra = '', tolerant = !strict): Promise<Set<number>> => {
    try {
      const rows = await query<{ idc: number; n: number }>(
        `SELECT ${col} AS idc, COUNT(*) AS n FROM ${table} WHERE ${col} IN (${inList})${extra} GROUP BY ${col}`,
      )
      return new Set(rows.filter((r) => Number(r.n) > 0).map((r) => Number(r.idc)))
    } catch (err) {
      if (tolerant) return new Set()
      throw err
    }
  }
  const [rolls, sst, client, ofs, fini, chute] = await Promise.all([
    hits('stock_ecru', 'IDcolori_ecru', '', true),
    hits('ligne_commande_sous_traitant', 'IDColoris', ' AND type IN (0, 1)'),
    hits('ligne_commande_client', 'IDcolori', ' AND TYPE = 1'),
    hits('ordre_fabrication', 'IDcolori_ecru'),
    hits('ref_fini', 'IDcolori_ecru'),
    colorisChuteHits(inList, strict),
  ])
  for (const id of list) {
    const use: ColorisUse | null = rolls.has(id) ? 'rolls'
      : sst.has(id) || client.has(id) ? 'orders'
      : ofs.has(id) ? 'ofs'
      : fini.has(id) ? 'ref_fini'
      : chute.has(id) ? 'chute'
      : null
    if (use) out.set(id, use)
  }
  return out
}

/** Coloris ids whose own composition rows are named by a chute_liage — the
 *  only table holding a composition_ecru id. Two plain reads joined in JS. */
async function colorisChuteHits(inList: string, strict: boolean): Promise<Set<number>> {
  try {
    const compos = await query<{ IDcomposition_ecru: number; IDcolori_ecru: number }>(
      `SELECT IDcomposition_ecru, IDcolori_ecru FROM composition_ecru WHERE IDcolori_ecru IN (${inList})`,
    )
    if (compos.length === 0) return new Set()
    const byCompo = new Map(compos.map((c) => [Number(c.IDcomposition_ecru), Number(c.IDcolori_ecru)]))
    const ids = [...byCompo.keys()].join(',')
    const chutes = await query<{ c1: number; c2: number }>(
      `SELECT IDcomposition_ecru1 AS c1, IDcomposition_ecru2 AS c2 FROM chute_liage
       WHERE IDcomposition_ecru1 IN (${ids}) OR IDcomposition_ecru2 IN (${ids})`,
    )
    const out = new Set<number>()
    for (const ch of chutes) {
      for (const c of [Number(ch.c1), Number(ch.c2)]) {
        const colori = byCompo.get(c)
        if (colori) out.add(colori)
      }
    }
    return out
  } catch (err) {
    if (!strict) return new Set()
    throw err
  }
}

const colorisBody = z.object({
  reference: z.string().min(1).max(100),
  commentaire: z.string().optional().nullable(),
  suivis: z.boolean().optional(),
})

// POST /api/references-ecru/:id/coloris
referencesEcruRouter.post('/:id/coloris', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = colorisBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    if (!(await refEcruExists(id))) { res.status(404).json({ error: 'Reference not found' }); return }
    const b = parsed.data
    await query(
      `INSERT INTO colori_ecru (IDref_ecru, reference, commentaire, suivis) VALUES (${id}, ${sqlText(b.reference)}, ${sqlText(b.commentaire ?? '')}, ${b.suivis ? 1 : 0})`,
    )
    const rows = await query<{ IDcolori_ecru: number }>(
      `SELECT IDcolori_ecru FROM colori_ecru WHERE IDref_ecru = ${id} AND reference = ${sqlText(b.reference)} ORDER BY IDcolori_ecru DESC`,
    )
    res.status(201).json({ IDcolori_ecru: rows[0]?.IDcolori_ecru ?? null })
  } catch (err) {
    console.error('Error creating colori_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/references-ecru/:id/coloris/:coloriId
referencesEcruRouter.put('/:id/coloris/:coloriId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const coloriId = parseInt(req.params.coloriId, 10)
    if (isNaN(id) || isNaN(coloriId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = colorisBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM colori_ecru WHERE IDcolori_ecru = ${coloriId} AND IDref_ecru = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) { res.status(404).json({ error: 'Coloris not found for this reference' }); return }
    const b = parsed.data
    await query(
      `UPDATE colori_ecru SET reference = ${sqlText(b.reference)}, commentaire = ${sqlText(b.commentaire ?? '')}, suivis = ${b.suivis ? 1 : 0} WHERE IDcolori_ecru = ${coloriId}`,
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating colori_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-ecru/:id/coloris/:coloriId — refused while anything
// points at it; the coloris's own composition rows go with it (LIVA #1204).
referencesEcruRouter.delete('/:id/coloris/:coloriId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const coloriId = parseInt(req.params.coloriId, 10)
    if (isNaN(id) || isNaN(coloriId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM colori_ecru WHERE IDcolori_ecru = ${coloriId} AND IDref_ecru = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) { res.status(404).json({ error: 'Coloris not found for this reference' }); return }
    const use = (await colorisUsage([coloriId], true)).get(coloriId)
    if (use) { res.status(409).json({ error: COLORIS_USE_MSG[use], in_use: use }); return }
    await query(`DELETE FROM composition_ecru WHERE IDcolori_ecru = ${coloriId} AND IDref_ecru = ${id}`)
    await query(`DELETE FROM colori_ecru WHERE IDcolori_ecru = ${coloriId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting colori_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// COLORIS COMPOSITION (composition_ecru rows keyed to a colori_ecru) — LIVA #1205
// ──────────────────────────────────────────────────────────
//
// The recipe every yarn-picking reader prefers over the reference's own
// (Stock de fil, « Créer un OF », the sst affectation, the PDF label). It names
// yarn COLOURS, which the reference's rows do not. Its lock is per coloris and
// narrower than the reference's: only what was knitted or launched in that
// colour (rolls, OFs) freezes it — an order that has not started can still be
// corrected, which is how « ech 55 » arrived with 029's yarns.

type ColorisCompoLock = 'rolls' | 'ofs'

const COLORIS_COMPO_LOCK_MSG: Record<ColorisCompoLock, string> = {
  rolls: 'La composition de ce coloris ne peut plus être modifiée : des rouleaux ont été tricotés dans ce coloris.',
  ofs: 'La composition de ce coloris ne peut plus être modifiée : un ordre de fabrication existe dans ce coloris.',
}

/** Per coloris: its composition lines (yarn + yarn colour names resolved) and
 *  its lock. Flat reads, labels by IN lookups — all-ASCII tables. */
async function loadColorisCompositions(refId: number, coloriIds: number[]) {
  const lines = new Map<number, Array<{
    IDcomposition_ecru: number; IDref_fil: number; ref_fil_reference: string | null
    IDcolori_fil: number; colori_fil_reference: string | null; pourcentage: number | null
  }>>()
  const locks = new Map<number, ColorisCompoLock>()
  const ids = coloriIds.filter((n) => n > 0)
  if (ids.length === 0) return { lines, locks }
  const inList = ids.join(',')

  const rows = await query<{ IDcomposition_ecru: number; IDcolori_ecru: number; IDref_fil: number; IDcolori_fil: number; pourcentage: number | null }>(
    `SELECT IDcomposition_ecru, IDcolori_ecru, IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru
     WHERE IDref_ecru = ${refId} AND IDcolori_ecru IN (${inList}) ORDER BY IDcomposition_ecru`,
  )
  const filIds = Array.from(new Set(rows.map((r) => Number(r.IDref_fil)).filter((n) => n > 0)))
  const cfIds = Array.from(new Set(rows.map((r) => Number(r.IDcolori_fil)).filter((n) => n > 0)))
  const filName = new Map<number, string | null>()
  if (filIds.length > 0) {
    const f = await query<{ IDref_fil: number; reference: string | null }>(
      `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${filIds.join(',')})`,
    )
    for (const r of await batchRepair(f.map((x) => ({ IDref_fil: Number(x.IDref_fil) || 0, reference: x.reference ?? null })), 'ref_fil', 'IDref_fil', ['reference'])) {
      filName.set(r.IDref_fil, r.reference ? String(r.reference).trim() : null)
    }
  }
  const cfName = new Map<number, string | null>()
  if (cfIds.length > 0) {
    const c = await query<{ IDcolori_fil: number; reference: string | null }>(
      `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${cfIds.join(',')})`,
    )
    for (const r of await fixEncoding(c, 'colori_fil', 'IDcolori_fil', ['reference'])) {
      cfName.set(Number(r.IDcolori_fil), r.reference ? String(r.reference).trim() : null)
    }
  }
  for (const r of rows) {
    const k = Number(r.IDcolori_ecru)
    const list = lines.get(k) ?? []
    list.push({
      IDcomposition_ecru: Number(r.IDcomposition_ecru) || 0,
      IDref_fil: Number(r.IDref_fil) || 0,
      ref_fil_reference: filName.get(Number(r.IDref_fil)) ?? null,
      IDcolori_fil: Number(r.IDcolori_fil) || 0,
      colori_fil_reference: cfName.get(Number(r.IDcolori_fil)) ?? null,
      pourcentage: toNumOrNull(r.pourcentage),
    })
    lines.set(k, list)
  }

  const hits = async (table: string): Promise<Set<number>> => {
    try {
      const h = await query<{ idc: number; n: number }>(
        `SELECT IDcolori_ecru AS idc, COUNT(*) AS n FROM ${table} WHERE IDcolori_ecru IN (${inList}) GROUP BY IDcolori_ecru`,
      )
      return new Set(h.filter((x) => Number(x.n) > 0).map((x) => Number(x.idc)))
    } catch { return new Set() } // stock_ecru unreachable on some dev envs
  }
  const [rolls, ofs] = await Promise.all([hits('stock_ecru'), hits('ordre_fabrication')])
  for (const id of ids) {
    if (rolls.has(id)) locks.set(id, 'rolls')
    else if (ofs.has(id)) locks.set(id, 'ofs')
  }
  return { lines, locks }
}

const colorisCompositionBody = z.object({
  lines: z.array(z.object({
    IDref_fil: z.number().int().positive(),
    IDcolori_fil: z.number().int().positive(),
    pourcentage: z.number().gt(0).max(100),
  })).max(20),
}).strict()

// PUT /api/references-ecru/:id/coloris/:coloriId/composition — replace the
// coloris's recipe. Empty = the coloris follows the reference's recipe.
// Row ids are kept in order (planColorisComposition) so a liage chute naming
// one keeps its position; a surplus row a chute names is refused.
referencesEcruRouter.put('/:id/coloris/:coloriId/composition', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const coloriId = parseInt(req.params.coloriId, 10)
    if (isNaN(id) || isNaN(coloriId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = colorisCompositionBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const wanted = parsed.data.lines
    if (!totalOk(wanted)) { res.status(400).json({ error: 'La composition doit totaliser 100 %.' }); return }

    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM colori_ecru WHERE IDcolori_ecru = ${coloriId} AND IDref_ecru = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) { res.status(404).json({ error: 'Coloris not found for this reference' }); return }
    const lock = (await loadColorisCompositions(id, [coloriId])).locks.get(coloriId)
    if (lock) { res.status(409).json({ error: COLORIS_COMPO_LOCK_MSG[lock], lock }); return }

    // Every yarn colour must belong to its yarn — a lot is matched on the pair.
    const cfIds = Array.from(new Set(wanted.map((l) => l.IDcolori_fil)))
    if (cfIds.length > 0) {
      const cf = await query<{ IDcolori_fil: number; IDref_fil: number }>(
        `SELECT IDcolori_fil, IDref_fil FROM colori_fil WHERE IDcolori_fil IN (${cfIds.join(',')})`,
      )
      const owner = new Map(cf.map((c) => [Number(c.IDcolori_fil), Number(c.IDref_fil)]))
      if (wanted.some((l) => owner.get(l.IDcolori_fil) !== l.IDref_fil)) {
        res.status(400).json({ error: 'Un coloris de fil ne correspond pas à son fil.' })
        return
      }
    }

    const existing = await query<{ IDcomposition_ecru: number; IDref_fil: number; IDcolori_fil: number; pourcentage: number | null }>(
      `SELECT IDcomposition_ecru, IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru
       WHERE IDref_ecru = ${id} AND IDcolori_ecru = ${coloriId}`,
    )
    const plan = planColorisComposition(
      existing.map((e) => ({ ...e, IDcomposition_ecru: Number(e.IDcomposition_ecru) || 0 })),
      wanted,
    )
    const deletes = plan.flatMap((w) => (w.kind === 'delete' ? [w.IDcomposition_ecru] : []))
    if (deletes.length > 0) {
      const named = await query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM chute_liage
         WHERE IDcomposition_ecru1 IN (${deletes.join(',')}) OR IDcomposition_ecru2 IN (${deletes.join(',')})`,
      )
      if (Number(named[0]?.n ?? 0) > 0) {
        res.status(409).json({ error: 'Un fil retiré est utilisé par le schéma de liage : retirez-le du schéma d’abord.' })
        return
      }
    }
    for (const w of plan) {
      if (w.kind === 'update') {
        await query(
          `UPDATE composition_ecru SET IDref_fil = ${w.line.IDref_fil}, IDcolori_fil = ${w.line.IDcolori_fil}, pourcentage = ${w.line.pourcentage}
           WHERE IDcomposition_ecru = ${w.IDcomposition_ecru}`,
        )
      } else if (w.kind === 'insert') {
        await query(
          `INSERT INTO composition_ecru (IDref_ecru, IDcolori_ecru, IDref_fil, IDcolori_fil, pourcentage, commentaire)
           VALUES (${id}, ${coloriId}, ${w.line.IDref_fil}, ${w.line.IDcolori_fil}, ${w.line.pourcentage}, '')`,
        )
      } else {
        await query(`DELETE FROM composition_ecru WHERE IDcomposition_ecru = ${w.IDcomposition_ecru}`)
      }
    }
    res.json({ ok: true, writes: plan.length })
  } catch (err) {
    console.error('Error saving coloris composition:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// MACHINE GRID (ref_ecru_machine) — all ASCII columns
// ──────────────────────────────────────────────────────────

const machineBody = z.object({
  IDmachine: z.number().int().positive(),
  repere_1: z.string().optional().nullable(),
  repere_2: z.string().optional().nullable(),
  repere_3: z.string().optional().nullable(),
  repere_4: z.string().optional().nullable(),
  repere_5: z.string().optional().nullable(),
  hauteur_pl: z.string().optional().nullable(),
  abattage: z.string().optional().nullable(),
  trs_10kg_chute: z.number().optional().nullable(),
  nb_chutes: z.number().optional().nullable(),
})

function machineSets(b: z.infer<typeof machineBody>): string {
  return [
    `IDmachine = ${b.IDmachine}`,
    `repere_1 = ${sqlText(b.repere_1 ?? '')}`,
    `repere_2 = ${sqlText(b.repere_2 ?? '')}`,
    `repere_3 = ${sqlText(b.repere_3 ?? '')}`,
    `repere_4 = ${sqlText(b.repere_4 ?? '')}`,
    `repere_5 = ${sqlText(b.repere_5 ?? '')}`,
    `hauteur_pl = ${sqlText(b.hauteur_pl ?? '')}`,
    `abattage = ${sqlText(b.abattage ?? '')}`,
    `trs_10kg_chute = ${toNumOrNull(b.trs_10kg_chute) ?? 0}`,
    `nb_chutes = ${toNumOrNull(b.nb_chutes) ?? 0}`,
  ].join(', ')
}

// POST /api/references-ecru/:id/machines
referencesEcruRouter.post('/:id/machines', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = machineBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    if (!(await refEcruExists(id))) { res.status(404).json({ error: 'Reference not found' }); return }
    const b = parsed.data
    await query(
      `INSERT INTO ref_ecru_machine (IDref_ecru, IDmachine, repere_1, repere_2, repere_3, repere_4, repere_5, hauteur_pl, abattage, trs_10kg_chute, nb_chutes)
       VALUES (${id}, ${b.IDmachine}, ${sqlText(b.repere_1 ?? '')}, ${sqlText(b.repere_2 ?? '')}, ${sqlText(b.repere_3 ?? '')}, ${sqlText(b.repere_4 ?? '')}, ${sqlText(b.repere_5 ?? '')}, ${sqlText(b.hauteur_pl ?? '')}, ${sqlText(b.abattage ?? '')}, ${toNumOrNull(b.trs_10kg_chute) ?? 0}, ${toNumOrNull(b.nb_chutes) ?? 0})`,
    )
    const rows = await query<{ IDref_ecru_machine: number }>(
      `SELECT IDref_ecru_machine FROM ref_ecru_machine WHERE IDref_ecru = ${id} AND IDmachine = ${b.IDmachine} ORDER BY IDref_ecru_machine DESC`,
    )
    res.status(201).json({ IDref_ecru_machine: rows[0]?.IDref_ecru_machine ?? null })
  } catch (err) {
    console.error('Error creating ref_ecru_machine:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/references-ecru/:id/machines/:rowId
referencesEcruRouter.put('/:id/machines/:rowId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const rowId = parseInt(req.params.rowId, 10)
    if (isNaN(id) || isNaN(rowId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = machineBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ref_ecru_machine WHERE IDref_ecru_machine = ${rowId} AND IDref_ecru = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) { res.status(404).json({ error: 'Machine row not found for this reference' }); return }
    await query(`UPDATE ref_ecru_machine SET ${machineSets(parsed.data)} WHERE IDref_ecru_machine = ${rowId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating ref_ecru_machine:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-ecru/:id/machines/:rowId
referencesEcruRouter.delete('/:id/machines/:rowId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const rowId = parseInt(req.params.rowId, 10)
    if (isNaN(id) || isNaN(rowId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ref_ecru_machine WHERE IDref_ecru_machine = ${rowId} AND IDref_ecru = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) { res.status(404).json({ error: 'Machine row not found for this reference' }); return }
    await query(`DELETE FROM ref_ecru_machine WHERE IDref_ecru_machine = ${rowId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting ref_ecru_machine:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// SCHÉMA DE LIAGE — chute_liage (rows) + schema_liage (cells)
// ──────────────────────────────────────────────────────────

// GET /api/references-ecru/:id/liage
referencesEcruRouter.get('/:id/liage', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    res.json(await loadLiage(id))
  } catch (err) {
    console.error('Error fetching liage:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const chuteBody = z.object({
  num_chute: z.number().int().nonnegative().optional(),
  IDcomposition_ecru1: z.number().int().nonnegative().optional(),
  IDcomposition_ecru2: z.number().int().nonnegative().optional(),
  lfa1: z.number().optional().nullable(),
  lfa2: z.number().optional().nullable(),
})

// POST /api/references-ecru/:id/liage/chutes — append a chute (num auto = max+1).
referencesEcruRouter.post('/:id/liage/chutes', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await refEcruExists(id))) { res.status(404).json({ error: 'Reference not found' }); return }
    const parsed = chuteBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const b = parsed.data
    let num = Number(b.num_chute) || 0
    if (!num) {
      const mx = await query<{ m: number | null }>(`SELECT MAX(num_chute) AS m FROM chute_liage WHERE IDref_ecru = ${id}`)
      num = (Number(mx[0]?.m) || 0) + 1
    }
    await query(
      `INSERT INTO chute_liage (IDref_ecru, num_chute, IDcomposition_ecru1, IDcomposition_ecru2, lfa1, lfa2)
       VALUES (${id}, ${num}, ${Number(b.IDcomposition_ecru1) || 0}, ${Number(b.IDcomposition_ecru2) || 0}, ${toNumOrNull(b.lfa1) ?? 0}, ${toNumOrNull(b.lfa2) ?? 0})`,
    )
    res.status(201).json(await loadLiage(id))
  } catch (err) {
    console.error('Error creating chute_liage:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/references-ecru/:id/liage/chutes/:chuteId
referencesEcruRouter.put('/:id/liage/chutes/:chuteId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const chuteId = parseInt(req.params.chuteId, 10)
    if (isNaN(id) || isNaN(chuteId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = chuteBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM chute_liage WHERE IDchute_liage = ${chuteId} AND IDref_ecru = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) { res.status(404).json({ error: 'Chute not found for this reference' }); return }
    const b = parsed.data
    const sets: string[] = []
    if (b.num_chute !== undefined) sets.push(`num_chute = ${Number(b.num_chute) || 0}`)
    sets.push(`IDcomposition_ecru1 = ${Number(b.IDcomposition_ecru1) || 0}`)
    sets.push(`IDcomposition_ecru2 = ${Number(b.IDcomposition_ecru2) || 0}`)
    sets.push(`lfa1 = ${toNumOrNull(b.lfa1) ?? 0}`)
    sets.push(`lfa2 = ${toNumOrNull(b.lfa2) ?? 0}`)
    await query(`UPDATE chute_liage SET ${sets.join(', ')} WHERE IDchute_liage = ${chuteId}`)
    res.json(await loadLiage(id))
  } catch (err) {
    console.error('Error updating chute_liage:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/references-ecru/:id/liage/chutes/:chuteId — also clears its cells.
referencesEcruRouter.delete('/:id/liage/chutes/:chuteId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const chuteId = parseInt(req.params.chuteId, 10)
    if (isNaN(id) || isNaN(chuteId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM chute_liage WHERE IDchute_liage = ${chuteId} AND IDref_ecru = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) { res.status(404).json({ error: 'Chute not found for this reference' }); return }
    await query(`DELETE FROM schema_liage WHERE IDchute_liage = ${chuteId} AND IDref_ecru = ${id}`)
    await query(`DELETE FROM chute_liage WHERE IDchute_liage = ${chuteId}`)
    res.json(await loadLiage(id))
  } catch (err) {
    console.error('Error deleting chute_liage:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const cellBody = z.object({
  IDchute_liage: z.number().int().positive(),
  num_symbole: z.number().int().positive(),
  IDsymbole_liage: z.number().int().nonnegative(), // 0 = clear
})

// PUT /api/references-ecru/:id/liage/cells — set (or clear, if symbole=0) a cell.
referencesEcruRouter.put('/:id/liage/cells', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = cellBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const b = parsed.data
    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM chute_liage WHERE IDchute_liage = ${b.IDchute_liage} AND IDref_ecru = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) { res.status(400).json({ error: 'Chute does not belong to this reference' }); return }
    // Upsert: clear any existing cell at this (chute, num_symbole), then insert.
    await query(
      `DELETE FROM schema_liage WHERE IDref_ecru = ${id} AND IDchute_liage = ${b.IDchute_liage} AND num_symbole = ${b.num_symbole}`,
    )
    if (b.IDsymbole_liage > 0) {
      await query(
        `INSERT INTO schema_liage (IDref_ecru, num_symbole, IDsymbole_liage, IDchute_liage)
         VALUES (${id}, ${b.num_symbole}, ${b.IDsymbole_liage}, ${b.IDchute_liage})`,
      )
    }
    res.json(await loadLiage(id))
  } catch (err) {
    console.error('Error setting liage cell:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
