// Qualité › Suivi lots — the Simone Pérèle « tableau de métrage » of a whole
// dyer lot (LIVA #1303). Pierrot dyes more pieces than an SP order needs and
// affects only what it needs; asked from the order line, the tableau left the
// rest of the lot unmeasured. Here it lists EVERY roll of the lot, affected or
// not: send it to MATEL when the lot comes in, type back what MATEL wrote. The
// measures are the same ones the order line's « Étiquettes » tab reads, where
// the labels are still printed (they need the SP order number).
//
// Banded dialog (mps_designer §18.D): navy header, zinc body, zinc footer.

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, AtSign, ClipboardList, Printer, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { SendEmailDialog } from '@/components/email/SendEmailDialog'
import { apiFetch, API_URL } from '@/lib/api'
import { invalidateStockCaches } from '@/lib/cache-sync'
import { postEmail } from '@/lib/email'
import {
  BatchFields, DocMenu, LoadState, MesuresTable, SaveStatus, useEtiquettesDraft, useRollSelection,
  type EtiquettesPayload, type SaveResponse,
} from './mesures-sp'

interface LotPayload extends EtiquettesPayload { suivilotId: number; lot: string; commandesSp: string[] }

export function TableauMetrageLotDialog({ suivilotId, lot, open, onClose }: {
  suivilotId: number
  lot: string
  open: boolean
  onClose: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-3xl p-0 border-0 bg-primary overflow-hidden max-h-[90dvh] flex flex-col">
        <div className="flex-shrink-0 flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5 rounded-t-lg">
          <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
            <ClipboardList className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">Tableau de métrage — Lot {lot}</h2>
            <p className="text-xs text-white/70 truncate">Simone Pérèle · toutes les pièces du lot, affectées ou non</p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-white/80 hover:bg-white/15 hover:text-white" title="Fermer" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        {/* Mounted only while open: closing unmounts it, which flushes the
            pending save (useEtiquettesDraft). */}
        {open && <LotBody suivilotId={suivilotId} />}
      </DialogContent>
    </Dialog>
  )
}

function LotBody({ suivilotId }: { suivilotId: number }) {
  const { data, isLoading, isError, isFetching } = useQuery<LotPayload>({
    queryKey: ['etiquettes-sp-lot', suivilotId],
    queryFn: () => apiFetch(`/etiquettes-sp/lots/${suivilotId}`),
    // The order line's tab writes the same measures: reload on every opening.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  })

  const queryClient = useQueryClient()
  const [netFactures, setNetFactures] = useState<string[]>([])
  const [netSousNf, setNetSousNf] = useState<string[]>([])
  /** A complete roll's net replaces its length in stock (LIVA #1246). */
  const afterSave = (res: SaveResponse | undefined) => {
    const net = res?.net
    if (!net) return
    setNetFactures((prev) => [...new Set([...prev, ...net.factures])])
    setNetSousNf((prev) => [...new Set([...prev, ...(net.sousNonFactures ?? [])])])
    if (net.appliques.length === 0) return
    invalidateStockCaches(queryClient)
    queryClient.invalidateQueries({ queryKey: ['suivi-lot'] })
    queryClient.invalidateQueries({ queryKey: ['commande-client'] })
    queryClient.invalidateQueries({ queryKey: ['etiquettes-sp-lot', suivilotId] })
  }

  const draft = useEtiquettesDraft({ data, ready: !isFetching, putUrl: `/etiquettes-sp/lots/${suivilotId}`, onSaved: afterSave })
  const rolls = data?.rolls ?? []
  const selection = useRollSelection(rolls)
  useEffect(() => {
    if (draft.hydrated) selection.selectUnshipped()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.hydrated])

  const [docError, setDocError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)
  const pdfPath = `/etiquettes-sp/lots/${suivilotId}/tableau/pdf?rolls=${selection.selectedIds.join(',')}`

  /** Saves, then asks for the PDF so a refusal shows here in words. */
  const fetchDoc = async (): Promise<Blob | null> => {
    setDocError(null)
    if (selection.selectedIds.length === 0) { setDocError('Cochez au moins un rouleau.'); return null }
    setBusy(true)
    try {
      await draft.flush()
      const res = await fetch(`${API_URL}${pdfPath}`, { credentials: 'include' })
      if (!res.ok) {
        let msg = `Erreur HTTP ${res.status}`
        try { const j = await res.json(); if (typeof j?.message === 'string') msg = j.message } catch { /* keep */ }
        setDocError(msg)
        return null
      }
      return await res.blob()
    } catch {
      setDocError("L'enregistrement a échoué — réessayez.")
      return null
    } finally {
      setBusy(false)
    }
  }
  const print = async () => {
    const blob = await fetchDoc()
    if (blob) window.open(URL.createObjectURL(blob), '_blank')
  }
  const send = async () => {
    const blob = await fetchDoc()
    if (blob) setEmailOpen(true)
  }

  const body = isLoading || (data && !draft.hydrated && !isError)
    ? <LoadState />
    : isError || !data
      ? <LoadState error />
      : (
        <>
          <div className="rounded-lg border-l-4 border-l-accent/70 border border-border/60 bg-card p-3 shadow-sm">
            <BatchFields
              codes={data.codes} coloris={data.coloris}
              codeId={draft.codeId} onCodeId={draft.setCodeId}
              commandeClient={draft.commandeClient} onCommandeClient={draft.setCommandeClient}
              bain={draft.bain} onBain={draft.setBain}
              commandeHint="Les commandes Simone Pérèle auxquelles des pièces du lot sont affectées. Vide si aucune ne l'est encore."
            />
          </div>
          {rolls.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <ClipboardList className="h-8 w-8 mb-2 opacity-50" />
              <p className="text-sm font-medium">Aucune pièce finie reçue pour ce lot</p>
            </div>
          ) : (
            <MesuresTable rolls={rolls} drafts={draft.drafts} setField={draft.setField} selection={selection} showAffectation />
          )}
          <p className="text-[11px] text-muted-foreground">
            Les mesures saisies ici sont celles de l'onglet « Étiquettes » de la commande, où s'impriment les étiquettes une fois la pièce affectée.
          </p>
        </>
      )

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-100 p-4 space-y-3 scrollbar-transparent">{body}</div>
      <div className="flex-shrink-0 flex items-center gap-3 border-t border-border/60 bg-zinc-200 px-4 py-3 rounded-b-lg">
        <div className="min-w-0 flex-1 text-xs">
          {docError ? (
            <span className="flex items-center gap-1.5 text-destructive"><AlertCircle className="h-3.5 w-3.5 flex-shrink-0" /><span className="truncate" title={docError}>{docError}</span></span>
          ) : data && draft.hydrated ? (
            <SaveStatus count={selection.selectedIds.length} saveState={draft.saveState} netFactures={netFactures} netSousNf={netSousNf} />
          ) : null}
        </div>
        <DocMenu icon={Printer} title="Imprimer" busy={busy || !draft.hydrated} docs={['tableau']} onSelect={print} />
        <DocMenu icon={AtSign} title={`Envoyer à ${data?.sousTraitant?.nom || 'MATEL'}`} busy={busy || !draft.hydrated} docs={['tableau']} onSelect={send} />
      </div>

      <SendEmailDialog
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        contextLabel={data?.sousTraitant?.nom ?? undefined}
        queryKey={['etiquettes-sp-lot-email', suivilotId]}
        loadDefaults={() => apiFetch(`/etiquettes-sp/lots/${suivilotId}/tableau/email-defaults`)}
        pdfUrl={emailOpen ? `${API_URL}${pdfPath}` : undefined}
        pdfAttachmentLabel="tableau-metrage.pdf"
        onSend={(p) => postEmail(`${API_URL}/etiquettes-sp/lots/${suivilotId}/tableau/email`, p, {
          includeAttachPdf: true,
          extraBody: { rolls: selection.selectedIds },
        })}
      />
    </>
  )
}
