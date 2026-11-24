// Who may use the espace partenaire (partenaire.etsmalterre.fr): one row per ERP contact of a
// sous-traitant given access. As for the espace client (lib/espace-client-acces.ts, whose
// connection, migrations and e-mail rules are reused), the ERP decides — the portal never creates,
// suspends or deletes a partner login by itself; it reads the list
// (GET /api/site/espace/partenaires/acces) and reports back what happened
// (POST /api/site/espace/partenaires/activite: invitation sent, password set, sign-in).
//
// Same PostgreSQL database as the customer accesses (`espace_client`, ESPACE_CLIENT_PG_URL), its
// own tables `acces_partenaire` + `journal_partenaire`, linked to `mps` by id only (`idcontact`,
// `idsous_traitant`). Without ESPACE_CLIENT_PG_URL the feature is off: the routes answer 503.
//
// What the portal list carries: the contact's id, e-mail, first name and name, its sous-traitant's
// id and name. Never add: the contact's phone or commentaire, the sous-traitant's commentaire,
// tariffs or délai standards, its other contacts, who at Malterre gave the access, the journal.

import { mpsPg } from './mps-pg.js'
import {
  AccesRefuse, COLONNE, conn, emailValide, espaceConfigure, normaliserEmail,
  type AccesContact, type Evenement, type Sql,
} from './espace-client-acces.js'

// ── Rules (pure, tested) ────────────────────────────────────

export interface ContactPartenaire {
  IDcontact: number
  IDsous_traitant: number
  nom: string
  prenom: string
  mail: string
  visible: boolean
}

export interface PartenaireErp {
  IDsous_traitant: number
  nom: string
  visible: boolean
}

export interface AccesPartenaireRow {
  idcontact: number
  idsous_traitant: number
  actif: boolean
  modifie_le: Date
}

/** One access as the portal reads it (espace-partenaire-etsmalterre packages/api `AccesPartenaireApi`). */
export interface AccesPartenairePortail {
  idcontact: number
  IDsous_traitant: number
  /** The sous-traitant's name. */
  partenaire: string
  email: string
  prenom: string
  nom: string
}

/**
 * The logins the portal must honour: active rows whose contact still exists, still belongs to
 * that sous-traitant, is visible and has a valid e-mail, at a visible sous-traitant. An e-mail is
 * a login, so it may appear once: on a clash the oldest grant wins (the grant route refuses a
 * clash; this only covers an e-mail changed in the ERP later).
 */
export function accesPartenairesEffectifs(
  rows: AccesPartenaireRow[],
  contacts: Map<number, ContactPartenaire>,
  partenaires: Map<number, PartenaireErp>,
): AccesPartenairePortail[] {
  const out: AccesPartenairePortail[] = []
  const vus = new Set<string>()
  const tries = [...rows].sort((a, b) => a.modifie_le.getTime() - b.modifie_le.getTime() || a.idcontact - b.idcontact)
  for (const r of tries) {
    if (!r.actif) continue
    const c = contacts.get(r.idcontact)
    if (!c || !c.visible || c.IDsous_traitant !== r.idsous_traitant) continue
    const p = partenaires.get(c.IDsous_traitant)
    if (!p || !p.visible) continue
    const email = normaliserEmail(c.mail)
    if (!emailValide(email) || vus.has(email)) continue
    vus.add(email)
    out.push({ idcontact: c.IDcontact, IDsous_traitant: c.IDsous_traitant, partenaire: p.nom, email, prenom: c.prenom, nom: c.nom })
  }
  return out
}

/** Why a contact cannot be given the access, null when it can (the e-mail clash is checked apart). Pure. */
export function refusAcces(
  c: ContactPartenaire | undefined,
  idsousTraitant: number,
  p: PartenaireErp | undefined,
): string | null {
  if (!c || c.IDsous_traitant !== idsousTraitant) return 'Contact introuvable pour ce sous-traitant.'
  if (!c.visible) return 'Ce contact est masqué dans l’ERP.'
  if (!emailValide(normaliserEmail(c.mail))) return 'Ce contact n’a pas d’adresse e-mail valide : renseignez-la d’abord.'
  if (!p) return 'Sous-traitant introuvable.'
  if (!p.visible) return 'Ce sous-traitant est inactif : réactivez-le d’abord.'
  return null
}

// ── ERP reads (native PostgreSQL, flat) ─────────────────────

const str = (v: unknown) => String(v ?? '').trim()
const ids = (xs: number[]) => [...new Set(xs)].filter((x) => Number.isInteger(x) && x > 0)

export async function contactsPartenaires(idcontacts: number[]): Promise<Map<number, ContactPartenaire>> {
  const m = new Map<number, ContactPartenaire>()
  const liste = ids(idcontacts)
  if (liste.length === 0) return m
  const rows = await mpsPg()<{ id: number; sst: number; nom: string | null; prenom: string | null; mail: string | null; visible: number }[]>`
    SELECT idcontact AS id, COALESCE(idsous_traitant, 0) AS sst, nom::text AS nom, prenom::text AS prenom, mail::text AS mail,
           COALESCE(est_visible, 0)::int AS visible
    FROM contact WHERE idcontact = ANY(${liste})`
  for (const r of rows) {
    m.set(Number(r.id), {
      IDcontact: Number(r.id), IDsous_traitant: Number(r.sst),
      nom: str(r.nom), prenom: str(r.prenom), mail: str(r.mail), visible: Number(r.visible) === 1,
    })
  }
  return m
}

export async function partenairesErp(idsousTraitants: number[]): Promise<Map<number, PartenaireErp>> {
  const m = new Map<number, PartenaireErp>()
  const liste = ids(idsousTraitants)
  if (liste.length === 0) return m
  const rows = await mpsPg()<{ id: number; nom: string | null; visible: number }[]>`
    SELECT idsous_traitant AS id, nom::text AS nom, COALESCE(est_visible, 0)::int AS visible
    FROM sous_traitant WHERE idsous_traitant = ANY(${liste})`
  for (const r of rows) m.set(Number(r.id), { IDsous_traitant: Number(r.id), nom: str(r.nom), visible: Number(r.visible) === 1 })
  return m
}

/** Every visible sous-traitant, sorted by name: the portal admin's « voir comme ». Id and name only. */
export async function partenairesVisibles(): Promise<{ IDsous_traitant: number; nom: string }[]> {
  const rows = await mpsPg()<{ id: number; nom: string | null }[]>`
    SELECT idsous_traitant AS id, nom::text AS nom FROM sous_traitant WHERE est_visible = 1`
  return rows
    .map((r) => ({ IDsous_traitant: Number(r.id), nom: str(r.nom) }))
    .filter((p) => p.nom)
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr') || a.IDsous_traitant - b.IDsous_traitant)
}

// ── ETM side ────────────────────────────────────────────────

/** Access state of every contact of one sous-traitant that ever had a row. */
export async function accesDuPartenaire(idsousTraitant: number): Promise<AccesContact[]> {
  const s = await conn()
  return s<AccesContact[]>`
    SELECT idcontact, actif, modifie_le, modifie_par, invitation_le, mot_de_passe_le, derniere_connexion_le
    FROM acces_partenaire WHERE idsous_traitant = ${idsousTraitant} ORDER BY idcontact`
}

/** Grant or remove one contact's access. Checks the ERP side first: the contact belongs to that
 *  sous-traitant, both are visible, and its e-mail is valid and used by no other active access. */
export async function changerAccesPartenaire(idcontact: number, idsousTraitant: number, actif: boolean, par: string): Promise<void> {
  const s = await conn()
  if (actif) {
    const c = (await contactsPartenaires([idcontact])).get(idcontact)
    const refus = refusAcces(c, idsousTraitant, (await partenairesErp([idsousTraitant])).get(idsousTraitant))
    if (refus) throw new AccesRefuse(refus)
    const email = normaliserEmail(c!.mail)
    const autres = await s<{ idcontact: number; idsous_traitant: number }[]>`
      SELECT idcontact, idsous_traitant FROM acces_partenaire WHERE actif AND idcontact <> ${idcontact}`
    const erp = await contactsPartenaires(autres.map((a) => a.idcontact))
    const clash = autres.find((a) => normaliserEmail(erp.get(a.idcontact)?.mail) === email)
    if (clash) {
      const autre = (await partenairesErp([clash.idsous_traitant])).get(clash.idsous_traitant)
      throw new AccesRefuse(`L’adresse ${email} a déjà un accès (sous-traitant ${autre?.nom ?? clash.idsous_traitant}). Une adresse = un seul accès.`)
    }
  }
  await s.begin(async (t) => {
    const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
    const [avant] = await tx<{ actif: boolean }[]>`SELECT actif FROM acces_partenaire WHERE idcontact = ${idcontact} FOR UPDATE`
    if (avant ? avant.actif === actif : !actif) return
    await tx`
      INSERT INTO acces_partenaire (idcontact, idsous_traitant, actif, modifie_par)
      VALUES (${idcontact}, ${idsousTraitant}, ${actif}, ${par})
      ON CONFLICT (idcontact) DO UPDATE SET idsous_traitant = ${idsousTraitant}, actif = ${actif}, modifie_le = now(), modifie_par = ${par}`
    await tx`
      INSERT INTO journal_partenaire (idcontact, idsous_traitant, action, par)
      VALUES (${idcontact}, ${idsousTraitant}, ${actif ? 'accorde' : 'retire'}, ${par})`
  })
  cacheListe = null
}

/** A sous-traitant made inactive (or deleted) loses the access of all its contacts, journaled like
 *  a removal by hand — the espace client's rule for an archived client. Making it active again
 *  gives nothing back: access is granted again contact by contact. Without ESPACE_CLIENT_PG_URL
 *  there is nothing to remove. Returns the count removed. */
export async function retirerAccesPartenaire(idsousTraitant: number, par: string, detail = 'sous-traitant inactif'): Promise<number> {
  if (!espaceConfigure()) return 0
  const s = await conn()
  const retires = await s.begin(async (t) => {
    const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
    const rows = await tx<{ idcontact: number }[]>`
      UPDATE acces_partenaire SET actif = false, modifie_le = now(), modifie_par = ${par}
      WHERE idsous_traitant = ${idsousTraitant} AND actif RETURNING idcontact`
    for (const r of rows) {
      await tx`
        INSERT INTO journal_partenaire (idcontact, idsous_traitant, action, par, detail)
        VALUES (${r.idcontact}, ${idsousTraitant}, 'retire', ${par}, ${detail})`
    }
    return rows.length
  })
  cacheListe = null
  return retires
}

// ── Portal side ─────────────────────────────────────────────

let cacheListe: { at: number; acces: AccesPartenairePortail[] } | null = null

/** The list the portal honours. Cached 30 s: the portal reads it on a timer and at each sign-in.
 *  A change made in ETM clears the cache. */
export async function listeAccesPartenaires(): Promise<AccesPartenairePortail[]> {
  if (cacheListe && Date.now() - cacheListe.at < 30_000) return cacheListe.acces
  const s = await conn()
  const rows = await s<AccesPartenaireRow[]>`SELECT idcontact, idsous_traitant, actif, modifie_le FROM acces_partenaire WHERE actif`
  const contacts = await contactsPartenaires(rows.map((r) => r.idcontact))
  const partenaires = await partenairesErp([...contacts.values()].map((c) => c.IDsous_traitant))
  const acces = accesPartenairesEffectifs(rows, contacts, partenaires)
  cacheListe = { at: Date.now(), acces }
  return acces
}

/** What the portal reports (it resends its dates on every sync: idempotent). Unknown contacts are
 *  ignored; a date never goes backwards; only a date that moves counts and, for invitations and
 *  passwords, is journaled. */
export async function enregistrerActivitePartenaires(evenements: Evenement[]): Promise<number> {
  const s = await conn()
  let n = 0
  await s.begin(async (t) => {
    const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
    for (const e of evenements) {
      const col = COLONNE[e.type]
      const [row] = await tx<{ idsous_traitant: number }[]>`
        UPDATE acces_partenaire SET ${tx(col)} = ${e.le}
        WHERE idcontact = ${e.idcontact} AND (${tx(col)} IS NULL OR ${tx(col)} < ${e.le}) RETURNING idsous_traitant`
      if (!row) continue
      n++
      if (e.type !== 'connexion') {
        await tx`
          INSERT INTO journal_partenaire (le, idcontact, idsous_traitant, action, par)
          VALUES (${e.le}, ${e.idcontact}, ${row.idsous_traitant}, ${e.type}, 'espace partenaire')`
      }
    }
  })
  return n
}
