// Rappels: a dated note on an object (API lib/rappels.ts, routes/rappels.ts).
// The object's « Rappel » button and the notification centre's reminder card
// share these types, queries and gestures.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

/** The objects a reminder can be put on (API lib/rappels-objets.ts). */
export type TypeObjet = 'lot_fini' | 'lot_fil' | 'piece_ecru' | 'piece_fini' | 'commande_fil' | 'commande_client' | 'commande_sst'

export interface Rappel {
  id: number
  objet_type: TypeObjet
  objet_id: number
  objet_libelle: string
  /** 'YYYY-MM-DD' */
  echeance: string
  observation: string
  pour_id: number
  pour: string
  /** 'YYYY-MM-DD' */
  cree_le: string
  par_id: number
  par: string
  /** 'YYYY-MM-DD', null while open */
  fait_le: string | null
  fait_par: string | null
  fait_comment: string | null
  lien: string
}

export interface Destinataire { id: number; nom: string }

/** '2027-05-04' → '04/05/2027'. */
export function dateFr(iso: string | null | undefined): string {
  return iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : ''
}

/** Today, 'YYYY-MM-DD', on this computer's clock (the date input's `min`; the API has the last word). */
export function aujourdhuiIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const cleRappels = (type: TypeObjet, id: number) => ['rappels', type, id] as const

/** The reminders of one object, open ones first. */
export function useRappelsObjet(type: TypeObjet, id: number | null | undefined, enabled = true) {
  return useQuery<{ rappels: Rappel[] }>({
    queryKey: cleRappels(type, id ?? 0),
    queryFn: () => apiFetch(`/rappels?objet=${type}:${id}`),
    enabled: enabled && !!id && id > 0,
    staleTime: 30_000,
  })
}

/** Who a reminder can be for; `moi` is the caller's id (the default). */
export function useDestinataires(enabled: boolean) {
  return useQuery<{ destinataires: Destinataire[]; moi: number }>({
    queryKey: ['rappels-destinataires'],
    queryFn: () => apiFetch('/rappels/destinataires'),
    enabled,
    staleTime: 5 * 60_000,
  })
}

/** The four gestures. Each refreshes the objects' reminders and the notification centre (a reminder
 *  due is a task there). */
export function useGestesRappel() {
  const qc = useQueryClient()
  const rafraichir = () => {
    qc.invalidateQueries({ queryKey: ['rappels'] })
    qc.invalidateQueries({ queryKey: ['abonnements-notifications'] })
  }
  const creer = useMutation({
    mutationFn: (v: { objet_type: TypeObjet; objet_id: number; echeance: string; observation: string; pour_id?: number }) =>
      apiFetch<{ rappel: Rappel }>('/rappels', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: rafraichir,
  })
  const modifier = useMutation({
    mutationFn: ({ id, ...v }: { id: number; echeance?: string; observation?: string; pour_id?: number }) =>
      apiFetch<{ rappel: Rappel }>(`/rappels/${id}`, { method: 'PUT', body: JSON.stringify(v) }),
    onSuccess: rafraichir,
  })
  const fait = useMutation({
    mutationFn: ({ id, commentaire }: { id: number; commentaire?: string }) =>
      apiFetch<{ rappel: Rappel }>(`/rappels/${id}/fait`, { method: 'POST', body: JSON.stringify({ commentaire: commentaire || null }) }),
    onSuccess: rafraichir,
  })
  const supprimer = useMutation({
    mutationFn: (id: number) => apiFetch(`/rappels/${id}`, { method: 'DELETE' }),
    onSuccess: rafraichir,
  })
  return { creer, modifier, fait, supprimer }
}
