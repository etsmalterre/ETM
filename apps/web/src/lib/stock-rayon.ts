// Physical (« en rayon ») yarn stock projection for Fils › Références ›
// Stock & conso (2026-10-07): the stock on the shelf falls at the consumption
// rate and steps up on each pending delivery's expected date. Answers « must I
// chase a pending order? » — the « disponible » line answers « when must I
// order? » and counts ordered yarn as if it were already here.
//
// Reserved yarn is NOT deducted: it leaves the shelf through knitting, which
// the consumption rate already measures — deducting it too would count it twice.

export interface LivraisonAttendue {
  id: number
  kg: number
  /** Weeks from today when it is expected (0 = today: late or no promise). */
  arriveeW: number
}

export interface VerdictLivraison {
  id: number
  /** kg left on the shelf just before it arrives. */
  stockAvantKg: number
  /** Week the shelf ran empty before this delivery (null = it did not). */
  ruptureW: number | null
  tone: 'ok' | 'warning' | 'danger'
}

export interface Rayon {
  /** [weeks from today, kg] — vertical steps at deliveries. */
  points: [number, number][]
  verdicts: VerdictLivraison[]
  /** Week the shelf runs empty AFTER the last expected delivery (null = not within the horizon). */
  ruptureFinaleW: number | null
}

export function simulerRayon(input: {
  enStock: number
  /** kg per week */
  rate: number
  livraisons: LivraisonAttendue[]
  horizon: number
  /** Safety margin in weeks: arriving with less shelf stock than that is a warning. */
  marge: number
}): Rayon {
  const { rate, horizon, marge } = input
  const livraisons = [...input.livraisons].sort((a, b) => a.arriveeW - b.arriveeW)
  let t = 0
  let s = Math.max(0, input.enStock)
  let zeroAt: number | null = s <= 0 ? 0 : null
  const points: [number, number][] = [[0, s]]
  const verdicts: VerdictLivraison[] = []

  // Falls from (t, s) to week `to`; records the moment it touches zero.
  const descendre = (to: number) => {
    if (to <= t) return
    if (s > 0 && rate > 0) {
      const tz = t + s / rate
      if (tz < to) {
        points.push([tz, 0])
        zeroAt = tz
        s = 0
      } else {
        s -= rate * (to - t)
      }
    }
    points.push([to, s])
    t = to
  }

  for (const l of livraisons) {
    const at = Math.max(0, Math.min(l.arriveeW, horizon))
    descendre(at)
    const ruptureW = s <= 0 && rate > 0 ? zeroAt : null
    const semainesAvant = rate > 0 ? s / rate : Infinity
    verdicts.push({
      id: l.id,
      stockAvantKg: s,
      ruptureW,
      tone: ruptureW != null ? 'danger' : semainesAvant < marge ? 'warning' : 'ok',
    })
    s += l.kg
    zeroAt = null
    points.push([at, s])
  }

  descendre(horizon)
  return { points, verdicts, ruptureFinaleW: zeroAt }
}
