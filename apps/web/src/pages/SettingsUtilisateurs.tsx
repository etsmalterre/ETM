// Settings > Utilisateurs — admin-only page for managing per-user permissions.
// Built on the canonical 3-panel MasterDetailLayout: searchable user list on
// the left, a header + a Classeur-style master-tabbed centre (Profil = email /
// photo / signature cards, Permissions = toggle cards per category).
//
// Permissions are toggled inline (no edit mode). Each toggle immediately PUTs
// the new grant set to /api/permissions/users/:id and refreshes the list.

import { useState, useMemo, useEffect, useRef } from 'react'
import { Navigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Search, Loader2, AlertCircle, Shield, Check, Mail, Save, Bell,
  Image as ImageIcon, PenLine, Trash2, User as UserIcon, ChevronDown,
} from 'lucide-react'
import { apiFetch, API_URL } from '@/lib/api'
import { useUser } from '@/contexts/UserContext'
import { usePermissions } from '@/contexts/PermissionsContext'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar } from '@/components/ui/avatar'
import { SignaturePreview } from '@/components/ui/signature-preview'
import { userPhotoUrl } from '@/components/profile/ProfileModal'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────

interface PermissionUser {
  IDutilisateur: number
  prenom: string | null
  nom: string | null
  roleHint: string | null
  granted: string[]
}

interface UserEmailRow {
  IDutilisateur: number
  prenom: string | null
  nom: string | null
  email: string | null
}

interface SignatureFields {
  displayName: string
  fonction: string
  telFixe: string
  email: string
}

const EMPTY_SIGNATURE: SignatureFields = {
  displayName: '',
  fonction: '',
  telFixe: '',
  email: '',
}

interface UserProfileRow {
  IDutilisateur: number
  prenom: string | null
  nom: string | null
  /** Structured signature fields (null when none saved yet) */
  signature: SignatureFields | null
  /** True when the user still has an old pasted-HTML signature */
  hasLegacySignature: boolean
  /** Rendered signature HTML (template, data-URI logo) or legacy HTML */
  signatureHtml: string | null
  hasPhoto: boolean
  photoVersion: number | null
}

interface PermissionKeyDef {
  key: string
  label: string
  description: string
  category: string
  /** Sub-permission: rendered indented under its parent toggle, visible only
   *  while the parent is granted. */
  parent?: string
}

/** Notification catalog entries share PermissionKeyDef's shape (minus `parent`)
 *  so the Notifications tab reuses CategorySection as-is. */
interface NotificationSubscriptionRow {
  IDutilisateur: number
  subscribed: string[]
}

// Maps the lowercase pc value to a human-readable role label (same as picker).
const ROLE_LABELS: Array<{ test: (pc: string) => boolean; label: string }> = [
  { test: (pc) => pc.includes('visitage'), label: 'Inspection qualité' },
  { test: (pc) => pc.includes('regleur'), label: 'Réglage machines' },
  { test: (pc) => pc === 'accueil-pc', label: 'Accueil' },
]

function roleLabel(roleHint: string | null): string | null {
  if (!roleHint) return null
  for (const r of ROLE_LABELS) if (r.test(roleHint)) return r.label
  return null
}

function initials(u: PermissionUser): string {
  const p = (u.prenom?.trim() ?? '')[0] ?? ''
  const n = (u.nom?.trim() ?? '')[0] ?? ''
  return (`${p}${n}`.toUpperCase()) || '?'
}

function displayName(u: PermissionUser): string {
  const p = u.prenom?.trim() ?? ''
  const n = u.nom?.trim() ?? ''
  return [p, n].filter(Boolean).join(' ') || '—'
}

function isVincent(u: PermissionUser): boolean {
  return (
    (u.prenom?.trim().toLowerCase() === 'vincent') &&
    (u.nom?.trim().toLowerCase() === 'malterre')
  )
}

// ── Page ───────────────────────────────────────────────

export function SettingsUtilisateurs() {
  const { user } = useUser()
  // Only EFFECTIVE admins (admin acting as themselves) can access this page.
  // When an admin impersonates another user, this drops to false and the
  // route guard below redirects to /. The admin must switch back to
  // themselves first via the header avatar to regain access.
  const { isEffectiveAdmin: viewerIsAdmin } = usePermissions()
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  // ── Data ───────────────────────────────────────
  const { data: users, isLoading, isError, error } = useQuery<PermissionUser[]>({
    queryKey: ['perm-users'],
    queryFn: () => apiFetch<PermissionUser[]>('/permissions/users'),
    enabled: viewerIsAdmin,
  })

  const { data: keys } = useQuery<PermissionKeyDef[]>({
    queryKey: ['perm-keys'],
    queryFn: () => apiFetch<PermissionKeyDef[]>('/permissions/keys'),
    staleTime: Infinity,
  })

  // Fetched in parallel with the permissions list; used to pre-fill the
  // email editor card in the detail view.
  const { data: emails } = useQuery<UserEmailRow[]>({
    queryKey: ['user-emails'],
    queryFn: () => apiFetch<UserEmailRow[]>('/user-emails/users'),
    enabled: viewerIsAdmin,
  })

  const emailByUserId = useMemo(() => {
    const map = new Map<number, string>()
    if (emails) for (const e of emails) map.set(e.IDutilisateur, e.email ?? '')
    return map
  }, [emails])

  // Per-user photo + HTML signature (admin-managed, JSON side-store).
  const { data: profiles } = useQuery<UserProfileRow[]>({
    queryKey: ['user-profiles'],
    queryFn: () => apiFetch<UserProfileRow[]>('/user-profiles/users'),
    enabled: viewerIsAdmin,
  })

  const profileByUserId = useMemo(() => {
    const map = new Map<number, UserProfileRow>()
    if (profiles) for (const p of profiles) map.set(p.IDutilisateur, p)
    return map
  }, [profiles])

  // Notification subscriptions — same shape as permissions, separate store
  // (see api/src/lib/notification-keys.ts for why they aren't permissions).
  const { data: notifKeys } = useQuery<PermissionKeyDef[]>({
    queryKey: ['notif-keys'],
    queryFn: () => apiFetch<PermissionKeyDef[]>('/notifications/keys'),
    staleTime: Infinity,
  })

  const { data: notifRows } = useQuery<NotificationSubscriptionRow[]>({
    queryKey: ['notif-users'],
    queryFn: () => apiFetch<NotificationSubscriptionRow[]>('/notifications/users'),
    enabled: viewerIsAdmin,
  })

  const subscribedByUserId = useMemo(() => {
    const map = new Map<number, string[]>()
    if (notifRows) for (const r of notifRows) map.set(r.IDutilisateur, r.subscribed)
    return map
  }, [notifRows])

  const updateNotifMut = useMutation({
    mutationFn: ({ id, subscribed }: { id: number; subscribed: string[] }) =>
      apiFetch<{ IDutilisateur: number; subscribed: string[] }>(
        `/notifications/users/${id}`,
        { method: 'PUT', body: JSON.stringify({ subscribed }) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notif-users'] })
    },
  })

  const setEmailMut = useMutation({
    mutationFn: ({ id, email }: { id: number; email: string }) =>
      apiFetch<{ IDutilisateur: number; email: string | null }>(
        `/user-emails/users/${id}`,
        { method: 'PUT', body: JSON.stringify({ email }) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-emails'] })
    },
  })

  // Auto-select first user once loaded (desktop only — stacked mode lands on the list)
  useAutoSelectFirst({
    rows: users,
    selectedId,
    getId: (u) => u.IDutilisateur,
    select: setSelectedId,
    behavior: 'fill',
  })

  // ── Mutation: toggle a permission key ─────────
  const updateMut = useMutation({
    mutationFn: ({ id, granted }: { id: number; granted: string[] }) =>
      apiFetch<{ IDutilisateur: number; granted: string[] }>(
        `/permissions/users/${id}`,
        { method: 'PUT', body: JSON.stringify({ granted }) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['perm-users'] })
    },
  })

  const filtered = useMemo(() => {
    if (!users) return []
    if (!searchQuery.trim()) return users
    const q = searchQuery.toLowerCase()
    return users.filter((u) => displayName(u).toLowerCase().includes(q))
  }, [users, searchQuery])

  const selected = useMemo(() => {
    if (!users || selectedId === null) return null
    return users.find((u) => u.IDutilisateur === selectedId) ?? null
  }, [users, selectedId])

  // ── Admin guard (belt-and-suspenders) ──────────
  // Sidebar already hides the link, but a direct URL hit needs page-level
  // protection too. Wait until the user context has loaded before deciding,
  // otherwise a brief flicker would redirect admins to /.
  if (!user) return null
  if (!viewerIsAdmin) return <Navigate to="/" replace />

  // ── Render ─────────────────────────────────────
  return (
    <MasterDetailLayout
      hasSelection={selectedId !== null}
      onBack={() => setSelectedId(null)}
      sidebarTitle="Informations"
      sidebar={null}
      list={
        <UserList
          rows={filtered}
          isLoading={isLoading}
          isError={isError}
          error={error as Error | null}
          selectedId={selectedId}
          onSelect={setSelectedId}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />
      }
      detailHeader={<DetailHeader user={selected} />}
      detail={
        <DetailBody
          user={selected}
          profile={selected ? profileByUserId.get(selected.IDutilisateur) ?? null : null}
          currentEmail={selected ? emailByUserId.get(selected.IDutilisateur) ?? '' : ''}
          onSaveEmail={(email) => {
            if (!selected) return
            setEmailMut.mutate({ id: selected.IDutilisateur, email })
          }}
          isSavingEmail={setEmailMut.isPending}
          emailSaveError={setEmailMut.error instanceof Error ? setEmailMut.error.message : null}
          keys={keys ?? []}
          notifKeys={notifKeys ?? []}
          subscribed={selected ? subscribedByUserId.get(selected.IDutilisateur) ?? [] : []}
          isUpdatingNotif={updateNotifMut.isPending}
          onToggleNotif={(key, nextValue) => {
            if (!selected) return
            const current = new Set(subscribedByUserId.get(selected.IDutilisateur) ?? [])
            if (nextValue) current.add(key)
            else current.delete(key)
            updateNotifMut.mutate({ id: selected.IDutilisateur, subscribed: Array.from(current) })
          }}
          isUpdating={updateMut.isPending}
          onToggle={(key, nextValue) => {
            if (!selected) return
            const current = new Set(selected.granted)
            // Toggling a parent cascades to its sub-permissions: ON grants
            // every child (the admin can then narrow), OFF removes them all.
            const children = (keys ?? []).filter((k) => k.parent === key).map((k) => k.key)
            if (nextValue) {
              current.add(key)
              for (const c of children) current.add(c)
            } else {
              current.delete(key)
              for (const c of children) current.delete(c)
            }
            updateMut.mutate({ id: selected.IDutilisateur, granted: Array.from(current) })
          }}
        />
      }
    />
  )
}

// ── Left Panel: List ───────────────────────────────────

function UserList({
  rows, isLoading, isError, error,
  selectedId, onSelect,
  searchQuery, onSearchChange,
}: {
  rows: PermissionUser[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (q: string) => void
}) {
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      {/* Search header */}
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Rechercher un utilisateur..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            autoComplete="off"
            className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      {/* List body */}
      <div className="flex-1 overflow-auto p-3 space-y-2 scrollbar-transparent">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-8 text-destructive">
            <AlertCircle className="h-6 w-6 mb-2" />
            <p className="text-sm">{error?.message || 'Erreur'}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <p className="text-sm">Aucun utilisateur</p>
          </div>
        ) : rows.map((u) => {
          const isSelected = selectedId === u.IDutilisateur
          const role = roleLabel(u.roleHint)
          const isVin = isVincent(u)
          return (
            <div
              key={u.IDutilisateur}
              onClick={() => onSelect(u.IDutilisateur)}
              className={cn(
                'p-3 border rounded-lg cursor-pointer transition-all bg-white flex items-center gap-3',
                isSelected
                  ? 'border-accent ring-1 ring-accent'
                  : 'border-border hover:border-accent/50'
              )}
            >
              <div className="h-8 w-8 rounded-full bg-gold flex items-center justify-center text-gold-foreground text-xs font-bold flex-shrink-0">
                {initials(u)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-medium truncate">{displayName(u)}</p>
                  {isVin && (
                    <Shield className="h-3 w-3 text-accent flex-shrink-0" />
                  )}
                </div>
                {role && (
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide truncate">{role}</p>
                )}
              </div>
              {u.granted.length > 0 && (
                <span className="text-[10px] text-muted-foreground tabular-nums flex-shrink-0">
                  {u.granted.length}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer count */}
      {rows.length > 0 && (
        <div className="p-3 border-t text-xs text-muted-foreground rounded-b-lg bg-zinc-200/50">
          {rows.length} utilisateur{rows.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  )
}

// ── Center: Detail Header ──────────────────────────────

function DetailHeader({ user }: { user: PermissionUser | null }) {
  if (!user) return null
  const isVin = isVincent(user)
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className="h-12 w-12 rounded-full bg-gold flex items-center justify-center text-gold-foreground font-heading font-bold shadow-sm">
          {initials(user)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-heading font-bold tracking-tight truncate">
              {displayName(user)}
            </h1>
            {isVin && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent/15 text-accent text-[10px] font-bold uppercase tracking-wide">
                <Shield className="h-3 w-3" />
                Administrateur
              </span>
            )}
          </div>
          {user.roleHint && (
            <p className="text-xs text-muted-foreground mt-1">{user.roleHint}</p>
          )}
        </div>
      </div>
      <div className="h-1 w-24 mt-3 rounded-full bg-gradient-to-r from-accent via-accent to-accent/30" />
    </div>
  )
}

// ── Center: Detail Body (Profil / Permissions master tabs) ──────────

const MAIN_TABS = [
  { key: 'profil', label: 'Profil', icon: UserIcon },
  { key: 'permissions', label: 'Permissions', icon: Shield },
  { key: 'notifications', label: 'Notifications', icon: Bell },
] as const
type MainTab = (typeof MAIN_TABS)[number]['key']

function DetailBody({
  user, profile, currentEmail, onSaveEmail, isSavingEmail, emailSaveError,
  keys, isUpdating, onToggle,
  notifKeys, subscribed, isUpdatingNotif, onToggleNotif,
}: {
  user: PermissionUser | null
  profile: UserProfileRow | null
  currentEmail: string
  onSaveEmail: (email: string) => void
  isSavingEmail: boolean
  emailSaveError: string | null
  keys: PermissionKeyDef[]
  isUpdating: boolean
  onToggle: (key: string, nextValue: boolean) => void
  notifKeys: PermissionKeyDef[]
  subscribed: string[]
  isUpdatingNotif: boolean
  onToggleNotif: (key: string, nextValue: boolean) => void
}) {
  const [activeTab, setActiveTab] = useState<MainTab>('profil')

  // Land back on the main-info tab whenever the selection changes.
  useEffect(() => { setActiveTab('profil') }, [user?.IDutilisateur])

  // Group keys by category. Hooks must run before the early return below,
  // so this useMemo lives here even though `user` may be null.
  const grouped = useMemo(() => {
    const g = new Map<string, PermissionKeyDef[]>()
    for (const k of keys) {
      const cat = k.category || 'Général'
      if (!g.has(cat)) g.set(cat, [])
      g.get(cat)!.push(k)
    }
    return Array.from(g.entries())
  }, [keys])

  const notifGrouped = useMemo(() => {
    const g = new Map<string, PermissionKeyDef[]>()
    for (const k of notifKeys) {
      const cat = k.category || 'Général'
      if (!g.has(cat)) g.set(cat, [])
      g.get(cat)!.push(k)
    }
    return Array.from(g.entries())
  }, [notifKeys])

  if (!user) return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="icon-box-gold h-16 w-16 mx-auto"><Shield className="h-8 w-8" /></div>
        <p className="text-muted-foreground text-sm">Sélectionnez un utilisateur dans la liste</p>
      </div>
    </div>
  )

  const isVin = isVincent(user)
  const grantedSet = new Set(user.granted)

  // The "Tableau de bord" section leads the permission list, then all other
  // permission categories.
  const dashboardGroup = grouped.find(([cat]) => cat === 'Tableau de bord')
  const otherGroups = grouped.filter(([cat]) => cat !== 'Tableau de bord')

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Master tabs — header-submenu style pills on the natural background */}
      <div className="flex-shrink-0 flex items-center gap-1 border-b border-border/60 pb-2">
        {MAIN_TABS.map((t) => {
          const Icon = t.icon
          const active = activeTab === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
                active
                  ? 'bg-accent text-accent-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/10 hover:text-accent',
              )}
            >
              <Icon className="h-3.5 w-3.5" />{t.label}
            </button>
          )
        })}
      </div>

      {/* px-1/pb-1 keep focus rings and hover borders clear of the overflow clip */}
      <div className="flex-1 min-h-0 overflow-auto space-y-4 pt-3 px-1 pb-1 scrollbar-transparent">
        {activeTab === 'profil' && (
          <>
            <EmailEditor
              userId={user.IDutilisateur}
              currentEmail={currentEmail}
              onSave={onSaveEmail}
              isSaving={isSavingEmail}
              saveError={emailSaveError}
            />

            <PhotoEditor user={user} profile={profile} />

            <SignatureEditor
              user={user}
              profile={profile}
              currentEmail={currentEmail}
            />
          </>
        )}

        {activeTab === 'permissions' && (
          <>
            {isVin && (
              <div className="flex items-start gap-3 p-3 rounded-lg border border-accent/40 bg-accent/[0.06]">
                <Shield className="h-4 w-4 text-accent flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-bold text-primary">Cet utilisateur est administrateur</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Les administrateurs disposent automatiquement de toutes les permissions, indépendamment des
                    cases ci-dessous. Aucun toggle ne peut leur retirer un droit.
                  </p>
                </div>
              </div>
            )}

            {dashboardGroup && (
              <CategorySection
                category={dashboardGroup[0]}
                items={dashboardGroup[1]}
                isVin={isVin}
                isUpdating={isUpdating}
                grantedSet={grantedSet}
                onToggle={onToggle}
              />
            )}

            {otherGroups.map(([category, items]) => (
              <CategorySection
                key={category}
                category={category}
                items={items}
                isVin={isVin}
                isUpdating={isUpdating}
                grantedSet={grantedSet}
                onToggle={onToggle}
              />
            ))}
          </>
        )}

        {activeTab === 'notifications' && (
          <>
            {/* Notifications are opt-in for everyone — there is no admin
                bypass, hence isVin={false} on the sections below. */}
            <div className="flex items-start gap-3 p-3 rounded-lg border border-border/60 bg-white shadow-sm">
              <Bell className="h-4 w-4 text-accent flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold">Notifications par email</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Cet utilisateur reçoit un email à chaque évènement activé ci-dessous, à l’adresse
                  définie dans l’onglet « Profil ». Les administrateurs ne sont pas abonnés
                  automatiquement.
                </p>
              </div>
            </div>

            {subscribed.length > 0 && !currentEmail.trim() && (
              <div className="flex items-start gap-3 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10">
                <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-bold text-amber-800">Aucune adresse email définie</p>
                  <p className="text-xs text-amber-800/80 mt-0.5">
                    Les notifications activées ci-dessous ne seront envoyées à personne tant qu’une
                    adresse n’est pas renseignée dans l’onglet « Profil ».
                  </p>
                </div>
              </div>
            )}

            {notifGrouped.map(([category, items]) => (
              <CategorySection
                key={category}
                category={category}
                items={items}
                isVin={false}
                isUpdating={isUpdatingNotif}
                grantedSet={new Set(subscribed)}
                onToggle={onToggleNotif}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

// ── A single permission category card (header + toggle rows) ───────────

function CategorySection({
  category, items, isVin, isUpdating, grantedSet, onToggle,
}: {
  category: string
  items: PermissionKeyDef[]
  isVin: boolean
  isUpdating: boolean
  grantedSet: Set<string>
  onToggle: (key: string, nextValue: boolean) => void
}) {
  // Collapsed by default so the tab reads as a compact section index — the
  // admin expands only the section they came to check (§23 collapsible cards).
  const [open, setOpen] = useState(false)

  // Sub-permissions render indented under their parent row, and only while
  // the parent is granted (toggling the parent on auto-grants them all).
  const topLevel = items.filter((k) => !k.parent)
  const childrenOf = (parentKey: string) => items.filter((k) => k.parent === parentKey)

  const grantedCount = items.filter((k) => isVin || grantedSet.has(k.key)).length

  return (
    <div className="rounded-lg border border-border/60 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'w-full flex items-center gap-2 px-4 py-2.5 bg-zinc-100/80 cursor-pointer select-none transition-colors hover:bg-zinc-200/60',
          open ? 'border-b border-border/60 rounded-t-lg' : 'rounded-lg',
        )}
      >
        <p className="text-xs font-bold text-primary uppercase tracking-wide">{category}</p>
        <Badge variant="secondary" className="text-xs ml-auto tabular-nums">
          {grantedCount}/{items.length}
        </Badge>
        <ChevronDown
          className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
      <div className="divide-y divide-border/60">
        {topLevel.map((k) => {
          const checked = isVin || grantedSet.has(k.key)
          const children = childrenOf(k.key)
          return (
            <div key={k.key}>
              <label
                className={cn(
                  'flex items-center gap-3 px-4 py-3 transition-colors',
                  isVin || isUpdating ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-zinc-50',
                )}
              >
                <ToggleSwitch
                  checked={checked}
                  disabled={isVin || isUpdating}
                  onChange={(next) => onToggle(k.key, next)}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{k.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{k.description}</p>
                </div>
              </label>
              {checked && children.length > 0 && (
                <div className="ml-12 mr-4 mb-3 border-l-2 border-accent/25 pl-3 space-y-0.5">
                  {children.map((c) => {
                    const childChecked = isVin || grantedSet.has(c.key)
                    return (
                      <label
                        key={c.key}
                        className={cn(
                          'flex items-center gap-3 py-1.5 rounded-md transition-colors',
                          isVin || isUpdating ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-zinc-50',
                        )}
                      >
                        <ToggleSwitch
                          checked={childChecked}
                          disabled={isVin || isUpdating}
                          onChange={(next) => onToggle(c.key, next)}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground">{c.label}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{c.description}</p>
                        </div>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
      )}
    </div>
  )
}

// ── Email editor card ─────────────────────────────────
// Local draft state so the user can type freely; Enregistrer is enabled
// only when the draft differs from the persisted value. Empty string
// clears the mapping.

function EmailEditor({
  userId, currentEmail, onSave, isSaving, saveError,
}: {
  userId: number
  currentEmail: string
  onSave: (email: string) => void
  isSaving: boolean
  saveError: string | null
}) {
  const [draft, setDraft] = useState(currentEmail)

  // Reset draft whenever the selected user changes, OR when the persisted
  // value changes after a save. Keyed on userId + currentEmail so both
  // cases trigger the reset.
  useEffect(() => {
    setDraft(currentEmail)
  }, [userId, currentEmail])

  const trimmed = draft.trim()
  const isDirty = trimmed !== (currentEmail ?? '').trim()
  const looksValid = trimmed === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)

  return (
    <div className="rounded-lg border border-border/60 bg-white shadow-sm">
      <div className="px-4 py-2 border-b border-border/60 bg-zinc-100/80 rounded-t-lg flex items-center gap-2">
        <Mail className="h-3.5 w-3.5 text-accent" />
        <p className="text-xs font-bold text-primary uppercase tracking-wide">Adresse email</p>
      </div>
      <div className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <input
            type="email"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="prenom.nom@etsmalterre.com"
            autoComplete="off"
            className="flex-1 h-9 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <Button
            size="sm"
            onClick={() => onSave(trimmed)}
            disabled={!isDirty || !looksValid || isSaving}
          >
            {isSaving ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Enregistrement…</>
            ) : (
              <><Save className="h-3.5 w-3.5 mr-1.5" />Enregistrer</>
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Adresse utilisée pour envoyer les emails (bon de commande, etc.) depuis l'application.
          Laisser vide pour désactiver l'envoi d'email par cet utilisateur.
        </p>
        {!looksValid && trimmed !== '' && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            Adresse email invalide
          </p>
        )}
        {saveError && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            {saveError}
          </p>
        )}
      </div>
    </div>
  )
}

// ── Photo editor card ─────────────────────────────────
// Admin picks an image file → immediate upload (multipart, raw fetch — the
// shared apiFetch forces a JSON Content-Type). Photo is stored on disk
// server-side; the ?v=<photoVersion> query string busts caches after upload.

const MAX_PHOTO_BYTES = 5 * 1024 * 1024

function PhotoEditor({ user, profile }: { user: PermissionUser; profile: UserProfileRow | null }) {
  const { user: viewer } = useUser()
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const userId = user.IDutilisateur
  const hasPhoto = profile?.hasPhoto ?? false

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['user-profiles'] })
    // Editing one's own photo must refresh the header avatar too.
    if (viewer && viewer.IDutilisateur === userId) {
      queryClient.invalidateQueries({ queryKey: ['user-profile-me'] })
    }
  }

  const uploadMut = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData()
      fd.append('photo', file)
      const res = await fetch(`${API_URL}/user-profiles/users/${userId}/photo`, {
        method: 'PUT',
        body: fd,
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`Erreur HTTP ${res.status}`)
      return res.json()
    },
    onSuccess: invalidate,
    onError: (err) => setUploadError(err instanceof Error ? err.message : 'Erreur'),
  })

  const deleteMut = useMutation({
    mutationFn: () => apiFetch(`/user-profiles/users/${userId}/photo`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  const handlePick = (file: File | undefined) => {
    if (!file) return
    setUploadError(null)
    if (file.size > MAX_PHOTO_BYTES) {
      setUploadError("L'image dépasse la limite de 5 Mo.")
      return
    }
    uploadMut.mutate(file)
  }

  return (
    <div className="rounded-lg border border-border/60 bg-white shadow-sm">
      <div className="px-4 py-2 border-b border-border/60 bg-zinc-100/80 rounded-t-lg flex items-center gap-2">
        <ImageIcon className="h-3.5 w-3.5 text-accent" />
        <p className="text-xs font-bold text-primary uppercase tracking-wide">Photo</p>
      </div>
      <div className="p-4 space-y-2">
        <div className="flex items-center gap-4">
          <Avatar
            className="h-16 w-16 text-lg"
            src={hasPhoto ? userPhotoUrl(userId, profile?.photoVersion ?? null) : undefined}
            alt={displayName(user)}
            fallback={initials(user)}
          />
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onClick={(e) => { (e.target as HTMLInputElement).value = '' }}
              onChange={(e) => handlePick(e.target.files?.[0])}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={uploadMut.isPending}
              onClick={() => fileRef.current?.click()}
            >
              {uploadMut.isPending ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Envoi…</>
              ) : (
                <><ImageIcon className="h-3.5 w-3.5 mr-1.5" />Choisir une photo…</>
              )}
            </Button>
            {hasPhoto && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={deleteMut.isPending}
                onClick={() => deleteMut.mutate()}
              >
                {deleteMut.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                )}
                Supprimer la photo
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Affichée dans l'en-tête de l'application et dans « Mon profil ». Formats acceptés : JPG, PNG, WebP, GIF (5 Mo max).
        </p>
        {uploadError && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            {uploadError}
          </p>
        )}
      </div>
    </div>
  )
}

// ── Signature editor card ─────────────────────────────
// The signature is generated server-side from a company template — the admin
// only fills a handful of fields (nom, fonction, téléphone, email). A live
// preview renders the exact template via POST /signature-preview (debounced).
// Same draft-state pattern as EmailEditor: local draft, Enregistrer enabled
// only when dirty. Saving all-empty fields clears the signature.

// Company switchboard — default landline prefill for a fresh signature.
const COMPANY_TEL = '03 22 35 36 66'

function sigFieldsEqual(a: SignatureFields, b: SignatureFields): boolean {
  return (
    a.displayName.trim() === b.displayName.trim() &&
    a.fonction.trim() === b.fonction.trim() &&
    a.telFixe.trim() === b.telFixe.trim() &&
    a.email.trim() === b.email.trim()
  )
}

function sigHasContent(f: SignatureFields): boolean {
  return Object.values(f).some((v) => v.trim() !== '')
}

function SignatureEditor({
  user, profile, currentEmail,
}: {
  user: PermissionUser
  profile: UserProfileRow | null
  currentEmail: string
}) {
  const { user: viewer } = useUser()
  const queryClient = useQueryClient()
  const userId = user.IDutilisateur

  const stored = profile?.signature ?? null
  const storedKey = JSON.stringify(stored)

  // Prefill source for users without a saved signature. Read through a ref
  // so the reset effect below doesn't need name/email in its deps (which
  // would clobber in-progress edits whenever the email card saves).
  const prefillRef = useRef({ name: '', email: '' })
  prefillRef.current = { name: displayName(user), email: currentEmail }

  const initialDraft = (): SignatureFields =>
    stored ?? {
      displayName: prefillRef.current.name === '—' ? '' : prefillRef.current.name,
      fonction: '',
      telFixe: COMPANY_TEL,
      email: prefillRef.current.email,
    }

  const [draft, setDraft] = useState<SignatureFields>(initialDraft)

  // Reset draft whenever the selected user changes, OR when the persisted
  // value changes after a save.
  useEffect(() => {
    setDraft(initialDraft())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, storedKey])

  // The email mapping loads in parallel — if it arrives after the initial
  // prefill, fill the still-empty email field (never overwrite typed input).
  useEffect(() => {
    if (!stored && currentEmail) {
      setDraft((d) => (d.email === '' ? { ...d, email: currentEmail } : d))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEmail])

  const isDirty = !sigFieldsEqual(draft, stored ?? EMPTY_SIGNATURE)

  // Debounce the draft, then render the preview through the server template.
  const [debouncedDraft, setDebouncedDraft] = useState(draft)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedDraft(draft), 350)
    return () => clearTimeout(t)
  }, [draft])

  const { data: preview } = useQuery<{ html: string }>({
    queryKey: ['signature-preview', debouncedDraft],
    queryFn: () =>
      apiFetch<{ html: string }>('/user-profiles/signature-preview', {
        method: 'POST',
        body: JSON.stringify({ signature: debouncedDraft }),
      }),
    enabled: sigHasContent(debouncedDraft),
    staleTime: 5 * 60 * 1000,
    placeholderData: (prev) => prev,
  })

  const saveMut = useMutation({
    mutationFn: (fields: SignatureFields) =>
      apiFetch(`/user-profiles/users/${userId}/signature`, {
        method: 'PUT',
        body: JSON.stringify({ signature: fields }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-profiles'] })
      if (viewer && viewer.IDutilisateur === userId) {
        queryClient.invalidateQueries({ queryKey: ['user-profile-me'] })
      }
    },
  })

  const setField = (key: keyof SignatureFields) => (value: string) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const showPreview = sigHasContent(draft) && !!preview?.html

  return (
    <div className="rounded-lg border border-border/60 bg-white shadow-sm">
      <div className="px-4 py-2 border-b border-border/60 bg-zinc-100/80 rounded-t-lg flex items-center gap-2">
        <PenLine className="h-3.5 w-3.5 text-accent" />
        <p className="text-xs font-bold text-primary uppercase tracking-wide">Signature email</p>
        <div className="ml-auto flex items-center gap-1.5">
          {stored !== null && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={saveMut.isPending}
              onClick={() => saveMut.mutate(EMPTY_SIGNATURE)}
              title="Supprimer la signature de cet utilisateur"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              Effacer
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => saveMut.mutate(draft)}
            disabled={!isDirty || saveMut.isPending}
          >
            {saveMut.isPending ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Enregistrement…</>
            ) : (
              <><Save className="h-3.5 w-3.5 mr-1.5" />Enregistrer</>
            )}
          </Button>
        </div>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-xs text-muted-foreground">
          La signature est générée automatiquement au format Malterre à partir des champs
          ci-dessous. Le logo est intégré directement dans l'email envoyé (affichage immédiat
          chez le destinataire, sans téléchargement).
        </p>
        {profile?.hasLegacySignature && (
          <p className="text-xs text-amber-700 flex items-start gap-1.5 p-2 rounded-md border border-amber-300/60 bg-amber-50">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
            <span>
              Cet utilisateur utilise encore une ancienne signature HTML collée. Elle restera
              utilisée pour les envois tant que les champs ci-dessous ne sont pas enregistrés.
            </span>
          </p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <SigField label="Nom affiché" value={draft.displayName} onChange={setField('displayName')} placeholder="Prénom Nom" />
          <SigField label="Fonction" value={draft.fonction} onChange={setField('fonction')} placeholder="Gérant, Comptabilité…" />
          <SigField label="Téléphone" value={draft.telFixe} onChange={setField('telFixe')} placeholder={COMPANY_TEL} />
          <SigField
            label="Email affiché"
            value={draft.email}
            onChange={setField('email')}
            placeholder="prenom.nom@etsmalterre.com"
          />
        </div>
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Aperçu</p>
          {showPreview ? (
            <SignaturePreview html={preview.html} className="min-h-[150px]" />
          ) : (
            <p className="text-sm text-muted-foreground italic">Aucune signature</p>
          )}
        </div>
        {saveMut.error instanceof Error && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            {saveMut.error.message}
          </p>
        )}
      </div>
    </div>
  )
}

// ── Small labeled text input used by the signature form ─

function SigField({
  label, value, onChange, placeholder, className,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full h-8 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </div>
  )
}

// ── Toggle switch (styled checkbox) ───────────────────

function ToggleSwitch({
  checked, disabled, onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => { e.preventDefault(); onChange(!checked) }}
      className={cn(
        'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
        checked ? 'bg-gold' : 'bg-zinc-300',
        disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
      {checked && (
        <Check className="absolute left-0.5 top-1/2 -translate-y-1/2 h-2.5 w-2.5 text-gold-foreground/70" />
      )}
    </button>
  )
}
