import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { AlertCircle, BellRing, CalendarClock, Hourglass, Info, Loader2, Timer, Truck } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'

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
const pct = (x: number | null) => (x === null ? '—' : `${fmtNum(Math.round(x * 100))} %`)
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

function Chiffre({ icon: Icon, label, value, detail }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: string; detail?: string
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-zinc-100/80 p-3 min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="h-3.5 w-3.5 text-accent flex-shrink-0" /><span className="truncate">{label}</span>
      </div>
      <div className="text-2xl font-bold tabular-nums mt-1">{value}</div>
      {detail && <div className="text-[11px] text-muted-foreground mt-0.5">{detail}</div>}
    </div>
  )
}

function ReponseCard({ data }: { data: QualiteService }) {
  const r = data.synthese.reponse
  return (
    <Card className="card-premium">
      <CardHeader className="flex flex-row items-center gap-2 pb-2">
        <Timer className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Réponse au délai</CardTitle>
        <span className="text-[11px] text-muted-foreground ml-auto">Du bon de commande envoyé au délai reçu</span>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <Chiffre icon={Timer} label="Délai de réponse moyen" value={r.moyenneJours === null ? '—' : `${fmtNum(r.moyenneJours, 1)} j`}
            detail={`jours ouvrés, sur ${fmtNum(r.mesurees)} commande${r.mesurees > 1 ? 's' : ''}`} />
          <Chiffre icon={CalendarClock} label={`Réponse sous ${r.seuilJours} jours`} value={pct(r.partDansLesTemps)} detail="ouvrés après le bon de commande" />
          <Chiffre icon={BellRing} label="Relances par commande" value={r.relancesMoyennes === null ? '—' : fmtNum(r.relancesMoyennes, 1)} detail="Point du jour, e-mail ou téléphone" />
          <Chiffre icon={Hourglass} label="En attente de délai" value={fmtNum(r.enAttente)}
            detail={r.reportsSst > 0 ? `${fmtNum(r.reportsSst)} report${r.reportsSst > 1 ? 's' : ''} de son fait` : undefined} />
        </div>
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3 flex-shrink-0 mt-0.5" />
          <span>
            {`Mesuré sur les délais reçus depuis le ${jjmmaa(data.reponseMesureeDepuis)}. `}
            {r.neutralisees > 0 && `${fmtNum(r.neutralisees)} commande${r.neutralisees > 1 ? 's' : ''} hors moyenne : attente repoussée de notre fait. `}
            {r.nonMesurees > 0 && `${fmtNum(r.nonMesurees)} commande${r.nonMesurees > 1 ? 's' : ''} sans date de réponse.`}
          </span>
        </p>
        {data.reponses.length > 0 && (
          <div className="rounded-lg border border-border/60 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-200/60 border-b border-border/60">
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left font-semibold">Commande</th>
                  <th className="px-3 py-2 text-left font-semibold">Demandé le</th>
                  <th className="px-3 py-2 text-left font-semibold">Répondu le</th>
                  <th className="px-3 py-2 text-right font-semibold">Jours ouvrés</th>
                  <th className="px-3 py-2 text-right font-semibold">Relances</th>
                  <th className="px-3 py-2 text-right font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {data.reponses.map((c) => (
                  <tr key={c.idcommande} className="border-b border-border/40 last:border-0">
                    <td className="px-3 py-1.5"><LienCommande id={c.idcommande} /></td>
                    <td className="px-3 py-1.5 tabular-nums">{jjmmaa(c.demandeLe)}</td>
                    <td className="px-3 py-1.5 tabular-nums">{jjmmaa(c.reponduLe)}</td>
                    <td className={cn('px-3 py-1.5 text-right tabular-nums', !c.enAttente && !c.neutralisee && c.jours > data.synthese.reponse.seuilJours && 'text-amber-700 font-medium')}>
                      {jours(c.jours)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(c.relances)}</td>
                    <td className="px-3 py-1.5 text-right">
                      {c.enAttente && <Badge variant="outline" className="text-[10px] py-0 bg-amber-500/10 text-amber-800 border-amber-500/30">En attente</Badge>}
                      {!c.enAttente && c.neutralisee && <Badge variant="outline" className="text-[10px] py-0 text-muted-foreground">De notre fait</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function RespectCard({ data }: { data: QualiteService }) {
  const r = data.synthese.respect
  return (
    <Card className="card-premium">
      <CardHeader className="flex flex-row items-center gap-2 pb-2">
        <Truck className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Respect du délai</CardTitle>
        <span className="text-[11px] text-muted-foreground ml-auto">Premier délai donné, comparé au premier lot reçu</span>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <Chiffre icon={CalendarClock} label="Lignes livrées à temps" value={pct(r.partALHeure)} detail={`${fmtNum(r.aLHeure)} sur ${fmtNum(r.lignes)}`} />
          <Chiffre icon={Timer} label="Retard moyen" value={r.retardMoyen === null ? '—' : `${fmtNum(r.retardMoyen, 1)} j`} detail="jours ouvrés, lignes en retard" />
          <Chiffre icon={Hourglass} label="En retard, rien reçu" value={fmtNum(r.enRetardOuvertes)} detail="lignes en cours, délai passé" />
        </div>
        {data.lignes.length > 0 && (
          <div className="rounded-lg border border-border/60 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-200/60 border-b border-border/60">
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left font-semibold">Commande</th>
                  <th className="px-3 py-2 text-left font-semibold">Référence</th>
                  <th className="px-3 py-2 text-left font-semibold">Délai donné</th>
                  <th className="px-3 py-2 text-left font-semibold">1er lot reçu</th>
                  <th className="px-3 py-2 text-right font-semibold">Retard</th>
                </tr>
              </thead>
              <tbody>
                {data.lignes.map((l) => (
                  <tr key={l.idligne} className="border-b border-border/40 last:border-0">
                    <td className="px-3 py-1.5"><LienCommande id={l.idcommande} /></td>
                    <td className="px-3 py-1.5 truncate max-w-[220px]" title={l.reference}>{l.reference || '—'}</td>
                    <td className="px-3 py-1.5 tabular-nums">{jjmmaa(l.delaiPromis)}</td>
                    <td className="px-3 py-1.5 tabular-nums">{l.premiereReception ? jjmmaa(l.premiereReception) : <span className="text-muted-foreground italic">pas encore</span>}</td>
                    <td className={cn('px-3 py-1.5 text-right tabular-nums', l.retard > 0 && 'text-red-600 font-medium')}>
                      {l.retard > 0 ? `+${jours(l.retard)}` : 'à temps'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function LienCommande({ id }: { id: number }) {
  return (
    <Link to={`/sous-traitants/commandes?commande=${id}`} className="font-medium tabular-nums text-accent-blue hover:underline">
      N° {id}
    </Link>
  )
}
