// Top-level gate above the router. While /auth/me loads: a spinner. No
// session: the login screen. A temporary password: the forced change. An
// account that is not a member of THIS app (one login for ETM and TRM, but
// each company has its own users — API lib/utilisateur-apps.ts): a refusal
// with a way out. Else the app — plus, while an admin looks through another
// account, a pill to come back. Name kept for main.tsx (ETM and TRM mount it
// the same way, each with its `app`).

import { Loader2, LogOut, ShieldX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { APP_NAMES, AppCodeProvider, useUser, type AppCode } from '@/contexts/UserContext'
import { AuthCard, AuthLayout } from './AuthLayout'
import { LoginScreen } from './LoginScreen'
import { ForcedPasswordChange } from './ChangePasswordForm'
import { VoirCommeBandeau } from './VoirComme'

export function UserPickerGate({ app, children }: { app: AppCode; children: React.ReactNode }) {
  const { user, isLoading } = useUser()

  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    )
  }

  // The login screen reads the app too: a PC enrolled from it records which one.
  if (!user) return <AppCodeProvider value={app}><LoginScreen /></AppCodeProvider>
  if (user.doitChangerMdp) return <ForcedPasswordChange />

  return (
    <AppCodeProvider value={app}>
      {/* `apps` absent = an API older than the membership: let it through. */}
      {user.apps && !user.apps.includes(app) ? <PasMembre app={app} /> : children}
      {user.voirComme && <VoirCommeBandeau />}
    </AppCodeProvider>
  )
}

/** Alias with the name the auth rework gave it. */
export const AuthGate = UserPickerGate

function PasMembre({ app }: { app: AppCode }) {
  const { user, logout } = useUser()
  const autre = (user?.apps ?? []).find((a) => a !== app)
  return (
    <AuthLayout>
      <AuthCard icon={<ShieldX className="h-5 w-5" />} title="Accès non autorisé" subtitle={APP_NAMES[app]}>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Le compte <span className="font-medium text-foreground">{[user?.prenom, user?.nom].filter(Boolean).join(' ')}</span>{' '}
            n’a pas accès à l’application {APP_NAMES[app]}
            {autre ? <> : il appartient à {APP_NAMES[autre]}.</> : '.'}
          </p>
          <p className="text-xs text-muted-foreground">
            Si vous devriez y avoir accès, demandez-le à un administrateur.
          </p>
          {!user?.voirComme && (
            <Button variant="outline" className="w-full" onClick={() => void logout()}>
              <LogOut className="h-4 w-4 mr-1.5" />
              Changer de compte
            </Button>
          )}
        </div>
      </AuthCard>
    </AuthLayout>
  )
}
