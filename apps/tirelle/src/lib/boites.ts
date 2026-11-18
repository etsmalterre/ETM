// The lab's shelf: 48 boxes where the squares and tirelles are stored once a
// lot's controls are done, rows A to F, numbers 1 to 8 (Vincent 2026-11-18,
// LIVA #1380). Mirror of the API's lib/tirelle-boites.ts, which decides.

export const RANGEES = ['A', 'B', 'C', 'D', 'E', 'F'] as const
export const NUMEROS = [1, 2, 3, 4, 5, 6, 7, 8] as const

/** A stored location as a box (« b 3 » → « B3 »), null when it is not one
 *  (« Carton », « 0 »: what was typed before the boxes). */
export function lireBoite(v: string | null | undefined): string | null {
  const s = (v ?? '').replace(/\s+/g, '').toUpperCase()
  return /^[A-F][1-8]$/.test(s) ? s : null
}

/** How long ago a date was, in the words of an archive's age: « 12 jours »,
 *  « 9 mois », « 1 an et 2 mois » (whole months, a started one does not count). */
export function ageArchive(depuis: string, aujourdhui: Date = new Date()): string {
  const [a, m, j] = depuis.slice(0, 10).split('-').map(Number)
  const mois = (aujourdhui.getFullYear() - a) * 12 + (aujourdhui.getMonth() + 1 - m) - (aujourdhui.getDate() < j ? 1 : 0)
  if (mois < 1) {
    const jours = Math.max(0, Math.round((Date.UTC(aujourdhui.getFullYear(), aujourdhui.getMonth(), aujourdhui.getDate()) - Date.UTC(a, m - 1, j)) / 86_400_000))
    return `${jours} jour${jours > 1 ? 's' : ''}`
  }
  const ans = Math.floor(mois / 12)
  const reste = mois % 12
  if (ans === 0) return `${mois} mois`
  return `${ans} an${ans > 1 ? 's' : ''}${reste ? ` et ${reste} mois` : ''}`
}
