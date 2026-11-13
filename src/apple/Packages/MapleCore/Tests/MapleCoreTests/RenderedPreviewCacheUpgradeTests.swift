// RenderedPreviewCacheUpgradeTests.swift — the APP-UPGRADE scenario for the
// rendered-preview disk cache (#1805, inverted by #4793).
//
// The key is version-free: a preview persisted by the previous build stays
// addressable after an app update, and only a change to the asset's own state
// (RAW mtime, sidecar mtime, selected sidecar, width bucket) re-keys it. This
// file works on real files at real on-disk key paths:
//
//   1. store a preview and OBSERVE the filename the cache actually wrote;
//   2. assert a version-free mirror of the key derivation reproduces it;
//   3. a fresh cache instance (the "next build") serves those bytes;
//   4. touching the sidecar re-keys the entry, so (3) is not vacuous.

import CoreImage
import CryptoKit
import Foundation
import XCTest

@testable import MapleCore

final class RenderedPreviewCacheUpgradeTests: XCTestCase {

    private var tmpDir: URL!
    private let screenWidth = 900

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("rendered-preview-upgrade-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    func testEntryWrittenByAPreviousBuildIsStillServed() async throws {
        let asset = tmpDir.appendingPathComponent("upgrade.dng")
        try Data("raw".utf8).write(to: asset)
        let sidecar = SidecarPath.sidecarURL(for: asset)
        try Data("<xmp/>".utf8).write(to: sidecar)

        await freshCache().storePreview(swatch(), for: asset, screenWidth: screenWidth)

        let previewDir = tmpDir.appendingPathComponent(".maple/previews")
        let written = try FileManager.default
            .contentsOfDirectory(atPath: previewDir.path)
            .filter { $0.hasSuffix(".jpg") }
        XCTAssertEqual(written, [keyOnDisk(for: asset)],
                       "the on-disk key must be the version-free derivation")

        let afterUpgrade = await freshCache().preview(for: asset, screenWidth: screenWidth)
        XCTAssertNotNil(afterUpgrade, "a persisted preview must survive an app upgrade (#4793)")

        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(60)], ofItemAtPath: sidecar.path)
        let afterEdit = await freshCache().preview(for: asset, screenWidth: screenWidth)
        XCTAssertNil(afterEdit, "a sidecar change must still re-key the entry")
    }

    // MARK: - Helpers

    private func freshCache() async -> RenderedPreviewCache {
        let cache = RenderedPreviewCache()
        await cache.configure(folderURL: tmpDir)
        return cache
    }

    private func swatch() -> CIImage {
        CIImage(color: CIColor(red: 0.4, green: 0.5, blue: 0.6))
            .cropped(to: CGRect(x: 0, y: 0, width: 64, height: 48))
    }

    private func keyOnDisk(for asset: URL) -> String {
        let token = RenderedPreviewCache.variantToken(
            primaryMtime: mtimeString(asset.path),
            sidecarMtime: mtimeString(SidecarPath.sidecarURL(for: asset).path),
            screenWidth: screenWidth)
        let urlHash = String(sha256Prefix(asset.path).prefix(16))
        return "\(urlHash)_\(sha256Prefix(token)).jpg"
    }

    private func mtimeString(_ path: String) -> String {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let mtime = attrs[.modificationDate] as? Date else { return "0" }
        return String(Int64(mtime.timeIntervalSince1970 * 1000))
    }

    private func sha256Prefix(_ string: String) -> String {
        SHA256.hash(data: Data(string.utf8))
            .prefix(16)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
