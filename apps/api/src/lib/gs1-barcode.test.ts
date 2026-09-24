import { describe, it, expect } from 'vitest'
import {
  code128Text, gs1_128, gs1CheckDigit, ean13FromStored, rollDigits, ssccForRoll,
  sixDigits2dec, eightDigits, spLabelCodes, GS, CODE128_PATTERNS,
} from './gs1-barcode.js'

// Reads a symbol back from its module widths, the way a scanner does: six
// elements per character, check character verified, stop pattern last.
const PATTERN_TO_VALUE = new Map(CODE128_PATTERNS.map((p, v) => [p, v]))
function decode(modules: number[]): { values: number[]; checkOk: boolean } {
  const values: number[] = []
  let i = 0
  while (modules.length - i > 7) {
    values.push(PATTERN_TO_VALUE.get(modules.slice(i, i + 6).join('')) ?? -1)
    i += 6
  }
  expect(modules.slice(i).join('')).toBe('2331112')
  const check = values.pop()!
  let sum = values[0]
  for (let k = 1; k < values.length; k++) sum += values[k] * k
  return { values, checkOk: sum % 103 === check }
}

describe('gs1CheckDigit', () => {
  it('matches the SSCCs on the legacy labels', () => {
    expect(gs1CheckDigit('99999990000321506')).toBe(2)
    expect(gs1CheckDigit('99999990000321507')).toBe(9)
    expect(gs1CheckDigit('99999990000033926')).toBe(6)
  })
  it('matches a known EAN-13', () => {
    expect(gs1CheckDigit('370044221022')).toBe(3) // 3700442210223 on label 106910
  })
})

describe('ean13FromStored', () => {
  it('appends the check digit to the 12 stored digits', () => {
    expect(ean13FromStored('370044221022')).toBe('3700442210223')
  })
  it('accepts a valid 13-digit code as is', () => {
    expect(ean13FromStored('3700442210223')).toBe('3700442210223')
  })
  it('refuses the 11-digit codes and a wrong check digit', () => {
    expect(ean13FromStored('37044221058')).toBeNull()
    expect(ean13FromStored('3700442210224')).toBeNull()
    expect(ean13FromStored('')).toBeNull()
  })
})

describe('roll numbering', () => {
  it('pads the suffix on two digits like the legacy N° pièce', () => {
    expect(rollDigits('3215/7')).toBe('321507')
    expect(rollDigits('3215/10')).toBe('321510')
    expect(rollDigits('339/26')).toBe('33926')
    expect(rollDigits('3215/7-1')).toBe('3215071')
  })
  it('rebuilds the five SSCCs of label sheet 106910', () => {
    expect(['3215/6', '3215/7', '3215/8', '3215/9', '3215/10'].map(ssccForRoll)).toEqual([
      '999999900003215062', '999999900003215079', '999999900003215086', '999999900003215093', '999999900003215109',
    ])
  })
})

describe('fixed-width fields', () => {
  it('formats measures and ids like the legacy', () => {
    expect(sixDigits2dec(109.8)).toBe('010980')
    expect(sixDigits2dec(110)).toBe('011000')
    expect(sixDigits2dec(108.3)).toBe('010830')
    expect(eightDigits('58808')).toBe('00058808')
    expect(eightDigits('ma107052')).toBe('00107052')
    expect(eightDigits('63424/1')).toBe('00634241')
  })
})

describe('Code 128 symbols', () => {
  it('reproduces the legacy order barcode codeword for codeword', () => {
    const s = code128Text('400A1-58690')
    // Decoded from 108966 - CAB.pdf: START A then the characters; check 19.
    expect(s.codes).toEqual([103, 20, 16, 16, 33, 17, 13, 21, 24, 22, 25, 16])
    const d = decode(s.modules)
    expect(d.checkOk).toBe(true)
  })
  it('falls back to set B for lower case', () => {
    expect(code128Text('400a').codes[0]).toBe(104)
  })
  it('encodes the logistic GS1-128 with FNC1 after the variable AI 10', () => {
    const s = gs1_128(`00999999900003215062${'10'}00058808${GS}25100106910`)
    expect(s.codes.slice(0, 2)).toEqual([105, 102])
    expect(s.codes.filter((c) => c === 102)).toHaveLength(2)
    expect(decode(s.modules).checkOk).toBe(true)
    // 251 + 8 digits = 11 digits: the odd tail goes through set B.
    expect(s.codes).toContain(100)
  })
  it('builds a full label from the 106910 sheet, first roll', () => {
    const c = spLabelCodes({
      numero: '3215/6', commandeClient: 'A3-57179 DU 30/07/2025', ean13: '3700442210223',
      bain: '58808', lot: 'MA106910', brut: 110, net: 109.8, laizeCm: 161,
    })
    expect(c.hri1).toBe('(00)999999900003215062(10)00058808(251)00106910')
    expect(c.hri2).toBe('(01)93700442210223(3112)010980(3122)000161(3312)011000')
    expect(decode(c.order.modules).checkOk).toBe(true)
    expect(decode(c.product.modules).checkOk).toBe(true)
    // Fixed-length AIs only → no separator after the leading FNC1.
    expect(c.product.codes.filter((x) => x === 102)).toHaveLength(1)
  })
})
