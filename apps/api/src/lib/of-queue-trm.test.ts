import { describe, it, expect, vi, beforeEach } from 'vitest'

// No base in unit tests: every SQL the module issues is captured here, and the
// SELECTs are answered from a scripted queue.
const queryMock = vi.fn()
vi.mock('./hfsql-auto.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}))

const { handedOverLeftovers, terminerOf, healHandedOverOfs, rerankQueue } = await import('./of-queue-trm.js')

const sql = (): string[] => queryMock.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ').trim())

beforeEach(() => queryMock.mockReset())

// The LIVA #1128 state, verbatim from prod on 2026-09-07: OF 3565 closed by the
// Android terminal (est_actif 0, arret_prod stamped, rank kept), OF 3571 running.
const LEFTOVER = { id: 3565, IDmachine: 25, est_actif: 0, arret_prod: '2026-09-03 19:33:24.387' }
const RUNNING = { id: 3571, IDmachine: 25, est_actif: 1, arret_prod: null }

describe('handedOverLeftovers — the legacy AutoActivation signature', () => {
  it('flags an inactive, stopped OF whose métier runs another OF', () => {
    expect(handedOverLeftovers([LEFTOVER, RUNNING]).map((o) => o.id)).toEqual([3565])
  })

  it('leaves a waiting OF alone: never started, no arret_prod', () => {
    const waiting = { id: 3568, IDmachine: 38, est_actif: 0, arret_prod: null }
    const running = { id: 3560, IDmachine: 38, est_actif: 1, arret_prod: null }
    expect(handedOverLeftovers([waiting, running])).toEqual([])
  })

  it('leaves an interrupted OF alone: arret_prod set but still active', () => {
    const interrupted = { id: 3560, IDmachine: 38, est_actif: 1, arret_prod: '2026-09-07 10:00:00.000' }
    expect(handedOverLeftovers([interrupted])).toEqual([])
  })

  it('leaves a stopped OF alone when nothing else runs on its métier', () => {
    // No successor took over: not the handover shape, the régleur decides.
    expect(handedOverLeftovers([LEFTOVER])).toEqual([])
  })

  it('does not let an OF on another métier count as the successor', () => {
    expect(handedOverLeftovers([LEFTOVER, { ...RUNNING, IDmachine: 26 }])).toEqual([])
  })

  it('reads HFSQL 0/1 that arrive as strings', () => {
    const rows = [
      { ...LEFTOVER, est_actif: '0' as unknown as number },
      { ...RUNNING, est_actif: '1' as unknown as number },
    ]
    expect(handedOverLeftovers(rows).map((o) => o.id)).toEqual([3565])
  })
})

describe('terminerOf — the one closing path', () => {
  it('closes, re-ranks and activates the head when it asked for it', async () => {
    queryMock
      .mockResolvedValueOnce([]) // UPDATE close
      .mockResolvedValueOnce([   // rerank SELECT: 3568 waits with auto_activation
        { IDordre_fabrication: 3568, priorite: 2, est_actif: 0, auto_activation: 1 },
      ])
      .mockResolvedValueOnce([]) // rerank UPDATE priorite 1
      .mockResolvedValueOnce([]) // activate

    expect(await terminerOf(3560, 38, { stampArret: true })).toEqual({ activated: 3568 })
    const s = sql()
    // nowDt() is the compact HFSQL DATETIME literal, YYYYMMDDHHMMSS.
    expect(s[0]).toMatch(/SET est_termine = 1, est_actif = 0, priorite = 0, arret_prod = '\d{14}'/)
    expect(s[0]).toContain('WHERE IDordre_fabrication = 3560')
    expect(s[2]).toBe('UPDATE ordre_fabrication SET priorite = 1 WHERE IDordre_fabrication = 3568')
    expect(s[3]).toBe('UPDATE ordre_fabrication SET est_actif = 1 WHERE IDordre_fabrication = 3568')
  })

  it('leaves the head waiting when auto_activation is off', async () => {
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ IDordre_fabrication: 3568, priorite: 1, est_actif: 0, auto_activation: 0 }])

    expect(await terminerOf(3560, 38, { stampArret: true })).toEqual({ activated: 0 })
    expect(sql()).toHaveLength(2)
  })

  it('keeps the phone\'s arret_prod when asked not to stamp', async () => {
    queryMock.mockResolvedValue([])
    await terminerOf(3565, 25, { stampArret: false })
    expect(sql()[0]).toBe(
      'UPDATE ordre_fabrication SET est_termine = 1, est_actif = 0, priorite = 0 WHERE IDordre_fabrication = 3565',
    )
  })

  it('never activates over an OF already running', async () => {
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { IDordre_fabrication: 3571, priorite: 1, est_actif: 1, auto_activation: 1 },
        { IDordre_fabrication: 3580, priorite: 2, est_actif: 0, auto_activation: 1 },
      ])
    expect(await terminerOf(3565, 25, { stampArret: false })).toEqual({ activated: 0 })
    expect(sql().some((q) => q.includes('SET est_actif = 1'))).toBe(false)
  })
})

describe('healHandedOverOfs', () => {
  it('closes the leftover through terminerOf, arret_prod untouched, and reports it', async () => {
    queryMock
      .mockResolvedValueOnce([ // open queue
        { IDordre_fabrication: 3565, IDmachine: 25, est_actif: 0, arret_prod: '2026-09-03 19:33:24.387' },
        { IDordre_fabrication: 3571, IDmachine: 25, est_actif: 1, arret_prod: null },
        { IDordre_fabrication: 3568, IDmachine: 38, est_actif: 0, arret_prod: null },
      ])
      .mockResolvedValueOnce([]) // close 3565
      .mockResolvedValueOnce([{ IDordre_fabrication: 3571, priorite: 2, est_actif: 1, auto_activation: 1 }]) // rerank
      .mockResolvedValueOnce([]) // priorite 2 → 1
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    expect(await healHandedOverOfs()).toEqual([3565])
    const s = sql()
    expect(s[0]).toBe('SELECT IDordre_fabrication, IDmachine, est_actif, arret_prod FROM ordre_fabrication WHERE est_termine = 0')
    expect(s[1]).toBe('UPDATE ordre_fabrication SET est_termine = 1, est_actif = 0, priorite = 0 WHERE IDordre_fabrication = 3565')
    expect(s[3]).toBe('UPDATE ordre_fabrication SET priorite = 1 WHERE IDordre_fabrication = 3571')
    expect(s.some((q) => q.includes('arret_prod ='))).toBe(false)
    info.mockRestore()
  })

  it('is a single read on a clean base', async () => {
    queryMock.mockResolvedValueOnce([
      { IDordre_fabrication: 3571, IDmachine: 25, est_actif: 1, arret_prod: null },
    ])
    expect(await healHandedOverOfs(25)).toEqual([])
    expect(sql()).toEqual(['SELECT IDordre_fabrication, IDmachine, est_actif, arret_prod FROM ordre_fabrication WHERE est_termine = 0 AND IDmachine = 25'])
  })
})

describe('rerankQueue', () => {
  it('densifies to 1..n with the active OF first and only rewrites what moved', async () => {
    queryMock
      .mockResolvedValueOnce([
        { IDordre_fabrication: 3571, priorite: 2, est_actif: 1, auto_activation: 1 },
        { IDordre_fabrication: 3580, priorite: 2, est_actif: 0, auto_activation: 0 },
      ])
      .mockResolvedValue([])
    const out = await rerankQueue(25)
    expect(out.map((e) => [e.id, e.priorite])).toEqual([[3571, 1], [3580, 2]])
    expect(sql().slice(1)).toEqual(['UPDATE ordre_fabrication SET priorite = 1 WHERE IDordre_fabrication = 3571'])
  })

  it('does nothing for a métier-less OF', async () => {
    expect(await rerankQueue(0)).toEqual([])
    expect(queryMock).not.toHaveBeenCalled()
  })
})
