import { Router, type Request, type Response, type Router as RouterType } from 'express'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { query, queryRaw, fixEncoding, queryB64Text } from '../lib/hfsql-auto.js'
import { PrimePdf, type PrimePdfData } from '../lib/pdf/PrimePdf.js'

// Production prime (TRM knitting mill) — semester bonus on knitted weight.
// Legacy: FI_Prime.wdw / FEN_Prime (logic recovered from the generated
// Android Java, C:\Mes Projets\MPS\Android\dbg\Compile\GWDFFEN_Prime.java).
//
// The prime period is a SEMESTER bounded by June 15 and December 15:
//   S1 = 15/12/(Y-1) → 15/06/Y   labelled "1er Semestre {year of fin}"
//   S2 = 15/06/Y     → 15/12/Y   labelled "2ème Semestre {year of début}"
//
// Rates (€/Kg) applied to SUM(stock_ecru.poids) over date_saisie (DATETIME):
//   1er choix  (second_choix = 0)  +0.05
//   2nd choix  (second_choix = 1)  −0.20
//   Retour client                  −0.60 — displayed but NEVER computed by the
//   legacy screen (both blocks are hardcoded to 0); kept at 0 here on purpose.
//
// Two deliberate deltas from the legacy, both user-approved (2026-08-24):
//   • Every sum adds `IDordre_fabrication > 0`: the legacy predicate also caught
//     ETM "fictif" manual pieces that carry a date_saisie but were never knitted
//     on a TRM métier (~0.4% of a semester). A TRM-knitted piece always has an OF.
//     NO IDsociete filter — the ETM handover flips delivered pieces to société 1,
//     so filtering on it would drop most of the semester (see TRM CLAUDE.md).
//   • Répartition day counts cap at the period END (legacy counted to *today*
//     even on a past semester, so historical splits drifted as time passed).
//     The current semester is unaffected: min(today, fin) = today.
//
// Répartition: bonnetiers (regleur = 0, NO archivé filter — date_sortie is what
// scopes history) whose employment overlaps the period; each gets
// total × jours/joursTotal where jours = max(début, date_entree) →
// min(today, fin, date_sortie). The week row always shows the CURRENT week
// (Monday → now), whatever period is being browsed — legacy behavior.

export const primeTrmRouter: RouterType = Router()

const IS_WINDOWS = process.platform === 'win32'

export const TAUX_PREMIER_CHOIX = 0.05
export const TAUX_SECOND_CHOIX = -0.2
export const TAUX_RETOUR_CLIENT = -0.6

// ── Date helpers (plain YYYY-MM-DD strings, no TZ arithmetic) ─────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function toUtc(date: string): Date {
  return new Date(`${date}T00:00:00Z`)
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function todayLocal(): string {
  const now = new Date()
  return iso(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

/** Whole days from a to b (WinDev DateDifférence). */
function dayDiff(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000)
}

/** Add months, clamping the day like WinDev date arithmetic (Aug 31 −6 → Feb 28). */
function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map((s) => parseInt(s, 10))
  const total = y * 12 + (m - 1) + months
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return iso(ny, nm, Math.min(d, lastDay))
}

/** Port of the legacy DatesSemestre(dDateRef): pivots at 15/06 and 15/12. */
export function datesSemestre(ref: string): { debut: string; fin: string; numSemestre: 1 | 2 } {
  const y = parseInt(ref.slice(0, 4), 10)
  const mediane = iso(y, 6, 15)
  const decembre = iso(y, 12, 15)
  if (ref <= mediane) return { debut: iso(y - 1, 12, 15), fin: mediane, numSemestre: 1 }
  if (ref > decembre) return { debut: decembre, fin: iso(y + 1, 6, 15), numSemestre: 1 }
  return { debut: mediane, fin: decembre, numSemestre: 2 }
}

function semestreLabel(p: { debut: string; fin: string; numSemestre: 1 | 2 }): string {
  return p.numSemestre === 1
    ? `1er Semestre ${p.fin.slice(0, 4)}`
    : `2ème Semestre ${p.debut.slice(0, 4)}`
}

/** Monday of the week containing `date` (WinDev PremierJourDeLaSemaine). */
function mondayOf(date: string): string {
  const d = toUtc(date)
  const shift = (d.getUTCDay() + 6) % 7 // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - shift)
  return d.toISOString().slice(0, 10)
}

/** ISO 8601 week number. */
function isoWeekNumber(date: string): number {
  const d = toUtc(date)
  d.setUTCDate(d.getUTCDate() + 4 - ((d.getUTCDay() + 6) % 7) - 1)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7)
}

/** Compact HFSQL DATETIME literal at midnight of a YYYY-MM-DD (round-trips on
 *  the live DB — same shape as planning-atelier's dtLiteral). */
function dtMidnight(date: string): string {
  return `'${date.replace(/-/g, '')}000000'`
}

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

// ── Production sums ───────────────────────────────────────

/** SUM(poids) of TRM-knitted pieces saisies in [debut, fin) (fin omitted = open
 *  ended, used by the current-week row like the legacy). */
async function sumPoids(secondChoix: 0 | 1, debut: string, fin?: string): Promise<number> {
  const where = [
    `date_saisie >= ${dtMidnight(debut)}`,
    ...(fin ? [`date_saisie <= ${dtMidnight(fin)}`] : []),
    `second_choix = ${secondChoix}`,
    `IDordre_fabrication > 0`,
  ]
  const rows = await query<{ total: unknown }>(
    `SELECT SUM(poids) AS total FROM stock_ecru WHERE ${where.join(' AND ')}`,
  )
  return n(rows[0]?.total)
}

// ── Bonnetiers ────────────────────────────────────────────

/** Fold a raw key: strip accents + lowercase (prénom → prenom). */
function rawGet(raw: Record<string, unknown>, re: RegExp): unknown {
  for (const [k, v] of Object.entries(raw)) {
    if (re.test(k)) return v
  }
  return undefined
}

// Same prénom-key resilience as planning-atelier.ts (the Linux bridge mangles
// the accented key unpredictably): match `pr…nom`-ish keys, then fall back to
// the column physically before `nom`.
function bonnetierPrenom(raw: Record<string, unknown>): string {
  const direct = rawGet(raw, /^pr$|^pr.*nom$/i)
  if (direct !== undefined) return String(direct ?? '')
  const keys = Object.keys(raw)
  const i = keys.indexOf('nom')
  return i > 0 ? String(raw[keys[i - 1]] ?? '') : ''
}

interface BonnetierRow {
  IDbonnetier: number
  prenom: string
  nom: string
  regleur: number
  dateEntree: string // YYYY-MM-DD or ''
  dateSortie: string // YYYY-MM-DD or ''
}

/** bonnetier date cols are 8-char YYYYMMDD (or null/empty). */
function bonnetierDate(v: unknown): string {
  const s = String(v ?? '').trim()
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (!m || m[0] === '00000000') return ''
  return `${m[1]}-${m[2]}-${m[3]}`
}

function normalizeBonnetier(raw: Record<string, unknown>): BonnetierRow {
  return {
    IDbonnetier: n(raw.IDbonnetier),
    prenom: bonnetierPrenom(raw),
    nom: String(raw.nom ?? ''),
    regleur: n(raw.regleur),
    dateEntree: bonnetierDate(raw.date_entree),
    dateSortie: bonnetierDate(raw.date_sortie),
  }
}

async function selectBonnetiers(): Promise<BonnetierRow[]> {
  // No WHERE on the accented `archivé` column — and no archivé filter at all:
  // a bonnetier who left keeps appearing on the semesters he worked via his
  // date_sortie, exactly like the legacy screen.
  const sql = 'SELECT * FROM bonnetier'
  if (IS_WINDOWS) {
    const rows = await query<Record<string, unknown>>(sql)
    const fixed = await fixEncoding(rows, 'bonnetier', 'IDbonnetier', ['prénom', 'nom'])
    return fixed.map(normalizeBonnetier)
  }
  const rows = await queryB64Text<Record<string, unknown>>(sql)
  return rows.map(normalizeBonnetier)
}

interface RepartitionEntry {
  IDbonnetier: number
  prenom: string
  nom: string
  jours: number
  montant: number
}

function buildRepartition(
  bonnetiers: BonnetierRow[],
  debut: string,
  fin: string,
  today: string,
  totalPrime: number,
): { repartition: RepartitionEntry[]; joursTotal: number } {
  const entries: Array<Omit<RepartitionEntry, 'montant'>> = []
  let joursTotal = 0
  for (const b of bonnetiers) {
    if (b.regleur !== 0) continue
    // Employment overlaps the period (legacy reqBonnetier predicate).
    if (b.dateEntree !== '' && b.dateEntree >= fin) continue
    if (b.dateSortie !== '' && b.dateSortie < debut) continue
    // Days worked: from max(début, entrée) to min(today, fin, sortie).
    const from = b.dateEntree > debut ? b.dateEntree : debut
    let to = today < fin ? today : fin
    if (b.dateSortie !== '' && b.dateSortie < to) to = b.dateSortie
    const jours = Math.max(0, dayDiff(from, to))
    if (jours === 0) continue
    joursTotal += jours
    entries.push({ IDbonnetier: b.IDbonnetier, prenom: b.prenom, nom: b.nom, jours })
  }
  const repartition = entries
    .map((e) => ({ ...e, montant: joursTotal > 0 ? (totalPrime / joursTotal) * e.jours : 0 }))
    .sort((a, b) => b.jours - a.jours || a.prenom.localeCompare(b.prenom, 'fr'))
  return { repartition, joursTotal }
}

// ── Payload ───────────────────────────────────────────────

interface PrimeBloc {
  kg: number
  montant: number
}

export interface PrimePayload {
  periode: {
    numSemestre: 1 | 2
    label: string
    debut: string
    fin: string
    estCourante: boolean
    precedentRef: string
    suivantRef: string | null
  }
  taux: { premierChoix: number; secondChoix: number; retourClient: number }
  semestre: { premierChoix: PrimeBloc; secondChoix: PrimeBloc; retourClient: PrimeBloc; total: number }
  semaine: {
    numero: number
    debut: string
    fin: string
    premierChoix: PrimeBloc
    secondChoix: PrimeBloc
    retourClient: PrimeBloc
    total: number
  }
  repartition: RepartitionEntry[]
  joursTotal: number
}

async function buildPayload(ref: string): Promise<PrimePayload> {
  const today = todayLocal()
  const periode = datesSemestre(ref)
  const courante = datesSemestre(today)
  const estCourante = periode.debut === courante.debut

  const monday = mondayOf(today)

  const [semKg1, semKg2, wkKg1, wkKg2, bonnetiers] = await Promise.all([
    sumPoids(0, periode.debut, periode.fin),
    sumPoids(1, periode.debut, periode.fin),
    sumPoids(0, monday),
    sumPoids(1, monday),
    selectBonnetiers(),
  ])

  const semestre = {
    premierChoix: { kg: semKg1, montant: semKg1 * TAUX_PREMIER_CHOIX },
    secondChoix: { kg: semKg2, montant: semKg2 * TAUX_SECOND_CHOIX },
    retourClient: { kg: 0, montant: 0 },
    total: semKg1 * TAUX_PREMIER_CHOIX + semKg2 * TAUX_SECOND_CHOIX,
  }
  const semaine = {
    numero: isoWeekNumber(monday),
    debut: monday,
    fin: saturdayOf(monday),
    premierChoix: { kg: wkKg1, montant: wkKg1 * TAUX_PREMIER_CHOIX },
    secondChoix: { kg: wkKg2, montant: wkKg2 * TAUX_SECOND_CHOIX },
    retourClient: { kg: 0, montant: 0 },
    total: wkKg1 * TAUX_PREMIER_CHOIX + wkKg2 * TAUX_SECOND_CHOIX,
  }

  const { repartition, joursTotal } = buildRepartition(
    bonnetiers,
    periode.debut,
    periode.fin,
    today,
    semestre.total,
  )

  return {
    periode: {
      ...periode,
      label: semestreLabel(periode),
      estCourante,
      precedentRef: addMonths(ref, -6),
      suivantRef: estCourante ? null : addMonths(ref, 6),
    },
    taux: {
      premierChoix: TAUX_PREMIER_CHOIX,
      secondChoix: TAUX_SECOND_CHOIX,
      retourClient: TAUX_RETOUR_CLIENT,
    },
    semestre,
    semaine,
    repartition,
    joursTotal,
  }
}

/** Saturday of the week starting at `monday` (legacy header: "du 17/08 au 22/08"). */
function saturdayOf(monday: string): string {
  const d = toUtc(monday)
  d.setUTCDate(d.getUTCDate() + 5)
  return d.toISOString().slice(0, 10)
}

// ── Routes ────────────────────────────────────────────────

function parseRef(req: Request): string | null {
  const ref = String(req.query.ref ?? '') || todayLocal()
  return DATE_RE.test(ref) ? ref : null
}

// GET /api/prime-trm?ref=YYYY-MM-DD — the whole screen in one payload.
primeTrmRouter.get('/', async (req: Request, res: Response) => {
  try {
    const ref = parseRef(req)
    if (!ref) {
      res.status(400).json({ error: 'ref must be YYYY-MM-DD' })
      return
    }
    res.json(await buildPayload(ref))
  } catch (err) {
    console.error('Error building prime payload:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/prime-trm/bonnetiers/:id/photo — JPEG portrait from bonnetier.photo.
// 404 when absent/unreadable; the web falls back to an initials avatar.
primeTrmRouter.get('/bonnetiers/:id/photo', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const rows = await queryRaw(`SELECT photo FROM bonnetier WHERE IDbonnetier = ${id}`)
    const v = rows[0]?.photo
    const buf =
      v instanceof ArrayBuffer ? Buffer.from(v) : Buffer.isBuffer(v) ? v : null
    // JPEG magic check: anything else (empty memo, bridge text mangling) → 404.
    if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
      res.status(404).json({ error: 'No photo' })
      return
    }
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buf)
  } catch (err) {
    console.error('Error fetching bonnetier photo:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/prime-trm/pdf?ref=YYYY-MM-DD — printable state of the screen.
primeTrmRouter.get('/pdf', async (req: Request, res: Response) => {
  try {
    const ref = parseRef(req)
    if (!ref) {
      res.status(400).json({ error: 'ref must be YYYY-MM-DD' })
      return
    }
    const payload = await buildPayload(ref)
    const data: PrimePdfData = { payload, printedDate: longDateFr(todayLocal()) }
    const buffer = await renderToBuffer(
      React.createElement(PrimePdf, { data }) as unknown as React.ReactElement<
        import('@react-pdf/renderer').DocumentProps
      >,
    )
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `inline; filename="prime-${payload.periode.label.toLowerCase().replace(/ /g, '-')}.pdf"`,
    )
    // Allow the dev web origin to embed the PDF (mps_designer §21).
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering prime PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const MOIS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
]

function longDateFr(date: string): string {
  const [y, m, d] = date.split('-').map((s) => parseInt(s, 10))
  return `${d} ${MOIS_FR[m - 1].replace(/^./, (c) => c.toUpperCase())} ${y}`
}
