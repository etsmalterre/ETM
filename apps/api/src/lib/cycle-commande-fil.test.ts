import { describe, expect, it } from 'vitest'
import { cycleCommandeFil, lotCertifie, urgenceCommandeFil, type FaitsCommandeFil } from './cycle-commande-fil.js'

const recue: FaitsCommandeFil = {
  etat: 1,
  sousRegle: true,
  lotsBio: [],
  nbFactures: 1,
  nbFacturesARegler: 0,
  clotureForcee: null,
  premiereReception: '2026-09-01',
  delaiPaiementJours: 0,
}

describe('cycleCommandeFil', () => {
  it('yarn still awaited = en cours, whatever is missing', () => {
    const c = cycleCommandeFil({ ...recue, etat: 0, nbFactures: 0 })
    expect(c.etape).toBe('en_cours')
    expect(c.attentes).toEqual([])
    expect(c.manques).toEqual(['facture'])
  })

  it('received, invoice attached and paid, no organic lot = terminée', () => {
    expect(cycleCommandeFil(recue).etape).toBe('terminee')
  })

  it('received without any invoice = attente facture', () => {
    const c = cycleCommandeFil({ ...recue, nbFactures: 0 })
    expect(c.etape).toBe('attente')
    expect(c.attentes).toEqual(['facture'])
  })

  it('an unpaid invoice = attente paiement', () => {
    const c = cycleCommandeFil({ ...recue, nbFactures: 2, nbFacturesARegler: 1 })
    expect(c.attentes).toEqual(['paiement'])
    expect(c.factures_a_regler).toBe(1)
  })

  it('an organic lot without certificate = attente certificat, counted per lot', () => {
    const c = cycleCommandeFil({
      ...recue,
      lotsBio: [
        { IDstock_fil: 1, lot: 'A', certifie: true, date_entree: '2026-09-01' },
        { IDstock_fil: 2, lot: 'B', certifie: false, date_entree: '2026-09-01' },
      ],
    })
    expect(c.attentes).toEqual(['certificat'])
    expect(c.lots_bio_sans_certificat).toBe(1)
  })

  it('several gaps at once, in a fixed order', () => {
    const c = cycleCommandeFil({
      ...recue,
      nbFactures: 0,
      lotsBio: [{ IDstock_fil: 1, lot: 'A', certifie: false, date_entree: '2026-09-01' }],
    })
    expect(c.attentes).toEqual(['certificat', 'facture'])
  })

  it('an order older than the rule stays terminée, its gaps kept as information', () => {
    const c = cycleCommandeFil({ ...recue, sousRegle: false, nbFactures: 0 })
    expect(c.etape).toBe('terminee')
    expect(c.attentes).toEqual([])
    expect(c.manques).toEqual(['facture'])
  })

  it('« Clôturer quand même » terminates despite the gaps', () => {
    const forcee = { le: '2026-10-13T10:00', par: 'Pierre-Emmanuel Roux', motif: 'Fournisseur sans certificat' }
    const c = cycleCommandeFil({ ...recue, nbFactures: 0, clotureForcee: forcee })
    expect(c.etape).toBe('terminee')
    expect(c.cloture_forcee).toEqual(forcee)
    expect(c.manques).toEqual(['facture'])
  })

  it('a forced close does not survive reopening the order', () => {
    const forcee = { le: '2026-10-13T10:00', par: null, motif: 'x' }
    const c = cycleCommandeFil({ ...recue, etat: 0, clotureForcee: forcee })
    expect(c.etape).toBe('en_cours')
    expect(c.cloture_forcee).toBeNull()
  })
})

describe('lotCertifie', () => {
  it('a certificate naming the lot covers it', () => {
    expect(lotCertifie(7, [{ lots: [7, 8] }])).toBe(true)
  })
  it('a certificate naming other lots does not', () => {
    expect(lotCertifie(9, [{ lots: [7, 8] }])).toBe(false)
  })
  it('a certificate naming no lot covers every lot of the order', () => {
    expect(lotCertifie(9, [{ lots: [7] }, { lots: [] }])).toBe(true)
  })
  it('no certificate covers nothing', () => {
    expect(lotCertifie(9, [])).toBe(false)
  })
})

describe('urgenceCommandeFil', () => {
  const today = '2026-10-13'
  const lot = (date: string, certifie = false) => ({ IDstock_fil: 1, lot: 'A', certifie, date_entree: date })

  it('a terminée order is neutral', () => {
    expect(urgenceCommandeFil(cycleCommandeFil(recue), null, today)).toBeNull()
  })

  it('yarn awaited: late or undated = rouge, within 3 days = ambre, later = neutral', () => {
    const c = cycleCommandeFil({ ...recue, etat: 0 })
    expect(urgenceCommandeFil(c, null, today)?.niveau).toBe('rouge')
    expect(urgenceCommandeFil(c, '20261013', today)).toEqual({ niveau: 'rouge', raison: 'Livraison en retard · 13/10' })
    expect(urgenceCommandeFil(c, '20261016', today)?.niveau).toBe('ambre')
    expect(urgenceCommandeFil(c, '20261017', today)).toBeNull()
  })

  it('certificate: neutral under 35 d, ambre from 35 d, rouge from 75 d — counted from the oldest uncovered lot', () => {
    const at = (date: string) => urgenceCommandeFil(cycleCommandeFil({ ...recue, lotsBio: [lot(date)] }), null, today)
    expect(at('2026-09-09')).toBeNull()                       // 34 d
    expect(at('2026-09-08')?.niveau).toBe('ambre')            // 35 d
    expect(at('2026-07-31')).toEqual({ niveau: 'ambre', raison: 'Certificat GOTS · reçu il y a 74 j' })
    expect(at('2026-07-30')).toEqual({ niveau: 'rouge', raison: 'Certificat GOTS · reçu il y a 75 j' })
  })

  it('a covered lot does not count', () => {
    const c = cycleCommandeFil({ ...recue, lotsBio: [lot('2026-01-01', true), lot('2026-10-01')] })
    expect(urgenceCommandeFil(c, null, today)).toBeNull()
  })

  it('missing invoice: ambre once the yarn is in, rouge from 15 d', () => {
    const at = (date: string) => urgenceCommandeFil(cycleCommandeFil({ ...recue, nbFactures: 0, premiereReception: date }), null, today)
    expect(at('2026-10-13')?.niveau).toBe('ambre')
    expect(at('2026-09-29')?.niveau).toBe('ambre')            // 14 d
    expect(at('2026-09-28')).toEqual({ niveau: 'rouge', raison: 'Facture à joindre · reçu il y a 15 j' })
  })

  it('unpaid invoice: neutral before the due date, ambre from it, rouge 15 d after', () => {
    const at = (date: string, delai: number | null) => urgenceCommandeFil(
      cycleCommandeFil({ ...recue, nbFacturesARegler: 1, premiereReception: date, delaiPaiementJours: delai }), null, today)
    expect(at('2026-10-01', 30)).toBeNull()                   // due 31/10
    expect(at('2026-10-13', 0)?.raison).toBe('À régler · échue aujourd’hui')
    expect(at('2026-09-29', null)?.niveau).toBe('ambre')      // 14 d, no échéance = à réception
    expect(at('2026-09-28', 0)?.niveau).toBe('rouge')
  })

  it('the most urgent gap wins', () => {
    const c = cycleCommandeFil({ ...recue, nbFactures: 0, premiereReception: '2026-10-10', lotsBio: [lot('2026-07-01')] })
    expect(urgenceCommandeFil(c, null, today)?.niveau).toBe('rouge')
    expect(urgenceCommandeFil(c, null, today)?.raison).toMatch(/^Certificat GOTS/)
  })
})
