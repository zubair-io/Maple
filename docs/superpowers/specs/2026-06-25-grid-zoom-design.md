# Grid zoom — design

Ticket: [#1550](https://github.com/zubair-io/Maple/issues/1550). Builds on the unified
grid from [#1490](https://github.com/zubair-io/Maple/issues/1490) (shared `PhotoGrid` /
`ColumnStrategy` / `PhotoThumbnailCell`). Prereq (grid unification) is merged.

## Goal

A 4-level zoom for the photo grid:

| Level         | iPhone columns | Meaning                     |
| ------------- | -------------- | --------------------------- |
| `fullWidth`   | 1              | one image filling the width |
| `comfortable` | 3              | today's iOS default         |
| `compact`     | 5              |                             |
| `dense`       | 10             |                             |

Smooth animated transitions between levels. The levels translate to bigger screens
by **cell size**, not raw column count: the 1/3/5/10 counts define cell _sizes_ at
iPhone width, and iPad / a resized Mac window keep those cell sizes while the column
count grows with the window.

## Non-goals

- Continuous (free) zoom — levels are discrete (4 snap points).
- Zoom on the **Search results** grid — it stays fixed at 3-wide (dense, transient
  preview sharing the screen with other sections). Same component, trivial to add
  later if wanted.
- The editor zoom-to-open transition (#1489) — separate work; this only adds grid
  cell-size zoom.

## Model

```swift
// MapleCore — pure value type, single-sourced level definitions.
public enum GridZoomLevel: Int, CaseIterable, Sendable, Codable {
    case fullWidth   // 1 column
    case comfortable // 3-wide on iPhone (default)
    case compact     // 5-wide on iPhone
    case dense       // 10-wide on iPhone

    /// Canonical iPhone column count for this level.
    public var phoneColumns: Int {
        switch self { case .fullWidth: 1; case .comfortable: 3; case .compact: 5; case .dense: 10 }
    }

    /// Step in/out, clamped to the ends (no wrap).
    public func stepped(_ dir: ZoomStep) -> GridZoomLevel { … }   // .in → fewer cols (bigger), .out → more cols
}
```

### Size translation (the core rule)

The level's **target cell width** is derived from a reference iPhone content width so a
cell is the same physical size on every device:

```
referencePhoneWidth = 390   // pt; iPhone 15/16/17-class logical width
targetCellWidth(level) = (referencePhoneWidth − insets) / level.phoneColumns
```

- **`.phone` layout** → exact counts via `ColumnStrategy.fixed(level.phoneColumns, spacing:)`.
  Guarantees iPhone always shows precisely 1/3/5/10 regardless of the exact model width.
- **`.tablet` / `.desktop`** → `ColumnStrategy.adaptive(minimum: targetCellWidth(level), spacing:)`.
  Same cell size as iPhone; column count = `floor(width / targetCellWidth)` grows with the
  window (so "3-wide" on iPhone is ~7-wide on a wide Mac window).
- **`.fullWidth`** → `ColumnStrategy.fixed(1, …)` on every layout.

Spacing per level follows the existing per-surface gaps (phone 2pt, else 4pt); dense
levels may use a tighter gap — tuned during implementation against the reference scenes.

## ColumnStrategy integration

Add one case to the existing enum (in `Grid/PhotoGrid.swift`):

```swift
case zoom(GridZoomLevel)
```

`gridItems(for:)` and `rowSpacing(for:)` resolve `.zoom` per `mapleLayout` using the rule
above (phone = fixed count; tablet/desktop = adaptive at the target cell width; fullWidth =
fixed 1). **`PhotoGrid` itself is unchanged** — it already consumes `ColumnStrategy`. The
call sites (`LibraryGrid`, `BrowseGrid`, `CloudTimelineView`) pass `.zoom(level)` in place
of their current hardcoded strategies. `SearchPhotoResultsSection` keeps `.fixed(3)`.

## State & persistence

- `@AppStorage("grid.zoomLevel")`-backed `browseZoomLevel: GridZoomLevel` on `AppShell`,
  threaded down as a `@Binding` exactly like the existing `browseDisplayMode`
  (`AppShell` → `AppShellToolbar` / `AppShellCenterColumn` / `AppShellIPhoneShell` /
  `AppShellMacLayout` → the grids). One shared level across Library / Browse / CloudTimeline.
- Persists across launches. **Orthogonal** to fill/fit (`displayMode`): both coexist, both
  apply (at `fullWidth`, fill/fit still governs the single cell).

## Interaction

- **Pinch** — a `MagnificationGesture` on the grid (works with Mac trackpad pinch too).
  Crossing an out-threshold (`scale > ~1.25`) steps one level toward bigger cells; crossing
  an in-threshold (`scale < ~0.8`) steps toward smaller cells. One step per gesture
  (discrete); the gesture's running scale is NOT applied live (that's the continuous variant
  we explicitly deferred). Encapsulated in a `gridZoomPinch(level:)` view modifier so all
  three surfaces get identical behaviour.
- **Toolbar + keyboard (Mac/iPad)** — a small zoom control in the existing toolbar
  (segmented or − / +) next to the fill/fit button, plus `⌘+` / `⌘−` commands.
- **iPhone** — pinch is primary.

## Animation

Stepping the level wraps the binding mutation in `withAnimation(.smooth)` so the
`LazyVGrid` reflows and cells resize fluidly. The grid's `ForEach` already keys on a stable
element id, so SwiftUI animates the frame changes rather than rebuilding. **Risk:**
`LazyVGrid` column-count reflow can occasionally pop; mitigation is the spring timing and,
if needed, a follow-up `matchedGeometryEffect` per cell (not in v1).

## Surfaces

Zoom (`.zoom(browseZoomLevel)` + pinch modifier + toolbar control) applies to:
`LibraryGrid` (iPhone), `BrowseGrid` (Mac/iPad), `CloudTimelineView` (per-month sections).
`SearchPhotoResultsSection` is unchanged.

## Testing

Apple isn't gated by cloud CI, so: `xcodebuild` green on **iOS Simulator** (the gate for
the `#if os(iOS)` surfaces) AND macOS; `swift test` for the pure logic. Unit-test
`GridZoomLevel` (phoneColumns, stepped clamping) and the `.zoom` → `ColumnStrategy`
resolution at each `MapleLayout`. Manual: pinch + toolbar + ⌘± on each surface; confirm
iPhone shows exactly 1/3/5/10 and a wide Mac window keeps cell size constant while column
count grows; confirm persistence across relaunch.

## Risks

- **Reflow jank** on level change — mitigated by spring animation; `matchedGeometryEffect`
  is the escape hatch.
- **Reference-width tuning** — the `targetCellWidth` constants must yield exactly 1/3/5/10
  on the common iPhone widths; verify on iPhone SE (375pt) and Pro Max (430pt).
- **Pinch vs scroll** conflict in `LazyVGrid` — `MagnificationGesture` composes with the
  scroll view, but verify it doesn't swallow scrolls; use `.simultaneousGesture` if needed.
