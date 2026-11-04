// Agent « BL Ennoblisseur »: the BLs Tricobot read for one sst order line, as
// the réception dialog shows them (LIVA #1347, 2026-11-04): the PDF next to the
// rolls, and for a BL he did NOT write (a blocking check), his reasoning.
//
// A blocked BL writes nothing into data_bl_tricotbot, so the réception's
// Tricobot used to answer « aucun rouleau correspondant » while the agent knew
// exactly which BL it was and why it stopped. This reads the agent's runs and
// hands the réception that reasoning, so the person types the rolls by hand
// knowingly. It never unblocks nor writes anything (decision Vincent: a
// blocked BL stays the human's).
//
// Pure: the runs are given (tests: bls-ligne.test.ts).

import type { AgentRun } from './store.js'

/** A BL Tricobot read for this line. */
export interface BlLu {
  runId: string
  /** When the agent read it (ISO). */
  luLe: string
  /** Dyer's name (« MATEL »), null on old runs without a profile. */
  ennoblisseur: string | null
  /** As printed (« 109547A »), '' when unreadable. */
  bordereau: string
  commande: string
  /** Left to a person: a blocking check stopped it, nothing was written. */
  bloque: boolean
  /** The blocking checks, in the agent's words (empty when written). */
  motifs: string[]
  /** The pieces as Tricobot read them, in the BL's order. */
  pieces: Array<{ numero: string; poids: number | null; metrage: number | null; observations: string }>
  /** The PDFs of the run, by their index in the run (GET …/bl-pdf). */
  fichiers: Array<{ n: number; nom: string }>
}

const NOMS_PROFIL: Record<string, string> = { matel: 'MATEL', bontemps: 'Bontemps', tad: 'TAD' }

interface ResultatLu {
  profil?: string | null
  extraction?: {
    numero_bordereau?: string
    numero_commande?: string
    pieces?: Array<{ numero_piece?: string; poids?: number | null; metrage?: number | null; observations?: string | null }>
  } | null
  resolution?: { ligneId?: number | null; lignes?: number[] | null } | null
  controles?: Array<{ gravite?: string; message?: string }> | null
}

/** The run concerns this order line. */
export const runSurLaLigne = (r: AgentRun, ligneId: number): boolean => {
  const res = (r.resultat ?? {}) as unknown as ResultatLu
  return res.resolution?.ligneId === ligneId || (res.resolution?.lignes ?? []).includes(ligneId)
}

/** Still blocked: « à vérifier », or one a pilot marked checked (still not written). */
const estBloque = (r: AgentRun) =>
  r.statut === 'a_verifier' || (r.statut === 'verifie' && r.verification?.statutAvant === 'a_verifier')

/** Statuses of a BL that was read whole (blocked, written, simulated, already imported). */
const estBlLu = (r: AgentRun) =>
  estBloque(r) || r.statut === 'ecrit' || r.statut === 'deja_importe' || r.statut === 'simule'

const cleBordereau = (b: string | undefined) => (b ?? '').toUpperCase().replace(/\s+/g, '')

/** The BLs read for this order line, newest first, one per bordereau (its
 *  latest reading: a bordereau a later run wrote is no longer blocked). */
export function blsDeLigne(runs: readonly AgentRun[], ligneId: number): BlLu[] {
  const vus = new Set<string>()
  const out: BlLu[] = []
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]
    if (!runSurLaLigne(r, ligneId) || !estBlLu(r)) continue
    const res = (r.resultat ?? {}) as unknown as ResultatLu
    const cle = cleBordereau(res.extraction?.numero_bordereau) || `run:${r.id}`
    if (vus.has(cle)) continue
    vus.add(cle)
    const bloque = estBloque(r)
    const motifs = bloque
      ? (res.controles ?? [])
          .filter((c) => c.gravite === 'bloquant' && (c.message ?? '').trim())
          .map((c) => (c.message ?? '').trim())
      : []
    out.push({
      runId: r.id,
      luLe: r.createdAt,
      ennoblisseur: res.profil ? NOMS_PROFIL[res.profil] ?? res.profil : null,
      bordereau: (res.extraction?.numero_bordereau ?? '').trim(),
      commande: (res.extraction?.numero_commande ?? '').trim(),
      bloque,
      motifs: bloque && motifs.length === 0 ? ['BL laissé à vérifier.'] : motifs,
      pieces: (res.extraction?.pieces ?? []).map((p) => ({
        numero: (p.numero_piece ?? '').trim(),
        poids: p.poids ?? null,
        metrage: p.metrage ?? null,
        observations: (p.observations ?? '').trim(),
      })),
      fichiers: (r.fichiers ?? []).map((f, n) => ({ n, nom: f.nom })),
    })
  }
  return out
}
