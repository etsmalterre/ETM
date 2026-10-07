// « Agents IA » — the catalog. An agent is code (what it reads, how it
// decides, what it writes) plus a stored state (mode, prompt versions — see
// store.ts). Adding an agent = one entry here + its pipeline module.

import { isChatModel } from '../mistral.js'
import { PROFILS } from './bl-profils.js'
import {
  BL_ENNOBLISSEUR_BOITE,
  BL_ENNOBLISSEUR_SLUG,
  BL_ENNOBLISSEUR_VERSION_INITIALE,
  BL_ENNOBLISSEUR_PROMPT_LIVRE,
  retirerEcritures as retirerBlEnnoblisseur,
  sonderBoite as sonderBlEnnoblisseur,
  traiterPdfs as traiterBlEnnoblisseur,
} from './bl-ennoblisseur.js'
import {
  SUPERVISEUR_BOITES,
  SUPERVISEUR_HEURE,
  SUPERVISEUR_JOURS,
  SUPERVISEUR_SLUG,
  SUPERVISEUR_VERSION_INITIALE,
  SUPERVISEUR_PROMPT_LIVRE,
  executer as executerSuperviseur,
} from './superviseur/superviseur.js'
import { CONTROLES } from './superviseur/controles/index.js'
import {
  DESTINATAIRES as RAPPORT_ACTIVITE_DESTINATAIRES,
  HEURES_RAPPORT as RAPPORT_ACTIVITE_HEURES,
  HEURES_TEXTE as RAPPORT_ACTIVITE_HEURES_TEXTE,
  PERSONNE_SUIVIE,
  RAPPORT_ACTIVITE_JOURS,
  RAPPORT_ACTIVITE_SLUG,
  RAPPORT_ACTIVITE_VERSION_INITIALE,
  executer as executerRapportActivite,
} from './rapport-activite/agent.js'
import { resultatTriage, sonderBoite as sonderTriage, TRIAGE_BOITE, TRIAGE_SLUG, TRIAGE_VERSION_INITIALE } from './triage/agent.js'
import { CATEGORIES } from './triage/categories.js'
import { DESTINATAIRES } from './triage/transmission.js'
import { OPTION_VIA_TRIAGE_DEF } from './triage/constantes.js'
import {
  FACTURES_SST_BOITE,
  FACTURES_SST_SLUG,
  FACTURES_SST_VERSION_INITIALE,
  sonderBoite as sonderFacturesSst,
  traiterPdfs as traiterFacturesSst,
  OPTION_CONFIRMATION,
} from './factures-sst/agent.js'
import { FOURNISSEURS } from './factures-sst/extraction.js'
import { bilanFacture, pointsFacture, scoreFactures } from './factures-sst/points.js'
import { bilanRun, scorePoints, type BilanPoints, type ScorePoints } from './superviseur/score.js'
import type { ResultatSuperviseur } from './superviseur/superviseur.js'
import type { AgentMode, AgentRun, AgentState, AgentVersion, Auteur, VersionInitiale } from './store.js'
import type { Contexte } from './bl-ennoblisseur.js'
import { deLApp, type AppIa } from './app-scope.js'

/** What starts an agent: a mailbox poll every N ms, or on given days at an
 *  hour (Paris) — or at several hours, one run per hour listed. */
export type Declenchement =
  | { type: 'releve'; intervalleMs: number }
  | { type: 'quotidien'; heure: number | readonly number[]; /** ISO weekdays, 1 = Monday. */ jours: readonly number[] }

export interface AgentDef {
  slug: string
  /** The app whose « Agents IA » menu shows it (lib/agents/app-scope.ts). Absent = ETM. */
  app?: AppIa
  nom: string
  description: string
  declenchement: Declenchement
  /** What triggers it, shown in the « Fonctionnement » tab. */
  declencheur: string
  /** What it writes, shown in the « Fonctionnement » tab. */
  ecritures: string[]
  /** When it holds back, shown in the « Fonctionnement » tab. */
  abstention: string
  /** What each score means for this agent, shown beside the three buttons —
   *  of the run dialog, or of each point when `pointsEvaluables`. Every score
   *  is the same (store.ts `Note`, binary since 2026-10-02): réussite = nobody
   *  had anything to say, échec = a person corrected it, with why. Formerly
   *  échec need one. */
  evaluation: {
    reussite: string
    echec: string
    /** The scoring guide opened beside the buttons: the one question that
     *  decides, then per score a concrete example from this agent's work. */
    guide: {
      question: string
      exemples: Record<'reussite' | 'echec', string>
      /** Edge cases people get wrong, one line each. */
      remarques: string[]
    }
    /** An échec removes what the run wrote (kept for the user
     *  to correct). Returns the French line stored on the evaluation, or null
     *  when there was nothing to remove. Absent = an échec removes nothing. */
    retirer?(run: AgentRun): Promise<string | null>
  }
  /** What is scored is each point of a run, never the run (Superviseur: the
   *  points of its report; Factures: the lines of the invoice) — PUT
   *  /runs/:id/evaluation answers 409. Requires `points`. */
  pointsEvaluables: boolean
  /** The points of a run, how one run's points stand, and a version's score. */
  points?: {
    duRun(run: AgentRun): Array<{ cle: string; titre: string }>
    bilan(run: AgentRun): BilanPoints | null
    score(runs: AgentRun[]): ScorePoints
  }
  /** One line per mode the agent offers, for the status footer menu. An agent
   *  whose « essai » would change nothing (Superviseur: it writes nothing)
   *  leaves it out. */
  modes: Partial<Record<AgentMode, string>>
  versionInitiale: VersionInitiale
  /** A version shipped with the code (the result of reading the « Retours »,
   *  or a behaviour change in the code). Offered in the Prompt tab until a
   *  stored version carries it — same prompt AND note, `estPublie()`: a new
   *  version may keep the prompt — publishing stays a person's decision: a
   *  version's score starts at 0. */
  promptLivre?: VersionInitiale
  /** Chat models a version may use. */
  modeles: readonly string[]
  /** One run now (scheduler tick, or « Relever / Lancer maintenant » when `par` is set). */
  sonder(state: AgentState, version: AgentVersion, par: Auteur | null): Promise<AgentRun[]>
  /** Run PDFs through the pipeline outside the mailbox (manual test, retraitement) — agents that read PDFs only. */
  traiter?(pdfs: Array<{ nom: string; contenu: Buffer }>, ctx: Contexte): Promise<AgentRun[]>
  /** Switches a pilot sets in Agents IA (configuration, never a score). */
  options?: ReadonlyArray<{ cle: string; libelle: string; description: string; defaut: boolean }>
  /** The checks it runs, listed in the « Fonctionnement » tab (Superviseur). */
  controles?: ReadonlyArray<{ id: string; libelle: string; description: string }>
  /** Correct by default (Triage): a run nobody corrected counts as a réussite
   *  in the stats — nobody confirms a triage, a person only corrects one. */
  confianceParDefaut?: boolean
  /** Extra fields of a run for the Exécutions list (routes/agents-ia.ts `allege`). */
  ligne?(run: AgentRun): Record<string, unknown>
}

const MODELES_MISTRAL = ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest', 'ministral-8b-latest'].filter(isChatModel)

export const AGENTS: readonly AgentDef[] = [
  {
    slug: TRIAGE_SLUG,
    nom: 'Triage',
    description:
      `L’agent de tête de la boîte ${TRIAGE_BOITE} : chaque mail reçu prend une ou plusieurs catégories (BL ennoblisseur, facture sous-traitant, commande client, qualité, transport…), un libellé Gmail sous « ETM/ », et part vers l’agent qui le traite — les BL vers BL Ennoblisseur, les factures des ennoblisseurs vers Factures Ennoblisseur. Son tri est tenu pour juste tant que personne ne le corrige.`,
    declenchement: { type: 'releve', intervalleMs: 60_000 },
    declencheur: `Relève chaque minute la boîte ${TRIAGE_BOITE} : tous les mails reçus (jamais ceux qu’elle envoie), depuis sa mise en route et au plus les 7 derniers jours, du plus ancien au plus récent. L’expéditeur est reconnu dans les contacts d’ETM (clients, sous-traitants, fournisseurs, transporteurs, prospects) ; le modèle lit l’objet, le corps, les noms des pièces jointes et les deux messages précédents du fil.`,
    ecritures: [
      `Un libellé Gmail par catégorie sur le mail : « ETM/Transport », « ETM/Qualité »… ; pour un BL ou une facture d’ennoblisseur, un niveau de plus avec l’ennoblisseur (« ETM/BL ennoblisseur/MATEL » — reconnu dans le PDF par l’agent qui le lit, sinon par l’expéditeur, « Inconnu » à défaut). Mode actif seulement.`,
      `Le mail transmis à l’agent de sa catégorie (${CATEGORIES.filter((c) => c.cible).map((c) => `${c.libelle} → ${DESTINATAIRES[c.cible!]?.nom ?? c.cible}`).join(', ')}), quand cet agent est en service avec l’option « Mails transmis par le Triage ». Cet agent lit et enregistre selon son propre mode.`,
    ],
    abstention:
      'En essai, il trie et garde l’exécution, sans libellé ni transmission. Un mail dont le tri échoue (Gmail ou Mistral indisponible) est retenté aux relevés suivants, 3 fois au plus ; une transmission en erreur aussi, pendant 3 jours. Corriger les catégories d’un mail (Exécutions) déplace ses libellés et transmet le mail à l’agent d’une nouvelle catégorie — ce qu’un agent a déjà fait pour une catégorie retirée n’est pas défait.',
    evaluation: {
      reussite: 'Juste par défaut : personne n’a corrigé ses catégories.',
      echec: 'Corrigé : une personne a changé les catégories du mail dans Exécutions, en disant pourquoi.',
      guide: {
        question: 'Est-ce que ce mail serait arrivé au bon service, au bon agent ? Oui → rien à faire (réussite). Non → « Corriger le tri », en disant pourquoi (échec).',
        exemples: {
          reussite: '« BL métrages 109235 » de MATEL → BL ennoblisseur (MATEL), transmis à BL Ennoblisseur.',
          echec: 'Une demande de certificat Oeko-Tex classée « Suivi client » au lieu de « Qualité ».',
        },
        remarques: [
          'Le tri se corrige ici, dans Exécutions — c’est là que se fait son travail.',
          'Revenir aux catégories qu’il avait choisies retire la correction.',
          'La sous-catégorie (l’ennoblisseur, le client) ne se corrige pas : elle vient de l’expéditeur et du PDF — corrigez la fiche contact si elle est fausse.',
        ],
      },
    },
    pointsEvaluables: false,
    confianceParDefaut: true,
    modes: {
      off: 'Ne lit pas la boîte mail.',
      essai: 'Trie les mails, sans libellé ni transmission.',
      actif: 'Trie, pose les libellés Gmail et transmet aux agents.',
    },
    versionInitiale: TRIAGE_VERSION_INITIALE,
    modeles: MODELES_MISTRAL,
    sonder: sonderTriage,
    ligne: (run) => {
      const res = resultatTriage(run)
      return {
        categories: res.categories ?? [],
        sousCategories: res.sousCategories ?? {},
        expediteur: res.expediteur ?? null,
        // A correction stands (a withdrawn one leaves the history, not the score).
        corrige: run.evaluation?.note === 'echec',
        transmissions: (res.transmissions ?? []).map((t) => ({ agent: t.agent, nom: t.nom, statut: t.statut, runs: t.runs.map((r) => r.id) })),
        extrait: res.extrait ?? '',
      }
    },
  },
  {
    slug: BL_ENNOBLISSEUR_SLUG,
    nom: 'BL Ennoblisseur',
    description:
      `Lit les bordereaux de livraison des ennoblisseurs (${PROFILS.map((p) => p.nom).join(', ')}) et prépare la réception : chaque pièce (métrage, observations, et le poids pour MATEL) est enregistrée pour pré-remplir le dialogue de réception de Sous-traitants › Commandes, et le PDF est classé dans les documents de la commande. Les autres pièces jointes de ces expéditeurs (palettes, plans de charge, factures, nos propres documents renvoyés) sont écartées sans alerte.`,
    declenchement: { type: 'releve', intervalleMs: 2 * 60_000 },
    declencheur: `Relève toutes les 2 minutes la boîte ${BL_ENNOBLISSEUR_BOITE} : mails avec pièce jointe venant des contacts de ${PROFILS.map((p) => p.nom).join(', ')} (Sous-traitants › Gestion › Contacts — une nouvelle adresse du même domaine est prise d’office). C’est le texte du PDF qui décide s’il s’agit d’un BL.${((essai) => (essai.length ? ` ${essai.join(' et ')} : en essai quel que soit le mode de l’agent, le temps de valider leur lecture.` : ''))(PROFILS.filter((p) => p.modeMax === 'essai').map((p) => p.nom))}`,
    ecritures: [
      'Le PDF dans les documents de la commande sous-traitant (type « BL retour ennoblisseur »), nommé comme le lot.',
      'Une ligne par pièce dans les données de réception (table data_bl_tricotbot). Lot : « MA » + n° de BL (MATEL), « BON » + n° de BL (Bontemps), « TA » + n° d’OF (TAD, mise à dispo comme BL). Poids : celui du BL pour MATEL, aucun pour les autres (Malterre pèse).',
      'Un libellé Gmail « ETM/BL traité » ou « ETM/BL à vérifier » sur le mail (mode actif seulement).',
    ],
    abstention:
      'Rien n’est enregistré si un contrôle bloque : numéro de commande, de bordereau ou d’OF illisible, commande inconnue ou chez un autre ennoblisseur, pièce introuvable ou affectée à une autre commande, somme des poids ou des métrages différente des totaux imprimés. L’exécution passe alors « à vérifier » et les abonnés à la notification « BL Ennoblisseur à vérifier » reçoivent un email (Paramètres › Utilisateurs › Notifications).',
    evaluation: {
      reussite: 'Gardé tel quel : les pièces pré-remplies sont bonnes, rien n’a été retouché à la réception.',
      echec: 'Tout jeté : inutilisable (mauvaise commande, pièces inventées ou manquantes en nombre). Les pièces pré-remplies sont retirées de la réception ; le PDF reste dans les documents de la commande.',
      guide: {
        question: 'Est-ce que je garde ce qu’il a écrit tel quel ? Oui → réussite. J’ai dû corriger quoi que ce soit → échec, en disant quoi.',
        exemples: {
          reussite: '12 pièces lues, poids et métrages identiques au BL papier.',
          echec: 'Le BL a été rattaché à la mauvaise commande.',
        },
        remarques: ['Une seule valeur corrigée suffit pour un échec : dites laquelle dans le commentaire.'],
      },
      retirer: retirerBlEnnoblisseur,
    },
    pointsEvaluables: false,
    modes: { off: 'Ne lit pas la boîte mail.', essai: 'Lit et analyse, n’enregistre rien.', actif: 'Lit, analyse et enregistre.' },
    versionInitiale: BL_ENNOBLISSEUR_VERSION_INITIALE,
    promptLivre: BL_ENNOBLISSEUR_PROMPT_LIVRE,
    modeles: MODELES_MISTRAL,
    sonder: sonderBlEnnoblisseur,
    traiter: traiterBlEnnoblisseur,
    options: [OPTION_VIA_TRIAGE_DEF],
  },
  {
    slug: FACTURES_SST_SLUG,
    nom: 'Factures Ennoblisseur',
    description:
      'Contrôle les factures des ennoblisseurs comme le faisait Pierre-Emmanuel avec « Lire facture » dans l’ancien Suivi lots : pour chaque lot facturé, le poids envoyé, le rendement et les traitements qui donnent le prix, comparés au tarif ETM du sous-traitant. La facture est enregistrée une seule fois dans Sous-traitants › Factures et rattachée à chaque commande qu’elle facture. Seules les factures avec un écart demandent une intervention.',
    declenchement: { type: 'releve', intervalleMs: 5 * 60_000 },
    declencheur: `Relève toutes les 5 minutes la boîte ${FACTURES_SST_BOITE} : mails des contacts des ennoblisseurs (les mêmes que BL Ennoblisseur) dont une pièce jointe ressemble à une facture. C’est le texte du PDF qui décide s’il s’agit d’une facture de ${FOURNISSEURS.map((f) => f.nom).join(', ')}.`,
    ecritures: [
      'La facture et son PDF dans Sous-traitants › Factures, une ligne par ligne imprimée, chaque lot rattaché à sa ligne de commande sous-traitant (avec le poids ETM, le prix attendu et le verdict).',
      'Le n° de facture sur les lignes de commande facturées, là où il est vide (comme dans l’ancien Suivi lots) — seulement si la lecture est fiable.',
      'Une carte « Factures sous-traitants — écarts » dans le widget Notifications du tableau de bord pour chaque facture à traiter (toutes tant que l’option « Confirmation » est active, sinon celles avec un écart).',
    ],
    abstention:
      'Deux verdicts par ligne. « Conforme » : l’agent avait tout (lot, commande, tarif ETM de la référence, coloris, traitements, rendement, poids des pièces) et c’est juste — ou facturé en dessous. « Écart » sinon : réel (facturé au-dessus du tarif au-delà de 1 % / 2 centimes, poids supérieur aux pièces dans ETM, lot déjà facturé) ou non vérifié (lot introuvable, tarif ETM absent ou incomplet, pièces pas toutes dans ETM). Chaque écart passe par une personne ; un écart non vérifié doit être confirmé ou levé avant de clore. Une lecture incohérente (lignes ≠ total) met toute la facture en écart et ne pointe pas les commandes. Les avoirs envoyés à part ne sont pas traités.',
    // Each LINE of the invoice is scored, never the invoice (points.ts).
    evaluation: {
      reussite: 'Juste : le verdict sur cette ligne est le bon — l’écart est réel, ou la ligne est bien correcte.',
      echec: 'Faux : écart signalé à tort, lot qui existe bien dans ETM, ou écart manqué sur une ligne dite conforme. Dites pourquoi.',
      guide: {
        question: 'Sur cette ligne, est-ce que j’aurais dit la même chose que Tricobot ? Oui → rien à faire (réussite). Non, même en partie → je le corrige ou je clique sur Tricobot, en disant pourquoi (échec).',
        exemples: {
          reussite: 'FA2865, lot 108406 : facturé 5,64 au lieu de 5,00 — MATEL a fait la remise.',
          echec: '« Lot introuvable » alors que le lot est bien dans Suivi lots sous un autre nom.',
        },
        remarques: [
          'La note se donne dans Sous-traitants › Factures en traitant la facture, jamais ici : valider confirme les lignes non touchées (réussite), « C’est conforme » / « Signaler un écart » contredit l’agent (échec), l’icône Tricobot signale une explication fausse (échec).',
          'Un écart « non vérifié » levé (c’est conforme) ne note pas l’agent : il ne pouvait pas savoir ; confirmé, c’est une réussite.',
          'Un écart vrai mais accepté (geste, prix négocié) reste une réussite : l’agent avait raison de le montrer.',
          'Un tarif ETM faux se corrige dans le tarif du sous-traitant ; notez la ligne en échec en le disant, pour qu’on le sache.',
        ],
      },
    },
    pointsEvaluables: true,
    points: { duRun: pointsFacture, bilan: bilanFacture, score: scoreFactures },
    options: [{
      cle: OPTION_CONFIRMATION,
      libelle: 'Confirmation de toutes les factures',
      description: 'Activé : chaque facture, même conforme, arrive « à traiter » dans Sous-traitants › Factures pour qu’une personne la valide — c’est ainsi que l’agent est noté pendant la période de confiance. Désactivé : seules les factures avec un écart, un lot introuvable ou des prix non contrôlés demandent une intervention.',
      defaut: true,
    }, OPTION_VIA_TRIAGE_DEF],
    modes: { off: 'Ne lit pas la boîte mail.', essai: 'Lit et contrôle, n’enregistre rien.', actif: 'Lit, contrôle, enregistre la facture et signale les écarts.' },
    versionInitiale: FACTURES_SST_VERSION_INITIALE,
    modeles: MODELES_MISTRAL,
    sonder: sonderFacturesSst,
    traiter: traiterFacturesSst,
  },
  {
    slug: SUPERVISEUR_SLUG,
    nom: 'Superviseur',
    description:
      'Contrôle chaque nuit l’activité d’ETS Malterre et prépare le rapport du matin : les clients ont-ils tous une réponse, les commandes reçues par mail sont-elles saisies dans ETM et justes, reste-t-il des actions en attente (pièces à affecter, fil à commander, ennoblissement non lancé…). Le rapport se lit ici, dans Exécutions.',
    declenchement: { type: 'quotidien', heure: SUPERVISEUR_HEURE, jours: SUPERVISEUR_JOURS },
    declencheur: `Chaque jour ouvré à ${SUPERVISEUR_HEURE} h du matin. Lit la base ETM (ETS Malterre uniquement) et les boîtes ${SUPERVISEUR_BOITES.join(', ')}.`,
    ecritures: ['Rien dans la base ni dans les boîtes mail : il lit seulement. Le rapport est l’exécution elle-même.'],
    abstention:
      'Un point déjà signalé reste dans le rapport, marqué « toujours ouvert », jusqu’à ce qu’il soit résolu. Un point jugé en échec (fausse alerte) est écarté des rapports suivants tant qu’il reste identique. Un lancement manuel ne met jamais à jour sa mémoire : le rapport du lendemain reste juste.',
    // Each POINT is scored, never the report (the report is the morning's batch).
    evaluation: {
      reussite: 'Vrai et utile : il fallait bien le traiter (j’ai agi, ou j’aurais dû agir).',
      echec: 'Rien à faire : c’est faux, ou c’est normal. Le point est écarté des prochains rapports tant qu’il reste identique.',
      guide: {
        question: 'Si j’avais ignoré ce point, est-ce que ça aurait posé un problème ? Oui, et il était bien dit → Traité (réussite). Mal dit, ou rien à faire → Fausse alerte ou « pouvait être mieux » (échec).',
        exemples: {
          reussite: '« Commande sans délai » : c’était vrai, je l’ai corrigée.',
          echec: 'Un avis signalé « non facturé » qui est en fait une donation.',
        },
        remarques: [
          'Vrai mais inutile (« je le sais, c’est normal ») = échec, pas réussite : sinon le rapport se remplit de bruit bien noté.',
          'Ce que l’agent a raté ne se note pas sur un point : signalez-le à l’administrateur des agents.',
        ],
      },
    },
    pointsEvaluables: true,
    points: {
      duRun: (run) => {
        const sup = run.resultat as Partial<ResultatSuperviseur>
        return [...(sup.constats ?? []), ...(sup.ecartes ?? []), ...(sup.resolus ?? [])].map((c) => ({ cle: c.cle, titre: c.titre }))
      },
      bilan: bilanRun,
      score: scorePoints,
    },
    modes: {
      off: 'Ne fait aucun contrôle.',
      actif: 'Contrôle chaque nuit et prépare le rapport du matin.',
    },
    versionInitiale: SUPERVISEUR_VERSION_INITIALE,
    promptLivre: SUPERVISEUR_PROMPT_LIVRE,
    modeles: MODELES_MISTRAL,
    sonder: executerSuperviseur,
    controles: CONTROLES.map((c) => ({ id: c.id, libelle: c.libelle, description: c.description })),
  },
  {
    slug: RAPPORT_ACTIVITE_SLUG,
    nom: 'Rapport d’activité',
    description: `Envoie aux heures de bureau (${RAPPORT_ACTIVITE_HEURES_TEXTE}) le compte rendu de l’activité de ${PERSONNE_SUIVIE} depuis le rapport précédent : connexions, actions dans ETM et TRM, mails envoyés et reçus, et les points à vérifier — techniques (erreurs, actions refusées, saisie douteuse) et de comportement (ton d’un mail, engagement sans trace dans ETM, client sans réponse).`,
    declenchement: { type: 'quotidien', heure: RAPPORT_ACTIVITE_HEURES, jours: RAPPORT_ACTIVITE_JOURS },
    declencheur: `Du lundi au vendredi à ${RAPPORT_ACTIVITE_HEURES_TEXTE} (heure de Paris), sur la période depuis le rapport précédent — celui de 9 h couvre depuis la veille ouvrée 18 h, week-end compris. Lit le journal d’activité d’ETM/TRM (créations, modifications, suppressions et erreurs du compte, jamais les simples consultations), les connexions, et la boîte ${PERSONNE_SUIVIE} en lecture seule.`,
    ecritures: [
      `Un e-mail à ${RAPPORT_ACTIVITE_DESTINATAIRES.join(' et ')}, envoyé par tricotbot@etsmalterre.com — destinataires fixés dans le code, aucun abonnement possible.`,
      'L’exécution garde les compteurs et les adresses, jamais le contenu du rapport.',
      'Supprime à chaque rapport prévu les lignes du journal d’activité de plus d’un an.',
    ],
    abstention:
      'Une période sans aucune activité (ni action, ni connexion, ni mail envoyé ou reçu) : aucun e-mail. Les mails dont l’objet les dit personnels sont listés sans être lus ; les mails automatiques (newsletters, notifications) ne sont pas listés. Si Mistral ne répond pas, le rapport part quand même avec les faits seuls.',
    evaluation: {
      reussite: 'Le rapport était juste : les points signalés méritaient d’être vérifiés.',
      echec: 'Un point signalé à tort ou un fait mal résumé : dites lequel, pour la version suivante du prompt.',
      guide: {
        question: 'Les points d’attention de l’analyse IA étaient-ils fondés ? Oui → réussite. Un point faux ou injuste → échec, en disant lequel.',
        exemples: {
          reussite: '« Prix de 5,20 €/ml annoncé à Sigvaris, la commande 1234 est à 5,60 » : c’était bien une erreur de saisie.',
          echec: '« Client sans réponse » alors qu’il avait répondu par téléphone.',
        },
        remarques: ['Les faits relevés par ETM (erreurs serveur, refus, suppressions) ne viennent pas du modèle : ils ne le notent pas.'],
      },
    },
    pointsEvaluables: false,
    modes: {
      off: 'N’envoie rien.',
      essai: 'Prépare le rapport à l’heure prévue et dit à qui il l’enverrait, n’envoie rien.',
      actif: 'Envoie le rapport à chaque heure prévue. « Lancer maintenant » l’envoie tout de suite, sur la période depuis le dernier rapport prévu.',
    },
    versionInitiale: RAPPORT_ACTIVITE_VERSION_INITIALE,
    modeles: MODELES_MISTRAL,
    sonder: executerRapportActivite,
  },
]

/** `app` given: only that app's agent (the routers); absent: any (the engine). */
export function agentDef(slug: string, app?: AppIa): AgentDef | undefined {
  return AGENTS.find((a) => a.slug === slug && (!app || deLApp(a, app)))
}

export function agentsDe(app: AppIa): AgentDef[] {
  return AGENTS.filter((a) => deLApp(a, app))
}

