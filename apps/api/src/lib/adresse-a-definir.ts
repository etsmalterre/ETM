// The legacy « A Définir » delivery address (LIVA #1189).
//
// `adresse` 795 is a single placeholder row shared by every client
// (IDclient = 0, every field « - »). The legacy let an order be taken before
// the client says where to deliver, and ~40 ETM orders plus 185 invoiced avis
// point at it. ETM offers it too, as the « À définir » choice of an order's
// delivery address — but only up to the moment the goods leave the factory:
// the BL (print or email) and the demande de transport refuse an avis whose
// address is still the placeholder (user decision 2026-09-23). The avis
// address itself is fixed in place, even on an invoiced avis (#1179).
//
// Prospect devis store the same row on both addresses (routes/devis.ts).

export const ADRESSE_A_DEFINIR = 795

export const ADRESSE_A_DEFINIR_LABEL = 'À définir'

export function isAdresseADefinir(id: unknown): boolean {
  return Number(id) === ADRESSE_A_DEFINIR
}

/** Display shape of the placeholder: the stored row prints « A Définir »
 *  followed by five « - » lines, so every reader replaces it with one clean
 *  label. `a_definir` lets the UI flag it. */
export function adresseADefinirRow() {
  return {
    IDadresse: ADRESSE_A_DEFINIR,
    nom: ADRESSE_A_DEFINIR_LABEL,
    adresse1: null,
    adresse2: null,
    adresse3: null,
    cp: null,
    ville: null,
    pays: null,
    a_definir: true as const,
  }
}

/** Swap a loaded address row for the clean placeholder shape when it is 795. */
export function withAdresseADefinir<T extends { IDadresse?: unknown } | null | undefined>(row: T): T {
  if (row && isAdresseADefinir(row.IDadresse)) return { ...row, ...adresseADefinirRow() } as T
  return row
}

/** 409 body of every route that would send the placeholder out of the
 *  factory. `message` is shown verbatim by the UI. */
export const ADRESSE_A_DEFINIR_REFUS = {
  error: 'adresse_a_definir',
  message:
    "L'adresse de livraison de cet avis est « À définir » : choisissez la vraie adresse avant d'éditer le BL ou la demande de transport.",
} as const
