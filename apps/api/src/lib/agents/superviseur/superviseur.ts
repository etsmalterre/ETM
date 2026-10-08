// Agent « Superviseur »: every weekday at 05:00 and 13:00 (Paris) it runs its checks
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
// Résolus: a point closes by itself when its check stops returning it, and the
// report says WHY (each check records the reason it let an object pass —
// ContexteControle.raison: « Réponse de pierre-emmanuel le 24/09 », « Ligne
// couverte »). A person may also mark a point résolu with an explanation
// (avis.ts) — the phone call ETM cannot see: it moves to « Résolus » while the
// check still returns it, and that explanation is feedback for the next version.
//
// Who may remember: only the scheduled run (par === null) updates the findings
// memory and prunes the scores of closed findings; a manual « Lancer
// maintenant » compares with the memory but never updates it — a 15:00 test
// must not turn tomorrow's new points into old ones.

import { ajouterRun, nouvelIdRun, type AgentRun, type AgentState, type AgentVersion, type Auteur, type RunStatut, type VersionInitiale } from '../store.js'
import { appliquerSuivi, lireAvis, lireResolutions, purgerAvis, purgerResolutions, type Resolution } from './avis.js'
import { comparer, ecrireMemoire, lireMemoire, type ConstatRun } from './constats.js'
import { journaliserRun } from './historique.js'
import { CONTROLES } from './controles/index.js'
import { TRI_PROMPT_V1, TRI_PROMPT_V3 } from './prompt.js'
import type { Constat, Domaine } from './types.js'

export const SUPERVISEUR_SLUG = 'superviseur'
/** 05:00: ready before anyone arrives, late enough to include the night's
 *  mails. 13:00 (2026-10-08): closes by itself what the morning settled (a
 *  confirmation sent, pieces reserved) instead of leaving it in the list until
 *  tomorrow, catches up a failed morning (that day's DNS blip cost every mail
 *  check), and reads the morning's mails. Not more: the points are a daily
 *  to-do list, not a feed to chase. */
export const SUPERVISEUR_HEURE: readonly number[] = [5, 13]
/** ISO weekdays, 1 = Monday. */
export const SUPERVISEUR_JOURS: readonly number[] = [1, 2, 3, 4, 5]

export { SUPERVISEUR_BOITES } from './boites-liste.js'

export const SUPERVISEUR_VERSION_INITIALE: VersionInitiale = {
  model: 'mistral-small-latest',
  prompt: TRI_PROMPT_V1,
  note: 'Version initiale — tri des fils de mail (les contrôles de la base sont du code, sans prompt).',
}

/** v3 (2026-10-07), from Isabelle's scores on v1 + v2 — prompt.ts. */
export const SUPERVISEUR_PROMPT_LIVRE: VersionInitiale = {
  model: 'mistral-small-latest',
  prompt: TRI_PROMPT_V3,
  note: 'Version 3 — un mail archivé est traité (règle de la maison), commande reçue comparée ligne à ligne avec la source de chaque ligne, stock non affecté indiqué sur les pièces à affecter, un client qui « reviendra vers nous » n’attend rien (seule cette dernière règle est dans le prompt, le reste est du code).',
}

/** What a Superviseur run stores in `resultat` (read by the web screen). */
export interface ResultatSuperviseur {
  controles: Array<{ id: string; libelle: string; domaine: Domaine; nb: number; dureeMs: number; erreur: string | null }>
  /** The points to handle, new first. */
  constats: ConstatRun[]
  /** Still returned by a check, but scored « échec » (false alarm) earlier. */
  ecartes: ConstatRun[]
  /** Still returned by a check, but marked résolu by a person earlier. */
  resolus?: ConstatRun[]
  /** Closed since the last report: the check no longer returns them. */
  fermes: Array<{
    cle: string; titre: string; domaine: Domaine; depuis: string
    /** Why the check let it pass (absent on reports before 2026-09-25). */
    raison?: string
    /** Someone had marked it résolu before it closed. */
    resolution?: Resolution
  }>
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
    const raisons = new Map<string, string>()
    const ctx = {
      nowMs: t0,
      version,
      cout: (usd: number) => { coutUsd += usd || 0 },
      raison: (cle: string, texte: string) => { raisons.set(cle, texte) },
    }
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
    // Read before the purge: a closing point shows the résolu it carried.
    const [avisIndex, resolutionsIndex] = await Promise.all([lireAvis(), lireResolutions()])
    if (planifie) {
      const ouvertes = new Set(Object.keys(cmp.memoire.ouverts))
      await ecrireMemoire(cmp.memoire)
      await purgerAvis(ouvertes)
      await purgerResolutions(ouvertes)
    }
    const { listes, ecartes, resolus } = appliquerSuivi(cmp.constats, avisIndex, resolutionsIndex)
    const absent = new Map(CONTROLES.map((c) => [c.id, c.raisonAbsent]))
    const raisonFermeture = (cle: string, controle: string) =>
      raisons.get(cle) ?? absent.get(controle) ?? 'Le contrôle ne le signale plus.'
    // The points' history (historique.ts) follows the memory: scheduled runs only.
    if (planifie) {
      await journaliserRun(
        cmp.constats,
        cmp.fermes.map((f) => ({ cle: f.constat.cle, depuis: f.depuis, raison: raisonFermeture(f.constat.cle, f.constat.controle) })),
        nowIso,
      )
    }

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
      resolus,
      fermes: cmp.fermes.map((f) => {
        const r = resolutionsIndex[f.constat.cle]
        return {
          cle: f.constat.cle,
          titre: f.constat.titre,
          domaine: f.constat.domaine,
          depuis: f.depuis,
          raison: raisonFermeture(f.constat.cle, f.constat.controle),
          ...(r ? { resolution: { commentaire: r.commentaire, par: r.par, le: r.le } } : {}),
        }
      }),
      memoireMiseAJour: planifie,
    }
    const resume = [
      pluriel(neufs, 'nouveau point', 'nouveaux points'),
      pluriel(ouverts, 'toujours ouvert', 'toujours ouverts'),
      // Points handled earlier and still found are not news: not counted.
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
