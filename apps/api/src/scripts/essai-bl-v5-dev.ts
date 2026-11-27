// BL v5 seen working end to end, on the DEV database, with real BLs taken from
// the production runs (2026-11-27). Each one goes through the agent's own
// pipeline, `traiterPdfs` (OCR, model, checks, resolution, write, point):
//
//   --probable <runId>   a BL whose printed order number cannot be used: v5
//                        finds the order by the pieces and hangs its aide on it
//                        (Sous-traitants › Ennoblissement: « Tricobot demande ton
//                        avis », his proposal ready to apply);
//   --seul <runId>       a clean BL, drawn « alone » (autonomie): Tricobot
//                        receives its rolls himself, the point is autonomous;
//   --corrige <runId>    the same, then one of its rolls is corrected as
//                        « Corriger la réception » would: the point is judged.
//
//   npx tsx src/scripts/essai-bl-v5-dev.ts --runs <runs-bl-ennoblisseur.json> --fichiers <dir of the runs' PDFs> --probable <id> --seul <id> --corrige <id>
//
// The dev database is a copy of production: what production already did with
// these BLs (their pre-fill, their waiting point) is removed first, so the BL
// arrives as new. A BL whose rolls are already received is left alone.
// Costs the Mistral OCR + one small call per BL. Refuses anything but a *_dev database.

import dotenv from 'dotenv'

dotenv.config({ path: '.env.development' })
const url = process.env.PG_CONNECTION_STRING ?? ''
if (!/\/[a-z_]+_dev(\?|$)/.test(url)) {
  console.error('Refusé : PG_CONNECTION_STRING ne pointe pas sur une base *_dev.')
  process.exit(1)
}

const path = await import('node:path')
const fs = await import('node:fs/promises')
const { mpsPg } = await import('../lib/mps-pg.js')
const { lireEtat, versionActive } = await import('../lib/agents/store.js')
const { traiterPdfs, BL_ENNOBLISSEUR_SLUG, BL_ENNOBLISSEUR_VERSION_INITIALE } = await import('../lib/agents/bl-ennoblisseur.js')
const { rouleauCorrige } = await import('../lib/agents/flux-ennoblisseur/saisies.js')
const { correctionsRouleau } = await import('../lib/agents/flux-ennoblisseur/reception-bl.js')
type AgentRun = import('../lib/agents/store.js').AgentRun
type ResultatBl = import('../lib/agents/bl-ennoblisseur.js').ResultatBl

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined }
const fichierRuns = arg('runs')
const dossier = arg('fichiers')
if (!fichierRuns || !dossier) { console.error('usage: --runs <json> --fichiers <dir> [--probable id] [--seul id] [--corrige id]'); process.exit(1) }
const prod = JSON.parse(await fs.readFile(fichierRuns, 'utf8')) as AgentRun[]
const sql = mpsPg()
const etat = await lireEtat(BL_ENNOBLISSEUR_SLUG, BL_ENNOBLISSEUR_VERSION_INITIALE)
const version = versionActive(etat)

async function rejouer(id: string, seul: boolean): Promise<AgentRun | null> {
  const origine = prod.find((r) => r.id === id)
  if (!origine) { console.log(`Run ${id} introuvable dans ${fichierRuns}.`); return null }
  const res = origine.resultat as unknown as ResultatBl
  const numeros = (res.extraction?.pieces ?? []).flatMap((p) => p.composants)
  const [{ n: recus }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM stock_fini WHERE numero IN ${sql(numeros)}`
  if (recus > 0) { console.log(`BL ${res.extraction?.numero_bordereau} : ${recus} rouleau(x) déjà réceptionné(s) en dev, laissé tel quel.`); return null }
  // What production had done with it, copied into dev: removed, the BL arrives as new.
  const ids = res.ecriture?.ids ?? []
  if (ids.length) await sql`DELETE FROM data_bl_tricotbot WHERE iddata_bl_tricotbot IN ${sql(ids)}`
  if (res.ecriture?.gedId) await sql`DELETE FROM ged WHERE idged = ${res.ecriture.gedId} AND idtype_doc = 3`
  await sql`DELETE FROM saisie_agent WHERE run_id = ${id} AND competence = 'bl'`
  const pdfs = await Promise.all(origine.fichiers.map(async (f) => ({ nom: f.nom, contenu: await fs.readFile(path.join(dossier!, f.fichier)) })))
  const [run] = await traiterPdfs(pdfs, {
    mode: 'actif', version, source: 'gmail', lancePar: null,
    message: origine.message ? { ...origine.message, id: `essai-v5-${origine.message.id}` } : null,
    profilAttendu: 'matel',
    ...(seul ? { tirerSeul: async () => true } : {}),
  })
  return run ?? null
}

async function montrer(titre: string, run: AgentRun): Promise<void> {
  const res = run.resultat as unknown as ResultatBl
  console.log(`\n══ ${titre} ══`)
  console.log(`run ${run.id} · ${run.statut} · ${run.resume}`)
  for (const c of res.controles) console.log(`   ${c.gravite === 'bloquant' ? '⛔' : '⚠'} ${c.code} : ${c.message}`)
  console.log(`   résolution : commande ${res.resolution?.commandeId ?? '—'} · ligne ${res.resolution?.ligneId ?? '—'} · lot ${res.resolution?.lot || '—'}${res.resolution?.commandeProbable ? ` · commande probable ${res.resolution.commandeProbable}` : ''}`)
  if (res.ecriture) console.log(`   écriture : ${res.ecriture.lignesEcrites} pièce(s) pré-remplie(s)${res.ecriture.seul ? ` · réceptionné seul (${res.ecriture.seul.rouleaux} rouleau(x))` : ''}${res.ecriture.seulRefuse ? ` · tiré seul mais rendu : ${res.ecriture.seulRefuse}` : ''}`)
  const points = await sql<{ id: number; mode: string; decision: string; statut: string; cmd: number; ligne: number; ecrit: boolean; valeur_finale: string | null; commentaire: string | null; revu_par: string | null }[]>`
    SELECT id, mode, decision, statut, idcommande_sous_traitant AS cmd, idligne_commande_sous_traitant AS ligne, ecrit, valeur_finale, commentaire, revu_par
    FROM saisie_agent WHERE run_id = ${run.id}`
  for (const p of points) console.log(`   point ${p.id} : ${p.decision} · ${p.mode} · ${p.statut} · commande ${p.cmd} · ligne ${p.ligne} · écrit ${p.ecrit}${p.valeur_finale && p.statut === 'corrigee' ? ` · ${p.valeur_finale} (${p.commentaire}, ${p.revu_par})` : ''}`)
  const ligne = res.resolution?.ligneId ?? 0
  const lot = res.resolution?.lot ?? ''
  if (ligne && lot) {
    const rouleaux = await sql<{ numero: string; poids: number; metrage: number; etat: number }[]>`
      SELECT numero, poids, metrage, idetat_stock_fini AS etat FROM stock_fini WHERE idref_commande_source = ${ligne} AND lot = ${lot} ORDER BY numero`
    console.log(`   stock : ${rouleaux.length} rouleau(x) du lot ${lot} sur la ligne ${ligne}${rouleaux.length ? ` : ${rouleaux.map((r) => `${r.numero} ${r.poids} kg ${r.metrage} m (état ${r.etat})`).join(' ; ')}` : ''}`)
    const journal = await sql<{ evenement: string; detail: string | null; par: string | null }[]>`
      SELECT j.evenement, j.detail, j.par FROM journal_lot j JOIN suivilot s ON s.idsuivilot = j.idsuivilot
      WHERE s.idligne_commande_sous_traitant = ${ligne} AND s.lot = ${lot} ORDER BY j.id`
    if (journal.length) console.log(`   journal du lot : ${journal.map((j) => `${j.evenement} ${j.detail ?? ''} par ${j.par}`).join(' ; ')}`)
  }
}

const probable = arg('probable')
if (probable) {
  const run = await rejouer(probable, false)
  if (run) await montrer('Numéro de commande inutilisable : la commande par les pièces', run)
}
const seul = arg('seul')
if (seul) {
  const run = await rejouer(seul, true)
  if (run) await montrer('BL sans aucun contrôle, tiré « seul » : réceptionné par Tricobot', run)
}
const corrige = arg('corrige')
if (corrige) {
  const run = await rejouer(corrige, true)
  if (run) {
    const res = run.resultat as unknown as ResultatBl
    const ligne = res.resolution?.ligneId ?? 0
    const lot = res.resolution?.lot ?? ''
    const [r] = await sql<{ id: number; numero: string; lot: string; poids: number; metrage: number }[]>`
      SELECT idstock_fini AS id, numero, lot, poids, metrage FROM stock_fini WHERE idref_commande_source = ${ligne} AND lot = ${lot} ORDER BY numero LIMIT 1`
    if (r) {
      // What PATCH …/pieces/fini/:id does for « Corriger la réception »: the roll, then Tricobot's point.
      const apres = { metrage: Math.round((Number(r.metrage) - 2) * 10) / 10 }
      await sql`UPDATE stock_fini SET metrage = ${apres.metrage} WHERE idstock_fini = ${r.id}`
      const juges = await rouleauCorrige(ligne, lot, correctionsRouleau(r, apres).join(' ; '), { id: 1, nom: 'Essai v5' })
      console.log(`\nRouleau ${r.numero} corrigé (${r.metrage} → ${apres.metrage} m) : ${juges} point(s) de Tricobot jugé(s).`)
    }
    await montrer('BL réceptionné seul, puis un rouleau corrigé par une personne', run)
  }
}

await sql.end({ timeout: 5 }).catch(() => {})
process.exit(0)
