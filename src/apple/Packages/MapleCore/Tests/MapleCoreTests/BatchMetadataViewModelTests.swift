// BatchMetadataViewModelTests.swift — unit tests for BatchMetadataViewModel.
// Tests use real XMPSidecarStore + temp directories (no mocks).

import XCTest
@testable import MapleCore

@MainActor
final class BatchMetadataViewModelTests: XCTestCase {

    // MARK: - Helpers

    /// Write a sidecar for a temp DNG URL and return the URL.
    private func tempAsset(metadata: XmpMetadata? = nil, model: AdjustmentModel = .default,
                           culling: CullingState = CullingState()) async throws -> (AssetRef, XMPSidecarStore) {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        let store = XMPSidecarStore(rawURL: url)
        if let m = metadata {
            await store.update(model: model, culling: culling, metadata: m)
        } else {
            await store.update(model: model, culling: culling)
        }
        await store.flush()
        let ref = AssetRef(url: url)
        return (ref, store)
    }

    // MARK: - Mixed-value detection

    func testMixedCityDetected() async throws {
        var m1 = XmpMetadata(); m1.city = "Paris"
        var m2 = XmpMetadata(); m2.city = "London"
        let (a1, _) = try await tempAsset(metadata: m1)
        let (a2, _) = try await tempAsset(metadata: m2)
        let vm = BatchMetadataViewModel(assets: [a1, a2], sessions: [:])
        await vm.loadExistingMetadata()
        XCTAssertTrue(vm.mixedFields.contains(.city), "City should be mixed")
        XCTAssertNil(vm.commonMetadata.city, "commonMetadata.city should be nil when mixed")
    }

    func testCommonCityAgreed() async throws {
        var m1 = XmpMetadata(); m1.city = "Paris"
        var m2 = XmpMetadata(); m2.city = "Paris"
        let (a1, _) = try await tempAsset(metadata: m1)
        let (a2, _) = try await tempAsset(metadata: m2)
        let vm = BatchMetadataViewModel(assets: [a1, a2], sessions: [:])
        await vm.loadExistingMetadata()
        XCTAssertFalse(vm.mixedFields.contains(.city), "City should not be mixed when equal")
        XCTAssertEqual(vm.commonMetadata.city, "Paris")
    }

    // MARK: - Apply: only touched fields written

    func testApplyOnlyTouchedFieldsWritten() async throws {
        var existingMeta = XmpMetadata()
        existingMeta.city = "Paris"
        existingMeta.headline = "Existing"
        let (asset, store) = try await tempAsset(metadata: existingMeta)
        let sidecarURL = await store.url

        let vm = BatchMetadataViewModel(assets: [asset], sessions: [:])
        await vm.loadExistingMetadata()

        vm.touchedMetadata.city = "Berlin"
        try await vm.apply()

        let xml = try String(contentsOf: sidecarURL, encoding: .utf8)
        let parsed = XMPParser.parseMetadata(xml)
        XCTAssertEqual(parsed.city, "Berlin", "Touched city must be written")
        XCTAssertEqual(parsed.headline, "Existing", "Untouched headline must be preserved")
    }

    func testApplyExplicitClear() async throws {
        var existingMeta = XmpMetadata()
        existingMeta.city = "Paris"
        let (asset, store) = try await tempAsset(metadata: existingMeta)
        let sidecarURL = await store.url

        let vm = BatchMetadataViewModel(assets: [asset], sessions: [:])
        await vm.loadExistingMetadata()

        // Explicit clear: set touched to empty string.
        vm.touchedMetadata.city = ""
        try await vm.apply()

        let xml = try String(contentsOf: sidecarURL, encoding: .utf8)
        let parsed = XMPParser.parseMetadata(xml)
        XCTAssertNil(parsed.city, "Explicitly cleared city should not appear in sidecar")
    }

    // MARK: - GPS touch

    func testApplyGPSTouched() async throws {
        let (asset, store) = try await tempAsset()
        let sidecarURL = await store.url
        let vm = BatchMetadataViewModel(assets: [asset], sessions: [:])
        await vm.loadExistingMetadata()
        vm.touchedMetadata.gpsLatitude = 48.8566
        vm.touchedMetadata.gpsLongitude = 2.3522
        try await vm.apply()
        let xml = (try? String(contentsOf: sidecarURL, encoding: .utf8)) ?? ""
        let parsed = XMPParser.parseMetadata(xml)
        XCTAssertEqual(parsed.gpsLatitude!, 48.8566, accuracy: 1e-4)
        XCTAssertEqual(parsed.gpsLongitude!, 2.3522, accuracy: 1e-4)
    }
}
