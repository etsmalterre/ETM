import { describe, expect, it } from 'vitest'
import { analyserAppro, type LigneAppro } from './fil-appro.js'

let seq = 1
function ligne(p: Partial<LigneAppro> & { cmd: number; commande: string }): LigneAppro {
  return {
    idref_fil_commande: seq++,
    idcommande_fil: p.cmd,
    fournisseur: 'Massebeuf',
    date_commande: p.commande,
    date_promise: p.date_promise ?? null,
    premiere_reception: p.premiere_reception ?? null,
    derniere_reception: p.derniere_reception ?? p.premiere_reception ?? null,
    quantite: 800,
    recu_kg: p.premiere_reception ? 800 : 0,
    ouverte: p.ouverte ?? !p.premiere_reception,
  }
}

// Shaped on the real 730 PES/CU écru history (Massebeuf).
const MASSEBEUF: LigneAppro[] = [
  ligne({ cmd: 651, commande: '2025-12-22', date_promise: '2027-01-08' }), // scheduled, open
  ligne({ cmd: 580, commande: '2025-06-04', date_promise: '2026-01-05', premiere_reception: '2026-01-15' }), // 225 d
  ligne({ cmd: 580, commande: '2025-06-04', date_promise: '2026-09-28', premiere_reception: '2026-07-17' }), // staggered 2nd
  ligne({ cmd: 551, commande: '2025-03-03', date_promise: '2025-05-29', premiere_reception: '2025-06-17' }), // 106 d, +19
  ligne({ cmd: 401, commande: '2023-09-12', date_promise: '2024-01-15', premiere_reception: '2023-12-21' }), // 100 d
  ligne({ cmd: 401, commande: '2023-09-12', date_promise: '2024-07-29', premiere_reception: '2024-05-14' }),
  ligne({ cmd: 364, commande: '2023-03-06', date_promise: '2023-04-21', premiere_reception: '2023-04-18' }), // 43 d
  ligne({ cmd: 364, commande: '2023-03-06', date_promise: '2023-12-30', premiere_reception: '2023-01-11' }), // lot before order → out
  ligne({ cmd: 269, commande: '2022-06-24', date_promise: '2022-06-30', premiere_reception: '2022-06-30' }), // 6 d
  ligne({ cmd: 158, commande: '2021-10-28', date_promise: '2022-02-17', premiere_reception: '2022-02-25' }), // 120 d, +8
  ligne({ cmd: 146, commande: '2021-09-28', date_promise: '2021-12-15', premiere_reception: '2021-12-15' }), // 78 d — 7th order, out of the window
]

describe('analyserAppro', () => {
  const a = analyserAppro(MASSEBEUF, '2026-10-07')

  it('measures the lead time on the FIRST line of each of the last 6 delivered orders', () => {
    // 580: 225, 551: 106, 401: 100, 364: 43, 269: 6, 158: 120 → sorted 6 43 100 106 120 225
    expect(a.nb_commandes_mesurees).toBe(6)
    expect(a.delai_mesure_jours).toBe(103) // (100 + 106) / 2
    expect(a.delai_min_jours).toBe(6)
    expect(a.delai_max_jours).toBe(225)
  })

  it('reads the announced lead time on the same lines', () => {
    // promises: 580 215, 551 87, 401 125, 364 46, 269 6, 158 112 → 6 46 87 112 125 215
    expect(a.delai_annonce_jours).toBe(100) // (87 + 112) / 2 rounded
  })

  it('compares every delivered line to its promise, with a 3-day tolerance', () => {
    // 9 delivered lines with a promise (the after-the-fact 364 line is excluded);
    // late beyond 3 d: 580/1 (+10), 551 (+19), 158 (+8)
    expect(a.nb_comparees).toBe(9)
    expect(a.a_l_heure).toBe(6)
    expect(a.retard_moyen_jours).toBe(12) // (10 + 19 + 8) / 3
  })

  it('returns the most recent lines first for the chart, open ones included', () => {
    expect(a.lignes[0].idcommande_fil).toBe(651)
    expect(a.lignes[0].delai_jours).toBeNull()
    expect(a.lignes[0].ouverte).toBe(true)
    expect(a.lignes).toHaveLength(8)
    expect(a.lignes.some((l) => l.premiere_reception === '2023-01-11')).toBe(false)
  })

  it('flags a line still awaited past its promise, against today', () => {
    // 280/48 écru, Legs N°703: promised 2 Oct 2026, nothing received on 7 Oct.
    const legs = analyserAppro([ligne({ cmd: 703, commande: '2026-07-16', date_promise: '2026-10-02' })], '2026-10-07')
    expect(legs.lignes[0]).toMatchObject({ retard_jours: 5, en_retard: true, delai_jours: null })
    // Not yet due: no lateness.
    expect(a.lignes[0]).toMatchObject({ idcommande_fil: 651, retard_jours: 0, en_retard: false })
  })

  it('lists every open line with what is still to receive, earliest promise first', () => {
    const r = analyserAppro([
      ligne({ cmd: 651, commande: '2025-12-22', date_promise: '2027-01-08' }),
      { ...ligne({ cmd: 703, commande: '2026-07-16', date_promise: '2026-10-02' }), quantite: 500, recu_kg: 120, premiere_reception: '2026-09-30', ouverte: true },
      ligne({ cmd: 551, commande: '2025-03-03', date_promise: '2025-05-29', premiere_reception: '2025-06-17' }), // closed
    ], '2026-10-07')
    expect(r.en_cours.map((l) => l.idcommande_fil)).toEqual([703, 651])
    expect(r.en_cours[0]).toMatchObject({ reste_kg: 380, retard_jours: 5, en_retard: true })
    expect(r.en_cours[1]).toMatchObject({ reste_kg: 800, retard_jours: 0, en_retard: false })
  })

  it('has nothing to say without deliveries', () => {
    const e = analyserAppro([ligne({ cmd: 1, commande: '2026-09-01', date_promise: '2026-10-20' })], '2026-10-07')
    expect(e.delai_mesure_jours).toBeNull()
    expect(e.delai_annonce_jours).toBeNull()
    expect(e.nb_comparees).toBe(0)
    expect(e.retard_moyen_jours).toBeNull()
  })
})
