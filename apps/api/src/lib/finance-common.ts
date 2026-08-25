// ── Finance & chiffre d'affaires — one implementation, two sociétés ────────
//
// `upload_compta` / `compte_compta` (via `id_societe`) and `facture` (via
// `IDsociete`) are partitioned tables whose two halves are the SAME OBJECT: a
// compte de résultat is a compte de résultat, an invoice is an invoice. Same
// columns, same lifecycle, same screens. So this is a ROUTER FACTORY mounted
// twice — the `factures.ts` shape, not the `stock-ecru-trm.ts` one — and the
// two apps can never quote different figures from the same books:
//
//   ETM  routes/rapports.ts       → /api/rapports/finance, /api/rapports/ca-*
//   TRM  routes/rapports-trm.ts   → /api/rapports-trm/finance, .../ca-*
//
// Everything société-dependent lives in `FinanceScope` below — including which
// permission STORE to ask, since TRM's grants live apart from ETM's
// (lib/permissions-trm.ts). Adding a third société is a third scope object.
//
// Extracted verbatim from routes/rapports.ts (2026-08-25) when TRM's tableau
// de bord grew the Charges / Chiffre d'affaires / Analyse financière /
// Évolution du CA widgets. The reverse-engineering notes below are ETM's
// originals and were re-verified against société 2 before the split — see the
// per-section comments for the TRM figures.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { query, fixEncoding } from './hfsql-auto.js'
import { repairAliased } from '../routes/stock-fini.js'
import { n, dateDigits, esc } from './sst-shared.js'
import { userHasPermission } from './permissions.js'
import type { PermissionKey } from './permission-keys.js'
import { trmUserHasPermission } from './permissions-trm.js'
import type { TrmPermissionKey } from './permission-keys-trm.js'
import { isEffectiveAdmin } from './auth.js'

// ── Scope ─────────────────────────────────────────────────────────────────

export interface FinanceScope {
  /** `upload_compta.id_societe` / `compte_compta.id_societe` / `facture.IDsociete`. */
  societe: number
  /** Which permission store answers — ETM's or TRM's. The two are separate
   *  files on purpose, so a key name may legitimately exist in both. */
  hasPermission(userId: number, admin: boolean, key: string): Promise<boolean>
  /** Any ONE of these grants the compte-by-compte balance (`GET /finance`).
   *  A list because the same payload feeds two very different consumers: the
   *  Rapports › Finance screen (`view_rapport_finance`) and the Charges widget.
   *  TRM has no report screen yet, so only the widget key is listed there —
   *  the alternative, a widget gated on a key whose screen does not exist,
   *  puts the card on the dashboard and 403s its data. */
  financeKeys: readonly string[]
  /** Company-level totals for the Analyse financière widget (`/finance/analyse`).
   *  Deliberately NOT one of `financeKeys`: this shows the aggregates, not the
   *  account-by-account balance that names the payroll lines. */
  analyseKey: string
  /** Per-client revenue (`/ca-clients`, `/ca-evolution`, `/ca-mensuel`). */
  caKey: string
  /** Grants the `Description` / `frais_variable` edits on a compte, on top of
   *  `financeKeys`. Empty string = nobody: the mount registers no write route
   *  at all (see `createFinanceRouter`). */
  editComptesKey: string
}

/** ETS Malterre — the ETM app's own books. */
export const FINANCE_SCOPE_ETM: FinanceScope = {
  societe: 1,
  hasPermission: userHasPermission,
  financeKeys: ['view_rapport_finance'] satisfies readonly PermissionKey[],
  analyseKey: 'dashboard_finance' satisfies PermissionKey,
  caKey: 'dashboard_ca' satisfies PermissionKey,
  editComptesKey: 'edit_compte_description' satisfies PermissionKey,
}

/** Tricotage Malterre. Serves both the Charges widget and, since 2026-08-25,
 *  TRM's own Rapports › Finance screen — which is ETM's screen file imported
 *  through the `@etm` alias with `basePath="/rapports-trm/finance"`. Landing it
 *  was exactly the two edits this object was left open for: `view_rapport_finance`
 *  joined `financeKeys`, and `editComptesKey` turned the compte drawer's routes
 *  on. The widget key STAYS in the list — it is an any-of, and dropping it would
 *  silently blank the Charges card for anyone holding only that grant. */
export const FINANCE_SCOPE_TRM: FinanceScope = {
  societe: 2,
  hasPermission: trmUserHasPermission,
  financeKeys: ['view_rapport_finance', 'dashboard_charges'] satisfies readonly TrmPermissionKey[],
  analyseKey: 'dashboard_finance' satisfies TrmPermissionKey,
  caKey: 'dashboard_ca' satisfies TrmPermissionKey,
  editComptesKey: 'edit_compte_description' satisfies TrmPermissionKey,
}

/** True when the user holds ANY of `keys` in this scope's store. Sequential,
 *  not Promise.all: the lists are one small JSON read and the common case is a
 *  single key. */
async function hasAnyPermission(
  scope: FinanceScope,
  req: Request,
  keys: readonly string[],
): Promise<boolean> {
  const admin = isEffectiveAdmin(req)
  for (const key of keys) {
    if (await scope.hasPermission(req.userId as number, admin, key)) return true
  }
  return false
}

const CHUNK = 400

/** Run `fn` over `ids` in CHUNK-sized batches and concatenate the rows.
 *  Returns [] for an empty id list (never emits a `WHERE col IN ()`). */
async function inChunks<T>(ids: number[], fn: (chunk: string) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    if (slice.length === 0) continue
    out.push(...(await fn(slice.join(','))))
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════
// Finance — ports the legacy WinDev "Analyse › Finance" tab.
//
// DATA MODEL (reverse-engineered from the live DB, 2026-07-28)
//
//   upload_compta   One row per accountant balance upload, per société.
//                   `DATE` (YYYYMMDD) + the pre-computed aggregates
//                   produits / charges / frais_fixe / frais_variable /
//                   provisions. Uploads land roughly weekly and each one is
//                   a CUMULATIVE year-to-date balance, not a delta.
//   compte_compta   Chart of accounts, partitioned by `id_societe`.
//                   `numero` (6-digit PCG account), `libelle`,
//                   `frais_variable` (0 = charge fixe, 1 = charge variable)
//                   and `Description` — a free-text annotation the user
//                   maintains ("Salaires Isa, Pierrot, Laetitia, Eloise").
//                   The same `numero` exists once per société.
//   releve_compta   One row per (account, upload date) with debit / credit.
//
// THE RULE (verified to the cent against the legacy screen)
//
//   montant(compte, année) = debit − credit of the releve_compta row at the
//   LAST upload date falling inside that CALENDAR year.
//
//   The "last upload of the year" — not the sum, because balances are
//   cumulative; and not the January upload that closes the prior exercise
//   (2026-01-05 carries the final 2025 figures, yet legacy reports 2025 as
//   of 2025-12-22, its last in-year upload).
//
//   pourcentage = round(montant / montant_precedent × 100), 0 when N-1 is 0.
//
// SCOPE
//
//   • One société at a time — `scope.societe`. Re-verified on société 2
//     (TRM) at 2026-08-25: the class-6 sums reproduce upload_compta's
//     frais_fixe / frais_variable exactly on the 2025 and 2026 anchors
//     (46 633,56 € / 10 562,04 € at 2026-03-23). The 2024 anchor drifts by
//     ~4,5 k€ on both sociétés because `frais_variable` is the compte's
//     CURRENT classification, not the one in force that year — the legacy
//     screen has the same behaviour, so it is not corrected here.
//   • Class-7 accounts (numero >= 700000) are produits, not charges, and are
//     excluded. Proof: summing the class-6 accounts of each frais_variable
//     bucket reproduces upload_compta.frais_fixe / .frais_variable exactly
//     (111 604,54 € / 610 431,35 € at 2026-03-23) — they balance only once
//     the 7xxxxx rows are dropped.
//   • Accounts with no releve row at either reference date are hidden, which
//     is what makes the legacy variable list 15 rows long rather than the 18
//     rows compte_compta holds.
//
// HFSQL discipline: `DATE` is a reserved word but survives in both the
// SELECT list and the WHERE clause (verified); flat set-based queries only
// (4 per request, independent of row count); accent repair is batched via
// repairAliased so empty `Description` values never enter a CONVERT.

/** Accounts at or above this number are produits (PCG class 7), not charges. */
const CLASS_7 = 700000

/** SQL literal for a user-supplied text value. Pure ASCII → quoted literal;
 *  anything with accents → Latin-1 hex literal (the Linux iODBC bridge
 *  corrupts raw multi-byte UTF-8 embedded in a SQL line). */
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

interface UploadRow {
  DATE: string | null
  produits: number | null
  charges: number | null
  frais_fixe: number | null
  frais_variable: number | null
  provisions: number | null
}

interface YearAnchor {
  /** YYYYMMDD of the upload. */
  date: string
  produits: number
  charges: number
  frais_fixe: number
  frais_variable: number
  provisions: number
}

/** Every ETM balance upload, oldest first. The table holds a few dozen rows
 *  (one per weekly upload), so it is cheaper to read it whole and slice in JS
 *  than to run one query per year. */
async function loadUploads(societe: number): Promise<YearAnchor[]> {
  const rows = await query<UploadRow>(
    `SELECT DATE, produits, charges, frais_fixe, frais_variable, provisions
     FROM upload_compta WHERE id_societe = ${societe}`,
  )
  return rows
    .map((r) => ({
      date: dateDigits(r.DATE),
      produits: n(r.produits),
      charges: n(r.charges),
      frais_fixe: n(r.frais_fixe),
      frais_variable: n(r.frais_variable),
      provisions: n(r.provisions),
    }))
    .filter((r) => /^\d{8}$/.test(r.date))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** Last upload of each calendar year for the ETM société, keyed by year. */
async function loadYearAnchors(societe: number): Promise<Map<number, YearAnchor>> {
  const byYear = new Map<number, YearAnchor>()
  // Ascending, so the last write per year is that year's closing anchor.
  for (const r of await loadUploads(societe)) byYear.set(Number(r.date.slice(0, 4)), r)
  return byYear
}

/** debit − credit per account at one upload date. Empty map for a null date. */
async function loadBalanceAt(date: string | null): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (!date || !/^\d{8}$/.test(date)) return out
  const rows = await query<{ IDcompte_compta: number; debit: number | null; credit: number | null }>(
    `SELECT IDcompte_compta, debit, credit FROM releve_compta WHERE DATE = '${date}'`,
  )
  for (const r of rows) {
    const id = n(r.IDcompte_compta)
    if (id <= 0) continue
    out.set(id, n(r.debit) - n(r.credit))
  }
  return out
}

interface CompteRow {
  IDcompte_compta: number
  numero: number | null
  libelle: string | null
  frais_variable: number | null
  description: string | null
}

/** Chart of accounts for ETM, accents repaired, class-7 rows dropped. */
async function loadComptes(societe: number): Promise<CompteRow[]> {
  const rows = await query<CompteRow>(
    `SELECT IDcompte_compta, numero, libelle, frais_variable, Description AS description
     FROM compte_compta WHERE id_societe = ${societe}`,
  )
  const fixed = await repairAliased(
    rows as unknown as Record<string, unknown>[],
    'compte_compta',
    'IDcompte_compta',
    { libelle: 'libelle', description: 'Description' },
  )
  return (fixed as unknown as CompteRow[]).filter((c) => {
    const num = n(c.numero)
    return num > 0 && num < CLASS_7
  })
}

/** round(cur / prev × 100), 0 when there is nothing to compare against. */
function pourcentage(cur: number, prev: number): number {
  if (!prev) return 0
  return Math.round((cur / prev) * 100)
}

// GET /api/rapports/finance?annee=YYYY
//   annee omitted → the most recent year holding an upload.
async function handleFinance(scope: FinanceScope, req: Request, res: Response) {
  try {
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const allowed = await hasAnyPermission(scope, req, scope.financeKeys)
    if (!allowed) {
      res.status(403).json({ error: 'forbidden', message: 'Accès au rapport finance non autorisé.' })
      return
    }

    const anchors = await loadYearAnchors(scope.societe)
    const annees = Array.from(anchors.keys()).sort((a, b) => b - a)
    if (annees.length === 0) {
      res.json({ annees: [], annee: null, annee_precedente: null, lignes: [], totaux: null })
      return
    }

    const asked = Number.parseInt(String(req.query.annee ?? ''), 10)
    const annee = anchors.has(asked) ? asked : annees[0]
    const anneePrec = annee - 1

    const cur = anchors.get(annee)!
    // Strictly N-1: with a gap year the comparison column is simply empty,
    // which is honest — silently comparing against N-2 under a "N-1" header
    // would be worse than showing nothing.
    const prev = anchors.get(anneePrec) ?? null

    const [comptes, balCur, balPrev] = await Promise.all([
      loadComptes(scope.societe),
      loadBalanceAt(cur.date),
      loadBalanceAt(prev?.date ?? null),
    ])

    const lignes = comptes
      // Legacy hides accounts absent from both reference balances.
      .filter((c) => balCur.has(n(c.IDcompte_compta)) || balPrev.has(n(c.IDcompte_compta)))
      .map((c) => {
        const id = n(c.IDcompte_compta)
        const montant = balCur.get(id) ?? 0
        const montantPrec = balPrev.get(id) ?? 0
        return {
          IDcompte_compta: id,
          numero: n(c.numero),
          libelle: (c.libelle ?? '').toString().trim(),
          description: (c.description ?? '').toString().trim(),
          variable: n(c.frais_variable) === 1 ? 1 : 0,
          montant,
          montant_precedent: montantPrec,
          ecart: montant - montantPrec,
          pourcentage: pourcentage(montant, montantPrec),
        }
      })
      .sort((a, b) => a.numero - b.numero)

    res.json({
      annees,
      annee,
      annee_precedente: prev ? anneePrec : null,
      date_arrete: cur.date,
      date_arrete_precedente: prev?.date ?? null,
      totaux: {
        produits: cur.produits,
        charges: cur.charges,
        frais_fixe: cur.frais_fixe,
        frais_variable: cur.frais_variable,
        provisions: cur.provisions,
        produits_precedent: prev?.produits ?? 0,
        charges_precedent: prev?.charges ?? 0,
        frais_fixe_precedent: prev?.frais_fixe ?? 0,
        frais_variable_precedent: prev?.frais_variable ?? 0,
        provisions_precedent: prev?.provisions ?? 0,
      },
      lignes,
    })
  } catch (err) {
    console.error('[rapports/finance]', err)
    res.status(500).json({ error: (err as Error).message })
  }
}

// GET /api/rapports/finance/comptes/:id/historique
//   Year-end value of one account across every year holding an upload.
async function handleCompteHistorique(scope: FinanceScope, req: Request, res: Response) {
  try {
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const allowed = await hasAnyPermission(scope, req, scope.financeKeys)
    if (!allowed) { res.status(403).json({ error: 'forbidden' }); return }

    const id = Number.parseInt(req.params.id, 10)
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return }

    // Same ownership check as the PATCH below: `releve_compta` carries no
    // id_societe of its own, so without this a TRM caller could read an ETM
    // payroll account's year series by guessing its id. Free while ETM was the
    // only mount; load-bearing now that TRM registers this route too.
    const owned = await query<{ IDcompte_compta: number }>(
      `SELECT IDcompte_compta FROM compte_compta
       WHERE IDcompte_compta = ${id} AND id_societe = ${scope.societe}`,
    )
    if (owned.length === 0) { res.status(404).json({ error: 'Compte not found' }); return }

    const anchors = await loadYearAnchors(scope.societe)
    // date → year, so one flat read over the account's own rows folds into
    // the year series without a query per year.
    const yearByDate = new Map<string, number>()
    for (const [year, a] of anchors) yearByDate.set(a.date, year)

    const rows = await query<{ DATE: string | null; debit: number | null; credit: number | null }>(
      `SELECT DATE, debit, credit FROM releve_compta WHERE IDcompte_compta = ${id}`,
    )
    const byYear = new Map<number, number>()
    for (const r of rows) {
      const year = yearByDate.get(dateDigits(r.DATE))
      if (year === undefined) continue
      byYear.set(year, n(r.debit) - n(r.credit))
    }

    res.json(
      Array.from(anchors.keys())
        .sort((a, b) => a - b)
        .map((annee) => ({ annee, montant: byYear.get(annee) ?? 0 })),
    )
  } catch (err) {
    console.error('[rapports/finance/historique]', err)
    res.status(500).json({ error: (err as Error).message })
  }
}

// PATCH /api/rapports/finance/comptes/:id  { description?, variable? }
//   The free-text annotation shown in the "description" column, and the
//   fixe/variable classification (`frais_variable`) that decides which of the
//   two lists the compte belongs to. Both fields are optional — the drawer
//   sends whichever the user changed. Scoped to the ETM société so an id from
//   another partition can't be written.
async function handleComptePatch(scope: FinanceScope, req: Request, res: Response) {
  try {
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const admin = isEffectiveAdmin(req)
    const canView = await hasAnyPermission(scope, req, scope.financeKeys)
    const canEdit = await scope.hasPermission(req.userId, admin, scope.editComptesKey)
    if (!canView || !canEdit) {
      res.status(403).json({ error: 'forbidden', message: 'Modification des comptes non autorisée.' })
      return
    }

    const id = Number.parseInt(req.params.id, 10)
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return }

    const raw = req.body?.description
    if (raw != null && typeof raw !== 'string') {
      res.status(400).json({ error: 'description must be a string' }); return
    }
    // `variable` is the fixe/variable bucket: 1 = charge variable, 0 = charge
    // fixe. Absent means "leave it alone" — a caller editing only the note must
    // not silently reclassify the compte.
    const rawVariable = req.body?.variable
    let variable: 0 | 1 | null = null
    if (rawVariable != null) {
      const v = Number(rawVariable)
      if (v !== 0 && v !== 1) { res.status(400).json({ error: 'variable must be 0 or 1' }); return }
      variable = v as 0 | 1
    }
    if (raw == null && variable === null) { res.status(400).json({ error: 'nothing to update' }); return }

    const owned = await query<{ IDcompte_compta: number }>(
      `SELECT IDcompte_compta FROM compte_compta
       WHERE IDcompte_compta = ${id} AND id_societe = ${scope.societe}`,
    )
    if (owned.length === 0) { res.status(404).json({ error: 'Compte not found' }); return }

    const sets: string[] = []
    if (raw != null) sets.push(`Description = ${sqlText(raw.toString().slice(0, 255))}`)
    if (variable !== null) sets.push(`frais_variable = ${variable}`)
    await query(`UPDATE compte_compta SET ${sets.join(', ')} WHERE IDcompte_compta = ${id}`)

    // HFSQL has no RETURNING — read back so the client hydrates the repaired value.
    const after = await query<{ IDcompte_compta: number; description: string | null; frais_variable: number | null }>(
      `SELECT IDcompte_compta, Description AS description, frais_variable
       FROM compte_compta WHERE IDcompte_compta = ${id}`,
    )
    const fixed = await repairAliased(
      after as unknown as Record<string, unknown>[],
      'compte_compta',
      'IDcompte_compta',
      { description: 'Description' },
    )
    res.json({
      IDcompte_compta: id,
      description: ((fixed[0]?.description ?? '') as string).toString().trim(),
      variable: n(after[0]?.frais_variable) === 1 ? 1 : 0,
    })
  } catch (err) {
    console.error('[rapports/finance PATCH]', err)
    res.status(500).json({ error: (err as Error).message })
  }
}

// ── Analyse financière (tableau de bord) ──────────────────────────────────
// Ports the legacy "Analyse Financière" chart window: the year's cumulative
// curves plus the CA / marge brute / EBE of the day.
//
// Every upload is a CUMULATIVE year-to-date balance, so the month-by-month
// series is simply the LAST upload of each month — never a sum of uploads.
//
// The three figures, from `upload_compta`'s pre-computed buckets:
//
//   CA               = produits
//   marge brute      = produits − frais_variable
//   EBE              = produits − frais_variable − frais_fixe
//
// Verified against the legacy screen (28/07/2026): CA 1 908 171 €,
// marge brute 595 021 € (31,2 % du CA), EBE 97 841 € (5,1 %) — its marge minus
// its EBE is exactly the charges fixes its red area reaches in July. Provisions
// stay out, which is what EBE means (it is struck before dotations).

/** The first upload of a year can be the accountant's closing balance for the
 *  PREVIOUS exercise — 2026-01-05 carries the final 2025 figures. It is dated in
 *  the first days of January and dwarfs the next upload, since a real
 *  year-to-date balance is nearly empty at that point.
 *
 *  Only that one row is dropped. A general "keep the series non-decreasing"
 *  filter would look tempting and would also eat a legitimate dip after an
 *  avoir. */
function dropExerciseClose(rows: YearAnchor[]): YearAnchor[] {
  const [first, second] = rows
  if (!first || !second) return rows
  const earlyJanuary = first.date.slice(4, 8) <= '0115'
  return earlyJanuary && first.produits > second.produits * 2 ? rows.slice(1) : rows
}

// GET /api/rapports/finance/analyse?annee=YYYY
//   annee omitted → the most recent year holding an upload.
async function handleFinanceAnalyse(scope: FinanceScope, req: Request, res: Response) {
  try {
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    // Own permission, not the rapport's: this shows company-level totals, not
    // the account-by-account balance that names the payroll lines.
    const allowed = await scope.hasPermission(req.userId, isEffectiveAdmin(req), scope.analyseKey)
    if (!allowed) {
      res.status(403).json({ error: 'forbidden', message: 'Accès à l\'analyse financière non autorisé.' })
      return
    }

    const uploads = await loadUploads(scope.societe)
    const annees = [...new Set(uploads.map((u) => Number(u.date.slice(0, 4))))].sort((a, b) => b - a)
    if (annees.length === 0) {
      res.json({ annees: [], annee: null, date_arrete: null, points: [], totaux: null })
      return
    }

    const asked = Number.parseInt(String(req.query.annee ?? ''), 10)
    const annee = annees.includes(asked) ? asked : annees[0]

    // Last upload of each month — the cumulative value reached by month's end.
    const byMonth = new Map<number, YearAnchor>()
    for (const u of dropExerciseClose(uploads.filter((u) => u.date.startsWith(String(annee))))) {
      byMonth.set(Number(u.date.slice(4, 6)), u)
    }

    const points = [...byMonth.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([mois, u]) => ({
        mois,
        date: u.date,
        ca: euro(u.produits),
        charges_fixes: euro(u.frais_fixe),
        charges_variables: euro(u.frais_variable),
        marge_brute: euro(u.produits - u.frais_variable),
        ebe: euro(u.produits - u.frais_variable - u.frais_fixe),
      }))

    const last = points[points.length - 1] ?? null
    res.json({
      annees,
      annee,
      date_arrete: last?.date ?? null,
      points,
      totaux: last ? { ca: last.ca, marge_brute: last.marge_brute, ebe: last.ebe } : null,
    })
  } catch (err) {
    console.error('[rapports/finance/analyse]', err)
    res.status(500).json({ error: (err as Error).message })
  }
}

// ── Chiffre d'affaires par client ─────────────────────────────────────────
// Ports the legacy "Comparatif CA" dashboard block and its "Rapport CA/Client"
// monthly detail window (FI_Comparatif_CA.wdw / FEN_Rapport_CA_Client.wdw).
//
// The revenue formula was reverse-engineered from the legacy screen (its
// WinDev queries are PCS-compressed and unreadable) and reproduces its figures
// to the centime on the 2025 and 2026 books:
//
//   CA(client, période) = Σ round2(ligne_facture.quantite × ligne_facture.prix)
//
// over every `facture` with IDsociete = 1 whose DATE falls in the period, with
// `facture.TYPE = 2` (avoir / credit note) counted NEGATIVE. The rounding is
// applied PER LINE — summing the raw floats drifts by a few centimes a year
// and stops matching the legacy totals (2025: 2 684 442,74 € vs 2 684 442,81 €).
//
// HFSQL discipline: `DATE` and `TYPE` are reserved words on `facture` and come
// back uppercased unless aliased; client names are read by a separate flat
// query (no inline CONVERT inside the JOIN — that collapses result sets) and
// repaired with a batched fixEncoding.

/** facture.TYPE for an avoir (credit note) — subtracted from revenue. */
const FACTURE_TYPE_AVOIR = 2

interface CaLineRow {
  idc: number
  t: number
  d: string
  q: number
  p: number
}

/** Per-client revenue for one year: yearly total + the 12 monthly buckets. */
interface CaClientAgg {
  total: number
  months: number[]
}

/** Round a monetary amount to the centime (legacy rounds each invoice line). */
function euro(v: number): number {
  return Math.round(v * 100) / 100
}

/** Sum euro amounts without float drift (accumulates in integer centimes). */
function sumEuros(values: number[]): number {
  return values.reduce((s, v) => s + Math.round(v * 100), 0) / 100
}

/** Aggregate `ligne_facture` revenue per client for one calendar year.
 *
 *  Amounts are accumulated in INTEGER CENTIMES and only converted back to
 *  euros at the end: adding thousands of already-rounded float centimes drifts
 *  by a centime here and there, which is enough to make a monthly bucket
 *  disagree with the legacy report. */
async function caForYear(societe: number, year: number, throughMmdd?: string | null): Promise<Map<number, CaClientAgg>> {
  // `throughMmdd` cuts the year at a day of the year (the "cumul à date"
  // comparison). Dates are YYYYMMDD strings, so the plain string comparison is
  // also a chronological one — including on a 29/02 cutoff against a non-leap
  // year, where it correctly stops at 28/02.
  const end = `${year}${throughMmdd ?? '1231'}`
  const rows = await query<CaLineRow>(
    `SELECT f.IDclient AS idc, f.TYPE AS t, f.DATE AS d, lf.quantite AS q, lf.prix AS p
       FROM facture f
       JOIN ligne_facture lf ON lf.IDfacture = f.IDfacture
      WHERE f.IDsociete = ${societe}
        AND f.DATE >= '${year}0101' AND f.DATE <= '${end}'`,
  )
  const cents = new Map<number, { total: number; months: number[] }>()
  for (const r of rows) {
    const idc = Number(r.idc)
    if (!Number.isInteger(idc) || idc <= 0) continue
    const month = Number(String(r.d ?? '').slice(4, 6)) - 1
    if (month < 0 || month > 11) continue
    let amount = Math.round(n(r.q) * n(r.p) * 100)
    if (Number(r.t) === FACTURE_TYPE_AVOIR) amount = -amount
    let agg = cents.get(idc)
    if (!agg) {
      agg = { total: 0, months: new Array<number>(12).fill(0) }
      cents.set(idc, agg)
    }
    agg.total += amount
    agg.months[month] += amount
  }
  const out = new Map<number, CaClientAgg>()
  for (const [idc, agg] of cents) {
    out.set(idc, { total: agg.total / 100, months: agg.months.map((c) => c / 100) })
  }
  return out
}

/** Every year carrying at least one ETM invoice, most recent first. */
async function caAvailableYears(societe: number): Promise<number[]> {
  const rows = await query<{ mn: string | null; mx: string | null }>(
    `SELECT MIN(DATE) AS mn, MAX(DATE) AS mx FROM facture WHERE IDsociete = ${societe}`,
  )
  const min = Number(String(rows[0]?.mn ?? '').slice(0, 4))
  const max = Number(String(rows[0]?.mx ?? '').slice(0, 4))
  const now = new Date().getFullYear()
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1990 || max < min) return [now]
  const years: number[] = []
  for (let y = Math.max(max, now); y >= min; y--) years.push(y)
  return years
}

/** Resolve client display names for a set of ids (batched + accent-repaired). */
async function caClientNames(ids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  if (ids.length === 0) return map
  const rows = await inChunks(ids, (chunk) =>
    query<{ IDclient: number; nom: string | null }>(
      `SELECT IDclient, nom FROM client WHERE IDclient IN (${chunk})`,
    ),
  )
  const fixed = await fixEncoding(rows, 'client', 'IDclient', ['nom'])
  for (const r of fixed) map.set(Number(r.IDclient), (r.nom ?? '').trim())
  return map
}

/** Parse + clamp the `year` query param, defaulting to the current year. */
function parseYear(raw: unknown): number {
  const y = parseInt(String(raw ?? ''), 10)
  const now = new Date().getFullYear()
  if (!Number.isInteger(y) || y < 1990 || y > now + 5) return now
  return y
}

/** Today's `MMDD` — the cutoff both years share in "cumul à date" mode. */
function todayMmdd(): string {
  const now = new Date()
  return `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
}

/** Guard both CA endpoints behind `dashboard_ca` — revenue per client is the
 *  most sensitive data the app exposes, so the API refuses it outright rather
 *  than relying on the widget being hidden. */
async function requireCaPermission(scope: FinanceScope, req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const allowed = await scope.hasPermission(req.userId, isEffectiveAdmin(req), scope.caKey)
  if (!allowed) {
    res.status(403).json({ error: `permission denied: ${scope.caKey}` })
    return false
  }
  return true
}

// GET /api/rapports/ca-clients?year=YYYY&period=full|ytd
// Comparatif CA: every client ranked by revenue for `year`, carrying the
// previous year's revenue and rank so the UI can show the rank delta.
//
// `period=ytd` cuts BOTH years at today's day of the year, so a partial current
// year is compared against the same partial previous year instead of a full one
// (the default `full` keeps the legacy whole-year comparison).
async function handleCaClients(scope: FinanceScope, req: Request, res: Response) {
  if (!(await requireCaPermission(scope, req, res))) return
  try {
    const year = parseYear(req.query.year)
    const prevYear = year - 1
    const period = req.query.period === 'ytd' ? 'ytd' : 'full'
    const through = period === 'ytd' ? todayMmdd() : null
    const [years, cur, prev] = await Promise.all([
      caAvailableYears(scope.societe),
      caForYear(scope.societe, year, through),
      caForYear(scope.societe, prevYear, through),
    ])

    const ids = [...new Set([...cur.keys(), ...prev.keys()])]
    const names = await caClientNames(ids)

    // Previous-year ranking is computed over the clients that actually billed
    // something that year — a client with no CA has no rank, not rank #last.
    const prevRank = new Map<number, number>()
    ;[...prev.entries()]
      .filter(([, a]) => a.total !== 0)
      .sort((a, b) => b[1].total - a[1].total)
      .forEach(([idc], i) => prevRank.set(idc, i + 1))

    const rows = ids
      .map((idc) => ({
        IDclient: idc,
        nom: names.get(idc) || `#${idc}`,
        ca: cur.get(idc)?.total ?? 0,
        ca_prev: prev.get(idc)?.total ?? 0,
      }))
      .filter((r) => r.ca !== 0 || r.ca_prev !== 0)
      // Secondary sort on the previous year keeps the clients with no CA this
      // year ordered by what they billed last year instead of alphabetically.
      .sort(
        (a, b) => b.ca - a.ca || b.ca_prev - a.ca_prev || a.nom.localeCompare(b.nom, 'fr'),
      )
      .map((r, i) => ({ ...r, rang: i + 1, rang_prev: prevRank.get(r.IDclient) ?? null }))

    res.json({
      year,
      previous_year: prevYear,
      period,
      through,
      years,
      rows,
      total: sumEuros(rows.map((r) => r.ca)),
      total_prev: sumEuros(rows.map((r) => r.ca_prev)),
    })
  } catch (err) {
    console.error('[rapports/ca-clients]', err)
    res.status(500).json({ error: (err as Error).message })
  }
}

// GET /api/rapports/ca-evolution?years=N
// CA per month for the last N calendar years — one series per year, for the
// "Évolution du CA" widget's monthly lines and annual bars.
//
// A dedicated endpoint rather than N calls to /ca-mensuel: that one returns the
// full per-client matrix (one row per client per year), and the widget needs
// only the twelve monthly totals. Same `caForYear` aggregation underneath, so
// the figures agree with the CA table to the centime.
const CA_EVOLUTION_MAX_YEARS = 10
const CA_EVOLUTION_DEFAULT_YEARS = 5

async function handleCaEvolution(scope: FinanceScope, req: Request, res: Response) {
  if (!(await requireCaPermission(scope, req, res))) return
  try {
    const asked = parseInt(String(req.query.years ?? ''), 10)
    const wanted = Number.isInteger(asked) && asked > 0
      ? Math.min(asked, CA_EVOLUTION_MAX_YEARS)
      : CA_EVOLUTION_DEFAULT_YEARS

    // Sort explicitly rather than trusting the helper's order — it happens to
    // count DOWN from the newest year, and assuming ascending silently served
    // the five OLDEST years instead of the five most recent.
    const available = [...(await caAvailableYears(scope.societe))].sort((a, b) => b - a)
    const years = available.slice(0, wanted).sort((a, b) => a - b)

    // Sequential, not Promise.all: each year is a full-year scan of `facture`
    // against the shared HFSQL server, and firing five at once is exactly the
    // kind of burst that makes the bridge unhappy for everyone.
    const nowYear = new Date().getFullYear()
    const series: { year: number; months: (number | null)[]; total: number }[] = []
    for (const year of years) {
      const agg = await caForYear(scope.societe, year)
      const months: (number | null)[] = Array.from({ length: 12 }, (_, i) =>
        sumEuros([...agg.values()].map((a) => a.months[i])),
      )
      const total = sumEuros(months.map((m) => m ?? 0))

      // For the CURRENT year, months after the last invoiced one are UNKNOWN,
      // not zero — emitting 0 would draw the line crashing to the axis for the
      // rest of the calendar. Past years keep their real zeros: a month with no
      // invoices genuinely earned nothing, and 2020's empty first nine months
      // are a fact worth seeing.
      if (year === nowYear) {
        let last = -1
        for (let i = 0; i < 12; i++) if ((months[i] ?? 0) !== 0) last = i
        for (let i = last + 1; i < 12; i++) months[i] = null
      }

      series.push({ year, months, total })
    }

    res.json({ years, series })
  } catch (err) {
    console.error('[rapports/ca-evolution]', err)
    res.status(500).json({ error: (err as Error).message })
  }
}

// GET /api/rapports/ca-mensuel?year=YYYY
// Monthly CA matrix — the legacy "Rapport CA/Client" window: one row per
// client, one column per month, plus per-month and grand totals.
async function handleCaMensuel(scope: FinanceScope, req: Request, res: Response) {
  if (!(await requireCaPermission(scope, req, res))) return
  try {
    const year = parseYear(req.query.year)
    const [years, cur] = await Promise.all([caAvailableYears(scope.societe), caForYear(scope.societe, year)])
    const names = await caClientNames([...cur.keys()])

    const rows = [...cur.entries()]
      .map(([idc, agg]) => ({
        IDclient: idc,
        nom: names.get(idc) || `#${idc}`,
        months: agg.months,
        total: agg.total,
      }))
      .filter((r) => r.total !== 0 || r.months.some((m) => m !== 0))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))

    const monthlyTotals = Array.from({ length: 12 }, (_, i) =>
      sumEuros(rows.map((r) => r.months[i])),
    )

    res.json({
      year,
      years,
      rows,
      monthly_totals: monthlyTotals,
      total: sumEuros(rows.map((r) => r.total)),
    })
  } catch (err) {
    console.error('[rapports/ca-mensuel]', err)
    res.status(500).json({ error: (err as Error).message })
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

/** The finance + CA routes for one société. Mounted on ETM's `rapportsRouter`
 *  (so its URLs stay `/api/rapports/...`) and at `/api/rapports-trm`. */
export function createFinanceRouter(scope: FinanceScope): RouterType {
  const router: RouterType = Router()

  router.get('/finance', (req, res) => handleFinance(scope, req, res))
  router.get('/finance/analyse', (req, res) => handleFinanceAnalyse(scope, req, res))
  router.get('/ca-clients', (req, res) => handleCaClients(scope, req, res))
  router.get('/ca-evolution', (req, res) => handleCaEvolution(scope, req, res))
  router.get('/ca-mensuel', (req, res) => handleCaMensuel(scope, req, res))

  // The compte drawer of the Rapports › Finance screen. Not registered at all
  // when the scope has no edit key: a 404 is the honest answer for a mount
  // whose app has no such screen, where a 403 would suggest "ask an admin".
  if (scope.editComptesKey) {
    router.get('/finance/comptes/:id/historique', (req, res) => handleCompteHistorique(scope, req, res))
    router.patch('/finance/comptes/:id', (req, res) => handleComptePatch(scope, req, res))
  }

  return router
}
