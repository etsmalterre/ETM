import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Loader2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api'
import { invalidateCommandeClientCaches, invalidateSstCommandeCaches } from '@/lib/cache-sync'
import { formatHfsqlDate } from '@/lib/dates'

/** An urgency asked of the knitter on a line still without its délai (API lib/urgence-sst.ts,
 *  Vincent 2026-11-16). Dates 'YYYY-MM-DD'. */
export interface UrgenceLigne {
  demandeeLe: string
  reponseAttendue: string
  relances: number
  dateSouhaitee: string | null
  note: string | null
  par: string | null
  /** the answer did not come on the day it was expected: ours to chase */
  aRelancer: boolean
}

/** Working days the knitter gets to answer, proposed (API REPONSE_URGENCE_J; public holidays are the
 *  API's to count, it refuses a date beyond 5 working days). */
const REPONSE_J = 2

const isoJour = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const jjmmIso = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

function plusJoursSemaine(n: number): string {
  const d = new Date()
  for (let k = 0; k < n;) {
    d.setDate(d.getDate() + 1)
    if (d.getDay() !== 0 && d.getDay() !== 6) k++
  }
  return isoJour(d)
}

const inputClass = 'w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'
const textareaClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y'

function messageErreur(e: unknown): string | null {
  if (!e) return null
  const err = e as Error & { body?: { message?: string } }
  return err.body?.message || err.message
}

/** « Demander une urgence » on a knitting line, or « Relancer » / « Lever » the one already asked.
 *  While its answer is awaited, a client line whose date cannot be held stays neutral; the day after
 *  the answer was expected, the knitting order and that client line turn red: chase the knitter. */
export function UrgenceDialog({ open, commandeId, ligneId, article, urgence, dateDemandee, onClose }: {
  open: boolean
  commandeId: number
  ligneId: number
  /** « REF - coloris » of the line */
  article: string
  urgence: UrgenceLigne | null
  /** YYYYMMDD the date already asked for on the line, if any */
  dateDemandee: string | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [reponse, setReponse] = useState('')
  const [souhaitee, setSouhaitee] = useState('')
  const [note, setNote] = useState('')
  const base = `/commandes-sous-traitant/${commandeId}/lignes/${ligneId}/urgence`
  const fini = () => { invalidateSstCommandeCaches(queryClient); invalidateCommandeClientCaches(queryClient); onClose() }
  const demander = useMutation({
    mutationFn: () => apiFetch(base, { method: 'POST', body: JSON.stringify({ reponse_attendue: reponse, date_souhaitee: souhaitee || null, note }) }),
    onSuccess: fini,
  })
  const lever = useMutation({
    mutationFn: () => apiFetch(`${base}/levee`, { method: 'POST', body: JSON.stringify({ note }) }),
    onSuccess: fini,
  })
  const aujourdhui = isoJour(new Date())
  useEffect(() => {
    if (!open) return
    setReponse(plusJoursSemaine(REPONSE_J))
    // Only a date named by an earlier ask: the line's own « Demandé pour le » is the standard, not an urgency.
    const dem = urgence?.dateSouhaitee ?? ''
    setSouhaitee(dem && dem >= aujourdhui ? dem : '')
    setNote('')
    demander.reset()
    lever.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const enCours = demander.isPending || lever.isPending
  const erreur = messageErreur(demander.error) ?? messageErreur(lever.error)
  const manque = !reponse ? 'Indiquez le jour où la réponse est attendue' : reponse < aujourdhui ? 'La réponse ne peut pas être attendue dans le passé' : null

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-accent" />
            {urgence ? 'Urgence demandée au tricoteur' : 'Demander une urgence au tricoteur'}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <p className="text-sm font-medium">{article}</p>
          {urgence ? (
            <p className="text-xs text-muted-foreground">
              Demandée le {jjmmIso(urgence.demandeeLe)}{urgence.par ? ` par ${urgence.par}` : ''}, réponse attendue le {jjmmIso(urgence.reponseAttendue)}
              {urgence.relances > 0 ? `, relancée ${urgence.relances} fois` : ''}. Le délai donné par le tricoteur la clôt tout seul.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Vous avez demandé au tricoteur de faire au plus vite. Tant que sa réponse est attendue, la commande client qui en dépend ne
              passe pas en rouge pour « date client intenable ». Le délai qu’il donne clôt l’urgence.
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{urgence ? 'Nouvelle réponse attendue le' : 'Réponse attendue le'}</label>
              <input type="date" value={reponse} min={aujourdhui} onChange={(e) => setReponse(e.target.value)} className={inputClass} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Date souhaitée (facultatif)</label>
              <input type="date" value={souhaitee} min={aujourdhui} onChange={(e) => setSouhaitee(e.target.value)} className={inputClass} />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Le lendemain de ce jour sans délai reçu, la commande repasse en rouge : relancer le tricoteur. 5 jours ouvrés au plus.
            {dateDemandee && /^\d{8}$/.test(dateDemandee) ? ` Date déjà demandée sur la ligne : ${formatHfsqlDate(dateDemandee)}.` : ''}
          </p>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Note (facultatif)</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Ex. : mail envoyé à l’atelier ce matin" className={textareaClass} />
          </div>
          {erreur && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="h-4 w-4 flex-shrink-0" />{erreur}</p>}
        </div>
        <DialogFooter className="mt-4">
          {urgence && (
            <Button variant="ghost" className="sm:mr-auto text-destructive hover:text-destructive" disabled={enCours} onClick={() => lever.mutate()}
              title="Abandonner l’urgence : la commande client reprend sa couleur">
              {lever.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Lever l’urgence
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => demander.mutate()} disabled={!!manque || enCours} title={manque ?? undefined}>
            {demander.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Zap className="h-3.5 w-3.5 mr-1.5" />}
            {urgence ? 'Noter la relance' : 'Demander l’urgence'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
