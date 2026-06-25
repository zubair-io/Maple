// PhotoKitInputShapeTests.swift — #1553.
//
// A non-RAW image opened from PhotoKit (no URL, no extension) was tagged RAW by
// `AssetRef.isRaw`'s extension fallback, so the GPU live path used
// `inputShape = 0` and ran AgX on a non-RAW buffer — crushing white to grey.
// The fix records the authoritative magic-byte classification in `sharedDecode`
// and `presentViaGpuLive` reads it (`renderActor.resolvedIsRaw(for:)`) for the
// `inputShape` tag. These tests pin that the classification is recorded as
// non-RAW for a bytes-backed PNG asset.

import XCTest
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@testable import MapleCore

final class PhotoKitInputShapeTests: XCTestCase {

    /// A solid-white 4×4 sRGB PNG — the kind of non-RAW asset PhotoKit hands us.
    private func makePNGBytes() throws -> Data {
        let (w, h) = (4, 4)
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = try XCTUnwrap(CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
            space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        let cg = try XCTUnwrap(ctx.makeImage())
        let out = NSMutableData()
        let dest = try XCTUnwrap(CGImageDestinationCreateWithData(
            out as CFMutableData, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, cg, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return out as Data
    }

    /// A PhotoKit-shaped bytes-backed `AssetRef`: no URL, no hint, no explicit
    /// flag — so `isRaw` falls through to its RAW default — but the content is a
    /// PNG. After `sharedDecode`, the actor must have recorded it as NON-RAW.
    func testPhotoKitNonRawAssetResolvesNonRaw() async throws {
        let png = try makePNGBytes()
        let asset = AssetRef(
            displayName: "photo",            // UUID-style, no extension
            hintExtension: nil,
            stableID: "pk-nonraw-1",
            explicitIsRaw: nil,
            bytesProvider: { png }
        )
        // Precondition: the extension fallback mis-classifies this as RAW — the
        // exact trap that set inputShape=0 and ran AgX on a non-RAW buffer.
        XCTAssertTrue(asset.isRaw, "bytes-backed asset with no hint defaults to RAW")

        let actor = RenderActor(pipeline: ImageEditPipeline())
        // Before any decode, nothing is recorded → callers fall back to isRaw.
        let before = await actor.resolvedIsRaw(for: asset.id)
        XCTAssertNil(before)

        _ = await actor.sharedDecode(asset: asset) { img, _ in img }

        // The sniff must have recorded NON-RAW, so the GPU `inputShape` resolves
        // to 1 (LinearRec2020Fp16) and AgX is skipped.
        let resolved = await actor.resolvedIsRaw(for: asset.id)
        XCTAssertEqual(resolved, false,
            "PhotoKit PNG must resolve NON-RAW so the GPU path skips AgX (#1553)")
    }

    /// An unknown asset id has no recorded classification — `presentViaGpuLive`
    /// falls back to `AssetRef.isRaw` (correct for URL/extension-backed assets).
    func testUnknownAssetHasNoRecordedClassification() async {
        let actor = RenderActor(pipeline: ImageEditPipeline())
        let none = await actor.resolvedIsRaw(for: AssetRef.ID())
        XCTAssertNil(none)
    }
}
