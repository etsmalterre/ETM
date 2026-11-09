// « Nouveau » design of the lab screen (2026-11-09), shown beside the old one
// (pages/Labo.tsx) through the header switch (lib/design.tsx) while Vincent
// compares them. Same data, same API calls, same rules as Labo.tsx — only the
// presentation changes:
//   • the open lot is a navy band (§43 of mps_designer) carrying its identity,
//     its client(s) and a 3-step track: avant lavage › après lavage › rangé;
//   • each step is a short checklist of numbered tasks that tick green as they
//     are filled, so what is left reads at a glance;
//   • the bottom button names what is missing instead of greying out;
//   • queue cards carry a step stripe, the measures done and the lot's age.
// Fits a Galaxy Tab A9 in landscape (1005 × 600), like the old design.
import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, Archive, ArrowLeft, Building2, Check, CheckCircle2, ChevronRight, CircleDashed, Droplets,
  Loader2, Palette, Pencil, RefreshCw, Ruler, Scissors, Trash2, X,
} from 'lucide-react'
import {
  enregistrerAvantLavage, fetchLots, marquerJete, terminerApresLavage,
  type EtapeLabo, type LotLabo, type VerdictColoris,
} from '@/lib/tirelle-api'
import type { ApiError } from '@/lib/api'
import { messagePourErreur } from '@/lib/erreurs'
import { ChampNombre, aidesTolerance, fmt, horsBornes, horsRetrait, lireNombre } from '@/components/Champs'
import { ChoixDesign } from '@/lib/design'
import { cn } from '@/lib/utils'

const LOTS_KEY = ['tirelle', 'lots'] as const
const CLE_CASIER = 'tirelle.dernier-casier'

const ETAPES: Record<EtapeLabo, { libelle: string; court: string; icone: typeof Scissors }> = {
  a_jeter: { libelle: 'À jeter', court: 'À jeter', icone: Trash2 },
  avant_lavage: { libelle: 'Avant lavage', court: 'Avant lavage', icone: Scissors },
  apres_lavage: { libelle: 'Après lavage', court: 'Après lavage', icone: Droplets },
}

// The queue's step colours: navy before the wash, the charter's accent blue after, red for
// the bin run (an action to do now — §41).
// A real bar, not an inset shadow: the card's own shadow would replace it.
const RAYURE: Record<EtapeLabo, string> = {
  a_jeter: 'bg-destructive',
  avant_lavage: 'bg-primary',
  apres_lavage: 'bg-accent-blue-vif',
}

// ── Formatting ──────────────────────────────────────────

function jour(d: string | null): string {
  if (!d) return ''
  const [y, m, j] = d.slice(0, 10).split('-')
  return `${j}/${m}/${y}`
}

/** « reçu aujourd'hui / hier / il y a 12 j ». */
function age(d: string | null): string {
  if (!d) return ''
  const t = new Date(`${d.slice(0, 10)}T00:00:00`)
  const auj = new Date()
  auj.setHours(0, 0, 0, 0)
  const n = Math.round((auj.getTime() - t.getTime()) / 86_400_000)
  if (n <= 0) return 'reçu aujourd’hui'
  if (n === 1) return 'reçu hier'
  return `reçu il y a ${n} j`
}

const article = (l: LotLabo) => [l.reference, l.coloris].filter(Boolean).join(' - ')

/** The measures of the lot's current phase: [done, asked]. */
function avancement(l: LotLabo): [number, number] {
  const phase = l.etape === 'apres_lavage' ? l.demandes.carre : l.etape === 'avant_lavage' ? l.demandes.rond : []
  return [phase.filter((m) => !l.manque.includes(m)).length, phase.length]
}

// ── Page ────────────────────────────────────────────────

export function LaboNouveau() {
  const qc = useQueryClient()
  const lots = useQuery({ queryKey: LOTS_KEY, queryFn: fetchLots })
  const [selection, setSelection] = useState<number | null>(null)

  const liste = lots.data?.lots ?? []
  const choisi = liste.find((l) => l.idsuivilot === selection) ?? null
  useEffect(() => {
    if (selection !== null && lots.data && !choisi) setSelection(null)
  }, [selection, lots.data, choisi])

  const rafraichir = () => qc.invalidateQueries({ queryKey: LOTS_KEY })

  return (
    <div className="h-full flex flex-col bg-zinc-100">
      <Entete lots={liste} chargement={lots.isFetching} onRafraichir={rafraichir} />
      {lots.isError && !lots.data ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-destructive">
          <AlertTriangle className="h-10 w-10" />
          <p className="text-lg font-semibold">{messagePourErreur(lots.error as ApiError)}</p>
          <button type="button" onClick={rafraichir} className="h-12 px-6 rounded-xl border border-border bg-white text-foreground text-base font-semibold">
            Réessayer
          </button>
        </div>
      ) : !lots.data ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-10 w-10 animate-spin text-gold" />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex gap-3 p-3">
          <div className={cn('min-h-0 flex-col w-full min-[900px]:w-[360px] min-[900px]:flex-shrink-0', choisi ? 'hidden min-[900px]:flex' : 'flex')}>
            <File lots={liste} selection={selection} onChoisir={setSelection} />
          </div>
          <div className={cn('flex-1 min-w-0 min-h-0', choisi ? 'flex' : 'hidden min-[900px]:flex')}>
            {choisi ? (
              <Lot
                key={`${choisi.idsuivilot}:${choisi.etape}`}
                lot={choisi}
                onFermer={() => setSelection(null)}
                onFait={(garder) => {
                  rafraichir()
                  if (!garder) setSelection(null)
                }}
              />
            ) : (
              <AucunLot vide={liste.length === 0} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Entete({ lots, chargement, onRafraichir }: { lots: LotLabo[]; chargement: boolean; onRafraichir: () => void }) {
  const n = (e: EtapeLabo) => lots.filter((l) => l.etape === e).length
  return (
    <>
      <div className="safe-top bg-primary" />
      <header className="flex-shrink-0 flex items-center gap-3 border-b-2 border-gold bg-primary px-4 h-14">
        <img src="/logo-m.png" alt="" className="h-9 w-9 rounded-lg" />
        <h1 className="text-lg font-heading font-bold tracking-tight text-primary-foreground truncate">Labo · Tirelles</h1>
        {/* The queue at a glance: how many lots wait at each step. */}
        <div className="hidden sm:flex items-center gap-1.5 ml-2">
          <Compteur icone={Scissors} n={n('avant_lavage')} libelle="avant lavage" />
          <Compteur icone={Droplets} n={n('apres_lavage')} libelle="après lavage" />
          {n('a_jeter') > 0 && <Compteur icone={Trash2} n={n('a_jeter')} libelle="à jeter" rouge />}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ChoixDesign />
          <span className="text-xs text-white/40 tabular-nums hidden md:inline">v{__APP_VERSION__}</span>
          <button
            type="button"
            onClick={onRafraichir}
            className="h-11 w-11 rounded-xl flex items-center justify-center text-white/80 active:bg-white/15"
            title="Actualiser"
          >
            <RefreshCw className={cn('h-5 w-5', chargement && 'animate-spin')} />
          </button>
        </div>
      </header>
    </>
  )
}

function Compteur({ icone: Icone, n, libelle, rouge }: { icone: typeof Scissors; n: number; libelle: string; rouge?: boolean }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
      rouge ? 'bg-destructive text-white' : 'bg-white/10 text-white/90 ring-1 ring-white/15',
    )}>
      <Icone className="h-3.5 w-3.5" />
      <span className="tabular-nums text-sm">{n}</span>
      {libelle}
    </span>
  )
}

function AucunLot({ vide }: { vide: boolean }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 rounded-2xl bg-white/60 border border-border/60 text-muted-foreground">
      <div className={cn('h-20 w-20 rounded-full flex items-center justify-center', vide ? 'bg-success/10' : 'bg-gold/15')}>
        {vide ? <CheckCircle2 className="h-10 w-10 text-success" /> : <CircleDashed className="h-10 w-10 text-gold-foreground/70" />}
      </div>
      <p className="text-xl font-semibold text-foreground">{vide ? 'Rien à contrôler' : 'Choisissez un lot'}</p>
      <p className="text-base -mt-2">{vide ? 'Les nouveaux lots arrivent tout seuls.' : 'Touchez un lot dans la liste pour commencer.'}</p>
    </div>
  )
}

// ── The queue ───────────────────────────────────────────

function File({ lots, selection, onChoisir }: { lots: LotLabo[]; selection: number | null; onChoisir: (id: number) => void }) {
  if (lots.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
        <CheckCircle2 className="h-14 w-14 text-success/60" />
        <p className="text-lg">Rien à contrôler pour le moment.</p>
      </div>
    )
  }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent pb-4 px-1">
      {(['a_jeter', 'avant_lavage', 'apres_lavage'] as const).map((e) => {
        const ls = lots.filter((l) => l.etape === e)
        if (ls.length === 0) return null
        const E = ETAPES[e]
        return (
          <section key={e} className="mb-3">
            {/* Sticky so the step stays named while its cards scroll. */}
            <div className="sticky top-0 z-10 -mx-1 px-1 py-1.5 bg-zinc-100/95 backdrop-blur-sm">
              <div className={cn(
                'flex items-center gap-2 rounded-lg px-3 py-1.5',
                e === 'a_jeter' ? 'bg-destructive text-white' : e === 'avant_lavage' ? 'bg-primary text-primary-foreground' : 'bg-accent-blue-vif text-white',
              )}>
                <E.icone className="h-4 w-4" />
                <h2 className="text-sm font-bold uppercase tracking-wide">{E.libelle}</h2>
                <span className="ml-auto rounded-full bg-white/20 px-2 text-sm font-bold tabular-nums">{ls.length}</span>
              </div>
            </div>
            <div className="space-y-2 pt-1">
              {ls.map((l) => <Carte key={l.idsuivilot} lot={l} actif={selection === l.idsuivilot} onClick={() => onChoisir(l.idsuivilot)} />)}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function Carte({ lot, actif, onClick }: { lot: LotLabo; actif: boolean; onClick: () => void }) {
  const hors = Object.values(lot.hors).some((h) => h === true)
  const [fait, total] = avancement(lot)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick()}
      className={cn(
        'relative overflow-hidden rounded-xl border bg-white pl-4 pr-3 py-2.5 cursor-pointer select-none transition-all',
        actif ? 'border-gold ring-2 ring-gold bg-gold/[0.06] shadow-md' : 'border-border/60 shadow-sm active:bg-zinc-50',
      )}
    >
      <span className={cn('absolute inset-y-0 left-0 w-1.5', RAYURE[lot.etape])} />
      <div className="flex items-center gap-2">
        <span className="text-xl font-bold tabular-nums">{lot.lot}</span>
        {hors && <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" aria-label="Mesure hors tolérance" />}
        {lot.clients.length > 0 && (
          <span className="ml-auto min-w-0 flex">
            <PillClient nom={lot.clients.length > 1 ? 'Plusieurs clients' : lot.clients[0]} titre={lot.clients.join(', ')} />
          </span>
        )}
      </div>
      <p className="text-sm truncate mt-0.5">{article(lot) || '—'}</p>
      <div className="flex items-center gap-2 mt-1.5 text-xs text-muted-foreground">
        <span className="truncate">{lot.etape === 'a_jeter' ? `Repris : ${lot.a_jeter?.motif || 'reprise'}` : [lot.sous_traitant, age(lot.reception)].filter(Boolean).join(' · ')}</span>
        {total > 0 && <Points fait={fait} total={total} />}
      </div>
    </div>
  )
}

/** Measures of the current phase: one dot each, green once given. */
function Points({ fait, total }: { fait: number; total: number }) {
  return (
    <span className="ml-auto flex items-center gap-1 flex-shrink-0" title={`${fait} mesure${fait > 1 ? 's' : ''} sur ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={cn('h-2 w-2 rounded-full', i < fait ? 'bg-success' : 'bg-zinc-300')} />
      ))}
    </span>
  )
}

function PillClient({ nom, titre, sombre }: { nom: string; titre?: string; sombre?: boolean }) {
  return (
    <span
      title={titre ?? nom}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 rounded-full border font-semibold',
        sombre ? 'border-teal/40 bg-teal-light px-3 py-1 text-sm text-teal-dark' : 'border-teal/30 bg-teal-light px-2 py-0.5 text-xs text-teal-dark',
      )}
    >
      <Building2 className={cn('flex-shrink-0', sombre ? 'h-4 w-4' : 'h-3 w-3')} />
      <span className="truncate">{nom}</span>
    </span>
  )
}

// ── The open lot ────────────────────────────────────────

function Lot({ lot, onFermer, onFait }: { lot: LotLabo; onFermer: () => void; onFait: (garder: boolean) => void }) {
  const [corriger, setCorriger] = useState(false)
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col rounded-2xl border border-border/60 bg-zinc-50 shadow-sm overflow-hidden">
      <Bandeau lot={lot} onFermer={onFermer} />
      {lot.etape === 'a_jeter' ? (
        <Jeter lot={lot} onFait={() => onFait(false)} />
      ) : lot.etape === 'avant_lavage' ? (
        <AvantLavage lot={lot} onFait={() => onFait(true)} />
      ) : corriger ? (
        <AvantLavage
          lot={lot}
          correction
          onAnnuler={() => setCorriger(false)}
          onFait={() => {
            setCorriger(false)
            onFait(true)
          }}
        />
      ) : (
        <ApresLavage lot={lot} onCorriger={() => setCorriger(true)} onFait={() => onFait(false)} />
      )}
    </div>
  )
}

/** The lot's identity (navy band, gold rule) and where it stands in the lab. */
function Bandeau({ lot, onFermer }: { lot: LotLabo; onFermer: () => void }) {
  const rouge = lot.etape === 'a_jeter'
  return (
    <div className={cn('flex-shrink-0 flex items-center gap-3 px-4 py-2.5 border-b-2', rouge ? 'bg-destructive border-red-300' : 'bg-primary border-gold')}>
      <button type="button" onClick={onFermer} className="h-11 w-11 -ml-1 rounded-xl flex items-center justify-center text-white active:bg-white/15 min-[900px]:hidden" title="Retour à la liste">
        <ArrowLeft className="h-6 w-6" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="flex-shrink-0 text-3xl leading-9 font-heading font-bold tracking-tight tabular-nums text-white">{lot.lot}</h2>
          {lot.clients.length > 0 && (
            <div className="min-w-0 flex items-center gap-1.5 overflow-hidden">
              {lot.clients.map((c) => <PillClient key={c} nom={c} sombre />)}
            </div>
          )}
        </div>
        <p className="truncate text-base text-white/90">
          {article(lot) || '—'}
          <span className="text-white/60">{[lot.sous_traitant, lot.reception && `reçu le ${jour(lot.reception)}`].filter(Boolean).map((t) => ` · ${t}`).join('')}</span>
        </p>
      </div>
      {!rouge && <Piste etape={lot.etape} />}
    </div>
  )
}

/** avant lavage › après lavage › rangé: done green, current gold, next faded. */
function Piste({ etape }: { etape: EtapeLabo }) {
  const pas = [
    { cle: 'avant_lavage', libelle: 'Avant lavage' },
    { cle: 'apres_lavage', libelle: 'Après lavage' },
    { cle: 'range', libelle: 'Rangé' },
  ] as const
  const courant = pas.findIndex((p) => p.cle === etape)
  return (
    <ol className="hidden lg:flex items-center gap-1 flex-shrink-0">
      {pas.map((p, i) => (
        <li key={p.cle} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-4 w-4 text-white/40" />}
          <span className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
            i < courant && 'bg-success/90 text-white',
            i === courant && 'bg-gold text-gold-foreground shadow-sm',
            i > courant && 'text-white/50 ring-1 ring-white/20',
          )}>
            {i < courant ? <Check className="h-3.5 w-3.5" /> : <span className="tabular-nums">{i + 1}</span>}
            {p.libelle}
          </span>
        </li>
      ))}
    </ol>
  )
}

// ── Step layout ─────────────────────────────────────────

/** Tasks scroll (only as a fallback on a small screen), the action stays at the bottom. */
function Etape({ pied, children }: { pied: ReactNode; children: ReactNode }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent space-y-2 p-3">{children}</div>
      <div className="flex-shrink-0 space-y-2 border-t border-border/60 bg-white p-3">{pied}</div>
    </div>
  )
}

/** One numbered task: its number turns into a green tick once done. */
function Tache({ n, titre, fait, facultatif, droite, children }: {
  n: number
  titre: string
  fait: boolean
  facultatif?: boolean
  droite?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={cn('rounded-xl border bg-white px-4 py-2.5 shadow-sm transition-colors', fait ? 'border-success/40' : 'border-border/60')}>
      <div className="flex items-center gap-2.5 mb-2">
        <span className={cn(
          'h-7 w-7 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 transition-colors',
          fait ? 'bg-success text-white' : facultatif ? 'bg-zinc-200 text-zinc-600' : 'bg-gold text-gold-foreground',
        )}>
          {fait ? <Check className="h-4 w-4" /> : n}
        </span>
        <h3 className="text-base font-semibold text-primary">{titre}</h3>
        {facultatif && !fait && <span className="text-sm text-muted-foreground">facultatif</span>}
        {droite && <div className="ml-auto min-w-0">{droite}</div>}
      </div>
      {children}
    </section>
  )
}

/** The instruction of the step, a light navy strip above the tasks. */
function Consigne({ icone: Icone, children }: { icone: typeof Scissors; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-primary/[0.06] border border-primary/10 px-4 py-2.5 text-base">
      <Icone className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1 space-y-1.5">{children}</div>
    </div>
  )
}

function Observations({ n, valeur, onChange, ecart }: { n: number; valeur: string; onChange: (v: string) => void; ecart?: boolean }) {
  return (
    <Tache n={n} titre="Observations" fait={!!valeur.trim()} facultatif={!ecart}>
      <textarea
        value={valeur}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        maxLength={2000}
        placeholder={ecart ? 'Décrivez l’écart de coloris…' : 'Une remarque sur le lot'}
        className={cn(
          'w-full rounded-xl border-2 bg-background px-3 py-2 text-lg focus:outline-none focus:ring-4 focus:ring-gold/40 resize-none',
          ecart && !valeur.trim() ? 'border-gold' : 'border-border',
        )}
      />
    </Tache>
  )
}

/** The step's one action: gold when everything is there, otherwise it says what is missing. */
function Action({ enCours, manque, onClick, icone: Icone, children, ton = 'gold' }: {
  enCours: boolean
  manque: string[]
  onClick: () => void
  icone: typeof Scissors
  children: ReactNode
  ton?: 'gold' | 'rouge'
}) {
  const pret = manque.length === 0
  return (
    <button
      type="button"
      disabled={!pret || enCours}
      onClick={onClick}
      className={cn(
        'w-full h-14 rounded-xl text-xl font-semibold flex items-center justify-center gap-2 transition-colors',
        !pret && 'bg-zinc-100 text-muted-foreground border-2 border-dashed border-border',
        pret && ton === 'gold' && 'bg-gold text-gold-foreground shadow-md active:opacity-90',
        pret && ton === 'rouge' && 'bg-destructive text-white shadow-md active:opacity-90',
      )}
    >
      {enCours ? <Loader2 className="h-6 w-6 animate-spin" /> : pret ? <Icone className="h-6 w-6" /> : <CircleDashed className="h-5 w-5" />}
      {pret ? children : <span className="text-lg">Il reste : {manque.join(', ')}</span>}
    </button>
  )
}

function Erreur({ e }: { e: unknown }) {
  if (!e) return null
  return (
    <p className="flex items-start gap-2 text-base text-destructive font-medium" role="alert">
      <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
      {messagePourErreur(e as ApiError)}
    </p>
  )
}

function InfoRond0({ lot }: { lot: LotLabo }) {
  const r0 = lot.rond0
  if (r0?.estCeLot) {
    return (
      <p className="rounded-lg bg-gold/15 border border-gold/40 px-3 py-1.5 text-sm">
        <strong>Premier lot de ce coloris :</strong> son rond devient le rond 0 du classeur.
      </p>
    )
  }
  if (!r0) {
    return <p className="text-sm text-muted-foreground">Aucun rond 0 connu dans ETM pour ce coloris : comparez avec le classeur.</p>
  }
  return (
    <p className="text-sm text-muted-foreground">
      Sortez le <strong className="text-foreground">rond 0</strong> : lot <strong className="tabular-nums text-foreground">{r0.lot}</strong>
      {r0.date && <> du {jour(r0.date)}</>}, rangez le nouveau à côté.
    </p>
  )
}

// ── Before the wash ─────────────────────────────────────

function AvantLavage({ lot, correction = false, onAnnuler, onFait }: {
  lot: LotLabo
  correction?: boolean
  onAnnuler?: () => void
  onFait: () => void
}) {
  const [laize, setLaize] = useState(fmt(lot.mesures.laize || null))
  const [poids, setPoids] = useState(fmt(lot.mesures.poids || null))
  const [coloris, setColoris] = useState<VerdictColoris | null>(lot.mesures.coloris)
  const [observations, setObservations] = useState(lot.observations)
  const aides = aidesTolerance(lot.tolerances)
  const demande = (m: string) => lot.demandes.rond.includes(m)
  const mut = useMutation({
    mutationFn: () => enregistrerAvantLavage(lot.idsuivilot, { laize, poids, coloris, observations }),
    onSuccess: onFait,
  })
  const manque = [
    demande('laize') && !lireNombre(laize) && 'la laize',
    demande('poids') && !lireNombre(poids) && 'le poids',
    demande('coloris') && !coloris && 'le coloris',
  ].filter(Boolean) as string[]
  const mesuresFaites = (!demande('laize') || !!lireNombre(laize)) && (!demande('poids') || !!lireNombre(poids))
  let n = 0
  const action = (
    <Action enCours={mut.isPending} manque={manque} onClick={() => mut.mutate()} icone={Check}>
      {correction ? 'Enregistrer la correction' : 'Contrôles avant lavage faits'}
    </Action>
  )

  return (
    <Etape
      pied={(
        <>
          <Erreur e={mut.error} />
          {correction ? (
            <div className="grid grid-cols-[1fr_2fr] gap-3">
              <button type="button" disabled={mut.isPending} onClick={() => onAnnuler?.()} className="h-14 rounded-xl border-2 border-border bg-white text-xl font-semibold flex items-center justify-center gap-2">
                <X className="h-6 w-6" />Annuler
              </button>
              {action}
            </div>
          ) : action}
        </>
      )}
    >
      <Consigne icone={correction ? Pencil : Scissors}>
        <p>
          {correction
            ? 'Correction des mesures du rond : le lot reste en contrôles après lavage.'
            : <>Découpez le <strong>rond</strong> et le <strong>carré de 50 × 50 cm</strong>, lot écrit dessus.</>}
        </p>
        {!demande('coloris') && lot.rond0?.estCeLot && <InfoRond0 lot={lot} />}
      </Consigne>
      {(demande('laize') || demande('poids')) && (
        <Tache n={++n} titre="Mesurer le rond" fait={mesuresFaites}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {demande('laize') && (
              <ChampNombre label="Laize" unite="cm" valeur={laize} onChange={setLaize}
                aide={aides.laize} hors={horsBornes(lireNombre(laize), lot.tolerances.laize)} />
            )}
            {demande('poids') && (
              <ChampNombre label="Poids" unite="g/m²" valeur={poids} onChange={setPoids}
                aide={aides.poids} hors={horsBornes(lireNombre(poids), lot.tolerances.poids)} />
            )}
          </div>
        </Tache>
      )}
      {demande('coloris') && (
        <Tache n={++n} titre="Comparer le coloris au rond 0" fait={!!coloris} droite={<InfoRond0 lot={lot} />}>
          <div className="grid grid-cols-2 gap-3">
            {([['conforme', 'Conforme', CheckCircle2], ['ecart', 'Écart', AlertTriangle]] as const).map(([v, libelle, Icone]) => (
              <button
                key={v}
                type="button"
                onClick={() => setColoris(v)}
                aria-pressed={coloris === v}
                className={cn(
                  'h-14 rounded-xl border-2 text-xl font-semibold flex items-center justify-center gap-2 transition-colors',
                  coloris === v
                    ? v === 'conforme' ? 'bg-success border-success text-white shadow-sm' : 'bg-destructive border-destructive text-white shadow-sm'
                    : v === 'conforme' ? 'bg-white border-success/40 text-success active:bg-success/10' : 'bg-white border-destructive/40 text-destructive active:bg-destructive/10',
                )}
              >
                <Icone className="h-6 w-6" />{libelle}
              </button>
            ))}
          </div>
        </Tache>
      )}
      <Observations n={++n} valeur={observations} onChange={setObservations} ecart={coloris === 'ecart'} />
    </Etape>
  )
}

// ── After the wash ──────────────────────────────────────

function dernierCasier(): string {
  try {
    return localStorage.getItem(CLE_CASIER) ?? ''
  } catch {
    return ''
  }
}

function ApresLavage({ lot, onCorriger, onFait }: { lot: LotLabo; onCorriger: () => void; onFait: () => void }) {
  const signeDe = (v: number) => (v > 0 ? '+' : '-') as '-' | '+'
  const [stabh, setStabh] = useState(fmt(lot.mesures.stabh ? Math.abs(lot.mesures.stabh) : null))
  const [stabl, setStabl] = useState(fmt(lot.mesures.stabl ? Math.abs(lot.mesures.stabl) : null))
  const [sh, setSh] = useState<'-' | '+'>(signeDe(lot.mesures.stabh))
  const [sl, setSl] = useState<'-' | '+'>(signeDe(lot.mesures.stabl))
  const [vrillage, setVrillage] = useState(fmt(lot.mesures.vrillage))
  const [casier, setCasier] = useState(() => dernierCasier())
  const [observations, setObservations] = useState(lot.observations)
  const aides = aidesTolerance(lot.tolerances)
  const demande = (m: string) => lot.demandes.carre.includes(m)
  const signe = (s: '-' | '+', v: string) => {
    const x = lireNombre(v)
    return x == null ? null : s === '-' ? -x : x
  }
  const vh = signe(sh, stabh)
  const vl = signe(sl, stabl)
  const mut = useMutation({
    mutationFn: () => terminerApresLavage(lot.idsuivilot, {
      stabh: vh == null ? '' : String(vh),
      stabl: vl == null ? '' : String(vl),
      vrillage,
      casier,
      observations,
    }),
    onSuccess: () => {
      try {
        localStorage.setItem(CLE_CASIER, casier.trim())
      } catch {
        /* storage disabled */
      }
      onFait()
    },
  })
  const stabsFaites = !demande('stabilités') || (vh != null && vl != null)
  const vrillageFait = !demande('vrillage') || lireNombre(vrillage) != null
  const manque = [
    !stabsFaites && 'les stabs',
    !vrillageFait && 'le vrillage',
    !casier.trim() && 'le casier',
  ].filter(Boolean) as string[]
  const aMesurer = demande('stabilités') || demande('vrillage')
  let n = 0

  return (
    <Etape
      pied={(
        <>
          <Erreur e={mut.error} />
          <Action enCours={mut.isPending} manque={manque} onClick={() => mut.mutate()} icone={CheckCircle2}>
            Contrôles terminés, lot rangé
          </Action>
        </>
      )}
    >
      <RecapRond lot={lot} onCorriger={onCorriger} />
      {aMesurer && (
        <Tache n={++n} titre="Mesurer le carré lavé et séché" fait={stabsFaites && vrillageFait}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {demande('stabilités') && (
              <>
                <ChampNombre label="Stab H" unite="%" valeur={stabh} onChange={setStabh} signe={sh} onSigne={setSh}
                  aide={aides.stabh} hors={horsRetrait(vh, lot.tolerances.stabh)} />
                <ChampNombre label="Stab L" unite="%" valeur={stabl} onChange={setStabl} signe={sl} onSigne={setSl}
                  aide={aides.stabl} hors={horsRetrait(vl, lot.tolerances.stabl)} />
              </>
            )}
            {demande('vrillage') && (
              <ChampNombre label="Vrillage" unite="%" valeur={vrillage} onChange={setVrillage}
                aide={aides.vrillage}
                hors={lireNombre(vrillage) == null ? null : lireNombre(vrillage)! > lot.tolerances.vrillageMax} />
            )}
          </div>
        </Tache>
      )}
      <Tache n={++n} titre="Ranger le carré avec la tirelle" fait={!!casier.trim()}>
        <div className="flex items-center gap-3">
          <Archive className="h-6 w-6 text-muted-foreground flex-shrink-0" />
          <label className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex-shrink-0">Casier</label>
          <input
            type="text"
            value={casier}
            onChange={(e) => setCasier(e.target.value)}
            maxLength={40}
            className="w-48 min-w-0 h-14 rounded-xl border-2 border-border bg-background px-4 text-3xl font-bold focus:outline-none focus:ring-4 focus:ring-gold/40"
          />
          {dernierCasier() && <span className="text-sm text-muted-foreground">dernier : {dernierCasier()}</span>}
        </div>
      </Tache>
      <Observations n={++n} valeur={observations} onChange={setObservations} />
    </Etape>
  )
}

/** The round's measures, done: a green line with the way back to correct them. */
function RecapRond({ lot, onCorriger }: { lot: LotLabo; onCorriger: () => void }) {
  const m = lot.mesures
  const demande = (k: string) => lot.demandes.rond.includes(k)
  const parts: Array<{ k: 'laize' | 'poids' | 'coloris'; icone: typeof Scissors; texte: string }> = []
  if (demande('laize')) parts.push({ k: 'laize', icone: Ruler, texte: `${fmt(m.laize || null) || '—'} cm` })
  if (demande('poids')) parts.push({ k: 'poids', icone: Ruler, texte: `${fmt(m.poids || null) || '—'} g/m²` })
  if (demande('coloris') && m.coloris) parts.push({ k: 'coloris', icone: Palette, texte: m.coloris === 'ecart' ? 'écart' : 'conforme' })
  return (
    <div className="flex items-center gap-3 rounded-xl border border-success/40 bg-success/[0.06] px-4 py-1.5">
      <span className="h-7 w-7 rounded-full bg-success text-white flex items-center justify-center flex-shrink-0">
        <Check className="h-4 w-4" />
      </span>
      <p className="font-semibold flex-shrink-0">Avant lavage</p>
      <div className="min-w-0 flex-1 flex items-center gap-2 overflow-hidden">
        {parts.length === 0 ? <span className="text-muted-foreground">rien à mesurer</span> : parts.map((p) => (
          <span key={p.k} className={cn(
            'inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-0.5 text-sm border tabular-nums',
            lot.hors[p.k] === true ? 'border-destructive/40 text-destructive font-semibold' : 'border-border/60',
          )}>
            <p.icone className="h-3.5 w-3.5" />{p.texte}
          </span>
        ))}
      </div>
      {parts.length > 0 && (
        <button type="button" onClick={onCorriger} className="h-11 px-3 rounded-xl flex items-center gap-2 text-base font-semibold text-accent-blue active:bg-white flex-shrink-0">
          <Pencil className="h-4 w-4" />Corriger
        </button>
      )}
    </div>
  )
}

// ── After a reprise ─────────────────────────────────────

function Jeter({ lot, onFait }: { lot: LotLabo; onFait: () => void }) {
  const mut = useMutation({ mutationFn: () => marquerJete(lot.idsuivilot), onSuccess: onFait })
  const j = lot.a_jeter
  return (
    <Etape
      pied={(
        <>
          <Erreur e={mut.error} />
          <Action enCours={mut.isPending} manque={[]} onClick={() => mut.mutate()} icone={Trash2} ton="rouge">
            Rond, carré et tirelle jetés
          </Action>
        </>
      )}
    >
      <Consigne icone={AlertTriangle}>
        <p><strong>Lot repris par l’ennoblisseur.</strong>{j?.motif && <> Motif : {j.motif}</>}</p>
        <p className="text-muted-foreground">Il reviendra sur la tablette avec une nouvelle tirelle : tout sera refait.</p>
      </Consigne>
      <Tache n={1} titre="Jeter le rond, dans le classeur" fait={false}>
        <p className="text-base text-muted-foreground">Retirez-le du classeur des ronds.</p>
      </Tache>
      <Tache n={2} titre="Jeter le carré et la tirelle" fait={false}>
        <p className="text-base text-muted-foreground">{j?.casier ? <>Ils sont dans le casier <strong className="text-foreground">{j.casier}</strong>.</> : 'Dans leur casier.'}</p>
      </Tache>
    </Etape>
  )
}
