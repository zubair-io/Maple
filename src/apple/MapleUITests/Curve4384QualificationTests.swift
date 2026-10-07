import CryptoKit
import XCTest

#if os(iOS) && targetEnvironment(simulator)
  final class Curve4384QualificationTests: XCTestCase {
    private var root = ""

    func testActualIPadPlotFocusGroupEntryAndReentry() throws {
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
      let authored = try Data(contentsOf: Self.authoredCurveFixture)
      XCTAssertEqual(
        SHA256.hash(data: authored).map { String(format: "%02x", $0) }.joined(),
        "556d2a4749eb4d7fd30dcb213e4ba2c4e098b19a150082aba987f932f35b5120")
      try authored.write(to: staged.deletingPathExtension().appendingPathExtension("xmp"))
      root = directory.path
      let input = XCTAttachment(
        string:
          "source=\(source.path)\nstaged=\(staged.path)\nSHA=\(sourceHash)\nproduction-serialized noncorner endpoint sidecar staged before launch"
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
      XCTAssertTrue(
        app.descendants(matching: .any)["editor-tone-curve-knot-3"].firstMatch.waitForExistence(
          timeout: 30))
      let initial = try curve()
      XCTAssertEqual(initial.count, 4)
      XCTAssertEqual(initial[3][0], 255)
      XCTAssertEqual(initial[3][1], 165.75, accuracy: 0.01)
      capture(app, "Real authored central and noncorner endpoint source")
      let adjacent = app.descendants(matching: .any)["editor-tone-curve-highlights"].firstMatch
      XCTAssertTrue(adjacent.exists)
      adjacent.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)).tap()
      capture(app, "Adjacent Highlights pointer focus before keyboard entry")
      let beforeEntry = try curve()
      app.typeKey(.tab, modifierFlags: .shift)
      app.typeKey(.upArrow, modifierFlags: [])
      let entered = waitCurve { self.movedIndex(beforeEntry, $0, delta: 255 / 64) != nil }
      capture(app, "ShiftTab from adjacent control then Up exact curve movement \(entered)")
      XCTAssertTrue(entered, "Keyboard entry must reach an actual knot without pointer selection")
      let index = try XCTUnwrap(movedIndex(beforeEntry, try curve(), delta: 255 / 64))
      print("CURVE4384_KEYBOARD_ENTRY actualIndex=\(index)")
      adjacent.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)).tap()
      let beforeReentry = try curve()
      app.typeKey(.tab, modifierFlags: .shift)
      app.typeKey(.downArrow, modifierFlags: [])
      let reentered = waitCurve { self.movedIndex(beforeReentry, $0, delta: -255 / 64) != nil }
      capture(app, "Keyboard reentry from adjacent control exact movement \(reentered)")
      XCTAssertTrue(reentered)
      XCUIDevice.shared.press(.home)
    }

    func testShiftArrowNudgesArmedRegionWithoutMovingFocusedKnot() throws {
      continueAfterFailure = false
      let source = try UITestFixtureRoot.locate("test_0017.dng")
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        "curve4384-shift-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let staged = directory.appendingPathComponent(source.lastPathComponent)
      try FileManager.default.copyItem(at: source, to: staged)
      try Data(contentsOf: Self.authoredCurveFixture).write(
        to: staged.deletingPathExtension().appendingPathExtension("xmp"))
      root = directory.path

      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = "test_0017.dng"
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = root
      app.launchEnvironment["MAPLE_GPU_LIVE"] = "0"
      app.launch()
      defer { app.terminate() }
      XCTAssertTrue(app.buttons["editor-back"].waitForExistence(timeout: 120))
      app.buttons["editor-dock-tool-toneCurve"].tap()

      let knot = app.descendants(matching: .any)["editor-tone-curve-knot-1"].firstMatch
      XCTAssertTrue(knot.waitForExistence(timeout: 30))
      XCTAssertEqual(try parametricHighlights(), 0)
      knot.tap()
      let beforeCurve = try curve()

      app.typeKey(.rightArrow, modifierFlags: .shift)
      XCTAssertTrue(waitHighlights { $0 == 10 })
      XCTAssertEqual(try curve(), beforeCurve, "Shift+Right must not move the focused knot")
      capture(app, "Shift Right nudges Highlights while preserving focused knot")

      app.typeKey(.leftArrow, modifierFlags: .shift)
      XCTAssertTrue(waitHighlights { $0 == 0 })
      XCTAssertEqual(try curve(), beforeCurve, "Shift+Left must not move the focused knot")
      capture(app, "Shift Left restores Highlights while preserving focused knot")
    }

    private func movedIndex(_ before: [[Double]], _ after: [[Double]], delta: Double) -> Int? {
      guard before.count == after.count else { return nil }
      return before.indices.first { index in
        abs(after[index][1] - before[index][1] - delta) < 0.03
          && after[index][0] == before[index][0]
          && before.indices.filter { $0 != index }.allSatisfy { before[$0] == after[$0] }
      }
    }

    private static let authoredCurveFixture = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("Fixtures/sidecar/test_0017-tone-curve-noncorner-endpoint.xmp")
      .standardizedFileURL

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

    private func parametricHighlights() throws -> Double {
      let text = try String(contentsOfFile: root + "/test_0017.xmp", encoding: .utf8)
      let regex = try NSRegularExpression(pattern: "crs:ParametricHighlights=\\\"([^\\\"]+)\\\"")
      let range = NSRange(text.startIndex..., in: text)
      guard let match = regex.firstMatch(in: text, range: range),
        let value = Range(match.range(at: 1), in: text)
      else { return 0 }
      return try XCTUnwrap(Double(text[value]))
    }

    private func waitCurve(_ accept: @escaping ([[Double]]) -> Bool) -> Bool {
      let expectation = XCTNSPredicateExpectation(
        predicate: NSPredicate { _, _ in
          guard let value = try? self.curve() else { return false }
          return accept(value)
        }, object: nil)
      return XCTWaiter.wait(for: [expectation], timeout: 20) == .completed
    }

    private func waitHighlights(_ accept: @escaping (Double) -> Bool) -> Bool {
      let expectation = XCTNSPredicateExpectation(
        predicate: NSPredicate { _, _ in
          guard let value = try? self.parametricHighlights() else { return false }
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
