// Search is a Maple Cloud feature. The phone/Duo tab must follow the
// same flag as Timeline, Map, and the Cloud settings surfaces (#3858).

import XCTest

#if os(iOS) && targetEnvironment(simulator)
  import UIKit

  final class PhoneCloudSearchFlagUITests: XCTestCase {
    override func setUpWithError() throws {
      try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "Phone shell only")
    }

    func testSearchTabIsAbsentWhenCloudIsDisabled() {
      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_ENABLE_CLOUD"] = "0"
      app.launch()
      defer { app.terminate() }

      XCTAssertTrue(app.buttons["Library"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.buttons["Settings"].exists)
      XCTAssertFalse(app.buttons["Search"].exists)
    }

    func testSearchTabIsPresentWhenCloudIsEnabled() {
      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_ENABLE_CLOUD"] = "1"
      app.launch()
      defer { app.terminate() }

      XCTAssertTrue(app.buttons["Search"].waitForExistence(timeout: 10))
    }
  }
#endif
