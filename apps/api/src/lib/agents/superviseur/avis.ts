// Agent « Superviseur » — what people said about each point of the report.
//
// A score given on one point (Agents IA › Superviseur › an execution) is kept
// twice: on the run (AgentRun.avisPoints — the record the next prompt version
// is written from) and here, by finding key, so the NEXT reports know it:
//   - « échec » = the point is wrong (false alarm): it is set aside — listed
//     under « Écartés », never among the points to handle — for as long as the
//     check keeps returning it;
//   - « partielle » / « réussite »: the point stays listed, showing its score.
// An entry is dropped when its finding closes (scheduled run only), so a
// problem that comes back later starts fresh.
//
// Stored in data/agents/superviseur-avis.json (gitignored, next to the running
// API), like the findings memory in constats.ts.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { AGENTS_DIR, type Evaluation } from '../store.js'
import type { ConstatRun } from './constats.js'

export interface AvisPoint extends Evaluation {
  /** The run it was given on. */
  runId: string
  /** The point's title when it was scored (the finding may be gone later). */
  titre: string
}

export type IndexAvis = Record<string, AvisPoint>

/** Split a report by the scores already given: points scored « échec » are set
 *  aside; every other point carries its score, if any. Pure. */
export function appliquerAvis(constats: ConstatRun[], avis: IndexAvis): { listes: ConstatRun[]; ecartes: ConstatRun[] } {
  const listes: ConstatRun[] = []
  const ecartes: ConstatRun[] = []
  for (const c of constats) {
    const a = avis[c.cle]
    const avecAvis: ConstatRun = a ? { ...c, avis: { note: a.note, commentaire: a.commentaire, par: a.par, le: a.le } } : c
    if (a?.note === 'echec') ecartes.push(avecAvis)
    else listes.push(avecAvis)
  }
  return { listes, ecartes }
}

// ── Persistence ──────────────────────────────────────────

const FICHIER = path.join(AGENTS_DIR, 'superviseur-avis.json')

let queue: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

export async function lireAvis(): Promise<IndexAvis> {
  try {
    return JSON.parse(await fs.readFile(FICHIER, 'utf8')) as IndexAvis
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

async function ecrire(index: IndexAvis): Promise<void> {
  await fs.mkdir(path.dirname(FICHIER), { recursive: true })
  const tmp = `${FICHIER}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(index, null, 1), 'utf8')
  await fs.rename(tmp, FICHIER)
}

/** Record (or clear, with null) the score of one finding. */
export function enregistrerAvis(cle: string, avis: AvisPoint | null): Promise<void> {
  return exclusive(async () => {
    const index = await lireAvis()
    if (avis) index[cle] = avis
    else delete index[cle]
    await ecrire(index)
  })
}

/** Keep only the scores of findings still open (scheduled run). */
export function purgerAvis(ouverts: ReadonlySet<string>): Promise<void> {
  return exclusive(async () => {
    const index = await lireAvis()
    const garde = Object.fromEntries(Object.entries(index).filter(([cle]) => ouverts.has(cle)))
    if (Object.keys(garde).length !== Object.keys(index).length) await ecrire(garde)
  })
}
