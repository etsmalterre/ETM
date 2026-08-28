/**
 * A FIFO async mutex for the write paths HFSQL cannot protect itself.
 *
 * The MPS API is one Node process in front of a database with no transactions,
 * no unique indexes on the keys we hand out, and a bridge that interleaves the
 * queries of concurrent requests one by one. A write sequence written as
 * "check, then MAX+1, then INSERT" is therefore only correct if no other
 * request runs the same sequence at the same time — and two requests that
 * arrive together do exactly that: both checks pass, both MAX+1 agree, both
 * INSERT. On 2026-08-28 two POST /visitage-trm/valider landing in the same
 * second turned a two-roll cut into four `stock_ecru` rows and wrote
 * `evenement_piece` rows with duplicate primary keys.
 *
 * `run(fn)` executes `fn` after every previously queued `fn` has settled,
 * whether it resolved or threw. Nothing re-enters: a queued call that throws
 * never blocks the next one.
 */
export interface SerialLock {
  run<T>(fn: () => Promise<T>): Promise<T>
  /** Calls queued or running right now — for diagnostics and tests. */
  readonly pending: number
}

export function createSerialLock(): SerialLock {
  let tail: Promise<void> = Promise.resolve()
  let pending = 0
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      pending++
      const previous = tail
      let release!: () => void
      tail = new Promise<void>((resolve) => { release = resolve })
      return previous
        .then(fn)
        .finally(() => {
          pending--
          release()
        })
    },
    get pending() { return pending },
  }
}
