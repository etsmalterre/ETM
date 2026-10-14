import { describe, expect, it } from 'vitest'
import { decrire, idsAResoudre, refsVides, regrouper, type Refs } from './libelles.js'
import { PROMPT_V1, PROMPT_V3 } from './prompt.js'

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
    expect(decrire({ methode: 'PUT', chemin: '/api/commandes-client/5', corps: null }, refsVides()).texte).toBe('Modification de la commande client #5 — formulaire enregistré, le détail de ce qui a changé n’est pas connu')
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

describe('prompt v3', () => {
  it('a whole text, the points Vincent found too severe written out', () => {
    expect(PROMPT_V3).not.toBe(PROMPT_V1)
    expect(PROMPT_V3).toContain('environ toutes les heures')
    expect(PROMPT_V3).toContain('Le ton amical')
    expect(PROMPT_V3).toContain('Un mail pas encore répondu')
    expect(PROMPT_V3).toContain('0 à 3')
    expect(PROMPT_V3).not.toContain('sans_reponse')
  })
})

describe('Point sous-traitant', () => {
  it('a line removed from the point is a removal, not a deletion', () => {
    const d = decrire({ methode: 'DELETE', chemin: '/api/points-sst/1/lignes/7', corps: null }, refsVides())
    expect(d.connue).toBe(true)
    expect(d.retrait).toBe(true)
    expect(decrire({ methode: 'POST', chemin: '/api/points-sst/1/lignes/20/retour', corps: '{"texte":"DATE DE RELANCE 08/10"}' }, refsVides()).texte).toContain('DATE DE RELANCE 08/10')
  })
})

// 2026-10-14: the routes the model read as raw JSON — real bodies from the prod journal.
describe('routes labelled on 2026-10-14', () => {
  it('a quality dossier says its description AND the FNC text, never the free « journal » note', () => {
    const corps = JSON.stringify({
      description: 'Traces d’huile importante sur 90 % des pièces',
      journal: 'Traces d’huile importante sur toutes les pièces',
      reference: '3576/1',
      message_fnc: 'Traces d’huile importante sur toutes les pièces',
      fnc_resolution: '',
      envoi_fnc: '20261014',
    })
    const d = decrire({ methode: 'PUT', chemin: '/api/dossiers-qualite/191', corps }, refsVides())
    expect(d.connue).toBe(true)
    expect(d.texte).toBe(
      'Modification du dossier qualité N° 191 (pièce 3576/1) : description « Traces d’huile importante sur 90 % des pièces » ; texte de la FNC « Traces d’huile importante sur toutes les pièces »',
    )
    expect(d.texte).not.toContain('journal')
  })
  it('a yarn order line names the yarn, quantity and price; the order its supplier', () => {
    const r = refsVides()
    r.refsFil.set(16, '160 ELASTHANNE')
    r.lignesFil.set(1000, 721)
    r.commandesFil.set(721, 50)
    r.fournisseurs.set(50, 'FILMATECH')
    expect(decrire({ methode: 'POST', chemin: '/api/commandes-fil/721/lignes', corps: '{"IDref_fil":16,"IDcolori_fil":295,"quantite":26,"prix_unitaire":5.5,"date_livraison":""}' }, r).texte).toBe(
      'Ajout d’une ligne à la commande de fil N° 721 (FILMATECH) : fil « 160 ELASTHANNE » (26 kg, 5,5 €/kg)',
    )
    expect(decrire({ methode: 'DELETE', chemin: '/api/commandes-fil/lignes/1000', corps: null }, r).texte).toBe('Suppression d’une ligne de la commande de fil N° 721 (FILMATECH)')
    expect(decrire({ methode: 'PUT', chemin: '/api/commandes-fil/720', corps: '{"date_commande":"20261014","commentaire":"48 cônes de 550 g","journal":"pour 263","IDadresse_fournisseur":1584}' }, r).texte).toBe(
      'Modification de la commande de fil N° 720 (commentaire « 48 cônes de 550 g », note interne « pour 263 ») — formulaire enregistré, le détail de ce qui a changé n’est pas connu',
    )
  })
  it('a colour study reads its date as a date, the client and the dyer by name', () => {
    const r = refsVides()
    r.clients.set(111, 'LE TEESHIRT PROPRE')
    r.refsFini.set(639, '029A')
    r.sousTraitants.set(9, 'MATEL')
    expect(
      decrire({ methode: 'POST', chemin: '/api/etudes-coloris', corps: '{"IDclient":111,"IDref_fini":639,"IDref_fini_colori":0,"IDsous_traitant":9,"libelle":"1210 cerise 19-1955 tcx","date_reception_type":"20261012"}' }, r).texte,
    ).toBe('Création de l’étude coloris « 1210 cerise 19-1955 tcx » pour LE TEESHIRT PROPRE (réf. fini 029A, chez MATEL, type reçu le 12/10/2026)')
  })
  it('Simone Pérèle measures name each roll by its numero', () => {
    const r = refsVides()
    r.lignesClient.set(13001, 7300)
    r.commandes.set(7300, { numero: '3870', client: 'SIMONE PERELE' })
    r.fini.set(50951, '3554/1')
    expect(decrire({ methode: 'PUT', chemin: '/api/etiquettes-sp/lignes/13001', corps: '{"rolls":[{"id":50951,"brut":105.9,"net":105.7,"laizeCm":161,"tare":2,"poids":19}]}' }, r).texte).toBe(
      'Étiquettes Simone Pérèle de la commande client N° 3870 (SIMONE PERELE) : mesures de 1 rouleau (3554/1 105,9 m brut, 105,7 m net, 161 cm de laize)',
    )
  })
  it('a BL checked from Tricobot says whether anything was corrected', () => {
    const r = refsVides()
    r.lignesSst.set(9042, 9070)
    r.commandesSst.set(9070, 9)
    r.sousTraitants.set(9, 'MATEL')
    expect(decrire({ methode: 'PUT', chemin: '/api/tricobot/bl-reception', corps: '{"ligneId":9042,"lots":[{"lot":"MA109487","corrections":"[0 éléments]"}],"commentaire":""}' }, r).texte).toBe(
      'Réception d’un BL pré-rempli par Tricobot (lot MA109487, commande sous-traitant N° 9070 (MATEL)) : sans correction',
    )
  })
  it('a price simulation says nothing is changed', () => {
    expect(decrire({ methode: 'POST', chemin: '/api/tarifs-fini/12/preview', corps: null }, refsVides()).texte).toContain('rien n’est modifié')
  })
  it('the new ids are collected from path and body', () => {
    const ids = idsAResoudre([
      { chemin: '/api/commandes-fil/lignes/1000', corps: null },
      { chemin: '/api/commandes-fil/721/lignes', corps: '{"IDref_fil":16}' },
      { chemin: '/api/etudes-coloris', corps: '{"IDclient":111,"IDref_fini":639}' },
      { chemin: '/api/tricobot/bl-reception', corps: '{"ligneId":9042}' },
      { chemin: '/api/factures/def/9290/email', corps: null },
    ])
    expect([...ids.lignesFil]).toEqual([1000])
    expect([...ids.commandesFil]).toEqual([721])
    expect([...ids.refsFil]).toEqual([16])
    expect([...ids.clients]).toEqual([111])
    expect([...ids.refsFini]).toEqual([639])
    expect([...ids.lignesSst]).toEqual([9042])
    expect([...ids.factures]).toEqual([9290])
  })
})
