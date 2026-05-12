// PhotoKitSourceXMPTests.swift — round-trip tests for PhotoKitSource writeXMP / readXMP.
//
// The shadow store (AppSupportSidecarStore) is independent of PhotoKit auth state
// so we can exercise writeXMP / readXMP without a real PHAsset. Each test gets
// an isolated tmp directory injected via the internal `sidecarOverride:` seam.

import XCTest
@testable import MapleCore
import MapleBackup

final class PhotoKitSourceXMPTests: XCTestCase {

    /// Write a Sidecar via PhotoKitSource then read it back — model and culling
    /// state should survive the round-trip.
    func testWriteThenReadRoundTrip() async throws {
        let tmpRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("photokit-xmp-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpRoot) }

        let store = AppSupportSidecarStore(root: tmpRoot)
        let source = PhotoKitSource(sidecarOverride: store)

        let phid = "TEST/L0/001"
        let ref = ImageRef(id: phid, displayName: phid)
        var model = AdjustmentModel.default
        model.exposure = 1.25
        var culling = CullingState()
        culling.stars = 4
        let sidecar = Sidecar(model: model, culling: culling)

        try await source.writeXMP(sidecar, for: ref)
        let (readModel, readCulling) = try await source.readXMP(for: ref)
        XCTAssertEqual(readModel.exposure, 1.25, accuracy: 0.0001)
        XCTAssertEqual(readCulling.stars, 4)
    }

    /// readXMP on a key that was never written should return default model and
    /// zero rating rather than throwing.
    func testReadWithoutPriorWriteReturnsDefault() async throws {
        let tmpRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("photokit-xmp-default-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpRoot) }

        let store = AppSupportSidecarStore(root: tmpRoot)
        let source = PhotoKitSource(sidecarOverride: store)
        let ref = ImageRef(id: "NEVER/WRITTEN", displayName: "n")
        let (model, culling) = try await source.readXMP(for: ref)
        XCTAssertEqual(model.exposure, AdjustmentModel.default.exposure, accuracy: 0.0001)
        XCTAssertEqual(culling.stars, 0)
    }
}
