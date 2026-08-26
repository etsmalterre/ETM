// Qualité › Retour client — TRM's side of a quality complaint
// (legacy FI_Retour_ClientTRM.wdw, recovered from the WinDev compile cache;
// the live-data dossier is `apps/api/src/scripts/probe-retour-client-trm.ts`).
//
// `retour_client` has NO IDsociete column: the object is TRM's by nature, the
// way ordre_fabrication and planning_bonnetier are. So this is a TRM-only
// router (the stock-ecru-trm.ts shape), not a two-scope factory like
// factures.ts — ETM has no counterpart object, it has the *other end* of the
// same conversation.
//
// ── The FNC loop (why this screen exists) ────────────────
// All 91 live rows carry `IDdossier_qualite > 0`: a retour client is what a
// `dossier_qualite` becomes once ETM sends its FNC to Tricotage Malterre.
// Verified column by column against the linked dossiers:
//     dossier_qualite.messageFNC      → retour_client.message_client
//     dossier_qualite.envoiFNC        → retour_client.DATE
//     dossier_qualite.IDdefaut_textile → retour_client.IDdefaut_textile
//     dossier_qualite.IDSociétéFNC = 1 (Tricotage Malterre) on every row
// and the answer travels back the other way:
//     retour_client.IDresolution_qualite + .reponse
//         → dossier_qualite.reponseFNC = "<libellé>\r\n<commentaire>"
// That write-back is what makes ETM's dossier list show `has_reponse`; it goes
// through `writeFncReponse()` in dossiers-qualite.ts so the encoding has ONE
// owner. Note the asymmetry: `IDclient` is NOT mirrored — the dossier names
// ETM's end client, the retour names TRM's (Ets Malterre, société 2).
//
// The affectation is **seeded then owned by TRM**: it diverges from the
// dossier on 13 of the 91 rows because the atelier re-points it at the roll it
// actually found (or narrows ETM's lot to one piece). It is editable here and
// never written back.
//
// ── Affectation semantics — a real trap ──────────────────
// `Type_Reference` is a *string* discriminator over the free-text `reference`:
//   '1' → stock_ecru.numero  (a knitted roll, 85 rows)
//   '2' → stock_fini.lot     (a FINISHED lot, 6 rows)
// On dossier_qualite the very same '2' means a **lot de fil** (stock_fil.lot).
// Same code, two tables — always read the discriminator against the table you
// are actually in. `stock_ecru.numero` is not unique and 6 historical
// references resolve to nothing at all, so resolution always yields a *list*,
// possibly empty.
//
// ── HFSQL rules ──────────────────────────────────────────
//  - `archivé` is the only accented column, and it is the En cours / Terminé
//    flag. Reads fold it via readCol(); the write goes through patchArchive():
//    named SET on Windows, full positional row rewrite on Linux (the bridge
//    cannot name it at all). RC_COLUMNS below is the RUNTIME `SELECT *` order,
//    which differs from the MPS.xdd listing — the same trap that bit
//    controle_titrage. The probe re-asserts it on every run.
//  - `DATE` is a reserved word: it comes back uppercased and is written as
//    `DATE` everywhere (SELECT alias, SET, positional INSERT).
//  - The four memo columns carry accents → sqlText() Latin-1 hex literals.
//  - No memo-BINARY column here, so `SELECT *` is safe on the Windows ODBC
//    driver too (unlike `client` / `stock_fil`).
//  - Reads of stock_ecru NEVER filter IDsociete: the ETM reception flips a
//    delivered roll from 2 to 1, and every referenced roll is already at 1.
//
// ── Dead columns — do not surface an input for these ─────
//  `impact_prime` (0 on 91/91, and the legacy window has no field for it — it
//  only appears on the printed sheet) and `defaut` (a text copy of the defect
//  label, empty on 90/91). The live label comes from IDdefaut_textile.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, queryRaw, queryB64Text, fixEncoding } from '../lib/hfsql-auto.js'
import { esc, n, IS_WINDOWS } from '../lib/sst-shared.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { trmUserHasPermission } from '../lib/permissions-trm.js'
import { loadFncSummaries, writeFncReponse, type FncSummary } from './dossiers-qualite.js'
import { renderRetourClientPdfBuffer, type RetourClientPdfData } from '../lib/pdf/RetourClientPdf.js'
import { type EmailRecipientPayload } from './expeditions.js'
import { sendMail } from '../lib/gmail.js'
import { getUserEmail } from '../lib/user-emails.js'

export const retoursClientTrmRouter: RouterType = Router()

const TRM_SOCIETE = 2

// ── SQL / format helpers ─────────────────────────────────

/** SQL literal for user text. Pure ASCII → quoted; accented → Latin-1 hex
 *  literal (raw multi-byte UTF-8 in a SQL line corrupts the Linux bridge). */
function sqlText(value: string | null | undefined): string {
  const v = (value ?? '').toString()
  if (v === '') return "''"
  if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(v)) return `'${esc(v)}'`
  const ascii = v
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ | /g, ' ')
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

function todayDigits8(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** `archivé` → `archiv` — the Linux driver truncates an accented column name
 *  at its first non-ASCII char, in the returned key as well as in SQL text. */
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

// ── retour_client physical column order ──────────────────
// RUNTIME `SELECT *` order — the positional rewrite on Linux depends on it.
// Re-asserted by probe-retour-client-trm.ts §2 on every run.
const RC_COLUMNS = [
  'IDretour_client',
  'message_client',
  'reponse',
  'impact_prime',
  'IDclient',
  'DATE',
  'Type_Reference',
  'reference',
  'archivé',
  'defaut',
  'IDdossier_qualite',
  'IDdefaut_textile',
  'journal',
  'message_resp_atelier',
  'IDresolution_qualite',
  'IDbonnetier',
  'IDmachine',
] as const

/** Columns emitted as SQL text literals; everything else is numeric. */
const RC_TEXT_COLUMNS = new Set<string>([
  'message_client', 'reponse', 'DATE', 'Type_Reference', 'reference',
  'defaut', 'journal', 'message_resp_atelier',
])

const RC_TEXT_FIELDS_FOR_REPAIR = [
  'message_client', 'reponse', 'Type_Reference', 'reference', 'defaut',
  'journal', 'message_resp_atelier',
]

/** SELECT * with clean text on both platforms. */
async function selectRetourRows(tail: string): Promise<Record<string, unknown>[]> {
  const sql = `SELECT * FROM retour_client ${tail}`
  if (IS_WINDOWS) {
    const rows = await query<Record<string, unknown>>(sql)
    return fixEncoding(rows, 'retour_client', 'IDretour_client', RC_TEXT_FIELDS_FOR_REPAIR)
  }
  return queryB64Text<Record<string, unknown>>(sql)
}

// ── Row shape ────────────────────────────────────────────

interface RetourRow {
  IDretour_client: number
  IDclient: number
  date: string | null
  IDdefaut_textile: number
  /** Legacy free-text copy of the defect label — dead (empty on 90/91). */
  defaut_legacy: string
  message_client: string
  message_resp_atelier: string
  reponse: string
  type_reference: string
  reference: string
  /** Dead — 0 on every row, no input in the legacy window. Printed anyway. */
  impact_prime: number
  archive: 0 | 1
  IDdossier_qualite: number
  journal: string
  IDresolution_qualite: number
  IDbonnetier: number
  IDmachine: number
}

function normalizeRetour(raw: Record<string, unknown>): RetourRow {
  const d = dateDigits8(readCol(raw, 'DATE'))
  return {
    IDretour_client: n(readCol(raw, 'IDretour_client')),
    IDclient: n(readCol(raw, 'IDclient')),
    date: d || null,
    IDdefaut_textile: n(readCol(raw, 'IDdefaut_textile')),
    defaut_legacy: trimStr(readCol(raw, 'defaut')),
    message_client: (readCol(raw, 'message_client') ?? '').toString(),
    message_resp_atelier: (readCol(raw, 'message_resp_atelier') ?? '').toString(),
    reponse: (readCol(raw, 'reponse') ?? '').toString(),
    type_reference: trimStr(readCol(raw, 'Type_Reference')),
    reference: trimStr(readCol(raw, 'reference')),
    impact_prime: Number(readCol(raw, 'impact_prime')) || 0,
    archive: n(readCol(raw, 'archivé')) === 1 ? 1 : 0,
    IDdossier_qualite: n(readCol(raw, 'IDdossier_qualite')),
    journal: (readCol(raw, 'journal') ?? '').toString(),
    IDresolution_qualite: n(readCol(raw, 'IDresolution_qualite')),
    IDbonnetier: n(readCol(raw, 'IDbonnetier')),
    IDmachine: n(readCol(raw, 'IDmachine')),
  }
}

// ── Lookups ──────────────────────────────────────────────

interface Lookups {
  clients: { IDclient: number; nom: string }[]
  defauts: { IDdefaut_textile: number; nom: string; categorie: string }[]
  resolutions: { IDresolution_qualite: number; libelle: string }[]
  bonnetiers: { IDbonnetier: number; nom: string }[]
  machines: { IDmachine: number; nom: string }[]
}

/** Résolutions are société-partitioned: TRM's four libellés (id_societe = 2)
 *  plus the shared « Autre » (0). Serving ETM's would let the atelier pick a
 *  libellé the FNC round-trip cannot match back. */
async function loadResolutions(): Promise<{ IDresolution_qualite: number; libelle: string }[]> {
  const rows = await fixEncoding(
    await query<any>(
      `SELECT IDresolution_qualite, libelle, id_societe FROM resolution_qualite
       WHERE id_societe IN (${TRM_SOCIETE}, 0) ORDER BY id_societe DESC, libelle`,
    ),
    'resolution_qualite', 'IDresolution_qualite', ['libelle'],
  )
  return (rows as any[])
    .map((r) => ({ IDresolution_qualite: n(r.IDresolution_qualite), libelle: trimStr(r.libelle) }))
    .filter((r) => r.IDresolution_qualite > 0 && r.libelle !== '')
}

/** `bonnetier` carries accented `prénom` / `archivé` → SELECT * + JS filter,
 *  the planning-atelier.ts contract. Archived staff stay in the list only when
 *  a stored row still points at them (historical dossiers name people who left). */
async function loadBonnetiers(keepIds: number[]): Promise<{ IDbonnetier: number; nom: string; archive: 0 | 1 }[]> {
  const sql = 'SELECT * FROM bonnetier'
  const rows = IS_WINDOWS
    ? await fixEncoding(await query<Record<string, unknown>>(sql), 'bonnetier', 'IDbonnetier', ['prénom', 'nom'])
    : await queryB64Text<Record<string, unknown>>(sql)
  const keep = new Set(keepIds.filter((x) => x > 0))
  return (rows as any[])
    .map((r) => {
      const id = n(readCol(r, 'IDbonnetier'))
      const prenom = trimStr(readCol(r, 'prénom'))
      const nom = trimStr(readCol(r, 'nom'))
      return {
        IDbonnetier: id,
        nom: [prenom, nom].filter(Boolean).join(' '),
        archive: (n(readCol(r, 'archivé')) === 1 ? 1 : 0) as 0 | 1,
      }
    })
    .filter((b) => b.IDbonnetier > 0 && b.nom !== '' && (b.archive === 0 || keep.has(b.IDbonnetier)))
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))
}

async function loadMachines(): Promise<{ IDmachine: number; nom: string }[]> {
  const rows = await fixEncoding(
    await query<any>(`SELECT IDmachine, nom FROM machine ORDER BY nom`),
    'machine', 'IDmachine', ['nom'],
  )
  return (rows as any[])
    .map((m) => ({ IDmachine: n(m.IDmachine), nom: trimStr(m.nom) }))
    .filter((m) => m.IDmachine > 0 && m.nom !== '')
}

retoursClientTrmRouter.get('/lookups', async (_req: Request, res: Response) => {
  try {
    // Bonnetiers/machines already stored on a dossier must stay selectable even
    // when archived, or opening an old dossier would silently blank its Info tab.
    const storedRows = await query<any>(
      `SELECT IDbonnetier FROM retour_client WHERE IDbonnetier > 0 GROUP BY IDbonnetier`,
    )
    const [clientRows, defautRows, categorieRows, resolutions, bonnetiers, machines] = await Promise.all([
      fixEncoding(
        await query<any>(`SELECT IDclient, nom FROM client WHERE IDsociete = ${TRM_SOCIETE} ORDER BY nom`),
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
      loadResolutions(),
      loadBonnetiers((storedRows as any[]).map((r) => n(r.IDbonnetier))),
      loadMachines(),
    ])

    const catName = new Map<number, string>(
      (categorieRows as any[]).map((c) => [n(c.IDcategorie_defaut), trimStr(c.nom)]),
    )

    const out: Lookups = {
      clients: (clientRows as any[])
        .map((c) => ({ IDclient: n(c.IDclient), nom: trimStr(c.nom) }))
        .filter((c) => c.IDclient > 0 && c.nom !== ''),
      defauts: (defautRows as any[]).map((d) => ({
        IDdefaut_textile: n(d.IDdefaut_textile),
        nom: trimStr(d.nom),
        categorie: catName.get(n(d.IDcategorie_defaut)) ?? '',
      })),
      resolutions,
      bonnetiers: bonnetiers.map(({ IDbonnetier, nom }) => ({ IDbonnetier, nom })),
      machines,
    }
    res.json(out)
  } catch (err) {
    console.error('Error loading retour-client-trm lookups:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Label resolution shared by list + detail ─────────────

async function loadLabels(rows: RetourRow[]): Promise<{
  clientNom: Map<number, string>
  defautNom: Map<number, string>
  defautCategorie: Map<number, string>
  resolutionLibelle: Map<number, string>
  bonnetierNom: Map<number, string>
  machineNom: Map<number, string>
}> {
  const ids = (pick: (r: RetourRow) => number) =>
    Array.from(new Set(rows.map(pick).filter((x) => x > 0)))

  const clientIds = ids((r) => r.IDclient)
  const defautIds = ids((r) => r.IDdefaut_textile)
  const resolutionIds = ids((r) => r.IDresolution_qualite)
  const bonnetierIds = ids((r) => r.IDbonnetier)
  const machineIds = ids((r) => r.IDmachine)

  const [clientRows, defautRows, categorieRows, resolutionRows, bonnetiers, machineRows] = await Promise.all([
    clientIds.length
      ? fixEncoding(
          await query<any>(`SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`),
          'client', 'IDclient', ['nom'],
        )
      : ([] as any[]),
    defautIds.length
      ? fixEncoding(
          await query<any>(
            `SELECT IDdefaut_textile, nom, IDcategorie_defaut FROM defaut_textile WHERE IDdefaut_textile IN (${defautIds.join(',')})`,
          ),
          'defaut_textile', 'IDdefaut_textile', ['nom'],
        )
      : ([] as any[]),
    fixEncoding(
      await query<any>(`SELECT IDcategorie_defaut, nom FROM categorie_defaut`),
      'categorie_defaut', 'IDcategorie_defaut', ['nom'],
    ),
    resolutionIds.length
      ? fixEncoding(
          await query<any>(
            `SELECT IDresolution_qualite, libelle FROM resolution_qualite WHERE IDresolution_qualite IN (${resolutionIds.join(',')})`,
          ),
          'resolution_qualite', 'IDresolution_qualite', ['libelle'],
        )
      : ([] as any[]),
    bonnetierIds.length ? loadBonnetiers(bonnetierIds) : Promise.resolve([]),
    machineIds.length
      ? fixEncoding(
          await query<any>(`SELECT IDmachine, nom FROM machine WHERE IDmachine IN (${machineIds.join(',')})`),
          'machine', 'IDmachine', ['nom'],
        )
      : ([] as any[]),
  ])

  const catName = new Map<number, string>(
    (categorieRows as any[]).map((c) => [n(c.IDcategorie_defaut), trimStr(c.nom)]),
  )
  return {
    clientNom: new Map((clientRows as any[]).map((c) => [n(c.IDclient), trimStr(c.nom)])),
    defautNom: new Map((defautRows as any[]).map((d) => [n(d.IDdefaut_textile), trimStr(d.nom)])),
    defautCategorie: new Map(
      (defautRows as any[]).map((d) => [n(d.IDdefaut_textile), catName.get(n(d.IDcategorie_defaut)) ?? '']),
    ),
    resolutionLibelle: new Map(
      (resolutionRows as any[]).map((r) => [n(r.IDresolution_qualite), trimStr(r.libelle)]),
    ),
    bonnetierNom: new Map(bonnetiers.map((b) => [b.IDbonnetier, b.nom])),
    machineNom: new Map((machineRows as any[]).map((m) => [n(m.IDmachine), trimStr(m.nom)])),
  }
}

// ── GET / — list ─────────────────────────────────────────

retoursClientTrmRouter.get('/', async (req: Request, res: Response) => {
  try {
    const statut = trimStr(req.query.statut) || 'en_cours'
    const rows = (await selectRetourRows('ORDER BY IDretour_client DESC')).map(normalizeRetour)
    // `archivé` cannot be named in a WHERE on the Linux bridge — filter in JS,
    // the table is 91 rows and grows a few per year.
    const filtered =
      statut === 'tous' ? rows : rows.filter((r) => (statut === 'termine' ? r.archive === 1 : r.archive === 0))

    const [labels, fncs] = await Promise.all([
      loadLabels(filtered),
      loadFncSummaries(filtered.map((r) => r.IDdossier_qualite)),
    ])

    res.json(
      filtered.map((r) => {
        const fnc = fncs.get(r.IDdossier_qualite)
        return {
          IDretour_client: r.IDretour_client,
          client_nom: labels.clientNom.get(r.IDclient) ?? '',
          defaut_label: labels.defautNom.get(r.IDdefaut_textile) || r.defaut_legacy,
          date: r.date,
          archive: r.archive,
          type_reference: r.type_reference,
          reference: r.reference,
          IDdossier_qualite: r.IDdossier_qualite,
          echeance: fnc?.echeance ?? null,
          has_reponse: r.reponse.trim() !== '' || r.IDresolution_qualite > 0 ? 1 : 0,
        }
      }),
    )
  } catch (err) {
    console.error('Error listing retours client TRM:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /:id — detail ────────────────────────────────────

async function readRetour(id: number): Promise<RetourRow | null> {
  const rows = await selectRetourRows(`WHERE IDretour_client = ${id}`)
  return rows[0] ? normalizeRetour(rows[0]) : null
}

retoursClientTrmRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const row = await readRetour(id)
    if (!row) { res.status(404).json({ error: 'Retour client not found' }); return }

    const [labels, fncs] = await Promise.all([
      loadLabels([row]),
      loadFncSummaries([row.IDdossier_qualite]),
    ])
    const fnc: FncSummary | undefined = fncs.get(row.IDdossier_qualite)

    // The complainant ETM actually acted for — TRM's own row always says
    // "Ets Malterre", so the real end client only exists on the dossier.
    let clientEtm = ''
    if (fnc && fnc.IDclient > 0) {
      const etmRows = await fixEncoding(
        await query<any>(`SELECT IDclient, nom FROM client WHERE IDclient = ${fnc.IDclient}`),
        'client', 'IDclient', ['nom'],
      )
      clientEtm = trimStr((etmRows as any[])[0]?.nom)
    }

    res.json({
      IDretour_client: row.IDretour_client,
      IDclient: row.IDclient,
      client_nom: labels.clientNom.get(row.IDclient) ?? '',
      IDdefaut_textile: row.IDdefaut_textile,
      defaut_nom: labels.defautNom.get(row.IDdefaut_textile) || row.defaut_legacy,
      defaut_categorie: labels.defautCategorie.get(row.IDdefaut_textile) ?? '',
      date: row.date,
      message_client: row.message_client,
      message_resp_atelier: row.message_resp_atelier,
      reponse: row.reponse,
      type_reference: row.type_reference,
      reference: row.reference,
      impact_prime: row.impact_prime,
      archive: row.archive,
      journal: row.journal,
      IDresolution_qualite: row.IDresolution_qualite,
      resolution_libelle: labels.resolutionLibelle.get(row.IDresolution_qualite) ?? '',
      IDbonnetier: row.IDbonnetier,
      bonnetier_nom: labels.bonnetierNom.get(row.IDbonnetier) ?? '',
      IDmachine: row.IDmachine,
      machine_nom: labels.machineNom.get(row.IDmachine) ?? '',
      fnc: fnc
        ? {
            IDdossier_qualite: fnc.IDdossier_qualite,
            envoi_fnc: fnc.envoi_fnc,
            echeance: fnc.echeance,
            message_fnc: fnc.message_fnc,
            termine: fnc.termine,
            client_etm: clientEtm,
          }
        : null,
    })
  } catch (err) {
    console.error('Error loading retour client TRM:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Permission gate ──────────────────────────────────────

/** `edit_retour_client` — création, modification, suppression et clôture.
 *  Reading is not gated: quality data is not confidential, and screen
 *  visibility already rides the Écrans axis. Sends its own 401/403. */
async function requireEdit(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const allowed = await trmUserHasPermission(req.userId, isEffectiveAdmin(req), 'edit_retour_client')
  if (!allowed) {
    res.status(403).json({ error: 'permission denied: edit_retour_client' })
    return false
  }
  return true
}

// ── Writes ───────────────────────────────────────────────

/** Emit one positional value for a retour_client column. */
function rcLiteral(column: string, value: unknown): string {
  if (RC_TEXT_COLUMNS.has(column)) return sqlText(value == null ? '' : value.toString())
  if (column === 'impact_prime') return String(Number(value) || 0)
  return String(n(value))
}

/**
 * Write the accented `archivé` flag. Windows names it directly; the Linux
 * bridge cannot, so the whole row is re-inserted positionally under the same
 * PK. Best-effort restore if the re-insert fails, so an interrupted toggle
 * cannot lose a dossier. (Same shape as patchAccented() in dossiers-qualite.ts,
 * which has to do it for four columns — here there is exactly one.)
 */
async function patchArchive(id: number, archive: 0 | 1): Promise<void> {
  if (IS_WINDOWS) {
    await query(`UPDATE retour_client SET archivé = ${archive} WHERE IDretour_client = ${id}`)
    return
  }
  const rows = await selectRetourRows(`WHERE IDretour_client = ${id}`)
  const original = rows[0]
  if (!original) throw new Error(`retour_client ${id} disappeared before rewrite`)

  const values: Record<string, unknown> = {}
  for (const col of RC_COLUMNS) values[col] = readCol(original, col)
  values['archivé'] = archive

  const literals = RC_COLUMNS.map((c) => rcLiteral(c, values[c]))
  const restore = RC_COLUMNS.map((c) => rcLiteral(c, readCol(original, c)))

  await query(`DELETE FROM retour_client WHERE IDretour_client = ${id}`)
  try {
    await query(`INSERT INTO retour_client VALUES (${literals.join(', ')})`)
  } catch (err) {
    try {
      await query(`DELETE FROM retour_client WHERE IDretour_client = ${id}`)
      await query(`INSERT INTO retour_client VALUES (${restore.join(', ')})`)
    } catch {
      console.error(`[retours-client-trm] FAILED to restore retour ${id} after rewrite error`)
    }
    throw err
  }
}

const updateBody = z.object({
  IDclient: z.number().int().nonnegative().optional(),
  IDdefaut_textile: z.number().int().nonnegative().optional(),
  date: z.string().optional(),
  message_client: z.string().max(20000).optional(),
  message_resp_atelier: z.string().max(20000).optional(),
  reponse: z.string().max(20000).optional(),
  journal: z.string().max(20000).optional(),
  type_reference: z.string().max(10).optional(),
  reference: z.string().max(50).optional(),
  IDresolution_qualite: z.number().int().nonnegative().optional(),
  IDbonnetier: z.number().int().nonnegative().optional(),
  IDmachine: z.number().int().nonnegative().optional(),
})

retoursClientTrmRouter.put('/:id', async (req: Request, res: Response) => {
  if (!(await requireEdit(req, res))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = updateBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const b = parsed.data
    const existing = await readRetour(id)
    if (!existing) { res.status(404).json({ error: 'Retour client not found' }); return }

    // Every writable column is ASCII-named → one plain UPDATE on both platforms.
    // (`archivé` is the sole exception and has its own endpoint.)
    const sets: string[] = []
    if (b.IDclient !== undefined) sets.push(`IDclient = ${n(b.IDclient)}`)
    if (b.IDdefaut_textile !== undefined) sets.push(`IDdefaut_textile = ${n(b.IDdefaut_textile)}`)
    if (b.date !== undefined) {
      const d = dateDigits8(b.date)
      sets.push(`DATE = ${d ? `'${d}'` : "''"}`)
    }
    if (b.message_client !== undefined) sets.push(`message_client = ${sqlText(b.message_client)}`)
    if (b.message_resp_atelier !== undefined) sets.push(`message_resp_atelier = ${sqlText(b.message_resp_atelier)}`)
    if (b.reponse !== undefined) sets.push(`reponse = ${sqlText(b.reponse)}`)
    if (b.journal !== undefined) sets.push(`journal = ${sqlText(b.journal)}`)
    if (b.type_reference !== undefined) sets.push(`Type_Reference = ${sqlText(b.type_reference)}`)
    if (b.reference !== undefined) sets.push(`reference = ${sqlText(b.reference)}`)
    if (b.IDresolution_qualite !== undefined) sets.push(`IDresolution_qualite = ${n(b.IDresolution_qualite)}`)
    if (b.IDbonnetier !== undefined) sets.push(`IDbonnetier = ${n(b.IDbonnetier)}`)
    if (b.IDmachine !== undefined) sets.push(`IDmachine = ${n(b.IDmachine)}`)

    if (sets.length > 0) {
      await query(`UPDATE retour_client SET ${sets.join(', ')} WHERE IDretour_client = ${id}`)
    }

    // ── The FNC loop: publish the answer back onto ETM's dossier.
    // Only the answer travels — never the affectation (TRM re-points it on 13
    // of the 91 live rows) and never the client (the two names differ by design).
    if (existing.IDdossier_qualite > 0 && (b.reponse !== undefined || b.IDresolution_qualite !== undefined)) {
      const resolutionId = b.IDresolution_qualite ?? existing.IDresolution_qualite
      const libelle = resolutionId > 0
        ? (await loadResolutions()).find((r) => r.IDresolution_qualite === resolutionId)?.libelle ?? ''
        : ''
      await writeFncReponse(existing.IDdossier_qualite, libelle, b.reponse ?? existing.reponse)
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating retour client TRM:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /:id/archive — the status footer pill (Terminer / Réactiver).
retoursClientTrmRouter.put('/:id/archive', async (req: Request, res: Response) => {
  if (!(await requireEdit(req, res))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = z.object({ archive: z.union([z.literal(0), z.literal(1)]) }).safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed' }); return }

    const existing = await readRetour(id)
    if (!existing) { res.status(404).json({ error: 'Retour client not found' }); return }

    // Deliberately does NOT touch dossier_qualite.terminé: ETM closes its own
    // dossier when it is satisfied with the answer, which is a separate decision.
    await patchArchive(id, parsed.data.archive)
    res.json({ ok: true, archive: parsed.data.archive })
  } catch (err) {
    console.error('Error toggling retour client TRM status:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST / — create ──────────────────────────────────────
//
// A natively created retour (IDdossier_qualite = 0) — a complaint that reached
// the atelier directly rather than through ETM's FNC. Zero live rows look like
// this today; the legacy « Nouveau » button makes it possible and we keep it.

const createBody = z.object({
  IDclient: z.number().int().positive(),
  IDdefaut_textile: z.number().int().nonnegative(),
  message_client: z.string().max(20000).default(''),
  date: z.string().optional(),
})

retoursClientTrmRouter.post('/', async (req: Request, res: Response) => {
  if (!(await requireEdit(req, res))) return
  try {
    const parsed = createBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const b = parsed.data
    const maxRows = await query<{ id: number }>(`SELECT MAX(IDretour_client) AS id FROM retour_client`)
    const newId = n(maxRows[0]?.id) + 1

    const seed: Record<string, unknown> = {
      IDretour_client: newId,
      message_client: b.message_client,
      reponse: '',
      impact_prime: 0,
      IDclient: b.IDclient,
      DATE: dateDigits8(b.date) || todayDigits8(),
      Type_Reference: '',
      reference: '',
      'archivé': 0,
      defaut: '',
      IDdossier_qualite: 0,
      IDdefaut_textile: b.IDdefaut_textile,
      journal: '',
      message_resp_atelier: '',
      IDresolution_qualite: 0,
      IDbonnetier: 0,
      IDmachine: 0,
    }
    const literals = RC_COLUMNS.map((c) => rcLiteral(c, seed[c])).join(', ')

    if (IS_WINDOWS) {
      await query(
        `INSERT INTO retour_client (${RC_COLUMNS.join(', ')}) VALUES (${literals})`,
      )
    } else {
      // Positional: neither `archivé` nor the reserved `DATE` can be named here.
      await query(`INSERT INTO retour_client VALUES (${literals})`)
    }

    res.status(201).json({ IDretour_client: newId })
  } catch (err) {
    console.error('Error creating retour client TRM:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── DELETE /:id ──────────────────────────────────────────

retoursClientTrmRouter.delete('/:id', async (req: Request, res: Response) => {
  if (!(await requireEdit(req, res))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const existing = await readRetour(id)
    if (!existing) { res.status(404).json({ error: 'Retour client not found' }); return }
    // The ETM dossier survives on purpose — deleting the TRM mirror is
    // "this was not for us", not "this complaint never happened".
    await query(`DELETE FROM retour_client WHERE IDretour_client = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting retour client TRM:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Traçabilité ──────────────────────────────────────────
//
// The legacy's orange band: what the complaint is actually about. It walks the
// affectation to the physical rolls, then shows, per roll, who made it
// (evenement_piece), what the visiteuse found on it (defaut_qualite), and the
// two documents that surround it — the order ETM placed with TRM and the avis
// d'expédition TRM shipped it on.
//
//   '1' → stock_ecru.numero = reference                (one roll… or several)
//   '2' → stock_fini.lot = reference → IDstock_ecru    (a whole finished lot)
//
// Both resolve to a LIST: `numero` is not unique, a finished lot holds 15–19
// rolls, and 6 historical references match nothing at all (the legacy's red
// cross next to the field). `resolved: false` is a normal answer, not an error.
//
// No IDsociete filter anywhere: ETM's reception flips a delivered roll from
// société 2 to 1, and every referenced roll is already at 1.

interface TracaEvent {
  IDevenement_piece: number
  date: string | null
  evenement: string
  observation: string
  IDbonnetier: number
  bonnetier: string
}

interface TracaDefaut {
  IDdefaut_qualite: number
  date: string | null
  type_defaut: string
  taille_cm: number
  nombre: number
  description: string
  IDSpotteur: number
  spotteur: string
  /** Bonnetier / Visiteur / Inconnu — legacy Type_Spotteur 1 / 2 / else. */
  role: string
}

interface TracaPiece {
  IDstock_ecru: number
  numero: string
  poids: number
  date_saisie: string | null
  second_choix: 0 | 1
  IDordre_fabrication: number
  metier: string
  events: TracaEvent[]
  defauts: TracaDefaut[]
}

interface TracaDoc {
  kind: 'commande_sst' | 'bon_livraison'
  id: number
  label: string
  sous_titre: string
  date: string | null
}

const EMPTY_TRACA = {
  kind: 'none' as const,
  resolved: false,
  titre: null as string | null,
  sous_titre: null as string | null,
  pieces: [] as TracaPiece[],
  documents: [] as TracaDoc[],
}

const spotteurRole = (t: number): string =>
  t === 1 ? 'Bonnetier' : t === 2 ? 'Visiteur' : 'Inconnu'

/** HFSQL DATETIME → the raw string, or null on empty / zero dates. Kept as
 *  text: the web renders it with the same helper the OF timelines use. */
function datetimeStr(v: unknown): string | null {
  const s = trimStr(v)
  return s === '' || s.startsWith('0000') ? null : s
}

/**
 * Affectation → the physical écru rolls it names. Shared by the Traçabilité tab
 * and the printed sheet, so the two can never disagree about which rolls the
 * complaint is about. Returns [] for an unresolvable reference — 6 historical
 * rows are in that state and it is not an error.
 */
async function resolveEcruRolls(row: RetourRow): Promise<any[]> {
  if (row.reference === '') return []
  const ref = esc(row.reference)
  let ecruWhere: string
  if (row.type_reference === '1') {
    ecruWhere = `numero = '${ref}'`
  } else if (row.type_reference === '2') {
    // stock_fini.lot compares case-insensitively on HFSQL — live data stores
    // 'Ma100602' on the retour and 'MA100602' on the lot.
    const finis = await query<any>(`SELECT IDstock_ecru FROM stock_fini WHERE lot = '${ref}'`)
    const ids = Array.from(new Set((finis as any[]).map((f) => n(f.IDstock_ecru)).filter((x) => x > 0)))
    if (ids.length === 0) return []
    ecruWhere = `IDstock_ecru IN (${ids.join(',')})`
  } else {
    return []
  }
  const rows = await query<any>(
    `SELECT IDstock_ecru, numero, poids, date_saisie, second_choix, IDordre_fabrication,
            IDpiece_production, IDref_ecru, IDcolori_ecru, IDref_commande_source, IDligne_expedition_TRM
     FROM stock_ecru WHERE ${ecruWhere} ORDER BY IDstock_ecru`,
  )
  return rows as any[]
}

retoursClientTrmRouter.get('/:id/tracabilite', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const row = await readRetour(id)
    if (!row) { res.status(404).json({ error: 'Retour client not found' }); return }
    if (row.reference === '' || (row.type_reference !== '1' && row.type_reference !== '2')) {
      res.json(EMPTY_TRACA)
      return
    }

    // ── Resolve the affectation to a set of écru rolls.
    const kind = row.type_reference === '1' ? ('piece' as const) : ('lot_fini' as const)
    const ecrus = await resolveEcruRolls(row)
    if (ecrus.length === 0) { res.json({ ...EMPTY_TRACA, kind }); return }

    const ecruIds = ecrus.map((e) => n(e.IDstock_ecru)).filter((x) => x > 0)
    const pieceProdIds = ecrus.map((e) => n(e.IDpiece_production)).filter((x) => x > 0)
    const ofIds = Array.from(new Set(ecrus.map((e) => n(e.IDordre_fabrication)).filter((x) => x > 0)))
    const refEcruId = n(ecrus[0]?.IDref_ecru)
    const coloriId = n(ecrus[0]?.IDcolori_ecru)

    // ── Everything the rolls hang off, in parallel.
    const [ofRows, refRows, coloRows, eventRows, defautRows] = await Promise.all([
      ofIds.length
        ? query<any>(
            `SELECT IDordre_fabrication, IDmachine FROM ordre_fabrication WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
          )
        : Promise.resolve([] as any[]),
      refEcruId > 0
        ? fixEncoding(
            await query<any>(`SELECT IDref_ecru, reference, designation FROM ref_ecru WHERE IDref_ecru = ${refEcruId}`),
            'ref_ecru', 'IDref_ecru', ['reference', 'designation'],
          )
        : Promise.resolve([] as any[]),
      coloriId > 0
        ? fixEncoding(
            await query<any>(`SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru = ${coloriId}`),
            'colori_ecru', 'IDcolori_ecru', ['reference'],
          )
        : Promise.resolve([] as any[]),
      // The legacy union: an event hangs either off the production piece
      // (tricotage) or off the weighed roll (visitage) — never off both.
      fixEncoding(
        await query<any>(
          `SELECT IDevenement_piece, IDpiece_production, IDstock_ecru, IDbonnetier,
                  DATE AS devt, evenement, observation
           FROM evenement_piece
           WHERE IDstock_ecru IN (${ecruIds.length ? ecruIds.join(',') : 0})
              OR IDpiece_production IN (${pieceProdIds.length ? pieceProdIds.join(',') : 0})
           ORDER BY DATE DESC`,
        ),
        'evenement_piece', 'IDevenement_piece', ['evenement', 'observation'],
      ),
      // defaut_qualite.reference is TEXT holding the stringified IDstock_ecru.
      ecruIds.length
        ? fixEncoding(
            await query<any>(
              `SELECT IDdefaut_qualite, reference, type_defaut, taille_cm, nombre, description,
                      DATE AS ddef, Type_Spotteur, IDSpotteur
               FROM defaut_qualite
               WHERE Type_Reference = 2 AND reference IN (${ecruIds.map((x) => `'${x}'`).join(',')})
               ORDER BY DATE`,
            ),
            'defaut_qualite', 'IDdefaut_qualite', ['type_defaut', 'description'],
          )
        : Promise.resolve([] as any[]),
    ])

    const machineIds = Array.from(new Set((ofRows as any[]).map((o) => n(o.IDmachine)).filter((x) => x > 0)))
    const staffIds = Array.from(
      new Set(
        [
          ...(eventRows as any[]).map((e) => n(e.IDbonnetier)),
          ...(defautRows as any[]).map((d) => n(d.IDSpotteur)),
        ].filter((x) => x > 0),
      ),
    )
    const [machineRows, staff, documents] = await Promise.all([
      machineIds.length
        ? fixEncoding(
            await query<any>(`SELECT IDmachine, nom FROM machine WHERE IDmachine IN (${machineIds.join(',')})`),
            'machine', 'IDmachine', ['nom'],
          )
        : Promise.resolve([] as any[]),
      staffIds.length ? loadBonnetiers(staffIds) : Promise.resolve([]),
      loadTracaDocs(ecrus),
    ])
    const machineName = new Map((machineRows as any[]).map((m) => [n(m.IDmachine), trimStr(m.nom)]))
    const ofMachine = new Map((ofRows as any[]).map((o) => [n(o.IDordre_fabrication), n(o.IDmachine)]))
    const staffName = new Map(staff.map((b) => [b.IDbonnetier, b.nom]))

    // ── Fold events / defects onto their roll.
    const eventsByEcru = new Map<number, TracaEvent[]>()
    const eventsByPiece = new Map<number, TracaEvent[]>()
    for (const e of eventRows as any[]) {
      const ev: TracaEvent = {
        IDevenement_piece: n(e.IDevenement_piece),
        date: datetimeStr(e.devt),
        evenement: trimStr(e.evenement),
        observation: trimStr(e.observation),
        IDbonnetier: n(e.IDbonnetier),
        bonnetier: staffName.get(n(e.IDbonnetier)) ?? '',
      }
      const ecruKey = n(e.IDstock_ecru)
      const pieceKey = n(e.IDpiece_production)
      if (ecruKey > 0) eventsByEcru.set(ecruKey, [...(eventsByEcru.get(ecruKey) ?? []), ev])
      else if (pieceKey > 0) eventsByPiece.set(pieceKey, [...(eventsByPiece.get(pieceKey) ?? []), ev])
    }

    const defautsByEcru = new Map<number, TracaDefaut[]>()
    for (const d of defautRows as any[]) {
      const key = parseInt(trimStr(d.reference), 10)
      if (!Number.isInteger(key)) continue
      const spot = n(d.IDSpotteur)
      defautsByEcru.set(key, [
        ...(defautsByEcru.get(key) ?? []),
        {
          IDdefaut_qualite: n(d.IDdefaut_qualite),
          date: datetimeStr(d.ddef),
          // Historical rows carry doubled spaces ("Autre Barrure  Plus de 3m").
          type_defaut: trimStr(d.type_defaut).replace(/\s+/g, ' '),
          taille_cm: Number(d.taille_cm) || 0,
          nombre: Number(d.nombre) || 0,
          description: trimStr(d.description),
          IDSpotteur: spot,
          spotteur: staffName.get(spot) ?? '',
          role: spotteurRole(n(d.Type_Spotteur)),
        },
      ])
    }

    const pieces: TracaPiece[] = ecrus.map((e) => {
      const ecruId = n(e.IDstock_ecru)
      const pieceId = n(e.IDpiece_production)
      const events = [...(eventsByEcru.get(ecruId) ?? []), ...(eventsByPiece.get(pieceId) ?? [])].sort(
        (a, b) => (b.date ?? '').localeCompare(a.date ?? ''),
      )
      const ofId = n(e.IDordre_fabrication)
      return {
        IDstock_ecru: ecruId,
        numero: trimStr(e.numero),
        poids: Number(e.poids) || 0,
        date_saisie: datetimeStr(e.date_saisie),
        second_choix: n(e.second_choix) === 1 ? 1 : 0,
        IDordre_fabrication: ofId,
        metier: machineName.get(ofMachine.get(ofId) ?? 0) ?? '',
        events,
        defauts: defautsByEcru.get(ecruId) ?? [],
      }
    })

    const refLabel = trimStr((refRows as any[])[0]?.reference)
    const coloLabel = trimStr((coloRows as any[])[0]?.reference)
    res.json({
      kind,
      resolved: true,
      // « 061 - ecru » — exactly the legacy's LIB_Piece_detail.
      titre: [refLabel, coloLabel].filter(Boolean).join(' - ') || row.reference,
      sous_titre: trimStr((refRows as any[])[0]?.designation) || null,
      pieces,
      documents,
    })
  } catch (err) {
    console.error('Error loading retour client TRM traçabilité:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * The legacy TABLE_Docs — two rows, both printable, and both already served by
 * endpoints that exist:
 *   Bon de commande   stock_ecru.IDref_commande_source → ligne_commande_sous_traitant
 *                     → commande_sous_traitant   (the order ETM placed with TRM)
 *                     → GET /commandes-sous-traitant/:id/pdf
 *   Bon de livraison  stock_ecru.IDligne_expedition_TRM → ligne_expedition
 *                     → expedition               (the avis TRM shipped it on)
 *                     → GET /expeditions-trm/:id/pdf
 * A finished lot's rolls almost always share both, hence the dedupe.
 */
async function loadTracaDocs(ecrus: any[]): Promise<TracaDoc[]> {
  const lcsstIds = Array.from(new Set(ecrus.map((e) => n(e.IDref_commande_source)).filter((x) => x > 0)))
  const ligneExpIds = Array.from(new Set(ecrus.map((e) => n(e.IDligne_expedition_TRM)).filter((x) => x > 0)))

  const [lcsstRows, ligneExpRows] = await Promise.all([
    lcsstIds.length
      ? query<any>(
          `SELECT IDligne_commande_sous_traitant, IDcommande_sous_traitant
           FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant IN (${lcsstIds.join(',')})`,
        )
      : Promise.resolve([] as any[]),
    ligneExpIds.length
      ? query<any>(
          `SELECT IDligne_expedition, IDexpedition FROM ligne_expedition WHERE IDligne_expedition IN (${ligneExpIds.join(',')})`,
        )
      : Promise.resolve([] as any[]),
  ])

  const cmdIds = Array.from(
    new Set((lcsstRows as any[]).map((l) => n(l.IDcommande_sous_traitant)).filter((x) => x > 0)),
  )
  const expIds = Array.from(new Set((ligneExpRows as any[]).map((l) => n(l.IDexpedition)).filter((x) => x > 0)))

  const [cmdRows, expRows] = await Promise.all([
    cmdIds.length
      ? query<any>(
          `SELECT IDcommande_sous_traitant, IDsous_traitant, date_commande
           FROM commande_sous_traitant WHERE IDcommande_sous_traitant IN (${cmdIds.join(',')})`,
        )
      : Promise.resolve([] as any[]),
    // `expedition` carries accented columns (envoyé_client / envoyé_sst) that
    // must never be named, and `DATE` is reserved — this ASCII subset is what
    // expeditions-trm.ts reads too.
    expIds.length
      ? query<any>(`SELECT IDexpedition, DATE AS dexp FROM expedition WHERE IDexpedition IN (${expIds.join(',')})`)
      : Promise.resolve([] as any[]),
  ])

  const sstIds = Array.from(new Set((cmdRows as any[]).map((c) => n(c.IDsous_traitant)).filter((x) => x > 0)))
  const sstRows = sstIds.length
    ? await fixEncoding(
        await query<any>(
          `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${sstIds.join(',')})`,
        ),
        'sous_traitant', 'IDsous_traitant', ['nom'],
      )
    : ([] as any[])
  const sstName = new Map((sstRows as any[]).map((s) => [n(s.IDsous_traitant), trimStr(s.nom)]))

  const docs: TracaDoc[] = []
  for (const c of cmdRows as any[]) {
    docs.push({
      kind: 'commande_sst',
      id: n(c.IDcommande_sous_traitant),
      label: 'Bon de commande',
      sous_titre: sstName.get(n(c.IDsous_traitant)) ?? '',
      date: dateDigits8(c.date_commande) || null,
    })
  }
  for (const e of expRows as any[]) {
    docs.push({
      kind: 'bon_livraison',
      id: n(e.IDexpedition),
      label: 'Bon de livraison',
      sous_titre: `Avis N° ${n(e.IDexpedition)}`,
      date: dateDigits8(e.dexp) || null,
    })
  }
  return docs
}

// ── Documents (doc_qualite of the linked ETM dossier) ────
//
// The photos and reports ETM attached to its dossier — where the evidence for
// the complaint actually lives. Nothing keys a doc_qualite on a retour_client,
// so a natively created retour has none by construction.
//
// ⚠️ Windows-only, and not by choice: doc_qualite's PK *and* its dossier FK are
// both accented (IDdoc_qualité, IDdossier_qualité), so the Linux bridge cannot
// scope a query to one dossier and `SELECT *` would drag 87 MB of blobs across
// it. The tab reports `degraded` there rather than claiming the dossier is
// empty — same limitation and same wording as dossiers-qualite.ts. Probe §8
// re-tests it on every run and will tell you when this can be dropped.

retoursClientTrmRouter.get('/:id/documents', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const row = await readRetour(id)
    if (!row) { res.status(404).json({ error: 'Retour client not found' }); return }
    if (row.IDdossier_qualite === 0) { res.json({ documents: [], degraded: false }); return }
    if (!IS_WINDOWS) { res.json({ documents: [], degraded: true }); return }

    const rows = await fixEncoding(
      await query<any>(
        `SELECT IDdoc_qualité, nom FROM doc_qualite WHERE IDdossier_qualité = ${row.IDdossier_qualite} ORDER BY IDdoc_qualité`,
      ),
      'doc_qualite', 'IDdoc_qualité', ['nom'],
    )
    res.json({
      documents: (rows as any[]).map((r) => ({
        IDdoc_qualite: n(readCol(r, 'IDdoc_qualité')),
        nom: trimStr(r.nom),
      })),
      degraded: false,
    })
  } catch (err) {
    console.error('Error listing retour client TRM documents:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// The blob itself. Scoped through the retour's own dossier id so a caller
// cannot read another dossier's evidence by guessing a doc id.
retoursClientTrmRouter.get('/:id/documents/:docId/fichier', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const docId = parseInt(req.params.docId, 10)
    if (isNaN(id) || isNaN(docId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!IS_WINDOWS) { res.status(404).json({ error: 'No file attached' }); return }

    const row = await readRetour(id)
    if (!row || row.IDdossier_qualite === 0) { res.status(404).json({ error: 'Document not found' }); return }

    const rows = (await queryRaw(
      `SELECT fichier FROM doc_qualite WHERE IDdoc_qualité = ${docId} AND IDdossier_qualité = ${row.IDdossier_qualite}`,
    )) as any[]
    if (rows.length === 0) { res.status(404).json({ error: 'Document not found' }); return }

    const fichier = rows[0].fichier
    let buf: Buffer | null = null
    if (Buffer.isBuffer(fichier)) buf = fichier
    else if (fichier instanceof ArrayBuffer) buf = Buffer.from(fichier)
    // An empty BinMemo still passes IS NOT NULL — 404 so the viewer shows its
    // empty state instead of an unreadable zero-byte frame.
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
    console.error('Error serving retour client TRM document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Fiche imprimée ───────────────────────────────────────
//
// The legacy ETAT_Retour_Client sheet, issued by Tricotage Malterre. The
// affected pieces come from the SAME resolver the Traçabilité tab uses, so the
// printed page and the screen can never name different rolls.

function frDate(d: string | null | undefined): string {
  const s = dateDigits8(d)
  return s ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}` : ''
}

/** '2026-01-22 14:04:38.808' → '22/01/2026'. */
function frDateTime(v: unknown): string {
  const s = trimStr(v)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : frDate(s)
}

const AFFECTATION_LABEL: Record<string, string> = {
  '1': 'Pièce',
  '2': 'Lot',
}

export async function buildRetourClientPdfData(id: number): Promise<RetourClientPdfData | null> {
  const row = await readRetour(id)
  if (!row) return null

  const [labels, fncs, ecrus] = await Promise.all([
    loadLabels([row]),
    loadFncSummaries([row.IDdossier_qualite]),
    resolveEcruRolls(row),
  ])
  const fnc = fncs.get(row.IDdossier_qualite)

  const ofIds = Array.from(new Set(ecrus.map((e) => n(e.IDordre_fabrication)).filter((x) => x > 0)))
  const ofRows = ofIds.length
    ? await query<any>(
        `SELECT IDordre_fabrication, IDmachine FROM ordre_fabrication WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
      )
    : ([] as any[])
  const machineIds = Array.from(new Set((ofRows as any[]).map((o) => n(o.IDmachine)).filter((x) => x > 0)))
  const machineRows = machineIds.length
    ? await fixEncoding(
        await query<any>(`SELECT IDmachine, nom FROM machine WHERE IDmachine IN (${machineIds.join(',')})`),
        'machine', 'IDmachine', ['nom'],
      )
    : ([] as any[])
  const machineName = new Map((machineRows as any[]).map((m) => [n(m.IDmachine), trimStr(m.nom)]))
  const ofMachine = new Map((ofRows as any[]).map((o) => [n(o.IDordre_fabrication), n(o.IDmachine)]))

  let clientEtm = ''
  if (fnc && fnc.IDclient > 0) {
    const etmRows = await fixEncoding(
      await query<any>(`SELECT IDclient, nom FROM client WHERE IDclient = ${fnc.IDclient}`),
      'client', 'IDclient', ['nom'],
    )
    clientEtm = trimStr((etmRows as any[])[0]?.nom)
  }

  return {
    numero: row.IDretour_client,
    date: frDate(row.date),
    clientNom: labels.clientNom.get(row.IDclient) ?? '',
    clientEtm,
    defautNom: labels.defautNom.get(row.IDdefaut_textile) || row.defaut_legacy,
    affectationLabel: AFFECTATION_LABEL[row.type_reference] ?? 'Affectation',
    reference: row.reference,
    observationClient: row.message_client,
    observationAtelier: row.message_resp_atelier,
    resolution: labels.resolutionLibelle.get(row.IDresolution_qualite) ?? '',
    reponse: row.reponse,
    impactPrime: row.impact_prime,
    pieces: ecrus.map((e) => {
      const ofId = n(e.IDordre_fabrication)
      return {
        numero: trimStr(e.numero),
        date: frDateTime(e.date_saisie),
        metier: machineName.get(ofMachine.get(ofId) ?? 0) ?? '',
        poids: Number(e.poids) || 0,
        second_choix: n(e.second_choix) === 1,
      }
    }),
    fncNumero: fnc ? fnc.IDdossier_qualite : null,
  }
}

retoursClientTrmRouter.get('/:id/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const data = await buildRetourClientPdfData(id)
    if (!data) { res.status(404).json({ error: 'Retour client not found' }); return }

    const buffer = await renderRetourClientPdfBuffer(data)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="Retour-client-${id}.pdf"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.end(buffer)
  } catch (err) {
    console.error('Error rendering retour client TRM pdf:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Envoi par email (§32) ────────────────────────────────
//
// The legacy IMG_email button mailed the client's contact a one-liner —
// "Le dossier N°%1 a été crée auprès de notre service qualité", signed
// « Ets Malterre - Service Qualité ». That text is a copy-paste from the ETM
// dossier window and makes no sense leaving TRM: the recipient here IS Ets
// Malterre, and the useful thing to send is the sheet with the atelier's
// answer on it. So the button sends the Retour client PDF instead.
//
// Recipient bucketing follows the §32.2 fallback: `contact` has no
// envoi_retour_client flag, so `est_defaut = 1` pre-checks a chip and every
// other valid address becomes a suggestion.
//
// Deliberately NOT logged in `envoi_email`: that ledger is keyed by
// (IDreference, IDtype_doc) and `type_doc` has no "retour client" row. Filing
// it under 2 = « autre » would put a quality sheet in the client's document
// dispatch history next to its invoices. Add a real type_doc first if the
// history ever needs it.

const SENDER_LABEL_TRM = 'Tricotage Malterre'

retoursClientTrmRouter.get('/:id/email-defaults', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const row = await readRetour(id)
    if (!row) { res.status(404).json({ error: 'Retour client not found' }); return }

    const [labels, contactRows] = await Promise.all([
      loadLabels([row]),
      row.IDclient > 0
        ? query<any>(
            `SELECT IDcontact, nom, prenom, mail, est_defaut, est_visible FROM contact WHERE IDclient = ${row.IDclient}`,
          )
        : Promise.resolve([] as any[]),
    ])
    const contacts = await fixEncoding(contactRows as any[], 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])

    const selected: EmailRecipientPayload[] = []
    const suggestions: EmailRecipientPayload[] = []
    const seen = new Set<string>()
    for (const c of contacts as any[]) {
      if (n(c.est_visible) === 0) continue
      const raw = trimStr(c.mail)
      if (!raw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) continue
      const key = raw.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const displayName = [c.prenom, c.nom].map((s: unknown) => trimStr(s)).filter(Boolean).join(' ')
      const recipient: EmailRecipientPayload = { email: raw, source: 'contact', contactId: n(c.IDcontact) }
      if (displayName) recipient.name = displayName
      if (n(c.est_defaut) === 1) selected.push(recipient)
      else suggestions.push(recipient)
    }

    const defaut = labels.defautNom.get(row.IDdefaut_textile) || row.defaut_legacy
    res.json({
      recipients: { selected, suggestions },
      subject: `Retour client N°${id} - ${SENDER_LABEL_TRM}`,
      body:
        `Bonjour,\n\n` +
        `Veuillez trouver ci-joint notre fiche de retour client N°${id}` +
        `${defaut ? ` (${defaut})` : ''}, avec le traitement apporté par l'atelier.\n\n` +
        `Nous restons à votre disposition pour toute information complémentaire.\n\n` +
        `Cordialement,\n` +
        SENDER_LABEL_TRM,
      clientNom: labels.clientNom.get(row.IDclient) ?? '',
      bcc: [],
      optional_attachments: [],
    })
  } catch (err) {
    console.error('Error building retour client TRM email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const rcExtraAttachment = z.object({
  filename: z.string().min(1).max(255),
  content_base64: z.string().min(1),
  content_type: z.string().min(1).max(100),
})
const rcEmailBody = z.object({
  to: z.array(z.string().email()).min(1, 'At least one recipient is required'),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20000),
  attach_pdf: z.boolean().optional(),
  extra_attachments: z.array(rcExtraAttachment).optional(),
  dev_skip_send: z.boolean().optional(),
})
const RC_ALLOW_DEV_SKIP_SEND = process.env.NODE_ENV !== 'production'

retoursClientTrmRouter.post('/:id/email', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const parsed = rcEmailBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }

    if (parsed.data.dev_skip_send === true && RC_ALLOW_DEV_SKIP_SEND) {
      console.log(`[dev-skip-send] retour client TRM #${id} — fake send to ${parsed.data.to.join(', ')}`)
      res.json({ ok: true, messageId: `dev-skip-${Date.now()}` })
      return
    }

    const senderEmail = await getUserEmail(req.userId)
    if (!senderEmail) {
      res.status(400).json({
        error: 'no_sender_email',
        message:
          "Aucune adresse email n'est associée à votre compte. Un administrateur doit en définir une dans Paramètres › Utilisateurs.",
      })
      return
    }
    const userRows = await fixEncoding(
      await query<any>(`SELECT prenom, nom FROM utilisateur WHERE IDutilisateur = ${req.userId}`),
      'utilisateur', 'IDutilisateur', ['prenom', 'nom'],
    )
    const u = (userRows as any[])[0]
    const displayName = u ? [u.prenom, u.nom].map((s: unknown) => trimStr(s)).filter(Boolean).join(' ') : ''
    const fromName = displayName ? `${displayName} - ${SENDER_LABEL_TRM}` : SENDER_LABEL_TRM

    const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
    if (parsed.data.attach_pdf !== false) {
      // Same builder as GET /:id/pdf, so the attachment is byte-identical to
      // what the Imprimer button shows (§32.2).
      const data = await buildRetourClientPdfData(id)
      if (!data) { res.status(404).json({ error: 'Retour client not found' }); return }
      attachments.push({
        filename: `Retour-client-${id}.pdf`,
        content: await renderRetourClientPdfBuffer(data),
        contentType: 'application/pdf',
      })
    }
    for (const a of parsed.data.extra_attachments ?? []) {
      attachments.push({
        filename: a.filename,
        content: Buffer.from(a.content_base64, 'base64'),
        contentType: a.content_type,
      })
    }

    const messageId = await sendMail({
      from: senderEmail,
      fromName,
      to: parsed.data.to,
      cc: parsed.data.cc,
      bcc: parsed.data.bcc,
      subject: parsed.data.subject,
      body: parsed.data.body,
      attachments: attachments.length > 0 ? attachments : undefined,
    })
    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending retour client TRM email:', err)
    res.status(500).json({ error: 'send_failed', message: (err as Error).message })
  }
})
