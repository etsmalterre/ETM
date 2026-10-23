/** Donut segment between two fractions of the circle, starting at 12 o'clock
 *  and running clockwise. Radii are viewBox units, centre at (0, 0). Shared by
 *  the CA « Répartition » widget and Fils › Stock « Réservations ». */
export function donutPath(from: number, to: number, outer: number, inner: number): string {
  const a0 = from * 2 * Math.PI - Math.PI / 2
  const a1 = to * 2 * Math.PI - Math.PI / 2
  const large = to - from > 0.5 ? 1 : 0
  const p = (a: number, r: number) => `${(Math.cos(a) * r).toFixed(3)},${(Math.sin(a) * r).toFixed(3)}`
  return [
    `M${p(a0, outer)}`,
    `A${outer},${outer} 0 ${large} 1 ${p(a1, outer)}`,
    `L${p(a1, inner)}`,
    `A${inner},${inner} 0 ${large} 0 ${p(a0, inner)}`,
    'Z',
  ].join(' ')
}
