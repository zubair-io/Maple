// ThumbnailProviderDisplayPreviewTests.swift — #2385.
//
// `ThumbnailProvider.preview(for:)`'s URL-less branch used to have exactly one
// way to reach a display-sized preview: the ambient `ImageSource` boxed into
// the `ThumbnailSource`. On the iPhone unified Timeline that ambient source is
// the `CloudSource` for the server owning the asset the user TAPPED, and the
// sibling list it swipes through can span several connected servers — so for a
// sibling on a different server the request went to the wrong host, 404'd, and
// the 1280 px tier never swapped in over the 256 px grid thumbnail.
//
// The fix makes resolution intrinsic to the asset (`AssetRef
// .displayPreviewProvider`, bound to that asset's OWN server at construction),
// mirroring what `AssetRef.thumbnailProvenance` already does for
// `PreviewViewVM.thumbnailSource`. These tests pin the routing: own provider
// wins, and — because a mixed list has no correct ambient fallback — its nil /
// throwing answers are terminal rather than a reason to re-ask the wrong host.
//
// Lives in MapleTests (not MapleCoreTests) because `ThumbnailProvider` is
// app-target: it needs Photos.framework for the PhotoKit backend.

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

final class ThumbnailProviderDisplayPreviewTests: XCTestCase {

  // MARK: - Fixtures

  private let ownBytes = Data("own-server-preview".utf8)
  private let ambientBytes = Data("ambient-source-preview".utf8)

  /// A URL-less cloud-shaped ref, optionally carrying its own display-preview
  /// resolver. `bytesProvider` is never invoked by the display tier — it is
  /// required by the initializer and stands in for the full-RAW fetch.
  private func makeCloudRef(
    displayPreviewProvider: AssetRef.DisplayPreviewProvider? = nil
  ) -> AssetRef {
    AssetRef(
      displayName: "IMG_0007.dng",
      hintExtension: "dng",
      stableID: "fs:/library-on-server-a/IMG_0007.dng",
      thumbnailProvenance: .cloud(server: URL(string: "https://a.example.invalid")!),
      displayPreviewProvider: displayPreviewProvider,
      bytesProvider: { Data() }
    )
  }

  // MARK: - Own provider wins over the ambient source

  func testDisplayPreviewPrefersTheAssetsOwnProviderOverTheAmbientSource() async throws {
    // The regression itself: ambient source answers (it's a live server, just
    // the WRONG one for this asset), and the asset's own resolver answers with
    // different bytes. The asset's own resolver must be what paints.
    let ambient = RecordingImageSource(previewBytes: ambientBytes)
    let own = ownBytes
    let ref = makeCloudRef(displayPreviewProvider: { own })
    let source = ThumbnailSource.local(ref, source: ImageSourceBox(ambient))

    let data = await ThumbnailProvider.local().preview(for: source)

    XCTAssertEqual(data, ownBytes)
    let ambientCalls = await ambient.previewCallCount
    XCTAssertEqual(ambientCalls, 0, "the ambient source must not be consulted at all")
  }

  // MARK: - The own provider's answer is terminal

  func testDisplayPreviewDoesNotFallBackToTheAmbientSourceWhenTheOwnProviderReturnsNil() async {
    // nil means "this asset's OWN server has no preview for it" — a real
    // answer. Re-asking the ambient source would be asking a host that
    // resolves `fs:<abs_path>` against a different machine's filesystem, so
    // any bytes it returned would be wrong, not a graceful fallback.
    let ambient = RecordingImageSource(previewBytes: ambientBytes)
    let ref = makeCloudRef(displayPreviewProvider: { nil })
    let source = ThumbnailSource.local(ref, source: ImageSourceBox(ambient))

    let data = await ThumbnailProvider.local().preview(for: source)

    XCTAssertNil(data)
    let ambientCalls = await ambient.previewCallCount
    XCTAssertEqual(ambientCalls, 0, "the ambient source must not be consulted at all")
  }

  func testDisplayPreviewSwallowsAThrowingOwnProviderWithoutConsultingTheAmbientSource() async {
    // `CloudSource.preview` returns nil on 404 but THROWS on any other non-2xx
    // (and on transport failure). Both must degrade to "keep showing the
    // thumbnail", never to a request against the ambient host.
    let ambient = RecordingImageSource(previewBytes: ambientBytes)
    let ref = makeCloudRef(displayPreviewProvider: {
      throw URLError(.timedOut)
    })
    let source = ThumbnailSource.local(ref, source: ImageSourceBox(ambient))

    let data = await ThumbnailProvider.local().preview(for: source)

    XCTAssertNil(data)
    let ambientCalls = await ambient.previewCallCount
    XCTAssertEqual(ambientCalls, 0, "the ambient source must not be consulted at all")
  }

  // MARK: - Untagged refs keep the ambient route

  func testDisplayPreviewStillUsesTheAmbientSourceForARefWithNoOwnProvider() async {
    // Every pre-#2385 construction site (single-source cloud browse, where the
    // one ambient source really is the one true backend) passes no provider
    // and must be unaffected.
    let ambient = RecordingImageSource(previewBytes: ambientBytes)
    let ref = makeCloudRef()
    let source = ThumbnailSource.local(ref, source: ImageSourceBox(ambient))

    let data = await ThumbnailProvider.local().preview(for: source)

    XCTAssertEqual(data, ambientBytes)
    let ambientCalls = await ambient.previewCallCount
    XCTAssertEqual(ambientCalls, 1)
  }
}

// MARK: - Test fixtures

/// `ImageSource` standing in for the Preview's ambient source — the one
/// belonging to whichever asset the user tapped. Counts `preview(for:)` calls
/// so a test can assert it was never reached, which is the whole point: in a
/// mixed multi-server list it is the wrong host for most of the list.
private actor RecordingImageSource: ImageSource {
  private let previewBytes: Data?
  private(set) var previewCallCount = 0

  init(previewBytes: Data?) { self.previewBytes = previewBytes }

  func images() async throws -> [ImageRef] { [] }
  func thumb(for ref: ImageRef) async throws -> Data? { nil }
  func preview(for ref: ImageRef) async throws -> Data? {
    previewCallCount += 1
    return previewBytes
  }
  func rawBytes(for ref: ImageRef) async throws -> Data { Data() }
  func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
  func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
}
