// « Étiquettes » tab of a Clients › Commandes order line — Simone Pérèle roll
// labels (LIVA #1200). Shown only for clients whose labels are switched on in
// Clients › Gestion.
//
// Flow: the lot's « tableau de métrage » goes to MATEL from Qualité › Suivi
// lots (LIVA #1303, every roll of the lot) — it can still be printed from here
// for the line's rolls → MATEL returns it filled by hand → type its numbers
// (here or on the lot: same measures, saved as you type) → print or send MATEL
// the labels. Rules and storage: apps/api/src/lib/etiquettes-sp.ts; shared
// grid + auto-save: ./mesures-sp.tsx.

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, AtSign, Barcode, Printer } from 'lucide-react'
import { SendEmailDialog } from '@/components/email/SendEmailDialog'
import { apiFetch, API_URL } from '@/lib/api'
import { invalidateStockCaches } from '@/lib/cache-sync'
import { postEmail } from '@/lib/email'
import {
  BatchFields, DocMenu, LoadState, MesuresTable, SaveStatus, useEtiquettesDraft, useRollSelection,
  type Doc, type EtiquettesPayload, type SaveResponse,
} from './mesures-sp'

interface LinePayload extends EtiquettesPayload { ligneId: number }

export function EtiquettesSpTab({ ligneId }: { ligneId: number }) {
  const { data, isLoading, isError, isFetching } = useQuery<LinePayload>({
    queryKey: ['etiquettes-sp-ligne', ligneId],
    queryFn: () => apiFetch(`/etiquettes-sp/lignes/${ligneId}`),
    // Always reload on opening: the lot's tableau (Suivi lots) writes the same
    // measures. The local draft is the source of truth once hydrated.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  })

  const queryClient = useQueryClient()
  /** Rolls whose net could not become their billed length: already invoiced. */
  const [netFactures, setNetFactures] = useState<string[]>([])
  /** Rolls whose net is shorter than their « Ml non facturés »: left at the gross length. */
  const [netSousNf, setNetSousNf] = useState<string[]>([])
  /** A complete roll's net replaces its length in stock (LIVA #1246) — the
   *  BL and the invoice bill it. Refresh what shows that length. */
  const afterSave = (res: SaveResponse | undefined) => {
    const net = res?.net
    if (!net) return
    setNetFactures((prev) => [...new Set([...prev, ...net.factures])])
    setNetSousNf((prev) => [...new Set([...prev, ...(net.sousNonFactures ?? [])])])
    if (net.appliques.length === 0) return
    invalidateStockCaches(queryClient)
    queryClient.invalidateQueries({ queryKey: ['commande-client'] })
    queryClient.invalidateQueries({ queryKey: ['commande-client-supply'] })
    queryClient.invalidateQueries({ queryKey: ['commande-client-line-expeditions'] })
    queryClient.invalidateQueries({ queryKey: ['etiquettes-sp-ligne', ligneId] })
    queryClient.invalidateQueries({ queryKey: ['suivi-lot'] })
  }

  const draft = useEtiquettesDraft({ data, ready: !isFetching, putUrl: `/etiquettes-sp/lignes/${ligneId}`, onSaved: afterSave })
  const rolls = data?.rolls ?? []
  const selection = useRollSelection(rolls)
  useEffect(() => {
    if (draft.hydrated) selection.selectUnshipped()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.hydrated])

  // ── Documents ────────────────────────────────────────────
  const [docError, setDocError] = useState<string | null>(null)
  const [busyDoc, setBusyDoc] = useState<Doc | null>(null)
  const [emailDoc, setEmailDoc] = useState<Doc | null>(null)
  const pdfPath = (doc: Doc) => `/etiquettes-sp/lignes/${ligneId}/${doc}/pdf?rolls=${selection.selectedIds.join(',')}`

  /** Saves, then asks the API for the document so a refusal (missing measure,
   *  bad EAN) shows here in words instead of as JSON in a new tab. */
  const fetchDoc = async (doc: Doc): Promise<Blob | null> => {
    setDocError(null)
    if (selection.selectedIds.length === 0) { setDocError('Cochez au moins un rouleau.'); return null }
    setBusyDoc(doc)
    try {
      await draft.flush()
      const res = await fetch(`${API_URL}${pdfPath(doc)}`, { credentials: 'include' })
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
      setBusyDoc(null)
    }
  }
  const printDoc = async (doc: Doc) => {
    const blob = await fetchDoc(doc)
    if (blob) window.open(URL.createObjectURL(blob), '_blank')
  }
  const sendDoc = async (doc: Doc) => {
    const blob = await fetchDoc(doc)
    if (blob) setEmailDoc(doc)
  }

  // ── Render ───────────────────────────────────────────────
  if (isLoading || (data && !draft.hydrated && !isError)) return <LoadState />
  if (isError || !data) return <LoadState error />

  return (
    <>
      <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-transparent">
        <div className="rounded-lg border bg-card p-3 shadow-sm">
          <BatchFields
            codes={data.codes} coloris={data.coloris}
            codeId={draft.codeId} onCodeId={draft.setCodeId}
            commandeClient={draft.commandeClient} onCommandeClient={draft.setCommandeClient}
            bain={draft.bain} onBain={draft.setBain}
          />
        </div>

        {rolls.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Barcode className="h-8 w-8 mb-2 opacity-50" />
            <p className="text-sm font-medium">Aucune pièce finie reçue pour cette ligne</p>
            <p className="text-xs mt-1">Les étiquettes se préparent une fois le BL de l'ennoblisseur réceptionné.</p>
          </div>
        ) : (
          <MesuresTable rolls={rolls} drafts={draft.drafts} setField={draft.setField} selection={selection} />
        )}
      </div>

      {/* Footer: save state + documents */}
      <div className="flex-shrink-0 flex items-center gap-3 border-t bg-zinc-200/50 px-3 py-2">
        <div className="min-w-0 flex-1 text-xs">
          {docError ? (
            <span className="flex items-center gap-1.5 text-destructive"><AlertCircle className="h-3.5 w-3.5 flex-shrink-0" /><span className="truncate" title={docError}>{docError}</span></span>
          ) : (
            <SaveStatus count={selection.selectedIds.length} saveState={draft.saveState} netFactures={netFactures} netSousNf={netSousNf} />
          )}
        </div>
        <DocMenu icon={Printer} title="Imprimer" busy={busyDoc !== null} docs={['tableau', 'etiquettes']} onSelect={printDoc} />
        <DocMenu icon={AtSign} title={`Envoyer à ${data.sousTraitant?.nom || 'MATEL'}`} busy={busyDoc !== null} docs={['tableau', 'etiquettes']} onSelect={sendDoc} />
      </div>

      <SendEmailDialog
        open={emailDoc !== null}
        onClose={() => setEmailDoc(null)}
        contextLabel={data.sousTraitant?.nom ?? undefined}
        queryKey={['etiquettes-sp-email', ligneId, emailDoc]}
        loadDefaults={() => apiFetch(`/etiquettes-sp/lignes/${ligneId}/${emailDoc}/email-defaults`)}
        pdfUrl={emailDoc ? `${API_URL}${pdfPath(emailDoc)}` : undefined}
        pdfAttachmentLabel={emailDoc === 'tableau' ? 'tableau-metrage.pdf' : 'etiquettes.pdf'}
        onSend={(p) => postEmail(`${API_URL}/etiquettes-sp/lignes/${ligneId}/${emailDoc}/email`, p, {
          includeAttachPdf: true,
          extraBody: { rolls: selection.selectedIds },
        })}
      />
    </>
  )
}
