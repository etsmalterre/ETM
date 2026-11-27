// Header: « Envoyer un email » — every mail of a record from one button (mps_designer §42).

import { useEffect, useRef, useState } from 'react'
import { AtSign, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** One e-mail the record can send now (a bon de commande, a soumission, a relance…). */
export interface MailChoix {
  key: string
  label: string
  icon: LucideIcon
  /** §41: 'rouge' = a relance due, 'ambre' = a mail of ours to send, null = offered. */
  niveau?: 'rouge' | 'ambre' | null
  onSelect: () => void
}

/** The record's ONE mail button (Vincent 2026-11-27: no button per kind of mail — the
 *  person sends an e-mail from the e-mail button): the §42 menu when several mails
 *  are possible, the mail itself when there is one, nothing when there is none.
 *  Qualité › Suivi lots (a lot) and Sous-traitants › Commandes (an order). */
export function MailMenuButton({ mails }: { mails: MailChoix[] }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])
  if (mails.length === 0) return null
  const seul = mails.length === 1 ? mails[0] : null
  const niveau = mails.some((m) => m.niveau === 'rouge') ? 'rouge' : mails.some((m) => m.niveau === 'ambre') ? 'ambre' : null
  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="outline" size="icon" className="h-9 w-9 relative"
        title={seul ? `${seul.label}${seul.niveau ? ' — à faire' : ''}` : niveau ? 'Envoyer un email — à faire' : 'Envoyer un email'}
        onClick={() => (seul ? seul.onSelect() : setMenuOpen((v) => !v))}
      >
        <AtSign className="h-4 w-4" />
        {niveau && <span className={cn('absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full ring-2 ring-white', niveau === 'rouge' ? 'bg-red-500' : 'bg-amber-500')} />}
      </Button>
      {!seul && menuOpen && (
        <div className="absolute top-full right-0 mt-1 w-80 rounded-lg border bg-white shadow-lg overflow-hidden z-50">
          {mails.map((m) => {
            const ItemIcon = m.icon
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => { m.onSelect(); setMenuOpen(false) }}
                title={m.label}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-zinc-100"
              >
                <ItemIcon className={cn('h-4 w-4 flex-shrink-0', m.niveau === 'rouge' ? 'text-red-600' : m.niveau === 'ambre' ? 'text-amber-600' : 'text-muted-foreground')} />
                <span className="min-w-0 flex-1 truncate">{m.label}</span>
                {m.niveau && (
                  <span className={cn('text-[11px] font-medium flex-shrink-0', m.niveau === 'rouge' ? 'text-red-600' : 'text-amber-700')}>À faire</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
