import XCTest

#if os(iOS) && targetEnvironment(simulator)
  import UIKit

  /// Masks in the canvas-first editor on iPhone and iPad (#5122): a mask can
  /// be created, edited on the canvas, hidden and deleted from the Mask
  /// tool, and each of create, edit and delete is one Undo step.
  final class EditorMaskUITests: XCTestCase {
    private var launchedApp: XCUIApplication?
    private var stagedDirectory: URL?
    private var phone: Bool { UIDevice.current.userInterfaceIdiom == .phone }

    override func setUpWithError() throws { continueAfterFailure = false }

    override func tearDownWithError() throws {
      if let app = launchedApp {
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "Final editor accessibility tree"
        tree.lifetime = .keepAlways
        add(tree)
        app.terminate()
      }
      if let stagedDirectory { try FileManager.default.removeItem(at: stagedDirectory) }
    }

    func testCreateEditHideDeleteAndUndoALinearMask() throws {
      let app = try launchEditor()
      if phone {
        app.buttons["editor-group-detail"].tap()
        tapTool(app, "mask")
      } else {
        app.buttons["editor-dock-tool-mask"].tap()
      }
      let rows = app.buttons.matching(
        NSPredicate(format: "identifier BEGINSWITH 'editor-mask-select-'"))
      XCTAssertEqual(rows.count, 0)

      // Create.
      let add = element(app, "editor-mask-add-menu")
      XCTAssertTrue(add.waitForExistence(timeout: 10), "Mask tool is not reachable")
      add.tap()
      let linear = app.buttons["Add linear mask"]
      XCTAssertTrue(linear.waitForExistence(timeout: 5))
      linear.tap()
      wait(rows.firstMatch, predicate: NSPredicate(format: "exists == 1"))
      XCTAssertEqual(rows.count, 1)
      XCTAssertEqual(rows.firstMatch.label, "Gradient mask")
      XCTAssertTrue(rows.firstMatch.isSelected)

      // Edit on the canvas: one drag of a handle.
      let handle = element(app, "editor-mask-handle-linearEnd")
      XCTAssertTrue(handle.waitForExistence(timeout: 10), "The mask has no canvas handles")
      let before = try XCTUnwrap(handle.value as? String)
      let grip = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
      grip.press(forDuration: 0.1, thenDragTo: grip.withOffset(CGVector(dx: 0, dy: -60)))
      wait(
        handle,
        predicate: NSPredicate { object, _ in
          ((object as? XCUIElement)?.value as? String).map { $0 != before } ?? false
        })
      attach(app, "Linear mask after a handle drag")
      tapUndo(app)
      XCTAssertEqual(handle.value as? String, before, "One handle drag must be one Undo step")
      XCTAssertEqual(rows.count, 1, "Undoing the drag must not undo the mask")

      // Hide and show.
      let visible = app.switches.matching(
        NSPredicate(format: "identifier BEGINSWITH 'editor-mask-visible-'")
      ).firstMatch
      XCTAssertEqual(visible.label, "Show Gradient mask")
      XCTAssertEqual(visible.value as? String, "1")
      visible.tap()
      XCTAssertEqual(visible.value as? String, "0")
      visible.tap()
      XCTAssertEqual(visible.value as? String, "1")

      // Delete, then Undo brings the mask back.
      let delete = app.buttons.matching(
        NSPredicate(format: "identifier BEGINSWITH 'editor-mask-delete-'")
      ).firstMatch
      XCTAssertEqual(delete.label, "Delete Gradient mask")
      delete.tap()
      wait(rows.firstMatch, predicate: NSPredicate(format: "exists == 0"))
      tapUndo(app)
      wait(rows.firstMatch, predicate: NSPredicate(format: "exists == 1"))
      XCTAssertEqual(rows.count, 1, "Deleting a mask must be one Undo step")
      attach(app, "Linear mask restored by Undo")

      // And one more Undo removes the mask's creation.
      tapUndo(app)
      wait(rows.firstMatch, predicate: NSPredicate(format: "exists == 0"))
    }

    // MARK: - Helpers

    private func launchEditor() throws -> XCUIApplication {
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-mask-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      stagedDirectory = directory
      let staged = directory.appendingPathComponent(fixture.lastPathComponent)
      try FileManager.default.copyItem(at: fixture, to: staged)
      let app = XCUIApplication()
      launchedApp = app
      app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = staged.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = directory.path
      app.launchEnvironment["MAPLE_GPU_LIVE"] = "0"
      XCUIDevice.shared.orientation = .portrait
      app.launch()
      let canvas = app.descendants(matching: .any)
        .matching(NSPredicate(format: "label == 'Editor canvas'")).firstMatch
      wait(canvas, predicate: NSPredicate(format: "exists == 1 AND value == 'canvas-render-ready'"))
      return app
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
      app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func tapTool(_ app: XCUIApplication, _ tool: String) {
      let button = app.buttons["editor-tool-\(tool)"]
      let row = element(app, "editor-tool-row")
      if !button.isHittable { row.swipeRight() }
      for _ in 0..<3 where !button.isHittable { row.swipeLeft() }
      XCTAssertTrue(button.isHittable, "Missing tool pill: \(tool)")
      button.tap()
    }

    private func tapUndo(_ app: XCUIApplication) {
      let undo = app.buttons["editor-undo"]
      wait(
        undo,
        predicate: NSPredicate { object, _ in (object as? XCUIElement)?.isHittable == true })
      undo.tap()
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
      let shot = XCTAttachment(screenshot: app.screenshot())
      shot.name = "\(phone ? "iPhone" : "iPad") \(name)"
      shot.lifetime = .keepAlways
      add(shot)
    }

    private func wait(_ element: XCUIElement, predicate: NSPredicate) {
      let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
      XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 30), .completed)
    }
  }
#endif
