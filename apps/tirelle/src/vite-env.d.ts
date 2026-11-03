/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// App version injected at build time from apps/tirelle/package.json (see
// `define` in vite.config.ts). Hand-written source, not a build artifact.
declare const __APP_VERSION__: string
