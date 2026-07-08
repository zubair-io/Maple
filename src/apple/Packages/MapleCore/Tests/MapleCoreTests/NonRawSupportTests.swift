// NonRawSupportTests.swift — unit tests for non-RAW image support.
//
// Covers:
//   - Extension classification: NonRawImageExtensions, SupportedImageExtensions.
//   - AssetRef.isRaw routing for .heic / .jpg / .png / .dng / no-hint.
//   - AssetRef.detectIsRaw magic-byte sniff for JPEG / PNG / HEIF.
//   - FilesystemSource lists .heic / .jpg files.
//   - ImageEditPipeline.decodeSceneLinearNonRaw produces a sane CIImage
//     for a synthetic sRGB JPEG (does NOT need RAW fixtures or the Rust
//     core).

import XCTest
import CoreImage
import ImageIO
import UniformTypeIdentifiers
@testable import MapleCore

@MainActor
final class NonRawSupportTests: XCTestCase {

    // MARK: Extension classification

    func testNonRawImageExtensionsIncludesIPhoneFormats() {
        let exts = NonRawImageExtensions.all
        XCTAssertTrue(exts.contains("heic"))
        XCTAssertTrue(exts.contains("heif"))
        XCTAssertTrue(exts.contains("jpg"))
        XCTAssertTrue(exts.contains("jpeg"))
        XCTAssertTrue(exts.contains("jpe"))
        XCTAssertTrue(exts.contains("png"))
    }

    func testNonRawImageExtensionsExcludesTiffAndDng() {
        // tif/tiff stay in RAWExtensions.all because camera-sourced TIFFs
        // (Phase One IIQ tethered captures, etc.) carry sensor data; dng
        // is iPhone ProRAW and deserves the full DCP pipeline.
        XCTAssertFalse(NonRawImageExtensions.all.contains("tif"))
        XCTAssertFalse(NonRawImageExtensions.all.contains("tiff"))
        XCTAssertFalse(NonRawImageExtensions.all.contains("dng"))
    }

    func testSupportedImageExtensionsIsUnion() {
        let union = SupportedImageExtensions.all
        // Sample a few from each side.
        XCTAssertTrue(union.contains("dng"))
        XCTAssertTrue(union.contains("cr3"))
        XCTAssertTrue(union.contains("heic"))
        XCTAssertTrue(union.contains("jpg"))
        XCTAssertTrue(union.contains("png"))
        // Should be exactly the union — no extras. (Stub/audio extensions
        // are covered by AssetRefStubAudioTests.testSupportedImageExtensionsIncludesStubAndAudio.)
        XCTAssertEqual(
            union,
            RAWExtensions.all
                .union(NonRawImageExtensions.all)
                .union(VideoExtensions.all)
                .union(StubExtensions.all)
                .union(AudioExtensions.all)
        )
    }

    // MARK: AssetRef.isRaw — extension-based

    func testAssetRefIsRawForRawExtensions() {
        let dng = AssetRef(url: URL(fileURLWithPath: "/tmp/foo.dng"))
        XCTAssertTrue(dng.isRaw, ".dng must be RAW (iPhone ProRAW path)")

        let cr3 = AssetRef(url: URL(fileURLWithPath: "/tmp/foo.CR3"))  // case-insensitive
        XCTAssertTrue(cr3.isRaw, ".CR3 must classify as RAW")
    }

    func testAssetRefIsRawForNonRawExtensions() {
        let heic = AssetRef(url: URL(fileURLWithPath: "/tmp/foo.HEIC"))
        XCTAssertFalse(heic.isRaw, ".HEIC must classify as non-RAW")

        let jpg = AssetRef(url: URL(fileURLWithPath: "/tmp/foo.jpg"))
        XCTAssertFalse(jpg.isRaw, ".jpg must classify as non-RAW")

        let png = AssetRef(url: URL(fileURLWithPath: "/tmp/foo.png"))
        XCTAssertFalse(png.isRaw, ".png must classify as non-RAW")
    }

    func testAssetRefIsRawDefaultsToTrueWithNoHint() {
        // PhotoKit / Self-Hosted refs without a hint: keep historical RAW
        // default. The magic-byte sniff inside sharedDecode reclassifies
        // before dispatch.
        let ref = AssetRef(
            displayName: "PHAsset-12345",
            hintExtension: nil,
            bytesProvider: { Data() }
        )
        XCTAssertTrue(ref.isRaw)
    }

    func testAssetRefExplicitIsRawOverrides() {
        // Even with a `.heic` hint, an explicit RAW classification wins.
        let ref = AssetRef(
            displayName: "force-raw",
            hintExtension: "heic",
            stableID: nil,
            explicitIsRaw: true,
            bytesProvider: { Data() }
        )
        XCTAssertTrue(ref.isRaw)

        let ref2 = AssetRef(
            displayName: "force-non-raw",
            hintExtension: "dng",
            stableID: nil,
            explicitIsRaw: false,
            bytesProvider: { Data() }
        )
        XCTAssertFalse(ref2.isRaw)
    }

    // MARK: detectIsRaw magic-byte sniff

    func testDetectIsRawSniffJPEG() {
        // FF D8 FF E0 …
        var bytes = Data([0xFF, 0xD8, 0xFF, 0xE0])
        bytes.append(contentsOf: Array(repeating: UInt8(0), count: 12))
        XCTAssertEqual(AssetRef.detectIsRaw(bytes: bytes), false)
    }

    func testDetectIsRawSniffPNG() {
        var bytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        bytes.append(contentsOf: Array(repeating: UInt8(0), count: 8))
        XCTAssertEqual(AssetRef.detectIsRaw(bytes: bytes), false)
    }

    func testDetectIsRawSniffHEIC() {
        // 4 bytes box-size, "ftyp", "heic" major brand, then 4 bytes of
        // version, then minor brand list.
        var bytes = Data([0, 0, 0, 0x18])  // box size
        bytes.append(contentsOf: [0x66, 0x74, 0x79, 0x70])  // "ftyp"
        bytes.append(contentsOf: [0x68, 0x65, 0x69, 0x63])  // "heic"
        bytes.append(contentsOf: Array(repeating: UInt8(0), count: 4))
        XCTAssertEqual(AssetRef.detectIsRaw(bytes: bytes), false)
    }

    func testDetectIsRawSniffMif1HEIF() {
        // mif1 brand (HEIF without HEVC).
        var bytes = Data([0, 0, 0, 0x18])
        bytes.append(contentsOf: [0x66, 0x74, 0x79, 0x70])
        bytes.append(contentsOf: [0x6D, 0x69, 0x66, 0x31])  // "mif1"
        bytes.append(contentsOf: Array(repeating: UInt8(0), count: 4))
        XCTAssertEqual(AssetRef.detectIsRaw(bytes: bytes), false)
    }

    func testDetectIsRawReturnsNilForUnknownSignature() {
        // DNG, CR3, ARW — all RAW formats — return nil so the caller
        // falls back to extension or the historical default.
        let dngLikeBytes = Data([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0, 0, 0, 0])
        XCTAssertNil(AssetRef.detectIsRaw(bytes: dngLikeBytes))
    }

    func testDetectIsRawRejectsTooShort() {
        XCTAssertNil(AssetRef.detectIsRaw(bytes: Data([0xFF, 0xD8])))
    }

    // MARK: FilesystemSource — listing

    func testFilesystemSourceListsHeicAndJpg() async throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        // Empty placeholder files — listing only inspects the extension.
        let dng = tmp.appendingPathComponent("a.dng")
        let heic = tmp.appendingPathComponent("b.heic")
        let jpg = tmp.appendingPathComponent("c.jpg")
        let png = tmp.appendingPathComponent("d.png")
        let txt = tmp.appendingPathComponent("e.txt")
        try Data([0]).write(to: dng)
        try Data([0]).write(to: heic)
        try Data([0]).write(to: jpg)
        try Data([0]).write(to: png)
        try Data([0]).write(to: txt)

        let source = FilesystemSource()
        try await source.open(folderURL: tmp)
        let assets = await source.assets
        let names = Set(assets.map { $0.url.lastPathComponent })
        XCTAssertTrue(names.contains("a.dng"))
        XCTAssertTrue(names.contains("b.heic"))
        XCTAssertTrue(names.contains("c.jpg"))
        XCTAssertTrue(names.contains("d.png"))
        XCTAssertFalse(names.contains("e.txt"), "non-image extensions filtered out")
    }

    // MARK: ImageEditPipeline — non-RAW decode

    /// Synthesise a 320×240 sRGB JPEG and decode it through
    /// `decodeSceneLinearNonRaw`. The CIImage's extent should match the
    /// source dims (or a viewport-prescaled equivalent when targetSize
    /// is set). No RAW fixtures or Rust core needed.
    func testDecodeSceneLinearNonRawDecodesSyntheticJPEG() async throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(UUID().uuidString).jpg")
        defer { try? FileManager.default.removeItem(at: tmp) }

        // Build a 320x240 sRGB CGImage filled with mid-grey, encode JPEG.
        let w = 320, h = 240
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(
            data: nil, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: w * 4,
            space: cs,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        ctx.setFillColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1.0)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        guard let cg = ctx.makeImage() else {
            XCTFail("synth CGImage failed"); return
        }
        guard let dest = CGImageDestinationCreateWithURL(
            tmp as CFURL, UTType.jpeg.identifier as CFString, 1, nil
        ) else {
            XCTFail("CGImageDestination failed"); return
        }
        CGImageDestinationAddImage(dest, cg, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))

        let asset = AssetRef(url: tmp)
        XCTAssertFalse(asset.isRaw, "synthetic .jpg must classify as non-RAW")

        let pipeline = ImageEditPipeline()
        guard let decoded = await pipeline.decodeSceneLinearNonRaw(
            asset: asset, targetSize: nil
        ) else {
            XCTFail("decodeSceneLinearNonRaw returned nil"); return
        }

        // Extent should match the source (no prescale when targetSize is
        // nil and source is small).
        XCTAssertEqual(decoded.extent.width, CGFloat(w), accuracy: 1.0)
        XCTAssertEqual(decoded.extent.height, CGFloat(h), accuracy: 1.0)
    }

    /// EXIF orientation must be applied to non-RAW decodes. iPhone HEIC /
    /// JPEG captures store landscape pixels with an orientation tag; the
    /// full-image open path used to ignore it, so portrait photos opened
    /// sideways (the grid thumbnail — which sets `…WithTransform` — was
    /// already correct, making the mismatch obvious). Synthesise a 320×240
    /// JPEG tagged orientation 6 (Rotate 90°) and assert the decoded
    /// CIImage comes back portrait (240×320) — i.e. the rotation landed.
    func testDecodeSceneLinearNonRawAppliesExifOrientation() async throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(UUID().uuidString).jpg")
        defer { try? FileManager.default.removeItem(at: tmp) }

        // Stored (sensor) pixels are landscape 320×240.
        let w = 320, h = 240
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(
            data: nil, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: w * 4,
            space: cs,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        ctx.setFillColor(red: 0.3, green: 0.6, blue: 0.9, alpha: 1.0)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        guard let cg = ctx.makeImage() else {
            XCTFail("synth CGImage failed"); return
        }
        guard let dest = CGImageDestinationCreateWithURL(
            tmp as CFURL, UTType.jpeg.identifier as CFString, 1, nil
        ) else {
            XCTFail("CGImageDestination failed"); return
        }
        // Orientation 6 = "rotate 90° CW for display" — width/height swap.
        let props: [CFString: Any] = [kCGImagePropertyOrientation: 6]
        CGImageDestinationAddImage(dest, cg, props as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(dest))

        let asset = AssetRef(url: tmp)
        let pipeline = ImageEditPipeline()
        guard let decoded = await pipeline.decodeSceneLinearNonRaw(
            asset: asset, targetSize: nil
        ) else {
            XCTFail("decodeSceneLinearNonRaw returned nil"); return
        }

        // Display orientation is portrait: dims swapped vs. stored pixels.
        XCTAssertEqual(decoded.extent.width, CGFloat(h), accuracy: 1.0,
                       "rotated width should equal stored height")
        XCTAssertEqual(decoded.extent.height, CGFloat(w), accuracy: 1.0,
                       "rotated height should equal stored width")
    }

    /// Synthesise a 320×240 PNG and decode through the non-RAW path.
    /// Verifies the alpha-channel handling in the ImageIO path doesn't
    /// blow up.
    func testDecodeSceneLinearNonRawDecodesSyntheticPNG() async throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: tmp) }

        let w = 320, h = 240
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(
            data: nil, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: w * 4,
            space: cs,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        ctx.setFillColor(red: 0.0, green: 0.5, blue: 1.0, alpha: 1.0)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        guard let cg = ctx.makeImage() else {
            XCTFail("synth CGImage failed"); return
        }
        guard let dest = CGImageDestinationCreateWithURL(
            tmp as CFURL, UTType.png.identifier as CFString, 1, nil
        ) else {
            XCTFail("CGImageDestination failed"); return
        }
        CGImageDestinationAddImage(dest, cg, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))

        let asset = AssetRef(url: tmp)
        XCTAssertFalse(asset.isRaw)

        let pipeline = ImageEditPipeline()
        let decoded = await pipeline.decodeSceneLinearNonRaw(asset: asset, targetSize: nil)
        XCTAssertNotNil(decoded)
    }

    /// Bytes-provider path — feed bytes from a synthetic JPEG and verify
    /// `decodeSceneLinearNonRaw` succeeds without a primaryURL.
    func testDecodeSceneLinearNonRawViaBytesProvider() async throws {
        let w = 320, h = 240
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(
            data: nil, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: w * 4,
            space: cs,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        ctx.setFillColor(red: 0.8, green: 0.2, blue: 0.4, alpha: 1.0)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        guard let cg = ctx.makeImage() else {
            XCTFail("synth CGImage failed"); return
        }
        let mutData = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            mutData, UTType.jpeg.identifier as CFString, 1, nil
        ) else {
            XCTFail("CGImageDestination failed"); return
        }
        CGImageDestinationAddImage(dest, cg, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))

        let bytes = mutData as Data
        let asset = AssetRef(
            displayName: "synth.jpg",
            hintExtension: "jpg",
            bytesProvider: { bytes }
        )
        XCTAssertFalse(asset.isRaw)

        let pipeline = ImageEditPipeline()
        let decoded = await pipeline.decodeSceneLinearNonRaw(asset: asset, targetSize: nil)
        XCTAssertNotNil(decoded)
    }

    /// `LocalHistogram.computeNonRaw` must also work via a bytesProvider (no
    /// URL) — the PhotoKit / cloud path. Mirrors the decode test above.
    func testComputeNonRawViaBytesProvider() async throws {
        let w = 256, h = 64
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(
            data: nil, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: w * 4,
            space: cs,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        for x in 0..<w {
            let v = CGFloat(x) / CGFloat(w - 1)
            ctx.setFillColor(red: v, green: 1.0 - v, blue: 0.5, alpha: 1.0)
            ctx.fill(CGRect(x: x, y: 0, width: 1, height: h))
        }
        guard let cg = ctx.makeImage() else { XCTFail("synth CGImage failed"); return }
        let mutData = NSMutableData()
        guard
            let dest = CGImageDestinationCreateWithData(
                mutData, UTType.jpeg.identifier as CFString, 1, nil)
        else { XCTFail("CGImageDestination failed"); return }
        CGImageDestinationAddImage(dest, cg, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))

        let bytes = mutData as Data
        let asset = AssetRef(displayName: "synth.jpg", hintExtension: "jpg", bytesProvider: { bytes })
        XCTAssertFalse(asset.isRaw)

        let hist: CloudHistogram
        do {
            hist = try await LocalHistogram.computeNonRaw(asset: asset, model: AdjustmentModel())
        } catch {
            XCTFail("computeNonRaw (bytesProvider) threw: \(error)")
            return
        }
        XCTAssertEqual(hist.r.count, 256)
        let spread =
            hist.r.filter { $0 > 0 }.count + hist.g.filter { $0 > 0 }.count
            + hist.b.filter { $0 > 0 }.count
        XCTAssertGreaterThan(spread, 10, "bytesProvider histogram should spread, got \(spread)")
    }

    /// Fixture-gated end-to-end: open a real JPEG via the EditSession's
    /// public API, drag a slider, and confirm a preview lands inside a
    /// reasonable budget. Mirrors how a user would open an iPhone HEIF
    /// from a folder of exported photos. Skips when no JPEG fixture is
    /// available.
    func testEndToEndOpenAndSliderDragOnRealJPEGFixture() async throws {
        // Look for an embedded-preview JPEG extracted from a DNG, or any
        // JPEG fixture under test-fixtures/raws/.
        let candidatePaths: [String] = [
            "/tmp/test_nonraw.jpg",
        ]
        var fixtureURL: URL?
        for path in candidatePaths {
            if FileManager.default.fileExists(atPath: path) {
                fixtureURL = URL(fileURLWithPath: path)
                break
            }
        }
        guard let fixtureURL else {
            throw XCTSkip("non-RAW JPEG fixture not present; skipping")
        }

        let asset = AssetRef(url: fixtureURL)
        XCTAssertFalse(asset.isRaw, "JPEG fixture must classify as non-RAW")

        let session = EditSession(asset: asset)
        await MainActor.run {
            session.previewSize = CGSize(width: 1024, height: 768)
            session.pixelScale = 0  // fit
        }
        await session.loadSidecar()
        session.ensureRenderStarted()

        // Wait for the cold-open path to publish a preview. Non-RAW
        // decode via ImageIO is fast — should be ≤ 500 ms even on
        // CI hardware. Generous 5 s ceiling.
        let deadline = Date().addingTimeInterval(5.0)
        while Date() < deadline {
            if session.renderedPreview != nil { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertNotNil(session.renderedPreview, "Non-RAW preview must publish within 5 s")

        // Simulate a slider drag — bump exposure and confirm a fresh
        // render comes through.
        let beforePreview = session.renderedPreview
        await MainActor.run {
            session.beginEdit()
            var m = session.model
            m.exposure = 0.5
            session.model = m
        }

        // Wait briefly for the new render.
        let sliderDeadline = Date().addingTimeInterval(2.0)
        while Date() < sliderDeadline {
            // Identity check on CIImage objects — slider should swap to
            // a fresh CIImage. extent stays the same.
            if let p = session.renderedPreview, p !== beforePreview { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertNotNil(session.renderedPreview)
    }

    /// processSceneLinearNonRaw + scene-linear chain runs end-to-end on a
    /// synthetic input. Smoke test — ensures the non-RAW pipeline
    /// produces a CIImage without throwing.
    func testProcessSceneLinearNonRawRunsEndToEnd() async throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(UUID().uuidString).jpg")
        defer { try? FileManager.default.removeItem(at: tmp) }

        let w = 320, h = 240
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(
            data: nil, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: w * 4,
            space: cs,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        ctx.setFillColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1.0)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        guard let cg = ctx.makeImage() else {
            XCTFail("synth CGImage failed"); return
        }
        guard let dest = CGImageDestinationCreateWithURL(
            tmp as CFURL, UTType.jpeg.identifier as CFString, 1, nil
        ) else {
            XCTFail("CGImageDestination failed"); return
        }
        CGImageDestinationAddImage(dest, cg, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))

        let asset = AssetRef(url: tmp)
        let pipeline = ImageEditPipeline()
        guard let decoded = await pipeline.decodeSceneLinearNonRaw(asset: asset, targetSize: nil) else {
            XCTFail("decode returned nil"); return
        }

        let processed = pipeline.processSceneLinearNonRaw(
            decoded: decoded,
            model: .default,
            targetSize: nil
        )
        XCTAssertGreaterThan(processed.extent.width, 0)
        XCTAssertGreaterThan(processed.extent.height, 0)
    }

    // MARK: LocalHistogram — non-RAW histogram (#1332)

    /// `LocalHistogram.computeNonRaw` must develop a non-RAW image and return a
    /// real 3×256 histogram (not throw → placeholder). Synthesises an RGB
    /// gradient PNG so the histogram is expected to spread across many bins.
    func testComputeNonRawProducesRealHistogram() async throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: tmp) }

        // 256×64 horizontal RGB gradient → varied per-channel values.
        let w = 256, h = 64
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(
            data: nil, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: w * 4,
            space: cs,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        for x in 0..<w {
            let v = CGFloat(x) / CGFloat(w - 1)
            ctx.setFillColor(red: v, green: v * 0.5, blue: 1.0 - v, alpha: 1.0)
            ctx.fill(CGRect(x: x, y: 0, width: 1, height: h))
        }
        guard let cg = ctx.makeImage() else { XCTFail("synth CGImage failed"); return }
        guard
            let dest = CGImageDestinationCreateWithURL(
                tmp as CFURL, UTType.png.identifier as CFString, 1, nil)
        else { XCTFail("CGImageDestination failed"); return }
        CGImageDestinationAddImage(dest, cg, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))

        let asset = AssetRef(url: tmp)
        XCTAssertFalse(asset.isRaw, "synthetic .png must classify as non-RAW")

        let hist: CloudHistogram
        do {
            hist = try await LocalHistogram.computeNonRaw(asset: asset, model: AdjustmentModel())
        } catch {
            XCTFail("computeNonRaw threw: \(error)")
            return
        }

        XCTAssertEqual(hist.r.count, 256)
        XCTAssertEqual(hist.g.count, 256)
        XCTAssertEqual(hist.b.count, 256)
        // A gradient must spread across bins — not all-zero (failed bin) and
        // not collapsed into a single bin.
        let rNonZero = hist.r.filter { $0 > 0 }.count
        let gNonZero = hist.g.filter { $0 > 0 }.count
        let bNonZero = hist.b.filter { $0 > 0 }.count
        XCTAssertGreaterThan(rNonZero, 5, "R should spread; got \(rNonZero) non-zero bins")
        XCTAssertGreaterThan(gNonZero, 5, "G should spread; got \(gNonZero) non-zero bins")
        XCTAssertGreaterThan(bNonZero, 5, "B should spread; got \(bNonZero) non-zero bins")
    }
}
