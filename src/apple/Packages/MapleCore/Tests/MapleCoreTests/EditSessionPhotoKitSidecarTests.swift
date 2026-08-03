// EditSessionPhotoKitSidecarTests.swift — regression coverage for #2555:
// edits made through EditSession on a `.photoKit`-provenance asset must
// round-trip through AppSupportSidecarStore, the same store
// BackupEngine.uploadCompanionsBestEffort reads via
// `sidecars.read(phassetLocalId:)` to prefer a real local edit over the
// synthetic Apple-metadata XMP.
//
// Before the fix, EditSession was always constructed with either no
// `remoteSidecarStore` (AppShell+PhotoKitActions.swift) or an explicit `nil`
// for `.photoKit` provenance (AppShell+FolderActions.swift's `ensureSession`)
// — a slider move or culling change never reached AppSupportSidecarStore at
// all, so BackupEngine's local-edit branch was permanently unreachable in
// production. These tests build an `EditSession` the same way those two call
// sites now do (`remoteSidecarStore: PhotoKitSidecarStore(...)`) and prove
// an edit survives the write path AND the read (hydration) path.

import XCTest
@testable import MapleCore
import MapleBackup

@MainActor
final class EditSessionPhotoKitSidecarTests: XCTestCase {

    private func freshBacking() throws -> (AppSupportSidecarStore, URL) {
        let tmpRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("editsession-photokit-sidecar-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
        return (AppSupportSidecarStore(root: tmpRoot), tmpRoot)
    }

    /// A sourceless `AssetRef` (no `primaryURL`) mirroring how
    /// `AppShell+PhotoKitActions.swift`'s `prepareLocalPhotoKitSession` and
    /// `AppShell+FolderActions.swift`'s `ensureSession` build PhotoKit
    /// `AssetRef`s — `stableID` carries the PHAsset `localIdentifier`.
    private func photoKitAssetRef(stableID: String) -> AssetRef {
        AssetRef(
            displayName: "IMG_TEST",
            hintExtension: "dng",
            stableID: stableID,
            thumbnailProvenance: .photoKit,
            bytesProvider: {
                throw NSError(domain: "test", code: -1)
            }
        )
    }

    /// Core regression test: a model edit (exposure slider) made through
    /// `EditSession.model` — exactly what a real slider drag does — must
    /// land in `AppSupportSidecarStore` once flushed.
    func testModelEditRoutesThroughPhotoKitSidecarStoreToAppSupportSidecarStore() async throws {
        let (backing, tmpRoot) = try freshBacking()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let phassetLocalId = "AAAA1111-BBBB-2222-CCCC-333344445555/L0/001"

        let store = PhotoKitSidecarStore(phassetLocalId: phassetLocalId, sidecars: backing)
        let asset = photoKitAssetRef(stableID: phassetLocalId)
        let session = EditSession(asset: asset, remoteSidecarStore: store)

        var edited = session.model
        edited.exposure = 1.75
        session.model = edited

        // `model`'s didSet spawns a detached Task calling `store.update(...)`
        // — yield so it actually runs before we flush.
        for _ in 0..<5 { await Task.yield() }
        await session.flushPendingSidecarWrite()

        let xml = try backing.read(phassetLocalId: phassetLocalId)
        let unwrapped = try XCTUnwrap(
            xml, "the slider edit never reached AppSupportSidecarStore — BackupEngine would see nil")

        let (readModel, _) = try XMPParser.parse(data: Data(unwrapped.utf8))
        XCTAssertEqual(readModel.exposure, 1.75, accuracy: 0.0001)
    }

    /// Culling edits (rating / flag) use the same wire — mirrors the local-
    /// file coverage in `EditSessionTests.testSetKeywordsRoutesThroughSidecarStore`.
    func testCullingEditRoutesThroughPhotoKitSidecarStoreToAppSupportSidecarStore() async throws {
        let (backing, tmpRoot) = try freshBacking()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let phassetLocalId = "P-CULLING/L0/001"

        let store = PhotoKitSidecarStore(phassetLocalId: phassetLocalId, sidecars: backing)
        let asset = photoKitAssetRef(stableID: phassetLocalId)
        let session = EditSession(asset: asset, remoteSidecarStore: store)

        var culling = session.culling
        culling.stars = 5
        session.culling = culling

        for _ in 0..<5 { await Task.yield() }
        await session.flushPendingSidecarWrite()

        let xml = try backing.read(phassetLocalId: phassetLocalId)
        let unwrapped = try XCTUnwrap(xml)
        let (_, readCulling) = try XMPParser.parse(data: Data(unwrapped.utf8))
        XCTAssertEqual(readCulling.stars, 5)
    }

    /// Read (hydration) path: a sidecar already sitting in
    /// `AppSupportSidecarStore` from a prior session — e.g. after a relaunch
    /// — must be loaded by `loadSidecar()` rather than silently ignored, the
    /// same as filesystem / cloud assets.
    func testLoadSidecarHydratesFromPriorAppSupportSidecarStoreWrite() async throws {
        let (backing, tmpRoot) = try freshBacking()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let phassetLocalId = "P-HYDRATE/L0/001"

        var priorModel = AdjustmentModel.default
        priorModel.temperature = 3400
        var priorCulling = CullingState()
        priorCulling.stars = 3
        let xml = XMPSerializer.serialize(model: priorModel, culling: priorCulling)
        try backing.write(phassetLocalId: phassetLocalId, xmp: xml)

        let store = PhotoKitSidecarStore(phassetLocalId: phassetLocalId, sidecars: backing)
        let asset = photoKitAssetRef(stableID: phassetLocalId)
        let session = EditSession(asset: asset, remoteSidecarStore: store)
        await session.loadSidecar()

        XCTAssertEqual(session.model.temperature, 3400, accuracy: 0.0001)
        XCTAssertEqual(session.culling.stars, 3)
    }

    /// Without a wired store (the pre-fix shape — `remoteSidecarStore: nil`
    /// for a sourceless asset), edits stay session-local and nothing is
    /// written anywhere. Kept as a control so the tests above are actually
    /// exercising the fix, not tautologically always passing.
    func testWithoutRemoteStoreEditsStaySessionLocal() async throws {
        let asset = photoKitAssetRef(stableID: "NO-STORE/L0/001")
        let session = EditSession(asset: asset)

        var edited = session.model
        edited.exposure = 1.75
        session.model = edited

        for _ in 0..<5 { await Task.yield() }
        await session.flushPendingSidecarWrite()

        // No store means no sidecarError either — just confirms no crash /
        // no attempted write path. The actual "no file exists anywhere" is
        // implicit: there is no store to point at a location to check.
        XCTAssertNil(session.sidecarError)
        XCTAssertEqual(session.model.exposure, 1.75, accuracy: 0.0001)
    }
}
