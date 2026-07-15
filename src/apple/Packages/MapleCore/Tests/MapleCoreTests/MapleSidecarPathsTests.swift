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

    func testPreviewURLIsCanonicalFilenameAvif() {
        // #2009 — preview is `<dir>/.maple/previews/<filename>.avif`, the
        // ORIGINAL filename incl. extension, no hash / size / version token.
        let pano = URL(fileURLWithPath: "/a/b/Panoramas/panorama-test.png")
        XCTAssertEqual(
            MapleSidecarPaths.previewURL(for: pano).path,
            "/a/b/Panoramas/.maple/previews/panorama-test.png.avif"
        )
    }

    func testPreviewURLKeepsRawExtensionInName() {
        // The extension stays in the name so `IMG.CR2` and `IMG.CR3` never
        // collide, and the file reads as "preview of <that exact original>".
        let raw = URL(fileURLWithPath: "/lib/Photos/2024/IMG_1234.CR2")
        XCTAssertEqual(
            MapleSidecarPaths.previewURL(for: raw).path,
            "/lib/Photos/2024/.maple/previews/IMG_1234.CR2.avif"
        )
    }
}
