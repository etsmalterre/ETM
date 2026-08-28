// Who is at the keyboard of a shared station — a hint a host page may set for
// the ticket widget, e.g. the visiteuse picked on the visitage poste.
//
// A station account (one MPS login for a whole PC) has no mapped email, so the
// proxy files its tickets under a synthetic per-account identity and names the
// reporter after the account: "Visitage". That says which PC, not who — and
// the page usually knows who (the poste makes the person identify herself
// before anything else). The proxy appends the hint to the account name
// ("Isabelle Dupont (Visitage)") and ignores it for a personal account, so
// setting it from a page is always safe.
//
// Module-level store rather than a context: the modal is mounted by the
// Header, far from the page that knows the name, and threading a prop through
// AppShell for one screen would make every layout aware of tickets.

import { useSyncExternalStore } from 'react'

let hint: string | null = null
const listeners = new Set<() => void>()

/** Name the person filing tickets from this browser (null to clear). Call from
 *  an effect and clear on unmount, so leaving the page drops the name. */
export function setTicketReporterHint(name: string | null): void {
  const next = name?.trim() || null
  if (next === hint) return
  hint = next
  for (const l of listeners) l()
}

export function getTicketReporterHint(): string | null {
  return hint
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

export function useTicketReporterHint(): string | null {
  return useSyncExternalStore(subscribe, getTicketReporterHint, () => null)
}
