// SliderMatrixUITests.swift — slider-state matrix harness (Ticket 10-C).
//
// Companion to MapleUITests.testCanvasMatchesGolden, which renders ONE
// fixture (test_0017.dng) with the DEFAULT model. This test runs the
// full slider-state matrix the references repo prepared for it: every
// committed `crs:` slider case in `test-fixtures/references/<stem>/xmp/`
// against the matching reference-rendered PNG in `<stem>/down/`.
//
// Per case it:
//   1. Stages a tmp dir with `<stem>.dng` (or .DNG/.RAW/.CR2/...) +
//      `<stem>.xmp` (the slider XMP renamed to the canonical sidecar
//      path so EditSession.loadSidecar() reads it on app open).
//   2. Re-launches Maple with MAPLE_UITEST_FIXTURE=<stem>.<ext> and
//      MAPLE_UITEST_FIXTURE_ROOT=<tmp>.
//   3. Waits for canvas-render-ready (refine pass published).
//   4. Screenshots the canvas.
//   5. Resizes both candidate + reference to a common 1024px long
//      edge to neutralize the 4000px-vs-canvas-points size mismatch
//      and keep CIEDE2000 fast.
//   6. Records ΔE₀₀ + per-channel bias, asserts under budget.
//   7. Attaches the failed pair as XCTAttachments on miss for triage.
//
// Skips fixture-by-fixture when:
//   - the DNG isn't present in test-fixtures/raws/ (gitignored)
//   - the references dir for the fixture has no `down/` PNGs (only
//     test_0000-0003 currently carry references; the rest are XMPs
//     waiting on a future reference-render pass)
//
// Budgets are deliberately loose for v1 — Maple AgX vs the reference's view
// transform produces non-trivial deltas even when color math is
// pristine. Ratchet downward as the pipeline tightens.
//
// Cross-links:
//   docs/tickets/10-tier-3-resume-queue.md item C
//   src/apple/MapleUITests/Helpers/MapleAppDriver.swift
//   src/apple/MapleUITests/Helpers/GoldenStore.swift
//   src/apple/MapleUITests/Helpers/CIEDE2000.swift
//   src/scripts/test_color_pipeline.sh (Rust-side analogue)

import XCTest
// SliderMatrixUITests uses MapleAppDriver + AppKit for macOS live-UI driving.
// Gate it out on iOS so the target can compile for iOS Simulator (M6 #1244).
#if os(macOS)
import AppKit
import CoreImage
import ImageIO

final class SliderMatrixUITests: XCTestCase {

    // MARK: - Budgets (loose v1; ratchet downward only)

    /// Per-case CIEDE2000 + bias budget. Maple AgX view transform vs the
    /// third-party reference renderer produces ~10–20 ΔE on a typical scene even when the
    /// upstream color math is correct — these limits accept that floor
    /// while still catching regressions that double the delta.
    private static let budget = GoldenBudget(mean: 25, p95: 50, max: 100, bias: 0.10)

    /// Long-edge target for both candidate and reference before diff.
    /// The 4000px `down/` references are too large for fast per-case
    /// CIEDE2000; the canvas screenshot is typically a few-hundred-points
    /// × backing-scale. 1024 is a workable common ground that preserves
    /// enough chroma signal without choking the pixel loop.
    private static let diffLongEdge: Int = 1024

    /// Compile-time case filter, for local triage when the environment
    /// variable can't be plumbed through. `xcodebuild` does NOT forward
    /// plain (or `TEST_RUNNER_`-prefixed) env vars into the UI-test process
    /// on this project's scheme, so a one-case run is otherwise a 90-minute
    /// wait. Keep "" on main — CI must run the whole matrix.
    static let hardcodedCaseFilter = ""

    // MARK: - Fixture / reference resolution

    private static let fixtureExtensions = [
        "dng", "DNG",
        "RAW", "raw",
        "CR2", "cr2", "CR3", "cr3",
        "NEF", "nef",
        "ARW", "arw",
        "RAF", "raf",
        "fff", "FFF",
    ]

    /// Walk #filePath up to the repo root.
    /// `.../src/apple/MapleUITests/Self.swift` → 4 levels up.
    private static func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleUITests/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // repo root
    }

    private static func rawsDir() -> URL {
        if let env = ProcessInfo.processInfo.environment["MAPLE_UITEST_FIXTURE_ROOT"],
           !env.isEmpty {
            return URL(fileURLWithPath: env)
        }
        return repoRoot().appendingPathComponent("test-fixtures/raws")
    }

    private static func referencesDir() -> URL {
        if let env = ProcessInfo.processInfo.environment["MAPLE_VISUAL_REFERENCES_ROOT"],
           !env.isEmpty {
            return URL(fileURLWithPath: env)
        }
        return repoRoot().appendingPathComponent("test-fixtures/references")
    }

    /// Find the on-disk RAW for `stem` (e.g. "test_0000") by trying
    /// every known fixture extension. Returns nil if none exists.
    private static func resolveRAW(stem: String, in dir: URL) -> URL? {
        for ext in fixtureExtensions {
            let url = dir.appendingPathComponent("\(stem).\(ext)")
            if FileManager.default.fileExists(atPath: url.path) {
                return url
            }
        }
        return nil
    }

    // MARK: - Per-case CIEDE2000 result

    private struct CaseResult {
        let stem: String
        let caseName: String
        let metrics: CIEDE2000Result?
        let failureReasons: [String]   // empty on pass
    }

    // MARK: - The matrix test

    /// Iterate every fixture in `test-fixtures/references/test_NNNN/` that
    /// has a reference-rendered `down/` PNG, pair each PNG with its sibling
    /// `xmp/<case>.xmp`, render the case via the live Mac app, and diff.
    /// Skips fixtures missing locally; XCTSkip if NO fixture has any
    /// renderable case (mirrors test_color_pipeline.sh's empty-fixtures
    /// pattern).
    func testSliderMatrixVsReferences() throws {
        let raws = Self.rawsDir()
        let refs = Self.referencesDir()
        guard FileManager.default.fileExists(atPath: refs.path) else {
            throw XCTSkip("references dir missing: \(refs.path)")
        }

        // Discover stems with both an `xmp/` folder AND a `down/` folder.
        let fm = FileManager.default
        let stems = (try? fm.contentsOfDirectory(atPath: refs.path))?
            .sorted()
            .filter { name in
                let base = refs.appendingPathComponent(name)
                let xmpDir = base.appendingPathComponent("xmp").path
                let downDir = base.appendingPathComponent("down").path
                var isDir: ObjCBool = false
                let xmpExists = fm.fileExists(atPath: xmpDir, isDirectory: &isDir) && isDir.boolValue
                isDir = false
                let downExists = fm.fileExists(atPath: downDir, isDirectory: &isDir) && isDir.boolValue
                return xmpExists && downExists && name.hasPrefix("test_")
            } ?? []

        var results: [CaseResult] = []
        var skippedStems: [String] = []
        var renderedCount = 0

        for stem in stems {
            guard let rawURL = Self.resolveRAW(stem: stem, in: raws) else {
                skippedStems.append("\(stem) (no RAW in \(raws.path))")
                continue
            }
            let stemDir = refs.appendingPathComponent(stem)
            let downDir = stemDir.appendingPathComponent("down")
            let xmpDir = stemDir.appendingPathComponent("xmp")

            guard let downPNGs = try? fm.contentsOfDirectory(atPath: downDir.path),
                  !downPNGs.isEmpty else {
                continue
            }

            for downName in downPNGs.sorted() where downName.hasSuffix(".png") {
                let caseName = String(downName.dropLast(".png".count))
                // Optional subset filter, mirroring `FILTER=` in
                // `src/scripts/test_color_pipeline.sh`. Substring match
                // against "stem/case" — a full matrix run is ~90 min, so
                // triaging one case needs a way in that isn't "wait 90
                // minutes". Unset = run everything (CI behaviour).
                let envFilter = ProcessInfo.processInfo.environment["MAPLE_UITEST_CASE_FILTER"]
                let filter = envFilter.flatMap { $0.isEmpty ? nil : $0 }
                    ?? Self.hardcodedCaseFilter
                if !filter.isEmpty, !"\(stem)/\(caseName)".contains(filter) {
                    continue
                }
                let xmpURL = xmpDir.appendingPathComponent("\(caseName).xmp")
                let refPNG = downDir.appendingPathComponent(downName)
                guard fm.fileExists(atPath: xmpURL.path) else { continue }
                guard fm.fileExists(atPath: refPNG.path) else { continue }

                do {
                    let result = try renderAndDiff(
                        rawURL: rawURL,
                        xmpURL: xmpURL,
                        referencePNG: refPNG,
                        stem: stem,
                        caseName: caseName
                    )
                    results.append(result)
                    renderedCount += 1
                } catch {
                    results.append(CaseResult(
                        stem: stem,
                        caseName: caseName,
                        metrics: nil,
                        failureReasons: ["render-or-diff threw: \(error)"]
                    ))
                }
            }
        }

        // Always emit the JSON report so CI logs preserve it.
        emitReport(results: results, skippedStems: skippedStems)

        if renderedCount == 0 {
            throw XCTSkip("no renderable (RAW + XMP + reference PNG) cases found — " +
                          "populate test-fixtures/raws/ + test-fixtures/references/")
        }

        let failures = results.filter { !$0.failureReasons.isEmpty }
        if !failures.isEmpty {
            let summary = failures.map { r in
                "\(r.stem)/\(r.caseName): \(r.failureReasons.joined(separator: "; "))"
            }.joined(separator: "\n  ")
            XCTFail("Slider-matrix failures (\(failures.count)/\(results.count)):\n  \(summary)")
        }
    }

    // MARK: - Render one case

    /// Stage a tmp fixture dir, launch the app pointed at it, screenshot
    /// the canvas, and CIEDE2000-compare against the reference.
    private func renderAndDiff(rawURL: URL,
                               xmpURL: URL,
                               referencePNG: URL,
                               stem: String,
                               caseName: String) throws -> CaseResult {
        // Stage RAW + XMP into tmp under the canonical sidecar layout
        // (`<stem>.<ext>` + `<stem>.xmp`) — see `StagedFixture`.
        let staged = try StagedFixture.stage(raw: rawURL, sidecar: xmpURL,
                                             label: "slider-matrix")
        defer { staged.remove() }

        // Launch Maple pointed at the tmp dir, with the staged RAW as
        // the seed fixture.
        let app = XCUIApplication()
        app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = staged.raw.lastPathComponent
        app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = staged.directory.path
        // Pin the CPU + Metal render path: each case diffs the canvas
        // against an ACR/CPU reference, so disable the default-on (#1064)
        // GPU live path and keep the render byte-comparable to the reference.
        app.launchEnvironment["MAPLE_GPU_LIVE"] = "0"
        app.launch()
        defer { app.terminate() }

        // Wait for the refine pass — and require the sentinel to SETTLE
        // before capturing (#2277). See `CanvasCapture` for why a bare
        // `exists == 1` wait races a follow-on render.
        let canvas = app.otherElements["canvas-render-ready"]
        guard let frame = CanvasCapture.waitForSettledCanvas(canvas) else {
            return CaseResult(
                stem: stem,
                caseName: caseName,
                metrics: nil,
                failureReasons:
                    ["canvas-render-ready never settled "
                     + "(\(Int(CanvasCapture.settleDeadline))s)"]
            )
        }

        // `frame` came back from `waitForSettledCanvas`, read there while the
        // element was known up; `CanvasCapture.canvasPNG` is the only thing
        // that touches `canvas` afterwards, behind its own `exists` guard.
        let candidatePNG: Data? = CanvasCapture.canvasPNG(canvas, frame: frame)

        guard let candidatePNG else {
            return CaseResult(
                stem: stem,
                caseName: caseName,
                metrics: nil,
                failureReasons: ["canvas screenshot unavailable (sentinel flipped mid-capture)"]
            )
        }

        // Resize both to the common diff size + RGBA8 buffer + diff.
        let referenceData = try Data(contentsOf: referencePNG)
        let (candRGBA, cw, ch) = try Self.resizeToCommonRGBA8(
            png: candidatePNG, longEdge: Self.diffLongEdge
        )
        let (refRGBA, rw, rh) = try Self.resizeToCommonRGBA8(
            png: referenceData, longEdge: Self.diffLongEdge
        )
        guard cw == rw, ch == rh else {
            return CaseResult(
                stem: stem,
                caseName: caseName,
                metrics: nil,
                failureReasons: [
                    "resize size mismatch: \(cw)x\(ch) vs \(rw)x\(rh) "
                    + "[canvasFrame=\(Int(frame.width))x\(Int(frame.height)) "
                    + "rawCandidate=\(NSBitmapImageRep(data: candidatePNG).map { "\($0.pixelsWide)x\($0.pixelsHigh)" } ?? "?") "
                    + "rawReference=\(NSBitmapImageRep(data: referenceData).map { "\($0.pixelsWide)x\($0.pixelsHigh)" } ?? "?")]"
                ]
            )
        }

        guard let metrics = CIEDE2000.compare(
            candidateRGBA: candRGBA,
            referenceRGBA: refRGBA,
            width: cw, height: ch
        ) else {
            return CaseResult(
                stem: stem,
                caseName: caseName,
                metrics: nil,
                failureReasons: ["CIEDE2000.compare returned nil"]
            )
        }

        var failures: [String] = []
        if metrics.meanDeltaE > Self.budget.mean {
            failures.append("mean ΔE \(String(format: "%.2f", metrics.meanDeltaE)) > \(Self.budget.mean)")
        }
        if metrics.p95DeltaE > Self.budget.p95 {
            failures.append("p95 ΔE \(String(format: "%.2f", metrics.p95DeltaE)) > \(Self.budget.p95)")
        }
        if metrics.maxDeltaE > Self.budget.max {
            failures.append("max ΔE \(String(format: "%.2f", metrics.maxDeltaE)) > \(Self.budget.max)")
        }
        for (channel, value) in [("R", metrics.biasR),
                                 ("G", metrics.biasG),
                                 ("B", metrics.biasB)] {
            if abs(value) > Self.budget.bias {
                failures.append("bias \(channel) \(String(format: "%.3f", value)) outside ±\(Self.budget.bias)")
            }
        }

        // On miss, attach both PNGs for triage.
        if !failures.isEmpty {
            let candAttach = XCTAttachment(data: candidatePNG, uniformTypeIdentifier: "public.png")
            candAttach.name = "\(stem)-\(caseName)-candidate.png"
            candAttach.lifetime = .keepAlways
            add(candAttach)

            let refAttach = XCTAttachment(data: referenceData, uniformTypeIdentifier: "public.png")
            refAttach.name = "\(stem)-\(caseName)-reference.png"
            refAttach.lifetime = .keepAlways
            add(refAttach)
        }

        return CaseResult(
            stem: stem,
            caseName: caseName,
            metrics: metrics,
            failureReasons: failures
        )
    }

    // MARK: - Image plumbing

    /// Decode a PNG, downsample it to `longEdge` on its longer axis using
    /// CGImage's high-quality interpolation, and return interleaved
    /// RGBA8 (premultipliedLast, sRGB) along with width/height.
    static func resizeToCommonRGBA8(png: Data,
                                    longEdge: Int) throws -> ([UInt8], Int, Int) {
        guard let src = CGImageSourceCreateWithData(png as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw NSError(domain: "SliderMatrix", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "PNG decode failed"
            ])
        }
        let srcW = img.width
        let srcH = img.height
        let scale = Double(longEdge) / Double(max(srcW, srcH))
        let dstW = max(1, Int((Double(srcW) * scale).rounded()))
        let dstH = max(1, Int((Double(srcH) * scale).rounded()))

        var bytes = [UInt8](repeating: 0, count: dstW * dstH * 4)
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let bitmap: UInt32 = CGImageAlphaInfo.premultipliedLast.rawValue
            | CGBitmapInfo.byteOrder32Big.rawValue
        guard let ctx = CGContext(
            data: &bytes,
            width: dstW,
            height: dstH,
            bitsPerComponent: 8,
            bytesPerRow: dstW * 4,
            space: cs,
            bitmapInfo: bitmap
        ) else {
            throw NSError(domain: "SliderMatrix", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "CGContext init failed"
            ])
        }
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: dstW, height: dstH))
        return (bytes, dstW, dstH)
    }

    // MARK: - JSON report

    /// Emit per-case metrics to stderr as one JSON line per case (mirrors
    /// GoldenStore's report shape so existing log scrapers work).
    private func emitReport(results: [CaseResult], skippedStems: [String]) {
        let header = "[slider-matrix] cases=\(results.count) skipped_stems=\(skippedStems.count)\n"
        FileHandle.standardError.write(Data(header.utf8))
        for r in results {
            if let m = r.metrics {
                let line = """
                {"name":"\(r.stem)/\(r.caseName)",\
                "mean":\(m.meanDeltaE),"p95":\(m.p95DeltaE),"max":\(m.maxDeltaE),\
                "bias_r":\(m.biasR),"bias_g":\(m.biasG),"bias_b":\(m.biasB),\
                "n_pixels":\(m.nPixels),\
                "pass":\(r.failureReasons.isEmpty)}
                """
                FileHandle.standardError.write(Data((line + "\n").utf8))
            } else {
                let line = "{\"name\":\"\(r.stem)/\(r.caseName)\",\"error\":\"\(r.failureReasons.joined(separator: " | "))\"}"
                FileHandle.standardError.write(Data((line + "\n").utf8))
            }
        }
        for s in skippedStems {
            FileHandle.standardError.write(Data(("[slider-matrix] SKIP \(s)\n").utf8))
        }
    }
}
#endif // os(macOS)
