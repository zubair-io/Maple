// SyntheticGreyUITests.swift — synthetic-grey adjustment parity harness.
//
// Companion to grey_adjustments.rs (Rust side). Rust validates the
// scene-linear math via closed-form predictions; this test validates
// that Apple's full platform path (Rust FFI scene-linear → Metal AgX →
// Metal sRGB encode → display) lands on the same per-pixel grey value
// that Rust's CPU view tail produces.
//
// Per case it:
//   1. Stages a tmp dir with the synthetic DNG + the renamed XMP.
//   2. Launches Maple with MAPLE_UITEST_FIXTURE pointed at the DNG.
//   3. Waits for canvas-render-ready (refine pass published).
//   4. Screenshots the canvas.
//   5. For every pixel: asserts R == G == B (±2 LSB) — Apple-side neutrality.
//   6. Asserts the canvas mean equals the Rust-rendered mean (±3 LSB)
//      to catch drift between Rust CPU AgX and Apple Metal AgX.
//
// Skips when src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng
// is missing (bootstrap step from Task 1 of the plan not run).
//
// Spec: .archived-plans/specs/2026-04-28-grey-card-adjustment-tests-design.md

import XCTest
import AppKit

final class SyntheticGreyUITests: XCTestCase {

    /// Per-case expected u8 mean. Sourced from
    /// `cargo test --test grey_adjustments dump_display_means -- --ignored --nocapture`
    /// — see Task 7 of the plan. Re-run that test if any upstream
    /// pipeline change is expected to shift the means; update integers
    /// here to match.
    private struct Case {
        let xmpName: String
        let expectedMean: Int
        let label: String
    }

    private let cases: [Case] = [
        Case(xmpName: "default.xmp",          expectedMean: 134, label: "default"),
        Case(xmpName: "exposure-plus1.xmp",   expectedMean: 167, label: "EV+1"),
        Case(xmpName: "exposure-minus1.xmp",  expectedMean: 99,  label: "EV-1"),
        Case(xmpName: "shadows-plus50.xmp",   expectedMean: 134, label: "shadows+50 (no-op at L=0.18)"),
        Case(xmpName: "whites-minus50.xmp",   expectedMean: 134, label: "whites-50 (no-op at L=0.18)"),
        Case(xmpName: "contrast-plus50.xmp",  expectedMean: 134, label: "contrast+50 (mid-gray pivot)"),
    ]

    private static let neutralityToleranceLSB = 2
    private static let meanToleranceLSB = 3

    override func setUpWithError() throws {
        continueAfterFailure = true
    }

    /// Walk up from this source file's compile-time path to find the
    /// committed synthetic fixtures directory:
    ///   .../src/apple/MapleUITests/SyntheticGreyUITests.swift
    /// → .../src/apple/MapleUITests/Fixtures/synthetic/
    private static func syntheticRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()                     // MapleUITests/
            .appendingPathComponent("Fixtures", isDirectory: true)
            .appendingPathComponent("synthetic", isDirectory: true)
    }

    func testEachCase() throws {
        let root = Self.syntheticRoot()
        let dngURL = root.appendingPathComponent("grey-l018-rggb.dng")
        guard FileManager.default.fileExists(atPath: dngURL.path) else {
            throw XCTSkip("synthetic DNG fixture missing at \(dngURL.path) — run Task 1 bootstrap")
        }

        for c in cases {
            try XCTContext.runActivity(named: "case: \(c.label)") { _ in
                let xmpURL = root.appendingPathComponent("cases").appendingPathComponent(c.xmpName)
                guard FileManager.default.fileExists(atPath: xmpURL.path) else {
                    XCTFail("XMP fixture missing: \(xmpURL.path)")
                    return
                }

                // Stage tmp dir: grey-l018-rggb.dng + grey-l018-rggb.xmp
                let tmp = FileManager.default.temporaryDirectory
                    .appendingPathComponent("synth-grey-\(UUID().uuidString)",
                                            isDirectory: true)
                do {
                    try FileManager.default.createDirectory(at: tmp,
                                                            withIntermediateDirectories: true)
                } catch {
                    XCTFail("could not create tmp dir for \(c.label): \(error)")
                    return
                }
                defer { try? FileManager.default.removeItem(at: tmp) }

                let stagedDng = tmp.appendingPathComponent("grey-l018-rggb.dng")
                let stagedXmp = tmp.appendingPathComponent("grey-l018-rggb.xmp")
                do {
                    try FileManager.default.copyItem(at: dngURL, to: stagedDng)
                    try FileManager.default.copyItem(at: xmpURL, to: stagedXmp)
                } catch {
                    XCTFail("could not stage fixtures for \(c.label): \(error)")
                    return
                }

                // Launch Maple pointed at the tmp dir.
                let app = XCUIApplication()
                app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = "grey-l018-rggb.dng"
                app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = tmp.path
                app.launch()
                defer { app.terminate() }

                let canvas = app.otherElements["canvas-render-ready"]
                let predicate = NSPredicate(format: "exists == 1")
                let expectation = XCTNSPredicateExpectation(predicate: predicate, object: canvas)
                let waited = XCTWaiter().wait(for: [expectation], timeout: 60)
                guard waited == .completed else {
                    XCTFail("canvas-render-ready not published for \(c.label) within 60s")
                    return
                }

                // Take a tight canvas screenshot, with manual-crop fallback
                // for the macOS full-window-capture pattern (mirrors
                // MapleAppDriver.screenshotCanvas).
                let frame = canvas.frame
                let elementSnap = canvas.screenshot().image
                let elementSize = elementSnap.size
                let tight =
                    elementSize.width  <= frame.width  * 1.1 &&
                    elementSize.height <= frame.height * 1.1
                let canvasImage: NSImage
                if tight {
                    canvasImage = elementSnap
                } else {
                    let screen = XCUIScreen.main.screenshot().image
                    let target = NSSize(width: frame.width, height: frame.height)
                    let cropped = NSImage(size: target)
                    cropped.lockFocus()
                    let drawRect = NSRect(origin: .zero, size: target)
                    let srcRect = NSRect(origin: frame.origin, size: target)
                    screen.draw(in: drawRect, from: srcRect, operation: .copy, fraction: 1.0)
                    cropped.unlockFocus()
                    canvasImage = cropped
                }

                guard let cgImage = canvasImage.cgImage(forProposedRect: nil,
                                                        context: nil,
                                                        hints: nil) else {
                    XCTFail("could not get CGImage from canvas screenshot for \(c.label)")
                    return
                }

                let w = cgImage.width
                let h = cgImage.height
                let bytesPerPixel = 4
                let bytesPerRow = w * bytesPerPixel
                let colorSpace = CGColorSpaceCreateDeviceRGB()
                var pixels = [UInt8](repeating: 0, count: w * h * bytesPerPixel)
                guard let ctx = CGContext(
                    data: &pixels,
                    width: w, height: h,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: colorSpace,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
                else {
                    XCTFail("could not build CGContext for \(c.label)")
                    return
                }
                ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: w, height: h))

                var sumR = 0, sumG = 0, sumB = 0
                let n = w * h
                var neutralityFails = 0
                for i in 0..<n {
                    let r = Int(pixels[i * bytesPerPixel])
                    let g = Int(pixels[i * bytesPerPixel + 1])
                    let b = Int(pixels[i * bytesPerPixel + 2])
                    if abs(r - g) > Self.neutralityToleranceLSB || abs(r - b) > Self.neutralityToleranceLSB {
                        neutralityFails += 1
                    }
                    sumR += r; sumG += g; sumB += b
                }
                XCTAssertEqual(neutralityFails, 0,
                    "\(neutralityFails)/\(n) pixels violate neutrality (>\(Self.neutralityToleranceLSB) LSB) [\(c.label)]")

                let meanR = (sumR + n / 2) / n
                let meanG = (sumG + n / 2) / n
                let meanB = (sumB + n / 2) / n
                XCTAssertLessThanOrEqual(abs(meanR - c.expectedMean), Self.meanToleranceLSB,
                    "mean R=\(meanR) deviates from Rust-expected \(c.expectedMean) by > \(Self.meanToleranceLSB) [\(c.label)]")
                XCTAssertLessThanOrEqual(abs(meanG - c.expectedMean), Self.meanToleranceLSB,
                    "mean G=\(meanG) deviates from Rust-expected \(c.expectedMean) by > \(Self.meanToleranceLSB) [\(c.label)]")
                XCTAssertLessThanOrEqual(abs(meanB - c.expectedMean), Self.meanToleranceLSB,
                    "mean B=\(meanB) deviates from Rust-expected \(c.expectedMean) by > \(Self.meanToleranceLSB) [\(c.label)]")
            }
        }
    }
}
