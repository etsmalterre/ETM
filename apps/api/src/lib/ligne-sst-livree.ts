// When a dyer line is delivered (Vincent 2026-11-03): the BL is in and the rolls received, so
// every écru piece handed to the dyer for the line came back dyed (own fini roll or component of
// a merged roll, lib/fini-sources.ts). Never by the metrage: the ordered Ml is a projection
// (point-sst v5, 9003). The legacy `sstatut` « Terminé » is no longer written by anyone, so it
// cannot be the signal. Once delivered the line's délai stops alerting: the lot is « En contrôle »
// on its own clock (lib/cycle-ennoblissement.ts, RELANCE_J.controle). Pure.

export function ecruToutRevenu(affectes: number, revenus: number): boolean {
  return affectes > 0 && revenus >= affectes
}

/** 'YYYYMMDD' of a date / datetime in either driver shape, '' when empty. */
export function jourDe(v: unknown): string {
  const d = String(v ?? '').replace(/[^0-9]/g, '').slice(0, 8)
  return /^(19|20)\d{6}$/.test(d) ? d : ''
}

/** The day the line was delivered: the latest roll received, once every écru came back. Null otherwise. */
export function ligneLivreeLe(affectes: number, revenus: number, receptions: readonly string[]): string | null {
  if (!ecruToutRevenu(affectes, revenus)) return null
  const jours = receptions.filter(Boolean).sort()
  return jours.at(-1) ?? null
}
