// Paramètres › Outils › Import de la balance Sage — one implementation, two
// sociétés. `upload_compta` / `compte_compta` are partitioned by `id_societe`
// and both halves are the same object, so this is a router factory mounted
// twice (the `createFinanceRouter` shape):
//
//   ETM  /api/outils/import-sage       société 1
//   TRM  /api/outils-trm/import-sage   société 2
//
// Rules, legacy recovery and the replay proof live in lib/import-sage.ts.
//
//   GET    /                 history of the société's imports, newest first
//   POST   /analyse          { nom, contenu_base64 } → what the import WOULD
//                            write; writes nothing
//   POST   /                 same body → the import itself
//   GET    /:id/fichier      the stored export, as Sage wrote it
//   DELETE /:id              undo the société's LATEST import
//
// Every route is gated by `import_compta_sage` in the app's own permission
// store — reads included: the balance names payroll accounts.
//
// HFSQL: no transactions. The header row (`upload_compta`) is written LAST
// and is what every reader keys on, so an import that dies half-way leaves
// only `releve_compta` rows nobody reads; the next attempt clears them before
// writing (`purgerReleves`), so a retry is safe.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, queryRaw } from '../lib/hfsql-auto.js'
import { dateDigits, esc, n } from '../lib/sst-shared.js'
import {
  ETM_PERMISSIONS,
  TRM_PERMISSIONS,
  requirePermission,
  type PermissionScope,
} from '../lib/clients-common.js'
import {
  EMPREINTE_NB_FICHIERS,
  aujourdhuiHfsql,
  comptesEnDouble,
  decodeBalance,
  parseBalanceSage,
  totauxBalance,
  verifierSociete,
  type BalanceSage,
  type LigneIgnoree,
  type TotauxBalance,
  type VerdictSociete,
} from '../lib/import-sage.js'
import { NUMERO_VARIATION_STOCK } from '../lib/variation-stock.js'

// ── Scope ────────────────────────────────────────────────────────────────

export interface ImportSageScope {
  /** `upload_compta.id_societe` / `compte_compta.id_societe`. */
  societe: number
  /** The company a misplaced file would come from (`verifierSociete`). */
  autreSociete: number
  /** Short names used in messages. */
  nom: string
  nomAutre: string
  /** Which app's permission store answers. */
  permissions: PermissionScope
  /** Accounts that must get a releve row at every import even when the file
   *  does not carry them (a 0 / 0 row). ETM: 603700, which the legacy stock
   *  step wrote at 0 € every week and which the finance screens need present
   *  for the variation-de-stock estimate to show (`variation-stock.ts` —
   *  `finance-common.ts` only estimates an account it can see). */
  comptesToujoursReleves: readonly number[]
}

export const IMPORT_SAGE_SCOPE_ETM: ImportSageScope = {
  societe: 1,
  autreSociete: 2,
  nom: 'ETS Malterre',
  nomAutre: 'Tricotage Malterre',
  permissions: ETM_PERMISSIONS,
  comptesToujoursReleves: [NUMERO_VARIATION_STOCK],
}

export const IMPORT_SAGE_SCOPE_TRM: ImportSageScope = {
  societe: 2,
  autreSociete: 1,
  nom: 'Tricotage Malterre',
  nomAutre: 'ETS Malterre',
  permissions: TRM_PERMISSIONS,
  comptesToujoursReleves: [],
}

const PERMISSION = 'import_compta_sage'

// ── Reads ────────────────────────────────────────────────────────────────

interface UploadRow {
  IDupload_compta: number
  DATE: string | null
  charges: number | null
  produits: number | null
  frais_fixe: number | null
  frais_variable: number | null
}

export interface ImportSageHistorique {
  IDupload_compta: number
  /** YYYYMMDD */
  date: string
  charges: number
  produits: number
  frais_fixe: number
  frais_variable: number
}

async function loadHistorique(societe: number): Promise<ImportSageHistorique[]> {
  const rows = await query<UploadRow>(
    `SELECT IDupload_compta, DATE, charges, produits, frais_fixe, frais_variable
     FROM upload_compta WHERE id_societe = ${societe}`,
  )
  return rows
    .map((r) => ({
      IDupload_compta: n(r.IDupload_compta),
      date: dateDigits(r.DATE),
      charges: n(r.charges),
      produits: n(r.produits),
      frais_fixe: n(r.frais_fixe),
      frais_variable: n(r.frais_variable),
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.IDupload_compta - a.IDupload_compta)
}

/** The stored export of one upload, or null when it has none. Single-row
 *  shape on purpose: `fichier` is a binary memo (Windows driver returns 0 rows
 *  on wider shapes, and `LENGTH()` on it answers 0 — hfsql_odbc.md). */
async function loadFichier(id: number, societe: number): Promise<Buffer | null> {
  const rows = (await queryRaw(
    `SELECT fichier FROM upload_compta WHERE IDupload_compta = ${id} AND id_societe = ${societe}`,
  )) as Array<{ fichier: unknown }>
  const f = rows[0]?.fichier
  let buf: Buffer | null = null
  if (f instanceof ArrayBuffer) buf = Buffer.from(f)
  else if (Buffer.isBuffer(f)) buf = f
  if (!buf || buf.length === 0 || (buf.length === 1 && buf[0] === 0)) return null
  return buf
}

/** `compte \t libellé` pairs of the société's last few exports. */
async function empreinteSociete(societe: number): Promise<Set<string>> {
  const recents = (await loadHistorique(societe)).slice(0, EMPREINTE_NB_FICHIERS)
  const out = new Set<string>()
  for (const u of recents) {
    const buf = await loadFichier(u.IDupload_compta, societe)
    if (!buf) continue
    for (const k of parseBalanceSage(decodeBalance(buf)).empreinte) out.add(k)
  }
  return out
}

async function loadComptes(societe: number): Promise<Map<number, { id: number; variable: boolean }>> {
  const rows = await query<{ IDcompte_compta: number; numero: number; frais_variable: number }>(
    `SELECT IDcompte_compta, numero, frais_variable FROM compte_compta WHERE id_societe = ${societe}`,
  )
  const out = new Map<number, { id: number; variable: boolean }>()
  for (const r of rows) out.set(n(r.numero), { id: n(r.IDcompte_compta), variable: n(r.frais_variable) === 1 })
  return out
}

// ── Analysis (shared by the preview and the import) ─────────────────────

export interface ImportSageAnalyse {
  date: string
  nbLignesFichier: number
  nbComptes: number
  totaux: TotauxBalance
  nouveauxComptes: Array<{ numero: number; libelle: string }>
  ignorees: LigneIgnoree[]
  societe: VerdictSociete & { nom: string; nomAutre: string }
  /** Blocking reasons, in French. Empty = the import may run. */
  blocages: Array<{ code: string; message: string }>
}

async function analyser(scope: ImportSageScope, balance: BalanceSage): Promise<ImportSageAnalyse> {
  const date = aujourdhuiHfsql()
  const [comptes, historique, refCible, refAutre] = await Promise.all([
    loadComptes(scope.societe),
    loadHistorique(scope.societe),
    empreinteSociete(scope.societe),
    empreinteSociete(scope.autreSociete),
  ])

  const verdict = verifierSociete(balance.empreinte, refCible, refAutre)
  const blocages: ImportSageAnalyse['blocages'] = []
  if (balance.lignes.length === 0) {
    blocages.push({
      code: 'fichier_invalide',
      message: 'Aucun compte de charges (6) ni de produits (7) lisible : ce fichier n’est pas une balance exportée de Sage.',
    })
  }
  const doubles = comptesEnDouble(balance.lignes)
  if (doubles.length > 0) {
    blocages.push({
      code: 'comptes_en_double',
      message: `Le fichier contient plusieurs fois le compte ${doubles.join(', ')}.`,
    })
  }
  // Nothing to attribute when nothing was read — `fichier_invalide` says it.
  if (!verdict.ok && balance.lignes.length > 0) {
    blocages.push({
      code: 'mauvaise_societe',
      message: `Ce fichier ressemble à une balance de ${scope.nomAutre}, pas de ${scope.nom}. Rien n’a été importé.`,
    })
  }
  if (historique.some((u) => u.date === date)) {
    blocages.push({
      code: 'deja_importe',
      message: 'Une balance a déjà été importée aujourd’hui. Supprimez-la d’abord pour la remplacer.',
    })
  }

  return {
    date,
    nbLignesFichier: balance.nbLignesFichier,
    nbComptes: balance.lignes.length,
    totaux: totauxBalance(balance.lignes, (num) => comptes.get(num)?.variable ?? false),
    nouveauxComptes: balance.lignes
      .filter((l) => !comptes.has(l.numero))
      .map((l) => ({ numero: l.numero, libelle: l.libelle })),
    ignorees: balance.ignorees,
    societe: { ...verdict, nom: scope.nom, nomAutre: scope.nomAutre },
    blocages,
  }
}

// ── Writes ───────────────────────────────────────────────────────────────

/** Anything with accents → Latin-1 hex literal (the Linux bridge corrupts raw
 *  multi-byte UTF-8 in a SQL line); plain ASCII stays a quoted literal. */
function sqlText(value: string): string {
  if (value === '') return "''"
  if (/^[\x20-\x7E]*$/.test(value)) return `'${esc(value)}'`
  const bytes = Buffer.from(Array.from(value, (ch) => {
    const c = ch.codePointAt(0) ?? 0x3f
    return c <= 0xff ? c : 0x3f
  }))
  return `x'${bytes.toString('hex')}'`
}

/** Remove the société's releve rows at `date` (a retry after a failed import,
 *  or the undo). `releve_compta` has no société column: scope by account. */
async function purgerReleves(societe: number, date: string): Promise<void> {
  const ids = [...(await loadComptes(societe)).values()].map((c) => c.id)
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    await query(`DELETE FROM releve_compta WHERE DATE = '${date}' AND IDcompte_compta IN (${chunk.join(',')})`)
  }
}

async function importer(
  scope: ImportSageScope,
  balance: BalanceSage,
  fichier: Buffer,
  date: string,
): Promise<number> {
  // 1. Accounts seen for the first time, created as the legacy did (fixe).
  let comptes = await loadComptes(scope.societe)
  for (const l of balance.lignes) {
    if (comptes.has(l.numero)) continue
    await query(
      `INSERT INTO compte_compta (libelle, numero, frais_variable, id_societe)
       VALUES (${sqlText(l.libelle)}, ${l.numero}, 0, ${scope.societe})`,
    )
    comptes.set(l.numero, { id: 0, variable: false })
  }
  comptes = await loadComptes(scope.societe)

  // 2. The balance, one row per account.
  await purgerReleves(scope.societe, date)
  const releves = balance.lignes.map((l) => ({ numero: l.numero, debit: l.debit, credit: l.credit }))
  for (const numero of scope.comptesToujoursReleves) {
    if (!releves.some((r) => r.numero === numero)) releves.push({ numero, debit: 0, credit: 0 })
  }
  for (const r of releves) {
    const compte = comptes.get(r.numero)
    if (!compte) continue // an always-releve account the société's chart lacks
    await query(
      `INSERT INTO releve_compta (IDcompte_compta, DATE, debit, credit)
       VALUES (${compte.id}, '${date}', ${r.debit}, ${r.credit})`,
    )
  }

  // 3. The header last — it is what makes the import visible.
  const t = totauxBalance(balance.lignes, (num) => comptes.get(num)?.variable ?? false)
  await query(
    `INSERT INTO upload_compta (id_societe, DATE, charges, produits, frais_fixe, frais_variable, provisions)
     VALUES (${scope.societe}, '${date}', ${t.charges}, ${t.produits}, ${t.frais_fixe}, ${t.frais_variable}, ${t.provisions})`,
  )
  const created = await query<{ id: number }>(
    `SELECT MAX(IDupload_compta) AS id FROM upload_compta WHERE id_societe = ${scope.societe} AND DATE = '${date}'`,
  )
  const id = n(created[0]?.id)
  if (id > 0) {
    await queryRaw(`UPDATE upload_compta SET fichier = x'${fichier.toString('hex')}' WHERE IDupload_compta = ${id}`)
  }
  return id
}

// ── Routes ───────────────────────────────────────────────────────────────

const bodySchema = z.object({
  nom: z.string().max(260).optional(),
  contenu_base64: z.string().min(1),
})

/** Largest export seen is ~9 KB; 2 MB leaves room without letting a wrong
 *  pick (a PDF, a photo) through to the parser. */
const MAX_FICHIER = 2 * 1024 * 1024

function readFichier(req: Request, res: Response): Buffer | null {
  const parsed = bodySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', message: 'Aucun fichier reçu.' })
    return null
  }
  const buf = Buffer.from(parsed.data.contenu_base64, 'base64')
  if (buf.length === 0 || buf.length > MAX_FICHIER) {
    res.status(400).json({
      error: 'fichier_invalide',
      message: 'Ce fichier est vide ou trop volumineux pour être une balance Sage.',
    })
    return null
  }
  return buf
}

export function createImportSageRouter(scope: ImportSageScope): RouterType {
  const router: RouterType = Router()
  const allowed = (req: Request, res: Response) => requirePermission(req, res, PERMISSION, scope.permissions)

  router.get('/', async (req, res) => {
    try {
      if (!(await allowed(req, res))) return
      res.json(await loadHistorique(scope.societe))
    } catch (err) {
      console.error('[import-sage] historique', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/analyse', async (req, res) => {
    try {
      if (!(await allowed(req, res))) return
      const buf = readFichier(req, res)
      if (!buf) return
      res.json(await analyser(scope, parseBalanceSage(decodeBalance(buf))))
    } catch (err) {
      console.error('[import-sage] analyse', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/', async (req, res) => {
    try {
      if (!(await allowed(req, res))) return
      const buf = readFichier(req, res)
      if (!buf) return
      const balance = parseBalanceSage(decodeBalance(buf))
      // Re-checked here, never trusted from the preview: the file, the day or
      // the other company's history may have changed since.
      const analyse = await analyser(scope, balance)
      if (analyse.blocages.length > 0) {
        const b = analyse.blocages[0]
        res.status(409).json({ error: b.code, message: b.message })
        return
      }
      const id = await importer(scope, balance, buf, analyse.date)
      console.log(`[import-sage] société ${scope.societe}: upload ${id} (${analyse.date}, ${analyse.nbComptes} comptes) by user ${req.userId}`)
      res.status(201).json({ IDupload_compta: id, date: analyse.date, totaux: analyse.totaux })
    } catch (err) {
      console.error('[import-sage] import', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/:id/fichier', async (req, res) => {
    try {
      if (!(await allowed(req, res))) return
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'Invalid id' }); return }
      const upload = (await loadHistorique(scope.societe)).find((u) => u.IDupload_compta === id)
      if (!upload) { res.status(404).json({ error: 'Import introuvable' }); return }
      const buf = await loadFichier(id, scope.societe)
      if (!buf) { res.status(404).json({ error: 'Aucun fichier conservé pour cet import' }); return }
      res.setHeader('Content-Type', 'text/plain; charset=windows-1252')
      res.setHeader('Content-Disposition', `attachment; filename="balance-sage-${scope.societe === 1 ? 'etm' : 'trm'}-${upload.date}.txt"`)
      res.end(buf)
    } catch (err) {
      console.error('[import-sage] fichier', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.delete('/:id', async (req, res) => {
    try {
      if (!(await allowed(req, res))) return
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'Invalid id' }); return }
      const historique = await loadHistorique(scope.societe)
      const upload = historique.find((u) => u.IDupload_compta === id)
      if (!upload) { res.status(404).json({ error: 'Import introuvable' }); return }
      // Only the latest: an older snapshot is history the finance screens read
      // (year anchors), and the use case is "I just imported the wrong file".
      if (historique[0]?.IDupload_compta !== id) {
        res.status(409).json({
          error: 'pas_le_dernier',
          message: 'Seul le dernier import peut être supprimé.',
        })
        return
      }
      // Header first: once it is gone, no reader sees the date, whatever
      // happens to the releve rows next.
      await query(`DELETE FROM upload_compta WHERE IDupload_compta = ${id} AND id_societe = ${scope.societe}`)
      const autreLeMemeJour = historique.some((u) => u.IDupload_compta !== id && u.date === upload.date)
      if (!autreLeMemeJour) await purgerReleves(scope.societe, upload.date)
      console.log(`[import-sage] société ${scope.societe}: upload ${id} (${upload.date}) deleted by user ${req.userId}`)
      res.json({ ok: true })
    } catch (err) {
      console.error('[import-sage] suppression', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}

export const importSageRouter: RouterType = createImportSageRouter(IMPORT_SAGE_SCOPE_ETM)
export const importSageTrmRouter: RouterType = createImportSageRouter(IMPORT_SAGE_SCOPE_TRM)
