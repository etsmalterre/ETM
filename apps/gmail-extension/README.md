# Tricobot — extension Chrome pour Gmail

Panneau latéral Chrome qui montre, pour la conversation ouverte dans Gmail (contact@), ce que
Tricobot en a fait, et permet de le corriger sans quitter Gmail. Même principe que l'extension
Vector de MFProd (`MFPROD/apps/gmail-extension`), dont elle reprend la structure.

- **Triage** : catégories, sous-catégorie (MATEL…), raisonnement, organisation reconnue, à quel
  agent le mail a été transmis et ce qu'il en a fait. Une pastille de catégorie se clique pour
  corriger (bonnes catégories + pourquoi) : même route qu'Agents IA › Exécutions
  (`PUT /agents-ia/triage/runs/:id/categories`, droit « Corriger le Triage » `corriger_triage` — Isabelle pour l’instant — ou `edit_agents_ia`). En mode actif, la
  correction remplace les libellés ETM/… et transmet le mail au nouvel agent.
- **BL ennoblisseur** : pièces lues (poids, Ml, observations), contrôles, lien vers la commande.
  « Marquer vérifié… » et « Tricobot s'est trompé ? » (pilote, `edit_agents_ia`). Le score
  habituel du BL reste donné à la réception des rouleaux.
- **Facture ennoblisseur** : lignes et verdict de Tricobot ; « C'est conforme… », « Signaler un
  écart… », « Mauvaise raison… » tant que la facture n'est pas close — les mêmes gestes que
  Sous-traitants › Factures (`PUT /factures-sst/lignes/:id/avis`, écran Factures).

- **Onglet Conversation** (barre du bas) : le fil lu en direct dans Gmail (`GET /api/tricobot/fil`), en bulles façon Messages — le groupe Malterre à droite, l’extérieur à gauche, l’historique cité retiré, les lignes coupées à 76 colonnes recollées, chaque pièce jointe sur le premier mail qui la porte (hors logos de signature). Seulement un fil que Tricobot a traité : la route n’ouvre jamais la boîte au hasard.

Pas de bouton « juste » : un mail non corrigé compte comme une réussite (doctrine Agents IA).

La lecture passe par `GET /api/tricobot/conversation` (`apps/api/src/lib/tricobot-conversation.ts`).

## Fonctionnement

- `content.ts` lit dans Gmail les ID de la conversation ouverte (`data-legacy-thread-id`,
  `data-legacy-message-id` = ID de l'API Gmail stockés dans `run.message`) et la boîte du
  compte (titre de l'onglet), et affiche une pastille « Tricobot · … » à côté de l'objet.
  Un clic ouvre le panneau.
- Les ID Gmail sont **propres à chaque boîte** : l'API ne cherche que parmi les agents qui
  lisent la boîte ouverte. Une autre boîte (isabelle@…) répond « Tricobot ne lit pas encore
  cette boîte » — l'y brancher = déclarer ses agents dans `agentsDeLaBoite()`.
- `background.ts` garde le contexte de chaque onglet dans `chrome.storage.session` et
  alimente la pastille.
- `sidepanel.ts` est le panneau ; il appelle l'API par l'entrée d'ETM
  (`https://etm.intra.etsmalterre.com/api`), autorisée par les `host_permissions`.
- Connexion avec le compte ETM : `POST /auth/login` avec `client: 'extension'` ouvre une
  session à part (« Extension Gmail Tricobot » dans la liste des sessions du compte), dont le
  jeton est envoyé en `Authorization: Bearer` — jamais le cookie d'ETM.

## Développement

```bash
cd apps/gmail-extension
pnpm build        # ou: pnpm watch
pnpm package      # zip pour le Chrome Web Store
pnpm test
pnpm typecheck
```

1. `chrome://extensions` → Mode développeur → **Charger l'extension non empaquetée** →
   `apps/gmail-extension/dist`.
2. Réglages du panneau (⚙) : API `http://localhost:808N/api`, ETM `http://localhost:300N`
   (slot N du worktree). Par défaut, ce sont les URL de prod.
3. En dev, aucun agent n'a lu vos mails : copiez les `runs-*.json` de prod dans
   `apps/api/data/agents/` (gitignoré) et passez-les en essai
   (`sed -i 's/"mode": "actif"/"mode": "essai"/g' runs-*.json`). ⚠️ Sans ça, une correction de
   Triage en dev suit le mode **du run** et modifierait les libellés du vrai contact@.

Après un `pnpm build`, rechargez l'extension (↻ dans `chrome://extensions`) puis l'onglet Gmail.

## Distribution

Comme Vector : extension non répertoriée du Chrome Web Store (compte développeur
vincent@etsmalterre.com), installée d'office par la console d'administration Google. Pour une
mise à jour : augmenter `version` dans `package.json`, `pnpm package` →
`release/tricobot-gmail-<version>.zip`, à téléverser dans le tableau de bord développeur.
Fiche, confidentialité, images et réglages de la console : `store/STORE.md`.
Seul Chrome desktop est pris en charge.
