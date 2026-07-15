import XCTest

@testable import MapleCore

final class MapleSidecarPathsTests: XCTestCase {
    func testKeyMatchesFrozenCrossPlatformValue() {
        // MUST equal the Rust sha256_prefix16 and API/web values.
        XCTAssertEqual(MapleThumbCacheKey.sha256Prefix16("panorama-test.png"), "88bab9b0d022c93c")
    }

    func testThumbURLIsAssetRelativeCanonical() {
        let pano = URL(fileURLWithPath: "/a/b/Panoramas/panorama-test.png")
        XCTAssertEqual(
            MapleSidecarPaths.thumbURL(for: pano).path,
            "/a/b/Panoramas/.maple/thumbs/88bab9b0d022c93c.avif"
        )
    }

    func testPreviewURLIsAssetRelativeCanonical() {
        let pano = URL(fileURLWithPath: "/a/b/Panoramas/panorama-test.png")
        XCTAssertEqual(
            MapleSidecarPaths.previewURL(for: pano).path,
            "/a/b/Panoramas/.maple/previews/88bab9b0d022c93c_1600.jpg"
        )
    }

    // MARK: - Edited/developed preview tier (#2009)

    func testEditedPreviewURLIsDistinctFromCanonicalPreviewURL() {
        let pano = URL(fileURLWithPath: "/a/b/Panoramas/panorama-test.png")
        let edited = MapleSidecarPaths.editedPreviewURL(for: pano)
        XCTAssertEqual(
            edited.path,
            "/a/b/Panoramas/.maple/previews/88bab9b0d022c93c_1600.edited.jpg"
        )
        XCTAssertNotEqual(edited, MapleSidecarPaths.previewURL(for: pano))
    }

    func testEditedPreviewMarkerURLIsDistinctFromCanonicalMarkerURL() {
        let pano = URL(fileURLWithPath: "/a/b/Panoramas/panorama-test.png")
        let marker = MapleSidecarPaths.editedPreviewMarkerURL(for: pano)
        XCTAssertEqual(
            marker.path,
            "/a/b/Panoramas/.maple/previews/88bab9b0d022c93c_1600.edited.v"
        )
        XCTAssertNotEqual(marker, MapleSidecarPaths.previewVersionURL(for: pano))
    }
}
