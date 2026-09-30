// The account entries of the header profile menu — shared by the ETM and TRM
// headers (TRM imports it through `@etm`), so both apps offer the same three:
//   • « Voir comme… »              — admins only (VoirComme.tsx)
//   • « Changer mon mot de passe » — a person's own browser session
//   • « Se déconnecter »
//
// A hook, not a component: the items live in the menu popover, which unmounts
// when it closes, so the dialogs they open must be mounted elsewhere (the
// header root). `items(close)` goes in the popover, `dialogs` at the root.

import { useState, type ReactNode } from 'react'
import { Eye, KeyRound, LogOut } from 'lucide-react'
import { canSwitchUser, useUser } from '@/contexts/UserContext'
import { ChangePasswordDialog } from './ChangePasswordForm'
import { VoirCommeDialog } from './VoirComme'

const itemClass =
  'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-accent/10 hover:text-accent transition-colors'

export function useAccountMenu(): { items: (close: () => void) => ReactNode; dialogs: ReactNode } {
  const { user, logout } = useUser()
  const [voirCommeOpen, setVoirCommeOpen] = useState(false)
  const [mdpOpen, setMdpOpen] = useState(false)
  const sessionPersonnelle = user?.sessionType === 'navigateur' && !user.voirComme

  const items = (close: () => void) => (
    <>
      {canSwitchUser(user) && (
        <button type="button" className={itemClass} onClick={() => { close(); setVoirCommeOpen(true) }}>
          <Eye className="h-3 w-3" />
          Voir comme…
        </button>
      )}
      {sessionPersonnelle && (
        <button type="button" className={itemClass} onClick={() => { close(); setMdpOpen(true) }}>
          <KeyRound className="h-3 w-3" />
          Changer mon mot de passe
        </button>
      )}
      <button type="button" className={itemClass} onClick={() => { close(); void logout() }}>
        <LogOut className="h-3 w-3" />
        Se déconnecter
      </button>
    </>
  )

  const dialogs = (
    <>
      <VoirCommeDialog open={voirCommeOpen} onClose={() => setVoirCommeOpen(false)} />
      <ChangePasswordDialog open={mdpOpen} onClose={() => setMdpOpen(false)} />
    </>
  )

  return { items, dialogs }
}
