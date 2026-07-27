import { useState, useEffect, useCallback, useRef } from 'react'
import { useLocation, NavLink } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Menu, Maximize2, Minimize2, LogOut, CircleUser, MessageSquarePlus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/ui/avatar'
import { getActiveMenu } from '@/config/navigation'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api'
import { useUser, canSwitchUser } from '@/contexts/UserContext'
import { ProfileModal, userPhotoUrl, type UserProfileMe } from '@/components/profile/ProfileModal'
import { TicketModal } from '@/components/tickets/TicketModal'
import { useTicketNotifications } from '@/components/tickets/useTicketNotifications'

interface HeaderProps {
  onMenuClick: () => void
  sidebarCollapsed: boolean
}

export function Header({ onMenuClick }: HeaderProps) {
  const location = useLocation()
  const activeMenu = getActiveMenu(location.pathname)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const { user, logout } = useUser()
  const allowSwitch = canSwitchUser(user)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const userMenuRef = useRef<HTMLDivElement | null>(null)

  // Force-refresh the app: ask the service worker to fetch the latest build
  // (registerType 'autoUpdate' activates it immediately), then reload so the
  // new assets are served. Users on the PWA can pick up a deploy without
  // closing the app.
  const refreshApp = useCallback(async () => {
    setRefreshing(true)
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((r) => r.update()))
      }
    } catch {
      // SW update failure must not block the reload.
    }
    window.location.reload()
  }, [])

  // Ticket reporting — the modal opens immediately; the screenshot is captured
  // in the background and excludes dialog portals from the shot (the ticket
  // modal is the only one that can be open — dialog overlays cover this button).
  const [ticketOpen, setTicketOpen] = useState(false)
  const [screenshot, setScreenshot] = useState<File | null>(null)
  const [capturingScreenshot, setCapturingScreenshot] = useState(false)
  // Unread = a ticket of this user moved status or got a developer reply since
  // they last opened it. Read state is client-side (localStorage) — no DB.
  const { unreadCount } = useTicketNotifications()

  const openTicketModal = useCallback(() => {
    setScreenshot(null)
    setTicketOpen(true)
    setCapturingScreenshot(true)
    void (async () => {
      try {
        // html-to-image (SVG <foreignObject> rasterization) rather than
        // html2canvas — the latter mis-renders text inside form inputs.
        // Dynamic import keeps the library out of the main chunk.
        // No cacheBust: it forces a network re-fetch of every image on the
        // page, which made the capture take several seconds.
        const htmlToImage = await import('html-to-image')
        const blob = await htmlToImage.toBlob(document.body, {
          pixelRatio: window.devicePixelRatio || 1,
          filter: (node) => !(node instanceof Element && node.hasAttribute('data-dialog-root')),
        })
        if (blob) {
          setScreenshot(new File([blob], `capture_${Date.now()}.png`, { type: 'image/png' }))
        }
      } catch {
        // Capture failure must not block reporting — the modal is already open.
      } finally {
        setCapturingScreenshot(false)
      }
    })()
  }, [])

  // Profile (photo + signature) of the logged-in user — drives the avatar
  // photo in the header and the "Mon profil" modal.
  // Keyed by IDutilisateur: on shared PCs a user switch must not serve the
  // previous user's cached profile (photo/signature) within staleTime.
  const { data: profileMe } = useQuery<UserProfileMe>({
    queryKey: ['user-profile-me', user?.IDutilisateur],
    queryFn: () => apiFetch<UserProfileMe>('/user-profiles/me'),
    enabled: !!user,
  })
  const photoUrl = user && profileMe?.hasPhoto
    ? userPhotoUrl(user.IDutilisateur, profileMe.photoVersion)
    : undefined

  // Close the user menu when clicking outside
  useEffect(() => {
    if (!userMenuOpen) return
    const onClick = (e: MouseEvent) => {
      if (!userMenuRef.current) return
      if (!userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [userMenuOpen])

  const userInitials = (() => {
    if (!user) return '?'
    const p = (user.prenom?.trim() ?? '')[0] ?? ''
    const n = (user.nom?.trim() ?? '')[0] ?? ''
    return (`${p}${n}`.toUpperCase()) || '?'
  })()
  const userDisplay = (() => {
    if (!user) return ''
    const p = user.prenom?.trim() ?? ''
    const n = user.nom?.trim() ?? ''
    return [p, n].filter(Boolean).join(' ') || '—'
  })()

  // Track fullscreen state changes (e.g., when user presses Escape)
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen()
      } else {
        await document.exitFullscreen()
      }
    } catch (err) {
      console.error('Fullscreen error:', err)
    }
  }, [])

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-gold/30 bg-gradient-to-r from-gold/40 via-gold/15 to-transparent px-4 lg:px-6 shadow-sm">
      {/* Mobile menu button */}
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={onMenuClick}
      >
        <Menu className="h-5 w-5" />
        <span className="sr-only">Menu</span>
      </Button>

      {/* Submenu tabs */}
      {activeMenu && activeMenu.submenus.length > 0 && (
        <nav className="flex gap-1 overflow-x-auto">
          {activeMenu.submenus.map((submenu) => (
            <NavLink
              key={submenu.href}
              to={submenu.href}
              className={({ isActive }) =>
                cn(
                  'px-4 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
                  isActive
                    ? 'bg-accent text-accent-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-accent/10 hover:text-accent'
                )
              }
            >
              {submenu.title}
            </NavLink>
          ))}
        </nav>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Actions */}
      <div className="flex items-center gap-2">
        {/* Ticket report — red count badge when tickets have news */}
        <div className="relative">
          <Button
            variant="ghost"
            size="icon"
            onClick={openTicketModal}
            title={
              unreadCount > 0
                ? `${unreadCount} ticket${unreadCount > 1 ? 's' : ''} mis à jour`
                : 'Envoyer un ticket'
            }
          >
            <MessageSquarePlus className="h-5 w-5" />
            <span className="sr-only">
              {unreadCount > 0
                ? `Envoyer un ticket — ${unreadCount} mis à jour`
                : 'Envoyer un ticket'}
            </span>
          </Button>
          {unreadCount > 0 && (
            <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white/80 shadow-sm pointer-events-none">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </div>

        {/* Fullscreen toggle */}
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Quitter plein écran' : 'Plein écran'}
        >
          {isFullscreen ? (
            <Minimize2 className="h-5 w-5" />
          ) : (
            <Maximize2 className="h-5 w-5" />
          )}
          <span className="sr-only">
            {isFullscreen ? 'Quitter plein écran' : 'Plein écran'}
          </span>
        </Button>

        {/* User menu — avatar with initials, click to reveal name + logout */}
        <div className="relative" ref={userMenuRef}>
          <button
            onClick={() => setUserMenuOpen((o) => !o)}
            title={userDisplay || 'Utilisateur'}
            className={cn(
              'h-9 w-9 rounded-full flex items-center justify-center font-heading font-bold text-sm shadow-sm transition-all overflow-hidden',
              'bg-gold text-gold-foreground',
              'hover:ring-2 hover:ring-gold/40 hover:shadow-md'
            )}
          >
            {photoUrl ? (
              <Avatar className="h-9 w-9" src={photoUrl} alt={userDisplay} fallback={userInitials} />
            ) : (
              userInitials
            )}
          </button>
          {userMenuOpen && user && (
            <div className="absolute right-0 top-full mt-2 w-56 rounded-lg border border-border bg-white shadow-lg p-3 z-50">
              <div className="flex items-center gap-3">
                {photoUrl ? (
                  <Avatar className="h-10 w-10 flex-shrink-0" src={photoUrl} alt={userDisplay} fallback={userInitials} />
                ) : (
                  <div className="h-10 w-10 rounded-full bg-gold flex items-center justify-center text-gold-foreground font-heading font-bold shadow-sm flex-shrink-0">
                    {userInitials}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-primary truncate">{userDisplay}</p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Utilisateur actif</p>
                </div>
              </div>
              <button
                onClick={() => { setUserMenuOpen(false); setProfileOpen(true) }}
                className="mt-3 w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-accent/10 hover:text-accent transition-colors border-t border-border/60 pt-3"
              >
                <CircleUser className="h-3 w-3" />
                Mon profil
              </button>
              {allowSwitch && (
                <button
                  onClick={() => { setUserMenuOpen(false); void logout() }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-accent/10 hover:text-accent transition-colors"
                >
                  <LogOut className="h-3 w-3" />
                  Changer d'utilisateur
                </button>
              )}
              <button
                onClick={() => void refreshApp()}
                disabled={refreshing}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-accent/10 hover:text-accent transition-colors disabled:opacity-60"
              >
                <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
                Actualiser l'application
              </button>
              <div className="mt-2 pt-2 border-t border-border/60 px-2">
                <p className="text-[10px] text-muted-foreground text-center">
                  Version {__APP_VERSION__}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
      <TicketModal
        open={ticketOpen}
        onOpenChange={setTicketOpen}
        initialScreenshot={screenshot}
        capturingScreenshot={capturingScreenshot}
      />
    </header>
  )
}
