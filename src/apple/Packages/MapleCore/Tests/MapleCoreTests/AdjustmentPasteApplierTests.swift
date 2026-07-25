// AdjustmentPasteApplierTests.swift — sidecar round-trip tests for
// AdjustmentPasteApplier (#944). Real XMPSidecarStore + temp directories —
// no mocks, per repo convention (XMP is the contract).

import XCTest
@testable import MapleCore

@MainActor
final class AdjustmentPasteApplierTests: XCTestCase {

    // MARK: - Helpers

    /// Write a sidecar for a temp RAW URL (default `.dng`) and return the
    /// asset ref. Mirrors `BatchMetadataViewModelTests.tempAsset`.
    private func tempAsset(
        ext: String = "dng",
        model: AdjustmentModel = .default,
        culling: CullingState = CullingState()
    ) async -> AssetRef {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension(ext)
        let store = XMPSidecarStore(rawURL: url)
        await store.update(model: model, culling: culling)
        await store.flush()
        return AssetRef(url: url)
    }

    // MARK: - Disk path: real sidecar round trip, only selected groups move

    func testApplyWritesOnlySelectedGroupsAndPreservesCulling() async throws {
        let culling = CullingState(stars: 4, flag: .pick, keywords: ["sunset", "beach"])
        let target = await tempAsset(model: .default, culling: culling)

        var source = AdjustmentModel.default
        source.exposure = 1.8     // .tone — should move
        source.vibrance = 55      // .color — must NOT move

        let written = await AdjustmentPasteApplier.apply(
            source: source, groups: [.tone], to: [target], sessions: [:]
        )
        XCTAssertEqual(written, 1)

        // Fresh store instance — the writer's in-memory cache would
        // satisfy `load()` without touching disk, so this really proves
        // the bytes landed.
        let reader = XMPSidecarStore(rawURL: target.primaryURL!)
        let (readModel, readCulling) = try await reader.load()

        XCTAssertEqual(readModel.exposure, 1.8, "Tone group field must be written")
        XCTAssertEqual(readModel.vibrance, AdjustmentModel.default.vibrance,
                        "Color group field must NOT move when only .tone is pasted")
        XCTAssertEqual(readCulling.stars, 4, "Target's stars must be preserved")
        XCTAssertEqual(readCulling.flag, .pick, "Target's flag must be preserved")
        XCTAssertEqual(readCulling.keywords, ["sunset", "beach"], "Target's keywords must be preserved")
    }

    func testApplyWithAllGroupsMovesEveryField() async throws {
        let target = await tempAsset(model: .default, culling: CullingState())

        var source = AdjustmentModel.default
        source.exposure = 2.0
        source.saturation = -20
        source.clarity = 15
        source.vignetteAmount = -25
        source.crop = Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 3)

        let written = await AdjustmentPasteApplier.apply(
            source: source, groups: Set(AdjustmentGroup.allCases), to: [target], sessions: [:]
        )
        XCTAssertEqual(written, 1)

        let reader = XMPSidecarStore(rawURL: target.primaryURL!)
        let (readModel, _) = try await reader.load()

        XCTAssertEqual(readModel.exposure, 2.0)
        XCTAssertEqual(readModel.saturation, -20)
        XCTAssertEqual(readModel.clarity, 15)
        XCTAssertEqual(readModel.vignetteAmount, -25)
        XCTAssertEqual(readModel.crop, source.crop)
    }

    func testApplySkipsVideoAssets() async throws {
        let videoTarget = await tempAsset(ext: "mov", model: .default, culling: CullingState())
        var source = AdjustmentModel.default
        source.exposure = 3.0

        let written = await AdjustmentPasteApplier.apply(
            source: source, groups: [.tone], to: [videoTarget], sessions: [:]
        )
        XCTAssertEqual(written, 0, "Video assets have no AdjustmentModel — paste must skip them")

        let reader = XMPSidecarStore(rawURL: videoTarget.primaryURL!)
        let (readModel, _) = try await reader.load()
        XCTAssertEqual(readModel.exposure, AdjustmentModel.default.exposure,
                        "A skipped video sidecar must be left untouched")
    }

    func testApplyMultipleTargetsReturnsWrittenCount() async {
        let a = await tempAsset()
        let b = await tempAsset()
        let c = await tempAsset()
        var source = AdjustmentModel.default
        source.exposure = 1.0

        let written = await AdjustmentPasteApplier.apply(
            source: source, groups: [.tone], to: [a, b, c], sessions: [:]
        )
        XCTAssertEqual(written, 3)
    }

    // MARK: - Live-session path: mutate session.model directly, groups only

    func testApplyMutatesLiveSessionModelWithinScopedGroupOnly() async {
        let asset = await tempAsset()
        var initial = AdjustmentModel.default
        initial.exposure = -1.0
        let session = EditSession(asset: asset, model: initial, culling: CullingState())

        var source = AdjustmentModel.default
        source.vibrance = 42     // .color — should move
        source.exposure = 5.0    // .tone — should NOT move (only .color requested)

        let written = await AdjustmentPasteApplier.apply(
            source: source, groups: [.color], to: [asset], sessions: [asset.id: session]
        )

        XCTAssertEqual(written, 1)
        XCTAssertEqual(session.model.vibrance, 42, "Color group must move onto the live session")
        XCTAssertEqual(session.model.exposure, -1.0, "Tone group must stay at the session's own value")
    }

    // MARK: - resolveModel

    func testResolveModelPrefersLiveSessionOverDisk() async {
        let asset = await tempAsset(model: .default)
        var sessionModel = AdjustmentModel.default
        sessionModel.exposure = 2.5
        let session = EditSession(asset: asset, model: sessionModel, culling: CullingState())

        let resolved = await AdjustmentPasteApplier.resolveModel(
            for: asset, sessions: [asset.id: session]
        )
        XCTAssertEqual(resolved.exposure, 2.5)
    }

    func testResolveModelFallsBackToDiskWhenNoLiveSession() async {
        var onDisk = AdjustmentModel.default
        onDisk.exposure = -3.5
        let asset = await tempAsset(model: onDisk)

        let resolved = await AdjustmentPasteApplier.resolveModel(for: asset, sessions: [:])
        XCTAssertEqual(resolved.exposure, -3.5)
    }
}
