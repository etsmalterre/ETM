// Atelier > Maintenance — TRM knitting-machine upkeep (legacy FI_Maintenance.wdw).
//
// Like the ordre_fabrication family, `machine` and `operation_maintenance` have
// NO IDsociete column: the knitting machines ARE Tricotage Malterre. There is
// nothing to scope, and nothing here is shared with an ETM screen.
//
// ── How the legacy spec was recovered ──────────────────────────────────────
// FI_Maintenance.wdw is PCS-compressed and, unlike FI_Prime, has no generated
// Android twin. The spec came out of WinDev's COMPILE CACHE instead:
//   C:\Mes Projets\MPS\MPS.cpl\<user>\00000000\FI_Maintenance.4C33DFB6.wdw.{wcw,wbw}
// There, string literals / identifiers / real literals survive but INTEGER
// literals and function names do not — so every threshold below was solved from
// live data against a screenshot, never read from the code. See §Constants.
//
// ── Column map (screen field → machine column) ─────────────────────────────
//   Description                 → commentaire       ⚠️ NOT `nom` (2E: nom='2E',
//                                                      commentaire='Terrot')
//   Simple / Double Fonture     → double_fonture
//   Rouloir · Dernière visite   → date_maintenance
//   Rouloir · Commentaire       → observation_maintenace   (typo is the real name)
//   Nettoyage des platines      → nett_platines  / comm_nett_platines
//   Nettoyage du cylindre       → nett_cylindre  / comm_nett_cylindre
//   Nettoyage du plateau        → nett_plateau   / comm_nett_plateau
//   Changement des aiguilles    → chg_aiguilles  / comm_chg_aiguilles
//   Changement des platines     → chg_platines   / comm_chg_platines
//   Pulsoniques                 → pulsonique     / comm_pulsonque  (typo too)
//
// ── HFSQL rules that apply here ────────────────────────────────────────────
//  - `machine` carries THREE accented columns — `connecté`, `archivé`,
//    `diamètre`. They are never named in SQL (the Linux bridge rejects accented
//    identifiers): reads go through SELECT * + key folding (queryB64Text on
//    Linux, fixEncoding on Windows), and `archivé` is filtered in JS.
//    SELECT * is safe on Windows here because `machine` holds no memo-binary
//    column — unlike stock_fil / client, where it silently returns zero rows.
//  - Every column this router WRITES is pure ASCII, so a plain named UPDATE is
//    legal. No delete + positional reinsert (the setClientFlag dance) needed.
//  - The write statement names ONLY the maintenance columns. `nom`, `Jauge`,
//    `diamètre`, `nb_chutes*`, `vitesse`, `elasthanne`, `adresse_automate`,
//    `connecté`, `archivé`, `IDDernier_evenement` belong to
//    FEN_Gestion_des_machines (not ported) — unnamed keeps the stored value,
//    named would zero it.
//  - `operation_maintenance` is all-ASCII with no reserved word
//    (`date_derniere`, not `date`) → plain named UPDATE.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, queryB64Text, fixEncoding } from '../lib/hfsql-auto.js'
import { esc, n } from '../lib/sst-shared.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { trmUserHasPermission } from '../lib/permissions-trm.js'

export const maintenanceTrmRouter: RouterType = Router()

const IS_WINDOWS = process.platform === 'win32'

// ════════════════════════════════════════════════════════
//  Constants — recovered from live data, NOT from the code
// ════════════════════════════════════════════════════════

/**
 * Kg of finished production after which a métier's rouloir needs its next
 * visit. The legacy `PoidsRestantRouloir` procedure survives in the compile
 * cache as SQL, but its threshold is an integer literal and integer literals do
 * NOT survive:
 *
 *   SELECT SUM(ordre_fabrication.quantite) AS total FROM ordre_fabrication
 *   WHERE est_termine = 1 AND IDmachine = {pIDMachine}
 *     AND date_creation > {pDate}
 *
 * 15 000 was solved by reconstructing the fourteen "Rouloir dans N Kgs" values
 * legible on a 2026-08-26 screenshot of the legacy window — all fourteen come
 * back to the exact displayed integer (worst delta 0 Kg). The reconciliation is
 * replayed by `src/scripts/probe-maintenance-trm.ts`, which is what makes this
 * a measurement rather than a guess.
 *
 * ⚠️ This is a module constant and applies to EVERY métier and every past
 * visit: changing it silently rewrites the whole screen's history, the same
 * class of caveat as the Prime barème rates.
 */
export const MAINTENANCE_ROULOIR_SEUIL_KG = 15_000

/**
 * Attention thresholds for the list liseré, as a fraction of the seuil.
 *
 * Recovered by grouping the 30 cards of the same screenshot by tag colour:
 *   red    ⇔ restant = 0        ⇔ produit ≥ 15 000  (2E, 3G, 3J)
 *   orange ⇔ 610 … 4 650 restant ⇔ produit ≥ 10 000  (3H, 3K, 3F, 2J, 1J, 1G)
 *   green  ⇔ ≥ 5 170 restant     ⇔ produit < 10 000  (3I, 2F, 2D, 2H, 2I, …)
 *
 * That reproduces the screenshot 30/30, but note the orange/green boundary is
 * only pinned to the interval ]4 650 ; 5 170] — 10 000 Kg (2/3 of the seuil) is
 * the round number inside it, not a proven value. ⚠️ APPROXIMATION.
 */
const ROULOIR_RATIO_PROCHE = 2 / 3

// ── Small helpers (same contract as of-trm.ts / commandes-trm.ts) ──

/** SQL literal for a user-supplied text value. Pure-ASCII → quoted literal;
 *  accented values → Latin-1 hex literal (the Linux bridge corrupts raw
 *  multi-byte UTF-8 embedded in a SQL line). Maintenance comments really do
 *  carry accents ("Changement roulement poignée…"), so this path is live. */
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

/** HFSQL DATE literal: 'YYYYMMDD' or '' for "not set" (what the base holds). */
function sqlDate(value: string | null | undefined): string {
  const v = (value ?? '').toString().trim()
  return /^\d{8}$/.test(v) ? `'${v}'` : "''"
}

/** Normalise an HFSQL DATE read back out: '' / '00000000' / null → null. */
function readDate(value: unknown): string | null {
  const v = String(value ?? '').trim()
  return /^\d{8}$/.test(v) && v !== '00000000' ? v : null
}

/** Normalise an HFSQL text column: trims, '' → null. */
function readText(value: unknown): string | null {
  const v = String(value ?? '').replace(/\0/g, '').trim()
  return v === '' ? null : v
}

function round2(x: number): number {
  return Math.round((Number(x) || 0) * 100) / 100
}

/** Key folding: on the Linux bridge accented column names come back mangled,
 *  so accented columns are located by pattern, never by exact key. */
function rawGet(row: Record<string, unknown>, re: RegExp): unknown {
  const k = Object.keys(row).find((key) => re.test(key))
  return k === undefined ? undefined : row[k]
}

/** Today as an HFSQL DATE string, in local time (the workshop's day). */
function todayHf(): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

/** Whole months elapsed between an HFSQL DATE and today, floored at 0.
 *  Matches the legacy's "Il y a N mois" label. */
function monthsSince(hfDate: string | null): number | null {
  if (!hfDate) return null
  const y = Number(hfDate.slice(0, 4))
  const m = Number(hfDate.slice(4, 6))
  const d = Number(hfDate.slice(6, 8))
  const now = new Date()
  let months = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m)
  if (now.getDate() < d) months -= 1
  return Math.max(0, months)
}

// ════════════════════════════════════════════════════════
//  Readers
// ════════════════════════════════════════════════════════

interface MachineRaw {
  id: number
  emplacement: string
  nom: string
  description: string | null
  doubleFonture: boolean
  archive: boolean
  dateMaintenance: string | null
  observationMaintenance: string | null
  nettCylindre: string | null
  nettPlateau: string | null
  nettPlatines: string | null
  commNettCylindre: string | null
  commNettPlateau: string | null
  commNettPlatines: string | null
  chgAiguilles: string | null
  chgPlatines: string | null
  commChgAiguilles: string | null
  commChgPlatines: string | null
  pulsonique: string | null
  commPulsonique: string | null
  jauge: number
  diametre: number
  nbChutes: number
  nbChutesMax: number
  elasthanne: boolean
  vitesse: number
  adresseAutomate: number | null
  connecte: boolean
}

/** Every machine row, both platforms. No WHERE on `archivé` — accented. */
async function selectMachines(): Promise<MachineRaw[]> {
  const sql = 'SELECT * FROM machine'
  const raws = IS_WINDOWS
    ? await fixEncoding(await query<Record<string, unknown>>(sql), 'machine', 'IDmachine', [
        'nom',
        'emplacement',
        'commentaire',
        'observation_maintenace',
        'comm_nett_cylindre',
        'comm_nett_plateau',
        'comm_nett_platines',
        'comm_chg_aiguilles',
        'comm_chg_platines',
        'comm_pulsonque',
      ])
    : await queryB64Text<Record<string, unknown>>(sql)

  return raws.map((r) => ({
    id: n(r.IDmachine),
    emplacement: String(r.emplacement ?? '').trim(),
    nom: String(r.nom ?? '').trim(),
    description: readText(r.commentaire),
    doubleFonture: n(r.double_fonture) === 1,
    archive: n(rawGet(r, /^archiv/i) ?? 0) === 1,
    dateMaintenance: readDate(r.date_maintenance),
    observationMaintenance: readText(r.observation_maintenace),
    nettCylindre: readDate(r.nett_cylindre),
    nettPlateau: readDate(r.nett_plateau),
    nettPlatines: readDate(r.nett_platines),
    commNettCylindre: readText(r.comm_nett_cylindre),
    commNettPlateau: readText(r.comm_nett_plateau),
    commNettPlatines: readText(r.comm_nett_platines),
    chgAiguilles: readDate(r.chg_aiguilles),
    chgPlatines: readDate(r.chg_platines),
    commChgAiguilles: readText(r.comm_chg_aiguilles),
    commChgPlatines: readText(r.comm_chg_platines),
    pulsonique: readDate(r.pulsonique),
    commPulsonique: readText(r.comm_pulsonque),
    jauge: n(rawGet(r, /^jauge$/i)),
    diametre: n(rawGet(r, /^diam/i)),
    nbChutes: n(r.nb_chutes),
    nbChutesMax: n(r.nb_chutes_max),
    elasthanne: n(r.elasthanne) === 1,
    vitesse: n(r.vitesse),
    adresseAutomate: r.adresse_automate == null ? null : n(r.adresse_automate),
    connecte: n(rawGet(r, /^connect/i) ?? 0) === 1,
  }))
}

/**
 * Kg of finished production per machine since its own last rouloir visit.
 *
 * ONE grouped pass over ordre_fabrication folded in JS, deliberately: the
 * legacy runs `PoidsRestantRouloir` per machine, which here would be 30 bridge
 * round-trips for a list endpoint. Same predicate, same arithmetic.
 *
 * No IDsociete filter anywhere — the OF tables have no such column.
 */
async function produitDepuisVisite(machines: MachineRaw[]): Promise<Map<number, number>> {
  const visite = new Map<number, string>()
  for (const m of machines) if (m.dateMaintenance) visite.set(m.id, m.dateMaintenance)

  const rows = await query<Record<string, unknown>>(
    'SELECT IDmachine, date_creation, quantite FROM ordre_fabrication WHERE est_termine = 1',
  )
  const out = new Map<number, number>()
  for (const r of rows) {
    const id = n(r.IDmachine)
    const since = visite.get(id)
    if (!since) continue
    const created = String(r.date_creation ?? '').trim()
    // String compare is valid on YYYYMMDD, and matches the legacy's `>`.
    if (!/^\d{8}$/.test(created) || created <= since) continue
    out.set(id, (out.get(id) ?? 0) + n(r.quantite))
  }
  return out
}

type RouloirEtat = 'due' | 'proche' | 'ok'

function rouloirEtat(ratio: number, hasVisite: boolean): RouloirEtat {
  // No recorded visit at all = the counter is meaningless, so it can't be "due".
  if (!hasVisite) return 'ok'
  if (ratio >= 1) return 'due'
  if (ratio >= ROULOIR_RATIO_PROCHE) return 'proche'
  return 'ok'
}

function shapeMetier(m: MachineRaw, produitKg: number) {
  const ratio = MAINTENANCE_ROULOIR_SEUIL_KG > 0 ? produitKg / MAINTENANCE_ROULOIR_SEUIL_KG : 0
  return {
    id: m.id,
    emplacement: m.emplacement,
    nom: m.nom,
    description: m.description,
    doubleFonture: m.doubleFonture,
    archive: m.archive,
    rouloir: {
      derniereVisite: m.dateMaintenance,
      commentaire: m.observationMaintenance,
      produitKg: round2(produitKg),
      restantKg: round2(Math.max(0, MAINTENANCE_ROULOIR_SEUIL_KG - produitKg)),
      ratio: round2(ratio),
      etat: rouloirEtat(ratio, m.dateMaintenance !== null),
    },
    // Order is the legacy form's, top to bottom — keep it, the workshop reads
    // this screen the way it reads the machine.
    garniture: {
      nettPlatines: { date: m.nettPlatines, commentaire: m.commNettPlatines },
      nettCylindre: { date: m.nettCylindre, commentaire: m.commNettCylindre },
      nettPlateau: { date: m.nettPlateau, commentaire: m.commNettPlateau },
      chgAiguilles: { date: m.chgAiguilles, commentaire: m.commChgAiguilles },
      chgPlatines: { date: m.chgPlatines, commentaire: m.commChgPlatines },
      pulsonique: { date: m.pulsonique, commentaire: m.commPulsonique },
    },
    // Read-only: these belong to FEN_Gestion_des_machines, never written here.
    caracteristiques: {
      jauge: m.jauge,
      diametre: m.diametre,
      nbChutes: m.nbChutes,
      nbChutesMax: m.nbChutesMax,
      elasthanne: m.elasthanne,
      vitesse: m.vitesse,
      adresseAutomate: m.adresseAutomate,
      connecte: m.connecte,
    },
  }
}

// ════════════════════════════════════════════════════════
//  GET /metiers — the left list + every fiche in one payload
// ════════════════════════════════════════════════════════

maintenanceTrmRouter.get('/metiers', async (_req: Request, res: Response) => {
  try {
    const machines = (await selectMachines()).filter((m) => !m.archive)
    const produit = await produitDepuisVisite(machines)

    const metiers = machines
      .map((m) => shapeMetier(m, produit.get(m.id) ?? 0))
      // Legacy order: most urgent first (least kg left), then by métier code.
      .sort(
        (a, b) =>
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
//  GET /metiers/:id/production — what the rouloir counter counts
// ════════════════════════════════════════════════════════

maintenanceTrmRouter.get('/metiers/:id/production', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const machine = (await selectMachines()).find((m) => m.id === id)
    if (!machine) {
      res.status(404).json({ error: 'métier introuvable' })
      return
    }
    if (!machine.dateMaintenance) {
      res.json({ derniereVisite: null, totalKg: 0, ofs: [] })
      return
    }

    // `orf` alias, never `of` — too close to SQL keyword territory for the
    // HFSQL parser (the of-trm.ts convention).
    // NB: ordre_fabrication has NO `numero` column — an OF is identified by its
    // id, which is exactly how Production › Ordres de fabrication labels it
    // ("OF 1234").
    const rows = await query<Record<string, unknown>>(
      `SELECT orf.IDordre_fabrication AS id, orf.date_creation AS date_creation,
              orf.quantite AS quantite, orf.IDref_ecru AS idref
       FROM ordre_fabrication orf
       WHERE orf.est_termine = 1 AND orf.IDmachine = ${id}
         AND orf.date_creation > '${machine.dateMaintenance}'`,
    )

    const refIds = [...new Set(rows.map((r) => n(r.idref)).filter((x) => x > 0))]
    const refs = new Map<number, string>()
    if (refIds.length > 0) {
      const raw = await query<Record<string, unknown>>(
        `SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru IN (${refIds.join(',')})`,
      )
      for (const r of await fixEncoding(raw, 'ref_ecru', 'IDref_ecru', ['reference'])) {
        refs.set(n(r.IDref_ecru), String(r.reference ?? '').trim())
      }
    }

    const ofs = rows
      .map((r) => ({
        id: n(r.id),
        dateCreation: readDate(r.date_creation),
        quantiteKg: round2(n(r.quantite)),
        reference: refs.get(n(r.idref)) ?? null,
      }))
      .sort((a, b) => (b.dateCreation ?? '').localeCompare(a.dateCreation ?? '') || b.id - a.id)

    res.json({
      derniereVisite: machine.dateMaintenance,
      totalKg: round2(ofs.reduce((s, o) => s + o.quantiteKg, 0)),
      seuilRouloirKg: MAINTENANCE_ROULOIR_SEUIL_KG,
      ofs,
    })
  } catch (err) {
    console.error('GET /maintenance-trm/metiers/:id/production failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  Write guard
// ════════════════════════════════════════════════════════

/** Guard for every write path (métier fiche + operation reset). Reads stay open
 *  to anyone holding the Atelier menu, same split as edit_commandes_client.
 *  Sends the 401/403 itself and returns false when the caller is not allowed. */
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

// ════════════════════════════════════════════════════════
//  PUT /metiers/:id — the fiche
// ════════════════════════════════════════════════════════

const hfDate = z
  .string()
  .regex(/^\d{8}$/, 'attendu YYYYMMDD')
  .nullable()

const operationBody = z.object({
  date: hfDate.optional().default(null),
  commentaire: z.string().max(4000).nullable().optional().default(null),
})

const metierBody = z.object({
  description: z.string().max(4000).nullable().optional().default(null),
  doubleFonture: z.boolean(),
  rouloir: z.object({
    derniereVisite: hfDate.optional().default(null),
    commentaire: z.string().max(4000).nullable().optional().default(null),
  }),
  garniture: z.object({
    nettPlatines: operationBody,
    nettCylindre: operationBody,
    nettPlateau: operationBody,
    chgAiguilles: operationBody,
    chgPlatines: operationBody,
    pulsonique: operationBody,
  }),
})

maintenanceTrmRouter.put('/metiers/:id', async (req: Request, res: Response) => {
  if (!(await requireEditMaintenance(req, res))) return
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const parsed = metierBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const body = parsed.data

    const machines = await selectMachines()
    const current = machines.find((m) => m.id === id)
    if (!current) {
      res.status(404).json({ error: 'métier introuvable' })
      return
    }
    if (current.archive) {
      res.status(409).json({
        error: 'machine_archivee',
        message: "Ce métier est archivé : sa fiche de maintenance n'est plus modifiable.",
      })
      return
    }

    const g = body.garniture
    // Named UPDATE — every column below is ASCII. The accented ones and the
    // FEN_Gestion_des_machines ones are deliberately absent: unnamed keeps the
    // stored value, named would overwrite it.
    await query(
      `UPDATE machine SET
         commentaire            = ${sqlText(body.description)},
         double_fonture         = ${body.doubleFonture ? 1 : 0},
         date_maintenance       = ${sqlDate(body.rouloir.derniereVisite)},
         observation_maintenace = ${sqlText(body.rouloir.commentaire)},
         nett_platines          = ${sqlDate(g.nettPlatines.date)},
         comm_nett_platines     = ${sqlText(g.nettPlatines.commentaire)},
         nett_cylindre          = ${sqlDate(g.nettCylindre.date)},
         comm_nett_cylindre     = ${sqlText(g.nettCylindre.commentaire)},
         nett_plateau           = ${sqlDate(g.nettPlateau.date)},
         comm_nett_plateau      = ${sqlText(g.nettPlateau.commentaire)},
         chg_aiguilles          = ${sqlDate(g.chgAiguilles.date)},
         comm_chg_aiguilles     = ${sqlText(g.chgAiguilles.commentaire)},
         chg_platines           = ${sqlDate(g.chgPlatines.date)},
         comm_chg_platines      = ${sqlText(g.chgPlatines.commentaire)},
         pulsonique             = ${sqlDate(g.pulsonique.date)},
         comm_pulsonque         = ${sqlText(g.pulsonique.commentaire)}
       WHERE IDmachine = ${id}`,
    )

    // Return the refreshed métier (the §31.6 pattern) — the rouloir counter
    // moves whenever the visit date does, and the caller must not recompute it.
    const after = (await selectMachines()).find((m) => m.id === id)
    if (!after) {
      res.status(500).json({ error: 'Internal server error' })
      return
    }
    const produit = await produitDepuisVisite([after])
    res.json({
      seuilRouloirKg: MAINTENANCE_ROULOIR_SEUIL_KG,
      metier: shapeMetier(after, produit.get(id) ?? 0),
    })
  } catch (err) {
    console.error('PUT /maintenance-trm/metiers/:id failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  Operations d'entretien atelier (operation_maintenance)
// ════════════════════════════════════════════════════════

/**
 * The three atelier-wide upkeep operations (Ventilateurs / Couronnes / Fuites
 * d'air). No IDmachine column — these are the workshop's, not a métier's.
 *
 * Rendered dynamically on purpose: the legacy hard-wired exactly three gauges
 * (JAUGE_Ventilateur / JAUGE_Couronne / JAUGE_FuiteAir), so a fourth row added
 * in the base would have been invisible there. Here it just shows up.
 *
 * `frequence` is in MONTHS — confirmed against the legacy screenshot
 * (Ventilateurs, dernière 24/10/2025, frequence 3, label "Il y a 10 mois").
 */
async function selectOperations() {
  const rows = await fixEncoding(
    await query<Record<string, unknown>>(
      'SELECT IDoperation_maintenance, nom, date_derniere, frequence FROM operation_maintenance',
    ),
    'operation_maintenance',
    'IDoperation_maintenance',
    ['nom'],
  )
  return rows
    .map((r) => {
      const derniere = readDate(r.date_derniere)
      const frequence = n(r.frequence)
      const mois = monthsSince(derniere)
      // Unbounded on purpose: the legacy needle just pinned to the right and
      // said nothing. The screen shows the overshoot in words.
      const ratio = frequence > 0 && mois !== null ? round2(mois / frequence) : null
      return {
        id: n(r.IDoperation_maintenance),
        nom: String(r.nom ?? '').trim(),
        derniereMaintenance: derniere,
        frequenceMois: frequence,
        moisEcoules: mois,
        ratio,
        etat: ratio === null ? 'inconnu' : ratio >= 1 ? 'due' : ratio >= ROULOIR_RATIO_PROCHE ? 'proche' : 'ok',
      }
    })
    .sort((a, b) => a.id - b.id)
}

maintenanceTrmRouter.get('/operations', async (_req: Request, res: Response) => {
  try {
    res.json({ operations: await selectOperations() })
  } catch (err) {
    console.error('GET /maintenance-trm/operations failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** "Mise a Zéro" in the legacy: stamp the operation as done today. */
maintenanceTrmRouter.post('/operations/:id/reset', async (req: Request, res: Response) => {
  if (!(await requireEditMaintenance(req, res))) return
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const existing = (await selectOperations()).find((o) => o.id === id)
    if (!existing) {
      res.status(404).json({ error: 'opération introuvable' })
      return
    }
    await query(
      `UPDATE operation_maintenance SET date_derniere = '${todayHf()}' WHERE IDoperation_maintenance = ${id}`,
    )
    res.json({ operations: await selectOperations() })
  } catch (err) {
    console.error('POST /maintenance-trm/operations/:id/reset failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
