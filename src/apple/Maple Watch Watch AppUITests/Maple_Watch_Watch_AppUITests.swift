import XCTest

final class MapleWatchUITests: XCTestCase {
  @MainActor
  func testLaunchShowsPairingOrConnectedLibrary() {
    let app = XCUIApplication()
    app.launch()
    let connect = app.buttons["watch.pairing.connect"]
    let disconnect = app.buttons["Disconnect"]
    XCTAssertTrue(
      connect.waitForExistence(timeout: 10) || disconnect.waitForExistence(timeout: 10),
      "Watch must show setup or a connected library, never a template or blank screen.")
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "Maple Watch launch"
    screenshot.lifetime = .keepAlways
    add(screenshot)
  }
}
