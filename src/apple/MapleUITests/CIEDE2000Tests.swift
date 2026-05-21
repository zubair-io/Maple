// CIEDE2000Tests.swift — cross-validate the Swift CIEDE2000 port at
// Helpers/CIEDE2000.swift against the Python reference at
// src/scripts/compare_images.py.
//
// The fixtures live at
// `src/apple/MapleUITests/Goldens/.calibration/{a,b,expected.json}`
// (this directory is auto-tracked by the MapleUITests
// PBXFileSystemSynchronizedRootGroup, so adding new fixtures requires
// no pbxproj edits):
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

import XCTest
import CoreGraphics
import ImageIO
#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

final class CIEDE2000Tests: XCTestCase {
    /// CIEDE2000 numbers must agree with the Python reference to ≤ 1e-3.
    /// Bias values are gamma-encoded RGB averages; tolerance can be
    /// tighter (1e-6) since they're a straight subtraction.
    func testCrossValidationAgainstPython() throws {
        let calibrationDir = try Self.calibrationDirectory()

        let aURL = calibrationDir.appendingPathComponent("a.png")
        let bURL = calibrationDir.appendingPathComponent("b.png")
        let expectedURL = calibrationDir.appendingPathComponent("expected.json")

        guard FileManager.default.fileExists(atPath: aURL.path),
              FileManager.default.fileExists(atPath: bURL.path),
              FileManager.default.fileExists(atPath: expectedURL.path)
        else {
            throw XCTSkip("Calibration fixtures missing at \(calibrationDir.path).")
        }

        let (aRGBA, aWidth, aHeight) = try Self.loadRGBA(url: aURL)
        let (bRGBA, bWidth, bHeight) = try Self.loadRGBA(url: bURL)
        XCTAssertEqual(aWidth, bWidth)
        XCTAssertEqual(aHeight, bHeight)

        guard let result = CIEDE2000.compare(
            candidateRGBA: aRGBA,
            referenceRGBA: bRGBA,
            width: aWidth,
            height: aHeight
        ) else {
            XCTFail("CIEDE2000.compare returned nil")
            return
        }

        let expected = try Self.loadExpected(url: expectedURL)

        XCTAssertEqual(result.meanDeltaE, expected.meanDeltaE,
                       accuracy: 1e-3,
                       "mean ΔE drift")
        XCTAssertEqual(result.p95DeltaE, expected.p95DeltaE,
                       accuracy: 1e-3,
                       "P95 ΔE drift")
        XCTAssertEqual(result.maxDeltaE, expected.maxDeltaE,
                       accuracy: 1e-3,
                       "max ΔE drift")
        XCTAssertEqual(result.biasR, expected.biasR,
                       accuracy: 1e-6,
                       "bias R drift")
        XCTAssertEqual(result.biasG, expected.biasG,
                       accuracy: 1e-6,
                       "bias G drift")
        XCTAssertEqual(result.biasB, expected.biasB,
                       accuracy: 1e-6,
                       "bias B drift")
        XCTAssertEqual(result.nPixels, expected.nPixels)
    }

    // MARK: - Helpers

    /// Walks up from the test runner's cwd to find the repo's
    /// `src/apple/MapleUITests/Goldens/.calibration` directory.
    /// Resolves at runtime since the test bundle layout differs between
    /// `xcodebuild test` and `swift test` invocations.
    private static func calibrationDirectory() throws -> URL {
        // `MAPLE_UITEST_GOLDENS_ROOT` (matches GoldenStore.swift) wins when
        // set. Otherwise walk up from the current directory looking for
        // `src/apple/MapleUITests/Goldens/.calibration`.
        if let root = ProcessInfo.processInfo.environment["MAPLE_UITEST_GOLDENS_ROOT"],
           !root.isEmpty {
            return URL(fileURLWithPath: root).appendingPathComponent(".calibration")
        }
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        // Try a few candidate paths; CI / xcodebuild cwd is usually the
        // src/apple dir, while local invocation starts at the repo root.
        let candidates = [
            cwd.appendingPathComponent("src/apple/MapleUITests/Goldens/.calibration"),
            cwd.appendingPathComponent("MapleUITests/Goldens/.calibration"),
            cwd.appendingPathComponent("../../src/apple/MapleUITests/Goldens/.calibration"),
        ]
        for candidate in candidates {
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate.standardizedFileURL
            }
        }
        throw XCTSkip(
            "Could not locate src/apple/MapleUITests/Goldens/.calibration " +
            "(tried: \(candidates.map(\.path).joined(separator: ", "))). " +
            "Set MAPLE_UITEST_GOLDENS_ROOT to override."
        )
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
        let bitmapInfo: UInt32 = CGImageAlphaInfo.premultipliedLast.rawValue
            | CGBitmapInfo.byteOrder32Big.rawValue
        guard let ctx = CGContext(
            data: &bytes,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: cs,
            bitmapInfo: bitmapInfo
        ) else {
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
