// Flux Ennoblisseur › BL — the delivery note as a POINT, like a délai or a
// lot's controls (claude_doc/agents_autonomie.md §3 and §7, 2026-11-11).
//
// Until now a BL was only a run: « écrit » filled the réception's pre-fill
// (data_bl_tricotbot) and a person had to know it was there, tick the tombés de
// métier and open the réception. It now leaves a point in PG `saisie_agent`
// too (competence 'bl', champ 'reception'), so the order's card turns red and
// Tricobot takes the order over with his proposal:
//   saisie  the BL passed every check: « je propose de réceptionner ces N
//           rouleaux » — Valider = the réception, done here by the code;
//   aide    a blocking check stopped it: he says why, shows what he read, and
//           the person settles it, then answers « avais-je raison de demander ? ».
// The proposal (`proposition`) is one canonical JSON text: the bordereau, the
// lot and the pieces as read. Validating receives exactly what was shown.
//
// The réception itself is the route's own rule (recevoirPiecesFini in
// routes/commandes-sous-traitant.ts): one roll « En contrôle » per piece, the
// lot in Suivi lots, its Journal — signed by whoever validates.

import type { Sql } from 'postgres'
import { mpsPg } from '../../mps-pg.js'
import { query } from '../../hfsql-auto.js'
import { esc } from '../../sst-shared.js'
import { consumedEcruIds, mergedNumero } from '../../fini-sources.js'
import type { AgentRun } from '../store.js'
import { composantsDe, type BlExtraction, type Controle } from '../bl-extraction.js'
import { profilDe } from '../bl-profils.js'
import type { Resolution } from '../bl-ennoblisseur-db.js'
import { enregistrerSaisie, GesteRefuse, type Auteur, type NouvelleSaisie } from './saisies.js'

/** `saisie_agent.champ` of a BL point. */
export const CHAMP_RECEPTION = 'reception'

export interface PieceProposee {
  /** As printed on the BL (« 3510/11+3510/2 » for a joined roll). */
  numero: string
  /** kg — null when the dyer's weight is not kept (Malterre weighs: the écru's weight stands). */
  poids: number | null
  /** m — null when unreadable (an aide). */
  metrage: number | null
  observations: string
}

export interface PropositionReception {
  bordereau: string
  lot: string
  ennoblisseur: string | null
  pieces: PieceProposee[]
}

const nombre = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null)

/** One canonical text per proposal (what `proposition` holds). */
export const texteReception = (p: PropositionReception): string =>
  JSON.stringify({
    bordereau: p.bordereau,
    lot: p.lot,
    ennoblisseur: p.ennoblisseur,
    pieces: p.pieces.map((x) => ({ numero: x.numero, poids: nombre(x.poids), metrage: nombre(x.metrage), observations: x.observations })),
  })

export function lireReception(v: string | null): PropositionReception | null {
  if (!v) return null
  try {
    const o = JSON.parse(v) as Partial<PropositionReception>
    if (!Array.isArray(o.pieces)) return null
    return {
      bordereau: String(o.bordereau ?? ''),
      lot: String(o.lot ?? ''),
      ennoblisseur: o.ennoblisseur ? String(o.ennoblisseur) : null,
      pieces: o.pieces.map((x) => ({
        numero: String(x?.numero ?? '').trim(),
        poids: nombre(x?.poids),
        metrage: nombre(x?.metrage),
        observations: String(x?.observations ?? '').trim(),
      })),
    }
  } catch {
    return null
  }
}

export const lotNormalise = (lot: string) => lot.toUpperCase().replace(/\s+/g, '')

interface ResultatLu {
  profil?: string | null
  extraction?: BlExtraction | null
  resolution?: Partial<Resolution> | null
  controles?: Controle[] | null
}

/** The pieces of a BL as the réception receives them: a piece printed twice
 *  (cut by the dyer, one part unweighed) is one roll — the weighed line, like
 *  the réception dialog, which keeps the last row per numero. Pure. */
export function piecesProposees(e: BlExtraction, ecritPoids: boolean): PieceProposee[] {
  const parNumero = new Map<string, PieceProposee>()
  for (const p of e.pieces) {
    const numero = p.numero_piece.trim()
    const avant = parNumero.get(numero)
    if (avant && (avant.poids ?? 0) > 0 && !((p.poids ?? 0) > 0)) continue
    parNumero.set(numero, {
      numero,
      poids: ecritPoids && (p.poids ?? 0) > 0 ? p.poids : null,
      metrage: p.metrage,
      observations: (p.observations ?? '').trim(),
    })
  }
  return [...parNumero.values()]
}

/** The point a BL run leaves, or null (essai, a PDF test, an error, a BL
 *  already imported, a mail that is no BL). Pure. */
export function pointDuRunBl(run: AgentRun): NouvelleSaisie | null {
  if (run.mode !== 'actif' || run.source === 'essai_manuel') return null
  if ((run.competence ?? 'bl') !== 'bl') return null
  if (run.statut !== 'ecrit' && run.statut !== 'a_verifier') return null
  const res = (run.resultat ?? {}) as unknown as ResultatLu
  const e = res.extraction
  if (!e) return null
  const profil = profilDe(res.profil)
  const lot = res.resolution?.lot ?? ''
  const proposition: PropositionReception = {
    bordereau: e.numero_bordereau,
    lot,
    ennoblisseur: profil?.nom ?? null,
    pieces: piecesProposees(e, profil?.ecritPoids ?? false),
  }
  const n = proposition.pieces.length
  const decision = run.statut === 'ecrit' ? 'saisie' : 'aide'
  const bloquants = (res.controles ?? []).filter((c) => c.gravite === 'bloquant' && c.message.trim()).map((c) => c.message.trim())
  return {
    agent: run.slug,
    competence: 'bl',
    version: run.version,
    runId: run.id,
    messageId: run.message?.id ?? null,
    threadId: run.message?.threadId ?? null,
    mode: 'supervise',
    decision,
    idsousTraitant: res.resolution?.sousTraitantId ?? profil?.idSousTraitant ?? 0,
    idcommande: res.resolution?.commandeId ?? 0,
    idligne: res.resolution?.ligneId ?? 0,
    champ: CHAMP_RECEPTION,
    valeurAvant: null,
    etatAvant: null,
    proposition: n > 0 || decision === 'saisie' ? texteReception(proposition) : null,
    ecrit: false,
    explication: decision === 'saisie'
      ? `Chaque pièce du BL est un tombé de métier affecté à cette ligne, et les totaux imprimés tombent juste : ${n} rouleau${n > 1 ? 'x' : ''} à réceptionner sous le lot ${lot}.`
      : (bloquants.length ? bloquants.join('\n') : 'BL laissé à vérifier.'),
    citation: '',
  }
}

/** Record a BL run's point. None when the run leaves none, or when the same
 *  bordereau already waits on the order (a mail re-read). Returns its id. */
export async function enregistrerPointBl(run: AgentRun, sql: Sql = mpsPg()): Promise<number | null> {
  const point = pointDuRunBl(run)
  if (!point) return null
  const bordereau = lireReception(point.proposition)?.bordereau ?? ''
  if (bordereau) {
    const ouvertes = await sql<{ proposition: string | null }[]>`
      SELECT proposition FROM saisie_agent
      WHERE competence = 'bl' AND champ = ${CHAMP_RECEPTION} AND statut = 'a_revoir'
        AND idcommande_sous_traitant = ${point.idcommande} AND idsous_traitant = ${point.idsousTraitant}`
    if (ouvertes.some((o) => lireReception(o.proposition)?.bordereau === bordereau)) return null
  }
  return enregistrerSaisie(point, sql)
}

/** Receive the rolls of a proposal on its line, as the réception dialog would
 *  from Tricobot's pre-fill: one roll per BL piece (a joined roll takes every
 *  component), the lot, the dyer's weight when kept (else the écru's), the
 *  métrage, the dyer's observations. A piece already received under that
 *  numero is left alone, so a validation can be replayed. Returns the number
 *  of rolls received. Throws GesteRefuse with what to do. */
export async function receptionnerProposition(idcommande: number, idligne: number, p: PropositionReception, par: Auteur): Promise<number> {
  const aLaMain = 'Réceptionne ce BL à la main.'
  if (!(idcommande > 0) || !(idligne > 0)) throw new GesteRefuse('ligne_inconnue', `Je ne sais pas sur quelle ligne réceptionner ce BL. ${aLaMain}`)
  if (!p.lot.trim()) throw new GesteRefuse('lot_inconnu', `Je n’ai pas le lot de ce BL. ${aLaMain}`)
  if (p.pieces.length === 0) throw new GesteRefuse('aucune_piece', `Aucune pièce lue sur ce BL. ${aLaMain}`)
  const [ligne] = await query<{ IDreference: number | null }>(
    `SELECT IDreference FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant = ${Math.trunc(idligne)} AND IDcommande_sous_traitant = ${Math.trunc(idcommande)}`,
  )
  const idRefFini = Number(ligne?.IDreference) || 0
  if (!idRefFini) throw new GesteRefuse('ligne_inconnue', `Ligne de commande introuvable. ${aLaMain}`)

  const ecrus = await query<{ IDstock_ecru: number; numero: string | null; poids: number | null }>(
    `SELECT IDstock_ecru, numero, poids FROM stock_ecru WHERE IDref_commande_affectation = ${Math.trunc(idligne)}`,
  )
  const parNumero = new Map(ecrus.map((r) => [String(r.numero ?? '').trim(), r]))
  const consommes = await consumedEcruIds(ecrus.map((r) => Number(r.IDstock_ecru)))
  const dejaRecus = new Set((await query<{ numero: string | null }>(
    `SELECT numero FROM stock_fini WHERE IDref_commande_source = ${Math.trunc(idligne)}`,
  )).map((r) => String(r.numero ?? '').trim()))

  const pieces: Array<Record<string, unknown>> = []
  for (const x of p.pieces) {
    const composants = composantsDe(x.numero)
    const numero = composants.length > 1 ? mergedNumero(composants) : x.numero
    if (dejaRecus.has(numero)) continue
    if (x.metrage == null || x.metrage < 0) throw new GesteRefuse('metrage_manquant', `Je n’ai pas le métrage de la pièce ${x.numero}. ${aLaMain}`)
    const sources = composants.map((c) => parNumero.get(c))
    const absent = composants.find((_, i) => !sources[i])
    if (absent) throw new GesteRefuse('piece_introuvable', `La pièce ${absent} n’est pas un tombé de métier affecté à cette ligne. ${aLaMain}`)
    const dejaPris = sources.find((s) => consommes.has(Number(s!.IDstock_ecru)))
    if (dejaPris) throw new GesteRefuse('piece_deja_recue', `Le tombé de métier ${String(dejaPris.numero ?? '').trim()} est déjà réceptionné. ${aLaMain}`)
    if (numero.length > 20) throw new GesteRefuse('numero_trop_long', `Le rouleau ${numero} regroupe trop de pièces pour être réceptionné d’ici. ${aLaMain}`)
    const poidsEcru = Math.round(sources.reduce((s, r) => s + (Number(r!.poids) || 0), 0) * 10) / 10
    const ids = sources.map((s) => Number(s!.IDstock_ecru))
    pieces.push({
      numero,
      lot: p.lot.trim(),
      poids: x.poids != null && x.poids > 0 ? x.poids : poidsEcru,
      metrage: x.metrage,
      IDstock_ecru: ids[0],
      ...(ids.length > 1 ? { IDstock_ecru_sources: ids } : {}),
      IDref_fini: idRefFini,
      IDmagasin: 0,
      observations: '',
      observation_sst: x.observations,
    })
  }
  if (pieces.length === 0) return 0
  // Imported here: the route file imports this folder (a cycle at module load otherwise).
  const { recevoirPiecesFini, RefusReception } = await import('../../../routes/commandes-sous-traitant.js')
  try {
    return await recevoirPiecesFini(idcommande, idligne, pieces as never, { id: par.id, nom: par.nom })
  } catch (e) {
    if (e instanceof RefusReception) throw new GesteRefuse(String(e.corps.error ?? 'reception_refusee'), String(e.corps.message ?? e.corps.error ?? 'Réception refusée.'))
    throw e
  }
}

/** The pre-fill rows of a lot on a line, removed (« pas à réceptionner »): the
 *  réception dialog must not offer them again. The PDF stays on the order. */
export async function retirerPreRemplissage(idligne: number, lot: string): Promise<number> {
  if (!(idligne > 0) || !lot.trim()) return 0
  const rows = await query<{ IDdata_bl_tricotbot: number }>(
    `SELECT IDdata_bl_tricotbot FROM data_bl_tricotbot WHERE IDligne_commande_sous_traitant = ${Math.trunc(idligne)} AND lot = '${esc(lot.trim())}'`,
  )
  const ids = rows.map((r) => Number(r.IDdata_bl_tricotbot)).filter((x) => x > 0)
  if (ids.length) await query(`DELETE FROM data_bl_tricotbot WHERE IDdata_bl_tricotbot IN (${ids.join(',')})`)
  return ids.length
}
