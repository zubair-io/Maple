// GoldenStore.swift — record-or-compare for canvas screenshots.
//
// First run, no baseline → write the PNG and FAIL the test with a
// "baseline written, please verify" message (matches
// pointfreeco/swift-snapshot-testing's first-run UX). Subsequent runs
// diff the candidate against the committed golden via the Swift
// CIEDE2000 port at Helpers/CIEDE2000.swift. Re-record by deleting
// the PNG.
//
// See docs/superpowers/plans/2026-04-25-xcuitest-visual-harness.md.

import XCTest
import CoreGraphics
import ImageIO
#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

struct GoldenBudget {
    let mean: Double
    let p95: Double
    let max: Double
    /// Per-channel absolute bias tolerance (gamma-encoded sRGB [0,1] units).
    let bias: Double
}

enum GoldenStore {
    /// Resolve the directory holding canonical goldens. Override via
    /// `MAPLE_UITEST_GOLDENS_ROOT`; otherwise walk the same candidate
    /// chain CIEDE2000Tests uses (CWD → ../../src/apple/...).
    static func goldensRoot() throws -> URL {
        if let root = ProcessInfo.processInfo.environment["MAPLE_UITEST_GOLDENS_ROOT"],
           !root.isEmpty {
            return URL(fileURLWithPath: root)
        }
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let candidates = [
            cwd.appendingPathComponent("src/apple/MapleUITests/Goldens"),
            cwd.appendingPathComponent("MapleUITests/Goldens"),
            cwd.appendingPathComponent("../../src/apple/MapleUITests/Goldens"),
        ]
        for c in candidates {
            if FileManager.default.fileExists(atPath: c.path) {
                return c.standardizedFileURL
            }
        }
        // Fall back to the first candidate (CWD-relative); the caller
        // will create it on first-run baseline write.
        return candidates[0].standardizedFileURL
    }

    /// Read the committed golden PNG bytes for `name`, or nil on first run.
    static func loadGolden(name: String) throws -> Data? {
        let url = try goldenURL(name: name)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return nil
        }
        return try Data(contentsOf: url)
    }

    /// Write `pngBytes` to the golden path for `name`, creating
    /// intermediate directories as needed.
    static func writeGolden(name: String, pngBytes: Data) throws -> URL {
        let url = try goldenURL(name: name)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try pngBytes.write(to: url)
        return url
    }

    /// Compare or record. On first run, writes the candidate to disk and
    /// XCTFails with a message asking the user to inspect the baseline.
    /// On subsequent runs, runs CIEDE2000 against the golden and asserts
    /// the metrics fall under `budget`.
    ///
    /// The diff JSON is dumped to stderr on failure so CI logs preserve
    /// it; failure messages quote mean / p95 / max so a single test log
    /// line tells the reader which gate tripped.
    static func compareOrRecord(name: String,
                                candidate pngBytes: Data,
                                budget: GoldenBudget,
                                file: StaticString = #file,
                                line: UInt = #line) throws {
        if let golden = try loadGolden(name: name) {
            // Diff path.
            let (candRGBA, cw, ch) = try Self.decodeRGBA(pngBytes)
            let (refRGBA, rw, rh) = try Self.decodeRGBA(golden)
            guard cw == rw, ch == rh else {
                XCTFail("Golden size mismatch for \(name): " +
                        "candidate \(cw)x\(ch) vs golden \(rw)x\(rh)",
                        file: file, line: line)
                return
            }
            guard let result = CIEDE2000.compare(
                candidateRGBA: candRGBA,
                referenceRGBA: refRGBA,
                width: cw,
                height: ch
            ) else {
                XCTFail("CIEDE2000.compare returned nil for \(name)",
                        file: file, line: line)
                return
            }

            let report = """
                {"name":"\(name)","mean":\(result.meanDeltaE),\
                "p95":\(result.p95DeltaE),"max":\(result.maxDeltaE),\
                "bias_r":\(result.biasR),"bias_g":\(result.biasG),\
                "bias_b":\(result.biasB),"n_pixels":\(result.nPixels)}
                """

            var failures: [String] = []
            if result.meanDeltaE > budget.mean {
                failures.append("mean ΔE \(result.meanDeltaE) > \(budget.mean)")
            }
            if result.p95DeltaE > budget.p95 {
                failures.append("p95 ΔE \(result.p95DeltaE) > \(budget.p95)")
            }
            if result.maxDeltaE > budget.max {
                failures.append("max ΔE \(result.maxDeltaE) > \(budget.max)")
            }
            for (channel, value) in [("R", result.biasR),
                                     ("G", result.biasG),
                                     ("B", result.biasB)] {
                if abs(value) > budget.bias {
                    failures.append("bias \(channel) \(value) outside ±\(budget.bias)")
                }
            }

            FileHandle.standardError.write(Data((report + "\n").utf8))

            if !failures.isEmpty {
                XCTFail("Golden \(name) failed: \(failures.joined(separator: "; "))",
                        file: file, line: line)
            }
        } else {
            // First-run baseline write.
            let url = try writeGolden(name: name, pngBytes: pngBytes)
            XCTFail(
                "baseline written for \(name) at \(url.path) — " +
                "open it, verify it looks correct, then commit and re-run.",
                file: file, line: line
            )
        }
    }

    // MARK: - Internal

    private static func goldenURL(name: String) throws -> URL {
        let root = try goldensRoot()
        // Goldens use `<name>.png` directly under the goldens root.
        return root.appendingPathComponent("\(name).png")
    }

    /// Decode PNG bytes to interleaved RGBA8 in sRGB. Same approach as
    /// CIEDE2000Tests.loadRGBA — we pin to sRGB explicitly so wide-gamut
    /// Macs don't re-encode the bytes through the device color space
    /// before flattening.
    private static func decodeRGBA(_ data: Data) throws -> ([UInt8], Int, Int) {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
        else {
            throw NSError(domain: "GoldenStore", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "PNG decode failed"])
        }
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
            throw NSError(domain: "GoldenStore", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "CGContext failed"])
        }
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: width, height: height))
        return (bytes, width, height)
    }
}
