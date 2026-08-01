// RenderedPreviewCacheUpgradeTests.swift — the APP-UPGRADE scenario for the
// rendered-preview disk cache (#1805, gap 2).
//
// WHY THIS EXISTS. Every CI and dev environment starts with an empty
// `.maple/previews/` store, so the one situation that actually shipped the
// #1801 band to users — a device carrying previews rendered by the PREVIOUS
// build, opened on the current one — is structurally invisible to every
// existing gate. The bug was never "the pipeline renders wrong"; it was "the
// pipeline never ran, because a stale artifact was still key-valid and
// short-circuited it," and no test in the repo had a stale artifact to serve.
//
// `RenderedPreviewCacheTests` already asserts that `variantToken` CONTAINS the
// version fields, but `variantToken` is only a string builder: a regression
// that stopped `cacheKey` from folding the token in, or that dropped a version
// from the hashed key, leaves those assertions green while restoring exactly
// the #1801 failure mode. So this file works one level down, on real files at
// real on-disk key paths:
//
//   1. store a preview and OBSERVE the filename the cache actually wrote;
//   2. assert the mirrored key derivation below reproduces it — the drift
//      guard that makes every step after it meaningful;
//   3. move those same bytes to the key a PREVIOUS build would have written
//      and assert the read path refuses to serve them;
//   4. move them back to the current key and assert they DO serve, so the
//      refusals in (3) can never be vacuous.

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

    // MARK: - The gate

    func testEntryWrittenByAPreviousBuildIsNotServed() async throws {
        let asset = tmpDir.appendingPathComponent("upgrade.dng")
        try Data("raw".utf8).write(to: asset)
        // A real sidecar, so the sidecar-mtime key component is a live value
        // rather than the missing-file `"0"` constant — this is the
        // edited-image case the band was reported on.
        try Data("<xmp/>".utf8).write(to: SidecarPath.sidecarURL(for: asset))

        let cache = await freshCache()
        await cache.storePreview(swatch(), for: asset, screenWidth: screenWidth)
        let viewTransformVersion = await cache._testViewTransformVersion()

        // (1) What did the cache actually write?
        let previewDir = tmpDir.appendingPathComponent(".maple/previews")
        let written = try FileManager.default
            .contentsOfDirectory(atPath: previewDir.path)
            .filter { $0.hasSuffix(".jpg") }
        XCTAssertEqual(written.count, 1,
                       "expected exactly one preview on disk, found \(written)")
        let currentFile = try XCTUnwrap(written.first)

        // (2) Drift guard. If `RenderedPreviewCache.cacheKey` ever stops
        // deriving its filename this way, every assertion below would be
        // testing a path the cache does not read — so fail loudly here first.
        let currentKey = keyOnDisk(for: asset,
                                   viewTransformVersion: viewTransformVersion,
                                   pipelineOutputVersion: AdjustmentModel.pipelineOutputVersion)
        XCTAssertEqual(
            currentFile, currentKey,
            "the mirrored key derivation in this test no longer matches "
            + "RenderedPreviewCache.cacheKey — update both together")

        // (3a) The same bytes under the PREVIOUS Apple-local cache generation:
        // the host-side render-semantics bump (v6/v7/v8 in the cache's own
        // lineage) that #1801 shipped without.
        let previousViewTransform = keyOnDisk(
            for: asset,
            viewTransformVersion: viewTransformVersion - 1,
            pipelineOutputVersion: AdjustmentModel.pipelineOutputVersion)
        try move(in: previewDir, from: currentKey, to: previousViewTransform)
        let staleViewTransformHit = await freshCache()
            .preview(for: asset, screenWidth: screenWidth)
        XCTAssertNil(
            staleViewTransformHit,
            "a preview written under viewTransformVersion "
            + "\(viewTransformVersion - 1) must not be served by a build at "
            + "\(viewTransformVersion) — that short-circuit is #1801")

        // (3b) And under the previous single-sourced, codegen-mirrored
        // raw-core pipeline-output version (#1926).
        let previousPipelineOutput = keyOnDisk(
            for: asset,
            viewTransformVersion: viewTransformVersion,
            pipelineOutputVersion: AdjustmentModel.pipelineOutputVersion - 1)
        try move(in: previewDir, from: previousViewTransform, to: previousPipelineOutput)
        let stalePipelineHit = await freshCache()
            .preview(for: asset, screenWidth: screenWidth)
        XCTAssertNil(
            stalePipelineHit,
            "a preview written under pipelineOutputVersion "
            + "\(AdjustmentModel.pipelineOutputVersion - 1) must not be served "
            + "by a build at \(AdjustmentModel.pipelineOutputVersion)")

        // (4) Non-vacuity: those exact bytes, back at the current key, DO
        // serve. Without this the two nil assertions above would also pass if
        // the disk read path were broken outright.
        try move(in: previewDir, from: previousPipelineOutput, to: currentKey)
        let currentHit = await freshCache().preview(for: asset, screenWidth: screenWidth)
        XCTAssertNotNil(
            currentHit,
            "the same bytes at the CURRENT key must serve — otherwise the "
            + "stale-key assertions above prove nothing")
    }

    // MARK: - Helpers

    /// A cache configured against the temp folder. Fresh instance per call so
    /// the read path can never be served by another instance's memory front.
    private func freshCache() async -> RenderedPreviewCache {
        let cache = RenderedPreviewCache()
        await cache.configure(folderURL: tmpDir)
        return cache
    }

    private func swatch() -> CIImage {
        CIImage(color: CIColor(red: 0.4, green: 0.5, blue: 0.6))
            .cropped(to: CGRect(x: 0, y: 0, width: 64, height: 48))
    }

    private func move(in dir: URL, from: String, to: String) throws {
        try FileManager.default.moveItem(at: dir.appendingPathComponent(from),
                                         to: dir.appendingPathComponent(to))
    }

    /// Mirror of `RenderedPreviewCache.cacheKey` + its `.jpg` suffix, with the
    /// two version components left free so a caller can build the key a
    /// PREVIOUS build would have written. Uses the production `variantToken`
    /// (internal, `@testable`) for the token itself; only the hashing and the
    /// `urlHash` prefix are re-derived here, and step (2) of the test proves
    /// that re-derivation still agrees with the real thing.
    private func keyOnDisk(for asset: URL,
                           viewTransformVersion: UInt32,
                           pipelineOutputVersion: UInt32) -> String {
        let token = RenderedPreviewCache.variantToken(
            primaryMtime: mtimeString(asset.path),
            sidecarMtime: mtimeString(SidecarPath.sidecarURL(for: asset).path),
            screenWidth: screenWidth,
            viewTransformVersion: viewTransformVersion,
            pipelineOutputVersion: pipelineOutputVersion)
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
