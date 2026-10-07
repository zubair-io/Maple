import CryptoKit
import XCTest

#if os(iOS) && targetEnvironment(simulator)
  final class Curve4384FullQualificationTests: XCTestCase {
    private var root = ""

    func testActualIPadKnotKeyboardXmpUndoFull() throws {
      continueAfterFailure = false
      let source = try UITestFixtureRoot.locate("test_0017.dng")
      let sourceBytes = try Data(contentsOf: source)
      let sourceHash = SHA256.hash(data: sourceBytes).map { String(format: "%02x", $0) }.joined()
      XCTAssertEqual(sourceHash, "26be5e06dfb53a2938dab3ca8f06024533a9c0dd0c652938f39eb48bc325f95e")
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        "curve4384-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let staged = directory.appendingPathComponent(source.lastPathComponent)
      try FileManager.default.copyItem(at: source, to: staged)
      XCTAssertEqual(try Data(contentsOf: staged), sourceBytes)
      root = directory.path
      let input = XCTAttachment(
        string:
          "source=\(source.path)\nstaged=\(staged.path)\nSHA=\(sourceHash)\nsidecar initially absent"
      )
      input.name = "Authentic runtime-staged input provenance"
      input.lifetime = .keepAlways
      add(input)
      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = "test_0017.dng"
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = root
      app.launchEnvironment["MAPLE_GPU_LIVE"] = "0"
      app.launch()
      defer { app.terminate() }
      XCTAssertTrue(app.buttons["editor-back"].waitForExistence(timeout: 120))
      app.buttons["editor-dock-tool-toneCurve"].tap()
      let plot = app.descendants(matching: .any)["editor-tone-curve-plot"].firstMatch
      XCTAssertTrue(plot.waitForExistence(timeout: 30))
      plot.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
      let knot = app.descendants(matching: .any)["editor-tone-curve-knot-1"].firstMatch
      XCTAssertTrue(knot.waitForExistence(timeout: 30))
      XCTAssertTrue(app.descendants(matching: .any)["editor-tone-curve-knot-2"].firstMatch.exists)
      let initial = try curve()
      XCTAssertEqual(initial.count, 3)
      capture(app, "Inserted actual midpoint")
      app.typeKey(.upArrow, modifierFlags: [])
      XCTAssertTrue(waitCurve { $0.count == 3 && $0[1][1] > initial[1][1] })
      let firstRaised = try curve()
      app.typeKey(.upArrow, modifierFlags: [])
      app.typeKey(.upArrow, modifierFlags: [])
      app.typeKey(.upArrow, modifierFlags: [])
      XCTAssertTrue(
        waitCurve { $0.count == 3 && abs($0[1][1] - firstRaised[1][1] - 255 * 3 / 64) < 0.03 })
      let raised = try curve()
      XCTAssertEqual(raised[1][0], initial[1][0], accuracy: 0.001)
      XCTAssertTrue(app.buttons["editor-dock-group-light"].isSelected)
      XCTAssertTrue(app.descendants(matching: .any)["editor-tone-curve-plot"].firstMatch.exists)
      capture(app, "Up changes XMP; inspector remains Light")
      app.typeKey("z", modifierFlags: .command)
      XCTAssertTrue(waitCurve { $0.count == 3 && abs($0[1][1] - raised[1][1] + 255 / 64) < 0.02 })
      capture(app, "Command Z restores actual midpoint XMP")
      knot.tap()
      let selected = try curve()
      app.typeKey(.rightArrow, modifierFlags: [])
      XCTAssertTrue(waitCurve { $0.count == 3 && $0[1][0] > selected[1][0] })
      XCTAssertTrue(app.buttons["editor-dock-group-light"].isSelected)
      let shifted = try curve()
      capture(app, "Existing knot pointer focus and Right")
      app.typeKey(.tab, modifierFlags: [])
      app.typeKey(.downArrow, modifierFlags: [])
      XCTAssertTrue(waitCurve { $0.count == 3 && $0[2][1] < shifted[2][1] })
      XCTAssertEqual(try curve()[2][0], 255)
      capture(app, "Forward Tab to endpoint2 and Down")
      let endpoint2 = try curve()
      app.typeKey(.tab, modifierFlags: .shift)
      app.typeKey(.upArrow, modifierFlags: [])
      XCTAssertTrue(waitCurve { $0.count == 3 && $0[1][1] > endpoint2[1][1] })
      let midpoint = try curve()
      app.typeKey(.tab, modifierFlags: .shift)
      app.typeKey(.upArrow, modifierFlags: [])
      XCTAssertTrue(waitCurve { $0.count == 3 && $0[0][1] > midpoint[0][1] })
      XCTAssertEqual(try curve()[0][0], 0)
      capture(app, "Reverse traversal2 to1 to0 with real XMP edits")
      let endpoint0 = try curve()
      app.typeKey(.rightArrow, modifierFlags: [])
      XCTAssertEqual(try curve(), endpoint0)
      app.typeKey(.tab, modifierFlags: .shift)
      app.typeKey(.downArrow, modifierFlags: [])
      XCTAssertEqual(
        try curve(), endpoint0, "Reverse boundary must leave knot0 rather than trapping focus")
      capture(app, "Reverse native boundary departure")
      app.buttons["editor-dock-tool-toneCurve"].tap()
      app.descendants(matching: .any)["editor-tone-curve-knot-0"].firstMatch.tap()
      app.typeKey(.tab, modifierFlags: [])
      let beforeMiddle = try curve()
      app.typeKey(.upArrow, modifierFlags: [])
      XCTAssertTrue(waitCurve { $0[1][1] > beforeMiddle[1][1] })
      app.typeKey(.tab, modifierFlags: [])
      let beforeLast = try curve()
      app.typeKey(.downArrow, modifierFlags: [])
      XCTAssertTrue(waitCurve { $0[2][1] < beforeLast[2][1] })
      XCTAssertEqual(try curve()[2][0], 255)
      capture(app, "Forward traversal0 to1 to2 with real XMP edits")
      let last = try curve()
      app.typeKey(.tab, modifierFlags: [])
      app.typeKey(.downArrow, modifierFlags: [])
      XCTAssertFalse(
        waitCurve { $0 != last }, "Forward boundary must leave knot2 rather than trapping focus")
      capture(app, "Forward native boundary departure")

    }

    private func curve() throws -> [[Double]] {
      let text = try String(contentsOfFile: root + "/test_0017.xmp", encoding: .utf8)
      let regex = try NSRegularExpression(
        pattern: "<papp:SceneLinearToneCurve>(.*?)</papp:SceneLinearToneCurve>",
        options: .dotMatchesLineSeparators)
      let range = NSRange(text.startIndex..., in: text)
      guard let match = regex.firstMatch(in: text, range: range),
        let body = Range(match.range(at: 1), in: text)
      else { throw Failure.missingCurve }
      let points = try NSRegularExpression(pattern: "<rdf:li>([^<]+)</rdf:li>")
      let contents = String(text[body])
      return points.matches(in: contents, range: NSRange(contents.startIndex..., in: contents)).map
      { match in
        String(contents[Range(match.range(at: 1), in: contents)!]).split(separator: ",").map {
          Double($0.trimmingCharacters(in: .whitespaces))!
        }
      }
    }

    private func waitCurve(_ accept: @escaping ([[Double]]) -> Bool) -> Bool {
      let expectation = XCTNSPredicateExpectation(
        predicate: NSPredicate { _, _ in
          guard let value = try? self.curve() else { return false }
          return accept(value)
        }, object: nil)
      return XCTWaiter.wait(for: [expectation], timeout: 20) == .completed
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
      print("CURVE4384 \(name)\n\(app.debugDescription)")
      let screen = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
      screen.name = name
      screen.lifetime = .keepAlways
      add(screen)
      if let data = try? Data(contentsOf: URL(fileURLWithPath: root + "/test_0017.xmp")) {
        let sidecar = XCTAttachment(data: data, uniformTypeIdentifier: "public.xml")
        sidecar.name = name + ".xmp"
        sidecar.lifetime = .keepAlways
        add(sidecar)
      }
    }

    private enum Failure: Error { case missingCurve }
  }
#endif
