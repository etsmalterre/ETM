// Detects "the chunk this tab wants no longer exists on the server".
//
// The app code-splits a few heavy libraries (`xlsx` for the Excel exports,
// `html-to-image` for the ticket screenshot) into their own hashed chunks,
// loaded on demand via `await import(...)`. Those chunk URLs are baked into the
// main bundle, so a tab that was opened BEFORE a deploy asks for the previous
// build's filenames.
//
// That normally still works - until the new service worker activates and
// claims the open tab (the SW is built with clientsClaim). From that moment the
// tab runs OLD JavaScript against a NEW precache that only lists the new hashed
// chunks, and the old ones are not in it. The request falls through to the
// network, where the deploy has replaced dist/ - so it 404s, nginx answers the
// SPA fallback (index.html, text/html), and the dynamic import rejects.
//
// Symptom for the user: they click "Exporter Excel" on a tab they left open
// over lunch, the button spins once and nothing happens (the call sites only
// console.error). This module lets the app notice and offer a reload instead.
//
// Browsers word the failure differently, and the SPA-fallback case surfaces as a
// MIME-type complaint rather than a fetch failure, so all four shapes are
// matched:
//   Chrome   "Failed to fetch dynamically imported module: <url>"
//   Firefox  "error loading dynamically imported module"
//   Safari   "Importing a module script failed."
//   any      "Failed to load module script: Expected a JavaScript module script
//             but the server responded with a MIME type of \"text/html\""
const CHUNK_ERROR_PATTERNS = [
  /dynamically imported module/i,
  /Importing a module script failed/i,
  /Failed to load module script/i,
  /expected a javascript module script/i,
]

function isChunkLoadError(reason: unknown): boolean {
  const message =
    reason instanceof Error
      ? `${reason.message} ${reason.name}`
      : typeof reason === 'string'
        ? reason
        : ''
  if (!message) return false
  return CHUNK_ERROR_PATTERNS.some((re) => re.test(message))
}

/**
 * Call `handler` the first time a lazily-imported chunk fails to load.
 * Returns an unsubscribe function.
 *
 * Two sources, because neither alone is sufficient:
 *  • `vite:preloadError` - Vite fires this on window when its preload helper
 *    can't fetch a chunk. It fires even when the call site catches the
 *    rejection, which matters here: every `await import(...)` in this app sits
 *    in a try/catch, so the rejection never reaches `unhandledrejection`.
 *    `preventDefault()` stops Vite from rethrowing, since we surface the
 *    failure ourselves.
 *  • `unhandledrejection` - backstop for an import that fails outside Vite's
 *    preload helper, or in a future call site that doesn't catch.
 *
 * The handler fires at most once: the answer is always the same reload prompt,
 * and a user clicking Export twice shouldn't queue two of them.
 */
export function onChunkLoadError(handler: () => void): () => void {
  let fired = false
  const fire = () => {
    if (fired) return
    fired = true
    handler()
  }

  const onPreloadError = (e: Event) => {
    e.preventDefault()
    fire()
  }
  const onRejection = (e: PromiseRejectionEvent) => {
    if (isChunkLoadError(e.reason)) fire()
  }

  window.addEventListener('vite:preloadError', onPreloadError)
  window.addEventListener('unhandledrejection', onRejection)

  return () => {
    window.removeEventListener('vite:preloadError', onPreloadError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
