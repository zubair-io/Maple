import XCTest

/// Portable controls must remain reachable around a scrolling history (#4062).
final class WorkflowControlsUITests: XCTestCase {
  func testNamedSnapshotAndUnchangedRestoreUseReachableControls() throws {
    continueAfterFailure = false
    let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
    let staged = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-workflow-ui-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: staged, withIntermediateDirectories: true)
    try FileManager.default.copyItem(
      at: fixture, to: staged.appendingPathComponent(fixture.lastPathComponent))
    #if os(macOS)
      // Bind this test's built app URL rather than another running Maple checkout.
      let products = (0..<4).reduce(Bundle(for: Self.self).bundleURL) { url, _ in
        url.deletingLastPathComponent()
      }
      let app = XCUIApplication(url: products.appendingPathComponent("Maple.app"))
    #else
      let app = XCUIApplication()
    #endif
    app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture.lastPathComponent
    app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = staged.path
    app.launch()
    defer {
      app.terminate()
      try? FileManager.default.removeItem(at: staged)
    }
    let canvas = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label == 'Editor canvas' AND value == 'canvas-render-ready'"))
      .firstMatch
    XCTAssertTrue(canvas.waitForExistence(timeout: 90))
    activate(app.buttons["editor-more"])
    #if os(macOS)
      activate(app.menuItems["Snapshots and history"])
    #else
      activate(app.buttons["Snapshots and history"])
    #endif
    let close = app.buttons["workflow-close"]
    let save = app.buttons["workflow-save-snapshot"]
    XCTAssertTrue(close.waitForExistence(timeout: 10))
    XCTAssertTrue(save.isHittable)
    XCTAssertTrue(close.isHittable)
    #if os(iOS)
      XCTAssertGreaterThan(save.frame.minY, close.frame.maxY)
    #endif
    activate(save)
    let name = app.textFields["Snapshot name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    activate(name)
    name.typeText("UI checkpoint")
    activate(app.buttons["Save"])
    let row = app.buttons["Restore UI checkpoint"]
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    XCTAssertTrue(row.isHittable)
    #if os(iOS)
      XCTAssertGreaterThan(row.frame.minY, close.frame.maxY)
    #endif
    XCTAssertLessThan(row.frame.maxY, save.frame.minY)
    let root = try XCTUnwrap(app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"])
    let sidecar = URL(fileURLWithPath: root).appendingPathComponent("rgb-gradient.xmp")
    let before = try Data(contentsOf: sidecar)
    activate(row)
    activate(app.buttons["Cancel"])
    XCTAssertEqual(try Data(contentsOf: sidecar), before)
    activate(row)
    activate(app.buttons["Restore"])
    XCTAssertTrue(save.waitForExistence(timeout: 10))
    XCTAssertEqual(try Data(contentsOf: sidecar), before, "Unchanged restore has no fake history")
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "Native snapshot controls after unchanged restore"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    activate(close)
    XCTAssertFalse(app.buttons["editor-undo"].isEnabled)
  }

  private func activate(_ element: XCUIElement) {
    XCTAssertTrue(element.waitForExistence(timeout: 10))
    #if os(macOS)
      element.click()
    #else
      element.tap()
    #endif
  }
}
