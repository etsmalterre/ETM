import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { readFileSync } from 'fs'

// The lab tablet « Tirelle » (Galaxy Tab A9, labo de l'usine). Same skeleton as
// the TRM pointage tablet (TRM/apps/pointage): its own version, injected as
// __APP_VERSION__; its own service worker (src/sw.ts) registered by
// src/lib/mise-a-jour.ts so a deploy reaches the tablet within a minute.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, './package.json'), 'utf-8'))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: null,
      includeAssets: ['favicon.svg', 'icons/*.png', 'logo-full.png', 'logo-m.png'],
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,svg}'],
      },
      manifest: {
        name: 'Tirelle',
        short_name: 'Tirelle',
        lang: 'fr',
        description: 'Contrôles des tirelles au labo — ETS Malterre',
        theme_color: '#143D6B',
        background_color: '#143D6B',
        display: 'fullscreen',
        // The tablet sits on the lab bench, in either direction: the layout
        // stacks below 900 px wide (src/pages/Labo.tsx).
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: false, type: 'module' },
    }),
  ],
  server: {
    // 5179 is in the API's dev CORS list (scripts/worktree/lib.mjs ETM_PWA_PORTS).
    port: 5179,
    host: true, // reachable from the real tablet on the LAN
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
