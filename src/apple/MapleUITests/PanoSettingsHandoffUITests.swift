// PanoSettingsHandoffUITests.swift — the panorama sheet's "Set Up in
// Settings → Pano" note must land on Settings' Pano page (#6093).
//
// With the ML matcher switched on but unable to load, the merge falls back to
// the classical matcher and shows that note. On iPhone the request used to set
// a flag no view observed, so the panorama cover closed and Settings never
// appeared.
//
// Exercises the no-models path: with the panorama ML models installed there is no note, so it skips.
//
// Needs `test-fixtures/raws/pano_01/PANO000{1,2,3}.DNG`, located by
// `UITestFixtureRoot` and skip-passed when absent; copies are staged in a
// throwaway directory so the app never reads the fixture tree.

import XCTest

#if os(iOS)
  import UIKit

  final class PanoSettingsHandoffUITests: XCTestCase {
    func testPanoNoteOpensSettingsOnPanoPageEachTime() throws {
      continueAfterFailure = false
      let isPhone = UIDevice.current.userInterfaceIdiom == .phone
      let frames = try (1...3).map {
        try UITestFixtureRoot.locate(String(format: "pano_01/PANO%04d.DNG", $0))
      }
      let staged = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-pano-settings-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: staged, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: staged) }
      for frame in frames {
        try FileManager.default.copyItem(
          at: frame, to: staged.appendingPathComponent(frame.lastPathComponent))
      }

      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = frames[0].lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = staged.path
      app.launchArguments = ["--uitest-browse", "-maple.pano.settings.useMLMatcher.v1", "YES"]
      app.launch()
      defer { app.terminate() }

      for attempt in ["first request", "second request"] {
        try tapPanoNote(app, attempt)

        XCTAssertTrue(
          app.navigationBars["Pano"].waitForExistence(timeout: 10),
          "Settings did not show the Pano page (\(attempt))")
        let selectedSettingsTab = app.buttons.matching(
          NSPredicate(format: "label == 'Settings' AND selected == true")
        ).firstMatch
        if isPhone {
          XCTAssertTrue(selectedSettingsTab.exists, "Settings tab not selected (\(attempt))")
        }

        app.buttons["BackButton"].tap()
        XCTAssertTrue(
          app.navigationBars["Settings"].waitForExistence(timeout: 10),
          "Back from Pano did not reach the Settings root (\(attempt))")

        if isPhone {
          app.buttons["Library"].firstMatch.tap()
        } else {
          dismissSheet(app)
        }
        XCTAssertTrue(
          app.buttons["multi-select-toggle"].waitForExistence(timeout: 10),
          "Browse unusable after Settings (\(attempt))")
      }
    }

    private func dismissSheet(_ app: XCUIApplication) {
      let window = app.windows.firstMatch
      window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        .press(
          forDuration: 0.1,
          thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
    }

    private func tapPanoNote(_ app: XCUIApplication, _ attempt: String) throws {
      let toggle = app.buttons["multi-select-toggle"]
      XCTAssertTrue(toggle.waitForExistence(timeout: 60), "Browse never appeared (\(attempt))")
      if UIDevice.current.userInterfaceIdiom == .phone {
        if !app.buttons["phone-select-all"].exists { toggle.tap() }
        let all = app.buttons["phone-select-all"]
        XCTAssertTrue(all.waitForExistence(timeout: 30))
        all.tap()
        app.buttons["phone-selection-more"].tap()
        app.buttons["Merge to Panorama…"].tap()
      } else {
        toggle.tap()
        let all = app.buttons["Select all images"]
        XCTAssertTrue(all.waitForExistence(timeout: 30))
        all.tap()
        let merge = app.buttons.matching(
          NSPredicate(format: "label CONTAINS 'into a panorama'")
        ).firstMatch
        XCTAssertTrue(merge.waitForExistence(timeout: 10))
        let screen = app.windows.firstMatch.frame
        let bar = app.buttons.matching(
          NSPredicate(format: "label CONTAINS 'elect all images'")
        ).firstMatch
        for _ in 0..<5 where merge.frame.maxX > screen.maxX { bar.swipeLeft() }
        merge.tap()
      }
      let note = app.descendants(matching: .any)["pano-matcher-note"]
      let previewReady = app.buttons.matching(
        NSPredicate(format: "label CONTAINS 'reusing the preview'")
      ).firstMatch
      let failed = app.descendants(matching: .any)["Panorama merge failed"]
      let deadline = Date().addingTimeInterval(240)
      while !note.exists && !previewReady.exists && !failed.exists && Date() < deadline {
        _ = note.waitForExistence(timeout: 2)
      }
      XCTAssertFalse(failed.exists, "panorama merge failed (\(attempt))")
      try XCTSkipUnless(
        note.waitForExistence(timeout: 20),
        "Panorama ML models are installed, so the matcher-unavailable note is not shown.")
      let setUp = app.buttons.matching(
        NSPredicate(format: "label CONTAINS 'Open Settings'")
      ).firstMatch
      XCTAssertTrue(setUp.waitForExistence(timeout: 10), "note has no Settings button (\(attempt))")
      setUp.tap()
    }
  }
#endif
