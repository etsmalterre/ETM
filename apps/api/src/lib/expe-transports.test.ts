import { describe, it, expect } from 'vitest'
import type { Depart } from './expe-departs.js'
import { cleGroupe, grouperEnTransports, statutDe } from './expe-transports.js'

const MATEL = { id: 9, nom: 'MATEL' }
const USINE = { id: 0, nom: 'Usine' }

function depart(id: number, plus: Partial<Depart> = {}): Depart {
  return {
    cle: `formelle-${id}`, kind: 'formelle', id, date: '2026-11-20', idclient: 7, client: 'Lemahieu',
    commande_numero: 4521, lieu: MATEL, idadresse: 12,
    destination: { nom: 'Lemahieu', adresse1: '', adresse2: '', adresse3: '', cp: '59280', ville: 'Armentières', pays: 'France', a_definir: false },
    idtransporteur: 0, transporteur: '', idenvoi: null, numero_suivi: '', nb_colis: 3, poids: 60, metrage: 300, facture: false, envoye_le: null, destinataires: 0, ...plus,
  }
}

describe('expe transports', () => {
  it('puts in one transport the avis of a day for one client, one address, one place', () => {
    const t = grouperEnTransports([depart(101), depart(100), depart(102, { nb_colis: 1, poids: 20 })])
    expect(t).toHaveLength(1)
    expect(t[0].avis.map((a) => a.id)).toEqual([100, 101, 102])
    expect(t[0]).toMatchObject({ client: 'Lemahieu', lieu: MATEL, nb_rouleaux: 7, nb_cartons: 0, poids: 140 })
  })

  it('separates another day, another client, another address or another place', () => {
    const t = grouperEnTransports([
      depart(100),
      depart(101, { date: '2026-11-19' }),
      depart(102, { idclient: 8, client: 'Thuasne' }),
      depart(103, { idadresse: 13 }),
      depart(104, { lieu: USINE }),
    ])
    expect(t).toHaveLength(5)
  })

  it('never groups what has no destination, no client or no known place', () => {
    expect(cleGroupe(depart(1))).toBe('2026-11-20_c7_a12_l9')
    expect(cleGroupe(depart(1, { idadresse: 0, destination: null }))).toBeNull()
    expect(cleGroupe(depart(1, { idadresse: 795, destination: { ...depart(1).destination!, a_definir: true } }))).toBeNull()
    expect(cleGroupe(depart(1, { idclient: 0 }))).toBeNull()
    expect(cleGroupe(depart(1, { lieu: { id: null, nom: 'Lieu à préciser' } }))).toBeNull()
    const t = grouperEnTransports([depart(1, { idadresse: 0, destination: null }), depart(2, { idadresse: 0, destination: null })])
    expect(t).toHaveLength(2)
  })

  it('keeps together the avis recorded in one envoi, whatever the computed rule says', () => {
    const t = grouperEnTransports([
      depart(100, { idenvoi: 7, numero_suivi: 'JD0146' }),
      // Another day and another address: left in the same truck all the same.
      depart(101, { idenvoi: 7, numero_suivi: 'JD0146', date: '2026-11-19', idadresse: 13 }),
      // Same day, client, address and place, but not in the envoi: apart.
      depart(102),
    ])
    expect(t).toHaveLength(2)
    const parti = t.find((x) => x.idenvoi === 7)!
    expect(parti.avis.map((a) => a.id)).toEqual([100, 101])
    expect(parti.numero_suivi).toBe('JD0146')
    expect(t.find((x) => x.idenvoi === null)!.avis.map((a) => a.id)).toEqual([102])
    // An avis that never groups by computation (no address) still follows its envoi.
    expect(cleGroupe(depart(1, { idenvoi: 7, idadresse: 0, destination: null }))).toBe('envoi7_l9')
  })

  it('gives the carrier of a transport only when every avis names the same one', () => {
    const [un] = grouperEnTransports([depart(100, { idtransporteur: 4, transporteur: 'DPD' }), depart(101, { idtransporteur: 4, transporteur: 'DPD' })])
    expect(un).toMatchObject({ idtransporteur: 4, transporteur: 'DPD' })
    const [deux] = grouperEnTransports([depart(100, { idtransporteur: 4, transporteur: 'DPD' }), depart(101)])
    expect(deux.idtransporteur).toBe(0)
  })

  it('counts rolls and cartons apart when an avis divers travels with an avis', () => {
    const t = grouperEnTransports([
      depart(100, { lieu: USINE }),
      depart(652, { cle: 'divers-652', kind: 'divers', lieu: USINE, nb_colis: 2, poids: 0 }),
    ])
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ nb_rouleaux: 3, nb_cartons: 2, poids: 60 })
  })

  it('is ready to leave once every avis has been e-mailed, in preparation before', () => {
    expect(statutDe([{ envoye_le: null }])).toBe('en_preparation')
    expect(statutDe([{ envoye_le: '2026-11-20 10:00:00' }, { envoye_le: null }])).toBe('en_preparation')
    expect(statutDe([{ envoye_le: '2026-11-20 10:00:00' }, { envoye_le: '2026-11-20 16:30:00' }])).toBe('pret_a_partir')
    const [pret] = grouperEnTransports([
      depart(100, { envoye_le: '2026-11-20 10:00:00' }), depart(101, { envoye_le: '2026-11-20 16:30:00' }),
    ])
    expect(pret.statut).toBe('pret_a_partir')
    expect(pret.pret_le).toBe('2026-11-20 16:30:00')
    const [prepa] = grouperEnTransports([depart(100, { envoye_le: '2026-11-20 10:00:00' }), depart(101)])
    expect(prepa.statut).toBe('en_preparation')
    expect(prepa.pret_le).toBeNull()
  })

  it('names the carrier only when every avis names the same one', () => {
    expect(grouperEnTransports([depart(1, { transporteur: 'DPD' }), depart(2, { transporteur: 'DPD' })])[0].transporteur).toBe('DPD')
    expect(grouperEnTransports([depart(1, { transporteur: 'DPD' }), depart(2)])[0].transporteur).toBe('DPD')
    expect(grouperEnTransports([depart(1, { transporteur: 'DPD' }), depart(2, { transporteur: 'UPS' })])[0].transporteur).toBe('')
  })

  it('lists the most recent transport first', () => {
    const t = grouperEnTransports([depart(100, { date: '2026-11-18' }), depart(105, { date: '2026-11-21' })])
    expect(t.map((x) => x.date)).toEqual(['2026-11-21', '2026-11-18'])
  })
})
