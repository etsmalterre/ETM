// The dyer invoices that bill one sst order (LIVA #1255) — shown at the top of
// its « Docs » tab. An invoice is stored once and covers many orders
// (Sous-traitants › Factures); here only its lines for THIS order, with the
// agent's verdict. A click opens the invoice. Renders nothing when no invoice
// bills the order.

import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, ReceiptText } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { apiFetch } from '@/lib/api'
import { formatHfsqlDate } from '@/lib/dates'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'

type Verdict = 'conforme' | 'ecart' | 'info'

interface LigneCommandeFacture {
  idfacture: number
  numero: string
  date_facture: string | null
  statut_facture: 'conforme' | 'ecarts'
  traitement: 'validee' | 'reclamee' | 'reclamation_close' | null
  id: number
  lot: string
  designation: string
  quantite: number | null
  unite: string
  prix_unitaire: number | null
  prix_attendu: number | null
  montant: number | null
  verdict: Verdict
  /** The person's verdict once the invoice was checked — it wins over the agent's. */
  verdict_final: 'conforme' | 'ecart' | null
}

const VERDICT: Record<Verdict, { label: string; cls: string } | null> = {
  ecart: { label: 'Écart', cls: 'bg-destructive text-white border-destructive' },
  conforme: { label: 'Conforme', cls: 'bg-green-500/10 text-green-700 border-green-500/25' },
  info: null,
}

export function FacturesCommande({ commandeId }: { commandeId: number }) {
  const navigate = useNavigate()
  const { data } = useQuery({
    queryKey: ['factures-sst-commande', commandeId],
    queryFn: () => apiFetch<{ rows: LigneCommandeFacture[] }>(`/factures-sst/commande/${commandeId}`).then((r) => r.rows),
  })
  const parFacture = new Map<number, LigneCommandeFacture[]>()
  for (const l of data ?? []) parFacture.set(l.idfacture, [...(parFacture.get(l.idfacture) ?? []), l])
  if (parFacture.size === 0) return null

  return (
    <div className="space-y-2 pb-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold px-0.5">Factures du sous-traitant</p>
      {[...parFacture.values()].map((lignes) => {
        const f = lignes[0]
        return (
          <div
            key={f.idfacture}
            role="button"
            tabIndex={0}
            onClick={() => navigate(`/sous-traitants/factures?facture=${f.idfacture}`)}
            onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/sous-traitants/factures?facture=${f.idfacture}`) }}
            title="Ouvrir dans Sous-traitants › Factures"
            className="group p-3 rounded-lg border bg-card shadow-sm cursor-pointer hover:border-accent/40 transition-colors"
          >
            <div className="flex items-center gap-2">
              <ReceiptText className="h-4 w-4 text-accent flex-shrink-0" />
              <span className="text-sm font-medium truncate">Facture {f.numero}</span>
              {f.date_facture && <span className="text-xs text-muted-foreground">{formatHfsqlDate(f.date_facture)}</span>}
              {f.traitement && (
                <span className="text-[10px] text-muted-foreground">{f.traitement === 'reclamee' ? '· en réclamation' : f.traitement === 'reclamation_close' ? '· réclamation close' : '· validée'}</span>
              )}
              <ChevronRight className="h-4 w-4 ml-auto text-muted-foreground group-hover:text-accent flex-shrink-0" />
            </div>
            <div className="mt-1.5 space-y-1">
              {lignes.map((l) => {
                const v = VERDICT[l.verdict_final ?? l.verdict]
                return (
                  <div key={l.id} className="flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
                    <span className="font-medium text-foreground truncate">{l.lot || l.designation}</span>
                    {l.quantite != null && <span>{fmtNum(l.quantite, 2)} {l.unite}</span>}
                    {l.prix_unitaire != null && (
                      <span className={cn(l.verdict === 'ecart' && 'text-destructive font-semibold')}>
                        {fmtNum(l.prix_unitaire, 2)} €{l.prix_attendu != null ? ` / ${fmtNum(l.prix_attendu, 2)}` : ''}
                      </span>
                    )}
                    {v && <Badge variant="outline" className={cn('ml-auto text-[10px] py-0 border', v.cls)}>{v.label}</Badge>}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
