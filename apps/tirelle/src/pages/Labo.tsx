// The lab: every lot with something to do, and the selected lot's controls.
// One screen, like a workshop station (mps_designer §45 « Poste »): the lots
// come to the tablet on their own (received BLs, reprises), Laetitia never
// searches.
//
// Two statuses (API lib/tirelle-labo.ts, Vincent 2026-11-03: no machine /
// dryer steps): « avant lavage » (laize, poids, coloris on the round) moves on
// its own to « après lavage » (stabs, vrillage on the square + casier → done),
// where a lot simply waits while its square is washed. Plus « à jeter » after
// a reprise.
import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, ArrowLeft, Check, CheckCircle2, CircleDashed, Droplets, Loader2,
  RefreshCw, Scissors, Trash2, X,
} from 'lucide-react'
import {
  enregistrerAvantLavage, fetchLots, marquerJete, terminerApresLavage,
  type EtapeLabo, type LotLabo, type VerdictColoris,
} from '@/lib/tirelle-api'
import type { ApiError } from '@/lib/api'
import { messagePourErreur } from '@/lib/erreurs'
import { ChampNombre, aidesTolerance, fmt, horsBornes, horsRetrait, lireNombre } from '@/components/Champs'
import { cn } from '@/lib/utils'

const LOTS_KEY = ['tirelle', 'lots'] as const

const ETAPES: Record<EtapeLabo, { libelle: string; icone: typeof Scissors }> = {
  a_jeter: { libelle: 'À jeter', icone: Trash2 },
  avant_lavage: { libelle: 'Contrôles avant lavage', icone: Scissors },
  apres_lavage: { libelle: 'Contrôles après lavage', icone: Droplets },
}

// ── Formatting ──────────────────────────────────────────

function jour(d: string | null): string {
  if (!d) return ''
  const [y, m, j] = d.slice(0, 10).split('-')
  return `${j}/${m}/${y}`
}

const article = (l: LotLabo) => [l.reference, l.coloris].filter(Boolean).join(' - ')

// ── Page ────────────────────────────────────────────────

export function Labo() {
  const qc = useQueryClient()
  const lots = useQuery({ queryKey: LOTS_KEY, queryFn: fetchLots })
  const [selection, setSelection] = useState<number | null>(null)

  const liste = lots.data?.lots ?? []
  const choisi = liste.find((l) => l.idsuivilot === selection) ?? null
  // A lot that left the queue (done, or moved by the office) closes its panel.
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
          {/* Below 900 px (tablet upright) one column: the list, or the open lot. */}
          <div className={cn('min-h-0 flex-col w-full min-[900px]:w-[400px] min-[900px]:flex-shrink-0', choisi ? 'hidden min-[900px]:flex' : 'flex')}>
            <FileLots lots={liste} selection={selection} onChoisir={setSelection} />
          </div>
          <div className={cn('flex-1 min-w-0 min-h-0', choisi ? 'flex' : 'hidden min-[900px]:flex')}>
            {choisi ? (
              <DetailLot
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
  const aJeter = lots.filter((l) => l.etape === 'a_jeter').length
  return (
    <>
    {/* The status-bar spacer (index.css), zero in fullscreen. */}
    <div className="safe-top bg-primary" />
    <header className="flex-shrink-0 flex items-center gap-3 border-b-2 border-gold bg-primary px-4 h-16">
      <img src="/logo-m.png" alt="" className="h-9 w-9 rounded-lg" />
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-heading font-bold tracking-tight text-primary-foreground truncate">Labo · Contrôle des tirelles</h1>
        <p className="text-xs text-white/70 truncate">
          {lots.length === 0 ? 'Aucun lot en cours' : `${lots.length} lot${lots.length > 1 ? 's' : ''} en cours`}
          {aJeter > 0 && <span className="ml-2 font-semibold text-red-200">· {aJeter} à jeter</span>}
        </p>
      </div>
      <span className="text-xs text-white/40 tabular-nums hidden sm:inline">v{__APP_VERSION__}</span>
      <button
        type="button"
        onClick={onRafraichir}
        className="h-11 w-11 rounded-xl flex items-center justify-center text-white/80 active:bg-white/15"
        title="Actualiser"
      >
        <RefreshCw className={cn('h-5 w-5', chargement && 'animate-spin')} />
      </button>
    </header>
    </>
  )
}

function AucunLot({ vide }: { vide: boolean }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3 rounded-2xl border-2 border-dashed border-border">
      {vide ? <CheckCircle2 className="h-14 w-14 text-success/60" /> : <CircleDashed className="h-14 w-14 opacity-40" />}
      <p className="text-lg font-medium">{vide ? 'Rien à contrôler pour le moment.' : 'Touchez un lot pour le contrôler.'}</p>
    </div>
  )
}

// ── The queue ───────────────────────────────────────────

function FileLots({ lots, selection, onChoisir }: {
  lots: LotLabo[]
  selection: number | null
  onChoisir: (id: number) => void
}) {
  if (lots.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
        <CheckCircle2 className="h-14 w-14 text-success/60" />
        <p className="text-lg">Rien à contrôler pour le moment.</p>
      </div>
    )
  }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent space-y-4 pb-4 pr-1">
      {(['a_jeter', 'avant_lavage', 'apres_lavage'] as const).map((e) => {
        const ls = lots.filter((l) => l.etape === e)
        return (
          <Section key={e} etape={e} n={ls.length}>
            {ls.map((l) => <CarteLot key={l.idsuivilot} lot={l} actif={selection === l.idsuivilot} onClick={() => onChoisir(l.idsuivilot)} />)}
          </Section>
        )
      })}
    </div>
  )
}

function TitreSection({ etape, n, libelle, droite }: { etape: EtapeLabo; n: number; libelle?: string; droite?: ReactNode }) {
  const E = ETAPES[etape]
  return (
    <div className="flex items-center gap-2 px-1">
      <E.icone className={cn('h-4 w-4', etape === 'a_jeter' ? 'text-destructive' : 'text-primary/70')} />
      <h2 className={cn('text-sm font-bold uppercase tracking-wide', etape === 'a_jeter' ? 'text-destructive' : 'text-primary/80')}>{libelle ?? E.libelle}</h2>
      <span className="text-sm text-muted-foreground tabular-nums">{n}</span>
      {droite && <div className="ml-auto">{droite}</div>}
    </div>
  )
}

function Section({ etape, n, children }: { etape: EtapeLabo; n: number; children: ReactNode }) {
  if (n === 0) return null
  return (
    <section className="space-y-2">
      <TitreSection etape={etape} n={n} />
      {children}
    </section>
  )
}

function CarteLot({ lot, actif, onClick, droite }: { lot: LotLabo; actif: boolean; onClick: () => void; droite?: ReactNode }) {
  const rouge = lot.etape === 'a_jeter'
  const hors = Object.values(lot.hors).some((h) => h === true)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick()}
      className={cn(
        'flex items-center gap-3 rounded-xl border bg-white p-3 shadow-sm cursor-pointer select-none transition-colors',
        rouge && 'shadow-[inset_5px_0_0_0_rgb(239_68_68)]',
        actif ? (rouge ? 'border-red-500 ring-2 ring-red-500' : 'border-gold ring-2 ring-gold') : 'border-border/60 active:bg-zinc-50',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-bold tabular-nums">{lot.lot}</span>
          {hors && <AlertTriangle className="h-4 w-4 text-destructive self-center" aria-label="Mesure hors tolérance" />}
        </div>
        <p className="text-sm truncate">{article(lot) || '—'}</p>
        <p className="text-xs text-muted-foreground truncate">
          {rouge ? `Repris : ${lot.a_jeter?.motif || 'reprise'}` : [lot.sous_traitant, lot.reception && `reçu le ${jour(lot.reception)}`].filter(Boolean).join(' · ')}
        </p>
      </div>
      {droite}
    </div>
  )
}

// ── The open lot ────────────────────────────────────────

function DetailLot({ lot, onFermer, onFait }: {
  lot: LotLabo
  onFermer: () => void
  /** `garder` = keep the lot open (it moved to its next step). */
  onFait: (garder: boolean) => void
}) {
  const E = ETAPES[lot.etape]
  return (
    <div className="flex-1 min-h-0 flex flex-col rounded-2xl border border-border/60 bg-white shadow-sm overflow-hidden">
      <div className="flex-shrink-0 flex items-center gap-3 border-b border-border/60 bg-zinc-200/50 px-4 py-3">
        <button type="button" onClick={onFermer} className="h-11 w-11 rounded-xl flex items-center justify-center active:bg-zinc-300/60 min-[900px]:hidden" title="Retour à la liste">
          <ArrowLeft className="h-6 w-6" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-3xl font-heading font-bold tracking-tight tabular-nums">{lot.lot}</h2>
            <span className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold text-white',
              lot.etape === 'a_jeter' ? 'bg-destructive' : 'bg-primary',
            )}>
              <E.icone className="h-4 w-4" />{E.libelle}
            </span>
          </div>
          <p className="text-base truncate">{article(lot) || '—'}</p>
          <p className="text-sm text-muted-foreground truncate">
            {[lot.sous_traitant, lot.reception && `reçu le ${jour(lot.reception)}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <button type="button" onClick={onFermer} className="h-11 w-11 rounded-xl hidden min-[900px]:flex items-center justify-center text-muted-foreground active:bg-zinc-300/60" title="Fermer">
          <X className="h-6 w-6" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent p-4 space-y-4 bg-zinc-100/80">
        {lot.etape === 'a_jeter' ? (
          <BlocJeter lot={lot} onFait={() => onFait(false)} />
        ) : (
          <>
            <BlocAvantLavage lot={lot} onFait={() => onFait(true)} />
            <BlocApresLavage lot={lot} onFait={() => onFait(false)} />
          </>
        )}
      </div>
    </div>
  )
}

function Carte({ titre, icone: Icone, etat, children }: {
  titre: string
  icone: typeof Scissors
  /** 'actif' = the step to do now (gold edge); 'fait' = done (green tick). */
  etat: 'actif' | 'fait' | 'attente'
  children: ReactNode
}) {
  return (
    <section className={cn(
      'rounded-xl border bg-card p-4 shadow-sm space-y-4',
      etat === 'actif' ? 'border-l-4 border-l-gold border-border/60' : 'border-border/60',
      etat === 'attente' && 'opacity-70',
    )}>
      <div className="flex items-center gap-2">
        <Icone className="h-5 w-5 text-gold" />
        <h3 className="text-lg font-semibold">{titre}</h3>
        {etat === 'fait' && <CheckCircle2 className="h-5 w-5 text-success ml-auto" />}
      </div>
      {children}
    </section>
  )
}

function BoutonAction({ enCours, disabled, onClick, icone: Icone, children, ton = 'gold' }: {
  enCours: boolean
  disabled?: boolean
  onClick: () => void
  icone: typeof Scissors
  children: ReactNode
  ton?: 'gold' | 'rouge' | 'neutre'
}) {
  return (
    <button
      type="button"
      disabled={disabled || enCours}
      onClick={onClick}
      className={cn(
        'w-full h-16 rounded-xl text-xl font-semibold flex items-center justify-center gap-2 active:opacity-90 disabled:opacity-40',
        ton === 'gold' && 'bg-gold text-gold-foreground',
        ton === 'rouge' && 'bg-destructive text-white',
        ton === 'neutre' && 'border border-border bg-background',
      )}
    >
      {enCours ? <Loader2 className="h-6 w-6 animate-spin" /> : <Icone className="h-6 w-6" />}
      {children}
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

// Before the wash — on the round: laize, poids, coloris vs the rond 0.
function BlocAvantLavage({ lot, onFait }: { lot: LotLabo; onFait: () => void }) {
  const actif = lot.etape === 'avant_lavage'
  const [edition, setEdition] = useState(actif)
  const [laize, setLaize] = useState(fmt(lot.mesures.laize || null))
  const [poids, setPoids] = useState(fmt(lot.mesures.poids || null))
  const [coloris, setColoris] = useState<VerdictColoris | null>(lot.mesures.coloris)
  const [note, setNote] = useState('')
  const aides = aidesTolerance(lot.tolerances)
  const demande = (m: string) => lot.demandes.rond.includes(m)
  const mut = useMutation({
    mutationFn: () => enregistrerAvantLavage(lot.idsuivilot, { laize, poids, coloris, note: coloris === 'ecart' ? note : undefined }),
    onSuccess: () => {
      setEdition(false)
      onFait()
    },
  })
  const complet = (!demande('laize') || lireNombre(laize)) && (!demande('poids') || lireNombre(poids)) && (!demande('coloris') || coloris)
  const rien = lot.demandes.rond.length === 0

  return (
    <Carte titre="Contrôles avant lavage" icone={Scissors} etat={actif ? 'actif' : 'fait'}>
      {actif && (
        <p className="text-base text-muted-foreground">
          Découpez le rond et le carré de 50 × 50 cm (lot écrit dessus)
          {rien ? '. Rien à mesurer avant le lavage pour cette référence.' : ', pesez le rond et mesurez la laize.'}
        </p>
      )}
      {demande('coloris') && <InfoRond0 lot={lot} />}
      {!demande('coloris') && lot.rond0?.estCeLot && <InfoRond0 lot={lot} />}
      {(demande('laize') || demande('poids')) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {demande('laize') && (
            <ChampNombre label="Laize" unite="cm" valeur={laize} onChange={setLaize} disabled={!edition}
              aide={aides.laize} hors={horsBornes(lireNombre(laize), lot.tolerances.laize)} autoFocus={actif} />
          )}
          {demande('poids') && (
            <ChampNombre label="Poids" unite="g/m²" valeur={poids} onChange={setPoids} disabled={!edition}
              aide={aides.poids} hors={horsBornes(lireNombre(poids), lot.tolerances.poids)} />
          )}
        </div>
      )}
      {demande('coloris') && (
        <div className="space-y-2">
          <label className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Coloris comparé au rond 0</label>
          <div className="grid grid-cols-2 gap-3">
            {([['conforme', 'Conforme', CheckCircle2], ['ecart', 'Écart', AlertTriangle]] as const).map(([v, libelle, Icone]) => (
              <button
                key={v}
                type="button"
                disabled={!edition}
                onClick={() => setColoris(v)}
                className={cn(
                  'h-16 rounded-xl border-2 text-xl font-semibold flex items-center justify-center gap-2 disabled:opacity-60',
                  coloris === v
                    ? v === 'conforme' ? 'bg-success border-success text-white' : 'bg-destructive border-destructive text-white'
                    : 'bg-background border-border',
                )}
                aria-pressed={coloris === v}
              >
                <Icone className="h-6 w-6" />{libelle}
              </button>
            ))}
          </div>
          {edition && coloris === 'ecart' && (
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="L'écart en quelques mots (ajouté aux observations du lot)"
              className="w-full rounded-xl border-2 border-border bg-background px-3 py-2 text-lg focus:outline-none focus:ring-4 focus:ring-gold/40"
            />
          )}
        </div>
      )}
      <Erreur e={mut.error} />
      {edition ? (
        <BoutonAction enCours={mut.isPending} disabled={!complet} onClick={() => mut.mutate()} icone={Check}>
          {actif ? 'Contrôles avant lavage faits' : 'Enregistrer la correction'}
        </BoutonAction>
      ) : (
        !rien && (
          <button type="button" onClick={() => setEdition(true)} className="text-base text-accent-blue underline underline-offset-4">
            Corriger les contrôles avant lavage
          </button>
        )
      )}
    </Carte>
  )
}

function InfoRond0({ lot }: { lot: LotLabo }) {
  const r0 = lot.rond0
  if (r0?.estCeLot) {
    return (
      <div className="rounded-xl bg-gold/15 border border-gold/40 p-3 text-base">
        <strong>Premier lot de ce coloris :</strong> son rond devient le rond 0 du classeur.
      </div>
    )
  }
  if (!r0) {
    return (
      <div className="rounded-xl bg-zinc-100 border border-border p-3 text-base text-muted-foreground">
        Aucun rond 0 connu dans ETM pour ce coloris : comparez avec le classeur.
      </div>
    )
  }
  return (
    <div className="rounded-xl bg-primary/10 border border-primary/20 p-3 text-base">
      Sortez le <strong>rond 0</strong> du classeur : lot <strong className="tabular-nums">{r0.lot}</strong>
      {r0.date && <> du {jour(r0.date)}</>}. Rangez le nouveau rond à côté.
    </div>
  )
}

const CLE_CASIER = 'tirelle.dernier-casier'

function dernierCasier(): string {
  try {
    return localStorage.getItem(CLE_CASIER) ?? ''
  } catch {
    return ''
  }
}

// After the wash — on the square: stab H, stab L, vrillage, then the casier
// where square and tirelle are stored. One button: the lab is done with the lot.
function BlocApresLavage({ lot, onFait }: { lot: LotLabo; onFait: () => void }) {
  const actif = lot.etape === 'apres_lavage'
  const signeDe = (v: number) => (v > 0 ? '+' : '-') as '-' | '+'
  const [stabh, setStabh] = useState(fmt(lot.mesures.stabh ? Math.abs(lot.mesures.stabh) : null))
  const [stabl, setStabl] = useState(fmt(lot.mesures.stabl ? Math.abs(lot.mesures.stabl) : null))
  const [sh, setSh] = useState<'-' | '+'>(signeDe(lot.mesures.stabh))
  const [sl, setSl] = useState<'-' | '+'>(signeDe(lot.mesures.stabl))
  const [vrillage, setVrillage] = useState(fmt(lot.mesures.vrillage))
  const [casier, setCasier] = useState(() => dernierCasier())
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
    }),
    onSuccess: () => {
      try {
        localStorage.setItem(CLE_CASIER, casier.trim())
      } catch {
        /* storage disabled: the field just starts empty next time */
      }
      onFait()
    },
  })
  const complet = (!demande('stabilités') || (vh != null && vl != null)) && (!demande('vrillage') || lireNombre(vrillage) != null) && !!casier.trim()

  if (!actif) {
    return (
      <Carte titre="Contrôles après lavage" icone={Droplets} etat="attente">
        <p className="text-base text-muted-foreground">Après le lavage et le séchage du carré.</p>
      </Carte>
    )
  }

  return (
    <Carte titre="Contrôles après lavage" icone={Droplets} etat="actif">
      <p className="text-base text-muted-foreground">
        {demande('stabilités') || demande('vrillage') ? 'Sur le carré lavé et séché, puis ' : 'Rien à mesurer après le lavage pour cette référence : '}
        rangez le carré avec la tirelle et indiquez le casier.
      </p>
      {demande('stabilités') && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ChampNombre label="Stab H" unite="%" valeur={stabh} onChange={setStabh} signe={sh} onSigne={setSh}
            aide={aides.stabh} hors={horsRetrait(vh, lot.tolerances.stabh)} />
          <ChampNombre label="Stab L" unite="%" valeur={stabl} onChange={setStabl} signe={sl} onSigne={setSl}
            aide={aides.stabl} hors={horsRetrait(vl, lot.tolerances.stabl)} />
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {demande('vrillage') && (
          <ChampNombre label="Vrillage" unite="%" valeur={vrillage} onChange={setVrillage}
            aide={aides.vrillage}
            hors={lireNombre(vrillage) == null ? null : lireNombre(vrillage)! > lot.tolerances.vrillageMax} />
        )}
        <div className="space-y-1.5 min-w-0">
          <label className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Casier</label>
          <input
            type="text"
            value={casier}
            onChange={(e) => setCasier(e.target.value)}
            maxLength={40}
            className="w-full h-16 rounded-xl border-2 border-border bg-background px-4 text-3xl font-bold focus:outline-none focus:ring-4 focus:ring-gold/40"
          />
        </div>
      </div>
      <Erreur e={mut.error} />
      <BoutonAction enCours={mut.isPending} disabled={!complet} onClick={() => mut.mutate()} icone={CheckCircle2}>
        Contrôles terminés
      </BoutonAction>
    </Carte>
  )
}

// After a reprise: the lot's round, square and tirelle go to the bin.
function BlocJeter({ lot, onFait }: { lot: LotLabo; onFait: () => void }) {
  const mut = useMutation({ mutationFn: () => marquerJete(lot.idsuivilot), onSuccess: onFait })
  const j = lot.a_jeter
  return (
    <section className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-5 space-y-4">
      <div className="flex items-center gap-2 text-destructive">
        <Trash2 className="h-6 w-6" />
        <h3 className="text-xl font-bold">Lot repris par l’ennoblisseur</h3>
      </div>
      {j?.motif && <p className="text-base"><span className="text-muted-foreground">Motif :</span> {j.motif}</p>}
      <p className="text-lg">Récupérez et jetez :</p>
      <ul className="text-lg space-y-2 pl-1">
        <li className="flex items-start gap-2"><span className="font-bold text-destructive">1.</span><span>le rond, dans le classeur ;</span></li>
        <li className="flex items-start gap-2"><span className="font-bold text-destructive">2.</span><span>le carré et la tirelle{j?.casier ? <>, casier <strong>{j.casier}</strong></> : ''}.</span></li>
      </ul>
      <p className="text-base text-muted-foreground">Le lot repris reviendra sur la tablette avec une nouvelle tirelle : tout sera refait.</p>
      <Erreur e={mut.error} />
      <BoutonAction enCours={mut.isPending} onClick={() => mut.mutate()} icone={Trash2} ton="rouge">
        Rond, carré et tirelle jetés
      </BoutonAction>
    </section>
  )
}
