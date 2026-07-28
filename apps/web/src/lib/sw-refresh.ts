// "Actualiser l'application" (header profile menu) has to leave the page running
// the NEW build after a single click. That is trickier than it looks, because of
// how the generated service worker serves navigations.
//
// The SW (vite-plugin-pwa, registerType 'autoUpdate') registers a NavigationRoute
// bound to the PRECACHED index.html. So a reload does NOT fetch index.html from
// nginx - it is answered from whichever SW is active at that moment, along with
// the hashed asset URLs that copy references.
//
// The old implementation did `await registration.update()` and reloaded straight
// away. But update()'s promise resolves as soon as the new worker STARTS
// installing (per spec the job promise is resolved inside the Install algorithm,
// before the install event's waitUntil - i.e. before precaching the ~2.2 MB of
// shell assets has finished). The reload therefore raced the install: the old
// worker was usually still the active one, served its own cached index.html, and
// the user saw the previous version. Clicking a second time worked because by
// then the new worker had finished installing and activated - hence the
// intermittent "I have to click twice".
//
// The SW is built with skipWaiting() + clientsClaim(), so no message handshake is
// needed: the new worker activates on its own once installed. What we must do is
// WAIT for that to happen before reloading. The signals we accept:
//   • the new worker reaching 'activated' - after this, a navigation is handled
//     by it, which is exactly what we need;
//   • 'controllerchange' - fired when clientsClaim() takes over this page;
//   • 'redundant' - the install failed, so waiting longer is pointless.
const WAIT_TIMEOUT_MS = 10_000

function settleOn(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve) => {
    // A worker found in `waiting`, or one that installed while we were awaiting
    // update(), may already be past the state we want to observe.
    if (worker.state === 'activated' || worker.state === 'redundant') {
      resolve()
      return
    }
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated' || worker.state === 'redundant') resolve()
    })
  })
}

/**
 * Check every registration for a new build and, if one is found, resolve only
 * once it has taken over - so the caller's reload serves the new assets.
 *
 * Resolves immediately when there is nothing new to install (no spinner for a
 * no-op refresh) and gives up after WAIT_TIMEOUT_MS so a stuck install can never
 * strand the user on a spinning button - the reload then behaves as it did
 * before, which is no worse than the old code.
 */
export async function updateServiceWorkerAndWait(): Promise<void> {
  if (!('serviceWorker' in navigator)) return

  const regs = await navigator.serviceWorker.getRegistrations()
  if (regs.length === 0) return

  // Armed BEFORE update() so a worker that installs and claims the page while we
  // are still awaiting cannot fire controllerchange unobserved.
  let onControllerChange: (() => void) | undefined
  const claimedThisPage = new Promise<void>((resolve) => {
    onControllerChange = () => resolve()
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
  })

  try {
    // A rejected update() (offline, 404 on sw.js) must not block the reload.
    await Promise.all(regs.map((r) => r.update().catch(() => undefined)))

    // `installing` is populated by the time update() resolves when a new build
    // exists; `waiting` covers a worker that installed on an earlier page load.
    // Neither => this page already runs the latest build.
    const pending = regs
      .map((r) => r.installing ?? r.waiting)
      .filter((w): w is ServiceWorker => w !== null && w !== undefined)
    if (pending.length === 0) return

    await Promise.race([
      claimedThisPage,
      Promise.all(pending.map(settleOn)),
      new Promise<void>((resolve) => setTimeout(resolve, WAIT_TIMEOUT_MS)),
    ])
  } finally {
    if (onControllerChange) {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    }
  }
}
