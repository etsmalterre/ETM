// Qualité › Dossiers — non-conformity dossiers (legacy FI_Dossier_QualitéV2).
//
// Table `dossier_qualite` (166 rows) is one of the ugliest in the schema: six of
// its twenty columns carry accents (echéance, résolution, defaut_qualité,
// terminé, IDaction_qualité, IDSociétéFNC), which the Linux bridge cannot name
// in SQL at all. The strategy here:
//   • reads   — always `SELECT *`; Windows repairs text with fixEncoding, Linux
//               uses the bridge's base64-text mode. Columns are then resolved by
//               name OR by their accent-truncated twin (readCol).
//   • writes  — the 13 ASCII columns go through a normal named UPDATE on both
//               platforms. The 3 accented columns we actually need to write
//               (terminé, echéance, IDSociétéFNC) go through patchAccented():
//               named SET on Windows, full-row positional rewrite on Linux.
//   • create  — named INSERT on Windows, positional INSERT (20 values, physical
//               column order) on Linux with an explicit PK = max+1.
//
// FNC (fiche de non-conformité) model, reverse-engineered from the data:
//   messageFNC  = what the responsable qualité reports
//   reponseFNC  = "<résolution libellé>\r\n<commentaires>" — the responding
//                 company picks a row from resolution_qualite and types a note;
//                 legacy concatenates the two. We split/rejoin on the same rule.
//   envoiFNC    = send date (YYYYMMDD)
//   IDSociétéFNC = 1-based index into the non-ETM societes (1 → Tricotage
//                 Malterre, 2 → Malterre Confection). Every existing row is 1
//                 and legacy renders it "Tricotage Malterre", which is the only
//                 mapping consistent with the data.
//
// Affectation: Type_Reference is a *string* discriminator on the free-text
// `reference` column — '1' = numéro de pièce (stock_ecru.numero), '2' = lot de
// fil (stock_fil.lot), anything else = none. IDreference is dead (always 0).

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, queryRaw, fixEncoding, queryB64Text } from '../lib/hfsql-auto.js'
import { esc, n, IS_WINDOWS } from '../lib/sst-shared.js'
import { renderFncPdfBuffer, type FncPdfData } from '../lib/pdf/FncPdf.js'

export const dossiersQualiteRouter: RouterType = Router()

// ── SQL helpers ──────────────────────────────────────────

/** Latin-1 hex literal for values holding accents — raw multi-byte UTF-8 in a
 *  SQL string corrupts the Linux bridge. ASCII keeps the normal quoted form. */
function sqlText(value: string | null | undefined): string {
  const v = (value ?? '').toString()
  if (v === '') return "''"
  if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(v)) return `'${esc(v)}'`
  const ascii = v
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ | /g, ' ')
  const bytes = Buffer.from(
    Array.from(ascii, (ch) => {
      const c = ch.codePointAt(0) ?? 0x3f
      return c <= 0xff ? c : 0x3f
    }),
  )
  return `x'${bytes.toString('hex')}'`
}

/** '20260220' | '' — HFSQL stores dates as 8-char strings. */
function dateDigits8(value: unknown): string {
  const s = (value ?? '').toString().replace(/\D/g, '')
  return s.length === 8 ? s : ''
}

function trimStr(v: unknown): string {
  return (v ?? '').toString().trim()
}

/** `terminé` → `termin` — the Linux driver truncates an accented column name at
 *  its first non-ASCII char, both in the returned key and in any SQL text. */
function accentTrunc(name: string): string {
  const m = name.match(/[^\x00-\x7F]/)
  return m && m.index !== undefined ? name.slice(0, m.index) : name
}

/** Read a column by its real name, its accent-truncated twin, or a
 *  case-insensitive match (reserved words like DATE come back uppercased). */
function readCol(row: Record<string, unknown>, name: string): unknown {
  if (name in row) return row[name]
  const t = accentTrunc(name)
  if (t !== name && t in row) return row[t]
  const lower = name.toLowerCase()
  const tLower = t.toLowerCase()
  for (const k of Object.keys(row)) {
    const kl = k.toLowerCase()
    if (kl === lower || kl === tLower) return row[k]
  }
  return undefined
}

// ── dossier_qualite physical column order (positional INSERT on Linux) ──
const DQ_COLUMNS = [
  'IDdossier_qualite',
  'action',
  'description',
  'DATE',
  'echéance',
  'résolution',
  'IDclient',
  'IDsuivilot',
  'defaut_qualité',
  'terminé',
  'IDaction_qualité',
  'Type_Reference',
  'IDreference',
  'journal',
  'reference',
  'IDSociétéFNC',
  'messageFNC',
  'reponseFNC',
  'envoiFNC',
  'IDdefaut_textile',
] as const

/** Columns emitted as SQL text literals; everything else is numeric. */
const DQ_TEXT_COLUMNS = new Set<string>([
  'action', 'description', 'DATE', 'echéance', 'résolution', 'defaut_qualité',
  'Type_Reference', 'journal', 'reference', 'messageFNC', 'reponseFNC', 'envoiFNC',
])

/** Date-ish columns that must stay NULL rather than become '' when empty —
 *  legacy stores NULL for "no deadline" / "FNC never sent". */
const DQ_NULLABLE_DATE_COLUMNS = new Set<string>(['echéance', 'envoiFNC'])

const TEXT_FIELDS_FOR_REPAIR = [
  'description', 'action', 'journal', 'messageFNC', 'reponseFNC',
  'reference', 'defaut_qualité', 'résolution',
]

/** SELECT * with clean text on both platforms. */
async function selectDossierRows(tail: string): Promise<Record<string, unknown>[]> {
  const sql = `SELECT * FROM dossier_qualite ${tail}`
  if (IS_WINDOWS) {
    const rows = await query<Record<string, unknown>>(sql)
    return fixEncoding(rows, 'dossier_qualite', 'IDdossier_qualite', TEXT_FIELDS_FOR_REPAIR)
  }
  return queryB64Text<Record<string, unknown>>(sql)
}

// ── Row shape ────────────────────────────────────────────

interface DossierRow {
  IDdossier_qualite: number
  action: string
  description: string
  date: string | null
  echeance: string | null
  resolution_legacy: string
  IDclient: number
  IDsuivilot: number
  defaut_legacy: string
  termine: 0 | 1
  IDaction_qualite: number
  type_reference: string
  reference: string
  journal: string
  IDsociete_fnc: number
  message_fnc: string
  reponse_fnc: string
  envoi_fnc: string | null
  IDdefaut_textile: number
}

function normalizeDossier(raw: Record<string, unknown>): DossierRow {
  const dateRaw = dateDigits8(readCol(raw, 'DATE'))
  const ech = dateDigits8(readCol(raw, 'echéance'))
  const envoi = dateDigits8(readCol(raw, 'envoiFNC'))
  return {
    IDdossier_qualite: n(readCol(raw, 'IDdossier_qualite')),
    action: trimStr(readCol(raw, 'action')),
    description: trimStr(readCol(raw, 'description')),
    date: dateRaw || null,
    echeance: ech || null,
    resolution_legacy: trimStr(readCol(raw, 'résolution')),
    IDclient: n(readCol(raw, 'IDclient')),
    IDsuivilot: n(readCol(raw, 'IDsuivilot')),
    defaut_legacy: trimStr(readCol(raw, 'defaut_qualité')),
    termine: n(readCol(raw, 'terminé')) === 1 ? 1 : 0,
    IDaction_qualite: n(readCol(raw, 'IDaction_qualité')),
    type_reference: trimStr(readCol(raw, 'Type_Reference')),
    reference: trimStr(readCol(raw, 'reference')),
    journal: trimStr(readCol(raw, 'journal')),
    IDsociete_fnc: n(readCol(raw, 'IDSociétéFNC')),
    message_fnc: trimStr(readCol(raw, 'messageFNC')),
    reponse_fnc: (readCol(raw, 'reponseFNC') ?? '').toString(),
    envoi_fnc: envoi || null,
    IDdefaut_textile: n(readCol(raw, 'IDdefaut_textile')),
  }
}

// ── FNC réponse split/join ───────────────────────────────
// Legacy stores "<résolution libellé>\r\n<commentaires libres>". The libellé is
// matched against resolution_qualite; anything unmatched stays in the comment.

function splitReponse(
  reponse: string,
  libelles: string[],
): { resolution: string; commentaire: string } {
  const normalized = reponse.replace(/\r\n/g, '\n')
  const nl = normalized.indexOf('\n')
  if (nl === -1) {
    const only = normalized.trim()
    return libelles.includes(only)
      ? { resolution: only, commentaire: '' }
      : { resolution: '', commentaire: normalized }
  }
  const head = normalized.slice(0, nl).trim()
  const tail = normalized.slice(nl + 1)
  if (head === '' || libelles.includes(head)) {
    return { resolution: head, commentaire: tail }
  }
  return { resolution: '', commentaire: normalized }
}

function joinReponse(resolution: string, commentaire: string): string {
  const r = resolution.trim()
  const c = commentaire ?? ''
  if (!r && !c.trim()) return ''
  return `${r || ' '}\r\n${c}`
}

// ── Lookups ──────────────────────────────────────────────

interface Lookups {
  clients: { IDclient: number; nom: string }[]
  defauts: { IDdefaut_textile: number; nom: string; categorie: string }[]
  resolutions: { IDresolution_qualite: number; libelle: string }[]
  societes_fnc: { value: number; label: string }[]
}

async function loadResolutionLibelles(): Promise<string[]> {
  const rows = await fixEncoding(
    await query<any>(`SELECT IDresolution_qualite, libelle FROM resolution_qualite`),
    'resolution_qualite', 'IDresolution_qualite', ['libelle'],
  )
  return (rows as any[]).map((r) => trimStr(r.libelle)).filter(Boolean)
}

dossiersQualiteRouter.get('/lookups', async (_req: Request, res: Response) => {
  try {
    const [clientRows, defautRows, categorieRows, resolutionRows, societeRows] = await Promise.all([
      fixEncoding(
        await query<any>(`SELECT IDclient, nom FROM client WHERE IDsociete = 1 ORDER BY nom`),
        'client', 'IDclient', ['nom'],
      ),
      fixEncoding(
        await query<any>(`SELECT IDdefaut_textile, nom, IDcategorie_defaut FROM defaut_textile ORDER BY nom`),
        'defaut_textile', 'IDdefaut_textile', ['nom'],
      ),
      fixEncoding(
        await query<any>(`SELECT IDcategorie_defaut, nom FROM categorie_defaut`),
        'categorie_defaut', 'IDcategorie_defaut', ['nom'],
      ),
      fixEncoding(
        await query<any>(`SELECT IDresolution_qualite, libelle FROM resolution_qualite ORDER BY IDresolution_qualite`),
        'resolution_qualite', 'IDresolution_qualite', ['libelle'],
      ),
      fixEncoding(
        await query<any>(`SELECT IDsociete, nom FROM societe ORDER BY IDsociete`),
        'societe', 'IDsociete', ['nom'],
      ),
    ])

    const catName = new Map<number, string>(
      (categorieRows as any[]).map((c) => [n(c.IDcategorie_defaut), trimStr(c.nom)]),
    )

    // FNC recipients = the sister companies, 1-based index (ETM is the issuer).
    const societes_fnc = (societeRows as any[])
      .filter((s) => n(s.IDsociete) !== 1)
      .map((s, i) => ({ value: i + 1, label: trimStr(s.nom) }))

    const out: Lookups = {
      clients: (clientRows as any[])
        .map((c) => ({ IDclient: n(c.IDclient), nom: trimStr(c.nom) }))
        .filter((c) => c.IDclient > 0 && c.nom !== ''),
      defauts: (defautRows as any[]).map((d) => ({
        IDdefaut_textile: n(d.IDdefaut_textile),
        nom: trimStr(d.nom),
        categorie: catName.get(n(d.IDcategorie_defaut)) ?? '',
      })),
      resolutions: (resolutionRows as any[]).map((r) => ({
        IDresolution_qualite: n(r.IDresolution_qualite),
        libelle: trimStr(r.libelle),
      })),
      societes_fnc,
    }
    res.json(out)
  } catch (err) {
    console.error('Error loading dossier-qualite lookups:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Label resolution shared by list + detail ─────────────

async function loadLabels(rows: DossierRow[]): Promise<{
  clientNom: Map<number, string>
  defautNom: Map<number, string>
  defautCategorie: Map<number, string>
}> {
  const clientIds = [...new Set(rows.map((r) => r.IDclient).filter((x) => x > 0))]
  const defautIds = [...new Set(rows.map((r) => r.IDdefaut_textile).filter((x) => x > 0))]

  const [clientRows, defautRows] = await Promise.all([
    clientIds.length > 0
      ? fixEncoding(
          await query<any>(`SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`),
          'client', 'IDclient', ['nom'],
        )
      : Promise.resolve([] as any[]),
    defautIds.length > 0
      ? fixEncoding(
          await query<any>(
            `SELECT IDdefaut_textile, nom, IDcategorie_defaut FROM defaut_textile WHERE IDdefaut_textile IN (${defautIds.join(',')})`,
          ),
          'defaut_textile', 'IDdefaut_textile', ['nom'],
        )
      : Promise.resolve([] as any[]),
  ])

  const catIds = [...new Set((defautRows as any[]).map((d) => n(d.IDcategorie_defaut)).filter((x) => x > 0))]
  const categorieRows = catIds.length > 0
    ? await fixEncoding(
        await query<any>(`SELECT IDcategorie_defaut, nom FROM categorie_defaut WHERE IDcategorie_defaut IN (${catIds.join(',')})`),
        'categorie_defaut', 'IDcategorie_defaut', ['nom'],
      )
    : []
  const catName = new Map<number, string>(
    (categorieRows as any[]).map((c) => [n(c.IDcategorie_defaut), trimStr(c.nom)]),
  )

  return {
    clientNom: new Map((clientRows as any[]).map((c) => [n(c.IDclient), trimStr(c.nom)])),
    defautNom: new Map((defautRows as any[]).map((d) => [n(d.IDdefaut_textile), trimStr(d.nom)])),
    defautCategorie: new Map(
      (defautRows as any[]).map((d) => [n(d.IDdefaut_textile), catName.get(n(d.IDcategorie_defaut)) ?? '']),
    ),
  }
}

// ── GET / — list ─────────────────────────────────────────

dossiersQualiteRouter.get('/', async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) ?? 'en_cours'
    const raw = await selectDossierRows(`ORDER BY IDdossier_qualite DESC`)
    let rows = raw.map(normalizeDossier)
    // `terminé` can't be filtered in SQL on Linux — narrow in JS on both.
    if (status === 'en_cours') rows = rows.filter((r) => r.termine === 0)
    else if (status === 'termine') rows = rows.filter((r) => r.termine === 1)

    const labels = await loadLabels(rows)

    res.json(
      rows.map((r) => ({
        IDdossier_qualite: r.IDdossier_qualite,
        client_nom: labels.clientNom.get(r.IDclient) ?? '',
        defaut_label: labels.defautNom.get(r.IDdefaut_textile) || r.defaut_legacy,
        date: r.date,
        echeance: r.echeance,
        termine: r.termine,
        reference: r.reference,
        type_reference: r.type_reference,
        fnc_envoye: r.envoi_fnc,
        has_reponse: r.reponse_fnc.trim() !== '' ? 1 : 0,
      })),
    )
  } catch (err) {
    console.error('Error listing dossiers qualite:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /:id — detail ────────────────────────────────────

dossiersQualiteRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const raw = await selectDossierRows(`WHERE IDdossier_qualite = ${id}`)
    if (raw.length === 0) { res.status(404).json({ error: 'Dossier not found' }); return }
    const row = normalizeDossier(raw[0])

    const [labels, libelles] = await Promise.all([loadLabels([row]), loadResolutionLibelles()])
    const { resolution, commentaire } = splitReponse(row.reponse_fnc, libelles)

    res.json({
      ...row,
      client_nom: labels.clientNom.get(row.IDclient) ?? '',
      defaut_nom: labels.defautNom.get(row.IDdefaut_textile) ?? '',
      defaut_categorie: labels.defautCategorie.get(row.IDdefaut_textile) ?? '',
      fnc_resolution: resolution,
      fnc_commentaire: commentaire,
    })
  } catch (err) {
    console.error('Error loading dossier qualite:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Writes ───────────────────────────────────────────────

/** Read the row with faithful text, ready for a positional rewrite. */
async function readRawDossier(id: number): Promise<Record<string, unknown> | null> {
  const rows = await selectDossierRows(`WHERE IDdossier_qualite = ${id}`)
  return rows[0] ?? null
}

/** Emit one positional value for a dossier_qualite column. */
function dqLiteral(column: string, value: unknown): string {
  if (DQ_TEXT_COLUMNS.has(column)) {
    const s = value == null ? '' : value.toString()
    if (DQ_NULLABLE_DATE_COLUMNS.has(column) && dateDigits8(s) === '') return 'NULL'
    return sqlText(s)
  }
  return String(n(value))
}

/**
 * Write the accented columns. Windows names them directly; Linux can't, so the
 * whole row is re-inserted positionally under the same PK (FKs in doc_qualite /
 * asso_lot_dq point at the PK, so they survive). Best-effort restore on failure.
 */
async function patchAccented(
  id: number,
  patch: { termine?: 0 | 1; echeance?: string | null; IDsociete_fnc?: number },
): Promise<void> {
  const sets: string[] = []
  if (patch.termine !== undefined) sets.push(`terminé = ${patch.termine}`)
  if (patch.echeance !== undefined) {
    const d = dateDigits8(patch.echeance)
    sets.push(`echéance = ${d ? `'${d}'` : 'NULL'}`)
  }
  if (patch.IDsociete_fnc !== undefined) sets.push(`IDSociétéFNC = ${n(patch.IDsociete_fnc)}`)
  if (sets.length === 0) return

  if (IS_WINDOWS) {
    await query(`UPDATE dossier_qualite SET ${sets.join(', ')} WHERE IDdossier_qualite = ${id}`)
    return
  }

  const original = await readRawDossier(id)
  if (!original) throw new Error(`dossier ${id} disappeared before rewrite`)

  const values: Record<string, unknown> = {}
  for (const col of DQ_COLUMNS) values[col] = readCol(original, col)
  if (patch.termine !== undefined) values['terminé'] = patch.termine
  if (patch.echeance !== undefined) values['echéance'] = dateDigits8(patch.echeance) || null
  if (patch.IDsociete_fnc !== undefined) values['IDSociétéFNC'] = n(patch.IDsociete_fnc)

  const literals = DQ_COLUMNS.map((c) => dqLiteral(c, values[c]))
  const restore = DQ_COLUMNS.map((c) => dqLiteral(c, readCol(original, c)))

  await query(`DELETE FROM dossier_qualite WHERE IDdossier_qualite = ${id}`)
  try {
    await query(`INSERT INTO dossier_qualite VALUES (${literals.join(', ')})`)
  } catch (err) {
    try {
      await query(`DELETE FROM dossier_qualite WHERE IDdossier_qualite = ${id}`)
      await query(`INSERT INTO dossier_qualite VALUES (${restore.join(', ')})`)
    } catch {
      console.error(`[dossiers-qualite] FAILED to restore dossier ${id} after rewrite error`)
    }
    throw err
  }
}

const updateBody = z.object({
  description: z.string().max(20000).optional(),
  journal: z.string().max(20000).optional(),
  date: z.string().optional(),
  echeance: z.string().nullable().optional(),
  IDclient: z.number().int().nonnegative().optional(),
  IDdefaut_textile: z.number().int().nonnegative().optional(),
  type_reference: z.string().max(10).optional(),
  reference: z.string().max(100).optional(),
  message_fnc: z.string().max(20000).optional(),
  fnc_resolution: z.string().max(200).optional(),
  fnc_commentaire: z.string().max(20000).optional(),
  IDsociete_fnc: z.number().int().nonnegative().optional(),
  envoi_fnc: z.string().nullable().optional(),
})

dossiersQualiteRouter.put(
  '/:id',
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10)
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

      const parsed = updateBody.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
        return
      }
      const b = parsed.data

      const existing = await readRawDossier(id)
      if (!existing) { res.status(404).json({ error: 'Dossier not found' }); return }

      // ── ASCII columns: plain named UPDATE (safe on both platforms).
      const sets: string[] = []
      if (b.description !== undefined) sets.push(`description = ${sqlText(b.description)}`)
      if (b.journal !== undefined) sets.push(`journal = ${sqlText(b.journal)}`)
      if (b.date !== undefined) {
        const d = dateDigits8(b.date)
        sets.push(`DATE = ${d ? `'${d}'` : "''"}`)
      }
      if (b.IDclient !== undefined) sets.push(`IDclient = ${n(b.IDclient)}`)
      if (b.IDdefaut_textile !== undefined) sets.push(`IDdefaut_textile = ${n(b.IDdefaut_textile)}`)
      if (b.type_reference !== undefined) sets.push(`Type_Reference = ${sqlText(b.type_reference)}`)
      if (b.reference !== undefined) sets.push(`reference = ${sqlText(b.reference)}`)
      if (b.message_fnc !== undefined) sets.push(`messageFNC = ${sqlText(b.message_fnc)}`)
      if (b.fnc_resolution !== undefined || b.fnc_commentaire !== undefined) {
        const libelles = await loadResolutionLibelles()
        const current = splitReponse(trimStr(readCol(existing, 'reponseFNC')), libelles)
        const reponse = joinReponse(
          b.fnc_resolution ?? current.resolution,
          b.fnc_commentaire ?? current.commentaire,
        )
        sets.push(`reponseFNC = ${sqlText(reponse)}`)
      }
      if (b.envoi_fnc !== undefined) {
        const d = dateDigits8(b.envoi_fnc)
        sets.push(`envoiFNC = ${d ? `'${d}'` : 'NULL'}`)
      }
      if (sets.length > 0) {
        await query(`UPDATE dossier_qualite SET ${sets.join(', ')} WHERE IDdossier_qualite = ${id}`)
      }

      // ── Accented columns: only when they actually change (Linux rewrites the row).
      const currentEcheance = dateDigits8(readCol(existing, 'echéance')) || null
      const currentSociete = n(readCol(existing, 'IDSociétéFNC'))
      const accentPatch: { echeance?: string | null; IDsociete_fnc?: number } = {}
      if (b.echeance !== undefined && (dateDigits8(b.echeance) || null) !== currentEcheance) {
        accentPatch.echeance = b.echeance
      }
      if (b.IDsociete_fnc !== undefined && n(b.IDsociete_fnc) !== currentSociete) {
        accentPatch.IDsociete_fnc = b.IDsociete_fnc
      }
      if (Object.keys(accentPatch).length > 0) await patchAccented(id, accentPatch)

      res.json({ ok: true })
    } catch (err) {
      console.error('Error updating dossier qualite:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// PUT /:id/termine — the status footer pill.
dossiersQualiteRouter.put(
  '/:id/termine',
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10)
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
      const parsed = z.object({ termine: z.union([z.literal(0), z.literal(1)]) }).safeParse(req.body)
      if (!parsed.success) { res.status(400).json({ error: 'Validation failed' }); return }

      const existing = await readRawDossier(id)
      if (!existing) { res.status(404).json({ error: 'Dossier not found' }); return }

      await patchAccented(id, { termine: parsed.data.termine })
      res.json({ ok: true, termine: parsed.data.termine })
    } catch (err) {
      console.error('Error toggling dossier qualite status:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ── POST / — create ──────────────────────────────────────

const createBody = z.object({
  IDclient: z.number().int().nonnegative(),
  IDdefaut_textile: z.number().int().nonnegative(),
  description: z.string().max(20000),
  date: z.string().optional(),
})

dossiersQualiteRouter.post(
  '/',
  async (req: Request, res: Response) => {
    try {
      const parsed = createBody.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
        return
      }
      const b = parsed.data
      const today = new Date()
      const dateStr = dateDigits8(b.date) ||
        `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

      const maxRows = await query<{ id: number }>(
        `SELECT MAX(IDdossier_qualite) AS id FROM dossier_qualite`,
      )
      const newId = n(maxRows[0]?.id) + 1

      // Legacy seeds description → journal → messageFNC on creation; the FNC
      // recipient defaults to the first sister company (Tricotage Malterre).
      const seed: Record<string, unknown> = {
        IDdossier_qualite: newId,
        action: '',
        description: b.description,
        DATE: dateStr,
        'echéance': null,
        'résolution': '',
        IDclient: b.IDclient,
        IDsuivilot: 0,
        'defaut_qualité': '',
        'terminé': 0,
        'IDaction_qualité': 0,
        Type_Reference: '-1',
        IDreference: 0,
        journal: b.description,
        reference: '',
        'IDSociétéFNC': 1,
        messageFNC: b.description,
        reponseFNC: '',
        envoiFNC: null,
        IDdefaut_textile: b.IDdefaut_textile,
      }

      if (IS_WINDOWS) {
        await query(
          `INSERT INTO dossier_qualite (IDdossier_qualite, action, description, DATE, echéance, résolution, IDclient, IDsuivilot, defaut_qualité, terminé, IDaction_qualité, Type_Reference, IDreference, journal, reference, IDSociétéFNC, messageFNC, reponseFNC, envoiFNC, IDdefaut_textile) ` +
            `VALUES (${DQ_COLUMNS.map((c) => dqLiteral(c, seed[c])).join(', ')})`,
        )
      } else {
        await query(
          `INSERT INTO dossier_qualite VALUES (${DQ_COLUMNS.map((c) => dqLiteral(c, seed[c])).join(', ')})`,
        )
      }

      res.status(201).json({ IDdossier_qualite: newId })
    } catch (err) {
      console.error('Error creating dossier qualite:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ── DELETE /:id ──────────────────────────────────────────

dossiersQualiteRouter.delete(
  '/:id',
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10)
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
      const existing = await readRawDossier(id)
      if (!existing) { res.status(404).json({ error: 'Dossier not found' }); return }
      await query(`DELETE FROM dossier_qualite WHERE IDdossier_qualite = ${id}`)
      res.json({ ok: true })
    } catch (err) {
      console.error('Error deleting dossier qualite:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ── Documents (doc_qualite) ──────────────────────────────
//
// doc_qualite's PK *and* its dossier FK are both accented (IDdoc_qualité,
// IDdossier_qualité), so on Linux there is no way to scope a query to one
// dossier — SELECT * would drag all 87 MB of blobs across the bridge. The tab is
// therefore fully functional on the Windows/ODBC path and reports `degraded` on
// the Linux bridge instead of pretending the dossier has no documents.

interface DocQualiteRow {
  IDdoc_qualite: number
  nom: string
  has_file: 0 | 1
}

dossiersQualiteRouter.get('/:id/documents', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!IS_WINDOWS) { res.json({ documents: [], degraded: true }); return }

    const rows = await fixEncoding(
      await query<any>(
        `SELECT IDdoc_qualité, nom FROM doc_qualite WHERE IDdossier_qualité = ${id} ORDER BY IDdoc_qualité`,
      ),
      'doc_qualite', 'IDdoc_qualité', ['nom'],
    )
    const documents: DocQualiteRow[] = (rows as any[]).map((r) => ({
      IDdoc_qualite: n(readCol(r, 'IDdoc_qualité')),
      nom: trimStr(r.nom),
      has_file: 1,
    }))
    res.json({ documents, degraded: false })
  } catch (err) {
    console.error('Error listing doc_qualite:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

dossiersQualiteRouter.get('/:id/documents/:docId/fichier', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const docId = parseInt(req.params.docId, 10)
    if (isNaN(id) || isNaN(docId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!IS_WINDOWS) { res.status(404).json({ error: 'No file attached' }); return }

    const rows = (await queryRaw(
      `SELECT fichier FROM doc_qualite WHERE IDdoc_qualité = ${docId} AND IDdossier_qualité = ${id}`,
    )) as any[]
    if (rows.length === 0) { res.status(404).json({ error: 'Document not found' }); return }

    const fichier = rows[0].fichier
    let buf: Buffer | null = null
    if (Buffer.isBuffer(fichier)) buf = fichier
    else if (fichier instanceof ArrayBuffer) buf = Buffer.from(fichier)
    if (!buf || buf.length === 0 || (buf.length === 1 && buf[0] === 0)) {
      res.status(404).json({ error: 'No file attached' })
      return
    }

    let contentType = 'application/octet-stream'
    if (buf.length >= 4) {
      const h = buf.subarray(0, 4)
      if (h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46) contentType = 'application/pdf'
      else if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) contentType = 'image/png'
      else if (h[0] === 0xff && h[1] === 0xd8) contentType = 'image/jpeg'
    }
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', 'inline')
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.end(buf)
  } catch (err) {
    console.error('Error serving doc_qualite file:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Traçabilité ──────────────────────────────────────────
//
// For an affectation of type '1' (numéro de pièce) we walk the écru roll back to
// the yarns it was knitted from and forward to the two subcontract orders that
// produced and finished it:
//   stock_ecru.IDordre_fabrication → asso_fil_of → stock_fil → ref_fil/colori_fil
//                                                            → ref_fil_commande → commande_fil
//   stock_ecru.IDref_commande_source      → lcsst (type 1) → tricoteur
//   stock_ecru.IDref_commande_affectation → lcsst (type 2) → ennoblisseur → suivilot lots
// Type '2' (lot de fil) resolves the single stock_fil lot and its purchase order.

interface FilRow {
  IDstock_fil: number
  ref_fil: string
  coloris: string
  lot: string
  pourcentage: number | null
  fournisseur_nom: string
  IDcommande_fil: number | null
  commande_date: string | null
  documents: { IDged: number; nom: string; type_nom: string | null }[]
}

interface SstBlock {
  IDcommande_sous_traitant: number
  sous_traitant_nom: string
  date_commande: string | null
  quantite: number
  prix: number
  lots: string[]
  documents: { IDged: number; nom: string; type_nom: string | null }[]
}

async function loadGedForCommandeFil(cmdIds: number[]) {
  if (cmdIds.length === 0) return new Map<number, { IDged: number; nom: string; type_nom: string | null }[]>()
  const rows = await fixEncoding(
    await query<any>(
      `SELECT IDged, nom, IDreference, IDtype_doc FROM ged WHERE IDreference IN (${cmdIds.join(',')}) AND IDcommande_client = 0 AND IDcommande_sous_traitant = 0`,
    ),
    'ged', 'IDged', ['nom'],
  )
  const typeIds = [...new Set((rows as any[]).map((r) => n(r.IDtype_doc)).filter((x) => x > 0))]
  const typeRows = typeIds.length > 0
    ? await fixEncoding(
        await query<any>(`SELECT IDtype_doc, nom FROM type_doc WHERE IDtype_doc IN (${typeIds.join(',')})`),
        'type_doc', 'IDtype_doc', ['nom'],
      )
    : []
  const typeName = new Map((typeRows as any[]).map((t) => [n(t.IDtype_doc), trimStr(t.nom)]))
  const out = new Map<number, { IDged: number; nom: string; type_nom: string | null }[]>()
  for (const r of rows as any[]) {
    const k = n(r.IDreference)
    const list = out.get(k) ?? []
    list.push({ IDged: n(r.IDged), nom: trimStr(r.nom), type_nom: typeName.get(n(r.IDtype_doc)) ?? null })
    out.set(k, list)
  }
  return out
}

async function loadGedForCommandeSst(cmdIds: number[]) {
  if (cmdIds.length === 0) return new Map<number, { IDged: number; nom: string; type_nom: string | null }[]>()
  const rows = await fixEncoding(
    await query<any>(
      `SELECT IDged, nom, IDcommande_sous_traitant, IDtype_doc FROM ged WHERE IDcommande_sous_traitant IN (${cmdIds.join(',')})`,
    ),
    'ged', 'IDged', ['nom'],
  )
  const typeIds = [...new Set((rows as any[]).map((r) => n(r.IDtype_doc)).filter((x) => x > 0))]
  const typeRows = typeIds.length > 0
    ? await fixEncoding(
        await query<any>(`SELECT IDtype_doc, nom FROM type_doc WHERE IDtype_doc IN (${typeIds.join(',')})`),
        'type_doc', 'IDtype_doc', ['nom'],
      )
    : []
  const typeName = new Map((typeRows as any[]).map((t) => [n(t.IDtype_doc), trimStr(t.nom)]))
  const out = new Map<number, { IDged: number; nom: string; type_nom: string | null }[]>()
  for (const r of rows as any[]) {
    const k = n(r.IDcommande_sous_traitant)
    const list = out.get(k) ?? []
    list.push({ IDged: n(r.IDged), nom: trimStr(r.nom), type_nom: typeName.get(n(r.IDtype_doc)) ?? null })
    out.set(k, list)
  }
  return out
}

/** Hydrate stock_fil ids into the Fil tab rows (never SELECT * — the certif_bio
 *  block silently poisons the result set on Windows). */
async function loadFilRows(
  stockFilIds: number[],
  pourcentageBySf: Map<number, number>,
): Promise<FilRow[]> {
  if (stockFilIds.length === 0) return []
  const sfRows = await query<any>(
    `SELECT IDstock_fil, IDref_fil, IDcolori_fil, lot, IDfournisseur, IDref_fil_commande FROM stock_fil WHERE IDstock_fil IN (${stockFilIds.join(',')})`,
  )
  const refIds = [...new Set((sfRows as any[]).map((r) => n(r.IDref_fil)).filter((x) => x > 0))]
  const coloIds = [...new Set((sfRows as any[]).map((r) => n(r.IDcolori_fil)).filter((x) => x > 0))]
  const frsIds = [...new Set((sfRows as any[]).map((r) => n(r.IDfournisseur)).filter((x) => x > 0))]
  const lineIds = [...new Set((sfRows as any[]).map((r) => n(r.IDref_fil_commande)).filter((x) => x > 0))]

  const [refRows, coloRows, frsRows, lineRows] = await Promise.all([
    refIds.length > 0
      ? fixEncoding(await query<any>(`SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${refIds.join(',')})`), 'ref_fil', 'IDref_fil', ['reference'])
      : Promise.resolve([] as any[]),
    coloIds.length > 0
      ? fixEncoding(await query<any>(`SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${coloIds.join(',')})`), 'colori_fil', 'IDcolori_fil', ['reference'])
      : Promise.resolve([] as any[]),
    frsIds.length > 0
      ? fixEncoding(await query<any>(`SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur IN (${frsIds.join(',')})`), 'fournisseur', 'IDfournisseur', ['nom'])
      : Promise.resolve([] as any[]),
    lineIds.length > 0
      ? query<any>(`SELECT IDref_fil_commande, IDcommande_fil FROM ref_fil_commande WHERE IDref_fil_commande IN (${lineIds.join(',')})`)
      : Promise.resolve([] as any[]),
  ])

  const refName = new Map((refRows as any[]).map((r) => [n(r.IDref_fil), trimStr(r.reference)]))
  const coloName = new Map((coloRows as any[]).map((r) => [n(r.IDcolori_fil), trimStr(r.reference)]))
  const frsName = new Map((frsRows as any[]).map((r) => [n(r.IDfournisseur), trimStr(r.nom)]))
  const cmdByLine = new Map((lineRows as any[]).map((r) => [n(r.IDref_fil_commande), n(r.IDcommande_fil)]))

  const cmdIds = [...new Set([...cmdByLine.values()].filter((x) => x > 0))]
  const [cmdRows, gedByCmd] = await Promise.all([
    cmdIds.length > 0
      ? query<any>(`SELECT IDcommande_fil, date_commande FROM commande_fil WHERE IDcommande_fil IN (${cmdIds.join(',')})`)
      : Promise.resolve([] as any[]),
    loadGedForCommandeFil(cmdIds),
  ])
  const cmdDate = new Map((cmdRows as any[]).map((r) => [n(r.IDcommande_fil), dateDigits8(r.date_commande) || null]))

  return (sfRows as any[]).map((r) => {
    const sfId = n(r.IDstock_fil)
    const cmdId = cmdByLine.get(n(r.IDref_fil_commande)) ?? 0
    return {
      IDstock_fil: sfId,
      ref_fil: refName.get(n(r.IDref_fil)) ?? '',
      coloris: coloName.get(n(r.IDcolori_fil)) ?? '',
      lot: trimStr(r.lot),
      pourcentage: pourcentageBySf.has(sfId) ? pourcentageBySf.get(sfId)! : null,
      fournisseur_nom: frsName.get(n(r.IDfournisseur)) ?? '',
      IDcommande_fil: cmdId > 0 ? cmdId : null,
      commande_date: cmdId > 0 ? (cmdDate.get(cmdId) ?? null) : null,
      documents: cmdId > 0 ? (gedByCmd.get(cmdId) ?? []) : [],
    }
  })
}

/** Resolve one lcsst id into a Tricotage / Ennoblissement block. */
async function loadSstBlock(lcsstId: number, expectedType: 1 | 2): Promise<SstBlock | null> {
  if (lcsstId <= 0) return null
  const lines = await query<any>(
    `SELECT IDligne_commande_sous_traitant, IDcommande_sous_traitant, TYPE AS type_kind, quantite, prix FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant = ${lcsstId}`,
  )
  if (lines.length === 0) return null
  const line = lines[0]
  if (n(line.type_kind) !== expectedType) return null
  const cmdId = n(line.IDcommande_sous_traitant)
  if (cmdId <= 0) return null

  const [cmdRows, lotRows, gedByCmd] = await Promise.all([
    query<any>(`SELECT IDcommande_sous_traitant, IDsous_traitant, date_commande FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${cmdId}`),
    query<any>(`SELECT lot FROM suivilot WHERE IDligne_commande_sous_traitant = ${lcsstId}`),
    loadGedForCommandeSst([cmdId]),
  ])
  if (cmdRows.length === 0) return null
  const sstId = n(cmdRows[0].IDsous_traitant)
  const sstRows = sstId > 0
    ? await fixEncoding(
        await query<any>(`SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant = ${sstId}`),
        'sous_traitant', 'IDsous_traitant', ['nom'],
      )
    : []

  return {
    IDcommande_sous_traitant: cmdId,
    sous_traitant_nom: trimStr((sstRows as any[])[0]?.nom),
    date_commande: dateDigits8(cmdRows[0].date_commande) || null,
    quantite: n(line.quantite),
    prix: Number(line.prix) || 0,
    lots: (lotRows as any[]).map((l) => trimStr(l.lot)).filter(Boolean),
    documents: gedByCmd.get(cmdId) ?? [],
  }
}

dossiersQualiteRouter.get('/:id/tracabilite', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const raw = await readRawDossier(id)
    if (!raw) { res.status(404).json({ error: 'Dossier not found' }); return }
    const dossier = normalizeDossier(raw)
    const reference = dossier.reference

    const empty = {
      kind: 'none' as const,
      titre: null, sous_titre: null, piece: null,
      fils: [] as FilRow[], tricotage: null, ennoblissement: null,
    }
    if (!reference) { res.json(empty); return }

    // ── '1' — numéro de pièce (écru roll)
    if (dossier.type_reference === '1') {
      const pieces = await query<any>(
        `SELECT IDstock_ecru, IDref_ecru, IDcolori_ecru, IDordre_fabrication, IDref_commande_source, IDref_commande_affectation, poids, metrage, lot, numero FROM stock_ecru WHERE numero = '${esc(reference)}'`,
      )
      if (pieces.length === 0) { res.json(empty); return }
      const p = pieces[0]

      const [refRows, coloRows, assoRows] = await Promise.all([
        n(p.IDref_ecru) > 0
          ? fixEncoding(await query<any>(`SELECT IDref_ecru, reference, designation FROM ref_ecru WHERE IDref_ecru = ${n(p.IDref_ecru)}`), 'ref_ecru', 'IDref_ecru', ['reference', 'designation'])
          : Promise.resolve([] as any[]),
        n(p.IDcolori_ecru) > 0
          ? fixEncoding(await query<any>(`SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru = ${n(p.IDcolori_ecru)}`), 'colori_ecru', 'IDcolori_ecru', ['reference'])
          : Promise.resolve([] as any[]),
        n(p.IDordre_fabrication) > 0
          ? query<any>(`SELECT IDasso_fil_of, IDstock_fil, pourcentage FROM asso_fil_of WHERE IDordre_fabrication = ${n(p.IDordre_fabrication)}`)
          : Promise.resolve([] as any[]),
      ])

      const pourcentageBySf = new Map<number, number>()
      for (const a of assoRows as any[]) {
        const sf = n(a.IDstock_fil)
        if (sf > 0) pourcentageBySf.set(sf, n(a.pourcentage))
      }
      const stockFilIds = [...pourcentageBySf.keys()]

      const [fils, tricotage, ennoblissement] = await Promise.all([
        loadFilRows(stockFilIds, pourcentageBySf),
        loadSstBlock(n(p.IDref_commande_source), 1),
        loadSstBlock(n(p.IDref_commande_affectation), 2),
      ])

      const refLabel = trimStr((refRows as any[])[0]?.reference)
      const coloLabel = trimStr((coloRows as any[])[0]?.reference)
      res.json({
        kind: 'piece',
        titre: [refLabel, coloLabel].filter(Boolean).join(' - ') || reference,
        sous_titre: trimStr((refRows as any[])[0]?.designation) || null,
        piece: {
          IDstock_ecru: n(p.IDstock_ecru),
          numero: trimStr(p.numero),
          lot: trimStr(p.lot),
          poids: Number(p.poids) || 0,
          metrage: Number(p.metrage) || 0,
          IDordre_fabrication: n(p.IDordre_fabrication),
        },
        fils,
        tricotage,
        ennoblissement,
      })
      return
    }

    // ── '2' — lot de fil
    if (dossier.type_reference === '2') {
      const lots = await query<any>(
        `SELECT IDstock_fil FROM stock_fil WHERE lot = '${esc(reference)}'`,
      )
      if (lots.length === 0) { res.json(empty); return }
      const ids = (lots as any[]).map((l) => n(l.IDstock_fil)).filter((x) => x > 0)
      const fils = await loadFilRows(ids, new Map())
      res.json({
        kind: 'lot_fil',
        titre: fils[0] ? [fils[0].ref_fil, fils[0].coloris].filter(Boolean).join(' - ') : reference,
        sous_titre: `Lot ${reference}`,
        piece: null,
        fils,
        tricotage: null,
        ennoblissement: null,
      })
      return
    }

    res.json(empty)
  } catch (err) {
    console.error('Error loading dossier qualite tracabilite:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── FNC PDF ──────────────────────────────────────────────

export async function buildFncPdfData(id: number): Promise<FncPdfData | null> {
  const raw = await readRawDossier(id)
  if (!raw) return null
  const dossier = normalizeDossier(raw)

  const [labels, libelles, societeRows] = await Promise.all([
    loadLabels([dossier]),
    loadResolutionLibelles(),
    fixEncoding(
      await query<any>(`SELECT IDsociete, nom FROM societe ORDER BY IDsociete`),
      'societe', 'IDsociete', ['nom'],
    ),
  ])
  const sisters = (societeRows as any[]).filter((s) => n(s.IDsociete) !== 1)
  const societeNom = trimStr(sisters[dossier.IDsociete_fnc - 1]?.nom)
  const { resolution, commentaire } = splitReponse(dossier.reponse_fnc, libelles)

  return {
    numero: dossier.IDdossier_qualite,
    date: formatFrDate(dossier.envoi_fnc ?? dossier.date),
    societeNom: societeNom || '—',
    clientNom: labels.clientNom.get(dossier.IDclient) ?? '',
    defautNom: labels.defautNom.get(dossier.IDdefaut_textile) || dossier.defaut_legacy,
    observation: dossier.message_fnc || dossier.description,
    pieces: dossier.reference ? [dossier.reference] : [],
    piecesLabel: dossier.type_reference === '2' ? 'Lot(s) de fil concerné(s)' : 'Pièce(s) affectée(s)',
    resolution,
    reponse: commentaire,
  }
}

function formatFrDate(d: string | null): string {
  if (!d || d.length !== 8) return ''
  return `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`
}

dossiersQualiteRouter.get('/:id/fnc/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const data = await buildFncPdfData(id)
    if (!data) { res.status(404).json({ error: 'Dossier not found' }); return }

    const buffer = await renderFncPdfBuffer(data)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="FNC-${id}.pdf"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.end(buffer)
  } catch (err) {
    console.error('Error rendering FNC pdf:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
