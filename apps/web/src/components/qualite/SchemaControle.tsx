// What each control of a lot measures, drawn on a piece of knit (LIVA #1332,
// from Vincent's sketch 2026-11-02): shown on hover of the gauges in
// Qualité › Suivi lots › Contrôles. The stitches are little « v », as a knit is
// drawn by hand; the gold arrow is what the figure measures; a dashed outline is
// the tirelle before washing.

export type SchemaKind = 'laize' | 'poids' | 'stabH' | 'stabL' | 'vrillage' | 'coloris'

const LEGENDES: Record<SchemaKind, { titre: string; texte: string }> = {
  laize: { titre: 'Laize', texte: 'Largeur du tissu, en cm.' },
  poids: { titre: 'Poids', texte: 'Masse d’un mètre carré de tissu, en g/m².' },
  stabH: { titre: 'Stabilité hauteur', texte: 'Retrait dans la hauteur après lavage, en % (négatif = le tissu rétrécit).' },
  stabL: { titre: 'Stabilité largeur', texte: 'Retrait dans la largeur après lavage, en % (négatif = le tissu rétrécit).' },
  vrillage: { titre: 'Vrillage', texte: 'Les colonnes de mailles se décalent sur le côté entre le haut et le bas de la tirelle. Conforme jusqu’à 5 %.' },
  // No sentence: the hover already names the rond 0 and lists the last lots (Vincent 2026-11-02).
  coloris: { titre: 'Coloris', texte: '' },
}

// Fabric box in the 160 × 120 view.
const X0 = 35, X1 = 125, Y0 = 18, Y1 = 92
const COLS = 5, ROWS = 4

/** One stitch « v » centred on (x, y). */
function v(x: number, y: number) {
  return `M${x - 3.5},${y - 2.5} L${x},${y + 2.5} L${x + 3.5},${y - 2.5}`
}

/** Stitches over a box; `dx(y)` / `dy(x)` slant the columns / rows. */
function mailles(x0: number, x1: number, y0: number, y1: number, dx = (_y: number) => 0, dy = (_x: number) => 0) {
  const out: string[] = []
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const x = x0 + ((c + 0.5) * (x1 - x0)) / COLS
      const y = y0 + ((r + 0.5) * (y1 - y0)) / ROWS
      out.push(v(x + dx(y), y + dy(x)))
    }
  }
  return out.join(' ')
}

/** A double-headed arrow from (x1, y1) to (x2, y2). */
function Fleche({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const a = Math.atan2(y2 - y1, x2 - x1)
  const tete = (x: number, y: number, ang: number) =>
    `M${x + 5 * Math.cos(ang + 0.5)},${y + 5 * Math.sin(ang + 0.5)} L${x},${y} L${x + 5 * Math.cos(ang - 0.5)},${y + 5 * Math.sin(ang - 0.5)}`
  return (
    <g className="stroke-amber-600" strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round">
      <line x1={x1} y1={y1} x2={x2} y2={y2} />
      <path d={tete(x1, y1, a)} />
      <path d={tete(x2, y2, a + Math.PI)} />
    </g>
  )
}

const tissu = 'fill-primary/[0.06] stroke-primary'
const maille = 'stroke-primary/70'

function Dessin({ kind }: { kind: SchemaKind }) {
  switch (kind) {
    case 'laize':
      return (
        <>
          <rect x={X0} y={Y0} width={X1 - X0} height={Y1 - Y0} className={tissu} strokeWidth={1.5} rx={1} />
          <path d={mailles(X0, X1, Y0, Y1)} className={maille} fill="none" strokeWidth={1.2} />
          <Fleche x1={X0} y1={Y1 + 12} x2={X1} y2={Y1 + 12} />
        </>
      )
    case 'poids':
      return (
        <>
          <rect x={X0 + 12} y={Y0} width={Y1 - Y0} height={Y1 - Y0} className={tissu} strokeWidth={1.5} rx={1} />
          <path d={mailles(X0 + 12, X0 + 12 + (Y1 - Y0), Y0, Y1)} className={maille} fill="none" strokeWidth={1.2} />
          <text x={X0 + 12 + (Y1 - Y0) / 2} y={Y1 + 16} textAnchor="middle" className="fill-amber-700 text-[11px] font-semibold">1 m² → g</text>
        </>
      )
    case 'stabL': {
      const x1 = X1 - 14
      return (
        <>
          <rect x={X0} y={Y0} width={X1 - X0} height={Y1 - Y0} className="fill-none stroke-zinc-400" strokeDasharray="3 3" strokeWidth={1.2} />
          <rect x={X0} y={Y0} width={x1 - X0} height={Y1 - Y0} className={tissu} strokeWidth={1.5} rx={1} />
          <path d={mailles(X0, x1, Y0, Y1)} className={maille} fill="none" strokeWidth={1.2} />
          <Fleche x1={x1} y1={Y1 + 12} x2={X1} y2={Y1 + 12} />
        </>
      )
    }
    case 'stabH': {
      const y1 = Y1 - 14
      return (
        <>
          <rect x={X0} y={Y0} width={X1 - X0} height={Y1 - Y0} className="fill-none stroke-zinc-400" strokeDasharray="3 3" strokeWidth={1.2} />
          <rect x={X0} y={Y0} width={X1 - X0} height={y1 - Y0} className={tissu} strokeWidth={1.5} rx={1} />
          <path d={mailles(X0, X1, Y0, y1)} className={maille} fill="none" strokeWidth={1.2} />
          <Fleche x1={X1 + 12} y1={y1} x2={X1 + 12} y2={Y1} />
        </>
      )
    }
    case 'vrillage': {
      // The columns lean: bottom shifted right of the top by `d`.
      const d = 16
      const dx = (y: number) => ((y - Y0) / (Y1 - Y0)) * d
      return (
        <>
          <path d={`M${X0},${Y0} L${X1},${Y0} L${X1 + d},${Y1} L${X0 + d},${Y1} Z`} className={tissu} strokeWidth={1.5} strokeLinejoin="round" />
          <path d={mailles(X0, X1, Y0, Y1, dx)} className={maille} fill="none" strokeWidth={1.2} />
          {/* where the last column should end */}
          <line x1={X1} y1={Y0} x2={X1} y2={Y1 + 8} className="stroke-zinc-400" strokeDasharray="3 3" strokeWidth={1.2} />
          <Fleche x1={X1} y1={Y1 + 12} x2={X1 + d} y2={Y1 + 12} />
        </>
      )
    }
    case 'coloris':
      return (
        <>
          <circle cx={50} cy={55} r={24} className="fill-zinc-300 stroke-primary" strokeWidth={1.5} />
          <circle cx={110} cy={55} r={24} className="fill-zinc-200 stroke-primary" strokeWidth={1.5} />
          <text x={50} y={97} textAnchor="middle" className="fill-muted-foreground text-[10px]">rond 0</text>
          <text x={110} y={97} textAnchor="middle" className="fill-muted-foreground text-[10px]">ce lot</text>
          <Fleche x1={72} y1={55} x2={88} y2={55} />
        </>
      )
  }
}

/** The tooltip body: drawing + one sentence. */
export function SchemaControle({ kind }: { kind: SchemaKind }) {
  const l = LEGENDES[kind]
  return (
    <div className="w-[190px] py-1">
      <p className="text-xs font-semibold mb-1">{l.titre}</p>
      <svg viewBox="0 0 160 120" className="w-full h-auto" aria-hidden>
        <Dessin kind={kind} />
      </svg>
      {l.texte && <p className="text-[11px] font-normal text-muted-foreground leading-snug whitespace-normal">{l.texte}</p>}
    </div>
  )
}
