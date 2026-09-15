/**
 * Square JPEG portrait of a bonnetier from `bonnetier.photo`.
 *
 * The stored photos are large originals (750–1300 px with EXIF orientation);
 * sharp resizes them to a crisp avatar — the browser's own 1000 px → 44 px
 * downscale is what made them look muddy. Shared by Production › Prime
 * (routes/prime-trm.ts) and the pointage tablet (routes/pointage.ts, through
 * `lst_salarie.id_mps`).
 *
 * The read needs `queryRaw`: `query()` decodes the blob as UTF-8 and returns a
 * string that looks like data (claude_doc/hfsql_odbc.md).
 */
import sharp from 'sharp'
import { queryRaw } from './hfsql-auto.js'

const cache = new Map<string, Buffer>()
const CACHE_MAX = 200

/** `?size=` of a photo route: 96 by default, clamped to 32–512. */
export function taillePhoto(raw: unknown): number {
  return Math.min(512, Math.max(32, parseInt(String(raw ?? '96'), 10) || 96))
}

/** null when the bonnetier has no readable JPEG. */
export async function photoBonnetier(id: number, size: number): Promise<Buffer | null> {
  const cacheKey = `${id}:${size}`
  const cached = cache.get(cacheKey)
  if (cached) return cached

  const rows = await queryRaw(`SELECT photo FROM bonnetier WHERE IDbonnetier = ${id}`)
  const v = rows[0]?.photo
  const buf = v instanceof ArrayBuffer ? Buffer.from(v) : Buffer.isBuffer(v) ? v : null
  // JPEG magic check: anything else (empty memo, bridge text mangling) → none.
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null

  let out: Buffer
  try {
    // .rotate() applies the EXIF orientation before the cover-crop.
    out = await sharp(buf).rotate().resize(size, size, { fit: 'cover', position: 'centre' }).jpeg({ quality: 85 }).toBuffer()
  } catch (resizeErr) {
    // A photo sharp cannot decode still shows — just unresized.
    console.warn(`[bonnetier-photo] resize failed for bonnetier ${id}:`, resizeErr)
    out = buf
  }
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(cacheKey, out)
  return out
}
