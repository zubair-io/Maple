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

import MapleBackup
import XCTest

@testable import MapleCore

@MainActor
final class EditSessionPhotoKitSidecarTests: XCTestCase {

  private func freshBacking() throws -> (AppSupportSidecarStore, URL) {
    let tmpRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent(
        "editsession-photokit-sidecar-test-\(UUID().uuidString)", isDirectory: true)
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

  func testSemanticGesturesUndoRedoAndReopenUseRealAppSupportFiles() async throws {
    let (backing, root) = try freshBacking()
    defer { try? FileManager.default.removeItem(at: root) }
    let id = "PH-HISTORY/L0/001"
    let opaque =
      #"<vendor:Audit xmlns:vendor="urn:maple:opaque" z="one" a="two"><vendor:History> unchanged &amp; ordered </vendor:History></vendor:Audit>"#
    let source = XMPSerializer.serialize(
      model: .default, culling: CullingState(),
      passthrough: XMPPassthrough(unknownNodes: [opaque]))
    try backing.write(phassetLocalId: id, xmp: source)
    let store = PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing)
    let session = EditSession(asset: photoKitAssetRef(stableID: id), remoteSidecarStore: store)
    await session.loadSidecar()
    for value in [0.5, 1.25, 1.75] {
      session.beginEdit(description: "Exposure")
      session.model.exposure = value - 0.1
      session.model.exposure = value
      session.endEdit()
    }
    session.undo()
    session.redo()
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.sidecarError)
    let xml = try XCTUnwrap(backing.read(phassetLocalId: id))
    let history = try XCTUnwrap(WorkflowSidecarCore.read(xmp: xml))
    XCTAssertEqual(
      history.history.map(\.action), ["adjustment", "adjustment", "adjustment", "undo", "redo"])
    XCTAssertEqual(
      try history.history.map { try XMPParser.parse($0.adjustmentXmp).0.exposure },
      [0.5, 1.25, 1.75, 1.25, 1.75])
    for checkpoint in history.history {
      XCTAssertTrue(checkpoint.adjustmentXmp.contains(opaque))
      XCTAssertNil(try WorkflowSidecarCore.read(xmp: checkpoint.adjustmentXmp))
    }
    let freshStore = PhotoKitSidecarStore(
      phassetLocalId: id, sidecars: AppSupportSidecarStore(root: root))
    let reopened = EditSession(
      asset: photoKitAssetRef(stableID: id), remoteSidecarStore: freshStore)
    await reopened.loadSidecar()
    XCTAssertEqual(reopened.model.exposure, 1.75)
    XCTAssertEqual(
      try WorkflowSidecarCore.read(xmp: XCTUnwrap(backing.read(phassetLocalId: id))), history)
    XCTAssertEqual(
      backing.sidecarURL(phassetLocalId: id).lastPathComponent, "PH-HISTORY_L0_001.xmp")
  }

  func testSemanticPublicationFailureRetainsExactCheckpointForFlushRetry() async throws {
    let (backing, root) = try freshBacking()
    defer { try? FileManager.default.removeItem(at: root) }
    let id = "PH-RETRY/L0/001"
    let original = XMPSerializer.serialize(model: .default, culling: CullingState())
    try backing.write(phassetLocalId: id, xmp: original)
    let obstruction = root.appendingPathComponent(".PH-RETRY_L0_001.xmp.tmp")
    try FileManager.default.createDirectory(at: obstruction, withIntermediateDirectories: true)
    let store = PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing)
    var model = AdjustmentModel.default
    model.exposure = 1.25
    do {
      try await store.commitSemantic(
        model: model, culling: CullingState(), action: "preset", label: "Warm study")
      XCTFail("The actual obstructed file must reject publication")
    } catch {}
    XCTAssertEqual(try backing.read(phassetLocalId: id), original)
    model.exposure = 2.25
    await store.update(model: model, culling: CullingState())
    try FileManager.default.removeItem(at: obstruction)
    await store.flush()
    let xml = try XCTUnwrap(backing.read(phassetLocalId: id))
    let record = try XCTUnwrap(WorkflowSidecarCore.read(xmp: xml))
    XCTAssertEqual(record.history.count, 1)
    XCTAssertEqual(record.history[0].action, "preset")
    XCTAssertEqual(try XMPParser.parse(record.history[0].adjustmentXmp).0.exposure, 1.25)
    XCTAssertEqual(try XMPParser.parse(xml).0.exposure, 2.25)
    await store.flush()
    XCTAssertEqual(try backing.read(phassetLocalId: id), xml)
  }

  func testPreviewAndNoopDoNotCreateHistoryAndInvalidUtf8RemainsAnError() async throws {
    let (backing, root) = try freshBacking()
    defer { try? FileManager.default.removeItem(at: root) }
    let id = "PH-PREVIEW/L0/001"
    let store = PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing)
    let session = EditSession(asset: photoKitAssetRef(stableID: id), remoteSidecarStore: store)
    session.model.exposure = 0.5
    session.beginEdit()
    session.endEdit()
    await session.flushPendingSidecarWrite()
    let xml = try XCTUnwrap(backing.read(phassetLocalId: id))
    XCTAssertNil(try WorkflowSidecarCore.read(xmp: xml))
    let invalidId = "PH-INVALID/L0/001"
    try Data([0xff, 0xfe]).write(to: backing.sidecarURL(phassetLocalId: invalidId))
    let invalid = PhotoKitSidecarStore(phassetLocalId: invalidId, sidecars: backing)
    do {
      _ = try await invalid.loadIfPresent()
      XCTFail("Invalid UTF-8 must remain a corruption error")
    } catch let error as AppSupportSidecarStoreError {
      guard case .decodeFailed = error else { return XCTFail("Unexpected corruption error") }
    }
  }

  func testPhotoKitSemanticCommitDoesNotTouchOriginalOrItsAdjacentSidecar() async throws {
    let (backing, root) = try freshBacking()
    defer { try? FileManager.default.removeItem(at: root) }
    var apple = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { apple.deleteLastPathComponent() }
    let original = root.appendingPathComponent("original.dng")
    try FileManager.default.copyItem(
      at: apple.appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng"),
      to: original)
    let originalBytes = try Data(contentsOf: original)
    let adjacent = SidecarPath.sidecarURL(for: original)
    let adjacentBytes = Data("unrelated original-file companion".utf8)
    try adjacentBytes.write(to: adjacent)
    let id = "PH-ORIGINAL/L0/001"
    let asset = AssetRef(
      displayName: "original.dng", hintExtension: "dng", stableID: id,
      thumbnailProvenance: .photoKit, bytesProvider: { try Data(contentsOf: original) })
    let session = EditSession(
      asset: asset,
      remoteSidecarStore: PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing))
    session.beginEdit(description: "Exposure")
    session.model.exposure = 1.25
    session.endEdit()
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.sidecarError)
    let persisted = try XCTUnwrap(backing.read(phassetLocalId: id))
    XCTAssertEqual(try WorkflowSidecarCore.read(xmp: persisted)?.history.count, 1)
    XCTAssertEqual(try Data(contentsOf: original), originalBytes)
    XCTAssertEqual(try Data(contentsOf: adjacent), adjacentBytes)
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
