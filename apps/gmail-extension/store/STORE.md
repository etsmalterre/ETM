# Chrome Web Store — Tricobot

Published unlisted from the developer account
**vincent@etsmalterre.com** (same account as Vector, `MFPROD/apps/gmail-extension/store/STORE.md`),
force-installed through the Google Admin console.

Item ID: **`lbnbhccnpolklobhddgpmnipjhgdgkpj`**

## Publishing an update

1. Bump `"version"` in `package.json` (the manifest takes it from there).
2. `pnpm package` → `release/tricobot-gmail-<version>.zip` (store build: no localhost permission).
3. Developer dashboard → Tricobot → Package → **Upload new package** → Submit for review.
4. Once approved, Chrome updates installed copies by itself within a few hours.

## Listing (Store listing tab)

**Name:** Tricobot — ETM (from the manifest)

**Summary (132 chars max, from the manifest description):**
Ce que Tricobot (Triage, BL, Factures) a fait du mail ouvert dans Gmail, et vos corrections.

**Description:**

> Outil interne d'ETS Malterre, réservé aux utilisateurs de l'ERP ETM.
>
> Tricobot est l'assistant IA d'ETM : il classe les mails reçus sur contact@ (Triage), lit
> les bons de livraison des ennoblisseurs et contrôle leurs factures. Cette extension
> affiche, à côté du mail ouvert dans Gmail, ce que Tricobot en a fait :
>
> - les catégories choisies par Triage et son raisonnement ;
> - les pièces lues sur un BL ennoblisseur, ses contrôles et un lien vers la commande ;
> - les lignes d'une facture ennoblisseur et le verdict de Tricobot ;
> - la conversation, en bulles, pour un mail que Tricobot a traité.
>
> Elle permet de corriger Tricobot sans quitter Gmail. Une pastille à côté de l'objet
> signale les conversations que Tricobot a traitées.
>
> Connexion avec votre compte ETM. Fonctionne uniquement sur le réseau de l'entreprise.

**Category:** Productivity → Workflow & planning management
**Language:** French

**Images:**
- Store icon 128×128: `static/icons/tricobot-128.png`
- Screenshot 1280×800, 24-bit PNG without alpha: `store/screenshot-1280x800.png` (provisional
  title card — a real capture of the panel in Gmail, resized to 1280×800, can replace it)
- Small promo tile 440×280: `store/promo-440x280.png`

Both images are rendered from `apps/web/public/tricobot/tricobot-mascot.png` on primary blue.

## Privacy tab

**Single purpose:**
Afficher, pour le mail ouvert dans Gmail, le travail de l'assistant Tricobot de l'ERP ETM
(classement, BL ou facture ennoblisseur lu) et enregistrer les corrections de l'utilisateur.

**Permission justifications:**
- `sidePanel` — le contenu de l'extension est affiché dans le panneau latéral de Chrome, à côté de Gmail.
- `storage` — conserve la session ETM de l'utilisateur, les adresses de l'API/ERP, et le contexte de l'onglet Gmail ouvert.
- Host `https://mail.google.com/*` — lire les identifiants (ID Gmail) de la conversation ouverte et l'adresse de la boîte, et afficher la pastille Tricobot à côté de l'objet. Le corps des mails n'est pas lu dans la page.
- Host `https://etm.intra.etsmalterre.com/*` — serveur de l'ERP ETM (réseau de l'entreprise) qui fournit les données Tricobot et reçoit les corrections.

**Remote code:** No, I am not using remote code.

**Data usage — collected:**
- Authentication information (the ETM login, exchanged for a session token stored locally)
- Personal communications — **Yes**, unlike Vector: the « Conversation » tab displays the
  thread's messages, served by the ETM API (only for a thread Tricobot handled), never stored.

Certify the three statements (no sale, no unrelated use, no creditworthiness).

**Privacy policy URL:** https://etsmalterre.com/tricobot/confidentialite — copy `store/privacy.html`
to `/srv/etsmalterre/static/tricobot/confidentialite.html` on `sites_malterre_vps` and add the
route next to Vector's in `/etc/caddy/sites/etsmalterre.com.caddy` (versioned in the
`mail_laurent` repo, `deploy/`). Edit the policy here, then re-copy it.

## Distribution tab

Visibility: **Unlisted** (Non répertorié), like Vector.

## Admin console (admin.google.com), once approved

Same settings as Vector (Chrome management for signed-in users already on):
Devices › Chrome › Apps & extensions › Users & browsers → + → **Add by ID** → **Force install +
pin to browser toolbar**. Scope it to the people who use contact@ if not everyone needs it.
