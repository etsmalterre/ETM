import { describe, expect, it } from 'vitest'
import {
  aujourdhuiHfsql,
  comptesEnDouble,
  decodeBalance,
  parseBalanceSage,
  totauxBalance,
  verifierSociete,
} from './import-sage.js'

// Synthetic lines shaped like a real export (never commit a real one: the
// balance names payroll accounts).
const FICHIER = [
  '101300\tCapital souscrit appele verse\t0.00\t50000.00',
  '40AMAZO\tAMAZONE\t3127.68\t0.00',
  '602110\tMatiere (ou groupe) c\t3237.82\t0.00',
  '603700\tVariation stocks marchandises\t0.00\t0.00',
  '641100\tSalaires, appointements\t1200.50\t0.00',
  '6358FED\tTVA A L IMPORTATION ET FRAIS DE DOU\t386.00\t0.00',
  '609000\tRabais remises ristournes\t0.00\t100.00',
  '706000\tPrestations de services\t0.00\t9000.00',
  '709000\tRabais accordes\t250.00\t0.00',
  '',
].join('\r\n')

describe('parseBalanceSage', () => {
  const b = parseBalanceSage(FICHIER)

  it('keeps the 6-digit class 6 and 7 accounts, in file order', () => {
    expect(b.lignes.map((l) => l.numero)).toEqual([602110, 603700, 641100, 609000, 706000, 709000])
    expect(b.lignes[0]).toEqual({ numero: 602110, libelle: 'Matiere (ou groupe) c', debit: 3237.82, credit: 0 })
  })

  it('reports a class 6 line whose account is off the chart, like the legacy skipped it', () => {
    expect(b.ignorees).toHaveLength(1)
    expect(b.ignorees[0].texte).toMatch(/^6358FED/)
    expect(b.ignorees[0].ligne).toBe(6)
  })

  it('fingerprints every 4-column line, all classes', () => {
    expect(b.nbLignesFichier).toBe(9)
    expect(b.empreinte.has('40AMAZO\tAMAZONE')).toBe(true)
    expect(b.empreinte.has('101300\tCapital souscrit appele verse')).toBe(true)
  })

  it('keeps a libellé holding a digit (the legacy regex dropped it)', () => {
    const r = parseBalanceSage('606100\tEau 2e site\t10.00\t0.00')
    expect(r.lignes).toEqual([{ numero: 606100, libelle: 'Eau 2e site', debit: 10, credit: 0 }])
  })

  it('refuses a French-formatted amount instead of misreading it', () => {
    const r = parseBalanceSage('606100\tEau\t1 234,56\t0.00')
    expect(r.lignes).toHaveLength(0)
    expect(r.ignorees[0].raison).toBe('montant illisible')
  })

  it('reads an unrelated file as empty', () => {
    const r = parseBalanceSage('nom;prenom\nDupont;Jean')
    expect(r.lignes).toHaveLength(0)
    expect(r.nbLignesFichier).toBe(0)
  })
})

describe('decodeBalance', () => {
  it('decodes the Windows code page Sage writes', () => {
    const buf = Buffer.from([0x53, 0xe9, 0x63, 0x75, 0x72, 0x69, 0x74, 0xe9, 0x92])
    expect(decodeBalance(buf)).toBe('Sécurité’')
  })
})

describe('totauxBalance', () => {
  const { lignes } = parseBalanceSage(FICHIER)

  it('reproduces the legacy aggregates', () => {
    const variables = new Set([602110, 603700])
    expect(totauxBalance(lignes, (n) => variables.has(n))).toEqual({
      charges: 3237.82 + 1200.5 - 100,
      produits: 9000 - 250,
      frais_fixe: 1200.5 - 100,
      frais_variable: 3237.82,
      provisions: 0,
    })
  })

  it('counts an unknown account as a charge fixe', () => {
    expect(totauxBalance(lignes, () => false).frais_variable).toBe(0)
  })

  it('rounds to the cent', () => {
    const r = totauxBalance(
      [{ numero: 600000, libelle: 'a', debit: 0.1, credit: 0 }, { numero: 600001, libelle: 'b', debit: 0.2, credit: 0 }],
      () => false,
    )
    expect(r.charges).toBe(0.3)
  })
})

describe('comptesEnDouble', () => {
  it('lists an account present twice', () => {
    const { lignes } = parseBalanceSage('606100\tA\t1.00\t0.00\n606100\tA\t2.00\t0.00\n606200\tB\t1.00\t0.00')
    expect(comptesEnDouble(lignes)).toEqual([606100])
  })
})

describe('verifierSociete', () => {
  const etm = new Set(['40AMAZO\tAMAZONE', '40C2TEC\tC2TEC', '602110\tMatiere (ou groupe) c', '641100\tSalaires'])
  const trm = new Set(['40AMAZO\tAMAZON', '40EDF\tEDF', '602110\tMatieres premieres', '641100\tSalaires'])

  it('accepts a file that looks like its own company', () => {
    const f = new Set(['40AMAZO\tAMAZONE', '40C2TEC\tC2TEC', '641100\tSalaires'])
    expect(verifierSociete(f, etm, trm).ok).toBe(true)
  })

  it('refuses a file that looks like the other company', () => {
    const f = new Set(['40AMAZO\tAMAZON', '40EDF\tEDF', '641100\tSalaires'])
    const v = verifierSociete(f, etm, trm)
    expect(v.ok).toBe(false)
    expect(v.ressemblanceAutre).toBe(1)
    expect(v.ressemblanceCible).toBeCloseTo(1 / 3)
  })

  it('refuses a tie — nothing proves the file is ours', () => {
    expect(verifierSociete(new Set(['641100\tSalaires']), etm, trm).ok).toBe(false)
  })

  it('lets the first import of a company through (nothing to compare with)', () => {
    expect(verifierSociete(new Set(['x\ty']), new Set(), trm).ok).toBe(true)
  })
})

describe('aujourdhuiHfsql', () => {
  it('uses the Paris calendar day', () => {
    // 23:30 UTC on 2026-09-25 is already the 26th in Paris (UTC+2).
    expect(aujourdhuiHfsql(new Date('2026-09-25T23:30:00Z'))).toBe('20260926')
    expect(aujourdhuiHfsql(new Date('2026-09-25T10:00:00Z'))).toBe('20260925')
  })
})
