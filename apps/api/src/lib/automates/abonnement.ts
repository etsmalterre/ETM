// Who an automate mails — the « Destinataires » tab of Agents IA › Automates.
// An automate that sends e-mails to subscribers declares `abonnement` in its
// catalog entry; the tab then lists the people who may receive it, each with a
// switch, plus « Aperçu » and « M’envoyer un test ». The subscriptions stay in
// the app's notification store (lib/notifications.ts): only the screen that
// edits them lives here (2026-10-02 — TRM's pointage reports were chosen in
// Paramètres › Utilisateurs › Notifications before).

/** One person the tab lists. */
export interface CandidatDestinataire {
  id: number
  nom: string
  email: string | null
  abonne: boolean
  /** Holds what the automate requires (the right to read what it mails). */
  autorise: boolean
}

/** The report as it would go out, for « Aperçu ». */
export interface ApercuAbonnement {
  sujet: string
  html: string
}

export class AbonnementRefuse extends Error {}

export interface AbonnementAutomate {
  /** Shown under the list: who may be ticked, and where that right is given. */
  regle: string
  /** The people who may receive it, plus anyone still subscribed without the right. */
  candidats(): Promise<CandidatDestinataire[]>
  /** Subscribe / unsubscribe one person. A NEW subscription without the right
   *  throws AbonnementRefuse; switching off is always allowed. */
  changer(userId: number, abonne: boolean): Promise<void>
  /** Whether the caller may see the report body (preview, test send). */
  peutLire(userId: number): Promise<boolean>
  /** The report as it would be built at `nowMs`; null when there is nothing to send. */
  apercu(nowMs: number): Promise<ApercuAbonnement | null>
  /** Send it to one address, subject marked « [Test] ». False when the send
   *  failed, null when there is nothing to send. */
  envoyerTest(nowMs: number, email: string): Promise<boolean | null>
}
