// Working days of a partner (doctrine des délais §1, Vincent 2026-10-29): no weekend, no French public
// holiday, none of its closures (Sous-traitants › Gestion › Info › Fermetures, lib/delais-standards.ts).
// Dates are YYYYMMDD strings throughout. Pure, pinned by jours-ouvres.test.ts.

export interface Periode { du: string; au: string }

const DAY = 86_400_000
const versMs = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))
const versYmd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '')

/** Easter Sunday (Meeus / Jones / Butcher), as UTC ms. */
function paques(annee: number): number {
  const a = annee % 19, b = Math.floor(annee / 100), c = annee % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451)
  const mois = Math.floor((h + l - 7 * m + 114) / 31), jour = ((h + l - 7 * m + 114) % 31) + 1
  return Date.UTC(annee, mois - 1, jour)
}

const cacheFeries = new Map<number, Set<string>>()
/** French public holidays of a year. */
export function joursFeries(annee: number): Set<string> {
  let s = cacheFeries.get(annee)
  if (s) return s
  const p = paques(annee)
  s = new Set([
    `${annee}0101`, `${annee}0501`, `${annee}0508`, `${annee}0714`, `${annee}0815`, `${annee}1101`, `${annee}1111`, `${annee}1225`,
    versYmd(p + DAY), versYmd(p + 39 * DAY), versYmd(p + 50 * DAY), // lundi de Pâques, Ascension, lundi de Pentecôte
  ])
  cacheFeries.set(annee, s)
  return s
}

export function estOuvre(ymd: string, fermetures: readonly Periode[] = []): boolean {
  const dow = new Date(versMs(ymd)).getUTCDay()
  if (dow === 0 || dow === 6) return false
  if (joursFeries(+ymd.slice(0, 4)).has(ymd)) return false
  return !fermetures.some((f) => ymd >= f.du && ymd <= f.au)
}

/** The date `n` working days after `depart` (n rounded up; 0 = `depart` itself). */
export function ajouterJoursOuvres(depart: string, n: number, fermetures: readonly Periode[] = []): string {
  let reste = Math.ceil(Math.max(0, n))
  let t = versMs(depart)
  while (reste > 0) {
    t += DAY
    if (estOuvre(versYmd(t), fermetures)) reste--
  }
  return versYmd(t)
}

/** Working days from `a` to `b` (b after a → positive), `a` excluded, `b` included. */
export function joursOuvresEntre(a: string, b: string, fermetures: readonly Periode[] = []): number {
  if (a === b) return 0
  const sens = b > a ? 1 : -1
  let t = versMs(a)
  const fin = versMs(b)
  let n = 0
  while (sens > 0 ? t < fin : t > fin) {
    t += sens * DAY
    if (estOuvre(versYmd(t), fermetures)) n += sens
  }
  return n
}
