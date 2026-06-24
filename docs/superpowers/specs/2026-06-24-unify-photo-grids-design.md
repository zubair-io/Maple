# Unify the photo grids (DRY) — design

Ticket: [#1490](https://github.com/zubair-io/Maple/issues/1490). Driver: the editor
zoom-to-open transition (#1489) needs a single shared grid/cell so a transition
source can be tagged once and adopted everywhere.

## Problem

Four near-duplicate grid/cell implementations render the same conceptual thing (a
tappable thumbnail in a grid) with divergent code:

| Surface                                                              | File                                                 | Model                                                    | Load path                                               | Layout                         |
| -------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------- | ------------------------------ |
| `SearchPhotoResultsSection`                                          | `Maple/Views/SearchPhotoResultsSection.swift`        | `SearchResultTile` (placeholder, **no real thumbnails**) | none                                                    | fixed 3-col, 9 cap             |
| `LibraryGrid` / `LibraryCell`                                        | `Maple/Views/LibraryGrid.swift`, `LibraryCell.swift` | `AssetRef`                                               | `ThumbnailLoader`                                       | responsive 3·5·adaptive        |
| `BrowseGrid` (+ `MergedCellView`)                                    | `Maple/Views/BrowseGrid.swift`                       | `AssetRef` / `MergedTimelineCell`                        | `ThumbnailLoader` / `PHImageManager`                    | adaptive 140–200, multi-select |
| `CloudTimelineView` (`CloudTimelineCell`, `CloudTimelineMergedCell`) | `Maple/Views/CloudTimelineView.swift`                | `SearchAsset` / `MergedTimelineCell`                     | `CloudThumbClient`+`CloudThumbCache` / `PHImageManager` | month-sectioned 4-col          |

Already shared: `ThumbnailImage` (JPEG→rounded square leaf renderer) and `LibraryCell`
(library + browse). The load+JPEG-encode+`PHImageManager` logic is **copy-pasted**
across `MergedCellView`, `CloudTimelineCell`, and `CloudTimelineMergedCell`.

The divergence blocks consistent behaviour (shared zoom-to-open source, consistent
loading/selection) and forces N-way fixes.

## Goal

One source of truth for the cell visuals, the thumbnail load path, tap/selection,
and a transition-source tag. Migrate all four surfaces onto it. **Full model
unification**: every surface converts its DTO to one `PhotoGridItem`; the cell and a
single load facade are the single source of truth.

## Architecture — five new components

```
PhotoGridItem        value model every surface converts to (id, thumbnailSource, overlays)
ThumbnailSource      enum bridging the 3 real load backends
ThumbnailProvider    single facade: thumbnail(for:targetSize:) async -> Data?  (the "one load path")
PhotoThumbnailCell   owns load lifecycle + overlays + tap/selection + zoom-source tag
PhotoGrid            container taking a ColumnStrategy (flat + month-sectioned variants)
```

`ThumbnailImage` stays as the leaf renderer. Each surface's job shrinks to: map its
data to `[PhotoGridItem]` and hand it to `PhotoGrid`.

### Unified model

```swift
struct PhotoGridItem: Identifiable {
    let id: String                          // grid identity, .task id, AND zoom-transition id
    let thumbnailSource: ThumbnailSource
    var overlays: GridCellOverlays = .init()
}

enum ThumbnailSource {                                 // Sendable, NOT Hashable (carries any ImageSource)
    case local(AssetRef, source: ImageSourceBox?)      // -> ThumbnailLoader
    case cloud(absPath: String, host: String)          // -> CloudThumbClient + CloudThumbCache
    case photoKit(localID: String)                     // -> PHImageManager
    case merged(MergedTimelineCell, host: String)      // -> resolves to photoKit or cloud
}

struct GridCellOverlays {                   // badges become DATA, not divergent code
    var rating: Int = 0                     // 0..5 stars
    var flag: CullFlag? = nil               // pick / reject (existing AdjustmentModel enum)
    var sync: SyncBadge? = nil             // synced / cloudOnly / localOnly
    var isVideo: Bool = false
    var style: OverlayStyle = .phone        // phone pick-dot vs desktop flag+stars
}
```

The four current models collapse into `PhotoGridItem` at the call site. Only the
differences that must survive (which backend, which badges, which overlay style)
remain — as data on the item.

### Single load path

`ThumbnailProvider` (actor) exposes one method the cell calls:

```swift
func thumbnail(for source: ThumbnailSource, targetSize: Int) async -> Data?
```

It dispatches on `ThumbnailSource` to the existing `ThumbnailLoader` /
`CloudThumbClient`+`CloudThumbCache` / `PHImageManager`, absorbing the JPEG-encode +
PhotoKit logic currently duplicated three times. No new caches — it orchestrates the
existing ones. (`PHImageManager` lives in Photos, so the provider sits app-side in
`Maple/Views`; the model + enum stay in MapleCore where their types already live.)

### Cell, grid, and zoom seam

- **`PhotoThumbnailCell`**: `@State thumb: Data?` + `.task(id: item.id)` (load,
  cancel on disappear) → `ThumbnailImage` → overlays from `item.overlays` →
  `onTapGesture` / selection. Per-surface visuals unchanged.
- **`PhotoGrid`**: `ColumnStrategy = .fixed(Int) | .adaptive(min:max:) |
.responsiveBySizeClass`; a `.sectioned` wrapper composes the flat grid per month
  bucket for the cloud timeline.
- **Zoom seam**: the cell tags itself with `item.id` (iOS 18 `matchedTransitionSource`
  - an anchor-preference fallback so a custom transition can read the source frame).
    Seam only — no animation in this work; #1489 adopts it.

### Out of scope

Folder cells (`LibraryFolderCell`, `FolderCell`) are not photos — they keep
rendering above the photo grid, unchanged. No new caching. No editor transition
animation (just the tag).

## Migration milestones (each = its own ticket + PR, deletes what it replaces)

- **M0** — land the five components + provider with preview/unit coverage; no call
  sites changed.
- **M1** — `LibraryGrid` + `BrowseGrid` (already share `LibraryCell`; exercises
  local + merged + multi-select; lowest risk).
- **M2** — `CloudTimelineView` (cloud + merged + month-sectioned).
- **M3** — `SearchPhotoResultsSection` → real thumbnails (behaviour upgrade from
  placeholders).

## Testing & verification

Apple isn't gated by cloud CI, so per milestone: `xcodebuild build` green,
`swift test` for view-model logic, and **before/after screenshots** of each migrated
surface (grids must look identical; M3 is the only intentional visual change). Lean
on the `MapleUITests` golden harness where it covers a surface; add coverage where it
doesn't. The unified `PhotoGridItem` mapping per surface gets pure unit tests
(DTO → item, overlay derivation).

## Risks

- **Visual drift** during migration — mitigated by per-surface before/after
  screenshots and the golden harness.
- **Load-path regressions** (PhotoKit fast path, cloud cache keys) — the provider
  must preserve each backend's exact behaviour; covered by keeping the existing
  loaders and only relocating the orchestration.
- **Selection/tap routing** differs per surface (editor push vs search-select vs
  merged branching) — modelled as a per-surface closure on the cell, not centralised.
