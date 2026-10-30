// Agent « Superviseur » — v4: the mails WE sent to each client in the window,
// for the database checks that must not report what has already been said to
// the client (a delay explained by mail, an order confirmed by mail rather
// than from ETM). Headers only (mails.ts entetesDuRun, read once per run).
//
// Never a reason to fail a check: a mailbox that cannot be read only means the
// check reports as it did before v4 (null below).

import { chargerAnnuaire, entetesDuRun } from '../mails.js'
import { identifierClient } from '../reponses.js'

export interface MailEnvoye {
  /** The mailbox it left from, without the domain (« pierre-emmanuel »). */
  par: string
  /** ms */
  date: number
  sujet: string
}

let memo: { nowMs: number; mails: Promise<Map<number, MailEnvoye[]> | null> } | null = null

/** IDclient → our mails to it (To or Cc), newest first. Null when no mailbox could be read. */
export function mailsEnvoyesParClient(nowMs: number): Promise<Map<number, MailEnvoye[]> | null> {
  if (!memo || memo.nowMs !== nowMs) {
    memo = {
      nowMs,
      mails: (async () => {
        try {
          const [{ entetes }, annuaire] = await Promise.all([entetesDuRun(nowMs), chargerAnnuaire()])
          if (!entetes.length) return null
          const out = new Map<number, MailEnvoye[]>()
          const vus = new Set<string>()
          for (const m of entetes) {
            if (!m.envoye || m.date > nowMs) continue
            const k = m.messageId || `${m.boite}:${m.id}`
            if (vus.has(k)) continue
            vus.add(k)
            const clients = new Set<number>()
            for (const adr of [...m.a, ...m.cc]) {
              const c = identifierClient(adr.toLowerCase(), annuaire)
              if (c) clients.add(c.idClient)
            }
            for (const id of clients) {
              const l = out.get(id) ?? []
              l.push({ par: m.boite.split('@')[0], date: m.date, sujet: m.sujet })
              out.set(id, l)
            }
          }
          for (const l of out.values()) l.sort((a, b) => b.date - a.date)
          return out
        } catch (err) {
          console.error('[agents] superviseur: mails envoyés illisibles:', err instanceof Error ? err.message : String(err))
          return null
        }
      })(),
    }
  }
  return memo.mails
}

/** « pierre-emmanuel le 06/10 (« Re: votre commande ») ». */
export function mailTexte(m: MailEnvoye): string {
  const d = new Date(m.date).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit' })
  const s = m.sujet.length > 60 ? `${m.sujet.slice(0, 59)}…` : m.sujet
  return `${m.par} le ${d}${s ? ` (« ${s} »)` : ''}`
}
