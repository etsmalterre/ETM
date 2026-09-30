import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { useUser } from '@/contexts/UserContext'

/** GET /rh/acces — whether the current user may open RH (apps/api/src/lib/rh-acces.ts)
 *  and whether they unlocked it (password, or the code RH for an account without one).
 *  Anyone else gets `{ autorise: false }` and never sees the menu. */
export interface RhAcces {
  autorise: boolean
  personne?: string
  deverrouille?: boolean
  codeDefini?: boolean
  /** What unlocks RH: the account password, or (account without one yet) the code RH. */
  methode?: 'mot_de_passe' | 'code'
  configure?: boolean
}

export const RH_ACCES_KEY = ['rh', 'acces'] as const

/** Keyed by user id: switching identity in the picker must re-ask (the RH
 *  cookie is bound to the person, so another person is locked out again). */
export function useRhAcces() {
  const { user } = useUser()
  return useQuery<RhAcces>({
    queryKey: [...RH_ACCES_KEY, user?.IDutilisateur ?? 0],
    enabled: !!user,
    queryFn: () => apiFetch('/rh/acces'),
    staleTime: 60_000,
    retry: false,
  })
}
