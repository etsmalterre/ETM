import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { readFileSync } from 'fs'

// App version single source of truth: the monorepo root package.json.
// Injected as __APP_VERSION__ and shown in the header profile menu.
const rootPkg = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')
)

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
    // react-draggable (inside react-grid-layout) gates its debug logging on
    // process.env.DRAGGABLE_DEBUG — Vite only substitutes NODE_ENV in deps, so
    // without this define the browser throws "process is not defined" the
    // moment a dashboard widget is dragged.
    'process.env.DRAGGABLE_DEBUG': 'undefined',
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // `png` is intentionally NOT in workbox.globPatterns below (so the 4.92 MB
      // tricobot mascot isn't globbed into the precache and fails the build), so
      // the real shell pngs we DO want offline are precached explicitly here.
      // includeAssets are globbed from publicDir and injected as manifest
      // entries, bypassing the precache-size check — safe because all of these
      // are small (logos < 15 KB, icons < 150 KB).
      includeAssets: ['favicon.svg', 'icons/*.png', 'logo-full.png', 'logo-small.png'],
      manifest: {
        name: 'ETM - Ets Malterre',
        short_name: 'ETM',
        lang: 'fr',
        description: 'Système ERP pour ETS Malterre - Textile/Tricotage',
        theme_color: '#143D6B',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        // `png` is deliberately omitted here. The Tricobot reception-modal
        // mascot (public/tricobot/tricobot-wave.png, ~5 MB) is loaded only
        // inside the ennoblisseur reception dialog and must NOT land in the
        // offline precache. With `png` in this glob it gets precached and the
        // build fails ("Assets exceeding the limit" — workbox's 2 MiB cap).
        // The small pngs we DO want offline (logos, icons) are precached
        // explicitly via `includeAssets` above instead.
        globPatterns: ['**/*.{js,css,html,ico,svg}'],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\./i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24
              }
            }
          }
        ]
      }
    })
  ],
  server: {
    port: 5174,
    // Never silently bump to port+1 when the requested port is taken. Dev slots
    // are registry-addressed (3000-300N); a foreign process squatting a slot
    // port (seen: LIVA issue tracker on 3000) would otherwise shift this server
    // onto the NEXT slot's port while every URL/registry entry still points at
    // the old one. Fail loudly instead.
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
})
