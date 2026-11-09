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
  AlertTriangle, Archive, ArrowLeft, Check, CheckCircle2, CircleDashed, ClipboardList, Droplets, Loader2,
  Building2, MessageSquare, Palette, Pencil, RefreshCw, Ruler, Scissors, Trash2, X,
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
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent space-y-4 pb-4 px-1">
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

/** Who the lot is for: a teal pill, the one colour of the tablet that means
 *  nothing else (navy = brand, gold = selection, red / amber = to do, green =
 *  in tolerance), so the client stands out without reading as a status. */
function PillClient({ nom, titre, grande }: { nom: string; titre?: string; grande?: boolean }) {
  return (
    <span
      title={titre ?? nom}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 rounded-full border border-teal/30 bg-teal-light font-semibold text-teal-dark',
        grande ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs',
      )}
    >
      <Building2 className={cn('flex-shrink-0', grande ? 'h-4 w-4' : 'h-3 w-3')} />
      <span className="truncate">{nom}</span>
    </span>
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
          {lot.clients.length > 0 && (
            <span className="ml-auto min-w-0 flex self-center">
              <PillClient
                nom={lot.clients.length > 1 ? 'Plusieurs clients' : lot.clients[0]}
                titre={lot.clients.join(', ')}
              />
            </span>
          )}
        </div>
        <p className="text-sm truncate">{article(lot) || '—'}</p>
        {/* Dyer and reception date are on the open lot's title, not on the card. */}
        {rouge && <p className="text-xs text-muted-foreground truncate">Repris : {lot.a_jeter?.motif || 'reprise'}</p>}
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
  // After the wash: reopen the round's measures in place of the square's.
  const [corriger, setCorriger] = useState(false)
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2">
      {/* The selected lot, straight on the grey: it is the detail of the card
          picked on the left, not a window — no band, no close button (another
          card is picked instead). The back arrow exists only in one column. */}
      <div className="flex-shrink-0 flex items-center gap-3 px-1">
        <button type="button" onClick={onFermer} className="h-11 w-11 -ml-1 rounded-xl flex items-center justify-center active:bg-zinc-200/60 min-[900px]:hidden" title="Retour à la liste">
          <ArrowLeft className="h-6 w-6" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-3">
            <h2 className="flex-shrink-0 text-3xl leading-9 font-heading font-bold tracking-tight tabular-nums">{lot.lot}</h2>
            <p className="min-w-0 truncate text-base">{article(lot) || '—'}</p>
            {lot.clients.length > 0 && (
              <div className="min-w-0 flex flex-shrink items-center gap-1.5 self-center overflow-hidden">
                {lot.clients.map((c) => <PillClient key={c} nom={c} grande />)}
              </div>
            )}
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {[lot.sous_traitant, lot.reception && `reçu le ${jour(lot.reception)}`].filter(Boolean).join(' · ') || '—'}
          </p>
        </div>
        <span className={cn(
          'flex-shrink-0 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold text-white',
          lot.etape === 'a_jeter' ? 'bg-destructive' : 'bg-primary',
        )}>
          <E.icone className="h-4 w-4" />{E.libelle}
        </span>
      </div>
      {/* Only the step to do now, filling the pane; its button sits at the
          bottom, at the same place for every lot. */}
      <div className="flex-1 min-h-0 flex flex-col gap-2">
        {lot.etape === 'a_jeter' ? (
          <BlocJeter lot={lot} onFait={() => onFait(false)} />
        ) : lot.etape === 'avant_lavage' ? (
          <BlocAvantLavage lot={lot} onFait={() => onFait(true)} />
        ) : corriger ? (
          <BlocAvantLavage
            lot={lot}
            correction
            onAnnuler={() => setCorriger(false)}
            onFait={() => {
              setCorriger(false)
              onFait(true)
            }}
          />
        ) : (
          <>
            <RecapAvantLavage lot={lot} onCorriger={() => setCorriger(true)} />
            <BlocApresLavage lot={lot} onFait={() => onFait(false)} />
          </>
        )}
      </div>
    </div>
  )
}

/** The step: its cards on the grey background, `pied` stays at the bottom.
 *  Sized to fit a Galaxy Tab A9 in landscape (1005 × 600) without scrolling;
 *  the scroll is only a fallback for a smaller screen. */
function Etape({ pied, children }: { pied: ReactNode; children: ReactNode }) {
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2">
      {/* p-1 -m-1: room for the inputs' focus ring inside the scroll clip. */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent space-y-2 p-1 -m-1">{children}</div>
      <div className="flex-shrink-0 space-y-2">{pied}</div>
    </div>
  )
}

/** What to do now: the instruction itself, no title row (it is the step's first card). */
function Consigne({ icone: Icone = ClipboardList, children }: { icone?: typeof Scissors; children: ReactNode }) {
  return (
    <section className="flex items-start gap-3 rounded-xl border border-border/60 bg-card px-4 py-2.5 shadow-sm">
      <div className="icon-box-gold h-7 w-7 rounded-lg flex items-center justify-center flex-shrink-0">
        <Icone className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-2 text-base">{children}</div>
    </section>
  )
}

/** One group of the step (what to do, the measures, the coloris…): a white card. */
function Bloc({ titre, icone: Icone, children }: { titre: string; icone: typeof Scissors; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border/60 bg-card px-4 py-2.5 shadow-sm space-y-2">
      <div className="flex items-center gap-2.5">
        <div className="icon-box-gold h-7 w-7 rounded-lg flex items-center justify-center flex-shrink-0">
          <Icone className="h-4 w-4" />
        </div>
        <h3 className="text-base font-semibold text-primary">{titre}</h3>
      </div>
      {children}
    </section>
  )
}

/** The lot's observations, in both steps: the very field of Qualité › Suivi
 *  lots in ETM, shown as it stands and saved whole with the step. */
function ChampObservations({ valeur, onChange, ecart }: { valeur: string; onChange: (v: string) => void; ecart?: boolean }) {
  return (
    <Bloc titre="Observations" icone={MessageSquare}>
      <textarea
        value={valeur}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder={ecart ? "Décrivez l'écart de coloris…" : 'Une remarque sur le lot (facultatif)'}
        className="w-full rounded-xl border-2 border-border bg-background px-3 py-2 text-lg focus:outline-none focus:ring-4 focus:ring-gold/40 resize-none"
      />
    </Bloc>
  )
}

// Once the round is done: one line recalling what was measured, with the way
// back to correct it.
function RecapAvantLavage({ lot, onCorriger }: { lot: LotLabo; onCorriger: () => void }) {
  const m = lot.mesures
  const demande = (k: string) => lot.demandes.rond.includes(k)
  const parts: Array<{ k: 'laize' | 'poids' | 'coloris'; texte: string }> = []
  if (demande('laize')) parts.push({ k: 'laize', texte: `laize ${fmt(m.laize || null) || '—'} cm` })
  if (demande('poids')) parts.push({ k: 'poids', texte: `poids ${fmt(m.poids || null) || '—'} g/m²` })
  if (demande('coloris') && m.coloris) parts.push({ k: 'coloris', texte: m.coloris === 'ecart' ? 'écart de coloris' : 'coloris conforme' })
  return (
    <div className="flex-shrink-0 flex items-center gap-3 rounded-xl border border-border/60 bg-white px-4 py-1 shadow-sm">
      <CheckCircle2 className="h-5 w-5 text-success flex-shrink-0" />
      <p className="min-w-0 flex-1 text-base truncate">
        <span className="font-semibold">Avant lavage</span>
        <span className="text-muted-foreground">
          {parts.length === 0 ? ' · rien à mesurer' : parts.map((p) => (
            <span key={p.k}> · <span className={cn(lot.hors[p.k] === true && 'text-destructive font-medium')}>{p.texte}</span></span>
          ))}
        </span>
      </p>
      {parts.length > 0 && (
        <button type="button" onClick={onCorriger} className="h-11 px-3 rounded-xl flex items-center gap-2 text-base font-semibold text-accent-blue active:bg-zinc-100 flex-shrink-0">
          <Pencil className="h-4 w-4" />Corriger
        </button>
      )}
    </div>
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
        'w-full h-14 rounded-xl text-xl font-semibold flex items-center justify-center gap-2 active:opacity-90 disabled:opacity-40',
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
function BlocAvantLavage({ lot, correction = false, onAnnuler, onFait }: {
  lot: LotLabo
  /** Reopened from the « après lavage » step to correct a measure. */
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
  const complet = (!demande('laize') || lireNombre(laize)) && (!demande('poids') || lireNombre(poids)) && (!demande('coloris') || coloris)
  const rien = lot.demandes.rond.length === 0
  const bouton = (
    <BoutonAction enCours={mut.isPending} disabled={!complet} onClick={() => mut.mutate()} icone={Check}>
      {correction ? 'Enregistrer la correction' : 'Contrôles avant lavage faits'}
    </BoutonAction>
  )

  return (
    <Etape
      pied={(
        <>
          <Erreur e={mut.error} />
          {correction ? (
            <div className="grid grid-cols-[1fr_2fr] gap-3">
              <BoutonAction enCours={false} disabled={mut.isPending} onClick={() => onAnnuler?.()} icone={X} ton="neutre">Annuler</BoutonAction>
              {bouton}
            </div>
          ) : bouton}
        </>
      )}
    >
      <Consigne icone={correction ? Pencil : ClipboardList}>
        <p className="text-muted-foreground">
          {correction
            ? 'Correction des mesures du rond : le lot reste en contrôles après lavage.'
            : <>Découpez le rond et le carré de 50 × 50 cm (lot écrit dessus){rien ? '. Rien à mesurer avant le lavage pour cette référence.' : ', pesez le rond et mesurez la laize.'}</>}
        </p>
        {!demande('coloris') && lot.rond0?.estCeLot && <InfoRond0 lot={lot} />}
      </Consigne>
      {(demande('laize') || demande('poids')) && (
        <Bloc titre="Mesures du rond" icone={Ruler}>
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
        </Bloc>
      )}
      {demande('coloris') && (
        <Bloc titre="Coloris comparé au rond 0" icone={Palette}>
          <InfoRond0 lot={lot} />
          <div className="grid grid-cols-2 gap-3">
            {([['conforme', 'Conforme', CheckCircle2], ['ecart', 'Écart', AlertTriangle]] as const).map(([v, libelle, Icone]) => (
              <button
                key={v}
                type="button"
                onClick={() => setColoris(v)}
                className={cn(
                  'h-14 rounded-xl border-2 text-xl font-semibold flex items-center justify-center gap-2 disabled:opacity-60',
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
        </Bloc>
      )}
      <ChampObservations valeur={observations} onChange={setObservations} ecart={coloris === 'ecart'} />
    </Etape>
  )
}

// One line (text-sm): the step must fit the tablet in landscape.
function InfoRond0({ lot }: { lot: LotLabo }) {
  const r0 = lot.rond0
  if (r0?.estCeLot) {
    return (
      <div className="rounded-lg bg-gold/15 border border-gold/40 px-3 py-1.5 text-sm">
        <strong>Premier lot de ce coloris :</strong> son rond devient le rond 0 du classeur.
      </div>
    )
  }
  if (!r0) {
    return (
      <div className="rounded-lg bg-zinc-100 border border-border px-3 py-1.5 text-sm text-muted-foreground">
        Aucun rond 0 connu dans ETM pour ce coloris : comparez avec le classeur.
      </div>
    )
  }
  return (
    <div className="rounded-lg bg-primary/10 border border-primary/20 px-3 py-1.5 text-sm">
      Sortez le <strong>rond 0</strong> : lot <strong className="tabular-nums">{r0.lot}</strong>
      {r0.date && <> du {jour(r0.date)}</>}, rangez le nouveau à côté.
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
  const signeDe = (v: number | null) => (v != null && v > 0 ? '+' : '-') as '-' | '+'
  // null = not measured; 0 is a measure, an ultra-stable matter (#1358).
  const [stabh, setStabh] = useState(fmt(lot.mesures.stabh == null ? null : Math.abs(lot.mesures.stabh)))
  const [stabl, setStabl] = useState(fmt(lot.mesures.stabl == null ? null : Math.abs(lot.mesures.stabl)))
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
        /* storage disabled: the field just starts empty next time */
      }
      onFait()
    },
  })
  // « les stabs », « le vrillage », « les stabs et le vrillage », or nothing.
  const aMesurer = [demande('stabilités') && 'les stabs', demande('vrillage') && 'le vrillage'].filter(Boolean).join(' et ')
  const complet = (!demande('stabilités') || (vh != null && vl != null)) && (!demande('vrillage') || lireNombre(vrillage) != null) && !!casier.trim()

  return (
    <Etape
      pied={(
        <>
          <Erreur e={mut.error} />
          <BoutonAction enCours={mut.isPending} disabled={!complet} onClick={() => mut.mutate()} icone={CheckCircle2}>
            Contrôles terminés
          </BoutonAction>
        </>
      )}
    >
      <Consigne>
        <p className="text-muted-foreground">
          {aMesurer
            ? `Mesurez ${aMesurer} sur le carré lavé et séché, puis rangez le carré avec la tirelle et indiquez le casier.`
            : 'Rien à mesurer après le lavage pour cette référence : rangez le carré avec la tirelle et indiquez le casier.'}
        </p>
      </Consigne>
      {/* One card: the square's measures, then the casier where square and
          tirelle are stored (not a measure, but typed in the same gesture). */}
      <Bloc titre={aMesurer ? 'Mesures du carré et rangement' : 'Rangement'} icone={aMesurer ? Ruler : Archive}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            <div className="space-y-1 min-w-0">
              <label className="block text-sm font-semibold text-muted-foreground uppercase tracking-wide">Casier</label>
              <input
                type="text"
                value={casier}
                onChange={(e) => setCasier(e.target.value)}
                maxLength={40}
                className="w-full min-w-0 h-14 rounded-xl border-2 border-border bg-background px-4 text-3xl font-bold focus:outline-none focus:ring-4 focus:ring-gold/40"
              />
            </div>
          </div>
      </Bloc>
      <ChampObservations valeur={observations} onChange={setObservations} />
    </Etape>
  )
}

// After a reprise: the lot's round, square and tirelle go to the bin.
function BlocJeter({ lot, onFait }: { lot: LotLabo; onFait: () => void }) {
  const mut = useMutation({ mutationFn: () => marquerJete(lot.idsuivilot), onSuccess: onFait })
  const j = lot.a_jeter
  return (
    <section className="flex-1 min-h-0 flex flex-col rounded-xl border-2 border-destructive/40 bg-destructive/5 overflow-hidden">
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent p-5 space-y-4">
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
      </div>
      <div className="flex-shrink-0 border-t border-destructive/30 bg-destructive/10 p-4 space-y-3">
        <Erreur e={mut.error} />
        <BoutonAction enCours={mut.isPending} onClick={() => mut.mutate()} icone={Trash2} ton="rouge">
          Rond, carré et tirelle jetés
        </BoutonAction>
      </div>
    </section>
  )
}
