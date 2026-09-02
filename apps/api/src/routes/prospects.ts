import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, fixEncoding, queryB64Text } from '../lib/hfsql-auto.js'
import { userHasPermission } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'

export const prospectsRouter: RouterType = Router()

// ── Permission gate (ticket #1112) ──────────────────────
// ONE key covering every write on the screen — same shape as etudes-coloris.ts.
// Until #1112 this router had no gate at all: whoever could open the screen
// could create, edit, delete and convert a prospect. Reads stay open.
//
// ⚠ `attachUser()` is best-effort and there is no global auth middleware, so a
// write route WITHOUT this call is reachable anonymously. Any new write here
// starts with it.
const EDIT_KEY = 'edit_prospects' as const

/** True when the caller may write. Writes the 401/403 itself, so callers
 *  just `return` on false. */
async function ensureCanEdit(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  if (!(await userHasPermission(req.userId, isEffectiveAdmin(req), EDIT_KEY))) {
    res.status(403).json({ error: `permission denied: ${EDIT_KEY}` })
    return false
  }
  return true
}

// The `prospect` table has accented column names: `prénom`, `société`, `traité`.
// The Linux iODBC bridge (production) rejects accented identifier tokens
// entirely, while the Windows ODBC driver accepts them. Following the
// canonical stock.ts pattern:
//   • Reads use `SELECT *` (no accented identifier named) on both platforms;
//     `normalizeProspectRow` folds the returned keys to canonical ASCII keys.
//   • Writes name the accented columns only on Windows; on Linux those three
//     fields are skipped (same limitation stock.ts ships for `terminé`).
const IS_WINDOWS = process.platform === 'win32'

// ── Helpers ──────────────────────────────────────────────

function esc(value: string): string {
  return value.replace(/'/g, "''")
}

/** SQL literal for a user-supplied text value. Pure-ASCII → quoted literal;
 *  accented values → hex literal of their Latin-1 bytes (the Linux bridge
 *  corrupts raw multi-byte UTF-8 embedded in a SQL string). */
function sqlText(value: string | null | undefined): string {
  const v = (value ?? '').toString()
  if (v === '') return "''"
  if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(v)) return `'${esc(v)}'`
  const ascii = v
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
  const bytes = Buffer.from(
    Array.from(ascii, (ch) => {
      const c = ch.codePointAt(0) ?? 0x3f
      return c <= 0xff ? c : 0x3f
    }),
  )
  return `x'${bytes.toString('hex')}'`
}

function n(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const parsed = Number(value)
  return isNaN(parsed) ? 0 : parsed
}

/** Keep only digits from a YYYYMMDD-ish input. Accepts 'YYYY-MM-DD', 'YYYYMMDD' or ''. */
function dateStr(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value).replace(/-/g, '')
  return /^\d{8}$/.test(s) ? s : ''
}

function todayHfsql(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** Diacritic-insensitive, lowercased key. `prénom` → `prenom`, `DATE` → `date`. */
function foldKey(k: string): string {
  return k.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Legacy status_catalogue values -1 and 0 display as Nouveau (1). */
function coerceStatus(raw: unknown): 1 | 2 | 3 {
  const v = n(raw)
  return v === 2 ? 2 : v === 3 ? 3 : 1
}

// ── Types ────────────────────────────────────────────────

interface ProspectRow {
  IDprospect: number
  prenom: string
  nom: string
  email: string
  societe: string
  adresse: string
  code_postal: string
  ville: string
  pays: string
  telephone: string
  status_catalogue: 1 | 2 | 3
  date: string
  observation: string
  notes_interne: string
  expe_catalogue: string
  tracking_number: string
  IDtransporteur: number
  traite: number
  IDclient: number
}

/** Map a raw HFSQL row (exact accented keys on Windows, possibly mangled on
 *  Linux, `date` uppercased as `DATE`) to canonical ASCII-keyed fields. */
function normalizeProspectRow(raw: Record<string, unknown>): ProspectRow {
  const byFold = new Map<string, unknown>()
  for (const [k, v] of Object.entries(raw)) byFold.set(foldKey(k), v)

  // Exact fold match, with a one-char-truncation fallback for the Linux
  // bridge mangling accented column names (terminé → termin style).
  const get = (folded: string): unknown => {
    if (byFold.has(folded)) return byFold.get(folded)
    for (const [f, v] of byFold) {
      if (f.length >= 3 && folded.startsWith(f) && folded.length - f.length <= 1) return v
    }
    return undefined
  }
  const str = (folded: string): string => {
    const v = get(folded)
    return v === null || v === undefined ? '' : String(v)
  }
  // The Linux bridge truncates accented identifiers AT the first accent, so
  // `prénom` arrives as key `pr` and `société` as `soci` (verified on prod).
  // The generic `get()` fallback can't catch these (`pr` is too short for its
  // length>=3 guard; `soci`→`societe` exceeds its 1-char-diff guard), so resolve
  // them with a prefix regex against the raw keys — matches both the truncated
  // Linux keys and the full `prénom`/`société` keys Windows returns.
  const strRaw = (re: RegExp): string => {
    for (const [k, v] of Object.entries(raw)) {
      if (re.test(k)) return v === null || v === undefined ? '' : String(v)
    }
    return ''
  }

  return {
    IDprospect: n(get('idprospect')),
    prenom: strRaw(/^pr/i),
    nom: str('nom'),
    email: str('email'),
    societe: strRaw(/^soci/i),
    adresse: str('adresse'),
    code_postal: str('code_postal'),
    ville: str('ville'),
    pays: str('pays'),
    telephone: str('telephone'),
    status_catalogue: coerceStatus(get('status_catalogue')),
    date: str('date'),
    observation: str('observation'),
    notes_interne: str('notes_interne'),
    expe_catalogue: str('expe_catalogue'),
    tracking_number: str('tracking_number'),
    IDtransporteur: n(get('idtransporteur')),
    traite: n(get('traite')) ? 1 : 0,
    IDclient: n(get('idclient')),
  }
}

// fixEncoding field lists keyed on the RAW column names. Non-accented columns
// are identical on both platforms; the accented ones are only nameable in a
// CONVERT() query on Windows.
const TEXT_FIELDS_BASE = [
  'nom', 'email', 'adresse', 'code_postal', 'ville', 'pays', 'telephone',
  'observation', 'notes_interne', 'tracking_number',
]
const TEXT_FIELDS_FULL = IS_WINDOWS ? [...TEXT_FIELDS_BASE, 'prénom', 'société'] : TEXT_FIELDS_BASE

// Full physical column set of `prospect`, in catalog order (verified via SELECT *
// on prod). Used for positional INSERT on Linux, where the accented column names
// (prénom, société, traité) can't be named in a column list.
interface ProspectFields {
  prenom: string; nom: string; email: string; societe: string; adresse: string
  code_postal: string; ville: string; pays: string; telephone: string
  status_catalogue: number; date: string; observation: string; notes_interne: string
  expe_catalogue: string; tracking_number: string; IDtransporteur: number
  traite: number; IDclient: number
}

/** Build a positional VALUES(...) list for `INSERT INTO prospect VALUES (...)`,
 *  columns in physical order:
 *  IDprospect, prénom, nom, email, société, adresse, code_postal, ville, pays,
 *  telephone, status_catalogue, date, observation, notes_interne, expe_catalogue,
 *  tracking_number, IDtransporteur, traité, IDclient */
function prospectPositionalValues(id: number, f: ProspectFields): string {
  return [
    String(id),
    sqlText(f.prenom), sqlText(f.nom), sqlText(f.email), sqlText(f.societe),
    sqlText(f.adresse), sqlText(f.code_postal), sqlText(f.ville), sqlText(f.pays),
    sqlText(f.telephone), String(n(f.status_catalogue)),
    `'${dateStr(f.date)}'`, sqlText(f.observation), sqlText(f.notes_interne),
    `'${dateStr(f.expe_catalogue)}'`, sqlText(f.tracking_number),
    String(n(f.IDtransporteur)), String(f.traite ? 1 : 0), String(n(f.IDclient)),
  ].join(', ')
}

// ── Validation ───────────────────────────────────────────

const prospectBody = z.object({
  prenom: z.string().max(150).optional(),
  nom: z.string().max(150).optional(),
  email: z.string().max(150).optional(),
  societe: z.string().max(150).optional(),
  adresse: z.string().max(255).optional(),
  code_postal: z.string().max(20).optional(),
  ville: z.string().max(120).optional(),
  pays: z.string().max(120).optional(),
  telephone: z.string().max(40).optional(),
  date: z.string().optional(),
  observation: z.string().optional(),
  notes_interne: z.string().optional(),
  expe_catalogue: z.string().optional(),
  tracking_number: z.string().max(120).optional(),
  IDtransporteur: z.number().int().nonnegative().optional(),
  traite: z.number().int().min(0).max(1).optional(),
})

const statusBody = z.object({
  status_catalogue: z.union([z.literal(1), z.literal(2), z.literal(3)]),
})

// Read prospect rows with CLEAN text values on both platforms.
//   • Linux: the accented column names (prénom, société) can't be CONVERT()'d,
//     so use the bridge's base64-text mode — every text value comes back decoded
//     from its raw Latin-1 bytes (accents intact). No fixEncoding needed.
//   • Windows: the odbc driver path uses the usual SELECT * + fixEncoding(CONVERT).
async function selectProspectRows(tail: string): Promise<Record<string, unknown>[]> {
  const sql = `SELECT * FROM prospect ${tail}`
  if (IS_WINDOWS) {
    const rows = await query<Record<string, unknown>>(sql)
    return fixEncoding(rows, 'prospect', 'IDprospect', TEXT_FIELDS_FULL)
  }
  return queryB64Text<Record<string, unknown>>(sql)
}

// ── Detail loader (shared by GET /:id, PUT, status, convert) ──

async function loadProspectDetail(id: number): Promise<Record<string, unknown> | null> {
  const rows = await selectProspectRows(`WHERE IDprospect = ${id}`)
  if (rows.length === 0) return null
  const p = normalizeProspectRow(rows[0])

  let transporteur_nom: string | null = null
  if (p.IDtransporteur > 0) {
    const tr = await query<{ IDtransporteur: number; nom: string }>(
      `SELECT IDtransporteur, nom FROM transporteur WHERE IDtransporteur = ${p.IDtransporteur}`,
    )
    const fixedTr = await fixEncoding(tr, 'transporteur', 'IDtransporteur', ['nom'])
    transporteur_nom = fixedTr[0]?.nom ?? null
  }

  let client_nom: string | null = null
  if (p.IDclient > 0) {
    const cl = await query<{ IDclient: number; nom: string }>(
      `SELECT IDclient, nom FROM client WHERE IDclient = ${p.IDclient}`,
    )
    const fixedCl = await fixEncoding(cl, 'client', 'IDclient', ['nom'])
    client_nom = fixedCl[0]?.nom ?? null
  }

  return { ...p, transporteur_nom, client_nom }
}

// ── Lite loader shared with devis.ts (prospect devis, #1112) ──

export interface ProspectLite {
  IDprospect: number
  /** Display name: société, else « Prénom Nom », else « Prospect #id ». */
  nom: string
  prenom: string
  nom_personne: string
  societe: string
  email: string
  telephone: string
  adresse: string
  code_postal: string
  ville: string
  pays: string
  IDclient: number
}

export function prospectDisplayName(p: { societe: string; prenom: string; nom: string; IDprospect: number }): string {
  return p.societe.trim() || `${p.prenom} ${p.nom}`.trim() || `Prospect #${p.IDprospect}`
}

/** Batched prospect read with clean text on both platforms. Used by devis.ts
 *  to resolve prospect devis (name for the list/PDF, email + address for the
 *  documents). Missing ids are simply absent from the map. */
export async function loadProspectsLite(ids: number[]): Promise<Map<number, ProspectLite>> {
  const out = new Map<number, ProspectLite>()
  const wanted = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)))
  if (wanted.length === 0) return out
  const rows = await selectProspectRows(`WHERE IDprospect IN (${wanted.join(',')})`)
  for (const raw of rows) {
    const p = normalizeProspectRow(raw)
    out.set(p.IDprospect, {
      IDprospect: p.IDprospect,
      nom: prospectDisplayName(p),
      prenom: p.prenom,
      nom_personne: p.nom,
      societe: p.societe,
      email: p.email,
      telephone: p.telephone,
      adresse: p.adresse,
      code_postal: p.code_postal,
      ville: p.ville,
      pays: p.pays,
      IDclient: p.IDclient,
    })
  }
  return out
}

// ── Transporteurs lookup ─────────────────────────────────

prospectsRouter.get('/lookups/transporteurs', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDtransporteur: number; nom: string }>(
      `SELECT IDtransporteur, nom FROM transporteur WHERE est_visible = 1 ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'transporteur', 'IDtransporteur', ['nom'])
    res.json(fixed.map((t) => ({ IDtransporteur: Number(t.IDtransporteur), nom: t.nom ?? '' })))
  } catch (err) {
    console.error('Error fetching transporteurs lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── List demandes ────────────────────────────────────────

prospectsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim().toLowerCase()
    const statusFilter = String(req.query.status ?? 'all')

    const rows = await selectProspectRows(`ORDER BY date DESC, IDprospect DESC`)
    let demandes = rows.map(normalizeProspectRow)

    if (statusFilter === 'nouveau') demandes = demandes.filter((d) => d.status_catalogue === 1)
    else if (statusFilter === 'en_attente') demandes = demandes.filter((d) => d.status_catalogue === 2)
    else if (statusFilter === 'terminee') demandes = demandes.filter((d) => d.status_catalogue === 3)

    if (q) {
      demandes = demandes.filter((d) => {
        const hay = `${d.prenom} ${d.nom} ${d.societe} ${d.email} ${d.ville}`.toLowerCase()
        return hay.includes(q)
      })
    }

    res.json(demandes)
  } catch (err) {
    console.error('Error fetching prospects:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Get one demande ──────────────────────────────────────

prospectsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const detail = await loadProspectDetail(id)
    if (!detail) { res.status(404).json({ error: 'Demande not found' }); return }
    res.json(detail)
  } catch (err) {
    console.error('Error fetching prospect:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Create demande ───────────────────────────────────────

prospectsRouter.post('/', async (req: Request, res: Response) => {
  try {
    if (!(await ensureCanEdit(req, res))) return
    const parsed = prospectBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data

    // New demandes always start at status_catalogue 1 (Nouveau), unconverted.
    const f: ProspectFields = {
      prenom: d.prenom ?? '', nom: d.nom ?? '', email: d.email ?? '', societe: d.societe ?? '',
      adresse: d.adresse ?? '', code_postal: d.code_postal ?? '', ville: d.ville ?? '',
      pays: d.pays ?? '', telephone: d.telephone ?? '',
      status_catalogue: 1,
      date: dateStr(d.date) || todayHfsql(),
      observation: d.observation ?? '', notes_interne: d.notes_interne ?? '',
      expe_catalogue: dateStr(d.expe_catalogue), tracking_number: d.tracking_number ?? '',
      IDtransporteur: d.IDtransporteur ?? 0, traite: d.traite ?? 0, IDclient: 0,
    }

    let newId: number
    if (IS_WINDOWS) {
      // Windows ODBC accepts accented column names → ordinary column-list INSERT.
      const cols = [
        'nom', 'email', 'adresse', 'code_postal', 'ville', 'pays', 'telephone',
        'status_catalogue', 'date', 'observation', 'notes_interne',
        'expe_catalogue', 'tracking_number', 'IDtransporteur', 'IDclient',
        'prénom', 'société', 'traité',
      ]
      const vals = [
        sqlText(f.nom), sqlText(f.email), sqlText(f.adresse), sqlText(f.code_postal),
        sqlText(f.ville), sqlText(f.pays), sqlText(f.telephone),
        '1', `'${dateStr(f.date)}'`, sqlText(f.observation),
        sqlText(f.notes_interne), `'${dateStr(f.expe_catalogue)}'`, sqlText(f.tracking_number),
        String(n(f.IDtransporteur)), '0',
        sqlText(f.prenom), sqlText(f.societe), String(f.traite ? 1 : 0),
      ]
      await query(`INSERT INTO prospect (${cols.join(', ')}) VALUES (${vals.join(', ')})`)
      const created = await selectProspectRows(`ORDER BY IDprospect DESC`)
      newId = normalizeProspectRow(created[0]).IDprospect
    } else {
      // Linux: accented column names are unwriteable → positional INSERT with an
      // explicit, self-assigned PK (max+1; positional INSERT doesn't auto-number).
      const maxRows = await query<{ m: unknown }>(`SELECT MAX(IDprospect) AS m FROM prospect`)
      newId = n(maxRows[0]?.m) + 1
      await query(`INSERT INTO prospect VALUES (${prospectPositionalValues(newId, f)})`)
    }

    const detail = await loadProspectDetail(newId)
    if (!detail) { res.status(500).json({ error: 'Insert failed' }); return }
    res.status(201).json(detail)
  } catch (err) {
    console.error('Error creating prospect:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Update demande ───────────────────────────────────────

prospectsRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    if (!(await ensureCanEdit(req, res))) return
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = prospectBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data

    // Linux: prénom/société/traité are accented column names → unwriteable in an
    // UPDATE on the iODBC bridge. When any of them actually changes, rewrite the
    // whole row positionally, preserving the PK. Reads are clean (b64text), so no
    // corrupted value is written back; the original row is restored if the
    // re-insert fails so a botched rewrite can never lose data.
    if (!IS_WINDOWS && (d.prenom !== undefined || d.societe !== undefined || d.traite !== undefined)) {
      const cur = await loadProspectDetail(id)
      if (!cur) { res.status(404).json({ error: 'Demande not found' }); return }
      const c = cur as unknown as ProspectFields & { IDprospect: number }
      const accentedChanged =
        (d.prenom !== undefined && d.prenom !== c.prenom) ||
        (d.societe !== undefined && d.societe !== c.societe) ||
        (d.traite !== undefined && (n(d.traite) ? 1 : 0) !== (c.traite ? 1 : 0))
      if (accentedChanged) {
        const merged: ProspectFields = {
          prenom: d.prenom ?? c.prenom,
          nom: d.nom ?? c.nom,
          email: d.email ?? c.email,
          societe: d.societe ?? c.societe,
          adresse: d.adresse ?? c.adresse,
          code_postal: d.code_postal ?? c.code_postal,
          ville: d.ville ?? c.ville,
          pays: d.pays ?? c.pays,
          telephone: d.telephone ?? c.telephone,
          status_catalogue: c.status_catalogue,
          date: d.date !== undefined ? dateStr(d.date) : c.date,
          observation: d.observation ?? c.observation,
          notes_interne: d.notes_interne ?? c.notes_interne,
          expe_catalogue: d.expe_catalogue !== undefined ? dateStr(d.expe_catalogue) : c.expe_catalogue,
          tracking_number: d.tracking_number ?? c.tracking_number,
          IDtransporteur: d.IDtransporteur ?? c.IDtransporteur,
          traite: d.traite !== undefined ? (n(d.traite) ? 1 : 0) : c.traite,
          IDclient: c.IDclient,
        }
        const restore = prospectPositionalValues(id, c)
        const next = prospectPositionalValues(id, merged)
        await query(`DELETE FROM prospect WHERE IDprospect = ${id}`)
        try {
          await query(`INSERT INTO prospect VALUES (${next})`)
        } catch (e) {
          try { await query(`INSERT INTO prospect VALUES (${restore})`) } catch { /* keep original error */ }
          throw e
        }
        const detail = await loadProspectDetail(id)
        res.json(detail); return
      }
      // accented fields present but unchanged → fall through to the named UPDATE
    }

    const sets: string[] = []
    if (d.nom !== undefined) sets.push(`nom = ${sqlText(d.nom)}`)
    if (d.email !== undefined) sets.push(`email = ${sqlText(d.email)}`)
    if (d.adresse !== undefined) sets.push(`adresse = ${sqlText(d.adresse)}`)
    if (d.code_postal !== undefined) sets.push(`code_postal = ${sqlText(d.code_postal)}`)
    if (d.ville !== undefined) sets.push(`ville = ${sqlText(d.ville)}`)
    if (d.pays !== undefined) sets.push(`pays = ${sqlText(d.pays)}`)
    if (d.telephone !== undefined) sets.push(`telephone = ${sqlText(d.telephone)}`)
    if (d.date !== undefined) sets.push(`date = '${dateStr(d.date)}'`)
    if (d.observation !== undefined) sets.push(`observation = ${sqlText(d.observation)}`)
    if (d.notes_interne !== undefined) sets.push(`notes_interne = ${sqlText(d.notes_interne)}`)
    if (d.expe_catalogue !== undefined) sets.push(`expe_catalogue = '${dateStr(d.expe_catalogue)}'`)
    if (d.tracking_number !== undefined) sets.push(`tracking_number = ${sqlText(d.tracking_number)}`)
    if (d.IDtransporteur !== undefined) sets.push(`IDtransporteur = ${n(d.IDtransporteur)}`)
    // Accented columns: writable only on the Windows ODBC driver.
    if (IS_WINDOWS) {
      if (d.prenom !== undefined) sets.push(`prénom = ${sqlText(d.prenom)}`)
      if (d.societe !== undefined) sets.push(`société = ${sqlText(d.societe)}`)
      if (d.traite !== undefined) sets.push(`traité = ${n(d.traite) ? 1 : 0}`)
    }

    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }

    await query(`UPDATE prospect SET ${sets.join(', ')} WHERE IDprospect = ${id}`)

    const detail = await loadProspectDetail(id)
    if (!detail) { res.status(404).json({ error: 'Demande not found' }); return }
    res.json(detail)
  } catch (err) {
    console.error('Error updating prospect:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Change status ────────────────────────────────────────

prospectsRouter.put('/:id/status', async (req: Request, res: Response) => {
  try {
    if (!(await ensureCanEdit(req, res))) return
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = statusBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }

    await query(
      `UPDATE prospect SET status_catalogue = ${parsed.data.status_catalogue} WHERE IDprospect = ${id}`,
    )

    const detail = await loadProspectDetail(id)
    if (!detail) { res.status(404).json({ error: 'Demande not found' }); return }
    res.json(detail)
  } catch (err) {
    console.error('Error updating prospect status:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Convert demande to client ────────────────────────────

prospectsRouter.post('/:id/convert', async (req: Request, res: Response) => {
  try {
    if (!(await ensureCanEdit(req, res))) return
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await query<Record<string, unknown>>(`SELECT * FROM prospect WHERE IDprospect = ${id}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Demande not found' }); return }
    const fixed = await fixEncoding(rows, 'prospect', 'IDprospect', TEXT_FIELDS_FULL)
    const p = normalizeProspectRow(fixed[0])

    if (p.IDclient > 0) {
      res.status(409).json({
        error: 'already_converted',
        message: 'Ce prospect est déjà converti en client.',
      })
      return
    }

    // The `client` table has no first-name/email/postal-address columns
    // (those live in the `adresse` / `contact` tables) — create the master
    // row here, then a default `adresse` and `contact` below. `bloqué` /
    // `archivé` are accented identifiers, so they are left to their HFSQL
    // default (0).
    const clientNom = (p.societe.trim() || `${p.prenom} ${p.nom}`.trim() || `Prospect #${id}`).slice(0, 100)
    const tel = p.telephone.slice(0, 20)

    // IDsociete = 1 (Ets Malterre) — the legacy WinDev Clients screen filters
    // on this and hides rows where IDsociete = 0. See memory project_societe_multi_company.
    // commentaire intentionally empty — prospect observation is not copied.
    await query(
      `INSERT INTO client (nom, tel, IDtransporteur, commentaire, date_creation, est_visible, client_interne, IDsociete) ` +
      `VALUES (${sqlText(clientNom)}, ${sqlText(tel)}, ${p.IDtransporteur}, '', '${todayHfsql()}', 1, 0, 1)`,
    )
    const createdClient = await query<Record<string, unknown>>(
      `SELECT IDclient FROM client ORDER BY IDclient DESC`,
    )
    if (createdClient.length === 0) { res.status(500).json({ error: 'Client insert failed' }); return }
    const newClientId = n(createdClient[0].IDclient)

    // Default adresse — flagged as the master default. Other discriminator
    // FKs (IDsous_traitant, IDfournisseur, IDentreprise) are 0 since this
    // adresse belongs to a client.
    await query(
      `INSERT INTO adresse (IDclient, IDsous_traitant, IDfournisseur, IDentreprise, nom, adresse1, adresse2, adresse3, cp, ville, pays, commentaire, est_defaut, est_defaut_facturation, est_defaut_livraison, est_visible) ` +
      `VALUES (${newClientId}, 0, 0, 0, ${sqlText(clientNom)}, ${sqlText(p.adresse)}, '', '', ${sqlText(p.code_postal)}, ${sqlText(p.ville)}, ${sqlText(p.pays)}, '', 1, 1, 1, 1)`,
    )

    // Default contact — carries the prospect's person name / email / phone.
    // envoi_* flags default to 1 (BL, facture, commande) so the contact is
    // pre-selected as a recipient by §32 email dialogs; envoi_soumission stays 0.
    await query(
      `INSERT INTO contact (IDclient, IDsous_traitant, IDfournisseur, IDentreprise, prenom, nom, tel, mail, commentaire, est_defaut, est_visible, envoi_bl, envoi_facture, envoi_commande, envoi_soumission) ` +
      `VALUES (${newClientId}, 0, 0, 0, ${sqlText(p.prenom)}, ${sqlText(p.nom)}, ${sqlText(tel)}, ${sqlText(p.email)}, '', 1, 1, 1, 1, 1, 0)`,
    )

    // Resolve the freshly created default adresse — the re-homed devis below
    // point at it instead of the legacy « A Définir » placeholder (795).
    const createdAdresse = await query<{ IDadresse: number }>(
      `SELECT IDadresse FROM adresse WHERE IDclient = ${newClientId} ORDER BY IDadresse DESC`,
    )
    const newAdresseId = n(createdAdresse[0]?.IDadresse)

    // Re-home the prospect's OPEN devis onto the new client (#1112, user
    // decision 2026-09-02): IDclient set + IDprospect cleared turns them into
    // ordinary client devis — visible in the WinDev devis list too, and
    // transformable into a commande. Soldé prospect devis stay attached to
    // the prospect (history).
    let devisRehomed = 0
    const openDevis = await query<{ IDDevis_etm: number }>(
      `SELECT IDDevis_etm FROM devis_etm WHERE IDprospect = ${id} AND est_soldee = 0`,
    )
    if (openDevis.length > 0) {
      const adresseSets = newAdresseId > 0
        ? `, IDadresse_livraison = ${newAdresseId}, IDadresse_facturation = ${newAdresseId}`
        : ''
      await query(
        `UPDATE devis_etm SET IDclient = ${newClientId}, IDprospect = 0${adresseSets}
         WHERE IDprospect = ${id} AND est_soldee = 0`,
      )
      devisRehomed = openDevis.length
    }

    // Linking + status (3 = Terminée) use non-accented columns — safe on Linux.
    await query(
      `UPDATE prospect SET IDclient = ${newClientId}, status_catalogue = 3 WHERE IDprospect = ${id}`,
    )

    const detail = await loadProspectDetail(id)
    res.json({ IDclient: newClientId, devis_rehomed: devisRehomed, demande: detail })
  } catch (err) {
    console.error('Error converting prospect:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Delete demande ───────────────────────────────────────

prospectsRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    if (!(await ensureCanEdit(req, res))) return
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    await query(`DELETE FROM prospect WHERE IDprospect = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting prospect:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
