// PreviewViewVMTests.swift — unit tests for the pure helpers in
// `Maple/Views/PreviewView+VM.swift` (Fast Preview epic, design doc
// 2026-07-06-fast-preview-and-phone-card-editor-design.md §4 / §6).
//
// Lives in the MapleTests Xcode target (not MapleCore) because `PreviewViewVM`
// is declared in the app target — that's where the view + its VM sibling live
// (per the `+VM.swift` co-location pattern, same as FullImageViewVMTests /
// InfoPanelVMTests). MapleTests is host-targeted on Maple Exposure.app, so
// `@testable import Maple_Exposure` reaches app-target types (the module name
// replaces the space with an underscore).
//
// Focus: prev/next selection (wrap + clamp edge cases), swipe classification
// (threshold + horizontal dominance), and the image-source selection. UI
// wiring (gestures, layout) is verified by building, not here.

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

final class PreviewViewVMTests: XCTestCase {

  // MARK: - Fixtures

  /// Four assets with stable ids, in a known order.
  private func makeAssets(_ n: Int) -> [AssetRef] {
    (0..<n).map { AssetRef.preview(displayName: "IMG_000\($0).dng") }
  }

  // MARK: - nextID

  func testNextIDAdvancesToTheFollowingAsset() {
    let assets = makeAssets(4)
    let ids = assets.map(\.id)
    XCTAssertEqual(
      PreviewViewVM.nextID(after: ids[0], in: ids),
      ids[1])
    XCTAssertEqual(
      PreviewViewVM.nextID(after: ids[2], in: ids),
      ids[3])
  }

  func testNextIDWrapsPastTheEndByDefault() {
    let ids = makeAssets(3).map(\.id)
    XCTAssertEqual(
      PreviewViewVM.nextID(after: ids[2], in: ids),
      ids[0], "stepping off the end should wrap to the first asset")
  }

  func testNextIDClampsPastTheEndWhenWrapsIsFalse() {
    let ids = makeAssets(3).map(\.id)
    XCTAssertNil(
      PreviewViewVM.nextID(after: ids[2], in: ids, wraps: false),
      "with wraps:false the last asset has no next")
  }

  func testNextIDReturnsFirstWhenNoSelection() {
    let ids = makeAssets(3).map(\.id)
    XCTAssertEqual(
      PreviewViewVM.nextID(after: nil, in: ids),
      ids[0], "no current selection starts at the front")
  }

  func testNextIDReturnsNilForEmptyList() {
    XCTAssertNil(PreviewViewVM.nextID(after: nil, in: []))
    XCTAssertNil(PreviewViewVM.nextID(after: UUID(), in: []))
  }

  func testNextIDReturnsNilWhenCurrentNotPresent() {
    let ids = makeAssets(3).map(\.id)
    // A stale/foreign id has no anchor in the list — no defined "next".
    XCTAssertNil(PreviewViewVM.nextID(after: UUID(), in: ids))
  }

  // MARK: - previousID

  func testPreviousIDStepsBack() {
    let ids = makeAssets(4).map(\.id)
    XCTAssertEqual(
      PreviewViewVM.previousID(before: ids[3], in: ids),
      ids[2])
    XCTAssertEqual(
      PreviewViewVM.previousID(before: ids[1], in: ids),
      ids[0])
  }

  func testPreviousIDWrapsPastTheFrontByDefault() {
    let ids = makeAssets(3).map(\.id)
    XCTAssertEqual(
      PreviewViewVM.previousID(before: ids[0], in: ids),
      ids[2], "stepping off the front should wrap to the last asset")
  }

  func testPreviousIDClampsPastTheFrontWhenWrapsIsFalse() {
    let ids = makeAssets(3).map(\.id)
    XCTAssertNil(
      PreviewViewVM.previousID(before: ids[0], in: ids, wraps: false),
      "with wraps:false the first asset has no previous")
  }

  func testPreviousIDReturnsLastWhenNoSelection() {
    let ids = makeAssets(3).map(\.id)
    XCTAssertEqual(
      PreviewViewVM.previousID(before: nil, in: ids),
      ids[2])
  }

  func testPreviousIDReturnsNilForEmptyList() {
    XCTAssertNil(PreviewViewVM.previousID(before: nil, in: []))
  }

  // MARK: - Single-element list

  func testSingleElementWrapsToItself() {
    let ids = makeAssets(1).map(\.id)
    XCTAssertEqual(PreviewViewVM.nextID(after: ids[0], in: ids), ids[0])
    XCTAssertEqual(PreviewViewVM.previousID(before: ids[0], in: ids), ids[0])
  }

  // MARK: - thumbnailSource

  func testThumbnailSourceIsLocalBackendForFilesystemAsset() {
    let asset = AssetRef.preview()
    let src = PreviewViewVM.thumbnailSource(for: asset, source: nil)
    guard case let .local(ref, box) = src else {
      return XCTFail("expected .local ThumbnailSource, got \(src)")
    }
    XCTAssertEqual(ref.id, asset.id)
    // A nil ImageSource still yields a (nil-boxed) source — the loader's
    // local branch resolves off primaryURL in that case.
    XCTAssertNil(box?.source)
  }

  // MARK: - thumbnailSource provenance (#2299)
  //
  // The unified Timeline's iPhone Preview sibling list mixes PhotoKit-local
  // cells with cloud cells from several servers in one `[AssetRef]` — there
  // is no single ambient `ImageSource` that's correct for every asset in it.
  // `AssetRef.thumbnailProvenance` lets a PhotoKit-backed ref route to
  // `.photoKit(localID:)` INTRINSICALLY, regardless of what the caller
  // happens to pass as `source` (nil, or even some other asset's source).

  private func makePhotoKitBackedAsset(stableID: String) -> AssetRef {
    AssetRef(
      displayName: "IMG_\(stableID).heic",
      hintExtension: "heic",
      stableID: stableID,
      thumbnailProvenance: .photoKit,
      bytesProvider: { Data() }
    )
  }

  func testThumbnailSourceRoutesPhotoKitProvenanceToPhotoKitWithNilSource() {
    let asset = makePhotoKitBackedAsset(stableID: "phasset-local-id-1")
    let src = PreviewViewVM.thumbnailSource(for: asset, source: nil)
    guard case let .photoKit(localID) = src else {
      return XCTFail("expected .photoKit ThumbnailSource, got \(src)")
    }
    XCTAssertEqual(localID, "phasset-local-id-1")
  }

  func testThumbnailSourceRoutesPhotoKitProvenanceToPhotoKitEvenWithANonPhotoKitAmbientSource() {
    // A non-PhotoKit `ImageSource` standing in for "the ambient source
    // actually belongs to a DIFFERENT cell in a mixed list" (e.g. the
    // unified Timeline's `browseVM.currentSource`, which is nil, or a cloud
    // `CloudSource` if one were ever threaded through). Provenance must win
    // regardless — the routing must NOT depend on `source is PhotoKitSource`.
    let asset = makePhotoKitBackedAsset(stableID: "phasset-local-id-2")
    let src = PreviewViewVM.thumbnailSource(for: asset, source: FakeNonPhotoKitImageSource())
    guard case let .photoKit(localID) = src else {
      return XCTFail("expected .photoKit ThumbnailSource, got \(src)")
    }
    XCTAssertEqual(localID, "phasset-local-id-2")
  }

  func testThumbnailSourceRoutesCloudProvenanceRefToLocal() {
    // Cloud/file assets keep their current resolution — `.cloud(server:)`
    // provenance is consulted by `AppShell.ensureSession` on activation, NOT
    // by `thumbnailSource`, which still resolves a cloud ref through its own
    // `bytesProvider` via the shared `.local` route.
    let asset = AssetRef(
      displayName: "IMG_3.dng",
      hintExtension: "dng",
      stableID: "fs:/library/IMG_3.dng",
      thumbnailProvenance: .cloud(server: URL(string: "https://cloud.example.invalid")!),
      bytesProvider: { Data() }
    )
    let src = PreviewViewVM.thumbnailSource(for: asset, source: nil)
    guard case let .local(ref, _) = src else {
      return XCTFail("expected .local ThumbnailSource, got \(src)")
    }
    XCTAssertEqual(ref.id, asset.id)
  }

  // MARK: - filenameMaxWidth (spec §6)

  func testFilenameMaxWidthIsResponsiveToSizeClass() {
    // Regular (iPad/Mac): the full 200pt ceiling, matching the Web fix's
    // 200px cap. Compact (narrow iPhone): a tighter 150pt so a long name
    // can't crowd the header's icon buttons. Both PillHeader (editor) and
    // PreviewView's header read this, so the two truncate identically.
    XCTAssertEqual(PreviewViewVM.filenameMaxWidth(isCompact: false), 200)
    XCTAssertEqual(PreviewViewVM.filenameMaxWidth(isCompact: true), 150)
  }

  func testFilenameMaxWidthNeverExceedsWebCeiling() {
    // Parity guard: neither size class may exceed the Web §6 200px ceiling.
    XCTAssertLessThanOrEqual(PreviewViewVM.filenameMaxWidth(isCompact: false), 200)
    XCTAssertLessThanOrEqual(PreviewViewVM.filenameMaxWidth(isCompact: true), 200)
  }
}

// MARK: - Test fixtures

/// Minimal `ImageSource` conformance standing in for "some OTHER asset's
/// source" in a mixed list (#2299) — every method is unreachable in these
/// tests; only the TYPE (not `PhotoKitSource`) matters for the
/// `source is PhotoKitSource` fallback check in `thumbnailSource`.
private actor FakeNonPhotoKitImageSource: ImageSource {
  func images() async throws -> [ImageRef] { [] }
  func thumb(for ref: ImageRef) async throws -> Data? { nil }
  func preview(for ref: ImageRef) async throws -> Data? { nil }
  func rawBytes(for ref: ImageRef) async throws -> Data { Data() }
  func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
  func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
}
