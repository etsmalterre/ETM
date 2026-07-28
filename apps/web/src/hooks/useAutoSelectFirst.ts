import { useEffect } from 'react'
import { useResponsiveLayout } from './useResponsiveLayout'

interface AutoSelectFirstOptions<T> {
  /**
   * The list the selection must stay valid against. **Always pass the
   * search/status-filtered array the left list actually renders**, never the
   * raw query result — passing the raw list is what leaves a stale detail on
   * screen while the list shows a single search hit.
   */
  rows: readonly T[] | undefined
  selectedId: number | null
  getId: (row: T) => number
  select: (id: number | null) => void
  /** Pause entirely — edit in progress, list refetching, pending auto-edit… */
  suspended?: boolean
}

/**
 * Desktop/compact modes keep the historical behavior: the detail pane sits
 * next to the list, so something must always be selected.
 *
 * Stacked mode (phone) shows either the list OR the detail, so a null
 * selection IS the list view. Auto-selecting there would land the user on
 * the first row's detail and instantly undo the "Retour" button (which sets
 * the selection back to null). In stacked mode this hook never picks a row
 * on its own; when the selection disappears from the list it falls back to
 * null (return to the list) instead of jumping to another row's detail.
 */
export function useAutoSelectFirst<T>({
  rows,
  selectedId,
  getId,
  select,
  suspended = false,
}: AutoSelectFirstOptions<T>) {
  const { isStacked } = useResponsiveLayout()

  // No dep array on purpose: getId/select are inline closures whose identity
  // changes every render, and the body is idempotent (select() with the
  // current value is a no-op), so running after each render is both cheap
  // and always up to date.
  useEffect(() => {
    if (suspended || rows === undefined) return

    if (rows.length === 0) {
      // List settled empty (search with no hits, or the last row left the
      // current filter) — clear the stale selection so the placeholder shows.
      if (selectedId !== null) select(null)
      return
    }
    const stillVisible = selectedId !== null && rows.some((r) => getId(r) === selectedId)
    if (stillVisible) return
    select(isStacked ? null : getId(rows[0]))
  })
}
