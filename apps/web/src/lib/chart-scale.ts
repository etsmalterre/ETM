// Axis scaling shared by the dashboard's hand-rolled SVG charts, so every one
// of them ticks at the same kind of round number.

/** Round the raw step up to 1/2/5 × a power of ten. */
export function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1)))
  const norm = raw / mag
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
}

/** Round tick step so the axis reads 0 / 200 k€ / 400 k€ rather than 173 k€. */
export function niceScale(min: number, max: number): { lo: number; hi: number; ticks: number[] } {
  const lo0 = Math.min(0, min)
  const hi0 = Math.max(0, max)
  if (hi0 === lo0) return { lo: 0, hi: 1, ticks: [0] }
  const step = niceStep((hi0 - lo0) / 4)
  const lo = Math.floor(lo0 / step) * step
  const hi = Math.ceil(hi0 / step) * step
  const ticks: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v))
  return { lo, hi, ticks }
}
