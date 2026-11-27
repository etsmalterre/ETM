import { describe, expect, it } from 'vitest'
import { documentDuLot, nomFichier } from './espace-partenaire-documents.js'

const LOTS = ['MA109152', 'MA109269', 'TA530425']
const d = (nom: string, lots: readonly string[] = LOTS) => documentDuLot(nom, lots)

describe('the partner’s delivery papers: only the names the BL agent writes', () => {
  it('the BL of a lot, a later bordereau, a further page', () => {
    expect(d('MA109152.pdf')).toEqual({ genre: 'bl', lot: 'MA109152', bordereau: null, rang: null, page: 1 })
    expect(d('MA109269B.pdf')).toEqual({ genre: 'bl', lot: 'MA109269', bordereau: 'B', rang: null, page: 1 })
    expect(d('MA109152-2.pdf')).toMatchObject({ genre: 'bl', lot: 'MA109152', page: 2 })
    expect(d('ma109152.PDF')).toMatchObject({ genre: 'bl', lot: 'MA109152' })
  })

  it('a reprise, a rectified BL, a mise à disposition', () => {
    expect(d('MA109152-reprise.pdf')).toMatchObject({ genre: 'bl_reprise', rang: null, page: 1 })
    expect(d('MA109152-reprise2.pdf')).toMatchObject({ genre: 'bl_reprise', rang: 2 })
    expect(d('MA109152-reprise2-3.pdf')).toMatchObject({ genre: 'bl_reprise', rang: 2, page: 3 })
    expect(d('MA109152-rectifie.pdf')).toMatchObject({ genre: 'bl_rectifie' })
    expect(d('TA530425-dispo.pdf')).toMatchObject({ genre: 'mise_a_dispo', lot: 'TA530425' })
  })

  it('nothing typed by hand: no .pdf, another wording, a lot the order does not know', () => {
    expect(d('MA109152')).toBeNull()
    expect(d('bl')).toBeNull()
    expect(d('BL Matel')).toBeNull()
    expect(d('bl 109152.pdf')).toBeNull()
    expect(d('108084 - tableau métrage 15 noir.doc')).toBeNull()
    expect(d('MA109152 - tableau métrage.pdf')).toBeNull()
    expect(d('MA109999.pdf')).toBeNull()
    expect(d('MA109152.pdf', [])).toBeNull()
    expect(d('.pdf', ['', ' '])).toBeNull()
  })

  it('a lot that opens another one’s name does not claim its paper', () => {
    expect(d('MA108914.pdf', ['MA10891'])).toBeNull()
    expect(d('MA108914.pdf', ['MA10891', 'MA108914'])).toMatchObject({ lot: 'MA108914', genre: 'bl' })
    expect(d('BON3976.pdf', ['BON397', 'BON3976'])).toMatchObject({ lot: 'BON3976' })
  })

  it('is handed out under the partner’s lot', () => {
    expect(nomFichier(d('MA109269B.pdf')!)).toBe('bl-MA109269B.pdf')
    expect(nomFichier(d('MA109152-reprise2-3.pdf')!)).toBe('bl-reprise-MA109152-p3.pdf')
    expect(nomFichier(d('TA530425-dispo.pdf')!)).toBe('mise-a-disposition-TA530425.pdf')
  })
})
