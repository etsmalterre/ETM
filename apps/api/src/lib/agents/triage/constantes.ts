// Agent « Triage » — constants shared with the agents it hands mail to. No
// import here: bl-ennoblisseur.ts and factures-sst/agent.ts read the option
// below, and the Triage imports them (no cycle).

export const TRIAGE_SLUG = 'triage'

/** The mailbox the Triage reads — the one every dyer, client and supplier writes to. */
export const TRIAGE_BOITE = process.env.AGENT_TRIAGE_BOITE?.trim() || 'contact@etsmalterre.com'

/** Option of an agent the Triage hands mail to: on = it no longer reads the
 *  mailbox itself, it only processes what the Triage sends it. */
export const OPTION_VIA_TRIAGE = 'via_triage'

export const OPTION_VIA_TRIAGE_DEF = {
  cle: OPTION_VIA_TRIAGE,
  libelle: 'Mails transmis par le Triage',
  description:
    'Activé : l’agent ne relève plus la boîte lui-même — il traite les mails que l’agent Triage lui transmet (le Triage doit être en service). Désactivé : il relève la boîte lui-même, avec son propre filtre d’expéditeurs.',
  defaut: false,
} as const
