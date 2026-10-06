import { describe, expect, it } from 'vitest'
import { msHeureParis } from '../../pointage-etat.js'
import { appDe, estPersonnel, libelleAction, menuDe, periode, signaux } from './regles.js'
import { sansCitation } from './agent.js'
import { resumerCorps, messageErreur } from '../../journal-activite.js'
import type { LigneJournal } from '../../journal-activite.js'

const ligne = (o: Partial<LigneJournal>): LigneJournal => ({
  le: new Date(msHeureParis(2026, 10, 6, 10, 0)),
  voir_comme: null,
  appareil: null,
  methode: 'PUT',
  chemin: '/api/commandes-client/12',
  statut: 200,
  duree_ms: 30,
  origine: 'etm.intra.etsmalterre.com',
  ecran: '/clients/commandes',
  corps: null,
  erreur: null,
  ip: null,
  ...o,
})

describe('periode', () => {
  it('the 18:00 run covers since yesterday 18:00', () => {
    const now = msHeureParis(2026, 10, 6, 18, 0, 30)
    expect(periode(now)).toEqual({ du: msHeureParis(2026, 10, 5, 18), au: now })
  })
  it('a launch at 15:00 also starts yesterday 18:00', () => {
    const now = msHeureParis(2026, 10, 6, 15)
    expect(periode(now).du).toBe(msHeureParis(2026, 10, 5, 18))
  })
  it('across the DST change (25/10) yesterday is still 18:00 Paris', () => {
    const now = msHeureParis(2026, 10, 26, 18, 1)
    expect(periode(now).du).toBe(msHeureParis(2026, 10, 25, 18))
  })
})

describe('appDe', () => {
  it('TRM by host, dev port, or route', () => {
    expect(appDe({ origine: 'trm.intra.etsmalterre.com', chemin: '/api/clients/1' })).toBe('TRM')
    expect(appDe({ origine: 'localhost:5171', chemin: '/api/clients/1' })).toBe('TRM')
    expect(appDe({ origine: null, chemin: '/api/commandes-trm/3' })).toBe('TRM')
    expect(appDe({ origine: null, chemin: '/api/pointage-admin/x' })).toBe('TRM')
  })
  it('ETM otherwise', () => {
    expect(appDe({ origine: 'etm.intra.etsmalterre.com', chemin: '/api/commandes-client/1' })).toBe('ETM')
    expect(appDe({ origine: 'localhost:3001', chemin: '/api/devis/1' })).toBe('ETM')
  })
})

describe('labels', () => {
  it('menu and action', () => {
    expect(menuDe('/api/commandes-sous-traitant/5/lignes')).toBe('Sous-traitants › Commandes')
    expect(libelleAction({ methode: 'DELETE', chemin: '/api/devis/9' })).toBe('Suppression — devis › 9')
  })
})

describe('signaux', () => {
  it('nothing on a clean day', () => {
    expect(signaux([ligne({})], [])).toEqual([])
  })
  it('server errors, refusals, deletions, failed logins', () => {
    const s = signaux(
      [ligne({ statut: 500, erreur: 'boom' }), ligne({ statut: 409, erreur: 'contrat_expire' }), ligne({ methode: 'DELETE', chemin: '/api/devis/9' })],
      [1, 2, 3].map(() => ({ le: new Date(), succes: false, motif: 'mot de passe' })),
    )
    expect(s.map((x) => x.titre)).toEqual(['1 erreur serveur rencontrée', '1 action refusée par ETM/TRM', '3 connexions échouées', '1 suppression'])
    expect(s[0].detail).toContain('boom')
  })
  it('a burst of the same write', () => {
    const t = msHeureParis(2026, 10, 6, 10)
    const j = [0, 20, 40, 60].map((s) => ligne({ le: new Date(t + s * 1000) }))
    expect(signaux(j, []).map((x) => x.titre)).toEqual(['Même action répétée en rafale'])
  })
})

describe('mails', () => {
  it('personal subjects', () => {
    expect(estPersonnel('RDV médecin (perso)')).toBe(true)
    expect(estPersonnel('Personnel atelier : planning')).toBe(true) // listed unread: errs on the safe side
    expect(estPersonnel('Commande 1234')).toBe(false)
  })
  it('drops the quoted history', () => {
    expect(sansCitation('Merci, c’est noté.\n\nLe lun. 5 oct. 2026 à 10:00, X <x@y.fr> a écrit :\n> avant')).toBe('Merci, c’est noté.')
  })
})

describe('journal', () => {
  it('masks secrets, shortens files and long texts', () => {
    const s = resumerCorps({ password: 'x', prix: 5.2, pdf: 'A'.repeat(4000), note: 'n'.repeat(300) })!
    const o = JSON.parse(s)
    expect(o.password).toBe('[masqué]')
    expect(o.prix).toBe(5.2)
    expect(o.pdf).toMatch(/^\[fichier \d+ Ko\]$/)
    expect(o.note).toContain('[300 car.]')
    expect(resumerCorps({})).toBeNull()
  })
  it('reads the error message of an answer', () => {
    expect(messageErreur({ error: 'contrat_expire', message: 'Contrat expiré' })).toBe('Contrat expiré')
    expect(messageErreur(null)).toBeNull()
  })
})
