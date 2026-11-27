// Finis › Études coloris — « Prochaines étapes », the first section of an étude's body
// (Vincent 2026-11-27): who holds the étude now (the ennoblisseur's lab or the client),
// what started its wait, and its clock in working days. Same grammar as a lot's card
// (components/qualite/LotCycle.tsx `CycleCard`); no button on the card: the relance is
// the header's « @ » button, the statut the footer's pill.
// The step is computed by apps/api/src/lib/etude-etape.ts, never here.

import { Ban, CheckCircle2, FlaskConical, ListChecks, Send } from 'lucide-react'
import { cn } from '@/lib/utils'

/** The étude's step (API `EtapeEtude`). Dates 'YYYY-MM-DD'. */
export interface EtapeEtude {
  attente: 'labo' | 'client' | 'acceptee' | 'annulee'
  /** What started the holder's wait. */
  origine: 'reception' | 'refus' | 'soumission' | null
  depuis: string | null
  /** Our relances of the current holder since then. */
  relances: number
  derniereRelance: string | null
  /** The holder's clock in working days, restarted by our last relance. */
  fenetre: { depuis: string; echeance: string; jours: number; ecoules: number; depassee: boolean } | null
  /** §41 red: the relance is due. */
  urgence: { niveau: 'rouge'; raison: string } | null
  accepteeLe: string | null
}

const jjmm = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '')

export function EtapeEtudeCard({
  etape, sousTraitant, client, coloris,
}: {
  etape: EtapeEtude
  sousTraitant: string | null
  client: string | null
  /** The coloris the acceptance created. */
  coloris: string | null
}) {
  const { attente, fenetre: f } = etape
  const enCours = attente === 'labo' || attente === 'client'
  const rouge = !!etape.urgence
  const retard = f ? f.ecoules - f.jours : 0
  // Colour = whose move, as on a lot: sky the ennoblisseur, violet the client.
  const Icon = attente === 'labo' ? FlaskConical : attente === 'client' ? Send : attente === 'acceptee' ? CheckCircle2 : Ban
  const iconColor = attente === 'labo' ? 'text-sky-600' : attente === 'client' ? 'text-violet-600' : attente === 'acceptee' ? 'text-green-600' : 'text-muted-foreground'
  const titre = attente === 'labo'
    ? (etape.origine === 'refus' ? 'Nouvelle soumission attendue de l’ennoblisseur' : 'Soumission attendue de l’ennoblisseur')
    : attente === 'client' ? 'Réponse du client attendue'
      : attente === 'acceptee' ? 'Étude acceptée' : 'Étude annulée'
  const origine = etape.origine === 'reception' ? `type reçu le ${jjmm(etape.depuis)}`
    : etape.origine === 'refus' ? `soumission refusée par le client le ${jjmm(etape.depuis)}`
      : etape.origine === 'soumission' ? `soumis le ${jjmm(etape.depuis)}` : ''
  const relance = etape.derniereRelance
    ? `relancé le ${jjmm(etape.derniereRelance)}${etape.relances > 1 ? ` (${etape.relances} relances)` : ''}`
    : ''
  const detail = enCours
    ? [attente === 'labo' ? sousTraitant : client, origine, relance].filter(Boolean).join(' · ')
    : attente === 'acceptee'
      ? [etape.accepteeLe ? `le ${jjmm(etape.accepteeLe)}` : '', coloris ? `coloris ${coloris}` : ''].filter(Boolean).join(' · ')
      : ''

  return (
    <div className={cn(
      'flex-shrink-0 rounded-xl border bg-card shadow-sm p-4 border-l-4',
      rouge ? 'border-l-red-500' : attente === 'acceptee' ? 'border-l-green-500/60' : 'border-l-border',
    )}>
      <div className="flex items-center gap-2 mb-3">
        <ListChecks className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Prochaines étapes</h2>
      </div>
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 flex-shrink-0 rounded-lg flex items-center justify-center bg-zinc-100">
          <Icon className={cn('h-5 w-5', iconColor)} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold leading-snug">{titre}</p>
          {detail && <p className="text-xs text-muted-foreground truncate" title={detail}>{detail}</p>}
        </div>
        {enCours && f && (
          <div className="flex-shrink-0 text-right">
            <p className={cn('text-2xl font-bold tabular-nums leading-none', rouge ? 'text-red-600' : 'text-foreground')}>
              {f.ecoules} j
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">sur {f.jours} j ouvrés</p>
          </div>
        )}
      </div>

      {enCours && f && (
        <div className="mt-3">
          <div className="flex gap-1">
            {Array.from({ length: f.jours }, (_, i) => (
              <div
                key={i}
                className={cn(
                  'h-2 flex-1 rounded-full',
                  i >= f.ecoules ? 'bg-zinc-200' : rouge ? 'bg-red-500' : attente === 'client' ? 'bg-violet-500' : 'bg-sky-500',
                )}
              />
            ))}
          </div>
          {etape.urgence && (
            <p className="mt-1.5 text-xs font-medium text-red-700">
              {etape.urgence.raison}{retard > 0 ? ` : ${retard} j de retard` : ' aujourd’hui'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
