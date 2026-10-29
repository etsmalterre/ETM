import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Loader2, Timer, Truck } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { GrapheDelais } from './GrapheDelais'

// ── Types (mirror GET /sous-traitants/:id/qualite-service, API lib/qualite-service-sst.ts) ──
interface CommandeReponse {
  idcommande: number
  demandeLe: string
  reponduLe: string | null
  jours: number
  relances: number
  enAttente: boolean
  neutralisee: boolean
  reportsSst: number
}
interface LigneRespect {
  idcommande: number
  idligne: number
  reference: string
  delaiPromis: string
  commandeLe: string | null
  /** working days from the order to the first lot (to today while open) */
  dureeJours: number | null
  premiereReception: string | null
  retard: number
  enRetardOuvert: boolean
}
interface QualiteService {
  depuis: string
  reponseMesureeDepuis: string
  synthese: {
    reponse: {
      mesurees: number; moyenneJours: number | null; partDansLesTemps: number | null; relancesMoyennes: number | null
      enAttente: number; neutralisees: number; nonMesurees: number; reportsSst: number; seuilJours: number
    }
    respect: { lignes: number; aLHeure: number; partALHeure: number | null; retardMoyen: number | null; enRetardOuvertes: number }
  }
  reponses: CommandeReponse[]
  lignes: LigneRespect[]
  /** the dyer's délai standard (Gestion › Info), the target of the respect chart */
  standardJours: number
}

type Periode = '3' | '12' | 'tout'
const PERIODES: { key: Periode; label: string }[] = [
  { key: '3', label: '3 mois' },
  { key: '12', label: '12 mois' },
  { key: 'tout', label: 'Tout' },
]

function depuisDe(p: Periode): string {
  if (p === 'tout') return '2000-01-01'
  const d = new Date()
  d.setMonth(d.getMonth() - Number(p))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const jjmmaa = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : '—')
const jours = (n: number) => `${fmtNum(n)} j`

/** Sous-traitants › Gestion › « Qualité de service » (LIVA #1314): how the
 *  sous-traitant answers the délai question and keeps the délai it gave.
 *  Read-only, computed by the API from facts ETM already holds. */
export function QualiteServiceSection({ sousTraitantId, respect, className }: {
  sousTraitantId: number
  /** The « respect du délai » half: dyers only (it reads the lots received). */
  respect: boolean
  className?: string
}) {
  const [periode, setPeriode] = useState<Periode>('12')
  const depuis = useMemo(() => depuisDe(periode), [periode])
  const { data, isLoading, isError, error } = useQuery<QualiteService>({
    queryKey: ['sous-traitant-qualite-service', sousTraitantId, depuis],
    queryFn: () => apiFetch(`/sous-traitants/${sousTraitantId}/qualite-service?depuis=${depuis}`),
  })

  return (
    <div className={cn('min-h-0 overflow-auto scrollbar-transparent space-y-3 px-1 pb-1', className)}>
      <div className="flex items-center gap-3">
        <div className="flex gap-1">
          {PERIODES.map((p) => (
            <button key={p.key} type="button" onClick={() => setPeriode(p.key)}
              className={cn('px-2.5 py-1 text-xs rounded-md transition-colors',
                periode === p.key ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10')}>
              {p.label}
            </button>
          ))}
        </div>
        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-accent" />}
      </div>

      {isError ? (
        <div className="flex items-center gap-2 text-sm text-destructive py-6 justify-center">
          <AlertCircle className="h-4 w-4" />{(error as Error)?.message || 'Erreur'}
        </div>
      ) : !data ? null : (
        <>
          <ReponseCard data={data} />
          {respect && <RespectCard data={data} />}
        </>
      )}
    </div>
  )
}

// Graphs only for now (Vincent 2026-10-29): the figures and tables are left out of this tab.
function ReponseCard({ data }: { data: QualiteService }) {
  const r = data.synthese.reponse
  return (
    <Card className="card-premium">
      <CardHeader className="flex flex-row items-center gap-2 pb-2">
        <Timer className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Réponse au délai</CardTitle>
        <span className="text-[11px] text-muted-foreground ml-auto">Du bon de commande envoyé au délai reçu</span>
      </CardHeader>
      <CardContent>
        {data.reponses.length === 0 ? (
          <p className="text-sm text-muted-foreground italic py-4 text-center">Aucun délai demandé sur la période</p>
        ) : (
          <GrapheDelais
            points={data.reponses.map((c) => ({
              key: c.idcommande, date: c.demandeLe, jours: c.jours, ouvert: c.enAttente,
              infos: [`N° ${c.idcommande}`, `Demandé le ${jjmmaa(c.demandeLe)}`,
                c.reponduLe ? `Répondu le ${jjmmaa(c.reponduLe)} · ${jours(c.jours)}` : `En attente depuis ${jours(c.jours)}`,
                `${fmtNum(c.relances)} relance${c.relances > 1 ? 's' : ''}`],
            }))}
            cible={{ jours: r.seuilJours, libelle: `Réponse attendue sous ${r.seuilJours} j` }}
            legendeOuvert="en attente de réponse" />
        )}
      </CardContent>
    </Card>
  )
}

function RespectCard({ data }: { data: QualiteService }) {
  const lignes = data.lignes.filter((l) => l.dureeJours != null)
  return (
    <Card className="card-premium">
      <CardHeader className="flex flex-row items-center gap-2 pb-2">
        <Truck className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Respect du délai</CardTitle>
        <span className="text-[11px] text-muted-foreground ml-auto">De la commande au premier lot reçu</span>
      </CardHeader>
      <CardContent>
        {lignes.length === 0 ? (
          <p className="text-sm text-muted-foreground italic py-4 text-center">Aucun lot reçu sur la période</p>
        ) : (
          /* The real délai of each line (order → first lot) against the dyer's délai standard (Vincent 2026-10-29). */
          <GrapheDelais
            points={lignes.map((l) => ({
              key: l.idligne, date: l.premiereReception ?? new Date().toISOString().slice(0, 10), jours: l.dureeJours!, ouvert: l.enRetardOuvert,
              infos: [`N° ${l.idcommande}${l.reference ? ` · ${l.reference}` : ''}`, `Commandé le ${jjmmaa(l.commandeLe)}`,
                l.premiereReception ? `1er lot le ${jjmmaa(l.premiereReception)} · ${jours(l.dureeJours!)}` : `Rien reçu, ${jours(l.dureeJours!)} à ce jour`,
                l.retard > 0 ? `+${jours(l.retard)} sur le délai donné` : 'À temps sur le délai donné'],
            }))}
            cible={{ jours: data.standardJours, libelle: `Standard ${data.standardJours} j` }}
            legendeOuvert="rien reçu, compté jusqu'à aujourd'hui" />
        )}
      </CardContent>
    </Card>
  )
}
