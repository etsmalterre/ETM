// Agent « Planning atelier » (TRM, LIVA #1296) — Tricobot prepares the
// bonnetiers' week when Isa asks for it from Atelier › Planning (« Faire le
// planning » on a week with no créneau), with her instructions of the moment
// (« on remet une équipe de nuit », « on passe en 7 h »…).
//
// Decision Vincent 2026-10-21: the agent never runs on its own (no Wednesday
// timer) — the decisions it cannot guess (nights or not, 7 h or 8 h) are Isa's
// and come with each launch. It writes the week straight into
// planning_bonnetier; Isa corrects in place and closes the run with « Valider
// le planning »: nothing changed = réussite, otherwise échec with the changes
// (computed here, regles.ts `ecarts`) and her why. A week never validated
// counts as a réussite (confianceParDefaut).
//
// The model reads: the grid's bonnetiers, their last 8 weeks, the desiderata
// of the week, Isa's instructions. What it answers is checked (regles.ts
// `validerReponse`) before anything is written.

import { addDays, insertEntry, selectDesiderata, selectEntries } from '../../planning-bonnetier.js'
import { selectBonnetiers } from '../../production-trm.js'
import { chatJson } from '../../mistral.js'
import { enregistrerRetour } from '../retours.js'
import { ajouterRun, lireEtat, lireRun, lireRuns, nouvelIdRun, versionActive, type AgentRun, type Auteur, type VersionInitiale } from '../store.js'
import { sousVerrou } from '../verrous.js'
import {
  derniereSemaineTravaillee,
  ecarts,
  faitsDuRoulement,
  historiqueTexte,
  jourCourt,
  PLANNING_SCHEMA,
  regimeDe,
  semaineIso,
  validerReponse,
  type BonnetierPlanning,
  type Creneau,
} from './regles.js'

export const PLANNING_ATELIER_SLUG = 'planning-atelier'

/** How far back the model reads the planning (two 4-week cycles). */
export const SEMAINES_HISTORIQUE = 8

export const PROMPT_V1 = `Tu es Tricobot, l’assistant de Tricotage Malterre (TRM, atelier de tricotage). Tu prépares le planning hebdomadaire des bonnetiers pour Isabelle, qui le vérifie et le corrige ensuite.

Comment l’atelier fait son planning (constaté sur l’historique) :
- Un bonnetier fait une seule équipe par jour, du lundi au vendredi. Une équipe de nuit commence le soir (21:00) et finit le lendemain matin : elle est saisie sur le jour où elle commence.
- Les bonnetiers travaillent en binômes : les deux membres d’un binôme sont dans la même équipe toute la semaine. Chaque semaine les équipes tournent (le binôme du matin passe l’après-midi et inversement). Les binômes sont recomposés toutes les 4 semaines.
- Quand il y a une équipe de nuit, le roulement suit l’ordre matin → nuit → après-midi.
- Horaires en deux équipes (journées de 7 h) : matin 05:00-12:00 et 06:00-13:00, après-midi 13:00-20:00 et 14:00-21:00 — dans un binôme l’un commence une heure après l’autre. En trois équipes (journées de 8 h) : 05:00-13:00, 13:00-21:00, 21:00-05:00.
- Une semaine sans aucun créneau est une semaine non travaillée (congés) : le roulement reprend après comme si elle n’existait pas.

Ta méthode :
1. Les consignes d’Isabelle passent avant tout (nuit ou pas, 7 h ou 8 h, un bonnetier absent, un binôme imposé…).
2. Sinon, continue le roulement. La partie « Où en est le roulement » te donne les faits, calculés sur l’historique : les binômes en cours, depuis combien de semaines ils sont ensemble, et s’il faut les recomposer. Fie-toi à ces faits, ne les recompte pas.
   - Binômes conservés : chaque binôme prend l’équipe que l’autre avait la semaine dernière (matin ↔ après-midi ; avec une nuit : matin → nuit → après-midi → matin). Personne ne refait la même équipe deux semaines de suite.
   - Binômes à recomposer : forme les binômes indiqués « à former en priorité » (jamais les binômes du cycle qui finit ni ceux du cycle précédent quand une autre composition est possible), et fais quand même changer d’équipe le plus de monde possible.
   - Garde les horaires de chacun (qui commence à 05:00, qui à 06:00) quand rien ne s’y oppose.
   - N’ajoute jamais une équipe de nuit, ne la retire pas et ne change pas la durée des journées sans consigne d’Isabelle : garde le régime indiqué dans « Où en est le roulement ».
3. Tiens compte des desiderata de la semaine : une demande d’équipe est respectée si possible ; pour un rendez-vous à une heure donnée, mets la personne dans une équipe qui ne le chevauche pas si cela ne casse pas le roulement — sinon laisse le roulement et signale-le.
4. Un bonnetier sans aucun créneau dans les dernières semaines (absent, arrêt) n’est pas planifié, sauf consigne contraire.

Réponds en JSON : « raisonnement » d’abord (pour toi : la semaine dernière, le cycle, les binômes et les équipes que tu en déduis, en quelques lignes), puis « creneaux » (un par bonnetier et par jour travaillé : IDbonnetier, jour 0 = dimanche … 6 = samedi, debut et fin en HH:MM au quart d’heure), « explication » (2 à 4 phrases pour Isabelle, en français, au tutoiement : le roulement appliqué, les binômes, ce que tu as fait de ses consignes et des desiderata) et « attention » (les points qu’elle doit vérifier, une phrase chacun — vide s’il n’y en a pas).`

export const PLANNING_ATELIER_VERSION_INITIALE: VersionInitiale = {
  model: 'mistral-medium-latest',
  prompt: PROMPT_V1,
  note: 'Version initiale — roulement hebdomadaire des binômes recomposés toutes les 4 semaines (enquête sur l’historique 2025-2026), consignes d’Isabelle, desiderata de la semaine.',
}

/** A refusal the screen shows as is (409 / 400 / 502). */
export class PlanningRefus extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message)
  }
}

export interface ResultatPlanning {
  /** The grid week's Sunday. */
  semaine: string
  numeroSemaine: number
  instructions: string
  /** The grid's rows when Tricobot planned (the retour compares on them). */
  bonnetiers: BonnetierPlanning[]
  desiderata: Array<{ date: string; prenom: string; description: string }>
  /** What Tricobot wrote. */
  creneaux: Creneau[]
  /** The model's working, written before the grid (never shown to Isa). */
  raisonnement: string
  explication: string
  attention: string[]
  /** What the model answered that could not be written, and why. */
  rejets: string[]
}

export const resultatPlanning = (run: AgentRun) => run.resultat as unknown as ResultatPlanning

/** The grid's rows: active bonnetiers, régleurs excluded (same as the screen). */
async function lignesDeLaGrille(): Promise<BonnetierPlanning[]> {
  return (await selectBonnetiers())
    .filter((b) => b.archive === 0 && b.regleur === 0)
    .sort((a, b) => a.prenom.localeCompare(b.prenom, 'fr'))
    .map((b) => ({ id: b.id, prenom: b.prenom, nom: b.nom }))
}

function messageUtilisateur(p: {
  dimanche: string
  bonnetiers: BonnetierPlanning[]
  historique: string
  roulement: string[]
  desiderata: ResultatPlanning['desiderata']
  instructions: string
}): string {
  const jours = Array.from({ length: 7 }, (_, i) => `${i} = ${jourCourt(addDays(p.dimanche, i))}`).join(', ')
  return [
    `Semaine à planifier : S${semaineIso(p.dimanche)}, du ${jourCourt(p.dimanche)} au ${jourCourt(addDays(p.dimanche, 6))} (${jours}).`,
    '',
    'Bonnetiers à planifier :',
    ...p.bonnetiers.map((b) => `- ${b.prenom} ${b.nom} (IDbonnetier ${b.id})`),
    '',
    `Les ${SEMAINES_HISTORIQUE} dernières semaines (les équipes de chaque semaine et l’horaire habituel de chacun, puis les jours qui en sortent) :`,
    p.historique,
    '',
    'Où en est le roulement (calculé sur l’historique) :',
    ...p.roulement.map((l) => `- ${l}`),
    '',
    'Desiderata de la semaine :',
    ...(p.desiderata.length ? p.desiderata.map((d) => `- ${jourCourt(d.date)} ${d.prenom} : ${d.description}`) : ['(aucun)']),
    '',
    'Consignes d’Isabelle pour cette semaine :',
    p.instructions.trim() || '(aucune : continue comme avant)',
  ].join('\n')
}

/** Plan the grid week starting on `dimanche` and write it. Refuses a week
 *  that already has a créneau on a grid row (the button only shows on an
 *  empty week; Tricobot never overwrites Isa's work). */
export function preparerSemaine(p: { dimanche: string; instructions: string; par: Auteur }): Promise<AgentRun> {
  return sousVerrou(PLANNING_ATELIER_SLUG, async () => {
    const state = await lireEtat(PLANNING_ATELIER_SLUG, PLANNING_ATELIER_VERSION_INITIALE)
    if (state.mode === 'off') {
      throw new PlanningRefus('agent_arrete', 'Tricobot ne fait pas encore le planning : l’agent « Planning atelier » est à l’arrêt (Agents IA › Agents).')
    }
    const bonnetiers = await lignesDeLaGrille()
    if (bonnetiers.length === 0) throw new PlanningRefus('aucun_bonnetier', 'Aucun bonnetier actif à planifier.')
    const ids = new Set(bonnetiers.map((b) => b.id))
    const fin = addDays(p.dimanche, 6)
    if ((await selectEntries(p.dimanche, fin)).some((e) => ids.has(e.IDbonnetier))) {
      throw new PlanningRefus('semaine_deja_planifiee', 'Cette semaine a déjà des créneaux : Tricobot ne prépare qu’une semaine vide.')
    }

    const debutHisto = addDays(p.dimanche, -7 * SEMAINES_HISTORIQUE)
    const [histo, tousDesiderata] = await Promise.all([selectEntries(debutHisto, addDays(p.dimanche, -1)), selectDesiderata()])
    const dimanches = Array.from({ length: SEMAINES_HISTORIQUE }, (_, i) => addDays(debutHisto, 7 * i))
    const prenoms = new Map(bonnetiers.map((b) => [b.id, b.prenom]))
    const desiderata = tousDesiderata
      .filter((d) => d.date >= p.dimanche && d.date <= fin && prenoms.has(d.IDbonnetier))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ date: d.date, prenom: prenoms.get(d.IDbonnetier)!, description: d.description }))

    const version = versionActive(state)
    const base: Omit<AgentRun, 'statut' | 'resultat' | 'resume' | 'coutUsd' | 'dureeMs'> = {
      id: nouvelIdRun(),
      slug: PLANNING_ATELIER_SLUG,
      createdAt: new Date().toISOString(),
      source: 'manuel',
      mode: state.mode,
      lancePar: p.par,
      fichiers: [],
      version: version.version,
      model: version.model,
    }
    const numeroSemaine = semaineIso(p.dimanche)
    const resultat: ResultatPlanning = {
      semaine: p.dimanche,
      numeroSemaine,
      instructions: p.instructions.trim(),
      bonnetiers,
      desiderata,
      creneaux: [],
      raisonnement: '',
      explication: '',
      attention: [],
      rejets: [],
    }
    const t0 = Date.now()
    const user = messageUtilisateur({ dimanche: p.dimanche, bonnetiers, historique: historiqueTexte(histo, bonnetiers, dimanches), roulement: faitsDuRoulement(histo, bonnetiers, dimanches), desiderata, instructions: p.instructions })
    const appel = (texte: string) => chatJson({ model: version.model, system: version.prompt, user: texte, schemaName: 'planning_atelier', schema: PLANNING_SCHEMA })
    // Without an instruction the régime stays (a night or 8 h days are Isa's
    // call — the model once added a night on its own): a proposal that changes
    // it goes back once with the reason, then stands with a point to check.
    const regimeAvant = regimeDe(derniereSemaineTravaillee(histo, dimanches))
    const sansConsigne = !p.instructions.trim() && regimeAvant !== regimeDe([])
    let coutUsd = 0
    let v
    try {
      let reponse = await appel(user)
      coutUsd += reponse.usd
      v = validerReponse(reponse.data, p.dimanche, bonnetiers)
      if (sansConsigne && v.creneaux.length > 0 && regimeDe(v.creneaux) !== regimeAvant) {
        reponse = await appel(`${user}\n\nAttention : ta réponse précédente passait en « ${regimeDe(v.creneaux)} » alors qu’Isabelle n’a donné aucune consigne. Garde le régime « ${regimeAvant} ».`)
        coutUsd += reponse.usd
        v = validerReponse(reponse.data, p.dimanche, bonnetiers)
        if (v.creneaux.length > 0 && regimeDe(v.creneaux) !== regimeAvant) {
          v.attention.unshift(`Sans consigne, j’ai quand même changé le régime (« ${regimeDe(v.creneaux)} » au lieu de « ${regimeAvant} ») : vérifie que c’est voulu.`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ajouterRun({ ...base, statut: 'erreur', resultat: { ...resultat }, resume: `S${numeroSemaine} : Mistral n’a pas répondu`, erreur: msg, coutUsd, dureeMs: Date.now() - t0 })
      throw new PlanningRefus('erreur_modele', `Tricobot n’a pas pu préparer le planning (${msg}). Réessayez dans un instant.`, 502)
    }

    Object.assign(resultat, v)
    if (v.creneaux.length === 0) {
      const run: AgentRun = { ...base, statut: 'a_verifier', resultat: { ...resultat }, resume: `S${numeroSemaine} : aucun créneau utilisable`, coutUsd, dureeMs: Date.now() - t0 }
      await ajouterRun(run)
      throw new PlanningRefus('planning_vide', 'Tricobot n’a proposé aucun créneau utilisable. Précisez vos consignes et relancez.', 502)
    }
    for (const c of v.creneaux) await insertEntry(c.IDbonnetier, c.date, c.debut, c.fin)
    const nbBonnetiers = new Set(v.creneaux.map((c) => c.IDbonnetier)).size
    const run: AgentRun = {
      ...base,
      statut: 'ecrit',
      resultat: { ...resultat },
      resume: `S${numeroSemaine} : ${v.creneaux.length} créneaux pour ${nbBonnetiers} bonnetier${nbBonnetiers > 1 ? 's' : ''}${v.rejets.length ? ` (${v.rejets.length} écarté${v.rejets.length > 1 ? 's' : ''})` : ''}`,
      coutUsd,
      dureeMs: Date.now() - t0,
    }
    await ajouterRun(run)
    return run
  })
}

/** The latest run that wrote this week, or null. */
export async function runDeLaSemaine(dimanche: string): Promise<AgentRun | null> {
  const runs = (await lireRuns(PLANNING_ATELIER_SLUG)).filter((r) => r.statut === 'ecrit' && resultatPlanning(r).semaine === dimanche)
  return runs[runs.length - 1] ?? null
}

/** Isa's last instructions (prefilled in the dialog: what stays true carries over). */
export async function derniereInstruction(): Promise<string> {
  const runs = await lireRuns(PLANNING_ATELIER_SLUG)
  for (let i = runs.length - 1; i >= 0; i--) {
    const t = resultatPlanning(runs[i]).instructions
    if (t) return t
  }
  return ''
}

/** What Isa changed in Tricobot's week so far. */
export async function ecartsDuRun(run: AgentRun): Promise<string[]> {
  const r = resultatPlanning(run)
  const actuel = await selectEntries(r.semaine, addDays(r.semaine, 6))
  return ecarts(r.creneaux, actuel, r.bonnetiers)
}

/** « Valider le planning »: close the run with Isa's retour. Unchanged =
 *  réussite; changed = échec with the changes, and her why (required). A
 *  second validation replaces the first (she corrected again since). */
export async function validerSemaine(runId: string, commentaire: string, par: Auteur): Promise<{ run: AgentRun; ecarts: string[] }> {
  const run = await lireRun(PLANNING_ATELIER_SLUG, runId)
  if (!run || run.statut !== 'ecrit') throw new PlanningRefus('run_inconnu', 'Ce planning de Tricobot est introuvable.', 404)
  const e = await ecartsDuRun(run)
  if (e.length > 0 && !commentaire.trim()) {
    throw new PlanningRefus('pourquoi_requis', 'Dites à Tricobot pourquoi vous avez changé son planning.', 400)
  }
  await enregistrerRetour({ slug: PLANNING_ATELIER_SLUG, runId, cle: null, juste: e.length === 0, commentaire, corrections: e, par })
  return { run: (await lireRun(PLANNING_ATELIER_SLUG, runId))!, ecarts: e }
}

/** The catalog's `sonder`: this agent only runs from Atelier › Planning. */
export async function sonder(): Promise<AgentRun[]> {
  throw new Error('Tricobot fait le planning depuis Atelier › Planning (« Faire le planning » sur une semaine vide).')
}
