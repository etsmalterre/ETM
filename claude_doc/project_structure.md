# Project Structure

File/directory layout with per-file annotations. Load when navigating the codebase.

```
ETM/
├── apps/
│   ├── api/           # Express API
│   │   ├── data/      # Runtime JSON (gitignored): permissions.json, user-emails.json
│   │   ├── secrets/   # Gitignored: Google service account key
│   │   └── src/
│   │       ├── assets/           # fonts/, logo-malterre-wide.png (PDF)
│   │       ├── lib/
│   │       │   ├── hfsql.ts              # ODBC singleton, query(), queryRaw(), fixEncoding()
│   │       │   ├── auth.ts               # Cookie HMAC, attachUser, requireAdmin, isEffectiveAdmin
│   │       │   ├── permissions.ts        # JSON-backed per-user permissions (TODO: DB)
│   │       │   ├── permission-keys.ts    # PERMISSION_KEYS catalog
│   │       │   ├── user-emails.ts        # JSON-backed per-user emails (TODO: DB)
│   │       │   ├── gmail.ts              # Gmail API send helper (JWT + DWD)
│   │       │   ├── pricing-sst.ts        # Ennoblisseur auto-pricing (see HFSQL rules)
│   │       │   ├── pricing-trm.ts        # Tricoteur auto-pricing — PrixDeRevientTRM port
│   │       │   └── pdf/                  # theme.ts, MalterreDocument.tsx, CommandeFournisseurPdf, CommandeSoustraitantPdf, SoumissionLotPdf, DemandeEtudeColorisPdf, SoumissionPdf, FeuilleColorisPdf
│   │       ├── routes/                   # entreprises, fournisseurs, references-fil, references-ecru, references-fini, references-divers, stock, stock-fini, commandes-fil, commandes-sous-traitant, sous-traitants, etudes-coloris, prospects, auth, permissions, user-emails
│   │       └── index.ts
│   └── web/           # React frontend
│       └── src/
│           ├── components/
│           │   ├── auth/         # UserPickerGate, UserPicker
│           │   ├── email/        # SendEmailDialog (shared two-pane send dialog)
│           │   ├── icons/        # BobineIcon, KnitIcon, FabricRollIcon, FiniRollIcon, TmRollIcon
│           │   ├── layout/       # AppShell, Sidebar, Header, MobileNav, MasterDetailLayout
│           │   └── ui/           # Radix-based (Button has 'gold' variant)
│           ├── config/navigation.ts      # SubMenuItem.adminOnly flag
│           ├── contexts/
│           │   ├── UserContext.tsx       # useUser, canSwitchUser
│           │   └── PermissionsContext.tsx # usePermissions, useHasPermission
│           ├── hooks/useResponsiveLayout.ts
│           ├── lib/
│           │   ├── api.ts        # SHARED apiFetch (credentials: 'include') — do NOT duplicate
│           │   ├── email.ts      # Types + postEmail helper for SendEmailDialog
│           │   ├── dates.ts      # HFSQL date helpers
│           │   └── format.ts     # fmtNum (French formatting)
│           ├── pages/            # Dashboard, Entreprises, FilsGestion, FilsReferences, FilsStock, FilsCommandes, SousTraitantsCommandes, SousTraitantsGestion, EtudesColoris, FinisReferences, FinisStock, TombeMetierReferences, TombeMetierStock, DiversReferences, ProspectsDemandes, SettingsUtilisateurs
│           ├── main.tsx          # QueryClient → UserProvider → PermissionsProvider → UserPickerGate → RouterProvider
│           └── router.tsx
├── claude_doc/                   # Detailed reference docs (load on demand)
├── data_migration/               # Legacy PostgreSQL migration scripts (reference)
├── packages/                     # shared/, db/ (legacy PostgreSQL, unused)
├── .claude/skills/               # mps_designer/, terminate_mps/, etm_deploy/ (ssh-context is user-level, ~/.claude/skills/)
└── CLAUDE.md
```
