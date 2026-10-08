import { describe, expect, it } from 'vitest'
import { msHeureParis } from '../../pointage-etat.js'
import { actionsParHeure, appDe, estPersonnel, gestes, libelleAction, menuDe, moyenneParHeure, periode, signaux, type LigneDecrite } from './regles.js'
import { sansCitation } from './agent.js'
import { resumerCorps, messageErreur } from '../../journal-activite.js'
import type { LigneJournal } from '../../journal-activite.js'

const ligne = (o: Partial<LigneDecrite>): LigneDecrite => ({
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
  // 2026-10-07 is a Wednesday.
  it('a scheduled run covers since the previous slot', () => {
    const now = msHeureParis(2026, 10, 7, 10, 0, 30)
    expect(periode(now, true)).toEqual({ du: msHeureParis(2026, 10, 7, 9), au: now })
    expect(periode(msHeureParis(2026, 10, 7, 15, 0, 30), true).du).toBe(msHeureParis(2026, 10, 7, 12))
  })
  it('9:00 covers since the previous working day 18:00 — Monday includes the weekend', () => {
    expect(periode(msHeureParis(2026, 10, 7, 9, 1), true).du).toBe(msHeureParis(2026, 10, 6, 18))
    expect(periode(msHeureParis(2026, 10, 12, 9, 1), true).du).toBe(msHeureParis(2026, 10, 9, 18))
  })
  it('a catch-up after a restart still starts at the slot before its own', () => {
    expect(periode(msHeureParis(2026, 10, 7, 13, 40), true).du).toBe(msHeureParis(2026, 10, 7, 11))
  })
  it('a manual launch covers since the last scheduled slot', () => {
    expect(periode(msHeureParis(2026, 10, 7, 14), false).du).toBe(msHeureParis(2026, 10, 7, 12))
    expect(periode(msHeureParis(2026, 10, 10, 11), false).du).toBe(msHeureParis(2026, 10, 9, 18)) // Saturday
  })
  it('across the DST change (25/10) Monday 9:00 still starts Friday 18:00 Paris', () => {
    expect(periode(msHeureParis(2026, 10, 26, 9, 1), true).du).toBe(msHeureParis(2026, 10, 23, 18))
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
  it('a failing background read is not reported (tickets widget polling)', () => {
    expect(signaux([ligne({ methode: 'GET', chemin: '/api/tickets', statut: 502 })], [])).toEqual([])
  })
  it('a burst of the same write', () => {
    const t = msHeureParis(2026, 10, 6, 10)
    const j = [0, 20, 40, 60].map((s) => ligne({ le: new Date(t + s * 1000) }))
    expect(signaux(j, []).map((x) => x.titre)).toEqual(['Même action envoyée plusieurs fois de suite'])
  })
  it('rolls received one after the other are not a burst, a released reservation not a deletion', () => {
    const t = msHeureParis(2026, 10, 6, 10)
    const j = [0, 20, 40, 60].map((s) => ligne({ le: new Date(t + s * 1000), methode: 'POST', corps: `{"numero":"3560/${s}"}` }))
    expect(signaux([...j, ligne({ methode: 'DELETE', retrait: true })], [])).toEqual([])
  })
})

describe('actions per hour', () => {
  const t = msHeureParis(2026, 10, 7, 9, 14, 30)
  const a = (s: number, o: Partial<LigneDecrite> = {}) => ligne({ le: new Date(t + s * 1000), ...o })
  // 09:14:30 a BL of 12 rolls + the Tricobot check, all within the second;
  // 09:14:50 one order line; 09:15:00 one more (10 s later: a new click).
  const bl = [...Array.from({ length: 12 }, (_, i) => a(i * 0.1, { methode: 'POST', chemin: '/api/commandes-sous-traitant/9016/lignes/8989/pieces/fini' })), a(1.3, { chemin: '/api/tricobot/bl-reception' })]
  const journal = [...bl, a(20, { chemin: '/api/commandes-client/lignes/13200' }), a(30, { chemin: '/api/commandes-client/7202' })]

  it('one click = one action, however many rows it wrote', () => {
    expect(gestes(journal).map((g) => g.length)).toEqual([13, 1, 1])
  })
  it('a 5xx on a read is not a click', () => {
    expect(gestes([a(0, { methode: 'GET', statut: 502 })])).toEqual([])
  })
  it('per Paris clock hour, with what it went on', () => {
    const h = actionsParHeure([...journal, a(3600)])
    expect(h.map((x) => [x.heure, x.actions, x.ecritures])).toEqual([['9 h', 3, 15], ['10 h', 1, 1]])
    expect(h[0].menus).toEqual([{ menu: 'Clients › Commandes', actions: 2 }, { menu: 'Sous-traitants › Commandes', actions: 1 }])
    expect(moyenneParHeure(h)).toBe(2)
    expect(moyenneParHeure([])).toBeNull()
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
