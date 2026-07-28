import { describe, it, expect, vi, beforeEach } from 'vitest'

// Both dependencies are mocked: the HFSQL lookup (no DB in unit tests) and the
// JSON-file email store.
const queryMock = vi.fn()
const fixEncodingMock = vi.fn()
const getUserEmailMock = vi.fn()

vi.mock('./hfsql-auto.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  fixEncoding: (...args: unknown[]) => fixEncodingMock(...args),
}))
vi.mock('./user-emails.js', () => ({
  getUserEmail: (...args: unknown[]) => getUserEmailMock(...args),
}))

const { getDefaultSignatureFields } = await import('./signature-defaults.js')

beforeEach(() => {
  queryMock.mockReset()
  fixEncodingMock.mockReset()
  getUserEmailMock.mockReset()
})

describe('getDefaultSignatureFields', () => {
  it('derives the display name and email, leaving the rest blank', async () => {
    queryMock.mockResolvedValue([{ IDutilisateur: 3, prenom: 'Vincent', nom: 'Malterre' }])
    fixEncodingMock.mockImplementation(async (rows: unknown) => rows)
    getUserEmailMock.mockResolvedValue('vincent@etsmalterre.com')

    expect(await getDefaultSignatureFields(3)).toEqual({
      displayName: 'Vincent Malterre',
      fonction: '',
      telFixe: '',
      email: 'vincent@etsmalterre.com',
    })
  })

  it('selects IDutilisateur so fixEncoding never builds WHERE id = NaN', async () => {
    queryMock.mockResolvedValue([])
    fixEncodingMock.mockResolvedValue([])
    getUserEmailMock.mockResolvedValue(null)

    await getDefaultSignatureFields(7)
    expect(queryMock.mock.calls[0][0]).toContain('SELECT IDutilisateur, prenom, nom')
  })

  it('returns null when neither a name nor an email is known', async () => {
    queryMock.mockResolvedValue([{ IDutilisateur: 9, prenom: null, nom: null }])
    fixEncodingMock.mockImplementation(async (rows: unknown) => rows)
    getUserEmailMock.mockResolvedValue(null)

    expect(await getDefaultSignatureFields(9)).toBeNull()
  })

  it('still signs with the email when the utilisateur lookup fails', async () => {
    queryMock.mockRejectedValue(new Error('bridge down'))
    getUserEmailMock.mockResolvedValue('atelier@etsmalterre.com')

    const fields = await getDefaultSignatureFields(4)
    expect(fields).toEqual({
      displayName: '',
      fonction: '',
      telFixe: '',
      email: 'atelier@etsmalterre.com',
    })
  })
})
