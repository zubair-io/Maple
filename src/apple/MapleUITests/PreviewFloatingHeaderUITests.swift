import XCTest

#if os(iOS) && targetEnvironment(simulator)
  import UIKit

  /// Preview's header floats over the photo at the top of the iPad pane shell,
  /// as the editor's does, instead of sitting below a navigation bar (#5435).
  final class PreviewFloatingHeaderUITests: XCTestCase {
    func testPreviewHeaderFloatsAtTopOverPhotoOnIPad() throws {
      continueAfterFailure = false
      guard UIDevice.current.userInterfaceIdiom == .pad else {
        throw XCTSkip("The iPhone shell already hides its navigation bar for Preview.")
      }
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-preview-header-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      try FileManager.default.copyItem(
        at: fixture, to: directory.appendingPathComponent(fixture.lastPathComponent))
      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = directory.path
      app.launch()
      defer { app.terminate() }

      let editorBack = app.buttons["editor-back"]
      XCTAssertTrue(editorBack.waitForExistence(timeout: 30))
      editorBack.tap()
      let header = app.descendants(matching: .any)["preview-header"].firstMatch
      XCTAssertTrue(header.waitForExistence(timeout: 20))
      let image = app.descendants(matching: .any)["preview-image"].firstMatch
      XCTAssertTrue(image.waitForExistence(timeout: 10))
      let window = app.windows.firstMatch.frame

      XCTAssertLessThan(
        header.frame.minY - window.minY, 60,
        "Only the status-bar inset may sit above the header; no navigation bar row")
      XCTAssertLessThan(
        image.frame.minY - window.minY, 60,
        "The photo area must start at the status-bar inset, behind the header")
      for id in ["preview-back", "preview-edit", "preview-info"] {
        XCTAssertFalse(app.buttons[id].label.isEmpty, "\(id) keeps its accessibility label")
        XCTAssertTrue(app.buttons[id].isHittable)
      }
      let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
      attachment.name = "iPad Preview floating header"
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }
#endif
