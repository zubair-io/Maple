// EditSessionNonRawFilmExportTests.swift — non-RAW export must apply the
// film look (#2713).
//
// `EditSession.renderForExport()` (`EditSession+RenderHelpers.swift`) tries
// the RAW-only `maple_render_file_with_film` FFI entry first
// (`renderExportWithFilmLook()`, `EditSession+FilmExport.swift`), which
// always declines for a non-RAW asset (`guard asset.isRaw`), falling
// through to the plain CIImage-graph path
// (`RenderActor.renderForExport` → `ImageEditPipeline.processSceneLinearNonRaw`).
// That FFI struct has no film-look field at all (raw-ffi scope), so before
// this ticket a JPEG/HEIF export with a look showed it live on the canvas
// (the GPU-live path, and the interactive CPU fallback since #2683's
// bugfix round) but exported WITHOUT it — a silent look-drop. The fix
// composites `FilmLookCube` on the CIImage-graph export result the same
// way the interactive canvas's CPU fallback already does.
//
// Per CLAUDE.md's "no eyeballing color changes" rule: this proves the fix
// with pixel-hash inequality between a looked and a look-less export of the
// SAME source image, not a visual read. No gitignored RAW fixture is
// needed — the source image is a small synthetic JPEG built in-process, and
// the look is the tiny committed `Fixtures/film-luts/test_lut.mlut` (a
// hand-built, non-identity 2³ lattice — see `FilmLutStoreTests.swift`'s
// header), bundled into the test target via `Bundle.module`.

import XCTest
import CoreGraphics
import CoreImage
import ImageIO
import UniformTypeIdentifiers
@testable import MapleCore

@MainActor
final class EditSessionNonRawFilmExportTests: XCTestCase {

    /// A small JPEG with real tonal variety (an R/G gradient over a fixed
    /// blue), so a non-identity lattice visibly moves pixel values instead
    /// of mapping a lone flat color onto itself by coincidence.
    private func makeGradientJPEG() throws -> URL {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(UUID().uuidString).jpg")
        let w = 32, h = 32
        let cs = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let ctx = try XCTUnwrap(CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
            space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        for y in 0..<h {
            for x in 0..<w {
                let r = CGFloat(x) / CGFloat(w - 1)
                let g = CGFloat(y) / CGFloat(h - 1)
                ctx.setFillColor(red: r, green: g, blue: 0.4, alpha: 1.0)
                ctx.fill(CGRect(x: x, y: y, width: 1, height: 1))
            }
        }
        let cg = try XCTUnwrap(ctx.makeImage())
        let dest = try XCTUnwrap(CGImageDestinationCreateWithURL(
            tmp as CFURL, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, cg, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return tmp
    }

    /// Render `image` to a plain RGBA8 byte buffer for a hash/equality
    /// comparison — never an eyeballed read (CLAUDE.md's color-testing rule).
    private func pixelBytes(of image: CIImage) -> [UInt8] {
        let extent = image.extent
        let w = max(1, Int(extent.width)), h = max(1, Int(extent.height))
        var buffer = [UInt8](repeating: 0, count: w * h * 4)
        let context = CIContext()
        buffer.withUnsafeMutableBytes { raw in
            context.render(
                image, toBitmap: raw.baseAddress!, rowBytes: w * 4,
                bounds: CGRect(x: 0, y: 0, width: w, height: h), format: .RGBA8,
                colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        }
        return buffer
    }

    /// THE REGRESSION GATE for #2713: a non-RAW export with a resolved film
    /// look must differ from the same export with no look. Before the fix,
    /// both renders took the identical CIImage-graph path with nothing
    /// consuming `model.filmLook`, so this assertion would fail (the two
    /// byte buffers were identical).
    func testNonRawExportAppliesFilmLook() async throws {
        let url = try makeGradientJPEG()
        defer { try? FileManager.default.removeItem(at: url) }

        var noLookModel = AdjustmentModel.default
        noLookModel.filmLook = ""
        let noLookSession = EditSession(
            asset: AssetRef(url: url), model: noLookModel,
            filmLutStore: FilmLutStore(bundle: .module))
        let noLookImage = try await noLookSession.renderForExport()

        var lookModel = AdjustmentModel.default
        lookModel.filmLook = "test_lut"
        lookModel.filmStrength = 100
        let lookSession = EditSession(
            asset: AssetRef(url: url), model: lookModel,
            filmLutStore: FilmLutStore(bundle: .module))
        let lookImage = try await lookSession.renderForExport()

        let noLookBytes = pixelBytes(of: noLookImage)
        let lookBytes = pixelBytes(of: lookImage)
        XCTAssertEqual(noLookBytes.count, lookBytes.count, "both exports must be the same size")
        XCTAssertNotEqual(
            noLookBytes, lookBytes,
            "a non-RAW export with a resolved film look must differ from the no-look export (#2713)")
    }

    /// An unresolvable look id (no matching `.mlut`) must not fail the
    /// export or otherwise change it — `FilmLookCube.apply` is a no-op on a
    /// nil lattice, matching the render-time "unknown id resolves to
    /// identity" rule everywhere else in the film-look surface.
    func testNonRawExportWithUnresolvableLookIdMatchesNoLook() async throws {
        let url = try makeGradientJPEG()
        defer { try? FileManager.default.removeItem(at: url) }

        var noLookModel = AdjustmentModel.default
        noLookModel.filmLook = ""
        let noLookSession = EditSession(
            asset: AssetRef(url: url), model: noLookModel,
            filmLutStore: FilmLutStore(bundle: .module))
        let noLookImage = try await noLookSession.renderForExport()

        var unresolvableModel = AdjustmentModel.default
        unresolvableModel.filmLook = "does_not_exist_in_the_catalog"
        let unresolvableSession = EditSession(
            asset: AssetRef(url: url), model: unresolvableModel,
            filmLutStore: FilmLutStore(bundle: .module))
        let unresolvableImage = try await unresolvableSession.renderForExport()

        XCTAssertEqual(pixelBytes(of: noLookImage), pixelBytes(of: unresolvableImage))
    }
}
