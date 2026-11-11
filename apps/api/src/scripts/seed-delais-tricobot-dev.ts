// Seeds Sous-traitants › Ennoblissement in the DEV database with what the
// skill « Délais » of Flux Ennoblisseur leaves in SUPERVISÉ mode: Perrine
// (MATEL) answers our last « Point du JJ/MM » with a délai for three orders.
// Tricobot proposes two of them — nothing is written on the line until a
// person validates — and asks a person about the third, whose line already
// holds another délai (claude_doc/agents_autonomie.md §2 and §6).
//
//   npx tsx src/scripts/seed-delais-tricobot-dev.ts [--commandes 9146,9152] [--aide 9145]
//
// What it does:
//   - takes MATEL's last sent Point and two orders of its §5 (lines still
//     waiting for a délai first, or the ones named by --commandes);
//   - puts their lines back to « Attente délai », without a date (dev only:
//     a line that already holds a délai would make the point an aide);
//   - takes a third order of §5 whose line HOLDS a délai (or --aide) and makes
//     Perrine announce it a week later: the code's own doubt (`doute()` in
//     delais.ts), so an aide with its proposal. Its line is left as it is;
//   - writes the mail as a run of the agent (apps/api/data/agents/, « Voir le
//     mail ») and one point per order in PG `saisie_agent` (supervisé, à revoir).
// No mailbox is read and no model is called: the délai of each answer is read
// by the code's own rule (relireDelai). Re-runnable: the previous seed (its
// saisies and its run) is removed first. Refuses anything but a *_dev database.

import dotenv from 'dotenv'

dotenv.config({ path: '.env.development' })
const url = process.env.PG_CONNECTION_STRING ?? ''
if (!/\/[a-z_]+_dev(\?|$)/.test(url)) {
  console.error('Refusé : PG_CONNECTION_STRING ne pointe pas sur une base *_dev.')
  process.exit(1)
}

const path = await import('node:path')
const { mpsPg, closeMpsPg } = await import('../lib/mps-pg.js')
const { query } = await import('../lib/hfsql-auto.js')
const { isLineDone, STATUT_ATTENTE_DELAI } = await import('../lib/sst-shared.js')
const { AGENTS_DIR, ajouterRun, lireEtat, nouvelIdRun, promptsCompetence, versionCompetenceActive } = await import('../lib/agents/store.js')
const { readJson, writeJson } = await import('../lib/agents/json-store.js')
const { BL_ENNOBLISSEUR_SLUG, BL_ENNOBLISSEUR_VERSION_INITIALE } = await import('../lib/agents/bl-ennoblisseur.js')
const { DELAIS_VERSIONS_LIVREES, relireDelai } = await import('../lib/agents/flux-ennoblisseur/lecture.js')
const { questionsDuPoint } = await import('../lib/agents/flux-ennoblisseur/delais.js')
const { sections } = await import('../lib/agents/flux-ennoblisseur/reponse-point.js')
const { enregistrerSaisie, lireEtatLigne } = await import('../lib/agents/flux-ennoblisseur/saisies.js')
type AgentRun = import('../lib/agents/store.js').AgentRun
type PointDelai = import('../lib/agents/flux-ennoblisseur/delais.js').PointDelai
type ResultatFlux = import('../lib/agents/flux-ennoblisseur/delais.js').ResultatFlux

const MATEL = 9
/** The seed's mails are recognised by this prefix of their Gmail id. */
const MARQUE = 'seed-delais-'
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined }
const voulues = (arg('commandes') ?? '').split(',').map((x) => Number(x.trim())).filter((x) => x > 0)
const aideVoulue = Number(arg('aide')) || 0

const jjmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
const jourSemaine = (iso: string) => JOURS[new Date(`${iso}T12:00:00Z`).getUTCDay()]
/** 'YYYYMMDD' (lireEtatLigne) → 'YYYY-MM-DD'. */
const versIso = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null)
/** ISO week number of a day. */
function semaineIso(d: Date): number {
  const j = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  j.setUTCDate(j.getUTCDate() + 4 - (j.getUTCDay() || 7))
  return Math.ceil(((j.getTime() - Date.UTC(j.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)
}

const sql = mpsPg()

// ── The previous seed ────────────────────────────────────
const anciennes = await sql`DELETE FROM saisie_agent WHERE message_id LIKE ${MARQUE + '%'} RETURNING id`
const fichierRuns = path.join(AGENTS_DIR, `runs-${BL_ENNOBLISSEUR_SLUG}.json`)
const runsAvant = await readJson<AgentRun[]>(fichierRuns, [])
const runsGardes = runsAvant.filter((r) => !r.message?.id.startsWith(MARQUE))
if (runsGardes.length !== runsAvant.length) await writeJson(fichierRuns, runsGardes)
if (anciennes.length) console.log(`Seed précédent retiré : ${anciennes.length} saisie(s), ${runsAvant.length - runsGardes.length} run(s).`)

// ── The Point and its two orders ─────────────────────────
const [point] = await sql<{ id: number; jour: string; sujet: string }[]>`
  SELECT p.idpoint_sst AS id, to_char(p.jour, 'YYYY-MM-DD') AS jour, p.sujet FROM point_sst p
  WHERE p.idsous_traitant = ${MATEL} AND p.statut = 'envoye'
    AND (SELECT count(DISTINCT l.idcommande_sous_traitant) FROM point_sst_ligne l
         WHERE l.idpoint_sst = p.idpoint_sst AND l.section = 5 AND NOT l.retiree AND l.idligne_commande_sous_traitant > 0) >= 2
  ORDER BY p.jour DESC LIMIT 1`
if (!point) { console.error('Aucun Point envoyé à MATEL avec au moins deux commandes en section 5.'); process.exit(1) }

const questions = (await questionsDuPoint(Number(point.id))).filter((q) => q.idligne > 0)
const etats = new Map<number, Awaited<ReturnType<typeof lireEtatLigne>>>()
for (const q of questions) etats.set(q.idligne, await lireEtatLigne(q.idligne))
const ouvertes = questions.filter((q) => { const e = etats.get(q.idligne); return !!e && !isLineDone(e.sstatut) })
// Lines still waiting for their délai first; one line per order.
const candidates = voulues.length
  ? voulues.map((c) => ouvertes.find((q) => q.idcommande === c)).filter((q): q is (typeof questions)[number] => !!q)
  : [...ouvertes].sort((a, b) => Number(etats.get(b.idligne)!.sstatut === STATUT_ATTENTE_DELAI) - Number(etats.get(a.idligne)!.sstatut === STATUT_ATTENTE_DELAI))
const choisies = candidates.filter((q, i) => candidates.findIndex((x) => x.idcommande === q.idcommande) === i).slice(0, 2)
if (choisies.length < 2) {
  console.error(`Il faut deux commandes ouvertes en section 5 du ${point.sujet}${voulues.length ? ` parmi ${voulues.join(', ')}` : ''} : ${ouvertes.map((q) => q.commande).join(', ') || 'aucune'}.`)
  process.exit(1)
}

// The order Tricobot asks about: its line already holds a délai, kept as it is.
const aide = ouvertes.find((q) => {
  const e = etats.get(q.idligne)!
  return !choisies.some((c) => c.idcommande === q.idcommande) && (!aideVoulue || q.idcommande === aideVoulue)
    && e.sstatut !== STATUT_ATTENTE_DELAI && !!versIso(e.dateLivraison)
}) ?? null
if (!aide) console.warn(`Pas de demande d’avis : aucune autre commande de la section 5${aideVoulue ? ` (${aideVoulue})` : ''} ne porte déjà un délai.`)
const delaiActuel = aide ? versIso(etats.get(aide.idligne)!.dateLivraison)! : null

// Back to « Attente délai »: what the line was when the Point asked.
for (const q of choisies) {
  await query(
    `UPDATE ligne_commande_sous_traitant SET date_livraison = NULL, date_delai = NULL, sstatut = '${STATUT_ATTENTE_DELAI}' WHERE IDligne_commande_sous_traitant = ${q.idligne}`,
  )
}

// ── Perrine's reply ──────────────────────────────────────
const [perrine] = await sql<{ mail: string | null }[]>`
  SELECT mail FROM contact WHERE idsous_traitant = ${MATEL} AND nom ILIKE 'perrine%' ORDER BY idcontact LIMIT 1`
const de = `Perrine LEONARD <${perrine?.mail?.trim() || 'mct.perrinelabo@mateltextiles.fr'}>`
const maintenant = new Date()
const recu = new Date(maintenant.getTime() - 12 * 60_000).toISOString()
// The dyer's standard: three weeks, the second order a week later (« s N » = Wednesday of ISO week N).
const semaine = (jours: number) => semaineIso(new Date(maintenant.getTime() + jours * 86_400_000))
const reponses = [`cde ${choisies[0].commande} s ${semaine(21)}`, `cde ${choisies[1].commande} s ${semaine(28)}`]
// The third order slips by a week from the délai its line holds.
const reponseAide = aide ? `cde ${aide.commande} s ${semaineIso(new Date(Date.parse(`${delaiActuel}T12:00:00Z`) + 7 * 86_400_000))}` : null
const [{ n: enSection4 }] = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM point_sst_ligne WHERE idpoint_sst = ${point.id} AND section = 4 AND NOT retiree`
const texte = [
  'Bonjour,',
  '',
  ...(enSection4 > 0 ? ['4) ce jour ou demain', ''] : []),
  `5) ${reponses[0]}`,
  reponses[1],
  ...(reponseAide ? [reponseAide] : []),
  '',
  'Cordialement.',
  'Perrine LEONARD',
  'Matel Couleurs Textiles',
].join('\n')
const messageId = `${MARQUE}${maintenant.getTime().toString(36)}`
const message = { id: messageId, threadId: messageId, de, sujet: `RE: ${point.sujet}`, date: recu }

// ── The run and its points, as delais.ts leaves them in supervisé ──
const etat = await lireEtat(BL_ENNOBLISSEUR_SLUG, BL_ENNOBLISSEUR_VERSION_INITIALE)
const prompt = versionCompetenceActive(promptsCompetence(etat, 'delais', DELAIS_VERSIONS_LIVREES))
const runId = nouvelIdRun()
const points: PointDelai[] = []
for (const q of questions) {
  const i = choisies.findIndex((c) => c.idligne === q.idligne)
  const p: PointDelai = { commande: q.commande, idcommande: q.idcommande, idligne: q.idligne, article: q.article, reponse: '', nommee: false, decision: 'aucune', delai: null, explication: 'Pas de réponse pour cette commande.' }
  if (i >= 0) {
    const delai = relireDelai(reponses[i], recu)
    if (!delai) { console.error(`Délai illisible dans « ${reponses[i]} ».`); process.exit(1) }
    Object.assign(p, { reponse: reponses[i], nommee: true, decision: 'saisie', delai, explication: `« ${reponses[i]} » : ${jourSemaine(delai)} ${jjmm(delai)}.` })
    p.saisieId = await enregistrerSaisie({
      agent: BL_ENNOBLISSEUR_SLUG, competence: 'delais', version: prompt.version, runId, messageId, threadId: messageId,
      mode: 'supervise', decision: 'saisie', idsousTraitant: MATEL, idcommande: q.idcommande, idligne: q.idligne,
      champ: 'date_livraison', valeurAvant: null, etatAvant: null, proposition: delai, ecrit: false,
      explication: p.explication, citation: p.reponse,
    })
  } else if (aide && reponseAide && q.idligne === aide.idligne) {
    const delai = relireDelai(reponseAide, recu)
    if (!delai || delai === delaiActuel) { console.error(`Délai illisible ou inchangé dans « ${reponseAide} ».`); process.exit(1) }
    // doute() in delais.ts: read for sure, but the line says something else.
    Object.assign(p, { reponse: reponseAide, nommee: true, decision: 'aide', delai, explication: `La ligne a déjà un délai au ${jjmm(delaiActuel!)}, la réponse dit le ${jjmm(delai)}.` })
    p.saisieId = await enregistrerSaisie({
      agent: BL_ENNOBLISSEUR_SLUG, competence: 'delais', version: prompt.version, runId, messageId, threadId: messageId,
      mode: 'supervise', decision: 'aide', idsousTraitant: MATEL, idcommande: q.idcommande, idligne: q.idligne,
      champ: 'date_livraison', valeurAvant: delaiActuel, etatAvant: null, proposition: delai, ecrit: false,
      explication: p.explication, citation: p.reponse,
    })
  }
  points.push(p)
}
const nAides = points.filter((p) => p.decision === 'aide').length

const resultat: ResultatFlux = {
  jourPoint: point.jour, idpoint: Number(point.id), texte, dateMail: recu,
  sections: Object.fromEntries([...sections(texte)].map(([k, v]) => [String(k), v])),
  delais: points,
}
await ajouterRun({
  id: runId, slug: BL_ENNOBLISSEUR_SLUG, createdAt: maintenant.toISOString(), source: 'gmail', mode: 'actif',
  lancePar: { id: 0, nom: 'Seed dev' }, message, fichiers: [], version: prompt.version, model: prompt.model, competence: 'delais',
  statut: nAides ? 'a_verifier' : 'ecrit', resultat: resultat as unknown as Record<string, unknown>,
  resume: `Délais · ${point.sujet} · 2 délais saisis${nAides ? ` · ${nAides} à trancher` : ''}`, coutUsd: 0, dureeMs: 0,
})

console.log(`Mail de ${de}, « ${message.sujet} » — run ${runId}`)
for (const p of points.filter((x) => x.decision === 'saisie')) {
  console.log(`  Cde ${p.commande} · ${p.article} : « ${p.reponse} » → ${jourSemaine(p.delai!)} ${jjmm(p.delai!)} à valider (saisie ${p.saisieId})`)
}
for (const p of points.filter((x) => x.decision === 'aide')) {
  console.log(`  Cde ${p.commande} · ${p.article} : « ${p.reponse} » → avis demandé, propose ${jourSemaine(p.delai!)} ${jjmm(p.delai!)} (saisie ${p.saisieId}) — ${p.explication}`)
}
console.log('\nSous-traitants › Ennoblissement : les commandes sont rouges, « Tricobot : délai à valider » / « Tricobot demande ton avis ».')
await closeMpsPg()
process.exit(0)
