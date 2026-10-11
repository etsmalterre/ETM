// /sous-traitants/commandes was split into › Ennoblissement and › Tricotage
// (2026-10-11). The old address lives on in sent mails, notifications and
// bookmarks: send it to the menu its order belongs to.

import { Navigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import type { SstFamille } from '@/pages/SousTraitantsCommandes'

export function SstCommandesRedirect() {
  const [searchParams] = useSearchParams()
  const raw = parseInt(searchParams.get('commande') ?? '', 10)
  const commandeId = isNaN(raw) || raw <= 0 ? null : raw
  const { data, isError } = useQuery<{ famille: SstFamille }>({
    queryKey: ['commande-sst-famille', commandeId],
    queryFn: () => apiFetch(`/commandes-sous-traitant/${commandeId}/famille`),
    enabled: commandeId !== null,
    retry: false,
  })
  if (commandeId === null) return <Navigate to="/sous-traitants/ennoblissement" replace />
  if (isError) return <Navigate to="/sous-traitants/ennoblissement" replace />
  if (!data) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    )
  }
  return <Navigate to={`/sous-traitants/${data.famille}?commande=${commandeId}`} replace />
}
