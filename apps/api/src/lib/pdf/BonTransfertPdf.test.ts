// #1268: a bordereau de transfert running over several pages must name the
// article (reference + designation) on every page, not only on the first —
// the dyer files loose pages. The identity block is `fixed`, so react-pdf
// repeats it with the column header on each page the article's table spans.
// Walks the element tree (claude_doc/pdf_email.md): asserts what the document
// says, not how it is painted.
import React from 'react'
import { describe, expect, it } from 'vitest'
import { BonTransfertPdf, type BonTransfertPdfData } from './BonTransfertPdf.js'

function textOf(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const el = node as React.ReactElement<{ children?: unknown }>
  if (typeof el.type === 'function') return textOf((el.type as (p: unknown) => unknown)(el.props))
  return textOf(el.props?.children)
}

/** Every element carrying `fixed`, as the text it holds. */
function fixedTexts(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach((n) => fixedTexts(n, out))
    return out
  }
  const el = node as React.ReactElement<{ children?: unknown; fixed?: boolean }>
  if (typeof el.type === 'function') return fixedTexts((el.type as (p: unknown) => unknown)(el.props), out)
  if (el.props?.fixed) out.push(textOf(el))
  fixedTexts(el.props?.children, out)
  return out
}

const data: BonTransfertPdfData = {
  numero: 4467,
  typeMatiere: 1,
  dateLong: '7 octobre 2026',
  sourceNom: 'Ets Malterre',
  destinationNom: 'MATEL',
  transporteurNom: 'Divers',
  adresseDestination: null,
  commentaire: null,
  filRows: [],
  articles: [
    {
      titre: '029',
      sousTitre: 'jersey cot/elast J28 30"',
      pieces: [{ reference: '', coloris: 'ecru', numero: '3599/14', lot: 'trm12409', poids: 20.6, metrage: 0 }],
    },
    {
      titre: '128/101',
      sousTitre: 'interlock - 100% polyester',
      pieces: [{ reference: '', coloris: 'ecru', numero: '3700/1', lot: 'trm12410', poids: 21, metrage: 0 }],
    },
  ],
}

describe('BonTransfertPdf', () => {
  it('repeats each article reference + designation on every page it spans', () => {
    const fixed = fixedTexts(BonTransfertPdf({ data }))
    expect(fixed).toContain('029jersey cot/elast J28 30"')
    expect(fixed).toContain('128/101interlock - 100% polyester')
  })
})
