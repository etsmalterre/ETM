// Agent « Superviseur » — the findings memory.
//
// Without it the morning report would repeat the same forty lines every day
// and be ignored within a week. A finding seen yesterday is « toujours ouvert »
// (one compact line), not a new alert; a finding whose gravity rose is
// « aggravé » and counts like a new one; a finding no check returns any more
// is closed. A check that FAILED this run closes nothing: an HFSQL hiccup is
// not a problem solved.
//
// Only the scheduled run updates the memory (superviseur.ts): a manual
// « Lancer maintenant » at 15:00 must not turn tomorrow's new points into old ones.
//
// Stored in data/agents/superviseur-constats.json (gitignored, next to the
// running API) until the PostgreSQL cutover, like the rest of lib/agents/.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { AGENTS_DIR, type Evaluation } from '../store.js'
import { GRAVITE_RANG, type Constat } from './types.js'

export interface ConstatOuvert {
  constat: Constat
  /** ISO — first run that returned it. */
  depuis: string
  /** ISO — last run that returned it. */
  vuLe: string
}

export interface Memoire {
  ouverts: Record<string, ConstatOuvert>
  majLe: string | null
}

export type EtatConstat = 'nouveau' | 'aggrave' | 'ouvert'

export interface ConstatRun extends Constat {
  etat: EtatConstat
  depuis: string
  /** The score someone gave this finding on an earlier report (avis.ts). */
  avis?: Pick<Evaluation, 'note' | 'commentaire' | 'par' | 'le'>
  /** Someone marked it resolved on an earlier report (resolutions.ts). */
  resolution?: Pick<Evaluation, 'commentaire' | 'par' | 'le'>
}

/** Same finding, but not the same problem any more (the client wrote again). */
export const empreinteChangee = (avant: Constat, apres: Constat) =>
  avant.empreinte !== undefined && apres.empreinte !== undefined && avant.empreinte !== apres.empreinte

export const memoireVide = (): Memoire => ({ ouverts: {}, majLe: null })

/** Several checks may return the same key (or one check twice): keep the gravest. */
export function dedoublonner(constats: Constat[]): Constat[] {
  const parCle = new Map<string, Constat>()
  for (const c of constats) {
    const d = parCle.get(c.cle)
    if (!d || GRAVITE_RANG[c.gravite] > GRAVITE_RANG[d.gravite]) parCle.set(c.cle, c)
  }
  return [...parCle.values()]
}

/** Compare today's findings with the memory. Pure — the caller decides whether
 *  to persist `memoire`. `controlesEnErreur`: their open findings stay open. */
export function comparer(
  memoire: Memoire,
  constats: Constat[],
  nowIso: string,
  controlesEnErreur: ReadonlySet<string> = new Set(),
): { constats: ConstatRun[]; fermes: ConstatOuvert[]; memoire: Memoire } {
  const ouverts: Record<string, ConstatOuvert> = {}
  const runs: ConstatRun[] = []
  for (const c of dedoublonner(constats)) {
    const prec = memoire.ouverts[c.cle]
    // A client who writes again in the same conversation raises a new point.
    const avant = prec && !empreinteChangee(prec.constat, c) ? prec : undefined
    const etat: EtatConstat = !avant ? 'nouveau' : GRAVITE_RANG[c.gravite] > GRAVITE_RANG[avant.constat.gravite] ? 'aggrave' : 'ouvert'
    const depuis = avant?.depuis ?? nowIso
    ouverts[c.cle] = { constat: c, depuis, vuLe: nowIso }
    runs.push({ ...c, etat, depuis })
  }
  const fermes: ConstatOuvert[] = []
  for (const [cle, o] of Object.entries(memoire.ouverts)) {
    if (ouverts[cle]) continue
    if (controlesEnErreur.has(o.constat.controle)) ouverts[cle] = o
    else fermes.push(o)
  }
  return { constats: trier(runs), fermes, memoire: { ouverts, majLe: nowIso } }
}

const RANG_ETAT: Record<EtatConstat, number> = { nouveau: 0, aggrave: 0, ouvert: 1 }

/** New/aggravated first, then by gravity (urgent first), then oldest first. */
export function trier(cs: ConstatRun[]): ConstatRun[] {
  return [...cs].sort(
    (a, b) =>
      RANG_ETAT[a.etat] - RANG_ETAT[b.etat] ||
      GRAVITE_RANG[b.gravite] - GRAVITE_RANG[a.gravite] ||
      a.depuis.localeCompare(b.depuis) ||
      a.titre.localeCompare(b.titre, 'fr'),
  )
}

// ── Persistence ──────────────────────────────────────────

const FICHIER = path.join(AGENTS_DIR, 'superviseur-constats.json')

export async function lireMemoire(): Promise<Memoire> {
  try {
    return JSON.parse(await fs.readFile(FICHIER, 'utf8')) as Memoire
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return memoireVide()
    throw err
  }
}

export async function ecrireMemoire(m: Memoire): Promise<void> {
  await fs.mkdir(path.dirname(FICHIER), { recursive: true })
  const tmp = `${FICHIER}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(m, null, 1), 'utf8')
  await fs.rename(tmp, FICHIER)
}
