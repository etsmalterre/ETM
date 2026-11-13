import { AlertCircle, Users } from 'lucide-react'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate } from '@/lib/dates'
import { cn } from '@/lib/utils'

/** Who a knitting line knits for (API lib/engagement-tricotage.ts). */
export interface LectureTricotage {
  quantite: number
  tricote: number
  reste: number
  chez_tricoteur: number
  a_venir: number
  sur_promesse: number
  parts: { lcc: number; client_nom: string | null; commande_numero: number | null; article: string | null; delai: string | null; reserve: number; recu: number; reste: number; toute: boolean }[]
  autres: { lcc: number; client_nom: string | null; commande_numero: number | null; article: string | null; don: boolean; recu: number }[]
  stock: { recu: number; a_venir: number }
}

// Who a knitting line knits for (Vincent 2026-11-13, API lib/engagement-tricotage.ts):
// one row per client line holding a share of the order — what it reserved, what
// it already received, what is still to come to it — then the pieces that went
// elsewhere, then « Stock » (what nobody claims). The same table look as the
// other tabs. More promised than the order will still bring is said in amber,
// with what to do.
export function ReservationsTricotage({ lecture, ligneCourante }: {
  lecture: LectureTricotage | null
  /** the client line the reading is opened from (Clients › Commandes): its row stands out */
  ligneCourante?: number
}) {
  if (!lecture) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <Users className="h-12 w-12 mb-2 opacity-40" />
        <p className="text-sm">Aucune réservation à lire sur cette ligne</p>
      </div>
    )
  }
  const th = 'px-2.5 py-2 font-semibold whitespace-nowrap'
  const td = 'px-2.5 py-1.5 whitespace-nowrap'
  const kg = (x: number) => (x > 0.05 ? `${fmtNum(x, 1)} kg` : '—')
  const pour = (r: { client_nom: string | null; commande_numero: number | null }) => (
    <span className="flex items-center gap-2 font-medium">
      <span>{r.client_nom || 'Client'}</span>
      {r.commande_numero ? <span className="font-normal text-muted-foreground tabular-nums">· Cde {r.commande_numero}</span> : null}
    </span>
  )
  const livre = round1(lecture.tricote - lecture.chez_tricoteur)
  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
          {fmtNum(lecture.quantite, 1)} kg commandés · {fmtNum(lecture.tricote, 1)} kg tricotés · {fmtNum(lecture.reste, 1)} kg à tricoter
        </h3>
        {lecture.chez_tricoteur > 0.05 && (
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold flex-shrink-0">
            {fmtNum(lecture.chez_tricoteur, 1)} kg chez le tricoteur
          </span>
        )}
      </div>
      {lecture.sur_promesse > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-900 flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 text-amber-600 flex-shrink-0 mt-px" />
          <span>
            <span className="font-medium">{fmtNum(lecture.sur_promesse, 1)} kg promis en trop.</span>{' '}
            Les lignes client comptent sur {fmtNum(lecture.parts.reduce((s, p) => s + p.reste, 0), 1)} kg, la commande n'en apportera plus que {fmtNum(lecture.a_venir, 1)}.
            Réduire une réservation (commande client, onglet Tricotage) ou tricoter le complément.
          </span>
        </div>
      )}
      <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-x-auto scrollbar-transparent">
        <table className="w-full text-xs">
          <thead className="bg-primary/10 border-b border-primary/10">
            <tr className="text-[10px] uppercase tracking-wide text-primary/80">
              <th className={cn(th, 'text-left')}>Pour</th>
              <th className={cn(th, 'text-left')}>Article</th>
              <th className={cn(th, 'text-left')}>Prête le</th>
              <th className="px-2.5 py-2 w-full" />
              <th className={cn(th, 'text-right')}>Réservé</th>
              <th className={cn(th, 'text-right')} title="Pièces déjà livrées et réservées à la ligne">Reçu</th>
              <th className={cn(th, 'text-right')} title="Ce que la commande doit encore lui apporter">Reste à recevoir</th>
            </tr>
          </thead>
          <tbody>
            {lecture.parts.map((p) => (
              <tr key={`p${p.lcc}`} className={cn('border-b border-border/40', p.lcc === ligneCourante && 'bg-accent/10')}>
                <td className={td}>{pour(p)}</td>
                <td className={td}>{p.article || '—'}</td>
                <td className={cn(td, 'text-muted-foreground tabular-nums')}>{p.delai ? formatHfsqlDate(p.delai) : '—'}</td>
                <td className={td} />
                <td className={cn(td, 'text-right tabular-nums')}>
                  {p.toute && <span className="mr-1.5 text-[10px] text-muted-foreground">tout le reste</span>}
                  {kg(p.reserve)}
                </td>
                <td className={cn(td, 'text-right tabular-nums')}>{kg(p.recu)}</td>
                <td className={cn(td, 'text-right tabular-nums font-medium')}>{kg(p.reste)}</td>
              </tr>
            ))}
            {lecture.autres.map((a) => (
              <tr key={`a${a.lcc}`} className={cn('border-b border-border/40', !a.don && a.lcc === ligneCourante && 'bg-accent/10')}>
                <td className={td} title={a.don ? undefined : 'Pièces réservées à la main, sans part de la commande'}>
                  {a.don ? <span className="font-medium">Don</span> : pour(a)}
                </td>
                <td className={td}>{a.article || '—'}</td>
                <td className={cn(td, 'text-muted-foreground')} colSpan={2}>{a.don ? 'données' : 'hors réservation'}</td>
                <td className={cn(td, 'text-right tabular-nums text-muted-foreground')}>—</td>
                <td className={cn(td, 'text-right tabular-nums')}>{kg(a.recu)}</td>
                <td className={cn(td, 'text-right tabular-nums text-muted-foreground')}>—</td>
              </tr>
            ))}
            <tr>
              <td className={cn(td, 'font-medium')}>Stock</td>
              <td className={cn(td, 'text-muted-foreground')} colSpan={3}>non réservé</td>
              <td className={cn(td, 'text-right tabular-nums text-muted-foreground')}>—</td>
              <td className={cn(td, 'text-right tabular-nums')}>{kg(lecture.stock.recu)}</td>
              <td className={cn(td, 'text-right tabular-nums font-medium')}>{kg(lecture.stock.a_venir)}</td>
            </tr>
          </tbody>
          <tfoot className="bg-zinc-100/80 border-t border-border/60">
            <tr className="font-semibold">
              {/* The order's own line: ordered, delivered, still to come — what the rows above share. */}
              <td className={td} colSpan={4}>La commande</td>
              <td className={cn(td, 'text-right tabular-nums')}>{kg(lecture.quantite)}</td>
              <td className={cn(td, 'text-right tabular-nums')}>{kg(livre)}</td>
              <td className={cn(td, 'text-right tabular-nums')}>{kg(lecture.a_venir)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  )
}

const round1 = (x: number) => Math.round(x * 10) / 10
