import XCTest

#if os(iOS) && targetEnvironment(simulator)
  import UIKit

  /// iPad Browse keeps the folder name, filters and controls on one floating
  /// row at the top, with no navigation-bar title band above it (#5435).
  final class BrowseFloatingHeaderUITests: XCTestCase {
    func testBrowseHeaderIsOneRowAtTopOnIPad() throws {
      continueAfterFailure = false
      guard UIDevice.current.userInterfaceIdiom == .pad else {
        throw XCTSkip("The iPhone Library has its own tab-shell header.")
      }
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("Federal Way \(UUID().uuidString.prefix(4))", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      try FileManager.default.copyItem(
        at: fixture, to: directory.appendingPathComponent(fixture.lastPathComponent))
      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = directory.path
      app.launchArguments = ["--uitest-browse"]
      defer {
        app.terminate()
        XCUIDevice.shared.orientation = .portrait
      }

      for orientation in [UIDeviceOrientation.portrait, .landscapeLeft] {
        XCUIDevice.shared.orientation = orientation
        app.launch()
        XCTAssertTrue(app.buttons["thumb-rgb-gradient"].waitForExistence(timeout: 30))
        guard app.windows.firstMatch.frame.width >= 768 else {
          throw XCTSkip("Below 768pt the pane shell renders the phone LibraryGrid.")
        }
        try assertOneRowHeader(app, folder: directory.lastPathComponent)

        let sidebar = app.buttons["browse-sidebar-toggle"]
        sidebar.tap()
        try assertOneRowHeader(app, folder: directory.lastPathComponent)
        sidebar.tap()
        app.terminate()
      }
    }

    private func assertOneRowHeader(_ app: XCUIApplication, folder: String) throws {
      let title = app.staticTexts["browse-title"].firstMatch
      XCTAssertTrue(title.waitForExistence(timeout: 10))
      XCTAssertEqual(title.label, folder)
      let window = app.windows.firstMatch.frame
      XCTAssertLessThan(
        title.frame.minY - window.minY, 60, "No title band may sit above the header row")
      for id in [
        "browse-sidebar-toggle", "grid-filter-all", "browse-grid-display-mode-toggle",
        "multi-select-toggle", "settings-button",
      ] {
        let control = app.buttons[id].firstMatch
        XCTAssertEqual(
          app.buttons.matching(identifier: id).count, 1, "\(id) appears once, in the header")
        XCTAssertFalse(control.label.isEmpty, "\(id) keeps its accessibility label")
        XCTAssertEqual(
          control.frame.midY, title.frame.midY, accuracy: 4, "\(id) shares the title's row")
      }
      let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
      attachment.name = "iPad Browse floating header"
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }
#endif
