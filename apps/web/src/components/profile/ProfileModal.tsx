// "Mon profil" modal — view-only summary of the logged-in user's profile:
// prénom/nom (from the user context), email (user-emails store), photo and
// rendered HTML signature (user-profiles store). Editing happens exclusively
// in Paramètres › Utilisateurs (admin only).

import { useQuery } from '@tanstack/react-query'
import { CircleUser, Loader2 } from 'lucide-react'
import { apiFetch, API_URL } from '@/lib/api'
import { useUser } from '@/contexts/UserContext'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/ui/avatar'
import { SignaturePreview } from '@/components/ui/signature-preview'

export interface UserProfileMe {
  IDutilisateur: number
  signatureHtml: string | null
  /** True when signatureHtml was derived from the user's identity because
   *  no signature is stored for them (see api lib/signature-defaults.ts). */
  signatureIsDefault?: boolean
  hasPhoto: boolean
  photoVersion: number | null
}

export function userPhotoUrl(userId: number, photoVersion: number | null): string {
  return `${API_URL}/user-profiles/users/${userId}/photo?v=${photoVersion ?? 0}`
}

export function ProfileModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useUser()

  // Both keys are scoped by IDutilisateur: on shared PCs a user switch must
  // not serve the previous user's cached profile/email within staleTime.
  const { data: profile, isLoading: profileLoading } = useQuery<UserProfileMe>({
    queryKey: ['user-profile-me', user?.IDutilisateur],
    queryFn: () => apiFetch<UserProfileMe>('/user-profiles/me'),
    enabled: open && !!user,
  })

  const { data: emailData, isLoading: emailLoading } = useQuery<{ email: string | null }>({
    queryKey: ['user-email-me', user?.IDutilisateur],
    queryFn: () => apiFetch<{ email: string | null }>('/user-emails/me'),
    enabled: open && !!user,
  })

  if (!user) return null

  const prenom = user.prenom?.trim() ?? ''
  const nom = user.nom?.trim() ?? ''
  const displayName = [prenom, nom].filter(Boolean).join(' ') || '—'
  const initials = (`${prenom[0] ?? ''}${nom[0] ?? ''}`.toUpperCase()) || '?'
  const isLoading = profileLoading || emailLoading

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CircleUser className="h-5 w-5 text-accent" />
            Mon profil
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
            </div>
          ) : (
            <>
              {/* Identity row */}
              <div className="flex items-center gap-4">
                <Avatar
                  className="h-16 w-16 text-lg"
                  src={profile?.hasPhoto ? userPhotoUrl(user.IDutilisateur, profile.photoVersion) : undefined}
                  alt={displayName}
                  fallback={initials}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-heading font-bold tracking-tight truncate">{displayName}</p>
                  {emailData?.email ? (
                    <p className="text-sm text-muted-foreground truncate">{emailData.email}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">Aucune adresse email configurée</p>
                  )}
                </div>
              </div>

              {/* Signature */}
              <div className="space-y-2">
                <p className="text-xs font-bold text-primary uppercase tracking-wide">Signature email</p>
                {profile?.signatureHtml ? (
                  <>
                    <SignaturePreview html={profile.signatureHtml} className="min-h-[140px]" />
                    {profile.signatureIsDefault && (
                      <p className="text-[11px] text-muted-foreground">
                        Signature automatique, générée à partir de votre nom et de votre adresse email.
                        Pour l'enrichir (fonction, téléphone), contactez un administrateur.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    Aucune signature définie — contactez un administrateur.
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Fermer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
