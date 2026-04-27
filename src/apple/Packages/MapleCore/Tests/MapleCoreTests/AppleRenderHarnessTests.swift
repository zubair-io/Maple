// AppleRenderHarnessTests.swift — Apple-side render harness measuring the
// LIVE Metal kernel chain against ACR-rendered references.
//
// Why this exists (vs the Rust-side `calibrate_color_pipeline.sh`):
//
//   The Rust harness renders through `maple-cli`, a pure-Rust binary. The
//   user's app runs the same Rust core for SCENE-LINEAR DECODE only — every
//   downstream stage (WB delta, tone, vibrance, clarity, dehaze, sharpen,
//   NR, AgX) ships as Apple Metal kernels invoked through Core Image. The
//   Rust path's `apply` functions and the Metal kernels are independent
//   ports of the same math, so floating-point drift between them is
//   measurable — and meaningful, because the user's screen reflects the
//   Apple path, not the Rust path.
//
//   This harness fills that measurement gap. It exercises the same public
//   `ImageEditPipeline` API that `EditSession` calls in production
//   (`decodeSceneLinear` → `processSceneLinear`), with the same
//   `extendedLinearSRGB` working space + `RGBAh` working format the
//   `ImageEditPipeline.init` CIContext uses, and rasterises through a
//   sRGB `RGBA8` `createCGImage` boundary so the resulting PNG matches
//   what the canvas would land on a sRGB display. (The live canvas
//   `CIImageView` ships P3 16-bit; we keep this harness on sRGB 8-bit so
//   it diffs directly against the calibration references, which are the
//   same shape.)
//
// Outputs per fixture <stem> (default scope: `baseline.xmp` only):
//   1. PNG written to `test-fixtures/diagnostics/apple_path/<stem>_baseline.png`
//   2. CIEDE2000 mean / P95 / max + per-channel bias logged to stderr
//   3. Per-fixture mean ΔE gated against `MAPLE_APPLE_RENDER_BUDGET`
//      (default 15; use a high value the first time, then ratchet down).
//
// Discovery walks `test-fixtures/references/test_*/xmp/baseline.xmp` so
// fixtures added later (test_0018+) appear automatically. Skip-passes when
// neither the RAW nor the reference is present (gitignored CI without
// fixtures).
//
// Cross-references:
//   src/scripts/calibrate_color_pipeline.sh                (Rust-side gate)
//   src/scripts/apple_render_diff.py                       (per-region + matrix solver)
//   src/apple/Maple/Views/FullImageView.swift:441-467      (live canvas CIContext config)
//   src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift
//   src/apple/MapleUITests/Helpers/CIEDE2000.swift         (sister CIEDE2000 port)

import XCTest
import CoreImage
import CoreGraphics
import AppKit
@testable import MapleCore

final class AppleRenderHarnessTests: XCTestCase {

    // MARK: - Repo / fixture path resolution

    /// Walk to the repo root from `#filePath`. Mirrors
    /// `SceneLinearVisualRegressionTests.repoRoot`.
    ///
    /// `<repoRoot>/src/apple/Packages/MapleCore/Tests/MapleCoreTests/<file>.swift`
    /// → 7 levels up.
    private static func repoRoot() -> URL {
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // MapleCore/
            .deletingLastPathComponent()  // Packages/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // repo root
    }

    /// Fixture-references root; default `<repoRoot>/test-fixtures/references`.
    /// Override via `MAPLE_REFERENCES_ROOT`.
    ///
    /// The harness lives in a worktree at `.claude/worktrees/<id>/...`; in
    /// that case the natural `repoRoot()` walk lands at the worktree root,
    /// which doesn't contain the gitignored `test-fixtures/`. The fallback
    /// climbs one more level to the parent worktree-host before giving up
    /// — that lets `swift test` from a worktree pick up the canonical
    /// fixtures that live in the parent checkout.
    private static func referencesRoot() -> URL {
        if let explicit = ProcessInfo.processInfo.environment["MAPLE_REFERENCES_ROOT"],
           !explicit.isEmpty {
            return URL(fileURLWithPath: explicit)
        }
        let primary = repoRoot().appendingPathComponent("test-fixtures/references")
        if FileManager.default.fileExists(atPath: primary.path) {
            return primary
        }
        // Worktree fallback — repoRoot() in a worktree resolves to the
        // worktree dir itself; climb two levels (`.claude/worktrees/<id>`)
        // to find the host repo.
        let host = repoRoot()
            .deletingLastPathComponent()  // worktrees
            .deletingLastPathComponent()  // .claude
            .deletingLastPathComponent()  // host repo
            .appendingPathComponent("test-fixtures/references")
        return host
    }

    /// RAW-fixtures root; default `<repoRoot>/test-fixtures/raws`. Same
    /// worktree-fallback pattern as `referencesRoot`.
    private static func rawsRoot() -> URL {
        if let explicit = ProcessInfo.processInfo.environment["MAPLE_VISUAL_FIXTURE_ROOT"],
           !explicit.isEmpty {
            return URL(fileURLWithPath: explicit)
        }
        let primary = repoRoot().appendingPathComponent("test-fixtures/raws")
        if FileManager.default.fileExists(atPath: primary.path) {
            return primary
        }
        let host = repoRoot()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("test-fixtures/raws")
        return host
    }

    /// Diagnostics output dir; default `<repoRoot>/test-fixtures/diagnostics/apple_path`.
    /// Override via `MAPLE_APPLE_DIAG_ROOT`.
    private static func diagnosticsRoot() -> URL {
        if let explicit = ProcessInfo.processInfo.environment["MAPLE_APPLE_DIAG_ROOT"],
           !explicit.isEmpty {
            return URL(fileURLWithPath: explicit)
        }
        let primary = repoRoot().appendingPathComponent("test-fixtures/diagnostics/apple_path")
        if FileManager.default.fileExists(atPath: repoRoot().appendingPathComponent("test-fixtures").path) {
            return primary
        }
        return repoRoot()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("test-fixtures/diagnostics/apple_path")
    }

    /// Per-fixture mean-ΔE gate. Default `15.0` matches the Rust harness's
    /// `BUDGET` default. Override via `MAPLE_APPLE_RENDER_BUDGET`.
    private static func renderBudget() -> Double {
        if let explicit = ProcessInfo.processInfo.environment["MAPLE_APPLE_RENDER_BUDGET"],
           let parsed = Double(explicit), parsed > 0 {
            return parsed
        }
        return 15.0
    }

    // MARK: - Fixture discovery

    /// Walk the references root and emit `(stem, rawURL, xmpURL, refPNG)`
    /// tuples for fixtures that have a baseline.xmp + baseline.png + an
    /// existing RAW. Returns an empty array (no skip / no error) when the
    /// references root is absent — test methods then call `XCTSkip`.
    private static func discoverBaselineFixtures()
        -> [(stem: String, rawURL: URL, xmpURL: URL, refPNGURL: URL)] {
        let referencesRoot = referencesRoot()
        guard FileManager.default.fileExists(atPath: referencesRoot.path) else {
            return []
        }
        let rawsRoot = rawsRoot()

        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: referencesRoot,
                                                        includingPropertiesForKeys: nil,
                                                        options: [.skipsHiddenFiles])
        else { return [] }

        var out: [(stem: String, rawURL: URL, xmpURL: URL, refPNGURL: URL)] = []
        for dir in entries {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else {
                continue
            }
            let stem = dir.lastPathComponent
            // We only want test_NNNN dirs.
            guard stem.hasPrefix("test_") else { continue }
            let xmpURL = dir.appendingPathComponent("xmp/baseline.xmp")
            let refPNGURL = dir.appendingPathComponent("down/baseline.png")
            guard fm.fileExists(atPath: xmpURL.path),
                  fm.fileExists(atPath: refPNGURL.path)
            else { continue }
            // Find the matching RAW. Manifest.json maps stem to the actual
            // case-sensitive extension; the simpler fallback here scans
            // common RAW extensions. test_0000.DNG, test_0001.RAW, etc.
            let rawCandidates = ["DNG", "dng", "RAW", "raw",
                                 "CR2", "cr2", "ARW", "arw",
                                 "NEF", "nef", "RAF", "raf",
                                 "X3F", "x3f", "FFF", "fff"]
            var rawURL: URL? = nil
            for ext in rawCandidates {
                let cand = rawsRoot.appendingPathComponent("\(stem).\(ext)")
                if fm.fileExists(atPath: cand.path) {
                    rawURL = cand
                    break
                }
            }
            guard let rawURL else { continue }
            out.append((stem: stem, rawURL: rawURL, xmpURL: xmpURL, refPNGURL: refPNGURL))
        }
        return out.sorted { $0.stem < $1.stem }
    }

    // MARK: - Render helper

    /// Single-fixture render helper. Mirrors the live app's path:
    ///   1. `decodeSceneLinear(asset:xmpPath:)`             — Rust FFI
    ///   2. `processSceneLinear(decoded:model:targetSize:asShot:decodedAtModel:)`
    ///                                                       — Apple Metal kernels
    ///   3. `CIContext.createCGImage(_, format:.RGBA8, colorSpace:sRGB)`
    ///                                                       — sRGB 8-bit raster
    ///
    /// The CIContext settings (extendedLinearSRGB working space + RGBAh
    /// working format + cacheIntermediates: false) match
    /// `ImageEditPipeline.init`. Output color space + format match
    /// `SceneLinearVisualRegressionTests` (sRGB 8-bit) so the resulting
    /// PNG diffs directly against the calibration references.
    private static func renderApplePNG(
        rawURL: URL,
        xmpURL: URL,
        refPNGURL: URL,
        stem: String
    ) async throws -> Data {
        let pipeline = ImageEditPipeline()
        let asset = AssetRef(url: rawURL)

        guard let decoded = await pipeline.decodeSceneLinear(
            asset: asset,
            quality: .preview,                  // matches the editor's slider path
            xmpPath: xmpURL
        ) else {
            throw NSError(domain: "AppleRenderHarness", code: 1,
                          userInfo: [NSLocalizedDescriptionKey:
                                     "decodeSceneLinear returned nil for \(rawURL.path)"])
        }

        // Live app uses `EditSession.parseSidecarModel` to feed
        // `decodedAtModel`; replicate that here so the WB kernel applies
        // only the (live - decoded) delta, not the full sidecar twice.
        let decodedAtModel: AdjustmentModel = {
            guard let xml = try? String(contentsOf: xmpURL, encoding: .utf8),
                  let (m, _) = try? XMPParser.parse(xml)
            else {
                return .default
            }
            return m
        }()

        // The "live model" the kernel chain processes against is the same
        // model the FFI used at decode time (since this harness simulates a
        // single-frame "open file with sidecar applied" scenario, not a
        // mid-edit slider state). The WB kernel's identity short-circuit
        // therefore takes effect: live_temp == decoded_temp, live_tint ==
        // decoded_tint, so WB is a no-op delta. This intentionally puts
        // every other Metal kernel on a "default-state" exercise — they
        // all run, but with the model already baked into the FFI buffer.
        let liveModel = decodedAtModel

        // As-shot WB — read from the file metadata, same as the live app.
        // Pass via the `asShot` argument so the WB kernel has the same
        // metered baseline as the editor session.
        let asShot: ImageEditPipeline.AsShotWB? = {
            guard let raw = ImageMetadataReader.readAsShotWB(from: rawURL) else {
                return nil
            }
            return ImageEditPipeline.AsShotWB(
                temperature: raw.temperature,
                tint: raw.tint
            )
        }()

        // Match the reference's pixel dimensions. ACR refs at `down/` are
        // 4000-px-long-edge; rendering through Apple's Lanczos prescale at
        // the same target keeps both sides on apples-to-apples geometry
        // (no resampling happens in the diff helper).
        let refExtent = try Self.peekPNGSize(at: refPNGURL)
        let targetSize = CGSize(width: refExtent.width, height: refExtent.height)

        let processed = pipeline.processSceneLinear(
            decoded: decoded,
            model: liveModel,
            targetSize: targetSize,
            asShot: asShot,
            decodedAtModel: decodedAtModel
        )

        // CIContext mirrors `ImageEditPipeline.init` (and therefore
        // `SceneLinearVisualRegressionTests`). The final raster is sRGB 8-bit
        // — same shape as the calibration references.
        let workingSpace = CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!
        let outputSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        let ciContext: CIContext
        if let device = MTLCreateSystemDefaultDevice() {
            ciContext = CIContext(mtlDevice: device, options: [
                .workingColorSpace: workingSpace,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        } else {
            ciContext = CIContext(options: [
                .workingColorSpace: workingSpace,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        }

        let extent = processed.extent
        guard extent.width > 0, extent.height > 0 else {
            throw NSError(domain: "AppleRenderHarness", code: 2,
                          userInfo: [NSLocalizedDescriptionKey:
                                     "processed CIImage has zero extent for \(stem)"])
        }
        guard let cg = ciContext.createCGImage(
            processed,
            from: extent,
            format: .RGBA8,
            colorSpace: outputSpace
        ) else {
            throw NSError(domain: "AppleRenderHarness", code: 3,
                          userInfo: [NSLocalizedDescriptionKey:
                                     "createCGImage returned nil for \(stem)"])
        }

        guard let png = pngData(from: cg) else {
            throw NSError(domain: "AppleRenderHarness", code: 4,
                          userInfo: [NSLocalizedDescriptionKey:
                                     "PNG encode failed for \(stem)"])
        }
        return png
    }

    /// PNG → CGImage size only (no pixel decode). Cheaper than fully
    /// decoding a 4000×3000 PNG just to read its dimensions.
    private static func peekPNGSize(at url: URL) throws -> (width: Int, height: Int) {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
        else {
            throw NSError(domain: "AppleRenderHarness", code: 5,
                          userInfo: [NSLocalizedDescriptionKey:
                                     "CGImageSource open failed for \(url.path)"])
        }
        let w = props[kCGImagePropertyPixelWidth] as? Int ?? 0
        let h = props[kCGImagePropertyPixelHeight] as? Int ?? 0
        return (w, h)
    }

    /// Encode a CGImage to PNG bytes via NSBitmapImageRep. Same approach
    /// as `SceneLinearVisualRegressionTests.pngData(from:)`.
    private static func pngData(from cgImage: CGImage) -> Data? {
        let rep = NSBitmapImageRep(cgImage: cgImage)
        return rep.representation(using: .png, properties: [:])
    }

    /// Decode a PNG into interleaved sRGB RGBA8. Pinned to sRGB so wide-
    /// gamut Macs don't reinterpret the bytes through the device color
    /// space — same approach as `GoldenStore.decodeRGBA`.
    private static func decodeSRGBRGBA(_ data: Data) throws
        -> (bytes: [UInt8], width: Int, height: Int) {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
        else {
            throw NSError(domain: "AppleRenderHarness", code: 6,
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
            throw NSError(domain: "AppleRenderHarness", code: 7,
                          userInfo: [NSLocalizedDescriptionKey: "CGContext failed"])
        }
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: width, height: height))
        return (bytes, width, height)
    }

    // MARK: - Test entry

    /// Render every discovered baseline fixture, write the diagnostic PNG
    /// to disk, and assert per-fixture mean ΔE under
    /// `MAPLE_APPLE_RENDER_BUDGET`.
    ///
    /// One test method covers the whole sweep so a single `swift test` run
    /// produces the entire diagnostic table — Python diff (`apple_render_diff.py`)
    /// can then read the PNGs and crunch the per-region + matrix-solve
    /// numbers without re-running the Metal pipeline.
    func testAppleRenderHarness_baselineSweep() async throws {
        let fixtures = Self.discoverBaselineFixtures()
        guard !fixtures.isEmpty else {
            throw XCTSkip(
                "No reference fixtures found. Set MAPLE_REFERENCES_ROOT or " +
                "ensure test-fixtures/references/test_*/{xmp,down}/baseline.* " +
                "exist."
            )
        }

        let diagDir = Self.diagnosticsRoot()
        try FileManager.default.createDirectory(
            at: diagDir, withIntermediateDirectories: true
        )

        let budget = Self.renderBudget()
        var failures: [String] = []
        var rows: [String] = []
        rows.append(String(format: "%-12s %-9s %-7s %-7s %-7s %-9s %-9s %-9s",
                           "fixture", "n_pix(M)", "mean", "p95", "max",
                           "bR", "bG", "bB"))
        rows.append(String(repeating: "-", count: 84))

        for fix in fixtures {
            let png: Data
            do {
                png = try await Self.renderApplePNG(
                    rawURL: fix.rawURL,
                    xmpURL: fix.xmpURL,
                    refPNGURL: fix.refPNGURL,
                    stem: fix.stem
                )
            } catch {
                failures.append("\(fix.stem): render failed — \(error.localizedDescription)")
                rows.append(String(format: "%-12s render-failed: %@",
                                   fix.stem, error.localizedDescription))
                continue
            }

            // Save PNG under `<diagRoot>/<stem>_baseline.png` so the
            // Python diff helper can read it.
            let outURL = diagDir.appendingPathComponent("\(fix.stem)_baseline.png")
            try png.write(to: outURL)

            // Diff via the Swift CIEDE2000 port. Both sides must be the
            // same dimensions; we already targeted the reference's
            // long-edge through Lanczos prescale, but the per-pixel
            // counts can still differ by ±1 due to integer rounding in
            // Lanczos's `floor(extent * scale)` clamp. Resample the
            // candidate to the reference's exact dims if they don't match.
            let refData = try Data(contentsOf: fix.refPNGURL)
            let candDecoded = try Self.decodeSRGBRGBA(png)
            let refDecoded = try Self.decodeSRGBRGBA(refData)
            let (candBytes, candW, candH): ([UInt8], Int, Int)
            if candDecoded.width == refDecoded.width,
               candDecoded.height == refDecoded.height {
                candBytes = candDecoded.bytes
                candW = candDecoded.width
                candH = candDecoded.height
            } else {
                // Resample the candidate to the reference's pixel grid
                // via a CGContext draw — covers off-by-one Lanczos drift
                // (e.g. 3998×2997 vs 4000×2997) without re-running the
                // Metal pipeline.
                let resampled = try Self.resampleSRGBRGBA(
                    bytes: candDecoded.bytes,
                    fromWidth: candDecoded.width,
                    fromHeight: candDecoded.height,
                    toWidth: refDecoded.width,
                    toHeight: refDecoded.height
                )
                candBytes = resampled
                candW = refDecoded.width
                candH = refDecoded.height
            }

            guard let result = CIEDE2000.compare(
                candidateRGBA: candBytes,
                referenceRGBA: refDecoded.bytes,
                width: candW,
                height: candH
            ) else {
                failures.append("\(fix.stem): CIEDE2000 compare returned nil")
                continue
            }

            let nM = Double(result.nPixels) / 1_000_000.0
            rows.append(String(format: "%-12s %-9.2f %-7.2f %-7.2f %-7.2f %+9.4f %+9.4f %+9.4f",
                               fix.stem, nM,
                               result.meanDeltaE, result.p95DeltaE, result.maxDeltaE,
                               result.biasR, result.biasG, result.biasB))

            if result.meanDeltaE > budget {
                failures.append(String(format: "%@: mean ΔE %.2f > budget %.2f",
                                       fix.stem,
                                       result.meanDeltaE,
                                       budget))
            }
        }

        // Report — print the table to stderr so it survives `swift test`'s
        // log pipeline. Mirrors `calibrate_color_pipeline.sh`'s output
        // shape so reviewers can side-by-side the Apple-vs-Rust paths.
        let table = rows.joined(separator: "\n")
        FileHandle.standardError.write(Data(("\n[apple-render]\n" + table + "\n").utf8))

        if !failures.isEmpty {
            XCTFail("apple-render harness: \(failures.count) failures: " +
                    failures.joined(separator: "; "))
        }
    }

    /// CGContext-based RGBA8 resample. Used when the rendered candidate
    /// drifts ±1 pixel from the reference grid. Returns interleaved sRGB
    /// RGBA8.
    private static func resampleSRGBRGBA(
        bytes: [UInt8],
        fromWidth: Int,
        fromHeight: Int,
        toWidth: Int,
        toHeight: Int
    ) throws -> [UInt8] {
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let bitmapInfo: UInt32 = CGImageAlphaInfo.premultipliedLast.rawValue
            | CGBitmapInfo.byteOrder32Big.rawValue
        var src = bytes
        guard let srcCtx = CGContext(
            data: &src,
            width: fromWidth,
            height: fromHeight,
            bitsPerComponent: 8,
            bytesPerRow: fromWidth * 4,
            space: cs,
            bitmapInfo: bitmapInfo
        ), let srcImg = srcCtx.makeImage() else {
            throw NSError(domain: "AppleRenderHarness", code: 8,
                          userInfo: [NSLocalizedDescriptionKey: "resample src ctx failed"])
        }
        var dst = [UInt8](repeating: 0, count: toWidth * toHeight * 4)
        guard let dstCtx = CGContext(
            data: &dst,
            width: toWidth,
            height: toHeight,
            bitsPerComponent: 8,
            bytesPerRow: toWidth * 4,
            space: cs,
            bitmapInfo: bitmapInfo
        ) else {
            throw NSError(domain: "AppleRenderHarness", code: 9,
                          userInfo: [NSLocalizedDescriptionKey: "resample dst ctx failed"])
        }
        dstCtx.interpolationQuality = .high
        dstCtx.draw(srcImg, in: CGRect(x: 0, y: 0, width: toWidth, height: toHeight))
        return dst
    }
}
