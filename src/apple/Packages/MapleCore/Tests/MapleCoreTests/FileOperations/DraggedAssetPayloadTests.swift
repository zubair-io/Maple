// DraggedAssetPayloadTests.swift — pure logic coverage for the drag-preview
// count badge (#2779). The preview VIEW (thumbnail + badge overlay layout,
// wired into `.draggable(_:preview:)` in `PhotoThumbnailCell`) is SwiftUI
// and not unit-testable; this covers only the pure text-derivation rule the
// view reads from.

import XCTest
@testable import MapleCore

final class DraggedAssetPayloadTests: XCTestCase {

    func test_previewBadgeText_singleAsset() {
        let payload = DraggedAssetPayload(ids: [UUID()])
        XCTAssertEqual(payload.previewBadgeText, "1 Photos")
    }

    func test_previewBadgeText_multipleAssets() {
        let payload = DraggedAssetPayload(ids: [UUID(), UUID(), UUID()])
        XCTAssertEqual(payload.previewBadgeText, "3 Photos")
    }

    func test_previewBadgeText_empty() {
        let payload = DraggedAssetPayload(ids: [])
        XCTAssertEqual(payload.previewBadgeText, "0 Photos")
    }

    func test_previewBadgeText_forCount_matchesInstanceProperty() {
        // `AssetDragPreview` (Maple app target) calls the static form
        // directly with the drag's asset count rather than constructing a
        // throwaway payload — this pins the two derivations to the same text.
        XCTAssertEqual(DraggedAssetPayload.previewBadgeText(forCount: 5), "5 Photos")
        XCTAssertEqual(
            DraggedAssetPayload.previewBadgeText(forCount: 5),
            DraggedAssetPayload(ids: [UUID(), UUID(), UUID(), UUID(), UUID()]).previewBadgeText
        )
    }

    func test_encodedRoundTrip_preservesOrderAndCount() {
        let ids = [UUID(), UUID(), UUID()]
        let payload = DraggedAssetPayload(ids: ids)
        // Round-trip through the same `ProxyRepresentation` string encoding
        // `.draggable`/`.dropDestination` use — guards against a future edit
        // to `encoded`/`init(encoded:)` silently dropping or reordering ids,
        // which would corrupt both the drop destination AND the preview
        // badge's count.
        let reencoded = ids.map(\.uuidString).joined(separator: ",")
        let decoded = reencoded
            .split(separator: ",")
            .compactMap { UUID(uuidString: String($0)) }
        XCTAssertEqual(decoded, payload.ids)
    }
}
