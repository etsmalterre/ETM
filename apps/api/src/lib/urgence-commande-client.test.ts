import { describe, expect, it } from 'vitest'
import { avancementCommande, etatAffiche, modeLivraisonDe, urgenceCommande, urgenceLigne, type LigneUrgence } from './urgence-commande-client.js'

const today = new Date(2026, 9, 8) // 08/10/2026
const dans = (j: number) => {
  const d = new Date(2026, 9, 8 + j)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}
const l = (etat: LigneUrgence['etat'], j: number | null, typeKind = 2): LigneUrgence =>
  ({ etat, typeKind, dateLivraison: j === null ? null : dans(j) })
const niveau = (x: LigneUrgence) => urgenceLigne(x, today)?.niveau ?? null

describe('urgenceLigne', () => {
  it('écru / fini à lancer is rouge whatever the délai: reserving the yarn or launching is ours now', () => {
    expect(niveau(l('a_lancer', 35))).toBe('rouge')
    expect(niveau(l('a_lancer', 200))).toBe('rouge')
    expect(niveau(l('a_lancer', 200, 1))).toBe('rouge')
    expect(niveau(l('a_lancer', -5, 1))).toBe('rouge')
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
  it('a line still to deliver without a délai is rouge: giving one is ours to do now', () => {
    expect(niveau(l('a_lancer', null))).toBe('rouge')
    expect(niveau(l('ennoblisseur', null))).toBe('rouge')
  })
  it('a line waiting for reserved yarn is neutral while the supplier is in time, then asks to chase it', () => {
    // 3911 bleu 1721: délai in 49 days, red « à lancer » until the yarn is reserved on order 723, due in 13 days
    expect(niveau(l('a_lancer', 49))).toBe('rouge')
    expect(niveau({ ...l('attente_fil', 49), filAttenduLe: dans(13) })).toBe(null)
    expect(niveau({ ...l('attente_fil', 49), filAttenduLe: dans(0) })).toBe(null)
    expect(niveau({ ...l('attente_fil', 49), filAttenduLe: dans(-1) })).toBe('rouge')
    expect(niveau({ ...l('attente_fil', 49), filAttenduLe: null })).toBe('rouge')
    expect(niveau({ ...l('attente_fil', null), filAttenduLe: dans(13) })).toBe('rouge') // no client délai: give one
    expect(urgenceCommande([{ ...l('attente_fil', 49), filAttenduLe: dans(-3) }], today)?.raison)
      .toBe(`1 ligne en attente de fil : relancer le fournisseur`)
  })
  it('a line « à lancer » held by a launch date is neutral before it, red from it', () => {
    const held = (lancement: number, delai: number | null = 60, etat: LigneUrgence['etat'] = 'a_lancer'): LigneUrgence =>
      ({ ...l(etat, delai), lancementLe: dans(lancement) })
    expect(niveau(held(5))).toBe(null)
    expect(niveau(held(1))).toBe(null)
    expect(niveau(held(0))).toBe('rouge')
    expect(niveau(held(-3))).toBe('rouge')
    expect(urgenceCommande([held(-3)], today)?.raison)
      .toBe(`1 ligne à lancer`)
    // the date only holds a line still to launch, never one without a délai or already launched
    expect(niveau(held(10, null))).toBe('rouge')
    expect(niveau(held(10, -2, 'tricotage'))).toBe('rouge')
    expect(niveau({ ...held(10, 49, 'attente_fil'), filAttenduLe: dans(-1) })).toBe('rouge')
    expect(niveau({ ...l('a_lancer', 60), lancementLe: 'n/a' })).toBe('rouge')
  })
  it('the step planned names the action of the red reason', () => {
    const held = (etape: LigneUrgence['lancementEtape']): LigneUrgence => ({ ...l('a_lancer', 60), lancementLe: dans(-2), lancementEtape: etape })
    expect(urgenceCommande([held('ennoblissement')], today)?.raison).toBe(`1 ligne à ennoblir`)
    expect(urgenceCommande([held('tricotage'), held('tricotage')], today)?.raison).toBe(`2 lignes à tricoter`)
    expect(urgenceCommande([held('fil')], today)?.raison).toBe(`1 ligne : fil à commander`)
    expect(niveau({ ...held('ennoblissement'), lancementLe: dans(3) })).toBe(null)
  })
  it('a launch date planned too late is red now: the delay is already known (3892, 2026-10-30)', () => {
    const held = (prete: number | null): LigneUrgence => ({ ...l('a_lancer', 80), lancementLe: dans(70), lancementEtape: 'ennoblissement', preteSiLanceLe: prete == null ? null : dans(prete) })
    expect(niveau(held(95))).toBe('rouge')
    expect(niveau(held(80))).toBe(null)
    expect(niveau(held(null))).toBe(null)
    expect(urgenceCommande([held(95)], today)?.raison)
      .toBe(`1 ligne planifiée trop tard`)
    // the displayed état stays « planifiée »: the pill says where it stands, the liseré what to do
    expect(etatAffiche('a_lancer', 2, dans(70), today)).toBe('planifiee')
  })
  it('a line waiting for its étude shows who holds it, before « à lancer » on the order (3904, 2026-10-30)', () => {
    expect(etatAffiche('a_lancer', 2, null, today, { attente: 'client' })).toBe('etude_client')
    expect(etatAffiche('a_lancer', 2, null, today, { attente: 'labo' })).toBe('etude_labo')
    expect(etatAffiche('a_lancer', 2, null, today, { attente: 'acceptee' })).toBe('a_lancer')
    expect(etatAffiche('tricotage', 2, null, today, { attente: 'client' })).toBe('tricotage')
    expect(avancementCommande(['ennoblisseur', 'ennoblisseur', 'etude_client', 'etude_client'], false)).toBe('etude_client')
    expect(avancementCommande(['a_lancer', 'etude_labo'], false)).toBe('etude_labo')
  })
  it('a line in étude coloris asks no délai, only a relance once it is due', () => {
    const e = (attente: 'labo' | 'client' | 'acceptee' | 'annulee', j: number | null, delai: number | null = null): LigneUrgence =>
      ({ ...l('a_lancer', delai), etude: { attente, relanceLe: j === null ? null : dans(j) } })
    expect(niveau(e('labo', 3))).toBe(null)
    expect(niveau(e('labo', 3, 5))).toBe(null) // a délai typed anyway is not judged
    expect(niveau(e('client', 1))).toBe(null)
    expect(niveau(e('client', 0))).toBe('rouge')
    expect(niveau(e('labo', -4))).toBe('rouge')
    expect(niveau(e('annulee', null))).toBe('rouge')
    expect(niveau(e('acceptee', null))).toBe('rouge')
    expect(niveau({ ...e('labo', -4), etat: 'expediee' })).toBe(null)
    expect(urgenceCommande([e('client', -2), l('a_lancer', 80)], today))
      .toEqual({ niveau: 'rouge', raison: `1 ligne en étude coloris : relancer le client` })
  })
})

describe('urgenceLigne: mode de livraison of a ready line', () => {
  const pae = (j: number, modeLivraison: LigneUrgence['modeLivraison']): LigneUrgence =>
    ({ etat: 'pae', typeKind: 2, dateLivraison: dans(j), modeLivraison })

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
  it('« date convenue » ships ON its date D (one date per line, 2026-10-28): red near it, never amber', () => {
    expect(niveau(pae(30, 'date_client'))).toBe(null)
    expect(niveau(pae(10, 'date_client'))).toBe(null)
    expect(niveau(pae(3, 'date_client'))).toBe('rouge')
    expect(urgenceLigne(pae(-61, 'date_client'), today)?.action).toBe('solder')
  })
  it('« date demandée » is judged on the client’s date, not on D', () => {
    expect(niveau({ ...pae(-20, 'date_client'), dateClient: dans(30) })).toBe(null)
    expect(niveau({ ...pae(-20, 'date_client'), dateClient: dans(2) })).toBe('rouge')
  })
  it('« ensemble » holds a ready line whatever the départ, while another is in production', () => {
    expect(niveau({ ...pae(-5, 'des_que_prete'), groupee: true, commandeIncomplete: true })).toBe(null)
    expect(niveau({ ...pae(2, 'date_client'), groupee: true, commandeIncomplete: true })).toBe(null)
    expect(niveau({ ...pae(-5, 'des_que_prete'), groupee: true })).toBe('rouge')
  })
  it('« date convenue » without its date is a line without date: red, give one', () => {
    expect(urgenceLigne({ etat: 'pae', typeKind: 2, dateLivraison: null, modeLivraison: 'date_client' }, today)?.action).toBe('sans_delai')
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
  it('the reason names the action only, never a date (the card orients, Vincent 2026-10-30)', () => {
    expect(urgenceCommande([pae(2, 'date_client')], today)?.raison)
      .toBe(`1 ligne à expédier`)
    expect(urgenceCommande([pae(-130, 'sur_appel')], today)?.raison)
      .toBe(`1 ligne sur appel : relancer le client`)
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
    expect(u).toEqual({ niveau: 'rouge', raison: `3 lignes à lancer` })
  })
  it('red beats amber, and a passed délai says so', () => {
    const u = urgenceCommande([l('pae', 8), l('ennoblisseur', -6)], today)
    expect(u?.niveau).toBe('rouge')
    expect(u?.raison).toBe('1 ligne en ennoblissement en retard')
  })
  it('names lines without délai', () => {
    expect(urgenceCommande([l('a_lancer', null, 3), l('a_lancer', null, 3)], today))
      .toEqual({ niveau: 'rouge', raison: '2 lignes sans délai : en donner un' })
  })
})

describe('avancementCommande', () => {
  it('is the least advanced line still to deliver', () => {
    expect(avancementCommande(['expediee', 'ennoblisseur', 'pae', 'expediee'], false)).toBe('ennoblisseur')
    expect(avancementCommande(['pae', 'a_lancer'], false)).toBe('a_lancer')
    expect(avancementCommande(['tricotage', 'ennoblisseur'], false)).toBe('tricotage')
    expect(avancementCommande(['tricotage', 'attente_fil'], false)).toBe('attente_fil')
    expect(avancementCommande(['attente_fil', 'a_lancer'], false)).toBe('a_lancer')
  })
  it('is expédiée once every line left, soldée when closed, null without lines', () => {
    expect(avancementCommande(['expediee', 'expediee'], false)).toBe('expediee')
    expect(avancementCommande(['a_lancer'], true)).toBe('soldee')
    expect(avancementCommande([], true)).toBe('soldee')
    expect(avancementCommande([], false)).toBe(null)
  })
})

describe('etatAffiche: « planifiée » (Vincent 2026-10-28)', () => {
  const today = new Date(2026, 9, 28)
  it('shows a line to launch held by a date still to come as planifiée', () => {
    expect(etatAffiche('a_lancer', 2, '20261116', today)).toBe('planifiee')
  })
  it('is à lancer again from the date on', () => {
    expect(etatAffiche('a_lancer', 2, '20261028', today)).toBe('a_lancer')
    expect(etatAffiche('a_lancer', 2, '20261020', today)).toBe('a_lancer')
  })
  it('leaves any other état, a divers line and a line without date alone', () => {
    expect(etatAffiche('tricotage', 2, '20261116', today)).toBe('tricotage')
    expect(etatAffiche('a_lancer', 3, '20261116', today)).toBe('a_lancer')
    expect(etatAffiche('a_lancer', 1, null, today)).toBe('a_lancer')
  })
  it('ranks just above à lancer on the order scale', () => {
    expect(avancementCommande(['planifiee', 'a_lancer'], false)).toBe('a_lancer')
    expect(avancementCommande(['planifiee', 'tricotage'], false)).toBe('planifiee')
  })
  it('a planifiée line is neutral', () => {
    expect(urgenceLigne({ etat: 'planifiee', typeKind: 2, dateLivraison: '20261001' }, today)).toBeNull()
  })
})
