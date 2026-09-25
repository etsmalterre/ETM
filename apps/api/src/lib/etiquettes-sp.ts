// Simone Pérèle roll labels (LIVA #1200) — the per-line state and the pure
// rules behind the « Étiquettes » tab of Clients › Commandes.
//
// The workflow (Vincent, 2026-09-24): the rolls come back dyed from MATEL;
// Pierrot sends MATEL a « tableau de métrage » listing them; MATEL writes by
// hand the gross length, net length (gross minus defects), laize, tare (count
// of defects) and net weight of each roll and sends the scan back; Pierrot
// enters those numbers and sends MATEL the label PDF, which MATEL prints, cuts
// and sticks on the rolls before shipping to Simone Pérèle.
//
// The legacy (FEN_Etiquettes_SP) had every field typed by hand and kept
// nothing. Here the order line gives the order number, the coloris (hence the
// EAN from `code_sp`) and the rolls; only MATEL's measures are typed, and they
// are KEPT per roll so a label can be reprinted identically.
//
// ⚠️ Storage is a JSON file, not HFSQL: a new table would have to be shipped
// as a .fic/.ndx pair (CLAUDE.md § HFSQL), and the PostgreSQL migration is
// under way. Swap the internals of this module when PG lands; the API is
// storage-agnostic. `code_sp` itself stays in HFSQL (WinDev still reads it).

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.resolve(__dirname, '../../data')
const FILE_PATH = path.join(DATA_DIR, 'etiquettes-sp.json')

/** MATEL's measures for one roll. */
export interface RollMesure {
  /** Métrage brut, metres. */
  brut: number | null
  /** Métrage net, metres (brut minus defects). */
  net: number | null
  /** Laize nette entre lisières encollées, centimetres. */
  laizeCm: number | null
  /** Number of defects. */
  tare: number | null
  /** Poids de la pièce nette, kg. */
  poids: number | null
}

/** The batch-level fields of a line's labels. */
export interface LigneEtiquettes {
  /** The client's order number as printed (« A3-57179 DU 30/07/2025 »). */
  commandeClient: string
  bain: string
  IDcode_sp: number
}

interface StoreFile {
  version: 1
  /** Clients whose order lines get the « Étiquettes » tab. */
  clients: number[]
  /** Keyed by IDligne_commande_client. */
  lignes: Record<string, LigneEtiquettes>
  /** Keyed by IDstock_fini. */
  rolls: Record<string, RollMesure>
}

let cache: StoreFile | null = null
let writeChain: Promise<void> = Promise.resolve()

async function load(): Promise<StoreFile> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await fs.readFile(FILE_PATH, 'utf8')) as StoreFile
    if (parsed?.version !== 1) throw new Error('etiquettes-sp.json: invalid shape')
    cache = { version: 1, clients: parsed.clients ?? [], lignes: parsed.lignes ?? {}, rolls: parsed.rolls ?? {} }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Failed to load etiquettes-sp.json:', err)
    cache = { version: 1, clients: [], lignes: {}, rolls: {} }
  }
  return cache
}

/** Serialised read-modify-write, written atomically (tmp + rename). */
function update(mutate: (f: StoreFile) => void): Promise<void> {
  const run = writeChain.then(async () => {
    const f = structuredClone(await load())
    mutate(f)
    await fs.mkdir(DATA_DIR, { recursive: true })
    const tmp = `${FILE_PATH}.tmp`
    await fs.writeFile(tmp, JSON.stringify(f, null, 2), 'utf8')
    await fs.rename(tmp, FILE_PATH)
    cache = f
  })
  writeChain = run.catch(() => {})
  return run
}

export async function listEtiquetteClients(): Promise<number[]> {
  return [...(await load()).clients]
}

export async function setEtiquetteClient(clientId: number, enabled: boolean): Promise<void> {
  await update((f) => {
    const set = new Set(f.clients)
    if (enabled) set.add(clientId); else set.delete(clientId)
    f.clients = [...set].sort((a, b) => a - b)
  })
}

export async function getLigneEtiquettes(ligneId: number): Promise<LigneEtiquettes | null> {
  return (await load()).lignes[String(ligneId)] ?? null
}

export async function getRollMesures(rollIds: number[]): Promise<Map<number, RollMesure>> {
  const f = await load()
  const out = new Map<number, RollMesure>()
  for (const id of rollIds) {
    const m = f.rolls[String(id)]
    if (m) out.set(id, m)
  }
  return out
}

export async function saveLigneEtiquettes(
  ligneId: number,
  ligne: LigneEtiquettes,
  rolls: Array<{ id: number } & RollMesure>,
): Promise<void> {
  await update((f) => {
    f.lignes[String(ligneId)] = ligne
    for (const r of rolls) {
      f.rolls[String(r.id)] = { brut: r.brut, net: r.net, laizeCm: r.laizeCm, tare: r.tare, poids: r.poids }
    }
  })
}

// ── Pure rules ────────────────────────────────────────────────────────────

/** Leading coloris number (« 011 BLANC » → 11), or null. */
function colorisNumber(s: string): number | null {
  const m = /^\s*(\d+)/.exec(s)
  return m ? Number(m[1]) : null
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/�/g, '').toUpperCase().replace(/\s+/g, ' ').trim()
}

/** Which `code_sp` row an order line's coloris maps to. `code_sp` has no FK
 *  to a coloris — the legacy picked it by hand from a combo — so the match is
 *  by the coloris number first (« 11 BLANC » ↔ « 011 BLANC »), then by the
 *  accent-folded label. 0 when nothing matches: the user picks. */
export function matchCodeSp(coloris: string, codes: Array<{ IDcode_sp: number; coloris: string }>): number {
  const num = colorisNumber(coloris)
  const byNum = num === null ? [] : codes.filter((c) => colorisNumber(c.coloris) === num)
  if (byNum.length === 1) return byNum[0].IDcode_sp
  const pool = byNum.length > 1 ? byNum : codes
  const target = fold(coloris)
  const exact = pool.find((c) => fold(c.coloris) === target)
  if (exact) return exact.IDcode_sp
  return byNum.length > 0 ? byNum[0].IDcode_sp : 0
}

/** Lot as printed: the dyer's lot on the roll (« ma107052 »). */
export function lotDigits(lot: string | null | undefined): string {
  return (lot ?? '').replace(/\D/g, '')
}

/** What a roll still lacks before its label can print (French, for the UI). */
export function missingMesures(m: RollMesure | undefined | null): string[] {
  const out: string[] = []
  if (!m || !(Number(m.brut) > 0)) out.push('métrage brut')
  if (!m || !(Number(m.net) > 0)) out.push('métrage net')
  if (!m || !(Number(m.laizeCm) > 0)) out.push('laize')
  if (!m || !(Number(m.poids) > 0)) out.push('poids')
  if (m && Number(m.net) > Number(m.brut)) out.push('net supérieur au brut')
  return out
}

/** The order number as the label prints it, from `commande_client.ref_client`
 *  as typed in ETM: « Commande A3-57378 du 16/10/2025 » → « A3-57378 DU
 *  16/10/2025 » (the legacy labels are upper case and start at the number). */
export function defaultCommandeClient(refClient: string): string {
  return refClient
    .replace(/^\s*(commande|cde)\b\.?\s*(n°|no\b|n\b\.?)?\s*:?\s*/i, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .trim()
}

// ── Numbering of the SP codes (LIVA #1209) ─────────────────────────────────
//
// Malterre has no GS1 subscription and numbers the codes itself (Vincent,
// 2026-09-24): a new coloris takes the highest code + 1. The codes also live
// in Simone Pérèle's warehouse system, so a code is never reused.

/** The 12 data digits a stored code compares on (a 13th digit is the check). */
export function eanKey(stored: string): string {
  return stored.replace(/\D/g, '').slice(0, 12)
}

/** Next free code: the highest complete (12-digit) code + 1, or null when the
 *  list holds none to count from. Short codes (a lost 0) are ignored — they
 *  are typing errors, not a range. */
export function nextCodeEan(stored: string[]): string | null {
  let max = -1
  for (const s of stored) {
    const k = eanKey(s)
    if (k.length === 12) max = Math.max(max, Number(k))
  }
  if (max < 0 || max >= 999_999_999_999) return null
  return String(max + 1).padStart(12, '0')
}

/** Every leading number of a coloris label: « 1002 499 rouge fragola » →
 *  [1002, 499] (some étude labels carry an extra reference in front). */
function leadingNumbers(s: string): number[] {
  const m = /^\s*((?:\d+\s+)*\d+)(?:\s|$)/.exec(s)
  return m ? m[1].trim().split(/\s+/).map(Number) : []
}

/** Whether the list already has a code for this coloris: same number (any of
 *  the label's leading numbers), or the same folded label when it has none. */
export function hasCodeForColoris(coloris: string, codes: Array<{ coloris: string }>): boolean {
  const nums = leadingNumbers(coloris)
  if (nums.length > 0) return codes.some((c) => { const n = colorisNumber(c.coloris); return n !== null && nums.includes(n) })
  const target = fold(coloris)
  return target !== '' && codes.some((c) => fold(c.coloris) === target)
}

/** The coloris as the SP list names it, from the label of an accepted étude:
 *  « 440 ROSE DESIR 63834/2 » → « 440 ROSE DESIR ». The étude appends the
 *  dyer's lab number and the sample number; the list keeps number + name,
 *  upper case. */
export function spColorisFromLibelle(libelle: string): string {
  return libelle
    .replace(/(\s*\/\s*\d+)+\s*$/, '')
    .replace(/\s+\d{5,}\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

/** The dyer's bath number an accepted étude implies: lab number + sample
 *  number, as Pierrot types it (« 556 saphir 63835/2 » → « 638352 »). */
export function bainFromLibelle(libelle: string): string {
  const m = /(\d{5,})\s*\/\s*(\d+)\s*$/.exec(libelle)
  return m ? `${m[1]}${m[2]}` : ''
}

/** The client article of a new coloris, patterned on an existing row
 *  (« LF 043 - 544 NUIT » → « LF 043 - 440 ROSE DESIR »). */
export function articleClientFor(template: { coloris: string; article_client: string } | undefined, coloris: string): string {
  if (!template) return ''
  const a = template.article_client
  const prefix = a.includes(' - ') ? a.slice(0, a.indexOf(' - ') + 3) : ''
  return prefix ? `${prefix}${coloris}` : ''
}
