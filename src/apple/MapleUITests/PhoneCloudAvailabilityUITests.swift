// Cloud remains available even when older builds' rollout overrides are off (#3893).

import XCTest

#if os(iOS) && targetEnvironment(simulator)
  import UIKit

  final class PhoneCloudAvailabilityUITests: XCTestCase {
    override func setUpWithError() throws {
      continueAfterFailure = false
      try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "Phone shell only")
    }

    func testCloudSearchAndSettingsIgnoreLegacyDisabledFlags() {
      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_ENABLE_CLOUD"] = "0"
      app.launchEnvironment["MAPLE_EARLY_FEATURES"] = "0"
      app.launchEnvironment["MAPLE_ENABLE_PANO"] = "0"
      app.launchArguments = ["-MapleEnableCloud", "0", "-MapleEarlyFeatures", "0"]
      app.launch()
      defer { app.terminate() }

      XCTAssertTrue(app.buttons["Search"].waitForExistence(timeout: 10))
      let searchScreenshot = XCTAttachment(screenshot: app.screenshot())
      searchScreenshot.name = "Cloud Search available with legacy flags off"
      searchScreenshot.lifetime = .keepAlways
      add(searchScreenshot)

      let settings = app.buttons["Settings"]
      XCTAssertTrue(settings.exists)
      settings.tap()
      for label in ["Backup", "Cloud", "Observability", "Files"] {
        XCTAssertTrue(app.buttons[label].waitForExistence(timeout: 10), "Missing \(label) settings")
      }
      XCTAssertFalse(app.buttons["settings.tab.pano"].exists)
      let settingsScreenshot = XCTAttachment(screenshot: app.screenshot())
      settingsScreenshot.name = "Cloud settings available with Panorama disabled"
      settingsScreenshot.lifetime = .keepAlways
      add(settingsScreenshot)
    }

    func testSearchTabIsPresentWithoutRolloutOverrides() {
      let app = XCUIApplication()
      app.launch()
      defer { app.terminate() }

      XCTAssertTrue(app.buttons["Search"].waitForExistence(timeout: 10))
    }
  }
#endif
