/// <reference lib="webworker" />
//
// The Tirelle lab tablet's service worker (injectManifest, like apps/atelier):
// precache the build, serve index.html for navigations.

import { precacheAndRoute, createHandlerBoundToURL, cleanupOutdatedCaches } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { clientsClaim } from 'workbox-core'

declare const self: ServiceWorkerGlobalScope

// Without these two a new build installs and waits forever — the « click twice
// to get the new version » bug apps/web hit (lib/sw-refresh.ts).
self.skipWaiting()
clientsClaim()

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// ⚠️ NEVER drop the /api/ denylist: without it the worker answers API
// navigations with index.html.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api\//],
  }),
)
