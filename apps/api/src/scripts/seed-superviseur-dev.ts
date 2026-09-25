// Seeds a Superviseur report in the DEV store (apps/api/data/agents/), to try
// the report screen and point scoring without waiting for 05:00.
//
//   npx tsx src/scripts/seed-superviseur-dev.ts
//
// Runs the real database checks against the dev HFSQL (SELECT only), then adds
// a few sample « mails » points (no mailbox is read, no Mistral call). Never
// touches the findings memory nor the scores: it only appends one run, marked
// « Seed dev » as its author. Refuses anything but a localhost database.

import dotenv from 'dotenv'

dotenv.config({ path: '.env.development' })
const cs = process.env.HFSQL_CONNECTION_STRING ?? ''
if (!/Server Name=(localhost|127\.0\.0\.1)\s*;/i.test(cs)) {
  console.error('Refusé : HFSQL_CONNECTION_STRING ne pointe pas sur une base locale (dev).')
  process.exit(1)
}

const { CONTROLES } = await import('../lib/agents/superviseur/controles/index.js')
const { SUPERVISEUR_SLUG, SUPERVISEUR_VERSION_INITIALE } = await import('../lib/agents/superviseur/superviseur.js')
const { ajouterRun, nouvelIdRun } = await import('../lib/agents/store.js')
type Constat = import('../lib/agents/superviseur/types.js').Constat
type ConstatRun = import('../lib/agents/superviseur/constats.js').ConstatRun
type ResultatSuperviseur = import('../lib/agents/superviseur/superviseur.js').ResultatSuperviseur

const t0 = Date.now()
const nowIso = new Date(t0).toISOString()
// Why each object the checks let pass was not reported: sample « résolus ».
const raisons = new Map<string, string>()
const ctx = { nowMs: t0, version: { version: 1, ...SUPERVISEUR_VERSION_INITIALE }, cout: () => {}, raison: (cle: string, t: string) => { raisons.set(cle, t) } }
const PAR_CONTROLE = 4 // enough of each kind to score, not a wall of points
// Checks that read the factory mailboxes — replaced below by sample points.
const MAILS = new Set(['client_sans_reponse', 'commande_mail'])

const controles: ResultatSuperviseur['controles'] = []
const trouves: Constat[] = []
for (const c of CONTROLES.filter((x) => !MAILS.has(x.id))) {
  const t = Date.now()
  try {
    const found = await c.executer(ctx)
    trouves.push(...found.slice(0, PAR_CONTROLE))
    controles.push({ id: c.id, libelle: c.libelle, domaine: c.domaine, nb: found.length, dureeMs: Date.now() - t, erreur: null })
    console.log(`${c.id}: ${found.length} point(s)`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    controles.push({ id: c.id, libelle: c.libelle, domaine: c.domaine, nb: 0, dureeMs: Date.now() - t, erreur: msg })
    console.log(`${c.id}: ERREUR ${msg}`)
  }
}

const mails: Constat[] = [
  {
    cle: 'seed:mail:1', controle: 'client_sans_reponse', domaine: 'mails', gravite: 'urgent',
    titre: '[Test] DUPONT TEXTILES — demande de délai sans réponse',
    message: 'Le client demande un délai pour sa commande. Sans réponse depuis 3 jours ouvrés (isabelle). À faire : Confirmer le délai de livraison au client.', lien: null,
  },
  {
    cle: 'seed:mail:2', controle: 'commande_mail', domaine: 'commandes_client', gravite: 'attention',
    titre: '[Test] MAILLE & CO — commande reçue par mail',
    message: 'Commande de 450 Ml reçue par mail le 22/09, introuvable dans ETM.', lien: null,
  },
  {
    cle: 'seed:mail:3', controle: 'client_sans_reponse', domaine: 'mails', gravite: 'info',
    titre: '[Test] Newsletter fournisseur',
    message: 'Mail sans réponse depuis 2 jours (probablement une fausse alerte : envoi automatique).', lien: null,
  },
]
for (const c of CONTROLES.filter((x) => MAILS.has(x.id))) {
  const nb = mails.filter((m) => m.controle === c.id).length
  controles.push({ id: c.id, libelle: c.libelle, domaine: c.domaine, nb, dureeMs: 0, erreur: null })
}

// Half « nouveau », half « toujours ouvert » so both renderings show.
const il_y_a = (j: number) => new Date(t0 - j * 86_400_000).toISOString()
const constats: ConstatRun[] = [...mails, ...trouves].map((c, i) =>
  i % 2 === 0 ? { ...c, etat: 'nouveau', depuis: nowIso } : { ...c, etat: 'ouvert', depuis: il_y_a(2 + i) },
)

// A few objects the checks let pass, shown as closed points with the real
// reason; one mail closed by an answer; one point marked résolu by hand earlier.
const parControle = new Map<string, number>()
const fermes: ResultatSuperviseur['fermes'] = []
for (const [cle, raison] of raisons) {
  const ctl = cle.split(':')[0]
  if ((parControle.get(ctl) ?? 0) >= 2) continue
  parControle.set(ctl, (parControle.get(ctl) ?? 0) + 1)
  fermes.push({ cle, titre: `[Test] ${cle}`, domaine: CONTROLES.find((c) => c.id === ctl)?.domaine ?? 'commandes_client', depuis: il_y_a(3), raison })
}
fermes.push({
  cle: 'seed:mail:ferme', titre: '[Test] ALLANDE — « RE: Confirmation de commande »', domaine: 'mails', depuis: il_y_a(2),
  raison: 'Réponse de pierre-emmanuel le 24/09 à 16h12.',
})
const resolus: ConstatRun[] = [{
  cle: 'seed:mail:resolu', controle: 'client_sans_reponse', domaine: 'mails', gravite: 'urgent', etat: 'ouvert', depuis: il_y_a(2),
  titre: '[Test] WECAMECA — « RE: demande de stock et prix »', lien: null,
  message: 'Le client demande des informations complémentaires sur le prix et le stock. Sans réponse depuis 6 jours ouvrés (isabelle).',
  resolution: { commentaire: 'J’ai eu la cliente au téléphone, elle doit revenir vers moi.', par: { id: 0, nom: 'Seed dev' }, le: il_y_a(1) },
}]
const resultat: ResultatSuperviseur = { controles, constats, ecartes: [], resolus, fermes, memoireMiseAJour: false }
const neufs = constats.filter((c) => c.etat === 'nouveau').length
await ajouterRun({
  id: nouvelIdRun(),
  slug: SUPERVISEUR_SLUG,
  createdAt: nowIso,
  source: 'manuel',
  mode: 'actif',
  lancePar: { id: 0, nom: 'Seed dev' },
  message: null,
  fichiers: [],
  version: 1,
  model: SUPERVISEUR_VERSION_INITIALE.model,
  statut: constats.length ? 'points_a_voir' : 'rien_a_signaler',
  resultat: resultat as unknown as Record<string, unknown>,
  resume: `Rapport de test · ${neufs} nouveaux points · ${constats.length - neufs} toujours ouverts`,
  coutUsd: 0.0042, // shows the « < 0,01 € » rendering
  dureeMs: Date.now() - t0,
})
console.log(`\nRapport de test ajouté : ${constats.length} point(s).`)
process.exit(0)
