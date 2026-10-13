// Bundles the three extension entry points into dist/ and copies the static
// files (manifest, panel HTML/CSS, icons). Load dist/ as an unpacked
// extension in chrome://extensions.
//   node build.mjs          one-off build
//   node build.mjs --watch  rebuild on change (reload the extension after)
//   node build.mjs --store  build for the Chrome Web Store (no localhost access)
//
// The manifest version always comes from package.json — bump it there.

import * as esbuild from 'esbuild'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const watch = process.argv.includes('--watch')
const store = process.argv.includes('--store')

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

// static/ → dist/, then rewrite the manifest: version from package.json, and
// the store build drops the localhost permission (dev installs stay unpacked).
function copyStatic() {
  cpSync('static', 'dist', { recursive: true })
  const manifest = JSON.parse(readFileSync('static/manifest.json', 'utf8'))
  manifest.version = version
  if (store) {
    manifest.host_permissions = manifest.host_permissions.filter(p => !p.startsWith('http://localhost'))
  }
  writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2) + '\n')
}

rmSync('dist', { recursive: true, force: true })
copyStatic()

const common = {
  outdir: 'dist',
  bundle: true,
  target: 'chrome120',
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
}
// The worker and the panel load as ES modules; the content script is a
// classic script injected into Gmail, so it is wrapped in an IIFE.
const builds = [
  { ...common, entryPoints: ['src/background.ts', 'src/sidepanel.ts'], format: 'esm' },
  { ...common, entryPoints: ['src/content.ts'], format: 'iife' },
]

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context({
      ...options,
      plugins: [
        {
          name: 'copy-static',
          setup(build) {
            build.onEnd(copyStatic)
          },
        },
      ],
    })
    await ctx.watch()
  }
} else {
  await Promise.all(builds.map(options => esbuild.build(options)))
}
