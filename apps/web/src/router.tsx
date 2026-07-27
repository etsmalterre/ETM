import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { PagePlaceholder } from '@/components/shared/PagePlaceholder'
import { Dashboard } from '@/pages/Dashboard'
import {
  ShoppingCart,
  FileText,
  FileBarChart,
  Palette,
  Euro,
  Droplet,
  TrendingUp,
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

// Références Finis — real screen (not a placeholder anymore)
// Études coloris — real screen (not a placeholder anymore)
const FinisTarifsPage = createPlaceholder('Tarifs Finis', 'Tarifs des produits finis', Euro)
const FinisColorisTeintPage = createPlaceholder('Coloris Teint', 'Coloris teints et ennoblissement', Droplet)
const FinisPrevisionsPage = createPlaceholder('Prévisions Finis', 'Prévisions des produits finis', TrendingUp)
const QualiteActionsPage = createPlaceholder('Actions', 'Actions qualité', ClipboardCheck)
const QualiteAnalysePage = createPlaceholder('Analyse', 'Analyse qualité', BarChart3)
const RapportsCommandesClientsPage = createPlaceholder('Commandes clients', 'Rapports sur les commandes clients', ShoppingCart)
const RapportsCommandesFilsPage = createPlaceholder('Commandes fils', 'Rapports sur les commandes de fils', FileBarChart)

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

// Tombé Métier pages (real)
import { TombeMetierReferences } from '@/pages/TombeMetierReferences'
import { TombeMetierStock } from '@/pages/TombeMetierStock'

// Divers pages (real)
import { DiversReferences } from '@/pages/DiversReferences'

// Finis pages (real)
import { FinisReferences } from '@/pages/FinisReferences'
import { EtudesColoris } from '@/pages/EtudesColoris'
import { FinisStock } from '@/pages/FinisStock'

// Prospects pages (real)
import { ProspectsDemandes } from '@/pages/ProspectsDemandes'

// Rapports pages (real)
import { RapportCommandesSst } from '@/pages/RapportCommandesSst'

// Réseau pages
import { Entreprises } from '@/pages/Entreprises'

// Settings
import { SettingsUtilisateurs } from '@/pages/SettingsUtilisateurs'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      // Dashboard
      { index: true, element: <Dashboard /> },

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
      { path: 'finis/tarifs', element: <FinisTarifsPage /> },
      { path: 'finis/coloris-teint', element: <FinisColorisTeintPage /> },
      { path: 'finis/previsions', element: <FinisPrevisionsPage /> },

      // Divers
      { path: 'divers', element: <Navigate to="/divers/references" replace /> },
      { path: 'divers/references', element: <DiversReferences /> },

      // Qualité
      { path: 'qualite', element: <Navigate to="/qualite/suivi-lots" replace /> },
      { path: 'qualite/suivi-lots', element: <QualiteSuiviLots /> },
      { path: 'qualite/dossiers', element: <QualiteDossiers /> },
      { path: 'qualite/actions', element: <QualiteActionsPage /> },
      { path: 'qualite/analyse', element: <QualiteAnalysePage /> },

      // Rapports
      { path: 'rapports', element: <Navigate to="/rapports/commandes-clients" replace /> },
      { path: 'rapports/commandes-clients', element: <RapportsCommandesClientsPage /> },
      { path: 'rapports/commandes-sst', element: <RapportCommandesSst /> },
      { path: 'rapports/commandes-fils', element: <RapportsCommandesFilsPage /> },

      // Réseau
      { path: 'reseau', element: <Navigate to="/reseau/entreprises" replace /> },
      { path: 'reseau/entreprises', element: <Entreprises /> },

      // Settings (admin-only sub-routes)
      { path: 'settings', element: <Navigate to="/settings/utilisateurs" replace /> },
      { path: 'settings/utilisateurs', element: <SettingsUtilisateurs /> },
    ],
  },
])
