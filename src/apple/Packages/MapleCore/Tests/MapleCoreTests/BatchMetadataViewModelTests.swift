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

    func testApplyGPSExplicitClear() async throws {
        var m = XmpMetadata(); m.gpsLatitude = 10; m.gpsLongitude = 20
        let (asset, store) = try await tempAsset(metadata: m)
        let sidecarURL = await store.url
        let vm = BatchMetadataViewModel(assets: [asset], sessions: [:])
        await vm.loadExistingMetadata()
        // Clear GPS button sets .some(nil) on lat/lon/alt.
        vm.touchedMetadata.gpsLatitude = .some(nil)
        vm.touchedMetadata.gpsLongitude = .some(nil)
        try await vm.apply()
        let parsed = XMPParser.parseMetadata(try String(contentsOf: sidecarURL, encoding: .utf8))
        XCTAssertNil(parsed.gpsLatitude, "Explicitly-cleared GPS latitude must be removed")
        XCTAssertNil(parsed.gpsLongitude, "Explicitly-cleared GPS longitude must be removed")
    }

    // MARK: - Multi-asset apply

    func testApplyMultiAssetPreservesPerAssetUntouched() async throws {
        var m1 = XmpMetadata(); m1.city = "Paris"; m1.headline = "H1"
        var m2 = XmpMetadata(); m2.city = "Paris"; m2.headline = "H2"
        let (a1, s1) = try await tempAsset(metadata: m1)
        let (a2, s2) = try await tempAsset(metadata: m2)
        let u1 = await s1.url
        let u2 = await s2.url

        let vm = BatchMetadataViewModel(assets: [a1, a2], sessions: [:])
        await vm.loadExistingMetadata()
        vm.touchedMetadata.city = "Berlin"   // touch only the (common) city
        try await vm.apply()

        let p1 = XMPParser.parseMetadata(try String(contentsOf: u1, encoding: .utf8))
        let p2 = XMPParser.parseMetadata(try String(contentsOf: u2, encoding: .utf8))
        XCTAssertEqual(p1.city, "Berlin"); XCTAssertEqual(p2.city, "Berlin")
        XCTAssertEqual(p1.headline, "H1", "per-asset untouched headline must survive")
        XCTAssertEqual(p2.headline, "H2", "per-asset untouched headline must survive")
    }

    // MARK: - Video asset path (#1638)

    func testApplyToVideoAssetWritesMetadataOnlySidecar() async throws {
        // Create a temp .mov URL (extension is what matters — no real video content needed)
        let videoURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("mov")
        // Write a placeholder so the file "exists" on disk (sidecar is written next to it)
        try Data().write(to: videoURL)
        defer {
            try? FileManager.default.removeItem(at: videoURL)
            try? FileManager.default.removeItem(at: SidecarPath.sidecarURL(for: videoURL))
        }

        let ref = AssetRef(url: videoURL)
        let vm = BatchMetadataViewModel(assets: [ref], sessions: [:])
        vm.touchedMetadata.city = "Tokyo"
        try await vm.apply()

        let sidecarURL = SidecarPath.sidecarURL(for: videoURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: sidecarURL.path),
                      "clip.mov.xmp sidecar must be written")
        let xml = try String(contentsOf: sidecarURL, encoding: .utf8)
        XCTAssertTrue(xml.contains("Tokyo"), "city must appear in sidecar XML")
        XCTAssertFalse(xml.contains("crs:Exposure"), "video sidecar must not contain crs:Exposure")
        XCTAssertFalse(xml.contains("crs:WhiteBalance"), "video sidecar must not contain crs:WhiteBalance")
        // Sidecar URL for a .mov must use full-name convention (.mov.xmp, not .xmp)
        XCTAssertTrue(sidecarURL.lastPathComponent.hasSuffix(".mov.xmp"),
                      "video sidecar must use full-name convention")
    }

    // MARK: - Altitude apply (#1633)

    func testApplyAltitudeRoundTrip() async throws {
        let (asset, store) = try await tempAsset()
        let sidecarURL = await store.url

        let vm = BatchMetadataViewModel(assets: [asset], sessions: [:])
        await vm.loadExistingMetadata()

        vm.touchedMetadata.gpsLatitude  = 48.8566
        vm.touchedMetadata.gpsLongitude = 2.3522
        vm.touchedMetadata.gpsAltitude  = 1234.5
        try await vm.apply()

        let xml = (try? String(contentsOf: sidecarURL, encoding: .utf8)) ?? ""
        let parsed = XMPParser.parseMetadata(xml)
        XCTAssertEqual(parsed.gpsLatitude!,  48.8566, accuracy: 1e-4,
                       "GPS latitude must round-trip")
        XCTAssertEqual(parsed.gpsLongitude!, 2.3522,  accuracy: 1e-4,
                       "GPS longitude must round-trip")
        XCTAssertEqual(parsed.gpsAltitude!, 1234.5, accuracy: 0.001,
                       "Altitude must round-trip to within 0.001 m")
    }

    /// A genuine 0 m (sea-level) altitude must survive apply — it is a valid
    /// reading, distinct from "altitude not set". This is the value the
    /// verticalAccuracy>0 placemark path now applies instead of dropping.
    func testApplyZeroAltitudeIsPreserved() async throws {
        let (asset, store) = try await tempAsset()
        let sidecarURL = await store.url

        let vm = BatchMetadataViewModel(assets: [asset], sessions: [:])
        await vm.loadExistingMetadata()

        vm.touchedMetadata.gpsLatitude  = 0.0
        vm.touchedMetadata.gpsLongitude = 0.0
        vm.touchedMetadata.gpsAltitude  = 0.0
        try await vm.apply()

        let xml = (try? String(contentsOf: sidecarURL, encoding: .utf8)) ?? ""
        let parsed = XMPParser.parseMetadata(xml)
        XCTAssertNotNil(parsed.gpsAltitude, "0 m altitude must be written, not dropped")
        XCTAssertEqual(parsed.gpsAltitude!, 0.0, accuracy: 0.001,
                       "0 m sea-level altitude must round-trip")
    }

    func testApplyAltitudeExplicitClear() async throws {
        var m = XmpMetadata()
        m.gpsLatitude = 10; m.gpsLongitude = 20; m.gpsAltitude = 500
        let (asset, store) = try await tempAsset(metadata: m)
        let sidecarURL = await store.url

        let vm = BatchMetadataViewModel(assets: [asset], sessions: [:])
        await vm.loadExistingMetadata()

        // Clear GPS clears lat/lon/alt atomically.
        vm.touchedMetadata.gpsLatitude  = .some(nil)
        vm.touchedMetadata.gpsLongitude = .some(nil)
        vm.touchedMetadata.gpsAltitude  = .some(nil)
        try await vm.apply()

        let parsed = XMPParser.parseMetadata(
            try String(contentsOf: sidecarURL, encoding: .utf8)
        )
        XCTAssertNil(parsed.gpsAltitude, "Explicitly-cleared altitude must be removed")
    }

    // MARK: - Keywords apply (#1633)

    func testApplyKeywordsRoundTrip() async throws {
        var m = XmpMetadata(); m.city = "Paris"
        let culling = CullingState(stars: 3, flag: .none, keywords: ["travel"])
        let (asset, store) = try await tempAsset(metadata: m, culling: culling)
        let sidecarURL = await store.url

        let vm = BatchMetadataViewModel(assets: [asset], sessions: [:])
        await vm.loadExistingMetadata()

        // Existing keywords are "travel"; load must detect them (not mixed, single asset).
        XCTAssertFalse(vm.mixedFields.contains(.keywords),
                       "Keywords should not be mixed for a single asset")
        XCTAssertEqual(vm.commonKeywords, ["travel"])

        // Replace keywords.
        vm.touchedMetadata.keywords = .some(["france", "street"])
        try await vm.apply()

        let xml = try String(contentsOf: sidecarURL, encoding: .utf8)
        let (_, parsedCulling) = try XMPParser.parse(xml)
        XCTAssertEqual(parsedCulling.keywords, ["france", "street"],
                       "New keywords must be written to the sidecar")

        // The unrelated metadata field (city) must survive.
        let parsedMeta = XMPParser.parseMetadata(xml)
        XCTAssertEqual(parsedMeta.city, "Paris", "Untouched city must be preserved")
    }

    func testApplyKeywordsExplicitClear() async throws {
        let culling = CullingState(stars: 0, flag: .none, keywords: ["old"])
        let (asset, store) = try await tempAsset(culling: culling)
        let sidecarURL = await store.url

        let vm = BatchMetadataViewModel(assets: [asset], sessions: [:])
        await vm.loadExistingMetadata()

        // Clear keywords by providing an empty list.
        vm.touchedMetadata.keywords = .some([])
        try await vm.apply()

        let xml = try String(contentsOf: sidecarURL, encoding: .utf8)
        let (_, parsedCulling) = try XMPParser.parse(xml)
        XCTAssertEqual(parsedCulling.keywords, [],
                       "Explicitly-cleared keywords must be empty after apply")
    }

    func testKeywordsMixedDetected() async throws {
        let c1 = CullingState(stars: 0, flag: .none, keywords: ["travel"])
        let c2 = CullingState(stars: 0, flag: .none, keywords: ["nature"])
        let (a1, _) = try await tempAsset(culling: c1)
        let (a2, _) = try await tempAsset(culling: c2)

        let vm = BatchMetadataViewModel(assets: [a1, a2], sessions: [:])
        await vm.loadExistingMetadata()

        XCTAssertTrue(vm.mixedFields.contains(.keywords),
                      "Keywords should be mixed when assets differ")
        XCTAssertNil(vm.commonKeywords,
                     "commonKeywords must be nil when keywords are mixed")
    }

    // MARK: - Store preserves metadata on a model-only write

    func testModelOnlyWritePreservesExistingMetadata() async throws {
        var m = XmpMetadata(); m.city = "Paris"; m.creator = "Ansel"
        let (asset, _) = try await tempAsset(metadata: m)
        let rawURL = try XCTUnwrap(asset.primaryURL)

        // A later model/culling-only write (e.g. a slider edit through a fresh
        // EditSession store) must NOT drop the batch-authored metadata block.
        let later = XMPSidecarStore(rawURL: rawURL)
        await later.update(model: .default, culling: CullingState())
        await later.flush()

        let sidecarURL = await later.url
        let parsed = XMPParser.parseMetadata(try String(contentsOf: sidecarURL, encoding: .utf8))
        XCTAssertEqual(parsed.city, "Paris", "model-only write must preserve existing metadata")
        XCTAssertEqual(parsed.creator, "Ansel", "model-only write must preserve existing metadata")
    }
}
