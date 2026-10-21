// Jauge and Diamètre of the circular-knit écru (ref_ecru) and of its trial
// samples (ref_echantillon): both tables store them as the same legacy ordinals.
// Imported RELATIVELY (TRM renders these screens through `@etm`).

// Both Jauge and Diamètre are stored on ref_ecru as 1-based ordinals indexing
// legacy combo lists, with index 1 = "_" placeholder and -1/0/null = unset.
// Display the mapped value, never the raw ordinal.
//
// Jauge (gtaJauge) = needles-per-inch — a plain number, NO inch unit.
export const JAUGE_OPTIONS: { ord: number; label: string }[] = [
  { ord: 2, label: '14' },
  { ord: 3, label: '18' },
  { ord: 4, label: '20' },
  { ord: 5, label: '28' },
]
// Diamètre (gtaDiametreMachine) = machine diameter in inches (shown with ").
export const DIAM_OPTIONS: { ord: number; label: string }[] = [
  { ord: 2, label: '26"' },
  { ord: 3, label: '30"' },
]
const ordLabel = (options: { ord: number; label: string }[]) => (ord: number | null | undefined): string | null => {
  if (ord == null) return null
  if (ord === 1) return '_'
  return options.find((o) => o.ord === ord)?.label ?? null
}
export const jaugeLabel = ordLabel(JAUGE_OPTIONS)
export const diametreLabel = ordLabel(DIAM_OPTIONS)
