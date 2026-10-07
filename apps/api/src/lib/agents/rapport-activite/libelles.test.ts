import { describe, expect, it } from 'vitest'
import { decrire, idsAResoudre, refsVides, regrouper, type Refs } from './libelles.js'
import { PROMPT_V1, PROMPT_V2 } from './prompt.js'

// The real case of 2026-10-07 (prod ids).
const refs = (): Refs => {
  const r = refsVides()
  r.commandes.set(7001, { numero: '3762', client: 'LEMAHIEU' })
  r.lignesSst.set(9066, 9094)
  r.commandesSst.set(9094, 9)
  r.commandesSst.set(9013, 9)
  r.sousTraitants.set(9, 'MATEL')
  r.ecru.set(57912, '3510/11')
  return r
}

describe('decrire', () => {
  it('a released reservation reads with on-screen numbers and is not a deletion', () => {
    const d = decrire({ methode: 'DELETE', chemin: '/api/commandes-client/7001/lignes/12856/supply/ennoblissement/9066/rolls/57912', corps: null }, refs())
    expect(d).toMatchObject({
      texte: 'Libération de la pièce 3510/11, réservée pour la commande client N° 3762 (LEMAHIEU) — ennoblissement commande sous-traitant N° 9094 (MATEL)',
      retrait: true,
      connue: true,
    })
  })
  it('a run of the same action on several pieces becomes one line with the count', () => {
    const r = refs()
    ;[1, 2, 3, 4, 5, 6, 7].forEach((i) => r.ecru.set(100 + i, `3599/${i}`))
    const t = Date.parse('2026-10-07T09:52:00+02:00')
    const run = [107, 103, 101, 102, 104, 105, 106].map((p, i) => ({
      ...decrire({ methode: 'DELETE', chemin: `/api/commandes-client/7001/lignes/12856/supply/ennoblissement/9066/rolls/${p}`, corps: null }, r),
      le: new Date(t + i * 1000),
      statut: 200,
    }))
    const autre = { ...decrire({ methode: 'DELETE', chemin: '/api/devis/9', corps: null }, r), le: new Date(t + 9000), statut: 200 }
    const g = regrouper([...run, autre])
    expect(g.map((x) => [x.n, x.texte])).toEqual([
      [7, 'Libération de 7 pièces (3599/1, 3599/2 … 3599/6, 3599/7), réservées pour la commande client N° 3762 (LEMAHIEU) — ennoblissement commande sous-traitant N° 9094 (MATEL)'],
      [1, 'Suppression — devis › 9'],
    ])
  })
  it('a finished roll received says number, weight, length, lot and defects', () => {
    const corps = JSON.stringify({ lot: 'MA109303', IDstock_ecru: 57065, numero: '3560/22', poids: 20.2, metrage: 30, observation_sst: '10 salissures' })
    expect(decrire({ methode: 'POST', chemin: '/api/commandes-sous-traitant/9013/lignes/8986/pieces/fini', corps }, refs()).texte).toBe(
      'Réception du rouleau fini 3560/22 (20,2 kg, 30 m) — commande sous-traitant N° 9013 (MATEL), lot MA109303 — défauts : 10 salissures',
    )
  })
  it('counts a shortened id list and names the stores of a transfer', () => {
    const r = refs()
    expect(decrire({ methode: 'PUT', chemin: '/api/transferts/rouleaux/4465/pieces', corps: '{"type":"ecru","stockIds":[1,2,3,4,5,6,"… 6 de plus"]}' }, r).texte).toBe(
      'Bon de transfert N° 4465 : 12 pièces',
    )
    expect(decrire({ methode: 'POST', chemin: '/api/transferts/rouleaux', corps: '{"IDmagasin_source":0,"IDmagasin_destination":9}' }, r).texte).toBe(
      'Création d’un bon de transfert Malterre → MATEL',
    )
  })
  it('an unknown route keeps its path, a missing name its id', () => {
    expect(decrire({ methode: 'DELETE', chemin: '/api/devis/9', corps: null }, refsVides())).toMatchObject({ texte: 'Suppression — devis › 9', retrait: false, connue: false })
    expect(decrire({ methode: 'PUT', chemin: '/api/commandes-client/5', corps: null }, refsVides()).texte).toBe('Modification de l’en-tête de la commande client #5')
  })
})

describe('idsAResoudre', () => {
  it('from the path and the body', () => {
    const ids = idsAResoudre([
      { chemin: '/api/commandes-client/7001/lignes/12856/supply/ennoblissement/9066/rolls/57912', corps: null },
      { chemin: '/api/commandes-client/7166/lignes/1/supply/ennoblissement/orders', corps: '{"IDsous_traitant":9,"stockEcruIds":[57804,57807]}' },
    ])
    expect([...ids.commandes]).toEqual([7001, 7166])
    expect([...ids.lignesSst]).toEqual([9066])
    expect([...ids.pieces]).toEqual([57912, 57804, 57807])
    expect([...ids.sousTraitants]).toEqual([9])
  })
})

describe('prompt v2', () => {
  it('every v1 sentence it rewrites was found', () => {
    expect(PROMPT_V2).not.toBe(PROMPT_V1)
    expect(PROMPT_V2).toContain('environ toutes les heures')
    expect(PROMPT_V2).toContain('2 à 5 phrases')
    expect(PROMPT_V2).toContain('pas une suppression')
    expect(PROMPT_V2).toContain('Une période sans rien de notable')
  })
})
