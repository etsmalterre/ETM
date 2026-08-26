import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { STOCK_QUERY_ROOTS, invalidateStockCaches, STOCK_QUERY_FRESHNESS } from './cache-sync'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

const FILES = sourceFiles(SRC).map((f) => ({ path: f, text: fs.readFileSync(f, 'utf8') }))

describe('invalidateStockCaches', () => {
  // The #1089 regression in one assertion: a `['stock-…']` query family that
  // the helper does not name is a family that keeps serving pre-transfer data
  // for five minutes after stock moves.
  it('names every stock-* query root used in the app', () => {
    const used = new Set<string>()
    for (const { text } of FILES) {
      for (const m of text.matchAll(/queryKey:\s*\[\s*'(stock-[a-z-]+)'/g)) used.add(m[1])
    }
    expect(used.size).toBeGreaterThan(0) // the scan itself must not silently find nothing
    const missing = [...used].filter((root) => !(STOCK_QUERY_ROOTS as readonly string[]).includes(root))
    expect(missing).toEqual([])
  })

  it('invalidates each root exactly once', () => {
    const calls: unknown[][] = []
    const qc = { invalidateQueries: ({ queryKey }: { queryKey: unknown[] }) => calls.push(queryKey) }
    invalidateStockCaches(qc as never)
    expect(calls).toEqual(STOCK_QUERY_ROOTS.map((r) => [r]))
  })
})

describe('STOCK_QUERY_FRESHNESS', () => {
  // Arriving on a stock screen must re-read the warehouse: the legacy WinDev
  // app and other users write these tables live, and no invalidation in this
  // browser can know about that.
  it('always refetches on mount', () => {
    expect(STOCK_QUERY_FRESHNESS.staleTime).toBe(0)
    expect(STOCK_QUERY_FRESHNESS.refetchOnMount).toBe('always')
  })

  // The behaviour ticket #1089 needed, exercised against a real QueryClient
  // carrying the app's 5-minute default: leaving a stock screen and coming
  // back must re-read the warehouse, not replay the pre-transfer list.
  // Mount an observer, wait for its fetch, unmount — i.e. arrive on the screen
  // and navigate away. Returns how many times the queryFn ran in total.
  async function visitTwice(extra: object): Promise<number> {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 1000 * 60 * 5, retry: false } } })
    let calls = 0
    const options = { queryKey: ['stock-fini', { hideShipped: true }], queryFn: async () => { calls++; return [] }, ...extra }
    for (let visit = 0; visit < 2; visit++) {
      const unsubscribe = new QueryObserver(qc, options).subscribe(() => {})
      await qc.getQueryCache().find({ queryKey: options.queryKey })!.promise
      unsubscribe()
    }
    qc.clear()
    return calls
  }

  it('refetches on remount despite the app-wide 5-minute staleTime', async () => {
    // The bug: on the app-wide default, coming back to the screen replays the
    // cached list — the pre-transfer magasin — for five minutes (#1089).
    expect(await visitTwice({})).toBe(1)
    // The fix: arriving re-reads the warehouse every time.
    expect(await visitTwice(STOCK_QUERY_FRESHNESS)).toBe(2)
  })

  it('is applied to every stock screen list and detail query', () => {
    const screens = [
      'pages/FinisStock.tsx',
      'pages/TombeMetierStock.tsx',
      'pages/FilsStock.tsx',
      'pages/DiversStock.tsx',
    ]
    for (const rel of screens) {
      const text = fs.readFileSync(path.join(SRC, rel), 'utf8')
      // One spread per list query + one per detail query. Lookups are
      // deliberately left on the default 5-minute cache.
      const spreads = [...text.matchAll(/\.\.\.STOCK_QUERY_FRESHNESS/g)].length
      expect(spreads, `${rel} should spread STOCK_QUERY_FRESHNESS into its list and detail queries`)
        .toBeGreaterThanOrEqual(2)
    }
  })
})
