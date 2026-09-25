// Agent « Superviseur » — the factory mailboxes it reads (read-only).
// Own module so the checks can import it without importing superviseur.ts
// (which imports the checks). Laetitia = l.tellier@ (laetitia@ does not exist).
// isabelle@ added 2026-09-24 (read access checked with essai-superviseur-boites.ts).

export const SUPERVISEUR_BOITES: readonly string[] = (
  process.env.AGENT_SUPERVISEUR_BOITES?.trim() ||
  'contact@etsmalterre.com,n.antonino@etsmalterre.com,l.tellier@etsmalterre.com,pierre-emmanuel@etsmalterre.com,isabelle@etsmalterre.com'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** Who reads the report (decision Isabelle, 2026-09-25). Her own inbox she
 *  manages herself: a conversation that reached her is reported only once it
 *  has waited BOITE_LECTRICE_DELAI_H (regles.ts). */
export const SUPERVISEUR_LECTRICE = 'isabelle@etsmalterre.com'

/** Mailboxes whose conversations are reported only when the reader is in copy
 *  somewhere in them (Isabelle on Nicolas's technical threads, 2026-09-25:
 *  « tant que Nicolas ne me met pas en copie »). */
export const BOITES_SUR_COPIE: readonly string[] = ['n.antonino@etsmalterre.com']
