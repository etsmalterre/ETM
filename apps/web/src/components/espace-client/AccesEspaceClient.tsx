// « Espace client » on each contact card of Clients › Gestion › Contacts: who may use
// client.etsmalterre.fr is decided here, the portal only applies it (API
// routes/espace-client.ts, lib/espace-client-acces.ts). Read mode shows a chip beside the
// envoi chips (this state in its tooltip); this switch line is rendered in edit mode only,
// behind its own permission (gestion_acces_espace_client). It never joins the contact
// form's envoi checkboxes: turning it on e-mails the customer at once.

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, Loader2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'

export interface AccesContact {
  idcontact: number
  actif: boolean
  modifie_le: string
  modifie_par: string
  invitation_le: string | null
  mot_de_passe_le: string | null
  derniere_connexion_le: string | null
}

interface AccesClient {
  disponible: boolean
  contacts: AccesContact[]
}

export function useAccesEspaceClient(clientId: number) {
  return useQuery<AccesClient>({
    queryKey: ['espace-client-acces', clientId],
    queryFn: () => apiFetch(`/espace-client/clients/${clientId}`),
  })
}

const jour = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fr-FR') : null)

/** What the portal did with this access, most advanced step first. */
export function etatAccesEspaceClient(a: AccesContact | undefined): string {
  if (!a) return 'Pas d’accès'
  if (!a.actif) return `Accès retiré le ${jour(a.modifie_le)} par ${a.modifie_par}`
  if (a.derniere_connexion_le) return `Dernière connexion le ${jour(a.derniere_connexion_le)}`
  if (a.mot_de_passe_le) return `Mot de passe choisi le ${jour(a.mot_de_passe_le)}`
  if (a.invitation_le) return `Invitation envoyée le ${jour(a.invitation_le)}`
  return `Accès donné le ${jour(a.modifie_le)} par ${a.modifie_par} — invitation en attente`
}

export function AccesContactLine({ clientId, contactId, contactNom, mail, acces, editable }: {
  clientId: number
  contactId: number
  contactNom: string
  mail: string | null
  acces: AccesContact | undefined
  editable: boolean
}) {
  const queryClient = useQueryClient()
  const [confirm, setConfirm] = useState<boolean | null>(null)
  const mut = useMutation({
    mutationFn: (actif: boolean) => apiFetch(`/espace-client/contacts/${contactId}`, {
      method: 'PUT', body: JSON.stringify({ idclient: clientId, actif }),
    }),
    onSuccess: (payload: { contacts: AccesContact[] }) => {
      queryClient.setQueryData(['espace-client-acces', clientId], { disponible: true, contacts: payload.contacts })
      setConfirm(null)
    },
  })
  const actif = !!acces?.actif
  const sansMail = !mail?.trim()
  const disabled = !editable || mut.isPending || (sansMail && !actif)
  const erreur = mut.error ? String((mut.error as { body?: { error?: string } }).body?.error ?? 'Échec de l’enregistrement') : null

  return (
    <div className="mt-2 flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5">
      <Globe className={cn('h-3.5 w-3.5 flex-shrink-0', actif ? 'text-accent' : 'text-muted-foreground/60')} />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium">Espace client</div>
        <div className="text-[10px] text-muted-foreground truncate" title={etatAccesEspaceClient(acces)}>
          {sansMail && !actif ? 'Renseignez un e-mail pour donner l’accès' : etatAccesEspaceClient(acces)}
        </div>
      </div>
      {mut.isPending && <Loader2 className="h-3 w-3 animate-spin text-accent" />}
      <button type="button" role="switch" aria-checked={actif} aria-label="Accès espace client" disabled={disabled}
        onClick={() => setConfirm(!actif)}
        className={cn('relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          actif ? 'bg-accent shadow-inner' : 'bg-zinc-300',
          !disabled && !actif && 'hover:bg-zinc-400/80')}>
        <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out',
          actif ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm ? 'Donner l’accès à l’espace client ?' : 'Retirer l’accès à l’espace client ?'}
        description={confirm
          ? `${contactNom} (${mail}) recevra un e-mail pour choisir son mot de passe sur client.etsmalterre.fr.`
          : `${contactNom} ne pourra plus se connecter à client.etsmalterre.fr. Ses sessions ouvertes seront fermées.`}
        confirmLabel={confirm ? 'Donner l’accès' : 'Retirer l’accès'}
        variant={confirm ? 'default' : 'destructive'}
        isPending={mut.isPending}
        error={erreur}
        onConfirm={() => mut.mutate(!!confirm)}
        onCancel={() => { setConfirm(null); mut.reset() }}
      />
    </div>
  )
}
