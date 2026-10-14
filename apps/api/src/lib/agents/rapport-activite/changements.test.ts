import { describe, expect, it } from 'vitest'
import { phrases } from './changements.js'
import { decrire, refsVides } from './libelles.js'
import { diffLignes } from '../../journal-activite.js'

describe('diffLignes', () => {
  it('keeps only the columns that moved, dates as YYYY-MM-DD', () => {
    const avant = { idligne: 9076, date_livraison: null, date_delai: null, sstatut: 'Attente_Delai', quantite: 1055.03, prix: 9.13 }
    const apres = { idligne: 9076, date_livraison: new Date('2026-11-10T00:00:00Z'), date_delai: new Date('2026-11-10T00:00:00Z'), sstatut: 'En_Cours', quantite: 1055.03, prix: 9.13 }
    expect(diffLignes(avant, apres)).toEqual({
      date_livraison: [null, '2026-11-10'],
      date_delai: [null, '2026-11-10'],
      sstatut: ['Attente_Delai', 'En_Cours'],
    })
  })

  it('{} when the save changed nothing — not null, which means « not known »', () => {
    expect(diffLignes({ a: 1, d: new Date('2026-10-13T00:00:00Z') }, { a: 1, d: new Date('2026-10-13T00:00:00Z') })).toEqual({})
  })
})

describe('phrases', () => {
  it('sst 9104 (2026-10-14): a délai typed and the relance cleared', () => {
    expect(phrases({ date_livraison: [null, '2026-11-10'], date_delai: [null, '2026-11-10'], sstatut: ['Attente_Delai', 'En_Cours'] }))
      .toEqual(['délai de livraison saisi au 10/11/2026', 'statut « Attente delai » → « En cours »'])
    expect(phrases({ date_notif: ['2026-10-14', null] })).toEqual(['date de relance effacée (était le 14/10/2026)'])
  })

  it('a délai moved says which way', () => {
    expect(phrases({ date_livraison: ['2026-11-10', '2026-11-03'] })).toEqual(['délai de livraison avancé du 10/11/2026 au 03/11/2026'])
    expect(phrases({ date_livraison: ['2026-11-10', '2026-11-17'] })).toEqual(['délai de livraison reculé du 10/11/2026 au 17/11/2026'])
  })

  it('texts, RTF unwrapped; an RTF-only rewrap says nothing', () => {
    expect(phrases({ commentaire: ['', 'urgent'] })).toEqual(['commentaire ajouté : « urgent »'])
    expect(phrases({ commentaire: ['{\\rtf1\\ansi urgent}', 'urgent'] })).toEqual([])
    expect(phrases({ journal: ['relancé', ''] })).toEqual(['note interne effacée (était « relancé »)'])
  })

  it('numbers, flags, links and an unknown column', () => {
    expect(phrases({ quantite: [1000, 1055.03] })).toEqual(['quantité 1000 → 1055,03'])
    expect(phrases({ est_soldee: [0, 1] })).toEqual(['commande soldée'])
    expect(phrases({ idadresse_livraison: [24, 25] })).toEqual(['adresse de livraison changée'])
    expect(phrases({ mode_livraison: [0, 2] })).toEqual(['mode de livraison « dès que prête » → « sur appel »'])
    expect(phrases({ nouvelle_colonne: ['a', 'b'] })).toEqual(['champ « nouvelle_colonne » modifié : « a » → « b »'])
  })
})

describe('decrire with changements', () => {
  const refs = () => {
    const r = refsVides()
    r.lignesSst.set(9076, 9104)
    r.commandesSst.set(9104, 12)
    r.sousTraitants.set(12, 'MATEL')
    r.articles.set('ligne_commande_sous_traitant:9076', 'EDF85/55 739 peau rosée')
    return r
  }

  it('names the line by its article and says what moved', () => {
    const d = decrire({
      methode: 'PUT', chemin: '/api/commandes-sous-traitant/lignes/9076', statut: 200,
      corps: '{"IDreference":8,"IDColoris":988,"quantite":1055.03,"prix":9.13,"date_livraison":"20261110"}',
      changements: { date_livraison: [null, '2026-11-10'], sstatut: ['Attente_Delai', 'En_Cours'] },
    }, refs())
    expect(d.texte).toBe('Commande sous-traitant N° 9104 (MATEL), ligne EDF85/55 739 peau rosée : délai de livraison saisi au 10/11/2026 ; statut « Attente delai » → « En cours »')
    expect(d.sansEffet).toBeFalsy()
  })

  it('the header sent along with the line, unchanged, is flagged to drop', () => {
    const d = decrire({ methode: 'PUT', chemin: '/api/commandes-sous-traitant/9104', statut: 200, corps: '{}', changements: {} }, refs())
    expect(d.sansEffet).toBe(true)
  })

  it('a row journaled before the capture says the detail is unknown', () => {
    const d = decrire({ methode: 'PUT', chemin: '/api/commandes-sous-traitant/9104', statut: 200, corps: '{"date_notif":""}', changements: null }, refs())
    expect(d.texte).toBe('Modification de la commande sous-traitant N° 9104 (MATEL) — formulaire enregistré, le détail de ce qui a changé n’est pas connu')
  })
})
