import { describe, expect, it } from 'vitest'
import { construirePoint, jourSuivantOuvre, lotCourt, type LigneFait } from './regles.js'

const JOUR = '2026-10-06'

function ligne(p: Partial<LigneFait> & { idligne: number }): LigneFait {
  return {
    idcommande: p.idligne + 30,
    reference: '029A',
    coloris: '0612 marine',
    sstatut: 'En_Cours',
    dateLivraison: null,
    quantite: 1000,
    nbRecus: 0,
    metrageRecu: 0,
    dernierRecu: null,
    dernierSoumis: null,
    clientSoumission: false,
    lotsSansControle: [],
    lotsEnReprise: [],
    lotsAControler: [],
    relance: null,
    ...p,
  }
}

const sections = (l: LigneFait[]) => construirePoint(JOUR, l).map((x) => `${x.section}:${x.idligne}`)

describe('construirePoint', () => {
  it('§5: a sent order waiting for its date; a bon de commande not sent is never asked', () => {
    expect(sections([ligne({ idligne: 1, sstatut: 'Attente_Delai' }), ligne({ idligne: 2, sstatut: 'Non_Envoye' })])).toEqual(['5:1'])
  })

  it('§1: due within 9 days and nothing received; later or fully received lines are left out', () => {
    expect(sections([
      ligne({ idligne: 1, dateLivraison: '2026-10-12' }),
      ligne({ idligne: 2, dateLivraison: '2026-10-15' }), // 6 + 9 = 15: still in
      ligne({ idligne: 3, dateLivraison: '2026-10-16' }),
      ligne({ idligne: 4, dateLivraison: '2026-10-12', nbRecus: 20, metrageRecu: 980 }),
    ])).toEqual(['1:1', '1:2'])
  })

  it('§1: a partly received line is announced as « solde »', () => {
    const [l] = construirePoint(JOUR, [ligne({ idligne: 1, dateLivraison: '2026-10-12', nbRecus: 3, metrageRecu: 300 })])
    expect(l).toMatchObject({ section: 1, commentaire: 'solde', datePrevue: '2026-10-12' })
  })

  it('§1 sorted by date, then most recent order first', () => {
    expect(sections([
      ligne({ idligne: 1, idcommande: 9030, dateLivraison: '2026-10-13' }),
      ligne({ idligne: 2, idcommande: 9031, dateLivraison: '2026-10-13' }),
      ligne({ idligne: 3, idcommande: 9017, dateLivraison: '2026-10-12' }),
    ])).toEqual(['1:3', '1:2', '1:1'])
  })

  it('§2: lots without the dyer measures, written as PE does (no « MA »)', () => {
    const [l] = construirePoint(JOUR, [ligne({ idligne: 1, nbRecus: 30, metrageRecu: 2000, lotsSansControle: ['MA109286', 'MA109287'] })])
    expect(l).toMatchObject({ section: 2, commentaire: '109286 et 109287' })
  })

  it('§2 and §1 together: controls asked while the rest is still due', () => {
    expect(sections([ligne({ idligne: 1, dateLivraison: '2026-10-12', nbRecus: 3, metrageRecu: 300, lotsSansControle: ['MA1'] })])).toEqual(['1:1', '2:1'])
  })

  it('§3: a client wanting soumissions, due today or up to 3 days late, none sent for a week', () => {
    expect(sections([
      ligne({ idligne: 1, clientSoumission: true, dateLivraison: '2026-10-04' }),
      ligne({ idligne: 2, clientSoumission: true, dateLivraison: '2026-10-08' }), // not due yet: §1 (v4)
      ligne({ idligne: 3, clientSoumission: false, dateLivraison: '2026-10-08' }), // no soumission: §1
      ligne({ idligne: 4, clientSoumission: true, dateLivraison: '2026-10-06' }), // due today
    ])).toEqual(['1:3', '1:2', '3:4', '3:1'])
  })

  // v2 — the cases of PE's point du 06/10/2026 the v1 rules got wrong.
  describe('v2 (point du 06/10)', () => {
    it('§5 waits for the relance date (9082–9090: bon de commande 05/10, relance 08/10)', () => {
      expect(sections([
        ligne({ idligne: 1, sstatut: 'Attente_Delai', relance: '2026-10-08' }),
        ligne({ idligne: 2, sstatut: 'Attente_Delai', relance: '2026-10-06' }),
      ])).toEqual(['5:2'])
    })

    it('a lot in reprise is a délai question « reprise », not a control (8929 lot 109102)', () => {
      const p = construirePoint(JOUR, [ligne({ idligne: 1, nbRecus: 23, metrageRecu: 1660, quantite: 1658, lotsEnReprise: ['MA109102'] })])
      expect(p).toEqual([expect.objectContaining({ section: 5, cle: 'reprise:1', commentaire: 'reprise' })])
    })

    it('§4 is never generated: soumission sent with no roll since, or late (8936, 9023)', () => {
      expect(sections([
        ligne({ idligne: 1, clientSoumission: true, dateLivraison: '2026-10-02', dernierSoumis: '2026-10-02' }),
        ligne({ idligne: 2, clientSoumission: true, dateLivraison: '2026-09-25' }),
        ligne({ idligne: 3, dateLivraison: '2026-10-01' }),
      ])).toEqual([])
    })

    it('a partly received line with a soumission is still a « solde » exit (9013)', () => {
      const [l] = construirePoint(JOUR, [ligne({ idligne: 1, quantite: 0, nbRecus: 10, metrageRecu: 300, dateLivraison: '2026-10-12', dernierSoumis: '2026-09-30', dernierRecu: '2026-09-27', clientSoumission: true })])
      expect(l).toMatchObject({ section: 1, commentaire: 'solde' })
    })
  })

  // v3 — Pierre-Emmanuel’s corrections on the point du 07/10, generalised only where ETM holds the fact.
  describe('v3 (point du 07/10)', () => {
    it('§3 is not asked while a lot measured by the dyer waits for our control (9029, lot 109379)', () => {
      expect(sections([
        ligne({ idligne: 1, clientSoumission: true, dateLivraison: '2026-10-05', nbRecus: 16, metrageRecu: 642, quantite: 688, lotsAControler: ['MA109379'] }),
        ligne({ idligne: 2, clientSoumission: true, dateLivraison: '2026-10-05' }),
      ])).toEqual(['3:2'])
    })

    it('a measured lot does not hide the exit of what is still due', () => {
      expect(sections([ligne({ idligne: 1, dateLivraison: '2026-10-12', nbRecus: 3, metrageRecu: 300, lotsAControler: ['MA1'] })])).toEqual(['1:1'])
    })

    it('§1 is not reminded when nothing came back and a soumission just went out (9037)', () => {
      expect(sections([
        ligne({ idligne: 1, dateLivraison: '2026-10-08', dernierSoumis: '2026-10-06' }),
        ligne({ idligne: 2, dateLivraison: '2026-10-08', dernierSoumis: '2026-09-20' }), // older than a week: reminded
      ])).toEqual(['1:2'])
    })

    it('§6 (études) is never filled — the question stays, without a list', () => {
      expect(construirePoint(JOUR, []).some((l) => l.section === 6)).toBe(false)
    })
  })

  // v4: Pierre-Emmanuel's corrections on the point du 09/10 and his answers of 08/10.
  describe('v4 (point du 09/10)', () => {
    const J = '2026-10-09'
    const s4 = (l: LigneFait[]) => construirePoint(J, l).map((x) => `${x.section}:${x.idligne}:${x.commentaire}`)

    it('due on the point day, nothing back: claimed in §4, no longer a §1 exit (8982)', () => {
      expect(s4([ligne({ idligne: 1, dateLivraison: '2026-10-09' })])).toEqual(['4:1:'])
    })

    it('due on the point day, partly received: §4 « solde »', () => {
      expect(s4([ligne({ idligne: 1, dateLivraison: '2026-10-09', nbRecus: 3, metrageRecu: 300 })])).toEqual(['4:1:solde'])
    })

    it('§3 never before the exit date: 9017 (due 12/10, partly received) stays a §1 « solde »', () => {
      expect(s4([ligne({ idligne: 1, quantite: 0, nbRecus: 26, metrageRecu: 1867, dateLivraison: '2026-10-12', clientSoumission: true, lotsSansControle: ['MA109331', 'MA109333'] })]))
        .toEqual(['1:1:solde', '2:1:109331 et 109333'])
    })

    it('a client wanting soumissions, due on the point day: §3, not §4', () => {
      expect(s4([ligne({ idligne: 1, dateLivraison: '2026-10-09', clientSoumission: true })])).toEqual(['3:1:'])
    })

    it('late lines still leave the point (PE moves the date at each of Perrine\'s answers)', () => {
      expect(s4([ligne({ idligne: 1, dateLivraison: '2026-10-08' })])).toEqual([])
    })
  })

  it('every line explains itself', () => {
    const p = construirePoint(JOUR, [
      ligne({ idligne: 1, sstatut: 'Attente_Delai' }),
      ligne({ idligne: 2, dateLivraison: '2026-10-12' }),
      ligne({ idligne: 3, dateLivraison: '2026-10-01' }),
    ])
    for (const l of p) expect(l.pourquoi.length).toBeGreaterThan(10)
  })
})

describe('helpers', () => {
  it('Friday → Monday', () => {
    expect(jourSuivantOuvre('2026-10-09')).toBe('2026-10-12')
    expect(jourSuivantOuvre('2026-10-05')).toBe('2026-10-06')
  })
  it('lotCourt', () => expect(lotCourt('MA109366')).toBe('109366'))
})

describe('lines without an ordered quantity', () => {
  it('rolls back, not yet due → « solde »; past its date → done', () => {
    const p = construirePoint(JOUR, [
      ligne({ idligne: 1, quantite: 0, nbRecus: 10, metrageRecu: 300, dateLivraison: '2026-10-12' }),
      ligne({ idligne: 2, quantite: 0, nbRecus: 22, metrageRecu: 600, dateLivraison: '2026-10-01' }),
    ])
    expect(p.map((x) => `${x.section}:${x.idligne}:${x.commentaire}`)).toEqual(['1:1:solde'])
  })
})
