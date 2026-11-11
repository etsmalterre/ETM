import { describe, expect, it } from 'vitest'
import { contexteAvant, mailExpliquant, type SaisieHumaine } from './observation.js'

const personne = { id: 7, nom: 'Pierre-Emmanuel' }

const humaine = (o: Partial<SaisieHumaine> & Pick<SaisieHumaine, 'id' | 'valeur' | 'le'>): SaisieHumaine => ({
  competence: 'delais', idsousTraitant: 1, idcommande: 9132, idligne: 0, idsuivilot: 0, avant: null, par: personne, ...o,
})

/** A mail read before the value: what it has on the lot the value is on. */
const mail = (nom: string, dateMail: string, o: { point?: boolean; cible?: boolean } = {}) =>
  ({ mail: nom, dateMail, point: !!o.point, cible: !!o.cible })

describe('observation driven by people (2026-11-09)', () => {
  it('gives the value to the mail whose reading has a point on the lot', () => {
    expect(mailExpliquant([mail('A', '2026-11-10T12:07:05Z', { point: true, cible: true })])).toEqual({ mail: 'A', omission: false })
  })

  it('never lets an older mail that only asked about the lot take the value a later mail gives (lot MA109651, 2026-11-10)', () => {
    // 09/11: « on va faire le max pour fin novembre », no measure, but its Point asked for the lot.
    // 10/11: the measures. Both waited when the person typed them.
    const r = mailExpliquant([
      mail('sans mesures', '2026-11-09T13:45:22Z', { cible: true }),
      mail('les mesures', '2026-11-10T12:07:05Z', { point: true, cible: true }),
    ])
    expect(r).toEqual({ mail: 'les mesures', omission: false })
  })

  it('prefers the mail that read the lot to a later one that only asked about it', () => {
    const r = mailExpliquant([
      mail('les mesures', '2026-11-09T12:17:14Z', { point: true, cible: true }),
      mail('merci', '2026-11-09T13:45:22Z', { cible: true }),
    ])
    expect(r).toEqual({ mail: 'les mesures', omission: false })
  })

  it('takes the latest of two mails that both read the lot: the person typed from the last one', () => {
    const r = mailExpliquant([
      mail('premières mesures', '2026-11-09T12:00:00Z', { point: true, cible: true }),
      mail('mesures corrigées', '2026-11-10T12:00:00Z', { point: true, cible: true }),
    ])
    expect(r?.mail).toBe('mesures corrigées')
  })

  it('is an omission of the latest mail that was about the lot when none read it', () => {
    const r = mailExpliquant([
      mail('A', '2026-11-09T12:00:00Z', { cible: true }),
      mail('B', '2026-11-10T12:00:00Z', { cible: true }),
      mail('C', '2026-11-10T15:00:00Z'),
    ])
    expect(r).toEqual({ mail: 'B', omission: true })
  })

  it('is hors de portée when no mail read was about the lot', () => {
    expect(mailExpliquant([mail('autre lot', '2026-11-10T12:00:00Z')])).toBeNull()
    expect(mailExpliquant([])).toBeNull()
  })

  it('reads the mail against each line as it was before the first value typed, « today » = the mail’s day in Paris', () => {
    const c = contexteAvant('2026-11-09T23:30:00Z', [
      humaine({ id: 2, idligne: 11, valeur: '2026-12-09', le: '2026-11-10T10:00:00Z', avant: { idcommande: 9132, dateLivraison: '20261202', dateDelai: '', sstatut: 'En_Cours' } }),
      humaine({ id: 1, idligne: 11, valeur: '2026-12-02', le: '2026-11-10T08:00:00Z', avant: { idcommande: 9132, dateLivraison: '', dateDelai: '', sstatut: 'Attente_Delai' } }),
      humaine({ id: 3, competence: 'controles', idsuivilot: 5, valeur: '{}', le: '2026-11-10T08:00:00Z', avant: null }),
    ])
    expect(c.aujourdhui).toBe('2026-11-10')
    expect(c.etats['11'].sstatut).toBe('Attente_Delai')
    expect(c.lots).toEqual({ '5': null })
  })
})
