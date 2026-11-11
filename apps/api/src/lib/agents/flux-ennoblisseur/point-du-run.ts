// The question a reply to the Point answers: our « Point du JJ/MM » as it was
// sent, its §2 (contrôles) and §5 (délais) lines. What a person is shown beside
// the reply Tricobot read, where the work is done (Tricobot's take-over in
// Sous-traitants › Ennoblissement and Qualité › Suivi lots, routes/tricobot-saisies.ts)
// and in Agents IA (a Délais / Contrôles run's dialog, routes/agents-ia.ts).

import { mpsPg } from '../../mps-pg.js'
import { SECTIONS } from '../../point-sst/regles.js'

export interface LigneQuestion { commande: string; idligne: number; article: string; commentaire: string }
export interface SectionQuestion { titre: string; lignes: LigneQuestion[] }

export interface PointQuestion {
  jour: string
  envoyeLe: string | null
  envoyePar: string | null
  sujet: string
  /** §5 at the top level: the Délais shape of 2026-11-05. */
  titre: string
  lignes: LigneQuestion[]
  sections: { 2: SectionQuestion; 5: SectionQuestion }
}

/** Our Point a reply answers: when it left, and its §2 (contrôles) and §5 (délais) lines. */
export async function pointDuRun(idpoint: number): Promise<PointQuestion | null> {
  const sql = mpsPg()
  const [p] = await sql<{ jour: string; envoye_le: Date | null; envoye_par_nom: string | null; sujet: string }[]>`
    SELECT to_char(jour, 'YYYY-MM-DD') AS jour, envoye_le, envoye_par_nom, sujet FROM point_sst WHERE idpoint_sst = ${idpoint}`
  if (!p) return null
  const lignes = await sql<{ section: number; commande: string; reference: string; coloris: string; idligne: number; commentaire: string }[]>`
    SELECT section, commande, reference, coloris, idligne_commande_sous_traitant AS idligne, commentaire
    FROM point_sst_ligne WHERE idpoint_sst = ${idpoint} AND section IN (2, 5) AND NOT retiree ORDER BY section, ordre`
  const section = (n: 2 | 5): SectionQuestion => ({
    titre: SECTIONS.find((x) => x.n === n)!.titre,
    lignes: lignes.filter((l) => Number(l.section) === n).map((l) => ({
      commande: String(l.commande).trim(),
      idligne: Number(l.idligne) || 0,
      article: [l.reference, l.coloris].map((x) => String(x ?? '').trim()).filter(Boolean).join(' - '),
      commentaire: String(l.commentaire ?? '').trim(),
    })),
  })
  const s5 = section(5)
  return {
    jour: p.jour,
    envoyeLe: p.envoye_le ? new Date(p.envoye_le).toISOString() : null,
    envoyePar: p.envoye_par_nom,
    sujet: p.sujet,
    titre: s5.titre,
    lignes: s5.lignes,
    sections: { 2: section(2), 5: s5 },
  }
}
