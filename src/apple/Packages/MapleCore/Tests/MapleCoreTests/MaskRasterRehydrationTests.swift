// MaskRasterRehydrationTests.swift — #3366.
//
// A saved bitmap mask must still WORK after reopening. `rasterId` is a
// per-process cache handle and is never persisted, so every `.bitmap` layer
// parses back as `rasterId: 0`; unless the raster is re-registered, raw-ffi
// resolves it to weight 0 and the mask is inert — sliders do nothing, the
// scope reads nothing — while the overlay still draws the selection. The
// symptom looks exactly like a broken pipeline and is nothing of the sort.

import CoreGraphics
import XCTest

@testable import MapleCore

@MainActor
final class MaskRasterRehydrationTests: XCTestCase {
    private let digest = "0123456789abcdef"
    private let model = "apple-vision-person-instance/1"

    /// A temp folder holding the portrait fixture, a sidecar with one
    /// bitmap layer (rasterId 0, as XMP always yields), and a cached raster
    /// PNG under `.maple/masks/` covering the LEFT half of the frame.
    private func stage() async throws -> URL {
        guard let src = Bundle.module.url(forResource: "portrait-skin-test", withExtension: "png")
        else { throw XCTSkip("portrait-skin-test.png fixture missing from the test bundle") }
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mask-rehydrate-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let asset = dir.appendingPathComponent("portrait-skin-test.png")
        try FileManager.default.copyItem(at: src, to: asset)

        // The raster the sidecar's layer refers to, already in the cache.
        let masks = dir.appendingPathComponent(".maple/masks", isDirectory: true)
        let store = MaskRasterStore(directory: masks)
        let (w, h) = (64, 48)
        var bytes = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h { for x in 0..<(w / 2) { bytes[y * w + x] = 255 } }
        _ = try await store.raster(for: digest, model: model) { (w, h, bytes) }

        // What XMP hands back: the recipe, and rasterId 0.
        var persisted = AdjustmentModel.default
        persisted.localAdjustments = [
            LocalAdjustment(
                mask: .bitmap(
                    recipe: BitmapRecipe(
                        person: 0, facialSkin: true, bodySkin: true, model: model, digest: digest),
                    rasterId: 0),
                range: nil,
                adjustments: PartialAdjustments(exposure: 2.0))
        ]
        let sidecar = XMPSidecarStore(rawURL: asset)
        await sidecar.update(model: persisted, culling: CullingState())
        await sidecar.flush()
        return asset
    }

    func testLoadedBitmapMaskIsRegisteredAndCarriesWeight() async throws {
        let asset = try await stage()
        defer { try? FileManager.default.removeItem(at: asset.deletingLastPathComponent()) }

        let session = EditSession(asset: AssetRef(url: asset))
        await session.loadSidecar()

        guard case .bitmap(let recipe, let rasterId) = session.model.localAdjustments.first?.mask
        else { return XCTFail("sidecar layer did not round-trip as a bitmap mask") }
        XCTAssertEqual(recipe.digest, digest)
        XCTAssertNotEqual(rasterId, 0, "a loaded bitmap mask must be re-registered on hydration")

        // The user-visible half: the layer now WEIGHS something. Scoping the
        // scope to it reads the raster, so an unresolved id gives total 0.
        let scoped = try await EditSession.renderScopeSample(
            asset: session.asset, model: session.model, layerIndex: 0)
        XCTAssertGreaterThan(scoped.total, 0, "resolved raster must contribute weight (#3366)")
    }

    /// The negative, so the assertion above is not vacuous: the same model
    /// with the id left at 0 weighs NOTHING — which is what every reopened
    /// mask did before this fix.
    func testUnregisteredBitmapMaskWeighsNothing() async throws {
        let asset = try await stage()
        defer { try? FileManager.default.removeItem(at: asset.deletingLastPathComponent()) }

        var stale = AdjustmentModel.default
        stale.localAdjustments = [
            LocalAdjustment(
                mask: .bitmap(
                    recipe: BitmapRecipe(
                        person: 0, facialSkin: true, bodySkin: true, model: model, digest: digest),
                    rasterId: 0),
                range: nil,
                adjustments: PartialAdjustments(exposure: 2.0))
        ]
        let scoped = try await EditSession.renderScopeSample(
            asset: AssetRef(url: asset), model: stale, layerIndex: 0)
        XCTAssertEqual(scoped.total, 0, "an unresolved raster id must resolve to weight 0, not a global edit")
    }

    /// `originalModel` gets the same ids, so hydration alone never reads as
    /// a dirty edit.
    func testRehydrationDoesNotDirtyTheSession() async throws {
        let asset = try await stage()
        defer { try? FileManager.default.removeItem(at: asset.deletingLastPathComponent()) }
        let session = EditSession(asset: AssetRef(url: asset))
        await session.loadSidecar()
        XCTAssertEqual(session.model, session.originalModel)
    }
}
