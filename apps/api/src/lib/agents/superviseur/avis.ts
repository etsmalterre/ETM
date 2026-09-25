// Agent « Superviseur » — what people said about each point of the report.
//
// Two separate things, one point each, kept twice: on the run (the record the
// next prompt version is written from) and here, by finding key, so the NEXT
// reports know it:
//
//   - a SCORE (AgentRun.avisPoints — réussite / partielle / échec + comment)
//     says whether the point was worth raising:
//       « échec » = false alarm: the point is set aside — listed under
//       « Écartés », never among the points to handle;
//       « partielle » / « réussite »: the point stays listed, showing its score;
//   - a RESOLUTION (AgentRun.resolutionsPoints — a mandatory explanation) says
//     the problem is dealt with even though ETM or the mailboxes cannot show it
//     (« PE l'a eu au téléphone »): the point moves to « Résolus » and stops
//     being a point to handle. It is not a score — a real problem handled by
//     phone is a réussite AND resolved.
//
// Both hold while the problem stays the same: when its empreinte changes (the
// client wrote again) they no longer apply and the point is listed afresh. An
// entry is dropped when its finding closes (scheduled run only), so a problem
// that comes back later starts fresh.
//
// Stored in data/agents/superviseur-avis.json and superviseur-resolutions.json
// (gitignored, next to the running API), like the findings memory.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { AGENTS_DIR, type Auteur, type Evaluation } from '../store.js'
import type { ConstatRun } from './constats.js'

interface Suivi {
  /** The run it was given on. */
  runId: string
  /** The point's title when it was given (the finding may be gone later). */
  titre: string
  /** Constat.empreinte when it was given. */
  empreinte?: string
}

export interface AvisPoint extends Evaluation, Suivi {}

/** « Résolu » by a person, with why. */
export interface Resolution {
  commentaire: string
  par: Auteur
  le: string
}
export interface ResolutionPoint extends Resolution, Suivi {}

export type IndexAvis = Record<string, AvisPoint>
export type IndexResolutions = Record<string, ResolutionPoint>

/** Does something said about a point still apply to it today? */
const valable = (s: Suivi | undefined, c: ConstatRun): boolean =>
  !!s && (s.empreinte === undefined || c.empreinte === undefined || s.empreinte === c.empreinte)

/** Split a report by what was said on earlier ones: points resolved by hand go
 *  to `resolus`, points scored « échec » are set aside, every other point is
 *  listed carrying its score, if any. Pure. */
export function appliquerSuivi(
  constats: ConstatRun[],
  avis: IndexAvis,
  resolutions: IndexResolutions = {},
): { listes: ConstatRun[]; ecartes: ConstatRun[]; resolus: ConstatRun[] } {
  const listes: ConstatRun[] = []
  const ecartes: ConstatRun[] = []
  const resolus: ConstatRun[] = []
  for (const c of constats) {
    const a = valable(avis[c.cle], c) ? avis[c.cle] : undefined
    const r = valable(resolutions[c.cle], c) ? resolutions[c.cle] : undefined
    const x: ConstatRun = { ...c }
    if (a) x.avis = { note: a.note, commentaire: a.commentaire, par: a.par, le: a.le }
    if (r) x.resolution = { commentaire: r.commentaire, par: r.par, le: r.le }
    if (r) resolus.push(x)
    else if (a?.note === 'echec') ecartes.push(x)
    else listes.push(x)
  }
  return { listes, ecartes, resolus }
}

// ── Persistence ──────────────────────────────────────────

let queue: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

/** One JSON object keyed by finding, read / set / pruned under one lock. */
function indexFichier<T>(nom: string) {
  const fichier = path.join(AGENTS_DIR, nom)
  const lire = async (): Promise<Record<string, T>> => {
    try {
      return JSON.parse(await fs.readFile(fichier, 'utf8')) as Record<string, T>
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw err
    }
  }
  const ecrire = async (index: Record<string, T>) => {
    await fs.mkdir(path.dirname(fichier), { recursive: true })
    const tmp = `${fichier}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(index, null, 1), 'utf8')
    await fs.rename(tmp, fichier)
  }
  return {
    lire,
    /** Record (or clear, with null) the entry of one finding. */
    enregistrer: (cle: string, v: T | null) => exclusive(async () => {
      const index = await lire()
      if (v) index[cle] = v
      else delete index[cle]
      await ecrire(index)
    }),
    /** Keep only the entries of findings still open (scheduled run). */
    purger: (ouverts: ReadonlySet<string>) => exclusive(async () => {
      const index = await lire()
      const garde = Object.fromEntries(Object.entries(index).filter(([cle]) => ouverts.has(cle)))
      if (Object.keys(garde).length !== Object.keys(index).length) await ecrire(garde)
    }),
  }
}

const avisIndex = indexFichier<AvisPoint>('superviseur-avis.json')
const resolutionsIndex = indexFichier<ResolutionPoint>('superviseur-resolutions.json')

export const lireAvis = avisIndex.lire
export const enregistrerAvis = avisIndex.enregistrer
export const purgerAvis = avisIndex.purger
export const lireResolutions = resolutionsIndex.lire
export const enregistrerResolution = resolutionsIndex.enregistrer
export const purgerResolutions = resolutionsIndex.purger
