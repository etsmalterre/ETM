import { describe, expect, it } from 'vitest'
import { addDays } from '../../planning-bonnetier.js'
import { ecarts, equipeDe, equipesDeLaSemaine, faitsDuRoulement, regimeDe, reproches, roulement, estDimanche, historiqueTexte, semaineIso, validerReponse, type Creneau } from './regles.js'

const B = [
  { id: 22, prenom: 'Anaïs', nom: 'Lagache' },
  { id: 24, prenom: 'Angélique', nom: 'Lhuillier' },
]
const DIM = '2026-11-15' // grid week S47 (Monday 16/11)

describe('equipeDe', () => {
  it('splits on the start hour like the screen', () => {
    expect(equipeDe('05:00')).toBe('M')
    expect(equipeDe('06:00')).toBe('M')
    expect(equipeDe('13:00')).toBe('A')
    expect(equipeDe('14:00')).toBe('A')
    expect(equipeDe('21:00')).toBe('N')
  })
})

describe('semaine', () => {
  it('numbers the grid week by its Monday', () => {
    expect(semaineIso(DIM)).toBe(47)
    // 2026-01-04 is a Sunday: its grid week is ISO week 2 (LIVA #1166).
    expect(semaineIso('2026-01-04')).toBe(2)
  })
  it('accepts only a Sunday', () => {
    expect(estDimanche(DIM)).toBe(true)
    expect(estDimanche('2026-11-16')).toBe(false)
    expect(estDimanche('nope')).toBe(false)
  })
})

describe('historiqueTexte', () => {
  it('groups the days of a week and says an empty week', () => {
    const entries: Creneau[] = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map((date) => ({ IDbonnetier: 22, date, debut: '05:00', fin: '12:00' }))
    entries.push({ IDbonnetier: 24, date: '2026-11-02', debut: '13:00', fin: '20:00' }, { IDbonnetier: 24, date: '2026-11-03', debut: '13:00', fin: '20:00' }, { IDbonnetier: 24, date: '2026-11-04', debut: '05:00', fin: '12:00' })
    const t = historiqueTexte(entries, B, ['2026-11-01', '2026-11-08'])
    expect(t.split('\n')).toEqual([
      'S45 (du dim. 01/11) — Matin : Anaïs 05:00-12:00 · Après-midi : Angélique 13:00-20:00 (3 j)',
      '    sauf Angélique mer. 04/11 : Matin 05:00-12:00',
      'S46 (du dim. 08/11) : aucun créneau (semaine non travaillée)',
    ])
  })
})

describe('validerReponse', () => {
  it('keeps valid créneaux, drops the rest with a reason', () => {
    const v = validerReponse(
      {
        creneaux: [
          { IDbonnetier: 22, jour: 1, debut: '05:00', fin: '12:00' },
          { IDbonnetier: 22, jour: 1, debut: '13:00', fin: '20:00' }, // second the same day
          { IDbonnetier: 99, jour: 2, debut: '05:00', fin: '12:00' }, // unknown
          { IDbonnetier: 24, jour: 7, debut: '05:00', fin: '12:00' }, // out of the week
          { IDbonnetier: 24, jour: 2, debut: '05:10', fin: '12:00' }, // not a quarter
          { IDbonnetier: 24, jour: 3, debut: '05:00', fin: '07:00' }, // 2 h
          { IDbonnetier: 24, jour: 1, debut: '21:00', fin: '05:00' }, // night: 8 h over midnight
        ],
        explication: ' ok ',
        attention: ['', 'Vérifie mardi'],
      },
      DIM,
      B,
    )
    expect(v.creneaux).toEqual([
      { IDbonnetier: 22, date: '2026-11-16', debut: '05:00', fin: '12:00' },
      { IDbonnetier: 24, date: '2026-11-16', debut: '21:00', fin: '05:00' },
    ])
    expect(v.rejets).toHaveLength(5)
    expect(v.explication).toBe('ok')
    expect(v.attention).toEqual(['Vérifie mardi'])
  })
  it('survives garbage', () => {
    expect(validerReponse(null, DIM, B).creneaux).toEqual([])
  })
})

describe('ecarts', () => {
  const propose: Creneau[] = [
    { IDbonnetier: 22, date: '2026-11-16', debut: '05:00', fin: '12:00' },
    { IDbonnetier: 22, date: '2026-11-17', debut: '05:00', fin: '12:00' },
    { IDbonnetier: 24, date: '2026-11-16', debut: '13:00', fin: '20:00' },
  ]
  it('is empty when the week was kept', () => {
    expect(ecarts(propose, [...propose].reverse(), B)).toEqual([])
  })
  it('lists changed, removed and added créneaux', () => {
    const actuel: Creneau[] = [
      { IDbonnetier: 22, date: '2026-11-16', debut: '13:00', fin: '20:00' },
      { IDbonnetier: 24, date: '2026-11-16', debut: '13:00', fin: '20:00' },
      { IDbonnetier: 24, date: '2026-11-18', debut: '14:00', fin: '21:00' },
      { IDbonnetier: 7, date: '2026-11-18', debut: '14:00', fin: '21:00' }, // not a grid row
    ]
    expect(ecarts(propose, actuel, B)).toEqual([
      'Anaïs lun. 16/11 : Matin 05:00-12:00 → Après-midi 13:00-20:00',
      'Anaïs mar. 17/11 : Matin 05:00-12:00 → retiré',
      'Angélique mer. 18/11 : ajouté Après-midi 14:00-21:00',
    ])
  })
})

describe('equipesDeLaSemaine', () => {
  it('groups the bonnetiers by their main shift, earliest first', () => {
    const c: Creneau[] = [
      { IDbonnetier: 24, date: '2026-11-16', debut: '06:00', fin: '13:00' },
      { IDbonnetier: 22, date: '2026-11-16', debut: '05:00', fin: '12:00' },
    ]
    expect(equipesDeLaSemaine(c, B)).toEqual([
      { equipe: 'M', membres: [{ prenom: 'Anaïs', horaire: '05:00-12:00', jours: 1 }, { prenom: 'Angélique', horaire: '06:00-13:00', jours: 1 }] },
    ])
  })
})

describe('faitsDuRoulement', () => {
  // S35–S38 {Ang, Dau}{Ana, Mar}, S39–S42 {Ang, Ana}{Dau, Mar} — the real 2026 autumn.
  const Q = [
    { id: 22, prenom: 'Anaïs', nom: '' },
    { id: 24, prenom: 'Angélique', nom: '' },
    { id: 28, prenom: 'Daunovan', nom: '' },
    { id: 30, prenom: 'Marie', nom: '' },
  ]
  const semaine = (dim: string, matin: number[], am: number[]): Creneau[] =>
    [1, 2, 3, 4, 5].flatMap((i) => [
      ...matin.map((id, k) => ({ IDbonnetier: id, date: addDays(dim, i), debut: k ? '06:00' : '05:00', fin: k ? '13:00' : '12:00' })),
      ...am.map((id, k) => ({ IDbonnetier: id, date: addDays(dim, i), debut: k ? '14:00' : '13:00', fin: k ? '21:00' : '20:00' })),
    ])
  const dims = ['2026-08-23', '2026-08-30', '2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27', '2026-10-04', '2026-10-11']
  const histo = [
    ...semaine(dims[0], [24, 28], [22, 30]), ...semaine(dims[1], [22, 30], [24, 28]),
    ...semaine(dims[2], [24, 28], [22, 30]), ...semaine(dims[3], [22, 30], [24, 28]),
    ...semaine(dims[4], [28, 30], [24, 22]), ...semaine(dims[5], [24, 22], [28, 30]),
    ...semaine(dims[6], [28, 30], [24, 22]), ...semaine(dims[7], [24, 22], [28, 30]),
  ]
  it('says the cycle is over and which pairs never worked together', () => {
    const f = faitsDuRoulement(histo, Q, dims)
    expect(f[0]).toBe('Régime de la dernière semaine travaillée : 2 équipes (Matin, Après-midi), journées de 7 h — à garder sauf consigne d’Isabelle.')
    expect(f[1]).toContain('Dernière semaine travaillée : S42')
    expect(f[2]).toContain('ensemble depuis 4 semaines travaillées (S39 à S42)')
    expect(f[2]).toContain('à recomposer')
    expect(f[3]).toBe('Binômes qui n’ont pas travaillé ensemble dans l’historique (à former en priorité) : Anaïs + Daunovan, Angélique + Marie.')
    expect(f[4]).toContain('S35 à S38 : Anaïs + Marie, Angélique + Daunovan')
  })
  it('keeps the pairs mid-cycle, holidays skipped', () => {
    const f = faitsDuRoulement(histo.filter((c) => c.date < '2026-09-27'), Q, [...dims.slice(0, 5), '2026-09-27'])
    expect(f[2]).toContain('ensemble depuis 1 semaine travaillée (S39)')
    expect(f[2]).toContain('restent ensemble')
  })

  // Start hours (Isa's retour on S46, 28/10/2026): each [id, start] of a week, 7 h days.
  const heures = (dim: string, xs: Array<[number, string]>): Creneau[] =>
    [1, 2, 3, 4, 5].flatMap((i) => xs.map(([id, debut]) => ({ IDbonnetier: id, date: addDays(dim, i), debut, fin: `${String(parseInt(debut, 10) + 7).padStart(2, '0')}:00` })))
  const s41 = heures('2026-10-04', [[22, '14:00'], [24, '13:00'], [28, '05:00'], [30, '06:00']])
  const s42 = heures('2026-10-11', [[22, '05:00'], [24, '06:00'], [28, '14:00'], [30, '13:00']])
  const s43 = heures('2026-10-18', [[22, '05:00'], [28, '06:00'], [24, '13:00'], [30, '14:00']])
  const s44 = heures('2026-10-25', [[22, '13:00'], [28, '14:00'], [24, '06:00'], [30, '05:00']])
  const s45 = heures('2026-11-01', [[22, '06:00'], [28, '05:00'], [24, '13:00'], [30, '14:00']])
  const horaires = (f: string[]) => f.find((l) => l.startsWith('Heures de début'))
  it('swaps the start hours of a held pair against the last week it shared the team (S46)', () => {
    const l = horaires(faitsDuRoulement([...s41, ...s42, ...s43, ...s44, ...s45], Q, ['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01']))
    expect(l).toContain('Anaïs + Daunovan en Après-midi : Anaïs 14:00-21:00, Daunovan 13:00-20:00 (l’inverse de S44')
    expect(l).toContain('Angélique + Marie en Matin : Angélique 05:00-12:00, Marie 06:00-13:00 (l’inverse de S44')
  })
  it('falls back on who started first the last time each was in the team', () => {
    // S44 is the cycle's second week: the pairs have not shared their next team yet.
    const l = horaires(faitsDuRoulement([...s41, ...s42, ...s43], Q, ['2026-10-04', '2026-10-11', '2026-10-18']))
    // Afternoon: Anaïs 14:00 in S41, Daunovan 14:00 in S42 → a tie, Isa decides.
    expect(l).toContain('Anaïs + Daunovan en Après-midi : l’historique ne dit pas')
    // Morning: Angélique 06:00 in S42, Marie 06:00 in S41 → a tie too.
    expect(l).toContain('Angélique + Marie en Matin : l’historique ne dit pas')
    // Daunovan 13:00 in S42 instead: he started first, so Anaïs does now.
    const s42b = heures('2026-10-11', [[22, '05:00'], [24, '06:00'], [28, '13:00'], [30, '14:00']])
    const m = horaires(faitsDuRoulement([...s41, ...s42b, ...s43], Q, ['2026-10-04', '2026-10-11', '2026-10-18']))
    expect(m).toContain('Anaïs + Daunovan en Après-midi : Anaïs 13:00-20:00, Daunovan 14:00-21:00 (la dernière fois en après-midi, Anaïs faisait 14:00-21:00 en S41 et Daunovan 13:00-20:00 en S42 : Daunovan commençait le plus tôt).')
  })
  it('gives each one’s last start per team when the pairs are recomposed', () => {
    const l = horaires(faitsDuRoulement([...s42, ...s43, ...s44, ...s45, ...heures('2026-11-08', [[22, '14:00'], [28, '13:00'], [24, '05:00'], [30, '06:00']])], Q, ['2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01', '2026-11-08']))
    expect(l).toContain('Anaïs : Matin 06:00-13:00 (S45), Après-midi 14:00-21:00 (S46)')
  })
  // A week with someone missing (Isa's retour on S50, 25/11/2026): the real S47 to S50.
  // S49: Daunovan on leave, Isa set Angélique 05:00, Anaïs 09:00-16:00, Marie 13:00.
  const s46 = heures('2026-11-08', [[24, '05:00'], [30, '06:00'], [28, '13:00'], [22, '14:00']])
  const s47 = heures('2026-11-15', [[22, '05:00'], [24, '06:00'], [28, '13:00'], [30, '14:00']])
  const s48 = heures('2026-11-22', [[30, '05:00'], [28, '06:00'], [22, '13:00'], [24, '14:00']])
  const s49 = heures('2026-11-29', [[24, '05:00'], [22, '09:00'], [30, '13:00']])
  const s50 = heures('2026-12-06', [[28, '05:00'], [30, '06:00'], [24, '13:00'], [22, '14:00']])
  const D = ['2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29', '2026-12-06']
  it('keeps the pairs over a week with someone missing, and goes on with the rhythm (S50)', () => {
    const r = roulement([...s46, ...s47, ...s48, ...s49], Q, D.slice(0, 4))
    expect(r.lignes[1]).toContain('Semaine incomplète (sans Daunovan) : elle ne change pas les binômes.')
    expect(r.lignes[2]).toContain('Binômes Anaïs + Angélique, Daunovan + Marie : ensemble depuis 3 semaines travaillées (S47 à S49, dont S49 sans Daunovan)')
    expect(r.lignes[2]).toContain('restent ensemble')
    const l = horaires(r.lignes)
    // What Isa kept: the swap of S48, never the hours she set for S49.
    expect(l).toContain('le roulement continue depuis S48 comme si S49 avait été une semaine normale.')
    expect(l).toContain('Daunovan + Marie en Matin : Daunovan 05:00-12:00, Marie 06:00-13:00 (l’inverse de S48')
    expect(l).toContain('Anaïs + Angélique en Après-midi : Anaïs 14:00-21:00, Angélique 13:00-20:00 (l’inverse de S48')
    expect(r.attendu.binomes).toEqual([['Anaïs', 'Angélique'], ['Daunovan', 'Marie']])
    expect(Object.fromEntries(r.attendu.horaires!)).toEqual({ Daunovan: '05:00-12:00', Marie: '06:00-13:00', Anaïs: '14:00-21:00', Angélique: '13:00-20:00' })
    expect(r.attention).toEqual([])
  })
  it('counts that week in the cycle, says so, and never reads its hours (S51)', () => {
    const r = roulement([...s46, ...s47, ...s48, ...s49, ...s50], Q, D)
    expect(r.lignes[2]).toContain('ensemble depuis 4 semaines travaillées (S47 à S50, dont S49 sans Daunovan)')
    expect(r.lignes[2]).toContain('à recomposer')
    expect(r.lignes[3]).toBe('Binômes qui n’ont pas travaillé ensemble dans l’historique (à former en priorité) : Anaïs + Marie, Angélique + Daunovan.')
    expect(r.attendu.binomes).toEqual([['Anaïs', 'Marie'], ['Angélique', 'Daunovan']])
    expect(r.attendu.horaires).toBeNull()
    expect(r.attention).toEqual(['Je compte S49 (sans Daunovan) dans les 4 semaines du cycle, donc je recompose les binômes cette semaine. Si elle ne compte pas, garde Anaïs + Angélique, Daunovan + Marie une semaine de plus.'])
    expect(horaires(r.lignes)).toContain('Anaïs : Matin 05:00-12:00 (S47), Après-midi 14:00-21:00 (S50)')
    expect(r.lignes.join(' ')).not.toContain('09:00-16:00 (')
  })
  it('opens a new cycle when someone changes partner, missing or not', () => {
    // Daunovan away and Marie put with Anaïs: not the cycle's pairs any more.
    const autre = heures('2026-11-29', [[22, '05:00'], [30, '06:00'], [24, '13:00']])
    const r = roulement([...s47, ...s48, ...autre], Q, D.slice(1, 4))
    expect(r.lignes[2]).toContain('ensemble depuis 1 semaine travaillée (S49)')
  })
  it('says nothing when both start together (8 h days)', () => {
    const c = [1, 2, 3, 4, 5].flatMap((i) => [[22, '05:00', '13:00'], [24, '05:00', '13:00'], [28, '13:00', '21:00'], [30, '13:00', '21:00']].map(([id, debut, fin]) => ({ IDbonnetier: id as number, date: addDays('2026-10-18', i), debut: debut as string, fin: fin as string })))
    expect(horaires(faitsDuRoulement(c, Q, ['2026-10-18']))).toBeUndefined()
  })
})

describe('reproches', () => {
  const Q = [
    { id: 22, prenom: 'Anaïs', nom: '' },
    { id: 24, prenom: 'Angélique', nom: '' },
    { id: 28, prenom: 'Daunovan', nom: '' },
    { id: 30, prenom: 'Marie', nom: '' },
  ]
  const DIM50 = '2026-12-06'
  const grille = (xs: Array<[number, string]>, sauf: Array<[number, number, string]> = []): Creneau[] =>
    [1, 2, 3, 4, 5].flatMap((i) => xs.map(([id, debut]) => {
      const d = sauf.find(([sid, jour]) => sid === id && jour === i)?.[2] ?? debut
      return { IDbonnetier: id, date: addDays(DIM50, i), debut: d, fin: `${String(parseInt(d, 10) + 7).padStart(2, '0')}:00` }
    }))
  const attendu = {
    binomes: [['Anaïs', 'Angélique'], ['Daunovan', 'Marie']],
    horaires: new Map([['Daunovan', '05:00-12:00'], ['Marie', '06:00-13:00'], ['Angélique', '13:00-20:00'], ['Anaïs', '14:00-21:00']]),
  }
  const regimeAvant = '2 équipes (Matin, Après-midi), journées de 7 h'
  const bonne = grille([[28, '05:00'], [30, '06:00'], [24, '13:00'], [22, '14:00']])
  it('has nothing to say of the grid the rotation gives', () => {
    expect(reproches(bonne, Q, { regimeAvant, attendu, desiderata: [] })).toEqual([])
  })
  it('sends back hours that change from a day to the next (Isa on S47)', () => {
    const r = reproches(grille([[28, '05:00'], [30, '06:00'], [24, '13:00'], [22, '14:00']], [[28, 2, '06:00'], [30, 2, '05:00']]), Q, { regimeAvant, attendu, desiderata: [] })
    expect(r.map((x) => x.relance)).toEqual([
      'Daunovan a des horaires différents selon les jours (05:00-12:00, 06:00-13:00) : chacun garde le même horaire du lundi au vendredi.',
      'Marie a des horaires différents selon les jours (05:00-12:00, 06:00-13:00) : chacun garde le même horaire du lundi au vendredi.',
    ])
  })
  it('leaves alone the hours of someone who asked for something that week', () => {
    const c = grille([[28, '05:00'], [30, '06:00'], [24, '13:00'], [22, '14:00']], [[28, 2, '06:00']])
    expect(reproches(c, Q, { regimeAvant, attendu, desiderata: ['Daunovan'] })).toEqual([])
  })
  it('sends back the hours of the rotation given the other way round (Isa on S50)', () => {
    const r = reproches(grille([[30, '05:00'], [28, '06:00'], [24, '13:00'], [22, '14:00']]), Q, { regimeAvant, attendu, desiderata: [] })
    expect(r).toHaveLength(1)
    // In the grid's order: by team, earliest start first.
    expect(r[0].relance).toBe('Marie est en 05:00-12:00 au lieu de 06:00-13:00, Daunovan est en 06:00-13:00 au lieu de 05:00-12:00 : suis la ligne « Heures de début de cette semaine ».')
  })
  it('sends back pairs that are not the rotation’s, and a régime nobody asked for', () => {
    const paires = reproches(grille([[28, '05:00'], [22, '06:00'], [24, '13:00'], [30, '14:00']]), Q, { regimeAvant, attendu, desiderata: [] })
    expect(paires.map((x) => x.relance)).toEqual(['ta grille met ensemble Anaïs + Daunovan, Angélique + Marie alors que « Où en est le roulement » demande Anaïs + Angélique, Daunovan + Marie.'])
    const nuit: Creneau[] = [...bonne.filter((c) => c.IDbonnetier !== 22), ...[1, 2, 3, 4, 5].map((i) => ({ IDbonnetier: 22, date: addDays(DIM50, i), debut: '21:00', fin: '05:00' }))]
    expect(reproches(nuit, Q, { regimeAvant, attendu: { binomes: null, horaires: null }, desiderata: [] })[0].attention).toContain('j’ai quand même changé le régime')
  })
  it('checks neither pairs nor hours where the history does not decide', () => {
    const autre = grille([[28, '05:00'], [22, '06:00'], [24, '13:00'], [30, '14:00']])
    expect(reproches(autre, Q, { regimeAvant: null, attendu: { binomes: null, horaires: null }, desiderata: [] })).toEqual([])
  })
})

describe('regimeDe', () => {
  const c = (IDbonnetier: number, date: string, debut: string, fin: string): Creneau => ({ IDbonnetier, date, debut, fin })
  it('names the shifts and the day length', () => {
    expect(regimeDe([c(1, '2026-11-16', '05:00', '13:00'), c(2, '2026-11-16', '13:00', '21:00'), c(3, '2026-11-16', '21:00', '05:00')])).toBe('3 équipes (Matin, Après-midi, Nuit), journées de 8 h')
    expect(regimeDe([c(1, '2026-11-16', '05:00', '12:00'), c(2, '2026-11-16', '14:00', '21:00')])).toBe('2 équipes (Matin, Après-midi), journées de 7 h')
    expect(regimeDe([])).toBe('aucune équipe')
  })
  it('ignores one odd day of a bonnetier', () => {
    expect(regimeDe([
      c(1, '2026-11-16', '14:00', '20:00'), c(1, '2026-11-17', '13:00', '20:00'), c(1, '2026-11-18', '13:00', '20:00'),
      c(2, '2026-11-16', '05:00', '12:00'),
    ])).toBe('2 équipes (Matin, Après-midi), journées de 7 h')
  })
})
