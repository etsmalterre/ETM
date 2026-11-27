import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SendEmailDialog } from '@/components/email/SendEmailDialog'
import { apiFetch, API_URL } from '@/lib/api'
import { postEmail } from '@/lib/email'
import { cn } from '@/lib/utils'
import { invalidateCommandeClientCaches, invalidateSstCommandeCaches } from '@/lib/cache-sync'
import { UrgenceIcon, type UrgenceLigne } from './UrgenceIcon'

export type { UrgenceLigne }


const isoJour = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const jjmmIso = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
const veille = (iso: string) => {
  const d = new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) - 1)
  return isoJour(d)
}

const inputClass = 'w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'


/** « Commande urgente » when an order is prepared (the launch dialog of a client line, a new knitting
 *  line): off by default — an order names no date, the knitter gives its délai. On, it asks the date
 *  wished. The same thing, afterwards, is « Passer en urgence » on the line (UrgenceDialog). */
export interface UrgenceSaisie { active: boolean; date: string }
export const URGENCE_VIDE: UrgenceSaisie = { active: false, date: '' }

/** What blocks the save, null when the choice is complete. `avant`: the délai the knitter already
 *  gave ('YYYY-MM-DD'), which the date wished must precede. */
export function urgenceSaisieManque(u: UrgenceSaisie, avant?: string | null): string | null {
  if (!u.active) return null
  if (!u.date) return 'Indiquez la date souhaitée de l’urgence'
  if (u.date < isoJour(new Date())) return 'La date souhaitée ne peut pas être passée'
  return avant && u.date >= avant ? `La date souhaitée doit être avant le délai donné (${jjmmIso(avant)})` : null
}

export function UrgenceChoix({ value, onChange, disabled, qui = 'le tricoteur', libelle = 'Commande urgente', avant }: {
  value: UrgenceSaisie
  onChange: (v: UrgenceSaisie) => void
  disabled?: boolean
  /** who is asked: « Tricotage Malterre », « le tricoteur » */
  qui?: string
  /** « Commande urgente » on a new order, « Passer en urgence » on a line that exists */
  libelle?: string
  /** 'YYYY-MM-DD' the délai the knitter already gave on the line: the date wished comes before it */
  avant?: string | null
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            <UrgenceIcon className={cn('h-3.5 w-3.5', !value.active && 'text-muted-foreground')} />
            <span>{libelle}</span>
          </div>
          {/* Off: what the switch is for. On: the date field speaks for itself (Vincent 2026-11-16). */}
          {!value.active && (
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {avant ? `Exceptionnel : demander à ${qui} de livrer avant son délai.` : `Aucune date demandée : ${qui} donne son délai.`}
            </p>
          )}
        </div>
        <button
          type="button" role="switch" aria-checked={value.active} disabled={disabled} title={libelle}
          onClick={() => onChange({ ...value, active: !value.active })}
          className={cn(
            'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            value.active ? 'bg-accent shadow-inner' : 'bg-zinc-300 hover:bg-zinc-400/80',
          )}
        >
          <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out', value.active ? 'translate-x-[18px]' : 'translate-x-0.5')} />
        </button>
      </div>
      {value.active && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Date souhaitée <span className="text-destructive">*</span></label>
          <input type="date" value={value.date} min={isoJour(new Date())} max={avant ? veille(avant) : undefined} disabled={disabled} autoComplete="off"
            onChange={(e) => onChange({ ...value, date: e.target.value })} className={inputClass} />
        </div>
      )}
    </div>
  )
}

/** A gesture that ends the urgency of a line (API lib/urgence-sst.ts): 'refus' = the sous-traitant
 *  cannot, 'levee' = we give it up. Both live in the line's edit dialog. The client lines that wait
 *  for this knitting read it too. */
export function useGesteUrgence(commandeId: number, onDone?: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ ligneId, geste }: { ligneId: number; geste: 'refus' | 'levee' }) =>
      apiFetch(`/commandes-sous-traitant/${commandeId}/lignes/${ligneId}/urgence/${geste}`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => { invalidateSstCommandeCaches(queryClient); invalidateCommandeClientCaches(queryClient); onDone?.() },
  })
}

/** The mail that tells the sous-traitant of an urgency gesture (Vincent 2026-11-16), to the
 *  contacts who receive the orders, the bon de commande attached (it prints « URGENT » while the
 *  urgency awaits). 'demande' (« Passer en urgence ») and 'levee' (« Retirer l'urgence »): opened
 *  pre-filled right after the gesture, which is already recorded — closing the window without
 *  sending is fine, the sous-traitant was told by phone. 'relance' (Vincent 2026-11-27, as on Suivi
 *  lots): opened from the order's mail button, the mail IS the relance — the API notes it when the
 *  mail leaves, nothing when the window is closed. `t` = when it was asked (the defaults are read
 *  again each time). */
export interface MailUrgence { ligneId: number; geste: 'demande' | 'relance' | 'levee'; article: string; t: number }

export function UrgenceMail({ commandeId, mail, contextLabel, onClose }: {
  commandeId: number
  mail: MailUrgence | null
  /** the sous-traitant's name, in the window's title */
  contextLabel?: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  if (!mail) return null
  const base = `/commandes-sous-traitant/${commandeId}/lignes/${mail.ligneId}/urgence`
  return (
    <SendEmailDialog
      open
      onClose={onClose}
      title={mail.geste === 'relance' ? 'Relancer la demande d’urgence' : undefined}
      contextLabel={contextLabel}
      queryKey={['commande-sst-urgence-email', commandeId, mail.ligneId, mail.geste, mail.t]}
      loadDefaults={() => apiFetch(`${base}/email-defaults?geste=${mail.geste}&article=${encodeURIComponent(mail.article)}`)}
      pdfUrl={`${API_URL}/commandes-sous-traitant/${commandeId}/pdf`}
      pdfAttachmentLabel={`commande-sous-traitant-${commandeId}.pdf`}
      onSend={async (p) => {
        await postEmail(`${API_URL}${base}/email?geste=${mail.geste}`, p, { includeAttachPdf: true })
        // The Journal tells the mail sent; a relance also calms the order and the client lines
        // that wait for it.
        invalidateSstCommandeCaches(queryClient)
        invalidateCommandeClientCaches(queryClient)
        queryClient.invalidateQueries({ queryKey: ['commande-sst-journal', commandeId] })
      }}
    />
  )
}

/** One urgency awaiting its answer, as a row of « Prochaines étapes » (Vincent 2026-11-16): asking the
 *  knitter to go faster is a process of its own, running beside the knitting — its own clock (the
 *  working days since the ask over the days the knitter gets to answer, one segment each, like a lot
 *  on a dyer's order) and its own chase (red the day after the answer was due). The answer itself
 *  is the knitter's délai, which ends the row. ⚠️ A reading, no button (Vincent 2026-11-27): the
 *  relance is a mail, sent from the order's mail button (« Relancer la demande d'urgence »);
 *  asking, « Refusée » and giving it up live in the line's edit dialog. */
export function UrgenceEnCours({ urgence, article, qui }: {
  urgence: UrgenceLigne
  /** « REF - coloris », named when the order has several lines */
  article?: string | null
  /** « Tricotage Malterre », « MATEL », « le tricoteur » */
  qui: string
}) {
  const rouge = urgence.etat === 'a_relancer'
  const { jours, accordes } = urgence
  const retard = jours - accordes
  return (
    <div>
      <div className="flex items-center gap-2 text-sm">
        <UrgenceIcon className="h-3.5 w-3.5" />
        <span className="min-w-0 truncate">
          <span className="font-medium">Urgence</span>
          {urgence.dateSouhaitee && <span className="text-muted-foreground"> · souhaité le {jjmmIso(urgence.dateSouhaitee)}</span>}
          {article && <span className="text-muted-foreground"> · {article}</span>}
        </span>
        <span className="ml-auto flex-shrink-0 text-xs tabular-nums text-muted-foreground">
          <span className={cn('text-sm font-bold', rouge ? 'text-red-600' : 'text-foreground')}>{jours} j</span>
          {' '}sur {accordes}
        </span>
      </div>
      <div className="mt-1.5 flex gap-1">
        {Array.from({ length: accordes }, (_, i) => (
          <div key={i} className={cn('h-1.5 flex-1 rounded-full', rouge ? 'bg-red-500' : i < jours ? 'bg-sky-500' : 'bg-zinc-200')} />
        ))}
      </div>
      {rouge && (
        <p className="mt-1 text-xs font-medium text-red-700">
          Relancer {qui}{retard > 0 ? ` : ${retard} j de retard` : ''}
        </p>
      )}
    </div>
  )
}
