// Shared server plumbing for the TRM production screens — Gestion des OF
// (routes/of-trm.ts) and Visitage (routes/visitage-trm.ts).
//
// These helpers were module-locals of of-trm.ts until Visitage needed the same
// ones. Extracted here rather than duplicated, same reasoning as
// lib/clients-common.ts for clients.ts / clients-trm.ts: improve THIS file,
// never fork a second copy.
//
// Scope: the ordre_fabrication family (ordre_fabrication, piece_production,
// asso_fil_of, evenement_piece, defaut_qualite) has NO IDsociete column —
// knitting production is inherently TRM. The partition guard runs through the
// commande chain instead: an OF is addressable only when its
// IDligne_commande_client lands on a commande_client with IDsociete = 2. That
// is what loadOf / resolveLigneContexts enforce; every route reading an OF by
// id must go through them, never straight to the table.
//
// HFSQL discipline encoded here (all of it has drawn blood before):
//  - `date` / `TYPE` are reserved words → aliased or read via SELECT * and
//    picked back out with rawGet.
//  - Accented columns (`récuperé`, `traité`, `archivé`, `prénom`,
//    `IDPropriétaire`) are NEVER named in SQL — the Linux bridge rejects the
//    identifier. Read them through SELECT * + key folding (rawGet).
//  - `SELECT *` on a table carrying a memo-binary column (stock_fil,
//    colori_ecru, client) silently returns ZERO rows on the Windows ODBC
//    driver → those readers name every column explicitly.
//  - Accented text in a SQL literal → sqlText (Latin-1 hex literal).
//  - Blobs (bonnetier.photo) need queryRaw; query() UTF-8-mangles them.
import { query, queryB64Text, fixEncoding } from './hfsql-auto.js'
import { esc, n } from './sst-shared.js'

export const IS_WINDOWS = process.platform === 'win32'
export const TRM_SOCIETE = 2

// ── Small SQL/format helpers (same contract as commandes-trm.ts) ──

/** SQL literal for a user-supplied text value. Pure-ASCII → quoted literal;
 *  accented values → Latin-1 hex literal (the Linux bridge corrupts raw
 *  multi-byte UTF-8 embedded in a SQL line). */
export function sqlText(value: string | null | undefined): string {
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

export function round2(x: number): number {
  return Math.round((Number(x) || 0) * 100) / 100
}

/** HFSQL DATE literal (8 chars, YYYYMMDD) for today. */
export function todayHfsql(): string {
  const t = new Date()
  return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`
}

/** Compact HFSQL DATETIME literal for "now" (verified round-trip shape, same
 *  as planning-atelier's dtLiteral). */
export function nowDt(): string {
  const t = new Date()
  const p = (x: number, l = 2) => String(x).padStart(l, '0')
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`
}

/** Parse an HFSQL DATETIME in either driver shape to epoch ms (local time).
 *  Windows ODBC: 'YYYY-MM-DD HH:MM:SS(.mmm)'; Linux bridge: 'YYYYMMDDHHMMSS'.
 *  Returns null for empty/zero dates. */
export function parseDtMs(v: unknown): number | null {
  const s = String(v ?? '').trim()
  if (!s || /^0+$/.test(s.replace(/[^0-9]/g, ''))) return null
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/)
  if (!m) {
    const d = s.match(/^(\d{4})-(\d{2})-(\d{2})$/) ?? s.match(/^(\d{4})(\d{2})(\d{2})$/)
    if (!d) return null
    return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime()
  }
  const t = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] ?? 0),
  ).getTime()
  return Number.isFinite(t) ? t : null
}

/** Case/accent-insensitive getter for SELECT * rows whose accented keys the
 *  Linux bridge mangles (prénom → `pr`, archivé → `archiv`, …). */
export function rawGet(raw: Record<string, unknown>, re: RegExp): unknown {
  for (const [k, v] of Object.entries(raw)) {
    if (re.test(k)) return v
  }
  return undefined
}

// ── Accented-table readers (SELECT * + key folding) ──────

export interface MachineRow {
  id: number
  nom: string
  jauge: number
  diametre: number
  emplacement: string
  vitesse: number
  archive: number
}

export async function selectMachines(): Promise<MachineRow[]> {
  // No WHERE on the accented `archivé` column — filter in JS on both platforms.
  const sql = 'SELECT * FROM machine'
  const raws = IS_WINDOWS
    ? await fixEncoding(await query<Record<string, unknown>>(sql), 'machine', 'IDmachine', ['nom', 'emplacement'])
    : await queryB64Text<Record<string, unknown>>(sql)
  return raws.map((r) => ({
    id: n(r.IDmachine),
    nom: String(r.nom ?? '').trim(),
    jauge: n(rawGet(r, /^jauge$/i)),
    diametre: n(rawGet(r, /^diam/i)),
    emplacement: String(r.emplacement ?? '').trim(),
    vitesse: n(r.vitesse),
    archive: n(rawGet(r, /^archiv/i) ?? 0),
  }))
}

export interface BonnetierInfo { prenom: string; nom: string }

/** Full bonnetier row set, key-folded. `prénom` and `archivé` are accented, so
 *  this is SELECT * + rawGet on both platforms — never name them. */
export interface BonnetierRow extends BonnetierInfo {
  id: number
  archive: number
  regleur: number
}

export async function selectBonnetiers(): Promise<BonnetierRow[]> {
  const sql = 'SELECT * FROM bonnetier'
  const raws = IS_WINDOWS
    ? await fixEncoding(await query<Record<string, unknown>>(sql), 'bonnetier', 'IDbonnetier', ['prénom', 'nom'])
    : await queryB64Text<Record<string, unknown>>(sql)
  return raws.map((r) => {
    // The bridge can truncate `prénom` to `pr`; when even that is gone, fall
    // back to the column physically sitting just before `nom`.
    const direct = rawGet(r, /^pr$|^pr.*nom$/i)
    let prenom = direct !== undefined ? String(direct ?? '') : ''
    if (prenom === '' && direct === undefined) {
      const keys = Object.keys(r)
      const i = keys.indexOf('nom')
      if (i > 0) prenom = String(r[keys[i - 1]] ?? '')
    }
    return {
      id: n(r.IDbonnetier),
      prenom: prenom.trim(),
      nom: String(r.nom ?? '').trim(),
      archive: n(rawGet(r, /^archiv/i) ?? 0),
      regleur: n(rawGet(r, /^regleur$/i) ?? 0),
    }
  })
}

/** id → display name, for event/observation attribution. */
export async function bonnetierDirectory(): Promise<Map<number, BonnetierInfo>> {
  const out = new Map<number, BonnetierInfo>()
  for (const b of await selectBonnetiers()) out.set(b.id, { prenom: b.prenom, nom: b.nom })
  return out
}

/** "Prénom Nom" — the exact shape stored in stock_ecru.visiteur ("Olivier
 *  Petit" on every live row). Keep this the single source of that format. */
export function bonnetierDisplayName(b: BonnetierInfo | undefined): string {
  if (!b) return ''
  return [b.prenom, b.nom].filter(Boolean).join(' ').trim()
}

export interface DefautRow {
  id: number
  reference: number
  type_defaut: string
  description: string
  taille_cm: number
  nombre: number
  recupere: number
  traite: number
  type_spotteur: number
  id_spotteur: number
  date_ms: number | null
}

/** Defect instances for one population. `reference` is a VARCHAR holding a
 *  stringified id — ALWAYS scope by an id list the caller already owns; never
 *  query by Type_Reference alone (the two populations share the id space).
 *
 *  Type_Reference 1 → reference = IDpiece_production (declared at the workshop
 *  terminal by the bonnetier, while knitting).
 *  Type_Reference 2 → reference = IDstock_ecru (carried onto the roll at
 *  visitage, or entered by the visiteur there).
 *
 *  Origin is read from `Type_Spotteur` (1 = bonnetier, 2 = visiteur), never
 *  from whether `description` is filled: the visitage path stopped writing a
 *  description in 2023, but 1 365 rows from 2021–22 still carry free text.
 *
 *  SELECT * because `traité`/`récuperé` are accented; the reserved `date`
 *  column comes back uppercased. */
export async function selectDefauts(typeRef: 1 | 2, ids: number[]): Promise<DefautRow[]> {
  const list = Array.from(new Set(ids.filter((x) => x > 0)))
  if (list.length === 0) return []
  const out: DefautRow[] = []
  // Chunk the IN list — visitage-heavy OFs hold hundreds of rolls.
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200).map((x) => `'${x}'`).join(',')
    const sql = `SELECT * FROM defaut_qualite WHERE Type_Reference = ${typeRef} AND reference IN (${chunk})`
    const raws = IS_WINDOWS
      ? await fixEncoding(await query<Record<string, unknown>>(sql), 'defaut_qualite', 'IDdefaut_qualite', ['description', 'type_defaut'])
      : await queryB64Text<Record<string, unknown>>(sql)
    for (const r of raws) {
      out.push({
        id: n(r.IDdefaut_qualite),
        reference: n(r.reference),
        type_defaut: String(r.type_defaut ?? '').trim(),
        description: String(r.description ?? '').trim(),
        taille_cm: n(r.taille_cm),
        nombre: n(r.nombre),
        recupere: n(rawGet(r, /^r.{0,2}cup/i) ?? 0),
        traite: n(rawGet(r, /^trait/i) ?? 0),
        type_spotteur: n(rawGet(r, /^type_spotteur$/i) ?? 0),
        id_spotteur: n(rawGet(r, /^idspotteur$/i) ?? 0),
        date_ms: parseDtMs(rawGet(r, /^date$/i)),
      })
    }
  }
  return out
}

// ── Label resolvers (flat batched lookups — no JOIN + CONVERT) ──

export interface EcruRefInfo {
  reference: string
  designation: string
  contexture: string
  poids_piece: number
  vitesse_cible: number
}

/** ref_ecru display info + contexture label ("interlock", "jersey", …) — the
 *  banner subtitle of the legacy forms. */
export async function resolveEcruRefs(refIds: number[]): Promise<Map<number, EcruRefInfo>> {
  const out = new Map<number, EcruRefInfo>()
  const ids = Array.from(new Set(refIds.filter((x) => x > 0)))
  if (ids.length === 0) return out
  const rows = await query<{
    IDref_ecru: number; reference: string | null; designation: string | null
    IDcontexture: number | null; poids: number | null; vitesse_cible: number | null
  }>(
    `SELECT IDref_ecru, reference, designation, IDcontexture, poids, vitesse_cible
     FROM ref_ecru WHERE IDref_ecru IN (${ids.join(',')})`,
  )
  const fixed = await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['reference', 'designation'])
  const ctxIds = Array.from(new Set(fixed.map((r) => Number(r.IDcontexture) || 0).filter((x) => x > 0)))
  const ctxNames = new Map<number, string>()
  if (ctxIds.length > 0) {
    const c = await query<{ IDcontexture: number; nom: string | null }>(
      `SELECT IDcontexture, nom FROM contexture WHERE IDcontexture IN (${ctxIds.join(',')})`,
    )
    for (const row of await fixEncoding(c, 'contexture', 'IDcontexture', ['nom'])) {
      ctxNames.set(Number(row.IDcontexture), (row.nom ?? '').toString().trim())
    }
  }
  for (const r of fixed as any[]) {
    out.set(Number(r.IDref_ecru), {
      reference: (r.reference ?? '').toString().trim(),
      designation: (r.designation ?? '').toString().trim(),
      contexture: ctxNames.get(Number(r.IDcontexture) || 0) ?? '',
      poids_piece: Number(r.poids) || 0,
      vitesse_cible: Number(r.vitesse_cible) || 0,
    })
  }
  return out
}

/** colori_ecru carries a memo column → SELECT * returns 0 rows on Windows.
 *  Name the two columns explicitly. */
export async function resolveColorisEcru(coloriIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const ids = Array.from(new Set(coloriIds.filter((x) => x > 0)))
  if (ids.length === 0) return out
  const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(
    `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${ids.join(',')})`,
  )
  for (const r of await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference'])) {
    out.set(Number(r.IDcolori_ecru), (r.reference ?? '').toString().trim())
  }
  return out
}

export interface StockFilLot {
  id: number
  lot: string
  IDref_fil: number
  IDcolori_fil: number
  stock: number
  emplacement: string
}

/** stock_fil has an accented `terminé` column and two memo-binary certif
 *  columns, so SELECT * returns 0 rows on this driver — name every column. */
export async function selectStockFilByIds(ids: number[]): Promise<Map<number, StockFilLot>> {
  const out = new Map<number, StockFilLot>()
  const list = Array.from(new Set(ids.filter((x) => x > 0)))
  if (list.length === 0) return out
  const rows = await query<any>(
    `SELECT IDstock_fil, IDref_fil, IDcolori_fil, lot, stock, emplacement
     FROM stock_fil WHERE IDstock_fil IN (${list.join(',')})`,
  )
  for (const r of await fixEncoding(rows, 'stock_fil', 'IDstock_fil', ['lot', 'emplacement'])) {
    out.set(Number(r.IDstock_fil), {
      id: Number(r.IDstock_fil),
      lot: (r.lot ?? '').toString().trim(),
      IDref_fil: Number(r.IDref_fil) || 0,
      IDcolori_fil: Number(r.IDcolori_fil) || 0,
      stock: round2(Number(r.stock) || 0),
      emplacement: (r.emplacement ?? '').toString().trim(),
    })
  }
  return out
}

// ── Commande scope guard ─────────────────────────────────

/** Commande context for a set of ligne_commande_client ids — numero + client,
 *  scoped to société 2. Lines whose commande is NOT société 2 are absent from
 *  the result, which is how out-of-scope OFs get 404'd. */
export interface LigneContext {
  ligneId: number
  commandeId: number
  commande_numero: number
  client_nom: string
  ligne_quantite: number
  IDreference: number
  IDcolori: number
}

export async function resolveLigneContexts(ligneIds: number[]): Promise<Map<number, LigneContext>> {
  const out = new Map<number, LigneContext>()
  const ids = Array.from(new Set(ligneIds.filter((x) => x > 0)))
  if (ids.length === 0) return out
  // ligne_commande_client has accented columns (delai_annoncé, déverrouiller)
  // and the reserved TYPE — named ASCII columns only.
  const lines = await query<any>(
    `SELECT IDligne_commande_client, IDcommande_client, quantite, IDreference, IDcolori
     FROM ligne_commande_client WHERE IDligne_commande_client IN (${ids.join(',')})`,
  )
  const cmdIds = Array.from(new Set(lines.map((l: any) => Number(l.IDcommande_client) || 0).filter(Boolean)))
  if (cmdIds.length === 0) return out
  const cmds = await query<any>(
    `SELECT IDcommande_client, numero, IDclient, IDsociete FROM commande_client
     WHERE IDcommande_client IN (${cmdIds.join(',')})`,
  )
  const cmdById = new Map<number, { numero: number; IDclient: number }>()
  for (const c of cmds) {
    if (Number(c.IDsociete) !== TRM_SOCIETE) continue
    cmdById.set(Number(c.IDcommande_client), { numero: Number(c.numero) || 0, IDclient: Number(c.IDclient) || 0 })
  }
  const clientIds = Array.from(new Set(Array.from(cmdById.values()).map((c) => c.IDclient).filter(Boolean)))
  const clientNames = new Map<number, string>()
  if (clientIds.length > 0) {
    // `SELECT * FROM client` returns 0 rows on this driver — explicit columns.
    const rows = await query<{ IDclient: number; nom: string | null }>(
      `SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`,
    )
    for (const r of await fixEncoding(rows, 'client', 'IDclient', ['nom'])) {
      clientNames.set(Number(r.IDclient), (r.nom ?? '').toString().trim())
    }
  }
  for (const l of lines) {
    const cmdId = Number(l.IDcommande_client) || 0
    const cmd = cmdById.get(cmdId)
    if (!cmd) continue
    out.set(Number(l.IDligne_commande_client), {
      ligneId: Number(l.IDligne_commande_client),
      commandeId: cmdId,
      commande_numero: cmd.numero,
      client_nom: clientNames.get(cmd.IDclient) ?? '',
      ligne_quantite: round2(Number(l.quantite) || 0),
      IDreference: Number(l.IDreference) || 0,
      IDcolori: Number(l.IDcolori) || 0,
    })
  }
  return out
}

// ── OF loading + scope guard ─────────────────────────────

/** The safe ASCII column list — everything except the four accented
 *  `productivité*` columns (recompute productivity, never read those) and
 *  `interruption_prod`: the only HFSQL *Durée* column in the whole MPS
 *  database. The ODBC driver types it numeric but returns it as the text
 *  `0000000000`, which the Linux bridge then emits unquoted — invalid JSON,
 *  every list/detail 500s in prod while Windows dev works. Nothing reads it. */
export const OF_COLUMNS =
  'IDordre_fabrication, quantite, IDligne_commande_client, poids_piece, ouvert_visiteuse, ' +
  'maille_ouverture, observations, date_creation, visitage, est_actif, est_termine, IDmachine, ' +
  'nb_tour_cpt, nb_tour_1_chute, priorite, finir_fil, nb_pieces, demarrage_prod, arret_prod, ' +
  'auto_activation, IDref_ecru, IDcolori_ecru, Nettoyage, raison_modif, ' +
  'prioritaire, planning_depart, planning_fin, vitesse, sonneter'

export type OfRow = Record<string, any>

/** Load one OF and verify its commande chain lands in société 2. A
 *  wrong-partition (or orphan) id is "not found" — never let a route touch
 *  another company's data through the shared id space. */
export async function loadOf(id: number): Promise<{ of: OfRow; ligne: LigneContext | null } | null> {
  const rows = await query<OfRow>(
    `SELECT ${OF_COLUMNS} FROM ordre_fabrication WHERE IDordre_fabrication = ${id}`,
  )
  if (rows.length === 0) return null
  const fixed = await fixEncoding(rows, 'ordre_fabrication', 'IDordre_fabrication', ['observations', 'raison_modif'])
  const of = fixed[0]
  const ligneId = Number(of.IDligne_commande_client) || 0
  if (ligneId > 0) {
    const ctx = await resolveLigneContexts([ligneId])
    const ligne = ctx.get(ligneId)
    if (!ligne) return null // line exists but not société 2 → out of scope
    return { of, ligne }
  }
  return { of, ligne: null }
}

/** Réalisé per OF = Σ stock_ecru.poids. NO IDsociete filter — delivered pieces
 *  flip to société 1 on the ETM handover and must keep counting.
 *
 *  `premierChoixOnly` reproduces the legacy visitage gauges, whose recovered
 *  SQL carries `AND second_choix = 0`: a déclassé roll is produced weight but
 *  not weight delivered against the order. The OF list/detail screens want the
 *  unfiltered total, which is the default. */
export async function realiseByOf(
  ofIds: number[],
  opts: { premierChoixOnly?: boolean } = {},
): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const ids = ofIds.filter((x) => x > 0)
  if (ids.length === 0) return out
  const where = opts.premierChoixOnly ? ' AND second_choix = 0' : ''
  const rows = await query<{ IDordre_fabrication: number; poids: number | null }>(
    `SELECT IDordre_fabrication, poids FROM stock_ecru
     WHERE IDordre_fabrication IN (${ids.join(',')})${where}`,
  )
  for (const r of rows) {
    const k = Number(r.IDordre_fabrication)
    out.set(k, (out.get(k) ?? 0) + (Number(r.poids) || 0))
  }
  for (const [k, v] of out) out.set(k, round2(v))
  return out
}

// ── Defect vocabulary (legacy FEN_Ajout_Défaut) ──────────

/** The visitage defect picker. There is NO reference table for it: the base's
 *  `type_defaut` table is ETM's quality/retour-client vocabulary (Coloris,
 *  Volars, Vrillage, Stabilisation, Poids) and is unrelated — the legacy combo
 *  is hard-coded in the window. This list is the vocabulary actually written
 *  by the visitage screen, recovered from live data
 *  (Type_Reference = 2 AND Type_Spotteur = 2, 3 491 rows), ordered by use.
 *
 *  `unite` decides the quantity field's mask, which the compile cache confirms
 *  is one of exactly two: `9 999 cm` (taille_cm) or `x9 999` (nombre). The cm
 *  family is the four literals sitting next to those masks in the cache —
 *  Maille, Barrure Lycra, Autre Barrure, Plis Marchand — and live data agrees
 *  on every one of them. */
export interface TypeDefautDef { type: string; unite: 'cm' | 'nb' }

export const TYPES_DEFAUT: TypeDefautDef[] = [
  { type: 'Maille', unite: 'cm' },
  { type: 'Trou', unite: 'nb' },
  { type: 'Démaillage', unite: 'nb' },
  { type: 'Barrure Lycra', unite: 'cm' },
  { type: 'Autre Barrure', unite: 'cm' },
  { type: 'Volards', unite: 'nb' },
  { type: 'Grille', unite: 'nb' },
  { type: 'Bourrage', unite: 'nb' },
  { type: 'Fil de séparation', unite: 'nb' },
  { type: 'Mise en bas', unite: 'nb' },
  { type: 'Trace', unite: 'nb' },
  { type: 'Vrille', unite: 'nb' },
  { type: 'Plis Marchand', unite: 'cm' },
  { type: 'Autre', unite: 'nb' },
]

/** Historical noise folded on READ only — never write these spellings.
 *  `"Autre Barrure "` (trailing space) is 453 live rows and already bit the
 *  Prime screen; `"Volard"` and `"Barrure"` are single strays. */
export function normaliseTypeDefaut(raw: string | null | undefined): string {
  const v = (raw ?? '').toString().replace(/\s+/g, ' ').trim()
  if (v === '') return ''
  if (/^volard$/i.test(v)) return 'Volards'
  if (/^barrure$/i.test(v)) return 'Autre Barrure'
  const known = TYPES_DEFAUT.find((t) => t.type.toLowerCase() === v.toLowerCase())
  return known ? known.type : v
}

/** Unit for a (possibly historical) type spelling. Unknown types fall back to
 *  a count, which is what the legacy mask does for anything outside its four
 *  cm literals. */
export function uniteForType(raw: string | null | undefined): 'cm' | 'nb' {
  const t = normaliseTypeDefaut(raw)
  return TYPES_DEFAUT.find((d) => d.type === t)?.unite ?? 'nb'
}
