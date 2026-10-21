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

/** The rotation as facts, so the model never has to count: the last worked
 *  week's teams, how many worked weeks in a row the same pairs have held
 *  (holidays skipped), whether a recomposition is due, and the pairings of the
 *  cycles before. A « pairing » is the week's teams as sets of names, shift
 *  labels ignored (the pairs swap shifts every week). */
export function faitsDuRoulement(entries: readonly Creneau[], bonnetiers: readonly BonnetierPlanning[], dimanches: readonly string[]): string[] {
  const semaines = dimanches
    .map((dim) => {
      const jours = new Set(Array.from({ length: 7 }, (_, i) => addDays(dim, i)))
      const equipes = equipesDeLaSemaine(entries.filter((e) => jours.has(e.date)), bonnetiers)
      const groupes = equipes.map((g) => g.membres.map((m) => m.prenom).sort((a, b) => a.localeCompare(b, 'fr')))
      return { dim, equipes, cle: groupes.map((g) => g.join(' + ')).sort().join(' / '), binomes: groupes.map((g) => g.join(' + ')).sort().join(', ') }
    })
    .filter((s) => s.equipes.length > 0)
  if (semaines.length === 0) return ['Aucune semaine travaillée dans l’historique : pas de roulement à continuer.']
  // Runs of identical pairings, oldest first.
  const cycles: Array<{ du: string; au: string; n: number; binomes: string; cle: string }> = []
  for (const s of semaines) {
    const c = cycles[cycles.length - 1]
    if (c && c.cle === s.cle) { c.au = s.dim; c.n++ } else cycles.push({ du: s.dim, au: s.dim, n: 1, binomes: s.binomes, cle: s.cle })
  }
  const derniere = semaines[semaines.length - 1]
  const cours = cycles[cycles.length - 1]
  const plage = (c: { du: string; au: string }) => (c.du === c.au ? `S${semaineIso(c.du)}` : `S${semaineIso(c.du)} à S${semaineIso(c.au)}`)
  const lignes = [
    `Régime de la dernière semaine travaillée : ${regimeDe(entries.filter((e) => e.date >= derniere.dim && e.date <= addDays(derniere.dim, 6)))} — à garder sauf consigne d’Isabelle.`,
    `Dernière semaine travaillée : S${semaineIso(derniere.dim)} — ${derniere.equipes.map((g) => `${EQUIPE_LIBELLE[g.equipe]} : ${g.membres.map((m) => `${m.prenom} ${m.horaire}`).join(', ')}`).join(' · ')}.`,
    cours.n >= SEMAINES_PAR_CYCLE
      ? `Binômes ${cours.binomes} : ensemble depuis ${cours.n} semaines travaillées (${plage(cours)}) — le cycle de ${SEMAINES_PAR_CYCLE} semaines est fini, les binômes sont à recomposer cette semaine.`
      : `Binômes ${cours.binomes} : ensemble depuis ${cours.n} semaine${cours.n > 1 ? 's' : ''} travaillée${cours.n > 1 ? 's' : ''} (${plage(cours)}) — ils restent ensemble cette semaine (cycle de ${SEMAINES_PAR_CYCLE} semaines) et changent d’équipe.`,
  ]
  if (cours.n >= SEMAINES_PAR_CYCLE) {
    // Every pair of last week's bonnetiers, by the last week they shared a team.
    const noms = derniere.equipes.flatMap((g) => g.membres.map((m) => m.prenom)).sort((a, b) => a.localeCompare(b, 'fr'))
    const paires: Array<{ txt: string; derniere: number }> = []
    for (let i = 0; i < noms.length; i++) {
      for (let j = i + 1; j < noms.length; j++) {
        let derniereFois = -1
        semaines.forEach((s, k) => {
          if (s.equipes.some((g) => g.membres.some((m) => m.prenom === noms[i]) && g.membres.some((m) => m.prenom === noms[j]))) derniereFois = k
        })
        paires.push({ txt: `${noms[i]} + ${noms[j]}`, derniere: derniereFois })
      }
    }
    paires.sort((a, b) => a.derniere - b.derniere)
    const jamais = paires.filter((p) => p.derniere < 0)
    lignes.push(
      jamais.length
        ? `Binômes qui n’ont pas travaillé ensemble dans l’historique (à former en priorité) : ${jamais.map((p) => p.txt).join(', ')}.`
        : `Binômes les moins récents (à former en priorité) : ${paires.slice(0, Math.max(1, Math.floor(noms.length / 2))).map((p) => `${p.txt} (S${semaineIso(semaines[p.derniere].dim)})`).join(', ')}.`,
    )
  }
  const avant = cycles.slice(0, -1).reverse()
  if (avant.length) lignes.push(`Binômes des cycles précédents (du plus récent au plus ancien) : ${avant.map((c) => `${plage(c)} : ${c.binomes}`).join(' ; ')}.`)
  return lignes
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
