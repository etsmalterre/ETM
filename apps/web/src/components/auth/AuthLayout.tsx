// Fullscreen frame of the auth screens (login, enrolment, forced password
// change, name picker). Shared with TRM through `@etm`.
//
// Split layout (2026-09-30): a navy brand panel — the sidebar's surface, logo,
// gold rule — on the left from `lg`, the content vertically centered on the
// right. Below `lg` the panel shrinks to a navy band on top. One title per
// screen: it lives in the card (or the screen's own heading), never twice.

import type { ReactNode } from 'react'

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 flex flex-col lg:flex-row overflow-auto bg-background">
      <BrandPanel />
      <main className="flex-1 min-h-0 flex flex-col items-center justify-center px-4 py-10 sm:px-8 lg:overflow-auto">
        {children}
      </main>
    </div>
  )
}

function BrandPanel() {
  return (
    <aside className="flex-shrink-0 bg-gradient-to-b from-primary via-primary/95 to-primary/90 text-white lg:w-[40%] lg:max-w-xl border-b-2 border-gold lg:border-b-0 lg:border-r-2">
      {/* Phone / tablet: one compact band */}
      <div className="lg:hidden flex items-center justify-between gap-4 px-5 py-4">
        <img src="/logo-full.png" alt="ETS Malterre" className="h-10" />
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-widest text-gold">Bonneterie · Tricotage</div>
          <div className="text-base font-heading font-bold tracking-tight">ETS MALTERRE</div>
        </div>
      </div>

      {/* Desktop: full-height panel */}
      <div className="hidden lg:flex h-full flex-col justify-between px-12 py-12 xl:px-16">
        <img src="/logo-full.png" alt="ETS Malterre" className="h-16 w-auto self-start" />
        <div>
          <div className="text-xs uppercase tracking-[0.25em] text-gold">Bonneterie · Tricotage</div>
          <div className="mt-3 text-4xl xl:text-5xl font-heading font-bold tracking-tight">ETS MALTERRE</div>
          <div className="mt-6 h-1 w-24 rounded-full bg-gradient-to-r from-gold via-gold to-gold/30" />
          <p className="mt-6 max-w-xs text-sm leading-relaxed text-white/70">
            Commandes, stocks, production et expéditions — ETM et TRM, un seul compte.
          </p>
        </div>
        <div className="text-xs text-white/50">Moreuil · Somme</div>
      </div>
    </aside>
  )
}

/** The white card holding an auth form: gold icon tile + one title, then the
 *  form. No coloured band — the brand panel already carries the navy. */
export function AuthCard({ icon, title, subtitle, children }: {
  icon: ReactNode
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <div className="w-full max-w-sm rounded-xl border border-border/60 bg-card shadow-lg">
      <div className="flex items-center gap-3 px-6 pt-6">
        <div className="h-10 w-10 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
          {icon}
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-heading font-bold tracking-tight text-primary">{title}</h1>
          {subtitle && <p className="text-xs text-muted-foreground truncate">{subtitle}</p>}
        </div>
      </div>
      <div className="mx-6 mt-4 h-px bg-border/60" />
      <div className="p-6 pt-5 space-y-3">{children}</div>
    </div>
  )
}

export const authInputClass =
  'w-full h-10 px-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'
