// Agent « Superviseur » — the shared vocabulary of its checks.
//
// A check (Controle) is code: it reads ETM (IDsociete 1 only) or the factory
// mailboxes and returns findings (Constat). A finding is keyed by `cle` =
// check id + the object it is about, so the same problem on the same order is
// ONE finding across days — the findings memory (constats.ts) turns that into
// « nouveau » / « aggravé » / « toujours ouvert depuis N jours ».

export type Gravite = 'info' | 'attention' | 'urgent'
export const GRAVITE_RANG: Record<Gravite, number> = { info: 0, attention: 1, urgent: 2 }

export type Domaine =
  | 'mails'
  | 'commandes_client'
  | 'devis'
  | 'sous_traitants'
  | 'fils'
  | 'stock'
  | 'references'
  | 'etudes_coloris'
  | 'qualite'
  | 'integrite'

export const DOMAINE_LIBELLE: Record<Domaine, string> = {
  mails: 'Mails clients',
  commandes_client: 'Commandes clients',
  devis: 'Devis',
  sous_traitants: 'Sous-traitants',
  fils: 'Fils',
  stock: 'Stock',
  references: 'Références',
  etudes_coloris: 'Études coloris',
  qualite: 'Qualité',
  integrite: 'Intégrité des données',
}

export interface Constat {
  /** `<controle>:<object id>` — stable from one day to the next. */
  cle: string
  controle: string
  domaine: Domaine
  gravite: Gravite
  /** What it is about, e.g. « Commande 12345 — DUPONT SA ». */
  titre: string
  /** What is wrong, in one French sentence. */
  message: string
  /** ETM path to open it (`/clients/commandes?id=…`), or null. */
  lien: string | null
}

export interface ContexteControle {
  nowMs: number
  /** The active prompt version (model + mail-triage prompt). */
  version: { version: number; model: string; prompt: string }
  /** Adds an LLM / OCR cost (USD) to the run. */
  cout(usd: number): void
}

export interface Controle {
  id: string
  domaine: Domaine
  libelle: string
  /** Shown in the « Fonctionnement » tab. */
  description: string
  executer(ctx: ContexteControle): Promise<Constat[]>
}
