// Code 128 / GS1-128 encoder + the GS1 numbers printed on the Simone Pérèle
// roll labels (LIVA #1200). Pure: no I/O, drawn by `pdf/Code128Bars.tsx`.
//
// ── What the legacy printed (decoded from its own PDFs, 2026-09-24) ─────────
// ETAT_Etiquette_SP carried three Code 128 symbols per label:
//   1. `<START A>400` + the client's order number, e.g. « 400A3-57179 DU
//      30/07/2025 » — plain Code 128, no FNC1. Reproduced as is.
//   2. « (00)SSCC(10)bain(251)lot » and
//   3. « (01)9+EAN13(3112)net(3122)laize(3312)brut » — meant as GS1-128, but
//      WinDev drew them with NO start character and the parentheses encoded as
//      literal text: no standard scanner reads them. Here they are real
//      GS1-128 (Start C + FNC1, FNC1 after a variable-length AI) carrying the
//      same element strings; the human-readable line under each is unchanged.
//
// The GTIN keeps the legacy shape « 9 » + EAN-13 (14 digits) even though that
// breaks the GTIN-14 check digit: it is what Simone Pérèle has been receiving
// for years, and only they can say whether their system re-validates it.

/** Bar/space widths (in modules) of every Code 128 value 0‥105, then STOP. */
export const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232',
]
const STOP_PATTERN = '2331112'

const START_A = 103
const START_B = 104
const START_C = 105
const CODE_B = 100 // in set C: switch to B
const CODE_C = 99 // in set B: switch to C
const FNC1 = 102

/** Marker for FNC1 inside a GS1 data sequence. */
export const GS = '\u001d'

/** Adds the mod-103 check character and the stop pattern; returns the module
 *  widths, alternating bar/space and starting with a bar. */
function toModules(codes: number[]): number[] {
  let sum = codes[0]
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i
  const all = [...codes, sum % 103]
  const widths: number[] = []
  for (const c of all) for (const ch of CODE128_PATTERNS[c]) widths.push(Number(ch))
  for (const ch of STOP_PATTERN) widths.push(Number(ch))
  return widths
}

export interface Code128Symbol {
  /** Codewords from the start character up to (excluding) the check character. */
  codes: number[]
  /** Bar/space widths in modules, bar first, check + stop included. */
  modules: number[]
}

/** Plain Code 128 over text. Set A when every character fits it (upper case,
 *  digits, punctuation — the legacy forced `<START A>`), set B otherwise. */
export function code128Text(text: string): Code128Symbol {
  const chars = [...text].map((c) => c.charCodeAt(0))
  if (chars.some((c) => c > 127)) throw new Error('code128Text: ASCII only')
  const fitsA = chars.every((c) => c < 96)
  const codes = [fitsA ? START_A : START_B]
  for (const c of chars) {
    if (fitsA) codes.push(c < 32 ? c + 64 : c - 32)
    else {
      if (c < 32) throw new Error('code128Text: control characters need set A')
      codes.push(c - 32)
    }
  }
  return { codes, modules: toModules(codes) }
}

/** GS1-128: Start C, FNC1, then the data. `data` holds digits and printable
 *  ASCII; `GS` marks an FNC1 separator. Digits pair up in set C; anything
 *  else (or a lone trailing digit) goes through set B. */
export function gs1_128(data: string): Code128Symbol {
  const codes = [START_C, FNC1]
  let set: 'B' | 'C' = 'C'
  let i = 0
  const digitRun = (from: number) => {
    let n = 0
    while (from + n < data.length && /\d/.test(data[from + n])) n++
    return n
  }
  while (i < data.length) {
    const ch = data[i]
    if (ch === GS) { codes.push(FNC1); i++; continue }
    const run = digitRun(i)
    if (set === 'C') {
      if (run >= 2) { codes.push(Number(data.slice(i, i + 2))); i += 2; continue }
      codes.push(CODE_B); set = 'B'
      continue
    }
    // Set B: go back to C for an even digit run, or a run of 4+.
    if (run >= 4 || (run >= 2 && run % 2 === 0 && i + run === data.length)) {
      // Odd run: its first digit stays in B, the even remainder goes to C.
      if (run % 2 === 1) { codes.push(data.charCodeAt(i) - 32); i++; continue }
      codes.push(CODE_C); set = 'C'
      continue
    }
    const c = data.charCodeAt(i)
    if (c < 32 || c > 127) throw new Error('gs1_128: unsupported character')
    codes.push(c - 32)
    i++
  }
  return { codes, modules: toModules(codes) }
}

/** GS1 mod-10 check digit over a string of digits (weights 3,1 from the right). */
export function gs1CheckDigit(digits: string): number {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    const d = Number(digits[digits.length - 1 - i])
    sum += d * (i % 2 === 0 ? 3 : 1)
  }
  return (10 - (sum % 10)) % 10
}

// ── Label values ──────────────────────────────────────────────────────────

const onlyDigits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')

/** EAN-13 from the stored `code_sp.code_ean_13`. The legacy stores the 12 data
 *  digits and adds the check digit at print time; 13 valid digits are
 *  accepted as is. Anything else (26 of the 54 codes on 2026-09-24 are 11
 *  digits long) is `null` — the label refuses it rather than print an EAN the
 *  customer's system cannot match. */
export function ean13FromStored(stored: string | null | undefined): string | null {
  const d = onlyDigits(stored)
  if (d.length === 12) return d + gs1CheckDigit(d)
  if (d.length === 13 && gs1CheckDigit(d.slice(0, 12)) === Number(d[12])) return d
  return null
}

/** Digits identifying a roll inside its SSCC: « 3215/7 » → 321507 (the
 *  suffix after the slash on two digits, as the legacy's « N° pièce »), any
 *  cut suffix « -N » appended. */
export function rollDigits(numero: string): string {
  const [base, rest = ''] = numero.trim().split('/')
  const [suffix, ...cut] = rest.split('-')
  const s = onlyDigits(suffix)
  return onlyDigits(base) + (s ? s.padStart(2, '0') : '') + onlyDigits(cut.join(''))
}

/** SSCC: the legacy's « 9999999 » prefix, the roll digits on 10 positions,
 *  and the GS1 check digit — 999999900003215062 for roll 3215/6. */
export function ssccForRoll(numero: string): string {
  const body = '9999999' + rollDigits(numero).slice(-10).padStart(10, '0')
  return body + gs1CheckDigit(body)
}

/** A measure on the six digits of a GS1 311n/312n/331n field with 2 decimals:
 *  109,8 m → « 010980 ». */
export function sixDigits2dec(value: number): string {
  return String(Math.round(value * 100)).padStart(6, '0').slice(-6)
}

/** The eight-digit fields: bain de teinture « 58808 » → « 00058808 », lot
 *  « ma107052 » → « 00107052 ». */
export function eightDigits(value: string | null | undefined): string {
  return onlyDigits(value).padStart(8, '0').slice(-8)
}

export interface SpLabelInput {
  numero: string
  commandeClient: string
  ean13: string
  bain: string
  lot: string
  /** Metres. */
  brut: number
  net: number
  /** Centimetres, as MATEL writes it (162 → 1,62 m). */
  laizeCm: number
}

export interface SpLabelCodes {
  sscc: string
  bain8: string
  lot8: string
  net6: string
  brut6: string
  laize6: string
  gtin14: string
  /** Human-readable lines printed under barcodes 2 and 3 (legacy text). */
  hri1: string
  hri2: string
  order: Code128Symbol
  logistic: Code128Symbol
  product: Code128Symbol
}

export function spLabelCodes(l: SpLabelInput): SpLabelCodes {
  const sscc = ssccForRoll(l.numero)
  const bain8 = eightDigits(l.bain)
  const lot8 = eightDigits(l.lot)
  const net6 = sixDigits2dec(l.net)
  const brut6 = sixDigits2dec(l.brut)
  const laize6 = String(Math.round(l.laizeCm)).padStart(6, '0').slice(-6)
  const gtin14 = '9' + l.ean13
  return {
    sscc, bain8, lot8, net6, brut6, laize6, gtin14,
    hri1: `(00)${sscc}(10)${bain8}(251)${lot8}`,
    hri2: `(01)${gtin14}(3112)${net6}(3122)${laize6}(3312)${brut6}`,
    order: code128Text(`400${l.commandeClient}`),
    // AI 10 is variable-length and not last → FNC1 separator before AI 251.
    logistic: gs1_128(`00${sscc}10${bain8}${GS}251${lot8}`),
    product: gs1_128(`01${gtin14}3112${net6}3122${laize6}3312${brut6}`),
  }
}
