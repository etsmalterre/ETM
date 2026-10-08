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
import type { LigneJournal } from '../../journal-activite.js'

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
})

export interface Description {
  texte: string
  /** A DELETE that only unlinks. */
  retrait: boolean
  /** A known route: the sentence says it all, the raw body is not needed. */
  connue: boolean
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
const docType = (sur: string) => ({ POST: `Ajout d’un document sur ${sur}`, PUT: `Modification d’un document de ${sur}`, DELETE: `Suppression d’un document de ${sur}` })

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
  { m: 'PUT', re: new RegExp(`${CC}$`), f: ([c], b, r) => `Modification de l’en-tête de la ${cmd(r, c)}${entre(txt(b.ref_client) && `réf. client « ${txt(b.ref_client)} »`)}` },
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
  { m: 'PUT', re: new RegExp(`${CS}$`), f: ([s], b, r) => `Modification de l’en-tête de la ${sst(r, s)}${entre(txt(b.commentaire) && `commentaire de la commande : « ${txt(b.commentaire)} »`)}` },
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
  { m: 'PUT', re: /^\/api\/commandes-trm\/(\d+)$/, f: ([c], _b, r) => `Modification de l’en-tête de la ${cmd(r, c, 'commande TRM')}` },
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
]

const VERBES: Record<string, string> = { POST: 'Action / création', PUT: 'Modification', PATCH: 'Modification', DELETE: 'Suppression' }

/** One journal line in French. Pure: the names come from `refs`. */
export function decrire(l: Pick<LigneJournal, 'methode' | 'chemin' | 'corps'>, refs: Refs): Description {
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
    if ((m = /^\/api\/permissions(?:-trm)?\/users\/(\d+)/.exec(c))) ajouter(ids.utilisateurs, m[1])
    for (const k of ['stockIds', 'stockEcruIds']) for (const i of idsDe(b[k]).ids) ajouter(ids.pieces, i)
    for (const k of ['IDsous_traitant', 'IDmagasin_source', 'IDmagasin_destination']) ajouter(ids.sousTraitants, b[k])
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
  if (ids.sousTraitants.size) {
    for (const x of await sql<{ idsous_traitant: number; nom: string | null }[]>`
      SELECT idsous_traitant, nom FROM sous_traitant WHERE idsous_traitant IN ${sql(liste(ids.sousTraitants))}`) {
      r.sousTraitants.set(Number(x.idsous_traitant), (x.nom ?? '').trim())
    }
  }
  return r
}
