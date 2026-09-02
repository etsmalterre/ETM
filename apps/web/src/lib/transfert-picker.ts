// Selection rules of the transfer picker (Transferts › Rouleaux / Fils,
// « Éditer le bon de transfert »). Pure, so they can be pinned by a test.
//
// LIVA #1120: the ticked set used to survive every change of search, chip or
// tab filter, while the footer counted the whole set and Valider posted it.
// Tick 58 rolls under one search, narrow to another, tick 13 more: the screen
// shows 13 ticks, the footer says 71, and Valider moves 71 pieces — 58 of them
// the user could no longer see. The invariant is now: the selection of a tab
// is always a subset of the rows that tab currently displays.

/** Intersect a tab's selection with the ids it currently renders. Returns the
 *  SAME Set instance when nothing has to go, so a React state setter can bail
 *  out without a re-render. */
export function pruneSelection(selected: ReadonlySet<number>, visibleIds: Iterable<number>): Set<number> {
  const visible = visibleIds instanceof Set ? visibleIds : new Set(visibleIds)
  let changed = false
  for (const id of selected) if (!visible.has(id)) { changed = true; break }
  if (!changed) return selected as Set<number>
  const next = new Set<number>()
  for (const id of selected) if (visible.has(id)) next.add(id)
  return next
}

/** Footer wording for what Valider will post: the active tab's count plus the
 *  share ticked on the other tabs, which the user is not looking at. */
export function queuedSummary(
  active: { count: number; poids: number },
  others: Array<{ label: string; count: number; poids: number }>,
  fmtKg: (v: number) => string,
): string {
  const count = active.count + others.reduce((s, o) => s + o.count, 0)
  const poids = active.poids + others.reduce((s, o) => s + o.poids, 0)
  const parts = others.filter((o) => o.count > 0).map((o) => `${o.count} sur ${o.label}`)
  const dont = parts.length > 0 ? `, dont ${parts.join(' et ')}` : ''
  return `${count} à ajouter (${fmtKg(poids)} kg)${dont}`
}
