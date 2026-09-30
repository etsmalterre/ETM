// Paramètres › Utilisateurs — right panel: the ACCOUNT of the selected person
// (password login since 2026-09-30, API routes/comptes.ts). Two tabs:
//   • Compte   — identifiant, password (set / generate, shown once),
//                administrator and active switches, and the apps it belongs
//                to (ETM / TRM — API lib/utilisateur-apps.ts);
//   • Sessions — the browsers logged in, and recent login attempts.
// Enrolled PCs, phones and pointeuses are in the centre « Appareils » tab
// (AppareilsTab.tsx), not here.
// Everything acts immediately (no edit mode), like the permission toggles of
// the centre panel.

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle, AppWindow, CheckCircle2, Copy, History, KeyRound, Loader2, Monitor, MonitorSmartphone,
  Save, ShieldCheck, Smartphone, Trash2, UserCog, Wand2, XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { apiFetch } from '@/lib/api'
import { APP_NAMES, messageErreur, useAppCode, type AppCode } from '@/contexts/UserContext'
import { cn } from '@/lib/utils'

export interface Compte {
  IDutilisateur: number
  prenom: string | null
  nom: string | null
  identifiant: string | null
  email: string | null
  typeCompte: 'personne' | 'poste'
  estAdmin: boolean
  actif: boolean
  aMotDePasse: boolean
  doitChangerMdp: boolean
  mdpModifieLe: string | null
  derniereConnexion: string | null
  /** Live browser sessions (enrolled PCs are counted in `appareils`). */
  sessions: number
  /** Enrolled PCs + phones + pointeuses — the « Appareils » tab. */
  appareils: number
  /** The apps it belongs to — each app's Utilisateurs screen lists its members. */
  apps: AppCode[]
}

const APP_ORDER: AppCode[] = ['etm', 'trm']

interface SessionRow {
  ref: string
  type: 'navigateur'
  libelle: string | null
  creeLe: string
  vuLe: string
  expireLe: string | null
  ip: string | null
  userAgent: string | null
  courante: boolean
}

interface ConnexionRow {
  le: string
  identifiant: string
  ip: string | null
  succes: boolean
  motif: string | null
}

export const COMPTES_KEY = ['comptes'] as const

const inputClass = 'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'
const cardClass = 'p-3 rounded-lg border bg-card shadow-sm'

function fmtDateHeure(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** « Chrome · Windows » from a user agent — enough to recognise a browser. */
function navigateurDe(ua: string | null): string {
  if (!ua) return 'Navigateur'
  const nav = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : /curl/.test(ua) ? 'curl' : 'Navigateur'
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${nav} · ${os}` : nav
}

const MOTIFS: Record<string, string> = {
  mdp: 'mot de passe incorrect',
  inconnu: 'identifiant inconnu',
  inactif: 'compte désactivé',
  sans_mdp: 'aucun mot de passe défini',
  poste: 'compte de poste',
  changement_mdp: 'ancien mot de passe incorrect',
  picker: 'choix du nom',
  enrolement: 'enrôlement du poste',
  code: 'code invalide',
}

export function CompteSidebar({ userId }: { userId: number }) {
  const [tab, setTab] = useState<'compte' | 'sessions'>('compte')
  useEffect(() => { setTab('compte') }, [userId])
  const { data: comptes, isLoading } = useQuery<Compte[]>({
    queryKey: COMPTES_KEY,
    queryFn: () => apiFetch('/comptes'),
  })
  const compte = comptes?.find((c) => c.IDutilisateur === userId) ?? null

  const tabs = [
    { key: 'compte' as const, label: 'Compte', icon: UserCog },
    { key: 'sessions' as const, label: 'Sessions', icon: Monitor },
  ]

  return (
    <div className="w-96 max-w-full flex-shrink-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80 h-full">
      <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
        {tabs.map((t) => {
          const Icon = t.icon
          const active = tab === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                active ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
              {t.key === 'sessions' && compte && compte.sessions > 0 && (
                <span className={cn('text-[10px] tabular-nums', active ? 'opacity-80' : 'opacity-60')}>{compte.sessions}</span>
              )}
            </button>
          )
        })}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
        ) : !compte ? (
          <p className="text-sm text-muted-foreground italic">Compte introuvable.</p>
        ) : tab === 'compte' ? (
          <CompteTab compte={compte} />
        ) : (
          <SessionsTab compte={compte} />
        )}
      </div>
    </div>
  )
}

// ── Compte ─────────────────────────────────────────────────────

function CompteTab({ compte }: { compte: Compte }) {
  const queryClient = useQueryClient()
  const invalider = () => queryClient.invalidateQueries({ queryKey: COMPTES_KEY })
  const [identifiant, setIdentifiant] = useState(compte.identifiant ?? '')
  useEffect(() => { setIdentifiant(compte.identifiant ?? '') }, [compte.IDutilisateur, compte.identifiant])
  const [mdpDialog, setMdpDialog] = useState(false)
  const [confirmSansMdp, setConfirmSansMdp] = useState(false)
  const [confirmDesactiver, setConfirmDesactiver] = useState(false)
  const [confirmQuitter, setConfirmQuitter] = useState(false)
  const app = useAppCode()

  const patch = useMutation({
    mutationFn: (body: Partial<{ identifiant: string; actif: boolean; estAdmin: boolean; apps: AppCode[] }>) =>
      apiFetch(`/comptes/${compte.IDutilisateur}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      invalider()
      queryClient.invalidateQueries({ queryKey: ['permissions'] })
    },
  })
  // Its own mutation so a refusal (409 apps_refusees) shows under its card.
  const appsMut = useMutation({
    mutationFn: (apps: AppCode[]) =>
      apiFetch(`/comptes/${compte.IDutilisateur}`, { method: 'PATCH', body: JSON.stringify({ apps }) }),
    onSuccess: () => {
      invalider()
      queryClient.invalidateQueries({ queryKey: ['perm-users'] })
    },
  })
  useEffect(() => { appsMut.reset() }, [compte.IDutilisateur]) // eslint-disable-line react-hooks/exhaustive-deps
  const basculerApp = (a: AppCode, membre: boolean) => {
    // Leaving THIS app takes the account off this very list: confirm first.
    if (!membre && a === app) { setConfirmQuitter(true); return }
    const apps = membre ? [...compte.apps, a] : compte.apps.filter((x) => x !== a)
    appsMut.mutate(APP_ORDER.filter((x) => apps.includes(x)))
  }
  const retirerMdp = useMutation({
    mutationFn: () => apiFetch(`/comptes/${compte.IDutilisateur}/mot-de-passe`, { method: 'DELETE' }),
    onSuccess: () => { invalider(); setConfirmSansMdp(false) },
  })

  const identifiantModifie = identifiant.trim().toLowerCase() !== (compte.identifiant ?? '')
  const estPoste = compte.typeCompte === 'poste'

  return (
    <>
      {/* Identité */}
      <div className={cardClass}>
        <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
          <UserCog className="h-3.5 w-3.5" />Identification
        </p>
        <div className="space-y-2">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Identifiant de connexion</label>
            <div className="flex gap-1.5">
              <input
                value={identifiant}
                onChange={(e) => setIdentifiant(e.target.value)}
                autoCapitalize="none"
                spellCheck={false}
                className={inputClass}
              />
              <Button
                size="sm"
                className="h-8 flex-shrink-0"
                disabled={!identifiantModifie || !identifiant.trim() || patch.isPending}
                onClick={() => patch.mutate({ identifiant: identifiant.trim().toLowerCase() })}
                title="Enregistrer l’identifiant"
              >
                {patch.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              </Button>
            </div>
            {!estPoste && (
              <p className="text-[11px] text-muted-foreground">
                {compte.email ? <>Il peut aussi se connecter avec <span className="font-medium">{compte.email}</span>.</> : 'Sans adresse e-mail : l’identifiant seul.'}
              </p>
            )}
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted-foreground">Type</span>
            <Badge variant="outline" className="text-[10px]">{estPoste ? 'Poste & appareils' : 'Personne'}</Badge>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted-foreground">Dernière connexion</span>
            <span className="text-sm tabular-nums">{fmtDateHeure(compte.derniereConnexion)}</span>
          </div>
        </div>
        {patch.error && <p className="mt-2 text-xs text-destructive">{messageErreur(patch.error, 'Enregistrement impossible.')}</p>}
      </div>

      {/* Mot de passe — a station account has none: its devices are enrolled by code */}
      {estPoste ? (
        <div className={cardClass}>
          <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
            <MonitorSmartphone className="h-3.5 w-3.5" />Sans mot de passe
          </p>
          <p className="text-[11px] text-muted-foreground">
            Un compte de poste ne se connecte pas avec un mot de passe : ses PC, téléphones et pointeuses
            s’enrôlent avec un code à usage unique, dans l’onglet <span className="font-medium">Appareils</span>.
          </p>
          <p className="mt-2 text-sm flex items-center gap-1.5">
            <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
            {compte.appareils === 0 ? 'Aucun appareil enrôlé' : `${compte.appareils} appareil${compte.appareils > 1 ? 's' : ''} enrôlé${compte.appareils > 1 ? 's' : ''}`}
          </p>
        </div>
      ) : (
        <div className={cardClass}>
          <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
            <KeyRound className="h-3.5 w-3.5" />Mot de passe
          </p>
          <div className="flex items-center gap-2 text-sm">
            {compte.aMotDePasse ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-success flex-shrink-0" />
                <span>Défini le {fmtDateHeure(compte.mdpModifieLe)}</span>
              </>
            ) : (
              <>
                <XCircle className="h-4 w-4 text-destructive flex-shrink-0" />
                <span>Aucun mot de passe — ne peut pas se connecter</span>
              </>
            )}
          </div>
          {compte.doitChangerMdp && (
            <p className="mt-1 text-[11px] text-amber-700">Provisoire : il devra le changer à sa prochaine connexion.</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setMdpDialog(true)}>
              <KeyRound className="h-3.5 w-3.5 mr-1.5" />
              {compte.aMotDePasse ? 'Réinitialiser' : 'Définir'}
            </Button>
            {compte.aMotDePasse && (
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmSansMdp(true)}>
                Retirer
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Droits */}
      <div className={cardClass}>
        <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" />Accès
        </p>
        <div className="space-y-3">
          {!estPoste && (
            <SwitchRow
              label="Administrateur"
              detail="Tous les droits, Paramètres › Utilisateurs, « Voir comme »."
              value={compte.estAdmin}
              disabled={patch.isPending}
              onChange={(v) => patch.mutate({ estAdmin: v })}
            />
          )}
          <SwitchRow
            label="Compte actif"
            detail={compte.actif ? 'Peut se connecter.' : 'Désactivé : connexion refusée, sessions fermées.'}
            value={compte.actif}
            disabled={patch.isPending}
            onChange={(v) => (v ? patch.mutate({ actif: true }) : setConfirmDesactiver(true))}
          />
        </div>
      </div>

      {/* Applications — one login, but each company has its own users */}
      <div className={cardClass}>
        <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
          <AppWindow className="h-3.5 w-3.5" />Applications
        </p>
        <div className="space-y-3">
          {APP_ORDER.map((a) => (
            <SwitchRow
              key={a}
              label={`${APP_NAMES[a]} (${a.toUpperCase()})`}
              detail={compte.apps.includes(a)
                ? (a === app ? 'Membre — cette application.' : 'Membre.')
                : 'Pas d’accès : l’application lui est refusée.'}
              value={compte.apps.includes(a)}
              disabled={appsMut.isPending}
              onChange={(v) => basculerApp(a, v)}
            />
          ))}
        </div>
        {appsMut.error && <p className="mt-2 text-xs text-destructive">{messageErreur(appsMut.error, 'Enregistrement impossible.')}</p>}
      </div>

      <MotDePasseDialog compte={compte} open={mdpDialog} onClose={() => setMdpDialog(false)} onDone={invalider} />
      <ConfirmDialog
        open={confirmSansMdp}
        title="Retirer le mot de passe"
        description={`${nomDe(compte)} ne pourra plus se connecter tant qu’un nouveau mot de passe n’est pas défini. Ses sessions ouvertes sont fermées.`}
        confirmLabel="Retirer"
        isPending={retirerMdp.isPending}
        onCancel={() => setConfirmSansMdp(false)}
        onConfirm={() => retirerMdp.mutate()}
      />
      <ConfirmDialog
        open={confirmDesactiver}
        title="Désactiver le compte"
        description={`${nomDe(compte)} ne pourra plus se connecter et ses sessions ouvertes sont fermées. Son historique est conservé ; le compte peut être réactivé.`}
        confirmLabel="Désactiver"
        isPending={patch.isPending}
        onCancel={() => setConfirmDesactiver(false)}
        onConfirm={() => patch.mutate({ actif: false }, { onSuccess: () => setConfirmDesactiver(false) })}
      />
      <ConfirmDialog
        open={confirmQuitter}
        title={`Retirer de ${APP_NAMES[app]}`}
        description={`${nomDe(compte)} n’aura plus accès à cette application et disparaîtra de cette liste. Ses droits y sont conservés et reviennent s’il y est de nouveau ajouté (« + Nouveau » › Compte existant).`}
        confirmLabel="Retirer"
        isPending={appsMut.isPending}
        error={appsMut.error ? messageErreur(appsMut.error, 'Enregistrement impossible.') : undefined}
        onCancel={() => setConfirmQuitter(false)}
        onConfirm={() => appsMut.mutate(
          compte.apps.filter((x) => x !== app),
          { onSuccess: () => setConfirmQuitter(false) },
        )}
      />
    </>
  )
}

const nomDe = (c: { prenom: string | null; nom: string | null }) =>
  [c.prenom?.trim(), c.nom?.trim()].filter(Boolean).join(' ') || 'Ce compte'

/** §35 inline pill switch. */
function SwitchRow({ label, detail, value, disabled, onChange }: {
  label: string
  detail: string
  value: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-[11px] text-muted-foreground">{detail}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!value)}
        className={cn(
          'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          value ? 'bg-accent shadow-inner' : 'bg-zinc-300 hover:bg-zinc-400/80',
        )}
      >
        <span className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out',
          value ? 'translate-x-[18px]' : 'translate-x-0.5',
        )} />
      </button>
    </div>
  )
}

// ── Password dialog: generate or type, shown once ──────────────

function MotDePasseDialog({ compte, open, onClose, onDone }: {
  compte: Compte
  open: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [mode, setMode] = useState<'generer' | 'saisir'>('generer')
  const [saisi, setSaisi] = useState('')
  const [provisoire, setProvisoire] = useState(false)
  const [resultat, setResultat] = useState<string | null>(null)
  const [copie, setCopie] = useState(false)
  useEffect(() => {
    if (!open) { setMode('generer'); setSaisi(''); setProvisoire(false); setResultat(null); setCopie(false) }
  }, [open])

  const mut = useMutation({
    mutationFn: () => apiFetch<{ motDePasse: string }>(`/comptes/${compte.IDutilisateur}/mot-de-passe`, {
      method: 'POST',
      body: JSON.stringify({ motDePasse: mode === 'saisir' ? saisi : undefined, doitChanger: provisoire }),
    }),
    onSuccess: (r) => { setResultat(r.motDePasse); onDone() },
  })

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-accent" />
            Mot de passe — {nomDe(compte)}
          </DialogTitle>
        </DialogHeader>
        {resultat ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              Voici le mot de passe. Il n’est affiché qu’une fois : notez-le dans le Dashlane de {compte.prenom ?? 'la personne'} maintenant.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded-md border bg-zinc-100 px-3 py-2 text-base font-mono tracking-wide select-all">
                {resultat}
              </code>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 flex-shrink-0"
                title="Copier"
                onClick={() => { void navigator.clipboard?.writeText(resultat).then(() => setCopie(true)) }}
              >
                {copie ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Identifiant : <span className="font-medium">{compte.identifiant}</span>
              {compte.email ? <> (ou {compte.email})</> : null}. Ses sessions ouvertes ont été fermées.
            </p>
            <DialogFooter className="mt-4">
              <Button onClick={onClose}>Terminé</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="mt-4 space-y-3">
              <div className="flex gap-1">
                {([['generer', 'Générer', Wand2], ['saisir', 'Saisir', KeyRound]] as const).map(([k, label, Icon]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setMode(k)}
                    className={cn(
                      'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs rounded-md transition-colors',
                      mode === k ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />{label}
                  </button>
                ))}
              </div>
              {mode === 'generer' ? (
                <p className="text-sm text-muted-foreground">
                  Un mot de passe aléatoire de 16 caractères (ex. <span className="font-mono">Kx7p-Qm3a-…</span>) est créé et affiché une seule fois.
                </p>
              ) : (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Nouveau mot de passe</label>
                  <input
                    type="text"
                    autoComplete="off"
                    value={saisi}
                    onChange={(e) => setSaisi(e.target.value)}
                    className={inputClass}
                  />
                  <p className="text-[11px] text-muted-foreground">Au moins 8 caractères — une phrase de quatre mots se retient bien.</p>
                </div>
              )}
              <SwitchRow
                label="Provisoire"
                detail="Il devra le remplacer par le sien à sa prochaine connexion."
                value={provisoire}
                onChange={setProvisoire}
              />
              {compte.aMotDePasse && (
                <p className="text-[11px] text-amber-700">Remplace le mot de passe actuel et ferme ses sessions ouvertes.</p>
              )}
              {mut.error && (
                <p className="text-xs text-destructive flex items-start gap-1">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
                  {messageErreur(mut.error, 'Enregistrement impossible.')}
                </p>
              )}
            </div>
            <DialogFooter className="mt-4">
              <Button variant="outline" onClick={onClose}>Annuler</Button>
              <Button
                onClick={() => mut.mutate()}
                disabled={mut.isPending || (mode === 'saisir' && saisi.trim().length < 8)}
              >
                {mut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5 mr-1.5" />}
                {mode === 'generer' ? 'Générer' : 'Enregistrer'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ── Sessions ───────────────────────────────────────────────────

function SessionsTab({ compte }: { compte: Compte }) {
  const queryClient = useQueryClient()
  const [confirmTout, setConfirmTout] = useState(false)
  const { data: sessions, isLoading } = useQuery<SessionRow[]>({
    queryKey: ['comptes', compte.IDutilisateur, 'sessions'],
    queryFn: () => apiFetch(`/comptes/${compte.IDutilisateur}/sessions`),
  })
  const { data: connexions } = useQuery<ConnexionRow[]>({
    queryKey: ['comptes', compte.IDutilisateur, 'connexions'],
    queryFn: () => apiFetch(`/comptes/${compte.IDutilisateur}/connexions`),
  })
  const rafraichir = () => queryClient.invalidateQueries({ queryKey: ['comptes'] })
  const revoquer = useMutation({
    mutationFn: (ref: string) => apiFetch(`/comptes/${compte.IDutilisateur}/sessions/${ref}`, { method: 'DELETE' }),
    onSuccess: rafraichir,
  })
  const toutRevoquer = useMutation({
    mutationFn: () => apiFetch(`/comptes/${compte.IDutilisateur}/sessions`, { method: 'DELETE' }),
    onSuccess: () => { rafraichir(); setConfirmTout(false) },
  })

  return (
    <>
      {isLoading && <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-accent" /></div>}
      {sessions && sessions.length === 0 && (
        <p className="text-sm text-muted-foreground italic px-1">
          {compte.typeCompte === 'poste' ? 'Aucun navigateur connecté — les PC enrôlés sont dans l’onglet Appareils.' : 'Aucune session ouverte.'}
        </p>
      )}
      {sessions?.map((s) => (
        <div key={s.ref} className={cn('group', cardClass)}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
                <Monitor className="h-3.5 w-3.5 text-amber-600" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {navigateurDe(s.userAgent)}
                  {s.courante && <Badge variant="secondary" className="ml-1.5 text-[10px] py-0">Cette session</Badge>}
                </p>
                <p className="text-[11px] text-muted-foreground truncate">
                  Vu le {fmtDateHeure(s.vuLe)}{s.ip ? ` · ${s.ip}` : ''}
                </p>
                <p className="text-[11px] text-muted-foreground truncate">
                  Ouverte le {fmtDateHeure(s.creeLe)}
                  {s.libelle ? ` · ${s.libelle}` : ''}
                </p>
              </div>
            </div>
            {!s.courante && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-destructive hover:text-destructive flex-shrink-0"
                title="Fermer cette session"
                disabled={revoquer.isPending}
                onClick={() => revoquer.mutate(s.ref)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      ))}
      {sessions && sessions.filter((s) => !s.courante).length > 1 && (
        <Button variant="ghost" size="sm" className="w-full text-destructive hover:text-destructive" onClick={() => setConfirmTout(true)}>
          Fermer toutes les sessions
        </Button>
      )}

      {connexions && connexions.length > 0 && (
        <div className={cn(cardClass, 'mt-3')}>
          <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
            <History className="h-3.5 w-3.5" />Dernières connexions
          </p>
          <div className="space-y-1">
            {connexions.slice(0, 15).map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                {c.succes
                  ? <CheckCircle2 className="h-3 w-3 text-success flex-shrink-0" />
                  : <XCircle className="h-3 w-3 text-destructive flex-shrink-0" />}
                <span className="tabular-nums text-muted-foreground flex-shrink-0">{fmtDateHeure(c.le)}</span>
                <span className="truncate">
                  {c.succes ? (c.motif ? MOTIFS[c.motif] ?? c.motif : 'connexion') : MOTIFS[c.motif ?? ''] ?? 'échec'}
                </span>
                {c.ip && <span className="ml-auto text-muted-foreground flex-shrink-0">{c.ip}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmTout}
        title="Fermer toutes les sessions"
        description={`${nomDe(compte)} sera déconnecté de tous ses navigateurs. Les appareils enrôlés ne sont pas touchés.`}
        confirmLabel="Fermer"
        isPending={toutRevoquer.isPending}
        onCancel={() => setConfirmTout(false)}
        onConfirm={() => toutRevoquer.mutate()}
      />
    </>
  )
}
