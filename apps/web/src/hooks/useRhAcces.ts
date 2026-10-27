import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { useUser } from '@/contexts/UserContext'

/** GET /rh/acces — whether the current user may open RH (apps/api/src/lib/rh-acces.ts).
 *  Anyone else gets `{ autorise: false }` and never sees the menu. */
export interface RhAcces {
  autorise: boolean
  personne?: string
  configure?: boolean
}

export const RH_ACCES_KEY = ['rh', 'acces'] as const

/** Keyed by user id: the grant is per person, so another account asks again. */
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
