import { useState, type ReactNode } from 'react'
import { Outlet, useSearchParams } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { MobileNav } from './MobileNav'
import { HeaderActionsProvider } from '@/contexts/HeaderActionsContext'

interface AppShellProps {
  children?: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [searchParams] = useSearchParams()
  const embed = searchParams.get('embed') === 'true'

  if (embed) {
    return (
      <div className="h-screen bg-background flex flex-col overflow-hidden">
        <main className="flex-1 min-h-0 p-4 flex flex-col overflow-hidden">
          {children || <Outlet />}
        </main>
      </div>
    )
  }

  return (
    <HeaderActionsProvider>
    <div className="h-screen bg-background flex overflow-hidden">
      {/* Desktop Sidebar */}
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        className="hidden lg:flex"
      />

      {/* Mobile Navigation */}
      <MobileNav open={mobileNavOpen} onOpenChange={setMobileNavOpen} />

      {/* Main Content */}
      <div
        className={`flex-1 flex flex-col min-w-0 overflow-hidden transition-all duration-300 ${
          sidebarCollapsed ? 'lg:ml-16' : 'lg:ml-64'
        }`}
      >
        <Header
          onMenuClick={() => setMobileNavOpen(true)}
          sidebarCollapsed={sidebarCollapsed}
        />

        <main className="flex-1 min-h-0 p-4 lg:p-6 flex flex-col overflow-hidden">
          {children || <Outlet />}
        </main>
      </div>
    </div>
    </HeaderActionsProvider>
  )
}
