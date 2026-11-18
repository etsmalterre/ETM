// The shelf of stored tirelles (LIVA #1380, Isabelle for Laetitia; decisions
// Vincent 2026-11-18). Opened from the queue's band (« Rechercher »).
//   • Find a tirelle by reference, coloris or lot number when samples are
//     needed and the lot's data is not at hand: each result says its box.
//     Only tirelles IN A BOX are found (Vincent 2026-11-18): a lot without
//     one is not shown, « si ce n'est pas là, ce n'est pas là ».
//   • The 48 boxes (A1 to F8) with their count; touching one lists its
//     content, and « Vider la boîte » throws it away when the shelf is full:
//     its lots lose their location, nothing to type.
// What was stored before the boxes (« Carton », « 0 ») has no box: we start
// from zero, those lots are simply not found.
// Same grammar as the lab (pages/Labo.tsx): one navy band, the grey panel,
// white cards, big targets; fits a Galaxy Tab A9 in landscape (1005 × 600).
import { useEffect, useState, type ReactNode } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Archive, ArrowLeft, Loader2, Search, Trash2, X } from 'lucide-react'
import {
  chercherTirelles, fetchBoites, fetchContenuBoite, viderBoite,
  type EtatBoite, type TirelleTrouvee,
} from '@/lib/tirelle-api'
import type { ApiError } from '@/lib/api'
import { messagePourErreur } from '@/lib/erreurs'
import { Actualiser, Message, PillClient, jour } from '@/components/Commun'
import { FiniRollIcon } from '@/components/FiniRollIcon'
import { GrilleBoites, tirelles } from '@/components/GrilleBoites'
import { ageArchive } from '@/lib/boites'
import { cn } from '@/lib/utils'

const RANGEMENT_KEY = ['tirelle', 'rangement'] as const
/** Shortest search the API runs (lib/tirelle-boites.ts RECHERCHE_MIN). */
const RECHERCHE_MIN = 2

export function Rangement({ onFermer }: { onFermer: () => void }) {
  const qc = useQueryClient()
  const [saisie, setSaisie] = useState('')
  const [q, setQ] = useState('')
  const [boite, setBoite] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // The search follows the typing, a beat behind.
  useEffect(() => {
    const t = setTimeout(() => setQ(saisie.trim()), 250)
    return () => clearTimeout(t)
  }, [saisie])
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 5000)
    return () => clearTimeout(t)
  }, [message])

  const cherche = !boite && q.length >= RECHERCHE_MIN
  const boites = useQuery({ queryKey: [...RANGEMENT_KEY, 'boites'], queryFn: fetchBoites })
  const resultats = useQuery({
    queryKey: [...RANGEMENT_KEY, 'recherche', q],
    queryFn: () => chercherTirelles(q),
    enabled: cherche,
    placeholderData: keepPreviousData,
  })
  const contenu = useQuery({
    queryKey: [...RANGEMENT_KEY, 'boite', boite],
    queryFn: () => fetchContenuBoite(boite!),
    enabled: !!boite,
  })

  const rafraichir = () => qc.invalidateQueries({ queryKey: RANGEMENT_KEY })
  const vider = useMutation({
    mutationFn: (b: string) => viderBoite(b),
    onSuccess: (r) => {
      setBoite(null)
      setMessage(`Boîte ${r.boite} vidée : ${tirelles(r.lots.length)} sorties du rangement`)
      rafraichir()
    },
  })

  const ecrire = (v: string) => {
    setSaisie(v)
    if (v) setBoite(null)
  }
  const choisirBoite = (b: string) => {
    vider.reset()
    setMessage(null)
    setSaisie('')
    setQ('')
    setBoite((prev) => (prev === b ? null : b))
  }

  // Where the search's hits are, to light their boxes on the shelf.
  const touchees = new Map<string, number>()
  if (cherche) for (const l of resultats.data?.lots ?? []) touchees.set(l.boite, (touchees.get(l.boite) ?? 0) + 1)

  const etat = boites.data?.boites.find((b) => b.boite === boite) ?? null

  return (
    <div className="h-full flex flex-col bg-zinc-100">
      <div className="safe-top bg-primary" />
      <header className="flex-shrink-0 flex items-center gap-3 border-b-2 border-gold bg-primary px-3 h-14">
        <button type="button" onClick={onFermer} className="h-11 pl-2 pr-3 rounded-xl flex items-center gap-1.5 text-white font-semibold ring-1 ring-white/25 active:bg-white/15 flex-shrink-0" title="Retour aux lots">
          <ArrowLeft className="h-6 w-6" />Lots
        </button>
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            value={saisie}
            onChange={(e) => ecrire(e.target.value)}
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            placeholder="Référence, coloris ou numéro de lot"
            className="w-full h-11 rounded-xl bg-white pl-11 pr-12 text-lg font-semibold placeholder:font-normal placeholder:text-muted-foreground focus:outline-none focus:ring-4 focus:ring-gold/50 [&::-webkit-search-cancel-button]:hidden"
          />
          {saisie && (
            <button type="button" onClick={() => ecrire('')} className="absolute right-0 top-0 h-11 w-11 flex items-center justify-center text-muted-foreground active:text-foreground" title="Effacer">
              <X className="h-5 w-5" />
            </button>
          )}
        </div>
        <Actualiser chargement={boites.isFetching || resultats.isFetching || contenu.isFetching} onClick={rafraichir} />
      </header>

      <div className="relative flex-1 min-h-0 flex flex-col md:flex-row gap-3 p-3 overflow-y-auto md:overflow-hidden scrollbar-transparent">
        <section className="md:flex-1 min-w-0 min-h-0 flex flex-col rounded-xl bg-zinc-200/60 p-2">
          {boite ? (
            <ContenuBoite
              boite={boite}
              etat={etat}
              lots={contenu.data?.lots ?? null}
              erreur={contenu.error}
              vidage={vider.isPending}
              erreurVidage={vider.error}
              onVider={() => vider.mutate(boite)}
              onFermer={() => { vider.reset(); setBoite(null) }}
            />
          ) : cherche ? (
            <Resultats lots={resultats.data?.lots ?? null} total={resultats.data?.total ?? 0} erreur={resultats.error} />
          ) : (
            <Accueil />
          )}
        </section>
        <Etagere
          boites={boites.data?.boites ?? null}
          depuis={boites.data?.depuis ?? null}
          choisie={boite}
          touchees={touchees}
          onChoisir={choisirBoite}
        />
        {message && <Message texte={message} onFermer={() => setMessage(null)} />}
      </div>
    </div>
  )
}

// ── Left pane ───────────────────────────────────────────

function Accueil() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 rounded-xl bg-white/60 border border-border/60 px-6 py-10 text-center text-muted-foreground">
      <div className="h-16 w-16 rounded-full flex items-center justify-center bg-primary/10">
        <Search className="h-8 w-8 text-primary" />
      </div>
      <p className="text-xl font-semibold text-foreground">Retrouver une tirelle rangée</p>
      <p className="text-base -mt-1">Tapez une référence, un coloris ou un numéro de lot.<br />Ou touchez une boîte pour voir ce qu’elle contient.</p>
    </div>
  )
}

function Bandeau({ children, rouge }: { children: ReactNode; rouge?: boolean }) {
  return (
    <div className={cn(
      'flex-shrink-0 flex items-center gap-2 rounded-lg px-3 min-h-[44px] py-1.5',
      rouge ? 'bg-destructive text-white' : 'bg-primary text-primary-foreground',
    )}>
      {children}
    </div>
  )
}

function Chargement() {
  return (
    <div className="flex-1 flex items-center justify-center py-10">
      <Loader2 className="h-8 w-8 animate-spin text-gold" />
    </div>
  )
}

function Erreur({ e }: { e: unknown }) {
  return (
    <p className="flex items-start gap-2 px-2 py-6 text-base text-destructive font-medium" role="alert">
      <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
      {messagePourErreur(e as ApiError)}
    </p>
  )
}

function Liste({ lots, avecBoite }: { lots: TirelleTrouvee[]; avecBoite: boolean }) {
  return (
    <div className="flex-1 min-h-0 md:overflow-y-auto scrollbar-transparent space-y-2 pt-2 px-0.5 pb-0.5">
      {lots.map((l) => <CarteTirelle key={l.idsuivilot} lot={l} avecBoite={avecBoite} />)}
    </div>
  )
}

function Resultats({ lots, total, erreur }: { lots: TirelleTrouvee[] | null; total: number; erreur: unknown }) {
  if (erreur && !lots) return <Erreur e={erreur} />
  if (!lots) return <Chargement />
  return (
    <>
      <Bandeau>
        <Search className="h-4 w-4" />
        <h2 className="text-sm font-bold uppercase tracking-wide">
          {total === 0 ? 'Aucune tirelle en boîte' : `${total} tirelle${total > 1 ? 's' : ''} en boîte`}
        </h2>
      </Bandeau>
      {total === 0 ? (
        <p className="py-8 px-4 text-center text-base text-muted-foreground italic">Aucune tirelle rangée dans une boîte ne correspond à cette recherche.</p>
      ) : (
        <>
          <Liste lots={lots} avecBoite />
          {total > lots.length && (
            <p className="flex-shrink-0 pt-2 text-center text-sm text-muted-foreground">
              Les {lots.length} premières sur {total} : précisez la recherche pour voir les autres.
            </p>
          )}
        </>
      )}
    </>
  )
}

function ContenuBoite({ boite, etat, lots, erreur, vidage, erreurVidage, onVider, onFermer }: {
  boite: string
  etat: EtatBoite | null
  lots: TirelleTrouvee[] | null
  erreur: unknown
  vidage: boolean
  erreurVidage: unknown
  onVider: () => void
  onFermer: () => void
}) {
  const [confirmer, setConfirmer] = useState(false)
  useEffect(() => setConfirmer(false), [boite])
  const n = lots?.length ?? etat?.n ?? 0
  return (
    <>
      <Bandeau rouge={confirmer}>
        <Archive className="h-4 w-4" />
        <h2 className="text-sm font-bold uppercase tracking-wide">
          {confirmer ? `Vider la boîte ${boite} ?` : `Boîte ${boite}`}
        </h2>
        {!confirmer && <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-sm font-bold tabular-nums">{tirelles(n)}</span>}
        {!confirmer && etat?.du && etat.au && (
          <span className="min-w-0 text-sm text-white/70 truncate">
            {etat.du === etat.au ? `lots reçus le ${jour(etat.au)}` : `lots reçus du ${jour(etat.du)} au ${jour(etat.au)}`}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          {confirmer ? (
            <>
              <button type="button" disabled={vidage} onClick={() => setConfirmer(false)} className="h-9 px-3 rounded-lg text-sm font-semibold ring-1 ring-white/40 active:bg-white/15">
                Annuler
              </button>
              <button type="button" disabled={vidage} onClick={onVider} className="h-9 px-3 rounded-lg bg-white text-destructive text-sm font-bold flex items-center gap-1.5 active:opacity-90">
                {vidage ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Jeter {n > 1 ? `les ${n} tirelles` : 'la tirelle'}
              </button>
            </>
          ) : (
            <>
              {n > 0 && (
                <button type="button" onClick={() => setConfirmer(true)} className="h-9 px-3 rounded-lg text-sm font-semibold flex items-center gap-1.5 ring-1 ring-white/40 active:bg-white/15">
                  <Trash2 className="h-4 w-4" />Vider la boîte
                </button>
              )}
              <button type="button" onClick={onFermer} className="h-9 w-9 rounded-lg flex items-center justify-center active:bg-white/15" title="Fermer la boîte">
                <X className="h-5 w-5" />
              </button>
            </>
          )}
        </div>
      </Bandeau>
      {confirmer && (
        <p className="flex-shrink-0 mt-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-base">
          Les carrés et tirelles de la boîte {boite} partent à la poubelle : ces lots n’auront plus de rangement.
        </p>
      )}
      {erreurVidage ? <Erreur e={erreurVidage} /> : null}
      {erreur && !lots ? <Erreur e={erreur} /> : !lots ? <Chargement /> : lots.length === 0 ? (
        <p className="py-8 text-center text-base text-muted-foreground italic">Cette boîte est vide.</p>
      ) : (
        <Liste lots={lots} avecBoite={false} />
      )}
    </>
  )
}

function CarteTirelle({ lot, avecBoite }: { lot: TirelleTrouvee; avecBoite: boolean }) {
  const article = [lot.reference, lot.coloris].filter(Boolean).join(' - ')
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-white pl-2.5 pr-3 py-2.5 shadow-sm">
      {avecBoite && (
        <span className="h-14 w-14 flex-shrink-0 rounded-xl flex items-center justify-center bg-primary text-primary-foreground text-2xl font-bold tabular-nums shadow-sm" title={`Boîte ${lot.boite}`}>
          {lot.boite}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xl font-bold tabular-nums">{lot.lot || '—'}</span>
          {lot.a_jeter && (
            <span className="inline-flex items-center gap-1 rounded-full bg-destructive px-2 py-0.5 text-xs font-bold text-white">
              <Trash2 className="h-3 w-3" />À jeter (reprise)
            </span>
          )}
          {lot.clients.length > 0 && (
            <span className="ml-auto min-w-0 flex">
              <PillClient nom={lot.clients.length > 1 ? 'Plusieurs clients' : lot.clients[0]} titre={lot.clients.join(', ')} />
            </span>
          )}
        </div>
        <p className="flex items-center gap-1.5 text-sm mt-0.5 min-w-0">
          <FiniRollIcon className="h-4 w-4 flex-shrink-0 text-primary/70" />
          <span className="truncate">{article || '—'}</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground truncate">
          {[
            lot.reception ? `reçu le ${jour(lot.reception)}` : 'pas encore reçu',
            lot.sous_traitant,
          ].filter(Boolean).join(' · ')}
        </p>
      </div>
    </div>
  )
}

// ── The shelf ───────────────────────────────────────────

function Etagere({ boites, depuis, choisie, touchees, onChoisir }: {
  boites: EtatBoite[] | null
  /** Reception of the oldest lot still in a box (ISO). */
  depuis: string | null
  choisie: string | null
  /** Boxes holding hits of the current search, with their count. */
  touchees: Map<string, number>
  onChoisir: (boite: string) => void
}) {
  const total = (boites ?? []).reduce((s, b) => s + b.n, 0)
  return (
    <section className="flex-shrink-0 md:w-[412px] flex flex-col rounded-xl bg-zinc-200/60 p-2">
      <div className="flex-shrink-0 flex items-center gap-2 rounded-lg bg-primary px-3 min-h-[44px] text-primary-foreground">
        <Archive className="h-4 w-4" />
        <h2 className="text-sm font-bold uppercase tracking-wide">Boîtes</h2>
        <span className="ml-auto rounded-full bg-white/20 px-2.5 py-0.5 text-sm font-bold tabular-nums">{tirelles(total)}</span>
      </div>
      {!boites ? <Chargement /> : (
        <>
          <div className="pt-2">
            <GrilleBoites boites={boites} choisie={choisie} touchees={touchees} onChoisir={onChoisir} />
          </div>
          <p className="pt-2 px-1 text-sm text-muted-foreground">
            {/* The one figure worth reading here: how far back the archives go (Vincent 2026-11-18). */}
            {depuis
              ? <><strong className="text-foreground">{ageArchive(depuis)} d’archives</strong> : la plus ancienne tirelle a été reçue le {jour(depuis)}.</>
              : 'Aucune tirelle en boîte pour le moment : elles s’y rangent à la fin des contrôles.'}
          </p>
        </>
      )}
    </section>
  )
}
