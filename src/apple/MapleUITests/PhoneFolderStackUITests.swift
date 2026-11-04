// PhoneFolderStackUITests.swift — iPhone Library folder stack (#5674).
//
// Opening a subfolder pushes it onto the Library tab's navigation stack.
// The left-edge swipe walks back to the parent, interactively and
// cancellably, and opens the side menu only at the source root. Tapping
// the selected Library tab opens the side menu from any depth.
//
//   xcodebuild test -project src/apple/Maple.xcodeproj -scheme Maple \
//     -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
//     -only-testing:MapleUITests/PhoneFolderStackUITests
//
// Needs no RAW fixtures: the tree is staged from the committed layout PNG.

import XCTest

#if os(iOS) && targetEnvironment(simulator)
  import UIKit

  final class PhoneFolderStackUITests: XCTestCase {
    private var root: URL!
    private var app: XCUIApplication!

    override func setUpWithError() throws {
      continueAfterFailure = false
      try XCTSkipUnless(
        UIDevice.current.userInterfaceIdiom == .phone,
        "The folder stack is the iPhone Library tab; iPad and Mac load folders in place.")
      let image = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
      root = FileManager.default.temporaryDirectory
        .appendingPathComponent("Shoot \(UUID().uuidString.prefix(4))", isDirectory: true)
      let day = root.appendingPathComponent("Day 1", isDirectory: true)
      let picks = day.appendingPathComponent("Picks", isDirectory: true)
      try FileManager.default.createDirectory(at: picks, withIntermediateDirectories: true)
      try FileManager.default.copyItem(
        at: image, to: root.appendingPathComponent("rgb-gradient.png"))
      try FileManager.default.copyItem(at: image, to: picks.appendingPathComponent("pick.png"))
      for index in 0..<160 {
        try FileManager.default.copyItem(
          at: image, to: day.appendingPathComponent(String(format: "frame-%03d.png", index)))
      }
      app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = "rgb-gradient.png"
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = root.path
      app.launchArguments = ["--uitest-browse"]
      app.launch()
      XCTAssertTrue(
        app.buttons["thumb-rgb-gradient"].waitForExistence(timeout: 30),
        "The staged root folder never loaded.")
    }

    override func tearDownWithError() throws {
      app?.terminate()
      if let root { try? FileManager.default.removeItem(at: root) }
    }

    func testSwipeWalksUpTheFolderStackThenOpensTheSideMenu() throws {
      let rootTitle = root.lastPathComponent
      XCTAssertTrue(menuButton.exists, "The root offers the side-menu button.")

      openFolder("Day 1")
      assertTitle("Day 1", backTo: rootTitle)
      XCTAssertFalse(menuButton.exists, "Below the root the back button replaces the menu.")

      openFolder("Picks")
      assertTitle("Picks", backTo: "Day 1")
      XCTAssertTrue(app.buttons["thumb-pick"].waitForExistence(timeout: 10))

      swipeRight(from: 0.1, to: 0.3, slowly: true)
      assertTitle("Picks", backTo: "Day 1", "A short, slow swipe cancels and stays on the child.")

      swipeBack()
      assertTitle("Day 1", backTo: rootTitle)
      XCTAssertTrue(
        app.buttons["Folder Picks"].waitForExistence(timeout: 5),
        "The parent's listing is still there after the pop.")

      app.navigationBars.buttons[rootTitle].tap()
      waitForTitle(rootTitle)
      XCTAssertTrue(menuButton.waitForExistence(timeout: 5))
      XCTAssertFalse(isSideMenuOpen, "Popping to the root must not open the menu.")

      swipeRight(from: 0, to: 0.85, slowly: false)
      XCTAssertTrue(waitForSideMenu(), "At the root the edge swipe opens the side menu.")
    }

    func testParentKeepsItsScrollPositionUnderTheChild() throws {
      openFolder("Day 1")
      let picks = app.buttons["Folder Picks"]
      XCTAssertTrue(picks.waitForExistence(timeout: 10))
      let unscrolledY = picks.frame.minY
      let grid = app.scrollViews["library-grid"].firstMatch
      // A short scroll that keeps the Picks tile below the navigation bar.
      let start = grid.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
      start.press(
        forDuration: 0.05,
        thenDragTo: grid.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.62)),
        withVelocity: .slow, thenHoldForDuration: 0.3)
      let scrolledY = picks.frame.minY
      XCTAssertNotEqual(scrolledY, unscrolledY, accuracy: 2, "The parent grid never scrolled.")

      picks.tap()
      waitForTitle("Picks")
      XCTAssertTrue(app.buttons["thumb-pick"].waitForExistence(timeout: 10))
      swipeBack()
      waitForTitle("Day 1")

      XCTAssertEqual(
        app.buttons["Folder Picks"].frame.minY, scrolledY, accuracy: 2,
        "Back lands on the parent exactly where the user left it.")
    }

    func testRetappingLibraryTabOpensSideMenuAtAnyDepth() throws {
      let libraryTab = app.tabBars.buttons["Library"]
      XCTAssertTrue(libraryTab.waitForExistence(timeout: 10))

      openFolder("Day 1")
      openFolder("Picks")
      libraryTab.tap()
      XCTAssertTrue(waitForSideMenu(), "Re-tapping Library opens the side menu while deep.")
      app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
      XCTAssertTrue(waitForSideMenuClosed())
      waitForTitle("Picks")

      app.navigationBars.buttons["Day 1"].tap()
      app.navigationBars.buttons[root.lastPathComponent].tap()
      waitForTitle(root.lastPathComponent)
      libraryTab.tap()
      XCTAssertTrue(waitForSideMenu(), "Re-tapping Library opens the side menu at the root.")
    }

    // MARK: - Helpers

    private var menuButton: XCUIElement {
      app.navigationBars.buttons["Library"]
    }

    /// The side menu stays in the hierarchy while closed, parked off screen.
    private var isSideMenuOpen: Bool {
      let row = app.buttons["All Photos"].firstMatch
      return row.exists && row.isHittable && row.frame.minX >= 0
    }

    private func openFolder(_ name: String) {
      let tile = app.buttons["Folder \(name)"]
      XCTAssertTrue(tile.waitForExistence(timeout: 10), "No tile for folder \(name).")
      tile.tap()
      waitForTitle(name)
    }

    private func waitForTitle(_ title: String, file: StaticString = #filePath, line: UInt = #line) {
      let found = app.navigationBars[title].waitForExistence(timeout: 10)
      if !found {
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "Hierarchy without \(title)"
        tree.lifetime = .keepAlways
        add(tree)
      }
      XCTAssertTrue(found, "Expected the \(title) screen on top.", file: file, line: line)
    }

    private func assertTitle(
      _ title: String, backTo parent: String, _ message: String = "",
      file: StaticString = #filePath, line: UInt = #line
    ) {
      waitForTitle(title, file: file, line: line)
      XCTAssertTrue(
        app.navigationBars[title].buttons[parent].exists,
        "The back button names the parent \(parent). \(message)", file: file, line: line)
    }

    /// A short, slow left-to-right drag that a user abandons part way.
    private func swipeRight(from startFraction: CGFloat, to endFraction: CGFloat, slowly: Bool) {
      let origin = app.coordinate(withNormalizedOffset: .zero)
      let width = app.frame.width
      let midY = app.frame.height / 2
      let start = origin.withOffset(CGVector(dx: max(1, width * startFraction), dy: midY))
      let end = origin.withOffset(CGVector(dx: width * endFraction, dy: midY))
      start.press(
        forDuration: 0.01, thenDragTo: end,
        withVelocity: slowly ? .slow : XCUIGestureVelocity(1200),
        thenHoldForDuration: slowly ? 0.3 : 0)
    }

    /// A committed left-to-right swipe across the folder's grid. Below the
    /// root iOS pops from anywhere on the content, not only the edge.
    private func swipeBack() {
      app.scrollViews["library-grid"].firstMatch.swipeRight(velocity: .fast)
    }

    private func waitForSideMenu() -> Bool {
      let open = expectation(for: NSPredicate { _, _ in self.isSideMenuOpen }, evaluatedWith: nil)
      return XCTWaiter.wait(for: [open], timeout: 5) == .completed
    }

    private func waitForSideMenuClosed() -> Bool {
      let closed = expectation(
        for: NSPredicate { _, _ in !self.isSideMenuOpen }, evaluatedWith: nil)
      return XCTWaiter.wait(for: [closed], timeout: 5) == .completed
    }
  }
#endif
