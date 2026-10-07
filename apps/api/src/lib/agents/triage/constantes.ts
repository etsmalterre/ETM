// Agent « Triage » — constants shared with the agents it hands mail to. No
// import here: bl-ennoblisseur.ts and factures-sst/agent.ts read them (through
// relais.ts), and the Triage imports those agents (no cycle).

export const TRIAGE_SLUG = 'triage'

/** The mailbox the Triage reads — the one every dyer, client and supplier writes to. */
export const TRIAGE_BOITE = process.env.AGENT_TRIAGE_BOITE?.trim() || 'contact@etsmalterre.com'
