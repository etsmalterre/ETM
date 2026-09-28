// One-off (2026-09-28): the first estimate of the share of each task that can
// be automated, written by Claude at Vincent's request (« set the values to an
// estimate you make yourself »), from a review of every task against what AI
// and ETM's own agents (BL Ennoblisseur, Superviseur, Gmail, espace client) can
// do today. Vincent adjusts them afterwards from the screen.
//
//   npx tsx src/scripts/rh-part-automatisable-2026-09-28.ts            (dry run, rh_dev)
//   NODE_ENV=production npx tsx src/scripts/rh-part-automatisable-2026-09-28.ts --write
//
// For each employee: takes the LATEST relevé as it is (hours, modes, notes
// untouched), sets partAutomatisable per task and appends the reason to the
// task's « Estimation » text, then saves it as the relevé of 2026-09-28 — a new
// dated version, so the previous one stays in the history (a relevé already
// dated that day is rewritten, which is how relevés work). A task whose name
// is not below is left unassessed and listed. Idempotent: re-running rewrites
// the same relevé with the same values (the reason is not appended twice).

import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })

import { listerEmployes, versionsCompletes, enregistrerVersion, journaliser, fermerRh } from '../lib/rh-store.js'
import { normaliserTache, estTampon } from '../lib/rh-charge.js'

const DATE = '2026-09-28'
const AUTEUR = 'Claude (estimation du 28/09/2026)'
const MARQUE = 'Part automatisable estimée à'

/** [share %, reason]; 'fait' = already automated as a whole. */
const ESTIMATIONS: Record<string, [number | 'fait', string]> = {
  // Laetitia
  'Gestion des expéditions': [50, 'ordres de transport pré-remplis depuis ETM, preuves d’enlèvement et de livraison relevées automatiquement (suivi transporteur, mails), brouillons de réclamation pour les litiges ; restent les exceptions.'],
  'Tirelles': [10, 'travail de laboratoire physique ; seule la saisie des mesures peut se faire à la volée.'],
  'Ménage': [0, 'travail physique.'],
  'Coupe métrage client': [0, 'travail physique.'],
  'Standard téléphonique': [20, 'transcription automatique de l’appel en note « à rappeler » ; l’accueil reste humain (clients professionnels).'],
  'Préparation des pochettes': [10, 'étiquettes générées automatiquement ; découpe et collage restent manuels.'],
  'Devis transport': [70, 'demande envoyée à plusieurs transporteurs, réponses lues et comparées par un agent ; la décision reste humaine.'],
  'Pointage': ['fait', 'déjà automatisé.'],
  'Fiches de paie TRM': [70, 'variables de paie exportées depuis le pointage, déjà automatisé ; contrôle final humain.'],
  'Envois et suivis des pochettes': [50, 'suivi de l’envoi automatique (suivi transporteur) ; préparation du colis manuelle.'],
  'Études des tarifs transporteur': [50, 'lecture et comparaison des grilles tarifaires par l’IA ; synthèse relue avant de l’envoyer à Isa.'],
  'Déclarations douane': [90, 'déclaration construite à partir des factures export d’ETM ; vérification et dépôt.'],
  'Suivi expé': [90, 'suivi transporteur et mail au client automatiques ; seulement les exceptions à traiter.'],
  // Pierre-Emmanuel
  'Commandes de teinture': [50, 'réception des BL déjà automatisée pour MATEL (agent BL Ennoblisseur), à étendre aux autres teinturiers ; relances de délais rédigées automatiquement.'],
  'Infos clients': [50, 'réponses rédigées à partir des données ETM (certificats, provenance, délais) et espace client ; envoi relu.'],
  'Saisie des commandes client': [60, 'commande lue dans le mail ou le PDF du client et pré-saisie dans ETM, validée ensuite (même principe que l’agent BL).'],
  'Définition des besoins': [40, 'calcul automatique des besoins en fil, tricotage et teinture depuis les stocks et les en-cours ; arbitrages stratégiques humains.'],
  'Coordination interne': [10, 'échanges humains ; quelques consignes remplacées par des alertes ETM.'],
  'Achat de fils': [40, 'bon de commande pré-rempli, certificats rattachés automatiquement depuis les mails fournisseurs, relances ; décision de quantité humaine.'],
  'Gestion étude coloris': [40, 'relances de délais et retour au client rédigés automatiquement ; suivi humain.'],
  'Soumission des tirelles': [40, 'mail de soumission assemblé automatiquement avec les contrôles sous-traitant et ETM ; décision humaine.'],
  'Déclencher les expéditions': [70, 'ETM propose l’avis quand la commande est prête et archive à la livraison confirmée ; validation humaine.'],
  'Commandes de tricotage': [50, 'commande TRM déjà générée par ETM ; suivi des délais automatisable.'],
  'Qualité': [20, 'enquête humaine ; l’IA reconstitue la chronologie du dossier à partir des mails.'],
  'Devis fils': [60, 'demande de prix envoyée à plusieurs fournisseurs, réponses comparées automatiquement.'],
  'Suivi lot': [50, 'pré-validation automatique à partir des contrôles ; cas limites humains.'],
  'Compte les cols rectilignes': [0, 'contrôle physique.'],
  'Vérifie les factures fournisseurs': [90, 'rapprochement facture / commande automatique ; seuls les écarts sont montrés.'],
  'Vérifie les factures sous-traitants': [90, 'rapprochement facture / commande automatique ; seuls les écarts sont montrés.'],
  'Gestion stock fini': [60, 'stocks dormants signalés automatiquement (Superviseur) ; décision de vente humaine.'],
  'Gestion stock TM': [60, 'stocks dormants signalés automatiquement (Superviseur) ; décision humaine.'],
  'Gestion stock fil': [60, 'stocks au minimum signalés automatiquement ; décision de réassort humaine.'],
  'Prélèvement pièce finie': [20, 'déclenchement et transport proposés automatiquement ; contrôle physique.'],
}

async function main() {
  const write = process.argv.includes('--write')
  console.log(write ? 'mode: ÉCRITURE\n' : 'mode: simulation (--write pour appliquer)\n')
  for (const e of await listerEmployes()) {
    const versions = await versionsCompletes(e.id)
    const derniere = versions.at(-1)
    if (!derniere) continue
    const inconnues: string[] = []
    const taches = derniere.taches.map((t) => {
      if (estTampon(t)) return t
      const est = ESTIMATIONS[t.nom]
      if (!est) { inconnues.push(t.nom); return t }
      const [part, raison] = est
      const methode = t.methode.includes(MARQUE)
        ? t.methode
        : [t.methode.trim(), `${MARQUE} ${part === 'fait' ? '100 % (déjà automatisée)' : `${part} %`} (Claude, 28/09/2026) : ${raison}`].filter(Boolean).join('\n\n')
      return normaliserTache({
        ...t,
        methode,
        automatise: part === 'fait' ? true : t.automatise,
        partAutomatisable: part === 'fait' ? 100 : part,
      })
    })
    console.log(`${e.prenom} ${e.nom} — relevé du ${derniere.dateReleve} → ${DATE}`)
    for (const t of taches) {
      if (estTampon(t)) continue
      console.log(`   ${t.automatise ? 'auto' : `${String(t.partAutomatisable ?? '—').padStart(3)} %`}  ${t.nom} (${t.heures} h)`)
    }
    if (inconnues.length) console.log(`   ⚠ non évaluées (nom inconnu) : ${inconnues.join(', ')}`)
    if (write) {
      const note = derniere.dateReleve === DATE && derniere.note
        ? `${derniere.note} · part automatisable estimée`
        : 'Part automatisable de chaque tâche estimée (Claude, 28/09/2026)'
      await enregistrerVersion(e.id, DATE, note, taches, AUTEUR)
      await journaliser('claude', 'releve_charge', `${e.id}:${DATE}`)
    }
    console.log('')
  }
  await fermerRh()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
