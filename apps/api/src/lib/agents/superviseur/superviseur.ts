// Agent « Superviseur » — every weekday at 19:00 (Paris) it runs its checks
// over ETM (IDsociete 1 only — never TRM nor mfprod) and the factory
// mailboxes, compares the findings with what it already reported, and mails
// Vincent and Isabelle (subscribers of notif_agent_superviseur) only when
// something NEW needs attention. Plan: ~/.claude/plans/superviseur.md.
//
// Every run leaves one line in Agents IA › Exécutions, mail or not. A run is a
// success unless someone marks it « échouée » with a comment (verdict
// `incorrect` — the same field as BL MATEL's, different labels on screen).
//
// Who may send and who may remember:
//   - scheduled run (par === null): updates the findings memory; sends the mail
//     when the agent is « actif », only builds it in « essai »;
//   - manual « Lancer maintenant »: compares with the memory but never updates
//     it and never sends — a 15:00 test must not swallow the 19:00 mail.

import { notify } from '../../notify.js'
import { ajouterRun, nouvelIdRun, type AgentRun, type AgentState, type AgentVersion, type Auteur, type RunStatut, type VersionInitiale } from '../store.js'
import { comparer, doitEnvoyer, ecrireMemoire, lireMemoire, type ConstatRun } from './constats.js'
import { CONTROLES } from './controles/index.js'
import { construireMail, type MailSuperviseur } from './email.js'
import { TRI_PROMPT_V1 } from './prompt.js'
import type { Constat, Domaine } from './types.js'

export const SUPERVISEUR_SLUG = 'superviseur'
export const SUPERVISEUR_HEURE = 19
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
  constats: ConstatRun[]
  fermes: Array<{ cle: string; titre: string; domaine: Domaine; depuis: string }>
  /** Whether this run updated the findings memory (scheduled runs only). */
  memoireMiseAJour: boolean
  mail: (MailSuperviseur & { envoye: boolean; destinataires: number; raison: string }) | null
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
    if (planifie) await ecrireMemoire(cmp.memoire)

    let statut: RunStatut = 'rien_a_signaler'
    let erreur: string | undefined
    let mail: ResultatSuperviseur['mail'] = null
    if (doitEnvoyer(cmp.constats)) {
      const m = construireMail(cmp.constats, cmp.fermes.length, t0, `/agents-ia/agents?agent=${SUPERVISEUR_SLUG}&run=${id}`)
      if (planifie && state.mode === 'actif') {
        const r = await notify('notif_agent_superviseur', { subject: m.sujet, content: m.contenu })
        mail = { ...m, envoye: r.notified > 0, destinataires: r.notified, raison: `envoyé à ${pluriel(r.notified, 'abonné')}` }
        statut = r.notified > 0 ? 'mail_envoye' : 'erreur'
        if (!r.notified) erreur = 'Le mail n’a pu être envoyé à personne : aucun abonné à « Superviseur » avec une adresse email (Paramètres › Utilisateurs).'
      } else {
        mail = { ...m, envoye: false, destinataires: 0, raison: planifie ? 'agent en essai : mail préparé, non envoyé' : 'lancement manuel : mail préparé, non envoyé' }
        statut = 'simule'
      }
    }
    if (CONTROLES.length > 0 && enErreur.size === CONTROLES.length) {
      statut = 'erreur'
      erreur = 'Tous les contrôles ont échoué (base inaccessible ?).'
    }

    const neufs = cmp.constats.filter((c) => c.etat !== 'ouvert').length
    const ouverts = cmp.constats.length - neufs
    const resultat: ResultatSuperviseur = {
      controles,
      constats: cmp.constats,
      fermes: cmp.fermes.map((f) => ({ cle: f.constat.cle, titre: f.constat.titre, domaine: f.constat.domaine, depuis: f.depuis })),
      memoireMiseAJour: planifie,
      mail,
    }
    const resume = [
      pluriel(neufs, 'nouveau point', 'nouveaux points'),
      pluriel(ouverts, 'toujours ouvert', 'toujours ouverts'),
      pluriel(cmp.fermes.length, 'résolu', 'résolus'),
      enErreur.size ? pluriel(enErreur.size, 'contrôle en erreur', 'contrôles en erreur') : null,
      mail ? (mail.envoye ? 'mail envoyé' : 'mail non envoyé') : 'pas de mail',
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
