import CryptoKit
import ImageIO
import XCTest

#if os(macOS)
  /// Uses the existing staged-fixture launch path and real native folder picker (#4113).
  final class NativeExportRecipeUITests: XCTestCase {
    func testFocusedRecipeQueuePublishesRealFileWithoutChangingSource() throws {
      continueAfterFailure = false
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
      let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("native-recipe-ui-\(UUID().uuidString)", isDirectory: true)
      let outputDirectory = root.appendingPathComponent("outputs", isDirectory: true)
      try FileManager.default.createDirectory(
        at: outputDirectory, withIntermediateDirectories: true)
      let source = root.appendingPathComponent(fixture.lastPathComponent)
      try FileManager.default.copyItem(at: fixture, to: source)
      let before = try Data(contentsOf: source)
      defer { try? FileManager.default.removeItem(at: root) }
      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = source.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = root.path
      app.launch()
      defer { app.terminate() }
      let share = app.buttons["editor-share"]
      XCTAssertTrue(share.waitForExistence(timeout: 30))
      attach(app, name: "Focused image before recipe export")
      share.tap()
      let recipes = app.buttons["export-open-recipes"]
      XCTAssertTrue(recipes.waitForExistence(timeout: 10))
      recipes.tap()
      let enqueue = app.buttons["native-recipe-enqueue"]
      XCTAssertTrue(enqueue.waitForExistence(timeout: 10))
      // Never replace another user's queue: this qualification requires empty saved state.
      guard app.staticTexts["No saved export queue."].exists else {
        throw XCTSkip("Existing saved queue must be preserved; qualify against empty app state.")
      }
      XCTAssertTrue(
        app.staticTexts["1 photos; captured edits and sequence numbers stay fixed during retry."]
          .exists)
      app.buttons["native-recipe-destination"].tap()
      let panel = app.dialogs.firstMatch
      XCTAssertTrue(panel.waitForExistence(timeout: 5))
      app.typeKey("g", modifierFlags: [.command, .shift])
      let path = app.textFields.firstMatch
      XCTAssertTrue(path.waitForExistence(timeout: 5))
      path.typeText(outputDirectory.path)
      app.typeKey(XCUIKeyboardKey.return, modifierFlags: [])
      let open = app.buttons["Open"].firstMatch
      XCTAssertTrue(open.waitForExistence(timeout: 5))
      open.tap()
      XCTAssertTrue(enqueue.isEnabled)
      enqueue.tap()
      let completed = app.staticTexts["1 exported, 0 failed, 0 remaining"]
      XCTAssertTrue(completed.waitForExistence(timeout: 30))
      XCTAssertTrue(app.buttons["native-export-resume"].exists)
      XCTAssertFalse(app.buttons["native-export-resume"].isEnabled)
      XCTAssertFalse(app.buttons["native-export-retry"].isEnabled)
      attach(app, name: "Actual native recipe queue complete")
      let output = outputDirectory.appendingPathComponent("rgb-gradient.jpg")
      let result = try XCTUnwrap(CGImageSourceCreateWithURL(output as CFURL, nil))
      let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(result, 0, nil))
      XCTAssertGreaterThan(image.width, 0)
      XCTAssertGreaterThan(image.height, 0)
      XCTAssertEqual(try Data(contentsOf: source), before)
      XCTAssertEqual(SHA256.hash(data: try Data(contentsOf: fixture)), SHA256.hash(data: before))
    }

    private func attach(_ app: XCUIApplication, name: String) {
      let attachment = XCTAttachment(screenshot: app.screenshot())
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }
#endif
