// Seeds Sous-traitants › Ennoblissement in the DEV database with two delivery
// notes read by Tricobot (Flux Ennoblisseur › BL, supervisé), each one a point
// waiting on its order (claude_doc/agents_autonomie.md §3, §6 and §7):
//   - a BL that passed every check: the card is red « Tricobot : réception à
//     valider », and on the order he proposes to receive its rolls — Valider
//     is the réception;
//   - a BL he asks about: its printed total métrage does not match the sum of
//     its rolls (two digits swapped), so nothing is pre-filled — « Tricobot
//     demande ton avis », with what he read as a proposal.
//
//   npx tsx src/scripts/seed-bl-tricobot-dev.ts [--commande 9133] [--aide 9142]
//
// What it does, for each of the two:
//   - takes a MATEL one-line order « en cours » whose écru pieces are affected
//     and not received yet (3 to 8 pieces, the nearest délai first; no point
//     of Tricobot already waiting on the order), or the order named;
//   - builds the BL as MATEL would print it: one row per écru piece, a dyed
//     weight a little under the écru's, a métrage at the reference's usual
//     m/kg (from its rolls already received), a few observations, the totals;
//   - runs the agent's own code on it, without OCR nor model: the extraction
//     checks, `resoudreBl` (the order, the line, every piece ours), `ecrireBl`
//     when nothing blocks (the PDF as a ged of the order + the réception's
//     pre-fill), then stores the run (apps/api/data/agents/) and its point
//     (`enregistrerPointBl`, PG saisie_agent) exactly as the agent does.
// The lots are MA9<line id>: numbers MATEL does not use. The PDFs say they are
// test documents. Re-runnable: a previous seed whose rolls were not received
// is removed first (its pre-fill, its ged, its run, its point); once received
// it is left alone and another line is taken. Refuses anything but a *_dev database.

import dotenv from 'dotenv'

dotenv.config({ path: '.env.development' })
const url = process.env.PG_CONNECTION_STRING ?? ''
if (!/\/[a-z_]+_dev(\?|$)/.test(url)) {
  console.error('Refusé : PG_CONNECTION_STRING ne pointe pas sur une base *_dev.')
  process.exit(1)
}

const path = await import('node:path')
const fs = await import('node:fs/promises')
const React = (await import('react')).default
const { Document, Page, View, Text, renderToBuffer } = await import('@react-pdf/renderer')
const { mpsPg, closeMpsPg } = await import('../lib/mps-pg.js')
const { consumedEcruIds } = await import('../lib/fini-sources.js')
const { AGENTS_DIR, ajouterRun, enregistrerFichier, lireEtat, nouvelIdRun } = await import('../lib/agents/store.js')
const { readJson, writeJson } = await import('../lib/agents/json-store.js')
const { BL_ENNOBLISSEUR_SLUG, BL_ENNOBLISSEUR_VERSION_INITIALE } = await import('../lib/agents/bl-ennoblisseur.js')
const { controlerExtraction, estBloquant } = await import('../lib/agents/bl-extraction.js')
const { profilDe, reglesDe } = await import('../lib/agents/bl-profils.js')
const { ecrireBl, resoudreBl } = await import('../lib/agents/bl-ennoblisseur-db.js')
const { enregistrerPointBl } = await import('../lib/agents/flux-ennoblisseur/reception-bl.js')
type AgentRun = import('../lib/agents/store.js').AgentRun
type BlExtraction = import('../lib/agents/bl-extraction.js').BlExtraction
type ResultatBl = import('../lib/agents/bl-ennoblisseur.js').ResultatBl
type Ecriture = import('../lib/agents/bl-ennoblisseur-db.js').Ecriture

const MATEL = 9
/** The seed's mails are recognised by this prefix of their Gmail id. */
const MARQUE = 'seed-bl-'
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined }
const commandeVoulue = Number(arg('commande')) || 0
const aideVoulue = Number(arg('aide')) || 0
const r1 = (x: number) => Math.round(x * 10) / 10
const fr = (x: number) => x.toFixed(1).replace('.', ',')

const sql = mpsPg()
const profil = profilDe('matel')!

// ── The previous seed ────────────────────────────────────
const fichierRuns = path.join(AGENTS_DIR, `runs-${BL_ENNOBLISSEUR_SLUG}.json`)
const runsAvant = await readJson<AgentRun[]>(fichierRuns, [])
const aRetirer = new Set<string>()
for (const r of runsAvant.filter((x) => x.message?.id.startsWith(MARQUE))) {
  const res = r.resultat as unknown as ResultatBl
  const ligne = res.resolution?.ligneId ?? 0
  const lot = res.resolution?.lot ?? ''
  const [{ n: recus }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM stock_fini WHERE idref_commande_source = ${ligne} AND lot = ${lot}`
  if (recus > 0) continue // received: the BL is the order's history now
  const ids = res.ecriture?.ids ?? []
  if (ids.length) await sql`DELETE FROM data_bl_tricotbot WHERE iddata_bl_tricotbot IN ${sql(ids)} AND idligne_commande_sous_traitant = ${ligne}`
  if (res.ecriture?.gedId && res.resolution?.nomGed) await sql`DELETE FROM ged WHERE idged = ${res.ecriture.gedId} AND nom = ${res.resolution.nomGed + '.pdf'}`
  await sql`DELETE FROM saisie_agent WHERE run_id = ${r.id} AND competence = 'bl'`
  for (const f of r.fichiers) await fs.rm(path.join(AGENTS_DIR, 'fichiers', f.fichier), { force: true })
  aRetirer.add(r.id)
  console.log(`Seed précédent retiré : BL ${res.extraction?.numero_bordereau} de la commande ${res.resolution?.commandeId} (non reçu).`)
}
if (aRetirer.size) await writeJson(fichierRuns, runsAvant.filter((r) => !aRetirer.has(r.id)))

// ── The lines: écru affected, nothing received, nothing pre-filled ──
interface Ligne { lig: number; cmd: number; idreference: number; reference: string; ecrus: Array<{ numero: string; poids: number }> }
const prises = new Set<number>()
async function choisirLigne(commande: number): Promise<Ligne | null> {
  const candidates = await sql<{ lig: number; cmd: number; idreference: number; reference: string | null }[]>`
    SELECT l.idligne_commande_sous_traitant AS lig, l.idcommande_sous_traitant AS cmd, l.idreference, rf.reference
    FROM ligne_commande_sous_traitant l
    JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
    LEFT JOIN ref_fini rf ON rf.idref_fini = l.idreference
    WHERE c.idsous_traitant = ${MATEL} AND l.type = 2 AND l.sstatut = 'En_Cours'
      AND ${commande ? sql`c.idcommande_sous_traitant = ${commande}` : sql`TRUE`}
      AND NOT EXISTS (SELECT 1 FROM stock_fini f WHERE f.idref_commande_source = l.idligne_commande_sous_traitant)
      AND NOT EXISTS (SELECT 1 FROM data_bl_tricotbot d WHERE d.idligne_commande_sous_traitant = l.idligne_commande_sous_traitant)
      AND NOT EXISTS (SELECT 1 FROM saisie_agent s WHERE s.idcommande_sous_traitant = c.idcommande_sous_traitant AND s.statut IN ('a_revoir', 'autonome'))
      AND (SELECT count(*) FROM ligne_commande_sous_traitant x WHERE x.idcommande_sous_traitant = c.idcommande_sous_traitant) = 1
    ORDER BY l.date_livraison NULLS LAST, l.idligne_commande_sous_traitant`
  for (const c of candidates) {
    if (prises.has(Number(c.cmd))) continue
    const ecrus = await sql<{ id: number; numero: string | null; poids: number | null }[]>`
      SELECT idstock_ecru AS id, numero, poids FROM stock_ecru WHERE idref_commande_affectation = ${c.lig} ORDER BY idstock_ecru`
    const consommes = await consumedEcruIds(ecrus.map((e) => Number(e.id)))
    const libres = ecrus
      .filter((e) => !consommes.has(Number(e.id)) && /^\d+\/\d+$/.test(String(e.numero ?? '').trim()) && Number(e.poids) > 0)
      .map((e) => ({ numero: String(e.numero).trim(), poids: Number(e.poids) }))
    if (libres.length !== ecrus.length) continue
    if (commande ? libres.length > 0 : libres.length >= 3 && libres.length <= 8) {
      prises.add(Number(c.cmd))
      return { lig: Number(c.lig), cmd: Number(c.cmd), idreference: Number(c.idreference), reference: String(c.reference ?? '').trim(), ecrus: libres }
    }
  }
  return null
}

const etat = await lireEtat(BL_ENNOBLISSEUR_SLUG, BL_ENNOBLISSEUR_VERSION_INITIALE)
const version = etat.versions.find((v) => v.version === etat.activeVersion) ?? etat.versions[etat.versions.length - 1]
const [celine] = await sql<{ mail: string | null }[]>`
  SELECT mail FROM contact WHERE idsous_traitant = ${MATEL} AND prenom ILIKE 'c_line%' ORDER BY idcontact LIMIT 1`
const expediteur = `Céline FERNANDES <${celine?.mail?.trim() || 'mct.celine@mateltextiles.fr'}>`
const jour = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris' }).format(new Date())
const jourYmd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date()).replace(/-/g, '')
const OBSERVATIONS = ['', '1 tache', '', '2 taches', 'Cassures', '', '1 défaut', '']
const PERTES = [0.97, 0.985, 0.96, 0.975, 0.99, 0.965, 0.98, 0.97]

/** Swap the last two digits before the decimal (« 185,2 » → « 158,2 »): the typo of a printed total. */
function chiffresInverses(x: number): number {
  const [e, d = '0'] = x.toFixed(1).split('.')
  if (e.length < 2 || e[e.length - 1] === e[e.length - 2]) return r1(x + 10)
  return Number(`${e.slice(0, -2)}${e[e.length - 1]}${e[e.length - 2]}.${d}`)
}

// ── One BL: built, checked, written (or not), stored with its point ──
async function seeder(l: Ligne, variante: 'saisie' | 'aide', minutes: number): Promise<void> {
  // The reference's usual m/kg, from its rolls already received.
  const [{ ratio }] = await sql<{ ratio: number | null }[]>`
    SELECT avg(f.metrage / f.poids)::float AS ratio FROM stock_fini f
    JOIN ligne_commande_sous_traitant x ON x.idligne_commande_sous_traitant = f.idref_commande_source
    WHERE x.idreference = ${l.idreference} AND x.type = 2 AND f.poids > 5 AND f.metrage > 5`
  const mParKg = ratio && ratio > 0.5 && ratio < 12 ? ratio : 3
  const pieces = l.ecrus.map((e, i) => {
    const poids = r1(e.poids * PERTES[i % PERTES.length])
    return { numero_piece: e.numero, composants: [e.numero], poids, metrage: r1(poids * mParKg * (0.98 + (i % 4) * 0.012)), observations: OBSERVATIONS[i % OBSERVATIONS.length] }
  })
  const bordereau = `${900000 + (l.lig % 100000)}A`
  const sommeMetrage = r1(pieces.reduce((s, p) => s + p.metrage, 0))
  const extraction: BlExtraction = {
    numero_commande: String(l.cmd), numero_bordereau: bordereau, ligne: 1, pieces,
    nombre_pieces: pieces.length,
    poids_total: r1(pieces.reduce((s, p) => s + p.poids, 0)),
    // The aide: MATEL's total with two digits swapped — the sum check stops the BL.
    metrage_total: variante === 'aide' ? chiffresInverses(sommeMetrage) : sommeMetrage,
    numero_of: '', destinataire: '',
  }

  const lignesTexte = [
    'MATEL COULEURS TEXTILES',
    `BORDEREAU DE LIVRAISON N° ${bordereau}`,
    `Date : ${jour}`,
    'Client : ETS MALTERRE',
    `Votre commande n° ${l.cmd} - Ligne 1`,
    `Article : ${l.reference}`,
    '',
    'N° pièce | Poids (kg) | Métrage (m) | Observations',
    ...pieces.map((p) => `${p.numero_piece} | ${fr(p.poids)} | ${fr(p.metrage)} | ${p.observations}`),
    '',
    `Nbre rouleaux : ${pieces.length}   Poids total : ${fr(extraction.poids_total!)} kg   Métrage total : ${fr(extraction.metrage_total!)} m`,
  ]
  const h = React.createElement
  const cellule = (texte: string, largeur: number, gras = false) =>
    h(Text, { style: { width: largeur, fontSize: 10, padding: 4, fontFamily: gras ? 'Helvetica-Bold' : 'Helvetica' } }, texte)
  const rangee = (cles: string[], gras = false, i = 0) =>
    h(View, { key: `${gras ? 't' : 'r'}${i}`, style: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#999', backgroundColor: gras ? '#eee' : '#fff' } },
      cellule(cles[0], 110, gras), cellule(cles[1], 90, gras), cellule(cles[2], 90, gras), cellule(cles[3], 220, gras))
  const pdf = await renderToBuffer(
    h(Document, null,
      h(Page, { size: 'A4', style: { padding: 40, fontFamily: 'Helvetica' } },
        h(Text, { style: { fontSize: 16, fontFamily: 'Helvetica-Bold' } }, 'MATEL COULEURS TEXTILES'),
        h(Text, { style: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginTop: 18 } }, `BORDEREAU DE LIVRAISON N° ${bordereau}`),
        h(Text, { style: { fontSize: 10, marginTop: 6 } }, `Date : ${jour}`),
        h(Text, { style: { fontSize: 10, marginTop: 14 } }, 'Client : ETS MALTERRE'),
        h(Text, { style: { fontSize: 10, marginTop: 3 } }, `Votre commande n° ${l.cmd} - Ligne 1`),
        h(Text, { style: { fontSize: 10, marginTop: 3 } }, `Article : ${l.reference}`),
        h(View, { style: { marginTop: 18, borderTopWidth: 0.5, borderTopColor: '#999' } },
          rangee(['N° pièce', 'Poids (kg)', 'Métrage (m)', 'Observations'], true),
          ...pieces.map((p, i) => rangee([p.numero_piece, fr(p.poids), fr(p.metrage), p.observations], false, i))),
        h(Text, { style: { fontSize: 10, fontFamily: 'Helvetica-Bold', marginTop: 12 } },
          `Nbre rouleaux : ${pieces.length}     Poids total : ${fr(extraction.poids_total!)} kg     Métrage total : ${fr(extraction.metrage_total!)} m`),
        h(Text, { style: { position: 'absolute', bottom: 30, left: 40, right: 40, fontSize: 8, color: '#b00', textAlign: 'center' } },
          'DOCUMENT DE TEST — généré par seed-bl-tricobot-dev.ts sur la base dev, ce n’est pas un BL de MATEL.'),
      ),
    ) as unknown as React.ReactElement<import('@react-pdf/renderer').DocumentProps>,
  )

  // The agent's own checks and writes.
  const controles = controlerExtraction(extraction, reglesDe(profil))
  const resolution = await resoudreBl(extraction, profil, 'bl')
  controles.push(...resolution.controles)
  const bloque = estBloquant(controles)
  if (resolution.ligneId !== l.lig || bloque !== (variante === 'aide')) {
    console.error(`Le BL fabriqué pour la commande ${l.cmd} ne donne pas « ${variante} » :`, controles.map((c) => `[${c.gravite}] ${c.message}`).join(' | ') || `ligne résolue ${resolution.ligneId}`)
    process.exit(1)
  }
  const ecriture: Ecriture | null = bloque ? null : await ecrireBl(extraction, resolution, [pdf], jourYmd, profil)

  const maintenant = new Date()
  const messageId = `${MARQUE}${maintenant.getTime().toString(36)}-${l.lig}`
  const nomPdf = `BL ${bordereau}.pdf`
  const runId = nouvelIdRun()
  const { controles: _c, ...resolutionSansControles } = resolution
  const resultat: ResultatBl = {
    profil: 'matel', typeDocument: 'bl',
    pages: [{ nom: nomPdf, ocr: lignesTexte.join('\n'), erreur: null }],
    extraction, resolution: resolutionSansControles, controles, ecriture,
  }
  const bl = `MATEL · BL ${bordereau} · commande ${l.cmd}`
  const run: AgentRun = {
    id: runId, slug: BL_ENNOBLISSEUR_SLUG, createdAt: maintenant.toISOString(), source: 'gmail', mode: 'actif',
    lancePar: { id: 0, nom: 'Seed dev' },
    message: {
      id: messageId, threadId: messageId, de: expediteur,
      sujet: `BL ${bordereau} - commande ${l.cmd}`, date: new Date(maintenant.getTime() - minutes * 60_000).toISOString(),
    },
    fichiers: [{ nom: nomPdf, fichier: await enregistrerFichier(runId, 0, pdf), taille: pdf.length }],
    version: version.version, model: version.model, statut: bloque ? 'a_verifier' : 'ecrit',
    resultat: resultat as unknown as Record<string, unknown>,
    resume: bloque
      ? `${bl} · ${controles.find((c) => c.gravite === 'bloquant')?.message ?? 'à vérifier'}`
      : `${bl} · ${ecriture!.lignesEcrites} pièce(s) enregistrée(s)`,
    coutUsd: 0, dureeMs: 0,
  }
  await ajouterRun(run)
  const idPoint = await enregistrerPointBl(run)

  console.log(`\nCommande ${l.cmd} · ${l.reference} — BL ${bordereau}, lot ${resolution.lot} (run ${runId}, point ${idPoint})`)
  for (const p of pieces) console.log(`  ${p.numero_piece} : ${fr(p.poids)} kg · ${fr(p.metrage)} m${p.observations ? ` · ${p.observations}` : ''}`)
  console.log(bloque
    ? `  → Tricobot demande ton avis : ${controles.filter((c) => c.gravite === 'bloquant').map((c) => c.message).join(' ')}`
    : `  → Tricobot propose de réceptionner ces ${pieces.length} rouleaux (pré-remplissage écrit, ged ${ecriture!.gedId}).`)
}

const pourSaisie = await choisirLigne(commandeVoulue)
if (!pourSaisie) console.warn(`Pas de BL à valider : aucune ligne MATEL « en cours »${commandeVoulue ? ` sur la commande ${commandeVoulue}` : ''} avec des tombés de métier affectés et rien de reçu.`)
else await seeder(pourSaisie, 'saisie', 8)
const pourAide = await choisirLigne(aideVoulue)
if (!pourAide) console.warn(`Pas de BL à trancher : aucune autre ligne MATEL${aideVoulue ? ` sur la commande ${aideVoulue}` : ''} ne convient.`)
else await seeder(pourAide, 'aide', 3)

console.log('\nSous-traitants › Ennoblissement : les commandes sont rouges, « Tricobot : réception à valider » / « Tricobot demande ton avis ».')
await closeMpsPg()
process.exit(0)
