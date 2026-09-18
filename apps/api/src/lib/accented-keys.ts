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

/** First value whose key matches `re`, or undefined. */
export function pickVal(row: Record<string, unknown>, re: RegExp): unknown {
  const k = Object.keys(row).find((key) => re.test(key))
  return k === undefined ? undefined : row[k]
}

/** Delete every key matching `re` from `out` — strips all mangled variants. */
export function stripKeys(out: Record<string, unknown>, re: RegExp): void {
  for (const k of Object.keys(out)) if (re.test(k)) delete out[k]
}
