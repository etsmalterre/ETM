// Country label normalisation for `adresse.pays`.
//
// The legacy window let users type the country free-form, so the column holds
// « France », « FRANCE », « france », « Belgique  » (trailing space), « -1 »
// (a WinDev combo sentinel) for the same thing. A report column or an Excel
// filter over that is useless unless the spelling is unified, so every reader
// that surfaces the country as a column goes through `normalizePays()`.
//
// The rule is deliberately light — it never guesses a country: it trims,
// drops the sentinels, and only re-cases a value typed ALL UPPER or all lower
// (« ILE MAURICE » → « Ile Maurice », « PAYS-BAS » → « Pays-Bas »). A value
// already in mixed case (« États-Unis ») is returned as typed.

const SENTINELS = new Set(['', '-1', '0'])

function capitalizeWord(w: string): string {
  if (!w) return w
  return w.charAt(0).toLocaleUpperCase('fr') + w.slice(1).toLocaleLowerCase('fr')
}

export function normalizePays(raw: string | null | undefined): string {
  const v = (raw ?? '').toString().trim().replace(/\s+/g, ' ')
  if (SENTINELS.has(v)) return ''
  const isUpper = v === v.toLocaleUpperCase('fr')
  const isLower = v === v.toLocaleLowerCase('fr')
  if (!isUpper && !isLower) return v
  // Re-case word by word, keeping hyphens and apostrophes as word boundaries.
  return v.replace(/[^\s\-']+/g, capitalizeWord)
}
