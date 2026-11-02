import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, BellRing, CalendarClock, Loader2, Mail, Phone } from 'lucide-react'
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
  derniereRelance: { jour: string; canal: 'point' | 'email' | 'telephone' } | null
  historique: { le: string; type: 'demande' | 'relance' | 'report' | 'delai_recu'; texte: string; par: string | null }[]
}

const jjmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
const jjmmaaaa = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
const isoJour = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** When it was asked, the history (every relance in it — no separate « Dernière
 *  relance » row, Vincent 2026-11-02) and the two gestures of an order waiting
 *  for the dyer's délai. A Point sent with the order counts as a relance by
 *  itself; « Relancer » records a call or an e-mail sent apart. */
export function DelaiQuestion({ commandeId, delai, disabled, enRetard }: { commandeId: number; delai: DelaiCycle; disabled: boolean; enRetard?: boolean }) {
  const [dialog, setDialog] = useState<'relance' | 'report' | null>(null)
  const raison = disabled ? 'Terminez la modification d’abord' : undefined
  return (
    <div className="pt-2 border-t border-border/50 space-y-1.5">
      <DemandeLigne demandeLe={delai.demandeLe ?? null} jours={delai.joursDepuisDemande ?? null} enRetard={!!enRetard} />
      {delai.historique.length > 0 && (
        <div className="pt-1 space-y-0.5">
          {delai.historique.map((h, i) => (
            <p key={i} className="text-[11px] text-muted-foreground flex gap-1.5">
              <span className="tabular-nums flex-shrink-0">{jjmm(h.le)}</span>
              <span className="min-w-0">{h.texte}{h.par ? ` (${h.par})` : ''}</span>
            </p>
          ))}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <Button variant="outline" size="sm" className="flex-1" disabled={disabled} onClick={() => setDialog('relance')}
          title={raison ?? 'Noter une relance par téléphone ou e-mail'}>
          <BellRing className="h-3.5 w-3.5 mr-1.5" />Relancer
        </Button>
        <Button variant="outline" size="sm" className="flex-1" disabled={disabled} onClick={() => setDialog('report')}
          title={raison ?? 'Le délai n’est pas attendu avant une autre date'}>
          <CalendarClock className="h-3.5 w-3.5 mr-1.5" />Repousser
        </Button>
      </div>
      <RelanceDialog open={dialog === 'relance'} commandeId={commandeId} onClose={() => setDialog(null)} />
      <ReportDialog open={dialog === 'report'} commandeId={commandeId} echeance={delai.echeance} onClose={() => setDialog(null)} />
    </div>
  )
}

/** One dated fact of the délai question: the date in bold, what it means in small
 *  grey beside it — red only when the relance is due and nobody chased
 *  (mps_designer §41, 2026-11-02). The value never truncates, the label gives way. */
function LigneFait({ label, date, detail, enRetard, vide = '—' }: {
  label: string
  date: string | null
  detail?: string | null
  enRetard?: boolean
  vide?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground truncate">{label}</span>
      {date ? (
        <span className="flex items-baseline gap-1.5 whitespace-nowrap">
          <span className={cn('text-sm font-semibold tabular-nums', enRetard && 'text-red-600')}>{date}</span>
          {detail && (
            <span className={cn('inline-flex items-center gap-1 text-[11px]', enRetard ? 'text-red-600 font-medium' : 'text-muted-foreground')}>
              {detail}
            </span>
          )}
        </span>
      ) : (
        <span className="text-sm text-muted-foreground italic">{vide}</span>
      )}
    </div>
  )
}

/** « Délai demandé le 28/10/2026 · il y a 3 jours ouvrés » — the day the bon de
 *  commande asked it, not the échéance (Vincent 2026-11-02). */
function DemandeLigne({ demandeLe, jours, enRetard }: { demandeLe: string | null; jours: number | null; enRetard: boolean }) {
  const depuis = jours === null || jours < 0 ? null
    : jours === 0 ? 'aujourd’hui'
    : `il y a ${jours} jour${jours > 1 ? 's' : ''} ouvré${jours > 1 ? 's' : ''}`
  return (
    <LigneFait
      label="Délai demandé le"
      date={demandeLe ? jjmmaaaa(demandeLe) : null}
      detail={depuis && enRetard ? `${depuis} · à relancer` : depuis}
      enRetard={enRetard}
    />
  )
}

const choixClass = (actif: boolean) => cn(
  'flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm rounded-md border transition-colors',
  actif ? 'bg-accent text-accent-foreground border-accent shadow-sm font-medium' : 'border-input text-muted-foreground hover:bg-accent/10',
)

const textareaClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y'

function useGeste(commandeId: number, chemin: 'relances' | 'reports', onDone: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiFetch(`/commandes-sous-traitant/${commandeId}/delai/${chemin}`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { invalidateSstCommandeCaches(queryClient); onDone() },
  })
}

function messageErreur(e: unknown): string | null {
  if (!e) return null
  const err = e as Error & { body?: { message?: string } }
  return err.body?.message || err.message
}

function RelanceDialog({ open, commandeId, onClose }: { open: boolean; commandeId: number; onClose: () => void }) {
  const [canal, setCanal] = useState<'email' | 'telephone'>('telephone')
  const [note, setNote] = useState('')
  const mut = useGeste(commandeId, 'relances', onClose)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { setCanal('telephone'); setNote(''); mut.reset() } }, [open])
  const erreur = messageErreur(mut.error)
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><BellRing className="h-5 w-5 text-accent" />Relancer le sous-traitant</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <p className="text-xs text-muted-foreground">Le Point du jour compte déjà comme une relance : notez ici un appel ou un e-mail envoyé à part.</p>
          <div className="flex gap-2">
            <button type="button" className={choixClass(canal === 'telephone')} onClick={() => setCanal('telephone')}><Phone className="h-3.5 w-3.5" />Téléphone</button>
            <button type="button" className={choixClass(canal === 'email')} onClick={() => setCanal('email')}><Mail className="h-3.5 w-3.5" />E-mail</button>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Note (facultatif)</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Ex. : rappel prévu demain" className={textareaClass} />
          </div>
          {erreur && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="h-4 w-4 flex-shrink-0" />{erreur}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => mut.mutate({ canal, note })} disabled={mut.isPending}>
            {mut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <BellRing className="h-3.5 w-3.5 mr-1.5" />}Noter la relance
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReportDialog({ open, commandeId, echeance, onClose }: { open: boolean; commandeId: number; echeance: string | null; onClose: () => void }) {
  const [date, setDate] = useState('')
  const [imputable, setImputable] = useState<'sous_traitant' | 'malterre'>('sous_traitant')
  const [motif, setMotif] = useState('')
  const mut = useGeste(commandeId, 'reports', onClose)
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
