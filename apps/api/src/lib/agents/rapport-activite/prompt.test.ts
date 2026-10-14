import { describe, expect, it } from 'vitest'
import { datesLisibles, estMailContexte, estPromptV4, filtrerPoints, premiereHeure, PROMPT_V3, PROMPT_V4, type PointIa } from './prompt.js'

const point = (p: Partial<PointIa>): PointIa => ({
  constat: 'Le prix du fil 160 ELASTHANNE dans ETM n’est pas celui de l’offre',
  fait_1: '09:38 ETM, Fils › Références : 160 ELASTHANNE à 5,78 €/kg',
  fait_2: '09:32 mail reçu de Filmatech : offre à 5,50 €/kg',
  risque: 'fournisseur',
  a_verifier: 'Ouvrir Fils › Références 160 ELASTHANNE',
  ...p,
})
const heures = { propres: new Set(['09:32', '09:38']), contexte: new Set(['10:15']) }

describe('filtrerPoints (v4)', () => {
  it('keeps a point whose two facts open on hours of the period', () => {
    expect(filtrerPoints([point({})], heures)).toMatchObject({ gardes: [{ risque: 'fournisseur' }], ecartes: [] })
  })
  it('drops a fact without an hour of the period — the model reasoning on what it was not given', () => {
    const r = filtrerPoints([point({ fait_2: 'Le journal conserve la version initiale' }), point({ fait_2: '08:12 ETM : affectation' })], heures)
    expect(r.gardes).toEqual([])
    expect(r.ecartes.map((e) => e.raison)).toEqual(['un fait ne cite aucune heure de la période', 'un fait ne cite aucune heure de la période'])
  })
  it('drops a point resting only on Vincent’s own mails', () => {
    const r = filtrerPoints([point({ fait_1: '10:15 mail de Vincent', fait_2: '10h15 même mail, plus bas' })], heures)
    expect(r.ecartes[0].raison).toBe('les deux faits viennent des mails [contexte]')
  })
  it('drops the same fact twice, and strips the [mN] handles', () => {
    expect(filtrerPoints([point({ fait_2: '09:38 ETM, Fils › Références : 160 ELASTHANNE à 5,78 €/kg' })], heures).ecartes[0].raison).toBe('deux fois le même fait')
    expect(filtrerPoints([point({ fait_2: '09:32 mail [m3] de Filmatech' })], heures).gardes[0].fait_2).toBe('09:32 mail de Filmatech')
  })
})

describe('prompt v4', () => {
  it('asks for two facts and bans « incohérence »', () => {
    expect(estPromptV4(PROMPT_V4)).toBe(true)
    expect(estPromptV4(PROMPT_V3)).toBe(false)
    expect(PROMPT_V4).toContain('jamais les mots « incohérence »')
    expect(PROMPT_V4).toContain('[contexte]')
    expect(PROMPT_V4).toContain('Une étape absente de la période')
  })
  it('helpers', () => {
    expect(premiereHeure('À 9h05, ETM')).toBe('09:05')
    expect(datesLisibles('{"date_reception_type":"20261012","n":"12345678"}')).toBe('{"date_reception_type":"12/10/2026","n":"12345678"}')
    expect(estMailContexte({ envoye: false, de: 'vincent@etsmalterre.com' })).toBe(true)
    expect(estMailContexte({ envoye: false, de: 'sender@malterre-intelligence.com' })).toBe(true)
    expect(estMailContexte({ envoye: true, de: 'pierre-emmanuel@etsmalterre.com' })).toBe(false)
    expect(estMailContexte({ envoye: false, de: 'philippe@filmatech.fr' })).toBe(false)
  })
})
