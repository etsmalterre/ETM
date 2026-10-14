import { describe, expect, it } from 'vitest'
import { avancementCommande, modeLivraisonDe, urgenceCommande, urgenceLigne, type LigneUrgence } from './urgence-commande-client.js'

const today = new Date(2026, 9, 8) // 08/10/2026
const dans = (j: number) => {
  const d = new Date(2026, 9, 8 + j)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}
const l = (etat: LigneUrgence['etat'], j: number | null, typeKind = 2): LigneUrgence =>
  ({ etat, typeKind, dateLivraison: j === null ? null : dans(j) })
const niveau = (x: LigneUrgence) => urgenceLigne(x, today)?.niveau ?? null

describe('urgenceLigne', () => {
  it('fini à lancer: rouge ≤ 35 j, ambre ≤ 56 j', () => {
    expect(niveau(l('a_lancer', 35))).toBe('rouge')
    expect(niveau(l('a_lancer', 36))).toBe('ambre')
    expect(niveau(l('a_lancer', 56))).toBe('ambre')
    expect(niveau(l('a_lancer', 57))).toBe(null)
  })
  it('écru à lancer: rouge ≤ 10 j, ambre ≤ 21 j', () => {
    expect(niveau(l('a_lancer', 10, 1))).toBe('rouge')
    expect(niveau(l('a_lancer', 21, 1))).toBe('ambre')
    expect(niveau(l('a_lancer', 22, 1))).toBe(null)
  })
  it('prête à expédier (and an unshipped divers line): rouge ≤ 3 j, ambre ≤ 10 j', () => {
    expect(niveau(l('pae', 3))).toBe('rouge')
    expect(niveau(l('pae', 10))).toBe('ambre')
    expect(niveau(l('pae', 11))).toBe(null)
    expect(niveau(l('a_lancer', 5, 3))).toBe('ambre')
    expect(niveau(l('a_lancer', 30, 3))).toBe(null)
  })
  it('a ready line 60+ days past its délai asks to ship or close', () => {
    expect(urgenceLigne(l('pae', -61), today)?.action).toBe('solder')
    expect(urgenceLigne(l('pae', -60), today)?.action).toBe('expedier')
  })
  it('in progress elsewhere is neutral until the délai has passed', () => {
    expect(niveau(l('tricotage', 0))).toBe(null)
    expect(niveau(l('ennoblisseur', 1))).toBe(null)
    expect(niveau(l('ennoblisseur', -1))).toBe('rouge')
    expect(niveau(l('tricotage', -1, 1))).toBe('rouge')
  })
  it('shipped or closed lines are always neutral, even late or without délai', () => {
    expect(niveau(l('expediee', -100))).toBe(null)
    expect(niveau(l('soldee', null))).toBe(null)
  })
  it('a line still to deliver without a délai is ambre', () => {
    expect(niveau(l('a_lancer', null))).toBe('ambre')
    expect(niveau(l('ennoblisseur', null))).toBe('ambre')
  })
})

describe('urgenceLigne: mode de livraison of a ready line', () => {
  const pae = (j: number, modeLivraison: LigneUrgence['modeLivraison'], exp: number | null = null): LigneUrgence =>
    ({ etat: 'pae', typeKind: 2, dateLivraison: dans(j), modeLivraison, dateExpedition: exp === null ? null : dans(exp) })

  it('« sur appel » is neutral until 4 months past the délai, then asks to chase the client', () => {
    expect(niveau(pae(-30, 'sur_appel'))).toBe(null)
    expect(niveau(pae(-120, 'sur_appel'))).toBe(null)
    expect(urgenceLigne(pae(-121, 'sur_appel'), today)).toMatchObject({ niveau: 'rouge', action: 'relancer' })
  })
  it('« sur appel » follows the client’s own relance delay, 0 = the default', () => {
    expect(niveau({ ...pae(-121, 'sur_appel'), relanceAppel: 180 })).toBe(null)
    expect(niveau({ ...pae(-181, 'sur_appel'), relanceAppel: 180 })).toBe('rouge')
    expect(niveau({ ...pae(-31, 'sur_appel'), relanceAppel: 30 })).toBe('rouge')
    expect(niveau({ ...pae(-121, 'sur_appel'), relanceAppel: 0 })).toBe('rouge')
    // only « sur appel » reads it
    expect(niveau({ ...pae(-5, 'des_que_prete'), relanceAppel: 365 })).toBe('rouge')
  })
  it('« date client » is judged on the agreed date, not on the délai', () => {
    expect(niveau(pae(-20, 'date_client', 30))).toBe(null)
    expect(niveau(pae(-20, 'date_client', 10))).toBe('ambre')
    expect(niveau(pae(-20, 'date_client', 3))).toBe('rouge')
    expect(urgenceLigne(pae(-90, 'date_client', -61), today)?.action).toBe('solder')
  })
  it('« date client » without a date falls back to the délai', () => {
    expect(niveau(pae(2, 'date_client'))).toBe('rouge')
  })
  it('the mode never changes the production stages, which run on the délai', () => {
    const lancer: LigneUrgence = { etat: 'a_lancer', typeKind: 2, dateLivraison: dans(20), modeLivraison: 'sur_appel' }
    expect(niveau(lancer)).toBe('rouge')
  })
  it('« commande complète » waits while another line is in production, then ships like « dès que prête »', () => {
    expect(niveau({ ...pae(-5, 'commande_complete'), commandeIncomplete: true })).toBe(null)
    expect(niveau(pae(-5, 'commande_complete'))).toBe('rouge')
    // the order: the ready line waits, the lagging line alone speaks
    expect(urgenceCommande([pae(-5, 'commande_complete'), l('ennoblisseur', 20)], today)).toBe(null)
    expect(urgenceCommande([pae(-5, 'commande_complete'), l('pae', 30), l('expediee', -40)], today)?.niveau).toBe('rouge')
    // a divers line not shipped yet is ready by nature: it never holds the order back
    expect(urgenceCommande([pae(-5, 'commande_complete'), { ...l('a_lancer', 30), typeKind: 3 }], today)?.niveau).toBe('rouge')
  })
  it('the reason names the date it is about', () => {
    expect(urgenceCommande([pae(-20, 'date_client', 2)], today)?.raison)
      .toBe(`1 ligne à expédier · expédition prévue ${dans(2).slice(6, 8)}/${dans(2).slice(4, 6)}`)
    expect(urgenceCommande([pae(-130, 'sur_appel')], today)?.raison)
      .toBe(`1 ligne sur appel : relancer le client · délai ${dans(-130).slice(6, 8)}/${dans(-130).slice(4, 6)} dépassé`)
  })
})

describe('modeLivraisonDe', () => {
  it('reads the smallint, anything unknown is « dès que prête »', () => {
    expect(modeLivraisonDe(0)).toBe('des_que_prete')
    expect(modeLivraisonDe(1)).toBe('date_client')
    expect(modeLivraisonDe('2')).toBe('sur_appel')
    expect(modeLivraisonDe(3)).toBe('commande_complete')
    expect(modeLivraisonDe(null)).toBe('des_que_prete')
    expect(modeLivraisonDe(9)).toBe('des_que_prete')
  })
})

describe('urgenceCommande', () => {
  it('is neutral when no line asks for anything (and for an order without lines)', () => {
    expect(urgenceCommande([l('tricotage', 20), l('expediee', -5)], today)).toBe(null)
    expect(urgenceCommande([], today)).toBe(null)
  })
  it('takes the most urgent line and counts every line sharing its action, whatever its level', () => {
    // 3900: 3 lines due in 29 j (rouge) + 3 in 50 j (ambre) are one launch
    const u = urgenceCommande([l('a_lancer', 50), l('a_lancer', 29), l('a_lancer', 29), l('ennoblisseur', 5)], today)
    expect(u).toEqual({ niveau: 'rouge', raison: `3 lignes à lancer · délai ${dans(29).slice(6, 8)}/${dans(29).slice(4, 6)}` })
  })
  it('red beats amber, and a passed délai says so', () => {
    const u = urgenceCommande([l('pae', 8), l('ennoblisseur', -6)], today)
    expect(u?.niveau).toBe('rouge')
    expect(u?.raison).toBe('1 ligne en ennoblissement en retard · délai 02/10 dépassé')
  })
  it('names lines without délai', () => {
    expect(urgenceCommande([l('a_lancer', null, 3), l('a_lancer', null, 3)], today))
      .toEqual({ niveau: 'ambre', raison: '2 lignes sans délai' })
  })
})

describe('avancementCommande', () => {
  it('is the least advanced line still to deliver', () => {
    expect(avancementCommande(['expediee', 'ennoblisseur', 'pae', 'expediee'], false)).toBe('ennoblisseur')
    expect(avancementCommande(['pae', 'a_lancer'], false)).toBe('a_lancer')
    expect(avancementCommande(['tricotage', 'ennoblisseur'], false)).toBe('tricotage')
  })
  it('is expédiée once every line left, soldée when closed, null without lines', () => {
    expect(avancementCommande(['expediee', 'expediee'], false)).toBe('expediee')
    expect(avancementCommande(['a_lancer'], true)).toBe('soldee')
    expect(avancementCommande([], true)).toBe('soldee')
    expect(avancementCommande([], false)).toBe(null)
  })
})
