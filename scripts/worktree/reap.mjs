// Finish any deferred worktree removals (dirs that were locked at
// /feature-complete time). Run from the main checkout after closing the old
// feature session/terminal.
//   node scripts/worktree/reap.mjs
import { reapPending } from './lib.mjs'

const { reaped, stillBlocked, resurrected } = reapPending()
if (reaped.length) {
  console.log(`Removed leftover worktree(s): ${reaped.map((e) => e.feature).join(', ')}`)
}
if (resurrected?.length) {
  console.log(`Kept (feature name reused, a live slot owns the path now): ${resurrected.map((e) => e.feature).join(', ')}`)
}
if (stillBlocked.length) {
  console.log('Still locked (a terminal is cwd\'d inside — close/cd out, then re-run):')
  for (const e of stillBlocked) console.log(`  ${e.worktree}`)
}
if (!reaped.length && !stillBlocked.length) console.log('Nothing pending.')
