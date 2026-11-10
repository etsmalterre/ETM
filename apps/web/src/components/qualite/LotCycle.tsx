// Qualité › Suivi lots — the lot's cycle (LIVA #1304, decision Vincent
// 2026-10-22). The responsable qualité runs the whole cycle from here:
// soumissions, the client's answers, the rapport de contrôle per client, then
// « Valider le lot », refused by the API while anything is left to do.
// Two soumissions since LIVA #1313: the COLORIS one before the stenter (the
// client's yes = « coloris validé », mailed to the dyer) and the STABILITÉS one on
// the received rolls.
// The step and its blockers are computed by apps/api/src/lib/cycle-ennoblissement.ts.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronUp,
  ClipboardCheck,
  Droplets,
  Hourglass,
  Loader2,
  MailCheck,
  Palette,
  RotateCcw,
  Send,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export type EtapeLot =
  | 'coloris_soumis'
  | 'reteinture'
  | 'ok_ramer_a_envoyer'
  | 'en_rame'
  | 'coloris_a_soumettre'
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
  /** Why the client is dispensed of this lot's RC (never owed), or null. */
  dispense: string | null
  /** An RC is owed: it blocks the validation (or is a task on a validated lot). */
  du: boolean
}

export interface SoumissionLot {
  requise: boolean
  /** 'YYYY-MM-DD' */
  envoyee_le: string | null
  reponse: { accepte: boolean; commentaire: string; par: string; le: string | null } | null
}

/** coloris = before the stenter, stabilites = the received rolls (LIVA #1313). */
export type NatureSoumission = 'coloris' | 'stabilites'

export type SoumissionsLot = Record<NatureSoumission, SoumissionLot>

export const SANS_SOUMISSIONS: SoumissionsLot = {
  coloris: { requise: false, envoyee_le: null, reponse: null },
  stabilites: { requise: false, envoyee_le: null, reponse: null },
}

/** The soumission the client is to answer at this step, if any. */
export function natureEnAttente(etape: EtapeLot): NatureSoumission | null {
  return etape === 'coloris_soumis' ? 'coloris' : etape === 'soumis' ? 'stabilites' : null
}

/** The step's look — shared by the list card icon and the footer pill (§29.8).
 *  Colour = whose move: sky the dyer, amber us, violet the client, red a
 *  refusal, orange a reprise, green done. */
export const ETAPE_LOT_META: Record<EtapeLot, { label: string; icon: LucideIcon; solid: string; iconColor: string }> = {
  coloris_soumis: { label: 'Coloris soumis', icon: Palette, solid: 'bg-violet-500 border-violet-500', iconColor: 'text-violet-600' },
  reteinture: { label: 'En reteinture', icon: Droplets, solid: 'bg-sky-600 border-sky-600', iconColor: 'text-sky-600' },
  ok_ramer_a_envoyer: { label: 'Coloris validé, à transmettre', icon: MailCheck, solid: 'bg-amber-500 border-amber-500', iconColor: 'text-amber-600' },
  en_rame: { label: 'En rame', icon: Hourglass, solid: 'bg-sky-600 border-sky-600', iconColor: 'text-sky-600' },
  coloris_a_soumettre: { label: 'Coloris à soumettre', icon: Palette, solid: 'bg-amber-500 border-amber-500', iconColor: 'text-amber-600' },
  attente_mesures: { label: 'Contrôle ennoblisseur', icon: Hourglass, solid: 'bg-sky-600 border-sky-600', iconColor: 'text-sky-600' },
  attente_tirelle: { label: 'Contrôle Malterre', icon: Hourglass, solid: 'bg-amber-500 border-amber-500', iconColor: 'text-amber-600' },
  a_soumettre: { label: 'Stabilités à soumettre', icon: Send, solid: 'bg-amber-500 border-amber-500', iconColor: 'text-amber-600' },
  soumis: { label: 'Stabilités soumises', icon: Send, solid: 'bg-violet-500 border-violet-500', iconColor: 'text-violet-600' },
  refuse_client: { label: 'Refusé par le client', icon: XCircle, solid: 'bg-red-600 border-red-600', iconColor: 'text-red-600' },
  rc_a_envoyer: { label: 'Rapport à envoyer', icon: ClipboardCheck, solid: 'bg-amber-500 border-amber-500', iconColor: 'text-amber-600' },
  a_valider: { label: 'À valider', icon: ShieldCheck, solid: 'bg-primary border-primary', iconColor: 'text-primary' },
  en_reprise: { label: 'En reprise', icon: RotateCcw, solid: 'bg-orange-500 border-orange-500', iconColor: 'text-orange-600' },
  valide: { label: 'Validé', icon: CheckCircle2, solid: 'bg-success border-success', iconColor: 'text-green-600' },
}

/** The step on a left-list card or a search-bar tag: the footer's solid colour (§29.8). */
export function EtapeLotPill({ etape, className, children }: { etape: EtapeLot; className?: string; children?: ReactNode }) {
  const meta = ETAPE_LOT_META[etape]
  const Icon = meta.icon
  return (
    <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white whitespace-nowrap', meta.solid, className)}>
      <Icon className="h-2.5 w-2.5 flex-shrink-0" />
      <span className="truncate">{meta.label}</span>
      {children}
    </Badge>
  )
}

const fmtJour = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '')

// ── Footer: the step pill + its gestures (§29.4) ─────────

export type GesteLot = 'valider' | 'reprendre' | 'accepte' | 'refuse' | 'ok_ramer'

export function LotCycleFooter({
  etape, prealables, recu, canManage, isChanging, disabled, onGeste,
}: {
  etape: EtapeLot
  prealables: string[]
  /** The lot came back from the dyer: only then has it rolls to take back. */
  recu: boolean
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
          {etape === 'coloris_soumis' && item('accepte', 'Le client accepte le coloris', ThumbsUp, 'text-green-600')}
          {etape === 'coloris_soumis' && item('refuse', 'Le client refuse le coloris…', ThumbsDown, 'text-red-600')}
          {etape === 'soumis' && item('accepte', 'Le client accepte les stabilités', ThumbsUp, 'text-green-600')}
          {etape === 'soumis' && item('refuse', 'Le client refuse les stabilités…', ThumbsDown, 'text-red-600')}
          {(etape === 'ok_ramer_a_envoyer' || etape === 'en_rame') && item(
            'ok_ramer', etape === 'en_rame' ? 'Retransmettre la validation du coloris à l’ennoblisseur…' : 'Transmettre la validation du coloris à l’ennoblisseur…', MailCheck, 'text-amber-600',
          )}
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
          {/* A lot not received has no roll to take back: a refused coloris re-dyes it (« En reteinture »). */}
          {recu && item('reprendre', 'Reprendre…', RotateCcw, 'text-orange-600', etape === 'en_reprise')}
        </div>
      )}
    </div>
  )
}

// ── Center: the step the lot waits for ───────────────────

/** Whose move a prealable is (API cycle-ennoblissement.ts `Main`). */
export type MainLot = 'teinturier' | 'nous' | 'client'

/** The one step the flow waits for, and since when (API `prealableAttendu` + `depuisEtape`). */
export interface AttenduLot {
  texte: string
  main: MainLot
  /** 'YYYY-MM-DD': the day the step started (reception, soumission sent…). */
  depuis: string | null
  /** Working days since `depuis`, start day excluded. */
  jours: number | null
  /** Working days the step gets before we chase (5 for the controls). */
  delai: number | null
}

/** One thing standing between the lot and « Valider le lot » (API `Prealable`). */
export interface PrealableLot {
  texte: string
  main: MainLot
  etape: EtapeLot | null
}

/** « Prochaines étapes » (top of the Journal tab since 2026-11-10): the step the
 *  lot waits for and how long it has been there against the days it gets
 *  (Vincent 2026-11-05: 2 days in « contrôle ennoblisseur » is fine, 5 is a
 *  problem), then what Malterre can already do and what others still owe.
 *  The gestures stay in the footer menu (no button on the card, 2026-11-05);
 *  the RC per client in the header button. */
export function CycleCard({
  etape, prealables, etapes, attendu, clients,
}: {
  etape: EtapeLot
  prealables: string[]
  /** Every prealable with whose move it is; absent from an older API = no lists. */
  etapes?: PrealableLot[]
  /** Absent from an older API: the card falls back to the first prealable. */
  attendu?: AttenduLot | null
  clients: ClientRc[]
}) {
  const valide = etape === 'valide'
  const rcDus = clients.filter((c) => c.du)
  const tete: AttenduLot | null = attendu
    ?? (prealables[0] ? { texte: prealables[0], main: 'nous', depuis: null, jours: null, delai: null } : null)
  const toutFait = !valide && prealables.length === 0
  const meta = ETAPE_LOT_META[etape]
  const EtapeIcon = meta.icon
  const jours = tete?.jours ?? null
  const delai = tete?.delai ?? null
  const mesure = !valide && jours !== null && delai !== null && delai > 0
  // §41, the same thresholds as the list card (urgenceLot): red once the days are
  // used up, amber on the last one.
  const niveau = !mesure ? null : jours >= delai ? 'rouge' : jours >= delai - 1 ? 'ambre' : null
  const retard = mesure ? jours - delai : 0
  // The rest of the list, the awaited step aside: ours first, then the others'.
  const autres = (etapes ?? []).filter((p) => p.texte !== tete?.texte)
  const aFaire = autres.filter((p) => p.main === 'nous')
  const enAttente = autres.filter((p) => p.main !== 'nous')

  return (
    <div className={cn(
      'rounded-xl border bg-card shadow-sm p-4 border-l-4',
      niveau === 'rouge' ? 'border-l-red-500'
        : niveau === 'ambre' ? 'border-l-amber-500'
          : valide ? (rcDus.length ? 'border-l-amber-500' : 'border-l-green-500/60')
            : 'border-l-border',
    )}>
      {!valide && tete && (
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 flex-shrink-0 rounded-lg flex items-center justify-center bg-zinc-100">
            <EtapeIcon className={cn('h-5 w-5', meta.iconColor)} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold leading-snug" title={tete.texte}>{meta.label}</p>
          </div>
          {mesure && (
            <div className="flex-shrink-0 text-right">
              <p className={cn(
                'text-2xl font-bold tabular-nums leading-none',
                niveau === 'rouge' ? 'text-red-600' : niveau === 'ambre' ? 'text-amber-600' : 'text-foreground',
              )}>
                {jours} j
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">sur {delai} j ouvrés</p>
            </div>
          )}
        </div>
      )}

      {mesure && (
        <div className="mt-3">
          <div className="flex gap-1">
            {Array.from({ length: delai }, (_, i) => (
              <div
                key={i}
                className={cn(
                  'h-2 flex-1 rounded-full',
                  i >= jours ? 'bg-zinc-200'
                    : niveau === 'rouge' ? 'bg-red-500' : niveau === 'ambre' ? 'bg-amber-500' : 'bg-sky-500',
                )}
              />
            ))}
          </div>
          {niveau && (
            <p className={cn('mt-1.5 text-xs font-medium', niveau === 'rouge' ? 'text-red-700' : 'text-amber-700')}>
              {niveau === 'ambre'
                ? `Dernier jour demain : ${tete!.main === 'nous' ? 'à traiter' : `relancer ${tete!.main === 'client' ? 'le client' : 'l’ennoblisseur'}`}`
                : `${tete!.main === 'nous' ? 'À traiter' : `Relancer ${tete!.main === 'client' ? 'le client' : 'l’ennoblisseur'}`}${retard > 0 ? ` : ${retard} j de retard` : ' aujourd’hui'}`}
            </p>
          )}
        </div>
      )}

      {!valide && (aFaire.length > 0 || enAttente.length > 0) && (
        <div className="mt-3 pt-3 border-t border-border/60 space-y-2.5">
          {aFaire.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Déjà faisable chez Malterre</p>
              <ul className="space-y-1">
                {aFaire.map((p) => (
                  <li key={p.texte} className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-amber-600" />
                    <span className="min-w-0">{p.texte}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {enAttente.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Attendu ensuite</p>
              <ul className="space-y-1">
                {enAttente.map((p) => (
                  <li key={p.texte} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <Hourglass className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                    <span className="min-w-0">{p.texte}<span className="text-[11px]"> · {p.main === 'client' ? 'client' : 'ennoblisseur'}</span></span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {toutFait && !tete && (
        <p className="flex items-center gap-2 text-sm text-green-700">
          <CheckCircle2 className="h-4 w-4" />Tout est fait : le lot peut être validé.
        </p>
      )}
      {valide && (rcDus.length > 0 ? (
        <p className="flex items-start gap-2 text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>Rapport de contrôle à envoyer à {rcDus.map((c) => c.nom).join(', ')} : des pièces ont été affectées après la validation.</span>
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-green-700">
          <CheckCircle2 className="h-4 w-4" />Lot validé.
        </p>
      ))}

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
              <span className={cn('text-[11px] flex-shrink-0', c.du ? 'text-amber-700 font-medium' : 'text-muted-foreground')} title={c.dispense ?? undefined}>
                {c.du ? 'À envoyer' : c.dernierEnvoi ? `Envoyé ${fmtJour(c.dernierEnvoi)}` : c.dispense ? 'Dispensé' : 'Facultatif'}
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
  open, lot, nature = 'stabilites', recu = true, isPending, error, onCancel, onConfirm,
}: {
  open: boolean
  lot: string
  /** Which soumission the client refuses. */
  nature?: NatureSoumission
  recu?: boolean
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
            Le client refuse {nature === 'coloris' ? 'le coloris du lot' : 'les stabilités du lot'} {lot}
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
            {nature === 'coloris' && !recu
              ? 'Le lot repart en teinture chez l’ennoblisseur, sous le même numéro. Il sera soumis à nouveau quand l’ennoblisseur l’annoncera.'
              : 'Le lot ne pourra plus être validé : il est à reprendre chez l’ennoblisseur, puis à soumettre à nouveau.'}
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
