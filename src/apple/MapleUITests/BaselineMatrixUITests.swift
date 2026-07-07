// BaselineMatrixUITests.swift — diagnostic baseline-only matrix.
//
// Purpose: capture today's per-fixture color delta vs the reference baseline
// references so we have ground-truth numbers to track when remediating
// the open-path color regression. Mirrors SliderMatrixUITests but runs
// only the `baseline.xmp` case per fixture, and **never fails on bad
// numbers** — pure diagnostic output, attaches every screenshot.
//
// Each iteration:
//   1. Stages a tmp dir with `<stem>.<ext>` (RAW) + `<stem>.xmp`
//      (the fixture's `baseline.xmp` from the references dir).
//   2. Launches Maple via `MAPLE_UITEST_FIXTURE`.
//   3. Waits for either `canvas-render-ready` (refine done) or
//      `canvas-rendering` (any preview painted) — long timeout so we
//      don't drop fixtures that just need more decode time.
//   4. Sleeps a small settle window for the refine.
//   5. Screenshots the canvas element (via whichever identifier exists)
//      — falls back to a window-cropped-to-canvas-frame when the
//      element-relative screenshot returns the whole window.
//   6. CIEDE2000-compares against `<stem>/down/baseline.png`.
//   7. Attaches both candidate + reference and emits one JSON line per
//      fixture to stderr.
//
// The test always XCTests as PASS regardless of the deltas — the goal
// is to capture today's numbers and make them visible in the test log.
// To gate, run SliderMatrixUITests instead.

import XCTest
// BaselineMatrixUITests uses MapleAppDriver + AppKit for macOS live-UI driving.
// Gate it out on iOS so the target can compile for iOS Simulator (M6 #1244).
#if os(macOS)
import AppKit
import CoreImage
import ImageIO

final class BaselineMatrixUITests: XCTestCase {

    // Resize-target long edge for the candidate↔reference comparison.
    // Matches SliderMatrixUITests so numbers compare directly.
    private static let diffLongEdge: Int = 1024

    private static let fixtureExtensions = [
        "dng", "DNG",
        "RAW", "raw",
        "CR2", "cr2", "CR3", "cr3",
        "NEF", "nef",
        "ARW", "arw",
        "RAF", "raf",
        "fff", "FFF",
    ]

    private static func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleUITests/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // repo root
    }

    private static func rawsDir() -> URL {
        repoRoot().appendingPathComponent("test-fixtures/raws")
    }

    private static func referencesDir() -> URL {
        repoRoot().appendingPathComponent("test-fixtures/references")
    }

    private static func resolveRAW(stem: String, in dir: URL) -> URL? {
        for ext in fixtureExtensions {
            let url = dir.appendingPathComponent("\(stem).\(ext)")
            if FileManager.default.fileExists(atPath: url.path) {
                return url
            }
        }
        return nil
    }

    private struct CaseResult {
        let stem: String
        let metrics: CIEDE2000Result?
        let note: String   // empty on clean run; populated when we had to skip / fall back
    }

    func testBaselineMatrixVsReferences() throws {
        let raws = Self.rawsDir()
        let refs = Self.referencesDir()
        guard FileManager.default.fileExists(atPath: refs.path) else {
            throw XCTSkip("references dir missing: \(refs.path)")
        }

        let fm = FileManager.default
        let stems = (try? fm.contentsOfDirectory(atPath: refs.path))?
            .sorted()
            .filter { name in
                guard name.hasPrefix("test_") else { return false }
                let base = refs.appendingPathComponent(name)
                let baselineXmp = base.appendingPathComponent("xmp/baseline.xmp")
                let baselinePNG = base.appendingPathComponent("down/baseline.png")
                return fm.fileExists(atPath: baselineXmp.path)
                    && fm.fileExists(atPath: baselinePNG.path)
            } ?? []

        var results: [CaseResult] = []
        for stem in stems {
            guard let rawURL = Self.resolveRAW(stem: stem, in: raws) else {
                results.append(CaseResult(stem: stem, metrics: nil,
                                          note: "no RAW in \(raws.path)"))
                continue
            }
            let xmpURL = refs.appendingPathComponent("\(stem)/xmp/baseline.xmp")
            let refPNG = refs.appendingPathComponent("\(stem)/down/baseline.png")
            do {
                let r = try renderAndDiff(stem: stem,
                                          rawURL: rawURL,
                                          xmpURL: xmpURL,
                                          referencePNG: refPNG)
                results.append(r)
            } catch {
                results.append(CaseResult(stem: stem, metrics: nil,
                                          note: "render-or-diff threw: \(error)"))
            }
        }

        emitReport(results)
        // Diagnostic test — never fail on bad deltas. Caller reads the
        // numbers from the [baseline-matrix] stderr lines + extracted
        // attachments.
    }

    /// Read PNG dims without decoding the full image. Used to compute
    /// the in-canvas letterbox bounds before screenshot.
    private func pngDimensions(at url: URL) -> CGSize? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil)
                as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? CGFloat,
              let h = props[kCGImagePropertyPixelHeight] as? CGFloat,
              w > 0, h > 0
        else { return nil }
        return CGSize(width: w, height: h)
    }

    /// Given the on-screen canvas frame and the reference image's
    /// aspect, compute where the image sits within the canvas under
    /// fit-to-canvas zoom. The image is centered with letterbox bars
    /// where the aspect doesn't match the canvas.
    private func imageBoundsWithinCanvas(canvasFrame: CGRect,
                                         imageSize: CGSize) -> CGRect {
        let canvasAspect = canvasFrame.width / canvasFrame.height
        let imgAspect = imageSize.width / imageSize.height
        if imgAspect > canvasAspect {
            // Wider than canvas — letterbox top + bottom.
            let imgH = canvasFrame.width / imgAspect
            let yOff = (canvasFrame.height - imgH) / 2.0
            return CGRect(x: canvasFrame.minX,
                          y: canvasFrame.minY + yOff,
                          width: canvasFrame.width,
                          height: imgH)
        } else {
            // Taller than canvas — letterbox left + right.
            let imgW = canvasFrame.height * imgAspect
            let xOff = (canvasFrame.width - imgW) / 2.0
            return CGRect(x: canvasFrame.minX + xOff,
                          y: canvasFrame.minY,
                          width: imgW,
                          height: canvasFrame.height)
        }
    }

    private func renderAndDiff(stem: String,
                               rawURL: URL,
                               xmpURL: URL,
                               referencePNG: URL) throws -> CaseResult {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-baseline-\(UUID().uuidString)",
                                    isDirectory: true)
        try FileManager.default.createDirectory(at: tmp,
                                                withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let stagedRaw = tmp.appendingPathComponent(rawURL.lastPathComponent)
        let stagedXmp = tmp.appendingPathComponent(stem).appendingPathExtension("xmp")
        try FileManager.default.copyItem(at: rawURL, to: stagedRaw)
        try FileManager.default.copyItem(at: xmpURL, to: stagedXmp)

        let app = XCUIApplication()
        app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = stagedRaw.lastPathComponent
        app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = tmp.path
        // Pin the CPU + Metal render path: this gate diffs the canvas
        // against an ACR/CPU reference, so disable the default-on (#1064)
        // GPU live path and keep the render byte-comparable to the baseline.
        app.launchEnvironment["MAPLE_GPU_LIVE"] = "0"
        app.launch()
        defer { app.terminate() }

        // Wait for the explicit `canvas-render-ready` signal — EditorView's
        // canvas leaf (`CanvasImageView` / `GpuLiveCanvasView`) exposes a
        // single accessibility leaf with that identifier. The same element's
        // frame matches the canvas content area, so we can use it
        // for both the wait AND the crop. `.descendants(matching: .any)`
        // because `.accessibilityElement()` on a SwiftUI view can
        // surface as various XCUIElement types.
        let renderReady = app.descendants(matching: .any)
            .matching(identifier: "canvas-render-ready").firstMatch
        let pred = NSPredicate(format: "exists == 1")
        let exp = XCTNSPredicateExpectation(predicate: pred, object: renderReady)
        let waited = XCTWaiter().wait(for: [exp], timeout: 60)

        let zoomMarker = renderReady   // alias: same element below

        // Crop the screen to the actual image area within the canvas
        // (canvas frame minus letterbox), using the zoom-marker rect
        // as the canvas extent and the reference's aspect to find the
        // letterbox-free image rect.
        let candidatePNG: Data
        let note: String
        if waited == .completed && zoomMarker.exists,
           let refSize = pngDimensions(at: referencePNG) {
            let canvasFrame = zoomMarker.frame
            let imageRect = imageBoundsWithinCanvas(canvasFrame: canvasFrame,
                                                    imageSize: refSize)
            let screenShot = XCUIScreen.main.screenshot().image
            // Diagnostic: log all the relevant geometry so we can
            // verify the crop math empirically.
            let diag = String(format:
                "[diag] %@ screen=%.0fx%.0f canvas=(%.0f,%.0f,%.0fx%.0f) imageRect=(%.0f,%.0f,%.0fx%.0f) refSize=%.0fx%.0f\n",
                stem,
                screenShot.size.width, screenShot.size.height,
                canvasFrame.minX, canvasFrame.minY, canvasFrame.width, canvasFrame.height,
                imageRect.minX, imageRect.minY, imageRect.width, imageRect.height,
                refSize.width, refSize.height)
            FileHandle.standardError.write(Data(diag.utf8))
            guard let cropped = Self.crop(screenShot, toPoints: imageRect) else {
                return CaseResult(stem: stem, metrics: nil, note: "crop failed")
            }
            if let png = cropped.tiffRepresentation
                .flatMap({ NSBitmapImageRep(data: $0) })
                .flatMap({ $0.representation(using: .png, properties: [:]) }) {
                candidatePNG = png
                note = String(format: "image-rect %.0fx%.0f (canvas %.0fx%.0f)",
                              imageRect.width, imageRect.height,
                              canvasFrame.width, canvasFrame.height)
            } else {
                candidatePNG = app.windows.firstMatch.screenshot().pngRepresentation
                note = "crop encode failed; window-shot only"
            }
        } else {
            candidatePNG = app.windows.firstMatch.screenshot().pngRepresentation
            note = "no-zoom-marker; window-shot only"
        }

        // Attach candidate so we can inspect it after the run.
        let candidateAttachment = XCTAttachment(data: candidatePNG,
                                                uniformTypeIdentifier: "public.png")
        candidateAttachment.name = "candidate-\(stem)"
        candidateAttachment.lifetime = .keepAlways
        add(candidateAttachment)

        // Attach the uncropped full screen alongside the candidate so
        // we can inspect any apparent color drift caused by the crop
        // pipeline (P3 → NSBitmapImageRep → PNG path) — extract via
        // `xcrun xcresulttool export attachments` to get both views.
        let fullScreen = XCUIScreen.main.screenshot()
        let fullAttachment = XCTAttachment(screenshot: fullScreen)
        fullAttachment.name = "fullscreen-\(stem)"
        fullAttachment.lifetime = .keepAlways
        add(fullAttachment)

        // CIEDE2000 vs the reference. Resize the reference to a
        // 1024 long edge first; then resize the candidate to that
        // exact (W, H). Avoids the ±1px floating-point drift that
        // happens when both are independently resized.
        let referenceData = try Data(contentsOf: referencePNG)
        let (ref, rw, rh) = try SliderMatrixUITests.resizeToCommonRGBA8(
            png: referenceData, longEdge: Self.diffLongEdge
        )
        let (cand, cw, ch) = try Self.resizeToExactRGBA8(
            png: candidatePNG, width: rw, height: rh
        )
        guard cw == rw, ch == rh else {
            return CaseResult(stem: stem, metrics: nil,
                              note: "\(note); resize size mismatch \(cw)x\(ch) vs \(rw)x\(rh)")
        }
        guard let metrics = CIEDE2000.compare(
            candidateRGBA: cand, referenceRGBA: ref, width: cw, height: ch
        ) else {
            return CaseResult(stem: stem, metrics: nil,
                              note: "\(note); CIEDE2000 returned nil")
        }
        return CaseResult(stem: stem, metrics: metrics, note: note)
    }

    /// Resize a PNG to exact (width, height) using CGImage's high-quality
    /// interpolation. Returns interleaved RGBA8 (premultipliedLast, sRGB).
    /// Used to make the candidate match the reference's resized dims
    /// exactly, sidestepping the ±1px drift from independent long-edge
    /// scaling.
    static func resizeToExactRGBA8(png: Data,
                                   width dstW: Int,
                                   height dstH: Int) throws -> ([UInt8], Int, Int) {
        guard let src = CGImageSourceCreateWithData(png as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw NSError(domain: "BaselineMatrix", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "PNG decode failed"
            ])
        }
        var bytes = [UInt8](repeating: 0, count: dstW * dstH * 4)
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let bitmap: UInt32 = CGImageAlphaInfo.premultipliedLast.rawValue
            | CGBitmapInfo.byteOrder32Big.rawValue
        guard let ctx = CGContext(
            data: &bytes, width: dstW, height: dstH,
            bitsPerComponent: 8, bytesPerRow: dstW * 4,
            space: cs, bitmapInfo: bitmap
        ) else {
            throw NSError(domain: "BaselineMatrix", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "CGContext init failed"
            ])
        }
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: dstW, height: dstH))
        return (bytes, dstW, dstH)
    }

    /// Crop a screen NSImage to a rect specified in **points** (the
    /// units of XCUIElement.frame). Uses CGImage's pixel-space cropping
    /// which is unambiguous Y-down, multiplying by the screen's backing
    /// scale to convert points → pixels. Returns an NSImage whose
    /// nominal size is in points (matches what callers expect).
    ///
    /// This is the right primitive for cropping
    /// `XCUIScreen.main.screenshot().image`, where the underlying
    /// CGImage is in pixels and the frame is in points.
    private static func crop(_ image: NSImage, toPoints rect: CGRect) -> NSImage? {
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }
        let scale = NSScreen.main?.backingScaleFactor ?? 2.0
        let pixelRect = CGRect(
            x: rect.origin.x * scale,
            y: rect.origin.y * scale,
            width: rect.width * scale,
            height: rect.height * scale
        )
        guard let cropped = cg.cropping(to: pixelRect) else { return nil }
        return NSImage(cgImage: cropped, size: rect.size)
    }

    private func emitReport(_ results: [CaseResult]) {
        let header = "[baseline-matrix] count=\(results.count)\n"
        FileHandle.standardError.write(Data(header.utf8))
        for r in results {
            if let m = r.metrics {
                let line = String(format:
                    "[baseline-matrix] %@ mean=%.2f p95=%.2f max=%.2f bias=(%+.3f,%+.3f,%+.3f) n=%d note=%@\n",
                    r.stem, m.meanDeltaE, m.p95DeltaE, m.maxDeltaE,
                    m.biasR, m.biasG, m.biasB, m.nPixels,
                    r.note.isEmpty ? "ok" : r.note)
                FileHandle.standardError.write(Data(line.utf8))
            } else {
                let line = "[baseline-matrix] \(r.stem) ERROR \(r.note)\n"
                FileHandle.standardError.write(Data(line.utf8))
            }
        }
        // Summary stats across fixtures (exclude errors).
        let valid = results.compactMap { $0.metrics }
        if !valid.isEmpty {
            let meanΔE = valid.map { $0.meanDeltaE }.reduce(0, +) / Double(valid.count)
            let maxMaxΔE = valid.map { $0.maxDeltaE }.max() ?? 0
            let summary = String(format:
                "[baseline-matrix] SUMMARY n=%d avg-mean-ΔE=%.2f worst-max-ΔE=%.2f\n",
                valid.count, meanΔE, maxMaxΔE)
            FileHandle.standardError.write(Data(summary.utf8))
        }
    }
}
#endif // os(macOS)
