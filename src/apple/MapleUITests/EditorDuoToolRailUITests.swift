// Open-Duo landscape gate: every editor destination is visible in the
// fixed rail beneath the system clock, and taps select the inspector state.

import XCTest

#if os(iOS) && targetEnvironment(simulator)
  import UIKit

  final class EditorDuoToolRailUITests: XCTestCase {
    func testToolControlsMatchCurrentPhonePosture() throws {
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-duo-rail-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      try FileManager.default.copyItem(
        at: fixture, to: directory.appendingPathComponent(fixture.lastPathComponent))

      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = directory.path
      app.launchEnvironment["MAPLE_GPU_LIVE"] = "0"
      app.launch()
      defer { app.terminate() }

      // A Duo closed (or an ordinary iPhone) keeps compact bottom controls.
      // The open landscape inner display uses the fixed vertical rail.
      let light = app.buttons["editor-dock-group-light"]
      if !light.waitForExistence(timeout: 10) {
        XCTAssertTrue(
          app.descendants(matching: .any)
            .matching(identifier: "editor-iphone-controls")
            .firstMatch.exists, "Neither the Duo rail nor compact controls appeared")
        XCTAssertFalse(app.buttons["editor-dock-tool-crop"].exists)
        throw XCTSkip("Open the Duo in Device Hub to exercise the landscape tool rail")
      }
      XCTAssertFalse(
        app.descendants(matching: .any)
          .matching(identifier: "editor-tool-dock").firstMatch.exists)
      XCTAssertTrue(
        app.descendants(matching: .any)
          .matching(identifier: "editor-adjustments-panel").firstMatch.exists)

      for group in ["light", "color", "effects", "detail"] {
        let button = app.buttons["editor-dock-group-\(group)"]
        XCTAssertTrue(button.exists, "Missing \(group) in the Duo rail")
        XCTAssertTrue(button.isHittable, "\(group) is hidden or clipped")
        button.tap()
        XCTAssertTrue(
          app.descendants(matching: .any)
            .matching(identifier: "editor-panel-section-\(group)")
            .firstMatch.waitForExistence(timeout: 5))
      }

      for tool in ["crop", "toneCurve", "filmLook", "geometry", "mask", "presets", "heal"] {
        let button = app.buttons["editor-dock-tool-\(tool)"]
        XCTAssertTrue(button.exists, "Missing \(tool) in the Duo rail")
        XCTAssertTrue(button.isHittable, "\(tool) is hidden or clipped")
      }

      let curve = app.buttons["editor-dock-tool-toneCurve"]
      curve.tap()
      XCTAssertTrue(curve.isSelected)
      XCTAssertEqual(
        app.descendants(matching: .any)
          .matching(identifier: "editor-panel-section-light").firstMatch.label,
        "Tone Curve section")
      XCTAssertFalse(
        app.descendants(matching: .any)
          .matching(identifier: "editor-slider-exposure").firstMatch.exists)

      let film = app.buttons["editor-dock-tool-filmLook"]
      film.tap()
      XCTAssertTrue(film.isSelected)
      XCTAssertEqual(
        app.descendants(matching: .any)
          .matching(identifier: "editor-panel-section-effects").firstMatch.label,
        "Film section")
      XCTAssertFalse(
        app.descendants(matching: .any)
          .matching(identifier: "editor-slider-clarity").firstMatch.exists)

      let crop = app.buttons["editor-dock-tool-crop"]
      crop.tap()
      XCTAssertTrue(crop.isSelected, "Crop tap did not select its panel")
      XCTAssertTrue(app.buttons["editor-crop-done"].waitForExistence(timeout: 5))

      let mask = app.buttons["editor-dock-tool-mask"]
      mask.tap()
      XCTAssertTrue(mask.isSelected, "Mask tap did not select its panel")

      let attachment = XCTAttachment(screenshot: app.screenshot())
      attachment.name = "Open Duo editor tool rail"
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }
#endif
