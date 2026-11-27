// A lab's études coloris, as the espace partenaire shows them (Vincent 2026-11-27: « un menu dans l'espace
// partenaire, en lecture seule d'abord ») — read by GET /api/site/espace/partenaires/:id/etudes
// (routes/webservice-site.ts). The shape is the portal's contract (its packages/api `EtudeApi`), field for field.
//
// Same data and rules as Finis › Études coloris (routes/etudes-coloris.ts) and as the client line waiting for
// its étude (lib/etude-ligne-client.ts, whose `etatEtude` is reused, never re-derived): who holds the étude — the
// lab or the client — since when, and the day Malterre chases (17 days for the lab, 21 for the client, a relance
// restarting each: `SEUILS_ETUDE`). Scoped to ONE sous-traitant: the études that name it as their lab.
//
// ⚠️ The one place of the espace partenaire that names Malterre's CUSTOMER (Vincent 2026-11-27: « ça me dérange
// pas que le partenaire ait le nom du client pour les études coloris »): the lab already has it — the demande
// d'étude it receives prints it, and it posts its samples to the client itself. This exception is the études'
// own: orders and lots still never name a customer (lib/espace-partenaire-commandes.ts).
//
// Shown: the étude's number, the client's name, the fini reference and its designation, the coloris asked (and,
// once accepted, the coloris created), the instruction (`commentaire`: printed on the demande d'étude the lab
// receives), the day the type was received, each soumission (its version, its sample numbers, its day, the
// answer and its day) and the time:
//   - while the lab holds the étude, ITS clock, as ETM runs it (`fenetre`: from the day it holds it — or
//     Malterre's last relance — to the day Malterre chases), in the working days the portal counts in;
//   - while the client holds it, the client's time in words (`attenteReponse`, as on a lot's coloris soumission):
//     never a clock of the lab's.
// Never add: the étude's `journal` (Malterre's own notes), `num_commande` and `desig_client` (the client's order
// and wording, not needed to do the étude), who created, answered or chased, the e-mail recipients, the
// client's address or contacts, a soumission's text beyond its sample numbers, prices. A CANCELLED étude is not
// listed at all (it leaves the lab's list: nothing is expected), nor one accepted more than twelve sliding
// months ago.

import { mpsPg } from './mps-pg.js'
import { etatEtude, type RelanceEtude, type SoumissionEtude } from './etude-ligne-client.js'
import { debutDouzeMois, fenetre, type Fenetre } from './espace-partenaire-commandes.js'
import { parseSampleNumbers } from './pdf/SoumissionPdf.js'

/** Where an étude stands for its lab: its own work (a first soumission to make, or another after a refusal),
 *  the client's answer waited, or accepted. */
export type EtapeEtudePartenaire = 'a_faire' | 'a_refaire' | 'chez_le_client' | 'acceptee'

export interface SoumissionEtudePartenaire {
  id: number
  /** « v1 », « v2 »… as ETM numbers them; '' when it carries none. */
  version: string
  /** The lab's own sample numbers submitted (« 1-2-3 » → [1, 2, 3]). */
  echantillons: number[]
  /** YYYY-MM-DD */
  soumiseLe: string | null
  reponse: 'attente' | 'acceptee' | 'refusee'
  reponduLe: string | null
}

export interface EtudePartenaire {
  /** The number printed on the demande d'étude (IDetude_col). */
  id: number
  etape: EtapeEtudePartenaire
  /** Malterre's customer the étude is for (see the header: the études' own exception). */
  client: string
  reference: string
  designation: string
  /** The coloris asked; once accepted, the coloris created (« 0612 marine 63052/1 »). */
  coloris: string
  /** The instruction printed on the demande d'étude; null when none. */
  consigne: string | null
  /** The day the type to match was received, YYYY-MM-DD. */
  recueLe: string | null
  /** The lab's clock while it holds the étude; null otherwise, or without a date. */
  fenetre: Fenetre | null
  /** Malterre's last relance of the lab on this étude, while it holds it. */
  relanceLe: string | null
  /** While the client's answer is waited: the soumission's day, the day the answer is expected (the soumission,
   *  or Malterre's latest relance of the client, + its 21 days), that relance and how many there were. */
  attenteReponse: { soumisLe: string; reponseAttendueLe: string; relanceLe: string | null; relances: number } | null
  accepteeLe: string | null
  /** Oldest first. */
  soumissions: SoumissionEtudePartenaire[]
}

const str = (v: unknown) => String(v ?? '').trim()
const iso = (ymd: string | null) => (ymd && /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : null)
const ymd = (v: unknown): string | null => {
  const d = String(v ?? '').replace(/\D/g, '').slice(0, 8)
  return /^\d{8}$/.test(d) && d !== '00000000' ? d : null
}

/** An étude's facts, as read. Dates YYYYMMDD (ETM's own, `etatEtude`'s). */
export interface EtudeFaits {
  id: number
  statut: number
  libelle: string
  commentaire: string
  client: string
  reference: string
  designation: string
  /** The coloris the étude points at once accepted. */
  colorisCree: string
  dateReception: string | null
  derniereAction: string | null
  soumissions: (SoumissionEtude & { version: string; observation: string })[]
  relances: RelanceEtude[]
}

/** One étude as its lab reads it, or null when it is not listed (cancelled). `today` YYYY-MM-DD. Pure. */
export function etudePartenaire(e: EtudeFaits, today: string): EtudePartenaire | null {
  const etat = etatEtude({ statut: e.statut, dateReception: e.dateReception, derniereAction: e.derniereAction }, e.soumissions, e.relances)
  if (etat.attente === 'annulee') return null
  const soumissions = [...e.soumissions]
    .sort((a, b) => (a.dateSoum ?? '').localeCompare(b.dateSoum ?? '') || a.id - b.id)
    .map((s): SoumissionEtudePartenaire => ({
      id: s.id,
      version: /^v\d{1,2}$/i.test(s.version) ? s.version.toLowerCase() : '',
      echantillons: parseSampleNumbers(s.observation),
      soumiseLe: iso(s.dateSoum),
      reponse: s.accepte === 1 ? 'acceptee' : s.accepte === 2 ? 'refusee' : 'attente',
      reponduLe: s.accepte === 0 ? null : iso(s.dateReponse),
    }))
  const derniere = soumissions[soumissions.length - 1]
  const base = {
    id: e.id, client: e.client, reference: e.reference, designation: e.designation,
    consigne: e.commentaire || null, recueLe: iso(e.dateReception), soumissions,
  }
  const rien = { fenetre: null, relanceLe: null, attenteReponse: null, accepteeLe: null }
  if (etat.attente === 'acceptee') {
    const acceptee = [...soumissions].reverse().find((s) => s.reponse === 'acceptee')
    return { ...base, ...rien, etape: 'acceptee', coloris: e.colorisCree || e.libelle, accepteeLe: acceptee?.reponduLe ?? iso(e.derniereAction) }
  }
  const depuis = iso(etat.depuis)
  const echeance = iso(etat.relanceLe)
  if (etat.attente === 'client') {
    const soumisLe = iso(etat.attenteDepuis)
    return {
      ...base, ...rien, etape: 'chez_le_client', coloris: e.libelle,
      attenteReponse: soumisLe && echeance
        ? {
            soumisLe, reponseAttendueLe: echeance, relanceLe: iso(etat.derniereRelance),
            relances: e.relances.filter((r) => r.cible === 'client' && (!etat.attenteDepuis || r.le >= etat.attenteDepuis)).length,
          }
        : null,
    }
  }
  return {
    ...base, ...rien, coloris: e.libelle,
    etape: derniere?.reponse === 'refusee' ? 'a_refaire' : 'a_faire',
    // Up on the day itself: the day ETM turns the étude red and chases the lab (lib/urgence-commande-client.ts
    // `urgenceLigne`: due when today >= relanceLe).
    fenetre: depuis && echeance ? fenetre(depuis, echeance, today, true) : null,
    relanceLe: iso(etat.derniereRelance),
  }
}

function aujourdhui(): string {
  const t = new Date()
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

/** The lab's études: those in progress, and those accepted within the twelve sliding months. [] for a
 *  sous-traitant that is nobody's lab. */
export async function etudesPartenaire(idSousTraitant: number): Promise<EtudePartenaire[]> {
  const sql = mpsPg()
  const today = aujourdhui()
  const depuis = debutDouzeMois(today)
  type Row = { id: number; statut: number; recu: string | null; action: string | null } &
    Record<'libelle' | 'commentaire' | 'client' | 'reference' | 'designation' | 'coloris', string | null>
  const rows = await sql<Row[]>`
    SELECT e.idetude_col::bigint AS id, COALESCE(e.statut_col, 0)::int AS statut,
           e.libelle::text AS libelle, e.commentaire::text AS commentaire,
           to_char(e.date_reception_type, 'YYYYMMDD') AS recu, e.date_derniere_action::text AS action,
           c.nom::text AS client, r.reference::text AS reference, r.designation::text AS designation,
           k.reference::text AS coloris
    FROM etude_col e
    LEFT JOIN client c ON c.idclient = e.idclient
    LEFT JOIN ref_fini r ON r.idref_fini = e.idref_fini
    LEFT JOIN ref_fini_colori k ON k.idref_fini_colori = e.idref_fini_colori
    WHERE e.idsous_traitant = ${idSousTraitant}
      AND (e.statut_col IN (1, 2) OR (e.statut_col = 3 AND e.date_derniere_action::text >= ${depuis}))
    ORDER BY e.idetude_col DESC`
  const ids = rows.map((r) => Number(r.id))
  if (ids.length === 0) return []
  const [soums, relances] = await Promise.all([
    sql<{ id: number; etude: number; soum: string | null; rep: string | null; accepte: number | null; version: string | null; obs: string | null }[]>`
      SELECT idsoum_col::bigint AS id, idetude_col::bigint AS etude, to_char(date_soum, 'YYYYMMDD') AS soum,
             date_reponse::text AS rep, accepte::int AS accepte, type_soum::text AS version, observation::text AS obs
      FROM soum_col WHERE idetude_col = ANY(${ids})`,
    sql<{ etude: number; cible: string; le: string }[]>`
      SELECT idetude_col::bigint AS etude, cible, to_char(relancee_le, 'YYYYMMDD') AS le
      FROM etude_col_relance WHERE idetude_col = ANY(${ids})`,
  ])
  return rows.flatMap((r) => {
    const id = Number(r.id)
    const e = etudePartenaire({
      id, statut: Number(r.statut) || 0, libelle: str(r.libelle), commentaire: str(r.commentaire), client: str(r.client),
      reference: str(r.reference), designation: str(r.designation), colorisCree: str(r.coloris),
      dateReception: ymd(r.recu), derniereAction: ymd(r.action),
      soumissions: soums.filter((s) => Number(s.etude) === id).map((s) => ({
        id: Number(s.id), dateSoum: ymd(s.soum), dateReponse: ymd(s.rep), accepte: Number(s.accepte) || 0, version: str(s.version), observation: str(s.obs),
      })),
      relances: relances.filter((x) => Number(x.etude) === id && (x.cible === 'labo' || x.cible === 'client')).map((x) => ({ cible: x.cible as 'labo' | 'client', le: x.le })),
    }, today)
    return e ? [e] : []
  })
}
