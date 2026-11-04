import { describe, expect, it } from 'vitest'
import { blsDeLigne } from './bls-ligne.js'
import type { AgentRun } from './store.js'

function run(id: string, statut: AgentRun['statut'], bordereau: string, ligneId: number, extra: Partial<AgentRun> = {}): AgentRun {
  return {
    id,
    slug: 'bl-ennoblisseur',
    createdAt: `2026-11-03T10:${id.padStart(2, '0')}:00.000Z`,
    source: 'triage',
    mode: 'actif',
    statut,
    resultat: {
      profil: 'matel',
      extraction: {
        numero_bordereau: bordereau,
        numero_commande: '9096',
        pieces: [
          { numero_piece: '3545/26', poids: 3, metrage: 15.6, observations: 'tirelle' },
          { numero_piece: '3545/26', poids: 21.3, metrage: 86, observations: '2ta 1df 1tb' },
        ],
      },
      resolution: { ligneId, lignes: [ligneId] },
      controles: [
        { code: 'piece_double', gravite: 'bloquant', message: 'La pièce 3545/26 apparaît deux fois sur le BL.' },
        { code: 'total', gravite: 'avertissement', message: 'Total non imprimé.' },
      ],
    },
    fichiers: [{ nom: '20261103120507566.pdf', fichier: `${id}-0.pdf`, taille: 1 }],
    ...extra,
  } as unknown as AgentRun
}

describe('blsDeLigne', () => {
  it('returns the blocked BL of the line with its blocking reasons only (BL 109547A, #1347)', () => {
    const out = blsDeLigne([run('1', 'a_verifier', '109547A', 9068)], 9068)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      runId: '1',
      ennoblisseur: 'MATEL',
      bordereau: '109547A',
      commande: '9096',
      bloque: true,
      motifs: ['La pièce 3545/26 apparaît deux fois sur le BL.'],
      fichiers: [{ n: 0, nom: '20261103120507566.pdf' }],
    })
    expect(out[0].pieces.map((p) => p.metrage)).toEqual([15.6, 86])
  })

  it('ignores other lines', () => {
    expect(blsDeLigne([run('1', 'a_verifier', '109547A', 9068)], 9069)).toEqual([])
  })

  it('a bordereau a later run wrote is listed once, written, without motifs', () => {
    const runs = [run('1', 'a_verifier', '109547A', 9068), run('2', 'ecrit', '109547 A', 9068)]
    const out = blsDeLigne(runs, 9068)
    expect(out.map((b) => [b.runId, b.bloque, b.motifs])).toEqual([['2', false, []]])
  })

  it('keeps only the latest reading of a bordereau, and one a pilot marked checked', () => {
    const runs = [
      run('1', 'ecrit', '109547A', 9068),
      run('2', 'verifie', '109547A', 9068, { verification: { statutAvant: 'a_verifier', commentaire: '', par: { id: 1, nom: 'X' }, le: '' } }),
    ]
    expect(blsDeLigne(runs, 9068).map((b) => [b.runId, b.bloque])).toEqual([['2', true]])
  })

  it('newest first, a non-BL run never listed', () => {
    const runs = [
      run('1', 'a_verifier', '109500A', 9068),
      run('2', 'ignore', '', 9068),
      run('3', 'a_verifier', '109547A', 9068),
    ]
    expect(blsDeLigne(runs, 9068).map((b) => b.bordereau)).toEqual(['109547A', '109500A'])
  })
})
