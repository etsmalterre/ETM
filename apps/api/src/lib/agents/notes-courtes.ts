// The note of a prompt version: what changes for the people who use the agent,
// in one or two short sentences (Vincent 2026-11-11: « trop de texte et de
// détail, ça ne donne pas envie de lire »). The detail (thresholds, examples,
// what is code and what is prompt) lives in the code and its history, never in
// the note.
//
// The versions published before that rule carry a long note. They are read with
// the short one below (store.ts `lireEtat`), and stored with it at the next
// write of the state. The versions shipped with the code take their note from
// here too (`noteCourteDe`), so a stored version and the shipped one keep the
// same note: that is how a shipped version is known to be published
// (store.ts `estPublie`).
//
// Leaf module: no import.

/** A note longer than this is refused by the API and by the tests of the shipped versions. */
export const NOTE_MAX = 240

interface NoteCourte {
  slug: string
  /** The version's number in the stored state (production's numbering). */
  version: number
  /** How the long note starts: a state numbered otherwise (a dev state) is left alone. */
  debut: string
  note: string
}

const NOTES_COURTES: readonly NoteCourte[] = [
  {
    slug: 'bl-ennoblisseur', version: 2, debut: 'Version 2 — MATEL, Bontemps et TAD',
    note: 'MATEL, Bontemps et TAD. Seuls les BL sont lus : le reste est écarté sans notification.',
  },
  {
    slug: 'bl-ennoblisseur', version: 3, debut: 'Retours de la v2',
    note: 'Un BL bloqué dit pourquoi et quoi faire. Deux bordereaux du même lot dans un mail sont deux BL. Prompt inchangé.',
  },
  {
    slug: 'bl-ennoblisseur', version: 4, debut: 'Retours de la v3',
    note: 'Un métrage incohérent avec le poids bloque le BL. Un BL reçu sur des pièces déjà réceptionnées est comparé au stock. Prompt inchangé.',
  },
  {
    slug: 'superviseur', version: 3, debut: 'Version 3 — un mail archivé',
    note: 'Un mail archivé compte comme traité. Une commande reçue par mail est comparée ligne à ligne. Un client qui « reviendra vers nous » n’attend rien.',
  },
  {
    slug: 'superviseur', version: 4, debut: 'Version 4 — retard',
    note: 'Moins de fausses alertes sur les retards (commande sur appel, paiement avant livraison, retard déjà annoncé au client) et sur les confirmations de commande. Prompt inchangé.',
  },
  {
    slug: 'triage', version: 2, debut: 'Version 2 — un PDF d’ennoblisseur',
    note: 'Un PDF d’ennoblisseur n’est un BL que s’il est annoncé comme tel. Notre réponse dans un fil de BL, sans nouveau document, est interne.',
  },
  {
    slug: 'triage', version: 3, debut: 'Chez TAD, seule la mise à disposition',
    note: 'Chez TAD, seule la mise à disposition va à l’agent BL. Son bon de livraison est une expédition au client : il part en transport.',
  },
  {
    slug: 'rapport-activite', version: 2, debut: 'Version 3 — moins sévère',
    note: 'Moins sévère : un ton amical, une réponse pas encore faite dans l’heure ou un délai donné par mail ne sont plus des alertes. 3 alertes au plus.',
  },
  {
    slug: 'rapport-activite', version: 3, debut: 'Version 4 — relecture des 45',
    note: 'Un point d’attention = deux faits datés qui se contredisent. Les mails de Vincent et les échanges courants avec un fournisseur ne sont jamais des points.',
  },
  {
    slug: 'planning-atelier', version: 2, debut: 'Version 2 : dans un binôme',
    note: 'Dans un binôme, les heures de début s’échangent d’une semaine sur l’autre, pour que ce ne soit pas toujours le même qui finisse tard.',
  },
]

/** The note a stored version is read with: the short one when it still carries the long one. */
export function noteCourte(slug: string, version: number, note: string): string {
  const n = NOTES_COURTES.find((x) => x.slug === slug && x.version === version)
  return n && note.trim().startsWith(n.debut) ? n.note : note
}

/** The short note of a version shipped with the code: the one its stored copy is read with. */
export function noteCourteDe(slug: string, version: number): string {
  const n = NOTES_COURTES.find((x) => x.slug === slug && x.version === version)
  if (!n) throw new Error(`no short note for ${slug} v${version}`)
  return n.note
}

export const toutesLesNotesCourtes = (): readonly string[] => NOTES_COURTES.map((n) => n.note)
