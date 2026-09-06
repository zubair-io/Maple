// ScopeLayerSelectionTests.swift — the scope must follow the selection
// (#3355), and arming Mask must fit the canvas (#3351).
//
// Both bugs were invisible to the existing suites because both were a
// hardcoded constant and a missing branch, not broken logic: raw-ffi's
// `scope_layer` weighting worked, and `zoom.resetToFit()` worked. Nothing
// asserted that the Apple shell actually asked for either.

import XCTest

@testable import MapleCore

final class ScopeLayerSelectionTests: XCTestCase {
    private func layer(_ hue: Double) -> LocalAdjustment {
        LocalAdjustment(mask: .everywhere, adjustments: PartialAdjustments(hue: hue))
    }

    /// No selection means "weigh the whole frame" — raw-ffi's contract for a
    /// negative `scope_layer`.
    @MainActor
    func testNoSelectionScopesWholeFrame() {
        let session = EditSession(asset: AssetRef(url: URL(fileURLWithPath: "/dev/null")))
        session.model.localAdjustments = [layer(10), layer(20)]
        session.selectedMaskId = nil
        XCTAssertEqual(session.scopeLayerIndex, -1)
    }

    /// Selecting a layer scopes THAT layer — the index raw-ffi weighs by.
    @MainActor
    func testSelectedLayerScopesThatLayersIndex() {
        let session = EditSession(asset: AssetRef(url: URL(fileURLWithPath: "/dev/null")))
        let first = layer(10)
        let second = layer(20)
        session.model.localAdjustments = [first, second]

        session.selectedMaskId = first.id
        XCTAssertEqual(session.scopeLayerIndex, 0)
        session.selectedMaskId = second.id
        XCTAssertEqual(
            session.scopeLayerIndex, 1,
            "the scope must follow the selection, not stay on the first layer")
    }

    /// A stale selection (layer deleted) falls back to the whole frame
    /// rather than indexing out of bounds.
    @MainActor
    func testStaleSelectionFallsBackToWholeFrame() {
        let session = EditSession(asset: AssetRef(url: URL(fileURLWithPath: "/dev/null")))
        let gone = layer(10)
        session.model.localAdjustments = [layer(20)]
        session.selectedMaskId = gone.id
        XCTAssertEqual(session.scopeLayerIndex, -1)
    }
}
