import XCTest

final class PanoSeamEditorUITests: XCTestCase {
  func testNumericRegionsAndExplicitPreviewRemainAccessible() throws {
    continueAfterFailure = false
    let fixtureDirectory = try UITestFixtureRoot.locate("pano_01")
    let fixtures = try FileManager.default.contentsOfDirectory(
      at: fixtureDirectory, includingPropertiesForKeys: nil
    ).filter { $0.pathExtension.lowercased() == "dng" }
      .sorted { $0.lastPathComponent < $1.lastPathComponent }
    XCTAssertGreaterThanOrEqual(fixtures.count, 3)
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-seam-ui-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    for fixture in fixtures.prefix(3) {
      try FileManager.default.copyItem(
        at: fixture, to: directory.appendingPathComponent(fixture.lastPathComponent))
    }
    #if os(macOS)
      let products = (0..<4).reduce(Bundle(for: Self.self).bundleURL) { url, _ in
        url.deletingLastPathComponent()
      }
      let app = XCUIApplication(url: products.appendingPathComponent("Maple.app"))
    #else
      let app = XCUIApplication()
    #endif
    app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = try XCTUnwrap(fixtures.first).lastPathComponent
    app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = directory.path
    app.launchArguments = ["--uitest-browse"]
    app.launch()
    defer { app.terminate() }

    activate(app.buttons["multi-select-toggle"])
    let phoneSelectAll = app.buttons["phone-select-all"]
    if phoneSelectAll.exists {
      activate(phoneSelectAll)
      activate(app.buttons["phone-selection-more"])
      activate(app.buttons["Merge to Panorama…"])
    } else {
      activate(app.buttons["Select all images"])
      let merge = app.buttons["Merge 3 selected images into a panorama"]
      let bar = app.scrollViews.containing(.button, identifier: merge.label).firstMatch
      for _ in 0..<6 where !merge.isHittable {
        #if os(macOS)
          bar.scroll(byDeltaX: -400, deltaY: 0)
        #else
          bar.swipeLeft()
        #endif
      }
      activate(merge)
    }
    let edit = app.buttons["pano-seam-editor"]
    XCTAssertTrue(edit.waitForExistence(timeout: 600), "The real panorama preview must finish")
    XCTAssertEqual(edit.label, "Edit panorama include and exclude seam regions")
    activate(edit)
    let canvas = app.descendants(matching: .any).matching(identifier: "pano-seam-canvas").firstMatch
    XCTAssertTrue(canvas.waitForExistence(timeout: 10))
    XCTAssertTrue(canvas.label.hasPrefix("Uncropped panorama seam canvas, "))
    let source = app.descendants(matching: .any).matching(identifier: "pano-seam-frame").firstMatch
    XCTAssertEqual(source.label, "Seam source frame")
    XCTAssertEqual(
      source.value as? String,
      "1: \(directory.appendingPathComponent(fixtures[0].lastPathComponent).path)")
    let secondSource = "2: \(directory.appendingPathComponent(fixtures[1].lastPathComponent).path)"
    choose(secondSource, from: source, app: app)
    XCTAssertEqual(source.value as? String, secondSource)
    choose(
      "1: \(directory.appendingPathComponent(fixtures[0].lastPathComponent).path)",
      from: source, app: app)
    let mode = app.descendants(matching: .any).matching(identifier: "pano-seam-kind").firstMatch
    XCTAssertEqual(mode.label, "Seam region mode")
    attach(app, name: "Uncropped seam authoring canvas and ordered source picker")

    let add = app.buttons["pano-seam-add"]
    XCTAssertEqual(
      XCTWaiter.wait(
        for: [
          XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "enabled == true"), object: add)
        ], timeout: 600),
      .completed)
    for label in ["X", "Y", "Width", "Height"] {
      XCTAssertTrue(app.textFields["Seam region \(label)"].exists)
    }
    replace(app.textFields["Seam region Width"], with: "0", app: app)
    activate(add, app: app)
    let error = app.staticTexts["pano-seam-error"]
    XCTAssertTrue(error.waitForExistence(timeout: 10))
    XCTAssertTrue(error.label.contains("invalid_seam_constraints"))
    XCTAssertEqual(app.staticTexts["pano-seam-count"].label, "0 seam regions")

    replace(app.textFields["Seam region Width"], with: "1", app: app)
    activate(add, app: app)
    XCTAssertEqual(app.staticTexts["pano-seam-count"].label, "1 seam regions")
    XCTAssertFalse(error.exists)
    choose("Exclude — avoid this frame", from: mode, app: app)
    replace(app.textFields["Seam region X"], with: "2", app: app)
    activate(add, app: app)
    XCTAssertEqual(app.staticTexts["pano-seam-count"].label, "2 seam regions")
    let remove = app.buttons["pano-seam-remove-2"]
    XCTAssertEqual(remove.label, "Remove seam region 2")
    activate(remove, app: app)
    XCTAssertEqual(app.staticTexts["pano-seam-count"].label, "1 seam regions")
    let clear = app.buttons["pano-seam-clear"]
    XCTAssertEqual(clear.label, "Clear all seam regions")
    activate(clear, app: app)
    XCTAssertEqual(app.staticTexts["pano-seam-count"].label, "0 seam regions")
    activate(add, app: app)
    XCTAssertEqual(app.staticTexts["pano-seam-count"].label, "1 seam regions")
    let preview = app.buttons["pano-seam-preview"]
    XCTAssertEqual(preview.label, "Preview panorama with seam regions")
    attach(app, name: "Numeric include and exclude regions with accessible removal controls")
    activate(preview, app: app)
    XCTAssertFalse(preview.isEnabled, "Authoring waits for the explicit preview")
    activate(app.buttons["pano-seam-done"])
    let create = app.buttons.matching(
      NSPredicate(format: "label BEGINSWITH 'Create the full panorama'")
    ).firstMatch
    activate(create)
    let stop = app.buttons["Stop the in-progress stitch"]
    XCTAssertTrue(stop.waitForExistence(timeout: 10))
    activate(stop)
    attach(app, name: "Create Panorama accepts the seam draft through the existing action")
  }

  private func choose(_ title: String, from picker: XCUIElement, app: XCUIApplication) {
    reveal(picker, app: app)
    activate(picker)
    #if os(macOS)
      activate(app.menuItems[title])
    #else
      activate(app.buttons[title])
    #endif
  }

  private func replace(_ field: XCUIElement, with value: String, app: XCUIApplication) {
    reveal(field, app: app)
    activate(field)
    let existing = field.value as? String ?? ""
    field.typeText(
      String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count) + value)
    #if os(iOS)
      let done = app.toolbars.buttons["Done"]
      if done.exists { activate(done) }
    #endif
  }

  private func reveal(_ element: XCUIElement, app: XCUIApplication) {
    let scroll = app.scrollViews["pano-seam-scroll"]
    for _ in 0..<6 where !element.isHittable {
      #if os(macOS)
        scroll.scroll(byDeltaX: 0, deltaY: -300)
      #else
        scroll.swipeUp()
      #endif
    }
    if !element.isHittable {
      for _ in 0..<6 where !element.isHittable {
        #if os(macOS)
          scroll.scroll(byDeltaX: 0, deltaY: 300)
        #else
          scroll.swipeDown()
        #endif
      }
    }
  }

  private func activate(_ element: XCUIElement, app: XCUIApplication? = nil) {
    XCTAssertTrue(element.waitForExistence(timeout: 30))
    if let app { reveal(element, app: app) }
    XCTAssertTrue(element.isHittable)
    #if os(macOS)
      element.click()
    #else
      element.tap()
    #endif
  }

  private func attach(_ app: XCUIApplication, name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
