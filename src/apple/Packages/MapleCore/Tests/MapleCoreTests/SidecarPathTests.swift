// SidecarPathTests.swift — unit tests for the shared sidecar-URL resolver.
//
// Pins the two naming conventions (M5 — #1635):
//   - images: stem-swap   `IMG_1.ARW`    → `IMG_1.xmp`
//   - videos: full-name    `clip.mov`     → `clip.mov.xmp`
// The split keeps an Apple Live Photo's motion clip from clobbering the
// same-stem still. Mirrors the API's `xmpSidecarPath()` so a clip edited on
// Web and on Apple targets the same `.xmp` file.

import XCTest
@testable import MapleCore

final class SidecarPathTests: XCTestCase {

    // MARK: - Images: stem-swap

    func test_image_usesStemSwap() {
        let raw = URL(fileURLWithPath: "/photos/IMG_1.ARW")
        XCTAssertEqual(SidecarPath.sidecarURL(for: raw).path, "/photos/IMG_1.xmp")
    }

    func test_heicAndJpeg_useStemSwap() {
        XCTAssertEqual(
            SidecarPath.sidecarURL(for: URL(fileURLWithPath: "/p/clip.heic")).path,
            "/p/clip.xmp")
        XCTAssertEqual(
            SidecarPath.sidecarURL(for: URL(fileURLWithPath: "/p/clip.jpg")).path,
            "/p/clip.xmp")
    }

    // MARK: - Videos: full-name

    func test_video_keepsExtension() {
        let mov = URL(fileURLWithPath: "/photos/clip.mov")
        XCTAssertEqual(SidecarPath.sidecarURL(for: mov).path, "/photos/clip.mov.xmp")
    }

    func test_mp4_keepsExtension() {
        let mp4 = URL(fileURLWithPath: "/photos/clip.mp4")
        XCTAssertEqual(SidecarPath.sidecarURL(for: mp4).path, "/photos/clip.mp4.xmp")
    }

    func test_video_extensionMatchIsCaseInsensitive() {
        let mov = URL(fileURLWithPath: "/photos/IMG_1234.MOV")
        XCTAssertTrue(SidecarPath.isVideo(mov))
        XCTAssertEqual(SidecarPath.sidecarURL(for: mov).path, "/photos/IMG_1234.MOV.xmp")
    }

    // MARK: - Live Photo: no collision

    func test_livePhoto_stillAndClipResolveToDifferentSidecars() {
        let still = SidecarPath.sidecarURL(for: URL(fileURLWithPath: "/p/IMG_1234.HEIC"))
        let clip = SidecarPath.sidecarURL(for: URL(fileURLWithPath: "/p/IMG_1234.MOV"))
        XCTAssertEqual(still.path, "/p/IMG_1234.xmp")
        XCTAssertEqual(clip.path, "/p/IMG_1234.MOV.xmp")
        XCTAssertNotEqual(still.path, clip.path, "same-stem still + clip must not clobber")
    }

    // MARK: - isVideo classification

    func test_isVideo_classification() {
        XCTAssertTrue(SidecarPath.isVideo(URL(fileURLWithPath: "/p/a.mov")))
        XCTAssertTrue(SidecarPath.isVideo(URL(fileURLWithPath: "/p/a.m4v")))
        XCTAssertFalse(SidecarPath.isVideo(URL(fileURLWithPath: "/p/a.dng")))
        XCTAssertFalse(SidecarPath.isVideo(URL(fileURLWithPath: "/p/a.heic")))
    }
}
