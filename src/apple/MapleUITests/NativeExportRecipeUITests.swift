import CryptoKit
import ImageIO
import XCTest

#if os(macOS)
  /// Uses the existing staged-fixture launch path and real native folder picker (#4113).
  final class NativeExportRecipeUITests: XCTestCase {
    func testRecipeSheetReturnsKeyboardFocusToBrowseTrigger() throws {
      continueAfterFailure = false
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appending(path: "Fixtures/layout/rgb-gradient.png")
      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = fixture.deletingLastPathComponent().path
      app.launchArguments = ["--uitest-browse"]
      app.launch()
      defer { app.terminate() }

      let trigger = app.buttons["browse-export-recipes"]
      let done = app.buttons["native-recipe-close"]
      XCTAssertTrue(trigger.waitForExistence(timeout: 30))
      trigger.click()
      XCTAssertTrue(done.waitForExistence(timeout: 10))
      let disappeared = NSPredicate(format: "exists == false")
      app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
      wait(for: [expectation(for: disappeared, evaluatedWith: done)], timeout: 5)
      app.typeKey(" ", modifierFlags: [])
      XCTAssertTrue(done.waitForExistence(timeout: 10))

      done.click()
      wait(for: [expectation(for: disappeared, evaluatedWith: done)], timeout: 5)
      app.typeKey(" ", modifierFlags: [])
      XCTAssertTrue(done.waitForExistence(timeout: 10))
    }

    func testBrowseRecipeCapturesTwoSelectedPhotosOnFirstPresentation() throws {
      continueAfterFailure = false
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appending(path: "Fixtures/layout/rgb-gradient.png")
      let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("native-recipe-selection-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: root) }
      for name in ["first.png", "second.png"] {
        try FileManager.default.copyItem(at: fixture, to: root.appendingPathComponent(name))
      }
      let app = XCUIApplication()
      let queueDirectory = root.appendingPathComponent("queue", isDirectory: true)
      try FileManager.default.createDirectory(at: queueDirectory, withIntermediateDirectories: true)
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = "first.png"
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = root.path
      app.launchEnvironment["MAPLE_EXPORT_QUEUE_ROOT"] = queueDirectory.path
      app.launchArguments = ["--uitest-browse", "--export-queue-root", queueDirectory.path]
      app.launch()
      defer { app.terminate() }
      XCTAssertTrue(app.buttons["thumb-first"].waitForExistence(timeout: 30))
      XCTAssertTrue(app.buttons["thumb-second"].waitForExistence(timeout: 30))
      let select = app.buttons["multi-select-toggle"]
      XCTAssertTrue(select.waitForExistence(timeout: 30))
      select.click()
      let selectionMode = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "label == %@", "Exit selection mode"), object: select)
      XCTAssertEqual(XCTWaiter.wait(for: [selectionMode], timeout: 5), .completed)
      app.buttons["Select all images"].click()
      XCTAssertTrue(app.staticTexts["2 images selected"].exists)
      app.buttons["browse-export-recipes"].click()
      let captured = app.staticTexts[
        "2 photos; captured edits and sequence numbers stay fixed during retry."]
      XCTAssertTrue(captured.waitForExistence(timeout: 10))
      attach(app, name: "First Browse export presentation captures both selected photos")
    }

    func testFocusedRecipeQueuePublishesRealFileWithoutChangingSource() throws {
      continueAfterFailure = false
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appending(path: "Fixtures/layout/rgb-gradient.png")
      let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("native-recipe-ui-\(UUID().uuidString)", isDirectory: true)
      let outputDirectory = root.appendingPathComponent("outputs", isDirectory: true)
      try FileManager.default.createDirectory(
        at: outputDirectory, withIntermediateDirectories: true)
      let source = root.appendingPathComponent(fixture.lastPathComponent)
      try FileManager.default.copyItem(at: fixture, to: source)
      let before = try Data(contentsOf: source)
      defer { try? FileManager.default.removeItem(at: root) }
      let queueDirectory = root.appendingPathComponent("queue", isDirectory: true)
      try FileManager.default.createDirectory(at: queueDirectory, withIntermediateDirectories: true)
      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = source.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = root.path
      app.launchEnvironment["MAPLE_EXPORT_QUEUE_ROOT"] = queueDirectory.path
      app.launchArguments = ["--export-queue-root", queueDirectory.path]
      app.launch()
      defer { app.terminate() }
      let more = app.descendants(matching: .any).matching(identifier: "editor-more").firstMatch
      XCTAssertTrue(more.waitForExistence(timeout: 30))
      attach(app, name: "Focused image before recipe export")
      more.click()
      let share = app.menuItems["Share / Export…"]
      XCTAssertTrue(share.waitForExistence(timeout: 5))
      share.click()
      let recipes = app.buttons["export-open-recipes"]
      XCTAssertTrue(recipes.waitForExistence(timeout: 10))
      recipes.click()
      let enqueue = app.buttons["native-recipe-enqueue"]
      XCTAssertTrue(enqueue.waitForExistence(timeout: 10))
      // Never replace another user's queue: this qualification requires empty saved state.
      guard app.staticTexts["No saved export queue."].exists else {
        throw XCTSkip("Existing saved queue must be preserved; qualify against empty app state.")
      }
      XCTAssertTrue(
        app.staticTexts["1 photos; captured edits and sequence numbers stay fixed during retry."]
          .exists)
      app.buttons["native-recipe-destination"].click()
      let panel = app.dialogs.firstMatch
      XCTAssertTrue(panel.waitForExistence(timeout: 5))
      app.typeKey("g", modifierFlags: [.command, .shift])
      let path = app.textFields.firstMatch
      XCTAssertTrue(path.waitForExistence(timeout: 5))
      path.typeText(outputDirectory.path)
      app.typeKey(XCUIKeyboardKey.return, modifierFlags: [])
      let open = panel.buttons["Open"].firstMatch
      XCTAssertTrue(open.waitForExistence(timeout: 5))
      open.click()
      XCTAssertTrue(enqueue.isEnabled)
      enqueue.click()
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
