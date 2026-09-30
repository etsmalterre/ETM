// Paramètres › Utilisateurs › Appareils — everything enrolled under one
// account, whatever the device (plan ~/.claude/plans/postes-appareils.md):
//   - PC postes — a station PC holding a session of type 'poste' (lib/postes.ts):
//     no password, no expiry, typed a one-time code on the login screen;
//   - atelier PHONES (atelier.intra…) — a régleur's own (fixed identity: his
//     screens, writes only for him) or shared (the bonnetiers' face grid);
//   - POINTEUSES (pointage.intra…) — the wall tablet clocking the salariés.
// Phones and pointeuses carry their own cookie (lib/appareils-atelier.ts).
// One list, one « Enrôler » button that asks the type; a code enrols only its
// own type. Revoking kills the device's cookie — only someone on site can
// enrol it again. Being enrolled is what lets a device write: there is no
// separate right to grant.
//
// Read: GET /api/comptes/:id/appareils. Writes: /api/comptes/:id/postes/:ref,
// /sessions/:ref, /code-poste (PCs) and /api/atelier/appareils (phones,
// pointeuses). Shared by ETM and TRM (imported relatively, TRM's `@/` has no
// comptes/).

import { useEffect, useState, type ComponentType } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle, Check, Clock, KeyRound, Loader2, Monitor, Pencil, Plus, Smartphone,
  Trash2, UserCheck, Users, X,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { messageErreur } from '@/contexts/UserContext'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { cn } from '@/lib/utils'
import { COMPTES_KEY, type Compte } from './CompteSidebar'

// ── Wire types ─────────────────────────────────────────

type Kind = 'pc' | 'atelier' | 'pointeuse'

interface BonnetierRef { IDbonnetier: number; prenom: string; nom: string }

interface PostePc {
  ref: string
  libelle: string | null
  creeLe: string
  vuLe: string
  ip: string | null
  userAgent: string | null
}

interface Telephone {
  id: number
  type: 'atelier' | 'pointeuse'
  libelle: string
  bonnetier: BonnetierRef | null
  creeLe: string
  vuLe: string | null
}

interface CodeRow {
  type: Kind
  code: string
  libelle: string
  bonnetier: BonnetierRef | null
  expireLe: string
}

interface AppareilsPayload {
  postes: PostePc[]
  telephones: Telephone[]
  codes: CodeRow[]
}

interface Regleur { IDbonnetier: number; prenom: string; nom: string }

/** One device in the list, whatever its store. */
interface Ligne {
  cle: string
  kind: Kind
  libelle: string
  bonnetier: BonnetierRef | null
  creeLe: string
  vuLe: string | null
  detail: string | null
  /** Rename / revoke target: the session ref of a PC, the id of a phone. */
  ref: string | number
}

/** Everything that differs between the three kinds, in one place. */
const KINDS: Record<Kind, {
  label: string
  icone: ComponentType<{ className?: string }>
  appareil: string
  hote: string
  ouSaisir: string
  placeholder: string
  aideLibelle: string
}> = {
  pc: {
    label: 'PC',
    icone: Monitor,
    appareil: 'le PC',
    hote: 'etm.intra.etsmalterre.com ou trm.intra.etsmalterre.com',
    ouSaisir: '« Poste d’atelier : enrôler ce PC avec un code », sous le formulaire de connexion',
    placeholder: 'PC visitage',
    aideLibelle: 'Ce nom distingue le PC dans cette liste.',
  },
  atelier: {
    label: 'Téléphone',
    icone: Smartphone,
    appareil: 'le téléphone',
    hote: 'atelier.intra.etsmalterre.com',
    ouSaisir: '« Enrôler ce téléphone », sous la grille des visages',
    placeholder: 'Téléphone Nico',
    aideLibelle: 'Ce nom est écrit sur chaque action enregistrée depuis le téléphone (colonne « appareil »).',
  },
  pointeuse: {
    label: 'Pointeuse',
    icone: Clock,
    appareil: 'la tablette',
    hote: 'pointage.intra.etsmalterre.com',
    ouSaisir: '« Enrôler cette pointeuse », sous l’horloge',
    placeholder: 'Pointeuse atelier',
    aideLibelle: 'Ce nom distingue la tablette dans cette liste.',
  },
}

/** What can be enrolled under this account: a PC only under a station
 *  account (the API refuses a person's), phones and pointeuses only under a
 *  TRM member (they record TRM production / TRM hours). */
function typesPossibles(compte: Compte): Kind[] {
  const out: Kind[] = []
  if (compte.typeCompte === 'poste') out.push('pc')
  if (compte.apps.includes('trm')) out.push('atelier', 'pointeuse')
  return out
}

// ── Helpers ────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function fmtHeure(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

/** « vu il y a 3 min » — coarse on purpose: devices refresh `vuLe` every
 *  5–10 minutes at most. */
function depuis(iso: string | null, now: number): string {
  if (!iso) return 'jamais vu'
  const min = Math.floor((now - Date.parse(iso)) / 60_000)
  if (min < 1) return 'vu à l’instant'
  if (min < 60) return `vu il y a ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `vu il y a ${h} h`
  return `vu le ${fmtDate(iso)}`
}

const nomComplet = (b: BonnetierRef | null) => (b ? `${b.prenom} ${b.nom}`.trim() : '')

/** « Chrome · Windows » — enough to recognise a PC. */
function navigateurDe(ua: string | null): string | null {
  if (!ua) return null
  const nav = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : null
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null
  return [nav, os].filter(Boolean).join(' · ') || null
}

/** Ticks once a second while mounted — the code countdown. */
function useMaintenant(actif: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!actif) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [actif])
  return now
}

function lignesDe(data: AppareilsPayload): Ligne[] {
  const pcs: Ligne[] = data.postes.map((p) => ({
    cle: `pc-${p.ref}`,
    kind: 'pc',
    libelle: p.libelle ?? 'PC',
    bonnetier: null,
    creeLe: p.creeLe,
    vuLe: p.vuLe,
    detail: [navigateurDe(p.userAgent), p.ip].filter(Boolean).join(' · ') || null,
    ref: p.ref,
  }))
  const tels: Ligne[] = data.telephones.map((t) => ({
    cle: `tel-${t.id}`,
    kind: t.type,
    libelle: t.libelle,
    bonnetier: t.bonnetier,
    creeLe: t.creeLe,
    vuLe: t.vuLe,
    detail: null,
    ref: t.id,
  }))
  const ordre: Record<Kind, number> = { pc: 0, pointeuse: 1, atelier: 2 }
  return [...pcs, ...tels].sort((a, b) => ordre[a.kind] - ordre[b.kind] || a.libelle.localeCompare(b.libelle, 'fr'))
}

// ── The tab ────────────────────────────────────────────

export function AppareilsTab({ compte }: { compte: Compte }) {
  const queryClient = useQueryClient()
  const userId = compte.IDutilisateur
  const queryKey = ['comptes', userId, 'appareils'] as const
  const [enrolerOpen, setEnrolerOpen] = useState(false)
  const [revoquerCible, setRevoquerCible] = useState<Ligne | null>(null)

  const { data, isLoading, isError } = useQuery<AppareilsPayload>({
    queryKey,
    queryFn: () => apiFetch<AppareilsPayload>(`/comptes/${userId}/appareils`),
    // A device enrolling itself is what the admin is waiting to see.
    refetchInterval: 15_000,
  })
  const lignes = data ? lignesDe(data) : []
  const codes = data?.codes ?? []
  const now = useMaintenant(codes.length > 0)
  const types = typesPossibles(compte)

  const invalider = () => {
    queryClient.invalidateQueries({ queryKey })
    queryClient.invalidateQueries({ queryKey: COMPTES_KEY })
  }

  const revoquerMut = useMutation({
    mutationFn: (l: Ligne) => l.kind === 'pc'
      ? apiFetch(`/comptes/${userId}/sessions/${l.ref}`, { method: 'DELETE' })
      : apiFetch(`/atelier/appareils/${l.ref}`, { method: 'DELETE' }),
    onSuccess: () => { invalider(); setRevoquerCible(null) },
  })

  const annulerCodeMut = useMutation({
    mutationFn: (c: CodeRow) => c.type === 'pc'
      ? apiFetch(`/comptes/${userId}/code-poste/${c.code}`, { method: 'DELETE' })
      : apiFetch(`/atelier/appareils/codes/${c.code}`, { method: 'DELETE' }),
    onSuccess: invalider,
  })

  return (
    <>
      <div className="rounded-lg border border-border/60 bg-white shadow-sm">
        <div className="px-4 py-2 border-b border-border/60 bg-zinc-100/80 rounded-t-lg flex items-center gap-2">
          <Smartphone className="h-3.5 w-3.5 text-accent" />
          <p className="text-xs font-bold text-primary uppercase tracking-wide flex-1">Appareils enrôlés</p>
          {types.length > 0 && (
            <Button size="sm" onClick={() => setEnrolerOpen(true)} disabled={!compte.actif} title={compte.actif ? 'Enrôler un appareil' : 'Compte désactivé'}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />Enrôler
            </Button>
          )}
        </div>

        <div className="p-4 space-y-3">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-accent" />Chargement…
            </div>
          )}
          {isError && (
            <p className="text-xs text-destructive flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />Impossible de lire les appareils enrôlés.
            </p>
          )}

          {codes.length > 0 && (
            <ul className="space-y-2">
              {codes.map((c) => {
                const reste = Math.max(0, Math.floor((Date.parse(c.expireLe) - now) / 1000))
                const mm = String(Math.floor(reste / 60)).padStart(2, '0')
                const ss = String(reste % 60).padStart(2, '0')
                const forme = c.type === 'atelier'
                  ? (c.bonnetier ? `téléphone du régleur ${nomComplet(c.bonnetier)}` : 'téléphone partagé')
                  : KINDS[c.type].label.toLowerCase()
                return (
                  <li key={c.code} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-accent/40 bg-accent/[0.06]">
                    <KeyRound className="h-4 w-4 text-accent flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xl font-heading font-bold tracking-[0.3em] tabular-nums text-primary">{c.code}</span>
                        <span className="text-xs text-muted-foreground">expire dans {mm}:{ss}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {c.libelle} · {forme} — en attente de saisie sur {KINDS[c.type].appareil}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" title="Annuler ce code" disabled={annulerCodeMut.isPending} onClick={() => annulerCodeMut.mutate(c)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}

          {data && lignes.length === 0 && codes.length === 0 && (
            <p className="text-sm text-muted-foreground italic">Aucun appareil enrôlé sous ce compte.</p>
          )}

          {lignes.length > 0 && (
            <ul className="space-y-2">
              {lignes.map((l) => (
                <LigneAppareil key={l.cle} ligne={l} userId={userId} now={now} onRenomme={invalider} onRevoquer={() => setRevoquerCible(l)} />
              ))}
            </ul>
          )}

          <p className="text-xs text-muted-foreground">
            {types.length === 0
              ? 'Rien ne s’enrôle sous ce compte : un PC s’enrôle sous un compte de poste, un téléphone ou une pointeuse sous un compte membre de TRM.'
              : 'Un appareil enrôlé agit sous ce compte, avec ses écrans et ses permissions, sans mot de passe. Le révoquer le déconnecte aussitôt : il faudra un nouveau code, saisi sur place, pour l’enrôler à nouveau.'}
          </p>
        </div>
      </div>

      {enrolerOpen && (
        <EnrolerDialog
          compte={compte}
          types={types}
          onClose={() => { setEnrolerOpen(false); invalider() }}
        />
      )}

      <ConfirmDialog
        open={revoquerCible !== null}
        title={revoquerCible ? `Révoquer ${revoquerCible.kind === 'pc' ? 'le PC' : revoquerCible.kind === 'pointeuse' ? 'la pointeuse' : 'le téléphone'}` : ''}
        description={revoquerCible
          ? `« ${revoquerCible.libelle} » est déconnecté aussitôt et ne pourra plus rien enregistrer. Il faudra un nouveau code, saisi sur place, pour l’enrôler à nouveau.`
          : undefined}
        confirmLabel="Révoquer"
        isPending={revoquerMut.isPending}
        error={revoquerMut.error ? messageErreur(revoquerMut.error, 'Révocation impossible.') : undefined}
        onCancel={() => { setRevoquerCible(null); revoquerMut.reset() }}
        onConfirm={() => { if (revoquerCible) revoquerMut.mutate(revoquerCible) }}
      />
    </>
  )
}

// ── One device row: icon, name (renamable in place), kind, last seen ────────

function LigneAppareil({ ligne: l, userId, now, onRenomme, onRevoquer }: {
  ligne: Ligne
  userId: number
  now: number
  onRenomme: () => void
  onRevoquer: () => void
}) {
  const [edition, setEdition] = useState(false)
  const [libelle, setLibelle] = useState(l.libelle)
  useEffect(() => { if (!edition) setLibelle(l.libelle) }, [l.libelle, edition])

  const renommer = useMutation({
    mutationFn: (v: string) => l.kind === 'pc'
      ? apiFetch(`/comptes/${userId}/postes/${l.ref}`, { method: 'PATCH', body: JSON.stringify({ libelle: v }) })
      : apiFetch(`/atelier/appareils/${l.ref}`, { method: 'PATCH', body: JSON.stringify({ libelle: v }) }),
    onSuccess: () => { setEdition(false); onRenomme() },
  })
  const valider = () => {
    const v = libelle.trim()
    if (!v || v === l.libelle) { setEdition(false); return }
    renommer.mutate(v)
  }

  const Icone = l.kind === 'atelier' ? (l.bonnetier ? UserCheck : Users) : KINDS[l.kind].icone
  return (
    <li className="group flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/60 bg-white shadow-sm">
      <div className={cn(
        'h-9 w-9 rounded-md flex items-center justify-center flex-shrink-0',
        l.bonnetier ? 'bg-accent/15 text-accent' : 'bg-zinc-100 text-zinc-600',
      )}>
        <Icone className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        {edition ? (
          <div className="flex items-center gap-1.5">
            <input
              value={libelle}
              onChange={(e) => setLibelle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') valider(); if (e.key === 'Escape') setEdition(false) }}
              maxLength={l.kind === 'pc' ? 80 : 50}
              autoFocus
              autoComplete="off"
              className="h-7 min-w-0 flex-1 px-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <Button size="icon" className="h-7 w-7 flex-shrink-0" title="Enregistrer le nom" disabled={!libelle.trim() || renommer.isPending} onClick={valider}>
              {renommer.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 flex-shrink-0" title="Annuler" onClick={() => setEdition(false)}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-primary truncate">{l.libelle}</span>
            {l.kind === 'atelier' && l.bonnetier ? (
              <Badge variant="outline" className="bg-accent/15 text-amber-800 border-accent/40">Régleur · {nomComplet(l.bonnetier)}</Badge>
            ) : (
              <Badge variant="outline" className="text-zinc-600">
                {l.kind === 'atelier' ? 'Téléphone partagé' : KINDS[l.kind].label}
              </Badge>
            )}
            <button
              type="button"
              title="Renommer"
              onClick={() => setEdition(true)}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-accent"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-0.5 truncate">
          Enrôlé le {fmtDate(l.creeLe)} à {fmtHeure(l.creeLe)} · {depuis(l.vuLe, now)}{l.detail ? ` · ${l.detail}` : ''}
        </p>
        {renommer.error && <p className="text-xs text-destructive mt-0.5">{messageErreur(renommer.error, 'Renommage impossible.')}</p>}
      </div>
      <Button variant="ghost" size="sm" title="Révoquer" className="text-destructive hover:text-destructive flex-shrink-0" onClick={onRevoquer}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  )
}

// ── « Enrôler » — type, label (and a phone's identity), then the code ───────

function EnrolerDialog({ compte, types, onClose }: { compte: Compte; types: Kind[]; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>(types[0])
  const [libelle, setLibelle] = useState('')
  const [IDbonnetier, setIDbonnetier] = useState(0)
  const [resultat, setResultat] = useState<{ code: string; expireLe: string } | null>(null)
  const userName = [compte.prenom, compte.nom].filter(Boolean).join(' ')
  const k = KINDS[kind]

  const { data: regleurs } = useQuery<Regleur[]>({
    queryKey: ['atelier', 'bonnetiers', 'regleur'],
    queryFn: () => apiFetch<Regleur[]>('/atelier/bonnetiers?regleur=1'),
    staleTime: 5 * 60_000,
    // Only a phone can carry a fixed identity.
    enabled: kind === 'atelier',
  })

  // Pre-select the régleur whose name matches the account (Nicolas Antonino
  // the user ↔ Nicolas Antonino the bonnetier): the common case is his own
  // phone under his own account. The admin can still switch to « partagé ».
  useEffect(() => {
    if (!regleurs || kind !== 'atelier' || IDbonnetier !== 0) return
    const same = regleurs.find((r) => `${r.prenom} ${r.nom}`.trim().toLowerCase() === userName.trim().toLowerCase())
    if (same) {
      setIDbonnetier(same.IDbonnetier)
      setLibelle((l) => l || `Téléphone ${same.prenom}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regleurs, kind])

  const creer = useMutation({
    mutationFn: async () => {
      if (kind === 'pc') {
        const r = await apiFetch<{ code: string; expire: string }>(`/comptes/${compte.IDutilisateur}/code-poste`, {
          method: 'POST', body: JSON.stringify({ libelle: libelle.trim() }),
        })
        return { code: r.code, expireLe: r.expire }
      }
      return apiFetch<{ code: string; expireLe: string }>('/atelier/appareils/codes', {
        method: 'POST',
        body: JSON.stringify({
          type: kind,
          IDutilisateur: compte.IDutilisateur,
          IDbonnetier: kind === 'atelier' && IDbonnetier > 0 ? IDbonnetier : null,
          libelle: libelle.trim(),
        }),
      })
    },
    onSuccess: setResultat,
  })

  const options = (regleurs ?? []).map((r) => ({ id: r.IDbonnetier, primary: `${r.prenom} ${r.nom}`.trim(), secondary: 'régleur' }))

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <k.icone className="h-5 w-5 text-accent" />
            Enrôler un appareil — {userName || 'ce compte'}
          </DialogTitle>
        </DialogHeader>

        {resultat ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg border border-accent/40 bg-accent/[0.06] px-4 py-5 text-center">
              <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">Code d’enrôlement</p>
              <p className="mt-1 text-4xl font-heading font-bold tracking-[0.35em] tabular-nums text-primary">{resultat.code}</p>
              <p className="mt-1 text-xs text-muted-foreground">valable jusqu’à {fmtHeure(resultat.expireLe)}, une seule fois</p>
            </div>
            <ol className="text-sm space-y-1.5 list-decimal pl-5">
              <li>Sur {k.appareil}, ouvrir <span className="font-semibold">{k.hote}</span>.</li>
              <li>Toucher <span className="font-semibold">{k.ouSaisir}</span>.</li>
              <li>Saisir ce code. L’appareil apparaît dans la liste dès son enrôlement.</li>
            </ol>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {types.length > 1 && (
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground">Type d’appareil</label>
                <div className="flex gap-1">
                  {types.map((t) => {
                    const T = KINDS[t]
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => { setKind(t); creer.reset() }}
                        className={cn(
                          'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs rounded-md transition-colors',
                          kind === t ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10',
                        )}
                      >
                        <T.icone className="h-3.5 w-3.5" />{T.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground" htmlFor="appareil-libelle">Nom de l’appareil</label>
              <input
                id="appareil-libelle"
                type="text"
                value={libelle}
                onChange={(e) => setLibelle(e.target.value)}
                placeholder={k.placeholder}
                maxLength={kind === 'pc' ? 80 : 50}
                autoComplete="off"
                autoFocus
                className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-xs text-muted-foreground">{k.aideLibelle}</p>
            </div>

            {kind === 'atelier' && (
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground">Identité du téléphone</label>
                <PopoverSelect
                  options={options}
                  value={IDbonnetier}
                  onChange={setIDbonnetier}
                  emptyLabel="Téléphone partagé — grille des bonnetiers"
                />
                <p className="text-xs text-muted-foreground">
                  {IDbonnetier > 0
                    ? 'Le téléphone s’ouvrira directement sur les écrans du régleur, sans grille de visages, et n’enregistrera que pour lui.'
                    : 'Le téléphone proposera la grille des bonnetiers ; celui qui le tient choisit son visage.'}
                </p>
              </div>
            )}

            {creer.error && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />{messageErreur(creer.error, 'La génération du code a échoué.')}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="mt-4">
          {resultat ? (
            <Button onClick={onClose}>Fermer</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>Annuler</Button>
              <Button disabled={!libelle.trim() || creer.isPending} onClick={() => creer.mutate()}>
                {creer.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5 mr-1.5" />}
                Générer le code
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
