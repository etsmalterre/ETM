// What Tricobot proposed or asked on a sous-traitant order (a BL of Flux
// Ennoblisseur: rolls to receive), and the gestures that judge it
// (claude_doc/agents_autonomie.md; API routes/tricobot-saisies.ts).
//
//   - the card: red « Tricobot : réception à valider » / « Tricobot demande ton
//     avis » (a Malterre action, now — doctrine §6), a neutral mascot when
//     Tricobot received alone;
//   - the revue on the order (TricobotPriseEnMain): each BL with the rolls he
//     proposes, his reasoning, the document, and the gestures: Réceptionner /
//     Modifier / Pas à réceptionner, or his proposal / nothing for an aide.

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Loader2, Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TricobotMascot } from '@/components/icons/TricobotMascot'
import { API_URL, apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'

export interface SaisieTricobot {
  id: number
  runId: string
  creeLe: string
  mode: 'supervise' | 'autonome'
  decision: 'saisie' | 'aide'
  idcommande: number
  idligne: number
  competence: string
  champ: string | null
  valeurAvant: string | null
  proposition: string | null
  explication: string
  citation: string
  statut: 'a_revoir' | 'autonome' | 'validee' | 'corrigee' | 'supprimee' | 'resolue'
  valeurFinale: string | null
  commentaire: string | null
  revuPar: string | null
  revuLe: string | null
}

export interface CompteurTricobot { aValider: number; aide: number; autonome: number }

// ── A delivery note (BL) ─────────────────────────────────

export interface PieceProposee { numero: string; poids: number | null; metrage: number | null; observations: string }
export interface PropositionReception { bordereau: string; lot: string; ennoblisseur: string | null; pieces: PieceProposee[] }

export function lireReception(v: string | null): PropositionReception | null {
  if (!v) return null
  try {
    const o = JSON.parse(v) as PropositionReception
    return Array.isArray(o.pieces) ? o : null
  } catch { return null }
}

/** A BL piece numero → the écru numeros it names (« 3510/11+3510/2 »; a cut « 3545/26-1 » names 3545/26). */
export const numerosEcruDuBl = (numero: string): string[] => numero.split('+').map((n) => n.trim().replace(/-\d+$/, '')).filter(Boolean)

export const messageErreur = (e: unknown) => {
  const b = (e as { body?: { message?: string } } | null)?.body
  return b?.message ?? (e instanceof Error ? e.message : 'Erreur')
}

export const CLE_COMPTEURS = ['tricobot-saisies', 'compteurs'] as const
export const cleSaisies = (idcommande: number) => ['tricobot-saisies', 'commande', idcommande] as const

export function useCompteursTricobot(enabled: boolean) {
  return useQuery<Record<number, CompteurTricobot>>({
    queryKey: CLE_COMPTEURS,
    queryFn: () => apiFetch('/tricobot/saisies/compteurs'),
    enabled,
    staleTime: 30_000,
  })
}

export function useSaisiesTricobot(idcommande: number | null) {
  return useQuery<SaisieTricobot[]>({
    queryKey: cleSaisies(idcommande ?? 0),
    queryFn: () => apiFetch(`/tricobot/saisies?commande=${idcommande}`),
    enabled: !!idcommande,
    staleTime: 0,
  })
}

/** The open points of an order: waiting for a person, or written alone. */
export const ouvertes = (xs: readonly SaisieTricobot[] | undefined) => (xs ?? []).filter((s) => s.statut === 'a_revoir' || s.statut === 'autonome')

/** True when Tricobot waits for a person on the order (red, doctrine §6). */
export const tricobotAttend = (c: CompteurTricobot | undefined) => !!c && c.aValider + c.aide > 0

/** On the order's card, left of its number: Tricobot in a round, ringed red
 *  when he waits for a person (his whole figure inside it — the needle he
 *  holds would stick out of a plain fit); small and plain when he wrote alone. */
export function TricobotAvatar({ c, className }: { c: CompteurTricobot | undefined; className?: string }) {
  if (!c) return null
  const aFaire = c.aValider + c.aide
  if (aFaire > 0) {
    const titre = c.aide > 0 && c.aValider === 0
      ? 'Tricobot demande ton avis'
      : `Tricobot a saisi pour toi${aFaire > 1 ? ` (${aFaire} points)` : ''} : à valider`
    return (
      <span title={titre} className={cn('h-11 w-11 flex-shrink-0 flex items-center justify-center', className)}>
        {/* Tricobot alone, no round: the red card already says « act now ». */}
        <TricobotMascot className="h-11 w-11 drop-shadow" />
      </span>
    )
  }
  if (c.autonome > 0) {
    return (
      <span title="Saisi seul par Tricobot — rien à faire, corrigeable ici" className={cn('h-6 w-6 flex-shrink-0 flex items-center justify-center', className)}>
        <TricobotMascot className="h-6 w-6" />
      </span>
    )
  }
  return null
}

// ── The mail Tricobot read ───────────────────────────────

export interface MailLu {
  id: string; de: string; sujet: string; date: string; resume: string
  /** The documents of the mail (the BL's PDF): GET /tricobot/saisies/mail/:runId/fichiers/:n. */
  fichiers?: Array<{ n: number; nom: string }>
  /** What the document says of itself. */
  bl?: { bordereau: string; commande: string; lot: string; pieces: number; poidsTotal: number | null; metrageTotal: number | null; avertissements: string[] } | null
}

/** The URL of a document of a mail Tricobot read (for an iframe). */
export const urlFichierMail = (runId: string, n: number) => `${API_URL}/tricobot/saisies/mail/${encodeURIComponent(runId)}/fichiers/${n}#view=FitH`

export function useMailLu(runId: string | null) {
  return useQuery<MailLu>({
    queryKey: ['tricobot-saisies', 'mail', runId],
    queryFn: () => apiFetch(`/tricobot/saisies/mail/${runId}`),
    enabled: !!runId,
  })
}

export function MailTricobotDialog({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const q = useQuery<MailLu>({
    queryKey: ['tricobot-saisies', 'mail', runId],
    queryFn: () => apiFetch(`/tricobot/saisies/mail/${runId}`),
    enabled: !!runId,
  })
  return (
    <Dialog open={!!runId} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[90dvh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Mail className="h-5 w-5 text-accent" />Le mail lu par Tricobot</DialogTitle>
        </DialogHeader>
        <div className="mt-4 flex-1 min-h-0 overflow-y-auto space-y-3">
          {q.isLoading && <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>}
          {q.isError && <p className="text-sm text-destructive">{messageErreur(q.error)}</p>}
          {q.data && (
            <>
              <div className="rounded-lg border bg-zinc-100/80 p-3 text-xs space-y-0.5">
                <p><span className="text-muted-foreground">De :</span> {q.data.de}</p>
                <p><span className="text-muted-foreground">Objet :</span> <span className="font-medium">{q.data.sujet}</span></p>
                <p><span className="text-muted-foreground">Reçu le :</span> {new Date(q.data.date).toLocaleString('fr-FR')}</p>
              </div>
              {/* A BL mail is its document. */}
              {q.data.fichiers?.length && runId
                ? <iframe src={urlFichierMail(runId, q.data.fichiers[0].n)} className="w-full h-[60vh] rounded-lg border bg-zinc-50" title={q.data.fichiers[0].nom} />
                : <p className="text-sm italic text-muted-foreground">Document introuvable.</p>}
              <p className="text-xs text-muted-foreground flex items-center gap-1.5"><TricobotMascot className="h-4 w-4" />{q.data.resume}</p>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Gestures ─────────────────────────────────────────────

export type Geste = {
  id: number
  action: 'valider' | 'supprimer' | 'trancher'
  valeur?: string | null
  commentaire?: string
  /** trancher: « Tu as bien fait de me demander ? » (Discernement) and, on a « non », why. */
  justifie?: boolean
  pourquoiAvis?: string
}

export function useGeste(onChanged?: () => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (g: Geste) => apiFetch(`/tricobot/saisies/${g.id}/${g.action}`, {
      method: 'POST',
      body: JSON.stringify({ valeur: g.valeur, commentaire: g.commentaire ?? '', justifie: g.justifie, pourquoiAvis: g.pourquoiAvis ?? '' }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tricobot-saisies'] })
      // The red counter of Sous-traitants › Ennoblissement counts his waits too.
      qc.invalidateQueries({ queryKey: ['commandes-sst-urgency-counts'] })
      qc.invalidateQueries({ queryKey: ['commandes-sst'] })
      qc.invalidateQueries({ queryKey: ['suivi-lots'] })
      qc.invalidateQueries({ queryKey: ['suivi-lot'] })
      onChanged?.()
    },
  })
}

/** Asks why (« Pas à réceptionner »): what Tricobot learns from. */
export function GesteDialog({ open, titre, libelle, isPending, error, onClose, onConfirm }: {
  open: boolean
  titre: string
  libelle: string
  isPending: boolean
  error: string | null
  onClose: () => void
  onConfirm: (pourquoi: string) => void
}) {
  const [pourquoi, setPourquoi] = useState('')
  useEffect(() => {
    if (open) setPourquoi('')
  }, [open])
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader><DialogTitle className="flex items-center gap-2"><TricobotMascot className="h-6 w-6" />{titre}</DialogTitle></DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Pourquoi ? Tricobot s’en sert pour s’améliorer</label>
            <textarea rows={3} value={pourquoi} onChange={(e) => setPourquoi(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
          </div>
          {error && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="h-4 w-4" />{error}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button disabled={!pourquoi.trim() || isPending} onClick={() => onConfirm(pourquoi.trim())}>
            {isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}{libelle}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
