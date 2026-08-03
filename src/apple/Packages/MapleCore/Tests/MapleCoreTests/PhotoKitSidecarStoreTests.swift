// PhotoKitSidecarStoreTests.swift — round-trip tests for PhotoKitSidecarStore
// (#2555). Each test gets an isolated tmp directory as the
// AppSupportSidecarStore root so nothing touches the real
// ~/Library/Application Support/Maple/PhotoKitSidecars/.

import XCTest
@testable import MapleCore
import MapleBackup

final class PhotoKitSidecarStoreTests: XCTestCase {

    private func freshBacking() throws -> (AppSupportSidecarStore, URL) {
        let tmpRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("photokit-sidecar-store-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
        return (AppSupportSidecarStore(root: tmpRoot), tmpRoot)
    }

    // MARK: - Fresh asset (no sidecar written yet)

    /// A `.photoKit` asset with no prior edit must report "no sidecar" —
    /// not "sidecar with default values" — so `EditSession.loadSidecar()`
    /// seeds from as-shot WB instead of silently discarding it.
    func testLoadIfPresentReturnsNilWhenNoSidecarWritten() async throws {
        let (backing, tmpRoot) = try freshBacking()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let store = PhotoKitSidecarStore(phassetLocalId: "NEVER/WRITTEN", sidecars: backing)

        let result = try await store.loadIfPresent()
        XCTAssertNil(result)
    }

    func testLoadReturnsDefaultsWhenNoSidecarWritten() async throws {
        let (backing, tmpRoot) = try freshBacking()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let store = PhotoKitSidecarStore(phassetLocalId: "NEVER/WRITTEN", sidecars: backing)

        let (model, culling) = try await store.load()
        XCTAssertEqual(model.exposure, AdjustmentModel.default.exposure, accuracy: 0.0001)
        XCTAssertEqual(culling.stars, 0)
    }

    // MARK: - Write path (#2555 core regression coverage)

    /// The write side of #2555: `update()` + `flush()` must land real bytes
    /// in `AppSupportSidecarStore` at the `phassetLocalId` key —
    /// `BackupEngine.uploadCompanionsBestEffort` reads this exact store via
    /// `sidecars.read(phassetLocalId:)` to decide whether a local edit
    /// exists. Before this fix, nothing ever called `update()` for a
    /// PhotoKit-provenance `EditSession`, so this key was always empty.
    func testUpdateThenFlushWritesIntoAppSupportSidecarStore() async throws {
        let (backing, tmpRoot) = try freshBacking()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let phassetLocalId = "ABCD1234-5678-90AB-CDEF-1234567890AB/L0/001"
        let store = PhotoKitSidecarStore(phassetLocalId: phassetLocalId, sidecars: backing)

        var model = AdjustmentModel.default
        model.exposure = 1.5
        var culling = CullingState()
        culling.stars = 4

        await store.update(model: model, culling: culling)
        await store.flush()

        // Read through the SAME primitive BackupEngine uses — proves the
        // write is visible to the actual downstream reader, not just to
        // this store's in-memory cache.
        let xml = try backing.read(phassetLocalId: phassetLocalId)
        let unwrapped = try XCTUnwrap(
            xml, "BackupEngine's sidecars.read(phassetLocalId:) would see nil here — the edit is invisible to backup")
        XCTAssertTrue(unwrapped.contains("xmpmeta"))
    }

    /// Durability across relaunch: a FRESH store instance (no in-memory
    /// cache carried over) must read back what a prior instance wrote —
    /// this is what "the edit survived force-quit + reopen" means in
    /// practice, since `EditSession` construction builds a fresh store
    /// every time an asset is opened.
    func testFreshStoreInstanceReadsBackPriorInstancesWrite() async throws {
        let (backing, tmpRoot) = try freshBacking()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let phassetLocalId = "P2/L0/001"

        let writer = PhotoKitSidecarStore(phassetLocalId: phassetLocalId, sidecars: backing)
        var model = AdjustmentModel.default
        model.contrast = 22
        await writer.update(model: model, culling: CullingState())
        await writer.flush()

        let reader = PhotoKitSidecarStore(phassetLocalId: phassetLocalId, sidecars: backing)
        let result = try await reader.loadIfPresent()
        let unwrapped = try XCTUnwrap(result)
        XCTAssertEqual(unwrapped.0.contrast, 22, accuracy: 0.0001)
    }

    /// `update()` debounces (750ms) rather than writing synchronously —
    /// mirrors `XMPSidecarStore` / `CloudSidecarStore`. Without an explicit
    /// `flush()`, nothing should be on disk yet.
    func testUpdateAloneDoesNotWriteBeforeFlush() async throws {
        let (backing, tmpRoot) = try freshBacking()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let phassetLocalId = "P3/L0/001"
        let store = PhotoKitSidecarStore(phassetLocalId: phassetLocalId, sidecars: backing)

        await store.update(model: .default, culling: CullingState())
        // Deliberately no flush() and no sleep — the 750ms debounce task
        // should not have fired yet.
        let xml = try backing.read(phassetLocalId: phassetLocalId)
        XCTAssertNil(xml, "update() alone must not write synchronously")
    }
}
