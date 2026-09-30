// Rules of the one-time account merge (scripts/comptes-import.ts): the legacy
// `utilisateur` table held one row PER PC (WinDev picked the user by hostname),
// so a person could have several rows — Vincent #1 + #18, Isabelle #2 + #20…
// With password login an account is a person: every row of a person folds
// into their lowest id, the others are recorded in `utilisateur_fusion`.
// Pure functions, tested in comptes-fusion.test.ts.

export interface LigneUtilisateur {
  idutilisateur: number
  prenom: string | null
  nom: string | null
}

export interface PlanCompte {
  /** The account kept: lowest id of the person. */
  idutilisateur: number
  prenom: string
  nom: string
  typeCompte: 'personne' | 'poste'
  /** Rows folded into it. */
  anciens: number[]
  identifiant: string
}

const ascii = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/** Login identifier derived from the name: the first name, lowercased, no
 *  accents (`Mickaël` → `mickael`); `prenom.nom` when two people share one. */
function identifiantDe(prenom: string, nom: string, pris: Set<string>): string {
  const slug = (s: string) => ascii(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const court = slug(prenom) || slug(nom) || 'compte'
  if (!pris.has(court)) return court
  const long = `${court}.${slug(nom)}`
  let candidat = long
  for (let i = 2; pris.has(candidat); i++) candidat = `${long}${i}`
  return candidat
}

/** Groups rows by person (first + last name, case- and accent-insensitive).
 *  A row with no last name is a STATION account (« Visitage », « Regleur »):
 *  it logs in only through an enrolled poste, never with a password. */
export function planFusion(rows: readonly LigneUtilisateur[]): PlanCompte[] {
  const groupes = new Map<string, LigneUtilisateur[]>()
  for (const r of [...rows].sort((a, b) => a.idutilisateur - b.idutilisateur)) {
    const cle = `${ascii(r.prenom ?? '')}|${ascii(r.nom ?? '')}`
    const g = groupes.get(cle)
    if (g) g.push(r)
    else groupes.set(cle, [r])
  }
  const pris = new Set<string>()
  const plans: PlanCompte[] = []
  for (const g of groupes.values()) {
    const [garde, ...autres] = g
    const prenom = (garde.prenom ?? '').trim()
    const nom = (garde.nom ?? '').trim()
    const identifiant = identifiantDe(prenom, nom, pris)
    pris.add(identifiant)
    plans.push({
      idutilisateur: garde.idutilisateur,
      prenom,
      nom,
      typeCompte: nom ? 'personne' : 'poste',
      anciens: autres.map((r) => r.idutilisateur),
      identifiant,
    })
  }
  return plans.sort((a, b) => a.idutilisateur - b.idutilisateur)
}

/** Old id → kept id, for every folded row. */
export function carteFusion(plans: readonly PlanCompte[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const p of plans) for (const a of p.anciens) m.set(a, p.idutilisateur)
  return m
}

/** Merges the permission sets of one person's rows (kept row first). Nobody
 *  loses anything: every grant of any row is kept. A screen HIDE key
 *  (`hide_…`) survives only if every row that grants screens at all hid it
 *  too — a screen visible on one of the person's PCs stays visible. */
export function fusionnerCles(ensembles: readonly (readonly string[])[]): string[] {
  const estHide = (k: string) => k.startsWith('hide_')
  const positives = new Set<string>()
  for (const e of ensembles) for (const k of e) if (!estHide(k)) positives.add(k)
  const avecEcrans = ensembles.filter((e) => e.some((k) => k.startsWith('screen_')))
  const hides = new Set<string>()
  for (const e of ensembles) for (const k of e) if (estHide(k)) hides.add(k)
  const gardes = [...hides].filter((h) => avecEcrans.length > 0 && avecEcrans.every((e) => e.includes(h)))
  return [...positives, ...gardes].sort()
}
