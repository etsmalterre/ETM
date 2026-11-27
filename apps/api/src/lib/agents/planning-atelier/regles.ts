// Agent « Planning atelier » (LIVA #1296) — the pure part: what the model is
// shown of the past weeks, the check of what it answers, and the gaps between
// what Tricobot wrote and the week Isa finally kept (her retour). No I/O.
//
// The week is the grid's: Sunday → Saturday (legacy convention), a night shift
// starting Sunday 21:00 belongs to the week that follows. Shifts are told
// apart by their start hour, exactly as the screen does (AtelierPlanning.tsx
// `equipeOf`): 04–12 h Matin, 12–20 h Après-midi, otherwise Nuit.

import { addDays } from '../../planning-bonnetier.js'

export type Equipe = 'M' | 'A' | 'N'

export const EQUIPE_LIBELLE: Record<Equipe, string> = { M: 'Matin', A: 'Après-midi', N: 'Nuit' }

export function equipeDe(debut: string): Equipe {
  const h = parseInt(debut.slice(0, 2), 10)
  if (h >= 4 && h < 12) return 'M'
  if (h >= 12 && h < 20) return 'A'
  return 'N'
}

export interface Creneau {
  IDbonnetier: number
  date: string // YYYY-MM-DD
  debut: string // HH:MM
  fin: string // HH:MM (≤ début = the next day)
}

export interface BonnetierPlanning {
  id: number
  prenom: string
  nom: string
}

const JOURS_COURTS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.']

/** « lun. 17/11 ». */
export function jourCourt(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  return `${JOURS_COURTS[d.getUTCDay()]} ${date.slice(8, 10)}/${date.slice(5, 7)}`
}

/** ISO week number of the grid week starting on `dimanche` (its Monday's week). */
export function semaineIso(dimanche: string): number {
  const d = new Date(`${addDays(dimanche, 1)}T00:00:00Z`)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const debutAnnee = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - debutAnnee.getTime()) / 86_400_000 + 1) / 7)
}

export function estDimanche(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(`${date}T00:00:00Z`).getUTCDay() === 0
}

/** Each bonnetier's main shift in a set of créneaux (the shift of most of
 *  their days), grouped: the week's teams — and so its pairs. A bonnetier with
 *  no créneau is left out. Order: Matin, Après-midi, Nuit; names by start hour. */
export function equipesDeLaSemaine(creneaux: readonly Creneau[], bonnetiers: readonly BonnetierPlanning[]): Array<{ equipe: Equipe; membres: Array<{ prenom: string; horaire: string; jours: number }> }> {
  const out = (['M', 'A', 'N'] as const).map((equipe) => ({ equipe, membres: [] as Array<{ prenom: string; horaire: string; jours: number; debut: string }> }))
  for (const b of bonnetiers) {
    const siens = creneaux.filter((c) => c.IDbonnetier === b.id)
    if (siens.length === 0) continue
    const compte = new Map<string, number>()
    for (const c of siens) compte.set(`${c.debut}-${c.fin}`, (compte.get(`${c.debut}-${c.fin}`) ?? 0) + 1)
    const horaire = [...compte.entries()].sort((x, y) => y[1] - x[1])[0][0]
    out.find((g) => g.equipe === equipeDe(horaire.slice(0, 5)))!.membres.push({ prenom: b.prenom, horaire, jours: siens.length, debut: horaire.slice(0, 5) })
  }
  return out
    .filter((g) => g.membres.length > 0)
    .map((g) => ({ equipe: g.equipe, membres: g.membres.sort((x, y) => x.debut.localeCompare(y.debut)).map(({ prenom, horaire, jours }) => ({ prenom, horaire, jours })) }))
}

/** The past weeks as the model reads them: one line per week with its teams
 *  (« S42 (du dim. 11/10) — Matin : Angélique 05:00-12:00, Anaïs 06:00-13:00 ·
 *  Après-midi : … »), then the days that break the pattern. A week nobody
 *  worked (holidays) says so — the rotation carries over it. */
export function historiqueTexte(entries: readonly Creneau[], bonnetiers: readonly BonnetierPlanning[], dimanches: readonly string[]): string {
  const lignes: string[] = []
  for (const dim of dimanches) {
    const jours = new Set(Array.from({ length: 7 }, (_, i) => addDays(dim, i)))
    const semaine = entries.filter((e) => jours.has(e.date))
    const titre = `S${semaineIso(dim)} (du ${jourCourt(dim)})`
    if (semaine.length === 0) {
      lignes.push(`${titre} : aucun créneau (semaine non travaillée)`)
      continue
    }
    const equipes = equipesDeLaSemaine(semaine, bonnetiers)
    const absents = bonnetiers.filter((b) => !semaine.some((e) => e.IDbonnetier === b.id)).map((b) => b.prenom)
    lignes.push(
      `${titre} — ${equipes.map((g) => `${EQUIPE_LIBELLE[g.equipe]} : ${g.membres.map((m) => `${m.prenom} ${m.horaire}${m.jours !== 5 ? ` (${m.jours} j)` : ''}`).join(', ')}`).join(' · ')}` +
        (absents.length ? ` · non planifiés : ${absents.join(', ')}` : ''),
    )
    // Days off the bonnetier's main hours (a swapped day, a shorter day).
    for (const g of equipes) {
      for (const m of g.membres) {
        const b = bonnetiers.find((x) => x.prenom === m.prenom)!
        for (const e of semaine.filter((x) => x.IDbonnetier === b.id && `${x.debut}-${x.fin}` !== m.horaire).sort((x, y) => x.date.localeCompare(y.date))) {
          lignes.push(`    sauf ${m.prenom} ${jourCourt(e.date)} : ${EQUIPE_LIBELLE[equipeDe(e.debut)]} ${e.debut}-${e.fin}`)
        }
      }
    }
  }
  return lignes.join('\n')
}

/** A week's régime in words — which shifts run and how long a day is
 *  (« 2 équipes (Matin, Après-midi), journées de 7 h »). Read on each
 *  bonnetier's usual hours of the week (the most frequent), so one swapped or
 *  shortened day does not change it. Two weeks with the same words run the
 *  same régime. */
export function regimeDe(creneaux: readonly Creneau[]): string {
  if (creneaux.length === 0) return 'aucune équipe'
  const habituels: string[] = []
  for (const id of new Set(creneaux.map((c) => c.IDbonnetier))) {
    const compte = new Map<string, number>()
    for (const c of creneaux.filter((x) => x.IDbonnetier === id)) compte.set(`${c.debut}-${c.fin}`, (compte.get(`${c.debut}-${c.fin}`) ?? 0) + 1)
    habituels.push([...compte.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0])
  }
  const equipes = (['M', 'A', 'N'] as const).filter((e) => habituels.some((h) => equipeDe(h.slice(0, 5)) === e))
  const heures = [...new Set(habituels.map((h) => Math.round(((((toMin(h.slice(6)) - toMin(h.slice(0, 5)) + 1440) % 1440) || 1440) / 60) * 2) / 2))].sort((a, b) => a - b)
  return `${equipes.length} équipe${equipes.length > 1 ? 's' : ''} (${equipes.map((e) => EQUIPE_LIBELLE[e]).join(', ')}), journées de ${heures.map((h) => String(h).replace('.', ',')).join(' ou ')} h`
}

/** The créneaux of the last week of `dimanches` that has any (holidays skipped). */
export function derniereSemaineTravaillee(entries: readonly Creneau[], dimanches: readonly string[]): Creneau[] {
  for (let i = dimanches.length - 1; i >= 0; i--) {
    const fin = addDays(dimanches[i], 6)
    const xs = entries.filter((e) => e.date >= dimanches[i] && e.date <= fin)
    if (xs.length) return xs
  }
  return []
}

/** Cycle length of the pairs (decision of the workshop: recomposed every 4 weeks). */
export const SEMAINES_PAR_CYCLE = 4

type SemaineVue = { dim: string; equipes: ReturnType<typeof equipesDeLaSemaine>; groupes: string[][] }

/** A run of weeks under the same pairs. `comp` is who shares a team (shift
 *  labels ignored: the pairs swap shifts every week). */
interface Cycle {
  semaines: SemaineVue[]
  comp: string[][]
}

const parNom = (a: string, b: string) => a.localeCompare(b, 'fr')
const cleDe = (groupes: readonly (readonly string[])[]) => groupes.map((g) => [...g].sort(parNom).join(' + ')).sort().join(' / ')
const binomesDe = (groupes: readonly (readonly string[])[]) => groupes.map((g) => [...g].sort(parNom).join(' + ')).sort().join(', ')
const S = (dim: string) => `S${semaineIso(dim)}`

/** Whether a week goes on with the cycle's pairs: among the people present in
 *  both, nobody changed partner. A week where someone is missing (a leave, Isa
 *  arranging those who are there) keeps the pairs: Isa's retour on S50,
 *  25/11/2026, « pour conserver le rythme avant la semaine de congés ». */
function continueLeCycle(comp: readonly string[][], groupes: readonly string[][]): boolean {
  const la = new Set(groupes.flat())
  const communs = new Set(comp.flat().filter((n) => la.has(n)))
  if (communs.size === 0) return false
  const sur = (gs: readonly string[][]) => cleDe(gs.map((g) => g.filter((n) => communs.has(n))).filter((g) => g.length > 0))
  return sur(comp) === sur(groupes)
}

/** The pairs of a cycle once a week adds the people it did not have yet. */
function fusion(comp: readonly string[][], groupes: readonly string[][]): string[][] {
  const out: string[][] = []
  for (const g of [...comp, ...groupes]) {
    const touches = out.filter((o) => o.some((n) => g.includes(n)))
    const reste = out.filter((o) => !touches.includes(o))
    out.length = 0
    out.push(...reste, [...new Set([...touches.flat(), ...g])].sort(parNom))
  }
  return out
}

function cyclesDe(semaines: readonly SemaineVue[]): Cycle[] {
  const cycles: Cycle[] = []
  for (const s of semaines) {
    const c = cycles[cycles.length - 1]
    if (c && continueLeCycle(c.comp, s.groupes)) {
      c.semaines.push(s)
      c.comp = fusion(c.comp, s.groupes)
    } else cycles.push({ semaines: [s], comp: fusion([], s.groupes) })
  }
  return cycles
}

/** A week that shows its cycle's pairs in full. An incomplete one (someone
 *  missing) counts in the rotation but says nothing of the hours: they were
 *  arranged for that week only. */
const estComplete = (s: SemaineVue, c: Cycle) => cleDe(s.groupes) === cleDe(c.comp)

/** What the grid must show when nothing asks otherwise (no instruction, no
 *  desiderata), or null where the history does not decide. Names are prénoms. */
export interface Attendu {
  /** Who shares a team this week. */
  binomes: string[][] | null
  /** Each one's hours for the week (« 05:00-12:00 »). */
  horaires: Map<string, string> | null
}

export interface Roulement {
  /** The rotation as facts, one French line each, for the model. */
  lignes: string[]
  attendu: Attendu
  /** What Isa must know of a choice the facts made for her (added to « attention »). */
  attention: string[]
}

/** The rotation as facts, so the model never has to count: the last worked
 *  week's teams, how many worked weeks in a row the same pairs have held
 *  (holidays skipped, a week with someone missing counted), whether a
 *  recomposition is due, the pairings of the cycles before, and each pair's
 *  team and start hours for the week. */
export function roulement(entries: readonly Creneau[], bonnetiers: readonly BonnetierPlanning[], dimanches: readonly string[]): Roulement {
  const semaines: SemaineVue[] = dimanches
    .map((dim) => {
      const jours = new Set(Array.from({ length: 7 }, (_, i) => addDays(dim, i)))
      const equipes = equipesDeLaSemaine(entries.filter((e) => jours.has(e.date)), bonnetiers)
      return { dim, equipes, groupes: equipes.map((g) => g.membres.map((m) => m.prenom).sort(parNom)) }
    })
    .filter((s) => s.equipes.length > 0)
  const rien: Attendu = { binomes: null, horaires: null }
  if (semaines.length === 0) return { lignes: ['Aucune semaine travaillée dans l’historique : pas de roulement à continuer.'], attendu: rien, attention: [] }

  const cycles = cyclesDe(semaines)
  const derniere = semaines[semaines.length - 1]
  const cours = cycles[cycles.length - 1]
  const n = cours.semaines.length
  const recomposer = n >= SEMAINES_PAR_CYCLE
  const plage = (c: Cycle) => (c.semaines.length === 1 ? S(c.semaines[0].dim) : `${S(c.semaines[0].dim)} à ${S(c.semaines[c.semaines.length - 1].dim)}`)
  const sans = (s: SemaineVue) => cours.comp.flat().filter((p) => !s.groupes.flat().includes(p)).join(', ')
  const incompletes = cours.semaines.filter((s) => !estComplete(s, cours))
  const dont = incompletes.length ? `, dont ${incompletes.map((s) => `${S(s.dim)} sans ${sans(s)}`).join(' et ')}` : ''

  const lignes = [
    `Régime de la dernière semaine travaillée : ${regimeDe(entries.filter((e) => e.date >= derniere.dim && e.date <= addDays(derniere.dim, 6)))} — à garder sauf consigne d’Isabelle.`,
    `Dernière semaine travaillée : ${S(derniere.dim)} — ${derniere.equipes.map((g) => `${EQUIPE_LIBELLE[g.equipe]} : ${g.membres.map((m) => `${m.prenom} ${m.horaire}`).join(', ')}`).join(' · ')}.` +
      (estComplete(derniere, cours) ? '' : ` Semaine incomplète (sans ${sans(derniere)}) : elle ne change pas les binômes.`),
    recomposer
      ? `Binômes ${binomesDe(cours.comp)} : ensemble depuis ${n} semaines travaillées (${plage(cours)}${dont}) — le cycle de ${SEMAINES_PAR_CYCLE} semaines est fini, les binômes sont à recomposer cette semaine.`
      : `Binômes ${binomesDe(cours.comp)} : ensemble depuis ${n} semaine${n > 1 ? 's' : ''} travaillée${n > 1 ? 's' : ''} (${plage(cours)}${dont}) — ils restent ensemble cette semaine (cycle de ${SEMAINES_PAR_CYCLE} semaines) et changent d’équipe.`,
  ]
  const attendu: Attendu = { binomes: recomposer ? null : cours.comp, horaires: null }
  const attention: string[] = []
  if (recomposer) {
    // Every pair of the cycle's bonnetiers, by the last week they shared a team.
    const noms = cours.comp.flat().sort(parNom)
    const paires: Array<{ a: string; b: string; txt: string; derniere: number }> = []
    for (let i = 0; i < noms.length; i++) {
      for (let j = i + 1; j < noms.length; j++) {
        let derniereFois = -1
        semaines.forEach((s, k) => {
          if (s.groupes.some((g) => g.includes(noms[i]) && g.includes(noms[j]))) derniereFois = k
        })
        paires.push({ a: noms[i], b: noms[j], txt: `${noms[i]} + ${noms[j]}`, derniere: derniereFois })
      }
    }
    paires.sort((a, b) => a.derniere - b.derniere)
    const jamais = paires.filter((p) => p.derniere < 0)
    const prioritaires = jamais.length ? jamais : paires.slice(0, Math.max(1, Math.floor(noms.length / 2)))
    lignes.push(
      jamais.length
        ? `Binômes qui n’ont pas travaillé ensemble dans l’historique (à former en priorité) : ${jamais.map((p) => p.txt).join(', ')}.`
        : `Binômes les moins récents (à former en priorité) : ${prioritaires.map((p) => `${p.txt} (${S(semaines[p.derniere].dim)})`).join(', ')}.`,
    )
    // Expected only when they make one whole composition (each bonnetier in exactly one pair).
    const vus = prioritaires.flatMap((p) => [p.a, p.b])
    if (vus.length === noms.length && new Set(vus).size === noms.length) attendu.binomes = prioritaires.map((p) => [p.a, p.b])
    // Whether a week with someone missing counts in the cycle is not settled
    // (no precedent before S49, 2026): it counts, and Isa is told.
    if (n - incompletes.length < SEMAINES_PAR_CYCLE) {
      attention.push(`Je compte ${incompletes.map((s) => `${S(s.dim)} (sans ${sans(s)})`).join(' et ')} dans les ${SEMAINES_PAR_CYCLE} semaines du cycle, donc je recompose les binômes cette semaine. Si elle ne compte pas, garde ${binomesDe(cours.comp)} une semaine de plus.`)
    }
  }
  const avant = cycles.slice(0, -1).reverse()
  if (avant.length) lignes.push(`Binômes des cycles précédents (du plus récent au plus ancien) : ${avant.map((c) => `${plage(c)} : ${binomesDe(c.comp)}`).join(' ; ')}.`)
  const h = faitsDesHoraires(cycles, derniere, recomposer)
  lignes.push(...h.lignes)
  if (!recomposer) attendu.horaires = h.horaires
  return { lignes, attendu, attention }
}

export const faitsDuRoulement = (entries: readonly Creneau[], bonnetiers: readonly BonnetierPlanning[], dimanches: readonly string[]): string[] => roulement(entries, bonnetiers, dimanches).lignes

/** The team a pair takes the week after: Matin ↔ Après-midi, or Matin → Nuit →
 *  Après-midi → Matin when a night runs. */
function equipeSuivante(e: Equipe, avecNuit: boolean): Equipe {
  if (!avecNuit) return e === 'M' ? 'A' : 'M'
  return e === 'M' ? 'N' : e === 'N' ? 'A' : 'M'
}

/** Each pair's team and who starts first (Isa's retours of 28/10 and 25/11/2026,
 *  checked on S27–S50): in a team, one starts an hour after the other, and each
 *  time a pair comes back to a team they swap, so it is never the same one who
 *  finishes late. Held pairs get their team and exact hours: the rotation goes
 *  on from the last complete week of the cycle as if every week since had been
 *  a normal one, and the hours are the swap of the last complete week the pair
 *  shared that team (else who started first the last time each was in it).
 *  Recomposed pairs get each one's last start per team. Incomplete weeks are
 *  never read for hours. A team where both start at the same hour (8 h days)
 *  says nothing. */
function faitsDesHoraires(cycles: readonly Cycle[], derniere: SemaineVue, recomposer: boolean): { lignes: string[]; horaires: Map<string, string> | null } {
  const cours = cycles[cycles.length - 1]
  const completes = cycles.flatMap((c) => c.semaines.filter((s) => estComplete(s, c)))
  const reference = [...cours.semaines].reverse().find((s) => estComplete(s, cours)) ?? null
  // Before the cycle's first complete week (it opened with someone missing): the last week as it is.
  const base = reference ?? derniere
  const decales = base.equipes.filter((g) => g.membres.length === 2 && g.membres[0].horaire !== g.membres[1].horaire)
  if (decales.length === 0) return { lignes: [], horaires: null }
  /** The member's horaire the last complete week they were in `equipe`, newest first. */
  const derniereFois = (prenom: string, equipe: Equipe) => {
    for (let k = completes.length - 1; k >= 0; k--) {
      const m = completes[k].equipes.find((g) => g.equipe === equipe)?.membres.find((x) => x.prenom === prenom)
      if (m) return { horaire: m.horaire, dim: completes[k].dim }
    }
    return null
  }
  const regle = 'dans un binôme l’un commence une heure après l’autre et chacun garde son horaire toute la semaine ; quand le binôme revient dans la même équipe, ils échangent, pour que ce ne soit pas toujours le même qui finisse tard'

  if (recomposer) {
    const noms = cours.comp.flat().sort(parNom)
    const parNomTxt = noms.map((nom) => {
      const xs = (['M', 'A', 'N'] as const).map((e) => ({ e, d: derniereFois(nom, e) })).filter((x) => x.d)
      return `${nom} : ${xs.map((x) => `${EQUIPE_LIBELLE[x.e]} ${x.d!.horaire} (${S(x.d!.dim)})`).join(', ')}`
    })
    return { lignes: [`Heures de début (${regle}) : dans un nouveau binôme, celui qui commençait le plus tôt la dernière fois dans cette équipe commence une heure après l’autre. Dernière fois de chacun par équipe : ${parNomTxt.join(' · ')}.`], horaires: null }
  }

  const avecNuit = base.equipes.some((g) => g.equipe === 'N')
  // Weeks from `base` to the week being planned: 1 when `base` is last week.
  const pas = cours.semaines.length - cours.semaines.indexOf(base)
  const duCycle = cours.semaines.filter((s) => estComplete(s, cours))
  const horaires = new Map<string, string>()
  let tousConnus = decales.length === base.equipes.length
  const faits: string[] = []
  for (const g of decales) {
    let cible = g.equipe
    for (let i = 0; i < pas; i++) cible = equipeSuivante(cible, avecNuit)
    const [a, b] = g.membres.map((m) => m.prenom).sort(parNom)
    let fait: string | null = null
    for (let k = duCycle.length - 1; k >= 0 && !fait; k--) {
      const eq = duCycle[k].equipes.find((x) => x.equipe === cible)
      const ma = eq?.membres.find((m) => m.prenom === a)
      const mb = eq?.membres.find((m) => m.prenom === b)
      if (ma && mb && ma.horaire !== mb.horaire) {
        horaires.set(a, mb.horaire).set(b, ma.horaire)
        fait = `${a} + ${b} en ${EQUIPE_LIBELLE[cible]} : ${a} ${mb.horaire}, ${b} ${ma.horaire} (l’inverse de ${S(duCycle[k].dim)}, où ${a} faisait ${ma.horaire} et ${b} ${mb.horaire}).`
      }
    }
    if (!fait) {
      const da = derniereFois(a, cible)
      const db = derniereFois(b, cible)
      if (da && db && da.horaire !== db.horaire) {
        const [tot, tard] = da.horaire < db.horaire ? [a, b] : [b, a]
        const [hTot, hTard] = [da.horaire, db.horaire].sort()
        horaires.set(tard, hTot).set(tot, hTard)
        fait = `${a} + ${b} en ${EQUIPE_LIBELLE[cible]} : ${tard} ${hTot}, ${tot} ${hTard} (la dernière fois en ${EQUIPE_LIBELLE[cible].toLowerCase()}, ${a} faisait ${da.horaire} en ${S(da.dim)} et ${b} ${db.horaire} en ${S(db.dim)} : ${tot} commençait le plus tôt).`
      } else {
        tousConnus = false
        fait = `${a} + ${b} en ${EQUIPE_LIBELLE[cible]} : l’historique ne dit pas qui doit commencer le plus tôt : choisis et signale-le dans « attention ».`
      }
    }
    faits.push(fait)
  }
  const reprise = reference && reference !== derniere ? `le roulement continue depuis ${S(reference.dim)} comme si ${cours.semaines.slice(cours.semaines.indexOf(reference) + 1).map((s) => S(s.dim)).join(' et ')} avait été une semaine normale. ` : ''
  return { lignes: [`Heures de début de cette semaine (${regle}) : ${reprise}${faits.join(' ')}`], horaires: tousConnus ? horaires : null }
}

/** One thing a grid proposed without any instruction gets wrong: what the
 *  model is told when the grid goes back to it, and what Isa reads if the
 *  second answer still has it. */
export interface Reproche { relance: string; attention: string }

/** What a grid proposed WITHOUT instruction gets wrong against the rotation.
 *  `regimeAvant`: the last worked week's régime (null without history).
 *  `desiderata`: the prénoms who asked something this week. One's own hours may
 *  move for it, and a desiderata may move a team: the pairs and the hours are
 *  only checked on a week without any. */
export function reproches(
  creneaux: readonly Creneau[],
  bonnetiers: readonly BonnetierPlanning[],
  p: { regimeAvant: string | null; attendu: Attendu; desiderata: readonly string[] },
): Reproche[] {
  const out: Reproche[] = []
  if (p.regimeAvant && regimeDe(creneaux) !== p.regimeAvant) {
    out.push({
      relance: `ta réponse passait en « ${regimeDe(creneaux)} » : garde le régime « ${p.regimeAvant} ».`,
      attention: `Sans consigne, j’ai quand même changé le régime (« ${regimeDe(creneaux)} » au lieu de « ${p.regimeAvant} ») : vérifie que c’est voulu.`,
    })
  }
  // One's hours hold for the whole week (Isa's retour on S47, 04/11/2026).
  for (const b of bonnetiers) {
    if (p.desiderata.includes(b.prenom)) continue
    const siens = [...new Set(creneaux.filter((c) => c.IDbonnetier === b.id).map((c) => `${c.debut}-${c.fin}`))].sort()
    if (siens.length > 1) {
      out.push({
        relance: `${b.prenom} a des horaires différents selon les jours (${siens.join(', ')}) : chacun garde le même horaire du lundi au vendredi.`,
        attention: `${b.prenom} n’a pas le même horaire toute la semaine (${siens.join(', ')}) : vérifie que c’est voulu.`,
      })
    }
  }
  if (p.desiderata.length > 0) return out
  const equipes = equipesDeLaSemaine(creneaux, bonnetiers)
  const groupes = equipes.map((g) => g.membres.map((m) => m.prenom))
  if (p.attendu.binomes && cleDe(groupes) !== cleDe(p.attendu.binomes)) {
    out.push({
      relance: `ta grille met ensemble ${binomesDe(groupes)} alors que « Où en est le roulement » demande ${binomesDe(p.attendu.binomes)}.`,
      attention: `Mes équipes (${binomesDe(groupes)}) ne sont pas les binômes du roulement (${binomesDe(p.attendu.binomes)}) : vérifie que c’est voulu.`,
    })
  } else if (p.attendu.horaires) {
    const faux = equipes.flatMap((g) => g.membres).filter((m) => p.attendu.horaires!.has(m.prenom) && p.attendu.horaires!.get(m.prenom) !== m.horaire)
    if (faux.length) {
      out.push({
        relance: `${faux.map((m) => `${m.prenom} est en ${m.horaire} au lieu de ${p.attendu.horaires!.get(m.prenom)}`).join(', ')} : suis la ligne « Heures de début de cette semaine ».`,
        attention: `Je n’ai pas suivi le roulement pour ${faux.map((m) => `${m.prenom} (${m.horaire} au lieu de ${p.attendu.horaires!.get(m.prenom)})`).join(', ')} : vérifie que c’est voulu.`,
      })
    }
  }
  return out
}

// ── The model's answer ───────────────────────────────────

export const PLANNING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['raisonnement', 'creneaux', 'explication', 'attention'],
  properties: {
    /** Written first: the model works the rotation out before the grid. Kept on the run, never shown to Isa. */
    raisonnement: { type: 'string' },
    creneaux: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['IDbonnetier', 'jour', 'debut', 'fin'],
        properties: {
          IDbonnetier: { type: 'integer' },
          /** 0 = dimanche … 6 = samedi, in the planned week. */
          jour: { type: 'integer' },
          debut: { type: 'string' },
          fin: { type: 'string' },
        },
      },
    },
    explication: { type: 'string' },
    attention: { type: 'array', items: { type: 'string' } },
  },
} as const

export interface ReponsePlanning {
  raisonnement: string
  creneaux: Array<{ IDbonnetier: number; jour: number; debut: string; fin: string }>
  explication: string
  attention: string[]
}

const HEURE_QUART = /^([01]\d|2[0-3]):(00|15|30|45)$/

/** Keep what can be written: a known bonnetier, a day of the week, quarter-hour
 *  times, a shift of 4 to 10 hours, one shift per bonnetier and day. Everything
 *  else is dropped and said (`rejets`). */
export function validerReponse(
  brut: unknown,
  dimanche: string,
  bonnetiers: readonly BonnetierPlanning[],
): { creneaux: Creneau[]; raisonnement: string; explication: string; attention: string[]; rejets: string[] } {
  const r = (brut ?? {}) as Partial<ReponsePlanning>
  const ids = new Map(bonnetiers.map((b) => [b.id, b.prenom]))
  const creneaux: Creneau[] = []
  const rejets: string[] = []
  const vus = new Set<string>()
  for (const c of Array.isArray(r.creneaux) ? r.creneaux : []) {
    const nom = ids.get(Number(c?.IDbonnetier))
    const jour = Number(c?.jour)
    const quoi = `${nom ?? `bonnetier #${c?.IDbonnetier}`} jour ${c?.jour} ${c?.debut}-${c?.fin}`
    if (!nom) { rejets.push(`${quoi} : bonnetier inconnu`); continue }
    if (!Number.isInteger(jour) || jour < 0 || jour > 6) { rejets.push(`${quoi} : jour hors de la semaine`); continue }
    if (!HEURE_QUART.test(String(c.debut)) || !HEURE_QUART.test(String(c.fin))) { rejets.push(`${quoi} : heure invalide`); continue }
    const duree = ((toMin(c.fin) - toMin(c.debut) + 1440) % 1440) || 1440
    if (duree < 240 || duree > 600) { rejets.push(`${quoi} : durée de ${Math.round(duree / 6) / 10} h`); continue }
    const date = addDays(dimanche, jour)
    const cle = `${c.IDbonnetier}|${date}`
    if (vus.has(cle)) { rejets.push(`${quoi} : deuxième créneau le même jour`); continue }
    vus.add(cle)
    creneaux.push({ IDbonnetier: Number(c.IDbonnetier), date, debut: c.debut, fin: c.fin })
  }
  creneaux.sort((a, b) => a.IDbonnetier - b.IDbonnetier || a.date.localeCompare(b.date))
  return {
    creneaux,
    raisonnement: String(r.raisonnement ?? '').trim(),
    explication: String(r.explication ?? '').trim(),
    attention: (Array.isArray(r.attention) ? r.attention : []).map((x) => String(x).trim()).filter(Boolean),
    rejets,
  }
}

function toMin(t: string): number {
  return parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10)
}

// ── Isa's retour ─────────────────────────────────────────

const decrit = (c: Pick<Creneau, 'debut' | 'fin'>) => `${EQUIPE_LIBELLE[equipeDe(c.debut)]} ${c.debut}-${c.fin}`

/** What changed between what Tricobot wrote and the week as it stands, one
 *  French line each (« Anaïs lun. 17/11 : Matin 05:00-12:00 → Après-midi
 *  13:00-20:00 »). Empty = Isa kept Tricobot's week. Only the bonnetiers of
 *  `bonnetiers` count (the grid's rows: a hidden or archived one is not a
 *  correction). */
export function ecarts(propose: readonly Creneau[], actuel: readonly Creneau[], bonnetiers: readonly BonnetierPlanning[]): string[] {
  const noms = new Map(bonnetiers.map((b) => [b.id, b.prenom]))
  const parCle = (xs: readonly Creneau[]) => new Map(xs.filter((c) => noms.has(c.IDbonnetier)).map((c) => [`${c.IDbonnetier}|${c.date}`, c]))
  const avant = parCle(propose)
  const apres = parCle(actuel)
  const cles = [...new Set([...avant.keys(), ...apres.keys()])].sort((x, y) => {
    const [bx, dx] = x.split('|')
    const [by, dy] = y.split('|')
    return (noms.get(Number(bx)) ?? '').localeCompare(noms.get(Number(by)) ?? '', 'fr') || dx.localeCompare(dy)
  })
  const lignes: string[] = []
  for (const cle of cles) {
    const a = avant.get(cle)
    const b = apres.get(cle)
    const [id, date] = cle.split('|')
    const qui = `${noms.get(Number(id))} ${jourCourt(date)}`
    if (a && b) {
      if (a.debut !== b.debut || a.fin !== b.fin) lignes.push(`${qui} : ${decrit(a)} → ${decrit(b)}`)
    } else if (a) lignes.push(`${qui} : ${decrit(a)} → retiré`)
    else if (b) lignes.push(`${qui} : ajouté ${decrit(b)}`)
  }
  return lignes
}
