import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { PagePlaceholder } from '@/components/shared/PagePlaceholder'
import { Dashboard } from '@/pages/Dashboard'
import {
  FileText,
  ClipboardCheck,
  BarChart3,
  type LucideIcon,
} from 'lucide-react'

// PagePlaceholder takes a LucideIcon — widen it locally so our custom
// SVG components (FabricRollIcon, etc.) are accepted too. They share
// the same React props shape.
const PlaceholderIcon = (c: unknown) => c as LucideIcon

// Placeholder component factory
function createPlaceholder(title: string, description: string, Icon: LucideIcon) {
  return function PlaceholderPage() {
    return <PagePlaceholder title={title} description={description} icon={Icon} />
  }
}

// Fils placeholder (prévisions only — other Fils sub-screens are real)
const FilsPrevisionsPage = createPlaceholder('Prévisions Fournisseurs', 'Prévisions d\'approvisionnement fournisseurs', FileText)

// Références Finis / Études coloris / Tarifs — real screens (not placeholders anymore)
// Actions qualité — real screen (not a placeholder anymore)
const QualiteAnalysePage = createPlaceholder('Analyse', 'Analyse qualité', BarChart3)
// Commandes clients — real screen (not a placeholder anymore)
// Commandes fils — real screen (not a placeholder anymore)

// Fils pages (real)
import { FilsGestion } from '@/pages/FilsGestion'
import { FilsReferences } from '@/pages/FilsReferences'
import { FilsStock } from '@/pages/FilsStock'
import { FilsCommandes } from '@/pages/FilsCommandes'
import { ClientsCommandes } from '@/pages/ClientsCommandes'
import { ClientsFacturation } from '@/pages/ClientsFacturation'
import { ClientsDevis } from '@/pages/ClientsDevis'
import { ClientsExpeditions } from '@/pages/ClientsExpeditions'
import { ClientsGestion } from '@/pages/ClientsGestion'

// Sous-traitants pages (real)
import { SousTraitantsCommandes } from '@/pages/SousTraitantsCommandes'
import { SousTraitantsGestion } from '@/pages/SousTraitantsGestion'

// Transferts pages (real)
import { TransfertsRouleaux } from '@/pages/TransfertsRouleaux'
import { TransfertsFils } from '@/pages/TransfertsFils'

// Qualité pages (real)
import { QualiteSuiviLots } from '@/pages/QualiteSuiviLots'
import { QualiteDossiers } from '@/pages/QualiteDossiers'
import { QualiteActions } from '@/pages/QualiteActions'

// Tombé Métier pages (real)
import { TombeMetierReferences } from '@/pages/TombeMetierReferences'
import { TombeMetierStock } from '@/pages/TombeMetierStock'

// Divers pages (real)
import { DiversReferences } from '@/pages/DiversReferences'
import { DiversStock } from '@/pages/DiversStock'

// Finis pages (real)
import { FinisReferences } from '@/pages/FinisReferences'
import { EtudesColoris } from '@/pages/EtudesColoris'
import { FinisStock } from '@/pages/FinisStock'
import { FinisTarifs } from '@/pages/FinisTarifs'

// Prospects pages (real)
import { ProspectsDemandes } from '@/pages/ProspectsDemandes'

// Rapports pages (real)
import { RapportCommandesSst } from '@/pages/RapportCommandesSst'
import { RapportCommandesClients } from '@/pages/RapportCommandesClients'
import { RapportCommandesFil } from '@/pages/RapportCommandesFil'
import { RapportFinance } from '@/pages/RapportFinance'

// Réseau pages
import { Entreprises } from '@/pages/Entreprises'

// Settings
import { SettingsUtilisateurs } from '@/pages/SettingsUtilisateurs'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      // Dashboard — `/` is the primary one, the rest are the user's own
      // tableaux de bord (see components/dashboard/useDashboardLayout.ts)
      { index: true, element: <Dashboard /> },
      { path: 'tableau-de-bord/:dashboardId', element: <Dashboard /> },

      // Prospects
      { path: 'prospects', element: <Navigate to="/prospects/demandes" replace /> },
      { path: 'prospects/demandes', element: <ProspectsDemandes /> },

      // Clients
      { path: 'clients', element: <Navigate to="/clients/commandes" replace /> },
      { path: 'clients/commandes', element: <ClientsCommandes /> },
      { path: 'clients/devis', element: <ClientsDevis /> },
      { path: 'clients/expeditions', element: <ClientsExpeditions /> },
      { path: 'clients/facturation', element: <ClientsFacturation /> },
      { path: 'clients/gestion', element: <ClientsGestion /> },

      // Sous-traitants
      { path: 'sous-traitants', element: <Navigate to="/sous-traitants/commandes" replace /> },
      { path: 'sous-traitants/commandes', element: <SousTraitantsCommandes /> },
      { path: 'sous-traitants/gestion', element: <SousTraitantsGestion /> },

      // Transferts
      { path: 'transferts', element: <Navigate to="/transferts/rouleaux" replace /> },
      { path: 'transferts/rouleaux', element: <TransfertsRouleaux /> },
      { path: 'transferts/fils', element: <TransfertsFils /> },

      // Fils
      { path: 'fils', element: <Navigate to="/fils/references" replace /> },
      { path: 'fils/references', element: <FilsReferences /> },
      { path: 'fils/stock', element: <FilsStock /> },
      { path: 'fils/commandes', element: <FilsCommandes /> },
      { path: 'fils/gestion', element: <FilsGestion /> },
      { path: 'fils/previsions', element: <FilsPrevisionsPage /> },

      // Tombé Métier
      { path: 'tombe-metier', element: <Navigate to="/tombe-metier/references" replace /> },
      { path: 'tombe-metier/references', element: <TombeMetierReferences /> },
      { path: 'tombe-metier/stock', element: <TombeMetierStock /> },

      // Finis
      { path: 'finis', element: <Navigate to="/finis/references" replace /> },
      { path: 'finis/references', element: <FinisReferences /> },
      { path: 'finis/stock', element: <FinisStock /> },
      { path: 'finis/etudes-coloris', element: <EtudesColoris /> },
      { path: 'finis/tarifs', element: <FinisTarifs /> },

      // Divers
      { path: 'divers', element: <Navigate to="/divers/references" replace /> },
      { path: 'divers/references', element: <DiversReferences /> },
      { path: 'divers/stock', element: <DiversStock /> },

      // Qualité
      { path: 'qualite', element: <Navigate to="/qualite/suivi-lots" replace /> },
      { path: 'qualite/suivi-lots', element: <QualiteSuiviLots /> },
      { path: 'qualite/dossiers', element: <QualiteDossiers /> },
      { path: 'qualite/actions', element: <QualiteActions /> },
      { path: 'qualite/analyse', element: <QualiteAnalysePage /> },

      // Rapports
      { path: 'rapports', element: <Navigate to="/rapports/commandes-clients" replace /> },
      { path: 'rapports/commandes-clients', element: <RapportCommandesClients /> },
      { path: 'rapports/commandes-sst', element: <RapportCommandesSst /> },
      { path: 'rapports/commandes-fils', element: <RapportCommandesFil /> },
      // The page renders its own "Accès restreint" state without the
      // view_rapport_finance permission; the API refuses too.
      { path: 'rapports/finance', element: <RapportFinance /> },

      // Réseau
      { path: 'reseau', element: <Navigate to="/reseau/entreprises" replace /> },
      { path: 'reseau/entreprises', element: <Entreprises /> },

      // Settings (admin-only sub-routes)
      { path: 'settings', element: <Navigate to="/settings/utilisateurs" replace /> },
      { path: 'settings/utilisateurs', element: <SettingsUtilisateurs /> },
    ],
  },
])
