# 07 — UI Architecture

The state model, undo/redo semantics, interaction loops. This document is about the shape of the editing experience — what the user sees, what happens when they drag a slider, how one image transitions to the next — not the visual design. For visual design tokens see `src/web/projects/maple-common/src/lib/tokens.scss` (CSS custom properties — `--mpl-*`) and the companion `tokens.ts` (typed mirrors).

The data types that flow through the UI are in [`01-data-model.md`](./01-data-model.md); what happens to pixels when the UI asks for a render is in [`02-pipeline.md`](./02-pipeline.md).

---

## Shells, in one sentence each

- **macOS**: three resizable columns (source tree / image grid / detail inspector), NavigationSplitView-driven, native toolbar and menu bar.
- **iPadOS**: same three columns; left panel slides in as a drawer in portrait.
- **iPhone**: single column with a bottom tab bar (Library / Search / Settings) and a swipe-up detail sheet. Each tab owns a `NavigationStack`; Loupe / Editor are push destinations that hide the tab bar via `.toolbar(.hidden, for: .tabBar)`. The source-picker drawer is Library-tab-scoped (overlays the Library tab content only — not the tab bar). See **Phone navigation** below.
- **Web (responsive)**: each Angular app (`projects/maple`, `projects/maple-syrup`) renders a single responsive shell driven by `LayoutService.layout()` (maple-common). Phone tier (<768pt) → tab-bar shell; tablet (768–1024pt) and desktop (>1024pt) → three-column pane shell.

All shells implement two modes: **Browse** (grid) and **Full Image** (large preview with filmstrip). The transition is a 180ms ease-out layout shift where the panels stay in place and only the center column crossfades.

---

## Phone navigation

The iPhone tab-bar shell ships in responsive-program S1a (#597). Surface:

- **Three tabs.** `Library` (`photo.on.rectangle.angled`), `Search` (`magnifyingglass`), `Settings` (`gearshape`). Selected tab persists across cold restart via `@AppStorage("cm.tab.shell")` on Apple. The web mirror uses route-driven selection (`routerLinkActive`) — the URL is the source of truth.
- **Per-tab NavigationStack.** Each tab owns its own stack so push depth is preserved when switching tabs and returning. The Library tab's stack hosts the source-picker drawer (S1b) over the responsive library grid (S2); the Loupe (S4) and Editor (S5) screens are push destinations on the Library stack.
- **Tab-bar hide on push.** Loupe and Editor pushes call `.toolbar(.hidden, for: .tabBar)` (Apple) so the chrome retracts when content goes full-screen. The web equivalent is `TabBarVisibilityService.hidden.set(true)` from a route component's `ngOnInit`; the bottom-nav reads the signal and slides off. PhoneLibraryStub demonstrates the wiring with a placeholder destination today.
- **Source-picker drawer (S1b) is Library-tab-scoped.** Hamburger → drawer overlays the Library tab content only. The tab bar stays visible above the drawer scrim; switching to another tab dismisses the drawer.
- **Settings is a tab, not a modal.** The pre-S1a iPhone shell presented `SettingsView` as a `.sheet` from the toolbar gear button; S1a embedded the same `SettingsView` (a `TabView`) directly in the Settings tab's `NavigationStack`, which produced a nested footer tab bar. S8 (#1903) replaced it with `PhoneSettingsView`, an iOS Settings-style grouped `List` (General / Backup / Cloud / Pano / Observability / Files / About) that pushes each sub-screen onto the Settings tab's `NavigationStack`.

Shell dispatch on Apple goes through `MapleShellKind.current == .phoneTab`. On web, `RootShellComponent` reads `LayoutService.layout()` and renders either `<app-phone-tab-shell>` (phone tier) or the existing `<router-outlet />` (tablet / desktop).

---

## Mode state machine

```
┌────────────────────────────────────────────────┐
│                   Browse                        │
│  ┌──────────┐  ┌────────────────┐  ┌─────────┐ │
│  │ Sources  │  │   Image Grid   │  │ Detail  │ │
│  └──────────┘  └────────────────┘  └─────────┘ │
└────────────────────┬───────────────────────────┘
                     │ double-click image
                     │ ↕ 180ms crossfade
┌────────────────────▼───────────────────────────┐
│                 Full Image                      │
│  ┌──────────┐  ┌────────────────┐  ┌─────────┐ │
│  │Filmstrip │  │   Full Image   │  │ Detail  │ │
│  │ (80px)   │  │                │  │         │ │
│  └──────────┘  └────────────────┘  └─────────┘ │
└────────────────────┬───────────────────────────┘
                     │ Esc or close button
                     └─────> Browse
```

### Invariants

- **Panels persist.** The three physical panels are allocated once; only their contents swap. Resizing the left panel in Browse also resizes the filmstrip in Full Image, by intent.
- **Selected image is preserved.** Switching Browse → Full Image opens the currently-selected grid cell. Switching back restores selection.
- **Zoom state is per-image.** When the user navigates filmstrip → next image, zoom resets to "fit" unless a pinned-zoom option is set. (Pinned zoom is a Phase 3 preference; v1 resets.)

---

## Three-column layout contract

The layout invariants from `docs/maple-prd.md` (visual design appendix) that this doc enforces:

1. **Left panel** is vertically scrollable. Never more than one scroll region.
2. **Center panel** fills. No horizontal scroll in Browse (grid reflows); no scroll at all in Full Image (the image fills).
3. **Right panel** (Detail) has four bottom-pinned tabs: **Info**, **Color**, **Meta**, **Scopes**. Scopes is grayed in Browse mode (no image selected in single-image sense).
4. **No modals.** Dialogs only for destructive or destination-picker operations (Export, Delete, Disconnect Source). Settings is a right-hand push panel, not a modal.

### Resize rules

- **Minimum widths**: left 200px, right 280px. Center has an absolute minimum of 300px; if dragging would push it below, the panel being dragged snaps back.
- **User drag persists across sessions.** Widths are saved per device.
- **Breakpoints** (responsive-program S0a, #581 — supersedes the previous 700/900 values): `<768pt` = phone-tier (tab-bar shell on Apple; tab-bar layout on web). `768–1024pt` = tablet (pane shell, sidebar + main + collapsible inspector). `>1024pt` = desktop (all three columns expanded). Layout signal: `@Environment(\.mapleLayout)` (Apple) / `LayoutService.layout()` signal (web). Shell selection on Apple goes through `MapleShellKind.current` (iPhone idiom → `.phoneTab`; iPad/Mac → `.pane`); direct `UIDevice.userInterfaceIdiom` reads outside `MapleCore/Layout/MapleLayout.swift` are forbidden.

---

## State ownership

Maple uses the platform-idiomatic observation model on each platform:

- **Apple**: `@Observable` from the Observation framework. No Combine in the edit loop.
- **Web**: Angular signals. No RxJS in the edit loop.

In both cases the pattern is identical: coarse-grained observable objects, not stream composition.

### Top-level stores

| Store                     | Lifetime       | Purpose                                                    |
| ------------------------- | -------------- | ---------------------------------------------------------- |
| `AppShellStore`           | app-scoped     | Window layout, selected source, current mode               |
| `UnifiedLibraryViewModel` | app-scoped     | Current folder's assets, sort/filter/selection             |
| `EditSession`             | per-image      | See [`01-data-model.md`](./01-data-model.md)               |
| `ThumbnailLoader`         | app-scoped     | Thumbnail memory + disk cache orchestration                |
| `SourcesStore`            | app-scoped     | List of connected sources: FS folders, PhotoKit, SMB hosts |
| `FavoritesStore`          | app-scoped     | Favorited folders                                          |
| `ExportStore`             | per-export-run | One-shot — config, progress, results                       |

### Why not one big Redux-shaped store

Every photo app that tries to push edit state into a central store ends up re-rendering the entire three-column shell on every slider tick. Maple keeps `EditSession` observable at the granularity of its fields, so:

- Detail panel (sliders) observes `editSession.model`.
- Image view observes `editSession.renderedPreview` and `editSession.zoom`.
- Grid cells observe `asset.cullingState` only.

When a slider moves, only the detail panel re-renders its own slider and the image view re-renders the pixels. The grid, the source tree, the toolbar are untouched.

---

## Persistence keys (`cm.*`)

Per-device UI state persists under the `cm.*` namespace (UserDefaults on Apple, `localStorage` on web). Existing keys stay; new keys added by the responsive program are documented here. Implementations land in each sub-project (S2–S6) that owns the key.

| Key               | Type                                        | Owner          | Status  |
| ----------------- | ------------------------------------------- | -------------- | ------- |
| `cm.tab`          | string                                      | existing       | reuse   |
| `cm.sort`         | string                                      | existing       | reuse   |
| `cm.filter`       | string (chip id)                            | S2 (Library)   | reuse   |
| `cm.leftHidden`   | bool (sidebar visibility, tablet/desktop)   | S3 (Sidebar)   | reuse   |
| `cm.detailHidden` | bool (inspector visibility, tablet/desktop) | S6 (Inspector) | reuse   |
| `cm.folderOpen`   | bool                                        | existing       | reuse   |
| `cm.source`       | string (source id)                          | S2             | **new** |
| `cm.editor.armed` | JSON `Record<imageId, {group, tool}>`       | S5 (Editor)    | **new** |
| `cm.filmstrip`    | bool                                        | S5             | **new** |

The `cm.m.*` namespace proposed in the original mobile spec is **not used** — the responsive program evolves the existing apps rather than building separate mobile apps, so the `m` prefix would be misleading.

---

## The slider interaction loop

The central, performance-critical interaction.

```
user drags slider from 0 to +20 contrast
    │
    (per frame, ~60Hz on Mac, ~120Hz on iPad Pro)
    ▼
SwiftUI binding writes:    editSession.model.contrast = 20.0
    ▼
`@Observable` invalidation fires on editSession.model
    ▼
Image view's body re-runs:
    pipeline.apply(to: editSession.decodedImage, with: editSession.model)
    → CIImage (lazy)
    ▼
CIContext.startTask(toRender: ciImage, to: texture, bounds: viewport)
    ▼
  (cancels any in-flight render task)
    ▼
GPU renders — result shown ~25ms later
    ▼
(on slider release)
undoStack.push(editSession.model.copy())
debouncedSidecarWrite.schedule(delay: 500ms)
refinePass.schedule(delay: 150ms)
```

### Commit boundaries

Undo snapshots are **not** taken per-frame. They are committed on:

- Slider release (mouse up, touch end).
- Keyboard-shortcut change (e.g., P/X for flags, 0–5 for ratings).
- WB preset button.
- Eyedropper WB sample.
- Copy-paste adjustments.
- Revert.

This keeps the undo stack at human-meaningful granularity. Redoing "contrast = 20" restores the entire slider value, not each intermediate 1-unit tick.

### Sidecar write debouncing

The 500ms debounce on sidecar write is load-bearing:

- Too short: every tiny slider adjustment writes a file. Filesystem overhead becomes visible.
- Too long: a user who drags then immediately navigates away might lose 200ms of edits.

`endEditing` flushes the debounced write synchronously before session teardown — there is no case where the debounce eats a user edit.

---

## Rendering cadence: fast vs refine (UI side)

From [`05-performance.md`](./05-performance.md) § Two-phase rendering, the UI-visible rules:

- **Fast pass** fires on every slider change. Renders the viewport only at screen resolution. Target 25ms on Mac / 33ms on iPad.
- **Refine pass** fires 150ms after the last slider change. Renders the full image at full resolution. Target 300ms.
- **If a slider moves during a refine pass**, the refine is cancelled and a fast render kicks off again.

The user sees: instant response on every slider movement, quality crystallizing 300ms after they stop.

### Loading state

When a RAW is being decoded (cold open, miss on rendered-preview cache), the UI shows:

- **In place of the image**: a low-contrast "loading" treatment of the embedded JPEG thumbnail (upscaled + slightly blurred). If no thumbnail available, a neutral placeholder.
- **In the toolbar**: a spinner next to the filename.
- **Sliders remain interactive.** Changes queue; they apply when decode completes.

When the decoded image arrives, the placeholder crossfades to the real image over 120ms.

---

## Zoom and pan

Detailed in [`zoom.md`](../zoom.md). UI-side rules:

- **Pinch-to-zoom** (trackpad / touch): continuous scaling around the pinch center, not the image center.
- **Double-tap / double-click**: toggle between "fit" and "1:1 pixel-perfect" centered on the tap point.
- **Keyboard shortcuts**: `Cmd+0` fit, `Cmd+1` 1:1, `Cmd+=` zoom in 50%, `Cmd+-` zoom out 50%.
- **Pan**: drag image with modifier key (spacebar on Mac, two-finger on trackpad), or drag directly when zoomed above fit.
- **Zoom reset on navigation**: in v1, always resets when the user moves to another image. Phase 3 adds a "pin zoom" preference.

### Retina awareness

The zoom system uses **real pixel** coordinates, not points. `1:1` means one texel per display pixel — on a retina display, that's half the count of points. The zoom math and viewport clipping described in [`zoom.md`](../zoom.md) are authoritative.

---

## Detail panel tabs

The right panel has four tabs, pinned at the bottom.

### Info

Shown in both Browse and Full Image modes. Contents:

- Filename, date, size, dimensions, camera/lens/ISO/exposure.
- Rating (star widget, 0–5).
- Flag (Pick / Reject / Unflagged pills).
- Color label (5 colored dots).
- Histogram thumbnail (Phase 3).

All fields are editable except the metadata block (camera/exposure/etc.).

### Color

Shown only in Full Image mode (Browse mode grays the tab content; header shows "select an image").

Sections, top to bottom:

1. **White Balance** — Temperature slider, Tint slider, presets row (As Shot / Daylight / Cloudy / Shade / Tungsten / Flash / Auto), eyedropper button.
2. **Tone** — Exposure, Contrast, Highlights, Shadows, Whites, Blacks.
3. **Presence** — Vibrance, Saturation, Clarity, Texture, Dehaze.
4. **Detail** — Sharpen (Amount, Radius, Detail, Masking), Noise Reduction (Luminance, Color).
5. **Curves** — Master, R, G, B (see § Curves panel below).
6. **Action row** — Copy Adjustments / Paste Adjustments / Revert.

**Every slider change is written to the sidecar** (debounced). No "Save" button.

### Curves panel

Tone curves operate on **scene-linear** values (see [`03-algorithms.md`](./03-algorithms.md) § 3.6, `ref_max = 4.0`). The editor exists in service of editing what AgX renders, so the editor's coordinate system is AgX's own log encode rather than display-linear `[0, 1]` or generic `log2(x/0.18)`. This means the AgX sigmoid plotted in the editor's space looks like a sigmoid (readable) and the user's curve coordinates and AgX's input domain share a coordinate system.

**Axes.** Log-log. X axis spans the full `ref_max = 4.0` curve domain — roughly **−6.5 EV to +4.5 EV** relative to mid-gray in AgX-log space. Tick labels at **−4, −2, 0, +2, +4 EV** (0 = mid-gray). Y axis identical. A 45° line is the identity curve. Internal storage stays linear (the existing `(x, y) ∈ [0, 255]` representation in the sidecar — see [`03-algorithms.md`](./03-algorithms.md) § Tone curve representation); the UI converts on read/write.

**The AgX overlay.** Two lines render in the editor:

- **Bold line** — the user's authored curve, editable by drag/click.
- **Thin overlay** — `AgX(user_curve(x))` mapped back into the editor's coordinate system. Shows what actually happens to a value at this x once the curve and the view transform compose. Both lines update live as the user edits.

The overlay is **on by default**. A toggle in the panel chrome hides it for users who find it busy. Without the overlay, users routinely ask "why does my curve look different on the image than in the editor"; the overlay is the answer.

**Channel switching.** Master / R / G / B as a four-tab control above the editor. Each channel has its own authored curve. The post-AgX overlay renders for the active tab only.

**AgX version coupling.** The X-axis transform follows the active `papp:ViewTransformVersion` (see [`04-color-management.md`](./04-color-management.md) § View transform versioning). A version bump that changes the AgX log encode re-axes the editor; this is a documented consequence of the version-bump contract.

**Imported display-referred curves.** A separate Curves sub-panel labeled **"Imported (display-referred)"** appears when the sidecar carries a Lightroom-authored compatibility curve. See [`09-open-questions.md`](./09-open-questions.md) § 9.50 for the import semantics; the UI just renders whatever 9.50 specifies.

### Meta

Shown in both modes. EXIF, IPTC, XMP passthrough fields. Read-only in v1; edit support is a Phase 5 item.

### Scopes

Shown only in Full Image mode. Grayed ("no image selected") in Browse.

Sections (Phase 3):

- Histogram (RGB + Luma).
- Waveform.
- Vectorscope.
- False-color toggle.

Rendered at `#141210` background — deeper than the rest of the chrome — so RGB waveform colors are legible. See `docs/maple-prd.md` (visual design appendix) for tokens.

---

## Keyboard shortcuts

### Culling (both modes)

| Key     | Action                            |
| ------- | --------------------------------- |
| `1`–`5` | Set rating to 1–5                 |
| `0`     | Clear rating                      |
| `P`     | Flag as Pick                      |
| `X`     | Flag as Reject                    |
| `U`     | Unflag                            |
| `6`–`9` | Set color label (1–4); `0` clears |

### Navigation (Full Image mode)

| Key       | Action                             |
| --------- | ---------------------------------- |
| `←` / `→` | Previous / Next image in filmstrip |
| `↑` / `↓` | Jump by 10 in filmstrip            |
| `Esc`     | Return to Browse                   |
| `F`       | Toggle fullscreen (Mac only)       |

### Zoom (Full Image)

| Key     | Action            |
| ------- | ----------------- |
| `Cmd+0` | Fit               |
| `Cmd+1` | 1:1 pixel-perfect |
| `Cmd+=` | Zoom in 50%       |
| `Cmd+-` | Zoom out 50%      |

### Edit

| Key           | Action             |
| ------------- | ------------------ |
| `Cmd+Z`       | Undo               |
| `Cmd+Shift+Z` | Redo               |
| `Cmd+R`       | Revert to original |
| `Cmd+C`       | Copy adjustments   |
| `Cmd+V`       | Paste adjustments  |
| `Cmd+Shift+E` | Export             |

### Web parity

Web uses the same shortcuts with `Ctrl` substituted for `Cmd` on non-Mac. Angular host listens at the document level; form fields (sidebar text inputs, etc.) absorb keystrokes locally.

---

## Undo / redo semantics

### Stack

- `undoStack: [AdjustmentModel]` — bounded at 50 entries per session.
- `redoStack: [AdjustmentModel]` — cleared on any non-undo edit.

Pushed entries are deep snapshots of the model. The decoded image and rendered texture are not snapshotted — only the parameter set.

### What's undoable

- All slider changes (commit boundary: slider release).
- All curve edits (commit boundary: curve-editor mouse up).
- WB presets, eyedropper, copy-paste.
- Rating / flag / color label changes.
- Crop and rotation operations.

### What's not undoable

- Zoom and pan.
- Selection changes in the grid / filmstrip.
- Tab switches.
- Window layout resizes.
- Sidecar writes themselves (those are a consequence of model changes, not a user action).

### Revert

`Cmd+R` is not an undo — it's a jump back to `originalModel`. It pushes the current model to undo stack, then `model = originalModel.copy()`. A subsequent `Cmd+Z` returns to the pre-revert state.

### Cross-session undo

Undo is session-scoped. Closing an image and reopening it starts with an empty undo stack.

---

## Filmstrip behavior (Full Image)

- **80px tall, fixed.** No resize handle. This is the single exception to the "everything resizable" rule; the filmstrip is a contextual tool, not a column.
- **Horizontal scroll**, keyboard-drivable. The selected cell stays centered.
- **Thumbnails match the grid**. Same cache.
- **Culling badges visible**: star count as a pill in the corner, flag as a colored dot, color label as a bar along the bottom.

### Filmstrip <-> model invariant

Changing selection in the filmstrip triggers `EditSession.endEditing()` on the old image (awaited), then constructs a new `EditSession` for the new image. There is never a moment where two `EditSession`s are alive for the same viewer.

---

## Source picker UX

The left panel ("Sources") shows:

```
▼ Apple Photos
    ▶ All Photos
    ▶ Recents
    ▼ Albums
        ...user albums...
    ▶ Favorites
▼ Folders
    ▶ ~/Pictures/2025
    ▶ ~/Desktop
    ▼ ⭐ ~/Pictures/Portfolio (favorited)
        ▶ subfolder
▼ Network
    ▶ MediaServer (SMB)
```

### Adding a source

- **Folder**: `fileImporter` → security-scoped bookmark → appended to `SourcesStore.folders`.
- **SMB**: modal dialog (host, user, password), test connection, save credential to Keychain, append to `SourcesStore.networkHosts`.
- **Photos**: always present. First access triggers the Photo library permission prompt.

### Removing a source

Right-click → Remove. Filesystem and SMB entries stop being listed; their sidecars on disk are untouched.

### Cold-start behavior

On app launch, the last-selected source and folder are restored. Bookmarks are resolved via `BookmarkStore.restore()`, which blocks until scoped URLs are ready — prevents EPERM on the first folder read. See [`architecture.md`](../architecture.md) § Security-scoped bookmarks.

---

## Error surfaces

Maple deliberately surfaces errors inline rather than via dialogs:

- **Decode failure**: the image view shows "Unable to decode <filename>" with a retry button and a details disclosure.
- **Sidecar write failure**: toast at the bottom of the detail panel, dismissable. Retry on next slider change.
- **SMB connection lost**: source tree shows a disconnected state; reconnect is one click.
- **Disk full during export**: modal dialog — destructive enough to interrupt.

---

## Web-specific UI notes

### Angular workspace

Three projects:

- **`editor`** — the RAW editor. Routes `/` (file picker) and `/edit/:id`. Consumes `raw-wasm`.
- **`browse`** — the library browser. Mirrors the Apple three-column shell. Currently consumes browser-local files only (no server).
- **`maple-common`** — shared TypeScript models, XMP parser/serializer, color math, type definitions.

### Routing

Angular Router, minimal surface. The detail panel is a child route; the mode (Browse / Full Image) is a parent route. Keyboard shortcuts listen at the router outlet level.

### File handling

Web has no native file browser access. File pickers use `<input type="file" />` or the File System Access API (Chromium-only). The editor holds `File` / `Blob` objects in-memory for the session — reloading the page clears them.

**Workspace folder support** (File System Access API) is a planned v2 feature. In v1, files are drag-and-drop or file-picker, one at a time.

### Worker decode (v2)

WASM decode blocks the main thread in v1. Moving to a worker is a v2 item. See [`09-open-questions.md`](./09-open-questions.md) § Web worker decode.

---

## Accessibility

Partially built; full audit pending (Phase 5).

- **VoiceOver on Mac/iOS**: basic labels on all interactive elements. Sliders announce their numeric values. Image grid cells announce filename + rating.
- **Dynamic Type**: the chrome respects the user's text-size preference up to Large; beyond that, layout breaks. Phase 5.
- **Keyboard navigation**: all primary actions have shortcuts. Tab order through the detail panel is sensible. Focus rings respect `#c4493a` accent.
- **Color contrast**: passes WCAG AA for body text against the warm-charcoal background. Slider track/thumb contrast is marginal on some sliders; tracked in [`09-open-questions.md`](./09-open-questions.md) § Accessibility gaps.

---

## What this document does not define

- **The pipeline the UI drives.** See [`02-pipeline.md`](./02-pipeline.md).
- **The types the UI manipulates.** See [`01-data-model.md`](./01-data-model.md).
- **What happens when a slider is debounced to sidecar.** See [`08-io.md`](./08-io.md).
- **Where design tokens come from.** See `docs/maple-prd.md` (visual design appendix).
- **The exact zoom math.** See [`zoom.md`](../zoom.md).
