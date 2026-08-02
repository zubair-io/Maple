# Apple info pane metadata parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Apple info pane to full parity with the web info pane (date, path, place, vision, faces, size, dimensions) and fix the broken cloud detail fetch, with a clickable path that opens the asset's containing folder in Maple.

**Architecture:** A single `CatalogRef` value on `AssetRef` carries the cloud catalog identity (server, folder, path, `slug:relPath` address). The detail fetch moves to the address-based `GET /api/assets/by-address` endpoint (which already exists), unblocking description/OCR/transcript and adding place/vision/faces/size. The info pane gains overview rows (date/dimensions from the EXIF it already reads; path/size) and Place/Vision/Faces sections. The clickable path invokes a new `AppShell.revealContainingFolder(of:)` exposed as a SwiftUI environment action, re-injected across the iPhone info sheet like the existing cloud clients.

**Tech Stack:** Swift 6, SwiftUI, `@Observable`, Swift Package Manager (MapleCore + MapleCloudKit packages), XCTest. Server unchanged (Bun/Elysia).

## Global Constraints

- Apple only. No API or web changes. No new backend DTO fields.
- `AssetRef.stableID` (thumbnail-cache key) must not change.
- `swift test` is the unit gate; Apple is not gated by cloud CI, so verify with local `swift test` + macOS and iOS-sim `xcodebuild` builds + a run against a signed-in cloud library.
- Field selection mirrors the web info pane (`src/web/projects/maple-common/src/lib/info/`): Place, Description, Vision (subjects/scene/setting/activity/shot_type/colors/mood + screenshot badge), Transcript, Faces.
- New/changed Swift files stay focused (one responsibility per file); follow the existing InfoPanel section-view pattern.

---

### Task 1: `CatalogRef` value + `AssetRef.catalog` field

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/AssetRef.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/AssetRefCatalogTests.swift` (create)

**Interfaces:**
- Produces: `public struct CatalogRef: Hashable, Sendable { public let serverID: URL; public let folderID: String; public let absPath: String; public let address: String? }` and `public var catalog: CatalogRef?` on `AssetRef`; both initializers accept `catalog: CatalogRef? = nil` (defaulted so all existing call sites compile unchanged). `AssetRef.init(url:)` sets `catalog = nil`.

- [ ] Write `AssetRefCatalogTests`: a URL-backed ref has `catalog == nil`; a bytes-backed ref built with a `CatalogRef` round-trips `serverID/folderID/absPath/address`.
- [ ] Add `CatalogRef` struct + `public let catalog: CatalogRef?` to `AssetRef`; thread `catalog: CatalogRef? = nil` through both inits and `preview(...)`.
- [ ] `swift test --package-path src/apple/Packages/MapleCore --filter AssetRefCatalog` → PASS.
- [ ] Commit.

### Task 2: `SearchAsset.address` decode

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCloudKit/Cloud/CloudSearchTypes.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCloudKitTests/SearchAssetAddressTests.swift` (create; match existing MapleCloudKit test dir)

**Interfaces:**
- Produces: `public let address: String?` on `SearchAsset` (synthesized `Codable` picks up the wire `address` key by name); `init(... address: String? = nil ...)`.

- [ ] Write test: decode a JSON fixture containing `"address":"lib:2026/x.dng"` → `asset.address == "lib:2026/x.dng"`; decode one without the key → `nil` (backward compat).
- [ ] Add `address` field + defaulted init param + assignment.
- [ ] `swift test ... --filter SearchAssetAddress` → PASS.
- [ ] Commit.

### Task 3: expand `CloudAssetDetail` + address-based fetch

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCloudKit/Cloud/CloudAssetDetailClient.swift`
- Create: `src/apple/Packages/MapleCore/Sources/MapleCloudKit/Cloud/CloudAssetDetailModels.swift` (place/vision/faces Codable structs — keep the client file lean)
- Test: `src/apple/Packages/MapleCore/Tests/MapleCloudKitTests/CloudAssetDetailTests.swift` (extend/create)

**Interfaces:**
- Produces: on `CloudAssetDetail`, add `absPath: String?` (`abs_path`), `size: Int64?`, `place: CloudPlace?`, `vision: CloudVision?`, `faces: [CloudFace]?`. New structs `CloudPlace` (display_name + structured address fields: city/town/village, state, country + `rollups`), `CloudVision` (caption, subjects[], scene_type, setting, activity, time_of_day, lighting, weather, mood, colors[], shot_type, is_screenshot, text_visible), `CloudFace` (person_id?, confidence?). Expand `CloudEnrichmentSections` with `place`, `vision`, `faces` projections (trimmed/empty-collapsed). Add `func detail(address: String) async throws -> CloudAssetDetail` calling `GET /api/assets/by-address?address=<pct-encoded>`; keep `detail(assetID:)` for compatibility.
- Consumes: nothing from other tasks.

- [ ] Write tests: decode a full DTO fixture → place/vision/faces populated; `sections` collapses an all-empty vision to `nil`; a screenshot flag surfaces. Decode a minimal DTO (description only) → new fields `nil`, existing behavior unchanged.
- [ ] Add the model structs + expanded fields/CodingKeys + `sections` projection; add `detail(address:)`.
- [ ] `swift test ... --filter CloudAssetDetail` → PASS.
- [ ] Commit.

### Task 4: `prepareCloudSession` populates `AssetRef.catalog`

**Files:**
- Modify: `src/apple/Maple/Views/AppShell+CloudActions.swift` (the `AssetRef(...)` build at ~437-442)

**Interfaces:**
- Consumes: `CatalogRef` (Task 1), `SearchAsset.address` (Task 2).
- Produces: the cloud `AssetRef` now carries `catalog: CatalogRef(serverID: server, folderID: asset.folder_id, absPath: asset.abs_path, address: asset.address)`. Use the canonical `server` param (registry key), not `effectiveServer`.

- [ ] Add `catalog:` to the `AssetRef(...)` initializer in `prepareCloudSession`.
- [ ] Build MapleApp (macOS) to confirm it compiles.
- [ ] Commit.

### Task 5: reveal-containing-folder action

**Files:**
- Create: `src/apple/Maple/Views/RevealFolderAction.swift` (the `EnvironmentKey` + `EnvironmentValues` accessor + a small `RevealFolderAction` wrapper struct so `nil` = inert)
- Modify: `src/apple/Maple/Views/AppShell+CloudActions.swift` or a new `AppShell+Reveal.swift` — add `@MainActor func revealContainingFolder(of asset: AssetRef)`
- Modify: `src/apple/Maple/Views/AppShell.swift` — set `.environment(\.revealFolderAction, ...)` at the root (near the existing cloud-client `.environment` sites)
- Modify: `src/apple/Maple/Views/PreviewView.swift` — re-inject `revealFolderAction` onto the info sheet/inspector content (same boundary as `cloudAssetDetailClient`)
- Test: `src/apple/MapleTests/RevealTargetTests.swift` (pure derivation, no UI)

**Interfaces:**
- Consumes: `AssetRef.catalog` (Task 1); existing `loadCloudLibrary(serverID:folderID:libraryPath:)`, `openSubFolder(url:rootBookmark:)`, `openSavedFolder(_:)`, `mode`, `libraryPath`.
- Produces: `revealContainingFolder(of:)`; `@MainActor struct RevealFolderAction { let run: (AssetRef) -> Void; func callAsFunction(_ a: AssetRef) }`; `EnvironmentValues.revealFolderAction: RevealFolderAction?`. Pure helper `static func revealTarget(for: AssetRef) -> RevealTarget` returning `.cloud(serverID,folderID,libraryPath)` / `.local(URL)` / `.none` for unit testing.

- [ ] Write `RevealTargetTests`: cloud ref (has `catalog`) → `.cloud` with `libraryPath == dirname(absPath)`; local ref (has `primaryURL`) → `.local(parent)`; PhotoKit ref (no url, no catalog) → `.none`.
- [ ] Implement the pure `revealTarget(for:)` + `revealContainingFolder(of:)` (dispatch, then `mode = .browse` / iOS `libraryPath = []`) + the environment plumbing; re-inject at the Preview boundary.
- [ ] `swift test ... --filter RevealTarget` → PASS; macOS + iOS-sim build compiles.
- [ ] Commit.

### Task 6: info-pane UI — overview rows + Place/Vision/Faces sections

**Files:**
- Modify: `src/apple/Maple/Views/DetailPanel+VM.swift` + `ImageMetadataReader` — extract `DateTimeOriginal` (→ formatted "Taken") and `PixelXDimension`/`PixelYDimension` (→ "W × H") from the already-read EXIF properties
- Modify: `src/apple/Maple/Views/InfoPanel/CameraLocationGrid.swift` + `InfoPanelView+VM.swift` — add Taken, Dimensions, Path (clickable → `revealFolderAction`), Size rows; populate City from detail `place` instead of `"—"`
- Create: `src/apple/Maple/Views/InfoPanel/PlaceBlock.swift`, `VisionBlock.swift`, `FacesBlock.swift` (mirror the web `info-place`/`info-vision`/`info-faces` field selection; each driven by `CloudEnrichmentSections`)
- Modify: `src/apple/Maple/Views/InfoPanel/EnrichmentBlock.swift` — switch the fetch to `client.detail(address: asset.catalog?.address ?? …)`; render Place/Vision/Faces alongside description/OCR/transcript
- Modify: `src/apple/Maple/Views/InfoPanel/InfoPanelView.swift` — no structural change (sections already composed via `CameraLocationGrid` + `EnrichmentBlock`); confirm ordering matches web
- Test: extend `InfoPanelView+VM` tests + a `CloudEnrichmentSections` projection test for the new sections

**Interfaces:**
- Consumes: `CloudEnrichmentSections` (Task 3), `AssetRef.catalog` (Task 1), `revealFolderAction` (Task 5), EXIF date/dimensions (this task).

- [ ] Write VM tests: EXIF with `DateTimeOriginal` → formatted Taken string; EXIF with pixel dims → "6000 × 4000"; a `place` with `city` → City row non-dash; empty enrichment → sections hidden.
- [ ] Implement EXIF extraction, overview rows (incl. clickable Path calling `revealFolderAction`), City-from-place, and the three new section views; switch `EnrichmentBlock` to address-based fetch.
- [ ] `swift test` (InfoPanel/enrichment filters) → PASS; macOS + iOS-sim build.
- [ ] Commit.

### Task 7: end-to-end verification

**Files:** none (verification only).

- [ ] `swift test --package-path src/apple/Packages/MapleCore` (full MapleCore + MapleCloudKit) green; `swift test` for the MapleTests reveal test green.
- [ ] `xcodebuild -project src/apple/Maple.xcodeproj -scheme "Maple Exposure" -destination 'platform=macOS' build` and an iOS-sim build both succeed (rebuild xcframework first if the build fails on missing FFI members — known gotcha).
- [ ] Run against a signed-in cloud library: open an image from **Search**, confirm the info pane shows Taken, Path, Size, Dimensions, City, Description, OCR, Transcript, Vision, Faces; click the Path and confirm it navigates to the containing folder from the inline pane and the iPhone sheet.
- [ ] Open PR with `Closes #2518`, ready for review.

## Self-Review

- **Spec coverage:** identifier fix (Tasks 1–4), address fetch (Task 3), reveal action (Task 5), overview rows + Place/Vision/Faces + City-from-place (Task 6), verification incl. cloud run (Task 7). All spec sections mapped.
- **Placeholders:** none — each task names concrete files, types, and test intent.
- **Type consistency:** `CatalogRef`, `CloudEnrichmentSections`, `revealFolderAction`, `revealTarget(for:)` names used consistently across tasks.
