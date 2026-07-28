// Tableau de bord — a per-user customisable grid of widgets.
//
// Permission decides AVAILABILITY (the `dashboard_*` keys, granted in
// Paramètres › Utilisateurs); this screen's "Personnaliser" mode decides
// DISPLAY: which of the available widgets are shown, where, and at what size.
//
// The desktop grid is react-grid-layout with VERTICAL COMPACTION: widgets have
// real (x, y) positions, dragging shows a live placeholder while the others
// glide aside, and gravity pulls everything up so no holes survive. This is
// what lets a widget sit in the right column under a short neighbour while a
// tall one fills the left — the order-based flow model this replaced could
// not express that. Below `lg` the grid is bypassed: one column, ordered by
// (y, x), definite heights so scrolling widget bodies still engage.
//
// Everything about a widget lives in components/dashboard/registry.tsx —
// adding one is a single entry there, not an edit to this file.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GridLayout, verticalCompactor, type Layout, type LayoutItem } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import { Eye, LayoutDashboard, LayoutGrid, Loader2, Pencil, RotateCcw, Save, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import { cn } from '@/lib/utils'
import { HeaderActions } from '@/contexts/HeaderActionsContext'
import { DashboardContextMenu, type ContextMenuItem } from '@/components/dashboard/DashboardContextMenu'
import { WidgetChromeProvider, type WidgetChrome } from '@/components/dashboard/WidgetFrame'
import { findWidget, type WidgetDef } from '@/components/dashboard/registry'
import {
  GRID_COLUMNS,
  GRID_MARGIN_PX,
  GRID_ROW_HEIGHT_PX,
  MIN_WIDGET_HEIGHT_UNITS,
  heightToUnits,
  unitsToHeight,
} from '@/components/dashboard/types'
import {
  defaultDraft,
  draftSignature,
  useDashboardLayout,
  type DraftLayout,
} from '@/components/dashboard/useDashboardLayout'

/** Desktop is Tailwind `lg` — below that the positional grid is meaningless
 *  (everything is one column) so we render a plain stack instead. */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => window.matchMedia('(min-width: 1024px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isDesktop
}

export function Dashboard() {
  const { available, saved, isLoading, isSaving, save } = useDashboardLayout()
  const isDesktop = useIsDesktop()

  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<DraftLayout | null>(null)
  const [resetConfirm, setResetConfirm] = useState(false)

  // While customising we render the draft; otherwise the persisted layout.
  const layout = draft ?? saved
  const isDirty = isEditing && draft !== null && draftSignature(draft) !== draftSignature(saved)

  const startEdit = useCallback(() => {
    setDraft(saved)
    setIsEditing(true)
  }, [saved])

  const cancelEdit = useCallback(() => {
    setDraft(null)
    setIsEditing(false)
  }, [])

  const commit = useCallback(async () => {
    if (draft) await save(draft)
    setDraft(null)
    setIsEditing(false)
  }, [draft, save])

  const guard = useUnsavedGuard({
    isDirty,
    save: commit,
    onDiscard: cancelEdit,
  })

  const mutate = useCallback((fn: (d: DraftLayout) => DraftLayout) => {
    setDraft((prev) => (prev ? fn(prev) : prev))
  }, [])

  // react-grid-layout reports every settled drag/resize/compaction through
  // onLayoutChange — fold it back into the draft (px for heights, columns for
  // the rest). Only wired while editing; the view-mode grid is read-only.
  const applyGridLayout = useCallback((next: Layout) => {
    mutate((d) => {
      let changed = false
      const sizes = { ...d.sizes }
      for (const it of next) {
        const cur = sizes[it.i]
        if (!cur) continue
        const heightPx = unitsToHeight(it.h)
        if (cur.x !== it.x || cur.y !== it.y || cur.width !== it.w || cur.heightPx !== heightPx) {
          sizes[it.i] = { x: it.x, y: it.y, width: it.w, heightPx }
          changed = true
        }
      }
      return changed ? { ...d, sizes } : d
    })
  }, [mutate])

  const hideWidget = useCallback((key: string) => {
    mutate((d) => ({
      ...d,
      visible: d.visible.filter((k) => k !== key),
      hidden: d.hidden.includes(key) ? d.hidden : [...d.hidden, key],
    }))
  }, [mutate])

  const showWidget = useCallback((key: string) => {
    mutate((d) => ({
      ...d,
      hidden: d.hidden.filter((k) => k !== key),
      visible: d.visible.includes(key) ? d.visible : [...d.visible, key],
    }))
  }, [mutate])

  // Right-click accelerator. Mirrors what the header buttons already offer —
  // never the only path to any of these (see DashboardContextMenu).
  const contextItems: ContextMenuItem[] = isEditing
    ? [
        { key: 'save', label: 'Enregistrer la disposition', icon: Save, onSelect: () => void commit() },
        { key: 'reset', label: 'Réinitialiser la disposition', icon: RotateCcw, onSelect: () => setResetConfirm(true) },
        { key: 'cancel', label: 'Annuler les modifications', icon: X, onSelect: cancelEdit },
      ]
    : [
        { key: 'edit', label: 'Personnaliser le tableau de bord', icon: LayoutGrid, onSelect: startEdit },
        { key: 'reset', label: 'Réinitialiser la disposition', icon: RotateCcw, onSelect: () => { startEdit(); setResetConfirm(true) } },
      ]

  const visibleDefs = useMemo(
    () => layout.visible.map(findWidget).filter((d): d is WidgetDef => !!d),
    [layout.visible],
  )
  const hiddenDefs = useMemo(
    () => layout.hidden.map(findWidget).filter((d): d is WidgetDef => !!d),
    [layout.hidden],
  )

  if (isLoading) {
    return (
      <div className="animate-fade-in -m-4 lg:-m-6 flex-1 min-h-0 overflow-auto bg-muted/70 p-4 lg:p-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="h-72 animate-pulse rounded-xl bg-muted" />
          <div className="h-72 animate-pulse rounded-xl bg-muted" />
        </div>
      </div>
    )
  }

  if (available.length === 0) {
    return (
      <div className="animate-fade-in -m-4 lg:-m-6 flex-1 min-h-0 overflow-auto bg-muted/70 p-4 lg:p-6">
        <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <LayoutDashboard className="h-12 w-12 opacity-30" />
          <p className="text-sm">Aucun widget n'est activé pour votre compte.</p>
        </div>
      </div>
    )
  }

  return (
    <DashboardContextMenu
      items={contextItems}
      className="animate-fade-in -m-4 lg:-m-6 flex-1 min-h-0 overflow-auto bg-muted/70 p-4 lg:p-6 scrollbar-transparent"
    >
      {/* Screen actions live in the app header (§HeaderActionsContext): the
          header is sticky, so Enregistrer stays reachable while scrolling. */}
      <HeaderActions>
        {isEditing ? (
          <>
            <Badge className="bg-accent text-accent-foreground gap-1 shadow-sm flex-shrink-0">
              <Pencil className="h-3 w-3" />
              <span className="hidden sm:inline">Mode edition</span>
            </Badge>
            <Button
              variant="outline" size="sm" title="Réinitialiser la disposition"
              onClick={() => setResetConfirm(true)} disabled={isSaving}
            >
              <RotateCcw className="h-3.5 w-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">Réinitialiser</span>
            </Button>
            <Button
              variant="outline" size="sm" title="Annuler les modifications"
              onClick={cancelEdit} disabled={isSaving}
            >
              <X className="h-3.5 w-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">Annuler</span>
            </Button>
            <Button size="sm" title="Enregistrer la disposition" onClick={commit} disabled={isSaving}>
              {isSaving
                ? <Loader2 className="h-3.5 w-3.5 sm:mr-1.5 animate-spin" />
                : <Save className="h-3.5 w-3.5 sm:mr-1.5" />}
              <span className="hidden sm:inline">Enregistrer</span>
            </Button>
          </>
        ) : (
          <Button variant="gold" size="sm" title="Personnaliser le tableau de bord" onClick={startEdit}>
            <LayoutGrid className="h-3.5 w-3.5 sm:mr-1.5" />
            <span className="hidden sm:inline">Personnaliser</span>
          </Button>
        )}
      </HeaderActions>

      {visibleDefs.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-white/50 py-16 text-center text-muted-foreground">
          <LayoutDashboard className="h-12 w-12 opacity-30" />
          <p className="text-sm">Tous vos widgets sont masqués.</p>
          {!isEditing && (
            <Button variant="gold" size="sm" onClick={startEdit}>
              <LayoutGrid className="h-3.5 w-3.5 mr-1.5" />Personnaliser
            </Button>
          )}
        </div>
      ) : isDesktop ? (
        <WidgetGrid
          defs={visibleDefs}
          layout={layout}
          isEditing={isEditing}
          onLayoutChange={applyGridLayout}
          onHide={hideWidget}
        />
      ) : (
        <MobileStack defs={visibleDefs} layout={layout} isEditing={isEditing} onHide={hideWidget} />
      )}

      {isEditing && <HiddenTray defs={hiddenDefs} onShow={showWidget} />}

      <ConfirmDialog
        open={resetConfirm}
        variant="default"
        title="Réinitialiser le tableau de bord"
        description="Tous les widgets auxquels vous avez accès seront réaffichés, dans leur disposition et leur taille d'origine. Rien n'est enregistré tant que vous n'avez pas cliqué sur « Enregistrer »."
        confirmLabel="Réinitialiser"
        onCancel={() => setResetConfirm(false)}
        onConfirm={() => { setDraft(defaultDraft(available)); setResetConfirm(false) }}
      />

      <UnsavedChangesDialog
        open={guard.showDialog}
        onAction={guard.handleAction}
        isSaving={guard.isSaving}
      />
    </DashboardContextMenu>
  )
}

// ── Desktop grid (react-grid-layout) ─────────────────────────

function WidgetGrid({
  defs, layout, isEditing, onLayoutChange, onHide,
}: {
  defs: WidgetDef[]
  layout: DraftLayout
  isEditing: boolean
  onLayoutChange: (next: Layout) => void
  onHide: (key: string) => void
}) {
  // Own the width measurement (ResizeObserver) instead of RGL's WidthProvider:
  // the sidebar collapse animates the content area without a window resize,
  // which WidthProvider would miss.
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setWidth(Math.round(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rglLayout: LayoutItem[] = useMemo(
    () => defs.map((def) => {
      const s = layout.sizes[def.key]
      return {
        i: def.key,
        x: s?.x ?? 0,
        y: s?.y ?? 0,
        w: s?.width ?? def.defaultWidth,
        h: heightToUnits(s?.heightPx ?? def.defaultHeightPx),
        minW: def.minWidth,
        minH: MIN_WIDGET_HEIGHT_UNITS,
      }
    }),
    [defs, layout.sizes],
  )

  return (
    <div ref={wrapRef} className={cn('dashboard-grid', isEditing && 'dashboard-grid--editing')}>
      {width > 0 && (
        <GridLayout
          width={width}
          gridConfig={{
            cols: GRID_COLUMNS,
            rowHeight: GRID_ROW_HEIGHT_PX,
            margin: [GRID_MARGIN_PX, GRID_MARGIN_PX],
            containerPadding: [0, 0],
          }}
          // Vertical gravity: widgets fall upward into free space, so a widget
          // dropped in a column snugs up under its neighbour and no holes form.
          compactor={verticalCompactor}
          dragConfig={{ enabled: isEditing, cancel: '.widget-no-drag' }}
          resizeConfig={{ enabled: isEditing, handles: ['e', 's', 'se'] }}
          layout={rglLayout}
          onLayoutChange={isEditing ? onLayoutChange : undefined}
        >
          {defs.map((def) => (
            <div key={def.key}>
              <WidgetChromeProvider chrome={{ isEditing, onHide: () => onHide(def.key) }}>
                <def.Component />
              </WidgetChromeProvider>
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  )
}

// ── Mobile stack (< lg) ───────────────────────────────────────

function MobileStack({
  defs, layout, isEditing, onHide,
}: {
  defs: WidgetDef[]
  layout: DraftLayout
  isEditing: boolean
  onHide: (key: string) => void
}) {
  // Reading order = grid order: top to bottom, then left to right.
  const sorted = useMemo(
    () => [...defs].sort((a, b) => {
      const sa = layout.sizes[a.key]; const sb = layout.sizes[b.key]
      return (sa?.y ?? 0) - (sb?.y ?? 0) || (sa?.x ?? 0) - (sb?.x ?? 0)
    }),
    [defs, layout.sizes],
  )
  return (
    <div className="space-y-4">
      {sorted.map((def) => (
        // Height must be DEFINITE, not a minimum: with `auto` the card grows to
        // its content and a scrolling widget body never engages.
        <div key={def.key} style={{ height: layout.sizes[def.key]?.heightPx ?? def.defaultHeightPx }}>
          <WidgetChromeProvider chrome={{ isEditing, onHide: () => onHide(def.key) }}>
            <def.Component />
          </WidgetChromeProvider>
        </div>
      ))}
    </div>
  )
}

// ── Hidden widgets tray ───────────────────────────────────────

function HiddenTray({ defs, onShow }: { defs: WidgetDef[]; onShow: (key: string) => void }) {
  return (
    <div className="mt-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Widgets masqués
      </p>
      <div className="flex min-h-[72px] flex-wrap items-start gap-2 rounded-xl border border-dashed border-border bg-white/50 p-3">
        {defs.length === 0 ? (
          <p className="w-full self-center text-center text-xs italic text-muted-foreground">
            Masquez un widget avec l'icône <Eye className="inline h-3.5 w-3.5 align-text-bottom" /> barrée de son en-tête.
          </p>
        ) : (
          defs.map((def) => {
            const Icon = def.icon
            return (
              <button
                key={def.key}
                type="button"
                onClick={() => onShow(def.key)}
                title={`Afficher « ${def.title} »`}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-sm shadow-sm transition-colors hover:border-accent/50 hover:bg-accent/5"
              >
                <Eye className="h-3.5 w-3.5 text-accent" />
                <Icon className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{def.title}</span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
