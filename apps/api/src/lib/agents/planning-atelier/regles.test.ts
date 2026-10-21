import { describe, expect, it } from 'vitest'
import { addDays } from '../../planning-bonnetier.js'
import { ecarts, equipeDe, equipesDeLaSemaine, faitsDuRoulement, regimeDe, estDimanche, historiqueTexte, semaineIso, validerReponse, type Creneau } from './regles.js'

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
