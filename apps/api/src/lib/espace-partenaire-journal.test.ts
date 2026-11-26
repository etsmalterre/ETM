import { describe, expect, it } from 'vitest'
import { entreePartenaire } from './espace-partenaire-journal.js'

const e = (type: string, titre: string, detail: string | null = null, lot: string | null = null) =>
  entreePartenaire({ le: '2026-11-24T09:00:00.000Z', type, titre, detail, lot })

describe('the order’s journal as the partner reads it', () => {
  it('the order’s own facts, re-worded, without the details Malterre keeps', () => {
    expect(e('bon_commande', 'Bon de commande envoyé', 'À perrine@example.com')).toMatchObject({ titre: 'Bon de commande envoyé', detail: null, lot: null })
    expect(e('delai_recu', 'Délai reçu : 11/12/2026', '228/122')).toMatchObject({ titre: 'Délai enregistré : 11/12/2026', detail: null })
    expect(e('report', 'Délai repoussé du 20/11 au 18/12', '027A — De notre fait — fil en retard')).toMatchObject({ titre: 'Délai repoussé du 20/11 au 18/12', detail: null })
    expect(e('urgence', 'Passage en urgence', '224A — souhaité pour le 11/12 — réponse attendue le 26/11 — client pressé'))
      .toMatchObject({ titre: 'Commande passée en urgence', detail: 'Souhaitée pour le 11/12' })
    expect(e('urgence', 'Urgence refusée par le sous-traitant : délai maintenu au 18/12')?.titre).toBe('Urgence refusée : délai maintenu au 18/12')
    expect(e('cloture', 'Commande clôturée')?.titre).toBe('Commande terminée')
  })

  it('a lot’s facts, tagged with their lot', () => {
    expect(e('reception', 'BL enregistré', '14 rouleaux', 'MA109776')).toEqual({ le: '2026-11-24T09:00:00.000Z', titre: 'Lot reçu chez Malterre', detail: '14 rouleaux', lot: 'MA109776' })
    expect(e('mesures_ennoblisseur', 'Contrôle ennoblisseur enregistré', 'laize 150 → 152', 'MA1')).toMatchObject({ titre: 'Contrôles ennoblisseur enregistrés', detail: null })
    expect(e('reponse_ok', 'Le client accepte le coloris', 'parfait', 'MA1')).toMatchObject({ titre: 'Coloris validé', detail: null })
    expect(e('reponse_refus', 'Action qualité jugée non conforme', null, 'MA1')?.titre).toBe('Action qualité jugée non conforme')
    expect(e('reprise', 'Envoyé en reprise (2e)', 'mal uni', 'MA1')).toMatchObject({ titre: 'Lot envoyé en reprise (2e)', detail: 'mal uni' })
    expect(e('etat', 'Lot validé', null, 'MA1')?.titre).toBe('Lot validé')
  })

  it('is a closed list: the chasing, the clients, the lab and anything unknown never pass', () => {
    expect(e('relance', 'Délai relancé par e-mail', 'sans réponse')).toBeNull()
    expect(e('point', 'Délai demandé dans le Point du 24/11')).toBeNull()
    expect(e('creation', 'Commande créée')).toBeNull()
    expect(e('report', 'Échéance repoussée au 27/11', 'De notre fait')).toBeNull()
    expect(e('urgence', 'Demande d’urgence envoyée par e-mail', 'À perrine@example.com')).toBeNull()
    expect(e('urgence', 'Urgence relancée')).toBeNull()
    expect(e('rc', 'Rapport de contrôle envoyé à CLIENT SA', null, 'MA1')).toBeNull()
    expect(e('soumission', 'Stabilités soumises au client', null, 'MA1')).toBeNull()
    expect(e('reponse_refus', 'Le client refuse les stabilités', null, 'MA1')).toBeNull()
    expect(e('tirelle_jete', 'Tirelle jetée', null, 'MA1')).toBeNull()
    expect(e('rappel', 'Rappel posé', 'appeler le client', 'MA1')).toBeNull()
    expect(e('etat', 'Reprise du 20/11/2026 annulée (ouverte par erreur)', null, 'MA1')).toBeNull()
    // A wording changed in ETM's journal, or a new kind: dropped until it is listed.
    expect(e('bon_commande', 'Bon de commande renvoyé')).toBeNull()
    expect(e('nouveau', 'Quelque chose')).toBeNull()
    // A lot's wording on the order (and the reverse) is not a match.
    expect(e('etat', 'Lot validé')).toBeNull()
    expect(e('bon_commande', 'Bon de commande envoyé', null, 'MA1')).toBeNull()
  })
})
