import XCTest

#if os(iOS) && targetEnvironment(simulator)
  final class PhoneBatchExportSheetUITests: XCTestCase {
    func testExportSheetListsEverySelectedPhoto() throws {
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-export-sheet-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let names = (1...4).map { String(format: "frame-%02d", $0) }
      for name in names {
        try FileManager.default.copyItem(
          at: fixture, to: directory.appendingPathComponent("\(name).png"))
      }

      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = "\(names[0]).png"
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = directory.path
      app.launchArguments = ["--uitest-browse"]
      addTeardownBlock {
        app.terminate()
        try? FileManager.default.removeItem(at: directory)
      }
      app.launch()

      let tiles = names.map { app.buttons["thumb-\($0)"].firstMatch }
      XCTAssertTrue(tiles[0].waitForExistence(timeout: 30), "The staged folder never loaded")
      let select = app.buttons["multi-select-toggle"]
      XCTAssertTrue(select.waitForExistence(timeout: 10))
      select.tap()
      XCTAssertTrue(app.otherElements["phone-selection-bar"].waitForExistence(timeout: 5))
      for tile in tiles.prefix(3) { tile.tap() }
      XCTAssertTrue(app.staticTexts["phone-selection-count"].label.contains("3"))

      app.buttons["phone-selection-export"].tap()
      XCTAssertTrue(app.navigationBars["Export Photos"].waitForExistence(timeout: 5))
      let summary = app.descendants(matching: .any)
        .matching(NSPredicate(format: "label == %@", "3 photos")).firstMatch
      XCTAssertTrue(
        summary.waitForExistence(timeout: 5), "Export did not list the 3 selected photos")
      XCTAssertTrue(app.buttons["batch-export-confirm"].isEnabled)
    }
  }
#endif
