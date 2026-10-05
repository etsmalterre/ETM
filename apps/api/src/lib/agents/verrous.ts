// « Agents IA » — one lock per tâche (agent slug or `automate:<slug>`), shared
// by the scheduler tick, « Relever / Lancer maintenant » and the Triage's
// hand-off: two runs of the same agent never overlap (they would process the
// same mail twice).
//
// Its own module, with no import, so the Triage (lib/agents/triage/) can take
// a target agent's lock without importing the scheduler → catalog → triage
// cycle.

const enCours = new Set<string>()

export class SondageEnCoursError extends Error {
  constructor() {
    super('Une exécution est déjà en cours.')
  }
}

export function estVerrouille(cle: string): boolean {
  return enCours.has(cle)
}

/** Take the lock or throw SondageEnCoursError (synchronously checked). */
export function prendreVerrou(cle: string): void {
  if (enCours.has(cle)) throw new SondageEnCoursError()
  enCours.add(cle)
}

export function rendreVerrou(cle: string): void {
  enCours.delete(cle)
}

/** Run `fn` under a tâche's lock. Throws SondageEnCoursError when a run holds it. */
export async function sousVerrou<T>(cle: string, fn: () => Promise<T>): Promise<T> {
  prendreVerrou(cle)
  try {
    return await fn()
  } finally {
    rendreVerrou(cle)
  }
}

/** Like sousVerrou, but waits (up to `attenteMs`) for a run already holding it. */
export async function apresVerrou<T>(cle: string, fn: () => Promise<T>, attenteMs = 60_000): Promise<T> {
  const fin = Date.now() + attenteMs
  while (enCours.has(cle)) {
    if (Date.now() > fin) throw new SondageEnCoursError()
    await new Promise((r) => setTimeout(r, 500))
  }
  return sousVerrou(cle, fn)
}
