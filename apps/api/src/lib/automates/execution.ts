// Agents IA › Automates — one run of an automate, and the tâches handed to
// the agents' scheduler (lib/agents/scheduler.ts, registered from index.ts).

import type { Auteur } from '../agents/store.js'
import type { RunResume, Tache } from '../agents/scheduler.js'
import { AUTOMATES, type AutomateDef, type Issue } from './catalog.js'
import { ajouterRun, lireEtat, lireRuns, marquerPlanification, noterControle, nouvelId, type AutomateRun } from './store.js'

/** The scheduler key of an automate (agents are keyed by their bare slug). */
export const cleTache = (slug: string) => `automate:${slug}`

/** Is this run worth keeping? A person's launch, a write and an error always;
 *  an hourly « nothing to change » never; an hourly essai proposal only when
 *  it differs from the last one kept (else the same diff lands every hour). */
export function aGarder(run: Pick<AutomateRun, 'source' | 'statut' | 'empreinte'>, dernierSimule: Pick<AutomateRun, 'empreinte'> | undefined): boolean {
  if (run.source !== 'planifie') return true
  if (run.statut === 'applique' || run.statut === 'erreur') return true
  if (run.statut === 'simule') return !dernierSimule || dernierSimule.empreinte !== run.empreinte
  return false
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function executerAutomate(def: AutomateDef, source: AutomateRun['source'], par: Auteur | null): Promise<RunResume[]> {
  const state = await lireEtat(def.slug)
  const resultat: Record<string, unknown> = {}
  const debut = Date.now()
  let issue: Issue
  let erreur: string | undefined
  try {
    if (source === 'arret') issue = def.quitterActif ? await def.quitterActif(resultat) : { statut: 'inchange', resume: 'Rien à remettre.' }
    else issue = await def.executer(state.mode === 'actif' ? 'actif' : 'essai', resultat)
  } catch (err) {
    erreur = message(err)
    issue = { statut: 'erreur', resume: erreur }
  }
  const run: AutomateRun = {
    id: nouvelId(),
    slug: def.slug,
    createdAt: new Date(debut).toISOString(),
    source,
    lancePar: par,
    mode: state.mode,
    version: def.version,
    statut: issue.statut,
    resume: issue.resume,
    dureeMs: Date.now() - debut,
    ...(erreur ? { erreur } : {}),
    ...(issue.empreinte ? { empreinte: issue.empreinte } : {}),
    resultat,
  }
  await noterControle(def.slug, { le: run.createdAt, statut: run.statut, resume: run.resume })
  const dernierSimule =
    run.source === 'planifie' && run.statut === 'simule'
      ? (await lireRuns(def.slug)).filter((r) => r.statut === 'simule').at(-1)
      : undefined
  if (aGarder(run, dernierSimule)) await ajouterRun(run)
  if (erreur) throw new Error(erreur)
  return [{ id: run.id, statut: run.statut, resume: run.resume }]
}

export function tachesAutomates(): Tache[] {
  return AUTOMATES.map((def) => ({
    cle: cleTache(def.slug),
    declenchement: def.declenchement,
    lireEtat: () => lireEtat(def.slug),
    marquerPlanification: (jour) => marquerPlanification(def.slug, jour),
    executer: (par) => executerAutomate(def, par ? 'manuel' : 'planifie', par),
  }))
}
