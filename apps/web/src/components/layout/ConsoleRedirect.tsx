// The old addresses of the screens that left the ERPs for the Console
// Administration on 2026-10-27 (Paramètres, Agents IA, RH: bookmarks, mails,
// notifications): sent to the same screen in the console, query kept
// (`?agent=…&run=…`). Shared with TRM through `@etm`, each app naming its
// company in `to`.

import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { adminConsoleUrl } from '@/contexts/UserContext'

export function ConsoleRedirect({ to }: { to: string }) {
  const { search } = useLocation()
  useEffect(() => {
    window.location.replace(adminConsoleUrl(`${to}${search}`))
  }, [to, search])
  return (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-accent" />
    </div>
  )
}
