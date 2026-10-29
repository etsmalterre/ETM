// Clients › Commandes › line drawer › « Ennoblissement », top zone (decisions Vincent 2026-10-28/29):
// the AVAILABLE tombé de métier reserved to a FINI line (pieces on no dyer order yet), against what the
// line still needs in écru once its fini rolls, its pieces on dyer orders and its écru still being knitted
// are counted. Those are carried by their orders and shown there (bottom zone here, the Tricotage tab):
// never counted again up here (top = what still waits, bottom = the orders). One block: a click opens
// the selector, where the line's pieces are ticked (untick = release) and free pieces can be ticked;
// available écru only, nothing on an order (Vincent 2026-10-29). Reserving never orders: the dyer order is launched from the
// bottom zone, « Ennoblir chez X », only where pieces reserved to the line sit (lieuxAEnnoblir).
// API GET/PUT …/lignes/:id/matiere/ecru, DELETE …/matiere/ecru/:stockId.
import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, CheckCircle2, Loader2, Pencil, X } from 'lucide-react'
import { TmRollIcon } from '@/components/icons/TmRollIcon'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { RollDefautsIcon, RollObservationsIcon } from '@/components/stock/RollNoteIcons'
import { ZoneLigne, ZoneVide } from '@/components/commandes/ZonesLigne'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate } from '@/lib/dates'
import { invalidateCommandeClientCaches, invalidateStockCaches } from '@/lib/cache-sync'
import { cn } from '@/lib/utils'

interface Stade { besoin: number; couvert: number; reste: number }

interface PieceEcru {
  id: number
  numero: string | null
  lot: string | null
  poids: number | null
  coloris_reference: string | null
  magasin_nom: string | null
  magasin_id: number
  /** the place is a dyer: a piece there, on no dyer order yet, can be dyed for the line */
  magasin_ennoblisseur: boolean
  second_choix: number | null
  observations: string | null
  /** the dyer order the piece is on, 0 = none yet */
  IDcommande_sous_traitant: number
  sst_nom: string | null
}

interface MatiereEcru {
  applicable: boolean
  unite_label: string
  dim: 'metrage' | 'poids'
  rendement: number
  ecru_ref_label: string
  stades: { fini: Stade | null; ecru: Stade & { pieces: number; tricotage: number } }
  pieces: PieceEcru[]
}

interface PieceLibre {
  id: number
  numero: string | null
  lot: string | null
  poids: number | null
  coloris_reference: string | null
  magasin_nom: string | null
  second_choix: number | null
  observations: string | null
  /** visitage defects of the piece (defaut_qualite) */
  defects?: { IDdefaut_qualite: number; description: string | null; type_defaut: string | null; taille_cm: number | null; nombre?: number | null }[]
  reserved_elsewhere: boolean
  reserved_to_line: boolean
  magasin_id: number
  magasin_ennoblisseur: boolean
}

/** A dyer holding écru reserved to the line: the create-order dialog's location. */
export interface LieuEnnoblisseur { IDsous_traitant: number; location_nom: string }

export const matiereEcruQueryKey = (commandeId: number, ligneId: number) => ['commande-client-matiere-ecru', commandeId, ligneId]

/** The écru reserved to a fini line (shared by the zone and the « Ennoblir » buttons). */
export function useMatiereEcru(commandeId: number, ligneId: number, enabled = true) {
  return useQuery<MatiereEcru>({
    queryKey: matiereEcruQueryKey(commandeId, ligneId),
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/lignes/${ligneId}/matiere/ecru`),
    // The pieces move on other screens (transfers, dyer receptions, TRM shipments).
    staleTime: 0,
    refetchOnMount: 'always',
    enabled,
  })
}

/** Where the line can be dyed now: the dyers holding pieces reserved to it, on no dyer order yet. */
export function lieuxAEnnoblir(data: MatiereEcru | undefined): (LieuEnnoblisseur & { nb: number; kg: number })[] {
  const m = new Map<number, LieuEnnoblisseur & { nb: number; kg: number }>()
  for (const p of data?.pieces ?? []) {
    if (!p.magasin_ennoblisseur || p.IDcommande_sous_traitant > 0 || !(p.magasin_id > 0)) continue
    const l = m.get(p.magasin_id) ?? { IDsous_traitant: p.magasin_id, location_nom: p.magasin_nom ?? '', nb: 0, kg: 0 }
    l.nb += 1
    l.kg += Number(p.poids) || 0
    m.set(p.magasin_id, l)
  }
  return [...m.values()].sort((a, b) => a.location_nom.localeCompare(b.location_nom, 'fr'))
}

export function EcruLigneZone({ commandeId, ligneId, soldee, onChanged }: {
  commandeId: number
  ligneId: number
  soldee: boolean
  /** the line's gauge, status and affectation follow the écru reserved to it */
  onChanged: () => void
}) {
  const queryClient = useQueryClient()
  const queryKey = matiereEcruQueryKey(commandeId, ligneId)
  const { data, isLoading, isError } = useMatiereEcru(commandeId, ligneId)
  const [selecteur, setSelecteur] = useState(false)
  const apres = (payload: MatiereEcru) => {
    queryClient.setQueryData(queryKey, payload)
    queryClient.invalidateQueries({ queryKey: ['commande-client-enno-available', commandeId, ligneId] })
    invalidateStockCaches(queryClient)
    invalidateCommandeClientCaches(queryClient)
    onChanged()
  }

  const u = data?.unite_label ?? ''
  const e = data?.stades.ecru
  // In the line's unit: Ml through the fini's rendement, else kg.
  const enUnite = (kg: number) => (data?.dim === 'metrage' ? kg * (data.rendement || 0) : kg)
  const dispo = (data?.pieces ?? []).filter((p) => !(p.IDcommande_sous_traitant > 0))
  const surCommande = (data?.pieces ?? []).filter((p) => p.IDcommande_sous_traitant > 0)
  const tenu = enUnite(dispo.reduce((x, p) => x + (Number(p.poids) || 0), 0))
  const chezEnnoblisseur = enUnite(surCommande.reduce((x, p) => x + (Number(p.poids) || 0), 0))
  // What available écru still has to cover: the écru stage's need less what its orders carry.
  const besoin = e ? Math.max(0, e.besoin - chezEnnoblisseur - e.tricotage) : 0
  const couvert = tenu >= besoin - 0.05
  const rien = !!e && besoin <= 0.05 && tenu <= 0.05

  const ouvrir = soldee ? undefined : () => setSelecteur(true)

  return (
    <>
      <ZoneLigne kind="matiere" titre="Tombé de métier réservé">
        {isLoading && <div className="h-12 bg-muted animate-pulse rounded-lg" />}
        {isError && (
          <p className="flex items-center gap-1.5 text-sm text-destructive"><AlertCircle className="h-4 w-4" />Impossible de charger le tombé de métier de la ligne</p>
        )}
        {data && !data.applicable && <ZoneVide>La référence finie n’a pas de tombé de métier.</ZoneVide>}
        {data?.applicable && e && (
          // ONE block (Vincent 2026-10-28, « pour simplifier »): what the line holds in écru against its
          // need, the pieces summed per place under it; a click opens the selector to reserve or release.
          <div
            role={ouvrir ? 'button' : undefined}
            tabIndex={ouvrir ? 0 : undefined}
            title={ouvrir ? 'Cliquer pour réserver ou retirer du tombé de métier' : undefined}
            onClick={ouvrir}
            onKeyDown={ouvrir ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ouvrir() } } : undefined}
            className={cn(
              'group relative rounded-lg border border-border/60 bg-card shadow-sm divide-y divide-border/40 transition-colors text-xs',
              ouvrir && 'cursor-pointer hover:border-accent/60 hover:bg-accent/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            {ouvrir && (
              <Pencil className="absolute -top-2 -right-2 h-5 w-5 p-1 rounded-full bg-accent text-accent-foreground shadow-sm opacity-0 group-hover:opacity-100 transition-opacity" />
            )}
            {/* One line: the available pieces held against what they must still cover; when nothing is
                left to cover, where the écru is (Vincent 2026-10-29). */}
            {rien ? (
              <p className="px-3 py-2.5 text-muted-foreground">
                {e!.tricotage > 0.05 ? 'Rien à ennoblir pour l’instant : l’écru est en tricotage'
                  : chezEnnoblisseur > 0.05 ? 'Rien à réserver : l’écru est chez l’ennoblisseur'
                  : 'Rien à réserver : le fini couvre la ligne'}
              </p>
            ) : (
              <div className="px-2.5 py-2 flex items-center gap-2">
                <TmRollIcon className="h-3.5 w-3.5 flex-shrink-0 text-accent" />
                <span className="flex-shrink-0 font-medium">{data.ecru_ref_label || 'Tombé de métier'}</span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {dispo.length > 0 && <> · {dispo.length} pièce{dispo.length > 1 ? 's' : ''}</>}
                </span>
                <span className={cn('ml-auto flex-shrink-0 inline-flex items-center gap-1 tabular-nums', couvert ? 'text-green-700 font-medium' : 'text-muted-foreground')}>
                  {couvert && <CheckCircle2 className="h-3.5 w-3.5" />}
                  Réservé {fmtNum(tenu, 1)} / {fmtNum(besoin, 1)} {u}
                </span>
              </div>
            )}
          </div>
        )}
      </ZoneLigne>

      {selecteur && data && (
        <ReserverEcruDialog
          commandeId={commandeId}
          ligneId={ligneId}
          matiere={data}
          onReserve={(payload) => { apres(payload); setSelecteur(false) }}
          onClose={() => setSelecteur(false)}
        />
      )}
    </>
  )
}

/** « Réserver »: the écru pieces of the fini's base, grouped by place (§18.D banded, §44 Shift+click).
 *  The line's own pieces start ticked: unticking releases them, so the same screen reserves and
 *  corrects; one « Réserver » applies (releases, then the new reservations). */
function ReserverEcruDialog({ commandeId, ligneId, matiere, onReserve, onClose }: {
  commandeId: number
  ligneId: number
  matiere: MatiereEcru
  onReserve: (payload: MatiereEcru) => void
  onClose: () => void
}) {
  const { data, isLoading, isError } = useQuery<{ rendement: number; rolls: PieceLibre[] }>({
    queryKey: ['commande-client-enno-available', commandeId, ligneId, 0],
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/lignes/${ligneId}/supply/ennoblissement/available-rolls`),
    staleTime: 0,
  })
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [initialise, setInitialise] = useState(false)
  const ancre = useRef<number | null>(null)
  const base = `/commandes-client/${commandeId}/lignes/${ligneId}/matiere/ecru`
  const reserveMut = useMutation({
    mutationFn: async ({ liberer, ajouter }: { liberer: number[]; ajouter: number[] }) => {
      let p: unknown = null
      for (const id of liberer) p = await apiFetch(`${base}/${id}`, { method: 'DELETE' })
      if (ajouter.length > 0) p = await apiFetch(base, { method: 'PUT', body: JSON.stringify({ stockIds: ajouter }) })
      return p as MatiereEcru
    },
    onSuccess: (p) => onReserve(p),
  })

  // Numeric-aware order per place; the line's own pieces included (ticked).
  const pieces = useMemo(() => (data?.rolls ?? [])
    .sort((a, b) => (a.magasin_nom ?? '').localeCompare(b.magasin_nom ?? '', 'fr')
      || (a.numero ?? '').localeCompare(b.numero ?? '', 'fr', { numeric: true, sensitivity: 'base' })), [data])
  const choisissables = pieces.filter((p) => !p.reserved_elsewhere)
  if (!initialise && data) {
    setInitialise(true)
    setSel(new Set(pieces.filter((p) => p.reserved_to_line).map((p) => p.id)))
  }
  const ordre = choisissables.map((p) => p.id)
  const groupes = useMemo(() => {
    const m = new Map<number, PieceLibre[]>()
    for (const p of pieces) m.set(p.magasin_id, [...(m.get(p.magasin_id) ?? []), p])
    return [...m.entries()].sort(([, a], [, b]) =>
      Number(b[0].magasin_ennoblisseur) - Number(a[0].magasin_ennoblisseur) || (a[0].magasin_nom ?? '').localeCompare(b[0].magasin_nom ?? '', 'fr'))
  }, [pieces])

  const basculer = (id: number, shift: boolean) => {
    const a = ancre.current
    if (shift && a !== null && a !== id) {
      const i = ordre.indexOf(a), j = ordre.indexOf(id)
      if (i >= 0 && j >= 0) {
        const [lo, hi] = i < j ? [i, j] : [j, i]
        setSel((prev) => {
          const next = new Set(prev)
          const retirer = prev.has(id) // §44: Shift+click on a selected end clears the range
          for (let k = lo; k <= hi; k++) { if (retirer) next.delete(ordre[k]); else next.add(ordre[k]) }
          return next
        })
        return
      }
    }
    setSel((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
    ancre.current = id
  }

  const rendement = matiere.rendement
  const enLigne = (kg: number) => (matiere.dim === 'metrage' ? kg * rendement : kg)
  const ajouts = choisissables.filter((p) => sel.has(p.id) && !p.reserved_to_line)
  const retraits = choisissables.filter((p) => !sel.has(p.id) && p.reserved_to_line)
  const kgDe = (ps: PieceLibre[]) => ps.reduce((s, p) => s + (Number(p.poids) || 0), 0)
  const e = matiere.stades.ecru
  const projete = e.couvert + enLigne(kgDe(ajouts)) - enLigne(kgDe(retraits))
  const changements = ajouts.length + retraits.length
  const couvert = e.besoin > 0 && projete >= e.besoin - 0.05

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !reserveMut.isPending) onClose() }}>
      <DialogContent className="max-w-3xl w-[94vw] h-[85vh] p-0 border-0 bg-primary overflow-hidden flex flex-col">
        <div className="flex-shrink-0 flex items-center gap-2.5 rounded-t-lg border-b-2 border-gold bg-primary px-4 py-2.5">
          <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
            <TmRollIcon className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">Réserver du tombé de métier</h2>
            <p className="text-xs text-white/70 truncate">{matiere.ecru_ref_label || 'Tombé de métier'} · celles de la ligne cochées · Maj+clic pour une plage</p>
          </div>
          <Button variant="ghost" size="icon" title="Fermer" disabled={reserveMut.isPending} onClick={onClose}
            className="h-8 w-8 flex-shrink-0 text-white/80 hover:bg-white/15 hover:text-white">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-100 p-4 space-y-4 scrollbar-transparent">
          {isLoading && <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-12 bg-card animate-pulse rounded-lg" />)}</div>}
          {isError && <p className="flex items-center gap-1.5 text-sm text-destructive"><AlertCircle className="h-4 w-4" />Erreur de chargement</p>}
          {!isLoading && !isError && pieces.length === 0 && (
            <ZoneVide>Aucune pièce écru libre de cette référence. Lancez le tricotage depuis l’onglet Tricotage.</ZoneVide>
          )}
          {groupes.map(([magId, ps]) => {
            const lieu = ps[0].magasin_nom || 'Malterre'
            const cochees = ps.filter((p) => sel.has(p.id))
            return (
              <section key={magId} className="space-y-1.5">
                {/* The place is a discreet heading on the dialog's ground; the card holds only the pieces
                    (same grammar as the yarn selector, Vincent 2026-10-28). */}
                <div className="flex items-baseline gap-2 px-1 text-[11px] uppercase tracking-wide">
                  <span className="min-w-0 truncate font-semibold text-muted-foreground">{lieu}</span>
                  <span className="ml-auto flex-shrink-0 normal-case tracking-normal text-muted-foreground tabular-nums">
                    {ps.length} pièce{ps.length > 1 ? 's' : ''} · {fmtNum(ps.reduce((s, p) => s + (Number(p.poids) || 0), 0), 1)} kg
                  </span>
                  {/* « Aucun », never « Tous » (Vincent 2026-10-28): a whole place is rarely the need; a run
                      of pieces is a Shift+click range (§44). */}
                  {cochees.length > 0 && (
                    <button type="button" disabled={reserveMut.isPending} title={`Décocher les ${cochees.length} pièce${cochees.length > 1 ? 's' : ''} de ${lieu}`}
                      onClick={() => setSel((prev) => { const next = new Set(prev); for (const p of cochees) next.delete(p.id); return next })}
                      className="flex-shrink-0 normal-case tracking-normal font-medium text-accent hover:underline disabled:opacity-50">
                      Aucun
                    </button>
                  )}
                </div>
                <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden divide-y divide-border/40">
                {ps.map((p) => {
                  const choisi = sel.has(p.id)
                  const poids = Number(p.poids) || 0
                  const bloquee = p.reserved_elsewhere || reserveMut.isPending
                  // A div, not a button: the defect / observation icons inside are buttons.
                  return (
                    <div
                      key={p.id}
                      role="button"
                      tabIndex={bloquee ? -1 : 0}
                      aria-pressed={choisi}
                      aria-disabled={bloquee}
                      onClick={(ev) => { if (!bloquee) basculer(p.id, ev.shiftKey) }}
                      onKeyDown={(ev) => { if (!bloquee && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); basculer(p.id, ev.shiftKey) } }}
                      title={p.reserved_elsewhere ? 'Réservée à une autre ligne' : undefined}
                      className={cn(
                        'w-full text-left px-3.5 py-2 flex items-center gap-3 transition-colors select-none',
                        bloquee ? 'cursor-not-allowed' : 'cursor-pointer',
                        choisi ? 'bg-accent/[0.07]' : 'hover:bg-zinc-50',
                        p.reserved_elsewhere && 'opacity-60',
                      )}
                    >
                      <span className={cn('h-5 w-5 flex-shrink-0 rounded-md flex items-center justify-center border-2 transition-colors',
                        choisi ? 'bg-accent border-accent text-accent-foreground' : 'border-zinc-300 bg-white')}>
                        {choisi && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                      </span>
                      {/* One line, fixed columns anchored left so the eye runs down each one (Vincent
                          2026-10-28): numéro, coloris, poids, métrage; the space goes before the icons. */}
                      <span className="w-24 flex-shrink-0 text-sm font-semibold tabular-nums truncate">{p.numero || `Pièce ${p.id}`}</span>
                      <span className="w-20 flex-shrink-0 text-xs text-muted-foreground truncate">{p.coloris_reference || ''}</span>
                      <span className="w-16 flex-shrink-0 text-right text-sm font-medium tabular-nums">{fmtNum(poids, 1)} kg</span>
                      <span className="w-14 flex-shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                        {matiere.dim === 'metrage' && rendement > 0 ? `${fmtNum(poids * rendement, 0)} Ml` : ''}
                      </span>
                      <span className="min-w-0 flex-1">
                        {p.reserved_elsewhere && (
                          <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-amber-500/40 text-amber-700 bg-amber-500/10">Réservée ailleurs</Badge>
                        )}
                      </span>
                      {/* Defects (2e choix + visitage) and observations at the card's right edge, read on hover;
                          a fixed slot keeps the weights aligned whether a piece has notes or not. */}
                      <span className="w-14 h-6 flex-shrink-0 flex items-center justify-end gap-1">
                        <RollDefautsIcon secondChoix={Number(p.second_choix) > 0} text={texteDefauts(p)} />
                        <RollObservationsIcon text={p.observations} />
                      </span>
                    </div>
                  )
                })}
                </div>
              </section>
            )
          })}
        </div>

        <div className="flex-shrink-0 rounded-b-lg border-t border-border/60 bg-zinc-200 px-4 py-3 space-y-2">
          {reserveMut.error && (
            <div className="flex items-start gap-1.5 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span className="break-words">{(reserveMut.error as any).body?.message ?? 'La réservation a échoué'}</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            {/* One figure, no bar (Vincent 2026-10-28): what the ticks bring against the line's écru need. */}
            <p className={cn('min-w-0 flex-1 text-xs tabular-nums truncate inline-flex items-center gap-1', couvert ? 'text-green-700 font-semibold' : 'text-muted-foreground')}>
              {couvert && <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />}
              <span className={cn('font-bold', !couvert && 'text-foreground')}>{fmtNum(projete, 1)}</span>
              {' / '}{fmtNum(e.besoin, 1)} {matiere.unite_label} d’écru pour la ligne
            </p>
            <div className="flex gap-2 flex-shrink-0">
              <Button variant="outline" onClick={onClose} disabled={reserveMut.isPending}>Annuler</Button>
              <Button
                onClick={() => reserveMut.mutate({ liberer: retraits.map((p) => p.id), ajouter: ajouts.map((p) => p.id) })}
                disabled={changements === 0 || reserveMut.isPending}
                title={changements === 0 ? 'Cochez les pièces à réserver, décochez celles à retirer' : undefined}
              >
                {reserveMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <TmRollIcon className="h-3.5 w-3.5 mr-1.5" />}
                Réserver
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** A piece's visitage defects as the tooltip reads them, one per line: the precise description, else
 *  type + count or size (as the TRM avis d'expédition prints them). */
function texteDefauts(p: PieceLibre): string {
  return (p.defects ?? [])
    .map((d) => {
      const desc = (d.description ?? '').trim()
      const taille = Number(d.taille_cm) || 0
      const nombre = Number(d.nombre) || 0
      // Countable defects carry `nombre` (« Trou x2 »), measured ones `taille_cm` (« Maille 25 cm »).
      return desc || [(d.type_defaut ?? '').trim(), nombre > 0 ? `x${nombre}` : taille > 0 ? `${taille} cm` : ''].filter(Boolean).join(' ')
    })
    .filter((t) => t.length > 0)
    .join('\n')
}
