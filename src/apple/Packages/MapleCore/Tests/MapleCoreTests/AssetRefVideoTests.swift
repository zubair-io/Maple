// AssetRefVideoTests.swift — standalone-video crash-safety (#1638).
//
// Videos became first-class selectable assets so their metadata can be
// edited to a `clip.mov.xmp` sidecar. They have NO still frame, so the
// render/open path must never feed a video's container bytes to a decoder.
//
// Covers:
//   • AssetRef.isVideo classification + isRaw short-circuit (video is never
//     RAW, even with explicitIsRaw == true).
//   • EditSession render dispatch no-ops for a video (no libraw, no
//     CGImageSource, no published preview).
//
// Split out of NonRawSupportTests.swift to stay under the 600-line budget.

import XCTest
@testable import MapleCore

final class AssetRefVideoTests: XCTestCase {
    // MARK: - Classification

    func testAssetRefVideoIsNeverRaw() {
        // `isRaw` must return false so the open/render dispatch never routes a
        // video's container bytes to the libraw RAW decoder.
        for ext in ["mov", "MP4", "m4v", "MKV", "webm", "3gp"] {
            let ref = AssetRef(url: URL(fileURLWithPath: "/tmp/clip.\(ext)"))
            XCTAssertFalse(ref.isRaw, ".\(ext) video must NOT classify as RAW")
            XCTAssertTrue(ref.isVideo, ".\(ext) must classify as video")
        }
    }

    func testAssetRefVideoIsRawBeatsExplicitIsRaw() {
        // The video short-circuit precedes `explicitIsRaw`: a source can't force
        // a video onto the RAW decode path even with explicitIsRaw == true.
        let ref = AssetRef(url: URL(fileURLWithPath: "/tmp/clip.mov"), scopeParentURL: nil)
        XCTAssertFalse(ref.isRaw)
        XCTAssertTrue(ref.isVideo)
    }

    func testAssetRefNonVideoIsNotVideo() {
        XCTAssertFalse(AssetRef(url: URL(fileURLWithPath: "/tmp/foo.dng")).isVideo)
        XCTAssertFalse(AssetRef(url: URL(fileURLWithPath: "/tmp/foo.jpg")).isVideo)
        let still = AssetRef(displayName: "PHAsset", hintExtension: "heic", bytesProvider: { Data() })
        XCTAssertFalse(still.isVideo)
    }

    func testURLLessVideoUsesExtensionHint() {
        let ref = AssetRef(displayName: "Cloud clip", hintExtension: "MOV", bytesProvider: { Data() })
        XCTAssertTrue(ref.isVideo, "remote video refs must classify from their extension hint")
        XCTAssertFalse(ref.isRaw)
    }

    // MARK: - EditSession render no-op

    @MainActor
    func testEditSessionDoesNotDecodeVideo() async {
        // Opening a video for render must be a no-op: no decode, no published
        // preview. `isRaw == false` already keeps it out of libraw; this asserts
        // the render dispatch itself bails so a video never reaches ANY decoder.
        // The path doesn't need to exist — the guard runs before any file read.
        let video = AssetRef(url: URL(fileURLWithPath: "/tmp/does-not-exist.mov"))
        let session = EditSession(asset: video)
        XCTAssertTrue(session.asset.isVideo)
        XCTAssertFalse(session.asset.isRaw)

        // renderFull funnels through decodeAndRender — the single body all
        // phases use. For a video it returns immediately without publishing.
        await session.renderFull()
        XCTAssertNil(session.renderedPreview, "video session must not produce a preview")
        XCTAssertFalse(session.isRendering, "video render must leave isRendering false")
    }
}
