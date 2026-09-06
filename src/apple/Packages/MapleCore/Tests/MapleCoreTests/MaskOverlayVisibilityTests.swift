// MaskOverlayVisibilityTests.swift — #3364.
//
// The overlay answers "what is selected", which is what you want while
// picking a mask and exactly what you do not want while dragging its
// sliders: a red wash over the subject hides the adjustment being made.
// The decision lives on `EditSession` rather than inside the SwiftUI view
// so it can be asserted here — the app target's own tests do not run in CI.

import XCTest

@testable import MapleCore

@MainActor
final class MaskOverlayVisibilityTests: XCTestCase {
    private func session() -> EditSession {
        EditSession(asset: AssetRef(url: URL(fileURLWithPath: "/dev/null")))
    }

    private func layer() -> LocalAdjustment {
        LocalAdjustment(mask: .everywhere, adjustments: PartialAdjustments(hue: 0))
    }

    func testHiddenWithNoSelection() {
        let s = session()
        XCTAssertFalse(s.showsMaskOverlay, "nothing selected — nothing to outline")
    }

    func testShownWhenALayerIsSelected() {
        let s = session()
        let l = layer()
        s.model.localAdjustments = [l]
        s.selectedMaskId = l.id
        XCTAssertTrue(s.showsMaskOverlay)
    }

    /// The behaviour this ticket exists for: the tint gets out of the way
    /// for the duration of the drag, then comes back.
    func testHiddenWhileAdjustingAndRestoredOnRelease() {
        let s = session()
        let l = layer()
        s.model.localAdjustments = [l]
        s.selectedMaskId = l.id

        s.isAdjustingMask = true
        XCTAssertFalse(
            s.showsMaskOverlay,
            "a red wash over the subject hides the adjustment being made")

        s.isAdjustingMask = false
        XCTAssertTrue(s.showsMaskOverlay, "the overlay must come back on release")
    }

    /// Releasing a drag with nothing selected must not resurrect it.
    func testReleaseDoesNotShowOverlayWithoutSelection() {
        let s = session()
        s.isAdjustingMask = true
        s.isAdjustingMask = false
        XCTAssertFalse(s.showsMaskOverlay)
    }
}
