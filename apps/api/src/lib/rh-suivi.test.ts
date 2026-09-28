import { describe, expect, it } from 'vitest'
import { hashEvenement, libelleType, sha256, verifierChaine, type EvenementScelle, type MaillonChaine } from './rh-suivi.js'

const evt = (id: number, x: Partial<EvenementScelle> = {}): EvenementScelle => ({
  id,
  idemploye: 1,
  dateEvenement: '2026-09-28',
  type: 'information',
  titre: 'Évolution du poste',
  presents: 'Vincent Malterre, Pierre-Emmanuel',
  contenu: 'Annonce de l’automatisation progressive des tâches.',
  rectifie: null,
  creeLe: '2026-09-28T16:12:00.000Z',
  creePar: 'vincent',
  pieces: [],
  ...x,
})

function chaine(evts: EvenementScelle[]): MaillonChaine[] {
  let precedent: string | null = null
  return evts.map((e) => {
    const hash = hashEvenement(e, precedent)
    const m = { evenement: e, hash, hashPrecedent: precedent }
    precedent = hash
    return m
  })
}

describe('hash d’un événement', () => {
  it('is stable and changes with any field, attachments included', () => {
    const base = hashEvenement(evt(1), null)
    expect(hashEvenement(evt(1), null)).toBe(base)
    expect(hashEvenement(evt(1, { contenu: 'autre' }), null)).not.toBe(base)
    expect(hashEvenement(evt(1, { dateEvenement: '2026-09-27' }), null)).not.toBe(base)
    expect(hashEvenement(evt(1, { pieces: [{ nom: 'recap.pdf', sha256: sha256('x') }] }), null)).not.toBe(base)
    expect(hashEvenement(evt(1), 'abc')).not.toBe(base)
  })
})

describe('vérification de la chaîne', () => {
  it('accepts an intact chain, empty included', () => {
    expect(verifierChaine([])).toEqual({ ok: true, nombre: 0 })
    expect(verifierChaine(chaine([evt(1), evt(2), evt(3)]))).toEqual({ ok: true, nombre: 3 })
  })

  it('points at an entry whose content was edited behind the API', () => {
    const c = chaine([evt(1), evt(2), evt(3)])
    c[1] = { ...c[1], evenement: { ...c[1].evenement, contenu: 'réécrit' } }
    expect(verifierChaine(c)).toMatchObject({ ok: false, idCasse: 2, raison: 'contenu' })
  })

  it('points at the entry after a removed one', () => {
    const c = chaine([evt(1), evt(2), evt(3)])
    c.splice(1, 1)
    expect(verifierChaine(c)).toMatchObject({ ok: false, idCasse: 3, raison: 'chainage' })
  })
})

describe('libellés', () => {
  it('labels known types and passes unknown ones through', () => {
    expect(libelleType('avertissement')).toBe('Avertissement / sanction')
    expect(libelleType('xyz')).toBe('xyz')
  })
})
