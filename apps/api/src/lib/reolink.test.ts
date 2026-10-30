import { describe, expect, it, vi } from 'vitest'
import { avecReprise, ReolinkError, SESSION_PERDUE } from './reolink.js'

const perdue = () => new ReolinkError('NVR : GetChannelstatus refusé', SESSION_PERDUE)

describe('avecReprise', () => {
  it('logs in once more when the NVR drops the token', async () => {
    const essai = vi.fn().mockRejectedValueOnce(perdue()).mockResolvedValueOnce('ok')
    await expect(avecReprise(essai, async () => null)).resolves.toBe('ok')
    expect(essai).toHaveBeenCalledTimes(2)
  })

  it('never retries another error', async () => {
    const essai = vi.fn().mockRejectedValue(new ReolinkError('NVR injoignable', -1))
    await expect(avecReprise(essai, async () => null)).rejects.toThrow('NVR injoignable')
    expect(essai).toHaveBeenCalledTimes(1)
  })

  it('a second drop says what to do and who is connected', async () => {
    const essai = vi.fn().mockRejectedValue(perdue())
    const err = (await avecReprise(essai, async () => ['admin depuis 10.10.20.3', 'admin depuis 10.10.30.7']).catch((e: unknown) => e)) as ReolinkError
    expect(essai).toHaveBeenCalledTimes(2)
    expect(err).toBeInstanceOf(ReolinkError)
    expect(err.message).toContain('« Lancer maintenant »')
    expect(err.message).toContain('admin depuis 10.10.30.7')
  })
})
