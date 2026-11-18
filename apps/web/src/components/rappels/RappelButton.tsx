// The « Rappel » button of an object (a lot, a piece, an order): a dated note
// that comes back, on its day, in the notification centre of the person it is
// for (API lib/rappels.ts). One component for every screen: a screen mounts it
// with the object's type and id, never a fork.
//
// The gold dot counts the reminders still open on the object, so that whoever
// opens the lot sees there is something agreed about it.

import { useState } from 'react'
import { AlarmClock, AlarmClockPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { cn } from '@/lib/utils'
import { RappelsDialog } from './RappelDialogs'
import { useRappelsObjet, type TypeObjet } from './rappels'

export function RappelButton({ type, id, titre, lot, surface = 'page' }: {
  type: TypeObjet
  id: number | null | undefined
  /** How the object reads in the dialog (« Lot MA109539 »). */
  titre?: string
  /** A piece of a lot: the dialog then offers « cette pièce » or « le lot », and the dot also counts
   *  the lot's reminders (what is agreed on the lot concerns each of its rolls). */
  lot?: { id: number; titre: string } | null
  /** `page`: a detail header (outline icon button, mps_designer §6.1). `bande`: the navy band of a
   *  side drawer (ghost white icon button, §27.5bis). */
  surface?: 'page' | 'bande'
}) {
  const [open, setOpen] = useState(false)
  // A reminder comes back in the notification centre: without it, nothing would ever show it.
  const centre = useHasPermission('dashboard_notifications')
  const { data } = useRappelsObjet(type, id, centre)
  const duLot = useRappelsObjet('lot_fini', lot?.id, centre && !!lot)
  if (!centre || !id || id <= 0) return null

  const ouverts = [...(data?.rappels ?? []), ...(lot ? duLot.data?.rappels ?? [] : [])].filter((r) => r.fait_le === null).length
  // An alarm clock, never a bell: the bell is the notification centre's alone (Vincent 2026-11-18).
  const Icone = ouverts > 0 ? AlarmClock : AlarmClockPlus
  const title = ouverts > 0
    ? `${ouverts} rappel${ouverts > 1 ? 's' : ''} sur cet élément${lot ? ' ou son lot' : ''}`
    : 'Poser un rappel'

  return (
    <>
      <div className="relative flex-shrink-0">
        <Button
          variant={surface === 'bande' ? 'ghost' : 'outline'}
          size="icon"
          title={title}
          onClick={() => setOpen(true)}
          className={cn(
            surface === 'bande' ? 'h-8 w-8 text-white/80 hover:bg-white/15 hover:text-white' : 'h-9 w-9',
          )}
        >
          <Icone className="h-4 w-4" />
          <span className="sr-only">{title}</span>
        </Button>
        {ouverts > 0 && (
          <span className="pointer-events-none absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 text-[10px] font-bold leading-none text-gold-foreground shadow-sm ring-2 ring-white/80">
            {ouverts > 9 ? '9+' : ouverts}
          </span>
        )}
      </div>
      <RappelsDialog open={open} onClose={() => setOpen(false)} type={type} id={id} titre={titre} lot={lot} />
    </>
  )
}
