// Agent « Superviseur » — the catalog of checks. Adding a check = one file in
// this folder + one entry here. Every check's SQL is run against dev before it
// ships (a column that does not exist = a prod outage on Linux), and measured
// on today's prod data (scripts/essai-superviseur.ts --prod): a check that
// fires hundreds of times on day one has a wrong threshold, not hundreds of
// problems. Thresholds live in regles.ts.

import type { Controle } from '../types.js'
import { controleCouverture, controleEnnoblissement } from './commandes-client.js'
import { controleAffectationFil, controleFilACommander } from './fils.js'
import { controleClientsSansReponse } from './mails-clients.js'
import { controleCommandesMails } from './commandes-mails.js'

export const CONTROLES: readonly Controle[] = [
  controleClientsSansReponse,
  controleCommandesMails,
  controleCouverture,
  controleEnnoblissement,
  controleFilACommander,
  controleAffectationFil,
]
