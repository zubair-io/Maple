import XCTest

#if os(iOS) && targetEnvironment(simulator)
  import UIKit

  /// Uses the same committed image and DEBUG launch hook as the desktop
  /// layout harness. The simulator can stage that host fixture in a fresh
  /// temporary directory; device deployment is validated separately.
  final class EditorPhoneLayoutUITests: XCTestCase {
    private var launchedApp: XCUIApplication?
    private var stagedDirectory: URL?

    override func setUpWithError() throws { continueAfterFailure = false }

    override func tearDownWithError() throws {
      if let app = launchedApp {
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "Final editor accessibility tree"
        tree.lifetime = .keepAlways
        add(tree)
        app.terminate()
      }
      XCUIDevice.shared.orientation = .portrait
      if let stagedDirectory { try FileManager.default.removeItem(at: stagedDirectory) }
    }

    func testDeviceControlFamilyAndSelectedToolSurviveRotation() throws {
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-phone-layout-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      stagedDirectory = directory
      let staged = directory.appendingPathComponent(fixture.lastPathComponent)
      try FileManager.default.copyItem(at: fixture, to: staged)
      let original = try Data(contentsOf: staged)
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

      let phone = UIDevice.current.userInterfaceIdiom == .phone
      let color = app.buttons[phone ? "editor-group-color" : "editor-dock-group-color"]
      XCTAssertTrue(color.waitForExistence(timeout: 10))
      color.tap()
      if phone { tapTool(app, "bwMix") }
      let blackWhite = element(app, "editor-bw-toggle")
      XCTAssertTrue(blackWhite.waitForExistence(timeout: 5))
      let initial = try XCTUnwrap(blackWhite.value as? String)
      blackWhite.tap()
      wait(
        blackWhite,
        predicate: NSPredicate { object, _ in
          (object as? XCUIElement)?.value as? String != initial
        })
      let edited = try XCTUnwrap(blackWhite.value as? String)
      XCTAssertNotEqual(edited, initial)

      for orientation: UIDeviceOrientation in [.landscapeLeft, .portrait, .landscapeRight] {
        XCUIDevice.shared.orientation = orientation
        let landscape = orientation != .portrait
        wait(
          app.windows.firstMatch,
          predicate: NSPredicate { _, _ in
            let frame = app.windows.firstMatch.frame
            return landscape ? frame.width > frame.height : frame.height > frame.width
          })
        let controls = element(app, "editor-iphone-controls")
        if phone {
          XCTAssertTrue(controls.exists)
          XCTAssertTrue(element(app, "editor-group-tabs").exists)
          XCTAssertTrue(element(app, "editor-tool-row").exists)
          XCTAssertFalse(element(app, "editor-adjustments-panel").exists)
          XCTAssertFalse(element(app, "editor-tool-dock").exists)
          XCTAssertTrue(app.buttons["editor-tool-bwMix"].isSelected)
          // B&W uses the selected channel's single compact slider. Other
          // editing panels must not be mounted in one long scrolling list.
          XCTAssertEqual(
            app.descendants(matching: .any)
              .matching(identifier: "editor-drag-bar").count, 1)
          for id in [
            "editor-hsl-section", "editor-tone-curve-section",
            "editor-color-grading-panel", "editor-mask-panel", "editor-bw-mix",
          ] {
            XCTAssertFalse(element(app, id).exists, "Unselected panel: \(id)")
          }
          wait(
            element(app, "editor-drag-bar"),
            predicate: NSPredicate { object, _ in
              (object as? XCUIElement)?.isHittable == true
            })
        } else {
          XCTAssertFalse(controls.exists, "A compact iPad must retain the shared inspector")
          XCTAssertTrue(element(app, "editor-adjustments-panel").exists)
          XCTAssertTrue(element(app, "editor-tool-dock").exists)
        }
        XCTAssertEqual(blackWhite.value as? String, edited)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "\(phone ? "iPhone compact" : "iPad shared") \(orientation.rawValue)"
        shot.lifetime = .keepAlways
        add(shot)
      }
      app.buttons["editor-undo"].tap()
      XCTAssertEqual(blackWhite.value as? String, initial)

      if phone {
        // Switching controls replaces the one active surface.
        tapTool(app, "hsl")
        XCTAssertTrue(element(app, "editor-hsl-section").waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "editor-drag-bar").exists)
        for (group, tool) in [
          ("light", "toneCurve"), ("effects", "filmLook"),
          ("effects", "colorGrade"), ("detail", "lensCorrections"), ("detail", "mask"),
        ] {
          app.buttons["editor-group-\(group)"].tap()
          tapTool(app, tool)
          let selected = element(app, "editor-iphone-selected-control")
          XCTAssertTrue(selected.exists)
          XCTAssertGreaterThan(selected.frame.height, 0)
          XCTAssertLessThanOrEqual(selected.frame.height, app.windows.firstMatch.frame.height * 0.4)
          // Every group remains reachable even for a tall selected panel.
          for id in ["light", "color", "effects", "detail"] {
            XCTAssertTrue(app.buttons["editor-group-\(id)"].isHittable)
          }
          XCTAssertFalse(element(app, "editor-hsl-section").exists)
        }
        let addMask = element(app, "editor-mask-add-menu")
        wait(
          addMask,
          predicate: NSPredicate { object, _ in
            (object as? XCUIElement)?.isHittable == true
          })
        XCTAssertFalse(element(app, "editor-hsl-section").exists)
        XCTAssertFalse(element(app, "editor-drag-bar").exists)
      }
      XCTAssertEqual(try Data(contentsOf: staged), original)
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
      app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func tapTool(_ app: XCUIApplication, _ tool: String) {
      let button = app.buttons["editor-tool-\(tool)"]
      if !button.isHittable { element(app, "editor-tool-row").swipeRight() }
      for _ in 0..<3 where !button.isHittable {
        element(app, "editor-tool-row").swipeLeft()
      }
      XCTAssertTrue(button.isHittable)
      button.tap()
    }

    private func wait(_ element: XCUIElement, predicate: NSPredicate) {
      XCTAssertEqual(
        XCTWaiter.wait(
          for: [
            XCTNSPredicateExpectation(predicate: predicate, object: element)
          ], timeout: 30), .completed)
    }
  }
#endif
