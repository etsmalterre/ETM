// Agent « Superviseur » — the history of its points: every point it ever
// raised, from the day it appeared to the day it closed, and how a person
// handled it. Backs the « Historique » of the Notifications widget, where
// Isabelle handles the points (decision 2026-09-28: the points are her work,
// the reports are the agent's log — Agents IA is the admin side).
//
// Needed because nothing else keeps a closed point: the findings memory
// (constats.ts) drops it, and avis.ts purges what was said about it once it
// closes. This journal is append-only in spirit — an entry is updated while
// its point lives, never removed (capped at MAX_ENTREES, oldest first).
//
// One entry per OCCURRENCE: `${cle}@${depuis}`. A point whose problem changes
// (the client wrote again — comparer() gives it a new `depuis`) or that comes
// back after closing is a new entry, like it is a new point for the widget.
//
// Stored in data/agents/superviseur-points.json (gitignored, next to the
// running API), like the findings memory.

import * as fs from 'node:fs/promises'
import { noteBinaire } from '../store.js'
import * as path from 'node:path'
import { AGENTS_DIR, type AgentRun, type Auteur, type Note } from '../store.js'
import type { ConstatRun } from './constats.js'
import type { Domaine, Gravite } from './types.js'

/** How a person settled a point (dashboard widget, LIVA #1272):
 *   - « traite »: the alert was real and dealt with: réussite, with an
 *     optional word on how (« appelée le 08/10 »);
 *   - « fausse_alerte »: « Former Tricobot › Ce point n'aurait pas dû
 *     remonter »: échec, why required.
 *  Entries written before #1272 may be a « traite » scored échec (the old
 *  « Tricobot s'est trompé ? » switch): shown « Traité · Tricobot corrigé ». */
export type Issue = 'traite' | 'fausse_alerte'

export interface Traitement {
  issue: Issue
  note: Note
  /** « traite »: how it was handled (may be empty); « fausse_alerte »: why. */
  commentaire: string
  par: Auteur
  le: string
}

/** « Former Tricobot › Tu pouvais aller chercher plus loin »: given at any time, on an
 *  open or a closed point, never settles it and is not a score. */
export interface Lecon {
  commentaire: string
  par: Auteur
  le: string
}

export interface PointHistorique {
  /** `${cle}@${depuis}` */
  id: string
  cle: string
  controle: string
  domaine: Domaine
  gravite: Gravite
  titre: string
  message: string
  lien: string | null
  /** ISO — first report that raised it. */
  depuis: string
  /** ISO — last report that raised it. */
  vuLe: string
  /** ISO — the scheduled run that no longer found it; null while open. */
  fermeLe: string | null
  /** Why the check let it pass (« Réponse de pierre-emmanuel le 24/09 »). */
  raisonFermeture: string | null
  traitement: Traitement | null
  /** Absent on entries written before #1272. */
  lecons?: Lecon[]
}

type Journal = Record<string, PointHistorique>

const FICHIER = path.join(AGENTS_DIR, 'superviseur-points.json')
/** A few points a day: years of history before this bites. */
const MAX_ENTREES = 5000

export const idPoint = (cle: string, depuis: string) => `${cle}@${depuis}`

async function lire(): Promise<Journal> {
  try {
    return JSON.parse(await fs.readFile(FICHIER, 'utf8')) as Journal
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

async function ecrire(j: Journal): Promise<void> {
  let entrees = Object.values(j)
  if (entrees.length > MAX_ENTREES) {
    entrees = entrees.sort((a, b) => b.vuLe.localeCompare(a.vuLe)).slice(0, MAX_ENTREES)
    j = Object.fromEntries(entrees.map((e) => [e.id, e]))
  }
  await fs.mkdir(path.dirname(FICHIER), { recursive: true })
  const tmp = `${FICHIER}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(j, null, 1), 'utf8')
  await fs.rename(tmp, FICHIER)
}

let queue: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

function depuisConstat(c: ConstatRun, nowIso: string, avant?: PointHistorique): PointHistorique {
  return {
    id: idPoint(c.cle, c.depuis),
    cle: c.cle,
    controle: c.controle,
    domaine: c.domaine,
    gravite: c.gravite,
    titre: c.titre,
    message: c.message,
    lien: c.lien,
    depuis: c.depuis,
    vuLe: nowIso,
    fermeLe: null,
    raisonFermeture: null,
    traitement: avant?.traitement ?? null,
    lecons: avant?.lecons ?? [],
  }
}

/** What one scheduled run saw: `ouverts` = every point it still returns
 *  (listed, set aside or résolu alike), `fermes` = the ones it no longer
 *  finds, with why. Pure apart from the file. */
export function journaliserRun(
  ouverts: ConstatRun[],
  fermes: Array<{ cle: string; depuis: string; raison: string }>,
  nowIso: string,
): Promise<void> {
  return exclusive(async () => {
    const j = await lire()
    for (const c of ouverts) {
      const id = idPoint(c.cle, c.depuis)
      j[id] = depuisConstat(c, nowIso, j[id])
    }
    for (const f of fermes) {
      const e = j[idPoint(f.cle, f.depuis)]
      if (e && !e.fermeLe) { e.fermeLe = nowIso; e.raisonFermeture = f.raison }
    }
    await ecrire(j)
  })
}

/** Record (or clear, with null) how a person handled a point. The entry is
 *  created if the point predates the journal. */
export function journaliserTraitement(c: ConstatRun, traitement: Traitement | null): Promise<void> {
  return exclusive(async () => {
    const j = await lire()
    const id = idPoint(c.cle, c.depuis)
    const e = j[id] ?? depuisConstat(c, new Date().toISOString())
    e.traitement = traitement
    j[id] = e
    await ecrire(j)
  })
}

/** Add a lesson to a point's entry (created if it predates the journal). */
export function journaliserLecon(c: ConstatRun, lecon: Lecon): Promise<void> {
  return exclusive(async () => {
    const j = await lire()
    const id = idPoint(c.cle, c.depuis)
    const e = j[id] ?? depuisConstat(c, new Date().toISOString())
    e.lecons = [...(e.lecons ?? []), lecon]
    j[id] = e
    await ecrire(j)
  })
}

/** One entry by id (`${cle}@${depuis}`), or null. */
export async function lireEntree(id: string): Promise<PointHistorique | null> {
  return (await lire())[id] ?? null
}

/** Lesson count by entry id: the widget's « Tricobot formé » chip. */
export async function nombreLecons(): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const e of Object.values(await lire())) if (e.lecons?.length) out.set(e.id, e.lecons.length)
  return out
}

/** Newest activity first. */
export async function lireHistorique(): Promise<PointHistorique[]> {
  const j = await lire()
  // Old « partielle » handlings read under the binary scale.
  for (const e of Object.values(j)) if (e.traitement) e.traitement = { ...e.traitement, note: noteBinaire(e.traitement.note) }
  for (const e of Object.values(j)) e.lecons ??= []
  const activite = (e: PointHistorique) =>
    [e.fermeLe, e.traitement?.le, e.vuLe, ...(e.lecons ?? []).map((l) => l.le)].filter(Boolean).sort().pop() as string
  return Object.values(j).sort((a, b) => activite(b).localeCompare(activite(a)))
}

/** The prompt version that raised each point, what Agents IA's « Points » tab
 *  filters on (same rule as scorePoints: a version owns the points it raised
 *  first). superviseur.ts stamps a new point's `depuis` with its run's
 *  `createdAt`, so the run is found exactly; failing that (a run past the runs
 *  file's cap), the last run before it. Only runs that updated the memory can
 *  raise a point (a manual preview does not). Null when no run is that old. */
export function versionDesPoints<P extends Pick<PointHistorique, 'depuis'>>(
  points: P[],
  runs: Array<Pick<AgentRun, 'createdAt' | 'version' | 'resultat'>>,
): Array<P & { version: number | null }> {
  const lanceurs = runs
    .filter((r) => (r.resultat as { memoireMiseAJour?: boolean } | null)?.memoireMiseAJour !== false)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const exact = new Map(lanceurs.map((r) => [r.createdAt, r.version]))
  return points.map((p) => {
    let version = exact.get(p.depuis) ?? null
    if (version === null) {
      for (const r of lanceurs) {
        if (r.createdAt > p.depuis) break
        version = r.version
      }
    }
    return { ...p, version }
  })
}
