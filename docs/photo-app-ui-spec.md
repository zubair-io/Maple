# Maple — UI / UX Specification

**Platforms:** macOS, iPadOS, iOS
**Layout model:** Three-column adaptive shell (Mac / iPad), single-column with bottom tabs (iPhone)
**Design system:** Just Maple dark theme — warm charcoal surfaces, maple-red accent

This document is the source of truth for how Maple looks and behaves. It describes the two primary modes (Browse and Full image), the four detail-panel tabs (Info, Color, Meta, Scopes), the app toolbar, platform adaptations, keyboard and gesture interactions, and the Just Maple visual language. Read alongside `photo-app-feature-spec.md` (what the product does) and `photo_app_mockup_v2.html` (the interactive layout reference).

---

## Overview

Maple is a non-destructive photo editor. Users browse a library (Apple Photos or the filesystem), cull and rate, and make RAW and color adjustments that always write to an `.xmp` sidecar — never to the original file. The UI is organized around this workflow:

- **The library is always visible.** Navigation, selection, and metadata never collapse behind a modal. All three panels persist; only their content changes.
- **Two modes, one layout.** Browse mode shows a thumbnail grid in the center. Full-image mode swaps the tree for a filmstrip and the grid for a single large image. Panel widths are preserved across the transition; the center crossfades in 180ms.
- **Editing is immediate.** Sliders in the Color tab write to the sidecar on change. There is no "Save" button and no dirty state to reconcile.
- **The chrome recedes.** Thumbnails and the full-image view dominate visual weight. Surfaces are warm charcoal, not pure black; the maple-red accent is reserved for selection, focus, and the XMP badge.

---

## Screens at a glance

**Browse mode** — the default. Users arrive here, select a source in the left tree, scan the grid, cull with flags and stars, and double-click a thumbnail to open it full-screen.

```
┌──────────────┬─────────────────────────────┬──────────────┐
│ File tree    │   Thumbnail grid            │ Detail panel │
│ (220px)      │   (flex)                    │ (260px)      │
│              │                             │              │
│ Folders      │  ┌──┐ ┌──┐ ┌──┐ ┌──┐       │  Info tab    │
│ Photos Lib   │  └──┘ └──┘ └──┘ └──┘       │              │
│ Albums       │  ┌──┐ ┌──┐ ┌──┐ ┌──┐       │  File · Cam  │
│              │  └──┘ └──┘ └──┘ └──┘       │  Rating      │
│              │                             │              │
│              │                             │ ┌──┬──┬──┬─┐ │
│              │                             │ │I │C │M │S│ │
└──────────────┴─────────────────────────────┴──────────────┘
```

**Full-image mode** — triggered by double-click. The tree collapses to an 80px vertical filmstrip; the grid is replaced by a letterboxed large image. The detail panel keeps its position; its tabs now include live scopes.

```
┌──────────┬────────────────────────────┬──────────────┐
│ Filmstrip│                            │ Detail panel │
│ (80px)   │                            │              │
│          │     Full image view        │  Color tab   │
│ ┌────┐   │     (centered, letterbox)  │  (all        │
│ ├────┤◀  │                            │   sliders)   │
│ ├────┤   │                            │              │
│ └────┘   │                            │ ┌──┬──┬──┬─┐ │
│          │                            │ │I │C │M │S│ │
└──────────┴────────────────────────────┴──────────────┘
```

Three panels. Two modes. The panels are resizable in Browse mode and persist their widths across mode changes.

---

## Layout overview

```
┌─────────────┬──────────────────────────┬─────────────┐
│  Left panel │      Center              │ Detail panel│
│  File tree  │   Grid (browse) or       │             │
│  or         │   Full image (full mode) │  [tabs]     │
│  Filmstrip  │                          │             │
│             │                          │ ┌──┬──┬──┐ │
│             │                          │ │  │  │  │ │
└─────────────┴──────────────────────────┴─┴──┴──┴──┘
```

Three resizable panels separated by drag handles. All three persist across navigation — only their content changes.

---

## App toolbar

A single horizontal strip across the top of the window, 36px tall, sitting above the three-column body.

**Contents (left → right):**

- Search icon (placeholder in Phase 0; opens a library-wide search in Phase 1)
- Title — current context string. In Browse mode: `Library — <selected source>` (e.g. `Library — All Photos`, `Library — France trip`). In Full-image mode: the filename of the current image (e.g. `IMG_1042.CR3`).
- Export button (right-aligned). Enabled when one or more images are selected.

**Styling**

- Background: `--color-surface` (`#262524`)
- Bottom border: 0.5px `--color-border` (`#44403c`)
- Title: 12px / weight 500 / `--color-text-main`
- Buttons: 0.5px border, 6px radius, 11px text, `--color-input-bg` background

Secondary commands (sort, filter, thumbnail-size slider) live inside the grid toolbar in Browse mode and the zoom/flag controls in Full-image mode — not on the app toolbar. The app toolbar stays intentionally sparse.

---

## Browse mode (default)

### Left panel — file system tree

Width: 220px default, resizable 160px–320px. Background: `--color-sidebar` (`#292524`).

The tree is organized into collapsible sections, each with a chevron that rotates on toggle and an optional `+` action on hover.

**Folders section** (filesystem)

- Empty state: muted body text ("No local folders") with an accent-colored "Add one" link — no icon, no card, no border.
- Populated: folder tree with expand/collapse chevrons. Each row shows a folder icon, the folder name, and an optional image-count badge.
- Folders can be nested; children indent 14px per level under their parent.
- Right-click context menu: Reveal in Finder/Files, New folder, Rename, Remove from library.
- Drag folders to reorder or nest.

**Photos Library section** (PhotoKit)

- Fixed entries: All Photos, Favorites, Picks, Rejects
- Subheading "Albums" (muted, uppercase, 10px, 0.03em letter-spacing)
- User albums listed alphabetically under the subheading
- Smart albums appear alongside user albums and are indistinguishable in the UI

**Behavior**

- Single-click a source or folder to load its contents into the grid.
- Active item: `--color-primary-light` (`#422016`) background with `--color-primary` (`#c4493a`) text. No border.
- Hover: `--color-bg-hover` (`rgba(255,255,255,0.06)`).
- Sections scroll independently from the center grid and right panel.

---

### Center panel — image grid

Fills remaining width between left and right panels. Background: `--color-bg` (`#1c1917`).

**Grid**

- Thumbnail size: adjustable via slider in the grid toolbar (small / medium / large, default medium).
- Aspect-ratio-preserved thumbnails arranged in a justified grid with uniform row height.
- 3px gutter between thumbnails, 3px padding around the grid.
- Single-click: selects image, loads metadata into detail panel. Previously selected image deselects.
- Double-click: transitions to Full-image mode.
- ⌘-click / Shift-click: multi-select (⌘ toggles individual, Shift selects range).
- Selected image: 2px inset border in `--color-primary` accent on the thumbnail.
- XMP sidecar badge (small checkmark corner marker) appears on thumbnails that have edits.

**Grid toolbar** (above grid)

- Left: source breadcrumb (e.g. `Local files › 2026 › France trip`).
- Center: thumbnail-size slider.
- Right: sort menu (date, name, rating, flag), filter pill (Picks only · 4+ stars · Unedited).

**Empty state**

- Centered message "No photos" with a folder icon and an "Open a folder" CTA linking to the filesystem picker.

---

## Full-image mode

Triggered by double-clicking a thumbnail. Escape or double-click again returns to Browse mode. The transition is a 180ms ease-out layout shift: panels stay in place, the center content crossfades, the left panel animates from 220px to 80px.

```
┌──────────┬────────────────────────────┬─────────────┐
│          │                            │             │
│ Film-    │     Full image view        │ Detail panel│
│ strip    │     (fills center panel)   │  [tabs]     │
│          │                            │             │
│  ┌────┐  │                            │ ┌──┬──┬──┐ │
│  ├────┤  │                            │ │  │  │  │ │
│  ├────┤  │                            │ │  │  │  │ │
└──┴────┴──┴────────────────────────────┴─┴──┴──┴──┘
```

### Left panel — filmstrip

Collapses from tree to filmstrip: 80px wide, fixed (not resizable in this mode).

- Vertical strip of thumbnails from the current folder/album, 52px × 40px each with 3px vertical spacing.
- Active image: 1.5px `--color-primary` border.
- Click any thumbnail to switch to that image — no mode change, the main image crossfades.
- Scroll vertically to navigate past the visible strip.
- Arrow keys (↑/↓ on iPad, ←/→ on Mac) advance through images.

### Center panel — full image view

- Image centered and scaled to fit the panel (letterboxed; never crops).
- Scroll wheel / pinch: zoom.
- At 100% or higher: pan by dragging.
- Zoom level indicator in bottom-left corner (e.g. `Fit` · `100%` · `225%`).
- Before/after toggle in the toolbar: splits the view with a draggable divider showing the current edit on one side and the original render on the other.

### Toolbar (full-image mode)

Replaces the grid toolbar in Browse mode; sits just above the image.

- **Left:** Back button (← to Browse), filename.
- **Center:** Zoom controls (Fit · 100% · − / +), before/after toggle.
- **Right:** Flag controls (Pick / Unflagged / Reject), star rating (1–5), export button.

---

## Detail panel

Width: 260px default, resizable 200px–360px. Background: `--color-surface` (`#262524`). Always visible in both modes.

Content switches based on the active bottom tab. Tabs are icon + label, pinned to the bottom of the panel.

### Tab bar (bottom of detail panel)

```
┌────────┬────────┬────────┬────────┐
│  Info  │ Color  │  Meta  │ Scopes │
└────────┴────────┴────────┴────────┘
```

- Active tab: 2px top border in `--color-primary`, `--color-surface` background, `--color-primary` text.
- Inactive tabs: `--color-surface-alt` (`#2e2c2a`) background, `--color-text-muted` text, no border.
- Scopes tab is grayed and shows "Select an image to view scopes" in Browse mode; fully active in Full-image mode.

---

### Tab: Info

The default tab. Read-only metadata plus the rating controls.

**File section**

- Filename, file size, format (e.g. `Canon RAW · CR3`)
- Pixel dimensions (`6240 × 4160`)
- XMP badge: inline pill below the filename, success-green fill with a checkmark. Shows the `.xmp` filename when a sidecar exists, omitted when not.

**Camera section**

- Camera model · Lens
- Focal length · Aperture · Shutter · ISO
- Flash (on / off / not fired)

**Rating & flags section**

- Flag row: three pills — Pick (`P`, green) · Unflagged (`—`, neutral) · Reject (`✕`, red). Tap to set; tap active to clear.
- Star rating: 1–5 stars. Tap to set; tap the active star again to clear. Active stars: `#EF9F27`.
- Color label: row of colored dots (Red · Orange · Yellow · Green · Blue). Tap to toggle one.

---

### Tab: Color

All adjustments write to the `.xmp` sidecar immediately on change. Sliders show the numeric value on the right side of the row label; native slider tint is `--color-primary`.

**Tone**

- Exposure (−4 to +4 EV)
- Contrast (−100 to +100)
- Highlights · Shadows · Whites · Blacks (−100 to +100 each)

**White balance**

- Temperature (2000K–12000K)
- Tint (−100 to +100)
- WB preset picker: Auto · Daylight · Cloudy · Shade · Tungsten · Flash · Custom
- Eyedropper tool: tap a neutral area in the image to set WB

**Presence**

- Clarity · Texture · Dehaze (−100 to +100)
- Vibrance · Saturation (−100 to +100)

**Sharpening**

- Amount · Radius · Detail · Masking

**Noise reduction**

- Luminance · Color

**Revert / Copy / Paste row** (bottom of the color tab, above the tab bar)

- Revert: discard all edits, restore to original.
- Copy: copy all adjustments to clipboard.
- Paste: apply clipboard adjustments to current image.

---

### Tab: Meta

**Location**

- GPS coordinates (lat/lon)
- Reverse-geocoded city, region, country
- Map thumbnail (tap to open in Maps)

**Dates**

- Date captured · Date modified
- Date created (file creation)

**IPTC**

- Title · Caption · Copyright · Creator (editable inline)
- Keywords: tag pills with add/remove

**Sidecar**

- File: `<filename>.xmp`
- Edits: count of non-default adjustments (e.g. "5 adjustments")

**Edit history**

- List of named snapshots
- "Add snapshot" button
- Tap snapshot to restore; long-press to rename or delete

---

### Tab: Scopes

Visible only in Full-image mode. In Browse mode the tab is grayed and shows `Select an image to view scopes`.

**Scope selector**

- Segmented control: Histogram / Waveform / Parade / Vectorscope

**Histogram**

- RGB composite, or individual R / G / B channels (toggle)
- Clipping indicators: red overlay on blown highlights, blue on crushed blacks

**Waveform**

- Full-width luma waveform
- 0–100 IRE scale on y-axis

**Parade**

- R, G, B waveforms side by side
- Same IRE scale

**Vectorscope**

- Chroma/hue scatter plot in YCbCr space
- Broadcast-safe circle overlay
- Skin-tone line indicator

All scopes render against `#141210` (darker than the root bg) so R/G/B colors read clearly, and update live as sliders in the Color tab change.

---

## Mode transitions

Browse ↔ Full-image is a **180ms ease-out** layout shift. The invariant is that panels do not move horizontally — only their content and widths change.

- Left panel: animates width from 220px (tree) to 80px (filmstrip), and back. The tree fades out as the filmstrip fades in.
- Center panel: grid and full-image view crossfade at 180ms. No slide; no zoom.
- Right panel: stays at its current width. Tab content re-renders (Scopes becomes active in Full-image mode).
- App toolbar: title text updates immediately.

Entering Full-image is idempotent across input methods — double-click, double-tap, and Return all trigger the same transition.

---

## Platform adaptations

### macOS

- Full menu bar with all commands mirrored (File · Edit · Image · View · Window).
- Keyboard shortcuts for all common actions — see "Key interactions" below.
- Drag handles on all panel dividers.
- Right-click context menus on thumbnails and tree items.
- Toolbar customizable via View > Customize Toolbar.
- Full-screen mode: left panel collapses to icon rail, center expands.

### iPadOS

- Same three-column layout in landscape on 12.9" iPad Pro and M-series iPad.
- Portrait on smaller iPads: left panel hidden by default, slide-in drawer on tap.
- Toolbar condenses: secondary actions move to a `···` overflow menu.
- Apple Pencil: hover shows loupe in grid; tap to select, double-tap to enter Full-image mode.
- Apple Pencil in Full-image mode: draw masks in the Masking tool (Phase 4).
- Stage Manager: app respects arbitrary window size; panels collapse below threshold widths.

### iOS (iPhone)

- Single-column layout: bottom tab bar replaces the left panel.
- Tabs: Library · Albums · Folders.
- Grid fills full width.
- Tap thumbnail → full-screen image with swipe-up detail sheet.
- Detail sheet: scrollable, same four tabs as iPad but arranged vertically.

---

## Key interactions

| Action             | macOS                  | iPadOS                        |
| ------------------ | ---------------------- | ----------------------------- |
| Select image       | Click                  | Tap                           |
| Enter Full-image   | Double-click           | Double-tap                    |
| Return to Browse   | Escape or double-click | Escape or double-tap          |
| Next / prev image  | ← / →                  | ← / → or swipe filmstrip      |
| Set rating         | 1–5 keys               | Tap stars                     |
| Pick flag          | P key                  | Tap Pick pill                 |
| Reject flag        | X key                  | Tap Reject pill               |
| Zoom in / out      | ⌘+ / ⌘− or scroll      | Pinch                         |
| Fit to window      | ⌘0                     | Double-tap image              |
| 100% zoom          | ⌘1                     | Double-tap image (second tap) |
| Copy adjustments   | ⌘C (in Color tab)      | Copy button                   |
| Paste adjustments  | ⌘V (in Color tab)      | Paste button                  |
| Revert to original | ⌘⌥Z                    | Revert button                 |
| Export             | ⌘⇧E                    | Export button                 |

---

## Visual design — Just Maple dark theme

The app uses the Just Maple dark theme as its design system. Warm charcoal surfaces, never pure black. Maple red accent. All tokens are sourced directly from the Just Maple SCSS token set.

### Design principles

- **Never pure black.** Root background is warm charcoal `#1c1917`, not `#000000`.
- **Elevation through surface lightness.** Higher layers use progressively lighter warm surfaces. No drop shadows.
- **Accent used sparingly.** `--color-primary` (`#c4493a`) appears on selected nav items, the active tab indicator, focus rings, and the XMP badge border — not on large surfaces.
- **Images are the UI.** Chrome recedes; thumbnails and the full-image view dominate visual weight.
- **Scopes against deeper bg.** Scopes always render on `#141210` (deeper than root) so R/G/B waveform colors read clearly regardless of surrounding theme.
- **Motion is purposeful.** Browse ↔ Full-image is a 180ms ease-out layout shift; panels stay in place, center content crossfades. No decorative animation.

### Color tokens (dark)

```scss
--color-bg: #1c1917 /* root / page background */ --color-surface: #262524
  /* panels, right detail pane */ --color-surface-alt: #2e2c2a
  /* tab bar, grouped backgrounds */ --color-surface-hover: #3a3836
  /* hover state on surfaces */ --color-sidebar: #292524 /* left nav panel */
  --color-input-bg: #1c1917 /* text inputs, range tracks */
  --color-text-main: #e7e5e4 /* primary text */ --color-text-muted: #a8a29e
  /* secondary labels, timestamps */ --color-border: #44403c
  /* dividers, panel borders, outlines */ --color-primary: #c4493a
  /* accent — maple red (brightened for dark) */ --color-primary-light: #422016
  /* accent tinted bg — selected nav item fill */
  --color-bg-hover: rgba(255, 255, 255, 0.06) /* hover on nav items */
  --color-bg-active: rgba(255, 255, 255, 0.1) /* pressed / active states */
  --color-bg-secondary: #292524 /* sidebar, secondary surfaces */;
```

### Semantic colors (dark)

```scss
--color-success-bg: rgba(34, 197, 94, 0.15) /* XMP badge, pick flag bg */
  --color-success-text: #4ade80 /* XMP badge text, pick flag */
  --color-error-bg: rgba(239, 68, 68, 0.15) /* reject flag bg */
  --color-error-text: #f87171 /* reject flag text */ --color-star: #ef9f27
  /* active star rating */;
```

### Surface hierarchy (dark, light → dark)

| Layer                    | Token                   | Hex       |
| ------------------------ | ----------------------- | --------- |
| Image canvas             | —                       | `#141210` |
| Root / page              | `--color-bg`            | `#1c1917` |
| Sidebar                  | `--color-sidebar`       | `#292524` |
| Panels (detail, toolbar) | `--color-surface`       | `#262524` |
| Grouped backgrounds      | `--color-surface-alt`   | `#2e2c2a` |
| Hover                    | `--color-surface-hover` | `#3a3836` |

### Typography

- Font: `-apple-system, BlinkMacSystemFont` (maps to SF Pro on Apple platforms).
- Primary text: `--color-text-main` / `#e7e5e4` / 12–13px / weight 400–500.
- Secondary labels: `--color-text-muted` / `#a8a29e` / 10–11px.
- Section headers: muted + uppercase + `letter-spacing: 0.05em`.
- Nav selected: accent `#c4493a` on accent-dim `#422016` fill.

### Component patterns

**Nav section headers** — flex row: chevron (rotates on collapse) + label + optional `+` icon right-aligned. Hover: `--color-bg-hover`. No border.

**Nav items** — 22px padding-left indent under section header. Selected: `background: #422016; color: #c4493a`. Hover: `rgba(255,255,255,0.06)`.

**Empty state (Folders)** — muted body copy + accent-colored "Add one" link. No icon, no border, no card.

**Detail panel tabs** — pinned to bottom of right panel. Active: 2px top border in accent, `--color-surface` bg. Inactive: `--color-surface-alt` bg, muted text.

**Range sliders** — `accent-color: #c4493a` (native browser/SwiftUI tint). Label row: name left, current value right in primary text weight.

**XMP badge** — `success-bg` fill + `success-text` color + checkmark icon. Inline below filename in Info tab; corner marker variant on grid thumbnails that have edits.

**Flag pills** — 22px circular pills. Pick: success-bg / success-text. Reject: error-bg / error-text. Unflagged: surface bg / muted text. Border: 0.5px `--color-border`.

**Stars** — 15px glyphs, inactive `--color-border`, active `#EF9F27`. No fill background.

---

## See also

- `photo-app-feature-spec.md` — feature scope, sidecar schema, phase plan
- `photo_app_mockup_v2.html` — interactive layout reference (open in a browser)
- `architecture.md` — Swift / SPM module layout
- `../CLAUDE.md` — repo-level conventions and build phases
