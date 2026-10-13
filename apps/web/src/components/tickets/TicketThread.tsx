// Ticket detail — the conversation with the team (widget v1.4.0).
//
// The reporter's messages sit on the right, the team's on the left. While the
// ticket waits on the reporter (`en_attente`), the team's latest message IS
// the question: purple like the status chip, labelled as a question to them,
// with the answer box right under it. The tracker moves the ticket back to
// `en_cours` (and stops its reminder mails) when the answer lands — the
// widget never writes a status. A closed ticket keeps the thread readable but
// takes no more answers.

import { useEffect, useRef, useState } from 'react'
import { Hourglass, Loader2, Lock, MessagesSquare, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Ticket } from './types'
import { isClosedStatus } from './types'

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function TicketThread({
  ticket,
  onSend,
}: {
  ticket: Ticket
  /** Posts through the proxy and takes the returned ticket in (detail view,
   *  list cache, read state). Throws with a displayable message. */
  onSend: (body: string) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const waiting = ticket.status === 'en_attente'
  const closed = isClosedStatus(ticket.status)
  const messages = ticket.messages
  const lastTeam = messages.map((m) => m.author).lastIndexOf('team')

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [messages.length])

  const send = async () => {
    const body = draft.trim()
    if (!body || sending) return
    setSending(true)
    setError(null)
    setNote(null)
    try {
      await onSend(body)
      setDraft('')
      // The status chip just moved under them: say why.
      setNote(waiting ? "Réponse envoyée : l'équipe reprend votre ticket." : 'Message envoyé.')
    } catch (err) {
      setError(err instanceof Error ? err.message : "Le message n'a pas pu être envoyé.")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
        <MessagesSquare className="h-3 w-3" />
        Échanges avec l'équipe
      </p>

      {messages.length === 0 && waiting && ticket.waiting_for ? (
        // A ticket put on hold before the tracker posted questions in the thread.
        <QuestionBubble author="L'équipe" body={ticket.waiting_for} />
      ) : messages.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">
          {closed ? 'Aucun échange sur ce ticket' : "Aucun échange pour l'instant"}
        </p>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto scrollbar-transparent p-0.5">
          {messages.map((m, i) =>
            waiting && i === lastTeam ? (
              <QuestionBubble
                key={m.id}
                author={m.author_name || "L'équipe"}
                body={m.body}
                at={m.created_at}
              />
            ) : (
              <div
                key={m.id}
                className={cn('flex', m.author === 'reporter' ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[85%] rounded-md border px-3 py-2',
                    m.author === 'reporter'
                      ? 'bg-accent/[0.06] border-accent/30'
                      : 'bg-muted/50',
                  )}
                >
                  <p className="text-[10px] text-muted-foreground mb-0.5">
                    {m.author === 'reporter' ? 'Vous' : m.author_name || "L'équipe"} ·{' '}
                    {formatDateTime(m.created_at)}
                  </p>
                  <p className="text-sm whitespace-pre-line">{m.body}</p>
                </div>
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>
      )}

      {closed ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="h-3 w-3" />
          Ticket clôturé : la conversation est en lecture seule.
        </p>
      ) : (
        <div
          className={cn(
            'rounded-md border p-2 space-y-2',
            // Waiting: the box is the call to action — same purple as the chip.
            waiting ? 'border-purple-300 ring-1 ring-purple-200 bg-purple-50/40' : 'border-input',
          )}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send()
            }}
            rows={3}
            maxLength={5000}
            autoFocus={waiting}
            autoComplete="off"
            placeholder={waiting ? "Votre réponse à l'équipe…" : "Écrire à l'équipe…"}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          />
          <div className="flex items-center justify-between gap-2">
            <p className={cn('text-[11px]', error ? 'text-destructive' : 'text-muted-foreground')}>
              {error ?? note ?? 'Ctrl + Entrée pour envoyer'}
            </p>
            <Button size="sm" onClick={send} disabled={sending || !draft.trim()}>
              {sending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5 mr-1" />
              )}
              {waiting ? 'Répondre' : 'Envoyer'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** The open question, labelled as a question TO the user — whose wait it is. */
function QuestionBubble({ author, body, at }: { author: string; body: string; at?: string }) {
  return (
    <div className="rounded-md border border-purple-200 bg-purple-50 px-3 py-2">
      <p className="flex items-center gap-1 text-[10px] font-semibold text-purple-800 mb-0.5">
        <Hourglass className="h-3 w-3" />
        Question de {author} — en attente de votre réponse
        {at ? <span className="font-normal text-purple-700/80"> · {formatDateTime(at)}</span> : null}
      </p>
      <p className="text-sm whitespace-pre-line">{body}</p>
    </div>
  )
}
