// Open-Duo landscape gate: the adjustment groups live in the native rail,
// while every special tool remains reachable without a floating dock.

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
      // The open landscape inner display uses the native vertical rail.
      let light = app.buttons["editor-dock-group-light"]
      if !light.waitForExistence(timeout: 10) {
        XCTAssertTrue(
          app.descendants(matching: .any)
            .matching(identifier: "editor-iphone-controls")
            .firstMatch.exists, "Neither the Duo rail nor compact controls appeared")
        XCTAssertFalse(app.buttons["editor-more-tools"].exists)
        return
      }
      XCTAssertFalse(
        app.descendants(matching: .any)
          .matching(identifier: "editor-tool-dock").firstMatch.exists)
      XCTAssertTrue(
        app.descendants(matching: .any)
          .matching(identifier: "editor-adjustments-panel").firstMatch.exists)

      for group in ["light", "color", "effects", "detail"] {
        let button = app.buttons["editor-dock-group-\(group)"]
        XCTAssertTrue(button.exists, "Missing \(group) in the system rail")
        button.tap()
        XCTAssertTrue(
          app.descendants(matching: .any)
            .matching(identifier: "editor-panel-section-\(group)")
            .firstMatch.waitForExistence(timeout: 5))
      }

      let more = app.buttons["editor-more-tools"]
      XCTAssertTrue(more.exists)
      more.tap()
      XCTAssertTrue(app.buttons["editor-dock-tool-crop"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.buttons["editor-dock-tool-presets"].exists)

      let attachment = XCTAttachment(screenshot: app.screenshot())
      attachment.name = "Open Duo editor system rail"
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }
#endif
