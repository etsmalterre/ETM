// Lets the active screen publish its own controls into the app header.
//
// The header's left region carries contextual controls for the current screen:
// submenu tabs on screens that have them, and — via this slot — screen-level
// actions on screens that don't. The tableau de bord is the first consumer:
// it has no submenus, so that space is free, and putting its "Personnaliser"
// control there costs zero vertical space AND keeps the edit-mode
// Enregistrer / Annuler buttons pinned (the header is `sticky top-0`) while
// the user scrolls a long dashboard.
//
// Implementation is a DOM portal rather than a ReactNode in state: the header
// hands out the slot element once, and screens render into it with
// createPortal. Storing JSX in context state would need a re-publish on every
// render (JSX identity changes each time), which is a render loop waiting to
// happen.

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface HeaderActionsValue {
  /** The header's slot element, or null before the header has mounted. */
  element: HTMLElement | null
  /** Callback ref the header attaches to its slot div. */
  setElement: (el: HTMLElement | null) => void
}

const HeaderActionsContext = createContext<HeaderActionsValue | null>(null)

export function HeaderActionsProvider({ children }: { children: ReactNode }) {
  const [element, setElementState] = useState<HTMLElement | null>(null)
  // Stable identity so the header's ref callback doesn't detach/reattach on
  // every provider render (which would null the slot for one frame).
  const setElement = useCallback((el: HTMLElement | null) => setElementState(el), [])
  return (
    <HeaderActionsContext.Provider value={{ element, setElement }}>
      {children}
    </HeaderActionsContext.Provider>
  )
}

/** Header-side: the callback ref to put on the slot div. */
export function useHeaderActionsSlot(): (el: HTMLElement | null) => void {
  const ctx = useContext(HeaderActionsContext)
  return ctx?.setElement ?? (() => {})
}

/** Screen-side: render `children` into the header slot.
 *
 *  Renders nothing until the slot exists (embed mode has no header at all, so
 *  the actions simply never appear — the screen must stay usable without them). */
export function HeaderActions({ children }: { children: ReactNode }) {
  const ctx = useContext(HeaderActionsContext)
  if (!ctx?.element) return null
  return createPortal(children, ctx.element)
}
