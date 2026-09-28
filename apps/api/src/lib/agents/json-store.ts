// « Agents IA » — the JSON-file plumbing shared by the agents store
// (store.ts, data/agents/) and the automates store (lib/automates/store.ts,
// data/automates/). One queue for both: a single API process runs every
// agent and automate (scheduler.ts), and each write lands through tmp + rename.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

let queue: Promise<unknown> = Promise.resolve()
/** Serialise every read-modify-write of the stores. */
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw err
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 1), 'utf8')
  await fs.rename(tmp, file)
}
