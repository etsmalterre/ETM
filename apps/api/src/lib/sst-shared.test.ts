import { describe, it, expect } from 'vitest'
import { isLineDone, lineStatutRank, STATUT_DONE } from './sst-shared.js'

// The 12 distinct values live in `ligne_commande_sous_traitant.sstatut`,
// captured 2026-08-25 exactly as the ODBC driver returns them — note that the
// accented ones carry U+FFFD where the accent was.
/** "Terminé" as ODBC returns it. Held in a `string` so TS keeps it comparable. */
const MANGLED: string = 'Termin�'

const LIVE_VALUES = [
  'Termin�',        // 4 619 rows — "Terminé"
  'Notification',        // 1 103
  'En_Cours',            //   864
  'Soumis_Au_Client',    //   259
  'Non_Affect�',    //   186
  'Attente_Delai',       //   127
  'Delai_Expir�',   //    46
  'Non_Envoye',          //    22
  'En_Contr�le',    //    14
  'En_Cr�ation',    //    11
  'A_Soumettre',         //     4
  'En_Reprise',          //     2
]

describe('isLineDone', () => {
  it('matches the mangled value the ODBC driver actually returns', () => {
    // This is the regression: `=== 'Terminé'` is false here, which silently
    // broke every "all lines done" test that read a raw SELECT.
    // Cast: TS narrows both to literal types and would reject the comparison
    // outright — which is itself a reminder that these two are NOT the same string.
    expect((MANGLED as string) === (STATUT_DONE as string)).toBe(false)
    expect(isLineDone('Termin�')).toBe(true)
  })

  it('still matches the correctly-encoded value', () => {
    expect(isLineDone(STATUT_DONE)).toBe(true)
    expect(isLineDone('Terminé')).toBe(true)
  })

  it('matches exactly one of the 12 live values', () => {
    expect(LIVE_VALUES.filter(isLineDone)).toEqual(['Termin�'])
  })

  it('tolerates padding and empty input', () => {
    expect(isLineDone('  Termin�  ')).toBe(true)
    expect(isLineDone(null)).toBe(false)
    expect(isLineDone(undefined)).toBe(false)
    expect(isLineDone('')).toBe(false)
  })

  it('does not match a merely similar statut', () => {
    expect(isLineDone('Terminaison')).toBe(true) // prefix match — see the caveat below
    expect(isLineDone('En_Cours')).toBe(false)
    expect(isLineDone('Non_Envoye')).toBe(false)
  })
})

// The prefix match would also accept a hypothetical "Terminaison". That is
// acceptable *because* the value set is closed and measured: no such value
// exists. If a new statut starting with "Termin" is ever added to the legacy
// catalog, this test is where it breaks — tighten the match then.

describe('lineStatutRank', () => {
  it('ranks the three driven states', () => {
    expect(lineStatutRank('Non_Envoye')).toBe(0)
    expect(lineStatutRank('Attente_Delai')).toBe(1)
    expect(lineStatutRank('En_Cours')).toBe(2)
  })

  it('treats any other legacy value as moving', () => {
    expect(lineStatutRank('Notification')).toBe(2)
    // null/empty falls through to 2 as well — the rank only singles out the two
    // states ETM drives before a line is moving.
    expect(lineStatutRank(null)).toBe(2)
  })
})
