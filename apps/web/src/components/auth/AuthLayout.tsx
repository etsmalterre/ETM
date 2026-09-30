// Fullscreen frame of the auth screens (login, enrolment, forced password
// change, name picker): the gold band mirroring the Malterre PDF header, then
// the content centered below. Shared with TRM through `@etm`.

import type { ReactNode } from 'react'

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 flex flex-col overflow-auto bg-background">
      <div className="flex-shrink-0 bg-gold px-6 sm:px-10 py-6 sm:py-8 flex items-center justify-between gap-4">
        <img src="/logo-full.png" alt="ETS Malterre" className="h-12 sm:h-16" />
        <div className="text-right text-white">
          <div className="text-xs uppercase tracking-widest opacity-90">Bonnetterie · Tricotage</div>
          <div className="text-xl sm:text-2xl font-heading font-bold mt-1">ETS MALTERRE</div>
        </div>
      </div>
      <div className="flex-shrink-0 h-[2px] bg-primary" />
      <div className="flex-1 flex flex-col items-center justify-start py-12 sm:py-16 px-4 sm:px-8">
        {children}
      </div>
    </div>
  )
}

/** The white card holding an auth form, navy band on top (§43 treatment). */
export function AuthCard({ icon, title, subtitle, children }: {
  icon: ReactNode
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <div className="w-full max-w-sm rounded-xl border bg-card shadow-md overflow-hidden">
      <div className="flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5">
        <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
          {icon}
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-heading font-bold tracking-tight text-primary-foreground">{title}</h2>
          {subtitle && <p className="text-xs text-white/70 truncate">{subtitle}</p>}
        </div>
      </div>
      <div className="p-5 space-y-3 bg-zinc-100/80">{children}</div>
    </div>
  )
}

export const authInputClass =
  'w-full h-10 px-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'
