import type { SVGProps } from 'react'

/** Outlined fabric-roll silhouette — a "tombé de métier" écru (greige) roll
 *  lying on the fabric it unrolls. Visually distinct from `FiniRollIcon`
 *  (filled) so finished and unfinished rolls stay apart at a glance.
 *
 *  Drawn in Lucide's grammar (24 grid, stroke 2, round caps, currentColor) so
 *  it carries the same weight as the icons around it — the old CSS-masked
 *  `public/icons/tm.png` had a ~12 px line on a 680 px image, a hairline once
 *  shrunk to 16 px:
 *
 *    <TmRollIcon className="h-4 w-4 text-muted-foreground" />
 */
export function TmRollIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/* Roll end, with its core */}
      <ellipse cx="6" cy="9" rx="3.5" ry="5" />
      <ellipse cx="6" cy="9" rx="1" ry="1.5" />
      {/* Roll body: top edge, far end, bottom edge */}
      <path d="M6 4h12a3.5 5 0 0 1 0 10H6" />
      {/* Fabric unrolled under it */}
      <path d="M9 14l-1.5 5.5H21l1.5-5.5" />
    </svg>
  )
}
