// Compte client (`client.compte`) — the "411XXX" accounting account code.
// Mirrors the rules enforced by the API (apps/api/src/lib/compte-client.ts):
// generation always produces 411 + 3 alphanumerics, but validation accepts
// 411 + 3-or-more so the 388 legacy 4-char codes stay editable.

export const COMPTE_PREFIX = '411'
export const COMPTE_SUFFIX_LEN = 3
const COMPTE_RE = /^411[A-Z0-9]{3,}$/

/** Uppercase, strip accents and anything that isn't alphanumeric. */
export function normalizeCompte(v: string | null | undefined): string {
  return (v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

export function isValidCompte(v: string | null | undefined): boolean {
  return COMPTE_RE.test(normalizeCompte(v))
}

interface CompteCheckOptions {
  /** Codes already in use (normalized). Enables the live duplicate check —
   *  omit it and only the format is validated. */
  taken?: ReadonlySet<string>
  /** The code this client already holds, so re-saving it unchanged is never
   *  reported as a conflict with itself. */
  ownCompte?: string | null
}

/** French explanation of why a value is refused — null when it is valid. */
export function compteError(v: string | null | undefined, opts?: CompteCheckOptions): string | null {
  const c = normalizeCompte(v)
  if (!c) return 'Le compte client est obligatoire.'
  if (!c.startsWith(COMPTE_PREFIX)) return 'Le compte client doit commencer par 411.'
  if (c.length < COMPTE_PREFIX.length + COMPTE_SUFFIX_LEN) {
    return 'Le compte client doit comporter 3 lettres ou chiffres après 411.'
  }
  if (opts?.taken && c !== normalizeCompte(opts.ownCompte) && opts.taken.has(c)) {
    return `Le compte client ${c} est déjà attribué à un autre client.`
  }
  return null
}
