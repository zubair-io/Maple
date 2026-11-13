// CIEDE2000Tests.swift — cross-validate the Swift CIEDE2000 port at
// Helpers/CIEDE2000.swift against the Python reference at
// src/scripts/compare_images.py.
//
// The fixtures live at
// `src/apple/MapleUITests/Goldens/.calibration/{a,b,expected.json}`
// (Goldens is copied as a folder by the MapleUITests synchronized group,
// preserving the independent calibration cases without flattening their names):
//   - a.png + b.png are tiny (64×64) sRGB PNGs.
//   - expected.json is the output of `compare_images.py a.png b.png`,
//     committed alongside so this test runs without invoking Python at
//     build time.
//
// Regenerate by running:
//
//   python3 src/scripts/compare_images.py \
//     src/apple/MapleUITests/Goldens/.calibration/a.png \
//     src/apple/MapleUITests/Goldens/.calibration/b.png \
//     > src/apple/MapleUITests/Goldens/.calibration/expected.json
//
// See .archived-plans/plans/2026-04-25-xcuitest-visual-harness.md
// Task 4 for the math + cross-validation procedure.

import CoreGraphics
import ImageIO
import XCTest

#if canImport(UniformTypeIdentifiers)
  import UniformTypeIdentifiers
#endif

final class CIEDE2000Tests: XCTestCase {
  /// CIEDE2000 numbers must agree with the Python reference to ≤ 1e-3.
  /// Bias values are gamma-encoded RGB averages; tolerance can be
  /// tighter (1e-12): both implementations retain Float residuals and
  /// accumulate them in Double.
  func testCrossValidationAgainstPython() throws {
    let calibrationDir = try Self.calibrationDirectory()

    let aURL = calibrationDir.appendingPathComponent("a.png")
    let bURL = calibrationDir.appendingPathComponent("b.png")
    let expectedURL = calibrationDir.appendingPathComponent("expected.json")

    let (aRGBA, aWidth, aHeight) = try Self.loadRGBA(url: aURL)
    let (bRGBA, bWidth, bHeight) = try Self.loadRGBA(url: bURL)
    XCTAssertEqual(aWidth, bWidth)
    XCTAssertEqual(aHeight, bHeight)

    guard
      let result = CIEDE2000.compare(
        candidateRGBA: aRGBA,
        referenceRGBA: bRGBA,
        width: aWidth,
        height: aHeight
      )
    else {
      XCTFail("CIEDE2000.compare returned nil")
      return
    }

    let expected = try Self.loadExpected(url: expectedURL)

    XCTAssertEqual(
      result.meanDeltaE, expected.meanDeltaE,
      accuracy: 1e-3,
      "mean ΔE drift")
    XCTAssertEqual(
      result.p95DeltaE, expected.p95DeltaE,
      accuracy: 1e-3,
      "P95 ΔE drift")
    XCTAssertEqual(
      result.maxDeltaE, expected.maxDeltaE,
      accuracy: 1e-3,
      "max ΔE drift")
    XCTAssertEqual(
      result.biasR, expected.biasR,
      accuracy: 1e-12,
      "bias R drift")
    XCTAssertEqual(
      result.biasG, expected.biasG,
      accuracy: 1e-12,
      "bias G drift")
    XCTAssertEqual(
      result.biasB, expected.biasB,
      accuracy: 1e-12,
      "bias B drift")
    XCTAssertEqual(result.nPixels, expected.nPixels)
  }

  func testLargeRepeatedImageBiasMatchesPythonAndSinglePixel() throws {
    try assertLargeBiasFixture("bias-repetition", compareSinglePixel: true)
  }

  func testLargeSignedCancellationBiasMatchesPythonInBothOrders() throws {
    try assertLargeBiasFixture("bias-cancellation", compareSinglePixel: false)
  }

  func testBundledCalibrationHierarchyContainsAllCases() throws {
    let root = try Self.bundledCalibrationDirectory()
    for name in ["", "bias-repetition", "bias-cancellation"] {
      let directory = name.isEmpty ? root : root.appendingPathComponent(name)
      for filename in ["a.png", "b.png", "expected.json"] {
        let data = try Data(contentsOf: directory.appendingPathComponent(filename))
        XCTAssertFalse(data.isEmpty, "Missing bundled calibration data: \(name)/\(filename)")
      }
    }
  }

  private func assertLargeBiasFixture(_ name: String, compareSinglePixel: Bool) throws {
    let directory = try Self.calibrationDirectory().appendingPathComponent(name)
    let (candidate, width, height) = try Self.loadRGBA(
      url: directory.appendingPathComponent("a.png"))
    let (reference, referenceWidth, referenceHeight) = try Self.loadRGBA(
      url: directory.appendingPathComponent("b.png"))
    XCTAssertEqual(width, 512)
    XCTAssertEqual(height, 512)
    XCTAssertEqual(referenceWidth, width)
    XCTAssertEqual(referenceHeight, height)
    let expected = try Self.loadExpected(url: directory.appendingPathComponent("expected.json"))
    let expectedBias = [expected.biasR, expected.biasG, expected.biasB]
    for reverse in [false, true] {
      func ordered(_ pixels: [UInt8]) -> [UInt8] {
        guard reverse else { return pixels }
        return (0..<height).reversed().flatMap { row in
          Array(pixels[(row * width * 4)..<((row + 1) * width * 4)])
        }
      }
      let result = try XCTUnwrap(
        CIEDE2000.compare(
          candidateRGBA: ordered(candidate), referenceRGBA: ordered(reference),
          width: width, height: height))
      XCTAssertEqual(result.nPixels, expected.nPixels)
      XCTAssertEqual(result.meanDeltaE, expected.meanDeltaE, accuracy: 1e-3)
      XCTAssertEqual(result.p95DeltaE, expected.p95DeltaE, accuracy: 1e-3)
      XCTAssertEqual(result.maxDeltaE, expected.maxDeltaE, accuracy: 1e-3)
      for (actual, expected) in zip([result.biasR, result.biasG, result.biasB], expectedBias) {
        XCTAssertEqual(actual, expected, accuracy: 1e-12, "\(name), reversed=\(reverse)")
      }
    }
    if compareSinglePixel {
      let single = try XCTUnwrap(
        CIEDE2000.compare(
          candidateRGBA: Array(candidate.prefix(4)), referenceRGBA: Array(reference.prefix(4)),
          width: 1, height: 1))
      for (actual, expected) in zip([single.biasR, single.biasG, single.biasB], expectedBias) {
        XCTAssertEqual(actual, expected, accuracy: 1e-12, "repetition preserves bias")
      }
    }
  }

  // MARK: - Helpers

  /// Preserve explicit fixture overrides, ignoring Xcode's unexpanded simulator
  /// default just as UITestFixtureRoot does. Committed calibration data travels
  /// with the test bundle, so it does not depend on the runner's working directory.
  private static func calibrationDirectory() throws -> URL {
    if let root = ProcessInfo.processInfo.environment["MAPLE_UITEST_GOLDENS_ROOT"],
      !root.isEmpty, !root.contains("$(")
    {
      return URL(fileURLWithPath: root).appendingPathComponent(".calibration")
    }
    return try bundledCalibrationDirectory()
  }

  private static func bundledCalibrationDirectory() throws -> URL {
    let resources = try XCTUnwrap(Bundle(for: CIEDE2000Tests.self).resourceURL)
    return resources.appendingPathComponent("Goldens/.calibration", isDirectory: true)
  }

  /// PNG → RGBA8 buffer. `CGContext` decodes through the device color
  /// space, which on a P3 Mac would re-encode the sRGB PNG into P3
  /// before flattening. We pin to sRGB explicitly so the round-trip
  /// matches what `compare_images.py` reads via PIL.
  private static func loadRGBA(url: URL) throws -> ([UInt8], Int, Int) {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else { throw NSError(domain: "CIEDE2000Tests", code: 1) }
    let width = img.width
    let height = img.height
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let bitmapInfo: UInt32 =
      CGImageAlphaInfo.premultipliedLast.rawValue
      | CGBitmapInfo.byteOrder32Big.rawValue
    guard
      let ctx = CGContext(
        data: &bytes,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: cs,
        bitmapInfo: bitmapInfo
      )
    else {
      throw NSError(domain: "CIEDE2000Tests", code: 2)
    }
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: width, height: height))
    return (bytes, width, height)
  }

  /// Decode the JSON `compare_images.py` emits into a struct with the
  /// same field shape as `CIEDE2000Result`.
  private struct Expected: Decodable {
    let meanDeltaE: Double
    let p95DeltaE: Double
    let maxDeltaE: Double
    let biasR: Double
    let biasG: Double
    let biasB: Double
    let nPixels: Int

    enum CodingKeys: String, CodingKey {
      case meanDeltaE = "mean_deltaE"
      case p95DeltaE = "p95_deltaE"
      case maxDeltaE = "max_deltaE"
      case biasR = "bias_r"
      case biasG = "bias_g"
      case biasB = "bias_b"
      case nPixels = "n_pixels"
    }
  }

  private static func loadExpected(url: URL) throws -> Expected {
    let data = try Data(contentsOf: url)
    return try JSONDecoder().decode(Expected.self, from: data)
  }
}
