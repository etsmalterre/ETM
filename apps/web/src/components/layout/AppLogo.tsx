// Sidebar logo + "which app am I in?" tag (LIVA #1231). ETM and TRM share the
// same shell, colours and even whole screens (Tombé Métier › Références), so
// the only cue used to be the browser tab. The logo stays the Malterre one (a
// single company is the plan); the company name sits under it as a tagline.
//
// Deliberately NOT a link to the other app: users run each app as an installed
// desktop PWA, and a cross-origin link opens outside it (browser tab or the
// PWA's out-of-scope bar) — more confusing than switching windows.
//
// Shared with TRM through `@etm`.

export type AppCode = 'etm' | 'trm'

const APPS: Record<AppCode, { label: string; company: string }> = {
  etm: { label: 'ETM', company: 'Ets Malterre' },
  trm: { label: 'TRM', company: 'Tricotage Malterre' },
}

// Dev servers show the DEV logo, so a dev tab is never mistaken for production.
const SHOW_DEV_LOGO = import.meta.env.DEV

export function AppLogo({ app, collapsed = false }: { app: AppCode; collapsed?: boolean }) {
  const current = APPS[app]

  // Brand lockup: the logo alone, the company as a small spaced-caps tagline
  // under it — a signature, not a badge. Collapsed, the M keeps the app code.
  return (
    <div className="flex h-14 items-center justify-center border-b border-white/10 px-3">
      <div title={current.company} className="flex flex-col items-center">
        {collapsed ? (
          <>
            <img
              src={SHOW_DEV_LOGO ? '/logo-dev.webp' : '/logo-small.png'}
              alt="Malterre"
              className="h-7 w-auto rounded"
            />
            <span className="mt-1 pl-[0.2em] text-[10px] font-semibold leading-none tracking-[0.2em] text-white/60">
              {current.label}
            </span>
          </>
        ) : (
          <>
            <img
              src={SHOW_DEV_LOGO ? '/logo-dev.webp' : '/logo-full.png'}
              alt="Malterre"
              className="h-8 w-auto rounded"
            />
            <span className="mt-1 pl-[0.3em] text-[9px] font-semibold uppercase leading-none tracking-[0.3em] text-white/60">
              {current.company}
            </span>
          </>
        )}
      </div>
    </div>
  )
}
