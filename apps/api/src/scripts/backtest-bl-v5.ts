// Backtest of BL v5 on the runs already acquired (2026-11-27). Nothing is
// written and no model is called: v5 changes neither the OCR nor the prompt, so
// each stored extraction is resolved again, read-only, by the code BEFORE (another
// checkout, --avant) and the code of this checkout, on the same database.
//
//   node --env-file=.env.development --import tsx src/scripts/backtest-bl-v5.ts <runs-bl-ennoblisseur.json> --avant=<other checkout>/apps/api/src
//
// Three reports:
//   1. Regression: every BL whose decision, checks or resolution differ between
//      the two codes. Expected: only the BLs whose printed order number could
//      not be used.
//   2. The rule itself (overfitting): on every BL that was written on an order
//      and validated by a person, the order number is hidden and the pieces
//      alone must name it. Counted: same order, another order, no answer.
//   3. Autonomy: among the BLs written, those a draw could have received alone
//      (not a single check raised, no reprise), and how people judged them.
//
// The database is today's, not the day's of each BL: a BL received since is
// seen as already received by both codes alike, so the comparison holds.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { closeConnection } from '../lib/hfsql-auto.js'
import { controlerExtraction, estBloquant, type BlExtraction, type Controle } from '../lib/agents/bl-extraction.js'
import { profilDe, reglesDe, type TypeDocument } from '../lib/agents/bl-profils.js'
import { cleDeLigne, poidsEcrit, resoudreBl, type Resolution } from '../lib/agents/bl-ennoblisseur-db.js'
import { seulPossible } from '../lib/agents/flux-ennoblisseur/reception-bl.js'
import { messageCommentaire } from '../lib/agents/bl-ennoblisseur.js'

const fichier = process.argv[2]
const avantDir = process.argv.find((a) => a.startsWith('--avant='))?.slice('--avant='.length)
if (!fichier || !avantDir) {
  console.error('usage: backtest-bl-v5.ts <runs-bl-ennoblisseur.json> --avant=<checkout>/apps/api/src')
  process.exit(1)
}
const charger = (f: string) => import(pathToFileURL(path.join(avantDir, 'lib/agents', f)).href)
const avant = {
  db: (await charger('bl-ennoblisseur-db.ts')) as { resoudreBl: (e: BlExtraction, p: unknown, t: TypeDocument) => Promise<Resolution> },
  ex: (await charger('bl-extraction.ts')) as { controlerExtraction: typeof controlerExtraction; estBloquant: typeof estBloquant },
  pr: (await charger('bl-profils.ts')) as { profilDe: typeof profilDe; reglesDe: typeof reglesDe },
}

interface RunLu {
  id: string; createdAt: string; version: number; statut: string; mode: string; source: string; competence?: string; resume: string
  evaluation?: { note: string } | null
  verification?: { statutAvant: string } | null
  resultat: {
    profil?: string | null; typeDocument?: TypeDocument | null; extraction?: BlExtraction | null; resolution?: Partial<Resolution> | null; controles?: Controle[]
    pages?: Array<{ ocr: string | null }>
  }
}
const runs = (JSON.parse(fs.readFileSync(fichier, 'utf8')) as RunLu[])
  .filter((r) => (r.competence ?? 'bl') === 'bl' && r.resultat?.extraction && r.source !== 'essai_manuel')

type Decision = 'ecrit' | 'deja_importe' | 'a_verifier'
interface Issue { decision: Decision; controles: Controle[]; resolution: Resolution | null }

const decider = (e: BlExtraction, controles: Controle[], resolution: Resolution | null, ecritPoids: (p: number | null) => number, bloquant: typeof estBloquant): Decision => {
  if (bloquant(controles)) return 'a_verifier'
  const deja = new Set(resolution?.dejaImportees ?? [])
  return e.pieces.every((p) => deja.has(cleDeLigne(p.numero_piece, ecritPoids(p.poids), p.metrage))) ? 'deja_importe' : 'ecrit'
}

async function ancien(e: BlExtraction, cle: string, type: TypeDocument): Promise<Issue> {
  const profil = avant.pr.profilDe(cle)!
  const controles = avant.ex.controlerExtraction(e, avant.pr.reglesDe(profil))
  let resolution: Resolution | null = null
  if (!controles.some((c) => c.code === 'commande_format')) {
    resolution = await avant.db.resoudreBl(e, profil, type)
    controles.push(...resolution.controles)
  }
  return { decision: decider(e, controles, resolution, (p) => poidsEcrit(profil, p), avant.ex.estBloquant), controles, resolution }
}

/** The dyer's header comment, as this checkout reads it on the stored OCR text. */
const commentaireDe = (r: RunLu): Controle[] => {
  const profil = profilDe(r.resultat.profil ?? 'matel')!
  const c = profil.commentaire?.((r.resultat.pages ?? []).map((p) => p.ocr ?? '').join('\n')) ?? null
  return c ? [{ code: 'commentaire_entete', gravite: 'avertissement', message: messageCommentaire(profil.nom, c) }] : []
}

async function nouveau(e: BlExtraction, cle: string, type: TypeDocument, r: RunLu): Promise<Issue> {
  const profil = profilDe(cle)!
  const controles = controlerExtraction(e, reglesDe(profil))
  controles.push(...commentaireDe(r))
  const resolution = await resoudreBl(e, profil, type, { commandeIllisible: controles.some((c) => c.code === 'commande_format') })
  controles.push(...resolution.controles)
  return { decision: decider(e, controles, resolution, (p) => poidsEcrit(profil, p), estBloquant), controles, resolution }
}

/** What a resolution says, without its checks (compared apart). */
const coeur = (r: Resolution | null) => r && {
  commandeId: r.commandeId, sousTraitantId: r.sousTraitantId, lignes: r.lignes, ligneId: r.ligneId, lot: r.lot, nomGed: r.nomGed,
  pieces: r.pieces, dejaImportees: r.dejaImportees, gedExistant: r.gedExistant, reprise: r.reprise ?? null, ecartsRecus: r.ecartsRecus ?? null,
}
const texteControles = (cs: Controle[]) => cs.map((c) => `${c.gravite} ${c.code} ${c.message}`)
const pareil = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// ── 1. Regression ────────────────────────────────────────
console.log(`\n══ 1. Régression : ${runs.length} BL lus (toutes versions), ancien code et nouveau code sur la même base ══`)
const bilan = { identiques: 0, commentaireSeul: 0, differents: 0 }
const commentaires: string[] = []
const transitions: Record<string, number> = {}
const differents: string[] = []
for (const r of runs) {
  const e = r.resultat.extraction!
  const cle = r.resultat.profil ?? 'matel'
  const type = r.resultat.typeDocument ?? 'bl'
  const a = await ancien(e, cle, type)
  const n = await nouveau(e, cle, type, r)
  const t = `${a.decision} → ${n.decision}`
  transitions[t] = (transitions[t] ?? 0) + 1
  if (a.decision === n.decision && pareil(texteControles(a.controles), texteControles(n.controles)) && pareil(coeur(a.resolution), coeur(n.resolution))) {
    bilan.identiques++
    continue
  }
  // The only change: the dyer's header comment, now said (a warning, same decision).
  const sansCommentaire = n.controles.filter((c) => c.code !== 'commentaire_entete')
  if (a.decision === n.decision && pareil(texteControles(a.controles), texteControles(sansCommentaire)) && pareil(coeur(a.resolution), coeur(n.resolution))) {
    bilan.commentaireSeul++
    commentaires.push(`   ${r.createdAt.slice(0, 10)} ${e.numero_bordereau.padEnd(8)} ${n.controles.find((c) => c.code === 'commentaire_entete')!.message}`)
    continue
  }
  bilan.differents++
  const lignes = [`── ${r.createdAt.slice(0, 10)} v${r.version} ${r.id} · à l’époque : ${r.statut} · ${r.resume.slice(0, 110)}`]
  lignes.push(`   AVANT  ${a.decision} · commande ${a.resolution?.commandeId ?? '—'} · ligne ${a.resolution?.ligneId ?? '—'} · lot ${a.resolution?.lot || '—'}`)
  for (const c of a.controles) lignes.push(`          ${c.gravite === 'bloquant' ? '⛔' : '⚠'} ${c.code} : ${c.message}`)
  lignes.push(`   APRÈS  ${n.decision} · commande ${n.resolution?.commandeId ?? '—'} · ligne ${n.resolution?.ligneId ?? '—'} · lot ${n.resolution?.lot || '—'}${n.resolution?.commandeProbable ? ` · commande probable ${n.resolution.commandeProbable}` : ''}`)
  for (const c of n.controles) lignes.push(`          ${c.gravite === 'bloquant' ? '⛔' : '⚠'} ${c.code} : ${c.message}`)
  differents.push(lignes.join('\n'))
}
console.log(`identiques : ${bilan.identiques} · même décision, le commentaire de l’ennoblisseur en plus : ${bilan.commentaireSeul} · autres différences : ${bilan.differents}`)
console.log('décisions (avant → après) :', JSON.stringify(transitions))
for (const d of differents) console.log(d)
console.log(`\n── Les ${commentaires.length} BL dont le commentaire d’en-tête est maintenant signalé (avertissement, décision inchangée) ──`)
for (const c of commentaires) console.log(c)

// ── 2. The rule, on the BLs whose order is known ─────────
// Written by the agent on an order and validated by a person at the réception:
// that order is the truth. The printed number is hidden; the pieces must name it.
const sure = runs.filter((r) => r.statut === 'ecrit' && r.evaluation?.note === 'reussite' && r.resultat.resolution?.commandeId)
console.log(`\n══ 2. La règle « commande d’après les pièces », numéro de commande caché, sur ${sure.length} BL écrits et validés ══`)
const regle = { meme: 0, autre: 0, sansReponse: 0 }
const parTaille: Record<string, { n: number; meme: number }> = {}
for (const r of sure) {
  const e = r.resultat.extraction!
  const profil = profilDe(r.resultat.profil ?? 'matel')!
  const res = await resoudreBl(e, profil, r.resultat.typeDocument ?? 'bl', { commandeIllisible: true })
  const vrai = Number(r.resultat.resolution!.commandeId)
  const taille = e.pieces.length === 1 ? '1 pièce' : e.pieces.length <= 5 ? '2 à 5 pièces' : '6 pièces et plus'
  const t = (parTaille[taille] ??= { n: 0, meme: 0 })
  t.n++
  if (res.commandeProbable === vrai) { regle.meme++; t.meme++ }
  else if (res.commandeProbable) {
    regle.autre++
    console.log(`   ✗ AUTRE COMMANDE ${r.id} ${r.resume.slice(0, 90)} : vraie ${vrai}, déduite ${res.commandeProbable}`)
  } else {
    regle.sansReponse++
    const pourquoi = res.controles.find((c) => c.code === 'commande_par_pieces')?.message ?? '(aucune pièce)'
    console.log(`   · sans réponse ${r.id} ${r.createdAt.slice(0, 10)} cde ${vrai} : ${pourquoi.slice(0, 200)}`)
  }
}
console.log(`même commande : ${regle.meme} · autre commande : ${regle.autre} · sans réponse : ${regle.sansReponse}`)
console.log('par taille de BL :', JSON.stringify(parTaille))

// ── 3. Autonomy: what a draw could have received alone ───
const ecrits = runs.filter((r) => r.statut === 'ecrit' && r.mode === 'actif')
console.log(`\n══ 3. Autonomie : parmi les ${ecrits.length} BL écrits, ceux qu’un tirage aurait pu réceptionner seul avec les règles de la v5 ══`)
console.log('   (aucun contrôle levé ce jour-là, aucun par les contrôles d’aujourd’hui sur le BL lui-même, pas de commentaire, pas de reprise)')
/** The run's own checks and resolution (the stock of that day), plus what
 *  today's code says of the document itself: its checks without the database,
 *  and the dyer's comment. */
const controlesV5 = (r: RunLu): Controle[] => {
  const profil = profilDe(r.resultat.profil ?? 'matel')!
  return [...(r.resultat.controles ?? []), ...controlerExtraction(r.resultat.extraction!, reglesDe(profil)), ...commentaireDe(r)]
}
const eligible = (r: RunLu) => seulPossible(controlesV5(r), r.resultat.resolution ?? null)
const parVersion: Record<string, { ecrits: number; eligibles: number; valides: number; corriges: number; sansAvis: number }> = {}
for (const r of ecrits) {
  const v = (parVersion[`v${r.version}`] ??= { ecrits: 0, eligibles: 0, valides: 0, corriges: 0, sansAvis: 0 })
  v.ecrits++
  if (!eligible(r)) continue
  v.eligibles++
  if (r.evaluation?.note === 'reussite') v.valides++
  else if (r.evaluation) {
    v.corriges++
    console.log(`   ✗ aurait été réceptionné seul puis corrigé : ${r.createdAt.slice(0, 10)} v${r.version} ${r.id} ${r.resume.slice(0, 100)}`)
  } else v.sansAvis++
}
console.log(JSON.stringify(parVersion, null, 1))
// The BLs written, corrected by a person since, that the v5 rules keep away from a réception alone: why.
for (const r of ecrits.filter((x) => x.evaluation && x.evaluation.note !== 'reussite' && !eligible(x))) {
  console.log(`   ✓ corrigé à l’époque, jamais seul en v5 : ${r.createdAt.slice(0, 10)} v${r.version} ${r.resume.slice(0, 70)} · ${[...new Set(controlesV5(r).map((c) => c.code))].join(', ') || 'reprise'}`)
}

await closeConnection()
process.exit(0)
