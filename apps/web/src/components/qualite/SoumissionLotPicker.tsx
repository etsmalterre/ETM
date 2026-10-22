// The « Soumettre au client » picker: which lot of a dye order goes to which
// client order. Sent from Qualité › Suivi lots since LIVA #1304 (it lived on
// Sous-traitants › Ennoblissement); the endpoints stay on the dye order,
// /commandes-sous-traitant/:id/soumission/*. Two uses since LIVA #1313: a
// received lot (its stabilités, or a coloris never submitted), and a lot NOT
// received yet whose coloris the dyer announces — the lot number is typed then
// (« on peut soumettre le lot MA… cde N »), and the soumission creates the lot.

import { useEffect, useState } from 'react'
import { AlertTriangle, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { formatHfsqlDate } from '@/lib/dates'
import { fmtNum } from '@/lib/format'
import type { NatureSoumission } from './LotCycle'

// Returned by GET /:id/soumission/lots-eligibles. One entry per
// (ref_fini, coloris, lot, commande_client) group; only includes groups
// whose (client, ref_fini) pair has designation_client.soumettre = 1.
export interface EligibleLot {
  /** 'received' = lot string is already known from received fini rolls;
   *  'manual' = no fini received yet, écru affectations identify the
   *  client, user types the lot at picker time. */
  kind: 'received' | 'manual'
  IDref_fini: number
  IDColoris: number
  lot: string                  // '' for manual
  IDcommande_client: number
  IDclient: number
  client_nom: string
  ref_malterre: string
  client_designation: string
  coloris_reference: string
  numero: number               // commande_client.numero
  date_commande: string        // commande_client.date_commande (YYYYMMDD)
  nb_rolls: number             // 0 for manual
  total_metrage: number        // 0 for manual
  /** The soumissions the client asks for the reference (LIVA #1313). */
  natures: NatureSoumission[]
  /** The dye line the lot belongs to. */
  ligneId: number
  /** Coloris candidates across dye orders (GET /suivi-lots/soumission-coloris/candidats). */
  idcommande_sous_traitant?: number
  sous_traitant_nom?: string
  key: string
}

// A received lot the picker cannot offer, and why (LIVA #1302) — rule in
// apps/api/src/lib/soumission-lots-bloques.ts.
export interface LotBloque {
  lot: string
  /** non_reserve = no roll reserved to a client order line;
   *  sans_soumission = reserved, but the client asks no soumission for the ref. */
  raison: 'non_reserve' | 'sans_soumission'
  nb_rolls: number
  total_metrage: number
  /** Client order the écru pieces are still reserved to (non_reserve). */
  reservation_ecru: { numero: number; client_nom: string } | null
  /** Client order the rolls are reserved to (sans_soumission). */
  commande_client: { numero: number; client_nom: string } | null
}

// ── Soumission Lot picker ─────────────────────────────────
// Modelled on AdressePickerDialog (line ~3494). Renders two flavours of
// candidate:
//   - 'received' (lot known) → click sends straight to email modal
//   - 'manual'   (no fini yet) → expands an inline "Numéro de lot" input;
//                                user types the lot then clicks Continuer
export function SoumissionLotPicker({
  open, lots, bloques, title = 'Choisir un lot à soumettre', intro, onClose, onSelect,
}: {
  open: boolean
  lots: EligibleLot[]
  /** Received lots that cannot be submitted — shown greyed with the reason. */
  bloques: LotBloque[]
  title?: string
  /** One line under the title, saying where the lot number comes from. */
  intro?: string
  onClose: () => void
  /** For manual entries the caller receives the candidate with `lot` set
   *  to the user-typed string — the downstream URL/params machinery is
   *  identical to the received path. */
  onSelect: (lot: EligibleLot) => void
}) {
  // Which manual entry is currently expanded for lot input, and the typed
  // value. Keyed by candidate.key.
  const [manualKey, setManualKey] = useState<string | null>(null)
  const [manualLot, setManualLot] = useState('')
  // Reset edit state whenever the dialog reopens.
  useEffect(() => {
    if (!open) { setManualKey(null); setManualLot('') }
  }, [open])

  const received = lots.filter((l) => l.kind === 'received')
  const manual = lots.filter((l) => l.kind === 'manual')

  const confirmManual = (lot: EligibleLot) => {
    const v = manualLot.trim()
    if (!v) return
    onSelect({ ...lot, lot: v })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg space-y-4" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5 text-accent" />
            {title}
          </DialogTitle>
        </DialogHeader>
        {intro && <p className="text-xs text-muted-foreground px-1">{intro}</p>}
        <div className="max-h-[60vh] overflow-y-auto space-y-3 px-1">
          {received.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-1">Lots reçus</div>
              {received.map((lot) => (
                <button
                  key={lot.key}
                  type="button"
                  onClick={() => onSelect(lot)}
                  className="w-full text-left p-3 rounded-md border border-zinc-200 hover:border-accent hover:bg-accent/5 transition-colors"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="text-sm font-semibold text-primary truncate">
                      Lot {lot.lot}
                    </div>
                    <div className="text-xs text-muted-foreground flex-shrink-0">
                      {lot.client_nom}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {lot.ref_malterre}
                    {lot.coloris_reference ? ` · ${lot.coloris_reference}` : ''}
                  </div>
                  {lot.numero > 0 && (
                    <div className="text-xs mt-1">
                      <span className="font-medium text-foreground tabular-nums">Commande N° {lot.numero}</span>
                      {lot.date_commande ? <span className="text-muted-foreground"> · {formatHfsqlDate(lot.date_commande)}</span> : ''}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground mt-1">
                    {lot.nb_rolls} rouleau{lot.nb_rolls > 1 ? 'x' : ''} · {fmtNum(lot.total_metrage, 1)} Ml
                  </div>
                </button>
              ))}
            </div>
          )}

          {manual.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-1">
                Saisir le lot annoncé par l’ennoblisseur (pas encore réceptionné)
              </div>
              {manual.map((lot) => {
                const expanded = manualKey === lot.key
                return (
                  <div
                    key={lot.key}
                    className={`p-3 rounded-md border transition-colors ${
                      expanded ? 'border-accent bg-accent/5' : 'border-zinc-200 hover:border-accent hover:bg-accent/5'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (expanded) { setManualKey(null); setManualLot('') }
                        else { setManualKey(lot.key); setManualLot('') }
                      }}
                      className="w-full text-left"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="text-sm font-semibold text-primary truncate">
                          {lot.client_nom}
                        </div>
                        <div className="text-xs text-muted-foreground flex-shrink-0">
                          {lot.ref_malterre}
                          {lot.coloris_reference ? ` · ${lot.coloris_reference}` : ''}
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Réf client : {lot.client_designation || '—'}
                      </div>
                      {!!lot.idcommande_sous_traitant && (
                        <div className="text-xs mt-1">
                          <span className="font-medium text-foreground tabular-nums">Teinture N° {lot.idcommande_sous_traitant}</span>
                          {lot.sous_traitant_nom ? <span className="text-muted-foreground"> · {lot.sous_traitant_nom}</span> : ''}
                        </div>
                      )}
                      {lot.numero > 0 && (
                        <div className="text-xs mt-1">
                          <span className="font-medium text-foreground tabular-nums">Commande N° {lot.numero}</span>
                          {lot.date_commande ? <span className="text-muted-foreground"> · {formatHfsqlDate(lot.date_commande)}</span> : ''}
                        </div>
                      )}
                    </button>
                    {!!expanded && (
                      <div className="mt-3 flex items-center gap-2">
                        <input
                          autoFocus
                          type="text"
                          value={manualLot}
                          onChange={(e) => setManualLot(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); confirmManual(lot) }
                            if (e.key === 'Escape') { e.preventDefault(); setManualKey(null); setManualLot('') }
                          }}
                          placeholder="Numéro de lot"
                          className="flex-1 h-9 px-3 rounded-md border border-zinc-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent/50"
                        />
                        <Button
                          variant="gold"
                          size="sm"
                          disabled={!manualLot.trim()}
                          onClick={() => confirmManual(lot)}
                        >
                          Continuer
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {lots.length === 0 && (
            <p className="text-sm text-muted-foreground italic px-2 py-4 text-center">
              Aucun lot éligible
            </p>
          )}

          {bloques.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-1">
                Lots reçus non soumissibles
              </div>
              {bloques.map((b) => (
                <div
                  key={b.lot}
                  className="p-3 rounded-md border border-dashed border-amber-400/60 bg-amber-50/60 cursor-not-allowed"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="text-sm font-semibold text-muted-foreground truncate">
                      Lot {b.lot}
                    </div>
                    <div className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">
                      {b.nb_rolls} rouleau{b.nb_rolls > 1 ? 'x' : ''} · {fmtNum(b.total_metrage, 1)} Ml
                    </div>
                  </div>
                  <div className="flex items-start gap-1.5 mt-1.5 text-xs text-amber-800">
                    <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
                    <span>{lotBloqueMessage(b)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>Annuler</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}


// Why a received lot cannot be submitted, and what to do about it.
function lotBloqueMessage(b: LotBloque): string {
  const cde = (c: { numero: number; client_nom: string }) =>
    `la commande N° ${c.numero}${c.client_nom ? ` (${c.client_nom})` : ''}`
  if (b.raison === 'sans_soumission') {
    return `Le client ne demande pas de soumission pour cette référence${b.commande_client ? ` (rouleaux réservés à ${cde(b.commande_client)})` : ''}. À activer dans Clients › Gestion › Références.`
  }
  // The écru reservation is the history the fini leaves behind (#1188): state
  // it as a fact, never as a story about who removed what.
  return b.reservation_ecru
    ? `Aucun rouleau n’est réservé à une commande client. Les pièces écru de ce lot sont réservées à ${cde(b.reservation_ecru)} : affectez les rouleaux à cette commande pour pouvoir soumettre ce lot.`
    : 'Aucun rouleau n’est réservé à une commande client. Affectez-les à une ligne client (Clients › Commandes) pour pouvoir soumettre ce lot.'

}

export function buildSoumissionLotQuery(lot: EligibleLot, nature: NatureSoumission): string {
  return new URLSearchParams({
    ref_fini: String(lot.IDref_fini),
    coloris: String(lot.IDColoris),
    lot: lot.lot,
    commande_client: String(lot.IDcommande_client),
    nature,
  }).toString()
}
