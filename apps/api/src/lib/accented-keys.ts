/**
 * Reading accented HFSQL columns back out of a result row.
 *
 * Accented identifiers (`terminé`, `controlé`, `recyclé`, `certif_recyclé`, …)
 * come back from the Linux iODBC bridge with the identifier TRUNCATED at the
 * accent AND a non-deterministic garbage trailing byte from a reused buffer:
 * `terminé` arrives as `termin`, `termint`, `termini`, … depending on server
 * load. Windows returns the name verbatim instead.
 *
 * So a hardcoded fallback (`row.termin ?? row['terminé']`) reads correctly on
 * Windows and MISSES THE KEY IN PRODUCTION, leaving the flag at 0 for every
 * row — a silent wrong number, never an error. That has now shipped five
 * times: "Masquer les lots terminés" on Fils › Stock, the stock total on the
 * Fils › Références card (ticket #1090), the lots offered when affecting
 * stock to a yarn order line, `ref_ecru.diamètre` in `pricing-trm.ts`
 * (2026-09-11: 0 needles on every reference in prod, so the « Changement
 * aiguilles » cost line was 0 € for months), and `designation_client.archivé`
 * through `pick(r, 'archivé', 'archiv')` in `clients-common.ts` (#1177,
 * 2026-09-18: the 17 archived « LF043 - coloris » designations of Simone
 * Perele listed on Clients › Gestion, offered in the order coloris picker,
 * and every archived client shown « En cours »). `pick()` now falls back to
 * the prefix pass itself; static guard `scripts/check-accented-key-fallback.ts`.
 *
 * Always resolve these columns by case-insensitive PREFIX, never by name.
 */

/** `terminé` → `termin`: where the Linux driver cuts the name. */
function accentTrunc(name: string): string {
  const m = name.match(/[^\x00-\x7F]/)
  return m && m.index !== undefined ? name.slice(0, m.index) : name
}

const unaccent = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')

/**
 * Read a column by its real HFSQL name, whatever the backend did to the key:
 *   1. the name verbatim (Windows driver; `DATE` etc. case-insensitively);
 *   2. unaccented, case-insensitive: `termine` (PostgreSQL, whose columns are
 *      lowercase and unaccented — windev_migration decision D2);
 *   3. the Linux truncation `termin` followed by its garbage (`terminl`,
 *      `terminc`…), only when that prefix is 4+ characters and exactly ONE key
 *      has it — `résolution` cuts to `r`, which would match `reference` too.
 * Measured on prod 2026-09-28 (`scripts/pg-measure-keys.ts`): 77 columns of 43
 * tables come back mangled through SELECT *, so steps 1–2 alone miss them.
 */
export function readCol(row: Record<string, unknown>, name: string): unknown {
  if (name in row) return row[name]
  const t = accentTrunc(name)
  const lower = name.toLowerCase()
  const plain = unaccent(name).toLowerCase()
  const tLower = t.toLowerCase()
  const keys = Object.keys(row)
  for (const k of keys) {
    const kl = k.toLowerCase()
    if (kl === lower || kl === plain || kl === tLower) return row[k]
  }
  if (t !== name && t.length >= 4) {
    const hits = keys.filter((k) => k.toLowerCase().startsWith(tLower))
    if (hits.length === 1) return row[hits[0]]
  }
  return undefined
}

/** First value whose key matches `re`, or undefined. */
export function pickVal(row: Record<string, unknown>, re: RegExp): unknown {
  const k = Object.keys(row).find((key) => re.test(key))
  return k === undefined ? undefined : row[k]
}

/** Delete every key matching `re` from `out` — strips all mangled variants. */
export function stripKeys(out: Record<string, unknown>, re: RegExp): void {
  for (const k of Object.keys(out)) if (re.test(k)) delete out[k]
}
