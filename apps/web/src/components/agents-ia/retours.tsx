// The « Retours » tab's pieces, shared by Agents IA (console, pages/AgentsIa.tsx)
// and Automates (Vincent 2026-10-30): two lists one at a time, « Utilisateurs »
// (what was said where the work is done) and « Développeur » (the notes for the
// next version). Every card leads with who and when; the comment sits in a frame,
// amber for a user, blue for the developer, so the two lists read alike but
// never mix up; what it is about is a context line at the bottom.

import type { ComponentType, ReactNode } from 'react'
import { ArrowRight, MessageSquare, MessagesSquare, NotebookPen, User } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import { fmtDateHeure, ilYA } from './commun'

interface Auteur { id: number; nom: string }

export type VueRetours = 'utilisateurs' | 'developpeur'

const VUES: Array<{ key: VueRetours; label: string; icon: ComponentType<{ className?: string }> }> = [
  { key: 'utilisateurs', label: 'Utilisateurs', icon: User },
  { key: 'developpeur', label: 'Développeur', icon: NotebookPen },
]

/** The two lists' switch, each with its count (null while loading). */
export function VueRetoursBoutons({ vue, onChange, nombres }: {
  vue: VueRetours
  onChange: (v: VueRetours) => void
  nombres: Record<VueRetours, number> | null
}) {
  return (
    <div className="flex items-center gap-1">
      {VUES.map((v) => {
        const Icon = v.icon
        return (
          <button key={v.key} type="button" onClick={() => onChange(v.key)}
            className={cn('inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded-md transition-colors',
              vue === v.key ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10')}>
            <Icon className="h-3.5 w-3.5" />{v.label}
            {nombres && <span className="tabular-nums opacity-70">{nombres[v.key]}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** One card: its entries (who, when, what), then what it is about. With
 *  `onOpen`, the whole card opens it (Agents IA: the run). */
export function CarteRetour({ contexte, onOpen, children }: { contexte?: ReactNode; onOpen?: () => void; children: ReactNode }) {
  return (
    <div onClick={onOpen} title={onOpen ? 'Ouvrir l’exécution' : undefined}
      className={cn('group rounded-lg border border-border/60 bg-card shadow-sm px-4 py-3.5 space-y-3 transition-colors',
        onOpen && 'cursor-pointer hover:border-accent/50')}>
      {children}
      {contexte && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0 pl-10">
          <ArrowRight className="h-3 w-3 flex-shrink-0" />
          <span className={cn('truncate', onOpen && 'group-hover:underline')}>{contexte}</span>
        </p>
      )}
    </div>
  )
}

/** Who and when (avatar, name, « il y a 2 h »), then the content under it. */
export function EntreeRetour({ par, le, actions, className, children }: {
  par: Auteur; le: string
  /** Right of the name (Automates: delete one's own retour). */
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2 min-w-0">
        <Avatar className="h-8 w-8 text-xs" fallback={initialesNom(par.nom)} alt={par.nom} />
        <p className="min-w-0 truncate text-sm">
          <span className="font-semibold">{par.nom}</span>
          <span className="text-muted-foreground" title={fmtDateHeure(le)}> · {ilYA(le)}</span>
        </p>
        {actions && <span className="ml-auto flex-shrink-0">{actions}</span>}
      </div>
      <div className="space-y-2 pl-10">{children}</div>
    </div>
  )
}

/** A user's comment: the amber frame. */
export function CommentaireUtilisateur({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 rounded-md border-l-2 border-l-accent/60 bg-accent/[0.04] px-2.5 py-1.5">
      <MessageSquare className="h-3.5 w-3.5 text-accent flex-shrink-0 mt-0.5" />
      <p className="text-sm whitespace-pre-wrap">{children}</p>
    </div>
  )
}

/** A developer note: the same frame, in blue. */
export function NoteDev({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 rounded-md border-l-2 border-l-sky-500/60 bg-sky-500/[0.05] px-2.5 py-1.5">
      <NotebookPen className="h-3.5 w-3.5 text-sky-600 flex-shrink-0 mt-0.5" />
      <p className="text-sm whitespace-pre-wrap">{children}</p>
    </div>
  )
}

export function SousTitreRetours({ children }: { children: ReactNode }) {
  return <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold pt-2">{children}</p>
}

export function VideRetours({ texte }: { texte: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
      <MessagesSquare className="h-10 w-10 mb-2 opacity-40" />
      <p className="text-sm">{texte}</p>
    </div>
  )
}

/** « Vincent Malterre » → « VM ». */
export const initialesNom = (nom: string) =>
  nom.split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m.charAt(0)).join('').toUpperCase() || '?'
