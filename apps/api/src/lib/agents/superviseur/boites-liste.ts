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
