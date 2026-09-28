// Workload of an employee (RH › Charge de travail) — pure rules, no I/O.
//
// Born from the spreadsheet « Optimisation IA 25-11.xlsx » (Isa + Vincent,
// November 2025): a 35 h week split into tasks, each with its hours, whether it
// can be automated and whether it already is. Kept deliberately simple (Vincent,
// 2026-09-25: « sans que ce soit l'usine à gaz »):
//
//   • ONE figure per task, its current value, always written the same way:
//     minutes per unit × units per week = minutes per week (the spreadsheet
//     reasoned so: « 10 min/cmd × 14 cmd/semaine »). The volume is MEASURED
//     when ETM counts it (lib/rh-indicateurs.ts), else ESTIMATED (typed, with
//     a free unit: « appel », « point stock »…). A task with no natural unit
//     (ménage, the structural slack) stays a FORFAIT: hours typed.
//   • Three automation states: à automatiser (automatisable = 'oui'),
//     automatisé, the rest. 'partiel' / 'inconnu' are kept in the data (the
//     spreadsheet had them) but count as « the rest ».
//   • What is left of the contract is « non attribué », never typed. The old
//     structural slack row is just a task (« Improductivité structurelle »).
//   • Every save is kept as a dated relevé; the monthly curve takes, for each
//     week, the relevé in force that week.

export const CATEGORIES = ['tache', 'improductivite_structurelle'] as const
export type Categorie = (typeof CATEGORIES)[number]

export const AUTOMATISABLE = ['oui', 'partiel', 'non', 'inconnu'] as const
export type Automatisable = (typeof AUTOMATISABLE)[number]

export interface TacheCharge {
  nom: string
  description: string
  methode: string
  /** Hours per week as typed (for a measured task: the value at the relevé). */
  heures: number
  automatisable: Automatisable
  automatise: boolean
  categorie: Categorie
  /** Measured task: key of lib/rh-indicateurs.ts, with minutes per unit. */
  indicateur: string | null
  /** Minutes per unit — measured and estimated tasks; null on a forfait. */
  minutesParUnite: number | null
  /** Estimated task: units per week, typed (null when measured or forfait). */
  volumeSaisi: number | null
  /** Estimated task: its unit, singular (« appel »); '' otherwise. */
  unite: string
}

export type ModeTache = 'mesuree' | 'estimee' | 'forfait'

export function modeTache(t: Pick<TacheCharge, 'indicateur' | 'minutesParUnite' | 'volumeSaisi'>): ModeTache {
  if (estMesuree(t)) return 'mesuree'
  return t.minutesParUnite != null && t.minutesParUnite > 0 && t.volumeSaisi != null ? 'estimee' : 'forfait'
}

export interface VersionCharge {
  id: number
  /** YYYY-MM-DD */
  dateReleve: string
  taches: TacheCharge[]
}

export const round2 = (n: number) => Math.round(n * 100) / 100

/** A measured task is measured only when both halves are there. */
export function estMesuree(t: Pick<TacheCharge, 'indicateur' | 'minutesParUnite'>): boolean {
  return !!t.indicateur && t.minutesParUnite != null && t.minutesParUnite > 0
}

/** Hours of a measured task for a weekly volume. */
export function heuresMesurees(minutesParUnite: number, volumeHebdo: number): number {
  return round2((minutesParUnite * volumeHebdo) / 60)
}

// ── Weeks ────────────────────────────────────────────────

const DAY_MS = 86_400_000

/** Monday (UTC) of the week holding `d`, as YYYY-MM-DD. */
export function lundiDe(d: Date): string {
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const dow = (new Date(t).getUTCDay() + 6) % 7 // 0 = Monday
  return new Date(t - dow * DAY_MS).toISOString().slice(0, 10)
}

/** Monday of the week of a HFSQL date `YYYYMMDD`, or null when malformed. */
export function lundiDeHfsql(d: string | null | undefined): string | null {
  if (!d || !/^\d{8}/.test(d)) return null
  const date = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8))))
  return Number.isNaN(date.getTime()) ? null : lundiDe(date)
}

/** Count HFSQL dates per Monday. */
export function compterParSemaine(dates: Array<string | null | undefined>): Map<string, number> {
  const out = new Map<string, number>()
  for (const d of dates) {
    const l = lundiDeHfsql(d)
    if (l) out.set(l, (out.get(l) ?? 0) + 1)
  }
  return out
}

/** Weekly volume smoothed over the `fenetre` weeks ending at `semaine`
 *  (a single week is too noisy: a Monday holiday halves it). */
export function volumeLisse(parSemaine: Map<string, number>, semaine: string, fenetre = 4): number {
  const t = Date.parse(`${semaine}T00:00:00Z`)
  let total = 0
  for (let i = 0; i < fenetre; i++) {
    total += parSemaine.get(new Date(t - i * 7 * DAY_MS).toISOString().slice(0, 10)) ?? 0
  }
  return total / fenetre
}

// ── Evolution ────────────────────────────────────────────

/** The version in force on a Monday: the latest relevé on or before the end of
 *  that week. Weeks before the first relevé take the first one — the chart
 *  marks them as « avant le premier relevé ». */
export function versionEnVigueur<V extends { dateReleve: string }>(versions: V[], semaine: string): V | null {
  if (versions.length === 0) return null
  const finSemaine = new Date(Date.parse(`${semaine}T00:00:00Z`) + 6 * DAY_MS).toISOString().slice(0, 10)
  const tries = [...versions].sort((a, b) => a.dateReleve.localeCompare(b.dateReleve))
  let v = tries[0]
  for (const x of tries) if (x.dateReleve <= finSemaine) v = x
  return v
}

// ── Validation of a posted task list ─────────────────────

export function normaliserTache(raw: Partial<TacheCharge>): TacheCharge {
  const auto = AUTOMATISABLE.includes(raw.automatisable as Automatisable) ? (raw.automatisable as Automatisable) : 'inconnu'
  const cat = CATEGORIES.includes(raw.categorie as Categorie) ? (raw.categorie as Categorie) : 'tache'
  const minutes = raw.minutesParUnite != null && Number(raw.minutesParUnite) > 0 ? round2(Number(raw.minutesParUnite)) : null
  const indicateur = cat === 'tache' && raw.indicateur ? String(raw.indicateur) : null
  const volume = raw.volumeSaisi != null && Number(raw.volumeSaisi) >= 0 ? round2(Number(raw.volumeSaisi)) : null
  // Estimated: minutes × a typed volume — its hours are that product, never typed.
  const estimee = cat === 'tache' && !indicateur && minutes != null && volume != null
  return {
    nom: String(raw.nom ?? '').trim(),
    description: String(raw.description ?? '').trim(),
    methode: String(raw.methode ?? '').trim(),
    heures: estimee ? heuresMesurees(minutes, volume) : Math.max(0, round2(Number(raw.heures) || 0)),
    automatisable: cat === 'tache' ? auto : 'non',
    automatise: cat === 'tache' ? !!raw.automatise : false,
    categorie: cat,
    indicateur,
    minutesParUnite: indicateur || estimee ? minutes : null,
    volumeSaisi: estimee ? volume : null,
    unite: estimee ? String(raw.unite ?? '').trim().slice(0, 40) : '',
  }
}

// ── Monthly view (RH › Charge de travail, since 2026-09-25) ──
//
// The screen shows ONE figure per task — its current value — and a monthly
// curve. Three automation states only: à automatiser (automatisable = 'oui'),
// automatisé, the rest. The structural slack counts as a task (« Marge »):
// what is left of the contract is simply « non attribué ».

/** `n` months ending with the month of `fin`, oldest first, as YYYY-MM. */
export function moisListe(fin: Date, n: number): string[] {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth() - i, 1))
    out.push(d.toISOString().slice(0, 7))
  }
  return out
}

/** Hours of each task for one week: measured tasks take that week's volume
 *  smoothed over `fenetre` weeks, the others their typed hours. */
export function heuresSemaine(
  taches: TacheCharge[],
  volumes: Map<string, Map<string, number>>,
  semaine: string,
  fenetre = 1,
): number[] {
  return taches.map((t) => {
    const vol = estMesuree(t) ? volumes.get(t.indicateur!) : undefined
    return vol ? heuresMesurees(t.minutesParUnite!, volumeLisse(vol, semaine, fenetre)) : t.heures
  })
}

export interface TotauxSimples {
  /** Every row, the margin included. */
  taches: number
  aAutomatiser: number
  automatise: number
}

export function totauxSimples(taches: TacheCharge[], heures: number[]): TotauxSimples {
  let total = 0
  let aAutomatiser = 0
  let automatise = 0
  taches.forEach((t, i) => {
    const h = heures[i] ?? 0
    total += h
    if (t.automatise) automatise += h
    else if (t.automatisable === 'oui') aAutomatiser += h
  })
  return { taches: round2(total), aAutomatiser: round2(aAutomatiser), automatise: round2(automatise) }
}

export interface PointMensuel extends TotauxSimples {
  /** YYYY-MM */
  mois: string
  /** Relevés dated in that month (YYYY-MM-DD). */
  releves: string[]
  /** The month is still running: only its complete weeks are counted. */
  enCours: boolean
  avantPremierReleve: boolean
}

/** Average week of each month: every complete week whose Monday falls in the
 *  month, each with the relevé in force that week and its own volumes. */
export function evolutionMensuelle(
  versions: VersionCharge[],
  volumes: Map<string, Map<string, number>>,
  mois: string[],
  derniereSemaineComplete: string,
): PointMensuel[] {
  if (versions.length === 0) return []
  const premier = versions.map((v) => v.dateReleve).sort()[0]
  const out: PointMensuel[] = []
  for (const m of mois) {
    const debut = Date.parse(`${m}-01T00:00:00Z`)
    const lundis: string[] = []
    for (let t = Date.parse(`${lundiDe(new Date(debut))}T00:00:00Z`); ; t += 7 * DAY_MS) {
      const l = new Date(t).toISOString().slice(0, 10)
      if (l.slice(0, 7) > m) break
      if (l.slice(0, 7) === m && l <= derniereSemaineComplete) lundis.push(l)
    }
    if (lundis.length === 0) continue
    const acc = { taches: 0, aAutomatiser: 0, automatise: 0 }
    for (const l of lundis) {
      const v = versionEnVigueur(versions, l)!
      const tot = totauxSimples(v.taches, heuresSemaine(v.taches, volumes, l))
      acc.taches += tot.taches
      acc.aAutomatiser += tot.aAutomatiser
      acc.automatise += tot.automatise
    }
    const finMois = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10)
    const prochainLundi = new Date(Date.parse(`${derniereSemaineComplete}T00:00:00Z`) + 7 * DAY_MS).toISOString().slice(0, 10)
    out.push({
      mois: m,
      taches: round2(acc.taches / lundis.length),
      aAutomatiser: round2(acc.aAutomatiser / lundis.length),
      automatise: round2(acc.automatise / lundis.length),
      releves: versions.map((v) => v.dateReleve).filter((d) => d.slice(0, 7) === m).sort(),
      enCours: prochainLundi <= finMois,
      avantPremierReleve: finMois < premier,
    })
  }
  return out
}
