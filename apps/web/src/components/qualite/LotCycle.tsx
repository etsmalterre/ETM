// Qualité › Suivi lots — the lot's cycle (LIVA #1304, decision Vincent
// 2026-10-22). The responsable qualité runs the whole cycle from here:
// soumission, the client's answer, the rapport de contrôle per client, then
// « Valider le lot », refused by the API while anything is left to do.
// The step and its blockers are computed by apps/api/src/lib/cycle-ennoblissement.ts.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronUp,
  CircleDashed,
  ClipboardCheck,
  Hourglass,
  Loader2,
  RotateCcw,
  Ruler,
  Send,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export type EtapeLot =
  | 'attente_mesures'
  | 'attente_tirelle'
  | 'a_soumettre'
  | 'soumis'
  | 'refuse_client'
  | 'rc_a_envoyer'
  | 'a_valider'
  | 'en_reprise'
  | 'valide'

/** One client of the lot (its pieces are affected to the client's orders). */
export interface ClientRc {
  idclient: number
  nom: string
  /** Clients › Gestion « Envoyer le rapport de contrôle de chaque lot ». */
  rcActif: boolean
  pieces: number
  piecesNonExpediees: number
  /** 'YYYY-MM-DD HH:MM' */
  dernierEnvoi: string | null
  /** An RC is owed: it blocks the validation (or is a task on a validated lot). */
  du: boolean
}

export interface SoumissionLot {
  requise: boolean
  /** 'YYYY-MM-DD' */
  envoyee_le: string | null
  reponse: { accepte: boolean; commentaire: string; par: string; le: string | null } | null
}

/** The step's look — shared by the list card icon and the footer pill (§29.8).
 *  Colour = whose move: sky the dyer, amber us, violet the client, red a
 *  refusal, orange a reprise, green done. */
export const ETAPE_LOT_META: Record<EtapeLot, { label: string; icon: LucideIcon; solid: string; iconColor: string }> = {
  attente_mesures: { label: 'Attente contrôle ennoblisseur', icon: Hourglass, solid: 'bg-sky-600 border-sky-600', iconColor: 'text-sky-600' },
  attente_tirelle: { label: 'Attente contrôle Malterre', icon: Ruler, solid: 'bg-amber-500 border-amber-500', iconColor: 'text-amber-600' },
  a_soumettre: { label: 'À soumettre', icon: Send, solid: 'bg-amber-500 border-amber-500', iconColor: 'text-amber-600' },
  soumis: { label: 'Soumis au client', icon: Send, solid: 'bg-violet-500 border-violet-500', iconColor: 'text-violet-600' },
  refuse_client: { label: 'Refusé par le client', icon: XCircle, solid: 'bg-red-600 border-red-600', iconColor: 'text-red-600' },
  rc_a_envoyer: { label: 'Rapport à envoyer', icon: ClipboardCheck, solid: 'bg-amber-500 border-amber-500', iconColor: 'text-amber-600' },
  a_valider: { label: 'À valider', icon: ShieldCheck, solid: 'bg-primary border-primary', iconColor: 'text-primary' },
  en_reprise: { label: 'En reprise', icon: RotateCcw, solid: 'bg-orange-500 border-orange-500', iconColor: 'text-orange-600' },
  valide: { label: 'Validé', icon: CheckCircle2, solid: 'bg-success border-success', iconColor: 'text-green-600' },
}

const fmtJour = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '')
const fmtJourHeure = (iso: string | null) => (iso ? `${fmtJour(iso)} ${iso.slice(11, 16)}` : '')

// ── Footer: the step pill + its gestures (§29.4) ─────────

export type GesteLot = 'valider' | 'reprendre' | 'accepte' | 'refuse'

export function LotCycleFooter({
  etape, prealables, canManage, isChanging, disabled, onGeste,
}: {
  etape: EtapeLot
  prealables: string[]
  canManage: boolean
  isChanging: boolean
  disabled: boolean
  onGeste: (g: GesteLot) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const meta = ETAPE_LOT_META[etape]
  const Icon = meta.icon

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])
  useEffect(() => { if (disabled || !canManage) setMenuOpen(false) }, [disabled, canManage])

  const valide = etape === 'valide'
  const bloque = !valide && prealables.length > 0
  const item = (g: GesteLot, label: string, ItemIcon: LucideIcon, iconColor: string, off = false, detail?: ReactNode) => (
    <button
      key={g}
      type="button"
      disabled={off}
      onClick={() => { if (!off) onGeste(g); setMenuOpen(false) }}
      className={cn(
        'w-full flex flex-col gap-1 px-3 py-2 text-sm text-left transition-colors',
        off ? 'cursor-not-allowed text-muted-foreground' : 'hover:bg-zinc-100',
      )}
    >
      <span className="flex items-center gap-2">
        <ItemIcon className={cn('h-4 w-4', off ? 'text-muted-foreground' : iconColor)} />
        {label}
      </span>
      {detail}
    </button>
  )

  return (
    <div ref={rootRef} className="flex-shrink-0 relative">
      <div className={cn('rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11', meta.solid)}>
        <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
          <Icon className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-bold uppercase tracking-wide truncate">{meta.label}</span>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={disabled || isChanging}
            title="Changer le statut"
            className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors"
          >
            {isChanging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronUp className={cn('h-3.5 w-3.5 transition-transform', menuOpen && 'rotate-180')} />}
            Changer
          </button>
        )}
      </div>
      {canManage && menuOpen && (
        <div className="absolute bottom-full right-0 mb-1 w-full min-w-[260px] rounded-lg border bg-white shadow-lg overflow-hidden z-50 divide-y divide-border/50">
          {etape === 'soumis' && item('accepte', 'Le client accepte le lot', ThumbsUp, 'text-green-600')}
          {etape === 'soumis' && item('refuse', 'Le client refuse le lot…', ThumbsDown, 'text-red-600')}
          {!valide && item(
            'valider', 'Valider le lot', CheckCircle2, 'text-green-600', bloque,
            bloque ? (
              <ul className="ml-6 space-y-0.5">
                {prealables.map((p) => (
                  <li key={p} className="text-[11px] leading-snug text-muted-foreground">· {p}</li>
                ))}
              </ul>
            ) : undefined,
          )}
          {item('reprendre', 'Reprendre…', RotateCcw, 'text-orange-600', etape === 'en_reprise')}
        </div>
      )}
    </div>
  )
}

// ── Center: what the lot still needs ─────────────────────

/** « Avant validation »: the checklist the validation obeys, the soumission
 *  and its answer, and the rapport de contrôle per client. */
export function CycleCard({
  etape, prealables, soumission, clients,
}: {
  etape: EtapeLot
  prealables: string[]
  soumission: SoumissionLot
  clients: ClientRc[]
}) {
  const valide = etape === 'valide'
  const rcDus = clients.filter((c) => c.du)
  return (
    <div className={cn(
      'rounded-xl border bg-card shadow-sm p-4 border-l-4',
      valide ? (rcDus.length ? 'border-l-amber-400/70' : 'border-l-green-500/60')
        : prealables.length ? 'border-l-amber-400/70' : 'border-l-green-500/60',
    )}>
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">{valide ? 'Lot validé' : 'Avant validation'}</h2>
      </div>

      {!valide && (prealables.length > 0 ? (
        <ul className="space-y-1">
          {prealables.map((p) => (
            <li key={p} className="flex items-start gap-2 text-sm">
              <CircleDashed className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-600" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 text-sm text-green-700">
          <CheckCircle2 className="h-4 w-4" />Tout est fait : le lot peut être validé.
        </p>
      ))}
      {valide && rcDus.length > 0 && (
        <p className="flex items-start gap-2 text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>Rapport de contrôle à envoyer à {rcDus.map((c) => c.nom).join(', ')} : des pièces ont été affectées après la validation.</span>
        </p>
      )}

      {(soumission.requise || soumission.envoyee_le || clients.length > 0) && (
        <div className="mt-3 pt-3 border-t border-border/50 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="space-y-1">
            <p className="font-semibold text-muted-foreground uppercase tracking-wide text-[10px]">Soumission</p>
            {!soumission.requise && !soumission.envoyee_le ? (
              <p className="text-muted-foreground italic">Non demandée par le client</p>
            ) : !soumission.envoyee_le ? (
              <p className="text-amber-700">À envoyer</p>
            ) : (
              <>
                <p>Envoyée le {fmtJour(soumission.envoyee_le)}</p>
                {soumission.reponse ? (
                  <p className={soumission.reponse.accepte ? 'text-green-700' : 'text-red-700'}>
                    {soumission.reponse.accepte ? 'Acceptée' : 'Refusée'} par le client
                    {soumission.reponse.le ? ` · saisi le ${fmtJourHeure(soumission.reponse.le)}` : ''}
                    {soumission.reponse.par ? ` par ${soumission.reponse.par}` : ''}
                    {soumission.reponse.commentaire ? <span className="block italic text-muted-foreground">« {soumission.reponse.commentaire} »</span> : null}
                  </p>
                ) : (
                  <p className="text-violet-700">Réponse du client attendue</p>
                )}
              </>
            )}
          </div>
          <div className="space-y-1">
            <p className="font-semibold text-muted-foreground uppercase tracking-wide text-[10px]">Rapport de contrôle</p>
            {clients.length === 0 ? (
              <p className="text-muted-foreground italic">Aucune pièce affectée à un client</p>
            ) : clients.map((c) => (
              <p key={c.idclient} className="flex items-baseline justify-between gap-2">
                <span className="truncate">{c.nom} <span className="text-muted-foreground">· {c.pieces} pièce{c.pieces > 1 ? 's' : ''}</span></span>
                <span className={cn('flex-shrink-0', c.du ? 'text-amber-700 font-medium' : 'text-muted-foreground')}>
                  {c.du ? 'À envoyer' : c.dernierEnvoi ? `Envoyé le ${fmtJour(c.dernierEnvoi)}` : c.rcActif ? 'Pièces expédiées' : 'Facultatif'}
                </span>
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Header: « Envoyer le rapport de contrôle » (§42 menu, one row per client) ──

export function RcMenuButton({ clients, onSelect }: { clients: ClientRc[]; onSelect: (c: ClientRc) => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])
  const du = clients.some((c) => c.du)
  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="outline" size="icon" className="h-9 w-9 relative"
        title={du ? 'Envoyer le rapport de contrôle — à envoyer' : 'Envoyer le rapport de contrôle'}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <ClipboardCheck className="h-4 w-4" />
        {du && <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-white" />}
      </Button>
      {menuOpen && (
        <div className="absolute top-full right-0 mt-1 w-72 rounded-lg border bg-white shadow-lg overflow-hidden z-50">
          <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Rapport de contrôle pour…</p>
          {clients.map((c) => (
            <button
              key={c.idclient}
              type="button"
              onClick={() => { onSelect(c); setMenuOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-zinc-100"
            >
              <ClipboardCheck className={cn('h-4 w-4 flex-shrink-0', c.du ? 'text-amber-600' : 'text-muted-foreground')} />
              <span className="min-w-0 flex-1 truncate">{c.nom}</span>
              <span className={cn('text-[11px] flex-shrink-0', c.du ? 'text-amber-700 font-medium' : 'text-muted-foreground')}>
                {c.du ? 'À envoyer' : c.dernierEnvoi ? `Envoyé ${fmtJour(c.dernierEnvoi)}` : 'Facultatif'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── The client refuses the lot: why is required ──────────

export function RefusClientDialog({
  open, lot, isPending, error, onCancel, onConfirm,
}: {
  open: boolean
  lot: string
  isPending: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (commentaire: string) => void
}) {
  const [commentaire, setCommentaire] = useState('')
  useEffect(() => { if (open) setCommentaire('') }, [open])
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !isPending) onCancel() }}>
      <DialogContent className="max-w-md" onClose={onCancel}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ThumbsDown className="h-5 w-5 text-accent" />
            Le client refuse le lot {lot}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Pourquoi le client refuse-t-il le lot ?</label>
            <textarea
              value={commentaire}
              onChange={(e) => setCommentaire(e.target.value)}
              rows={3}
              autoFocus
              placeholder="Teinte trop foncée, toucher différent…"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Le lot ne pourra plus être validé : il est à reprendre chez l’ennoblisseur, puis à soumettre à nouveau.
          </p>
          {error && (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span>{error}</span>
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={isPending}>Annuler</Button>
          <Button onClick={() => onConfirm(commentaire.trim())} disabled={!commentaire.trim() || isPending}>
            {isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <ThumbsDown className="h-3.5 w-3.5 mr-1.5" />}
            Enregistrer le refus
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
