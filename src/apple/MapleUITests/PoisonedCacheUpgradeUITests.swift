// PoisonedCacheUpgradeUITests.swift — end-to-end poisoned-cache upgrade gate
// (#1805, gap 2).
//
// WHY THIS EXISTS. Every CI and dev environment starts with an empty
// `.maple/previews/` store, so the situation that actually shipped the #1801
// band — a device carrying previews rendered by the PREVIOUS build, opened on
// the current one — was invisible to every gate. The pipeline was never
// wrong; it never RAN, because a stale artifact was still key-valid and
// short-circuited it.
//
// `RenderedPreviewCacheUpgradeTests` (MapleCore) owns the key algebra: it
// proves that an entry stored under a previous `viewTransformVersion` /
// `pipelineOutputVersion` is not served, using the real constants. What that
// test CANNOT see is whether the live app honours the disk cache at all —
// whether a stale JPEG really does reach the canvas and displace the render.
// That is this file's half, and it needs the running app:
//
//   Launch 1  clean       → the pipeline runs, the canvas lands on the
//                           Rust-predicted value, and a preview is persisted.
//   Launch 2  poisoned    → the persisted entry is overwritten with obviously
//                           wrong pixels; the canvas must now show them. This
//                           is the POSITIVE CONTROL: it proves the disk entry
//                           genuinely short-circuits the live pipeline, i.e.
//                           that the mechanism #1801 rode is real and that
//                           launch 3's assertion is not vacuous.
//   Launch 3  upgraded    → the same poisoned bytes are moved to a DIFFERENT
//                           variant digest — exactly what a version bump does
//                           to the key from the cache's point of view — and
//                           the canvas must be back on the correct value, with
//                           no stale short-circuit and no live-vs-refine
//                           divergence.
//
// The fixture is the COMMITTED synthetic grey card, not a gitignored RAW, so
// this gate runs everywhere rather than skip-passing on CI. Its L=0.18 patch
// renders to a known u8 mean (see `SyntheticGreyUITests`, sourced from
// `cargo test --test grey_adjustments dump_display_means`), which makes
// "correct render" an exact number rather than a tolerance band — and makes a
// stale-preview short-circuit unmissable.
//
//   xcodebuild test \
//     -project src/apple/Maple.xcodeproj \
//     -scheme "Maple Exposure" \
//     -destination 'platform=macOS' \
//     -only-testing:MapleUITests/PoisonedCacheUpgradeUITests

import XCTest

#if os(macOS)
import AppKit

final class PoisonedCacheUpgradeUITests: XCTestCase {

    /// The Rust-predicted u8 mean for the synthetic L=0.18 grey card at
    /// default adjustments — the same constant `SyntheticGreyUITests` gates on.
    private static let expectedMean = 134
    private static let meanToleranceLSB = 3

    /// The poisoned entry is a uniform WHITE JPEG. Whatever the chain does to
    /// it, it cannot come back near 134, so a canvas mean at or above this is
    /// unambiguous evidence the stale artifact reached the screen.
    private static let poisonMeanFloor = 200

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private static func syntheticRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/synthetic", isDirectory: true)
    }

    // MARK: - The gate

    func testStalePreviewFromAPreviousBuildDoesNotShortCircuitTheRender() throws {
        let root = Self.syntheticRoot()
        let dngURL = root.appendingPathComponent("grey-l018-rggb.dng")
        let xmpURL = root.appendingPathComponent("cases/default.xmp")
        guard FileManager.default.fileExists(atPath: dngURL.path) else {
            throw XCTSkip("synthetic DNG fixture missing at \(dngURL.path)")
        }

        let staged = try StagedFixture.stage(raw: dngURL, sidecar: xmpURL,
                                             label: "poisoned-cache")
        defer { staged.remove() }
        let previewDir = staged.directory.appendingPathComponent(".maple/previews")

        // ── Launch 1: clean. The pipeline runs and persists a preview. ──
        let cleanMean = try launchAndMeasureMean(staged)
        XCTAssertLessThanOrEqual(
            abs(cleanMean - Self.expectedMean), Self.meanToleranceLSB,
            "precondition: a clean open must land on the Rust-predicted mean "
            + "\(Self.expectedMean), measured \(cleanMean)")

        let entry = try XCTUnwrap(
            Self.soleCacheEntry(in: previewDir),
            "no preview was persisted to \(previewDir.path) — the app opened "
            + "with its rendered-preview cache disabled, so this gate cannot "
            + "run (check MAPLE_UITEST_PREVIEW_CACHE plumbing)")

        // ── Launch 2: poisoned at the CURRENT key. Positive control. ──
        try Self.poisonJPEG().write(to: previewDir.appendingPathComponent(entry),
                                    options: .atomic)
        let poisonedMean = try launchAndMeasureMean(staged)
        XCTAssertGreaterThanOrEqual(
            poisonedMean, Self.poisonMeanFloor,
            "the poisoned cache entry did not reach the canvas (mean "
            + "\(poisonedMean)) — without that short-circuit this gate proves "
            + "nothing about the upgrade case below")

        // ── Launch 3: the upgrade. Same bytes, under keys this build does not
        //    compute — which is exactly what a version bump does to the whole
        //    store. Every `.jpg` is re-keyed, not just the one launch 1 wrote,
        //    so a preview launch 2 re-persisted cannot mask the result. ──
        try Self.rekeyEverything(in: previewDir)
        let upgradedMean = try launchAndMeasureMean(staged)
        XCTAssertLessThanOrEqual(
            abs(upgradedMean - Self.expectedMean), Self.meanToleranceLSB,
            "after the upgrade the canvas measured \(upgradedMean), not the "
            + "Rust-predicted \(Self.expectedMean) — a preview this build's key "
            + "does not name still reached the screen (#1801)")
    }

    // MARK: - Launch + measure

    /// Launch Maple on `staged` with the rendered-preview disk cache enabled,
    /// wait for the canvas to settle after the refine pass, and return the
    /// canvas mean. Also asserts channel neutrality: the fixture is a neutral
    /// grey card, so any R/G/B split is a colour regression in the very chain
    /// the cache is short-circuiting.
    private func launchAndMeasureMean(_ staged: StagedFixture) throws -> Int {
        let app = XCUIApplication()
        app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = staged.raw.lastPathComponent
        app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = staged.directory.path
        // The harness normally runs with the cross-session preview cache OFF
        // (the fixture path skips the folder-open configure). This gate is the
        // one that needs it on — see AppShell+UITestFixture.
        app.launchEnvironment["MAPLE_UITEST_PREVIEW_CACHE"] = "1"
        // The expected mean is a Rust CPU view-tail value, matching
        // SyntheticGreyUITests.
        app.launchEnvironment["MAPLE_GPU_LIVE"] = "0"
        app.launch()
        defer { app.terminate() }

        let canvas = app.otherElements["canvas-render-ready"]
        guard let frame = CanvasCapture.waitForSettledCanvas(canvas) else {
            throw MeasureError.canvasNeverSettled
        }
        guard let png = CanvasCapture.canvasPNG(canvas, frame: frame) else {
            throw MeasureError.screenshotUnavailable
        }

        // Let the detached persist Task land before the app is torn down —
        // launch 1's whole purpose is the file it writes.
        Self.waitForPersist(in: staged.directory.appendingPathComponent(".maple/previews"))

        guard let rep = NSBitmapImageRep(data: png), let cg = rep.cgImage else {
            throw MeasureError.undecodableCapture
        }
        let stats = try Self.channelMeans(of: cg)
        XCTAssertLessThanOrEqual(
            max(abs(stats.r - stats.g), abs(stats.r - stats.b)), 2,
            "neutral grey fixture rendered non-neutral: R=\(stats.r) G=\(stats.g) B=\(stats.b)")
        return stats.r
    }

    /// Poll for the persisted preview for a bounded window. `persistCurrent
    /// PreviewToCache` fires a detached `Task`, so the write can trail the
    /// canvas sentinel by a beat; terminating the app before it lands would
    /// leave nothing to poison.
    private static func waitForPersist(in dir: URL, timeout: TimeInterval = 15) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if soleCacheEntry(in: dir) != nil { return }
            Thread.sleep(forTimeInterval: 0.25)
        }
    }

    /// Move every cached preview to a key of the same shape that this build
    /// will never compute — the cache's-eye view of a version bump, where the
    /// artifacts are all still there and none of them is addressable.
    private static func rekeyEverything(in dir: URL) throws {
        let jpgs = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".jpg") }
        for name in jpgs {
            let rekeyed = "\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))_stale.jpg"
            try FileManager.default.moveItem(at: dir.appendingPathComponent(name),
                                             to: dir.appendingPathComponent(rekeyed))
        }
    }

    /// The single `.jpg` in `dir`, or nil when there is not exactly one. The
    /// staged directory is private to this run and one asset is open at one
    /// viewport width, so anything else means the cache key story changed and
    /// the caller should not guess which file to poison.
    private static func soleCacheEntry(in dir: URL) -> String? {
        let jpgs = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
            .filter { $0.hasSuffix(".jpg") }
        return jpgs.count == 1 ? jpgs.first : nil
    }

    /// A uniform white JPEG standing in for "pixels a previous build produced".
    /// Content only has to be unmistakably NOT the L=0.18 grey render.
    private static func poisonJPEG() throws -> Data {
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: 512, pixelsHigh: 512,
            bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        guard let rep, let pixels = rep.bitmapData else { throw MeasureError.poisonEncodeFailed }
        pixels.update(repeating: 255, count: rep.bytesPerRow * rep.pixelsHigh)
        guard let jpeg = rep.representation(using: .jpeg, properties: [:]) else {
            throw MeasureError.poisonEncodeFailed
        }
        return jpeg
    }

    private static func channelMeans(of cg: CGImage) throws -> (r: Int, g: Int, b: Int) {
        let w = cg.width
        let h = cg.height
        var pixels = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(
            data: &pixels, width: w, height: h, bitsPerComponent: 8,
            bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
            throw MeasureError.undecodableCapture
        }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        let n = w * h
        let sums = (0..<n).reduce(into: (r: 0, g: 0, b: 0)) { acc, i in
            acc.r += Int(pixels[i * 4])
            acc.g += Int(pixels[i * 4 + 1])
            acc.b += Int(pixels[i * 4 + 2])
        }
        return ((sums.r + n / 2) / n, (sums.g + n / 2) / n, (sums.b + n / 2) / n)
    }

    private enum MeasureError: Error, CustomStringConvertible {
        case canvasNeverSettled
        case screenshotUnavailable
        case undecodableCapture
        case poisonEncodeFailed

        var description: String {
            switch self {
            case .canvasNeverSettled:
                return "canvas-render-ready never settled"
            case .screenshotUnavailable:
                return "canvas screenshot unavailable (sentinel flipped mid-capture)"
            case .undecodableCapture:
                return "could not decode the canvas capture into RGBA bytes"
            case .poisonEncodeFailed:
                return "could not build the poison JPEG"
            }
        }
    }
}
#endif // os(macOS)
