# MPS Designer Skill

## Overview

Design system for **MPS_NG**, the ERP system for **ETS Malterre** (French textile/knitting manufacturer). This document is the single source of truth for all visual patterns — follow it precisely when building new screens or modifying existing ones.

## Reference implementations — the three named layouts

There are **three** gold-standard layouts in the codebase, each with a short name. **Use these names** ("Fiche", "Tableau", "Classeur") when discussing layouts with the user. Pick the one whose layout matches the use case before writing any code; do not invent a fourth layout pattern.

| Name | Screen | File | Use when |
|---|---|---|---|
| **Fiche** (3-panel master-detail) | `/fils/gestion` | `apps/web/src/pages/FilsGestion.tsx` | One entity at a time has rich nested data (contacts, addresses, sub-resources) and the user works on one record start-to-finish. Implements `MasterDetailLayout`, collapsible card sections with status-colored items, side-by-side edit dialogs with file upload + PDF preview, sidebar tabs with inline edit forms, global vs per-section edit state. **§4–§9, §18, §21–§25.** |
| **Tableau** (table-centric + slide-in drawer) | `/fils/stock` | `apps/web/src/pages/FilsStock.tsx` | The page is fundamentally a sortable / searchable list of many flat rows; selecting a row reveals a focused detail view, but the row-set is the primary working surface. Implements toolbar (search + filters + create), split-aligned sortable table, right slide-in drawer, embed-mode top-offset, "Nouveau" creation dialog, KV-row drawer cards, mobile card list below `md`. **§27, §40.** |
| **Classeur** (Fiche variant: master-tabbed center panel) | `/clients/gestion` | `apps/web/src/pages/ClientsGestion.tsx` | Same 3-panel shell as Fiche, but the center panel holds several independent, read-mostly datasets of which the user consults **one at a time** — a row of master tabs gives the active dataset the full panel height instead of stacked collapsible sections. **§39.** |

When in doubt about a single rule, look at the references. When in doubt about which *layout* to choose, ask the user — do NOT mix patterns into a hybrid design.

**Every edit-mode screen — regardless of layout — must also plug into the unsaved-changes guard (§28).** This is not optional; it applies to both patterns above.

---

## 1. Brand Colors

### Primary Palette

| Name | Hex | HSL | CSS Variable | Usage |
|------|-----|-----|--------------|-------|
| **Primary Blue** | `#143D6B` | `211 68% 25%` | `--primary` | Sidebar background, primary buttons |
| **Vivid Gold** | `#F2B80A` | `44 92% 50%` | `--accent` / `--gold` | CTAs, active states, highlights, focus rings |
| **Accent Blue** | `#3B7DC9` | `211 68% 35%` | `--accent-blue` | Links, secondary actions |

### Extended Palette

| Name | HSL | CSS Variable | Usage |
|------|-----|--------------|-------|
| Teal | `175 42% 45%` | `--teal` | Complementary accent, alt badges |
| Terracotta | `18 55% 48%` | `--terracotta` | Warm accent, alt icon boxes |
| Sand | `38 20% 93%` | `--sand` | Warm surface backgrounds |
| Success Green | `152 69% 40%` | `--success` | Success states |
| Warning Amber | `38 92% 50%` | `--warning` | Warning states |
| Destructive Red | `0 72% 51%` | `--destructive` | Error states, delete actions |

### Surface Colors

| Name | HSL | CSS Variable | Usage |
|------|-----|--------------|-------|
| Background | `40 18% 99%` | `--background` | Page background (bright warm white) |
| Card | `0 0% 100%` | `--card` | Card surfaces (pure white) |
| Muted | `38 12% 96%` | `--muted` | Disabled backgrounds, soft surfaces |
| Border | `211 10% 91%` | `--border` | Default borders |

### Shadows (Blue-tinted)

All shadows have a soft blue tint from `rgb(20 61 107)`:

```css
--shadow-sm: 0 1px 2px 0 rgb(20 61 107 / 0.04), 0 1px 3px 0 rgb(20 50 90 / 0.02);
--shadow-md: 0 4px 6px -1px rgb(20 61 107 / 0.05), 0 2px 4px -2px rgb(20 50 90 / 0.02);
--shadow-lg: 0 10px 15px -3px rgb(20 61 107 / 0.06), 0 4px 6px -4px rgb(20 50 90 / 0.03);
```

### Gradients

```css
--gradient-brand: linear-gradient(135deg, hsl(211 68% 25%) 0%, hsl(211 68% 18%) 100%);
--gradient-accent: linear-gradient(135deg, hsl(44 92% 50%) 0%, hsl(44 92% 43%) 100%);
--gradient-accent-subtle: linear-gradient(135deg, hsl(44 92% 50% / 0.10) 0%, hsl(44 92% 50% / 0.03) 100%);
```

---

## 2. Typography

### Fonts (OS system stack)

The app intentionally uses the **OS default UI font** for everything — Segoe UI on Windows, San Francisco on macOS, Roboto on Android/Linux — via the `system-ui` CSS keyword. No web fonts are loaded. No `@import` in `index.css`, no `<link>` tags in `index.html`, no `@font-face`.

| Tailwind Class | Resolves to | Usage |
|----------------|-------------|-------|
| `font-sans` | system-ui stack | Body text (default) |
| `font-heading` | system-ui stack | Headings (h1-h6), applied automatically via base CSS |

Both utilities map to the same stack in `tailwind.config.js`:

```js
fontFamily: {
  sans: ["system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
  heading: ["system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
}
```

`font-heading` is kept as a separate utility (identical resolution) because many call sites already use `className="font-heading"` on headings and we want room to swap in a real display font later if needed.

**Historical note**: earlier iterations of this project tried to load Anton (display) + Lato (body) from Google Fonts via `@import`. The `@import` statement was placed after `@tailwind base` in `index.css`, which is invalid per the CSS spec (`@import` must come before any style rule), so browsers silently dropped it and the fonts never loaded. The app rendered in the system stack the entire time, which is the look the project has grown into and kept. The broken `@import` and the Anton/Lato references were removed in April 2026 — do NOT re-add `@import url('https://fonts.googleapis.com/...')` to `index.css` without an explicit design decision to swap the heading font, because it will silently change every screen.

### Heading Pattern

All h1-h6 automatically get `font-heading tracking-tight` via base CSS in `index.css`. For explicit usage:

```tsx
<h1 className="text-2xl font-heading font-bold tracking-tight">Page Title</h1>
```

Because `font-heading` currently resolves to the same stack as `font-sans`, `font-heading` has no *visual* effect on its own — weight/size/tracking do the lifting. Keep the className on headings anyway so the swap is a one-line config change if we ever pick a real display font.

### Text Hierarchy

| Style | Class | Usage |
|-------|-------|-------|
| Page title | `text-2xl font-heading font-bold tracking-tight` | Main entity name in detail header |
| Card title | `text-sm font-semibold` | Card section headers (Notes, Competences) |
| Form title | `text-xs font-semibold text-accent uppercase tracking-wide` | InlineForm headers |
| Body text | `text-sm` | Default content |
| Secondary | `text-sm text-muted-foreground` | Descriptions, notes content |
| Caption | `text-xs text-muted-foreground` | Metadata, counts, dates |
| Empty state | `text-sm text-muted-foreground italic` | "Aucune note", "Aucun contact" |
| Badge label | `text-xs` or `text-[10px]` | Badge content |

---

## 3. App Shell Layout

### Structure (`AppShell.tsx`)

```
┌──────────────────────────────────────────────┐
│ [Sidebar]  │  [Header bar]                   │
│  fixed     │  sticky top, h-14               │
│  left      │──────────────────────────────────│
│  w-64/w-16 │  [Main content]                 │
│            │  flex-1, p-4 lg:p-6             │
│            │  overflow-hidden                 │
└──────────────────────────────────────────────┘
```

- Root: `h-screen bg-background flex overflow-hidden`
- Content area margin: `lg:ml-64` (expanded) or `lg:ml-16` (collapsed)
- Transition: `transition-all duration-300`

### Sidebar (`Sidebar.tsx`)

- **Width**: 256px expanded (`w-64`), 64px collapsed (`w-16`)
- **Position**: `fixed left-0 top-0 z-40 h-screen`
- **Background**: `bg-gradient-to-b from-primary via-primary/95 to-primary/90`
- **Border**: `border-r border-primary/20`
- **Logo**: `text-accent` (gold), `font-semibold text-2xl`, shows "MPS" expanded / "M" collapsed

#### Nav Items

```tsx
// Active state
className="bg-white/20 text-white"
// + gold indicator bar:
<div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-accent" />

// Inactive state
className="text-white/85 hover:bg-white/10 hover:text-white"

// Item dimensions
className="flex h-12 items-center gap-3 rounded-md px-3 text-sm font-medium"
```

#### Sections (top to bottom)
1. Logo bar (`h-14`, `border-b border-white/10`)
2. Dashboard item
3. Separator (`border-t border-white/10`)
4. Main navigation items (scrollable)
5. Settings item (`border-t border-white/10`)
6. Collapse toggle (`border-t border-white/10`)

### Header (`Header.tsx`)

```tsx
className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-gold/30 bg-gradient-to-r from-gold/40 via-gold/15 to-transparent px-4 lg:px-6 shadow-sm"
```

- **Height**: 56px (`h-14`)
- **Background**: Gold gradient left-to-right (darker left → transparent right)
- **Border bottom**: `border-gold/30`
- **Content** (left to right): Mobile menu button | Submenu tabs | Spacer | **Screen-actions slot** | Ticket | Fullscreen toggle | User avatar

#### Screen-actions slot (`HeaderActionsContext`)

A screen can portal its own **screen-level** controls into the header, right-aligned just left of the global actions (ticket / fullscreen / avatar), separated by a gold divider that only renders when the slot is filled (`[&:not(:empty)]:border-r`).

```tsx
import { HeaderActions } from '@/contexts/HeaderActionsContext'

<HeaderActions>
  <Button variant="gold" size="sm" title="Personnaliser le tableau de bord" onClick={startEdit}>
    <LayoutGrid className="h-3.5 w-3.5 sm:mr-1.5" />
    <span className="hidden sm:inline">Personnaliser</span>
  </Button>
</HeaderActions>
```

Rules:

- **This is for actions on the SCREEN AS A WHOLE**, not on a selected record. A record's actions belong in the detail header (§6.1 Print / Email / Modifier) — never up here. The reference consumer is the tableau de bord's "Personnaliser" + its edit-mode Réinitialiser / Annuler / Enregistrer.
- **Right-aligned, deliberately** — not next to the submenu tabs on the left. The tabs region belongs to navigation and can fill up later (e.g. if a screen gains sub-pages), and a control that moves once users have learned its position is worse than one that never had the left-hand space.
- **Use it when the action must survive scrolling.** The header is `sticky top-0` while page bodies scroll independently, so edit-mode Enregistrer / Annuler stay reachable at the bottom of a long page. An in-page toolbar row scrolls away — that's the bug this slot was introduced to fix on the dashboard.
- **Collapse labels below `sm`** per §40.5: `<span className="hidden sm:inline">`, icon margin `sm:mr-1.5`, and a `title` on every button (it becomes the accessible name once the label is hidden).
- **Embed mode has no header**, so `<HeaderActions>` renders nothing there. A screen must stay usable without its slot content — never put the only path to something in it.
- Implementation is a **DOM portal**, not a ReactNode in context state: the header hands out the slot element once via a callback ref and screens `createPortal` into it. Storing JSX in state would need a re-publish on every render (JSX identity changes each time) — a render loop waiting to happen.
- **Gotcha — portal events bubble through the REACT tree, not the DOM tree.** A click or context-menu event on slot content propagates to the *screen's* handlers, not the header's. Any `onContextMenu` / `onClick` on a screen's root wrapper must therefore verify the event target is physically inside its own subtree (`rootRef.current?.contains(target)`) before acting. This bit the dashboard's right-click menu, which opened when right-clicking the header buttons.

#### Submenu Tabs (in header)

```tsx
// Active tab
className="bg-accent text-accent-foreground shadow-sm"
// Inactive tab
className="text-muted-foreground hover:bg-accent/10 hover:text-accent"
// Shared
className="px-4 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap"
```

---

## 4. MasterDetailLayout (3-Panel) — the "Fiche" layout

Component: `apps/web/src/components/layout/MasterDetailLayout.tsx`
Hook: `apps/web/src/hooks/useResponsiveLayout.ts`

> **Don't use this for list-heavy screens.** If the page is fundamentally a sortable / searchable / filterable table of many flat rows, use the **Tableau pattern** in §27 instead — that's the layout used by `/fils/stock`. And if the center panel would stack several large read-mostly datasets consulted one at a time, use the **Classeur variant** (§39).

### Props

```typescript
{
  list: ReactNode           // Left panel content
  detailHeader: ReactNode   // Top of center panel
  detail: ReactNode         // Center panel body (scrollable)
  sidebar: ReactNode | null // Right panel content
  sidebarTitle?: string     // Drawer header label
  hasSelection: boolean     // Whether an item is selected
  onBack: () => void        // Back button handler (stacked mode)
}
```

### Responsive Modes

| Mode | Breakpoint | Layout |
|------|-----------|--------|
| **Full** | ≥ 1400px | 3 columns: list + detail + sidebar inline |
| **Compact** | 1240–1400px | 2 columns: list + detail; sidebar in right drawer |
| **Stacked** | < 1240px | 1 column: list OR detail; sidebar in right drawer |

### Full Mode Layout

```
┌─────────┬────────────────────────┬───────────┐
│  List   │  Detail Header         │  Sidebar  │
│  w-72   │────────────────────────│  w-96     │
│         │  Detail Body           │  (tabs)   │
│         │  (scrollable)          │           │
└─────────┴────────────────────────┴───────────┘
gap-4 between all panels
```

### Sidebar Drawer (compact/stacked modes)

```tsx
// Overlay
className="fixed inset-0 z-40 bg-black/50"
// Drawer panel
className="fixed top-0 right-0 z-50 h-full w-full max-w-md bg-background shadow-lg transition-transform duration-300"
// Slides: translate-x-full (hidden) → translate-x-0 (visible)
```

---

## 5. Left Panel: Entity List

Container:
```tsx
className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80"
```

### Panel Background Pattern

All panels (left list, right sidebar) and section item cards use **Zinc** background for contrast against white cards:
- **Panel body**: `bg-zinc-100/80` — neutral dense gray
- **Header/footer areas**: `bg-zinc-200/50` — slightly darker for visual structure
- **Item cards inside sections** (certificats, refs, commandes): `bg-zinc-100/80`
- **Contact/address cards in sidebar**: `bg-card` (white) since they sit on the zinc panel
- **Scrollbar**: Use `scrollbar-transparent` utility class for blending

### Search Bar (top, `border-b`)

```tsx
<div className="p-3 border-b rounded-t-lg bg-zinc-200/50">
  <div className="relative">
    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
    <input className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
  </div>
</div>
```

**Auto-select the first visible row** — mandatory on every master-detail screen, via the shared hook **`apps/web/src/hooks/useAutoSelectFirst.ts`**. Never hand-roll the effect.

```tsx
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'

// Declare the filtered memo immediately above the hook so `rows` is the array
// the left list actually renders.
const filtered = useMemo(() => {
  if (!refs) return []
  const q = searchQuery.trim().toLowerCase()
  if (!q) return refs
  return refs.filter((r) => r.reference.toLowerCase().includes(q))
}, [refs, searchQuery])

// Keep the selection valid against the search-filtered list: narrowing the
// search re-targets the top row instead of leaving the previous one on screen.
useAutoSelectFirst({
  rows: filtered,
  selectedId,
  getId: (r) => r.IDref_fini,
  select: setSelectedId,
  suspended: isEditing || autoEditForId !== null,
})
```

The contract:

- **`rows` MUST be the filtered array** (search + status-narrowed), never the raw query result. Passing the raw list is the single most common way to break this: the list narrows to one search hit while the detail panel keeps showing the previously selected record — confusing, and the exact bug fixed app-wide in July 2026 (Finis › Références, Fils › Références, Fils › Gestion, Entreprises, Sous-traitants › Gestion, Paramètres › Utilisateurs all shipped with the raw list). If your `filtered` memo currently sits *below* the hook call, move the memo up rather than passing the raw list.
- **Do NOT gate on `selectedId === null`.** That only fires on first load and leaves a narrowed search unselected. The hook re-targets whenever the selection leaves the visible set, and clears the selection to `null` when the list settles empty (so the placeholder shows instead of a stale detail).
- **`suspended` is how you avoid clobbering**, and there are exactly three reasons to pass it:
  - `isEditing` — never discard unsaved changes out from under the user. Always include it on screens with an edit mode.
  - `autoEditForId !== null` — the §25.1 create flow sets `setSelectedId(newId)` before the list refetch settles, so the stale filtered array wouldn't contain the new row yet and the hook would steal the selection back. Include it wherever `autoEditForId` exists.
  - `isFetching` — same race, on screens whose list query is **server**-filtered (search/status go to the API) so the row set genuinely empties between fetches. Client-filtered screens don't need it.
  - Screens whose create flow flips `setIsEditing(true)` synchronously in the mutation's `onSuccess` (the inline-create gestion screens) are already covered by `isEditing` alone.
- **Stacked (phone) mode is handled inside the hook** — there a null selection IS the list view, so it never auto-picks a row and falls back to `null` instead of jumping to another record's detail. Don't special-case this at the call site.
- The hook intentionally runs **with no dep array** (its `getId`/`select` are inline closures whose identity changes every render, and `select()` with the current value is a no-op).

References: every master-detail screen — `FinisReferences.tsx`, `DiversReferences.tsx`, `ClientsCommandes.tsx` (server-filtered, `isFetching`), `SousTraitantsGestion.tsx` (search + status filter).

### Left-list filter button group (segmented filter under the search bar)

When the left list needs a quick status / category filter (actif / inactif / tous, en cours / terminées / toutes, etc.), render it as a **borderless segmented button row immediately under the search input, inside the same `bg-zinc-200/50` header band**. This is the canonical pattern — do NOT wrap the buttons in a bordered `border border-input` box, and do NOT build an iOS-style pill toggle. Reference: `SousTraitantsCommandes.tsx` list header.

The header wrapper gets `space-y-2` so the search input and the filter row stack with consistent spacing:

```tsx
<div className="p-3 border-b rounded-t-lg bg-zinc-200/50 space-y-2">
  <div className="relative">
    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
    <input className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
  </div>
  <div className="flex flex-wrap gap-1">
    {filterOptions.map((opt) => (
      <button
        key={opt.key}
        type="button"
        onClick={() => onFilterChange(opt.key)}
        className={cn(
          'px-2 py-1 text-xs rounded-md transition-colors flex-grow basis-[calc(33.333%-0.25rem)]',
          filter === opt.key
            ? 'bg-accent text-accent-foreground shadow-sm font-medium'
            : 'text-muted-foreground hover:bg-accent/10',
        )}
      >
        {opt.label}
      </button>
    ))}
  </div>
</div>
```

Conventions — do not deviate:
- **Container**: `flex flex-wrap gap-1`. No border, no background box around the group. The buttons sit directly on the zinc header band.
- **Button base**: `px-2 py-1 text-xs rounded-md transition-colors flex-grow basis-[calc(33.333%-0.25rem)]`. The `flex-grow basis-[calc(33.333%-0.25rem)]` makes 3 buttons split the row evenly while still wrapping gracefully if there are more.
- **Active**: `bg-accent text-accent-foreground shadow-sm font-medium` (gold pill, `font-medium` ONLY on the active button).
- **Inactive**: `text-muted-foreground hover:bg-accent/10`.
- **Default selection**: pick the everyday working view (e.g. `actif` for a sous-traitant gestion list, `open`/`en cours` for an orders list), not `tous`. Drive the list's auto-select-first effect off the **filtered** array so it never lands on a row hidden by the active filter.

This is the same gold-pill active state used by the sidebar tab bar (§8) and the orders status filter — keep all three visually identical.

### List Items (scrollable body, `p-3 space-y-2 scrollbar-transparent`)

```tsx
// Selected item
className="p-3 border rounded-lg cursor-pointer border-accent bg-white ring-1 ring-accent"

// Unselected item
className="p-3 border rounded-lg cursor-pointer border-border bg-white hover:border-accent/50"
```

Item content:
- Row: icon (`h-4 w-4 text-muted-foreground`) + name (`font-medium text-sm truncate`)
- Optional subtitle: `text-xs text-muted-foreground mt-1 line-clamp-2`

### Footer (bottom, `border-t`)

```tsx
<div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
  <span>{count} entreprise{plural}</span>
  {!isEditing && (
    <Button size="sm" variant="ghost" className="text-accent hover:text-accent hover:bg-accent/10">
      <Plus className="h-3.5 w-3.5 mr-1" />Nouveau
    </Button>
  )}
</div>
```

#### "+ Nouveau" button — standard behavior

The new-item button at the bottom of the left list MUST follow this contract on every master-detail screen:

1. **Visibility**: shown only in **view mode** (`{!isEditing && ...}`). Hidden in edit mode.
   - **Why**: clicking it while editing would silently navigate away and auto-enter edit mode on the new item, losing unsaved changes on the current one. Hiding the button is simpler and more honest than an unsaved-changes guard.
2. **Click behavior** — pick one based on what initial data the entity needs:
   - **Inline-create** (default, used by Entreprises, FilsGestion, FilsReferences): POST a placeholder row (`nom: 'Nouvelle entreprise'`, sensible defaults) directly. No dialog.
   - **Modal** (used when the row needs real data up front — FilsCommandes asks for fournisseur+date+payment+addresses; EtudesColoris asks for client+ref fini+sous-traitant+libellé): a small focused dialog with only the fields needed to make the row meaningful.
3. **After save** (both paths): `setSelectedId(newId)` + auto-enter edit mode (typically via an `autoEditForId` effect that fires once after the detail loads).

**Exception**: table-centric screens (`FilsStock`) put the button in the header, gate it on permissions instead of edit mode, and may skip auto-edit. The exception is the table layout itself, not a license to deviate elsewhere.

**Placeholder screens**: when implementing a not-yet-built menu entry (Marketing, Transferts, Tombé Métier, etc.), default to the standard above from day one — don't reinvent.

### Empty/Loading States

- **Loading**: centered `<Loader2 className="h-6 w-6 animate-spin text-accent" />`
- **Error**: centered `<AlertCircle />` + error message in `text-destructive`
- **Empty list**: centered large icon (`h-12 w-12 opacity-50`) + `text-sm` message
- **No selection** (detail area): centered `icon-box-gold h-16 w-16` + instruction text

---

## 6. Center Panel: Detail Header

Position: flex-shrink-0 at top of center panel.

```tsx
<div className="flex-shrink-0 pt-0.5">
  <div className="flex items-center gap-3">
    {/* Icon box */}
    <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center',
      isEditing ? 'bg-accent/15' : 'icon-box-gold')}>
      <EntityIcon className="h-5 w-5" />
    </div>

    {/* Name + badges */}
    <div className="min-w-0 flex-1">
      {isEditing ? (
        <div className="flex items-center gap-3">
          <input className="flex-1 text-xl font-heading font-bold h-10 px-3 rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
          <Badge className="bg-accent text-accent-foreground flex-shrink-0 gap-1 shadow-sm">
            <Pencil className="h-3 w-3" />Mode edition
          </Badge>
        </div>
      ) : (
        <>
          <h1 className="text-2xl font-heading font-bold tracking-tight truncate">{name}</h1>
          {/* Optional badges below name */}
          <div className="flex gap-1.5 mt-1 flex-wrap">
            <Badge variant="secondary" className="text-xs">{label}</Badge>
          </div>
        </>
      )}
    </div>

    {/* Action buttons */}
    <div className="flex items-center gap-2 flex-shrink-0">
      {isEditing ? (
        <>
          <Button variant="outline" size="sm"><X />Annuler</Button>
          <Button size="sm"><Save />Enregistrer</Button>
        </>
      ) : (
        <>
          <Button variant="outline" size="icon" className="h-9 w-9" title="Action"><Icon /></Button>
          <Button variant="outline" size="sm"><Pencil />Modifier</Button>
        </>
      )}
    </div>
  </div>

  {/* Gold accent line below header */}
  <div className={cn('h-1 w-24 mt-3 rounded-full',
    isEditing ? 'bg-accent' : 'bg-gradient-to-r from-accent via-accent to-accent/30')} />
</div>
```

### Key Details

- **Icon box**: `h-11 w-11 rounded-lg`, uses `icon-box-gold` in view mode, `bg-accent/15` in edit mode
- **Name input** (edit mode): `text-xl font-heading font-bold h-10` — matches heading visually
- **"Mode edition" badge**: `bg-accent text-accent-foreground` with `Pencil` icon
- **Gold accent line**: `h-1 w-24 mt-3 rounded-full`, gradient in view mode, solid in edit mode
- **Buttons**: `size="sm"` for text buttons, `size="icon" className="h-9 w-9"` for icon-only

### 6.1 Standard view-mode action buttons (Print + Email + Modifier)

Every detail screen should surface the same canonical set of view-mode action buttons, in this order, right-aligned in the header row:

1. **Imprimer** — `<Printer>` icon, opens a placeholder Dialog (see §18 "En developpement")
2. **Envoyer un email** — `<AtSign>` icon (**not** `<Mail>`), opens a placeholder Dialog (see §18 "En developpement")
3. **Modifier** — `<Pencil>` icon + "Modifier" text, switches to edit mode. **Always `variant="gold"`** — the gold CTA is the canonical "enter edit mode" affordance across the whole app.

```tsx
// Inside the view-mode branch of the button row
<>
  <Button variant="outline" size="icon" className="h-9 w-9" title="Imprimer" onClick={onPrintClick}>
    <Printer className="h-4 w-4" />
  </Button>
  <Button variant="outline" size="icon" className="h-9 w-9" title="Envoyer un email" onClick={onEmailClick}>
    <AtSign className="h-4 w-4" />
  </Button>
  <Button variant="gold" size="sm" onClick={onStartEdit}>
    <Pencil className="h-3.5 w-3.5 mr-1.5" />Modifier
  </Button>
</>
```

**Icon choice is canonical**: use `AtSign` for the email *trigger* button (it's the recognisable "@" symbol and reads as an action, not a field label). `Mail` is reserved for the Dialog's large central icon and for contact-card sub-rows showing an email address inline. Do NOT swap them.

**Modifier button colour is canonical**: always `variant="gold"`. Never `variant="outline"`, never `variant="default"` (which is primary blue). The gold CTA across all screens reinforces "this is THE primary action on a view-mode screen — enter edit mode".

`onPrintClick` and `onEmailClick` flip page-level state (`setPrintModalOpen(true)` / `setEmailModalOpen(true)`) that opens the corresponding placeholder Dialog (§18). Both Dialogs are always mounted at the page root as siblings of the `MasterDetailLayout`, alongside any other top-level dialogs (`UnsavedChangesDialog`, `CreateXxxDialog`, etc.).

**When the screen can produce more than one document** (confirmation vs proforma, fiche technique vs fiche tarifs…), the Print/Email icon button does NOT act directly — it opens a small contextual popover menu listing the documents. See §42 (`DocMenuButton`). A single-document screen keeps the plain direct-action button.

Reference implementations: `apps/web/src/pages/Entreprises.tsx`, `apps/web/src/pages/FilsGestion.tsx`, `apps/web/src/pages/FilsStock.tsx`, and `apps/web/src/pages/FilsCommandes.tsx` — all four use `<Button variant="gold">` for the Modifier action.

---

## 7. Center Panel: Detail Body

The detail body hosts one of two layouts. Pick before writing code — they are not mixable:

| Shape | When to use | Outer classes |
|---|---|---|
| **Multi-section** — several distinct content groups stacked (notes, competences, certs, commandes, recommandations…) | The record has several independent concepts that each deserve their own titled surface | `flex-1 min-h-0 overflow-auto space-y-4` with one `<Card>` per section (often §23 collapsible) |
| **Single-list** — the whole center panel IS one list of rows (lignes of a commande, soumissions of an étude, mouvements of a stock lot…) | The record has one primary nested resource that's also its main interaction surface | `flex-1 min-h-0 flex flex-col` directly (§31 pattern), **no framing Card, no section title** |

For the single-list shape, **do not** wrap the rows in a `<Card>` with a "Section Title" + chevron + count-badge header. That pattern belongs to §23 (multi-section). The étude's title is already one screen-row above — a second "Soumissions" title would just duplicate it, eat vertical space, and invite the user to collapse the only thing on the screen. Render the row list as the flex-sibling body from §31.1, with the drawer as a second flex sibling below. Reference: `LignesSection` in `FilsCommandes.tsx`, `SoumissionsSection` in `EtudesColoris.tsx`.

### 7.1 The row-add button on a single-list center panel

References: `FilsCommandes.tsx`, `ClientsCommandes.tsx`, `ClientsDevis.tsx`, `ClientsFacturation.tsx`, `SousTraitantsCommandes.tsx` — all five render this identically.

The affordance that adds a row to a single-list center panel (a ligne, a pièce, a soumission…) has **exactly two renderings, and both live inside the scrollable rows container** — never in the totals footer, never in the detail header.

**1. Empty list** — a small outline button centered under the empty-state icon + message:

```tsx
<div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
  <Layers className="h-12 w-12 mb-3 opacity-40" />
  <p className="text-sm">Aucune ligne</p>
  {isEditing && !linesLocked && (
    <Button variant="outline" size="sm" className="mt-3" onClick={startAddLine}>
      <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter une ligne
    </Button>
  )}
</div>
```

**2. Non-empty list** — a full-width dashed ghost button as the **last child of the scroll container**, after the row cards, so it scrolls with them and always sits directly under the last row:

```tsx
{isEditing && !linesLocked && rows.length > 0 && (
  <Button
    variant="ghost"
    size="sm"
    onClick={startAddLine}
    className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
  >
    <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter une ligne
  </Button>
)}
```

Rules — do not deviate:

- **Classes are copy-paste fixed** for both states. The dashed border (`border border-dashed border-border/60`) + muted text is what makes the row read as "a slot waiting to be filled" rather than a competing CTA against Enregistrer.
- **Both renderings carry the same label and the same leading icon at `h-3.5 w-3.5 mr-1.5`.** The label describes what the click produces (`Ajouter une ligne`, `Ajouter un coloris`) with a `<Plus>` icon. When the click opens a manager that both adds *and* removes, name the manager (`Éditer le bon de transfert`) and pair it with `<Pencil>` — a `+` on a control that also deletes misreads the action. Never let the label or the icon differ between the empty and non-empty states, and give the dialog it opens the same title and icon (§18.A).
- **Never move the button between the two states.** Empty → centered in the empty state; non-empty → bottom of the list. Those are the only two positions, and both are inside the same scroll container, so the eye tracks it. Putting the non-empty variant in the totals footer (or anywhere outside the scroll container) makes it appear to vanish the moment the first row lands — the user looks where it was and finds nothing. This is the specific failure this rule exists to prevent.
- **Edit-mode gated** — both renderings hang off `isEditing` (plus whatever per-screen lock applies: `linesLocked`, permissions, `!showLineForm`, `editingLineId === null`). In view mode neither exists.
- When an inline `InlineForm` is open for a new/edited row, hide the button (`!showLineForm && editingLineId === null`) so there aren't two competing entry points.

The mirror rule for the **left list** is §5's "+ Nouveau" (view mode only, list footer). Don't confuse the two: §5 creates a whole record, §7.1 adds a row to the record already open.

### Cards (`.card-premium`)

```tsx
<Card className={cn('card-premium', isEditing && editSectionClass)}>
  <CardHeader className="pb-2">
    <CardTitle className="text-sm font-semibold">Section Title</CardTitle>
  </CardHeader>
  <CardContent>
    {/* content */}
  </CardContent>
</Card>
```

**Edit mode indicator** (`editSectionClass`):
```tsx
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'
```
Adds a gold left border and very subtle gold background tint.

### Card Header with Icon + Action

```tsx
<CardHeader className="flex flex-row items-center gap-2 pb-2">
  <Icon className="h-4 w-4 text-accent" />
  <CardTitle className="text-sm font-semibold">Title</CardTitle>
  <Badge variant="secondary" className="text-xs ml-auto">{count}</Badge>
  {isEditing && (
    <Button variant="ghost" size="icon" className="h-6 w-6">
      <Plus className="h-3.5 w-3.5" />
    </Button>
  )}
</CardHeader>
```

### Notes Card (view vs edit)

- **View**: `<p className="text-sm text-muted-foreground whitespace-pre-line">`
- **Empty**: `<p className="text-sm text-muted-foreground italic">Aucune note</p>`
- **Edit**: `<textarea rows={4} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />`

### Competence Badges

```tsx
// Existing competence
<Badge className="bg-accent/10 text-accent hover:bg-accent/20 border-accent/20">
  {label}
  {isEditing && (
    <button className="ml-1.5 rounded-full hover:bg-destructive/20 hover:text-destructive p-0.5 -mr-1 transition-colors">
      <X className="h-3 w-3" />
    </button>
  )}
</Badge>

// Available competence to add (shown on "+" click)
<Badge variant="outline" className="cursor-pointer hover:bg-accent/10 transition-colors">
  <Plus className="h-3 w-3 mr-1" />{label}
</Badge>
```

Available competences section: `mt-3 pt-3 border-t border-border/50 flex flex-wrap gap-2`

### Item View Cards (certificats, refs, commandes, recommandations)

Cards use a consistent two-row layout with a colored left accent border and an icon box.

**Important**: Use `cn()` to combine the base classes with the border color class. Do NOT use a static className string — `twMerge` inside `cn()` resolves `border` + `border-l-4` in a specific way that produces the correct thin left accent. A static `className="… border-l-4 border … border-l-amber-400/60"` skips that resolution and renders a **thick 4px amber bar** instead of the standard thin edge (this drift shipped on early Clients/Tombé Métier screens and was swept in July 2026 — `FilsCommandes.tsx` `LineCard` is the reference rendering). If you spot a card whose left amber edge looks thicker than the ones in Fils › Commandes, this is the cause.

#### Card Color Variants

The full status color system — left border, icon box, icon color, AND matching badge — should always be used together for visual consistency.

| Status | Left border | Icon bg | Icon color | Status badge |
|--------|-------------|---------|------------|--------------|
| **Neutral / Default** | `border-l-amber-400/60` | `bg-amber-400/10` | `text-amber-600` | `variant="secondary"` |
| **Success / Valid** | `border-l-green-500/60` | `bg-green-500/10` | `text-green-600` | `badge-success` |
| **Warning / In progress** | `border-l-amber-400/60` | `bg-amber-400/10` | `text-amber-600` | `badge-warning` |
| **Danger / Error / Expired** | `border-l-destructive/60` | `bg-destructive/10` | `text-destructive/70` | `variant="destructive"` |
| **Muted / Closed / Draft** | `border-l-border` | `bg-muted` | `text-muted-foreground` | `variant="outline"` |

**Amber/gold is the standard neutral color for item cards throughout the app** — use it for cards that don't have a meaningful status (e.g. references de fil, generic items). It's not just "warning".

#### Base Card Template

```tsx
<div className={cn(
  'group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3',
  'border-l-amber-400/60' // or dynamic borderColor variable
)}>
  {/* Top row: icon box + title + badges/actions */}
  <div className="flex items-center justify-between gap-2">
    <div className="flex items-center gap-2 min-w-0">
      <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
        <Icon className="h-3.5 w-3.5 text-amber-600" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{title}</p>
        <p className="text-[11px] text-muted-foreground truncate">{subtitle}</p>
      </div>
    </div>
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {/* Badges, hover-reveal edit/delete buttons */}
    </div>
  </div>
  {/* Bottom row: metadata */}
  <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
    <span>{detail}</span>
    <span className="ml-auto">{rightDetail}</span>
  </div>
</div>
```

#### Status-colored Card (dynamic border)

```tsx
const borderColor = etat === 1 ? 'border-l-amber-400/60'
  : etat === 2 ? 'border-l-green-500/60'
  : 'border-l-border'
const iconBg = etat === 1 ? 'bg-amber-400/10'
  : etat === 2 ? 'bg-green-500/10'
  : 'bg-muted'
const iconColor = etat === 1 ? 'text-amber-600'
  : etat === 2 ? 'text-green-600'
  : 'text-muted-foreground'

<div className={cn('group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3', borderColor)}>
  <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 {iconBg}">
    <Icon className={cn('h-3.5 w-3.5', iconColor)} />
  </div>
  ...
</div>
```

#### Indented Sub-content (e.g., order lines)

```tsx
{/* Indent under the icon box with ml-9 */}
<div className="mt-2 space-y-1 ml-9">
  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
    <span className="truncate max-w-[220px]">{lineText}</span>
    <span className="flex-shrink-0">{lineValue}</span>
  </div>
</div>
```

---

## 8. Right Panel: Sidebar with Tabs

Container:
```tsx
className="w-96 flex-shrink-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80"
```

### Tab Bar

```tsx
<div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
  {tabs.map(tab => (
    <button className={cn(
      'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors',
      isActive ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10'
    )}>
      <Icon className="h-3.5 w-3.5" />{label}
    </button>
  ))}
</div>
```

### Tab Content Area

```tsx
className="flex-1 overflow-y-auto p-3 space-y-2"
```

### Contact/Address View Cards (in sidebar)

```tsx
<div className="p-2.5 rounded-md bg-muted/40 group relative">
  <div className="flex items-start justify-between">
    <div className="min-w-0 flex-1">
      <div className="font-medium text-sm flex items-center gap-2">
        {name}
        {isDefault && (
          <Badge variant="secondary" className="text-[10px] py-0">
            <Star className="h-2.5 w-2.5 mr-0.5" />Principal
          </Badge>
        )}
      </div>
      {/* Detail lines */}
      <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-1">
        <Phone className="h-3 w-3" />{phone}
      </div>
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Mail className="h-3 w-3" /><span className="truncate">{email}</span>
      </div>
    </div>
    {/* Hover-reveal edit/delete */}
    {isEditing && (
      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button variant="ghost" size="icon" className="h-6 w-6"><Pencil className="h-3 w-3" /></Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive"><Trash2 className="h-3 w-3" /></Button>
      </div>
    )}
  </div>
</div>
```

### "Add" Button (bottom of tab, edit mode only)

```tsx
<Button variant="ghost" size="sm" className="w-full text-muted-foreground hover:text-foreground">
  <Plus className="h-4 w-4 mr-1.5" />Ajouter un contact
</Button>
```

Only shown when `isEditing && !showForm && editingId === null`.

### 8.1 Item cards inside tabs — use the section card style, NOT the center-panel one

When a sidebar tab renders a list of items (documents, contacts, notes, attachments…), each item card must use the **sidebar section card style**, not the center-panel "item view card" style from §7.

| Context | Container classes | Used on |
|---|---|---|
| **Sidebar tab item** (this rule) | `p-3 rounded-lg border bg-card shadow-sm` | `DocsTab` doc cards, `AdresseCard`, `InfoTab` sub-cards |
| **Center-panel item** (§7) | `rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3` | `LineCard`, ref cards, commande cards in `FilsGestion.tsx` |

Visual intent: center-panel cards sit on the warm background and rely on the left-edge status color to communicate state; sidebar tab cards sit on the `bg-zinc-100/80` panel and need to be white `bg-card` with a shadow to separate from the panel. Mixing the two — putting a zinc + border-l card inside a zinc sidebar panel — makes the card disappear into the background.

When `isEditing`, add `editSectionClass` (`border-l-4 border-l-accent/70 bg-accent/[0.03]`) to the same white card — this gives the gold left edge and subtle tint used consistently across every edit-aware panel card in the app. Do NOT try to use the amber `border-l-amber-400/60` accent from the center-panel neutral pattern.

### 8.2 Do not wrap single-content tabs in a redundant section card

When a sidebar tab holds only one kind of content (a single list of documents, a single form, a single note field), do NOT wrap the entire tab body in a `p-3 rounded-lg border bg-card shadow-sm` card with a header that repeats the tab's name.

```tsx
// WRONG — the "Documents" label duplicates the tab label,
// the card has nothing else inside, and the whitespace compounds.
function DocsTab({ commande, isEditing }) {
  return (
    <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
      <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
        <FileText className="h-3.5 w-3.5" />Documents
      </p>
      {/* doc list */}
    </div>
  )
}

// RIGHT — fragment root, items render directly in the tab body's p-3 space-y-2 layout.
function DocsTab({ commande, isEditing }) {
  return (
    <>
      {/* doc cards, each using the §8.1 section card style */}
      {/* "Ajouter un document" button, edit mode only */}
    </>
  )
}
```

Rationale: the tab header (Info / Adresses / Docs / Journal) already identifies the content. Doubling that as an internal card title creates redundant chrome and eats vertical space.

Multi-content tabs (like `InfoTab`'s "Metadata" + "Commentaire" pair) DO get internal cards — each logical group is its own card. The rule is about single-group tabs.

### 8.3 Edit-mode click swaps view ↔ edit on item cards

Item cards in a sidebar tab are clickable in both modes, but the target differs:

```tsx
onClick={() => isEditing ? setEditingDoc(doc) : setViewDoc(doc)}
className={cn(
  'group p-3 rounded-lg border bg-card shadow-sm cursor-pointer hover:border-accent/40 transition-colors',
  isEditing && editSectionClass,
)}
```

Conventions:
- **View mode** — click opens the read-only viewer dialog (`DocViewDialog`, `ContactViewDialog`, etc.). No action buttons shown on the card.
- **Edit mode** — click opens the create/edit form dialog. The card picks up `editSectionClass` so users see it's in "edit context". The only hover-revealed action on the card is **Trash** (red ghost icon); there is no separate Pencil button — the whole card is the pencil.
- **Delete** — hover-reveal `<Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">` with `e.stopPropagation()` inside its handler so the row click doesn't also fire. The destructive action goes through `ConfirmDialog` (§33).

Reference implementation: `DocsTab` in `FilsCommandes.tsx`. Applies to every future tab where items are editable (contacts, adresses, lots, attachments…).

---

## 9. Edit Mode Pattern

### Activation

- "Modifier" button in detail header → sets `isEditing = true`
- Populates edit state from current data (`editNom`, `editCommentaire`, etc.)
- "Annuler" discards changes, "Enregistrer" saves via mutation

### Visual Indicators (when `isEditing = true`)

1. **Header icon box**: switches from `icon-box-gold` to `bg-accent/15`
2. **Name field**: becomes editable `<input>` with `font-heading font-bold`
3. **"Mode edition" badge**: `bg-accent text-accent-foreground` with `Pencil` icon
4. **Gold accent line**: solid `bg-accent` instead of gradient
5. **Cards**: get `editSectionClass` = `border-l-4 border-l-accent/70 bg-accent/[0.03]`
6. **Hover-reveal buttons**: `opacity-0 group-hover:opacity-100 transition-opacity` on items
7. **"+" buttons**: appear in card headers and footer
8. **"Nouveau" button**: appears in list footer
9. **"Ajouter" buttons**: appear at bottom of sidebar tabs

### InlineForm Component

Used for creating/editing sub-entities (contacts, adresses, recommandations):

```tsx
<div className="rounded-lg border border-accent/25 bg-accent/[0.03] p-4 space-y-3">
  <p className="text-xs font-semibold text-accent uppercase tracking-wide">{title}</p>
  {/* Form fields */}
  <div className="flex justify-end gap-2 pt-1">
    <Button variant="outline" size="sm">Annuler</Button>
    <Button size="sm">Enregistrer</Button>
  </div>
</div>
```

### LabeledInput Component

```tsx
<div className="space-y-1">
  <label className="text-xs font-medium text-muted-foreground">{label}</label>
  <input className="w-full h-8 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
</div>
```

### Form Layout Grids

- 2-column: `grid grid-cols-2 gap-2` (e.g., Prénom + Nom, Société + Contact)
- 3-column: `grid grid-cols-3 gap-2` (e.g., CP | Ville spanning `col-span-2`)

### Forms Appear on Demand

Forms are **not** always visible. They show only when user clicks "+":
- `showForm` state controls visibility
- Only one form OR one edit at a time (`showForm` and `editingId` are mutually exclusive)

---

## 10. Shared CSS Classes

### Card Styles

```css
.card-premium {
  /* Rounded-xl, bg-card, border-border/50, shadow-md */
  /* Hover: shadow-lg, border-border */
}
```

### Icon Box Variants

```css
.icon-box-gold {
  /* gradient bg: gold/15 → gold/8, text: gold darker, rounded-xl */
}
.icon-box-teal {
  /* gradient bg: teal/15 → teal/8, text: teal darker, rounded-xl */
}
.icon-box-terracotta {
  /* gradient bg: terracotta/15 → terracotta/8, text: terracotta darker, rounded-xl */
}
```

### Badge Variants

```css
.badge-success { /* bg-success/10 text-success ring-success/20 */ }
.badge-warning { /* bg-warning/10 text-warning ring-warning/30 */ }
.badge-info    { /* bg-primary/10 text-primary ring-primary/20 */ }
.badge-pending { /* bg-muted text-muted-foreground ring-border */ }
.badge-teal    { /* bg teal-light, text teal-dark, ring teal */ }
```

### Accent Cards

```css
.card-warm {
  /* border: gold/15, bg gradient to gold/4, gold-tinted inset shadow */
  /* hover: border gold/25 */
}
.card-teal {
  /* border: teal/15, bg gradient to teal/4 */
}
```

### Utility Classes

```css
.glass          { /* bg-white/70 backdrop-blur-xl border-white/20 shadow-lg */ }
.text-gradient  { /* bg-clip-text text-transparent, gradient-brand */ }
.accent-line    { /* ::before pseudo, w-1 bg-accent left border */ }
.divider-warm   { /* h-px, gradient gold/25 transparent at edges */ }
.stat-glow      { /* ::after pseudo, gold gradient glow on hover */ }
```

---

## 11. Input Styling

### Standard Input

```tsx
const inputClass = 'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'
```

### Search Input (in list panel)

```tsx
className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
// With Search icon positioned: absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground
```

### Textarea

```tsx
className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
```

### Select / Dropdown

**Native `<select>` is banned.** Every dropdown in the app uses one of the two
styled, portal-positioned components. The native element looks like Windows 95
next to our cards, its option list cursor is OS-controlled (no hand pointer
on Windows even with `cursor-pointer`), and its popup clips wrong inside KV
rows and scrollable panels — see §11bis for the clipping story.

Pick one of the two styled components:

1. **`SearchableCombobox`** — long lists (30+ items), typed search. Clients, Références, fournisseurs, any catalog lookup. Both in edit-mode detail panels (`size="sm"`) and in Nouveau dialogs (default size).
2. **`PopoverSelect`** — short ID-keyed lists (< 30 items), no search. Sous-traitant, magasins, statuses, type fields. Both in detail panels (`size="sm"`) and in dialogs.

Both live in `apps/web/src/components/ui/popover-select.tsx`:

```tsx
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
```

Even for "tiny" inline dropdowns (e.g. an action-trigger pill that doesn't keep a value, like "+ Ajouter un fournisseur") — wrap `PopoverSelect` with `value={0}` and use `emptyLabel` as the trigger label. See `FilsReferences.tsx` for the canonical example. Do not fall back to native `<select>` because the visual is "smaller" — the styled component scales down via `size="sm"`.

If a future need can't be satisfied by either component (e.g. multi-select chips, or a typed search with custom option rendering), extend the shared module — do not introduce a third dropdown shape inline.

### Focus Ring

All inputs: `focus:ring-2 focus:ring-ring` where `--ring: 42 80% 55%` (gold).

---

## 11bis. Styled Dropdowns: `SearchableCombobox` + `PopoverSelect`

Both components live in **`apps/web/src/components/ui/popover-select.tsx`**.
They render the visible trigger inline (the text input for `SearchableCombobox`, the button for `PopoverSelect`) but mount the **popover list through `createPortal` into `document.body`**, positioned with `position: fixed` using `getBoundingClientRect()` from the trigger. This is non-negotiable in our right-panel detail views — see the clipping story below.

```tsx
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
```

Both export their option/prop types too (`PopoverSelectOption`, `SearchableComboboxProps<T>`) for thin domain-specific wrappers (see "Domain-specific wrappers" below).

### Why portal — the clipping trap

The right-panel `KV` component wraps values in `<span className="… truncate">`, which expands to `overflow: hidden`. An `absolute z-50 top-full` popover rendered as a child of that span is clipped to the span's box (~button width × button height) and the user sees nothing clickable. The tab container above also has `overflow-hidden`, and its content has `overflow-y-auto`, so there are up to **three** ancestors that clip a non-portal popover. Always portal.

### When to pick which

| Use | Component | Trigger | Why |
|-----|-----------|---------|-----|
| 30+ options, user needs to find one fast (clients, references, catalogs) | `SearchableCombobox` | Text input | Typing filters the list live; selected item renders as primary — secondary |
| < 30 options, no search needed (sous-traitants, magasins, statuses) | `PopoverSelect` | Button + chevron | Cleaner visual; button shows current label, popover lists all options |
| A status the user cycles through (pending / sent / accepted / refused) | See §29 (detached status footer pill) | — | Not a form field — lives in sidebar footer, not inside a card |

### `SearchableCombobox<T>` — generic, ID-keyed

```tsx
<SearchableCombobox
  options={clients ?? []}
  value={IDclient}                         // 0 means nothing selected
  onChange={setIDclient}
  getId={(c) => c.IDclient}
  getPrimary={(c) => c.nom ?? ''}
  getSecondary={(c) => c.ville}            // optional
  placeholder="Rechercher un client"
  size="sm"                                // omit in dialogs, pass "sm" in right-panel KV rows
/>
```

- Typing invalidates the current selection (`onChange(0)`) until the user picks again — prevents stale IDs when the user mistyped.
- Loading state is supported via the `loading` prop (shows a spinner in the popover).
- In size="sm", the input is right-aligned at `h-7` capped at 220px to fit KV rows.

### `PopoverSelect` — generic, ID-keyed, no search

```tsx
<PopoverSelect
  options={sousTraitants.map((s) => ({ id: s.IDsous_traitant, primary: s.nom ?? '' }))}
  value={editIDSousTraitant}               // 0 means "none"
  onChange={setEditIDSousTraitant}
  emptyLabel="— aucun —"                    // default; customise per field
  size="sm"                                // same sizing rule as SearchableCombobox
/>
```

- Options are `{ id: number; primary: string; secondary?: string; description?: string }`. `secondary` is shown muted on the right side of the option row AND on the trigger button (kept short — e.g. the city, a code). `description` is multi-line detail rendered ONLY in each popover row, below the primary, in `text-[11px] text-muted-foreground` — use it when the user needs to verify a selection at a glance (addresses showing street + postal + city + country, references with composition + designation, etc.). Use `\n` to split into separate lines; empty lines are filtered out.
- `id: 0` is the sentinel for "none" — by default the top of the popover shows a styled `emptyLabel` row. Set `hideEmpty` to suppress it (see below).
- `hideEmpty` — pass `true` when the field is required AND has a sensible default. The user can switch between options but cannot un-select. Common for `Type sous-traitant`-style dropdowns and address pickers when the parent has at least one address.
- Set `disabled` + `disabledTitle` when the dropdown depends on another field (e.g. N° commande depends on a client being picked).
- The button rotates its chevron 180° when open; the selected option gets `bg-accent/10 text-accent`.

#### Address pattern (canonical for `description`)

```tsx
function adresseOption(a: AdresseLookup) {
  const street = [a.adresse1, a.adresse2, a.adresse3].filter(Boolean).join(' · ')
  const cityLine = [a.cp, a.ville].filter(Boolean).join(' ')
  const descLines = [street, cityLine, a.pays || ''].filter((s) => s.trim().length > 0)
  return {
    id: a.IDadresse,
    primary: a.nom || `Adresse #${a.IDadresse}`,
    secondary: a.ville ?? undefined,
    description: descLines.length > 0 ? descLines.join('\n') : undefined,
  }
}
```

Reference: `SousTraitantsCommandes.tsx` create dialog. Re-use this exact mapper any time you put `AdresseLookup` rows into a `PopoverSelect` — copying it ad-hoc per screen invites subtle inconsistencies (one screen showing pays, another not).

### Domain-specific wrappers

For fields with extra business rules, write a thin wrapper instead of inlining the logic at the call site. The canonical example is `CommandeSelect` in `EtudesColoris.tsx` — it wraps `PopoverSelect`-style behavior for N° commande with:

- Tabular-nums `N°<num>` primary label + French-formatted date as secondary.
- A **stale option row** at the top of the popover if the saved value no longer matches any active commande (e.g. the order was settled after the étude was saved). Rendered with a muted `soldée` tag so the user knows why it's there.
- Disabled until a client is picked.

Follow that shape when adding other domain dropdowns (e.g. N° devis, N° facture): specialize the wrapper, don't duplicate the portal positioning code.

### Sizing cheatsheet

| Context | Size | Button/input height | Width |
|---------|------|---------------------|-------|
| Right-panel KV row, edit mode | `size="sm"` | `h-7` | `w-[220px]` right-aligned |
| Nouveau dialog / centered form | default | `h-9` | `w-full` |
| Short value in a crowded row (a year, a code) | `size="sm"` + `widthClass` | `h-7` | whatever you pass, e.g. `w-[104px]` |
| Popover itself (both sizes) | — | `max-h-64 overflow-y-auto` | `max(triggerWidth, 240–260px)` so options stay readable even from a narrow trigger |

**`widthClass` (PopoverSelect only)** overrides the trigger width. Reach for it when 220px would crowd the row — the dashboard's CA widget puts a year picker next to a "Détail" button in the header band. **Do NOT wrap the component in a narrower `<div>` instead**: `size="sm"` sets `w-[220px]` on its own root, so an outer `w-[110px]` doesn't constrain it — the trigger overflows and silently pushes its neighbours out of the card (exactly the bug this prop was added to fix). The popover list still gets its own 240px minimum, so a 104px trigger stays perfectly readable.

### Anti-patterns

- **Do not use native `<select>` anywhere.** It's banned app-wide as of the propagation sweep — every screen now uses `PopoverSelect` / `SearchableCombobox`. The native element's option-list cursor is OS-controlled (no hand pointer on Windows regardless of `cursor-pointer`), it can't be themed, and it clips wrong inside KV rows and scrollable panels. If the next dropdown you add reaches for `<select>`, swap it for the styled component before merging.
- **Do not absolute-position a popover as a DOM child of the trigger in a scrollable panel** — you'll reinvent the clipping bug. Portal.
- **Do not re-implement the portal positioning per call site.** If you need a third variant, either extend `PopoverSelect` with new props or write a wrapper (like `CommandeSelect`) — don't copy the `getBoundingClientRect` / scroll-listener block again.
- **Do not forget to close on scroll.** All our detail panels and dialogs are scrollable; leaving an open portal popover attached to an off-screen trigger looks broken. The existing components already wire this — don't strip it when you copy them.
- **But do NOT close when the scroll target is inside the popover itself.** The close-on-scroll listener uses `window.addEventListener('scroll', ..., true)` with `capture: true` (needed because `scroll` doesn't bubble), which means scrolls *inside* the popover's own option list also fire it. Always guard: `if (popoverRef.current?.contains(e.target as Node)) return` before closing. Without this, the user can't scroll past the first screen of options — the popover snaps shut on the first wheel tick.

### Bridging legacy `number | ''` state

Some pre-existing dialogs use `number | ''` for unselected fields (empty string = not picked). `PopoverSelect` / `SearchableCombobox` expect `value: number` with `0` as the empty sentinel. Bridge inline at the call site rather than refactoring the state shape — the rest of the form code probably checks `typeof === 'number'` to gate enabled/loading states, and rewriting all of those is a bigger blast radius than the bridge:

```tsx
<PopoverSelect
  value={typeof IDfournisseur === 'number' ? IDfournisseur : 0}
  onChange={(id) => setIDfournisseur(id > 0 ? id : '')}
  /* ... */
/>
```

Reference: `FilsStock.tsx` "Nouveau lot" dialog.

### Action-trigger pattern (no value kept)

For inline "click to add" pills that fire a mutation immediately and never keep a selection, bind `value={0}` permanently and use `emptyLabel` as the trigger label:

```tsx
<PopoverSelect
  size="sm"
  value={0}
  onChange={(fid) => { if (fid) linkFrsMut.mutate({ coloriId, fournisseurId: fid }) }}
  emptyLabel="+ Ajouter un fournisseur"
  options={...}
/>
```

Reference: `FilsReferences.tsx` per-coloris fournisseur add. Don't fall back to a native `<select>` "because it's small" — `size="sm"` exists for that.

---

## 12. Button Patterns

| Variant | Usage | Example |
|---------|-------|---------|
| Default (`<Button>`) | Primary in-form actions: Enregistrer | `bg-primary text-primary-foreground` |
| `variant="gold"` | **Canonical "Modifier" / enter-edit-mode CTA** on every detail screen header (§6.1) | `bg-gold text-gold-foreground` |
| `variant="outline"` | Secondary: Annuler, header icon buttons (Imprimer, Email) | Border + text |
| `variant="ghost"` | Tertiary: +, edit/delete icons | No border, hover bg |
| `variant="destructive"` | Dangerous full-text actions (rare — usually use ghost+text-destructive) | `bg-destructive` |
| `size="sm"` | Text buttons with icon: `<Pencil className="h-3.5 w-3.5 mr-1.5" />Modifier` |
| `size="icon"` | Icon-only: `className="h-9 w-9"` for header, `className="h-6 w-6"` for inline |

The `gold` variant is defined in `apps/web/src/components/ui/button.tsx`:

```tsx
gold: 'bg-gold text-gold-foreground shadow hover:bg-gold/90',
```

Always use `variant="gold"` for the "Modifier" button at the top right of every detail screen — never `variant="outline"` or `variant="default"`. The gold CTA is the canonical "enter edit mode" affordance and stays consistent across the whole app. See §6.1 for the full Print + Email + Modifier header trio.

### Delete Button Pattern

```tsx
<Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive">
  <Trash2 className="h-3 w-3" />
</Button>
```

---

## 13. Loading & Skeleton States

### Spinner

```tsx
<Loader2 className="h-6 w-6 animate-spin text-accent" />  // small
<Loader2 className="h-8 w-8 animate-spin text-accent" />  // detail area
```

### Skeleton Pulse

```tsx
<div className="h-8 w-48 bg-muted animate-pulse rounded" />     // title placeholder
<div className="h-24 bg-muted animate-pulse rounded-lg" />       // card placeholder
```

### Sidebar Loading

```tsx
<div className="w-96 flex-shrink-0 bg-muted/30 rounded-xl border p-4 space-y-4">
  <div className="flex gap-2">
    <div className="h-8 flex-1 bg-muted animate-pulse rounded-md" />
    <div className="h-8 flex-1 bg-muted animate-pulse rounded-md" />
  </div>
  {[1, 2, 3].map(i => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
</div>
```

---

## 14. Animation Classes

```css
.animate-fade-in     { animation: fadeIn 0.5s ease-out forwards; }
.animate-slide-up    { animation: slideUp 0.5s ease-out forwards; }
.animate-slide-in-right { animation: slideInRight 0.4s ease-out forwards; }
.stagger-children > *:nth-child(N) { animation-delay: (N-1)*50ms; }
.transition-premium  { transition: all 300ms ease-out; }
```

---

## 15. Responsive Breakpoints

Full mobile/tablet doctrine (card lists, drawers, dialogs, toolbars, regression harness) in **§40**.

| Breakpoint | Tailwind | Layout Effect |
|-----------|----------|---------------|
| < 640px | default | Toolbars wrap (§40.5); dialog form grids collapse to 1 column (§40.6) |
| < 768px | default | **Table-centric screens: card list replaces the table** (§40.2–§40.3); drawers full-width + X close (§40.4) |
| ≥ 768px | `md:` | Table-centric screens: split table (§27.3) |
| < 1024px | default | Sidebar hidden, hamburger menu (`MobileNav`) |
| ≥ 1024px | `lg:` | Desktop: sidebar visible |
| < 1240px | — | MasterDetail: stacked (1 column) |
| 1240–1400px | — | MasterDetail: compact (2 columns, sidebar drawer) |
| ≥ 1400px | — | MasterDetail: full (3 columns) |

Two **independent** systems coexist: Tailwind breakpoints (`sm`/`md`/`lg`) drive the shell and the table-centric screens; the JS `useResponsiveLayout` hook (1240/1400, `matchMedia`) drives `MasterDetailLayout`. Do not merge them and do not add phone modes to the hook — phone behavior for master-detail screens is "stacked", which already works below 1240.

---

## 16. Navigation Structure

1. **Tableau de bord** — Dashboard
2. **Clients** — Commandes, Devis, Facturation, Gestion
3. **Fils** — Références, Stock, Commandes, Gestion, Prévisions
4. **Sous-traitants** — Commandes, Gestion
5. **Production** — Tricotage, Teinture, Confection, Contrôle qualité
6. **Stock** — Matières premières, Produits finis, Mouvements
7. **Produits** — Références, Coloris
8. **Transport** — Expéditions, Livraisons
9. **Réseau** — Entreprises
10. **Paramètres** — Settings

---

## 17. Icons (Lucide React)

| Icon | Usage |
|------|-------|
| `Building2` | Enterprise/company |
| `User` | Contact |
| `MapPin` | Address |
| `Phone` | Phone number |
| `Mail` | Email |
| `Search` | Search input |
| `Pencil` | Edit action |
| `Plus` | Add action |
| `X` | Close/cancel/remove |
| `Save` | Save action |
| `Trash2` | Delete action |
| `Award` | Competences |
| `MessageSquare` | Recommandations |
| `Star` | Default/principal indicator |
| `Calendar` | Date display |
| `Building` | Company (in recommandation) |
| `Globe` | Network/empty state |
| `AtSign` | Email action |
| `Loader2` | Loading spinner (with `animate-spin`) |
| `AlertCircle` | Error state |
| `ChevronLeft/Right` | Sidebar collapse, navigation |
| `ArrowLeft` | Back button (stacked mode) |
| `PanelRightOpen` | Open sidebar drawer |
| `Maximize2/Minimize2` | Fullscreen toggle |
| `Menu` | Mobile hamburger |

---

## 18. Dialog/Modal Pattern

Three variants are used in the app — pick the one that matches your use case.

> **Critical hooks rule**: Any `useState` / `useQuery` / `useEffect` inside a dialog component must be declared **before** any `if (!cert) return null` early return. Hooks after conditional returns work in dev but crash production builds with React error #310. See the React Component Rules in `CLAUDE.md`.

### 18.0 When to open a Dialog vs render inline

A new form inside an already-bounded surface (sidebar tab, slide-up drawer, the in-screen drawer of §31, a sub-section card) competes for vertical space with everything else the host is showing. Promote the form to a Dialog when **both** of these are true:

1. **The form is a side-feature of its host**, not a continuation of the host's primary purpose. The host has its own job (showing rolls already received, listing line items, displaying attached docs…) and this form opens a distinct sub-workflow that the host wasn't built to display.
2. **Space is tight or the form is non-trivial** — the host is already 2+ containers deep (page → drawer → tab body, or page → sidebar → tab), OR the form has more than 2–3 fields, OR it includes a textarea / multi-line input that needs real height.

Inline forms remain correct when **the form IS the host's primary mode** — e.g. the sidebar Contacts tab's "add contact" form (§9 `InlineForm`), where managing contacts is exactly what the tab is for. Per-row pencil-edits and inline field updates inside detail cards also stay inline because they're tightly coupled to the row they edit and the field set is tiny.

Reference: `SousTraitantsCommandes.tsx` → `ReceptionForm` was originally rendered inline at the bottom of the line drawer's Réception tab. It met both criteria — the tab's purpose is to display received rolls (not create them), and at 3 containers deep with 8 fields + a textarea, the inline form crushed the existing roll list. Promoting it to a Dialog gave it dedicated breathing room and let the tab focus on its actual job.

When in doubt, prototype inline first. If you reach for `overflow-y-auto` to make room, or start trimming labels / padding to squeeze the form in, that's the cue to lift it into a Dialog.

### A. Basic Form Dialog

For simple forms — use `DialogContent` with header, body, and footer.

```tsx
<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent className="max-w-md" onClose={() => setOpen(false)}>
    <DialogHeader>
      <DialogTitle className="flex items-center gap-2">
        <Icon className="h-5 w-5 text-accent" />
        Title
      </DialogTitle>
    </DialogHeader>
    <div className="mt-4 space-y-3">
      {/* Body content */}
    </div>
    <DialogFooter className="mt-4">
      <Button variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
      <Button onClick={handleSave}>Enregistrer</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

**Internal spacing — `mt-4` between header, body, and footer**. `<DialogContent>` has `p-6` outer padding but **no vertical spacing between its direct children**. Without explicit margins, the title rams flush against the first input and the footer rams against the last input, and the whole dialog reads as cramped. Apply:

- `mt-4` on the body wrapper (the first element after `<DialogHeader>`) — 16px breathing room under the title
- `mt-4` on `<DialogFooter>` — 16px breathing room above the action buttons
- Inline error / success banners that sit between body and footer get `mt-3` from the body, and the footer keeps `mt-4`

This applies to every Dialog variant in this section (Basic Form, Side-by-Side, custom layouts). The only exception is the full-bleed viewer variant (§18.B), which has no body wrapper because the iframe IS the body.

When the body is a `<form>` element or a single flex column, put the `mt-4` on the body wrapper itself, not on each child — otherwise the spacing compounds and the dialog grows taller than intended.

### A-bis. "En developpement" Placeholder Dialog (canonical)

Any feature that's wired up in the UI but not yet implemented (email send, print, export, etc.) must open this exact placeholder Dialog. Reference: `Entreprises.tsx` email button, `FilsCommandes.tsx` print + email buttons.

```tsx
<Dialog open={placeholderOpen} onOpenChange={setPlaceholderOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle className="flex items-center gap-2">
        <TriggerIcon className="h-5 w-5 text-accent" />
        {actionLabel}
      </DialogTitle>
    </DialogHeader>
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
      <CenterIcon className="h-12 w-12 mb-3 opacity-40" />
      <p className="text-sm font-medium">En developpement</p>
      <p className="text-xs mt-1">Cette fonctionnalite sera disponible prochainement.</p>
    </div>
  </DialogContent>
</Dialog>
```

**Rules — do not deviate**:
- Title `<DialogTitle>` uses the **same icon as the trigger button** (`AtSign` for email, `Printer` for print, etc.) with `h-5 w-5 text-accent`
- Centre `<div>` uses `py-8 text-muted-foreground`, `opacity-40` on the large icon, `h-12 w-12 mb-3`
- Primary copy: **exactly** `"En developpement"` (no accent on the "é" — matches existing screens for grep consistency) in `text-sm font-medium`
- Secondary copy: **exactly** `"Cette fonctionnalite sera disponible prochainement."` in `text-xs mt-1`
- No footer, no buttons — user dismisses via the built-in `X` or overlay click
- The **centre icon** (`h-12 w-12`) can differ from the title icon when it reinforces the action. Example: email dialog uses `AtSign` in the title + `Mail` (envelope) in the centre, because both symbols read as "email" but the envelope is more visually recognisable at size 12. Print dialog uses `Printer` for both.

Always use the literal strings above so a global search for `"En developpement"` finds every placeholder in one shot when we're ready to implement them.

### B. Full-Bleed Viewer Dialog (chrome-free)

For embedded document/PDF viewers where the dialog frame would distract. Used by `CertificatViewDialog` in `FilsGestion.tsx`.

```tsx
<Dialog open={!!cert} onOpenChange={() => onClose()}>
  {fichierOk ? (
    <div className="relative z-50 w-[60vw] max-w-3xl h-[95vh]" onClick={(e) => e.stopPropagation()}>
      <iframe
        src={`${API_URL}/.../fichier#view=FitH`}
        className="w-full h-full rounded-lg"
        title="Document"
      />
    </div>
  ) : (
    <DialogContent className="max-w-sm" onClose={onClose}>
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <FileText className="h-12 w-12 opacity-30" />
        <p className="text-sm">Aucun document attaché</p>
      </div>
    </DialogContent>
  )}
</Dialog>
```

Key points:
- Renders a raw `<div>` directly inside `<Dialog>` (NOT wrapped in `<DialogContent>`) so there's no card chrome around the iframe
- `e.stopPropagation()` on the inner div prevents overlay-click-to-close from firing
- Always pre-check resource availability with a HEAD request before showing the iframe — falls back to a small `DialogContent` for empty/error states

### C. Side-by-Side Form + Preview Dialog

For complex edit dialogs where the user needs both a form AND a preview/viewer. Used by `CertificatEditDialog`.

```tsx
<Dialog open={!!cert} onOpenChange={() => onClose()}>
  <DialogContent className="max-w-5xl h-[85vh] flex flex-col" onClose={onClose}>
    <DialogHeader>
      <DialogTitle className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-accent" />
        Modifier l'élément
      </DialogTitle>
    </DialogHeader>
    <div className="flex-1 min-h-0 flex gap-4">
      {/* Left: form fields */}
      <div className="w-80 flex-shrink-0 overflow-y-auto space-y-3 px-1">
        <LabeledInput label="Nom" value={nom} onChange={setNom} />
        {/* more fields */}
      </div>
      {/* Right: viewer + file controls + action buttons */}
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="flex-1 min-h-0 rounded-lg border border-border/60 bg-zinc-50 overflow-hidden">
          <iframe src={previewUrl} className="w-full h-full" title="Document" />
        </div>
        <div className="flex items-center gap-2">
          {/* file picker, then action buttons aligned right */}
          <FileUploadButton ... />
          <div className="flex items-center gap-2 ml-auto">
            <Button variant="outline" onClick={onClose}>Annuler</Button>
            <Button onClick={handleSave}>Enregistrer</Button>
          </div>
        </div>
      </div>
    </div>
  </DialogContent>
</Dialog>
```

Key points:
- **`max-w-5xl h-[85vh]`** — wide enough for form + preview side by side
- **`flex-1 min-h-0 flex gap-4`** — body splits horizontally; `min-h-0` is required so children can scroll
- **Form column**: `w-80 flex-shrink-0 overflow-y-auto px-1` — `px-1` is critical, otherwise input focus rings get clipped
- **Viewer column**: `flex-1 min-w-0 flex flex-col gap-2` — fills remaining width; `min-w-0` prevents flex overflow
- **Action buttons live at the bottom of the right column**, NOT in a `DialogFooter`. This vertically aligns Annuler/Enregistrer with the file upload controls (looks intentional and avoids a stranded footer)

---

## 19. Body Background

Multi-layer warm gradient with fixed attachment:

```css
body {
  background-image:
    radial-gradient(ellipse 100% 60% at 50% -10%, hsl(42 80% 55% / 0.06), transparent 60%),
    radial-gradient(ellipse 80% 50% at 0% 50%, hsl(175 42% 45% / 0.04), transparent),
    radial-gradient(ellipse 70% 50% at 100% 80%, hsl(42 80% 55% / 0.05), transparent),
    linear-gradient(180deg, hsl(36 25% 98%) 0%, hsl(36 20% 97%) 100%);
  background-attachment: fixed;
}
```

---

## 20. Accessibility

- All interactive elements have `:focus-visible` states with gold ring
- Color contrast meets WCAG AA
- Screen reader labels: `<span className="sr-only">` for icon-only buttons
- Keyboard navigation support via Radix primitives
- Focus ring: `ring-2 ring-accent/40 ring-offset-2 ring-offset-background`

---

## 21. Iframe Document Viewer

For embedding PDFs, images, and other documents served by the API.

```tsx
<iframe
  src={`${API_URL}/.../fichier#view=FitH`}
  className="w-full h-full rounded-lg"
  title="Document"
/>
```

**Container**: `flex-1 min-h-0 rounded-lg border border-border/60 bg-zinc-50 overflow-hidden`

### Conventions

- **`#view=FitH`** is the PDF.js URL parameter that defaults the viewer to "fit width" — most readable for letter/A4 documents
- **Pre-check availability with HEAD** before showing the iframe — saves the user from seeing raw JSON 404 text inside the frame:
  ```tsx
  useEffect(() => {
    if (!cert) return
    fetch(`${API_URL}/.../fichier`, { method: 'HEAD' })
      .then(r => setFichierOk(r.ok))
      .catch(() => setFichierOk(false))
  }, [cert?.IDcertificat])
  ```
- **Object URL previews**: when showing a file the user just picked but hasn't saved yet, use `URL.createObjectURL(file)` and remember to `URL.revokeObjectURL()` on cleanup or when replacing the file:
  ```tsx
  if (newFileUrl) URL.revokeObjectURL(newFileUrl)
  setNewFileUrl(URL.createObjectURL(file))
  ```

### API-side requirements

Endpoints serving documents must override helmet's restrictive headers, otherwise iframes from a different port/host will be blocked:

```ts
res.setHeader('Content-Type', contentType)
res.setHeader('Content-Disposition', 'inline')
res.removeHeader('X-Frame-Options')
res.removeHeader('Content-Security-Policy')
res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
```

---

## 22. File Upload Pattern

Hidden `<input type="file">` wrapped in a styled `<label>` for a polished button look. Used in `CertificatEditDialog` in `FilsGestion.tsx`.

```tsx
<label className="cursor-pointer">
  <input
    type="file"
    className="hidden"
    accept=".pdf,image/*"
    onClick={(e) => { (e.target as HTMLInputElement).value = '' }}
    onChange={(e) => {
      const f = e.target.files?.[0]
      if (f) {
        if (newFileUrl) URL.revokeObjectURL(newFileUrl)
        setNewFile(f)
        setNewFileUrl(URL.createObjectURL(f))
        setRemoveFichier(false)
      }
    }}
  />
  <span className={cn(inputClass, 'inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/5 w-auto px-3')}>
    <Upload className="h-3.5 w-3.5" />
    {newFile ? newFile.name : 'Choisir un fichier'}
  </span>
</label>
{newFile && (
  <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => {
    if (newFileUrl) URL.revokeObjectURL(newFileUrl)
    setNewFile(null); setNewFileUrl(null); setRemoveFichier(true)
  }}>
    <X className="h-3.5 w-3.5" />
  </Button>
)}
```

### Critical bits

- **`onClick={(e) => { e.target.value = '' }}`** — without resetting the value, picking the *same* file twice in a row doesn't fire `onChange`. Easy to miss, infuriating to debug.
- **`URL.createObjectURL` for instant preview** — shows the picked file in the viewer immediately, before the user clicks Save
- **`X` button to clear** the selection. If replacing an existing document, also set a `removeFichier` flag so the save handler knows to delete the old blob even if the user backs out of uploading a new one
- **Save MUST use raw `fetch` with `FormData`**, NOT `apiFetch` which forces `Content-Type: application/json`. The browser sets the multipart boundary automatically:
  ```tsx
  const formData = new FormData()
  formData.append('nom', nom)
  if (newFile) formData.append('fichier', newFile)
  if (removeFichier && !newFile) formData.append('remove_fichier', '1')
  const res = await fetch(url, { method: 'PUT', body: formData })
  ```

---

## 23. Collapsible Section Cards

The center detail body uses collapsible cards for groups of related items (Certificats, Refs de fil, Commandes in `FilsGestion.tsx`).

**Apply this pattern only when the center panel stacks *multiple* sections** (see §7 multi-section shape). When the center panel is a single primary list — lignes of a commande, soumissions of an étude, mouvements of a stock lot — do NOT use a collapsible Card. Use §31's flex-sibling layout directly. A framing Card with a title + chevron around the only thing on the screen duplicates the detail header, eats space, and lets the user collapse the only interaction surface.

**When the stacked sections are all large, read-mostly datasets consulted one at a time** (history tables, catalogs), prefer the **Classeur** master-tab variant (§39) instead of collapsible cards — tabs give the active dataset the full panel height.

```tsx
<Card className="card-premium">
  <CardHeader
    className="flex flex-row items-center gap-2 p-4 space-y-0 cursor-pointer select-none"
    onClick={() => setOpen(!open)}
  >
    <Icon className="h-4 w-4 text-accent" />
    <CardTitle className="text-sm font-semibold">Section Title</CardTitle>
    {isEditing && (
      <Button
        size="sm" variant="ghost"
        className="h-6 w-6 p-0 text-accent hover:text-accent hover:bg-accent/10"
        onClick={(e) => { e.stopPropagation(); setCreating(true) }}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    )}
    <Badge variant="secondary" className="text-xs ml-auto">{count}</Badge>
    <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
  </CardHeader>
  {open && <CardContent className="space-y-2">
    {/* Optional toggle for hidden items, e.g. expired */}
    {hiddenCount > 0 && (
      <button
        onClick={() => setShowHidden(!showHidden)}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {showHidden ? 'Masquer expirés' : `Afficher expirés (${hiddenCount})`}
      </button>
    )}
    {/* item cards */}
  </CardContent>}
</Card>
```

### Conventions

- **`+` button on the header** (edit mode only) for creating items in this section. Always use `e.stopPropagation()` to prevent the header click from also toggling the card open/closed.
- **Count badge**: shows the **active/valid** count, not the total. For example, the Certificats badge shows only valid certs, with a separate "Afficher expirés (N)" toggle inside the content.
- **Chevron rotation**: `transition-transform` + conditional `rotate-180` for smooth expand/collapse animation.
- **`select-none`** on the header so users can't accidentally select text when toggling.

---

## 24. Comment / Empty-Aware Display

Pattern for showing optional comments under an item card, with a subtle icon to indicate "this has a note":

```tsx
{cmd.commentaire?.trim() && (
  <div className="flex items-start gap-1.5 mt-2 ml-9">
    <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
    <p className="text-[11px] text-muted-foreground italic">{cmd.commentaire.trim()}</p>
  </div>
)}
```

### Conventions

- **Always `.trim()` before checking** — HFSQL stores `" "` (single space) for "no comment", which is truthy in JS. Without trimming, the icon would render for empty comments.
- **`ml-9`** indents the comment under the parent card's icon box (matches title alignment perfectly: 7px icon box + gap-2 ≈ ml-9).
- **`text-muted-foreground/50`** on the icon — intentionally subtle so it reads as metadata, not primary content.
- **`mt-0.5`** on the icon to optically center it with the first line of italic text.
- Wrap text in `<p className="text-[11px] text-muted-foreground italic">` to match the secondary-text hierarchy used elsewhere in cards.

---

## 25. Edit State: Global vs Per-Section

Two layers of edit state work together in data screens.

### Global `isEditing` (top-level page state)

Lives at the page component (e.g. `FilsGestion`). Toggled by the **"Modifier"** button in the detail header.

When `true`:
- Detail header shows the entity name as an `<input>` and adds the **"Mode edition"** badge
- Header buttons swap from `[Modifier]` to `[Annuler] [Enregistrer]`
- Sub-sections enable their action buttons (the `+` on collapsible card headers, hover-reveal pencil/trash on item cards)
- Sidebar tabs (Info/Contacts/Adresses) enable their inline edit forms

### Per-Section state

Each sub-section (a collapsible card or a sidebar tab) has its own local state for which specific item is being edited.

```tsx
const [editingId, setEditingId] = useState<number | null>(null)  // which item is in edit form
const [showForm, setShowForm] = useState(false)                  // show "add new" form
const [form, setForm] = useState({ nom: '', tel: '', ... })      // form field values
```

Convention: opening one form/dialog should close any others — only one item is being edited at a time within a section.

### Mutation pattern with onSuccess invalidation

```tsx
const updateMut = useMutation({
  mutationFn: (id: number) => apiFetch(`/path/${id}`, {
    method: 'PUT',
    body: JSON.stringify(form),
  }),
  onSuccess: () => { onMutationSuccess(); setEditingId(null) },
})
```

The page component passes an `invalidateAll` callback down to sub-sections so they can refresh both the list and detail queries after a mutation:

```tsx
const invalidateAll = useCallback(() => {
  queryClient.invalidateQueries({ queryKey: ['fournisseurs'] })
  queryClient.invalidateQueries({ queryKey: ['fournisseur', selectedId] })
}, [queryClient, selectedId])
```

### 25.1 Auto-enter edit mode after creating a new entity

When the user clicks **Nouveau** to create a commande / fournisseur / entreprise / etc., the expected flow is: dialog opens → user fills the mandatory fields → dialog closes → the new row appears selected **and already in edit mode**, so the user can immediately finish filling optional fields without a second click on "Modifier". Don't make them hunt for the edit button on a freshly-created skeleton row.

The race condition to solve: `setSelectedId(newId)` switches the detail query, but the detail hasn't loaded yet, so calling `startEdit()` synchronously has nothing to snapshot. The fix is a one-shot trigger id + an effect that waits for the detail to match:

```tsx
// Page-level state — set by the create dialog's onCreated, cleared by the effect.
const [autoEditForId, setAutoEditForId] = useState<number | null>(null)

// Effect runs after every detail query settle. When the detail's id matches
// the flagged one, startEdit() snapshots the freshly-loaded row and flips
// isEditing on. The flag is then cleared so this only fires once.
useEffect(() => {
  if (autoEditForId !== null && detail?.IDcommande_fil === autoEditForId) {
    startEdit()
    setAutoEditForId(null)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [autoEditForId, detail])

// Wire it in the create dialog's onCreated:
<CreateCommandeDialog
  open={createOpen}
  onClose={() => setCreateOpen(false)}
  onCreated={(newId) => {
    setCreateOpen(false)
    queryClient.invalidateQueries({ queryKey: ['commandes-fil'] })
    setSelectedId(newId)
    setAutoEditForId(newId)
  }}
/>
```

The `eslint-disable` is deliberate — including `startEdit` in deps re-runs the effect whenever the callback identity changes, which causes false re-triggers after cancel. Keying the effect on `[autoEditForId, detail]` alone is correct.

Reference: `FilsCommandes.tsx` — apply the same pattern to every screen with a "Nouveau" affordance.

### 25.2 Auto-select the next item after a delete (read cache BEFORE invalidating)

When the user deletes the currently-selected row, the expected UX is: the row disappears from the list AND the next best row gets selected automatically, so the detail panel never shows an empty "Select a row" state. The naive implementation is broken in a subtle way:

```tsx
// BROKEN — the auto-select-first useEffect fires during stale-while-revalidate
// and picks the deleted row as selectedId, then the refetch removes it and
// selectedId points at a non-existent row.
const deleteMut = useMutation({
  mutationFn: () => apiFetch(`/commandes-fil/${selectedId}`, { method: 'DELETE' }),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['commandes-fil'] })
    setSelectedId(null)  // the effect sees cached (old) list, picks [0]
    setIsEditing(false)
  },
})
```

The React Query default is `stale-while-revalidate`: `invalidateQueries` marks the query stale and triggers a refetch, but returns the cached result synchronously. Between the invalidation and the refetch completing, `commandes` still contains the just-deleted row. If the auto-select-first effect reads that stale list, it picks the wrong row.

**Fix**: read the cached list *before* invalidation, filter out the deleted id yourself, set the selection explicitly, then invalidate:

```tsx
const deleteMut = useMutation({
  // Pass the id as a mutation arg so onSuccess has a stable reference
  // that can't drift if the user changes selection mid-flight.
  mutationFn: (id: number) => apiFetch(`/commandes-fil/${id}`, { method: 'DELETE' }),
  onSuccess: (_data, deletedId) => {
    const cached = queryClient.getQueryData<CommandeListRow[]>(['commandes-fil', statusFilter]) ?? []
    const remaining = cached.filter((c) => c.IDcommande_fil !== deletedId)
    queryClient.invalidateQueries({ queryKey: ['commandes-fil'] })
    setIsEditing(false)
    setSelectedId(remaining.length > 0 ? remaining[0].IDcommande_fil : null)
  },
})

// At the call site, pass the current selection explicitly:
deleteMut.mutate(selectedId)
```

Conventions:
- **Always take the id as a mutation argument**, not from closure — the arg is stable across re-renders; closure captures can drift.
- **Read from the cache, not from state** — `queryClient.getQueryData` sees the same data React Query would render, keyed on the query key actually in use. Using a React state `commandes` variable risks closure staleness.
- **Include the cache key's full parameters** (`statusFilter`, `searchQuery`, etc.) when the query key depends on filters — otherwise `getQueryData` returns undefined.
- **Set selection explicitly, not to null** — setting to null and relying on an auto-select-first effect hits the stale-while-revalidate gap. Compute the next selection yourself and set it directly.
- **Empty list → `null`** — if nothing remains, set `selectedId` to `null` and let the existing empty-state render.

Reference: `FilsCommandes.tsx`. Apply to every delete mutation on every master-detail screen.

---

## 26. HFSQL Date Helpers

HFSQL stores dates as 8-character strings (`YYYYMMDD`), but HTML `<input type="date">` uses `YYYY-MM-DD`. These two helpers convert between the two formats and should be reused across screens — don't reinvent.

```tsx
// "20260403" → "2026-04-03"
function hfsqlDateToInput(d: string | null): string {
  if (!d || d.length !== 8) return ''
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
}

// "2026-04-03" → "20260403"
function inputDateToHfsql(d: string): string {
  return d.replace(/-/g, '')
}
```

For **display** (not editing), use `formatHfsqlDate` which converts to French locale:

```tsx
function formatHfsqlDate(raw: string): string {
  if (raw.length === 8) {
    return new Date(`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`).toLocaleDateString('fr-FR')
  }
  return new Date(raw).toLocaleDateString('fr-FR')
}
```

These three helpers live in **`apps/web/src/lib/dates.ts`** — import from there, do not redefine. Both `FilsGestion.tsx` and `FilsStock.tsx` consume them via `import { formatHfsqlDate, hfsqlDateToInput, inputDateToHfsql } from '@/lib/dates'`.

---

## 26bis. Number Formatting (`fmtNum`)

All numeric values displayed in the UI (weights in kg, prices in €, stock counts, totals) must use **`fmtNum`** from `apps/web/src/lib/format.ts`. It produces French-style formatting with a **plain ASCII space** as the thousand separator — e.g. `12345.6` → `12 345,6`.

```tsx
import { fmtNum } from '@/lib/format'

fmtNum(12345)          // "12 345"
fmtNum(12345.67, 2)    // "12 345,67"
fmtNum(0.5, 1)         // "0,5"
fmtNum(null)           // ""  (null/undefined/NaN safe)
```

### Why not raw `toLocaleString('fr-FR')`?

The `fr-FR` locale emits `\u202f` (narrow no-break space) or `\u00a0` (non-breaking space) for groups depending on the browser/Node version. `fmtNum` normalizes both to a regular space so (a) UI spacing is predictable across environments, (b) copy-paste produces text the user can re-type, and (c) tests match on simple string literals.

### Conventions

- **Weights (kg)**: `fmtNum(value, 1)` for line/detail displays, `fmtNum(value)` (0 decimals) for list-card summaries where space is tight
- **Prices (€)**: `fmtNum(value, 2)` everywhere — always show cents
- **Unit prices (€/kg)**: `fmtNum(value, 2)`
- **Counts / integers**: `fmtNum(value)` (0 decimals)
- **Always pair with `tabular-nums`** on the containing element so columns align — matches the existing pattern in list cards and totals footers

### Do not

- Do not use `value.toFixed(n)` in JSX — it skips the thousand separator
- Do not redefine a local `fmtNum` inside a page file — import the shared one
- Do not hardcode the separator character in tests or snapshots; the helper guarantees a plain space but read the output through `fmtNum` if you need to assert

Reference: `FilsCommandes.tsx` uses `fmtNum` for list card kg/€, totals footer, and line card quantite/prix/total.

---

## 27. Table-Centric Screen Pattern — the "Tableau" layout

Reference: **`apps/web/src/pages/FilsStock.tsx`** (`/fils/stock`).

Use this pattern — never `MasterDetailLayout` — when the page is fundamentally a sortable / searchable list of many flat rows (e.g. stock lots, order lines, movements) and selecting a row reveals a focused detail view that the user reads/edits without leaving the table context.

### 27.1 Page root structure

```tsx
return (
  <div className="h-full flex flex-col gap-3 min-h-0">
    {/* NO page-title <h1> here — the toolbar is the first child */}
    {/* Toolbar */}             <-- §27.2
    {/* Table card */}          <-- §27.3
    <DetailDrawer ... />        <-- §27.5
    <CreateDialog ... />        <-- §18.A
  </div>
)
```

`min-h-0` on the root is mandatory — without it the table body can't shrink to fit and the whole page scrolls instead of just the rows.

**No page title `<h1>` on table-centric screens.** Do NOT add a heading row (`<h1 className="text-3xl font-heading…">Commandes sous-traitants</h1>` + gold accent line) above the toolbar. The screen's identity already comes from the sidebar nav / header submenu tab that routed here; a redundant title just eats the vertical space the table needs and is absent from every reference table-centric screen (`FilsStock`, `RapportCommandesSst`). The toolbar (search + filters + actions) is the **first** element under the page root. This is the opposite of master-detail screens (§6), which DO get the title in the detail header — but that title is the *selected entity's name*, not the screen name. A screen-name `<h1>` is never correct in this app.

### 27.2 Toolbar (top, full-width)

A single horizontal flex row with:
1. **Search input** — `flex-1 min-w-0`, with a `<Search>` Lucide icon absolutely positioned inside. Standard input height `h-9`, white background.
2. **Filter toggles** — `<label>` wrappers around `<input type="checkbox">`, `flex-shrink-0`, label text follows the checkbox.
3. **"Nouveau" button** — pinned right, `flex-shrink-0`. Use the **default `<Button>` variant** (no `variant=...` prop) — that gives `bg-primary text-primary-foreground` which is the brand navy `#143D6B`. Always pair with a leading `<Plus className="h-3.5 w-3.5 mr-1" />`. Do **not** override the background color.

```tsx
<div className="flex-shrink-0 flex items-center gap-3">
  <div className="relative flex-1 min-w-0">
    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
    <input
      type="text"
      value={searchQuery}
      onChange={(e) => setSearchQuery(e.target.value)}
      placeholder="Rechercher (...)"
      className="h-9 w-full pl-8 pr-3 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
    />
  </div>

  <label className="flex items-center gap-2 text-sm cursor-pointer select-none flex-shrink-0">
    <input type="checkbox" checked={hideFinished} onChange={...}
      className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer" />
    <span>Masquer les lots terminés</span>
  </label>

  <Button size="sm" onClick={() => setCreateOpen(true)} className="flex-shrink-0">
    <Plus className="h-3.5 w-3.5 mr-1" />
    Nouveau
  </Button>
</div>
```

### 27.3 Split header / body table (the alignment trick)

Tables that scroll inside a fixed-height card need a non-scrolling header above a scrolling body. Use **two separate `<table>` elements** with **identical `<colgroup>` definitions** and `table-layout: fixed`. The shared `colgroup` is what keeps the columns aligned.

```tsx
const COLUMNS: { key: SortKey; label: string; width: string; align?: 'left' | 'right' }[] = [
  { key: 'ref_fil',          label: 'Référence',       width: '12%' },
  { key: 'colori_reference', label: 'Coloris',         width: '10%' },
  { key: 'lot',              label: 'Lot interne',     width: '7%' },
  // … widths must sum to 100% minus the trailing icon column
]
const ICON_COL_WIDTH = '3%'
```

```tsx
<div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border/60 bg-white shadow-sm overflow-hidden">
  {/* Header table — does NOT scroll */}
  <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
    <colgroup>
      {COLUMNS.map((c) => <col key={c.key} style={{ width: c.width }} />)}
      <col style={{ width: ICON_COL_WIDTH }} />
    </colgroup>
    <thead className="bg-zinc-200/60 border-b border-border/60">
      <tr className="text-xs uppercase tracking-wide text-muted-foreground">
        {COLUMNS.map((c) => (
          <SortHeader key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={handleSort} align={c.align} />
        ))}
        <th className="px-3 py-2.5 text-left font-semibold"></th>
      </tr>
    </thead>
  </table>

  {/* Body table — scrolls inside an overflow div */}
  <div className="flex-1 min-h-0 overflow-auto scrollbar-transparent">
    <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
      <colgroup>
        {COLUMNS.map((c) => <col key={c.key} style={{ width: c.width }} />)}
        <col style={{ width: ICON_COL_WIDTH }} />
      </colgroup>
      <tbody>
        {filteredSorted.map((r) => (
          <tr
            key={r.IDstock_fil}
            data-stock-row
            onClick={() => setSelectedId((prev) => prev === r.IDstock_fil ? null : r.IDstock_fil)}
            className={cn(
              'border-b border-border/40 cursor-pointer transition-colors',
              isSelected ? 'bg-accent/10' : 'hover:bg-accent/5'
            )}
          >
            …row cells…
          </tr>
        ))}
      </tbody>
    </table>
  </div>
</div>
```

Conventions:
- **Row hover**: `hover:bg-accent/5`. **Selected**: `bg-accent/10`. Never both — selection wins via the `cn(... isSelected ? ... : hover...)` ternary.
- **Clicking the same row again** toggles the selection off (`prev === id ? null : id`). Clicking a different row switches.
- **`data-stock-row`** marker is mandatory — the drawer's outside-click handler reads it to differentiate "clicked another row" (switch) from "clicked outside the table" (close). See §27.5.
- **Numeric cells**: `tabular-nums`, right-aligned via the column's `align: 'right'`.
- **Trailing icon column**: small badges (Bio leaf, Recycle, Terminé "T") right-aligned in a `flex justify-end gap-1`.
- **Truncation**: every text cell uses `truncate`. Long values get a `title={value}` for hover tooltip.

### 27.4 Sortable column header

```tsx
function SortHeader({ label, sortKey, sort, onSort, align = 'left' }: SortHeaderProps) {
  const active = sort.key === sortKey
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={cn(
        'px-3 py-2.5 font-semibold cursor-pointer select-none whitespace-nowrap',
        align === 'right' ? 'text-right' : 'text-left',
        active && 'text-accent'
      )}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </span>
    </th>
  )
}
```

The active sort column gets `text-accent` (gold) **and** a directional arrow icon. Clicking the same header toggles direction; clicking a different one resets to `asc`.

### 27.5 Right slide-in drawer

The drawer is `position: fixed`, width `w-full max-w-[440px]` (440px on any viewport ≥ 440px; full-width on phones — see §40.4), slides in from the right edge. It is **separate** from the page flex layout — it overlays the table.

#### Top offset (handles embed mode)

```tsx
const [searchParams] = useSearchParams()
const embed = searchParams.get('embed') === 'true'

<div
  ref={drawerRef}
  className={cn(
    'fixed right-0 bottom-0 w-full max-w-[440px] bg-white border-l border-border/60 shadow-xl z-30 transition-transform duration-300 flex flex-col',
    embed ? 'top-0' : 'top-14',                       // critical — embed mode has no header
    open ? 'translate-x-0' : 'translate-x-full'
  )}
>
```

`top-14` is the height of the standard app header. When `?embed=true` is set the AppShell hides the header, so the drawer must pin to `top-0` or it leaves an empty band at the top of the embed iframe.

#### Three-tone background composition

The drawer must match the FilsGestion right panel exactly: an opaque white root, an inner zinc-100/80 layer, and a zinc-200/50 top band. These need to be **nested** divs, not stacked classes — `bg-zinc-100/80` is semi-transparent and only blends correctly when there is an opaque base behind it.

```tsx
<div className="fixed ... bg-white ...">                          {/* opaque base */}
  <div className="flex-1 min-h-0 flex flex-col bg-zinc-100/80">  {/* inner panel */}
    <div className="flex-shrink-0 px-4 pt-4 pb-3 border-b border-border/60 bg-zinc-200/50">
      {/* Header band */}
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3 scrollbar-transparent">
      {/* Body — inherits zinc-100/80 from parent */}
    </div>
  </div>
</div>
```

| Layer | Class | Why |
|---|---|---|
| Drawer root | `bg-white` | opaque base — drawer overlays the table, so the root must hide it |
| Inner panel | `bg-zinc-100/80` | the lighter gray, blended over white |
| Top band (header) | `bg-zinc-200/50` | the darker gray, blended over the inner zinc-100/80 |
| DrawerCards inside body | `bg-card` | white cards |

**Do not** put `bg-zinc-100/80` directly on the drawer root or `bg-zinc-200/50` directly over white — the colors will not match the FilsGestion panel.

#### Header content

- **Icon** (`h-10 w-10` rounded square, `icon-box-gold` class normally / `bg-accent/15` when editing) containing a **`BobineIcon`** at `h-[25px] w-[25px]`. Always use `BobineIcon` for yarn-related screens (matches the inline icon used in `FilsGestion.tsx` "Références de fil" section). Other domains get their domain-specific icon at the same frame size.
- **Title row**: `<h2 className="text-base font-heading font-bold tracking-tight truncate">` followed by inline `Badge`s (Bio, Recyclé) — use the same green/blue badge palette as elsewhere.
- **Subtitle**: `text-xs text-muted-foreground mt-0.5` — secondary identifier line (e.g. "coloris • Lot N").
- **Action buttons** (right-aligned, `flex-shrink-0 -mt-0.5`): `outline` Modifier in view mode, `outline` Annuler + default Enregistrer in edit mode. Save button shows a `Loader2` spinner when `mutation.isPending`.

#### Body cards

Each section is a `DrawerCard` with `bg-card`, gold icon, title:

```tsx
function DrawerCard({ icon, title, highlight, children }) {
  return (
    <div className={cn(
      'rounded-lg border border-border/60 bg-card p-3 shadow-sm',
      highlight && 'border-l-4 border-l-accent/70 bg-accent/[0.03]'
    )}>
      <div className="flex items-center gap-2 mb-2">{icon}<h3 className="text-sm font-semibold">{title}</h3></div>
      {children}
    </div>
  )
}
```

**Edit highlight rule**: every card that the user might *visually associate* with editing — including read-only ones in the same logical group — gets `highlight={isEditing}`. The Provenance card on this screen is read-only but still gets the gold left edge in edit mode so the user perceives the whole drawer as "in edit mode", not just two cards out of four.

#### KV row primitive

Inside cards, every label/value pair uses the `KV` component — label on the left, value on the right, baseline-aligned, label small/muted, value `text-sm text-right truncate`:

```tsx
function KV({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-sm text-right truncate', mono && 'tabular-nums')}>{value}</span>
    </div>
  )
}
```

**Edit-mode inputs go in the value slot**, not below the label. The input height drops to `h-7` (smaller than the standard `h-9`) and gets `text-right` so its content visually aligns with the read-mode value text:

```tsx
<KV
  label="Emplacement"
  value={
    isEditing ? (
      <input type="text" value={editEmplacement} onChange={...}
        className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right" />
    ) : (
      detail.emplacement || '—'
    )
  }
/>
```

#### Outside-click dismissal

Clicking anywhere outside the drawer closes it — *except* clicking another row in the table (or a mobile card, §40.3), which switches the selection. The handler reads the `data-stock-row` marker (§27.3). The selector is `[data-stock-row]`, NOT `tr[data-stock-row]` — the mobile card list uses `div`s carrying the same marker:

```tsx
useEffect(() => {
  if (id === null) return
  function handleMouseDown(e: MouseEvent) {
    const target = e.target as Node | null
    if (!target) return
    if (drawerRef.current?.contains(target)) return  // inside drawer → keep open
    if ((target as Element).closest?.('[data-stock-row]')) return  // row/card click → selection handles it
    onClose()
  }
  document.addEventListener('mousedown', handleMouseDown)
  return () => document.removeEventListener('mousedown', handleMouseDown)
}, [id, onClose])
```

Below `md` the drawer covers the full viewport, so outside-click can never fire — a **mobile-only X close button** in the drawer header is mandatory (see §40.4).

### 27.6 Foreign-key display columns

When a table column is a foreign-key ID (e.g. `stock_fil.IDMagasin → sous_traitant`), **never display the bare `#${id}`** in the UI. Add a JOIN to the API query and select the human name as a derived column (e.g. `st.nom AS magasin_nom`), then surface `magasin_nom` in the drawer KV. The legacy IDs are implementation noise — the user thinks in supplier names, depot names, etc.

### 27.7 Reference checklist for new table-centric screens

When building a new screen of this type, the result must have:

- [ ] Page root: `h-full flex flex-col gap-3 min-h-0`
- [ ] **No page-title `<h1>`** — the toolbar is the first child of the page root (§27.1)
- [ ] Toolbar with search left, filters middle, **default-variant** `<Button>` "Nouveau" right
- [ ] Split table with shared `<colgroup>` between header and body, both `tableLayout: fixed`
- [ ] Sortable headers via `SortHeader`, active column gets `text-accent` + arrow icon
- [ ] Row toggle selection on click (same row → close), `data-stock-row` marker, `bg-accent/10` selection / `hover:bg-accent/5` hover
- [ ] Right slide-in drawer with `embed`-aware top offset
- [ ] Three-tone background: `bg-white` root → `bg-zinc-100/80` inner → `bg-zinc-200/50` header
- [ ] `BobineIcon` (or domain icon) at `h-[25px] w-[25px]` in the gold icon frame
- [ ] All drawer rows use `KV` (label left / value right)
- [ ] `highlight={isEditing}` on every section card, even read-only ones
- [ ] FK columns rendered via joined display name, never `#${id}`
- [ ] Outside-click closes drawer, ignoring clicks on `[data-stock-row]` (selector must match the mobile cards too)
- [ ] Create dialog wired through React Query mutation with `onMutationSuccess` invalidation, auto-selects the new row in the drawer
- [ ] **Responsive (§40)**: table `hidden md:flex` + card list `md:hidden` sharing the same state; mobile sort row; drawer `w-full max-w-[440px]` + mobile X close; dialog grid `grid-cols-1 sm:grid-cols-2` with `col-span-full`; toolbar `flex-wrap` with Nouveau kept top-right via `order-*`
- [ ] **Desktop screenshot baselines captured BEFORE any responsive/CSS change** and green after (§40.7)

If any box is unchecked, do not mark the screen complete.

---

## 28. Unsaved Changes Guard (mandatory on every edit-mode screen)

Any screen with a "Modifier → edit → Enregistrer" flow **must** plug into the shared unsaved-changes guard. The guard intercepts navigation (route changes, left-list item clicks, back-button, drawer dismissal) while the form is dirty and pops a 3-button dialog: **Annuler** (stay) / **Abandonner** (discard) / **Enregistrer** (save then continue). Without this, users lose half-typed work the moment they misclick — we already had this bug on every edit screen before porting the pattern from MFProd.

**Apply this to every single edit-mode screen.** There is no screen where it's "optional".

### 28.1 The shared pieces — never re-implement, always import

| File | Purpose |
|---|---|
| `apps/web/src/components/shared/UnsavedChangesDialog.tsx` | The 3-button `AlertDialog`. Pure presentation — takes `open`, `onAction('save'\|'discard'\|'cancel')`, `isSaving`. |
| `apps/web/src/hooks/useUnsavedGuard.ts` | Wraps `useBlocker` for route nav, `guardAction(fn)` for in-page nav, dialog state, 3-way action handler. |

```tsx
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
```

Do **not** copy/paste `useBlocker` into pages. Always go through `useUnsavedGuard`.

### 28.2 Page-level integration (5 moving parts)

Every edit-mode page has the same five pieces. The order matters — `originalDraftRef` + `isDirty` must come before `useUnsavedGuard`, and `useUnsavedGuard` must come before `handleSelect` (which depends on `guard`).

```tsx
// (1) snapshot ref — set in startEdit, compared in isDirty
const originalDraftRef = useRef<{ nom: string; commentaire: string; /* ... */ } | null>(null)

// (2) sub-form dirty surfaced from child components (see §28.3)
const [subFormsDirty, setSubFormsDirty] = useState(false)
// OR the per-key registry for screens with multiple concurrent sub-forms (see §28.3)

// (3) startEdit captures the snapshot
const startEdit = useCallback(() => {
  if (!detail) return
  const snapshot = { nom: detail.nom, commentaire: detail.commentaire ?? '', /* ... */ }
  setEditNom(snapshot.nom)
  setEditCommentaire(snapshot.commentaire)
  originalDraftRef.current = snapshot
  setIsEditing(true)
}, [detail])

// (4) isDirty is a useMemo that ORs header-diff with sub-form-dirty
const isDirty = useMemo(() => {
  if (!isEditing) return false
  const o = originalDraftRef.current
  if (!o) return false
  if (editNom !== o.nom) return true
  if (editCommentaire !== o.commentaire) return true
  if (subFormsDirty) return true
  return false
}, [isEditing, editNom, editCommentaire, subFormsDirty])

// (5) the guard — depends on isDirty and the existing saveMutation
const guard = useUnsavedGuard({
  isDirty,
  save: async () => { await saveMutation.mutateAsync() },
  onDiscard: () => setIsEditing(false),
})
```

The `save` callback must call the existing top-level save mutation. Do **not** duplicate save logic — reuse whatever the "Enregistrer" button in the detail header already runs.

### 28.3 Surfacing sub-form dirty state from child components

Sub-sections (Contacts tab, Adresses tab, Lignes card, Recommandations card, etc.) own their own `showForm` / `editingId` state. The page needs to know when any of those are open so `isDirty` returns true. Two patterns depending on concurrency:

#### 28.3.a Single-source callback (use when sub-forms are mutually exclusive)

When only **one** sub-form can be open at a time in the whole screen — e.g. FilsGestion where tab content is conditionally mounted so Contacts and Adresses can never be dirty at the same instant — pass a single `onDirtyChange: (dirty: boolean) => void` through the tree.

```tsx
// In the child (ContactsTab, LignesSection, etc.)
const onDirtyChangeRef = useRef(onDirtyChange)
useEffect(() => { onDirtyChangeRef.current = onDirtyChange })
useEffect(() => {
  onDirtyChangeRef.current(showForm || editingId !== null)
}, [showForm, editingId])
useEffect(() => () => { onDirtyChangeRef.current(false) }, [])  // reset on unmount
```

The ref indirection is **mandatory**: the unmount cleanup fires `false` so that when a tab is switched (unmounting the old tab), the parent correctly sees the dirty flag clear. A naked callback closure would crash on strict-mode double-invoke or lose the latest reference.

#### 28.3.b Per-key dirty registry (use when multiple sub-forms can be dirty simultaneously)

When the screen has sub-sections in **both** the center panel and the sidebar — e.g. Entreprises where `RecommandationsCard` lives in the center and `ContactsTab` / `AdressesTab` live in the sidebar — a single setter would let the last caller clobber the others. Use a key-based registry:

```tsx
// In the page
const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set())
const reportDirty = useCallback((key: string, dirty: boolean) => {
  setDirtyKeys((prev) => {
    if (dirty === prev.has(key)) return prev
    const next = new Set(prev)
    if (dirty) next.add(key); else next.delete(key)
    return next
  })
}, [])
const subFormsDirty = dirtyKeys.size > 0
```

Pass `reportDirty` down. Each child reports under a **unique string key**:

```tsx
// In the child
const reportDirtyRef = useRef(reportDirty)
useEffect(() => { reportDirtyRef.current = reportDirty })
useEffect(() => {
  reportDirtyRef.current('ent-contacts', showForm || editingId !== null)
}, [showForm, editingId])
useEffect(() => () => { reportDirtyRef.current('ent-contacts', false) }, [])
```

Key naming: prefix with the screen (e.g. `ent-contacts`, `ent-adresses`, `ent-recommandations`) to avoid collisions if the same component is reused across screens later.

#### 28.3.c Drawer-based screens (FilsStock pattern)

When the edit form lives inside a right-side drawer child component (per §27), the drawer owns its own edit state. Surface `isDirty` to the page via a callback + expose `save` and `onDiscard` via mutable refs so the page-level guard can invoke them:

```tsx
// Page
const [drawerDirty, setDrawerDirty] = useState(false)
const drawerSaveRef = useRef<() => Promise<void>>(async () => {})
const drawerDiscardRef = useRef<() => void>(() => {})

const guard = useUnsavedGuard({
  isDirty: drawerDirty,
  save: async () => { await drawerSaveRef.current() },
  onDiscard: () => drawerDiscardRef.current(),
})

<StockDetailDrawer
  onDirtyChange={setDrawerDirty}
  saveRef={drawerSaveRef}
  discardRef={drawerDiscardRef}
  onClose={handleClose}  // guarded — see §28.4
/>
```

```tsx
// Drawer
const isDirty = useMemo(() => { /* compare edit state to originalDraftRef */ }, [...])
useEffect(() => { onDirtyChange(isDirty) }, [isDirty, onDirtyChange])
useEffect(() => () => { onDirtyChange(false) }, [onDirtyChange])  // reset on unmount

useEffect(() => {
  saveRef.current = async () => { await saveMutation.mutateAsync() }
})
useEffect(() => {
  discardRef.current = () => setIsEditing(false)
})
```

The `useEffect(() => { ref.current = ... })` with no dep array runs on every render, keeping the ref up-to-date with the latest closure. The page's guard reads `drawerSaveRef.current` at click time, always getting the fresh function.

### 28.4 Guarding in-page navigation — `guardAction` wraps everything

Three in-page navigation points must go through `guard.guardAction`:

```tsx
// 1. Left list click (MasterDetailLayout pattern)
const handleSelect = useCallback((id: number) => {
  guard.guardAction(() => {
    setIsEditing(false)
    setSelectedId(id)
  })
}, [guard])

// 2. Back button (MasterDetailLayout stacked mode)
onBack={() => guard.guardAction(() => { setIsEditing(false); setSelectedId(null) })}

// 3. Drawer close / outside-click dismissal (table-centric §27 pattern)
const handleClose = useCallback(() => {
  guard.guardAction(() => setSelectedId(null))
}, [guard])

// In the table row (§27.3):
onClick={() => handleRowClick(r.IDstock_fil)}
// where handleRowClick = (id) => guard.guardAction(() => setSelectedId(prev => prev === id ? null : id))
```

**Route-level navigation** (sidebar clicks, submenu tabs, programmatic `navigate()`) is **automatically** intercepted by `useBlocker` inside the hook — no extra wiring needed. The only thing left to render is the dialog:

```tsx
<UnsavedChangesDialog
  open={guard.showDialog}
  onAction={guard.handleAction}
  isSaving={guard.isSaving}
/>
```

Place it as a sibling of the `MasterDetailLayout` (wrap in a `<>...</>` fragment if necessary), **not** inside it — dialogs should always be top-level siblings of the screen's main JSX.

### 28.5 Delete bypass

Header delete buttons (trash icon → confirm → mutate) must **reset `isEditing` before calling the mutation** so the guard doesn't block the follow-up list re-render:

```tsx
onDelete={() => {
  if (confirm('Supprimer ... ?')) {
    setIsEditing(false)  // <-- critical: makes isDirty false so guard doesn't fire
    deleteMut.mutate()
  }
}}
```

Deleting is a valid exit path that implicitly discards. The guard should never ask "save or discard?" when the user is deleting the record entirely.

### 28.5b Hard-block exit on validation failure (`shouldBlockExit` / `onExitBlocked`)

For screens with a hard validation rule that must be satisfied before the user can leave edit mode (e.g. composition must total 100% in `FilsReferences.tsx`), `useUnsavedGuard` accepts two extra optional fields:

```tsx
const guard = useUnsavedGuard({
  isDirty,
  save: async () => { await saveMutation.mutateAsync() },
  onDiscard: () => cancelEdit(),
  shouldBlockExit: isEditing && !compositionOk,    // hard-block flag
  onExitBlocked: () => { showCompositionAlert() }, // surface your own UI
})
```

When `shouldBlockExit` is `true`:
- Route navigation (sidebar clicks, menu changes, browser back) is intercepted; `onExitBlocked` fires and the route is reset — the unsaved-changes dialog does NOT open
- `guard.guardAction(fn)` calls (left-list selection, back button, drawer close) refuse to run; `onExitBlocked` fires instead

The caller is responsible for surfacing the explanation — typically a one-button `AlertDialog` describing the violated rule. The hook is intentionally agnostic about the UI: it just refuses to exit and lets you tell the user why.

Note that the in-page Annuler / Enregistrer buttons aren't routed through the guard — wrap their handlers with the same validation function used by `onExitBlocked` so they're also blocked. Reference: `FilsReferences.tsx` → `blockExitIfBadComposition`.

### 28.6 Hooks-before-returns (CLAUDE.md rule reinforced)

`useBlocker` is a React hook called from inside `useUnsavedGuard`. Since pages call `useUnsavedGuard` at their top level, this is fine in normal flow. But: **every hook in the page component (including `useState`, `useRef`, `useMemo`, `useCallback`, `useMutation`, `useQuery`, `useUnsavedGuard`) must be declared before any early `return`**. Violating this crashes production builds with React error #310 (dev builds may appear to work).

The 4 current reference screens all satisfy this — mirror their layout. When in doubt, put every hook at the top of the component body and only put early returns (`if (!detail) return null`) after the last hook call.

### 28.7 Reference checklist for new edit-mode screens

Every screen with an edit mode must have:

- [ ] `UnsavedChangesDialog` and `useUnsavedGuard` imported from the shared paths (§28.1)
- [ ] `originalDraftRef` captured in `startEdit`, containing every editable header field
- [ ] `isDirty` `useMemo` comparing current header state to the snapshot, OR'd with sub-form dirty flag(s)
- [ ] Sub-form dirty surfaced via **single-callback** (§28.3.a) OR **per-key registry** (§28.3.b) OR **ref-based** (§28.3.c) depending on architecture
- [ ] Every child component with its own form state uses the `useRef(callback)` + `useEffect` + unmount-cleanup trio (§28.3.a) — never a naked closure
- [ ] `useUnsavedGuard({ isDirty, save, onDiscard })` called at the page top level, with `save` awaiting the existing save mutation
- [ ] `handleSelect`, `onBack`, `handleClose`, and any row-click handler routed through `guard.guardAction(...)`
- [ ] `<UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />` rendered as a top-level sibling
- [ ] Delete button resets `setIsEditing(false)` **before** calling the delete mutation (§28.5)
- [ ] All hooks declared before any early `return` (§28.6)
- [ ] `tsc --noEmit` clean and `pnpm --filter @mps/web build` completes without errors

Manual test that must pass on every edit-mode screen:
1. Enter edit mode, change a field, click a different row in the list → dialog appears
2. Click **Annuler** → stays on current, edit state preserved
3. Click **Abandonner** → switches to new row, discarding changes
4. Click **Enregistrer** → saves, then switches
5. Enter edit mode, change a field, click a different sidebar route → same 3 outcomes
6. Enter edit mode with no changes, click another row → switches immediately, no dialog
7. Click delete → no dialog, deletion proceeds

---

## 29. Sidebar Status Footer (user-controlled state, detached pill)

References:
- **Binary**: `apps/web/src/pages/FilsCommandes.tsx` → `StatusFooter` (two-state toggle — en cours / terminée)
- **Multi-state**: `apps/web/src/pages/EtudesColoris.tsx` → `EtudeStatutFooter` (four-state menu — attente labo / soumis / accepté / annulé)

For entities with a **user-controlled primary state**, render the current state as a **solid-colored pill placed as a standalone sibling below the sidebar tabs panel** — not as a small badge in the header, and not as an inset cap on the bottom of the panel. The pill is both the status display and the state-change control, combined into a single visual unit, and it is structurally separated from the tabs panel by a 12px gap.

This pattern applies regardless of how many values the state can take:
- **2 values (binary)** → pill + split toggle button (§29.3)
- **3+ values (multi-state)** → pill + menu button that opens a transition popover (§29.4)

Both variants share the same outer shape, colors, and placement. Do NOT put state management in the detail header (no status Badge next to the title). Multi-state entities were an exception in earlier drafts of this skill — they are not an exception anymore.

### 29.1 Why a detached pill, not an inset footer

- The detail header is already dense with title, date, edit/delete buttons, and "Mode édition" chip — adding a badge there competes for attention
- A bar fixed below the right sidebar sits in a predictable spot across screens, so users always know where to look for / change status
- Giving the state its own bold, colored surface communicates its importance more than a pastel pill
- **Detaching** it from the tabs panel (rather than capping the panel with it) lets the tabs panel keep its own rounded-xl border on all four corners and makes the status pill feel like a first-class, distinct control rather than subordinate chrome of the tabs panel

### 29.2 Structure — parent layout

The sidebar's root is a flex column with two siblings: the tabs panel (fills remaining height) and the status pill (fixed height, pinned at the bottom). Use `gap-3` between them so they read as two distinct elements.

```tsx
return (
  <div className="w-96 flex-shrink-0 flex flex-col gap-3 min-h-0">
    {/* Tabs panel — takes remaining space, own rounded border on all four corners */}
    <div className="flex-1 min-h-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
      <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
        {/* tab buttons */}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
        {/* active tab content */}
      </div>
    </div>

    {/* Standalone status pill — flex-shrink-0, same w-96 inherited from the parent */}
    <StatusFooter
      etat={commande.etat}
      onToggle={onToggleEtat}
      isToggling={isTogglingEtat}
      disabled={isEditing}
    />
  </div>
)
```

Critical classes on the root:
- **`flex flex-col gap-3 min-h-0`** — the `min-h-0` is mandatory: without it the `flex-1` child can't shrink below its content's natural height and the status pill gets pushed off-screen.
- **`gap-3`** — 12px separation between the tabs panel and the status pill. Smaller gaps look accidental.

### 29.3 Binary variant — pill + split toggle button

Two states, one click flips from one to the other. The right-side action button's label describes the *target* state, not the current one ("Clôturer" on an en-cours order, "Rouvrir" on a closed one).

```tsx
function StatusFooter({
  etat, onToggle, isToggling, disabled,
}: {
  etat: number | null
  onToggle: () => void
  isToggling: boolean
  disabled: boolean
}) {
  const isDone = etat === 1
  const Icon = isDone ? CheckCircle2 : Clock
  const label = isDone ? 'Terminée' : 'En cours'
  const actionLabel = isDone ? 'Rouvrir' : 'Clôturer'
  const ActionIcon = isDone ? Clock : CheckCircle2

  return (
    <div
      className={cn(
        'flex-shrink-0 rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11',
        isDone ? 'bg-success border-success' : 'bg-primary border-primary'
      )}
    >
      {/* Left half: icon + state label */}
      <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
        <Icon className="h-4 w-4 flex-shrink-0" />
        <span className="text-sm font-bold uppercase tracking-wide truncate">{label}</span>
      </div>
      {/* Right half: toggle action, split by a white divider */}
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled || isToggling}
        title={isDone ? 'Marquer en cours' : 'Marquer terminée'}
        className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors"
      >
        <ActionIcon className="h-3.5 w-3.5" />
        {actionLabel}
      </button>
    </div>
  )
}
```

### 29.4 Multi-state variant — pill + menu button

Three or more discrete states (pending / sent / accepted / refused, draft / submitted / paid / overdue / cancelled, …). Same outer shape as the binary variant, but the right-side button opens a small popover with one row per possible state. Clicking a row fires the state-change mutation immediately and closes the menu.

```tsx
const STATUT_META: Record<Statut, {
  label: string               // e.g. "Soumis au client"
  icon: LucideIcon            // e.g. Send
  solidBg: string             // Tailwind bg class, e.g. 'bg-blue-500 border-blue-500'
}> = { /* …one entry per state… */ }

function StatutFooter({
  current, onChange, isChanging, disabled,
}: {
  current: Statut
  onChange: (next: Statut) => void
  isChanging: boolean
  disabled: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const meta = STATUT_META[current]
  const Icon = meta.icon

  // Click outside to close the menu.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  return (
    <div ref={rootRef} className="flex-shrink-0 relative">
      <div className={cn(
        'rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11',
        meta.solidBg,
      )}>
        <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
          <Icon className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-bold uppercase tracking-wide truncate">
            {meta.label}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          disabled={disabled || isChanging}
          title="Changer le statut"
          className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors"
        >
          {isChanging
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <ChevronUp className={cn('h-3.5 w-3.5 transition-transform', menuOpen && 'rotate-180')} />}
          Changer
        </button>
      </div>
      {menuOpen && (
        <div className="absolute bottom-full right-0 mb-1 w-full min-w-[220px] rounded-lg border bg-white shadow-lg overflow-hidden z-50">
          {STATUT_ORDER.map((s) => {
            const m = STATUT_META[s]
            const active = current === s
            const SIcon = m.icon
            return (
              <button
                key={s}
                type="button"
                onClick={() => { if (!active) onChange(s); setMenuOpen(false) }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors',
                  active ? 'bg-accent/10 text-accent cursor-default' : 'hover:bg-zinc-100',
                )}
              >
                <SIcon className="h-4 w-4" />
                {m.label}
                {active && <CheckCircle2 className="h-4 w-4 ml-auto text-accent" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

Conventions specific to the multi-state variant:
- **Menu button label is always `"Changer"`** (not the target state — there are too many possible targets to name one). The icon is a `ChevronUp` that rotates 180° when open so it reads as "expand upward."
- **Popover anchors to `bottom-full`** (opens upward from the pill) so it doesn't get clipped at the bottom of the viewport.
- **Active row is non-interactive** (`cursor-default`, no hover state, check icon on the right) — clicking it does nothing. The other rows fire `onChange` immediately.
- **`onChange` triggers a mutation that persists the change directly** — there is no "Enregistrer" step. Status changes are not part of the record's edit form. During edit mode, the button is `disabled` so the user can't race their own unsaved edit against a status change.
- **Loader replaces the chevron** while `isChanging` is true. The button stays disabled through the round-trip.
- **State list comes from a `STATUT_META` record** indexed by the state type. This is the same structure used by the left-list card (strip color), detail-header badge, and any other status-displaying surface — one definition, one visual language.

### 29.5 Conventions

- **Colors**: `bg-primary` (MPS deep blue) for the "in progress / active" state, `bg-success` for the "done / validated" state. The border matches the bg color (`border-primary` / `border-success`) so the pill reads as a single solid shape, not a ringed button. Do NOT use `bg-amber`/`bg-yellow` for active — amber is reserved for warnings/alerts. Do NOT use pastel transparent colors (`bg-primary/10`) — the pill must be solid and bold to match the left-list badge aesthetic.
- **Shape**: `rounded-xl` all four corners (NOT `rounded-b-xl`) — it's a standalone pill now, not a bottom cap.
- **Border + shadow**: `border shadow-sm` to match the tabs panel's visual weight. Without them the pill looks flat next to the bordered panel above.
- **Height**: fixed `h-11` — visually substantial without dominating the sidebar.
- **Typography**: `text-sm font-bold uppercase tracking-wide` for the state label, `text-xs font-semibold` for the action button text. White foreground throughout.
- **Action button as inset split**: the toggle button lives **inside** the colored pill, separated by `border-l border-white/25` and a `bg-white/15` hover-tinted surface. It is not an outlined shadcn `<Button>` — use a raw `<button>` so it can share the pill's background.
- **Disabled during edit mode**: pass `disabled={isEditing}` so users cannot toggle the state while a header edit is mid-flight. Also disable while the mutation is in-flight (`isTogglingEtat`).
- **No "Statut" label above the pill**: the bold colored pill speaks for itself. Adding a label above makes it feel like a form field and eats vertical space.

### 29.6 When to use the footer vs a badge in the header

| Situation | Pattern |
|---|---|
| **User-controlled** primary state — 2 values → §29.3 / 3+ values → §29.4 | **Footer pill** at the bottom of the sidebar |
| **Computed / derived** state shown for reference only (e.g. "en retard" from due date, "surstockée" from a threshold) | Badge in the detail header |
| Several independent flags displayed together (e.g. Bio + Recyclé + GOTS on a yarn reference) | Row of badges in the detail header or near the title |

Decision rule: *"Can the user change this from a dropdown or toggle?"* If yes, it goes to the footer, regardless of how many values exist. If it's purely derived from other fields (dates, thresholds, calculations), it stays in the header where it reads as "informational."

**Do not** place user-controlled status management in the detail header — even for multi-valued states. Earlier drafts of this skill allowed a header badge + menu as an alternative for 3+-state screens; that guidance has been superseded. Every status surface now uses the footer.

### 29.7 Gotcha: `<Badge variant='default'>` is primary blue, not grey

When building related status indicators elsewhere, note that the shadcn `<Badge>` component in this project defaults to `variant='default'` which is `bg-primary text-primary-foreground` — **solid deep blue**, not a neutral grey. If you append a `badge-warning` / `badge-success` utility via `className`, the variant's `bg-primary` will usually win because both classes sit in the same CSS layer. Always pass an explicit `variant` (`variant='default'`, `variant='success'`, `variant='warning'`, `variant='secondary'`) when building status badges. This is how `CommandeEtatBadge` in `FilsCommandes.tsx` is written: `<Badge variant="success">Terminée</Badge>` / `<Badge variant="default">En cours</Badge>`.

### 29.8 Left-list card status pill matches the footer color

The status pill on each **left-list card** must be the **same solid color** as the §29 footer pill for that state — not a pastel / tinted variant. A `terminée` order shows a solid green pill in the list **and** a solid green footer pill; an `en_cours` order shows solid blue in both. The user scans the list and reads each card's state with the exact same color language they then see on the detail footer.

- Drive both surfaces from the **same `STATUT_META` / `*_PHASE_META` record** — one `solid` field (`bg-… border-…`, paired with white text), consumed by the footer band *and* the list-card pill. Do **not** keep a separate pastel `classes` field just for the list pill; that splits the visual language in two and is exactly the mismatch this rule exists to prevent.
- List-card pill markup: `<Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white', meta.solid, className)}>` + the state icon at `h-2.5 w-2.5`.
- References: `FilsCommandes.tsx` → `CommandeEtatBadge` (solid `variant="success"` / `variant="default"`, matching its binary `StatusFooter`); `SousTraitantsCommandes.tsx` → `PhasePill` (solid `meta.solid`, matching the multi-phase `StatusFooter`).

This supersedes any earlier "light tinted background for inline use" guidance — the left-list status pill is solid.

---

## 30. List Card Deadline / Urgency Indicator

Reference: **`apps/web/src/pages/FilsCommandes.tsx`** → `deliveryUrgency()` helper + left-list card.

For any entity that has a **deadline** (delivery date, due date, échéance, expected ship date…), the left-list card should visually flag how urgent that deadline is. The pattern:

- **Red left edge + red selection ring** → deadline is today or already past, OR no deadline is set
- **Amber left edge + amber selection ring** → deadline is within the next 3 days
- **No decoration** → deadline is further out, OR the entity is in a terminal state (`terminée`, `livrée`, `payée`, `annulée`…)

This makes the "what do I need to deal with first?" question answerable at a glance without reading any date values.

### 30.1 Urgency helper

```tsx
// Urgency flag based on a YYYYMMDD deadline (HFSQL date string).
// 'late' = today >= deadline, OR no deadline specified (red)
// 'soon' = deadline within the next 3 days (amber)
// null   = not urgent, or entity is in a terminal state
function deliveryUrgency(deadlineHfsql: string | null, etat: number | null): 'late' | 'soon' | null {
  if (etat === 1) return null // terminal state — no urgency color
  if (!deadlineHfsql || !/^\d{8}$/.test(deadlineHfsql)) return 'late' // missing date = problem
  const y = Number(deadlineHfsql.slice(0, 4))
  const m = Number(deadlineHfsql.slice(4, 6)) - 1
  const d = Number(deadlineHfsql.slice(6, 8))
  const target = new Date(y, m, d); target.setHours(0, 0, 0, 0)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000)
  if (diffDays <= 0) return 'late'
  if (diffDays <= 3) return 'soon'
  return null
}
```

The three-day window and the "missing date = late" rule are deliberate — a missing deadline is almost always a data-quality problem the user should see as red rather than silently hide.

### 30.2 Rendering the indicator on the card

Two visual cues, applied together:

1. **Left-edge strip** via an inset `box-shadow` (not `border-l`) — see §30.3 for why
2. **Matching selection ring + border** when the card is the selected one — so the urgency color dominates the selection color instead of fighting it

```tsx
{rows.map((row) => {
  const isSelected = selectedId === row.id
  const urgency = deliveryUrgency(row.earliest_delivery, row.etat)
  const selectedRingClass =
    urgency === 'late' ? 'border-red-500 ring-1 ring-red-500'
    : urgency === 'soon' ? 'border-amber-500 ring-1 ring-amber-500'
    : 'border-accent ring-1 ring-accent'

  return (
    <div
      key={row.id}
      onClick={() => onSelect(row.id)}
      className={cn(
        'p-3 border rounded-lg cursor-pointer transition-all bg-white',
        isSelected ? selectedRingClass : 'border-border hover:border-accent/50',
        // Inset left-edge strip — uses --tw-shadow so it coexists with --tw-ring-shadow
        urgency === 'late' && 'shadow-[inset_4px_0_0_0_rgb(239_68_68)]',
        urgency === 'soon' && 'shadow-[inset_4px_0_0_0_rgb(245_158_11)]'
      )}
    >
      {/* …card contents… */}
    </div>
  )
})}
```

### 30.3 Why `shadow-[inset_...]` and not `border-l-4 border-l-red-500`

The left list cards already use `border border-accent` + `ring-1 ring-accent` to mark the selected row. Mixing that with `border-l-<color>` causes two problems:

1. `border-accent` is a shorthand (sets all four sides) and `border-l-red-500` is a longhand for the left side — the winner depends on Tailwind's stylesheet ordering, which is not stable across class combinations
2. The selection ring and the urgency strip are two separate visual concepts, and coupling them to the same `border-l` property makes it hard to keep the ring color consistent with the urgency color independently

`shadow-[inset_4px_0_0_0_<color>]` sidesteps both issues. Tailwind compiles arbitrary-value shadows to `--tw-shadow`, while `ring-1 ring-accent` compiles to `--tw-ring-shadow`. The final `box-shadow` property composes both variables, so a selected urgent row gets the ring **and** the inset left strip at the same time, with no ordering gymnastics. `cn()` (twMerge) also doesn't know about arbitrary shadow values, so nothing gets deduped away.

### 30.4 Color palette

Always use the same raw RGB values for consistency across screens:

| State | Fill color (inset shadow) | Ring / border class |
|---|---|---|
| `late` | `rgb(239 68 68)` (red-500) | `ring-red-500 border-red-500` |
| `soon` | `rgb(245 158 11)` (amber-500) | `ring-amber-500 border-amber-500` |
| normal | — | `ring-accent border-accent` |

Do NOT use the semantic `destructive` / `warning` tokens here — those vary slightly between light and dark themes, and deadline urgency should remain stable regardless of theme. Raw Tailwind red-500 / amber-500 is the right choice.

### 30.5 When this pattern applies

Apply it to any list card that carries a deadline the user cares about. Candidates in MPS_NG:

- Fils → Commandes (implemented) — earliest line `date_livraison`
- Clients → Facturation — `date_echeance`
- Sous-traitants → Commandes (implemented) — relance / delivery deadlines
- Production → Tricotage / Teinture / Confection — `date_prevue`
- Transport → Expéditions / Livraisons — `date_expedition` / `date_livraison`

**Exception — Clients → Commandes**: its left-list cards are neutral-by-default and color only on workflow state (amber = non affectée), NOT on delivery deadlines — see §41. Deadline urgency on that screen survives only at the line-card level inside the detail panel. When a screen's every card would end up red/amber under the deadline rule (long-running orders), prefer the §41 workflow-state model for the left list.

The three-day window can be tuned per domain, but the visual language (red = late/missing, amber = soon, no decoration = normal) stays constant across the whole app so users don't have to re-learn it per screen.

---

## 31. In-Screen Contained Drawer (click-a-row → slides up inside the center panel)

Reference: **`apps/web/src/pages/FilsCommandes.tsx`** → `StockLinkDrawer` + the split inside `LignesSection`.

When a user clicks a row in the center panel's main list (e.g. an order line), a drawer should slide up inside that same panel — **not** as a full-screen `Sheet` overlay. The rows shrink to make room; the drawer fills the bottom. Nothing outside the center panel is covered.

This pattern already exists in **MFProd** (`C:\dev\etsmalterre\mfprod\mfprod_erp` → `src/features/commandes/components/OrderDetail.tsx` + `AffectationPanel.tsx`) and should be used in MPS_NG for the same "drill into a row without losing context" interactions. It is distinct from:
- **§27 Table-centric screens** — those use a `fixed` right-side drawer that overlays the table body
- **§29 Sidebar status footer** — that is a pinned element, never hidden
- **shadcn `<Sheet>`** — that is a full-screen modal with an overlay backdrop

### 31.1 Core mechanic — flexbox sibling, no `position: fixed`

The drawer is a **flex sibling** of the rows-scrollable div, not a positioned overlay. The parent is already `flex-1 min-h-0 flex flex-col` (§7 single-list shape — **no framing `<Card>` around the list**, see §7 and §23). When the drawer is open, the rows div capitulates to `flex-shrink-0 max-h-[40%]` and the drawer gets `flex-1 min-h-0`. Flexbox handles the height split with no explicit calc.

```tsx
function LignesSection({ commande, stockDrawerLineId, onOpenStockDrawer, isEditing, ... }: Props) {
  // Drawer is closed whenever we enter edit mode — the line-card click is
  // reserved for the existing edit-mode buttons.
  const drawerOpen = stockDrawerLineId !== null && !isEditing
  const drawerLigne = drawerOpen
    ? commande.lignes.find((l) => l.IDref_fil_commande === stockDrawerLineId) ?? null
    : null

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Rows list: shrinks to 40% when drawer is open, full height otherwise */}
      <div
        className={cn(
          'overflow-auto space-y-2 p-1 scrollbar-transparent',
          drawerOpen ? 'flex-shrink-0 max-h-[40%]' : 'flex-1 min-h-0'
        )}
      >
        {commande.lignes.map((l) => (
          <LineCard
            key={l.IDref_fil_commande}
            line={l}
            isStockDrawerOpen={stockDrawerLineId === l.IDref_fil_commande}
            onOpenStockDrawer={onOpenStockDrawer}
            /* ...other props */
          />
        ))}
      </div>

      {/* Drawer: fills the remaining space, animated slide-in */}
      {drawerOpen && drawerLigne && (
        <div className="flex-1 min-h-0 flex flex-col mt-3 rounded-lg border border-border/60 overflow-hidden bg-zinc-50/80 animate-in slide-in-from-bottom-4 fade-in-0 duration-200">
          <StockLinkDrawer
            commandeId={commande.IDcommande_fil}
            ligne={drawerLigne}
            onClose={() => onOpenStockDrawer(null)}
            onSuccess={onMutationSuccess}
          />
        </div>
      )}

      {/* Existing totals footer stays pinned at the bottom */}
      {commande.lignes.length > 0 && (
        <div className="flex-shrink-0 mt-3 pt-3 border-t ...">…</div>
      )}
    </div>
  )
}
```

### 31.2 Toggle-on-reclick + selected-row highlight

The click behavior is a **toggle**: clicking the already-open row closes the drawer, clicking a different row switches it. The open row also gets a subtle highlight so the user always knows which row the drawer belongs to.

```tsx
// Inside LineCard
<div
  className={cn(
    'group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3',
    etatBorder,
    clickable && 'cursor-pointer hover:bg-zinc-100 hover:border-accent/40 transition-colors',
    isStockDrawerOpen && 'ring-1 ring-accent bg-accent/[0.06] border-accent/50' // selected-row cue
  )}
  onClick={clickable ? () => onOpenStockDrawer(isStockDrawerOpen ? null : line.IDref_fil_commande) : undefined}
>
```

State lives at the **page root** (`const [stockDrawerLineId, setStockDrawerLineId] = useState<number | null>(null)`), threaded down through `DetailMain → LignesSection → LineCard`. This keeps the drawer state outside the React Query cache and lets the page-level `startEdit` callback close it imperatively when the user switches to edit mode.

### 31.3 Auto-close when entering edit mode

Edit mode hides the drawer because the same line-card click is reserved for the inline edit UI. Close the drawer in `startEdit`, not just conditionally in the render:

```tsx
const startEdit = useCallback(() => {
  // …snapshot header draft…
  setStockDrawerLineId(null) // Edit mode hides the stock drawer
  setIsEditing(true)
}, [detail])
```

This means the drawer's `drawerOpen` guard (`stockDrawerLineId !== null && !isEditing`) is belt-and-suspenders — but the imperative close is what actually drops the state so it doesn't silently reopen when the user cancels the edit.

### 31.4 Drawer content chrome

Because the drawer sits **inside** the panel and the selected row is already highlighted right above it, **do NOT repeat the row's info at the top of the drawer**. The user can see it without scrolling. Keep the drawer header minimal — a thin strip with just an `X` close button on the right is plenty:

```tsx
<div className="flex flex-col h-full min-h-0 overflow-hidden bg-zinc-100/80">
  {/* Minimal top bar: close button only — row info is already visible in the list above */}
  <div className="flex-shrink-0 px-2 py-1 border-b bg-zinc-200/50 flex items-center justify-end">
    <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7" title="Fermer">
      <X className="h-3.5 w-3.5" />
    </Button>
  </div>
  <div className="flex-1 overflow-y-auto p-3 space-y-4 scrollbar-transparent">
    {/* sections, row items, etc. */}
  </div>
</div>
```

#### Chrome conventions — copy these classes

The drawer reuses the **same three-tone background scheme as the right DetailSidebar** (§8) so the in-screen drawer reads as "another sidebar panel, just inside this row". Do not pick other zinc shades.

| Layer | Class | Why |
|---|---|---|
| Outer container | `bg-zinc-100/80` | Matches the right DetailSidebar's tab panel — the drawer "belongs" to the same visual family. **Mandatory** — do not omit. |
| Top strip (close X + optional tabs) | `bg-zinc-200/50` | The darker gray strip mirrors the DetailSidebar's tab header band. |
| Cards inside the body | `rounded-lg border bg-card shadow-sm` | Same white card with light shadow as the InfoTab cards (§8.1). Do NOT use `bg-white` without a shadow — the card disappears into the zinc panel. |

Section headings inside the body keep the `text-[10px] uppercase tracking-wide text-muted-foreground font-semibold` convention (§5, §7).

#### Optional internal tab strip (multi-content drawers)

When the drawer has **two or more distinct content modes** (e.g. *Réception* vs *Affectés* in the sous-traitant `PiecesDrawer`), the top strip becomes a tab bar instead of a bare close button. The tab buttons MUST use the **same gold-pill active state as the right DetailSidebar's tabs** (§8) so the styling is unified across every sidebar-like panel in the app:

```tsx
<div className="flex-shrink-0 flex items-center border-b bg-zinc-200/50 p-1 gap-1">
  {tabs.map((t) => {
    const Icon = t.icon
    const active = activeTab === t.key
    return (
      <button
        key={t.key}
        type="button"
        onClick={() => setActiveTab(t.key)}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer',
          active
            ? 'bg-accent text-accent-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-accent/10',
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        <span>{t.label}</span>
      </button>
    )
  })}
  <div className="ml-auto flex items-center pr-1">
    <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7" title="Fermer">
      <X className="h-3.5 w-3.5" />
    </Button>
  </div>
</div>
```

Rules — do not deviate:
- **Active tab**: `bg-accent text-accent-foreground shadow-sm` (gold pill, dark text). NOT an underline, NOT a colored text-only active. This matches §8's right-sidebar tab bar exactly.
- **Inactive tab**: `text-muted-foreground hover:bg-accent/10`.
- **Close X** stays in the same top strip, pushed right with `ml-auto`. It's a sibling of the tabs, not a separate band.
- **Tabs don't `flex-1`** here (unlike the DetailSidebar's full-width tabs) because we need to reserve space for the close X on the right. They size to content.
- Tab icons: `h-3.5 w-3.5`. Tab labels: `text-xs font-medium`.

Reference implementation: `PiecesDrawer` in `apps/web/src/pages/SousTraitantsCommandes.tsx` — every convention above is set there.

### 31.5 Gotcha: `overflow-auto` clips ring-based highlights

The shrunk rows container has `overflow-auto`, which **clips the `ring-1` + `border-accent` highlight on the selected row** if there's no padding between the cards and the scrollable edge. Always add `p-1` (or wider) to the scrollable div:

```tsx
// WRONG — ring gets clipped on top/left edges
<div className="overflow-auto space-y-2 pr-1 ...">

// RIGHT — 4px of breathing room all around the cards
<div className="overflow-auto space-y-2 p-1 ...">
```

This same fix applies anywhere else in the app where a scrollable container holds cards with outer rings.

### 31.6 Data pattern: mutations return the full refreshed payload

Drawer contents usually show two lists that move items between themselves (linked ↔ available, selected ↔ candidate, etc.). Rather than invalidating and refetching after every mutation, have the **mutation endpoint return the full refreshed `{listA, listB}` payload** and hydrate it directly via `queryClient.setQueryData`. No round-trip, no flicker:

```tsx
const queryKey = ['commande-fil-stock', commandeId, ligne.IDref_fil_commande]

const linkMut = useMutation({
  mutationFn: (stockId: number) => apiFetch(`/commandes-fil/${commandeId}/lignes/${ligne.IDref_fil_commande}/stock/${stockId}`, { method: 'PUT' }),
  onSuccess: (payload: LineStockPayload) => {
    queryClient.setQueryData(queryKey, payload)
    onSuccess() // also invalidate the parent detail query so indicators on the row outside refresh
  },
})
```

The `onSuccess` callback bubbles up to the page so the parent `['commande-fil', id]` query (which drives the row's aggregate indicator, e.g. "N lots · X kg") also refreshes.

### 31.7 When to use this vs other drawer patterns

| Situation | Pattern |
|---|---|
| Click a row in a list to drill into a related sub-list / pick child items, without navigating away | **§31 in-screen drawer** (this section) |
| Edit a single entity's full form / certificate viewer / anything where the user needs the full screen | shadcn `<Sheet>` or `<Dialog>` |
| Stock-fil style "big table with a side panel for the selected row" | **§27 fixed right-side drawer** |
| Pinned always-visible state display | **§29 sidebar status footer** |

### 31.8 Candidate screens in MPS_NG

This pattern will recur wherever the user needs to "drill into a row to pick related items". Candidates:

- Fils → Commandes (implemented) — pick stock_fil lots for a ref_fil_commande line
- Clients → Commandes — pick finished-product lots for a client order line (same shape)
- Sous-traitants → Commandes — pick semi-finished batches for a subcontract return
- Production → Tricotage / Teinture / Confection — pick inputs to consume for a production order line
- Transport → Expéditions — pick ready-to-ship parcels for a delivery line

Every case has the same mechanic: a list of rows in the center panel, and each row needs an ad-hoc sub-picker against another table. This pattern is the canonical answer.

---

## 32. Email Send Dialog (Gmail API via domain-wide delegation)

References:
- **Shared component**: `apps/web/src/components/email/SendEmailDialog.tsx` — the single reusable two-pane dialog used by every email button in the app.
- **Shared lib**: `apps/web/src/lib/email.ts` — types (`EmailRecipient`, `EmailDefaults`, `SendPayload`), `parseEmailList`, `formatFileSize`, `MAX_TOTAL_ATTACHMENT_BYTES`, `postEmail(url, payload, opts)`.
- **Call sites**: `apps/web/src/pages/FilsCommandes.tsx` (with PDF preview) and `apps/web/src/pages/Entreprises.tsx` (no PDF → empty viewer).
- **Backend reference**: `apps/api/src/routes/commandes-fil.ts` → `/:id/email-defaults` + `/:id/email` (with server-rendered PDF + user attachments). `apps/api/src/routes/entreprises.ts` has the minus-PDF variant.

Every document-centric screen (bons de commande, devis, factures, bons de livraison, bons d'expédition…) plus "plain" email-enabled screens like Entreprises use the same `SendEmailDialog` component. Backed by a single Google service account with Workspace domain-wide delegation — there is no per-user OAuth flow.

**Historical note**: through April 2026 the plan was per-screen `EmailXxxDialog` forks until 3+ copies justified abstracting. The actual abstraction landed earlier: `FilsCommandes.tsx` got a working `EmailCommandeDialog`, then `Entreprises.tsx` needed one, then a bunch of other screens were queued — so the shared component was built directly, the local `EmailCommandeDialog` was deleted, and both call sites were wired through `<SendEmailDialog>`. **Do not re-fork per screen**. Add props to the shared component or lift state up if a screen needs something custom.

### 32.1 Infrastructure (one-time, already in place)

| Piece | File | Role |
|---|---|---|
| JWT impersonation + MIME builder | `apps/api/src/lib/gmail.ts` | `sendMail({ from, fromName, to, cc, subject, body, attachments })` — builds a RFC 2822 multipart/mixed message and sends via `google.gmail('v1').users.messages.send()`. One `JWT` instance per impersonated `subject`, cached across sends. |
| User→email map | `apps/api/src/lib/user-emails.ts` + `apps/api/data/user-emails.json` | JSON-file-backed, mirrors `permissions.ts`. Admin-editable via `/api/user-emails/users`. The `utilisateur` table has no `email` column, so the mapping lives outside HFSQL. |
| Admin editor | `apps/web/src/pages/SettingsUtilisateurs.tsx` → `EmailEditor` card | Lives above the permission list on each user. Local draft state, client-side regex check, Enregistrer disabled when empty-to-empty or invalid. |
| Env var | `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` in `apps/api/.env.{development,production}` | Absolute path to the service account JSON key. Read lazily inside `gmail.ts` (dotenv runs in `index.ts`, ESM import hoisting forbids reading at module load). Key file lives in `apps/api/secrets/` locally (gitignored) and `/home/debian/mps_api/secrets/` on the prod API server. |

The GCP project is **MPS-Desktop**, the service account is **OAuth_Sender** (`oauth-sender@mps-desktop.iam.gserviceaccount.com`), and its Client ID (`106332337770635660405`) is authorised in Google Workspace Admin → Security → API controls → Domain-wide Delegation for scope `https://www.googleapis.com/auth/gmail.send`.

### 32.2 Two-endpoint backend pattern per document type

For each document type (or plain entity) that needs email, add **two** endpoints next to the existing `/:id/pdf` endpoint (if any):

**`GET /:id/email-defaults`** — returns the shared `EmailDefaults` shape:

```ts
{
  recipients: {
    selected:    Array<{ email, name?, source: 'contact', contactId }>,  // pre-checked chips
    suggestions: Array<{ email, name?, source: 'contact', contactId }>,  // clickable to add
  },
  subject: string,
  body: string,
  // ...plus screen-specific context fields (fournisseurNom, entrepriseNom, numero, etc.)
}
```

Filter every contact on the parent record: skip `est_visible = 0`, require a non-empty `mail` matching `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, dedupe lowercase. Build `name` from `prenom + nom`. Split into two lists by the relevant `envoi_*` flag (for documents) or `est_defaut` (for entreprises, which have no `envoi_*`). Returns 404 if the parent record doesn't exist.

**`POST /:id/email`** — body:

```ts
{
  to: string[],                     // required, min 1, Zod .email()
  cc?: string[],
  subject: string,                  // min 1, max 500
  body: string,                     // min 1, max 20000
  attach_pdf?: boolean,             // default true; omit if there's no server PDF
  extra_attachments?: Array<{       // user-uploaded files from the dialog
    filename:       string,
    content_base64: string,
    content_type:   string,
  }>,
}
```

Validates via Zod, looks up the acting user's mapped email via `getUserEmail(req.userId)`, generates the server PDF via the shared helper (if `attach_pdf !== false`), decodes each `extra_attachments[].content_base64` to a Buffer, merges both into one `attachments` array, calls `sendMail()`. Responses:
- `200 { ok: true, messageId }`
- `400 no_sender_email` — acting user has no mapped email yet (see §32.7)
- `400 Validation failed` — Zod issues
- `404` — record not found
- `500 send_failed` — bubble `err.message` for the UI banner

**Body size**: `apps/api/src/index.ts` sets `express.json({ limit: '25mb' })`. Required — user attachments travel inline as base64 and the default 100 KB limit would reject anything non-trivial.

**PDF helper refactor (mandatory)** — the moment a document type gains an email endpoint, split its PDF rendering into a reusable `buildXxxPdfData(id)` + `renderXxxPdfBuffer(data)` pair. Both `/pdf` and `/email` call them so the attachment is byte-identical to the downloadable PDF. Reference: `commandes-fil.ts`.

**Iframe-embedding header strip (mandatory for any `/pdf` endpoint)** — see §21. The `SendEmailDialog` viewer iframes the `/pdf` endpoint, and helmet's default headers block cross-origin embedding. Every PDF endpoint MUST:
```ts
res.removeHeader('X-Frame-Options')
res.removeHeader('Content-Security-Policy')
res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
```
Without this the right pane silently falls back to the empty state. Already applied in `commandes-fil.ts`.

**Contacts filtering convention** — flags in the `contact` table drive which contacts go into `recipients.selected` vs `suggestions`:

| Document | Flag determining `selected` bucket |
|---|---|
| Bon de commande (commande_fil) | `envoi_commande = 1` |
| Facture | `envoi_facture = 1` |
| Bon de livraison | `envoi_bl = 1` |
| Devis / Soumission | `envoi_soumission = 1` |
| **Entreprise (no document)** | `est_defaut = 1` (fallback — entreprise contacts lack `envoi_*`) |

Everything that doesn't match the flag but still has a valid email goes into `suggestions` so the user can click-to-add.

### 32.3 Frontend — using the shared `SendEmailDialog`

Every screen mounts the same component. Do NOT fork it. Call site shape:

```tsx
<SendEmailDialog
  open={emailModalOpen}
  onClose={() => setEmailModalOpen(false)}
  contextLabel={detail?.fournisseur_nom ?? undefined}
  queryKey={['commande-fil-email-defaults', selectedId]}
  loadDefaults={() => apiFetch(`/commandes-fil/${selectedId}/email-defaults`)}
  pdfUrl={`${API_URL}/commandes-fil/${selectedId}/pdf`}
  pdfAttachmentLabel={`commande-fournisseur-${selectedId}.pdf`}
  onSend={(p) => postEmail(
    `${API_URL}/commandes-fil/${selectedId}/email`,
    p,
    { includeAttachPdf: true },
  )}
/>
```

For a screen without a document (Entreprises), drop `pdfUrl` + `pdfAttachmentLabel` and pass `postEmail(..., p)` without `includeAttachPdf`. The right pane shows the empty state until the user attaches a file.

**Props**:

| Prop | Type | Notes |
|---|---|---|
| `open` / `onClose` | `boolean` / `() => void` | Standard dialog visibility |
| `contextLabel` | `string?` | Header suffix (e.g. fournisseur / entreprise name) |
| `queryKey` | `readonly unknown[]` | React-query cache key for the defaults fetch — must be stable per open id |
| `loadDefaults` | `() => Promise<EmailDefaults>` | Called on open (guarded by `enabled: open`) |
| `onSend` | `(payload: SendPayload) => Promise<void>` | Caller wires the endpoint via `postEmail(url, p, opts)` |
| `pdfUrl` | `string?` | Optional; when omitted, the right pane shows the empty state and no server PDF chip is added to the attachment list |
| `pdfAttachmentLabel` | `string?` | Filename-like label shown on the server PDF chip (default `'document.pdf'`) |

**`postEmail` helper** (`apps/web/src/lib/email.ts`) does three things the caller should not reinvent:
1. Uses raw `fetch` with `credentials: 'include'` (NOT `apiFetch`) so the server's French `no_sender_email` message is preserved in the response body.
2. Serializes `payload.userAttachments` (`File[]`) to base64 via a binary-safe chunked `Uint8Array` → `btoa` loop, sends as `extra_attachments: [{ filename, content_base64, content_type }]`.
3. When `opts.includeAttachPdf` is true, forwards `attachPdf` as the `attach_pdf` body field.

### 32.4 Layout — the two-pane dialog

```
┌───────────────────────────────────────────────────────────┐
│  [@] Envoyer un email — {contextLabel}             [X]   │ ← flex-shrink-0 header, gold gradient
├─────────────────────────────┬─────────────────────────────┤
│ À                           │                             │
│ ┌─────────────────────────┐ │                             │
│ │ [👤 Jean D. ✕] [✕]      │ │                             │
│ │ + [Paul M.] [Marc T.]   │ │                             │
│ │ [ajouter une adresse] + │ │       <iframe #view=FitH>   │
│ └─────────────────────────┘ │       OR <img object-contain>│
│ Cc                          │       OR "Aperçu non         │
│ [__________________]        │          disponible"         │
│ Objet                       │       OR empty state         │
│ [__________________]        │                             │
│ Message                     │                             │
│ ┌─────────────────────────┐ │                             │
│ │ (flex-1, min-h-0,        │ │                             │
│ │  resize-none,            │ │                             │
│ │  anchored to bottom)     │ │                             │
│ └─────────────────────────┘ │                             │
├─────────────────────────────│─────────────────────────────│
│ [errors/success banner]     │ [📎 server.pdf ✕] [file ✕]  │
│       [Annuler] [Envoyer]   │ [+ Ajouter un fichier]      │
└─────────────────────────────┴─────────────────────────────┘
```

- Outer: `<DialogContent className="max-w-6xl w-[92vw] h-[85vh] flex flex-col p-0 overflow-hidden">`
- Header: `flex-shrink-0 px-6 py-4 border-b bg-gradient-to-r from-gold/25 via-gold/10 to-transparent`
- Body split: `flex-1 min-h-0 flex` → left `w-1/2 border-r flex flex-col`, right `w-1/2 bg-zinc-200/50 flex flex-col`
- **Left pane is a flex column**, NOT a scrollable container:
  - À / Cc / Objet blocks are each `space-y-1 flex-shrink-0` — preserve natural height
  - Message block is `flex-1 min-h-0 flex flex-col gap-1` with a `flex-shrink-0` label and the textarea at `flex-1 min-h-0 w-full resize-none scrollbar-transparent` — it fills all remaining space down to the footer
  - Footer (`flex-shrink-0 p-4 border-t bg-zinc-200/50`) holds the error/success banners and the Annuler + Envoyer buttons
- **Right pane is a flex column** with the viewer at `flex-1 min-h-0` and the attachment strip at `flex-shrink-0 border-t bg-white/70 px-3 py-2.5`, leading `Paperclip` icon

### 32.5 Recipient chip UX (left pane, À block)

Inside a bordered card, stacked vertically with `border-t border-border/40` dividers:

1. **Selected chips** — `<span>` elements with `bg-accent/10 border-accent/30 text-accent`, optional 👤 `User` icon for `source: 'contact'`, name-or-email, and a `<button>` ✕ that removes. Removing a contact-sourced chip moves it back to suggestions; removing a manual-sourced chip just drops it.
2. **Suggestion chips** — `<button>` elements with `bg-zinc-100 border-border/60 text-muted-foreground hover:bg-accent/10`, leading `+` icon. Click moves the recipient to the selected list.
3. **Manual entry** — `<input type="email">` + ghost `+` button. On Enter or button click, validate via `EMAIL_REGEX`, dedupe case-insensitive against both lists, push as `{ source: 'manual', email }`.

### 32.6 Attachment strip + clickable pills (right pane, bottom)

Strip layout: `flex items-start gap-2` with a leading muted `Paperclip`, then `flex-1 min-w-0 flex flex-wrap gap-1.5 items-center`.

**Pill types** (all keyed on stable ids):
- **Server-rendered PDF pill** — rendered when `pdfUrl && attachPdf`. Click body → `selectPreview('server')`. Click inner ✕ → `removeServerPdf()` (sets `attachPdf=false` + falls through the preview).
- **User-uploaded file pills** — one per entry in the internal `userAttachments: UserAttachment[] = { id, file, blobUrl }[]` state. Click body → `selectPreview(a.id)`. Click inner ✕ → `removeUserAttachment(a.id)` (revokes blob URL + filters + falls through preview). Shows filename + `formatFileSize(file.size)`.
- **"Ajouter un fichier" button** — dashed-border `<button>`, triggers a hidden multi-file `<input type="file">`. Mandatory `onClick={(e) => (e.target.value = '')}` reset from §22 so the same file can be picked twice.

**Pills are `<div role="button" tabIndex={0}>`, not `<button>`** — HTML forbids nested `<button>`s and each pill has an inner ✕ `<button>`. `onKeyDown` handles Enter/Space for keyboard. Inner ✕ uses `e.stopPropagation()` so removal doesn't also fire `selectPreview`.

**Active pill styling**: `border-accent ring-2 ring-accent/60` (gold ring). Inactive: `border-border/60 hover:bg-zinc-50`.

**Size cap**: the strip rejects additions that would push total user-attachment bytes above `MAX_TOTAL_ATTACHMENT_BYTES` (18 MB) and surfaces a French error banner. The total is shown inline as `X MB / 18.0 MB` on the right end of the strip when at least one user file is present.

### 32.7 Viewer preview state + render kinds

Internal state:
- `previewedId: 'server' | string | null` — currently shown in the viewer. Hydration effect sets it to `'server'` when a `pdfUrl` is passed, otherwise `null`.
- Resolved into an `ActivePreview` tagged union via `useMemo`:

```ts
type ActivePreview =
  | { kind: 'server-pdf';       url: string }
  | { kind: 'user-pdf';         url: string; name: string }
  | { kind: 'user-image';       url: string; name: string }
  | { kind: 'user-unsupported'; name: string; type: string }
  | { kind: 'empty' }
```

Render branch:
- `server-pdf` / `user-pdf` → `<iframe src={url} />` with `url = '...#view=FitH'`
- `user-image` → centered `<img className="max-w-full max-h-full object-contain" />`
- `user-unsupported` (anything not `application/pdf` or `image/*`) → `FileText h-12 w-12 opacity-30` + `"Aperçu non disponible pour ce type de fichier"` + truncated filename
- `empty` → `FileText h-12 w-12 opacity-30` + `"Aucun document à prévisualiser"`

**Preview auto-selection rules** (keep the viewer in sync with what's in the send queue):
- First hydration with pdfUrl → `'server'`; without pdfUrl → `null`.
- First user file added when preview is `null` → auto-select the new file.
- Server PDF removed + it was active → fall through to first user attachment, else `null`.
- User attachment removed + it was active → fall through to next user attachment, else back to server PDF (if still in list), else `null`.

**Blob URL lifecycle**: created in `handleFilePick` (`URL.createObjectURL(file)`), revoked in `removeUserAttachment` AND in the dialog-close cleanup effect (`setUserAttachments(prev => { prev.forEach(a => URL.revokeObjectURL(a.blobUrl)); return [] })`). If an addition is rejected by the size cap, the brand-new blob URLs are revoked too — no leaks on the reject path.

### 32.8 Conventions — do not deviate

- **Envoyer button variant = default (primary blue)**, NOT gold. `variant="gold"` is reserved for the canonical Modifier/enter-edit-mode CTA (§6.1/§12). In-form actions like Enregistrer/Envoyer use the default variant.
- **Icon in the DialogTitle** is `AtSign`. Send button icon is `Mail` (envelope). Never swap them.
- **Width**: `max-w-6xl w-[92vw] h-[85vh]`. Fixed, not responsive to content — the PDF preview needs room.
- **Pre-fill hydration runs once** on first defaults arrival via a `hydrated` flag so editing-in-progress isn't clobbered.
- **Cleanup effect on `open → false`** resets all state and revokes all blob URLs.
- **Validation before send**: at least one chip in `selectedRecipients`, non-empty `subject.trim()`. Surface errors in the red banner — don't throw.
- **Success banner → auto-close** after 1.2s via `setTimeout(onClose, 1200)`. Envoyer is disabled while `successMessage` is set.
- **When adding a new call site** the default shape is: screen-specific `queryKey`, `loadDefaults` via `apiFetch`, `onSend` via `postEmail(url, p, { includeAttachPdf: hasServerPdf })`. Everything else is already handled inside the shared component.

### 32.9 Body template conventions

Keep the default body **short, polite, French, and signed "ETS Malterre"**. Pattern from `buildEmailDefaults` in `commandes-fil.ts`:

```
Bonjour,

Veuillez trouver ci-joint notre bon de commande N°{numero}
[à destination de {fournisseurNom}].

Merci de bien vouloir nous confirmer la bonne réception de cette commande.

Cordialement,
ETS Malterre
```

Per document type, only the second line changes (the document reference). Do NOT generate elaborate multi-paragraph templates — users will edit the body when they need something specific, and a terse default is easier to personalise than a verbose one to delete.

### 32.10 From header convention

The API resolves the acting user's display name from `utilisateur.prenom + nom` and formats the From header as `Prénom Nom — ETS Malterre <mapped-email@etsmalterre.com>`. Never send with a bare email in the From header — Gmail will render it with the `mapped-email` local part as the display name, which looks clinical. The " — ETS Malterre" suffix makes the sender instantly recognisable in the recipient's inbox. MIME-encode the display name via the `encodeHeader` helper in `gmail.ts` so accented characters survive.

### 32.11 Error handling — map 400s to friendly French

The server's `400 no_sender_email` response includes a `message` field in French: `"Aucune adresse email n'est associée à votre compte. Un administrateur doit en définir une dans Paramètres › Utilisateurs."`

The frontend must surface this message verbatim — it directs the user to the exact fix. The `handleSend` raw-fetch path does this automatically by reading `json.message` before falling back to `json.error`. Do not strip or rephrase it in the dialog.

Any other 4xx/5xx falls through to the generic `Erreur HTTP {status}` banner.

### 32.12 Candidate screens

The shared `SendEmailDialog` covers every email-enabled screen. Apply to:

- Fils → Commandes ✅ implemented (with server PDF)
- Réseau → Entreprises ✅ implemented (no server PDF — plain message with user attachments)
- Sous-traitants → Commandes — contact flag `envoi_commande`
- Clients → Commandes — contact flag `envoi_commande`
- Clients → Devis — contact flag `envoi_soumission`
- Clients → Facturation ✅ implemented (proforma + définitive; proforma sends are NOT logged to `envoi_email` — id-space collision with definitive ids on the shared `IDtype_doc`; both PDFs carry the bank-coordinates card)
- Transport → Expéditions / Livraisons — contact flag `envoi_bl`

A new document screen needs:
1. A PDF renderer in `apps/api/src/lib/pdf/`
2. A `buildXxxPdfData(id)` + `renderXxxPdfBuffer(data)` helper pair reused by both `/pdf` and `/email`
3. The PDF endpoint with the iframe header strip (§21 + §32.2)
4. `GET /:id/email-defaults` returning the `recipients: { selected, suggestions }` shape
5. `POST /:id/email` accepting `extra_attachments`
6. The `@` button on the view-mode header trio (§6.1)
7. A `<SendEmailDialog>` mount at the page root passing `pdfUrl`, `pdfAttachmentLabel`, `queryKey`, `loadDefaults`, and `onSend` via `postEmail(..., { includeAttachPdf: true })`

A plain non-document screen (like Entreprises) skips steps 1–3 and omits `pdfUrl` / `pdfAttachmentLabel` from the `<SendEmailDialog>` props. The `onSend` call drops `includeAttachPdf`.

---

## 33. Destructive confirmation — `ConfirmDialog` (never use `window.confirm`)

Reference: **`apps/web/src/components/shared/ConfirmDialog.tsx`**, used for commande / ligne / document deletion in `FilsCommandes.tsx`.

**Never call `window.confirm()` / `window.alert()` / `window.prompt()` from application code.** Native browser dialogs are jarring, styled by the browser (so they break the app's visual language), block the entire tab, and cannot surface loading state while the destructive mutation runs. Every destructive or hard-to-reverse action in the app must go through `ConfirmDialog` instead.

### 33.1 Import & props

```tsx
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'

<ConfirmDialog
  open={confirmOpen}
  title="Supprimer la commande"
  description="Cette action supprimera la commande et toutes ses lignes. Elle est irréversible."
  confirmLabel="Supprimer"
  isPending={deleteMut.isPending}
  onCancel={() => setConfirmOpen(false)}
  onConfirm={() => deleteMut.mutate(id, { onSuccess: () => setConfirmOpen(false) })}
/>
```

| Prop | Type | Notes |
|---|---|---|
| `open` | `boolean` | Required |
| `title` | `string` | Required. Imperative + the entity ("Supprimer la commande"). Keep it to one short phrase. |
| `description` | `string?` | Optional second line. Use when the action has side effects the user needs to know about ("toutes ses lignes", "tous les contacts", etc.). Keep to 1–2 short sentences. |
| `confirmLabel` | `string?` | Defaults to `"Supprimer"` for destructive, `"Confirmer"` for default. Always an imperative verb. |
| `cancelLabel` | `string?` | Defaults to `"Annuler"`. Never override unless there's a specific reason. |
| `variant` | `'destructive' \| 'default'` | Defaults to `'destructive'`. Controls the title icon (`AlertTriangle` in red for destructive, none for default) and the confirm button variant (`destructive` red vs `default` primary). |
| `isPending` | `boolean?` | Wire this to the mutation's `isPending`. Disables both buttons and swaps the `Trash2` icon on the confirm button for a spinning `Loader2` — users get visual feedback that the action is actually running. |
| `onCancel` | `() => void` | Close the dialog. Also fires on overlay/escape/X. |
| `onConfirm` | `() => void` | Fire the destructive mutation. **The component does NOT auto-close on confirm** — you are responsible for closing it yourself, typically in the mutation's `onSuccess`. This lets the dialog stay visible (with its spinner) while the request is in flight. |

### 33.2 State pattern — local state at the nearest owner

Don't try to hoist confirmation state to the page root when the action is owned by a sub-component. Each component that fires a destructive mutation owns its own confirm state. If three different places on a screen can delete things (the detail header, the lines section, the docs tab), mount three `ConfirmDialog`s — one per owner — each with its own state. This keeps the concerns colocated and avoids cross-tree plumbing.

The canonical shape for a one-target-at-a-time delete:

```tsx
// Single-target delete (commande, current entity, etc.)
const [confirmOpen, setConfirmOpen] = useState(false)

// …in the button handler:
onClick={() => setConfirmOpen(true)}

// …at the end of the JSX:
<ConfirmDialog
  open={confirmOpen}
  title="Supprimer la commande"
  description="Cette action supprimera la commande et toutes ses lignes. Elle est irréversible."
  isPending={deleteMut.isPending}
  onCancel={() => setConfirmOpen(false)}
  onConfirm={() => {
    if (selectedId !== null) deleteMut.mutate(selectedId)
  }}
/>
```

For a list of items where each has its own delete button, store the target id (or full object) instead of a boolean — the dialog is "open" iff that value is non-null:

```tsx
// Per-row delete (line cards, doc cards, etc.)
const [deleteTarget, setDeleteTarget] = useState<LigneCommande | null>(null)

onDelete={() => setDeleteTarget(line)}

<ConfirmDialog
  open={deleteTarget !== null}
  title="Supprimer la ligne"
  description={deleteTarget ? `${deleteTarget.ref_fil} · ${deleteTarget.colori_reference} sera supprimée.` : undefined}
  isPending={deleteMut.isPending}
  onCancel={() => setDeleteTarget(null)}
  onConfirm={() => {
    if (deleteTarget) {
      deleteMut.mutate(deleteTarget.IDref_fil_commande, {
        onSuccess: () => setDeleteTarget(null),
      })
    }
  }}
/>
```

Storing the full object (not just the id) lets you interpolate entity fields into the `description` without a second lookup. The dialog closes on the mutation's per-call `onSuccess` — the page-level `deleteMut` can have its own global `onSuccess` for invalidation that runs in addition.

### 33.3 Placement — always a top-level sibling of the main JSX

Like `UnsavedChangesDialog` and `SendEmailDialog`, `ConfirmDialog` must be a **top-level sibling of the screen's main content**, not nested inside a card or section. Wrap the component's return in a `<>…</>` fragment if needed. Nesting it under a scrollable or transform-containing parent causes the `AlertDialog` overlay to render in the wrong stacking context and the dialog ends up clipped.

### 33.4 Copy conventions (French)

- **Title** — imperative verb + entity, no punctuation: `"Supprimer la commande"`, `"Supprimer le document"`, `"Supprimer la ligne"`. Not `"Êtes-vous sûr ?"` — that's a popup question, not a decision.
- **Description** — 1–2 short sentences in present tense, stating what will happen. End with a period. Mention cascading effects explicitly: `"Cette action supprimera la commande et toutes ses lignes. Elle est irréversible."` — the user deserves to know that deleting a commande also wipes its lines.
- **Confirm button** — imperative verb matching the title: `"Supprimer"` / `"Archiver"` / `"Clôturer"`. Never `"OK"` or `"Oui"`.
- **Cancel button** — always `"Annuler"`.

### 33.5 When to use the dialog vs proceed directly

Use it for:
- **Irreversible deletes** — rows from the database, files, linked sub-entities
- **Cascading actions** — deleting a parent that also removes children
- **State transitions that can't be trivially undone** — closing a commande, invoicing, sending
- **Discarding unsaved work** — covered by `UnsavedChangesDialog` (§28), not this one

Do NOT use it for:
- Toggling a boolean state that has its own in-place undo (`checked` → `unchecked`)
- Navigation with unsaved changes — use `UnsavedChangesDialog` instead
- Anything the user can trivially redo (reassigning a lot to a line, reordering a list)

When in doubt, lean towards using it — one extra click is much cheaper than a lost order.

### 33.6 Mandatory replacements

Any existing `window.confirm(…)` / `alert(…)` / `prompt(…)` call in the codebase is a bug. When you touch a file that still has one, replace it with `ConfirmDialog` as part of the same edit. Do not add new native dialog calls under any circumstances.

---

## 34. Polymorphic document attachments (`ged` + `type_doc`)

Reference implementation: **`apps/web/src/pages/FilsCommandes.tsx`** → `DocsTab`, `DocViewDialog`, `DocCreateEditDialog` + **`apps/api/src/routes/commandes-fil.ts`** → the `/:id/documents*` endpoint cluster.

The legacy MPS database uses **one shared table `ged`** to store documents for every entity in the system — client commandes, sous-traitant commandes, commande_fil (fournisseur orders), stock lots, certificates, references, and more. Rather than one attachment table per parent, rows are disambiguated by which of several discriminator columns is non-zero. Every screen that needs attached documents follows the same convention below — do not build a new dedicated table, and do not skip any of the conventions.

### 34.1 `ged` schema (columns you care about)

| Column | Type | Purpose |
|---|---|---|
| `IDged` | int PK | Stable id used by API routes and `stock_fil_ged` linker |
| `nom` | string | User-facing filename / label |
| `fichier` | blob (BinMemo) | The actual file bytes — may be empty/null even when `IS NOT NULL` (see §34.6) |
| `commentaire` | string | Free-form note |
| `IDdossier` | int FK | Legacy "dossier" grouping, rarely used in the new app — set to `0` |
| `IDcommande_client` | int FK | Non-zero iff the doc belongs to a client order |
| `IDcommande_sous_traitant` | int FK | Non-zero iff the doc belongs to a subcontractor order |
| `IDtype_doc` | int FK → `type_doc.IDtype_doc` | Doc type (facture fil, cert GOTS, BL, cert oekotex…). The full catalog lives in `type_doc` |
| `IDreference` | int | **The polymorphic parent id**. Interpretation depends on which of the discriminator columns above are non-zero |

### 34.2 Polymorphic discriminator — how to know which parent a row belongs to

There is no dedicated "parent_type" column — the owning entity is inferred from which FKs are zero:

| Parent entity | `IDcommande_client` | `IDcommande_sous_traitant` | `IDreference` |
|---|---|---|---|
| **Client commande** | `≠ 0` (the commande id) | `0` | typically also equal to the commande id (legacy quirk) |
| **Sous-traitant commande** | `0` | `≠ 0` (the commande id) | typically also equal to the commande id |
| **Commande_fil (fournisseur order)** | `0` | `0` | `= IDcommande_fil` |
| **Other entities** (stock_fil via `stock_fil_ged`, references via `IDreference`, dossier via `IDdossier`, …) | `0` | `0` | varies — see the specific screen's pattern |

**Critical consequence**: to query "documents for commande_fil #672", the WHERE clause is **not** just `IDreference = 672`. It must explicitly filter out client and sous-traitant rows:

```sql
WHERE g.IDreference = ${id}
  AND g.IDcommande_client = 0
  AND g.IDcommande_sous_traitant = 0
```

Skipping either zero guard leaks documents from other parent types that happen to share the same numeric id.

### 34.3 The canonical endpoint shape (mirror this for every parent)

For each parent type that needs documents, implement this exact five-endpoint cluster on the parent's route file. Naming uses `commande-fil` below — substitute the parent.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/:id/documents` | List metadata (joins `type_doc`, includes per-doc `linked_lots` when relevant) |
| `GET` | `/:id/documents/:idged/fichier` | Serve the blob as `application/pdf` / `image/*` / `application/octet-stream` |
| `POST` | `/:id/documents` | Multipart create (metadata + optional file) |
| `PUT` | `/:id/documents/:idged` | Multipart update (metadata + optional file replace) |
| `DELETE` | `/:id/documents/:idged` | Scoped delete |

Every endpoint **must** enforce the parent scope — a caller with a valid `IDged` from another commande must not be able to read, edit, or delete a doc that doesn't belong to the parent in the URL:

```ts
// Scope guard reused by every PUT/DELETE and the file GET
const scope = await query(
  `SELECT IDged FROM ged
   WHERE IDged = ${idged}
     AND IDreference = ${id}
     AND IDcommande_client = 0
     AND IDcommande_sous_traitant = 0`
)
if (scope.length === 0) { res.status(404).json({ error: 'Document not found' }); return }
```

Factor this into a helper (`verifyDocBelongsToCommande`) once you have more than two endpoints using it.

### 34.4 Encoding — `fixEncoding` for two separate base tables

The list endpoint joins `ged` and `type_doc`, both of which have French accented text that comes back corrupted through the ODBC bridge. `fixEncoding()` works on one base table at a time, so apply it twice:

```ts
const fixed = await fixEncoding(rows, 'ged', 'IDged', ['nom', 'commentaire'])
// type_nom (from type_doc) needs a separate targeted pass keyed on IDtype_doc:
const typeIds = Array.from(new Set(fixed.map((r) => r.IDtype_doc).filter((t) => t > 0)))
const typeMap = new Map<number, string>()
if (typeIds.length > 0) {
  const typeRows = await query(
    `SELECT IDtype_doc, nom FROM type_doc WHERE IDtype_doc IN (${typeIds.join(',')})`
  )
  const fixedTypes = await fixEncoding(typeRows, 'type_doc', 'IDtype_doc', ['nom'])
  for (const t of fixedTypes) typeMap.set(t.IDtype_doc, t.nom)
}
```

Do NOT try to `CONVERT(td.nom USING 'UTF-8') AS type_nom` inline in the JOIN — `fixEncoding` assumes a single base table and gets confused.

### 34.5 Writing binary blobs — hex literals, not parameters

HFSQL ODBC doesn't accept parameterized binary values. All blob writes go through a hex literal on `queryRaw`:

```ts
if (req.file && req.file.buffer.length > 0) {
  const hexStr = req.file.buffer.toString('hex')
  await queryRaw(`UPDATE ged SET fichier = x'${hexStr}' WHERE IDged = ${newId}`)
}
```

For `POST`, do the INSERT of metadata first (with zero blob), then the hex-literal UPDATE on the looked-up new `IDged`. For `PUT`, accept a `remove_fichier=1` form field that clears the blob when the user wants to delete the file without replacing it:

```ts
if (req.file && req.file.buffer.length > 0) {
  await queryRaw(`UPDATE ged SET fichier = x'${req.file.buffer.toString('hex')}' WHERE IDged = ${idged}`)
} else if (req.body.remove_fichier === '1') {
  await query(`UPDATE ged SET fichier = NULL WHERE IDged = ${idged}`)
}
```

### 34.6 Serving the blob — MIME sniff + empty-blob 404 + iframe header strip

```ts
const rows = await queryRaw(
  `SELECT fichier FROM ged
   WHERE IDged = ${idged} AND IDreference = ${id}
     AND IDcommande_client = 0 AND IDcommande_sous_traitant = 0`
)
if (rows.length === 0) { res.status(404).json({ error: 'Document not found' }); return }

const fichier = rows[0].fichier
if (fichier == null) { res.status(404).json({ error: 'No file attached' }); return }

let buf: Buffer
if (fichier instanceof ArrayBuffer) buf = Buffer.from(fichier)
else if (Buffer.isBuffer(fichier)) buf = fichier
else { res.status(404).json({ error: 'No file attached' }); return }

// HFSQL BinMemo IS NOT NULL is unreliable — empty/null-terminator-only
// blobs pass the null check. Return 404 here so the frontend HEAD pre-check
// can hide the viewer cleanly.
if (buf.length === 0 || (buf.length === 1 && buf[0] === 0)) {
  res.status(404).json({ error: 'No file attached' }); return
}

// Sniff MIME from magic bytes
let contentType = 'application/octet-stream'
if (buf.length >= 4) {
  const h = buf.subarray(0, 4)
  if (h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46) contentType = 'application/pdf'
  else if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4E && h[3] === 0x47) contentType = 'image/png'
  else if (h[0] === 0xFF && h[1] === 0xD8) contentType = 'image/jpeg'
}

res.setHeader('Content-Type', contentType)
res.setHeader('Content-Disposition', 'inline')
// Strip helmet so cross-origin iframe embedding works in dev
res.removeHeader('X-Frame-Options')
res.removeHeader('Content-Security-Policy')
res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
res.end(buf)
```

The "empty blob = 404" rule (§34.6 CLAUDE.md HFSQL rules) is mandatory: without it the frontend HEAD pre-check can't distinguish "document exists" from "document has a real file". Three magic-byte checks (PDF / PNG / JPEG) cover essentially every document type ETS Malterre uses; fall back to `application/octet-stream` and let the browser's inline handler do its best.

### 34.7 Per-lot scoping via `stock_fil_ged` — "zero rows = applies to all"

A `ged` row attached to a commande_fil can additionally be scoped to a subset of the commande's yarn lots via the **`stock_fil_ged`** linker table (`IDstock_fil_ged`, `IDged`, `IDstock_fil`). This is how a GOTS certificate applies to only some of an order's lots instead of the whole order.

**Semantics — critical and easy to get wrong**:

- **Zero rows in `stock_fil_ged` for a given `IDged`** = the document applies to **all** lots of the parent commande. This is the default and the "implicit global" state. It matches legacy behavior and means you don't need to backfill links when a new lot is added to the order.
- **One or more rows** = the document applies **only** to the listed lots — explicit specific scoping.

Do NOT add a separate boolean column to `ged` to represent "all vs specific" — the empty-set convention already encodes it. When the user flips a UI toggle from "specific" back to "all", DELETE every `stock_fil_ged` row for that `IDged` (not "insert one row per lot" — that would be the wrong semantics and would break the moment someone adds a new lot).

**Scope guard on link writes**: when inserting a `stock_fil_ged` row, verify that the stock_fil lot actually belongs to the parent commande via the line table:

```ts
const scope = await query(
  `SELECT sf.IDstock_fil FROM stock_fil sf
   INNER JOIN ref_fil_commande rfc ON sf.IDref_fil_commande = rfc.IDref_fil_commande
   WHERE sf.IDstock_fil = ${stockId} AND rfc.IDcommande_fil = ${id}`
)
if (scope.length === 0) {
  res.status(400).json({ error: 'Lot does not belong to this commande' }); return
}
// Idempotent insert — skip if already linked
const existing = await query(
  `SELECT IDstock_fil_ged FROM stock_fil_ged WHERE IDged = ${idged} AND IDstock_fil = ${stockId}`
)
if (existing.length === 0) {
  await query(`INSERT INTO stock_fil_ged (IDged, IDstock_fil) VALUES (${idged}, ${stockId})`)
}
```

**Endpoints**:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/:id/documents/:idged/lots` | Return `{ linked: StockLot[], available: StockLot[] }` |
| `PUT` | `/:id/documents/:idged/lots/:stockId` | Idempotent link (returns the refreshed `{linked, available}`) |
| `DELETE` | `/:id/documents/:idged/lots/:stockId` | Unlink a single lot (same return shape) |
| `DELETE` | `/:id/documents/:idged/lots` | Bulk clear — used when the UI toggle flips back to "all lots" |

Every write returns the refreshed `{linked, available}` payload so the dialog can hydrate via `queryClient.setQueryData` without a follow-up fetch. Matches the pattern used by the stock drawer's link/unlink endpoints.

### 34.8 Enrich the list endpoint with `linked_lots`

When the frontend shows a doc list and needs to render a per-card indicator like `"Lot A, Lot B"` when specific lots are selected, include a batched `linked_lots` field on each doc row from the list endpoint — don't force the frontend to fire N per-doc queries.

```ts
// After fetching + fixEncoding'ing the main ged rows:
const docIds = fixed.map((r) => r.IDged)
const lotsByDoc = new Map<number, Array<{ IDstock_fil: number; lot: string | null }>>()
if (docIds.length > 0) {
  const lotRows = await query(
    `SELECT sfg.IDged, sf.IDstock_fil, sf.lot
     FROM stock_fil_ged sfg
     INNER JOIN stock_fil sf ON sfg.IDstock_fil = sf.IDstock_fil
     WHERE sfg.IDged IN (${docIds.join(',')})
     ORDER BY sf.lot`
  )
  for (const lr of lotRows) {
    const arr = lotsByDoc.get(lr.IDged) ?? []
    arr.push({ IDstock_fil: lr.IDstock_fil, lot: lr.lot })
    lotsByDoc.set(lr.IDged, arr)
  }
}

const out = fixed.map((r) => ({
  IDged: r.IDged,
  nom: r.nom,
  commentaire: r.commentaire,
  IDtype_doc: r.IDtype_doc,
  type_nom: typeMap.get(r.IDtype_doc) ?? null,
  linked_lots: lotsByDoc.get(r.IDged) ?? [],  // empty array = "all lots"
}))
```

Empty `linked_lots` on the frontend = render nothing (the doc applies globally). Non-empty = render a `<BobineIcon>` + truncated `Lot A, Lot B, Lot C…` inline on the right side of the card.

### 34.9 Frontend — `DocsTab` + `DocViewDialog` + `DocCreateEditDialog`

Three components, all colocated in the parent screen file (not factored into shared), mirroring `FilsCommandes.tsx`:

1. **`DocsTab`** — the sidebar tab:
   - Fragment root (no wrapping card, per §8.2)
   - `useQuery` on `['<parent>-docs', parentId]`
   - Each doc rendered as a `p-3 rounded-lg border bg-card shadow-sm` card (per §8.1) with `editSectionClass` when editing, lot indicator on the right side when `linked_lots.length > 0`, hover-reveal trash in edit mode
   - Click-to-view (view mode) or click-to-edit (edit mode) per §8.3
   - `"Ajouter un document"` ghost button at the bottom, `isEditing && !isNew`
   - Locally-mounted `ConfirmDialog` (§33) for deletes — doc-level state `deleteDocConfirm: GedDocument | null`

2. **`DocViewDialog`** — chrome-free full-bleed iframe per §18.B:
   - HEAD pre-check on the file endpoint before rendering the iframe
   - Falls back to a compact `DialogContent` with "Aucun document attaché" when the HEAD returns 404 (empty blob)

3. **`DocCreateEditDialog`** — side-by-side form + preview per §18.C:
   - Left column: `LabeledInput` for `nom`, a select for `IDtype_doc` (sourced from `/fournisseurs/type-doc`, reuse that endpoint across screens — do not duplicate it), textarea for `commentaire`, the "Lots de fil" toggle + list section (edit mode only, doc exists), error banner
   - Right column: iframe preview of the current blob OR the freshly-picked file via `URL.createObjectURL`, file picker (`accept=".pdf,image/*"`), action buttons bottom-right
   - Raw `fetch` with `FormData` (NOT `apiFetch` — multipart needs the browser to set the boundary)
   - `createOpen || editingDoc !== null` controls `open`; `doc={editingDoc}` distinguishes create mode (null) from edit mode
   - On success, calls `onSuccess` which closes the dialog and invalidates the docs list — parent state (`createOpen`, `editingDoc`) is reset in the same handler

### 34.10 Candidate screens

Apply this entire pattern to every screen where entities have attached documents:

- **Fils → Commandes** ✅ reference implementation
- **Clients → Commandes** — discriminator: `IDcommande_client = id`, `IDcommande_sous_traitant = 0`
- **Sous-traitants → Commandes** — discriminator: `IDcommande_sous_traitant = id`, `IDcommande_client = 0`
- **Clients → Devis / Facturation** — same legacy split; check which `IDtype_doc` values legacy populates for each
- **Production → Tricotage / Teinture / Confection** — attached via `IDsuivi_tricotage` etc., polymorphic column depends on entity. Check the legacy MPS database before coding.
- **Stock → Matières premières / Produits finis** — these go through `stock_fil_ged` for yarn lots; finished-product lots may have their own linker

For each new parent, the checklist is: (1) identify the discriminator columns, (2) implement the five-endpoint cluster with scope guards, (3) copy-paste the three frontend components and adapt the query keys + parent id. Do NOT try to abstract the components into a single generic `<DocumentAttachments>` — the parent-specific scope guards and discriminator columns are different enough per screen that a generic component ends up riddled with conditionals.

---

## 35. Inline toggle pill (`role="switch"`)

Reference: **`apps/web/src/pages/FilsCommandes.tsx`** → `DocCreateEditDialog` "Appliquer à tous les lots" row.

For inline boolean controls inside a form — "Appliquer à tous les lots", "Notifier par email à la création", "Afficher les éléments archivés", etc. — use an iOS-style pill switch, not a plain `<input type="checkbox">` and not a shadcn-style filled checkbox. The pill reads as a toggle at a glance and matches the app's modern feel.

The app has no shared `<Switch>` component — copy this inline. Don't refactor into a component until at least three screens use it.

### 35.1 Markup

```tsx
<button
  type="button"
  role="switch"
  aria-checked={value}
  disabled={disabled}
  onClick={() => onChange(!value)}
  className={cn(
    'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
    'disabled:opacity-50 disabled:cursor-not-allowed',
    value ? 'bg-accent shadow-inner' : 'bg-zinc-300 hover:bg-zinc-400/80',
  )}
>
  <span
    className={cn(
      'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out',
      value ? 'translate-x-[18px]' : 'translate-x-0.5',
    )}
  />
</button>
```

### 35.2 Row layout — label on left, toggle pinned right

The toggle itself is intentionally small; give it a descriptive row around it so the whole thing is a clickable-feeling control:

```tsx
<div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-border/60 bg-white shadow-sm">
  <div className="min-w-0 flex-1">
    <div className="flex items-center gap-1.5 text-xs font-semibold">
      <BobineIcon className="h-3.5 w-3.5 text-accent" />
      <span>Appliquer à tous les lots</span>
    </div>
    <p className="text-[10px] text-muted-foreground mt-0.5">
      {value ? 'Ce document concerne toute la commande' : `${specific.length} lot sélectionné(s)`}
    </p>
  </div>
  {mutation.isPending && <Loader2 className="h-3 w-3 animate-spin text-accent flex-shrink-0" />}
  {/* …toggle button from §35.1 goes here… */}
</div>
```

### 35.3 Conventions

- **Track**: `h-5 w-9` (20×36px). `bg-accent` (gold `#F2B80A`) when on, `bg-zinc-300` when off. `shadow-inner` on the on-state adds a subtle recessed feel. Hover tint on the off-state only.
- **Thumb**: `h-4 w-4` white circle with `shadow`. Slides from `translate-x-0.5` to `translate-x-[18px]` — the arbitrary `18px` is `w-9 (36) - w-4 (16) - 2×(0.5×4) = 18`. A `200ms ease-out` transition is exactly enough to feel responsive without looking sluggish.
- **Accessibility**: `role="switch"` + `aria-checked` is non-negotiable — without them screen readers announce the button as a plain button. Full keyboard support comes for free via `<button>`.
- **Disabled**: `opacity-50 cursor-not-allowed` on the track; do NOT change the thumb position for disabled state — the user still needs to read the current value while a mutation is in flight.
- **Never use `<input type="checkbox">`** — browsers render those very differently on Windows (square, grey) vs macOS (circle, blue); the pill is consistent across platforms.
- **Label click**: the outer row is NOT clickable. The click target is the pill itself. Putting a click handler on the row risks firing when users click the subtitle text or a stray icon — confusing for state that drives a destructive operation (like clearing all lot links).

### 35.4 When NOT to use this pattern

- **Form submission checkboxes** (accept terms, agree to newsletter…) — a shadcn checkbox is more conventional there because those are part of a larger form submission, not inline state toggles
- **List filters** (hide terminated, show bio only…) — a plain checkbox+label in the toolbar is fine; the pill is overkill for a filter
- **Multi-select checkboxes** (lot-picker list, tag picker…) — use a checkbox; the pill doesn't scale visually to many side-by-side toggles

Use the pill specifically for **inline single-boolean state that has meaningful UX consequences** (hides/shows a section, toggles a mode, clears/sets a relationship).

---

## 36. Sous-traitant type chip (hue-per-type category tag)

Reference: **`apps/web/src/lib/sst-type.tsx`** — `sstTypeTagClasses(type)` + `<SstTypeTag>`. Used by `SousTraitantsCommandes.tsx` (left-list cards + detail header) and `SousTraitantsGestion.tsx` (left-list cards, detail header, Info-tab KV row).

A sous-traitant's **type** (Tricoteur / Ennoblisseur / Confectionneur / Autre) is a *category*, not a status — so it gets its own **hue-per-type chip**, one stable colour per type, so the user can scan a list and tell knitters from dyers at a glance. This is **not** a `<Badge variant="secondary">` (that grey chip reads as generic metadata and is identical for every type) and **not** the §29 status footer (type isn't user-cycled state).

### 36.1 The single source of truth

Both Sous-traitants screens import from `@/lib/sst-type` — never re-define the colour map per page (the whole point is that Commandes and Gestion look identical).

```tsx
import { SstTypeTag, sstTypeTagClasses } from '@/lib/sst-type'

// Component form (preferred): renders nothing for an empty type.
<SstTypeTag type={sousTraitant.type_label} size="sm" />   // left-list cards
<SstTypeTag type={commande.sous_traitant_type} size="md" /> // detail headers / KV rows

// Class-only form, when you need the colours on your own element:
<span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', sstTypeTagClasses(type))}>{type}</span>
```

### 36.2 The palette — fixed, do not improvise

| Type | Classes | Rationale |
|---|---|---|
| **Ennoblisseur** | `bg-sky-500/10 text-sky-700 border border-sky-500/25` | sky/blue — cool, dye/water association |
| **Tricoteur** | `bg-amber-500/15 text-amber-800 border border-amber-500/30` | amber/orange — warm, yarn association |
| **Confectionneur** | `bg-teal-500/10 text-teal-700 border border-teal-500/25` | teal — clean cut-and-sew finishing |
| **Autre / unknown** | `bg-stone-500/10 text-stone-700 border border-stone-500/25` | muted stone fallback |

The match is **case-insensitive on the French label** (`type.trim().toLowerCase()`), so it works whether the value comes from `type_label` (Gestion) or `sous_traitant_type` (Commandes).

### 36.3 Conventions

- **Never use gold/`bg-accent`** for a type chip — gold is reserved for the brand CTA / active state (§12). The amber tricoteur chip is deliberately `amber-500` (orange-leaning) + `amber-800` text so it stays distinct from the solid gold CTA.
- **No icon** inside the chip — the colour + label carry the meaning; an extra `<Tag>` icon just adds noise.
- **Two sizes only**: `size="sm"` (`px-1.5 py-0.5 text-[10px]`) for left-list cards, `size="md"` (`px-2 py-0.5 text-xs`) for detail headers and KV-row values.
- When a new sous-traitant type is added to `type_sst`, add its hue to `sstTypeTagClasses` in the shared module — do not let it silently fall through to the stone fallback if it deserves its own colour.

---

## 37. Stock-fini état pill (`EtatPill`) — one component, everywhere

Reference: **`apps/web/src/lib/etat-stock-fini.tsx`** — `<EtatPill libelle={...} variant={...} />` + `etatPillClass(libelle, variant)`. Consumers: `FinisStock.tsx` (table État column + drawer Statut KV — soft), `SousTraitantsGestion.tsx` (rolls-on-site table — soft), `ClientsCommandes.tsx` (Affectation drawer roll rows — solid).

Whenever a screen displays a `stock_fini` roll's **état** (the `etat_stock_fini` libellé — En Contrôle, Validé, Reprise, Refusé…), render the shared `<EtatPill>` component. **Never** an ad-hoc `<Badge variant="outline">`, never inline colour classes. The whole point of the pill is its colour language, and it only works if it is identical on every screen.

**One hue per état, two intensity variants.** The hue mapping is the standard; the variant only changes intensity:

| État (libellé match) | Hue | `soft` (tables, inline chips) | `solid` (roll cards, catch-the-eye) |
|---|---|---|---|
| contrôle | amber | `bg-amber-100 text-amber-800 border-amber-200` | `bg-amber-500 text-white border-amber-500` |
| reprise | orange | `bg-orange-100 text-orange-800 border-orange-200` | `bg-orange-500 text-white border-orange-500` |
| validé / disponible / prêt | emerald | `bg-emerald-100 text-emerald-800 border-emerald-200` | `bg-emerald-600 text-white border-emerald-600` |
| refusé / rebut | red | `bg-red-100 text-red-700 border-red-200` | `bg-red-600 text-white border-red-600` |
| unknown / other | zinc | `bg-zinc-100 text-zinc-700 border-zinc-200` | `bg-zinc-500 text-white border-zinc-500` |

```tsx
import { EtatPill } from '@/lib/etat-stock-fini'

<EtatPill libelle={roll.etat_libelle} />                    // soft (default) — table cells, inline chips
<EtatPill libelle={roll.etat_label} variant="solid" />      // solid — roll cards
```

**Which variant where**:
- **`soft` (default)** — dense table cells, drawer KV values, inline chips next to other text. The pastel keeps rows calm when many pills stack in a column.
- **`solid`** — roll cards where the état is a primary scanning cue (Clients/Commandes Affectation drawer). **Anchor it at the far right of the card** (`flex-shrink-0`, LAST element of the row — after the hover icons AND the action button). Rationale: the état is the only element present on every row, while defect/observation icons and action buttons are conditional — so the constant gets the edge and the variables flow in on its left. Pinning the pill's right edge makes all rows' statuses read as a right-aligned column even when labels differ in width. Do NOT place it inline after the roll number/lot, and do NOT place it before the conditional icons — both make its x position wander row to row.

Conventions — do not deviate:

- **Markup is fixed**: `inline-flex items-center rounded-full border font-medium` + per-variant sizing (`px-2 py-0.5 text-[10px]` soft / `px-2.5 py-0.5 text-xs font-semibold` solid) + the colour classes. It's baked into the component — don't rebuild the `<span>` by hand with `etatPillClass`; the class-only export exists for exceptional cases (e.g. applying the colours to a non-pill element), not as an invitation to fork the markup.
- **`EtatPill` renders `null` for an empty libellé.** When the surrounding layout needs an explicit empty marker (a table cell), the call site renders the `—` fallback itself: `{row.etat_libelle ? <EtatPill libelle={row.etat_libelle} /> : <span className="text-muted-foreground">—</span>}`. Inline flows (chips row on a roll card) just render `<EtatPill libelle={x} />` and let it disappear.
- **Matching is substring-based on the French libellé** (case-insensitive, accent-tolerant for contrôle/prêt). New états added to the `etat_stock_fini` catalog that deserve their own colour get added to `etatPillClass` in the shared module — **both variants at once** — never a per-screen override.
- This pill is a **read-only category/status display** — it is NOT the §29 user-controlled status footer (état changes go through their own workflows, e.g. Qualité/Suivi lots), and NOT the §36 sous-traitant type chip (different palette, different domain).
- **History**: the Clients/Commandes Affectation drawer originally rendered the état as a plain outline Badge (grey, regardless of state) — exactly the drift this rule prevents. If you find another surface showing a roll état without `EtatPill`, fix it as part of your change.

---

## 38. Branded PDF documents (`MalterreDocument`) — meta-row icon alignment + financial-document body

References: **`apps/api/src/lib/pdf/MalterreDocument.tsx`** (shared frame, `AddressCard`, `MetadataCard`, inline SVG icons), **`apps/api/src/lib/pdf/theme.ts`** (PDF palette + company info), **`apps/api/src/lib/pdf/FacturePdf.tsx`** (reference financial-document body).

### 38.1 Icon + label rows: ALWAYS set a tight `lineHeight` on the Text

In `@react-pdf/renderer`, a `Text` inherits the content area's `lineHeight: 1.45`, which inflates its line box (the extra leading goes **below** the glyphs). In a `flexDirection: 'row', alignItems: 'center'` meta row, the sibling `Svg` icon centers against that inflated box, so the icon visually sits **below** the label — the "icons not aligned with their labels" bug (shipped on the first Facture PDF, July 2026).

**Rule**: every `Text` that sits beside a center-aligned icon in a PDF meta row MUST declare its own tight `lineHeight` (`1` for single-line caps labels, `1.25` for label/value rows). The shared `metaLabel`/`metaValue`/`cardTitle` styles in `MalterreDocument.tsx` already do this — **prefer reusing `MetadataCard`/`AddressCard` over re-rolling per-document meta rows**. If a document must roll its own row (conditional rows, custom padding), copy the `lineHeight` along with the rest of the style, not just the colors.

```tsx
// WRONG — inherits lineHeight 1.45, label glyphs float above the centered icon
metaLabel: { fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, flex: 1 },

// RIGHT
metaLabel: { fontSize: sizes.fontBase, color: colors.muted, fontWeight: 700, flex: 1, lineHeight: 1.25 },
```

### 38.2 Financial documents (facture / avoir) — formal ledger body

Factures and avoirs use a more formal body than the softer rounded-box tables on devis/commandes. Reference: `FacturePdf.tsx`.

- **Lines table**: **squared** — no rounded outer box, no outer border. Header band keeps the family treatment (`colors.bgMuted` bg, `colors.text` `fontWeight: 900` uppercase labels, `letterSpacing: 0.8`, `lineHeight: 1`, 2pt **gold** rule beneath). Rows separated by 0.75 hairlines (`colors.border`); the last row drops its hairline and the table container closes with a 2pt **gold** bottom rule matching the header's.
- **No solid navy fills, no navy rules**: do NOT use a `colors.primary`-filled header band or totals band, and structural rules (under the table header, closing the table, above the TTC row) are all 2pt **gold** — the user rejected both filled blue bands and a blue table-closing rule. Navy appears only as text color.
- **Designation cell**: first line `colors.text` bold 10.5 (**never** `colors.primary` blue — reads as a web link); detail lines 9pt `colors.muted`.
- **Numeric cells**: 10pt; the MONTANT column is bold.
- **Totals block**: right-aligned, `width: '45%'`, **no bordered rounded box, compact** — it should read as a small arithmetic recap, not a second table. Rows at `paddingVertical: 3.5` (muted bold 10pt label left, bold 10pt value right, tight `lineHeight: 1.25`), hairline between HT and TVA, then the grand total row: `colors.bgTotal` bg, 2pt gold **top** rule, `colors.primary` `fontWeight: 900` text at `sizes.fontLg`, `paddingVertical: 6`.
- **Column discipline**: totals values share the MONTANT column's right inset (12pt row padding + 4pt cell padding = `paddingRight: 16`) so every figure on the page aligns in a single column.

Visual verification: mirror `apps/api/src/scripts/dump-facture-pdf.ts` — a synthetic-data render script (no DB) whose output PDF you can open/inspect directly.

---

## 39. "Classeur" — Fiche with a master-tabbed center panel

Reference: **`apps/web/src/pages/ClientsGestion.tsx`** → `DetailMain` + `MAIN_TABS` (Références / Historique des commandes / Marchandise expédiée).

A variant of the **Fiche** (3-panel) layout. Everything else is identical — left list (§5), detail header (§6), right sidebar with tabs (§8), edit mode (§9/§25), unsaved guard (§28) — except the **center panel body**: instead of stacking §23 collapsible section cards, a row of **master tabs** at the top switches the whole center body between the datasets, and the active dataset gets the full panel height.

### 39.1 When Classeur vs Fiche

| Situation | Layout |
|---|---|
| Center sections are small/medium and the user scans several together (notes + certs + commandes) | **Fiche** — §23 collapsible cards |
| Center sections are large, read-mostly row-sets (history tables, catalogs) and only one is consulted at a time | **Classeur** — master tabs (this section) |
| The center panel IS one single primary list (lignes, soumissions, mouvements) | **Fiche single-list shape** — §7 / §31, no tabs, no cards |

### 39.2 Structure

```tsx
const MAIN_TABS = [
  { key: 'references', label: 'Références', icon: Tag },
  { key: 'historique', label: 'Historique des commandes', icon: History },
  { key: 'marchandise', label: 'Marchandise expédiée', icon: Truck },
] as const
type MainTab = (typeof MAIN_TABS)[number]['key']

function DetailMain({ client, isLoading, hasSelection, ... }) {
  const [activeTab, setActiveTab] = useState<MainTab>('references')
  // Land on the main-info tab whenever the selection changes.
  useEffect(() => { setActiveTab('references') }, [client?.IDclient])

  // …no-selection / loading / null early returns (AFTER the hooks — §28.6)…

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Master tabs — header-submenu style pills on the natural background */}
      <div className="flex-shrink-0 flex items-center gap-1 border-b border-border/60 pb-2">
        {MAIN_TABS.map((t) => {
          const Icon = t.icon
          const active = activeTab === t.key
          return (
            <button key={t.key} type="button" onClick={() => setActiveTab(t.key)}
              className={cn('flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
                active ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10 hover:text-accent')}>
              <Icon className="h-3.5 w-3.5" />{t.label}
            </button>
          )
        })}
      </div>
      {/* px-1/pb-1 keep focus rings and hover borders clear of the overflow clip (§31.5) */}
      <div className="flex-1 min-h-0 overflow-auto space-y-2 pt-3 px-1 pb-1">
        {activeTab === 'references' && <ReferencesTab clientId={client.IDclient} ... />}
        {activeTab === 'historique' && <HistoriqueTab clientId={client.IDclient} />}
        {activeTab === 'marchandise' && <MarchandiseTab clientId={client.IDclient} />}
      </div>
    </div>
  )
}
```

### 39.3 Rules — do not deviate

- **Master tab styling = header submenu tabs (§3)**, NOT the sidebar's zinc tab band (§8): gold pill active (`bg-accent text-accent-foreground shadow-sm`), inactive `text-muted-foreground hover:bg-accent/10 hover:text-accent`, tabs sized to content and left-aligned, `px-4 py-1.5`. This is deliberate — the center panel must NOT be wrapped in a zinc `bg-zinc-100/80` panel with a `bg-zinc-200/50` tab band, or it reads as a duplicate of the right sidebar (that variant was tried and rejected).
- **Content sits on the natural page background** — no panel wrapper, no border box around the tab body. The only chrome is a `border-b border-border/60 pb-2` divider under the tab row and `pt-3` above the content.
- **Item cards inside the tabs keep their normal §7 center-panel styling** (zinc `bg-zinc-100/80` item cards with `border-l-4` status edge; tables in white `bg-card shadow-sm` containers) — they are on the page background, so the §8.1 white-card rule for zinc panels does NOT apply.
- **Default tab = the entity's main info**, and it resets on every selection change via `useEffect` keyed on the record id — the user always lands on the primary dataset, never on a stale tab from the previous record.
- **Lazy per-tab queries**: tab content components are conditionally mounted, so each tab's `useQuery` fires on first visit only (no `enabled` flag needed). Never lift the three queries to the parent to fetch eagerly — each tab is a real HFSQL query against the shared server.
- **No count badges in the tab labels** — showing counts on inactive tabs would force all datasets to fetch on every selection, defeating the lazy loading.
- **Tab state lives in `DetailMain`**, declared before the no-selection/loading early returns (hooks-before-returns, §28.6).
- Each tab body renders as a **fragment** (spinner / empty / content + its own dialogs) — no redundant wrapping card repeating the tab's name (§8.2 applies here too).

### 39.4 Candidate screens

Any Fiche screen whose center panel would otherwise stack 2+ large read-only history/catalog sections:

- Clients → Gestion ✅ reference implementation (Références / Historique / Marchandise expédiée)
- Sous-traitants → Gestion — if it ever grows per-sst history tables
- Réseau → Entreprises — if commandes/recommandations histories grow into full tables

---

## 40. Responsive doctrine — tablet / Galaxy Z Fold / phone

Reference: **`apps/web/src/pages/FilsStock.tsx`** (`StockLotCard`, `CardKV`, mobile sort row, drawer X close) + **`apps/web/e2e/`** (the regression harness). Established July 2026 as the pilot for the app-wide responsive rollout. Targets: tablets (768–1024), Z Fold unfolded (~717px CSS), phones (360–430), Z Fold cover screen (~345px — the narrowest supported width).

### 40.1 The prime directive: desktop pixels never change

Every responsive change must be **additive**: existing markup gets `hidden md:*`, new mobile markup gets `md:hidden`, form grids gain `sm:` gates, flex order swaps use `order-*` utilities that preserve DOM order at `sm`+. Never restructure or restyle desktop rendering "while you're in there". Proof is mechanical, not visual: capture Playwright desktop baselines BEFORE the first CSS change (§40.7) and keep them green after every edit — during the work, temporarily set `maxDiffPixels: 0` to prove strict pixel identity.

Layout-family map (which screens need work):
- **Table-centric (§27)** — the responsive gap; this section is mostly about them. Done: FilsStock ✅, FinisStock ✅ (incl. edit-mode multi-select cards — checkbox is CSS-driven via a `data-editing` group attribute on the card container, same trick as the tbody, so edit-mode toggles re-render zero cards), TombeMetierStock ✅ (adds a toolbar `PopoverSelect` filter — see the §40.5 forced-wrap wrapper rule). To port: RapportCommandesSst.
- **Master-detail (§4)** — already handled by `useResponsiveLayout` (stacked below 1240). Do not touch.
- **Dashboard** — already responsive (`sm:`/`lg:` grid).

### 40.2 Table-centric screens: card list below `md`

**Breakpoint is `md` (768px)** — stock Tailwind, no custom screens. Z Fold unfolded (~717px) deliberately gets cards: 10+ fixed-layout columns at 717px are unreadable, and unfolded-Fold is a handheld. Tablets (768+) keep the table with its existing `truncate` cells.

Structure inside the §27.3 table card container — loading/error/empty branches stay shared ABOVE both siblings:

```tsx
{/* Desktop table (md+) — split header/body sharing one colgroup */}
<div className="hidden md:flex md:flex-col flex-1 min-h-0">
  {/* header <table> + scrolling body <table> exactly as §27.3 */}
</div>

{/* Mobile card list (< md) — same rows, selection and sort state as the table */}
<div className="md:hidden flex-1 min-h-0 flex flex-col">
  {/* sort row (§40.3) */}
  <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent p-2 space-y-2 bg-zinc-100/80">
    {filteredSorted.map((r) => (
      <StockLotCard key={r.id} row={r} isSelected={...} onClick={() => handleRowClick(r.id)} />
    ))}
  </div>
</div>
```

**No logic duplication** — the cards consume the exact same `filteredSorted`, `selectedId`, `handleRowClick` (and therefore the unsaved-changes guard) as the table. Only row markup is rendered twice; one branch is `display:none` at any width.

### 40.3 The card pattern (`StockLotCard` / `CardKV`)

- Container: `rounded-lg border p-3 cursor-pointer transition-colors shadow-sm`; selected `bg-accent/10 border-accent ring-1 ring-accent`, unselected `bg-white border-border/60 hover:border-accent/40`. Cards sit on a `bg-zinc-100/80` panel (§5 list-item language).
- **Must carry `data-stock-row`** and the same onClick as the table row — this is what keeps the drawer's outside-click logic working (§27.5).
- Header row: primary field (`text-sm font-medium truncate`) + right-aligned icon cluster mirroring the table's trailing icon column (Leaf/Recycle/"T" badge).
- Second line: secondary identifier (`text-xs text-muted-foreground`).
- Body: 2-col grid of `CardKV` (label `text-[10px] uppercase tracking-wide text-muted-foreground`, value `text-xs truncate`, `tabular-nums` for numbers, `font-semibold` on the value users scan for — e.g. Stock).
- Optional footer after a `border-t border-border/40`: comment (italic, truncate) left, date right.
- The shared primitives live in **`apps/web/src/components/stock/StockCardParts.tsx`**: `CardKV` (label/value cell) and `MobileSortRow` (generic over the screen's `SortKey`). The card component itself (`StockLotCard`, `StockFiniCard`) stays **in-file** next to the page — fields differ per screen. Memo the card like the table row when the screen has perf-sensitive row counts.

**Mobile sort row** — table headers disappear with the table, so sorting gets a compact `md:hidden` row above the cards, styled like the table header band (`bg-zinc-200/60 border-b border-border/60 px-2 py-1.5`): a `TRI` micro-label, a full-width `PopoverSelect` (`hideEmpty`, options = the `COLUMNS` labels, `id = index + 1`) that changes `sort.key` keeping the current direction, and a ghost `h-9 w-9` icon button toggling `asc`/`desc` (ArrowUp/ArrowDown, French titles "Tri croissant"/"Tri décroissant").

### 40.4 Drawers on phones

- Width: **`w-full max-w-[440px]`** (never bare `w-[440px]`). `position: fixed` makes `w-full` = viewport width, capped at 440 on anything wider — desktop pixels identical, phones get full width. `translate-x-full` off-screen transform still works.
- `top-14` is safe at all widths (header is `h-14` everywhere; `embed` mode still swaps to `top-0`).
- **Mobile X close is mandatory**: at full width there is no "outside" left to tap, so without it the drawer is un-dismissable. Ghost `h-8 w-8 md:hidden` icon button with `title="Fermer"`, last sibling in the drawer header row, calling the guarded `onClose` (never a raw `setSelectedId(null)` — it must route through the §28 unsaved-changes guard).

### 40.5 Toolbars on phones

- Toolbar container gains `flex-wrap` (no-op while nothing wraps).
- **The primary/create action ("Nouveau") stays in the top-right corner at every width** — user-confirmed rule. On phones it shares row 1 with the search; the filter checkbox wraps to row 2. Implement with order utilities so desktop DOM order (search, checkbox, button) and pixels are untouched:
  - search wrapper: `order-1 flex-1 min-w-0`
  - checkbox label: `order-3 sm:order-2 w-full sm:w-auto`
  - Nouveau button: `order-2 sm:order-3 flex-shrink-0`
- Long search placeholders just clip natively — do NOT shorten the string (that would change desktop pixels).
- **Order utilities alone are NOT enough when the toolbar holds more than a checkbox.** `flex-wrap` only wraps on overflow, so a `w-40` `PopoverSelect` + checkbox can still FIT on row 1 at Z Fold widths (~500–639px) and push the action buttons off the top-right corner (user-flagged on TombeMetierStock). Deterministic fix: wrap the extra filter controls in `<div className="order-4 w-full flex items-center gap-3 sm:contents">` — below `sm` it is a forced full-width row of its own; at `sm`+ `display: contents` dissolves the wrapper so the children rejoin the toolbar flex with their own `sm:order-*` classes and desktop pixels stay identical. Reference: `TombeMetierStock.tsx` toolbar.
- **Toolbar text buttons collapse to icon-only below `sm`** (user-confirmed): label wrapped in `<span className="hidden sm:inline">`, icon margin becomes `sm:mr-*`, and the button gets a `title` attribute (it becomes the accessible name once the text is hidden — tests select on it). Applies to Nouveau (+), Modifier (pencil), Terminer (X); icon-only buttons (Couper, batch, surteindre) are already fine.
- **The "Mode édition" badge gets a `w-full sm:w-auto` wrapper div** so on phones it takes its own row instead of crushing the search input (a bare `order-*` badge stays on row 1 because the `flex-1 min-w-0` search absorbs the squeeze).

### 40.5bis Totalizer bars on phones

Below `sm`, the "Poids total / Métrage total" style labels are `hidden sm:inline` (the kg/Ml units are self-explanatory) and the values drop one size (`text-sm sm:text-base`), so the whole bar stays on ONE line even at 345px (user-confirmed preference over stacking). The edit-mode selection summary becomes its own row (`w-full sm:w-auto` on the span, plus `w-full sm:w-auto` on the left group only when a selection exists). Divider `border-l` stays as the separator between values; `pl-3 sm:pl-5`, `gap-3 sm:gap-5`. Reference: `FinisStock.tsx` totalizer.

### 40.6 Dialogs on phones

- The `dialog.tsx` primitive's centering wrapper carries `p-4` so no dialog is ever edge-to-edge. (Desktop no-op: every dialog is narrower than viewport − 32px.)
- Form grids: `grid grid-cols-1 sm:grid-cols-2` — never a bare `grid-cols-2`.
- Full-width items inside those grids: **`col-span-full`, never `col-span-2`** (identical at 2 columns; `col-span-2` overflows a 1-column grid).
- Tall dialogs: `DialogContent` gets `max-h-[90dvh] overflow-y-auto` so the form scrolls inside a 720px-tall phone viewport (use `dvh`, not `vh` — mobile browser chrome).

### 40.7 Screenshot-regression harness (the safety net)

Lives in `apps/web/e2e/` (Playwright, chromium only, own vite server on **port 3200** — clear of worktree slots 3000–3006). Full policy in `apps/web/e2e/README.md`. Key rules:

- **Entire `/api/` layer is fixture-mocked** (`support/mock-api.ts`): vite runs with `VITE_API_URL=/api` so one `page.route('**/api/**')` intercepts everything; unmocked endpoints fulfill 500 and fail the test via the `afterEach` `unmatched` assertion. `page.clock.setFixedTime` freezes `Date.now()` (row ages, default dates).
- **Workflow for any risky UI change**: capture baselines from the UNTOUCHED screen in their own commit, then every edit must keep `test:e2e` green (`maxDiffPixels: 0` temporarily to prove pixel identity).
- Projects: `desktop-1920`, `desktop-1366`, `tablet-768` run the standard spec (table layout); `fold-open-717`, `phone-390`, `fold-cover-345` run only `*-responsive.spec.ts` (card layout) via `testMatch`.
- Baselines are machine-specific (system-ui fonts) — regenerate locally, never trust cross-machine diffs. Not wired into turbo `test`; run explicitly: `pnpm --filter @mps/web test:e2e`.
- **Adding a screen to the rollout**: capture its API responses into `e2e/fixtures/`, add routes in `mock-api.ts`, write a `<screen>.spec.ts` (default + drawer/dialog + edit states), bless desktop baselines BEFORE touching the screen, then do the §40.2–§40.6 edits, then add its `*-responsive.spec.ts` snapshots.

---

## 41. Left-list card liseré + search-bar counter pill (attention-state standard)

References: **`SousTraitantsCommandes.tsx`** (red + amber relance pills — the original implementation) and **`ClientsCommandes.tsx`** (amber "non affectée" pill).

The standard color-coding model for master-detail **left-list cards**:

1. **Cards are NEUTRAL by default.** White `bg-white`, `border-border`, hover `hover:border-zinc-400/60`, selected `border-zinc-400 ring-1 ring-zinc-400`. No color unless the card is in a registered attention state. Resist the urge to color-code every status onto the card frame — the status pill on the card already does that job (§29.8); the frame color is reserved for "this needs my attention now".

2. **An attention state = a colored liseré** (4px inset left strip) plus matching hover/selection tint:
   - Liseré: `shadow-[inset_4px_0_0_0_<rgb>]` — inset shadow, NOT `border-l-4` (§30.3 explains why: it composes with the selection ring instead of fighting the border shorthand).
   - Hover: `border-border hover:border-<color>-500/50`. Selected: `border-<color>-500 ring-1 ring-<color>-500` — the attention color takes over the selection ring so it dominates.
   - Raw Tailwind palette values, not semantic tokens (theme-stable): red `rgb(239 68 68)` (red-500), amber `rgb(245 158 11)` (amber-500).

3. **Each colored state gets a counter pill flush right of the search input.** Number-only toggle button, one per state, sitting in a `flex items-center gap-2` row with the search input (`relative flex-1 min-w-0` wrapper):
   ```tsx
   {count > 0 && (
     <button type="button" onClick={onToggle} aria-pressed={on} title="<state label>"
       className={cn(
         'h-7 min-w-[1.75rem] px-1.5 inline-flex items-center justify-center rounded-md text-xs font-semibold tabular-nums border transition-colors flex-shrink-0',
         on ? 'bg-amber-500 text-white border-amber-500 shadow-sm'
            : 'bg-amber-500/10 text-amber-800 border-amber-500/30 hover:bg-amber-500/20',
       )}>
       {count}
     </button>
   )}
   ```
   Rules: **hidden when the count is 0** (never a grey disabled pill); **active = solid fill** with white text, inactive = tinted (`/10` bg, dark text, `/30` border); toggling **narrows the list to only that state's cards**; multiple pills (SST red + amber) are independent toggles. Pill color = liseré color, always. Add a `title` naming the state.

4. **Guard the empty-filter trap.** The pill hides at count 0, so an armed filter must not survive an emptying bucket: either derive an effective flag (`const active = on && count > 0`, ClientsCommandes) or make the toggle handler reset conflicting filters (SST bumps `terminee` → `open` when a pill is clicked, since its pills count open orders polled globally).

5. **The meaning of each color is per-screen business logic and MUST be registered here** when a screen adopts the pattern:

| Screen | Color | Meaning |
|---|---|---|
| Sous-traitants → Commandes | red | `attente_delai` relance due/overdue (`date_notif`), or delivery deadline passed/missing (§30) |
| Sous-traitants → Commandes | amber | relance tomorrow, or delivery within 3 days (§30) |
| Clients → Commandes | amber | **commande non affectée** — open order with no roll reserved yet (`phase === 'a_affecter'`) |

Note the two families of meaning: SST colors are **deadline-derived** (§30 `deliveryUrgency`), Clients colors are **workflow-state-derived** (phase). Both render through the same visual system. When adding a new state: pick the color by severity (red = overdue/blocking, amber = needs action), add the liseré + pill wiring, and add a row to this table. Clients → Commandes deliberately does NOT color cards by delivery urgency anymore — neutral-by-default won over "every card is red or amber" noise.

---

## 42. Header doc-menu button (`DocMenuButton`) — contextual print/email menu

References: **`apps/web/src/pages/ClientsCommandes.tsx`** → `DocMenuButton` (print + email, confirmation vs proforma), **`apps/web/src/pages/ClientsExpeditions.tsx`** → `PrintMenuButton` (the original), **`apps/web/src/pages/FinisReferences.tsx`** → `DocMenuButton` (print, fiche technique vs fiche tarifs).

When a detail screen's Print (or Email) header action can produce **more than one document**, the §6.1 icon button does not act directly — clicking it opens a **small contextual popover menu** anchored under the button, one row per document. The user picks the document; the row's action fires and the menu closes. A screen with a single document keeps the plain direct-action button — no menu, no chooser dialog.

**Do NOT use a chooser Dialog for this.** A modal that only asks "which document?" is heavier than the decision it carries; the anchored menu keeps the choice in context and costs one click less.

### 42.1 Markup — copy this shape

```tsx
/** Icon button opening a small popover menu — the print/email header buttons
 *  use it to pick which document to act on. */
function DocMenuButton({ icon: TriggerIcon, title, items, onSelect }: {
  icon: ComponentType<{ className?: string }>
  title: string
  items: Array<{ key: DocKind; label: string; icon: ComponentType<{ className?: string }> }>
  onSelect: (key: DocKind) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Click outside to close the menu.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  return (
    <div ref={rootRef} className="relative">
      <Button variant="outline" size="icon" className="h-9 w-9" title={title} onClick={() => setMenuOpen((v) => !v)}>
        <TriggerIcon className="h-4 w-4" />
      </Button>
      {menuOpen && (
        <div className="absolute top-full right-0 mt-1 w-64 rounded-lg border bg-white shadow-lg overflow-hidden z-50">
          {items.map((item) => {
            const ItemIcon = item.icon
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => { onSelect(item.key); setMenuOpen(false) }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-zinc-100"
              >
                <ItemIcon className="h-4 w-4 text-muted-foreground" />
                {item.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

Usage in the §6.1 view-mode button row:

```tsx
<DocMenuButton
  icon={Printer}
  title="Imprimer"
  items={[
    { key: 'technique', label: 'Fiche technique', icon: FileText },
    { key: 'tarifs', label: 'Fiche tarifs', icon: BadgeEuro },
  ]}
  onSelect={onPrintDoc}
/>
```

### 42.2 Conventions — do not deviate

- **Trigger**: the standard §6.1 header icon button (`variant="outline" size="icon" className="h-9 w-9"`, `Printer` / `AtSign` icon, French `title`). The menu does not change the trigger's look.
- **Popover**: `absolute top-full right-0 mt-1 w-64 rounded-lg border bg-white shadow-lg overflow-hidden z-50` — right-aligned under the button (the button sits at the screen's right edge). No portal needed: the detail header is not inside an `overflow: hidden` ancestor (unlike KV rows, §11bis).
- **Rows**: `w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-zinc-100`, leading Lucide icon at `h-4 w-4 text-muted-foreground`, French document label. `onSelect(key)` then `setMenuOpen(false)`.
- **Item icons** name the document, e.g. `FileCheck2` confirmation, `ReceiptText` proforma/facture, `FileText` fiche technique, `BadgeEuro` fiche tarifs.
- **Conditional items**: build the `items` array conditionally when a document doesn't apply (e.g. donation orders get no proforma row in `ClientsCommandes`). One remaining item still shows the menu — the consistency is worth the extra click, and the missing row explains itself.
- **Print and Email share the same `items` array** when both actions exist on the screen — one definition, two `DocMenuButton` mounts.
- **Follow-up options go in a Dialog after selection**, not in the menu. When a document needs a pre-generation question (e.g. the fiche tarifs' "Inclure les tranches 15 et 30 rouleaux" toggle in `FinisReferences`), the menu row opens a small §18.A Dialog with the option control (§35 pill for booleans) and an Annuler / Générer footer. The menu itself stays a flat list of documents — never nest inputs inside it.
- **Outside-click close** via the `mousedown` listener + `rootRef.contains` guard, same as the §29.4 status-footer menu. No scroll-close needed (the header doesn't scroll).

### 42.3 When to use vs the direct button

| Situation | Pattern |
|---|---|
| One document (bon de commande, fiche seule) | Plain §6.1 icon button, direct `window.open` / dialog |
| 2+ documents from the same trigger | **§42 `DocMenuButton`** |
| Document needs pre-generation options | §42 menu row → small §18.A options Dialog → generate |
| Action is a user-controlled state change | §29 status footer, not a header menu |

---

## 43. Dashboard widget header (`WidgetFrame`) — navy band, gold tile, white title

Reference: **`apps/web/src/components/dashboard/WidgetFrame.tsx`**. Every tableau de bord widget renders through it, so the whole dashboard shares one header treatment.

```tsx
<div className="flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5 flex-shrink-0">
  <div className={cn(
    'h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm transition-colors',
    isEditing ? 'bg-white text-primary' : 'bg-gold text-gold-foreground',
  )}>
    <Icon className="h-[18px] w-[18px]" />
  </div>
  <h2 className="min-w-0 flex-1 text-base font-heading font-bold tracking-tight truncate text-primary-foreground">
    {title}
  </h2>
  {isEditing ? /* hand affordance + hide button */ : actions}
</div>
```

Conventions — do not deviate:

- **Navy band (`bg-primary`), white title, solid gold icon tile.** This is the sidebar's pairing (navy surface + white text + gold accent) restated on a card, which is what makes a dashboard of several widgets read as part of the app rather than as a stack of foreign panels.
- **Gold hairline underneath** (`border-b-2 border-gold`) — the same accent-rule idea as the gold line under every detail header (§6).
- **Single line, no subtitle.** The band is `py-2.5` and the title is `text-base`; a widget's explanation belongs in its body, not in chrome that repeats on every card.
- **Edit mode flips the icon tile to `bg-white text-primary`** — §9's "header icon box changes" signal, restated for a dark band (a `bg-accent/15` tint is invisible on navy). Header controls on the band go white-on-navy (`text-white/70 hover:bg-white/15`), never `text-muted-foreground`.

**Two treatments that were tried and rejected — do not reintroduce:**

| Tried | Why it failed |
|---|---|
| Gold band (`bg-gold/25`) + `icon-box-gold` | Gold-on-gold: the icon tile disappeared into the band, and a row of gold bands competed with the gold app header directly above them. |
| Zinc band (`bg-zinc-200/50`) + `icon-box-gold` (the §27.5 drawer header) | Technically the app's panel-header pattern, but on a dashboard of large white cards it read as grey and lifeless — user-rejected in favour of the navy treatment. |

The §27.5 zinc drawer header remains correct **for drawers and sidebars**, where the band caps a zinc panel. This section is the rule for dashboard widget cards specifically.

---

## 44. Shift+click range selection — mandatory on every multi-select list

References: **`SousTraitantsCommandes.tsx`** → `handleEcruClick` / `handleFiniClick` (the original), **`FinisStock.tsx`** → `handleSelectRoll` (the add-or-remove refinement, canonical), **`ClientsCommandes.tsx`** → `toggleLink` / `toggleShip` in `AffectationDrawer`, **`ClientsGestion.tsx`** → `handleRowClick` in the expedition lines table.

**Any list where the user ticks several rows to drive a batch action MUST support Shift+click ("MAJ + clic") range selection.** This is not a nice-to-have per screen — users work through rolls, lots and lines in runs of ten or twenty, and a list that only accepts one click per row is a data-entry chore next to the sibling screen that accepts a range. Ticking twenty checkboxes one at a time is the bug this rule prevents.

It applies to **every** multi-select surface, whatever its markup: roll cards in a drawer (`ClientsCommandes` Affectation — Stock disponible **and** Affecté), table rows in edit mode (`FinisStock`), pieces lists in the sst drawer, expedition-line tables (`ClientsGestion`), and any future batch-pick list. If you add a checkbox column or a selection `Set<number>`, you add this handler in the same edit.

### 44.1 The handler — copy this shape

Anchor-based, over the **rendered order** of the list. The anchor is a `useRef`, not state: it must not trigger a re-render, and it must survive across Shift+clicks so the user can widen and narrow a range from a fixed origin (the OS file-manager behaviour they already expect).

```tsx
const [selected, setSelected] = useState<Set<number>>(new Set())
const lastSelectedIdRef = useRef<number | null>(null)

// Plain click toggles the row and becomes the anchor; Shift+click applies the
// inclusive range between the anchor and the clicked row, in the current
// sort/filter order. The range operation is add-or-remove depending on the
// clicked row's current state: Shift+clicking an already-selected row
// deselects the whole range (so re-clicking the end of a range clears it).
const handleSelect = useCallback((id: number, shiftKey: boolean) => {
  const ids = rows.map((r) => r.id)          // the SAME array the list renders
  const anchor = lastSelectedIdRef.current
  if (shiftKey && anchor !== null && anchor !== id) {
    const a = ids.indexOf(anchor)
    const b = ids.indexOf(id)
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a]
      setSelected((prev) => {
        const next = new Set(prev)
        const deselect = prev.has(id)        // clicked end already selected → clear the range
        for (let i = lo; i <= hi; i++) {
          if (deselect) next.delete(ids[i]); else next.add(ids[i])
        }
        return next
      })
      return                                  // anchor is intentionally NOT moved
    }
  }
  // Plain click — toggle this row and become the new anchor.
  setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  lastSelectedIdRef.current = id
}, [rows])
```

Row side — forward the modifier from the event, never read it from a global:

```tsx
onClick={(e) => onSelect(row.id, e.shiftKey)}
// and on an inner checkbox, which must not double-fire the card handler:
onClick={(e) => { e.stopPropagation(); onSelect(row.id, e.shiftKey) }}
```

### 44.2 Rules — do not deviate

- **`select-none` on the clickable row is mandatory.** Without it Shift+click paints a browser text selection across the rows instead of extending the selection — it looks broken even though the state is correct. Table rows: `group-data-[editing=true]:select-none` when selection is edit-mode-only (`FinisStock`); cards: `select-none` alongside `cursor-pointer`.
- **The id array MUST be the rendered order** — the filtered/sorted array the list maps over, not the raw query result. A range computed over a different order selects rows the user never dragged across. When only a subset of rows is selectable (e.g. only "En reprise" rolls), build the array from **that subset** (`finiReprisableIds` in `SousTraitantsCommandes`) so the range never silently skips or includes unselectable rows.
- **The anchor does not move on a Shift+click.** Only a plain click re-anchors. This is what lets the user widen, then narrow, a range from one origin.
- **Shift+clicking an already-selected end clears the range** (the `deselect` branch). This is the canonical variant — `FinisStock` and `ClientsCommandes` implement it; the older `SousTraitantsCommandes` handlers are add-only and predate the refinement. Write new code with the `deselect` branch.
- **Reset the anchor whenever the selection is reset from outside**: on the batch mutation's `onSuccess`, and on an "Aucun" / clear-selection control. A "Tout" control sets the anchor to the **last** row, so a following Shift+click narrows from the end.
- **Mutually exclusive selections clear each other's anchor too.** `ClientsCommandes` keeps two selections in one drawer (Affecté → Expédier, Stock disponible → Affecter); ticking in one clears the other's `Set` **and** its ref, or a later Shift+click would extend from a stale origin in a list the user has since left.
- **No UI hint is rendered for this.** MAJ+clic is a learned OS convention, and a permanent "astuce" line on every selectable list is chrome the screen doesn't need. If the range is discoverable nowhere else, that's what the `title` on the checkbox is for — do not add a banner.
- **Ctrl/Cmd+click is NOT implemented** — plain click already toggles without clearing the rest of the selection, so Ctrl would be a no-op alias. Don't add it.

### 44.3 Checklist when adding a multi-select list

- [ ] `Set<number>` selection state + `lastSelectedIdRef` anchor ref
- [ ] Handler takes `(id, shiftKey)` and follows §44.1 verbatim, `useCallback` keyed on the rendered array
- [ ] Row `onClick` forwards `e.shiftKey`; inner checkbox does `e.stopPropagation()` **and** forwards `e.shiftKey`
- [ ] `select-none` on the clickable row/card
- [ ] Anchor reset on mutation success, on "Aucun", and on any sibling selection taking over
- [ ] Range array = the filtered/sorted/selectable-subset order actually rendered
