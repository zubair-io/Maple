// EditSessionNativeSizeSeedTests.swift — #1604.
//
// A sourceless / bytes-backed asset (Self-Hosted, SMB, PhotoKit) must seed
// `nativeImageSize` from its bytes so the canvas frame resolves and the GPU
// live layer registers before the decode lands. Without an early seed the
// remote asset stays placeholder-only and falls to the CPU path.
//
// Split out of NonRawSupportTests to keep that file under the 600-LOC budget.

import XCTest
import CoreImage
import ImageIO
import UniformTypeIdentifiers
@testable import MapleCore

final class EditSessionNativeSizeSeedTests: XCTestCase {
    @MainActor
    func testSeedsNativeImageSizeFromBytesProvider() async {
        let w = 320, h = 200
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8,
            bytesPerRow: w * 4, space: cs,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { XCTFail("synth CGContext failed"); return }
        ctx.setFillColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1.0)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        guard let cg = ctx.makeImage() else { XCTFail("synth CGImage failed"); return }
        let mutData = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            mutData, UTType.jpeg.identifier as CFString, 1, nil
        ) else { XCTFail("CGImageDestination failed"); return }
        CGImageDestinationAddImage(dest, cg, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        let bytes = mutData as Data

        let asset = AssetRef(displayName: "remote.jpg", hintExtension: "jpg", bytesProvider: { bytes })
        XCTAssertNil(asset.primaryURL, "bytes-backed asset has no URL")
        let session = EditSession(asset: asset)
        XCTAssertEqual(session.nativeImageSize, .zero)

        await session.seedNativeImageSizeFromMetadataAsync(asset)

        XCTAssertEqual(
            session.nativeImageSize, CGSize(width: CGFloat(w), height: CGFloat(h)),
            "a bytes-backed asset must seed nativeImageSize from its bytes")
    }
}
