// Agent « Superviseur » — every weekday at 05:00 (Paris) it runs its checks
// over ETM (IDsociete 1 only — never TRM nor mfprod) and the factory
// mailboxes, compares the findings with what it already reported, and leaves
// the report in Agents IA › Superviseur, where Isabelle reads it every morning.
// Plan: ~/.claude/plans/superviseur.md.
//
// No mail since 2026-09-23 (Isabelle: « pas besoin d'un mail chaque soir, je
// regarde le rapport le matin »): the run IS the report. Each point is scored
// on screen (réussite / partielle / échec + comment, avis.ts) — a point scored
// « échec » is a false alarm and is set aside in the next reports — and the
// run as a whole is scored the same way. Those comments are what the next
// prompt version is written from.
//
// Who may remember: only the scheduled run (par === null) updates the findings
// memory and prunes the scores of closed findings; a manual « Lancer
// maintenant » compares with the memory but never updates it — a 15:00 test
// must not turn tomorrow's new points into old ones.

import { ajouterRun, nouvelIdRun, type AgentRun, type AgentState, type AgentVersion, type Auteur, type RunStatut, type VersionInitiale } from '../store.js'
import { appliquerAvis, lireAvis, purgerAvis } from './avis.js'
import { comparer, ecrireMemoire, lireMemoire, type ConstatRun } from './constats.js'
import { CONTROLES } from './controles/index.js'
import { TRI_PROMPT_V1 } from './prompt.js'
import type { Constat, Domaine } from './types.js'

export const SUPERVISEUR_SLUG = 'superviseur'
/** Ready before anyone arrives, late enough to include the night's mails. */
export const SUPERVISEUR_HEURE = 5
/** ISO weekdays, 1 = Monday. */
export const SUPERVISEUR_JOURS: readonly number[] = [1, 2, 3, 4, 5]

export { SUPERVISEUR_BOITES } from './boites-liste.js'

export const SUPERVISEUR_VERSION_INITIALE: VersionInitiale = {
  model: 'mistral-small-latest',
  prompt: TRI_PROMPT_V1,
  note: 'Version initiale — tri des fils de mail (les contrôles de la base sont du code, sans prompt).',
}

/** What a Superviseur run stores in `resultat` (read by the web screen). */
export interface ResultatSuperviseur {
  controles: Array<{ id: string; libelle: string; domaine: Domaine; nb: number; dureeMs: number; erreur: string | null }>
  /** The points to handle, new first. */
  constats: ConstatRun[]
  /** Still returned by a check, but scored « échec » (false alarm) earlier. */
  ecartes: ConstatRun[]
  fermes: Array<{ cle: string; titre: string; domaine: Domaine; depuis: string }>
  /** Whether this run updated the findings memory (scheduled runs only). */
  memoireMiseAJour: boolean
}

const pluriel = (n: number, s: string, p = `${s}s`) => `${n} ${n > 1 ? p : s}`

export async function executer(state: AgentState, version: AgentVersion, par: Auteur | null): Promise<AgentRun[]> {
  if (state.mode === 'off') return []
  const t0 = Date.now()
  const nowIso = new Date(t0).toISOString()
  const planifie = par === null
  const id = nouvelIdRun()
  const base: Omit<AgentRun, 'statut' | 'resultat' | 'resume'> = {
    id,
    slug: SUPERVISEUR_SLUG,
    createdAt: nowIso,
    source: planifie ? 'planifie' : 'manuel',
    mode: state.mode,
    lancePar: par,
    message: null,
    fichiers: [],
    version: version.version,
    model: version.model,
    coutUsd: 0,
    dureeMs: 0,
  }

  try {
    const controles: ResultatSuperviseur['controles'] = []
    const trouves: Constat[] = []
    const enErreur = new Set<string>()
    let coutUsd = 0
    const ctx = { nowMs: t0, version, cout: (usd: number) => { coutUsd += usd || 0 } }
    // Sequential on purpose: HFSQL list queries are bimodal under load, and
    // one check at a time keeps the run's footprint on the shared server small.
    for (const c of CONTROLES) {
      const t = Date.now()
      try {
        const cs = await c.executer(ctx)
        trouves.push(...cs)
        controles.push({ id: c.id, libelle: c.libelle, domaine: c.domaine, nb: cs.length, dureeMs: Date.now() - t, erreur: null })
      } catch (err) {
        enErreur.add(c.id)
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[agents] ${SUPERVISEUR_SLUG}: check ${c.id} failed:`, msg)
        controles.push({ id: c.id, libelle: c.libelle, domaine: c.domaine, nb: 0, dureeMs: Date.now() - t, erreur: msg })
      }
    }

    const memoire = await lireMemoire()
    const cmp = comparer(memoire, trouves, nowIso, enErreur)
    if (planifie) {
      await ecrireMemoire(cmp.memoire)
      await purgerAvis(new Set(Object.keys(cmp.memoire.ouverts)))
    }
    const { listes, ecartes } = appliquerAvis(cmp.constats, await lireAvis())

    let statut: RunStatut = listes.length > 0 ? 'points_a_voir' : 'rien_a_signaler'
    let erreur: string | undefined
    if (CONTROLES.length > 0 && enErreur.size === CONTROLES.length) {
      statut = 'erreur'
      erreur = 'Tous les contrôles ont échoué (base inaccessible ?).'
    }

    const neufs = listes.filter((c) => c.etat !== 'ouvert').length
    const ouverts = listes.length - neufs
    const resultat: ResultatSuperviseur = {
      controles,
      constats: listes,
      ecartes,
      fermes: cmp.fermes.map((f) => ({ cle: f.constat.cle, titre: f.constat.titre, domaine: f.constat.domaine, depuis: f.depuis })),
      memoireMiseAJour: planifie,
    }
    const resume = [
      pluriel(neufs, 'nouveau point', 'nouveaux points'),
      pluriel(ouverts, 'toujours ouvert', 'toujours ouverts'),
      pluriel(cmp.fermes.length, 'résolu', 'résolus'),
      ecartes.length ? pluriel(ecartes.length, 'écarté', 'écartés') : null,
      enErreur.size ? pluriel(enErreur.size, 'contrôle en erreur', 'contrôles en erreur') : null,
    ]
      .filter(Boolean)
      .join(' · ')
    const run: AgentRun = { ...base, statut, resultat: resultat as unknown as Record<string, unknown>, resume, coutUsd, dureeMs: Date.now() - t0, erreur }
    await ajouterRun(run)
    return [run]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const run: AgentRun = { ...base, statut: 'erreur', resultat: {}, resume: 'Exécution interrompue', erreur: msg, dureeMs: Date.now() - t0 }
    await ajouterRun(run)
    return [run]
  }
}
