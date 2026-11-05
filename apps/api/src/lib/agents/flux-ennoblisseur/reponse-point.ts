// Flux Ennoblisseur — reading a dyer's reply to our « Point du JJ/MM »
// (lib/point-sst/). Pure, tested on the real replies (reponse-point.test.ts).
//
// MATEL answers the Point section by section, in the order of SECTIONS
// (point-sst/regles.ts):
//
//   2) lot 109579     laize = 156cm     poids = 166g/m²     stabs     h = -3     l = -3     V = 4%
//   3) cde 9094 métrages cet aprème
//   5) s 49
//
// §5 (« Pouvez-vous me confirmer les délais… ») holds the délais, §2 (« Puis-je
// avoir vos contrôles… ») the dyer's controls. A bare answer in §5 (« s 49 »)
// is for EVERY order the Point listed in §5; a line naming orders (« cde 9086
// s 49 ») is for those. « s N » = Wednesday of ISO week N — what
// Pierre-Emmanuel types (« s 47 » of 23/10 → 18/11, delai_sst_evenement,
// claude_doc/agents_autonomie.md §7). Anything else is not read here: the
// skill asks a person (with the model's proposal).

/** « RE: Point du 05/11 » → the Point's day, 'YYYY-MM-DD' (year from the mail's date). */
export function jourDuPoint(sujet: string, dateMail: string): string | null {
  const m = /\bpoint\s+du\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i.exec(sujet)
  if (!m) return null
  const j = +m[1], mo = +m[2]
  if (j < 1 || j > 31 || mo < 1 || mo > 12) return null
  const anneeMail = +dateMail.slice(0, 4)
  let annee = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : anneeMail
  // A Point of late December answered in January.
  if (!m[3] && mo === 12 && +dateMail.slice(5, 7) === 1) annee = anneeMail - 1
  return `${annee}-${String(mo).padStart(2, '0')}-${String(j).padStart(2, '0')}`
}

/** True for a reply (or forward) to one of our Points. */
export const estReponsePoint = (sujet: string) => /^\s*((re|tr|fwd?)\s*:\s*)+point\s+du\s+\d/i.test(sujet)

/** The answer under each section number, signature cut. Lines before the first number are dropped. */
export function sections(texte: string): Map<number, string[]> {
  const out = new Map<number, string[]>()
  let courante: number | null = null
  for (const brut of texte.split(/\r?\n/)) {
    const l = brut.trim()
    if (/^(cordialement|bien cordialement|bonne journ|merci|salutations)/i.test(l)) break
    const m = /^([1-6])\s*\)\s*(.*)$/.exec(l)
    if (m) {
      courante = +m[1]
      out.set(courante, m[2].trim() ? [m[2].trim()] : [])
      continue
    }
    if (courante !== null && l) out.get(courante)!.push(l)
  }
  return out
}

/** Wednesday of ISO week `semaine` of `annee`, 'YYYY-MM-DD'. */
export function mercrediSemaineIso(annee: number, semaine: number): string {
  // ISO week 1 holds January 4th.
  const j4 = new Date(Date.UTC(annee, 0, 4))
  const lundiS1 = j4.getTime() - ((j4.getUTCDay() + 6) % 7) * 86_400_000
  return new Date(lundiS1 + ((semaine - 1) * 7 + 2) * 86_400_000).toISOString().slice(0, 10)
}

/** ISO weeks in a year (52 or 53). */
function semainesDansAnnee(annee: number): number {
  const d = new Date(Date.UTC(annee, 11, 28))
  const j = (d.getUTCDay() + 6) % 7
  const jeudi = new Date(d.getTime() + (3 - j) * 86_400_000)
  const debut = Date.UTC(jeudi.getUTCFullYear(), 0, 1)
  return Math.ceil(((jeudi.getTime() - debut) / 86_400_000 + 1) / 7)
}

/** The délai one answer gives, when it is a form the code reads for sure:
 *  « s 49 », « S49 », « semaine 49 », « sem. 49 », or a date « 02/12 » /
 *  « 02/12/2026 ». The year is the one that puts the date at or after the
 *  mail (a week 2 answered in December is next year's). Null otherwise. */
export function lireDelai(reponse: string, dateMail: string): string | null {
  const t = reponse.trim().replace(/[.;,]+$/, '')
  const annee = +dateMail.slice(0, 4)
  const jour = dateMail.slice(0, 10)
  const s = /^(?:s|sem(?:aine)?\.?)\s*(\d{1,2})$/i.exec(t)
  if (s) {
    const n = +s[1]
    for (const a of [annee, annee + 1]) {
      if (n < 1 || n > semainesDansAnnee(a)) continue
      const d = mercrediSemaineIso(a, n)
      // Up to a week back still counts as this year's (« s 45 » answered on Thursday of week 45).
      if (d >= addJours(jour, -7)) return d
    }
    return null
  }
  const d = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(t)
  if (d) {
    const jj = +d[1], mm = +d[2]
    if (jj < 1 || jj > 31 || mm < 1 || mm > 12) return null
    const fmt = (a: number) => `${a}-${String(mm).padStart(2, '0')}-${String(jj).padStart(2, '0')}`
    if (d[3]) return fmt(d[3].length === 2 ? 2000 + +d[3] : +d[3])
    return fmt(fmt(annee) >= addJours(jour, -7) ? annee : annee + 1)
  }
  return null
}

function addJours(iso: string, n: number): string {
  return new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

/** One order the Point asked in §5. */
export interface QuestionDelai {
  /** The order number as printed (= IDcommande_sous_traitant). */
  commande: string
  idcommande: number
  idligne: number
  article: string
}

/** What §5 of the reply says for one question. */
export interface ReponseDelai {
  question: QuestionDelai
  /** The answer text that applies to it ('' = no answer for it). */
  texte: string
  /** The délai read for sure, 'YYYY-MM-DD', else null. */
  delai: string | null
  /** The answer names this order (« cde 9086 s 50 »); false = a bare answer
   *  for every order of §5 (« s 49 »). Said in Tricobot's reasoning. */
  nommee: boolean
}

/** « cde 9086 s 49 », « Cdes 9074-9081 s 50 », « 9086 : s 49 » → the orders named and the rest. */
function commandesNommees(ligne: string): { commandes: string[]; reste: string } {
  const m = /^(?:cdes?\.?\s*|commandes?\s*)?((?:\d{4,6})(?:\s*(?:[-+/,&]|et)\s*\d{4,6})*)\s*[:=-]?\s*(.*)$/i.exec(ligne)
  if (!m || !/^(cdes?|commandes?)/i.test(ligne) && !/^\d{4,6}\s*[:=-]/.test(ligne)) return { commandes: [], reste: ligne }
  return { commandes: m[1].split(/\s*(?:[-+/,&]|et)\s*/i).filter(Boolean), reste: m[2].trim() }
}

/** Each §5 question with the answer that applies to it. A line naming orders
 *  answers those; a line naming none answers every question not named elsewhere. Pure. */
export function repondreDelais(questions: readonly QuestionDelai[], lignes: readonly string[], dateMail: string): ReponseDelai[] {
  const parCommande = new Map<string, string>()
  const generales: string[] = []
  for (const l of lignes) {
    const { commandes, reste } = commandesNommees(l)
    if (commandes.length) for (const c of commandes) parCommande.set(c, reste)
    // « Le reste s 43 » (23/09, 01/10): the answer for every order not named.
    else generales.push(l.replace(/^(?:pour\s+)?le\s+reste\s*:?\s*/i, ''))
  }
  const general = generales.join(' ').trim()
  return questions.map((q) => {
    const nommee = parCommande.has(q.commande)
    const texte = parCommande.get(q.commande) ?? general
    return { question: q, texte, delai: texte ? lireDelai(texte, dateMail) : null, nommee }
  })
}

// ── §2: the dyer's controls ──────────────────────────────

export interface ControleLu {
  /** The lot number as written (« 109579 »). */
  lot: string
  laize: number | null
  poids: number | null
  stabH: number | null
  stabL: number | null
  /** % ; null = not given (0 is a measure). */
  vrillage: number | null
  texte: string
  /** Why the line cannot be read for sure (« l » twice, no « h »…): the skill asks a person. */
  doute?: string
}

const num = (s: string | undefined) => (s == null ? null : Number(s.replace(',', '.')))

/** Every « lot N laize = … poids = … stabs h = … l = … V = …% » line of §2. A
 *  line naming a lot without any measure (« Résultats lot 109669 demain ») is
 *  kept with every measure null. Pure. */
export function lireControles(lignes: readonly string[]): ControleLu[] {
  const out: ControleLu[] = []
  for (const l of lignes) {
    const lot = /\blot\s*(?:n°\s*)?(\d{5,7})/i.exec(l)
    if (!lot) continue
    // « stabs l = -6 l = -5 » (15/10, a typo for h / l): never guess which is which.
    const nH = (l.match(/\bh\s*=/gi) ?? []).length
    const nL = (l.match(/\bl\s*=/gi) ?? []).length
    const stabs = /stab/i.test(l) || nH + nL > 0
    const doute = !stabs ? undefined
      : nH > 1 || nL > 1 ? `« ${nH > 1 ? 'h' : 'l'} = » écrit deux fois dans les stabilités : je ne sais pas laquelle est la hauteur et laquelle la largeur.`
      : nH === 0 || nL === 0 ? `Stabilité ${nH === 0 ? 'en hauteur (h)' : 'en largeur (l)'} absente de la ligne.`
      : undefined
    out.push({
      ...(doute ? { doute } : {}),
      lot: lot[1],
      laize: num(/laize(?:\s+utile)?\s*=\s*(\d+(?:[.,]\d+)?)/i.exec(l)?.[1]),
      poids: num(/poids\s*=\s*(\d+(?:[.,]\d+)?)/i.exec(l)?.[1]),
      stabH: num(/\bh\s*=\s*([+-]?\s*\d+(?:[.,]\d+)?)/i.exec(l)?.[1]?.replace(/\s+/g, '')),
      stabL: num(/\bl\s*=\s*([+-]?\s*\d+(?:[.,]\d+)?)/i.exec(l)?.[1]?.replace(/\s+/g, '')),
      vrillage: num(/\bv\s*=\s*(\d+(?:[.,]\d+)?)\s*%/i.exec(l)?.[1]),
      texte: l,
    })
  }
  return out
}
