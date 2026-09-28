// The CGV columns are filled from an estimate (CgvPdf.tsx) and lib/cgv.ts
// retries with emptier columns until nothing overflows. This pins the result:
// a text edit that pushes the CGV past two pages, or a render that never
// matched its plan, fails here instead of reaching a client.
import { describe, expect, it } from 'vitest'
import { getCgvPdf, CGV_MENTION, CGV_VERSION } from '../cgv.js'

function countPages(pdf: Buffer): number {
  return pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g)?.length ?? 0
}

describe('CGV PDF', () => {
  it('renders on two pages', async () => {
    expect(countPages(await getCgvPdf())).toBe(2)
  }, 60_000)

  it('names its version in the acceptance mention', () => {
    expect(CGV_MENTION).toContain(`version ${CGV_VERSION}`)
  })
})
