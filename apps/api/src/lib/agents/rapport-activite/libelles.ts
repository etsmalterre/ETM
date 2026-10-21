// Agent « Rapport d'activité » — what a journal line means, in French, with
// the numbers people see on screen (2026-10-07).
//
// The journal stores the API path and a summary of the body: « DELETE
// /api/commandes-client/7001/lignes/12856/supply/ennoblissement/9066/rolls/57912 ».
// Read raw, it misled both the reader and the model (7001 is order N° 3762,
// 9066 a sst LINE, 57912 the écru piece 3510/11; and that DELETE releases a
// reservation, it deletes nothing). Each known route gets a sentence here;
// the ids are resolved in one batch per table (chargerRefs). An unknown route
// falls back to the raw path, with its body for the model.
//
// `retrait`: a DELETE that only unlinks (a reservation, a piece taken off an
// order or a transfer) — not counted as a deletion by the code signals.

import { mpsPg } from '../../mps-pg.js'
import { SUIVIS, type LigneJournal } from '../../journal-activite.js'
import { phrases } from './changements.js'

export interface Refs {
  /** commande_client (ETM and TRM) → on-screen numero + client name. */
  commandes: Map<number, { numero: string; client: string }>
  /** ligne_commande_client → its commande_client. */
  lignesClient: Map<number, number>
  /** ligne_commande_sous_traitant → its commande_sous_traitant. */
  lignesSst: Map<number, number>
  /** commande_sous_traitant → its sous-traitant id. */
  commandesSst: Map<number, number>
  /** sous_traitant (also the magasin ids, 0 = Malterre) → name. */
  sousTraitants: Map<number, string>
  ecru: Map<number, string>
  fini: Map<number, string>
  /** suivilot → lot. */
  lots: Map<number, string>
  utilisateurs: Map<number, string>
  /** commande_fil (its id IS the on-screen N°) → its fournisseur id. */
  commandesFil: Map<number, number>
  /** ref_fil_commande → its commande_fil. */
  lignesFil: Map<number, number>
  fournisseurs: Map<number, string>
  refsFil: Map<number, string>
  /** colori_fil → its reference (an offer or an order line is per coloris). */
  colorisFil: Map<number, string>
  clients: Map<number, string>
  refsDivers: Map<number, string>
  refsFini: Map<number, string>
  /** facture → its on-screen numero. */
  factures: Map<number, string>
  /** « table:id » of an order line (SUIVIS) → « EDF85/55 739 peau rosée ». */
  articles: Map<string, string>
}

export const refsVides = (): Refs => ({
  commandes: new Map(),
  lignesClient: new Map(),
  lignesSst: new Map(),
  commandesSst: new Map(),
  sousTraitants: new Map(),
  ecru: new Map(),
  fini: new Map(),
  lots: new Map(),
  utilisateurs: new Map(),
  commandesFil: new Map(),
  lignesFil: new Map(),
  fournisseurs: new Map(),
  refsFil: new Map(),
  colorisFil: new Map(),
  clients: new Map(),
  refsDivers: new Map(),
  refsFini: new Map(),
  factures: new Map(),
  articles: new Map(),
})

export interface Description {
  texte: string
  /** A DELETE that only unlinks. */
  retrait: boolean
  /** A known route: the sentence says it all, the raw body is not needed. */
  connue: boolean
  /** A save that changed nothing on its row (journal_activite.changements
   *  = {}): the screen's « Enregistrer » sent the header along with the
   *  line. Left out of the report. */
  sansEffet?: boolean
  /** Piece routes only — what regrouper() needs to merge a run. */
  groupe?: string
  numero?: string
  genre?: 'ecru' | 'fini' | '?'
  refaire?: (p: Pieces) => string
}

type Corps = Record<string, unknown>

/** The stored body summary (lib/journal-activite.ts resumerCorps), or {}. */
export function lireCorps(corps: string | null): Corps {
  if (!corps) return {}
  try {
    const v = JSON.parse(corps)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Corps) : {}
  } catch {
    return {}
  }
}

/** Ids of a (possibly shortened: « … 6 de plus ») array of the body. */
function idsDe(v: unknown): { ids: number[]; total: number } {
  if (!Array.isArray(v)) return { ids: [], total: 0 }
  const ids = v.filter((x): x is number => typeof x === 'number')
  const plus = v.map((x) => (typeof x === 'string' ? /… (\d+) de plus/.exec(x) : null)).find(Boolean)
  return { ids, total: ids.length + (plus ? parseInt(plus[1], 10) : 0) }
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : NaN)
const txt = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const nombre = (v: unknown, unite: string) => (typeof v === 'number' ? `${String(v).replace('.', ',')} ${unite}` : '')
/** « 20261106 » → « 06/11/2026 ». */
const date = (v: unknown) => (/^\d{8}$/.test(txt(v)) ? `${txt(v).slice(6, 8)}/${txt(v).slice(4, 6)}/${txt(v).slice(0, 4)}` : txt(v))
const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? 's' : ''}`
const destinataires = (v: unknown) => {
  const a = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.includes('@')) : []
  return a.length ? ` à ${a[0]}${a.length > 1 ? ` (+${a.length - 1})` : ''}` : ''
}
const entre = (...p: string[]) => {
  const t = p.filter(Boolean).join(', ')
  return t ? ` (${t})` : ''
}

// ── Names ────────────────────────────────────────────────

const cmd = (r: Refs, id: number, quoi = 'commande client') => {
  const c = r.commandes.get(id)
  return c ? `${quoi} N° ${c.numero}${c.client ? ` (${c.client})` : ''}` : `${quoi} #${id}`
}
const cmdLigne = (r: Refs, ligne: number, quoi?: string) => {
  const c = r.lignesClient.get(ligne)
  return c ? cmd(r, c, quoi) : `${quoi ?? 'commande client'} (ligne #${ligne})`
}
const sstNom = (r: Refs, id: number) => (id === 0 ? 'Malterre' : (r.sousTraitants.get(id) ?? `sous-traitant #${id}`))
const sst = (r: Refs, id: number) => {
  const s = r.commandesSst.get(id)
  return `commande sous-traitant N° ${id}${s !== undefined ? ` (${sstNom(r, s)})` : ''}`
}
const sstLigne = (r: Refs, ligne: number) => {
  const c = r.lignesSst.get(ligne)
  return c ? sst(r, c) : `commande sous-traitant (ligne #${ligne})`
}
const ecru = (r: Refs, id: number) => `pièce ${r.ecru.get(id) ?? `#${id}`}`
const fini = (r: Refs, id: number) => `rouleau ${r.fini.get(id) ?? `#${id}`}`
/** « pièces 3510/11, 3510/12 » or « 26 pièces » past five. */
const pieces = (r: Refs, v: unknown, genre: 'ecru' | 'fini' | '?' = '?') => {
  const { ids, total } = idsDe(v)
  if (!total) return 'des pièces'
  if (total <= 5 && ids.length === total) return `${total > 1 ? 'pièces' : 'pièce'} ${ids.map((i) => (genre === 'fini' ? r.fini.get(i) : genre === 'ecru' ? r.ecru.get(i) : (r.ecru.get(i) ?? r.fini.get(i))) ?? `#${i}`).join(', ')}`
  return pluriel(total, 'pièce')
}
const fournisseur = (r: Refs, id: number) => r.fournisseurs.get(id) ?? `fournisseur #${id}`
const cmdFil = (r: Refs, id: number) => {
  const f = r.commandesFil.get(id)
  return `commande de fil N° ${id}${f !== undefined && r.fournisseurs.get(f) ? ` (${r.fournisseurs.get(f)})` : ''}`
}
/** A deleted line can no longer be traced to its order. */
const cmdFilLigne = (r: Refs, ligne: number) => {
  const c = r.lignesFil.get(ligne)
  return c ? cmdFil(r, c) : 'commande de fil'
}
const refFil = (r: Refs, id: unknown) => {
  const n = r.refsFil.get(num(id))
  return n ? `« ${n} »` : ''
}
/** « coloris Écru » when the body names one. */
const colorisFil = (r: Refs, id: unknown) => {
  const n = r.colorisFil.get(num(id))
  return n ? `coloris « ${n} »` : ''
}
const client = (r: Refs, id: unknown) => r.clients.get(num(id)) ?? `client #${num(id)}`
const refFini = (r: Refs, id: unknown) => {
  const n = r.refsFini.get(num(id))
  return n ? `réf. fini ${n}` : ''
}
/** A user-typed text, quoted and cut. */
const cite = (v: unknown, n = 160) => {
  const t = txt(v).replace(/\s+/g, ' ')
  return t ? `« ${t.length > n ? `${t.slice(0, n)}…` : t} »` : ''
}
/** Corrections counted from a list or its stored summary « [2 éléments] ». */
const nbElements = (v: unknown) => (Array.isArray(v) ? v.length : Number(/\[(\d+) éléments?\]/.exec(txt(v))?.[1] ?? 0))
const nomPieceId = (r: Refs, id: unknown) => r.fini.get(num(id)) ?? r.ecru.get(num(id)) ?? `#${num(id)}`
const objets = (v: unknown): Corps[] => (Array.isArray(v) ? v.filter((x): x is Corps => !!x && typeof x === 'object' && !Array.isArray(x)) : [])

const docType = (sur: string) =>({ POST: `Ajout d’un document sur ${sur}`, PUT: `Modification d’un document de ${sur}`, DELETE: `Suppression d’un document de ${sur}` })

// ── Routes ───────────────────────────────────────────────

/** The piece(s) a route acts on, ready for a sentence: one, or a run of the
 *  same action merged by regrouper(). */
export interface Pieces {
  n: number
  /** « de la pièce 3510/11 » · « de 20 pièces (3599/7, 3599/8 … 3599/26) » */
  de: string
  /** Agreement: '' or 's'. */
  s: string
}

type Genre = 'ecru' | 'fini' | '?'

export function lotPieces(numeros: readonly string[], genre: Genre): Pieces {
  const rouleau = genre === 'fini'
  if (numeros.length === 1) return { n: 1, de: rouleau ? `du rouleau ${numeros[0]}` : `de la pièce ${numeros[0]}`, s: '' }
  const tri = [...numeros].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }))
  const liste = tri.length <= 6 ? tri.join(', ') : `${tri.slice(0, 2).join(', ')} … ${tri.slice(-2).join(', ')}`
  return { n: tri.length, de: `de ${tri.length} ${rouleau ? 'rouleaux' : 'pièces'} (${liste})`, s: 's' }
}

const nomPiece = (r: Refs, id: number, genre: Genre) =>
  (genre === 'fini' ? r.fini.get(id) : genre === 'ecru' ? r.ecru.get(id) : (r.ecru.get(id) ?? r.fini.get(id))) ?? `#${id}`

interface Route {
  m: string
  re: RegExp
  retrait?: boolean
  /** The last captured id is a piece of this kind: a run of the same action
   *  on several pieces merges into one line (regrouper). */
  piece?: Genre
  f: (g: number[], b: Corps, r: Refs, m: string, p: Pieces) => string
}

const P = '^/api/'
const CC = `${P}commandes-client/(\\d+)`
const CS = `${P}commandes-sous-traitant/(\\d+)`
const TR = `${P}transferts/(?:rouleaux|fils)`

const ROUTES: Route[] = [
  // Clients › Commandes
  { m: 'POST', re: /^\/api\/commandes-client$/, f: () => 'Création d’une commande client' },
  { m: 'PUT', re: new RegExp(`${CC}$`), f: ([c], b, r) => `Modification de la ${cmd(r, c)}${entre(txt(b.ref_client) && `réf. client « ${txt(b.ref_client)} »`)}` },
  { m: 'PUT', re: new RegExp(`${CC}/etat$`), f: ([c], _b, r) => `Changement d’état de la ${cmd(r, c)}` },
  { m: 'DELETE', re: new RegExp(`${CC}$`), f: ([c], _b, r) => `Suppression de la ${cmd(r, c)}` },
  { m: 'POST', re: new RegExp(`${CC}/lignes$`), f: ([c], b, r) => `Ajout d’une ligne à la ${cmd(r, c)}${entre(nombre(b.quantite, 'u.'), nombre(b.prix, '€'))}` },
  {
    m: 'PUT',
    re: /^\/api\/commandes-client\/lignes\/(\d+)$/,
    f: ([l], b, r) => `Modification d’une ligne de la ${cmdLigne(r, l)}${entre(typeof b.quantite === 'number' ? `quantité ${b.quantite}` : '', nombre(b.prix, '€'), b.date_livraison ? `livraison ${date(b.date_livraison)}` : '')}`,
  },
  { m: 'DELETE', re: /^\/api\/commandes-client\/lignes\/(\d+)$/, f: ([l], _b, r) => `Suppression d’une ligne de la ${cmdLigne(r, l)}` },
  { m: 'PUT', piece: 'ecru', re: new RegExp(`${CC}/lignes/\\d+/pieces/ecru/(\\d+)$`), f: ([c], _b, r, _m, p) => `Affectation ${p.de} à la ${cmd(r, c)}` },
  { m: 'PUT', piece: 'fini', re: new RegExp(`${CC}/lignes/\\d+/pieces/fini/(\\d+)$`), f: ([c], _b, r, _m, p) => `Affectation ${p.de} à la ${cmd(r, c)}` },
  { m: 'DELETE', retrait: true, piece: 'ecru', re: new RegExp(`${CC}/lignes/\\d+/pieces/ecru/(\\d+)$`), f: ([c], _b, r, _m, p) => `Désaffectation ${p.de} de la ${cmd(r, c)}` },
  { m: 'DELETE', retrait: true, piece: 'fini', re: new RegExp(`${CC}/lignes/\\d+/pieces/fini/(\\d+)$`), f: ([c], _b, r, _m, p) => `Désaffectation ${p.de} de la ${cmd(r, c)}` },
  { m: 'POST', re: new RegExp(`${CC}/lignes/\\d+/pieces/(?:ecru|fini)/affecter$`), f: ([c], b, r) => `Affectation de ${pieces(r, b.stockIds)} à la ${cmd(r, c)}` },
  { m: 'PUT', re: new RegExp(`${CC}/lignes/\\d+/pieces/ecru/(\\d+)/observations$`), f: ([c, p], _b, r) => `Observations de la ${ecru(r, p)} (${cmd(r, c)})` },
  { m: 'PUT', re: new RegExp(`${CC}/lignes/\\d+/pieces/fini/(\\d+)/observations$`), f: ([c, p], _b, r) => `Observations du ${fini(r, p)} (${cmd(r, c)})` },
  {
    m: 'PUT',
    piece: 'ecru',
    re: new RegExp(`${CC}/lignes/\\d+/supply/ennoblissement/(\\d+)/rolls/(\\d+)$`),
    f: ([c, l], _b, r, _m, p) => `Réservation ${p.de} pour la ${cmd(r, c)} — ennoblissement ${sstLigne(r, l)}`,
  },
  {
    m: 'DELETE',
    retrait: true,
    piece: 'ecru',
    re: new RegExp(`${CC}/lignes/\\d+/supply/ennoblissement/(\\d+)/rolls/(\\d+)$`),
    f: ([c, l], _b, r, _m, p) => `Libération ${p.de}, réservée${p.s} pour la ${cmd(r, c)} — ennoblissement ${sstLigne(r, l)}`,
  },
  {
    m: 'POST',
    re: new RegExp(`${CC}/lignes/\\d+/supply/ennoblissement/orders$`),
    f: ([c], b, r) => `Lancement de l’ennoblissement chez ${sstNom(r, num(b.IDsous_traitant))} pour la ${cmd(r, c)} — ${pieces(r, b.stockEcruIds, 'ecru')}`,
  },
  { m: 'POST', re: new RegExp(`${CC}/lignes/\\d+/supply/tricotage/orders$`), f: ([c], _b, r) => `Lancement du tricotage pour la ${cmd(r, c)}` },
  { m: 'PUT', re: new RegExp(`${CC}/lignes/\\d+/supply/tricotage/(\\d+)/affectation$`), f: ([c, l], _b, r) => `Affectation de fils au tricotage ${sstLigne(r, l)} (${cmd(r, c)})` },
  { m: 'POST', re: new RegExp(`${CC}/lignes/\\d+/expedier(?:-divers)?$`), f: ([c], b, r) => `Expédition de ${pieces(r, b.stockIds)} de la ${cmd(r, c)}` },
  { m: 'POST', re: new RegExp(`${CC}/expeditions-divers$`), f: ([c], _b, r) => `Expédition de divers pour la ${cmd(r, c)}` },
  { m: 'PUT', re: new RegExp(`${CC}/donation-pieces$`), f: ([c], _b, r) => `Pièces de la donation ${cmd(r, c, 'commande')}` },
  { m: 'POST', re: new RegExp(`${CC}/email$`), f: ([c], b, r) => `Envoi par mail de la confirmation de la ${cmd(r, c)}${destinataires(b.to)}` },
  { m: 'POST', re: new RegExp(`${CC}/proforma/email$`), f: ([c], b, r) => `Envoi par mail de la proforma de la ${cmd(r, c)}${destinataires(b.to)}` },
  { m: 'POST', re: new RegExp(`${CC}/donation-valeur/email$`), f: ([c], b, r) => `Envoi par mail de la valeur de la donation ${cmd(r, c, 'commande')}${destinataires(b.to)}` },
  { m: 'POST', re: new RegExp(`${CC}/cotes-a-revoir$`), f: ([c], _b, r) => `Côtes à revoir sur la ${cmd(r, c)}` },
  { m: 'POST|PUT|DELETE', re: new RegExp(`${CC}/documents(?:/\\d+)?$`), f: ([c], b, r, m) => `${docType(cmd(r, c))[m as 'POST']}${txt(b.nom) ? ` « ${txt(b.nom)} »` : ''}` },

  // Sous-traitants › Commandes
  { m: 'POST', re: /^\/api\/commandes-sous-traitant$/, f: (_g, b, r) => `Création d’une commande sous-traitant${b.IDsous_traitant !== undefined ? ` chez ${sstNom(r, num(b.IDsous_traitant))}` : ''}` },
  { m: 'PUT', re: new RegExp(`${CS}$`), f: ([s], b, r) => `Modification de la ${sst(r, s)}${entre(txt(b.commentaire) && `commentaire de la commande : « ${txt(b.commentaire)} »`)}` },
  { m: 'PUT', re: new RegExp(`${CS}/etat$`), f: ([s], _b, r) => `Changement d’état de la ${sst(r, s)}` },
  { m: 'DELETE', re: new RegExp(`${CS}$`), f: ([s], _b, r) => `Suppression de la ${sst(r, s)}` },
  { m: 'POST', re: new RegExp(`${CS}/lignes$`), f: ([s], _b, r) => `Ajout d’une ligne à la ${sst(r, s)}` },
  { m: 'PUT', re: /^\/api\/commandes-sous-traitant\/lignes\/(\d+)$/, f: ([l], b, r) => `Modification d’une ligne de la ${sstLigne(r, l)}${entre(txt(b.sstatut) && `statut « ${txt(b.sstatut)} »`, b.date_livraison ? `livraison ${date(b.date_livraison)}` : '')}` },
  { m: 'DELETE', re: /^\/api\/commandes-sous-traitant\/lignes\/(\d+)$/, f: ([l], _b, r) => `Suppression d’une ligne de la ${sstLigne(r, l)}` },
  { m: 'POST', re: new RegExp(`${CS}/lignes/\\d+/affecter$`), f: ([s], b, r) => `Affectation de ${pieces(r, b.stockIds ?? b.stockEcruIds ?? b.ids)} à la ${sst(r, s)}` },
  { m: 'DELETE', retrait: true, re: new RegExp(`${CS}/lignes/\\d+/affectations$`), f: ([s], _b, r) => `Retrait d’affectations de la ${sst(r, s)}` },
  { m: 'POST', re: new RegExp(`${CS}/lignes/\\d+/pieces-fil/rolls$`), f: ([s], _b, r) => `Ajout de bobines de fil à la ${sst(r, s)}` },
  { m: 'PUT', piece: 'ecru', re: new RegExp(`${CS}/lignes/\\d+/pieces/ecru/(\\d+)$`), f: ([s], _b, r, _m, p) => `Ajout ${p.de} à la ${sst(r, s)}` },
  { m: 'DELETE', retrait: true, piece: 'ecru', re: new RegExp(`${CS}/lignes/\\d+/pieces/ecru/(\\d+)$`), f: ([s], _b, r, _m, p) => `Retrait ${p.de} de la ${sst(r, s)}` },
  { m: 'DELETE', retrait: true, piece: 'ecru', re: new RegExp(`${CS}/lignes/\\d+/pieces/ecru/(\\d+)/reservation$`), f: ([s], _b, r, _m, p) => `Libération de la réservation ${p.de} (${sst(r, s)})` },
  {
    m: 'POST',
    re: new RegExp(`${CS}/lignes/\\d+/pieces/fini$`),
    f: ([s], b, r) =>
      `Réception du rouleau fini ${txt(b.numero) || '?'}${entre(nombre(b.poids, 'kg'), nombre(b.metrage, 'm'))} — ${sst(r, s)}${txt(b.lot) ? `, lot ${txt(b.lot)}` : ''}` +
      `${txt(b.observation_sst) ? ` — défauts : ${txt(b.observation_sst)}` : ''}${txt(b.observations) ? ` — observations : ${txt(b.observations)}` : ''}`,
  },
  { m: 'PATCH', re: new RegExp(`${CS}/lignes/\\d+/pieces/fini/(\\d+)$`), f: ([s, p], b, r) => `Modification du ${fini(r, p)}${entre(nombre(b.poids, 'kg'), nombre(b.metrage, 'm'))} — ${sst(r, s)}` },
  { m: 'DELETE', re: new RegExp(`${CS}/lignes/\\d+/pieces/fini/(\\d+)$`), f: ([s, p], _b, r) => `Suppression du ${fini(r, p)} reçu sur la ${sst(r, s)}` },
  { m: 'POST', re: new RegExp(`${CS}/email$`), f: ([s], b, r) => `Envoi par mail du bon de la ${sst(r, s)}${destinataires(b.to)}` },
  { m: 'POST', re: new RegExp(`${CS}/soumission/email$`), f: ([s], b, r) => `Envoi par mail de la soumission lot client de la ${sst(r, s)}${destinataires(b.to)}` },
  { m: 'POST|PUT|DELETE', re: new RegExp(`${CS}/documents(?:/\\d+)?$`), f: ([s], b, r, m) => `${docType(sst(r, s))[m as 'POST']}${txt(b.nom) ? ` « ${txt(b.nom)} »` : ''}` },

  // Transferts
  { m: 'POST', re: new RegExp(`${TR}$`), f: (_g, b, r) => `Création d’un bon de transfert ${sstNom(r, num(b.IDmagasin_source))} → ${sstNom(r, num(b.IDmagasin_destination))}` },
  { m: 'PUT', re: new RegExp(`${TR}/(\\d+)$`), f: ([t], b, r) => `Modification du bon de transfert N° ${t}${b.IDmagasin_destination !== undefined ? ` (${sstNom(r, num(b.IDmagasin_source))} → ${sstNom(r, num(b.IDmagasin_destination))})` : ''}` },
  { m: 'DELETE', re: new RegExp(`${TR}/(\\d+)$`), f: ([t]) => `Suppression du bon de transfert N° ${t}` },
  { m: 'PUT', re: new RegExp(`${TR}/(\\d+)/pieces$`), f: ([t], b, r) => `Bon de transfert N° ${t} : ${pieces(r, b.stockIds, b.type === 'fini' ? 'fini' : b.type === 'ecru' ? 'ecru' : '?')}` },
  { m: 'DELETE', retrait: true, piece: '?', re: new RegExp(`${TR}/(\\d+)/pieces/(\\d+)$`), f: ([t], _b, _r, _m, p) => `Retrait ${p.de} du bon de transfert N° ${t}` },
  { m: 'POST', re: new RegExp(`${TR}/(\\d+)/email$`), f: ([t], b) => `Envoi par mail du bon de transfert N° ${t}${destinataires(b.to)}` },

  // Expéditions
  { m: 'POST', re: /^\/api\/expeditions\/(?:formelle|divers)$/, f: () => 'Création d’un avis d’expédition' },
  { m: 'PUT', re: /^\/api\/expeditions\/(?:formelle|divers)\/(\d+)(?:\/adresse)?$/, f: ([e]) => `Modification de l’avis d’expédition N° ${e}` },
  { m: 'DELETE', re: /^\/api\/expeditions\/(?:formelle|divers)\/(\d+)$/, f: ([e]) => `Suppression de l’avis d’expédition N° ${e}` },
  { m: 'PUT', piece: 'fini', re: /^\/api\/expeditions\/formelle\/(\d+)\/lignes\/\d+\/rolls\/(\d+)$/, f: ([e], _b, _r, _m, p) => `Ajout ${p.de} à l’avis d’expédition N° ${e}` },
  { m: 'DELETE', retrait: true, piece: 'fini', re: /^\/api\/expeditions\/formelle\/(\d+)\/lignes\/\d+\/rolls\/(\d+)$/, f: ([e], _b, _r, _m, p) => `Retrait ${p.de} de l’avis d’expédition N° ${e}` },
  { m: 'POST', re: /^\/api\/expeditions\/(?:formelle|divers)\/(\d+)\/email$/, f: ([e], b) => `Envoi par mail de l’avis d’expédition N° ${e}${destinataires(b.to)}` },

  // TRM commandes (same commande_client table, IDsociete 2)
  { m: 'POST', re: /^\/api\/commandes-trm$/, f: () => 'Création d’une commande TRM' },
  { m: 'PUT', re: /^\/api\/commandes-trm\/(\d+)$/, f: ([c], _b, r) => `Modification de la ${cmd(r, c, 'commande TRM')}` },
  { m: 'PUT', re: /^\/api\/commandes-trm\/(\d+)\/etat$/, f: ([c], _b, r) => `Changement d’état de la ${cmd(r, c, 'commande TRM')}` },
  { m: 'DELETE', re: /^\/api\/commandes-trm\/(\d+)$/, f: ([c], _b, r) => `Suppression de la ${cmd(r, c, 'commande TRM')}` },
  { m: 'POST', re: /^\/api\/commandes-trm\/(\d+)\/lignes$/, f: ([c], _b, r) => `Ajout d’une ligne à la ${cmd(r, c, 'commande TRM')}` },
  { m: 'PUT', re: /^\/api\/commandes-trm\/lignes\/(\d+)$/, f: ([l], _b, r) => `Modification d’une ligne de la ${cmdLigne(r, l, 'commande TRM')}` },
  { m: 'PUT', re: /^\/api\/commandes-trm\/lignes\/(\d+)\/delai$/, f: ([l], b, r) => `Délai d’une ligne de la ${cmdLigne(r, l, 'commande TRM')} porté au ${date(b.date_livraison)}` },
  { m: 'DELETE', re: /^\/api\/commandes-trm\/lignes\/(\d+)$/, f: ([l], _b, r) => `Suppression d’une ligne de la ${cmdLigne(r, l, 'commande TRM')}` },
  { m: 'POST', re: /^\/api\/commandes-trm\/(\d+)\/lignes\/\d+\/expedier$/, f: ([c], b, r) => `Expédition de ${pieces(r, b.stockIds)} de la ${cmd(r, c, 'commande TRM')}` },
  { m: 'POST', re: /^\/api\/commandes-trm\/(\d+)\/email$/, f: ([c], b, r) => `Envoi par mail de la ${cmd(r, c, 'commande TRM')}${destinataires(b.to)}` },

  // Others
  { m: 'PUT', re: /^\/api\/suivi-lots\/(\d+)$/, f: ([s], _b, r) => `Saisie des mesures du lot ${r.lots.get(s) ?? `#${s}`} (suivi de lot)` },
  { m: 'POST', re: /^\/api\/suivi-lots\/(\d+)\/etat$/, f: ([s], _b, r) => `Changement d’état du lot ${r.lots.get(s) ?? `#${s}`}` },
  { m: 'PUT', re: /^\/api\/suivi-lots\/(\d+)\/actions\/\d+$/, f: ([s], _b, r) => `Action qualité sur le lot ${r.lots.get(s) ?? `#${s}`}` },
  // Sous-traitants › Point: the day's draft to MATEL. Removing a line is
  // curating the draft (restorable, « Restaurer »), never a deletion.
  { m: 'POST', re: /^\/api\/points-sst\/preparer$/, f: () => 'Point sous-traitant : préparation du point' },
  { m: 'POST', re: /^\/api\/points-sst\/(\d+)\/actualiser$/, f: () => 'Point sous-traitant : actualisation' },
  { m: 'POST', re: /^\/api\/points-sst\/(\d+)\/lignes$/, f: (_g, b) => `Point sous-traitant : ajout d’une ligne${txt(b.commande) ? ` (commande sous-traitant N° ${txt(b.commande)})` : ''}` },
  { m: 'PATCH', re: /^\/api\/points-sst\/(\d+)\/lignes\/\d+$/, f: () => 'Point sous-traitant : modification d’une ligne' },
  { m: 'DELETE', retrait: true, re: /^\/api\/points-sst\/(\d+)\/lignes\/\d+$/, f: () => 'Point sous-traitant : ligne retirée du point (restaurable)' },
  { m: 'POST', re: /^\/api\/points-sst\/(\d+)\/lignes\/\d+\/restaurer$/, f: () => 'Point sous-traitant : ligne restaurée' },
  { m: 'POST', re: /^\/api\/points-sst\/(\d+)\/lignes\/\d+\/retour$/, f: (_g, b) => `Point sous-traitant : retour à Tricobot${txt(b.texte) ? ` « ${txt(b.texte)} »` : ''}` },
  { m: 'DELETE', retrait: true, re: /^\/api\/points-sst\/(\d+)\/lignes\/\d+\/retour$/, f: () => 'Point sous-traitant : retour à Tricobot effacé' },
  { m: 'POST', re: /^\/api\/points-sst\/(\d+)\/email$/, f: (_g, b) => `Point sous-traitant : envoi ou programmation du mail${destinataires(b.to)}` },
  { m: 'DELETE', retrait: true, re: /^\/api\/points-sst\/(\d+)\/programme$/, f: () => 'Point sous-traitant : envoi programmé annulé' },
  { m: 'POST', re: /^\/api\/tickets(?:-trm)?$/, f: (_g, b) => `Ticket envoyé au développement : « ${txt(b.title)} »${txt(b.description) ? ` — ${txt(b.description)}` : ''}` },
  { m: 'PUT', re: /^\/api\/permissions(?:-trm)?\/users\/(\d+)$/, f: ([u], _b, r) => `Modification des droits de ${r.utilisateurs.get(u) ?? `l’utilisateur #${u}`}` },
  {
    m: 'PUT',
    re: /^\/api\/agents-ia\/superviseur\/points\/traitement$/,
    f: (_g, b) => `Superviseur : point marqué « ${txt(b.issue).replace('_', ' ') || 'traité'} »${txt(b.commentaire) ? ` — « ${txt(b.commentaire)} »` : ''}`,
  },
  { m: 'POST', re: /^\/api\/agents-ia\/([a-z-]+)\/sonder$/, f: () => 'Agents IA : lancement manuel d’un agent' },
  { m: 'POST', re: /^\/api\/agents-ia(?:-trm)?\/([a-z-]+)\/versions$/, f: () => 'Agents IA : nouvelle version d’un prompt' },
  { m: 'POST|PUT', re: /^\/api\/agents-ia(?:-trm)?\/([a-z-]+)\/runs\/[^/]+\/(?:evaluation|notes-dev|verifie)$/, f: () => 'Agents IA : avis donné sur une exécution' },

  // 2026-10-14 — the routes the model still read as raw JSON (13 % of the
  // actions; it took the dossier's free « journal » note for its history and
  // « 20261012 » for a wrong date). Only what the person typed or chose is
  // said; internal ids never are.

  // Fils › Commandes (the commande_fil id is the N° printed on the order)
  { m: 'POST', re: /^\/api\/commandes-fil$/, f: (_g, b, r) => `Création d’une commande de fil chez ${fournisseur(r, num(b.IDfournisseur))}` },
  { m: 'PUT', re: /^\/api\/commandes-fil\/(\d+)$/, f: ([c], b, r) => `Modification de la ${cmdFil(r, c)}${entre(txt(b.commentaire) && `commentaire ${cite(b.commentaire)}`, txt(b.journal) && `note interne ${cite(b.journal)}`)}` },
  { m: 'DELETE', re: /^\/api\/commandes-fil\/(\d+)$/, f: ([c], _b, r) => `Suppression de la ${cmdFil(r, c)}` },
  { m: 'POST', re: /^\/api\/commandes-fil\/(\d+)\/lignes$/, f: ([c], b, r) => `Ajout d’une ligne à la ${cmdFil(r, c)} : fil ${refFil(r, b.IDref_fil) || '?'}${entre(colorisFil(r, b.IDcolori_fil), nombre(b.quantite, 'kg'), nombre(b.prix_unitaire, '€/kg'), b.date_livraison ? `livraison ${date(b.date_livraison)}` : '')}` },
  { m: 'PUT', re: /^\/api\/commandes-fil\/lignes\/(\d+)$/, f: ([l], b, r) => `Modification d’une ligne de la ${cmdFilLigne(r, l)} : fil ${refFil(r, b.IDref_fil) || '?'}${entre(colorisFil(r, b.IDcolori_fil), nombre(b.quantite, 'kg'), nombre(b.prix_unitaire, '€/kg'), b.date_livraison ? `livraison ${date(b.date_livraison)}` : '')}` },
  { m: 'DELETE', re: /^\/api\/commandes-fil\/lignes\/(\d+)$/, f: ([l], _b, r) => `Suppression d’une ligne de la ${cmdFilLigne(r, l)}` },
  { m: 'PUT', re: /^\/api\/commandes-fil\/(\d+)\/lignes\/\d+\/stock\/\d+$/, f: ([c], _b, r) => `Lot de stock rattaché à une ligne de la ${cmdFil(r, c)} (réception)` },
  { m: 'POST|PUT|DELETE', re: /^\/api\/commandes-fil\/(\d+)\/documents(?:\/\d+)?$/, f: ([c], b, r, m) => `${docType(cmdFil(r, c))[m as 'POST']}${txt(b.nom) ? ` « ${txt(b.nom)} »` : ''}` },
  { m: 'POST', re: /^\/api\/commandes-fil\/(\d+)\/email$/, f: ([c], b, r) => `Envoi par mail du bon de la ${cmdFil(r, c)}${destinataires(b.to)}` },

  // Fils › Références
  { m: 'PUT', re: /^\/api\/references-fil\/(\d+)$/, f: (_g, b) => `Modification de la référence fil ${cite(b.reference) || '?'}${entre(typeof b.prix_kg === 'number' ? `prix de base ${nombre(b.prix_kg, '€/kg')}` : '', txt(b.commentaire) && `commentaire ${cite(b.commentaire)}`)}` },
  { m: 'POST', re: /^\/api\/references-fil\/(\d+)\/offres$/, f: ([f], b, r) => `Offre de prix saisie sur la référence fil ${refFil(r, f) || '?'}${colorisFil(r, b.IDcolori_fil) ? `, ${colorisFil(r, b.IDcolori_fil)}` : ''} : ${fournisseur(r, num(b.IDfournisseur))}${entre(nombre(b.prix, '€/kg'), nombre(b.quantite, 'kg'), txt(b.observation) && cite(b.observation))}` },
  { m: 'PUT', re: /^\/api\/references-fil\/(\d+)\/variantes\/\d+\/reappro$/, f: ([f], b, r) => `Stock mini et délai d’appro d’un coloris de la référence fil ${refFil(r, f) || '?'}${entre(nombre(b.stock_mini, 'kg'), nombre(b.delai_appro, 'jours'))}` },
  { m: 'POST|DELETE', re: /^\/api\/references-fil\/(\d+)\/variantes\/\d+\/fournisseurs\/(\d+)$/, f: ([f, fo], _b, r, m) => `${m === 'POST' ? 'Ajout' : 'Retrait'} du fournisseur ${fournisseur(r, fo)} sur un coloris de la référence fil ${refFil(r, f) || '?'}` },

  // Qualité › Dossiers (the dossier id is the N° printed on the FNC). Its
  // « journal » is a free note, never the history: left out on purpose.
  { m: 'POST', re: /^\/api\/dossiers-qualite$/, f: (_g, b, r) => `Création d’un dossier qualité pour ${client(r, b.IDclient)} : ${cite(b.description)}` },
  {
    m: 'PUT',
    re: /^\/api\/dossiers-qualite\/(\d+)$/,
    f: ([d], b) =>
      `Modification du dossier qualité N° ${d}${txt(b.reference) ? ` (pièce ${txt(b.reference)})` : ''} : description ${cite(b.description) || 'vide'}` +
      `${txt(b.message_fnc) ? ` ; texte de la FNC ${cite(b.message_fnc)}` : ''}${txt(b.fnc_resolution) ? ` ; résolution « ${txt(b.fnc_resolution)} »` : ''}${txt(b.fnc_commentaire) ? ` ; commentaire ${cite(b.fnc_commentaire)}` : ''}`,
  },
  { m: 'PUT', re: /^\/api\/dossiers-qualite\/(\d+)\/termine$/, f: ([d], b) => `Dossier qualité N° ${d} ${b.termine === 0 || b.termine === false ? 'rouvert' : 'marqué terminé'}` },
  { m: 'POST|PUT|DELETE', re: /^\/api\/dossiers-qualite\/(\d+)\/documents(?:\/\d+)?$/, f: ([d], _b, _r, m) => docType(`dossier qualité N° ${d}`)[m as 'POST'] },
  { m: 'POST', re: /^\/api\/dossiers-qualite\/(\d+)\/fnc\/(?:email|envoi)$/, f: ([d], b) => `Envoi de la fiche de non-conformité du dossier qualité N° ${d}${destinataires(b.to)}` },

  // Finis › Études coloris
  { m: 'POST', re: /^\/api\/etudes-coloris$/, f: (_g, b, r) => `Création de l’étude coloris ${cite(b.libelle)} pour ${client(r, b.IDclient)}${entre(refFini(r, b.IDref_fini), b.IDsous_traitant !== undefined ? `chez ${sstNom(r, num(b.IDsous_traitant))}` : '', b.date_reception_type ? `type reçu le ${date(b.date_reception_type)}` : '')}` },
  { m: 'PUT', re: /^\/api\/etudes-coloris\/(\d+)$/, f: (_g, b) => `Modification de l’étude coloris ${cite(b.libelle) || '?'}${entre(txt(b.commentaire) && `commentaire ${cite(b.commentaire)}`, txt(b.journal) && `note interne ${cite(b.journal)}`)}` },
  { m: 'POST', re: /^\/api\/etudes-coloris\/soumissions\/(\d+)\/respond$/, f: () => 'Réponse du client enregistrée sur une soumission coloris' },

  // Clients, fournisseurs, sous-traitants, prospects
  { m: 'PUT', re: /^\/api\/clients(?:-trm)?\/(\d+)$/, f: ([c], b, r) => `Modification de la fiche du client ${r.clients.get(c) ?? (txt(b.nom) || `#${c}`)}${entre(txt(b.commentaire) && `commentaire ${cite(b.commentaire)}`)}` },
  { m: 'POST|PUT', re: /^\/api\/clients(?:-trm)?\/(\d+)\/contacts(?:\/\d+)?$/, f: ([c], b, r, m) => `${m === 'POST' ? 'Ajout' : 'Modification'} du contact ${[txt(b.prenom), txt(b.nom)].filter(Boolean).join(' ')}${txt(b.mail) ? ` (${txt(b.mail)})` : ''} du client ${client(r, c)}` },
  { m: 'DELETE', re: /^\/api\/clients(?:-trm)?\/(\d+)\/contacts\/\d+$/, f: ([c], _b, r) => `Suppression d’un contact du client ${client(r, c)}` },
  { m: 'POST|PUT', re: /^\/api\/clients(?:-trm)?\/(\d+)\/adresses(?:\/\d+)?$/, f: ([c], b, r, m) => `${m === 'POST' ? 'Ajout' : 'Modification'} d’une adresse du client ${client(r, c)}${entre(txt(b.nom), txt(b.ville))}` },
  { m: 'POST', re: /^\/api\/clients\/(\d+)\/references\/\d+\/coloris\/demande$/, f: ([c], _b, r) => `Demande de nouveau coloris pour le client ${client(r, c)}` },
  { m: 'PUT', re: /^\/api\/fournisseurs\/(\d+)$/, f: ([f], b, r) => `Modification de la fiche du fournisseur ${r.fournisseurs.get(f) ?? (txt(b.nom) || `#${f}`)}` },
  { m: 'POST|PUT', re: /^\/api\/fournisseurs\/(\d+)\/contacts(?:\/\d+)?$/, f: ([f], b, r, m) => `${m === 'POST' ? 'Ajout' : 'Modification'} du contact ${[txt(b.prenom), txt(b.nom)].filter(Boolean).join(' ')}${txt(b.mail) ? ` (${txt(b.mail)})` : ''} du fournisseur ${fournisseur(r, f)}` },
  { m: 'PUT', re: /^\/api\/sous-traitants\/(\d+)$/, f: ([s], _b, r) => `Modification de la fiche du sous-traitant ${sstNom(r, s)}` },
  { m: 'POST|PUT', re: /^\/api\/sous-traitants\/(\d+)\/contacts(?:\/\d+)?$/, f: ([s], b, r, m) => `${m === 'POST' ? 'Ajout' : 'Modification'} du contact ${[txt(b.prenom), txt(b.nom)].filter(Boolean).join(' ')}${txt(b.mail) ? ` (${txt(b.mail)})` : ''} du sous-traitant ${sstNom(r, s)}` },
  { m: 'PUT', re: /^\/api\/prospects\/(\d+)$/, f: (_g, b) => `Modification du prospect ${txt(b.societe) || [txt(b.prenom), txt(b.nom)].filter(Boolean).join(' ')}` },
  { m: 'PUT', re: /^\/api\/prospects\/(\d+)\/status$/, f: () => 'Changement de statut d’un prospect (catalogue)' },

  // Stocks
  {
    m: 'PATCH',
    re: /^\/api\/stock\/fini\/(\d+)$/,
    f: ([p], b, r) =>
      `Modification du ${fini(r, p)} en stock${entre(txt(b.observations) && `observations ${cite(b.observations)}`, txt(b.observation_sst) && `défauts ${cite(b.observation_sst)}`, txt(b.emplacement) && `emplacement ${txt(b.emplacement)}`, b.second_choix === true ? '2e choix' : '', b.don === true ? 'à donner' : '')}`,
  },
  { m: 'POST', re: /^\/api\/stock\/fini\/(\d+)\/cut$/, f: ([p], b, r) => `Découpe du ${fini(r, p)} : ${objets(b.pieces).map((x) => nombre(x.metrage, 'm')).filter(Boolean).join(' + ') || 'morceaux'} détachés` },
  { m: 'POST', re: /^\/api\/stock\/ecru\/(\d+)\/cut$/, f: ([p], b, r) => `Découpe de la ${ecru(r, p)} : ${objets(b.pieces).map((x) => nombre(x.poids, 'kg')).filter(Boolean).join(' + ') || 'morceaux'} détachés` },
  { m: 'POST', re: /^\/api\/stock\/fini\/surteindre\/preview$/, f: (_g, b, r) => `Aperçu d’une surteinture (${pieces(r, b.ids, 'fini')}) — rien n’est modifié` },
  { m: 'POST', re: /^\/api\/stock\/fini\/surteindre$/, f: (_g, b, r) => `Surteinture : ${pieces(r, b.ids, 'fini')} renvoyée(s) en teinture` },
  { m: 'PATCH', re: /^\/api\/stock\/ecru(?:-trm)?\/(\d+)$/, f: ([p], b, r) => `Modification de la ${ecru(r, p)} en stock${entre(txt(b.observations) && `observations ${cite(b.observations)}`, b.second_choix === true ? '2e choix' : '')}` },
  { m: 'POST', re: /^\/api\/stock-divers$/, f: (_g, b, r) => `Entrée en stock divers : ${typeof b.quantite === 'number' ? b.quantite : '?'} × ${r.refsDivers.get(num(b.IDref_divers)) ?? 'article'}` },
  { m: 'PATCH', re: /^\/api\/stock-divers\/(\d+)$/, f: (_g, b) => `Correction d’une quantité en stock divers${typeof b.quantite === 'number' ? ` (${b.quantite})` : ''}` },
  { m: 'POST', re: /^\/api\/expeditions\/divers\/(\d+)\/lignes$/, f: ([e]) => `Ajout d’une ligne à l’avis d’expédition divers N° ${e}` },
  { m: 'PUT', re: /^\/api\/expeditions\/divers\/lignes\/\d+\/contenu$/, f: (_g, b, r) => `Contenu d’une ligne d’avis divers : ${objets(b.items).map((x) => `${typeof x.quantite === 'number' ? x.quantite : '?'} × ${r.refsDivers.get(num(x.IDref_divers)) ?? 'article'}${typeof x.prix === 'number' ? ` à ${nombre(x.prix, '€')}` : ''}`).join(', ') || 'vide'}` },

  // Clients › Étiquettes Simone Pérèle (net = the length billed, in m)
  {
    m: 'PUT',
    re: /^\/api\/etiquettes-sp\/lignes\/(\d+)$/,
    f: ([l], b, r) => {
      const rl = objets(b.rolls)
      const mesures = rl.map((x) => `${nomPieceId(r, x.id)} ${[nombre(x.brut, 'm brut'), nombre(x.net, 'm net'), nombre(x.laizeCm, 'cm de laize')].filter(Boolean).join(', ')}`)
      return `Étiquettes Simone Pérèle de la ${cmdLigne(r, l)} : mesures de ${rl.length} rouleau${rl.length > 1 ? 'x' : ''}${mesures.length ? ` (${mesures.join(' ; ')})` : ''}`
    },
  },
  { m: 'POST', re: /^\/api\/etiquettes-sp\/lignes\/(\d+)\/([a-z]+)\/email$/, f: ([l], b, r) => `Envoi par mail du document Simone Pérèle de la ${cmdLigne(r, l)}${destinataires(b.to)}` },
  {
    m: 'PUT',
    re: /^\/api\/etiquettes-sp\/lots\/(\d+)$/,
    f: ([s], b, r) => {
      const rl = objets(b.rolls)
      const mesures = rl.map((x) => `${nomPieceId(r, x.id)} ${[nombre(x.brut, 'm brut'), nombre(x.net, 'm net'), nombre(x.laizeCm, 'cm de laize')].filter(Boolean).join(', ')}`)
      return `Tableau de métrage Simone Pérèle du lot ${r.lots.get(s) ?? `#${s}`} : mesures de ${rl.length} rouleau${rl.length > 1 ? 'x' : ''}${mesures.length ? ` (${mesures.join(' ; ')})` : ''}`
    },
  },
  { m: 'POST', re: /^\/api\/etiquettes-sp\/lots\/(\d+)\/tableau\/email$/, f: ([s], b, r) => `Envoi par mail du tableau de métrage Simone Pérèle du lot ${r.lots.get(s) ?? `#${s}`}${destinataires(b.to)}` },

  // Tricobot: the person checked a BL Tricobot pre-filled
  {
    m: 'PUT',
    re: /^\/api\/tricobot\/bl-reception$/,
    f: (_g, b, r) => {
      const lots = objets(b.lots)
      const corr = lots.reduce((t, x) => t + nbElements(x.corrections), 0)
      return `Réception d’un BL pré-rempli par Tricobot (lot ${lots.map((x) => txt(x.lot)).filter(Boolean).join(', ') || '?'}, ${sstLigne(r, num(b.ligneId))}) : ${corr ? `${pluriel(corr, 'valeur')} corrigée${corr > 1 ? 's' : ''}` : 'sans correction'}`
    },
  },

  // Clients › Facturation
  { m: 'POST', re: /^\/api\/factures(?:-trm)?\/def\/(\d+)\/email$/, f: ([f], b, r) => `Envoi par mail de la facture N° ${r.factures.get(f) ?? '?'}${destinataires(b.to)}` },
  { m: 'POST', re: /^\/api\/factures(?:-trm)?\/def\/(\d+)\/marquer-envoyee$/, f: ([f], b, r) => `Facture N° ${r.factures.get(f) ?? '?'} marquée comme envoyée${txt(b.motif) ? ` — ${cite(b.motif)}` : ''}` },
  { m: 'POST', re: /^\/api\/factures(?:-trm)?\/def\/(\d+)\/avoir$/, f: ([f], _b, r) => `Création d’un avoir sur la facture N° ${r.factures.get(f) ?? '?'}` },
  { m: 'POST', re: /^\/api\/factures(?:-trm)?\/prov$/, f: (_g, b, r) => `Création d’une facture provisoire pour ${client(r, b.IDclient)}` },
  { m: 'POST', re: /^\/api\/factures(?:-trm)?\/prov\/generate$/, f: () => 'Génération des factures provisoires' },
  { m: 'PUT', re: /^\/api\/factures(?:-trm)?\/prov\/(\d+)$/, f: () => 'Modification d’une facture provisoire' },
  { m: 'POST|PUT', re: /^\/api\/factures(?:-trm)?\/prov\/(?:\d+\/)?lignes(?:\/\d+)?$/, f: (_g, b, _r, m) => `${m === 'POST' ? 'Ajout' : 'Modification'} d’une ligne de facture provisoire${entre(cite(txt(b.designation).split('\n')[0], 60), typeof b.quantite === 'number' && b.quantite ? `${String(b.quantite).replace('.', ',')} ${txt(b.unite)}` : '', nombre(b.prix, '€'))}` },
  { m: 'POST', re: /^\/api\/factures(?:-trm)?\/prov\/(?:\d+\/convert|convert-batch)$/, f: (_g, b) => `Validation de ${b.ids ? pluriel(idsDe(b.ids).total, 'facture provisoire') : 'la facture provisoire'} en facture définitive` },
  { m: 'POST', re: /^\/api\/factures(?:-trm)?\/prov\/delete-batch$/, f: (_g, b) => `Suppression de ${pluriel(idsDe(b.ids).total, 'facture provisoire')}` },

  { m: 'PUT', re: /^\/api\/factures-sst\/lignes\/(\d+)\/avis$/, f: (_g, b) => `Sous-traitants › Factures : ligne de facture ennoblisseur ${txt(b.action) ? `jugée « ${txt(b.action)} »` : 'remise en attente'}${txt(b.commentaire) ? ` — ${cite(b.commentaire)}` : ''}` },

  // Others
  { m: 'POST', re: /^\/api\/tarifs-fini\/(\d+)\/preview$/, f: () => 'Finis › Tarifs : simulation de prix — rien n’est modifié' },
  { m: 'POST|PUT|DELETE', re: /^\/api\/tarifs-fini(?:\/\d+)?(?:\/fils\/\d+)?$/, f: (_g, b, _r, m) => `Finis › Tarifs : ${m === 'POST' ? 'création' : m === 'DELETE' ? 'suppression' : 'modification'} d’une fiche de prix${txt(b.reference) ? ` ${cite(b.reference)}` : ''}` },
  { m: 'POST', re: /^\/api\/tickets(?:-trm)?\/[^/]+\/attachments$/, f: () => 'Pièce jointe ajoutée à un ticket' },
  { m: 'POST', re: /^\/api\/tickets(?:-trm)?\/[^/]+\/messages$/, f: (_g, b) => `Message sur un ticket : ${cite(b.body)}` },
  { m: 'POST', re: /^\/api\/auth\/voir-comme$/, f: () => '« Voir comme » un autre compte' },
]

const VERBES: Record<string, string> = { POST: 'Action / création', PUT: 'Modification', PATCH: 'Modification', DELETE: 'Suppression' }

const majuscule = (t: string) => t[0].toUpperCase() + t.slice(1)

/** The order (and line) a SUIVIS row belongs to, as on screen. */
function sujetSuivi(table: string, id: number, chemin: string, r: Refs): string {
  const article = r.articles.get(`${table}:${id}`)
  const ligne = article ? `, ligne ${article}` : ', une ligne'
  const quoi = chemin.startsWith('/api/commandes-trm/') ? 'commande TRM' : undefined
  switch (table) {
    case 'ligne_commande_sous_traitant': return majuscule(sstLigne(r, id)) + ligne
    case 'commande_sous_traitant': return majuscule(sst(r, id))
    case 'ligne_commande_client': return majuscule(cmdLigne(r, id, quoi)) + ligne
    case 'commande_client': return majuscule(cmd(r, id, quoi))
    case 'ref_fil_commande': return majuscule(cmdFilLigne(r, id)) + ligne
    default: return majuscule(cmdFil(r, id))
  }
}

/** One journal line in French. Pure: the names come from `refs`. */
export function decrire(
  l: Pick<LigneJournal, 'methode' | 'chemin' | 'corps'> & Partial<Pick<LigneJournal, 'changements' | 'statut'>>,
  refs: Refs,
): Description {
  // An order saved through its form: say what moved, read from the row
  // before and after (journal_activite.changements) — never from the body,
  // which carries every field of the form, touched or not.
  const suivi = l.methode === 'PUT' || l.methode === 'PATCH'
    ? SUIVIS.map((s) => ({ s, id: parseInt(s.re.exec(l.chemin)?.[1] ?? '', 10) })).find((x) => !isNaN(x.id))
    : undefined
  if (suivi && l.changements) {
    const sujet = sujetSuivi(suivi.s.table, suivi.id, l.chemin, refs)
    const ph = phrases(l.changements)
    return ph.length
      ? { texte: `${sujet} : ${ph.join(' ; ')}`, retrait: false, connue: true }
      : { texte: `${sujet} : enregistrée sans changement`, retrait: false, connue: true, sansEffet: true }
  }
  const d = decrireRoute(l, refs)
  // Journaled before 2026-10-14 (or the row could not be read): only the
  // form sent is known — say so rather than let it pass for a change.
  return suivi && d.connue && (l.statut ?? 200) < 400
    ? { ...d, texte: `${d.texte} — formulaire enregistré, le détail de ce qui a changé n’est pas connu` }
    : d
}

function decrireRoute(l: Pick<LigneJournal, 'methode' | 'chemin' | 'corps'>, refs: Refs): Description {
  for (const [i, route] of ROUTES.entries()) {
    if (!route.m.split('|').includes(l.methode)) continue
    const m = route.re.exec(l.chemin)
    if (!m) continue
    const g = m.slice(1).map((x) => parseInt(x, 10))
    const b = lireCorps(l.corps)
    if (!route.piece) return { texte: route.f(g, b, refs, l.methode, lotPieces([], '?')), retrait: !!route.retrait, connue: true }
    const genre = route.piece
    const numero = nomPiece(refs, g[g.length - 1], genre)
    return {
      texte: route.f(g, b, refs, l.methode, lotPieces([numero], genre)),
      retrait: !!route.retrait,
      connue: true,
      // Same route, same ids but the piece: the same action on another piece.
      groupe: `${i}|${g.slice(0, -1).join(',')}`,
      numero,
      refaire: (p) => route.f(g, b, refs, l.methode, p),
      genre,
    }
  }
  const objet = l.chemin.replace(/^\/api\//, '').split('/').filter(Boolean).join(' › ')
  return { texte: `${VERBES[l.methode] ?? 'Lecture'} — ${objet}`, retrait: false, connue: false }
}

/** Two actions further apart than this are never merged. */
const ECART_GROUPE_MS = 10 * 60_000

/** Merges a run of the same action on several pieces (20 reservations
 *  released one by one in a minute) into one line naming them all, so the
 *  reader — and the model — get the count from code. Only consecutive lines,
 *  all answered OK; the line keeps the first one's time and `n` the count. */
export function regrouper<T extends Description & { le: Date; statut: number }>(lignes: readonly T[]): Array<T & { n: number }> {
  const out: Array<T & { n: number; numeros?: string[]; dernier?: number }> = []
  for (const l of lignes) {
    const prec = out[out.length - 1]
    if (
      prec && l.groupe && prec.groupe === l.groupe && l.statut < 400 && prec.statut < 400 &&
      l.le.getTime() - (prec.dernier ?? prec.le.getTime()) <= ECART_GROUPE_MS
    ) {
      prec.numeros = [...(prec.numeros ?? [prec.numero ?? '?']), l.numero ?? '?']
      prec.n++
      prec.dernier = l.le.getTime()
      prec.texte = prec.refaire!(lotPieces(prec.numeros, prec.genre ?? '?'))
      continue
    }
    out.push({ ...l, n: 1 })
  }
  return out.map(({ numeros: _n, dernier: _d, ...l }) => l as unknown as T & { n: number })
}

// ── Ids to resolve ───────────────────────────────────────

export interface IdsAResoudre {
  commandes: Set<number>
  lignesClient: Set<number>
  lignesSst: Set<number>
  commandesSst: Set<number>
  sousTraitants: Set<number>
  pieces: Set<number>
  lots: Set<number>
  utilisateurs: Set<number>
  commandesFil: Set<number>
  lignesFil: Set<number>
  fournisseurs: Set<number>
  refsFil: Set<number>
  colorisFil: Set<number>
  clients: Set<number>
  refsDivers: Set<number>
  refsFini: Set<number>
  factures: Set<number>
}

/** Every id the descriptions of `lignes` will look up. Pure. */
export function idsAResoudre(lignes: readonly Pick<LigneJournal, 'chemin' | 'corps'>[]): IdsAResoudre {
  const ids: IdsAResoudre = {
    commandes: new Set(),
    lignesClient: new Set(),
    lignesSst: new Set(),
    commandesSst: new Set(),
    sousTraitants: new Set(),
    pieces: new Set(),
    lots: new Set(),
    utilisateurs: new Set(),
    commandesFil: new Set(),
    lignesFil: new Set(),
    fournisseurs: new Set(),
    refsFil: new Set(),
    colorisFil: new Set(),
    clients: new Set(),
    refsDivers: new Set(),
    refsFini: new Set(),
    factures: new Set(),
  }
  const ajouter = (s: Set<number>, v: unknown) => {
    const n = num(v)
    if (Number.isFinite(n) && n > 0) s.add(n)
  }
  for (const l of lignes) {
    const c = l.chemin
    const b = lireCorps(l.corps)
    let m: RegExpExecArray | null
    if ((m = /^\/api\/commandes-(?:client|trm)\/(\d+)/.exec(c))) ajouter(ids.commandes, m[1])
    if ((m = /^\/api\/commandes-(?:client|trm)\/lignes\/(\d+)/.exec(c))) ajouter(ids.lignesClient, m[1])
    if ((m = /\/supply\/(?:ennoblissement|tricotage)\/(\d+)/.exec(c))) ajouter(ids.lignesSst, m[1])
    if ((m = /^\/api\/commandes-sous-traitant\/lignes\/(\d+)/.exec(c))) ajouter(ids.lignesSst, m[1])
    if ((m = /^\/api\/commandes-sous-traitant\/(\d+)/.exec(c))) ajouter(ids.commandesSst, m[1])
    if ((m = /\/(?:rolls|pieces\/ecru|pieces\/fini|pieces)\/(\d+)(?:\/|$)/.exec(c))) ajouter(ids.pieces, m[1])
    if ((m = /^\/api\/suivi-lots\/(\d+)/.exec(c))) ajouter(ids.lots, m[1])
    if ((m = /^\/api\/etiquettes-sp\/lots\/(\d+)/.exec(c))) ajouter(ids.lots, m[1])
    if ((m = /^\/api\/permissions(?:-trm)?\/users\/(\d+)/.exec(c))) ajouter(ids.utilisateurs, m[1])
    for (const k of ['stockIds', 'stockEcruIds']) for (const i of idsDe(b[k]).ids) ajouter(ids.pieces, i)
    for (const k of ['IDsous_traitant', 'IDmagasin_source', 'IDmagasin_destination']) ajouter(ids.sousTraitants, b[k])
    if ((m = /^\/api\/commandes-fil\/(\d+)/.exec(c))) ajouter(ids.commandesFil, m[1])
    if ((m = /^\/api\/commandes-fil\/(?:\d+\/)?lignes\/(\d+)/.exec(c))) ajouter(ids.lignesFil, m[1])
    if ((m = /^\/api\/(?:fournisseurs|references-fil\/\d+\/variantes\/\d+\/fournisseurs)\/(\d+)/.exec(c))) ajouter(ids.fournisseurs, m[1])
    if ((m = /^\/api\/references-fil\/(\d+)/.exec(c))) ajouter(ids.refsFil, m[1])
    if ((m = /^\/api\/clients(?:-trm)?\/(\d+)/.exec(c))) ajouter(ids.clients, m[1])
    if ((m = /^\/api\/sous-traitants\/(\d+)/.exec(c))) ajouter(ids.sousTraitants, m[1])
    if ((m = /^\/api\/stock\/(?:fini|ecru(?:-trm)?)\/(\d+)/.exec(c))) ajouter(ids.pieces, m[1])
    if ((m = /^\/api\/etiquettes-sp\/lignes\/(\d+)/.exec(c))) ajouter(ids.lignesClient, m[1])
    if ((m = /^\/api\/factures(?:-trm)?\/def\/(\d+)/.exec(c))) ajouter(ids.factures, m[1])
    if (c === '/api/tricobot/bl-reception') ajouter(ids.lignesSst, b.ligneId)
    ajouter(ids.fournisseurs, b.IDfournisseur)
    ajouter(ids.refsFil, b.IDref_fil)
    ajouter(ids.colorisFil, b.IDcolori_fil)
    ajouter(ids.clients, b.IDclient)
    ajouter(ids.refsFini, b.IDref_fini)
    ajouter(ids.refsDivers, b.IDref_divers)
    for (const x of objets(b.items)) ajouter(ids.refsDivers, x.IDref_divers)
    for (const x of objets(b.rolls)) ajouter(ids.pieces, x.id)
    for (const i of idsDe(b.ids).ids) ajouter(ids.pieces, i)
  }
  return ids
}

const liste = (s: Set<number>) => [...s]

/** Loads every name `lignes` needs, one query per table. */
export async function chargerRefs(lignes: readonly Pick<LigneJournal, 'chemin' | 'corps'>[]): Promise<Refs> {
  const ids = idsAResoudre(lignes)
  const sql = mpsPg()
  const r = refsVides()

  if (ids.lignesClient.size) {
    for (const x of await sql<{ idligne_commande_client: number; idcommande_client: number }[]>`
      SELECT idligne_commande_client, idcommande_client FROM ligne_commande_client WHERE idligne_commande_client IN ${sql(liste(ids.lignesClient))}`) {
      r.lignesClient.set(Number(x.idligne_commande_client), Number(x.idcommande_client))
      ids.commandes.add(Number(x.idcommande_client))
    }
  }
  if (ids.lignesSst.size) {
    for (const x of await sql<{ idligne_commande_sous_traitant: number; idcommande_sous_traitant: number }[]>`
      SELECT idligne_commande_sous_traitant, idcommande_sous_traitant FROM ligne_commande_sous_traitant WHERE idligne_commande_sous_traitant IN ${sql(liste(ids.lignesSst))}`) {
      r.lignesSst.set(Number(x.idligne_commande_sous_traitant), Number(x.idcommande_sous_traitant))
      ids.commandesSst.add(Number(x.idcommande_sous_traitant))
    }
  }
  const [commandes, sstCmds, ecrus, finis, lots, utilisateurs] = await Promise.all([
    ids.commandes.size
      ? sql<{ idcommande_client: number; numero: unknown; nom: string | null }[]>`
          SELECT cc.idcommande_client, cc.numero, c.nom FROM commande_client cc LEFT JOIN client c ON c.idclient = cc.idclient
          WHERE cc.idcommande_client IN ${sql(liste(ids.commandes))}`
      : [],
    ids.commandesSst.size
      ? sql<{ idcommande_sous_traitant: number; idsous_traitant: number }[]>`
          SELECT idcommande_sous_traitant, idsous_traitant FROM commande_sous_traitant WHERE idcommande_sous_traitant IN ${sql(liste(ids.commandesSst))}`
      : [],
    ids.pieces.size ? sql<{ id: number; numero: string | null }[]>`SELECT idstock_ecru AS id, numero FROM stock_ecru WHERE idstock_ecru IN ${sql(liste(ids.pieces))}` : [],
    ids.pieces.size ? sql<{ id: number; numero: string | null }[]>`SELECT idstock_fini AS id, numero FROM stock_fini WHERE idstock_fini IN ${sql(liste(ids.pieces))}` : [],
    ids.lots.size ? sql<{ idsuivilot: number; lot: string | null }[]>`SELECT idsuivilot, lot FROM suivilot WHERE idsuivilot IN ${sql(liste(ids.lots))}` : [],
    ids.utilisateurs.size
      ? sql<{ idutilisateur: number; prenom: string | null; nom: string | null }[]>`
          SELECT idutilisateur, prenom, nom FROM utilisateur WHERE idutilisateur IN ${sql(liste(ids.utilisateurs))}`
      : [],
  ])
  for (const x of commandes) r.commandes.set(Number(x.idcommande_client), { numero: String(x.numero ?? x.idcommande_client), client: (x.nom ?? '').trim() })
  for (const x of sstCmds) {
    r.commandesSst.set(Number(x.idcommande_sous_traitant), Number(x.idsous_traitant))
    ids.sousTraitants.add(Number(x.idsous_traitant))
  }
  // A piece id is looked up in both stocks: the route decides which one it reads.
  for (const x of ecrus) if (x.numero) r.ecru.set(Number(x.id), x.numero.trim())
  for (const x of finis) if (x.numero) r.fini.set(Number(x.id), x.numero.trim())
  for (const x of lots) if (x.lot) r.lots.set(Number(x.idsuivilot), x.lot.trim())
  for (const x of utilisateurs) r.utilisateurs.set(Number(x.idutilisateur), [x.prenom, x.nom].map((v) => (v ?? '').trim()).filter(Boolean).join(' '))
  if (ids.lignesFil.size) {
    for (const x of await sql<{ idref_fil_commande: number; idcommande_fil: number }[]>`
      SELECT idref_fil_commande, idcommande_fil FROM ref_fil_commande WHERE idref_fil_commande IN ${sql(liste(ids.lignesFil))}`) {
      r.lignesFil.set(Number(x.idref_fil_commande), Number(x.idcommande_fil))
      ids.commandesFil.add(Number(x.idcommande_fil))
    }
  }
  if (ids.commandesFil.size) {
    for (const x of await sql<{ idcommande_fil: number; idfournisseur: number }[]>`
      SELECT idcommande_fil, idfournisseur FROM commande_fil WHERE idcommande_fil IN ${sql(liste(ids.commandesFil))}`) {
      r.commandesFil.set(Number(x.idcommande_fil), Number(x.idfournisseur))
      ids.fournisseurs.add(Number(x.idfournisseur))
    }
  }
  const nommer = async (s: Set<number>, cible: Map<number, string>, requete: (l: number[]) => Promise<Array<{ id: number; nom: unknown }>>) => {
    if (!s.size) return
    for (const x of await requete(liste(s))) if (x.nom !== null && String(x.nom).trim()) cible.set(Number(x.id), String(x.nom).trim())
  }
  await Promise.all([
    nommer(ids.fournisseurs, r.fournisseurs, (l) => sql`SELECT idfournisseur AS id, nom FROM fournisseur WHERE idfournisseur IN ${sql(l)}`),
    nommer(ids.colorisFil, r.colorisFil, (l) => sql`SELECT idcolori_fil AS id, reference AS nom FROM colori_fil WHERE idcolori_fil IN ${sql(l)}`),
    nommer(ids.refsFil, r.refsFil, (l) => sql`SELECT idref_fil AS id, reference AS nom FROM ref_fil WHERE idref_fil IN ${sql(l)}`),
    nommer(ids.clients, r.clients, (l) => sql`SELECT idclient AS id, nom FROM client WHERE idclient IN ${sql(l)}`),
    nommer(ids.refsDivers, r.refsDivers, (l) => sql`SELECT idref_divers AS id, designation AS nom FROM ref_divers WHERE idref_divers IN ${sql(l)}`),
    nommer(ids.refsFini, r.refsFini, (l) => sql`SELECT idref_fini AS id, reference AS nom FROM ref_fini WHERE idref_fini IN ${sql(l)}`),
    nommer(ids.factures, r.factures, (l) => sql`SELECT idfacture AS id, numero AS nom FROM facture WHERE idfacture IN ${sql(l)}`),
  ])
  if (ids.sousTraitants.size) {
    for (const x of await sql<{ idsous_traitant: number; nom: string | null }[]>`
      SELECT idsous_traitant, nom FROM sous_traitant WHERE idsous_traitant IN ${sql(liste(ids.sousTraitants))}`) {
      r.sousTraitants.set(Number(x.idsous_traitant), (x.nom ?? '').trim())
    }
  }
  await chargerArticles(lignes, r)
  return r
}

type Article = { id: number; ref: string | null; coloris: string | null }

/** « EDF85/55 739 peau rosée » for every order line a SUIVIS row names. The
 *  catalog follows the line's type (lib/sst-line-kind.ts: 2 = fini,
 *  4 = rectiligne, else écru; client lines 3 = divers), a fini's coloris its
 *  avec_teinture (#1158). */
async function chargerArticles(lignes: readonly Pick<LigneJournal, 'chemin'>[], r: Refs): Promise<void> {
  const parTable = new Map<string, Set<number>>()
  for (const l of lignes) {
    const s = SUIVIS.find((x) => x.re.test(l.chemin))
    if (!s || !(s.table.startsWith('ligne_') || s.table === 'ref_fil_commande')) continue
    const set = parTable.get(s.table) ?? new Set<number>()
    set.add(parseInt(s.re.exec(l.chemin)![1], 10))
    parTable.set(s.table, set)
  }
  const sql = mpsPg()
  const poser = (table: string) => (rows: Article[]) => {
    for (const x of rows) {
      const t = [x.ref, x.coloris].map((v) => (v ?? '').trim()).filter(Boolean).join(' ')
      if (t) r.articles.set(`${table}:${Number(x.id)}`, t)
    }
  }
  const sst = parTable.get('ligne_commande_sous_traitant')
  const cli = parTable.get('ligne_commande_client')
  const fil = parTable.get('ref_fil_commande')
  await Promise.all([
    sst && sql<Article[]>`
      SELECT l.idligne_commande_sous_traitant AS id,
             CASE WHEN l.type = 2 THEN rf.reference WHEN l.type = 4 THEN rr.reference ELSE re.reference END AS ref,
             CASE WHEN l.type = 2 THEN (CASE WHEN COALESCE(rf.avec_teinture, 1) = 0 THEN ce.reference ELSE rfc.reference END)
                  WHEN l.type = 4 THEN cr.coloris ELSE ce.reference END AS coloris
      FROM ligne_commande_sous_traitant l
      LEFT JOIN ref_fini rf ON l.type = 2 AND rf.idref_fini = l.idreference
      LEFT JOIN ref_fini_colori rfc ON l.type = 2 AND rfc.idref_fini_colori = l.idcoloris
      LEFT JOIN ref_rectiligne rr ON l.type = 4 AND rr.idref_rectiligne = l.idreference
      LEFT JOIN coloris_rectiligne cr ON l.type = 4 AND cr.idcoloris_rectiligne = l.idcoloris
      LEFT JOIN ref_ecru re ON l.type NOT IN (2, 4) AND re.idref_ecru = l.idreference
      LEFT JOIN colori_ecru ce ON l.type <> 4 AND ce.idcolori_ecru = l.idcoloris
      WHERE l.idligne_commande_sous_traitant IN ${sql([...sst])}`.then(poser('ligne_commande_sous_traitant')),
    cli && sql<Article[]>`
      SELECT l.idligne_commande_client AS id,
             CASE WHEN l.type = 2 THEN rf.reference WHEN l.type = 3 THEN rd.designation WHEN l.type = 4 THEN rr.reference ELSE re.reference END AS ref,
             CASE WHEN l.type = 2 THEN (CASE WHEN COALESCE(rf.avec_teinture, 1) = 0 THEN ce.reference ELSE rfc.reference END)
                  WHEN l.type = 3 THEN NULL WHEN l.type = 4 THEN cr.coloris ELSE ce.reference END AS coloris
      FROM ligne_commande_client l
      LEFT JOIN ref_fini rf ON l.type = 2 AND rf.idref_fini = l.idreference
      LEFT JOIN ref_fini_colori rfc ON l.type = 2 AND rfc.idref_fini_colori = l.idcolori
      LEFT JOIN ref_divers rd ON l.type = 3 AND rd.idref_divers = l.idreference
      LEFT JOIN ref_rectiligne rr ON l.type = 4 AND rr.idref_rectiligne = l.idreference
      LEFT JOIN coloris_rectiligne cr ON l.type = 4 AND cr.idcoloris_rectiligne = l.idcolori
      LEFT JOIN ref_ecru re ON l.type NOT IN (2, 3, 4) AND re.idref_ecru = l.idreference
      LEFT JOIN colori_ecru ce ON l.type NOT IN (3, 4) AND ce.idcolori_ecru = l.idcolori
      WHERE l.idligne_commande_client IN ${sql([...cli])}`.then(poser('ligne_commande_client')),
    fil && sql<Article[]>`
      SELECT l.idref_fil_commande AS id, rf.reference AS ref, cf.reference AS coloris
      FROM ref_fil_commande l
      LEFT JOIN ref_fil rf ON rf.idref_fil = l.idref_fil
      LEFT JOIN colori_fil cf ON cf.idcolori_fil = l.idcolori_fil
      WHERE l.idref_fil_commande IN ${sql([...fil])}`.then(poser('ref_fil_commande')),
  ])
}
