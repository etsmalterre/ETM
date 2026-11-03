// Is this tablet the enrolled lab tablet?
//
// The real identity of the station: a secret the server issued once against a
// code typed in Paramètres › Utilisateurs › Appareils, carried in the tablet's
// own `mps_tirelle` cookie. The server refuses every read and write from a
// tablet it does not know, so the whole app sits behind this answer (main.tsx).
//
// Mirrored in localStorage so a cold start on a dropped network still opens on
// the lab; the app's poll picks up a revocation within seconds.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchAppareil, type Appareil } from '@/lib/tirelle-api'

const CLE = 'tirelle.appareil'
export const APPAREIL_QUERY_KEY = ['tirelle', 'appareil'] as const

interface Ctx {
  /** undefined = not known yet (first launch); null = not enrolled or revoked. */
  appareil: Appareil | null | undefined
  /** Re-ask the server now (after an enrolment). */
  rafraichir: () => Promise<void>
}

const AppareilContext = createContext<Ctx | null>(null)

function lire(): Appareil | null | undefined {
  try {
    const raw = localStorage.getItem(CLE)
    if (raw === null) return undefined
    if (raw === 'null') return null
    const p = JSON.parse(raw) as Partial<Appareil>
    return typeof p?.id === 'number' ? { id: p.id, libelle: String(p.libelle ?? '') } : undefined
  } catch {
    return undefined
  }
}

function ecrire(a: Appareil | null): void {
  try {
    localStorage.setItem(CLE, JSON.stringify(a))
  } catch {
    /* storage disabled — the server is asked again next launch */
  }
}

export function AppareilProvider({ children }: { children: ReactNode }) {
  // Read synchronously: a default settled in an effect would flash the
  // « not enrolled » screen at every launch of an enrolled tablet.
  const [cache, setCache] = useState<Appareil | null | undefined>(lire)
  const qc = useQueryClient()
  const query = useQuery({ queryKey: APPAREIL_QUERY_KEY, queryFn: fetchAppareil })
  const data = query.data

  useEffect(() => {
    if (data === undefined) return
    setCache(data)
    ecrire(data)
  }, [data])

  const appareil = data !== undefined ? data : query.isError ? (cache ?? null) : cache

  const rafraichir = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: APPAREIL_QUERY_KEY })
  }, [qc])

  return <AppareilContext.Provider value={{ appareil, rafraichir }}>{children}</AppareilContext.Provider>
}

export function useAppareil(): Ctx {
  const ctx = useContext(AppareilContext)
  if (!ctx) throw new Error('useAppareil must be used inside <AppareilProvider>')
  return ctx
}
