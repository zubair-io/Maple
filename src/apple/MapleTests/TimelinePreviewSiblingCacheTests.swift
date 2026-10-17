// TimelinePreviewSiblingCacheTests.swift — #4714.
//
// `PhoneTabShell` asks the shell for the Timeline sibling list on every
// redraw. Each build minted fresh `AssetRef.id`s, so `PreviewDestination`
// could no longer find the shown asset by id and snapped back to the tapped
// photo. The cache hands back the SAME refs until the Timeline content it
// was built from actually changes.

import Foundation
import MapleCore
import XCTest

@testable import Maple

@MainActor
final class TimelinePreviewSiblingCacheTests: XCTestCase {

  private func refs(_ names: [String]) -> [AssetRef] {
    names.map { AssetRef.preview(displayName: $0) }
  }

  func testSameKeyReturnsTheSameRefsWithoutRebuilding() {
    let cache = TimelinePreviewSiblingCache()
    var builds = 0
    let key = TimelinePreviewSiblingCache.Key(fingerprint: 42)

    let first = cache.assets(for: key) { builds += 1; return refs(["a.dng", "b.dng"]) }
    let second = cache.assets(for: key) { builds += 1; return refs(["a.dng", "b.dng"]) }

    XCTAssertEqual(builds, 1, "the list must be built once per Timeline content")
    XCTAssertEqual(first.map(\.id), second.map(\.id), "ids must survive a redraw")
  }

  func testChangedKeyRebuilds() {
    let cache = TimelinePreviewSiblingCache()
    var builds = 0

    let first = cache.assets(for: .init(fingerprint: 1)) { builds += 1; return refs(["a.dng"]) }
    let second = cache.assets(for: .init(fingerprint: 2)) { builds += 1; return refs(["a.dng", "b.dng"]) }

    XCTAssertEqual(builds, 2)
    XCTAssertNotEqual(first.map(\.id), second.map(\.id))
    XCTAssertEqual(second.count, 2)
  }
}
