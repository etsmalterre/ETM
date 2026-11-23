// The mail that carries an étude coloris soumission (LIVA #1389).
//
// It is written to the LAB (the sous-traitant's « soumission » contacts), never
// to the client: the lab prints the sheet, staples its samples on it and posts
// the parcel to the client. The text therefore asks the lab to SEND, and says to
// whom — it used to ask the reader for « vos commentaires après examen des
// échantillons », a sentence meant for the client, who never receives this mail.
//
// Who at the client: the people named in `destinataires`. Nothing on an étude
// names one yet, so the sentence falls back to the address printed on the sheet
// (the client's default address, « À l'attention de »).

export interface MailSoumissionEtude {
  numero: string
  clientNom?: string | null
  /** People at the client the parcel is addressed to (« Prénom Nom »). */
  destinataires?: readonly string[]
  refFini?: string | null
  codeClient?: string | null
  codeMalterre?: string | null
}

const propre = (s: string | null | undefined): string => (s ?? '').trim()

/** « A », « A et B », « A, B et C ». */
function enumerer(noms: readonly string[]): string {
  if (noms.length <= 1) return noms[0] ?? ''
  return `${noms.slice(0, -1).join(', ')} et ${noms[noms.length - 1]}`
}

/** The sentence telling the lab where the sheet and its samples go. Pure. */
export function phraseEnvoiSoumission(clientNom?: string | null, destinataires: readonly string[] = []): string {
  const debut = 'Merci de bien vouloir envoyer cette soumission avec les échantillons'
  const client = propre(clientNom)
  const personnes = [...new Set(destinataires.map(propre).filter(Boolean))]
  if (personnes.length > 0) {
    return `${debut} à l'attention de ${enumerer(personnes)}${client ? ` chez ${client}` : ''}.`
  }
  return client
    ? `${debut} chez ${client}, à l'adresse indiquée sur le document joint.`
    : `${debut} à l'adresse indiquée sur le document joint.`
}

/** The pre-filled body of the mail (plain text, the person edits it). Pure. */
export function corpsMailSoumissionEtude(m: MailSoumissionEtude): string {
  const client = propre(m.clientNom)
  const lignes = [
    'Bonjour,',
    '',
    `Veuillez trouver ci-joint notre soumission N°${m.numero}${client ? ` à destination de ${client}` : ''}.`,
    '',
  ]
  const details: Array<[string, string]> = [
    ['Référence fini', propre(m.refFini)],
    ['Code client', propre(m.codeClient)],
    ['Code Malterre', propre(m.codeMalterre)],
  ]
  if (details.some(([, v]) => v)) {
    lignes.push('Détails :')
    for (const [libelle, valeur] of details) if (valeur) lignes.push(`  • ${libelle} : ${valeur}`)
    lignes.push('')
  }
  lignes.push(phraseEnvoiSoumission(client, m.destinataires), '', 'Cordialement,')
  return lignes.join('\n')
}
