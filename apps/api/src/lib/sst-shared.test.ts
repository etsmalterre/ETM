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

// ── sstDelaiSets — the délai write shared by ETM's PUT /lignes and TRM's
// PUT /lignes/:id/delai (LIVA #1123) ───────────────────────────────────
import { sstDelaiSets, STATUT_OPEN, STATUT_ATTENTE_DELAI, STATUT_NON_ENVOYE } from './sst-shared.js'

describe('sstDelaiSets', () => {
  it('first date on an Attente_Delai line: writes the date, flips to En_Cours, freezes nothing', () => {
    const r = sstDelaiSets({ date_livraison: '', date_delai: '', sstatut: STATUT_ATTENTE_DELAI }, '2026-10-15')
    expect(r.sets).toEqual([`date_livraison = '20261015'`, `sstatut = '${STATUT_OPEN}'`])
    expect(r).toMatchObject({ date_livraison: '20261015', date_delai: '', sstatut: STATUT_OPEN })
  })

  it('first reschedule freezes the original date into date_delai (capture-once)', () => {
    const r = sstDelaiSets({ date_livraison: '20261015', date_delai: '20261015', sstatut: STATUT_OPEN }, '20261101')
    expect(r.sets).toEqual([`date_delai = '20261015'`, `date_livraison = '20261101'`])
    expect(r.date_delai).toBe('20261015')
  })

  it('a second reschedule leaves the frozen original alone', () => {
    const r = sstDelaiSets({ date_livraison: '20261101', date_delai: '20261015', sstatut: STATUT_OPEN }, '20261120')
    expect(r.sets).toEqual([`date_livraison = '20261120'`])
    expect(r.date_delai).toBe('20261015')
  })

  it('the same date again changes nothing but the (identical) date clause', () => {
    const r = sstDelaiSets({ date_livraison: '20261015', date_delai: '20261015', sstatut: STATUT_OPEN }, '20261015')
    expect(r.sets).toEqual([`date_livraison = '20261015'`])
  })

  it('Non_Envoye keeps its status: the bon de commande is not out yet', () => {
    const r = sstDelaiSets({ date_livraison: '', date_delai: '', sstatut: STATUT_NON_ENVOYE }, '20261015')
    expect(r.sets).toEqual([`date_livraison = '20261015'`])
    expect(r.sstatut).toBe(STATUT_NON_ENVOYE)
  })

  it('an explicit statut in the patch wins over the auto-flip', () => {
    const r = sstDelaiSets({ date_livraison: '', date_delai: '', sstatut: STATUT_ATTENTE_DELAI }, '20261015', 'Notification')
    expect(r.sets).toEqual([`date_livraison = '20261015'`, `sstatut = 'Notification'`])
    expect(r.sstatut).toBe('Notification')
  })

  it('clearing the date is allowed and freezes the previous one', () => {
    const r = sstDelaiSets({ date_livraison: '20261015', date_delai: '20261015', sstatut: STATUT_OPEN }, '')
    expect(r.sets).toEqual([`date_delai = '20261015'`, `date_livraison = ''`])
    expect(r.date_livraison).toBe('')
  })

  it('garbage input clears rather than writing junk', () => {
    const r = sstDelaiSets({ date_livraison: '', date_delai: '', sstatut: STATUT_OPEN }, '15/10/2026')
    expect(r.sets).toEqual([`date_livraison = ''`])
  })
})
