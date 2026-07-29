// Notification subscriptions + live alert detection — the port of the legacy
// `FI_Notifications.wdw` dashboard panel and its `FEN_Abonnement.wdw` settings
// window.
//
// ── Legacy model (reverse-engineered from the data; the .wdw sources are
//    PCS-compressed and unreadable) ──
//   abonnement_notif  catalog of subscription types (nom / description / icone),
//                     partitioned by IDsociete — an ETM user never sees the
//                     société-2 entries, which is why "FNC" is absent from the
//                     legacy subscription list on this app.
//   abonnement_user   IDutilisateur × IDabonnement — who subscribed to what.
//   notifutilisateur  the generated alerts (hash / Titre / Description / icone /
//                     visible). Rebuilt periodically by a WinDev routine, which
//                     deletes rows whose condition no longer holds.
//
// ── What MPS_NG does differently, and why ──
// The catalog and the subscriptions are read from (and written to) the SAME
// HFSQL tables, so a user who subscribes here is subscribed in the WinDev app
// too — that is the whole point of both apps sharing live data.
//
// The alert LIST, however, is computed live from the source tables on every
// read rather than persisted into `notifutilisateur`. Legacy's `hash` column is
// an opaque SHA-1 whose formula could not be recovered, so any row we inserted
// would be a duplicate the WinDev app shows twice — and the WinDev routine
// rebuilds that table anyway, so our writes would not survive. Computing live
// also means MPS_NG needs no scheduler and can never show a stale alert.
//
// The consequence is that `visible = 0` (the eye button on each card) has no
// row to live on. It is stored per user in lib/notification-hidden.ts instead —
// which is also an improvement: legacy's flag was global, so one person hiding
// a card hid it for the whole company.

import { query, queryB64Text, fixEncoding } from './hfsql-auto.js'
import { IS_WINDOWS, n } from './sst-shared.js'

/** MPS_NG serves ETS Malterre. `abonnement_notif` is partitioned by IDsociete
 *  exactly like `client` / `commande_client`, and legacy filters the
 *  subscription list on it — an ETM user is never offered the société-2 FNC
 *  subscription. Detector 3 is implemented all the same so the shared API
 *  already has it the day a société-2 view needs it. */
export const APP_SOCIETE = 1

/** How far ahead a deadline counts as "arrive à échéance". Legacy's wording
 *  ("qui arrivent a échéance") gives no number; a week is the horizon the other
 *  MPS_NG deadline surfaces use for "act on this now". Overdue always counts. */
export const ECHEANCE_WINDOW_DAYS = 7

/** Detection hits several big tables (stock_ecru alone scans ~1.5k live rolls
 *  with a NOT EXISTS), and the widget re-mounts on every navigation back to the
 *  tableau de bord. A short TTL keeps that from hammering the shared HFSQL
 *  server without ever showing meaningfully stale data. */
const DETECT_CACHE_TTL_MS = 60_000

// ── Catalog + subscriptions (shared HFSQL tables) ────────

export interface Abonnement {
  id: number
  nom: string
  description: string
  /** Legacy icon filename (certificat.png / bobine_triangle.png / tricot.png).
   *  The frontend maps it to a real icon component — see the widget. */
  icone: string
  /** True when a detector exists for this subscription. A catalog row without
   *  one is still listed (so the two apps agree on the catalog) but can never
   *  produce a card here. */
  implemented: boolean
}

/** The subscription catalog for this app's société, ordered as legacy shows it. */
export async function getAbonnementCatalog(): Promise<Abonnement[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT IDabonnement_notif, nom, description, icone
     FROM abonnement_notif
     WHERE IDsociete = ${APP_SOCIETE}
     ORDER BY IDabonnement_notif`,
  )
  const fixed = (await fixEncoding(
    rows, 'abonnement_notif', 'IDabonnement_notif', ['nom', 'description'],
  )) as Record<string, unknown>[]
  return fixed.map((r) => {
    const id = n(r.IDabonnement_notif)
    return {
      id,
      nom: (r.nom ?? '').toString().trim(),
      description: (r.description ?? '').toString().trim(),
      icone: (r.icone ?? '').toString().trim(),
      implemented: DETECTORS[id] !== undefined,
    }
  })
}

/** The subscription ids of one user. */
export async function getUserAbonnementIds(userId: number): Promise<number[]> {
  const rows = await query<{ IDabonnement: number }>(
    `SELECT IDabonnement FROM abonnement_user WHERE IDutilisateur = ${n(userId)}`,
  )
  return Array.from(new Set(rows.map((r) => n(r.IDabonnement)).filter((x) => x > 0))).sort((a, b) => a - b)
}

/** Replace a user's subscriptions. `abonnement_user` is all-ASCII (no accented
 *  column), so a named DELETE + INSERT is safe on both platforms — but the PK
 *  is NOT auto-assigned, so it is computed as max+1 and validated before use
 *  (a NaN there would collapse every insert onto row 1).
 *
 *  ⚠️ Subscriptions OUTSIDE this app's catalog are carried over untouched.
 *  `abonnement_notif` is partitioned by IDsociete, so an ETM user's row can
 *  point at a société-2 subscription (real case: user 1 is subscribed to
 *  "FNC", id 3) — one the dialog here never shows and therefore never sends
 *  back. Rewriting the user's rows from the payload alone would silently
 *  unsubscribe them in the legacy WinDev app. */
export async function setUserAbonnementIds(
  userId: number,
  ids: readonly number[],
): Promise<void> {
  const uid = n(userId)
  if (uid <= 0) throw new Error(`setUserAbonnementIds: invalid IDutilisateur ${userId}`)

  const valid = new Set(ids.map((x) => n(x)).filter((x) => x > 0))
  const catalog = new Set((await getAbonnementCatalog()).map((a) => a.id))
  const existing = await getUserAbonnementIds(uid)
  const wanted = Array.from(new Set([
    // What the caller asked for, restricted to what it could actually see…
    ...Array.from(valid).filter((x) => catalog.has(x)),
    // …plus every subscription this app doesn't own.
    ...existing.filter((x) => !catalog.has(x)),
  ])).sort((a, b) => a - b)

  await query(`DELETE FROM abonnement_user WHERE IDutilisateur = ${uid}`)
  if (wanted.length === 0) return

  const maxRow = await query<{ m: number | null }>(
    `SELECT MAX(IDabonnement_user) AS m FROM abonnement_user`,
  )
  let nextPk = n(maxRow[0]?.m) + 1
  if (!Number.isInteger(nextPk) || nextPk <= 0) {
    throw new Error('setUserAbonnementIds: could not compute a valid IDabonnement_user')
  }
  for (const aboId of wanted) {
    await query(
      `INSERT INTO abonnement_user (IDabonnement_user, IDutilisateur, IDabonnement)
       VALUES (${nextPk}, ${uid}, ${aboId})`,
    )
    nextPk++
  }
}

// ── Detected notifications ───────────────────────────────

export interface DetectedNotification {
  /** Stable identity used by the hidden store: `<abonnementId>:<sourceId>`.
   *  Derived from the source row's primary key (never from the display text) so
   *  a hidden card stays hidden across a renamed reference or a fixed typo. */
  key: string
  abonnementId: number
  titre: string
  description: string
  icone: string
}

/** A detector returns the source rows that currently satisfy its alert
 *  condition. `sourceId` must be stable for the underlying record. */
type Detector = () => Promise<Array<{ sourceId: string; titre: string; description: string }>>

// ── Shared helpers ───────────────────────────────────────

function todayYmd(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function ymdPlusDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** Normalise a HFSQL date to 'YYYYMMDD' — handles both the 8-char string form
 *  and the 'YYYY-MM-DD hh:mm:ss' datetime form. '' when unparseable/empty. */
function toYmd(v: unknown): string {
  if (v == null) return ''
  const s = String(v).trim()
  if (/^\d{8}$/.test(s)) return s
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? m[1] + m[2] + m[3] : ''
}

/** 'YYYYMMDD' → '31/12/2026' for display inside a description. */
function frDate(ymd: string): string {
  return ymd.length === 8 ? `${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}` : ''
}

function trimStr(v: unknown): string {
  return (v ?? '').toString().trim()
}

/** `terminé` → `termin` — the Linux driver truncates an accented column name at
 *  its first non-ASCII char, in the returned key as well as in SQL text.
 *  (Canonical implementation: routes/dossiers-qualite.ts.) */
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

/** `dossier_qualite` carries accented columns (echéance, terminé, IDSociétéFNC)
 *  that must never be NAMED in SQL on the Linux bridge — so both detectors that
 *  read it do `SELECT *` and filter in JS. 167 rows; cheap enough. */
async function selectDossiers(): Promise<Record<string, unknown>[]> {
  const sql = `SELECT * FROM dossier_qualite`
  if (IS_WINDOWS) {
    const rows = await query<Record<string, unknown>>(sql)
    return fixEncoding(rows, 'dossier_qualite', 'IDdossier_qualite', ['defaut_qualité', 'reference'])
  }
  return queryB64Text<Record<string, unknown>>(sql)
}

/** IDclient → nom, batched (client names are accented, and a JOIN + CONVERT
 *  collapses the result set on the bridge — see CLAUDE.md). */
async function clientNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const list = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)))
  if (list.length === 0) return out
  const rows = await query<{ IDclient: number; nom: string | null }>(
    `SELECT IDclient, nom FROM client WHERE IDclient IN (${list.join(',')})`,
  )
  for (const r of await fixEncoding(rows as any[], 'client', 'IDclient', ['nom'])) {
    out.set(n((r as any).IDclient), trimStr((r as any).nom))
  }
  return out
}

/** IDfournisseur → nom, batched (same reasoning as clientNames). */
async function fournisseurNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const list = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)))
  if (list.length === 0) return out
  const rows = await query<{ IDfournisseur: number; nom: string | null }>(
    `SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur IN (${list.join(',')})`,
  )
  for (const r of await fixEncoding(rows as any[], 'fournisseur', 'IDfournisseur', ['nom'])) {
    out.set(n((r as any).IDfournisseur), trimStr((r as any).nom))
  }
  return out
}

/** IDdefaut_textile → nom, batched. */
async function defautNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const list = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)))
  if (list.length === 0) return out
  const rows = await query<{ IDdefaut_textile: number; nom: string | null }>(
    `SELECT IDdefaut_textile, nom FROM defaut_textile WHERE IDdefaut_textile IN (${list.join(',')})`,
  )
  for (const r of await fixEncoding(rows as any[], 'defaut_textile', 'IDdefaut_textile', ['nom'])) {
    out.set(n((r as any).IDdefaut_textile), trimStr((r as any).nom))
  }
  return out
}

/** "1/60 COTON PEIGNE BIO Z - ecru" — the yarn label legacy puts in the
 *  Description of both fil detectors: ref_fil.reference + coloris reference.
 *  Batched over (IDref_fil, IDcolori_fil) pairs. */
async function yarnLabels(
  refIds: number[],
  coloriIds: number[],
): Promise<{ ref: Map<number, string>; colori: Map<number, string> }> {
  const ref = new Map<number, string>()
  const colori = new Map<number, string>()
  const rIds = Array.from(new Set(refIds.filter((x) => x > 0)))
  const cIds = Array.from(new Set(coloriIds.filter((x) => x > 0)))
  if (rIds.length > 0) {
    const rows = await query<{ IDref_fil: number; reference: string | null }>(
      `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${rIds.join(',')})`,
    )
    for (const r of await fixEncoding(rows as any[], 'ref_fil', 'IDref_fil', ['reference'])) {
      ref.set(n((r as any).IDref_fil), trimStr((r as any).reference))
    }
  }
  if (cIds.length > 0) {
    const rows = await query<{ IDcolori_fil: number; reference: string | null }>(
      `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${cIds.join(',')})`,
    )
    for (const r of await fixEncoding(rows as any[], 'colori_fil', 'IDcolori_fil', ['reference'])) {
      colori.set(n((r as any).IDcolori_fil), trimStr((r as any).reference))
    }
  }
  return { ref, colori }
}

function yarnLabel(
  labels: { ref: Map<number, string>; colori: Map<number, string> },
  refId: number,
  coloriId: number,
): string {
  const a = labels.ref.get(refId) ?? ''
  const b = labels.colori.get(coloriId) ?? ''
  return [a, b].filter(Boolean).join(' - ') || '—'
}

/** The canonical "écru rolls physically in stock" population, identical to the
 *  one Tombé Métier › Stock renders (routes/stock-ecru.ts). Both TM detectors
 *  scope to it — without it they would walk ~52k historical rows. */
const ECRU_IN_STOCK = `se.IDsociete = ${APP_SOCIETE}
  AND (se.IDligne_expedition_ETM = 0 OR se.IDligne_expedition_ETM IS NULL)
  AND NOT EXISTS (SELECT 1 FROM stock_fini sf WHERE sf.IDstock_ecru = se.IDstock_ecru)`

// ── The detectors, keyed by IDabonnement_notif ───────────

const DETECTORS: Record<number, Detector> = {
  // 1 — "Suivre les dossiers qualité qui arrivent a échéance"
  1: async () => {
    const limit = ymdPlusDays(ECHEANCE_WINDOW_DAYS)
    const rows = (await selectDossiers()).filter((raw) => {
      if (n(readCol(raw, 'terminé')) === 1) return false
      const ech = toYmd(readCol(raw, 'echéance'))
      return ech !== '' && ech <= limit
    })
    const names = await clientNames(rows.map((r) => n(readCol(r, 'IDclient'))))
    const defauts = await defautNames(rows.map((r) => n(readCol(r, 'IDdefaut_textile'))))
    return rows.map((raw) => {
      const id = n(readCol(raw, 'IDdossier_qualite'))
      const client = names.get(n(readCol(raw, 'IDclient'))) || '—'
      // Legacy free-text `defaut_qualité` first, falling back to the structured
      // defaut_textile the newer screens write.
      const defaut = trimStr(readCol(raw, 'defaut_qualité'))
        || defauts.get(n(readCol(raw, 'IDdefaut_textile'))) || '—'
      return {
        sourceId: String(id),
        // Legacy's own label reads "Cient:" — a typo we do not reproduce.
        titre: `Dossier qualité N° ${id}`,
        description: `Client: ${client} - Défaut: ${defaut}`,
      }
    })
  },

  // 2 — "Suivre les commandes de fil qui arrivent a échéance"
  2: async () => {
    const limit = ymdPlusDays(ECHEANCE_WINDOW_DAYS)
    // Open lines only (etat = 0 — a received line is etat = 1). Urgency is
    // measured against date_notif while the supplier still owes us a délai,
    // and against date_livraison once one exists — the same rule the
    // Rapports › Commandes fil screen applies (routes/rapports.ts).
    const rows = await query<{
      IDref_fil_commande: number
      IDcommande_fil: number
      IDref_fil: number
      IDcolori_fil: number
      date_livraison: string | null
      date_notif: string | null
    }>(
      `SELECT IDref_fil_commande, IDcommande_fil, IDref_fil, IDcolori_fil, date_livraison, date_notif
       FROM ref_fil_commande WHERE etat = 0`,
    )
    const due = rows.filter((r) => {
      const deadline = toYmd(r.date_livraison) || toYmd(r.date_notif)
      return deadline !== '' && deadline <= limit
    })
    if (due.length === 0) return []

    const headers = await query<{ IDcommande_fil: number; IDfournisseur: number }>(
      `SELECT IDcommande_fil, IDfournisseur FROM commande_fil
       WHERE IDcommande_fil IN (${Array.from(new Set(due.map((r) => n(r.IDcommande_fil)))).join(',')})`,
    )
    const frsByCmd = new Map(headers.map((h) => [n(h.IDcommande_fil), n(h.IDfournisseur)]))
    const frs = await fournisseurNames(Array.from(frsByCmd.values()))
    const labels = await yarnLabels(due.map((r) => n(r.IDref_fil)), due.map((r) => n(r.IDcolori_fil)))

    return due.map((r) => ({
      sourceId: String(n(r.IDref_fil_commande)),
      titre: `Commande ${frs.get(frsByCmd.get(n(r.IDcommande_fil)) ?? 0) || '—'}`,
      description: yarnLabel(labels, n(r.IDref_fil), n(r.IDcolori_fil)),
    }))
  },

  // 3 — "Suivre les FNC qui arrivent a échéance" (société 2 — TRM).
  // Implemented for completeness: the catalog row is IDsociete = 2, so it never
  // reaches an ETM user's subscription list, but the shared API is ready for a
  // société-2 view.
  3: async () => {
    const limit = ymdPlusDays(ECHEANCE_WINDOW_DAYS)
    const rows = (await selectDossiers()).filter((raw) => {
      if (n(readCol(raw, 'terminé')) === 1) return false
      if (toYmd(readCol(raw, 'envoiFNC')) === '') return false // no FNC sent → not an FNC
      const ech = toYmd(readCol(raw, 'echéance'))
      return ech !== '' && ech <= limit
    })
    const names = await clientNames(rows.map((r) => n(readCol(r, 'IDclient'))))
    return rows.map((raw) => {
      const id = n(readCol(raw, 'IDdossier_qualite'))
      return {
        sourceId: String(id),
        titre: `FNC N° ${id}`,
        description: `Client: ${names.get(n(readCol(raw, 'IDclient'))) || '—'}`,
      }
    })
  },

  // 4 — "Notification quand un stock de fil atteint son minimum"
  4: async () => {
    // The threshold lives on the coloris, not the reference: colori_fil.stock_mini.
    // Only coloris that declare one (> 0) can ever be under it.
    const coloris = await query<{
      IDcolori_fil: number
      IDref_fil: number
      stock_mini: number | null
    }>(
      `SELECT IDcolori_fil, IDref_fil, stock_mini FROM colori_fil WHERE stock_mini > 0`,
    )
    if (coloris.length === 0) return []

    // On-hand per coloris. `stock_fil` must never be read with SELECT * nor with
    // certif_bio in the column list — both silently return 0 rows on Windows
    // (memory: project-stock-fil-poisoned-select).
    const stockRows = await query<{ IDcolori_fil: number; stock: number | null }>(
      `SELECT IDcolori_fil, stock FROM stock_fil WHERE stock > 0`,
    )
    const onHand = new Map<number, number>()
    for (const r of stockRows) {
      const id = n(r.IDcolori_fil)
      onHand.set(id, (onHand.get(id) ?? 0) + (Number(r.stock) || 0))
    }

    const under = coloris.filter((c) => (onHand.get(n(c.IDcolori_fil)) ?? 0) <= Number(c.stock_mini))
    if (under.length === 0) return []
    const labels = await yarnLabels(under.map((c) => n(c.IDref_fil)), under.map((c) => n(c.IDcolori_fil)))

    return under.map((c) => ({
      sourceId: String(n(c.IDcolori_fil)),
      titre: 'Stock mini de fil atteint',
      description: yarnLabel(labels, n(c.IDref_fil), n(c.IDcolori_fil)),
    }))
  },

  // 5 — "Notification quand un stock de fil n'est pas affecté a une commande"
  // Validated against the legacy rows: "Lot de fil N° 10430" is stock_fil.lot
  // (NOT the PK), and the predicate is exactly IDref_fil_commande = 0 + stock > 0.
  // HFSQL keeps an empty FK at 0 rather than NULL — guard both.
  5: async () => {
    const rows = await query<{ IDstock_fil: number; lot: string | null }>(
      `SELECT IDstock_fil, lot FROM stock_fil
       WHERE (IDref_fil_commande IS NULL OR IDref_fil_commande = 0) AND stock > 0`,
    )
    const fixed = (await fixEncoding(rows as any[], 'stock_fil', 'IDstock_fil', ['lot'])) as any[]
    return fixed.map((r) => ({
      sourceId: String(n(r.IDstock_fil)),
      titre: `Lot de fil N° ${trimStr(r.lot) || n(r.IDstock_fil)}`,
      description: "Ce lot de fil n'est pas relié à une commande",
    }))
  },

  // 6 — "Notification quand un stock Tombé de metier n'a pas de fil affecté"
  // Yarn reaches an écru roll through its ordre de fabrication (asso_fil_of);
  // a roll with no OF at all therefore has no yarn either, and the NOT EXISTS
  // covers both cases in one predicate.
  6: async () => {
    const rows = await query<{ IDstock_ecru: number; numero: string | null }>(
      `SELECT se.IDstock_ecru, se.numero FROM stock_ecru se
       WHERE ${ECRU_IN_STOCK}
         AND NOT EXISTS (SELECT 1 FROM asso_fil_of a WHERE a.IDordre_fabrication = se.IDordre_fabrication)
       ORDER BY se.IDstock_ecru DESC`,
    )
    const fixed = (await fixEncoding(rows as any[], 'stock_ecru', 'IDstock_ecru', ['numero'])) as any[]
    return fixed.map((r) => ({
      sourceId: String(n(r.IDstock_ecru)),
      titre: `Pièce TM N° ${trimStr(r.numero) || n(r.IDstock_ecru)}`,
      description: "Cette pièce n'a pas de fil affecté",
    }))
  },

  // 7 — "Notification quand un stock Tombé de metier n'a pas de commande affectée"
  // The predicate is the CLIENT order line, not the ennoblisseur affectation:
  // one of the legacy rows ("Pièce TM N° B2721014") carries
  // IDref_commande_affectation = 143 and was still notified.
  7: async () => {
    const rows = await query<{ IDstock_ecru: number; numero: string | null }>(
      `SELECT se.IDstock_ecru, se.numero FROM stock_ecru se
       WHERE ${ECRU_IN_STOCK}
         AND (se.IDligne_commande_client IS NULL OR se.IDligne_commande_client = 0)
       ORDER BY se.IDstock_ecru DESC`,
    )
    const fixed = (await fixEncoding(rows as any[], 'stock_ecru', 'IDstock_ecru', ['numero'])) as any[]
    return fixed.map((r) => ({
      sourceId: String(n(r.IDstock_ecru)),
      titre: `Pièce TM N° ${trimStr(r.numero) || n(r.IDstock_ecru)}`,
      description: "Cette pièce n'est pas affectée à une commande",
    }))
  },

  // 8 — "Notification lorsque le certificat d'un fournisseur de fil est expiré"
  8: async () => {
    const today = todayYmd()
    const rows = await query<{
      IDcertificat: number
      nom: string | null
      date_expiration: string | null
      IDfournisseur: number
    }>(
      `SELECT IDcertificat, nom, date_expiration, IDfournisseur FROM certificat
       WHERE IDfournisseur > 0`,
    )
    const expired = rows.filter((r) => {
      const d = toYmd(r.date_expiration)
      return d !== '' && d < today
    })
    if (expired.length === 0) return []
    const fixed = (await fixEncoding(
      expired as any[], 'certificat', 'IDcertificat', ['nom'],
    )) as any[]
    const frs = await fournisseurNames(expired.map((r) => n(r.IDfournisseur)))
    return fixed.map((r) => {
      const label = trimStr(r.nom) || 'Certificat'
      const when = frDate(toYmd(r.date_expiration))
      return {
        sourceId: String(n(r.IDcertificat)),
        titre: `Certificat expiré - ${frs.get(n(r.IDfournisseur)) || '—'}`,
        description: when ? `${label} - expiré le ${when}` : label,
      }
    })
  },
}

// ── Detection with a short TTL cache ─────────────────────

const detectCache = new Map<number, { at: number; rows: DetectedNotification[] }>()

/** Run one subscription's detector. A detector that throws yields no cards
 *  rather than failing the whole widget — one broken source table must not
 *  blank out the other seven subscriptions. */
async function detectOne(abo: Abonnement): Promise<DetectedNotification[]> {
  const cached = detectCache.get(abo.id)
  if (cached && Date.now() - cached.at < DETECT_CACHE_TTL_MS) return cached.rows

  const detector = DETECTORS[abo.id]
  if (!detector) return []
  let rows: DetectedNotification[] = []
  try {
    rows = (await detector()).map((r) => ({
      key: `${abo.id}:${r.sourceId}`,
      abonnementId: abo.id,
      titre: r.titre,
      description: r.description,
      icone: abo.icone,
    }))
  } catch (err) {
    console.error(`Notification detector ${abo.id} (${abo.nom}) failed:`, err)
    return []
  }
  detectCache.set(abo.id, { at: Date.now(), rows })
  return rows
}

/** Every alert a user is subscribed to, ordered by subscription then source —
 *  the grouping legacy's flat list happens to produce. */
export async function detectForUser(
  subscribedIds: readonly number[],
  catalog: Abonnement[],
): Promise<DetectedNotification[]> {
  const wanted = new Set(subscribedIds)
  const active = catalog.filter((a) => wanted.has(a.id) && a.implemented)
  const batches = await Promise.all(active.map((a) => detectOne(a)))
  return batches.flat()
}

/** Drop the memoised detections — called after a write that could change them. */
export function invalidateDetectionCache(): void {
  detectCache.clear()
}
