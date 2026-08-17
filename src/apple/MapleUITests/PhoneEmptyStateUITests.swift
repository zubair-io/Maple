// PhoneEmptyStateUITests.swift — iPhone Library-tab empty-state gate (#2924).
//
// The bug this guards: `LibraryGrid` (the phone Library grid) had no
// empty-state branch at all. With zero assets its body was an empty
// `ScrollView`, so a user without PhotoKit permission got a blank screen
// and no route to the "Connect your Photos library" panel (#2454) — the
// only place in the app that raises the system permission prompt. The
// Mac / iPad `BrowseGrid` rendered the panel the whole time, which is why
// this survived: every existing gate ran on the desktop path.
//
// Runs on an iPhone simulator:
//
//   xcodebuild test \
//     -project src/apple/Maple.xcodeproj \
//     -scheme "Maple Exposure" \
//     -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
//     -only-testing:MapleUITests/PhoneEmptyStateUITests
//
// Needs no fixtures — the whole point is the no-content state. It does
// need the app to be un-authorized for Photos, which is the state of a
// freshly installed simulator app. When the library IS authorized the
// grid legitimately fills with photos and there's no permission panel to
// assert, so the test XCTSkips rather than failing — same skip-pass
// convention the fixture-gated harnesses use.

import XCTest

#if os(iOS)
import UIKit

final class PhoneEmptyStateUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipUnless(
            UIDevice.current.userInterfaceIdiom == .phone,
            "Phone-shell gate — the iPad/Mac path renders BrowseGrid, covered elsewhere."
        )
    }

    /// Select the Photos library from the drawer on a build that has no
    /// Photos permission, and assert the permission panel takes over the
    /// grid. Before #2924 this assertion failed on a blank screen.
    func testPhotosPermissionPanelIsReachableFromTheLibraryTab() throws {
        let app = XCUIApplication()
        app.launch()

        // The grid surface itself must exist before anything else is
        // meaningful — it's the identifier the empty state and the
        // populated grid share, so its absence is a shell failure rather
        // than an empty-state failure.
        let grid = app.otherElements["library-grid"]
        XCTAssertTrue(grid.waitForExistence(timeout: 30),
                      "Library grid never appeared on the phone shell.")

        // Open the drawer and pick All Photos. Deliberately NOT relying on
        // the cold-start auto-pick: this test asserts the panel is
        // reachable by the route a user actually takes, and stays valid
        // whatever `autoPickInitialSource()` chooses.
        app.buttons["Library"].tap()
        let allPhotos = app.buttons["All Photos"]
        XCTAssertTrue(allPhotos.waitForExistence(timeout: 10),
                      "Drawer did not offer the All Photos row.")
        allPhotos.tap()

        let panel = app.otherElements["photos-auth-panel"]
        guard panel.waitForExistence(timeout: 15) else {
            // Either the library is authorized (photos loaded, no panel is
            // correct) or we regressed. Distinguish the two so an
            // authorized simulator skips instead of reporting a false
            // failure — and so a genuine regression still fails.
            let cells = app.cells.count + app.images.count
            try XCTSkipIf(
                cells > 0,
                "Photo library is authorized on this simulator — no permission panel to assert. "
                + "Erase the simulator (xcrun simctl erase) to exercise this gate."
            )
            return XCTFail("No permission panel and no photos: the phone Library tab is blank.")
        }

        // The panel is only useful if its action is live. `onGrantPhotosAccess`
        // was never threaded into LibraryGrid, so before #2924 the Connect
        // button rendered `.disabled` even once the panel existed.
        let connect = panel.buttons.firstMatch
        XCTAssertTrue(connect.exists, "Permission panel rendered without an action button.")
        XCTAssertTrue(connect.isEnabled,
                      "Connect button is disabled — onGrantPhotosAccess was not wired through.")
    }
}

#endif
