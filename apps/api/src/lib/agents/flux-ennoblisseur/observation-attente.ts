// Observation driven by people (Vincent 2026-11-09, claude_doc/agents_autonomie.md §2):
// a skill in observation does not read a reply to the Point when it arrives.
// The mail waits here (PG observation_mail) until a person reacts to it on a
// line or a lot; the hourly pass (observation.ts) reads it then, as it was on
// arrival. Database only: delais.ts imports it, observation.ts imports delais.ts.

import type { Sql } from 'postgres'
import { mpsPg } from '../../mps-pg.js'

/** A waiting mail no person reacted to within this many days is never read. */
export const ATTENTE_MAX_J = 14

export interface MailEnAttente {
  id: number
  agent: string
  competence: string
  messageId: string
  threadId: string | null
  idsousTraitant: number
  idpoint: number
  /** 'YYYY-MM-DD' or null. */
  jourPoint: string | null
  dateMail: string
  recuLe: string
  statut: 'attente' | 'lu' | 'expire'
  essais: number
  /** Once read: the run of the reading. */
  runId: string | null
}

type Ligne = Record<string, unknown>

const isoJour = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : null)

export const versMail = (r: Ligne): MailEnAttente => ({
  id: Number(r.id),
  agent: String(r.agent),
  competence: String(r.competence),
  messageId: String(r.message_id),
  threadId: (r.thread_id as string) ?? null,
  idsousTraitant: Number(r.idsous_traitant),
  idpoint: Number(r.idpoint_sst),
  jourPoint: r.jour_point instanceof Date ? isoJour(r.jour_point) : ((r.jour_point as string | null) ?? null),
  dateMail: new Date(r.date_mail as string).toISOString(),
  recuLe: new Date(r.recu_le as string).toISOString(),
  statut: r.statut as MailEnAttente['statut'],
  essais: Number(r.essais ?? 0),
  runId: (r.run_id as string) ?? null,
})

/** Put a mail in the waiting list of a skill in observation. Once per mail
 *  and skill: a mail handed twice (Triage, « Retraiter ») waits once. */
export async function mettreEnAttente(n: {
  agent: string
  competence: string
  messageId: string
  threadId: string | null
  idsousTraitant: number
  idpoint: number
  jourPoint: string | null
  dateMail: string
}, sql: Sql = mpsPg()): Promise<void> {
  await sql`
    INSERT INTO observation_mail (agent, competence, message_id, thread_id, idsous_traitant, idpoint_sst, jour_point, date_mail)
    VALUES (${n.agent}, ${n.competence}, ${n.messageId}, ${n.threadId}, ${n.idsousTraitant}, ${n.idpoint},
      ${n.jourPoint}, ${new Date(n.dateMail).toISOString()})
    ON CONFLICT (agent, competence, message_id) DO NOTHING`
}
