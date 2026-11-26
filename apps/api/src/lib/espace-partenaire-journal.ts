// The journal of an order as the espace partenaire shows it (Vincent 2026-11-26: « une section sur laquelle on
// peut voir le journal, tout ce qui s'est passé sur la commande ») — served inside the order's detail
// (lib/espace-partenaire-commandes.ts `commandePartenaire`).
//
// It is NOT ETM's Journal tab (lib/journal-commande-sst.ts, lib/journal-lot.ts). That one is written for Malterre:
// it names who did what, the clients, the e-mail addresses, the relances, whose fault a report is, the lab's
// tirelles, Tricobot's readings, the reminders. This one is a PROJECTION of it through a closed list: an entry is
// shown only when its kind and its exact wording are listed below, re-worded for the partner, and it is dropped
// otherwise — so a new kind of entry in ETM's journal, or one re-worded there, never reaches a partner by
// accident (it disappears from the portal until it is listed here).
//
// Shown: the bon de commande sent, the délai recorded and pushed back, the urgency (asked, cancelled, its
// answer), the order closed or reopened; for each lot: received, its controls recorded (the dyer's, Malterre's),
// the coloris (submitted, validated, refused, to put on the stenter), a reprise with its reason (the one the
// lot's page already shows), a quality action judged, the lot validated.
// Never add: who did it (`par`, Malterre's people — and so the author is never sent at all), any `detail` that is
// free text (notes, a client's comment, a report's motif and « de notre fait »), e-mail recipients, relances and
// Points (the chasing), the échéance Malterre pushes back for an answer, the rapport de contrôle (it names the
// client), the stabilités submitted to a client, the tirelle, the reminders, « Commande créée » (Malterre's own
// preparation, before the bon is sent).

import { lireJournalCommandeSst, type EntreeJournalCommande } from './journal-commande-sst.js'

export interface EntreeJournalPartenaire {
  /** ISO timestamp. */
  le: string
  titre: string
  /** A fact of the entry the partner may read (rolls received, the reason of a reprise); never free notes. */
  detail: string | null
  /** The lot the entry is about; null = the order itself. */
  lot: string | null
}

type Sortie = { titre: string; detail?: string | null } | null

const ROULEAUX = /^\d+ rouleaux?$/

/** One entry of ETM's journal as the partner reads it, or null when it is not for it. Pure. */
export function entreePartenaire(e: Pick<EntreeJournalCommande, 'le' | 'type' | 'titre' | 'detail' | 'lot'>): EntreeJournalPartenaire | null {
  const s = e.lot ? duLot(e) : deLaCommande(e)
  return s ? { le: e.le, titre: s.titre, detail: s.detail ?? null, lot: e.lot ?? null } : null
}

function deLaCommande(e: Pick<EntreeJournalCommande, 'type' | 'titre' | 'detail'>): Sortie {
  const t = e.titre
  let m: RegExpMatchArray | null
  switch (e.type) {
    case 'bon_commande':
      return t === 'Bon de commande envoyé' ? { titre: t } : null
    case 'delai_recu':
      m = t.match(/^Délai reçu : (\d{2}\/\d{2}\/\d{4})$/)
      return m ? { titre: `Délai enregistré : ${m[1]}` } : null
    case 'report':
      // The délai itself pushed back; « Échéance repoussée » is Malterre's own wait for an answer.
      return /^Délai repoussé du \d{2}\/\d{2} au \d{2}\/\d{2}$/.test(t) ? { titre: t } : null
    case 'urgence':
      if (t === 'Passage en urgence') {
        m = (e.detail ?? '').match(/souhaité pour le (\d{2}\/\d{2})/)
        return { titre: 'Commande passée en urgence', detail: m ? `Souhaitée pour le ${m[1]}` : null }
      }
      if (t === 'Urgence annulée') return { titre: t }
      if (/^Urgence (acceptée : délai avancé|sans suite : délai repoussé) du \d{2}\/\d{2} au \d{2}\/\d{2}$/.test(t)) return { titre: t }
      m = t.match(/^Urgence refusée par le sous-traitant( : délai maintenu au \d{2}\/\d{2})?$/)
      return m ? { titre: `Urgence refusée${m[1] ?? ''}` } : null
    case 'cloture':
      return t === 'Commande clôturée' ? { titre: 'Commande terminée' } : t === 'Commande rouverte' ? { titre: t } : null
    default:
      return null
  }
}

function duLot(e: Pick<EntreeJournalCommande, 'type' | 'titre' | 'detail'>): Sortie {
  const t = e.titre
  let m: RegExpMatchArray | null
  switch (e.type) {
    case 'reception':
      if (t === 'BL enregistré' || t === 'Lot reçu') return { titre: 'Lot reçu chez Malterre', detail: e.detail && ROULEAUX.test(e.detail) ? e.detail : null }
      return t === 'Retour de reprise réceptionné' ? { titre: 'Retour de reprise reçu chez Malterre' } : null
    case 'mesures_ennoblisseur':
      return t === 'Contrôle ennoblisseur enregistré' ? { titre: 'Contrôles ennoblisseur enregistrés' } : null
    case 'mesures_malterre':
      return t === 'Contrôle Malterre enregistré' ? { titre: t } : null
    case 'coloris_malterre':
      return t === 'Coloris contrôlé' ? { titre: 'Coloris contrôlé par Malterre' } : null
    case 'soumission':
      return t === 'Coloris soumis au client' ? { titre: t } : null
    case 'reponse_ok':
      return t === 'Le client accepte le coloris' ? { titre: 'Coloris validé' } : t === 'Action qualité jugée conforme' ? { titre: t } : null
    case 'reponse_refus':
      return t === 'Le client refuse le coloris' ? { titre: 'Coloris refusé' } : t === 'Action qualité jugée non conforme' ? { titre: t } : null
    case 'ok_ramer':
      return t === 'Coloris validé transmis à l’ennoblisseur' ? { titre: 'Coloris validé : lot à ramer' } : null
    case 'reprise':
      // The reason is the one the lot's page already shows (lib/reprises.ts).
      m = t.match(/^Envoyé en reprise( \(\d+e\))?$/)
      return m ? { titre: `Lot envoyé en reprise${m[1] ?? ''}`, detail: e.detail?.trim() || null } : null
    case 'etat':
      return t === 'Lot validé' ? { titre: t } : null
    default:
      return null
  }
}

/** The order's journal for its partner, newest first. The caller has checked the order is this partner's. */
export async function journalPartenaire(idCommande: number): Promise<EntreeJournalPartenaire[]> {
  const entrees = await lireJournalCommandeSst(idCommande)
  return entrees
    .map(entreePartenaire)
    .filter((e): e is EntreeJournalPartenaire => !!e)
    .sort((a, b) => b.le.localeCompare(a.le))
}
