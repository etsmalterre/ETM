// Top-level gate above the router. While /auth/me loads: a spinner. No
// session: the login screen. A temporary password: the forced change. Else
// the app — plus, while an admin looks through another account, a pill to
// come back. Name kept for main.tsx (ETM and TRM mount it the same way).

import { Loader2 } from 'lucide-react'
import { useUser } from '@/contexts/UserContext'
import { LoginScreen } from './LoginScreen'
import { ForcedPasswordChange } from './ChangePasswordForm'
import { VoirCommeBandeau } from './VoirComme'

export function UserPickerGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useUser()

  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    )
  }

  if (!user) return <LoginScreen />
  if (user.doitChangerMdp) return <ForcedPasswordChange />

  return (
    <>
      {children}
      {user.voirComme && <VoirCommeBandeau />}
    </>
  )
}

/** Alias with the name the auth rework gave it. */
export const AuthGate = UserPickerGate
