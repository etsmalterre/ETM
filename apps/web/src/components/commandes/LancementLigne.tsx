// Clients › Commandes: the launch date of a line's next step (doctrine des délais §5, decision
// Vincent 2026-10-28, API lib/lancement-ligne.ts). The only way to hold a line « à lancer » on
// purpose: before the date the line is neutral, from it red. It is set from « Planifier », next to the
// order buttons of the line drawer's Fil / Tricotage / Ennoblissement tabs: the tab IS the step that
// waits (commander le fil, tricoter, ennoblir), so no why is typed. The line card only shows it.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CalendarClock, History, Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { apiFetch } from '@/lib/api'
import { formatHfsqlDate, hfsqlDateToInput, inputDateToHfsql } from '@/lib/dates'
import { invalidateCommandeClientCaches } from '@/lib/cache-sync'
import { cn } from '@/lib/utils'

export type EtapeLancement = 'fil' | 'tricotage' | 'ennoblissement'

interface Changement { id: number; date: string | null; etape: EtapeLancement | null; saisi_le: string; saisi_par: string | null; lancee?: boolean }
interface LancementPayload { date: string | null; etape: EtapeLancement | null; historique: Changement[] }

/** What waits, as a verb: « Ennoblir le 16/11 ». */
const VERBE: Record<EtapeLancement, string> = { fil: 'Commander le fil', tricotage: 'Tricoter', ennoblissement: 'Ennoblir' }
const jjmm = (d: string) => formatHfsqlDate(d).slice(0, 5)
const libelle = (date: string, etape: EtapeLancement | null) => `${etape ? VERBE[etape] : 'Lancer'} le ${jjmm(date)}`

/** Next to the line card's status pill, read only: « 📅 Ennoblir le 16/11 » (Vincent 2026-10-28, was a
 *  « Lancement » stat). The pill says « Planifiée » before the date; from it the line is « À lancer »
 *  again and this label turns red. Nothing without a date — planning is done from the drawer's tabs. */
export function LancementLabel({ date, etape, rouge }: {
  /** YYYYMMDD or null */
  date: string | null
  etape: EtapeLancement | null
  /** the line is red because its launch date has come */
  rouge: boolean
}) {
  if (!date) return null
  return (
    <span title="Lancement prévu : la ligne reste neutre jusqu’à cette date, puis passe au rouge (« Planifier » dans les onglets de la ligne)"
      className={cn('inline-flex items-center gap-1 text-[11px] font-medium tabular-nums whitespace-nowrap', rouge ? 'text-red-600' : 'text-muted-foreground')}>
      <CalendarClock className="h-3.5 w-3.5" />
      {libelle(date, etape)}
    </span>
  )
}

/** « Planifier » / « Ennoblir le 16/11 » next to the order buttons of the line drawer's bottom zones:
 *  one decides to wait where one would launch, and the tab gives the step. One launch date per line:
 *  planning from another tab replaces it and its step (doctrine des délais §5). */
export function PlanifierBouton({ commandeId, ligneId, date, etapeActuelle, etape, proposee = null }: {
  commandeId: number
  ligneId: number
  date: string | null
  /** the step the current date holds */
  etapeActuelle: EtapeLancement | null
  /** this tab's step */
  etape: EtapeLancement
  /** the doctrine's date (YYYYMMDD), offered when none is set yet, with why */
  proposee?: { date: string; pourquoi: string } | null
}) {
  const peutModifier = useHasPermission('edit_commandes_client')
  const [ouvert, setOuvert] = useState(false)
  if (!date && !peutModifier) return null
  return (
    <>
      <span title={date
        ? 'Lancement prévu : la ligne reste neutre jusqu’à cette date, puis passe au rouge'
        : `Attendre avant de ${VERBE[etape].toLowerCase()} : la ligne reste neutre jusqu’à la date choisie`} className="inline-flex">
        <Button variant="ghost" size="sm" disabled={!peutModifier} onClick={() => setOuvert(true)}
          className="h-6 px-2 text-[11px] text-accent hover:text-accent hover:bg-accent/10">
          <CalendarClock className="h-3 w-3 mr-1" />
          {date ? libelle(date, etapeActuelle) : 'Planifier'}
        </Button>
      </span>
      {ouvert && <LancementDialog commandeId={commandeId} ligneId={ligneId} etape={etape} proposee={proposee} onClose={() => setOuvert(false)} />}
    </>
  )
}

function LancementDialog({ commandeId, ligneId, etape, proposee, onClose }: {
  commandeId: number; ligneId: number; etape: EtapeLancement; proposee: { date: string; pourquoi: string } | null; onClose: () => void
}) {
  const queryClient = useQueryClient()
  const url = `/commandes-client/${commandeId}/lignes/${ligneId}/lancement`
  const { data, isLoading } = useQuery<LancementPayload>({ queryKey: ['commande-client-lancement', ligneId], queryFn: () => apiFetch(url) })
  const [date, setDate] = useState('')
  const [pret, setPret] = useState(false)
  if (!pret && data) {
    setPret(true)
    // No date yet: the doctrine's proposal, to accept or change.
    setDate(hfsqlDateToInput(data.date ?? proposee?.date ?? null))
  }

  const mut = useMutation({
    mutationFn: (d: string | null) => apiFetch<LancementPayload>(url, { method: 'PUT', body: JSON.stringify({ date: d, etape }) }),
    onSuccess: (p) => {
      queryClient.setQueryData(['commande-client-lancement', ligneId], p)
      // The line's colour, the order's liseré and the list's counters follow the date.
      invalidateCommandeClientCaches(queryClient)
      onClose()
    },
  })
  const actuelle = data?.date ?? null
  const choisie = date ? inputDateToHfsql(date) : null
  // Same date planned from another tab = a change of step, worth saving.
  const change = choisie !== actuelle || (choisie !== null && data?.etape !== etape)

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !mut.isPending) onClose() }}>
      <DialogContent className="max-w-sm" onClose={mut.isPending ? undefined : onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-accent" />
            {VERBE[etape]} le…
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          {isLoading ? (
            <div className="h-10 bg-muted animate-pulse rounded-md" />
          ) : (
            <>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={mut.isPending} autoFocus
                className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
              <p className="text-xs text-muted-foreground">La ligne reste neutre jusqu’à cette date, puis passe au rouge.</p>
              {!actuelle && proposee && (
                <p className="text-xs text-muted-foreground">Proposée : {proposee.pourquoi}.</p>
              )}
              {actuelle && data?.etape && data.etape !== etape && (
                <p className="text-xs text-amber-700">Remplace « {libelle(actuelle, data.etape)} » : une seule date de lancement par ligne.</p>
              )}
              {(data?.historique.length ?? 0) > 0 && (
                <div className="rounded-lg border border-border/60 bg-zinc-100/80 p-2.5 space-y-1">
                  <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <History className="h-3 w-3" />Historique
                  </p>
                  {data!.historique.map((h) => (
                    <p key={h.id} className="text-xs">
                      <span className="font-medium tabular-nums">{h.date ? libelle(h.date, h.etape) : h.lancee ? `Lancée (${h.etape ? VERBE[h.etape].toLowerCase() : 'étape'})` : 'Date retirée'}</span>
                      <span className="text-muted-foreground"> · {new Date(h.saisi_le).toLocaleDateString('fr-FR')}{h.saisi_par ? `, ${h.saisi_par}` : ''}</span>
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
          {mut.error && (
            <p className="flex items-center gap-1.5 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />{(mut.error as any).body?.message ?? 'L’enregistrement a échoué'}
            </p>
          )}
        </div>
        <DialogFooter className="mt-4">
          {actuelle && (
            <Button variant="ghost" className="mr-auto text-destructive hover:text-destructive" disabled={mut.isPending}
              onClick={() => mut.mutate(null)} title="La ligne redevient rouge : il y a quelque chose à faire maintenant">
              Retirer la date
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={mut.isPending}>Annuler</Button>
          <Button onClick={() => mut.mutate(choisie)} disabled={!choisie || !change || mut.isPending}>
            {mut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
