// Agent « Rapport d'activité » — what a save changed, in French (2026-10-14).
//
// The order screens send their whole form on « Enregistrer »: the line AND
// the header, touched or not. Read from the body, sst 9104 came out as
// « modification de la ligne et de l'en-tête » when Pierre-Emmanuel had typed
// MATEL's délai (10/11) and cleared the relance date. The journal now keeps
// the row read before and after (journal_activite.changements, SUIVIS in
// lib/journal-activite.ts); this file says each column that moved, in the
// words of the screen. A save that changed nothing says nothing.
//
// Pure: no I/O.

import { stripRtf } from '../../rtf-utils.js'
import type { Changements } from '../../journal-activite.js'
import { modeLivraisonDe } from '../../urgence-commande-client.js'

const MODES: Record<string, string> = { des_que_prete: 'dès que prête', date_client: 'date convenue', sur_appel: 'sur appel', commande_complete: 'commande complète' }

type Sorte = 'mode' | 'date' | 'delai' | 'nombre' | 'texte' | 'statut' | 'drapeau' | 'lien' | 'ignore'

interface Champ {
  nom: string
  sorte: Sorte
  /** drapeau: the words for 1 and 0 (« soldée » / « rouverte »). */
  oui?: string
  non?: string
  /** Feminine noun: « saisie », « effacée ». */
  f?: boolean
}

/** Columns of the six SUIVIS tables. Absent = said with its raw name, so
 *  nothing a person changed is ever hidden. */
const CHAMPS: Record<string, Champ> = {
  date_commande: { nom: 'date de commande', sorte: 'date', f: true },
  date_notif: { nom: 'date de relance', sorte: 'date', f: true },
  date_livraison: { nom: 'délai de livraison', sorte: 'delai' },
  date_reception: { nom: 'date de réception', sorte: 'date', f: true },
  date_expedition_prevue: { nom: 'date d’expédition convenue', sorte: 'date', f: true },
  date_demande_paiement: { nom: 'date de demande de paiement', sorte: 'date', f: true },
  delai_reel: { nom: 'délai réel', sorte: 'delai' },
  quantite: { nom: 'quantité', sorte: 'nombre', f: true },
  prix: { nom: 'prix', sorte: 'nombre' },
  prix_unitaire: { nom: 'prix unitaire', sorte: 'nombre' },
  poids: { nom: 'poids', sorte: 'nombre' },
  remise: { nom: 'remise', sorte: 'nombre', f: true },
  frais_port: { nom: 'frais de port', sorte: 'nombre' },
  unite: { nom: 'unité', sorte: 'lien', f: true },
  commentaire: { nom: 'commentaire', sorte: 'texte' },
  commentaire_interne: { nom: 'commentaire interne', sorte: 'texte' },
  journal: { nom: 'note interne', sorte: 'texte', f: true },
  ref_client: { nom: 'réf. client', sorte: 'texte', f: true },
  observations_facturation: { nom: 'observations de facturation', sorte: 'texte' },
  num_facture: { nom: 'N° de facture', sorte: 'texte' },
  sstatut: { nom: 'statut', sorte: 'statut' },
  etat: { nom: '', sorte: 'drapeau', oui: 'réception enregistrée', non: 'réception annulée' },
  mode_livraison: { nom: 'mode de livraison', sorte: 'mode' },
  est_soldee: { nom: '', sorte: 'drapeau', oui: 'commande soldée', non: 'commande rouverte' },
  archive: { nom: '', sorte: 'drapeau', oui: 'archivée', non: 'désarchivée' },
  expedie: { nom: '', sorte: 'drapeau', oui: 'marquée expédiée', non: 'plus marquée expédiée' },
  envoye_client: { nom: '', sorte: 'drapeau', oui: 'marquée envoyée au client', non: 'plus marquée envoyée au client' },
  attente_paiement: { nom: '', sorte: 'drapeau', oui: 'mise en attente de paiement', non: 'sortie de l’attente de paiement' },
  donation: { nom: '', sorte: 'drapeau', oui: 'passée en donation', non: 'plus en donation' },
  idreference: { nom: 'référence', sorte: 'lien', f: true },
  idref_fil: { nom: 'référence de fil', sorte: 'lien', f: true },
  idcoloris: { nom: 'coloris', sorte: 'lien' },
  idcolori: { nom: 'coloris', sorte: 'lien' },
  idcolori_fil: { nom: 'coloris', sorte: 'lien' },
  type: { nom: 'type de ligne', sorte: 'lien' },
  idclient: { nom: 'client', sorte: 'lien' },
  idfournisseur: { nom: 'fournisseur', sorte: 'lien' },
  idadresse_sous_traitant: { nom: 'adresse du sous-traitant', sorte: 'lien', f: true },
  idadresse_fournisseur: { nom: 'adresse du fournisseur', sorte: 'lien', f: true },
  idadresse_livraison: { nom: 'adresse de livraison', sorte: 'lien', f: true },
  idadresse_facturation: { nom: 'adresse de facturation', sorte: 'lien', f: true },
  idmode_paiement: { nom: 'mode de paiement', sorte: 'lien' },
  idecheance: { nom: 'échéance', sorte: 'lien', f: true },
  iddesignation_client: { nom: 'désignation client', sorte: 'lien', f: true },
  idvariation1: { nom: 'variation 1', sorte: 'lien', f: true },
  idvariation2: { nom: 'variation 2', sorte: 'lien', f: true },
  idmachine_planning: { nom: 'machine au planning', sorte: 'lien', f: true },
  planning_depart: { nom: 'début au planning', sorte: 'texte' },
  planning_fin: { nom: 'fin au planning', sorte: 'texte', f: true },
  deverrouiller: { nom: 'déverrouillage', sorte: 'texte' },
  // Written by the API on its own, never typed: the délai first announced
  // (frozen once) and the links between ledgers.
  date_delai: { nom: '', sorte: 'ignore' },
  delai_annonce: { nom: '', sorte: 'ignore' },
  idsociete: { nom: '', sorte: 'ignore' },
  idcommande_etm: { nom: '', sorte: 'ignore' },
  idligne_commande_etm: { nom: '', sorte: 'ignore' },
}

const vide = (v: unknown) => v === null || v === undefined || v === '' || v === 0 || v === '0'

/** « 2026-11-10 » → « 10/11/2026 ». */
const dateFr = (v: unknown) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''))
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v ?? '')
}
const nombreFr = (v: unknown) => String(v ?? '').replace('.', ',')
/** RTF (sst header comments) to plain text, one line, cut. */
const texteFr = (v: unknown) => {
  const t = (typeof v === 'string' && v.trimStart().startsWith('{\\rtf') ? stripRtf(v) : String(v ?? '')).replace(/\s+/g, ' ').trim()
  return t.length > 120 ? `${t.slice(0, 120)}…` : t
}
/** « Attente_Delai » → « Attente délai ». */
const statutFr = (v: unknown) => {
  const t = String(v ?? '').replace(/_/g, ' ').trim().toLowerCase()
  return t ? t[0].toUpperCase() + t.slice(1) : '(vide)'
}

/** One phrase per column that moved, in the screen's words. Pure. */
export function phrases(ch: Changements): string[] {
  const out: string[] = []
  for (const [col, [a, b]] of Object.entries(ch)) {
    const c = CHAMPS[col] ?? { nom: `champ « ${col} »`, sorte: 'texte' as Sorte }
    const e = c.f ? 'e' : ''
    switch (c.sorte) {
      case 'ignore':
        break
      case 'date':
      case 'delai':
        if (vide(a)) out.push(`${c.nom} saisi${e} au ${dateFr(b)}`)
        else if (vide(b)) out.push(`${c.nom} effacé${e} (était le ${dateFr(a)})`)
        else if (c.sorte === 'delai') out.push(`${c.nom} ${String(b) < String(a) ? 'avancé' : 'reculé'} du ${dateFr(a)} au ${dateFr(b)}`)
        else out.push(`${c.nom} déplacé${e} du ${dateFr(a)} au ${dateFr(b)}`)
        break
      case 'nombre':
        out.push(`${c.nom} ${vide(a) ? '0' : nombreFr(a)} → ${vide(b) ? '0' : nombreFr(b)}`)
        break
      case 'texte': {
        const ta = texteFr(a)
        const tb = texteFr(b)
        if (ta === tb) break // RTF wrapping only
        if (!ta) out.push(`${c.nom} ajouté${e} : « ${tb} »`)
        else if (!tb) out.push(`${c.nom} effacé${e} (était « ${ta} »)`)
        else out.push(`${c.nom} modifié${e} : « ${ta} » → « ${tb} »`)
        break
      }
      case 'statut':
        out.push(`${c.nom} « ${statutFr(a)} » → « ${statutFr(b)} »`)
        break
      case 'mode':
        out.push(`${c.nom} « ${MODES[modeLivraisonDe(a)]} » → « ${MODES[modeLivraisonDe(b)]} »`)
        break
      case 'drapeau':
        out.push(vide(b) ? c.non! : c.oui!)
        break
      case 'lien':
        out.push(vide(a) ? `${c.nom} renseigné${e}` : vide(b) ? `${c.nom} retiré${e}` : `${c.nom} changé${e}`)
        break
    }
  }
  return out
}
