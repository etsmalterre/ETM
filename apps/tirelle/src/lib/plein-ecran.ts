// The wall tablet must show nothing but the app.
//
// The manifest says `display: fullscreen`, and a real WebAPK honours it — but
// Chrome cannot mint a WebAPK for a dev server on `localhost` (the A7 over
// adb, 2026-09-21): « Installer » silently falls back to Chrome's legacy
// home-screen shortcut (`WebappActivity`), which keeps Android's status bar.
// A plain browser tab has Chrome's own bars on top of that.
//
// So on a touch screen the first tap asks the browser for fullscreen itself,
// and every later tap re-asks after anything ended it (a reload on deploy, the
// back gesture). A no-op once the display mode is already fullscreen (the
// installed WebAPK), and on a desktop with a mouse — a developer's browser
// must not jump to fullscreen on every click. Silent on refusal: fullscreen
// is comfort, never a gate.
export function installerPleinEcran() {
  if (!window.matchMedia('(pointer: coarse)').matches) return
  const dejaPleinEcran = () =>
    window.matchMedia('(display-mode: fullscreen)').matches || document.fullscreenElement !== null
  const demander = () => {
    if (dejaPleinEcran() || typeof document.documentElement.requestFullscreen !== 'function') return
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined)
  }
  // `click`, not `pointerdown`: a touch grants the user activation that
  // requestFullscreen needs on pointerup / click. Capture phase, so a handler
  // that stops propagation never hides the request.
  document.addEventListener('click', demander, { capture: true })
}
