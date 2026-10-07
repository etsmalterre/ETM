import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun, AgentState } from '../store.js'

const runs: AgentRun[] = []
let etat: Partial<AgentState> = { mode: 'off' }
vi.mock('../store.js', () => ({
  lireEtat: async () => ({ mode: 'off', ...etat }),
  lireRuns: async () => runs,
}))

const { ECHECS_MAX, evaluerRelais, noterReleveTriage, relaisTriage, SILENCE_MAX_MS, triesParTriage } = await import('./relais.js')

const NOW = Date.parse('2026-10-07T10:00:00Z')
const run = (id: string, statut: string, minutesAvant: number, mode = 'actif') =>
  ({ message: { id }, statut, mode, createdAt: new Date(NOW - minutesAvant * 60_000).toISOString() }) as AgentRun

beforeEach(() => {
  runs.length = 0
  etat = { mode: 'off' }
})

describe('evaluerRelais (who reads contact@ for the agents behind the Triage)', () => {
  it('Triage off or essai → the agents read the mailbox themselves', () => {
    expect(evaluerRelais({ mode: 'off', dernierReleve: NOW, runs: [], now: NOW }).source).toBe('boite')
    const essai = evaluerRelais({ mode: 'essai', dernierReleve: NOW, runs: [], now: NOW })
    expect(essai.source).toBe('boite')
    expect(essai.raison).toMatch(/essai/)
  })

  it('Triage actif and healthy → the Triage hands the mail over', () => {
    const r = evaluerRelais({ mode: 'actif', dernierReleve: NOW - 60_000, runs: [run('a', 'trie', 1), run('b', 'erreur', 0)], now: NOW })
    expect(r.source).toBe('triage')
  })

  it('no successful Triage poll for too long → fallback', () => {
    expect(evaluerRelais({ mode: 'actif', dernierReleve: NOW - SILENCE_MAX_MS, runs: [], now: NOW }).source).toBe('triage')
    const r = evaluerRelais({ mode: 'actif', dernierReleve: NOW - SILENCE_MAX_MS - 1, runs: [], now: NOW })
    expect(r.source).toBe('secours')
    expect(r.raison).toMatch(/n’a pas relevé la boîte depuis/)
  })

  it(`its last ${ECHECS_MAX} triages all failed → fallback, until one succeeds`, () => {
    const echecs = [run('a', 'erreur', 3), run('b', 'erreur', 2), run('c', 'erreur', 1)]
    const r = evaluerRelais({ mode: 'actif', dernierReleve: NOW, runs: [run('z', 'trie', 10), ...echecs], now: NOW })
    expect(r.source).toBe('secours')
    expect(r.raison).toMatch(/3 derniers tris/)
    // Order of the stored runs does not matter.
    expect(evaluerRelais({ mode: 'actif', dernierReleve: NOW, runs: [...echecs].reverse(), now: NOW }).source).toBe('secours')
    // One success after the failures: back to the Triage.
    expect(evaluerRelais({ mode: 'actif', dernierReleve: NOW, runs: [...echecs, run('d', 'trie', 0)], now: NOW }).source).toBe('triage')
    // Fewer failures than the threshold: still the Triage.
    expect(evaluerRelais({ mode: 'actif', dernierReleve: NOW, runs: echecs.slice(1), now: NOW }).source).toBe('triage')
  })
})

describe('relaisTriage / triesParTriage', () => {
  it('reads the Triage state; a fresh API counts as heard from the Triage', async () => {
    expect((await relaisTriage()).source).toBe('boite')
    etat = { mode: 'actif' }
    expect((await relaisTriage()).source).toBe('triage')
    noterReleveTriage(Date.now() - SILENCE_MAX_MS - 60_000)
    expect((await relaisTriage()).source).toBe('secours')
    noterReleveTriage()
    expect((await relaisTriage()).source).toBe('triage')
  })

  it('the mails an agent never reads itself: sorted by the Triage while actif', async () => {
    runs.push(run('trie-actif', 'trie', 5), run('trie-essai', 'trie', 4, 'essai'), run('en-erreur', 'erreur', 3))
    expect([...(await triesParTriage())]).toEqual(['trie-actif'])
  })
})
