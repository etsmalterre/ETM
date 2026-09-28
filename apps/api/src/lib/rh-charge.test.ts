import { describe, expect, it } from 'vitest'
import {
  compterParSemaine,
  evolutionMensuelle,
  heuresMesurees,
  heuresSemaine,
  lundiDe,
  lundiDeHfsql,
  moisListe,
  normaliserTache,
  totauxSimples,
  versionEnVigueur,
  volumeLisse,
  type TacheCharge,
} from './rh-charge.js'

const tache = (x: Partial<TacheCharge> & { nom: string; heures: number }): TacheCharge => normaliserTache(x)

describe('totaux d’un relevé', () => {
  it('counts every row, the margin included, in three automation states', () => {
    const taches = [
      tache({ nom: 'Expéditions', heures: 10, automatisable: 'oui' }),
      tache({ nom: 'Tirelles', heures: 4, automatisable: 'non' }),
      tache({ nom: 'Pointage', heures: 1, automatisable: 'oui', automatise: true }),
      tache({ nom: 'Pochettes', heures: 0.25, automatisable: 'partiel' }), // partiel = « the rest »
      tache({ nom: 'Marge', heures: 2.8, categorie: 'improductivite_structurelle' }),
    ]
    expect(totauxSimples(taches, taches.map((t) => t.heures))).toEqual({ taches: 18.05, aAutomatiser: 10, automatise: 1 })
  })
})

describe('tâches mesurées', () => {
  it('turns minutes per unit × weekly volume into hours — 10 min × 14 cmd = 2 h 20', () => {
    expect(heuresMesurees(10, 14)).toBe(2.33)
  })

  it('takes the week’s volume for a measured task and the typed hours for the others', () => {
    const taches = [
      tache({ nom: 'Saisie', heures: 2.3, indicateur: 'cmd', minutesParUnite: 10 }),
      tache({ nom: 'Ménage', heures: 4 }),
      tache({ nom: 'Sans données', heures: 1, indicateur: 'absent', minutesParUnite: 5 }),
    ]
    const volumes = new Map([['cmd', new Map([['2025-11-24', 6], ['2025-11-17', 18]])]])
    expect(heuresSemaine(taches, volumes, '2025-11-24')).toEqual([1, 4, 1])
    expect(heuresSemaine(taches, volumes, '2025-11-24', 2)).toEqual([2, 4, 1]) // (6 + 18) / 2 = 12 cmd
  })

  it('normalises a posted task: the margin never carries automation or a measure', () => {
    const t = normaliserTache({
      nom: ' Marge ', heures: 2.8, categorie: 'improductivite_structurelle',
      automatisable: 'oui', automatise: true, indicateur: 'commandes_client', minutesParUnite: 3,
    })
    expect(t).toMatchObject({ nom: 'Marge', automatisable: 'non', automatise: false, indicateur: null, minutesParUnite: null })
    expect(normaliserTache({ nom: 'x', heures: -1 }).heures).toBe(0)
    expect(normaliserTache({ nom: 'x', heures: 1, automatisable: '?' as never }).automatisable).toBe('inconnu')
  })
})

describe('semaines et mois', () => {
  it('anchors every week on Monday', () => {
    expect(lundiDe(new Date('2025-11-25T15:00:00Z'))).toBe('2025-11-24') // a Tuesday
    expect(lundiDe(new Date('2025-11-30T23:00:00Z'))).toBe('2025-11-24') // the Sunday
    expect(lundiDeHfsql('20251124')).toBe('2025-11-24')
    expect(lundiDeHfsql('')).toBeNull()
    expect(lundiDeHfsql(null)).toBeNull()
  })

  it('smooths a volume over the weeks ending at the week', () => {
    const parSemaine = compterParSemaine(['20251103', '20251110', '20251110', '20251117', '20251124', '20251124', '20251124', '20251124'])
    expect(parSemaine.get('2025-11-10')).toBe(2)
    expect(volumeLisse(parSemaine, '2025-11-24')).toBe(2) // (1 + 1 + 2 + 4) / 4 — the 11-03 week is outside
  })

  it('lists n months ending with the current one', () => {
    expect(moisListe(new Date('2026-02-10T00:00:00Z'), 3)).toEqual(['2025-12', '2026-01', '2026-02'])
  })
})

describe('évolution mensuelle', () => {
  const v1 = { id: 1, dateReleve: '2025-11-25', taches: [
    tache({ nom: 'Saisie', heures: 2.3, automatisable: 'oui', indicateur: 'cmd', minutesParUnite: 10 }),
    tache({ nom: 'Ménage', heures: 4 }),
  ] }
  const v2 = { id: 2, dateReleve: '2026-01-14', taches: [
    tache({ nom: 'Saisie', heures: 2.3, automatisable: 'oui', automatise: true, indicateur: 'cmd', minutesParUnite: 10 }),
    tache({ nom: 'Ménage', heures: 4 }),
  ] }
  // 12 orders every week of November 2025 → 2 h of Saisie
  const volumes = new Map([['cmd', new Map(['2025-11-03', '2025-11-10', '2025-11-17', '2025-11-24', '2026-01-05', '2026-01-12'].map((l) => [l, 12]))]])

  it('takes the relevé in force at the end of each week', () => {
    expect(versionEnVigueur([v2, v1], '2025-11-10')?.id).toBe(1)
    expect(versionEnVigueur([v2, v1], '2026-01-12')?.id).toBe(2) // relevé on the Wednesday of that week
    expect(versionEnVigueur([], '2026-01-12')).toBeNull()
  })

  it('averages the complete weeks of each month, each with its own volume and relevé', () => {
    const pts = evolutionMensuelle([v1, v2], volumes, ['2025-10', '2025-11', '2026-01', '2026-02'], '2026-01-12')
    // October: weeks before the first relevé still count (first relevé applied), flagged
    expect(pts[0]).toMatchObject({ mois: '2025-10', avantPremierReleve: true, taches: 4, aAutomatiser: 0 })
    expect(pts[1]).toMatchObject({ mois: '2025-11', taches: 6, aAutomatiser: 2, automatise: 0, releves: ['2025-11-25'], enCours: false })
    // January: 01-05 on v1 (à automatiser 2 h), 01-12 on v2 (automatisé 2 h) → half each
    expect(pts[2]).toMatchObject({ mois: '2026-01', aAutomatiser: 1, automatise: 1, releves: ['2026-01-14'], enCours: true })
    // February has no complete week yet → absent
    expect(pts.map((p) => p.mois)).not.toContain('2026-02')
  })

  it('is empty without any relevé', () => {
    expect(evolutionMensuelle([], volumes, ['2025-11'], '2025-11-24')).toEqual([])
  })
})
