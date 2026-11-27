import { describe, expect, it } from 'vitest'
import { etudePartenaire, type EtudeFaits } from './espace-partenaire-etudes.js'

// Friday 2026-11-27.
const TODAY = '2026-11-27'
const etude = (over: Partial<EtudeFaits> = {}): EtudeFaits => ({
  id: 1412, statut: 1, libelle: '512 bleu chambray', commentaire: '', client: 'SIMONE PERELE', reference: 'EDF85/55', designation: 'Jersey',
  colorisCree: '', dateReception: '20261110', derniereAction: '20261110', soumissions: [], relances: [], ...over,
})
const soum = (id: number, dateSoum: string, accepte: number, dateReponse: string | null = null, version = 'v1', observation = '1-2') =>
  ({ id, dateSoum, dateReponse, accepte, version, observation })

describe('an étude coloris as its lab reads it', () => {
  it('the lab holds it: its clock from the type received to the day Malterre chases (17 days), in working days', () => {
    const e = etudePartenaire(etude(), TODAY)!
    expect(e).toMatchObject({ etape: 'a_faire', client: 'SIMONE PERELE', coloris: '512 bleu chambray', recueLe: '2026-11-10', attenteReponse: null, relanceLe: null })
    // 10/11 + 17 days = 27/11: 12 working days granted (the 11th is a holiday). Up on that day itself, as in ETM,
    // which chases the lab from the 27th; the day before, one day is left.
    expect(e.fenetre).toEqual({ depuis: '2026-11-10', echeance: '2026-11-27', jours: 12, ecoules: 12, depassee: true })
    expect(etudePartenaire(etude(), '2026-11-26')!.fenetre).toMatchObject({ ecoules: 11, depassee: false })
  })

  it('a relance of the lab restarts its clock', () => {
    const e = etudePartenaire(etude({ relances: [{ cible: 'labo', le: '20261125' }] }), TODAY)!
    expect(e.relanceLe).toBe('2026-11-25')
    expect(e.fenetre).toMatchObject({ depuis: '2026-11-25', echeance: '2026-12-12', depassee: false })
  })

  it('the client holds it: its time in words, never a clock of the lab’s', () => {
    const e = etudePartenaire(etude({ statut: 2, soumissions: [soum(1628, '20261105', 0)] }), TODAY)!
    expect(e).toMatchObject({ etape: 'chez_le_client', fenetre: null })
    expect(e.attenteReponse).toEqual({ soumisLe: '2026-11-05', reponseAttendueLe: '2026-11-26', relanceLe: null, relances: 0 })
    expect(e.soumissions).toEqual([{ id: 1628, version: 'v1', echantillons: [1, 2], soumiseLe: '2026-11-05', reponse: 'attente', reponduLe: null }])
    const relancee = etudePartenaire(etude({ statut: 2, soumissions: [soum(1628, '20261105', 0)], relances: [{ cible: 'client', le: '20261126' }, { cible: 'labo', le: '20261101' }] }), TODAY)!
    expect(relancee.attenteReponse).toEqual({ soumisLe: '2026-11-05', reponseAttendueLe: '2026-12-17', relanceLe: '2026-11-26', relances: 1 })
  })

  it('a refused soumission gives it back to the lab, from the day of the answer', () => {
    const e = etudePartenaire(etude({ statut: 2, soumissions: [soum(1627, '20261104', 2, '20261123', 'v1', '1-2-3')] }), TODAY)!
    expect(e.etape).toBe('a_refaire')
    expect(e.fenetre).toMatchObject({ depuis: '2026-11-23', echeance: '2026-12-10' })
    expect(e.soumissions[0]).toMatchObject({ reponse: 'refusee', reponduLe: '2026-11-23', echantillons: [1, 2, 3] })
    // …and the next soumission hands it to the client again.
    const v2 = etudePartenaire(etude({ statut: 2, soumissions: [soum(1627, '20261104', 2, '20261123'), soum(1634, '20261123', 0, null, 'v2', '4-5')] }), TODAY)!
    expect(v2.etape).toBe('chez_le_client')
    expect(v2.soumissions.map((s) => s.version)).toEqual(['v1', 'v2'])
  })

  it('accepted: the coloris created and the day; cancelled: not listed', () => {
    const e = etudePartenaire(etude({ statut: 3, colorisCree: '512 bleu chambray 63901/2', soumissions: [soum(1, '20261112', 1, '20261120')] }), TODAY)!
    expect(e).toMatchObject({ etape: 'acceptee', coloris: '512 bleu chambray 63901/2', accepteeLe: '2026-11-20', fenetre: null, attenteReponse: null })
    expect(etudePartenaire(etude({ statut: 4 }), TODAY)).toBeNull()
  })

  it('never sends what is Malterre’s own: only a known version and the sample numbers of a soumission', () => {
    const e = etudePartenaire(etude({ statut: 2, commentaire: 'SS 2027', soumissions: [soum(9, '20261105', 0, '00000000', 'CN', 'voir avec Marine 1-2')] }), TODAY)!
    expect(e.consigne).toBe('SS 2027')
    expect(e.soumissions[0]).toEqual({ id: 9, version: '', echantillons: [1, 2], soumiseLe: '2026-11-05', reponse: 'attente', reponduLe: null })
    expect(Object.keys(e).sort()).toEqual(['accepteeLe', 'attenteReponse', 'client', 'coloris', 'consigne', 'designation', 'etape', 'fenetre', 'id', 'recueLe', 'reference', 'relanceLe', 'soumissions'])
  })
})
