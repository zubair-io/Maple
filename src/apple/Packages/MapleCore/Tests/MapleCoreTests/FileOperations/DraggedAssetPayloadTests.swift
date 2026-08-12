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
        XCTAssertEqual(payload.previewBadgeText, "1 Photo")
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
        // Drives the type's OWN `encoded` / `init(encoded:)` — the exact pair
        // `ProxyRepresentation` hands to `.draggable`/`.dropDestination`.
        // Re-implementing the comma-join here instead would pass even with
        // both halves broken, proving nothing.
        let ids = [UUID(), UUID(), UUID()]
        let payload = DraggedAssetPayload(ids: ids)

        let decoded = DraggedAssetPayload(encoded: payload.encoded)

        XCTAssertEqual(decoded.ids, ids, "order and count must survive the transfer encoding")
        XCTAssertEqual(decoded, payload)
    }

    func test_encoded_isTheCommaJoinedTransferFormat() {
        // Pins the wire shape itself: a future switch to another separator
        // (or to a JSON blob) is a deliberate change, not a silent one.
        let ids = [UUID(), UUID()]
        XCTAssertEqual(
            DraggedAssetPayload(ids: ids).encoded,
            "\(ids[0].uuidString),\(ids[1].uuidString)")
    }

    func test_initEncoded_dropsUnparseableComponents() {
        // A malformed payload must decode to the ids it CAN read rather than
        // trapping — the drop destination then simply moves fewer assets.
        let good = UUID()
        let decoded = DraggedAssetPayload(encoded: "\(good.uuidString),not-a-uuid,")
        XCTAssertEqual(decoded.ids, [good])
    }

    func test_initEncoded_emptyStringYieldsNoIds() {
        XCTAssertEqual(DraggedAssetPayload(encoded: "").ids, [])
    }
}
