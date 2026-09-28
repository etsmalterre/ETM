// RH › Employés › Suivi — the dated record of what happened with an employee
// (meetings, announcements, warnings, training, letters). Pure rules; storage
// in rh-store.ts, routes in routes/rh.ts.
//
// Built as EVIDENCE, for the day a file goes to the prud'hommes:
//  - append-only: an entry is never edited or deleted — the database refuses it
//    (trigger, rh-store.ts migration 2). A mistake is fixed by a new
//    « rectificatif » entry pointing at the original.
//  - every entry carries a SHA-256 of its content + its attachments' hashes +
//    the previous entry's hash (one chain for the whole table), so a row edited
//    or removed behind the API's back breaks the chain from that point on —
//    verifierChaine() says where.
//  - the event date (when it happened) is typed; the creation time and author
//    are set by the server and are part of the hash.
// An internal note has limited weight on its own (Code civil art. 1363); what
// counts is a document the employee received — attach it (the recap email, the
// signed letter).

import { createHash } from 'crypto'

export const TYPES_EVENEMENT = [
  { cle: 'entretien', label: 'Entretien' },
  { cle: 'information', label: 'Information / annonce' },
  { cle: 'avertissement', label: 'Avertissement / sanction' },
  { cle: 'formation', label: 'Formation' },
  { cle: 'medical', label: 'Visite médicale' },
  { cle: 'courrier', label: 'Courrier / email' },
  { cle: 'note', label: 'Note' },
  { cle: 'rectificatif', label: 'Rectificatif' },
] as const

export type TypeEvenement = (typeof TYPES_EVENEMENT)[number]['cle']

export function libelleType(cle: string): string {
  return TYPES_EVENEMENT.find((t) => t.cle === cle)?.label ?? cle
}

export interface PieceEmpreinte {
  nom: string
  sha256: string
}

/** Everything the hash covers. Order of keys is fixed by contenuCanonique(). */
export interface EvenementScelle {
  id: number
  idemploye: number
  /** YYYY-MM-DD */
  dateEvenement: string
  type: string
  titre: string
  presents: string
  contenu: string
  rectifie: number | null
  /** ISO timestamp, milliseconds (set by the server) */
  creeLe: string
  creePar: string
  pieces: PieceEmpreinte[]
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Deterministic text of an entry — never reorder, or every stored hash breaks. */
export function contenuCanonique(e: EvenementScelle, hashPrecedent: string | null): string {
  return JSON.stringify([
    'rh-evenement-v1',
    e.id,
    e.idemploye,
    e.dateEvenement,
    e.type,
    e.titre,
    e.presents,
    e.contenu,
    e.rectifie,
    e.creeLe,
    e.creePar,
    e.pieces.map((p) => [p.nom, p.sha256]),
    hashPrecedent,
  ])
}

export function hashEvenement(e: EvenementScelle, hashPrecedent: string | null): string {
  return sha256(contenuCanonique(e, hashPrecedent))
}

export interface MaillonChaine {
  evenement: EvenementScelle
  hash: string
  hashPrecedent: string | null
}

export type ResultatVerification =
  | { ok: true; nombre: number }
  | { ok: false; nombre: number; idCasse: number; raison: 'contenu' | 'chainage' }

/** Walk the whole chain, oldest first (ordered by id). */
export function verifierChaine(maillons: MaillonChaine[]): ResultatVerification {
  let precedent: string | null = null
  for (const m of maillons) {
    if (m.hashPrecedent !== precedent) {
      return { ok: false, nombre: maillons.length, idCasse: m.evenement.id, raison: 'chainage' }
    }
    if (hashEvenement(m.evenement, m.hashPrecedent) !== m.hash) {
      return { ok: false, nombre: maillons.length, idCasse: m.evenement.id, raison: 'contenu' }
    }
    precedent = m.hash
  }
  return { ok: true, nombre: maillons.length }
}
