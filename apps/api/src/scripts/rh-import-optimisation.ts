// One-off, idempotent: load the spreadsheet « Optimisation IA 25-11.xlsx »
// (G:\Mon Drive\ETM, November 2025) into RH as the first workload relevé of
// Pierre-Emmanuel (« Pierrot ») and Laetitia, dated 2025-11-25. Isa's own block is deliberately
// left out (decision 2026-09-25: RH lists the employees, not its two users).
//
//   npx tsx src/scripts/rh-import-optimisation.ts            (dev, rh_dev)
//   NODE_ENV=production npx tsx src/scripts/rh-import-optimisation.ts
//
// Transcribed, not parsed: the file sits on a personal drive, and three things
// had to be decided by hand anyway —
//   • « Improductivité subie » is NOT imported: RH computes it as what is left
//     of the 35 h (it was typed as exactly that remainder: 6 h and 22 h).
//   • « Automatisable » empty → 'inconnu', '?' → 'inconnu'.
//   • A task whose method is « N min × a volume read in MPS » is bound to the
//     matching ETM indicator (lib/rh-indicateurs.ts), with those minutes. The
//     hours typed in November stay as the relevé's value. Expéditions are NOT
//     bound: the sheet's « 50 expé/semaine » does not match any count ETM keeps
//     (avis + divers ≈ 19/week in 2025), so that volume is a different unit.
// Re-running rewrites the 2025-11-25 relevé (same date = same version).

import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })

import { listerEmployes, creerEmploye, modifierEmploye, lireEmploye, enregistrerVersion, fermerRh } from '../lib/rh-store.js'
import { normaliserTache, type TacheCharge } from '../lib/rh-charge.js'

const DATE_RELEVE = '2025-11-25'
const NOTE = 'Relevé initial — tableur « Optimisation IA 25-11.xlsx » (Isa + Vincent, novembre 2025).'

type T = Partial<TacheCharge> & { nom: string; heures: number }
const t = (x: T): TacheCharge => normaliserTache(x)
const structurelle = t({
  nom: 'Improductivité structurelle',
  description: 'Temps d’improductivité stratégique permettant de faire face à une hausse soudaine d’activité.',
  heures: 2.8,
  categorie: 'improductivite_structurelle',
})

const LAETITIA: TacheCharge[] = [
  t({
    nom: 'Gestion des expéditions',
    description: 'Créer les ordres de transport, suivre les transports en cours en rassemblant les preuves d’enlèvement et de livraison, gérer les litiges et archiver les transports terminés.',
    methode: '180 expé par mois + 20 divers\n50/sem avec 10 % de litiges\nEstimation d’une charge de 2 h/jour',
    heures: 10, automatisable: 'oui',
  }),
  t({
    nom: 'Tirelles',
    description: 'Sur toutes les tirelles, mesurer la laize, couper un échantillon et mesurer le poids. Marquer un carré de 50×50 et le couper. Passer en machine à laver. Faire sécher les tirelles, mesurer les stabs H et L. Comparer et archiver les échantillons (coloris). Archiver les tirelles. Reporter les mesures sur MPS.',
    methode: 'Une requête MPS a montré que nous gérons une moyenne de 15 tirelles par semaine.\nUne charge de 4 h/sem est allouée.',
    heures: 4, automatisable: 'non',
  }),
  t({ nom: 'Ménage', description: 'Faire le ménage dans les bureaux.', heures: 4, automatisable: 'non' }),
  structurelle,
  t({ nom: 'Coupe métrage client', description: 'Couper des métrages lorsque le client le demande.', heures: 2, automatisable: 'non' }),
  t({
    nom: 'Standard téléphonique',
    description: 'Filtrer les appels, émettre un rapport « à rappeler » selon les besoins.',
    methode: 'Environ 10 appels entrants par jour.\n2 min en moyenne par appel.',
    heures: 1.7, automatisable: 'oui',
  }),
  t({
    nom: 'Préparation des pochettes',
    description: 'Couper les échantillons, les coller sur les feuillets puis imprimer et coller les étiquettes.',
    methode: 'Une requête MPS montre que nous traitons en moyenne 10 prospects par mois.',
    heures: 1.3, automatisable: 'non',
  }),
  t({
    nom: 'Devis transport',
    description: 'Pour certains transports, il est nécessaire de demander des devis à plusieurs sociétés. Il faut ensuite recueillir l’information pour fournir une synthèse permettant de prendre une décision.',
    methode: 'Isa observe que cette tâche prend en moyenne 1 h par semaine.',
    heures: 1, automatisable: 'oui',
  }),
  t({
    nom: 'Pointage',
    description: 'Faire un rapport journalier du pointage de TRM et hebdomadaire pour le suivi des heures par rapport aux 35 h.',
    methode: '10 min par jour de relevé pointage + 10 min par semaine de relevé des heures',
    heures: 1, automatisable: 'oui', automatise: true,
  }),
  t({ nom: 'Fiches de paie TRM', heures: 0.5, automatisable: 'oui' }),
  t({ nom: 'Envois et suivis des pochettes', description: 'Envoyer aux clients et suivre l’envoi.', heures: 0.25, automatisable: 'partiel' }),
  t({
    nom: 'Études des tarifs transporteur',
    description: 'Reçoit les tarifs à jour, enregistre l’information. Compare avec les précédents et fournit un rapport à Isa.',
    methode: 'Max 5 fois par an. Une MAJ tarif prend environ 2 h. Donc un max de 10 h par an.',
    heures: 0.25, automatisable: 'inconnu',
  }),
  t({ nom: 'Déclarations douane', description: 'Déclaration des ventes à l’étranger.', heures: 0.2, automatisable: 'oui' }),
  t({
    nom: 'Suivi expé',
    description: 'Suivre les expéditions et informer le client.',
    methode: 'Tâche non effectuée pour l’instant',
    heures: 0, automatisable: 'oui',
  }),
]

const PIERROT: TacheCharge[] = [
  structurelle,
  t({
    nom: 'Saisie des commandes client',
    description: 'Précise avec le client jusqu’à ce qu’une commande soit saisie dans MPS. Définit les besoins en termes d’achat de fil, tricotage et teinture. Il faut aussi suivre les commandes jusqu’à leur archivage.',
    methode: 'Considère la saisie de la commande dans MPS et l’étude des besoins en fil, tricotage et teinture. Ce relevé d’infos sera utilisé en dehors de cette tâche.\n→ 10 min / cmd\nrequête : 14 commandes / semaine en moyenne\n⇒ 140 min / semaine (2 h 20)',
    heures: 2.3, automatisable: 'oui', indicateur: 'commandes_client', minutesParUnite: 10,
  }),
  t({
    nom: 'Définition des besoins',
    description: 'Pour chaque ligne de commande client, il faut définir les besoins en achat de fil, commandes tricotage et teinture. Les stocks et commandes en cours doivent être pris en compte pour cela.',
    methode: 'On peut considérer que ce temps est équivalent au temps de saisie',
    heures: 2.3, automatisable: 'inconnu', indicateur: 'commandes_client', minutesParUnite: 10,
  }),
  t({
    nom: 'Commandes de teinture',
    description: 'Créer les commandes, suivre les délais. Réceptionner les pièces et enregistrer les données fournies par le partenaire.',
    methode: 'Prise de commande 2 min + suivi (point MATEL) 3 min + 2 min réception → 7 min\nrequête : 19 commandes / semaine en moyenne\n⇒ 133 min / semaine',
    heures: 2.2, automatisable: 'oui', indicateur: 'commandes_teinture', minutesParUnite: 7,
  }),
  t({
    nom: 'Déclencher les expéditions',
    description: 'Donner à Laetitia les ordres d’expédition chez les clients et archiver les commandes lorsqu’il est confirmé que le client l’a reçue.',
    methode: '1 min par expé\nreq : 50 expé / semaine\n⇒ 50 min / semaine',
    heures: 0.8, automatisable: 'inconnu',
  }),
  t({
    nom: 'Achat de fils',
    description: 'Passer les commandes de fil et les suivre jusqu’à réception. Lier les certificats à la commande. Une décision sur la quantité à commander est parfois nécessaire pour faire baisser les prix en fonction de la stratégie.',
    methode: '* une commande s’enregistre en 10 min\n* on ajoute 10 % pour la gestion des délais et problèmes de transport\n* lier accusé de réception, facture, BL, certif = 5 min\n16 min par commande × 9 commandes par mois / 4\n⇒ 36 min par semaine',
    heures: 0.6, automatisable: 'oui', indicateur: 'commandes_fil', minutesParUnite: 16,
  }),
  t({
    nom: 'Commandes de tricotage',
    description: 'Créer les commandes, suivre les délais. Réceptionner les pièces et enregistrer les données fournies par le partenaire.',
    methode: '2 min + 1 min de suivi\nrequête : 10 commandes / semaine en moyenne\n⇒ 30 min / semaine',
    heures: 0.5, automatisable: 'oui', indicateur: 'commandes_tricotage', minutesParUnite: 3,
  }),
  t({
    nom: 'Infos clients',
    description: 'Donner des infos au client quand par exemple il demande des certificats, la provenance des fils, les différentes entreprises… Informer le client des délais et imprévus de sa commande.',
    methode: '1 min par commande\nrequête : 14 commandes / semaine en moyenne\n⇒ 14 min / semaine',
    heures: 0.2, automatisable: 'inconnu', indicateur: 'commandes_client', minutesParUnite: 1,
  }),
  t({
    nom: 'Suivi lot',
    description: 'Vérifier la conformité des lots en fonction des contrôles du sous-traitant et de ceux de Laetitia. Valider, reprendre ou consulter Isa pour décider.',
    methode: '0,5 min par lot\nrequête : 19 lots / semaine en moyenne\n⇒ 10 min / semaine',
    heures: 0.2, automatisable: 'inconnu', indicateur: 'suivi_lots', minutesParUnite: 0.5,
  }),
  t({
    nom: 'Devis fils',
    description: 'Obtenir plusieurs devis de filateurs/négociants.',
    methode: 'Avant chaque commande de fils au minimum et aussi parfois en préparation pour un marché.\n1 min de mails avec 2 frs = 2 min par commande\nRequête MPS : 9 commandes par mois en moyenne + 1 pour la prépa marché\n20 min par mois / 5 min par semaine',
    heures: 0.1, automatisable: 'oui', indicateur: 'commandes_fil', minutesParUnite: 2,
  }),
  t({
    nom: 'Qualité',
    description: 'Enregistrer les non-qualités quand elles surviennent. Enquêter pour trouver les processus qui ont permis aux défauts de passer. Fournir les infos aux dirigeants pour la gestion commerciale et le management interne. Management direct avec les teinturiers et filateurs.',
    methode: '5 % des commandes ont des problèmes de qualité. 5 min par litige.\nrequête : 14 commandes / semaine en moyenne\nenviron 1 retour qualité par semaine\n⇒ 5 min / semaine',
    heures: 0.1, automatisable: 'inconnu',
  }),
  t({
    nom: 'Soumission des tirelles',
    description: 'Envoie les tirelles au client lorsque demandé. Fournir les contrôles sous-traitant et ETM avec cette tirelle. Valider, reprendre ou consulter les dirigeants.',
    methode: '1 min par lot avec tirelle\nreq : 7 soumissions par semaine\n⇒ 7 min / semaine',
    heures: 0.1, automatisable: 'inconnu',
  }),
  t({
    nom: 'Prélèvement pièce finie',
    description: 'Une fois tous les 10 lots environ, demander au teinturier d’envoyer une pièce à l’usine pour faire un contrôle après teinture. Gérer le transport, visiter la pièce. Si contrôle non conforme, enregistrer l’information et la fournir aux dirigeants pour le management des partenaires.',
    methode: '5 min par prélèvement\nune dizaine de prélèvements par an\n⇒ 1 min / semaine',
    heures: 0.1, automatisable: 'inconnu',
  }),
  t({
    nom: 'Gestion étude coloris',
    description: 'Créer une étude coloris dans MPS, l’envoyer chez le teinturier. Gérer les délais et remonter l’étude au client.',
    methode: '1 min par étude\nreq : 5 études / semaine\n⇒ 5 min / semaine',
    heures: 0.1, automatisable: 'inconnu', indicateur: 'etudes_coloris', minutesParUnite: 1,
  }),
  t({
    nom: 'Gestion stock fil',
    description: 'Gérer les stocks mini en fonction des besoins et de la stratégie. Lorsque les stocks atteignent leur minimum, il faut les renouveler selon la stratégie.',
    methode: 'Point stock fil 1 fois par semaine → 2 min',
    heures: 0.1, automatisable: 'inconnu',
  }),
  t({
    nom: 'Gestion stock TM',
    description: 'Faire un point régulier sur les stocks TM. Éviter les stocks morts et encore plus chez les partenaires. Enregistrer l’information des stocks dormants afin d’aider le service commercial à les vendre.',
    methode: 'Point stock TM 1 fois par semaine → 2 min',
    heures: 0.1, automatisable: 'inconnu',
  }),
  t({
    nom: 'Gestion stock fini',
    description: 'Faire un point régulier sur les stocks finis. Éviter les stocks morts et encore plus chez les partenaires. Enregistrer l’information des stocks dormants afin d’aider le service commercial à les vendre.',
    methode: 'Point stock fini/inventaire 1 fois par mois → 10 min',
    heures: 0.1, automatisable: 'inconnu',
  }),
  t({
    nom: 'Vérifie les factures fournisseurs',
    description: 'Comparer le montant facturé au montant commandé, vérifier la conformité de la commande. Approuver la facture ou demander un avoir en fournissant une raison.',
    methode: '2 min / commande de fil\nreq : 2,5 commandes / semaine\n⇒ 5 min / semaine',
    heures: 0.1, automatisable: 'inconnu', indicateur: 'commandes_fil', minutesParUnite: 2,
  }),
  t({
    nom: 'Vérifie les factures sous-traitants',
    description: 'Comparer le montant facturé au montant commandé, vérifier la conformité de la commande. Approuver la facture ou demander un avoir en fournissant une raison.',
    methode: '5 s / commande de teinture',
    heures: 0.1, automatisable: 'inconnu',
  }),
  t({
    nom: 'Compte les cols rectilignes',
    description: 'Faire un contrôle qualité en comptant les cols rectilignes.',
    methode: '1 fois tous les 2 mois → 1 h',
    heures: 0.1, automatisable: 'inconnu',
  }),
]

const EMPLOYES = [
  // « Pierrot » at the factory; RH keeps the real first name.
  { prenom: 'Pierre-Emmanuel', nom: 'Roux', poste: 'Achats, commandes et suivi de production', idutilisateur: 4, taches: PIERROT },
  { prenom: 'Laetitia', nom: 'Tellier', poste: 'Accueil, expéditions et laboratoire', idutilisateur: 12, taches: LAETITIA },
]

async function main() {
  const existants = await listerEmployes()
  for (const e of EMPLOYES) {
    let id = existants.find((x) => x.idutilisateur === e.idutilisateur || x.prenom.toLowerCase() === e.prenom.toLowerCase())?.id
    if (!id) {
      id = await creerEmploye(e.prenom, e.nom, 'import')
      const cur = (await lireEmploye(id))!
      await modifierEmploye(id, { ...cur, poste: e.poste, idutilisateur: e.idutilisateur }, 'import')
      console.log(`${e.prenom}: fiche créée (#${id})`)
    } else {
      console.log(`${e.prenom}: fiche existante (#${id}), gardée telle quelle`)
    }
    await enregistrerVersion(id, DATE_RELEVE, NOTE, e.taches, 'import')
    const total = e.taches.reduce((s, x) => s + x.heures, 0)
    console.log(`  relevé ${DATE_RELEVE}: ${e.taches.length} lignes, ${total.toFixed(1)} h hors improductivité subie`)
  }
  await fermerRh()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
