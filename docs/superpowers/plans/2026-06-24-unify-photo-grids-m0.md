# Unify Photo Grids — M0 Implementation Plan (foundation)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Land the five shared grid components + the single thumbnail-load facade, with unit coverage and SwiftUI previews. No call sites change in M0.

**Architecture:** A unified `PhotoGridItem` value model (id + `ThumbnailSource` + `GridCellOverlays`) that every surface will convert to; a single `ThumbnailProvider` actor facade that dispatches `ThumbnailSource` to the existing `ThumbnailLoader` / `CloudThumbClient`+`CloudThumbCache` / `PHImageManager`; a `PhotoThumbnailCell` view owning load lifecycle + overlays + tap/selection + a zoom-transition tag; and a `PhotoGrid` container taking a `ColumnStrategy`. The leaf renderer `ThumbnailImage` (already shared) is reused as-is.

**Tech Stack:** Swift 6 / SwiftUI, `@Observable`, structured-concurrency `actor` for the provider, Photos.framework (PHImageManager), MapleCore (model + enums), Maple app target (views + provider). XCTest in MapleCoreTests for pure logic.

**Spec:** `docs/superpowers/specs/2026-06-24-unify-photo-grids-design.md`

---

## File structure

| File                                                               | Module         | Responsibility                                                                                                                             |
| ------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Packages/MapleCore/Sources/MapleCore/Grid/PhotoGridItem.swift`    | MapleCore      | `PhotoGridItem`, `ThumbnailSource`, `GridCellOverlays`, `SyncBadge`, `OverlayStyle` — pure value types + a couple of derivation helpers    |
| `Packages/MapleCore/Tests/MapleCoreTests/PhotoGridItemTests.swift` | MapleCoreTests | unit tests for the model + overlay derivation                                                                                              |
| `Maple/Views/Grid/ThumbnailProvider.swift`                         | Maple          | the single load facade (actor) dispatching `ThumbnailSource` → existing loaders; absorbs the duplicated PHImageManager + JPEG-encode logic |
| `Maple/Views/Grid/PhotoThumbnailCell.swift`                        | Maple          | the shared cell: load lifecycle, overlays, tap/selection, zoom tag                                                                         |
| `Maple/Views/Grid/PhotoGrid.swift`                                 | Maple          | `ColumnStrategy` + flat `PhotoGrid` + `SectionedPhotoGrid`                                                                                 |

`ThumbnailImage` and `GridDisplayMode` move from `BrowseGrid.swift` into `Maple/Views/Grid/ThumbnailImage.swift` (no logic change) so the new components don't depend on `BrowseGrid.swift`. Re-export/keep the `BrowseGrid.swift` call sites compiling unchanged.

---

## Known existing types this builds on (verified)

- `ThumbnailImage(jpegData: Data?, displayMode: GridDisplayMode)` — leaf renderer (BrowseGrid.swift:616).
- `GridDisplayMode { case fill, fit; var contentMode }` (BrowseGrid.swift:26).
- `MergedTimelineCell { case localOnly(ImageRef), cloudOnly(ImageRef), synced(local:ImageRef, cloud:ImageRef) }` (MapleCore/Browse/MergedTimelineSource.swift:18); `renderID(_:)` gives the stable id.
- `ThumbnailLoader.shared.load(for: AssetRef, from: (any ImageSource)?) async -> Data?` (MapleCore/Cache/ThumbnailLoader.swift).
- `CloudThumbClient.thumb(absPath:size:) async throws -> Data`; `CloudThumbCache.get(host:absPath:)`/`put(host:absPath:_:)` (MapleCore/Cloud/). The cloud fetch+cache pattern is `CloudTimelineCell.fetchThumbBytes` (CloudTimelineView.swift:298).
- PhotoKit fast path: `PHImageManager.default().requestImage(...)` + `CGImageDestination` JPEG encode — currently duplicated in `BrowseGrid.MergedCellView` (~537) and `CloudTimelineMergedCell` (~390). M0 hoists ONE copy into `ThumbnailProvider`.
- `SearchAsset` (cloud DTO): `id`, `abs_path`, `filename`, `rating: Int?`, `flag` (MapleCore/Cloud/CloudSearchTypes.swift:34).

---

## Task 1: Move `ThumbnailImage` + `GridDisplayMode` into `Views/Grid/`

**Files:**

- Create: `Maple/Views/Grid/ThumbnailImage.swift`
- Modify: `Maple/Views/BrowseGrid.swift` (remove the two type definitions; keep all usages)

- [ ] **Step 1:** Cut `GridDisplayMode` (BrowseGrid.swift:17-61) and `ThumbnailImage` (BrowseGrid.swift:600-654) verbatim into the new file (same `internal` access, same target). No code changes.
- [ ] **Step 2:** Build the macOS app: `cd src/apple && xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" -destination 'platform=macOS' build` (after building the xcframework macOS slice — see "Build prerequisite" below). Expected: builds; BrowseGrid + CloudTimeline still reference the moved types (same target, no import needed).
- [ ] **Step 3:** Commit: `refactor(apple): hoist ThumbnailImage/GridDisplayMode into Views/Grid (#1490 M0)`.

## Task 2: `PhotoGridItem` model + tests

**Files:**

- Create: `Packages/MapleCore/Sources/MapleCore/Grid/PhotoGridItem.swift`
- Test: `Packages/MapleCore/Tests/MapleCoreTests/PhotoGridItemTests.swift`

- [ ] **Step 1: Write the model.**

```swift
import Foundation

public enum ThumbnailSource: Sendable, Hashable {
    case local(AssetRef, source: ImageSourceBox?)   // → ThumbnailLoader
    case cloud(absPath: String, host: String)        // → CloudThumbClient + CloudThumbCache
    case photoKit(localID: String)                   // → PHImageManager
    case merged(MergedTimelineCell)                  // → resolves to photoKit or cloud
}

public enum SyncBadge: Sendable, Hashable { case synced, cloudOnly, localOnly }
public enum OverlayStyle: Sendable, Hashable { case phone, desktop }

public struct GridCellOverlays: Sendable, Hashable {
    public var rating: Int = 0
    public var flag: AssetFlag? = nil
    public var sync: SyncBadge? = nil
    public var isVideo: Bool = false
    public var style: OverlayStyle = .phone
    public init(rating: Int = 0, flag: AssetFlag? = nil, sync: SyncBadge? = nil,
                isVideo: Bool = false, style: OverlayStyle = .phone) {
        self.rating = rating; self.flag = flag; self.sync = sync
        self.isVideo = isVideo; self.style = style
    }
}

public struct PhotoGridItem: Identifiable, Sendable, Hashable {
    public let id: String
    public let thumbnailSource: ThumbnailSource
    public var overlays: GridCellOverlays
    public init(id: String, thumbnailSource: ThumbnailSource, overlays: GridCellOverlays = .init()) {
        self.id = id; self.thumbnailSource = thumbnailSource; self.overlays = overlays
    }
}
```

> **Note:** `AssetFlag` is the existing flag enum used by `LibraryCell` (confirm exact name during execution — it's the pick/reject type the FlagBadge renders; reuse it, do not redefine). `ImageSourceBox` is a `Hashable`/`Sendable` wrapper if `(any ImageSource)?` can't be stored in a `Hashable` enum directly; if `ImageSource` is already `Hashable & Sendable`, store it directly and delete the box. Resolve this when reading `AssetRef.swift`/`ImageSource`.

- [ ] **Step 2: Tests.** Cover: default overlays, `Identifiable` id passthrough, `Hashable` equality for two items with the same id+source, and `PhotoGridItem(from: MergedTimelineCell)` once added in Task 3.

```swift
import XCTest
@testable import MapleCore

final class PhotoGridItemTests: XCTestCase {
    func testDefaultOverlaysAreEmpty() {
        let item = PhotoGridItem(id: "x", thumbnailSource: .photoKit(localID: "x"))
        XCTAssertEqual(item.overlays.rating, 0)
        XCTAssertNil(item.overlays.sync)
    }
}
```

- [ ] **Step 3:** `cd src/apple/Packages/MapleCore && swift test --filter PhotoGridItemTests`. Expected: PASS.
- [ ] **Step 4:** Commit: `feat(apple): PhotoGridItem unified grid model (#1490 M0)`.

## Task 3: `PhotoGridItem` adapters per surface (pure mapping)

Add static/`init` adapters so each surface maps its DTO → `PhotoGridItem`. These are the seam M1–M3 call.

- [ ] **Step 1:** Add to `PhotoGridItem.swift`:
  - `init(merged cell: MergedTimelineCell, host: String, sync: SyncBadge, style: OverlayStyle)` — id = `MergedTimelineSource.renderID(cell)`, source = `.merged(cell)`, overlays.sync = sync.
  - `init(cloud asset: SearchAsset, host: String, style: OverlayStyle)` — id = `asset.id`, source = `.cloud(absPath: asset.abs_path, host: host)`, overlays from `asset.rating`/`asset.flag`.
  - `init(local asset: AssetRef, source: (any ImageSource)?, overlays: GridCellOverlays)` — id = `asset.stableID`, source = `.local(asset, source: …)`.
- [ ] **Step 2:** Unit-test each adapter (id + source + overlay derivation). Run `swift test --filter PhotoGridItemTests`.
- [ ] **Step 3:** Commit: `feat(apple): PhotoGridItem adapters for local/cloud/merged (#1490 M0)`.

## Task 4: `ThumbnailProvider` facade (the single load path)

**Files:** Create `Maple/Views/Grid/ThumbnailProvider.swift`

- [ ] **Step 1:** Implement an `actor ThumbnailProvider` with one entry point that dispatches on `ThumbnailSource`:

```
func thumbnail(for source: ThumbnailSource, targetSize: Int) async -> Data?
  .local(ref, src)     → ThumbnailLoader.shared.load(for: ref, from: src?.unwrap)
  .cloud(abs, host)    → cache.get ?? (try? client.thumb(absPath:size:)) then cache.put
  .photoKit(localID)   → PHImageManager fast path → JPEG (hoisted from MergedCellView)
  .merged(cell)        → switch: .synced/.localOnly → photoKit(local.id); .cloudOnly → cloud(absPath,host)
```

Inject `CloudThumbClient`, `CloudThumbCache`, and `host` at construction (the cloud path needs them; pass via an initializer the app already has wired for the timeline). The PhotoKit JPEG-encode helper is moved here verbatim from `BrowseGrid.MergedCellView` (one copy) and both old cells will delegate in M1/M2.

- [ ] **Step 2:** Verify the PhotoKit/cloud behaviour is byte-for-byte the relocated logic (no new caching, same target sizes: cloud 512, local 256, PhotoKit current size). Build the app (Task 1 build command). Expected: compiles.
- [ ] **Step 3:** Pure-logic test for the `.merged` → backend routing (extract the switch into a pure `static func backend(for: ThumbnailSource) -> Backend` enum-returning helper and test it in MapleCoreTests — keeps the I/O out of the unit test).
- [ ] **Step 4:** Commit: `feat(apple): ThumbnailProvider single load facade (#1490 M0)`.

## Task 5: `PhotoThumbnailCell` view (+ zoom seam)

**Files:** Create `Maple/Views/Grid/PhotoThumbnailCell.swift`

- [ ] **Step 1:** Implement the cell:

```
struct PhotoThumbnailCell: View {
  let item: PhotoGridItem
  let provider: ThumbnailProvider
  let displayMode: GridDisplayMode
  var isSelected: Bool = false
  var transitionNamespace: Namespace.ID? = nil   // zoom seam
  let onTap: () -> Void
  @State private var thumb: Data?
  // body: ThumbnailImage(jpegData: thumb, displayMode:)
  //   .overlay { GridCellOverlayView(item.overlays) }   // rating/flag/sync/selection
  //   .modifier(SelectionOutline(isSelected))
  //   .modifier(ZoomSourceTag(id: item.id, namespace: transitionNamespace)) // matchedTransitionSource if available
  //   .contentShape(Rectangle()).onTapGesture(perform: onTap)
  //   .task(id: item.id) { thumb = await provider.thumbnail(for: item.thumbnailSource, targetSize: px) }
}
```

`GridCellOverlayView` renders the badges from `GridCellOverlays` — port the existing overlay visuals (phone pick-dot + ≥4★ gold; desktop FlagBadge + StarView; cloud rating ★; merged sync `checkmark.icloud.fill`/`icloud.fill`) verbatim so visuals are identical. `ZoomSourceTag` applies `.matchedTransitionSource(id:in:)` when a namespace is provided (iOS 18+) and is a no-op otherwise.

- [ ] **Step 2:** Add a `#Preview` exercising each overlay style + selection. Build the app. Expected: compiles; preview renders.
- [ ] **Step 3:** Commit: `feat(apple): PhotoThumbnailCell shared cell + zoom seam (#1490 M0)`.

## Task 6: `PhotoGrid` container

**Files:** Create `Maple/Views/Grid/PhotoGrid.swift`

- [ ] **Step 1:** Implement:

```
enum ColumnStrategy { case fixed(Int, spacing: CGFloat)
                      case adaptive(min: CGFloat, max: CGFloat, spacing: CGFloat)
                      case responsiveBySizeClass            // 3 phone / 5 tablet / adaptive desktop
  func gridItems(for sizeClass: …) -> [GridItem] }

struct PhotoGrid: View {                 // flat
  let items: [PhotoGridItem]
  let columns: ColumnStrategy
  let provider: ThumbnailProvider
  let displayMode: GridDisplayMode
  var selection: Set<String> = []
  var transitionNamespace: Namespace.ID? = nil
  let onTap: (PhotoGridItem) -> Void
  // LazyVGrid(columns:) { ForEach(items) { PhotoThumbnailCell(...) } }
}

struct SectionedPhotoGrid<Header: View>: View {   // month buckets for CloudTimeline
  let sections: [(key: String, items: [PhotoGridItem])]
  @ViewBuilder let header: (String) -> Header
  // LazyVStack { ForEach(sections) { header($0.key); PhotoGrid(...) } }
}
```

- [ ] **Step 2:** `#Preview` with ~12 placeholder items in each `ColumnStrategy`. Build. Expected: compiles.
- [ ] **Step 3:** Commit: `feat(apple): PhotoGrid container with ColumnStrategy (#1490 M0)`.

## Build prerequisite (run once before Task 1's build)

The xcframework `.a` slices are gitignored. For macOS-only compile/verify (fast):

```bash
cd src/apple
cargo build -p raw-ffi --features gpu,pano --target aarch64-apple-darwin   # ~24s
# copy the .a into the macOS slice + regenerate the header via cbindgen (see build-xcframework.sh macOS path)
```

(Per `project_fast_macos_xcframework_for_parity_tests`.) Then the `xcodebuild ... -destination 'platform=macOS' build` in each task verifies compilation.

## M0 Definition of Done

- All five components + provider compile in the macOS app target; `swift test` (MapleCore) green for model/adapter/routing.
- No call sites changed; existing grids untouched and still building.
- `#Preview`s render each component.
- PR opened, `Closes #<M0 sub-ticket>`, no merge without approval.

## Self-review notes

- Spec coverage: model (Task 2/3), single load path (Task 4), cell+zoom seam (Task 5), grid (Task 6), `ThumbnailImage` reuse (Task 1). Migration (M1–M3) is out of M0 by design.
- Open items to resolve at execution (read the source, don't guess): exact `AssetFlag` enum name + `AssetRef.stableID`; whether `ImageSource` is `Hashable & Sendable` (drop `ImageSourceBox` if so); the exact `PHImageManager` request options + target size used today (copy verbatim); how `host` is currently provided to the timeline (reuse that injection).
