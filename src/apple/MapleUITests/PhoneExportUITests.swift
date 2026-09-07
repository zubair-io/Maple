// PhoneExportUITests.swift — iPhone editor Export flow gate (#3403).
//
// The bug this guards: on the phone shell the editor's Share button was
// wired to an empty closure (`EditorDestination` passed `onShare: {}`),
// so tapping it did nothing — no panel, no file. The desktop/iPad hosts
// wired their own sheet, which is why every existing editor gate (all
// macOS-driven) never saw it. The fix moves the export sheet into
// `EditorView` itself, so this test asserts the whole phone flow: Share →
// Export panel → Export → system share sheet holding the rendered file.
//
// Runs on an iPhone simulator:
//
//   xcodebuild test \
//     -project src/apple/Maple.xcodeproj \
//     -scheme "Maple Exposure" \
//     -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
//     -only-testing:MapleUITests/PhoneExportUITests
//
// Needs `test-fixtures/raws/test_0017.dng`, located by `UITestFixtureRoot`
// (#2366: the scheme's `TEST_RUNNER_MAPLE_UITEST_FIXTURE_ROOT` reaches the
// iOS runner unexpanded, so the compile-time repo root is what resolves it
// here) and skip-passes without it, like the other fixture-gated gates.
// `MapleAppDriver` is macOS-only (AppKit), so the fixture is staged here.

import XCTest

#if os(iOS)
  import UIKit

  final class PhoneExportUITests: XCTestCase {
    override func setUpWithError() throws {
      continueAfterFailure = false
      try XCTSkipUnless(
        UIDevice.current.userInterfaceIdiom == .phone,
        "Phone-shell gate — the iPad/Mac editor hosts are covered by the macOS harnesses.")
    }

    func testShareButtonPresentsTheExportPanelAndShareSheet() throws {
      let fixtureURL = try UITestFixtureRoot.locate("test_0017.dng")
      // Stage a private copy so the app's library root (and its `.maple/`
      // cache) is a throwaway directory, not the shared fixture tree.
      let staged = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-phone-export-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: staged, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: staged) }
      try FileManager.default.copyItem(
        at: fixtureURL, to: staged.appendingPathComponent(fixtureURL.lastPathComponent))

      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixtureURL.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = staged.path
      app.launch()

      let canvas = app.descendants(matching: .any)
        .matching(
          NSPredicate(format: "label == 'Editor canvas' AND value == 'canvas-render-ready'")
        )
        .firstMatch
      XCTAssertTrue(canvas.waitForExistence(timeout: 90), "editor canvas never became ready")

      // The pill's trailing controls scroll horizontally on compact width;
      // drag the pill row left until Share is on screen.
      let share = app.buttons["editor-share"]
      XCTAssertTrue(share.waitForExistence(timeout: 10), "editor Share button missing")
      if !share.isHittable {
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.08))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.08))
        from.press(forDuration: 0.05, thenDragTo: to)
      }
      XCTAssertTrue(share.isHittable, "editor Share button never scrolled into view")
      share.tap()

      let export = app.buttons["export-confirm"]
      XCTAssertTrue(export.waitForExistence(timeout: 10), "Share did not present the Export panel")
      attach(app.screenshot(), name: "Export panel")
      export.tap()

      // Full-quality render + encode of the fixture, then the system share
      // sheet (`UIActivityViewController`) with the staged file. The sheet
      // is hosted by UIKit as "ActivityListView"; a Close control is the
      // fallback identity on OS builds that don't expose that id.
      let shareSheet = app.otherElements["ActivityListView"]
      let close = app.buttons["Close"]
      let presented = NSPredicate { _, _ in shareSheet.exists || close.exists }
      let expectation = XCTNSPredicateExpectation(predicate: presented, object: nil)
      XCTAssertEqual(
        XCTWaiter().wait(for: [expectation], timeout: 240), .completed,
        "Export never presented the share sheet")
      attach(app.screenshot(), name: "Share sheet")
    }

    private func attach(_ screenshot: XCUIScreenshot, name: String) {
      let attachment = XCTAttachment(screenshot: screenshot)
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }
#endif
