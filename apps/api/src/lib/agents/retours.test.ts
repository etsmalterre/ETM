import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun } from './store.js'

let enMemoire: AgentRun
vi.mock('./store.js', () => ({
  modifierRun: async (_slug: string, id: string, fn: (r: AgentRun) => void) => {
    if (id !== enMemoire.id) return null
    fn(enMemoire)
    return enMemoire
  },
}))
const { enregistrerRetour } = await import('./retours.js')

const par = { id: 1, nom: 'Pierre-Emmanuel Roux' }
const base = { slug: 'bl-ennoblisseur', runId: 'r1', par }

beforeEach(() => {
  enMemoire = { id: 'r1', slug: 'bl-ennoblisseur' } as AgentRun
})

describe('Tricobot feedback (silence = juste, a correction = échec with a why)', () => {
  it('silence scores the run a réussite, a correction an échec with its why', async () => {
    await enregistrerRetour({ ...base, cle: null, juste: true, commentaire: '' })
    expect(enMemoire.evaluation?.note).toBe('reussite')
    await enregistrerRetour({ ...base, cle: null, juste: false, commentaire: '3505/14 poids 21,4 → 24,1 kg' })
    expect(enMemoire.evaluation).toMatchObject({ note: 'echec', commentaire: '3505/14 poids 21,4 → 24,1 kg' })
  })

  it('a correction without a why is refused', async () => {
    await expect(enregistrerRetour({ ...base, cle: null, juste: false, commentaire: '  ' })).rejects.toThrow()
  })

  it('a later silent pass keeps an échec when asked to (second partial réception)', async () => {
    await enregistrerRetour({ ...base, cle: null, juste: false, commentaire: 'lot faux', garderEchec: true })
    await enregistrerRetour({ ...base, cle: null, juste: true, commentaire: '', garderEchec: true })
    expect(enMemoire.evaluation?.note).toBe('echec')
  })

  it('an item key scores that item only', async () => {
    await enregistrerRetour({ ...base, cle: 'a', juste: false, commentaire: 'mauvais client' })
    expect(enMemoire.avisPoints?.a.note).toBe('echec')
    expect(enMemoire.evaluation).toBeUndefined()
  })

  it('a run gone is reported, not thrown', async () => {
    expect(await enregistrerRetour({ ...base, runId: 'absent', cle: null, juste: true, commentaire: '' })).toBe(false)
  })
})
