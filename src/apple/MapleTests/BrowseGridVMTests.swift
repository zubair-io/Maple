// BrowseGridVMTests.swift — unit tests for the pure helpers in
// `Maple/Views/BrowseGrid+VM.swift`.
//
// Lives in the MapleTests Xcode target (not MapleCore) because `BrowseGridVM`
// is declared in the app target, per the `+VM.swift` co-location pattern —
// same as PreviewViewVMTests / FullImageViewVMTests / InfoPanelVMTests.
//
// Focus: the Photos-permission panel's two states (#2454). The distinction
// carries real behaviour, not just copy — once the user declines, iOS never
// shows the system prompt again, so offering Connect there would be a button
// that silently does nothing. The selector is what keeps that decision out of
// the view and under test.

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

final class BrowseGridVMTests: XCTestCase {

    // MARK: - Empty-state branch selection

    func testUndecidedPhotosAuthSelectsTheConnectBranch() {
        let secondary = BrowseGridVM.emptyStateSecondary(.init(
            photosAuthNeeded: true,
            photosAuthCanRequest: true,
            isLoading: false,
            hasLoadError: false,
            hasCurrentSource: false
        ))
        XCTAssertEqual(secondary, .photosAuthConnect)
    }

    func testDeclinedPhotosAuthSelectsTheSettingsBranch() {
        let secondary = BrowseGridVM.emptyStateSecondary(.init(
            photosAuthNeeded: true,
            photosAuthCanRequest: false,
            isLoading: false,
            hasLoadError: false,
            hasCurrentSource: false
        ))
        XCTAssertEqual(secondary, .photosAuthSettings)
    }

    /// The permission branch outranks loading/error/source — a user who owes
    /// us access should see the panel, not a spinner over an empty grid.
    func testPhotosAuthOutranksEveryOtherEmptyStateBranch() {
        let secondary = BrowseGridVM.emptyStateSecondary(.init(
            photosAuthNeeded: true,
            photosAuthCanRequest: true,
            isLoading: true,
            hasLoadError: true,
            hasCurrentSource: true
        ))
        XCTAssertEqual(secondary, .photosAuthConnect)
    }

    func testNonPhotosEmptyStatesAreUnaffectedByTheCanRequestFlag() {
        for canRequest in [true, false] {
            let secondary = BrowseGridVM.emptyStateSecondary(.init(
                photosAuthNeeded: false,
                photosAuthCanRequest: canRequest,
                isLoading: true,
                hasLoadError: false,
                hasCurrentSource: false
            ))
            XCTAssertEqual(secondary, .loading,
                           "canRequest=\(canRequest) must not leak into non-Photos branches")
        }
    }

    // MARK: - Panel copy

    func testConnectStateInvitesAndSettingsStateExplains() {
        XCTAssertEqual(BrowseGridVM.photosAuthTitle(canRequest: true),
                       "Connect your Photos library")
        XCTAssertEqual(BrowseGridVM.photosAuthTitle(canRequest: false),
                       "Photos access is turned off")
    }

    func testButtonTitleMatchesWhatTheButtonCanActuallyDo() {
        XCTAssertEqual(BrowseGridVM.photosAuthButtonTitle(canRequest: true), "Connect")
        XCTAssertEqual(BrowseGridVM.photosAuthButtonTitle(canRequest: false), "Open Settings")
    }

    /// The undecided copy has to carry the non-destructive promise — it's the
    /// reassurance the user is being asked to act on.
    func testConnectBodyStatesOriginalsAreNeverModified() {
        let body = BrowseGridVM.photosAuthBody(canRequest: true)
        XCTAssertTrue(body.contains("never modified"), body)
    }

    /// The declined copy has to say where to go, since the prompt is spent.
    func testSettingsBodyPointsAtSettings() {
        let body = BrowseGridVM.photosAuthBody(canRequest: false)
        XCTAssertTrue(body.contains("Settings"), body)
    }

    // MARK: - Primary title

    func testPrimaryTitleTracksThePanelStateAndFallsBackOtherwise() {
        XCTAssertEqual(
            BrowseGridVM.emptyStatePrimaryTitle(photosAuthNeeded: true, photosAuthCanRequest: true),
            "Connect your Photos library")
        XCTAssertEqual(
            BrowseGridVM.emptyStatePrimaryTitle(photosAuthNeeded: true, photosAuthCanRequest: false),
            "Photos access is turned off")
        XCTAssertEqual(
            BrowseGridVM.emptyStatePrimaryTitle(photosAuthNeeded: false, photosAuthCanRequest: true),
            "No assets yet")
    }
}
