// Automate « Point sous-traitant » — prepares, every working day from 17:00,
// the next working day's « Point du JJ/MM » for each dyer in
// POINT_SST_SOUS_TRAITANTS (MATEL first), and sends the points a person
// scheduled (Sous-traitants › Point, « Programmer l'envoi », 9:00 by default).
// The rules are lib/point-sst/regles.ts; the person checks every line before
// anything leaves — the automate never sends a point nobody scheduled.
//
// Feedback: the Tricobot button on each line of the screen lands in this
// automate's « Retours », with the line it is about (decision Vincent
// 2026-10-05: automates are not scored, their users' remarks are read
// before each new version).

import { partiesParis } from '../../pointage-etat.js'
import { jourSuivantOuvre } from '../../point-sst/regles.js'
import { pointsAEnvoyer, preparerPoint, marquerErreurEnvoi } from '../../point-sst/db.js'
import { envoyerPoint } from '../../point-sst/envoi.js'
import { lireFaits } from '../../point-sst/lecture.js'
import { construirePoint } from '../../point-sst/regles.js'
import { mpsPg } from '../../mps-pg.js'
import type { Issue } from '../catalog.js'

export const SLUG = 'point-sst'
export const VERSION = 2
export const VERSIONS = [
  {
    version: 1,
    date: '2026-10-06',
    note: 'Première version : le point MATEL est préparé chaque jour ouvré à 17 h pour le lendemain, d’après les règles estimées sur les points de Pierre-Emmanuel du 22/09 au 05/10/2026 (sorties à 9 jours, contrôles manquants, soumissions, métrages, délais, études). Chaque ligne dit pourquoi elle est là.',
  },
  {
    version: 2,
    date: '2026-10-06',
    note: 'Corrigée sur le point réellement envoyé par Pierre-Emmanuel le 06/10 : les délais ne sont demandés qu’à la date de relance du bon de commande (bon + 3 jours ouvrés) ; un lot en reprise passe en « délais » avec « reprise » au lieu de « contrôles » ; la section « métrages » n’est plus remplie (l’accord du client sur la soumission et la fin d’un lot n’arrivent que par mail) ; une commande en retard n’apparaît plus.',
  },
] as const

/** Hour (Paris) from which the next point is prepared. */
export const HEURE_PREPARATION = 17

export const sousTraitantsDuPoint = (): number[] =>
  (process.env.POINT_SST_SOUS_TRAITANTS?.trim() || '9').split(',').map((s) => Number.parseInt(s, 10)).filter((n) => n > 0)

const iso = (p: { y: number; mo: number; d: number }) => `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`

const liste = (r: Record<string, unknown>, k: string): unknown[] => (Array.isArray(r[k]) ? (r[k] as unknown[]) : (r[k] = []) as unknown[])

/** The essai proposal is computed once a day, not every minute. */
let essaiDuJour = ''

export async function executer(mode: 'essai' | 'actif', resultat: Record<string, unknown>): Promise<Issue> {
  const maintenant = partiesParis(Date.now())
  const aujourdhui = iso(maintenant)
  const ouvre = ![0, 6].includes(new Date(`${aujourdhui}T12:00:00Z`).getUTCDay())
  const faits: string[] = []
  let applique = false

  // 1. Scheduled sends whose time has come — only « actif » sends.
  const dus = await pointsAEnvoyer()
  if (dus.length > 0) {
    if (mode === 'actif') {
      const envois: unknown[] = []
      for (const d of dus) {
        try {
          const r = await envoyerPoint(d.id, { id: d.par, nom: d.parNom })
          envois.push({ point: d.id, a: r.a, cc: r.cc, essai: r.essai })
          faits.push(`Point ${d.id} envoyé à ${[...r.a, ...r.cc].join(', ')}.`)
          applique = true
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          await marquerErreurEnvoi(d.id, msg)
          envois.push({ point: d.id, erreur: msg })
          faits.push(`Point ${d.id} : envoi impossible — ${msg}`)
          applique = true
        }
      }
      resultat.envois = envois
    } else {
      faits.push(`${dus.length} point(s) programmé(s) attendent : l’automate est en essai, il n’envoie rien.`)
    }
  }

  // 2. From 17:00 on a working day: prepare the next working day's point.
  if (ouvre && maintenant.h >= HEURE_PREPARATION) {
    const jour = jourSuivantOuvre(aujourdhui)
    const sql = mpsPg()
    for (const sst of sousTraitantsDuPoint()) {
      const [existe] = await sql`SELECT idpoint_sst FROM point_sst WHERE idsous_traitant = ${sst} AND jour = ${jour}::date`
      if (existe) continue
      if (mode === 'actif') {
        const r = await preparerPoint(sst, jour, 'automate', VERSION)
        liste(resultat, 'prepares').push({ sousTraitant: sst, jour, point: r.id, lignes: r.ajoutees })
        faits.push(`Point du ${jour.slice(8, 10)}/${jour.slice(5, 7)} préparé (sous-traitant ${sst}, ${r.ajoutees} lignes).`)
        applique = true
      } else if (essaiDuJour !== `${aujourdhui}:${sst}`) {
        essaiDuJour = `${aujourdhui}:${sst}`
        const { lignes, etudes } = await lireFaits(sst, jour)
        const point = construirePoint(jour, lignes, etudes)
        liste(resultat, 'proposes').push({ sousTraitant: sst, jour, lignes: point.map((l) => ({ section: l.section, commande: l.commande, reference: l.reference, coloris: l.coloris, commentaire: l.commentaire, pourquoi: l.pourquoi })) })
        faits.push(`Essai : préparerait le point du ${jour.slice(8, 10)}/${jour.slice(5, 7)} (sous-traitant ${sst}, ${point.length} lignes).`)
        return { statut: 'simule', resume: faits.join(' '), empreinte: `${jour}:${sst}:${point.length}` }
      }
    }
  }

  if (applique) return { statut: 'applique', resume: faits.join(' ') }
  return { statut: 'inchange', resume: faits.join(' ') || 'Rien à faire.' }
}
