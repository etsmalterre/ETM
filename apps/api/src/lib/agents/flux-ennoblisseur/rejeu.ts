// Flux Ennoblisseur › replay a draft prompt before publishing it (Agents IA ›
// Prompt › « Rejouer », doctrine §0): the last executions of a skill are read
// again with the draft, decided by the same code (deciderDelais /
// deciderControles), and NOTHING is written: no run, no saisie, no line.
// Each point is set against what the version in service decided and against
// what a person kept (saisie_agent), so a pilot sees what the draft changes
// before its measures restart.
//
// Decided on today's data: a line dated since reads « déjà ce délai », a lot
// validated since is left alone. The value read is what the comparison is on.

import { mpsPg } from '../../mps-pg.js'
import type { AgentRun, AgentVersion } from '../store.js'
import type { StatutPoint } from '../competences.js'
import { deciderControles, deciderDelais, type ControleRapproche, type PointDelai, type ResultatFlux } from './delais.js'
import { lireMesures, saisiesDeRuns, texteMesures, type MesuresSst, type Saisie } from './saisies.js'

export const REJEU_MAX = 20

type Decision = 'saisie' | 'aide' | 'aucune'

export interface CotePoint {
  decision: Decision
  /** Canonical value: 'YYYY-MM-DD' or texteMesures() JSON; null = none. */
  valeur: string | null
  /** The same, for a person (« mer. 18/11 », « laize 156 · poids 166 · h -3 · l -3 »). */
  libelle: string
  explication: string
}

export interface PointRejeu {
  cle: string
  /** « Commande 9012 », « Lot 109579 ». */
  quoi: string
  citation: string
  avant: CotePoint | null
  apres: CotePoint | null
  /** What a person kept for the point (validated, corrected, settled), null when not judged. */
  juge: { statut: StatutPoint; valeur: string | null; libelle: string; par: string | null } | null
  /** identique: same decision and value · change: something differs ·
   *  nouveau / disparu: the point exists on one side only. */
  ecart: 'identique' | 'change' | 'nouveau' | 'disparu'
  /** Against what the person kept: true = the draft reads it, false = it does not, null = nothing to compare. */
  conforme: boolean | null
}

export interface RunRejoue {
  runId: string
  le: string
  sujet: string
  de: string
  version: number
  points: PointRejeu[]
  erreur: string | null
}

export interface Rejeu {
  competence: 'delais' | 'controles'
  runs: RunRejoue[]
  usd: number
  bilan: { points: number; identiques: number; changes: number; juges: number; conformes: number; contraires: number; erreurs: number }
}

const JOURS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.']
const libelleDelai = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${JOURS[new Date(`${iso}T12:00:00Z`).getUTCDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '')
const f = (x: number | null | undefined) => (x == null ? '?' : String(x).replace('.', ','))
const libelleMesures = (m: { [K in keyof MesuresSst]?: number | null } | null) =>
  m ? `laize ${f(m.laize)} · poids ${f(m.poids)} · h ${f(m.stabH)} · l ${f(m.stabL)}${m.vrillage != null ? ` · V ${f(m.vrillage)} %` : ''}` : ''

function coteDelai(p: PointDelai): CotePoint {
  return { decision: p.decision, valeur: p.delai, libelle: libelleDelai(p.delai), explication: p.explication }
}
function coteControle(c: ControleRapproche): CotePoint {
  const lu = { laize: c.laize, poids: c.poids, stabH: c.stabH, stabL: c.stabL, vrillage: c.vrillage }
  const valeur = c.mesures ? texteMesures(c.mesures) : (Object.values(lu).some((x) => x != null) ? JSON.stringify(lu) : null)
  return { decision: c.decision ?? 'aucune', valeur, libelle: libelleMesures(c.mesures ?? lu), explication: c.explication }
}

const cleDelai = (p: Pick<PointDelai, 'commande' | 'idligne'>) => `cmd:${p.commande.replace(/\D/g, '')}:${p.idligne}`
const cleControle = (c: Pick<ControleRapproche, 'lot'>) => `lot:${c.lot}`

/** What a person kept for a point, read from its saisie. */
function jugement(s: Saisie | undefined, competence: 'delais' | 'controles'): PointRejeu['juge'] {
  if (!s || s.statut === 'a_revoir' || s.statut === 'autonome') return null
  // A saisie validated keeps its proposal; deleted / omission keep nothing.
  const valeur = s.statut === 'validee' ? (s.valeurFinale ?? s.proposition) : s.valeurFinale
  const libelle = competence === 'delais' ? libelleDelai(valeur) : libelleMesures(lireMesures(valeur))
  return { statut: s.statut, valeur, libelle, par: s.revuPar }
}

function comparer(avant: CotePoint | null, apres: CotePoint | null, juge: PointRejeu['juge']): Pick<PointRejeu, 'ecart' | 'conforme'> {
  const ecart = !avant ? 'nouveau' : !apres ? 'disparu'
    : avant.decision === apres.decision && (avant.valeur ?? '') === (apres.valeur ?? '') ? 'identique' : 'change'
  let conforme: boolean | null = null
  if (juge) {
    // Nothing should have been written (deleted, or an aide settled with nothing): right when the draft writes nothing.
    if (!juge.valeur) conforme = juge.statut === 'supprimee' || juge.statut === 'resolue' ? (apres?.decision ?? 'aucune') !== 'saisie' : null
    else conforme = !!apres && apres.valeur === juge.valeur
  }
  return { ecart, conforme }
}

/** Replay a draft prompt on these runs (the newest first, at most REJEU_MAX). Writes nothing. */
export async function rejouer(competence: 'delais' | 'controles', runs: readonly AgentRun[], prompt: Pick<AgentVersion, 'model' | 'prompt'>): Promise<Rejeu> {
  const choisis = runs.filter((r) => typeof (r.resultat as Partial<ResultatFlux>).texte === 'string').slice(0, REJEU_MAX)
  const saisies = await saisiesDeRuns(choisis.map((r) => r.id)).catch(() => [] as Saisie[])
  const sql = mpsPg()
  let usd = 0
  const out: RunRejoue[] = []
  // A few at a time: the model's rate limit, and HFSQL reads per line.
  for (let i = 0; i < choisis.length; i += 4) {
    out.push(...await Promise.all(choisis.slice(i, i + 4).map(async (r): Promise<RunRejoue> => {
      const res = r.resultat as Partial<ResultatFlux>
      const base = { runId: r.id, le: r.createdAt, sujet: r.message?.sujet ?? '', de: r.message?.de ?? '', version: r.version }
      const entree = { texte: res.texte ?? '', dateMail: res.dateMail ?? r.message?.date ?? r.createdAt, jourPoint: res.jourPoint ?? null, idpoint: res.idpoint ?? null }
      const juges = new Map<string, Saisie>()
      try {
        let avant: Array<[string, string, string, CotePoint]>
        let apres: Array<[string, string, string, CotePoint]>
        if (competence === 'delais') {
          for (const p of res.delais ?? []) {
            const s = p.saisieId ? saisies.find((x) => x.id === p.saisieId) : undefined
            if (s) juges.set(cleDelai(p), s)
          }
          const d = await deciderDelais(entree, prompt)
          usd += d.usd
          const ligne = (p: PointDelai): [string, string, string, CotePoint] => [cleDelai(p), `Commande ${p.commande}`, p.reponse, coteDelai(p)]
          avant = (res.delais ?? []).filter((p) => p.reponse).map(ligne)
          apres = d.points.filter((p) => p.reponse).map(ligne)
        } else {
          for (const c of res.controles ?? []) {
            const s = c.saisieId ? saisies.find((x) => x.id === c.saisieId) : undefined
            if (s) juges.set(cleControle(c), s)
          }
          const d = await deciderControles(entree, prompt, sql)
          usd += d.usd
          const ligne = (c: ControleRapproche): [string, string, string, CotePoint] => [cleControle(c), `Lot ${c.lotEtm ?? c.lot}`, c.texte, coteControle(c)]
          avant = (res.controles ?? []).map(ligne)
          apres = d.controles.map(ligne)
        }
        const cles = [...new Set([...avant.map((x) => x[0]), ...apres.map((x) => x[0])])]
        const points = cles.map((cle): PointRejeu => {
          const a = avant.find((x) => x[0] === cle)
          const b = apres.find((x) => x[0] === cle)
          const juge = jugement(juges.get(cle), competence)
          return { cle, quoi: (b ?? a)![1], citation: (b ?? a)![2], avant: a?.[3] ?? null, apres: b?.[3] ?? null, juge, ...comparer(a?.[3] ?? null, b?.[3] ?? null, juge) }
        })
        return { ...base, points, erreur: null }
      } catch (e) {
        return { ...base, points: [], erreur: e instanceof Error ? e.message : String(e) }
      }
    })))
  }
  const tous = out.flatMap((r) => r.points)
  return {
    competence,
    runs: out,
    usd,
    bilan: {
      points: tous.length,
      identiques: tous.filter((p) => p.ecart === 'identique').length,
      changes: tous.filter((p) => p.ecart !== 'identique').length,
      juges: tous.filter((p) => p.conforme !== null).length,
      conformes: tous.filter((p) => p.conforme === true).length,
      contraires: tous.filter((p) => p.conforme === false).length,
      erreurs: out.filter((r) => r.erreur).length,
    },
  }
}
