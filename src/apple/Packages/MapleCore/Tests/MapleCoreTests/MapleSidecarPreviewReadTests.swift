import CoreImage
import XCTest

@testable import MapleCore

final class MapleSidecarPreviewReadTests: XCTestCase {
    private func jpegData(width: Int, height: Int) -> Data {
        let ci = CIImage(color: .gray).cropped(
            to: CGRect(x: 0, y: 0, width: width, height: height))
        return CIContext().jpegRepresentation(
            of: ci, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, options: [:])!
    }

    func testReadMapleSidecarPreviewDecodesJPEGAtCanonicalPath() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(
            "mspr-\(UUID().uuidString)/Panoramas")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let panoURL = dir.appendingPathComponent("panorama-test.png")

        // Encode a real 8x4 JPEG at the canonical preview path, with its
        // #1976 tier-version marker — a marker-less file reads as stale by
        // definition (see `displayPreviewMarkerIsCurrent`'s doc).
        let previewURL = MapleSidecarPaths.previewURL(for: panoURL)
        try fm.createDirectory(
            at: previewURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try jpegData(width: 8, height: 4).write(to: previewURL)
        ThumbnailLoader.writeDisplayPreviewMarker(for: panoURL)

        let decoded = EditSession.readMapleSidecarPreview(from: panoURL)
        XCTAssertNotNil(decoded)
        XCTAssertEqual(decoded?.extent.width, 8)

        // Missing file → nil.
        let missing = dir.appendingPathComponent("panorama-absent.png")
        XCTAssertNil(EditSession.readMapleSidecarPreview(from: missing))

        try? fm.removeItem(at: dir.deletingLastPathComponent())
    }

    // MARK: - Edited/developed preview precedence (#2009)

    func testReadMapleSidecarPreviewPrefersFreshLocalEditedRenderOverCanonical() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(
            "mspr-edited-\(UUID().uuidString)")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let assetURL = dir.appendingPathComponent("a.dng")
        try Data([0x00]).write(to: assetURL)

        // Canonical camera-original tier present and fresh.
        let previewURL = MapleSidecarPaths.previewURL(for: assetURL)
        try fm.createDirectory(
            at: previewURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try jpegData(width: 8, height: 4).write(to: previewURL)
        ThumbnailLoader.writeDisplayPreviewMarker(for: assetURL)

        // Local edited render present with a marker matching the CURRENT
        // sidecar state (no sidecar at all here — "none" signature).
        let editedURL = MapleSidecarPaths.editedPreviewURL(for: assetURL)
        try jpegData(width: 16, height: 8).write(to: editedURL)
        ThumbnailLoader.writeEditedPreviewMarker(for: assetURL)

        let decoded = EditSession.readMapleSidecarPreview(from: assetURL)
        XCTAssertEqual(
            decoded?.extent.width, 16,
            "the local edited render must win over the canonical camera-original tier")

        try? fm.removeItem(at: dir)
    }

    func testReadMapleSidecarPreviewFallsBackToCanonicalWhenEditedMarkerStale() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(
            "mspr-stale-edited-\(UUID().uuidString)")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let assetURL = dir.appendingPathComponent("a.dng")
        try Data([0x00]).write(to: assetURL)

        let previewURL = MapleSidecarPaths.previewURL(for: assetURL)
        try fm.createDirectory(
            at: previewURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try jpegData(width: 8, height: 4).write(to: previewURL)
        ThumbnailLoader.writeDisplayPreviewMarker(for: assetURL)

        // Local edited render present, but its marker records a sidecar-state
        // signature that no longer matches (simulating an external sidecar
        // change since this render was captured).
        let editedURL = MapleSidecarPaths.editedPreviewURL(for: assetURL)
        try jpegData(width: 16, height: 8).write(to: editedURL)
        try "stale-signature".write(
            to: MapleSidecarPaths.editedPreviewMarkerURL(for: assetURL),
            atomically: true, encoding: .utf8)

        let decoded = EditSession.readMapleSidecarPreview(from: assetURL)
        XCTAssertEqual(
            decoded?.extent.width, 8,
            "a stale edited marker must fall back to the canonical tier")
        // The stale edited render + its marker are cleaned up eagerly, not
        // left for cache-gc's backstop sweep.
        XCTAssertFalse(fm.fileExists(atPath: editedURL.path))
        XCTAssertFalse(
            fm.fileExists(atPath: MapleSidecarPaths.editedPreviewMarkerURL(for: assetURL).path))

        try? fm.removeItem(at: dir)
    }
}
