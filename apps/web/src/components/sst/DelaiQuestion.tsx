import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CalendarClock, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api'
import { invalidateSstCommandeCaches } from '@/lib/cache-sync'

/** The délai question of a sous-traitant order (API lib/delai-sst.ts, LIVA #1314). */
export interface DelaiCycle {
  /** From when the délai is due — the Point asks from that day. 'YYYY-MM-DD' */
  echeance: string | null
  /** The day the délai was asked (first bon de commande sent). 'YYYY-MM-DD' */
  demandeLe?: string | null
  /** Working days since it was asked (0 = today). */
  joursDepuisDemande?: number | null
  /** Working days from the demand to the échéance (the card's gauge). */
  joursAccordes?: number | null
  derniereRelance: { jour: string; canal: 'point' | 'email' | 'telephone' } | null
  historique: { le: string; type: 'demande' | 'relance' | 'report' | 'delai_recu'; texte: string; par: string | null }[]
}

const jjmmaaaa = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
const isoJour = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The gesture of an order waiting for the dyer's délai: « Repousser » its échéance.
 *  The relance is a mail, sent from the order's mail button (Vincent 2026-11-27, as
 *  on Suivi lots) — no button here; a Point sent with the order counts as one by
 *  itself. When it was asked is the card's counter; the history is the Journal
 *  tab's (Vincent 2026-11-10). */
export function DelaiQuestion({ commandeId, delai, disabled }: { commandeId: number; delai: DelaiCycle; disabled: boolean }) {
  const [ouvert, setOuvert] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" className="w-full" disabled={disabled} onClick={() => setOuvert(true)}
        title={disabled ? 'Terminez la modification d’abord' : 'Le délai n’est pas attendu avant une autre date'}>
        <CalendarClock className="h-3.5 w-3.5 mr-1.5" />Repousser
      </Button>
      <ReportDialog open={ouvert} commandeId={commandeId} echeance={delai.echeance} onClose={() => setOuvert(false)} />
    </>
  )
}

const choixClass = (actif: boolean) => cn(
  'flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm rounded-md border transition-colors',
  actif ? 'bg-accent text-accent-foreground border-accent shadow-sm font-medium' : 'border-input text-muted-foreground hover:bg-accent/10',
)

const textareaClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y'

function messageErreur(e: unknown): string | null {
  if (!e) return null
  const err = e as Error & { body?: { message?: string } }
  return err.body?.message || err.message
}

function ReportDialog({ open, commandeId, echeance, onClose }: { open: boolean; commandeId: number; echeance: string | null; onClose: () => void }) {
  const [date, setDate] = useState('')
  const [imputable, setImputable] = useState<'sous_traitant' | 'malterre'>('sous_traitant')
  const [motif, setMotif] = useState('')
  const queryClient = useQueryClient()
  const mut = useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiFetch(`/commandes-sous-traitant/${commandeId}/delai/reports`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { invalidateSstCommandeCaches(queryClient); onClose() },
  })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { setDate(''); setImputable('sous_traitant'); setMotif(''); mut.reset() } }, [open])
  const erreur = messageErreur(mut.error)
  const demain = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return isoJour(d) })()
  const manque = !date ? 'Choisissez la nouvelle échéance' : date < demain ? 'L’échéance doit être après aujourd’hui' : !motif.trim() ? 'Indiquez le motif' : null
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CalendarClock className="h-5 w-5 text-accent" />Repousser l’échéance du délai</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Le délai n’est pas attendu avant cette date : la commande sort du Point du jour et ne passe plus en rouge d’ici là.
            {echeance ? ` Échéance actuelle : ${jjmmaaaa(echeance)}.` : ''}
          </p>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Nouvelle échéance</label>
            <input type="date" value={date} min={demain} onChange={(e) => setDate(e.target.value)}
              className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">L’attente vient</label>
            <div className="flex gap-2">
              <button type="button" className={choixClass(imputable === 'sous_traitant')} onClick={() => setImputable('sous_traitant')}>Du sous-traitant</button>
              <button type="button" className={choixClass(imputable === 'malterre')} onClick={() => setImputable('malterre')}>De nous</button>
            </div>
            <p className="text-[11px] text-muted-foreground">« De nous » (fil pas arrivé, client indécis…) : cette attente ne compte pas dans sa qualité de service.</p>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Motif</label>
            <textarea value={motif} onChange={(e) => setMotif(e.target.value)} rows={3} placeholder="Pourquoi le délai ne peut pas être donné avant" className={textareaClass} />
          </div>
          {erreur && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="h-4 w-4 flex-shrink-0" />{erreur}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => mut.mutate({ echeance: date, imputable, motif })} disabled={!!manque || mut.isPending} title={manque ?? undefined}>
            {mut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <CalendarClock className="h-3.5 w-3.5 mr-1.5" />}Repousser
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
