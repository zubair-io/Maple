import XCTest

#if os(iOS) && targetEnvironment(simulator)
  import UIKit

  final class LibrarySourcesFolderPickerUITests: XCTestCase {
    override func setUpWithError() throws {
      continueAfterFailure = false
      try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "Phone Settings route")
    }

    func testFolderPickerCanCancelAndReopen() {
      let app = XCUIApplication()
      app.launch()
      defer { app.terminate() }

      let settings = app.buttons["Settings"]
      XCTAssertTrue(settings.waitForExistence(timeout: 15))
      settings.tap()
      let sources = app.buttons["settings.tab.sources"]
      XCTAssertTrue(sources.waitForExistence(timeout: 10))
      sources.tap()

      let addFolder = app.buttons["librarySources.addFolder"]
      XCTAssertTrue(addFolder.waitForExistence(timeout: 10))
      let folders = app.descendants(matching: .any).matching(
        NSPredicate(format: "identifier BEGINSWITH 'librarySources.folder.'"))
      let originalCount = folders.count
      let before = XCTAttachment(screenshot: app.screenshot())
      before.name = "Sources before folder selection"
      before.lifetime = .keepAlways
      add(before)

      for attempt in 1...2 {
        addFolder.tap()
        let cancel = app.buttons["Cancel"].firstMatch
        let browse = app.buttons["Browse"].firstMatch
        let presented = cancel.waitForExistence(timeout: 5) || browse.waitForExistence(timeout: 5)
        let picker = XCTAttachment(screenshot: app.screenshot())
        picker.name = "Folder picker presentation \(attempt)"
        picker.lifetime = .keepAlways
        add(picker)
        XCTAssertTrue(presented, app.debugDescription)
        if cancel.exists {
          cancel.tap()
        } else if browse.exists {
          browse.tap()
          let rootCancel = app.buttons["Cancel"].firstMatch
          if rootCancel.waitForExistence(timeout: 3) {
            rootCancel.tap()
          }
        }
        XCTAssertTrue(addFolder.waitForExistence(timeout: 5))
        XCTAssertEqual(folders.count, originalCount, "Cancellation must not register a folder")
      }
    }
  }
#endif
