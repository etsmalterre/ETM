// Per-client VAT exemption file (LIVA #1248): the mention légale chosen for a
// French client at 0 % (lib/tva-mention.ts says why only the customer file
// can know it) and the attestations the client sends to justify it — SOFILETA
// sends an « attestation d'achat en franchise » every year, which Laetitia
// needs to keep with the fiche.
//
// Storage: `data/tva-exoneration.json` (keyed by IDclient) + the uploaded
// files under `data/tva-attestations/`, next to the other API-side stores
// (same choice as data/etiquettes-sp.json: no schema migration to ship).
// ⚠️ `data/` is server state — a deploy never touches it, a backup must.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { MentionClient } from './tva-mention.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.resolve(__dirname, '../../data')
const FILE_PATH = path.join(DATA_DIR, 'tva-exoneration.json')
const DOCS_DIR = path.join(DATA_DIR, 'tva-attestations')

/** Accepted attestation formats → stored extension. */
export const ATTESTATION_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
}

export interface AttestationTva {
  /** Random id, also the file's basename. */
  id: string
  /** Original file name, for display. */
  nom: string
  contentType: string
  taille: number
  /** ISO timestamp. */
  ajouteLe: string
  ajoutePar: number
}

export interface ExonerationClient {
  mention: MentionClient | null
  attestations: AttestationTva[]
}

interface StoreFile {
  version: 1
  clients: Record<string, ExonerationClient>
}

let cache: StoreFile | null = null
let writeChain: Promise<void> = Promise.resolve()

async function load(): Promise<StoreFile> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await fs.readFile(FILE_PATH, 'utf8')) as StoreFile
    if (parsed?.version !== 1) throw new Error('tva-exoneration.json: invalid shape')
    cache = { version: 1, clients: parsed.clients ?? {} }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Failed to load tva-exoneration.json:', err)
    cache = { version: 1, clients: {} }
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

function entry(f: StoreFile, IDclient: number): ExonerationClient {
  return f.clients[String(IDclient)] ?? { mention: null, attestations: [] }
}

function put(f: StoreFile, IDclient: number, e: ExonerationClient) {
  if (!e.mention && e.attestations.length === 0) delete f.clients[String(IDclient)]
  else f.clients[String(IDclient)] = e
}

export async function getExoneration(IDclient: number): Promise<ExonerationClient> {
  const e = entry(await load(), IDclient)
  return { mention: e.mention, attestations: [...e.attestations] }
}

export async function getMentionClient(IDclient: number): Promise<MentionClient | null> {
  if (!(IDclient > 0)) return null
  return entry(await load(), IDclient).mention
}

export async function setMentionClient(IDclient: number, mention: MentionClient | null): Promise<void> {
  await update((f) => { put(f, IDclient, { ...entry(f, IDclient), mention }) })
}

export async function addAttestation(
  IDclient: number,
  file: { nom: string; contentType: string; buffer: Buffer },
  ajoutePar: number,
): Promise<AttestationTva> {
  const ext = ATTESTATION_TYPES[file.contentType]
  if (!ext) throw new Error('unsupported content type')
  const doc: AttestationTva = {
    id: crypto.randomBytes(8).toString('hex'),
    nom: file.nom,
    contentType: file.contentType,
    taille: file.buffer.length,
    ajouteLe: new Date().toISOString(),
    ajoutePar,
  }
  await fs.mkdir(DOCS_DIR, { recursive: true })
  await fs.writeFile(path.join(DOCS_DIR, `${doc.id}.${ext}`), file.buffer)
  await update((f) => {
    const e = entry(f, IDclient)
    put(f, IDclient, { ...e, attestations: [doc, ...e.attestations] })
  })
  return doc
}

/** The file of one attestation of this client, or null. */
export async function getAttestationFile(
  IDclient: number,
  id: string,
): Promise<{ doc: AttestationTva; path: string } | null> {
  const doc = entry(await load(), IDclient).attestations.find((d) => d.id === id)
  if (!doc) return null
  return { doc, path: path.join(DOCS_DIR, `${doc.id}.${ATTESTATION_TYPES[doc.contentType]}`) }
}

export async function deleteAttestation(IDclient: number, id: string): Promise<boolean> {
  const found = await getAttestationFile(IDclient, id)
  if (!found) return false
  await update((f) => {
    const e = entry(f, IDclient)
    put(f, IDclient, { ...e, attestations: e.attestations.filter((d) => d.id !== id) })
  })
  await fs.unlink(found.path).catch(() => {})
  return true
}
