import XCTest

#if os(iOS) && targetEnvironment(simulator)
  import UIKit
  final class PhotoHeaderUITests: XCTestCase {
    func testNativeHeadersAndOverflowInfoInPortraitAndLandscape() throws {
      continueAfterFailure = false
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-photo-header-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      try FileManager.default.copyItem(
        at: fixture, to: directory.appendingPathComponent(fixture.lastPathComponent))
      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = directory.path
      app.launchEnvironment["MAPLE_UITEST_START"] = "preview"
      defer {
        app.terminate()
        XCUIDevice.shared.orientation = .portrait
      }

      for orientation in [UIDeviceOrientation.portrait, .landscapeLeft] {
        XCUIDevice.shared.orientation = orientation
        app.launch()
        XCTAssertTrue(app.buttons["preview-edit"].waitForExistence(timeout: 20))
        let filename = app.staticTexts["preview-filename"]
        XCTAssertTrue(filename.exists)
        XCTAssertLessThanOrEqual(
          app.buttons["preview-back"].frame.maxX, filename.frame.minX)
        XCTAssertLessThanOrEqual(filename.frame.maxX, app.buttons["preview-edit"].frame.minX)
        attach(app, name: "Native Preview \(orientation.rawValue)")

        app.buttons["preview-edit"].tap()
        let more = app.buttons["editor-more"]
        XCTAssertTrue(more.waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["editor-filename"].exists)
        XCTAssertTrue(app.buttons["editor-back"].isHittable)
        XCTAssertTrue(more.isHittable)
        XCTAssertFalse(app.buttons["editor-auto"].isEnabled, "Auto requires a RAW")
        XCTAssertFalse(app.buttons["editor-undo"].isEnabled)
        XCTAssertLessThanOrEqual(
          app.buttons["editor-auto"].frame.maxX, app.buttons["editor-undo"].frame.minX)
        attach(app, name: "Native Editor \(orientation.rawValue)")

        more.tap()
        let info = app.buttons["Photo Info"]
        XCTAssertTrue(info.waitForExistence(timeout: 5))
        XCTAssertFalse(app.keyboards.firstMatch.exists, "More must not summon a software keyboard")
        XCTAssertTrue(app.buttons["Share / Export…"].exists)
        XCTAssertTrue(app.buttons["Zoom to Fit"].exists)
        XCTAssertTrue(app.buttons["Redo"].exists)
        XCTAssertFalse(app.buttons["Redo"].isEnabled)
        attach(app, name: "Editor More \(orientation.rawValue)")
        info.tap()
        XCTAssertTrue(app.scrollViews["info-panel"].waitForExistence(timeout: 5))
        app.terminate()
      }
    }

    private func attach(_ app: XCUIApplication, name: String) {
      let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }
#endif
