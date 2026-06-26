# Grid scale-zoom — graduation to production

Epic: [#1570](https://github.com/zubair-io/Maple/issues/1570). Branch `grid-zoom-impl`.

## Context

The scale-zoom interaction is validated on real photos as a throwaway prototype
(`src/apple/Maple/Views/Grid/ScaleZoomTest.swift`, reachable via the temporary 🧪
button in `LibraryGrid`). It must become the real grid on all photo surfaces:
iPhone Library, Mac/iPad Browse, and Cloud Timeline. The prototype is the
**interaction spec** — read it for exact timings/behavior.

## Proven interaction (do not redesign)

- Fixed levels `[9, 5, 3, 1]` columns (phone basis). Gap-aware level scale
  `s(T) = W / (T·cell + (T-1)·gap)`.
- Pinch = a single `scaleEffect` (smooth, no reflow); the focal image is tracked
  and kept under the finger during the gesture (offset-anchored, both axes).
- Vertical scroll = a custom clamped `.offset(y:)` (no ScrollView) with
  velocity-projected momentum (`v·0.42`, easeOut). Mirrors `CanvasZoomHost`.
- Settle: scale lands (`.smooth` 0.46s) + the focal slides to its edge-aligned
  column; then a **delayed (0.2s) opacity crossfade (1.0s)** where the incoming
  packing is rendered at its FINAL edge-aligned position and only fades in (no
  horizontal motion). Pinch rounds toward its direction (no opposite bounce;
  multi-level jumps).
- Content packing: level `T` lays all items in `T` columns (`row·T + col`); the
  pinched item is preserved across the repack by scrolling its new row under the
  finger.
- Windowing: only the rows within ±1 viewport are realized (placed `ZStack`,
  since the transform container can't use `LazyVGrid` windowing).
- No placeholder flicker: a thumbnail loaded once renders synchronously on later
  levels (prototype uses a local `ThumbCache`; production moves this into the
  shared cell — see M1).

## Architecture

A reusable generic component replaces `PhotoGrid` on each surface:

`ScaleZoomGrid<Element: Identifiable>` (new, `Maple/Views/Grid/`):

- Inputs: `data: [Element]`, `zoomLevel` binding (or internal), `provider`,
  `makeItem: (Element) -> PhotoGridItem`, `onTap: (Element) -> Void`,
  `leadingCount: Int` + `makeLeading: (Int) -> AnyView?` (folders), `selection`,
  `multiSelectChecked`. Renders the scale-zoom container + windowed
  `PhotoThumbnailCell`s, packing leading cells (folders) into the first
  `leadingCount` slots so they zoom/scroll with the photos (matches today's
  leading-slot behavior). All interaction logic lives here, lifted from the
  prototype.
- Cells are `PhotoThumbnailCell` (overlays/selection/badges/a11y), NOT the
  prototype's `CachedThumb`.

## Milestones (sequenced; each builds + verifies on iOS-sim + macOS, then device)

- **M0 — `ScaleZoomGrid` component.** Extract + generalize the prototype into the
  generic component (windowing, scale/scroll/momentum/crossfade/focal, leading
  cells). Rewire the 🧪 `ScaleZoomTest` to render via `ScaleZoomGrid` so it stays
  verifiable. No real-surface change yet.
- **M1 — shared-cell sync cache.** Add a `nonisolated` synchronous
  `cachedThumbnail(for: ThumbnailSource) -> Data?` memory-cache peek to
  `ThumbnailProvider`, and have `PhotoThumbnailCell` render
  `thumb ?? provider.cachedThumbnail(...)` so cached thumbs show with no
  placeholder frame. Removes the prototype-local cache; benefits the whole app
  (scroll re-entry, editor round-trips, the existing grids). Investigate
  `ThumbnailProvider`/`ThumbnailLoader`/`ThumbnailDiskCache` for a thread-safe
  memory cache to expose.
- **M2 — Library (iPhone).** Replace `PhotoGrid` in `LibraryGrid` with
  `ScaleZoomGrid`: folders as leading cells, tap → `onOpenEditor`, single-select,
  overlays. Remove `ScaleZoomTest` + the 🧪 button. Persist the zoom level
  (`@AppStorage`, like `browseZoomLevel`).
- **M3 — Browse (Mac/iPad).** `BrowseGrid` normal + merged: folders, multi-select
  badges, trackpad pinch + the existing toolbar +/- + ⌘± driving the same level.
  Resolve: the toolbar/buttons have no focal point → default focal = the selected
  item (or viewport center).
- **M4 — Cloud Timeline.** Sectioned per-month — **design decision required at
  this milestone**: flatten the timeline into one continuous zoomable grid (with
  month-header rows interleaved or dropped) vs. per-section zoom. Decide with the
  user before building M4.

## Open design decisions

- **Folders (M2/M3):** default = folders occupy the first `leadingCount` slots of
  the packing (zoom + scroll with photos), matching today's leading-slot layout.
  Confirm if a fixed non-zooming folder header is preferred instead.
- **Cloud sections (M4):** flatten vs per-section — resolve at M4.
- **Edge-align vs focal-under-finger at rest:** prototype lands edge-aligned at
  rest (focal slides to its column on settle). Keep.

## Verification (every milestone)

`swift test` (MapleCore) green; `xcodebuild` BUILD SUCCEEDED on **iOS Simulator**
AND macOS (the `#if os(iOS)` surfaces only compile on iOS-sim); then device-build

- install to Artemis for on-device feel. Manual: pinch through levels, scroll +
  momentum, focal preserved, edge-aligned at rest, no placeholder flicker, tap
  opens the editor, selection/multi-select work, folders navigate.
