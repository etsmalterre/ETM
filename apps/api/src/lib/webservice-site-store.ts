// Snapshot, refresh and `date_modification` for the website catalogue
// (lib/webservice-site.ts builds the documents, routes/webservice-site.ts
// serves them).
//
// Every route answers from an in-memory snapshot, so a QR scan never waits on
// HFSQL (the legacy service took ~10 s per call, whatever the call). The
// snapshot is persisted to data/ and reloaded at start, so a restart serves at
// once; it is rebuilt in the background when older than the TTL (default 20
// min, WEBSERVICE_SITE_TTL_MIN) — the site calls in bursts (nightly sync, a
// few scans a day), so a stale-while-revalidate read is the right trade.
//
// `date_modification` is how the WordPress plugin decides to rebuild a product.
// The legacy service returned the row's own date, which a price change never
// touches (a new yarn price, a treatment band, a contract), so the shop kept
// stale prices for months. Here each document carries a content hash; when the
// hash changes, the document's date moves to the build time. The first build
// after go-live dates every document « now », which makes the shop refresh
// everything once — deliberately.

import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog } from './webservice-site-data.js'
import { buildSite, type Built, type RefInterneDoc, type RefProduitDoc, type SiteBuild } from './webservice-site.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../../data')
const SNAPSHOT_FILE = 'webservice-site-snapshot.json'
const STATE_FILE = 'webservice-site-state.json'

const TTL_MS = (Number(process.env.WEBSERVICE_SITE_TTL_MIN) || 20) * 60_000

/** Where the technical-sheet links point. alpha.etsmalterre.com is the public
 *  name the plugin already calls; at cutover Caddy points it here. */
export const PUBLIC_BASE_URL = (process.env.WEBSERVICE_SITE_PUBLIC_URL || 'https://alpha.etsmalterre.com').replace(/\/+$/, '')

export interface SiteSnapshot {
  version: 1
  builtAt: number
  buildMs: number
  refInterne: Record<string, RefInterneDoc>
  /** By IDdesignation_client. */
  refProduit: Record<string, { IDclient: number; doc: RefProduitDoc }>
  refColorisByClient: Record<string, { IDRef: number; IDColoris: number }[]>
  clients: SiteBuild['clients']
  categories: SiteBuild['categories']
}

interface StateFile {
  version: 1
  /** "ri:<id>" / "rp:<id>" → content hash + when it last changed (epoch ms). */
  entries: Record<string, { h: string; t: number }>
}

/** AAAAMMJJHHmm, local time — the legacy `date_modification` format. */
export function legacyStamp(ms: number): string {
  if (!(ms > 0)) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`
}

function hashDoc(doc: unknown): string {
  return createHash('sha1').update(JSON.stringify(doc)).digest('hex')
}

/** Stamp every document's `date_modification` = max(row date, last content
 *  change), updating `state` in place. Pure apart from `now`. */
export function applyDates<D extends { ref_produit: { date_modification: string } }>(
  prefix: string,
  built: Map<number, Built<D>>,
  state: StateFile,
  now: number,
): Map<number, D> {
  const out = new Map<number, D>()
  for (const [id, b] of built) {
    const key = `${prefix}:${id}`
    const h = hashDoc(b.doc) // hashed with date_modification still ''
    const prev = state.entries[key]
    const changedAt = prev && prev.h === h ? prev.t : now
    state.entries[key] = { h, t: changedAt }
    const doc = structuredClone(b.doc)
    doc.ref_produit.date_modification = legacyStamp(Math.max(b.sourceMs, changedAt))
    out.set(id, doc)
  }
  return out
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[webservice-site] unreadable ${file}:`, err)
    return null
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const target = path.join(DATA_DIR, file)
  await fs.writeFile(`${target}.tmp`, JSON.stringify(value), 'utf8')
  await fs.rename(`${target}.tmp`, target)
}

let current: SiteSnapshot | null = null
let loadedFromDisk = false
let building: Promise<SiteSnapshot> | null = null
let lastError: string | null = null

async function rebuild(): Promise<SiteSnapshot> {
  const t0 = Date.now()
  const cat = await loadCatalog()
  const today = legacyStamp(t0).slice(0, 8)
  const site = buildSite(cat, { publicBaseUrl: PUBLIC_BASE_URL, today })
  const state = (await readJson<StateFile>(STATE_FILE)) ?? { version: 1, entries: {} }
  const ri = applyDates('ri', site.refInterne, state, t0)
  const rpBuilt = new Map([...site.refProduit].map(([id, b]) => [id, { doc: b.doc, sourceMs: b.sourceMs }]))
  const rp = applyDates('rp', rpBuilt, state, t0)
  const snap: SiteSnapshot = {
    version: 1,
    builtAt: t0,
    buildMs: Date.now() - t0,
    refInterne: Object.fromEntries([...ri].map(([id, doc]) => [String(id), doc])),
    refProduit: Object.fromEntries([...rp].map(([id, doc]) => [String(id), { IDclient: site.refProduit.get(id)!.IDclient, doc }])),
    refColorisByClient: Object.fromEntries([...site.refColorisByClient].map(([id, pairs]) => [String(id), pairs])),
    clients: site.clients,
    categories: site.categories,
  }
  await writeJson(STATE_FILE, state)
  await writeJson(SNAPSHOT_FILE, snap)
  console.log(
    `[webservice-site] snapshot built in ${snap.buildMs} ms — ${ri.size} refs, ${rp.size} client products`,
  )
  return snap
}

function startBuild(): Promise<SiteSnapshot> {
  if (!building) {
    building = rebuild()
      .then((s) => {
        current = s
        lastError = null
        return s
      })
      .catch((err) => {
        lastError = err instanceof Error ? err.message : String(err)
        console.error('[webservice-site] snapshot build failed:', err)
        throw err
      })
      .finally(() => {
        building = null
      })
  }
  return building
}

/** The snapshot to answer from. Waits only when there is none at all (first
 *  start with no file); otherwise answers at once and refreshes behind. */
export async function getSiteSnapshot(): Promise<SiteSnapshot> {
  if (!current && !loadedFromDisk) {
    loadedFromDisk = true
    const disk = await readJson<SiteSnapshot>(SNAPSHOT_FILE)
    if (disk?.version === 1) current = disk
  }
  if (!current) return startBuild()
  if (Date.now() - current.builtAt > TTL_MS) startBuild().catch(() => { /* logged; keep serving the old one */ })
  return current
}

/** Force a rebuild now (admin / tests). */
export function refreshSiteSnapshot(): Promise<SiteSnapshot> {
  return startBuild()
}

export function siteSnapshotStatus(): { builtAt: number | null; buildMs: number | null; building: boolean; lastError: string | null; ttlMin: number } {
  return {
    builtAt: current?.builtAt ?? null,
    buildMs: current?.buildMs ?? null,
    building: building !== null,
    lastError,
    ttlMin: TTL_MS / 60_000,
  }
}
