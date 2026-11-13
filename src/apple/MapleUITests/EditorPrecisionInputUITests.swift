import XCTest

#if os(iOS) && targetEnvironment(simulator)
  import UIKit

  /// The white-balance pad and the tone-curve plot on iPhone and iPad
  /// (#5121): both are reachable in the canvas-first editor, a press-drag on
  /// either edits the photo, and each drag is one Undo step. The simulator
  /// sends fingertip touches, so this exercises the fingertip path of the
  /// plot's touch-type-aware drag; an Apple Pencil needs a device.
  final class EditorPrecisionInputUITests: XCTestCase {
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

    func testWhiteBalancePadDragIsOneUndoStep() throws {
      let app = try launchEditor()
      app.buttons[phone ? "editor-group-color" : "editor-dock-group-color"].tap()
      if phone { tapTool(app, "temp") }

      let pad = element(app, "editor-wb-pad")
      XCTAssertTrue(pad.waitForExistence(timeout: 10), "White-balance pad is not reachable")
      XCTAssertEqual(pad.label, "White balance pad")
      let initial = try XCTUnwrap(pad.value as? String)

      let start = pad.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5))
      let end = pad.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.25))
      start.press(forDuration: 0.1, thenDragTo: end)
      waitForChange(of: pad, from: initial)
      let edited = try XCTUnwrap(pad.value as? String)
      XCTAssertTrue(edited.hasPrefix("Temperature "), edited)
      attachScreenshot(app, "White-balance pad after drag")

      tapUndo(app)
      XCTAssertEqual(pad.value as? String, initial, "One drag must be one Undo step")
    }

    func testToneCurveFingertipAddsThenGrabsAPoint() throws {
      let app = try launchEditor()
      if phone {
        app.buttons["editor-group-light"].tap()
        tapTool(app, "toneCurve")
      } else {
        app.buttons["editor-dock-tool-toneCurve"].tap()
      }
      let plot = element(app, "editor-tone-curve-plot")
      XCTAssertTrue(plot.waitForExistence(timeout: 10), "Tone-curve plot is not reachable")
      XCTAssertTrue(element(app, "editor-tone-curve-knot-1").waitForExistence(timeout: 5))
      XCTAssertFalse(element(app, "editor-tone-curve-knot-2").exists)

      // A press on empty plot adds a point and drags it.
      let middle = plot.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
      middle.press(
        forDuration: 0.1,
        thenDragTo: plot.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)))
      XCTAssertTrue(
        element(app, "editor-tone-curve-knot-2").waitForExistence(timeout: 5),
        "A press-drag on the plot did not add a curve point")
      XCTAssertFalse(element(app, "editor-tone-curve-knot-3").exists)

      // A fingertip 14 pt from that point grabs it instead of adding a
      // fourth: its reach is half a 44 pt touch target.
      let point = element(app, "editor-tone-curve-knot-1")
      let before = try XCTUnwrap(point.value as? String)
      let near = point.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        .withOffset(CGVector(dx: 10, dy: 10))
      near.press(forDuration: 0.1, thenDragTo: near.withOffset(CGVector(dx: 0, dy: 30)))
      waitForChange(of: point, from: before)
      XCTAssertFalse(
        element(app, "editor-tone-curve-knot-3").exists,
        "A fingertip beside a point must grab it, not add another")
      attachScreenshot(app, "Tone curve after fingertip drags")

      // Two drags, two Undo steps: the move, then the insertion.
      tapUndo(app)
      XCTAssertEqual(point.value as? String, before)
      XCTAssertTrue(element(app, "editor-tone-curve-knot-2").exists)
      tapUndo(app)
      wait(
        element(app, "editor-tone-curve-knot-2"),
        predicate: NSPredicate(format: "exists == 0"))
    }

    // MARK: - Helpers

    private func launchEditor() throws -> XCUIApplication {
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-precision-\(UUID().uuidString)", isDirectory: true)
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

    private func waitForChange(of element: XCUIElement, from value: String) {
      wait(
        element,
        predicate: NSPredicate { object, _ in
          ((object as? XCUIElement)?.value as? String).map { $0 != value } ?? false
        })
    }

    private func attachScreenshot(_ app: XCUIApplication, _ name: String) {
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
