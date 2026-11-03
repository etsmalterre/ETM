// Copied from TRM/apps/atelier (same update path as the atelier phones and the
// pointage tablet): the lab tablet runs the installed PWA and never closes it.
//
// A deployed build reaches the phones on its own.
//
// The atelier phones run the installed PWA and never close it, so nothing
// ever navigates: until 2026-09-15 the only service-worker update check was
// the browser's own (a navigation, or at most once every 24 h), and once the
// new worker did install and claim the page — the SW calls skipWaiting() and
// clientsClaim() — the page kept running the OLD bundle, because the injected
// vite-plugin-pwa registration (`registerSW.js`) registers and does nothing
// else. A deploy could therefore sit unseen on a phone for a day or more.
//
// This module replaces that injected script (`injectRegister: null` in
// vite.config.ts) with the three things the phone actually needs:
//
//  1. Register the worker (what the injected script did).
//  2. ASK for updates: `registration.update()` every CHECK_MS and every time
//     the app comes back to the foreground. nginx serves sw.js with
//     `no-store`, and the browser bypasses the HTTP cache for the worker
//     script anyway (`updateViaCache: 'imports'`, the default, and sw.js has
//     no imports), so each check sees the build that is really on the server.
//  3. RELOAD once the new worker controls the page (`controllerchange`), so
//     the navigation is answered by the new worker's precached index.html and
//     the new hashed assets. Deferred while a write is in flight: a reload
//     in the middle of « Fin de pièce » would abort the request from the
//     phone's side while the server may still commit it, and the bonnetier
//     would not know which. The reload waits for the mutation cache to go
//     idle, then fires. Anything unsaved on screen (a draft consigne, a chosen
//     action not yet confirmed) is lost — a deploy is rare and on Vincent's
//     schedule, and identity survives (localStorage), so the phone comes back
//     on the same poste, with the same person, a few seconds later.
//
// Skipped:
//  - the very first registration: `clientsClaim()` fires controllerchange when
//    the worker first claims a page that had none. That is an install, not an
//    update, so a page with no controller at startup ignores its first claim.
//  - dev: `devOptions.enabled` is false in vite.config.ts, /sw.js does not
//    exist there, and a precaching worker in dev turns every edit into a
//    "why am I seeing the old build?" hunt.
import type { QueryClient } from '@tanstack/react-query'

/** How often a foreground phone asks the server for a newer build. A minute
 *  is one request for a 2 KB script the browser will not cache; a deploy is
 *  on every phone within a minute plus one reload. */
export const CHECK_MS = 60_000

export function installerMiseAJour(qc: QueryClient): void {
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return

  const avaitControleur = navigator.serviceWorker.controller !== null
  let rechargementPrevu = false

  // 3 — reload when the new worker takes over, once no write is in flight.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!avaitControleur || rechargementPrevu) return
    rechargementPrevu = true
    recharger(qc)
  })

  // 1 + 2 — register, then keep asking. The page has already loaded by the
  // time main.tsx runs, so no `load` listener: registering later than the
  // injected script did only delays first install by the React mount.
  navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((reg) => {
      const verifier = () => {
        // A check while a worker is already installing only queues a second
        // fetch behind it; offline it would fail and log.
        if (reg.installing || !navigator.onLine) return
        reg.update().catch(() => undefined)
      }
      window.setInterval(verifier, CHECK_MS)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') verifier()
      })
    })
    .catch(() => undefined)
}

/** Reload now if nothing is being written, otherwise the moment the last
 *  in-flight mutation settles — whichever way it settles. */
function recharger(qc: QueryClient): void {
  if (qc.isMutating() === 0) {
    window.location.reload()
    return
  }
  const stop = qc.getMutationCache().subscribe(() => {
    if (qc.isMutating() === 0) {
      stop()
      window.location.reload()
    }
  })
}
