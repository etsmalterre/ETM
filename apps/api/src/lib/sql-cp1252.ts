/**
 * LOSSLESS SQL literal for text that must land byte-for-byte in an HFSQL text
 * or memo column — for copying rows between databases, not for user input.
 *
 * HFSQL stores text as Windows-1252, not strict Latin-1: the legacy pointage
 * messages carry `€` (0x80) and `’` (0x92), which read back through
 * `CONVERT(… USING 'UTF-8')` as U+20AC / U+2019. The route helpers `sqlText()`
 * (production-trm.ts, clients-common.ts, expeditions.ts) are deliberately
 * lossy — `’` → `'`, anything above 0xFF → `?` — which is right for a typed
 * value and wrong for a copy. This one maps the 27 cp1252 code points of
 * 0x80–0x9F back to their byte and THROWS on anything it cannot encode
 * (U+FFFD left by a failed accent repair, an emoji), so a copy never alters
 * a value in silence.
 *
 * Pure ASCII without control characters stays a quoted literal; everything
 * else becomes a hex literal, which also sidesteps CR/LF inside SQL text on
 * the Linux bridge. Verified on the dev server 2026-09-15:
 * x'e90d0a8092' → « é\r\n€’ ».
 */

const CP1252_HIGH: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
])

/** Windows-1252 bytes of `value`; throws naming the first character it cannot encode. */
export function cp1252Bytes(value: string): Buffer {
  const bytes: number[] = []
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0
    // 0x80–0x9F are C1 controls in Unicode; in cp1252 those bytes are the
    // characters of CP1252_HIGH, so a raw C1 code point has no byte to go to.
    if (cp <= 0x7f || (cp >= 0xa0 && cp <= 0xff)) bytes.push(cp)
    else if (CP1252_HIGH.has(cp)) bytes.push(CP1252_HIGH.get(cp)!)
    else throw new Error(`cp1252: U+${cp.toString(16).toUpperCase().padStart(4, '0')} cannot be encoded`)
  }
  return Buffer.from(bytes)
}

export function sqlTextCp1252(value: string | null | undefined): string {
  const v = value ?? ''
  if (v === '') return "''"
  if (/^[\x20-\x7e]*$/.test(v)) return `'${v.replace(/'/g, "''")}'`
  return `x'${cp1252Bytes(v).toString('hex')}'`
}
