import { describe, expect, it } from 'vitest'
import { mailRelanceRetard, retardCalme } from './relance-retard-sst.js'
import { mailRelanceGroupee, nombreDossiers, type DossiersARelancer } from './relance-groupee-sst.js'
import { etatCommande, urgenceCommande, type CommandeFait } from './cycle-ennoblissement.js'
import { urgenceTricotage, type CommandeTricotage } from './sst-tricotage.js'

describe('a passed délai chased by mail', () => {
  it('is calm the day of the relance, red again the next working day', () => {
    // Friday 27/11: chased; Monday 30/11 it is ours to chase again.
    expect(retardCalme(['2026-11-27'], '2026-11-27', '2026-11-27')).toBe(true)
    expect(retardCalme(['2026-11-27'], '2026-11-27', '2026-11-28')).toBe(true)
    expect(retardCalme(['2026-11-27'], '2026-11-27', '2026-11-30')).toBe(false)
  })
  it('a relance older than the délai in place counts for nothing (a new délai was given since)', () => {
    expect(retardCalme(['2026-11-20'], '2026-11-27', '2026-11-27')).toBe(false)
    expect(retardCalme([], '2026-11-27', '2026-11-27')).toBe(false)
    expect(retardCalme(undefined, '2026-11-27', '2026-11-27')).toBe(false)
  })

  // A dyer order « en traitement » whose only line was due on 27/11.
  const commande = (relancesRetard?: string[]): CommandeFait => ({
    est_soldee: false, rangStatut: 2, delai: '2026-11-27', delaisLignes: ['2026-11-27'],
    lignesOuvertes: [{ id: 1, delai: '2026-11-27' }], lots: [], ecruChezTeinturier: 3,
    ...(relancesRetard ? { relancesRetard } : {}),
  })
  it('the dyer order: red on its délai, calm once chased, red the next working day', () => {
    expect(urgenceCommande(etatCommande(commande()), '2026-11-27')).toBe('late')
    expect(urgenceCommande(etatCommande(commande(['2026-11-27'])), '2026-11-27')).toBeNull()
    expect(urgenceCommande(etatCommande(commande(['2026-11-27'])), '2026-11-30')).toBe('late')
  })

  const tricot: CommandeTricotage = {
    est_soldee: false, trm: false, trm_soldee: false,
    lignes: [{ id: 1, type: 1, quantite: 100, date_livraison: '20261127', rang_statut: 2, fil_affecte: true, a_un_of: true, kg_tricote: 10, kg_livre: 0 }],
  }
  it('the knitting order reads the same', () => {
    const le = (j: number) => new Date(2026, 10, j)
    expect(urgenceTricotage(tricot, 'en_tricotage', null, le(27))).toBe('late')
    expect(urgenceTricotage(tricot, 'en_tricotage', null, le(27), ['2026-11-27'])).toBeNull()
    expect(urgenceTricotage(tricot, 'en_tricotage', null, le(30), ['2026-11-27'])).toBe('late')
  })

  it('its mail asks for a new délai', () => {
    const m = mailRelanceRetard({ numero: 9120, articles: 'E1732 - Noir', delai: '2026-11-27', derniereRelance: null })
    expect(m.subject).toBe('Relance — Délai dépassé de notre commande N°9120 — ETS Malterre')
    expect(m.body).toContain('Notre commande N°9120 (E1732 - Noir) était prévue pour le 27/11/2026 et nous ne l’avons pas reçue.')
    expect(m.body).toContain('Pouvez-vous nous donner un nouveau délai ?')
    expect(mailRelanceRetard({ numero: 9120, articles: null, delai: '2026-11-27', derniereRelance: '2026-11-30' }).body)
      .toContain('et malgré notre relance du 30/11/2026, nous ne l’avons pas reçue.')
  })
})

describe('the grouped relance of a sous-traitant', () => {
  const d: DossiersARelancer = {
    retards: [{ commande: 9120, articles: 'E1732 - Noir', delai: '2026-11-27' }],
    urgences: [{ commande: 9161, ligne: 1, article: '176A - marine', dateSouhaitee: '2026-12-01', demandeeLe: '2026-11-24' }],
    delais: [{ commande: 9183, articles: '224A - bleu', commandeLe: '2026-11-24' }],
    controles: [{ idsuivilot: 5, commande: 9100, lot: 'TA532110', article: '180B - écru', recuLe: '2026-11-17', manque: ['laize', 'poids', 'stabilités'] }],
  }
  it('one block per kind of answer we wait for, the passed délais first', () => {
    const m = mailRelanceGroupee(d)
    expect(nombreDossiers(d)).toBe(4)
    expect(m.subject).toBe('Relance — 4 dossiers en attente — ETS Malterre')
    expect(m.body).toContain('Un nouveau délai, le délai prévu étant dépassé :\n- Commande N°9120 (E1732 - Noir), prévue le 27/11/2026')
    expect(m.body).toContain('Votre réponse à nos demandes d’urgence :\n- Commande N°9161 (176A - marine), souhaitée le 01/12/2026, demandée le 24/11/2026')
    expect(m.body).toContain('Votre délai :\n- Commande N°9183 (224A - bleu), du 24/11/2026')
    expect(m.body).toContain('Vos contrôles :\n- Lot TA532110 (180B - écru), reçu le 17/11/2026 : laize, poids et stabilités')
    expect(m.body.indexOf('Un nouveau délai')).toBeLessThan(m.body.indexOf('Votre réponse'))
  })
  it('a kind with nothing overdue has no block', () => {
    const m = mailRelanceGroupee({ ...d, urgences: [], delais: [], controles: [] })
    expect(m.subject).toBe('Relance — 1 dossier en attente — ETS Malterre')
    expect(m.body).not.toContain('Votre délai :')
    expect(m.body).not.toContain('Vos contrôles :')
  })
})
