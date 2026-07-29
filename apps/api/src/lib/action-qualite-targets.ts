// Per-action "objectif de conformités" — how many Conforme results the user
// wants to see before considering a quality action settled.
//
// This is a MPS_NG addition: legacy `action_qualite` has only the manual
// `terminé` flag and no column to hold a target, and the WinDev app still reads
// that table, so we keep the target in a JSON side-store rather than altering
// the HFSQL analysis. Same shape and atomic-write discipline as
// lib/user-profiles.ts.
//
// The target is deliberately advisory: reaching it surfaces an "objectif
// atteint" cue on the screen, but nothing is ever archived automatically —
// closing an action stays the responsable qualité's call.
//
// ⚠️ TODO (post data-migration): fold into real DB storage alongside the other
// JSON side-stores. The public API here is storage-agnostic.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.resolve(__dirname, '../../data')
const FILE_PATH = path.join(DATA_DIR, 'action-qualite-targets.json')

/** Guard rails, not design constraints — just keep a typo from storing 1e9. */
export const MIN_TARGET = 1
export const MAX_TARGET = 999

interface TargetsFile {
  version: 1
  /** keyed by IDaction_qualite as a string (JSON object keys must be strings) */
  targets: Record<string, number>
}

const EMPTY: TargetsFile = { version: 1, targets: {} }

let cache: TargetsFile | null = null

async function load(): Promise<TargetsFile> {
  if (cache !== null) return cache
  try {
    const raw = await fs.readFile(FILE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as TargetsFile
    if (
      typeof parsed !== 'object' || parsed === null ||
      parsed.version !== 1 || typeof parsed.targets !== 'object'
    ) {
      throw new Error('action-qualite-targets.json: invalid shape')
    }
    cache = parsed
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      cache = { version: 1, targets: {} }
    } else {
      console.error('Failed to load action-qualite-targets.json:', err)
      cache = { ...EMPTY, targets: {} }
    }
  }
  return cache
}

async function save(file: TargetsFile): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const tmp = `${FILE_PATH}.tmp`
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
  await fs.rename(tmp, FILE_PATH)
  cache = file
}

/** Targets for every action that has one, keyed by id. */
export async function getAllTargets(): Promise<Map<number, number>> {
  const file = await load()
  const map = new Map<number, number>()
  for (const [k, v] of Object.entries(file.targets)) {
    const id = Number(k)
    const target = Number(v)
    if (Number.isInteger(id) && Number.isInteger(target) && target >= MIN_TARGET) map.set(id, target)
  }
  return map
}

export async function getTarget(actionId: number): Promise<number | null> {
  return (await getAllTargets()).get(actionId) ?? null
}

/** Set (or clear, with `null`) an action's target. Clearing prunes the key so
 *  the file doesn't accumulate dead entries. */
export async function setTarget(actionId: number, target: number | null): Promise<void> {
  const file = await load()
  const next: TargetsFile = { version: 1, targets: { ...file.targets } }
  if (target === null) {
    delete next.targets[String(actionId)]
  } else {
    const clamped = Math.min(MAX_TARGET, Math.max(MIN_TARGET, Math.trunc(target)))
    next.targets[String(actionId)] = clamped
  }
  await save(next)
}
