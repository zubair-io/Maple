import XCTest

@testable import MapleCore

final class LocalRemovalRelocateTests: XCTestCase {
  private func fixture(_ name: String) throws -> Data {
    let parts = name.split(separator: ".")
    let url = try XCTUnwrap(
      Bundle.module.url(
        forResource: String(parts[0]),
        withExtension: String(parts[1]), subdirectory: "removal"))
    return try Data(contentsOf: url)
  }

  private func stage() async throws -> (URL, String) {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    let raw = root.appendingPathComponent("photo.dng")
    try fixture("source.dng").write(to: raw)
    try fixture("prior.xmp").write(to: SidecarPath.sidecarURL(for: raw))
    let records = try await LocalRemovalAssetStore(rawURL: raw).publish(
      request: String(decoding: fixture("request.txt"), as: UTF8.self), prior: "[]",
      mask: fixture("mask.mimf"), patch: fixture("patch.f16"))
    try await XMPSidecarStore(rawURL: raw).writeRemovalConfirmed(
      records: records, expectedRecords: "[]", model: .default, culling: CullingState())
    return (raw, records)
  }

  func testCopyAndMoveReopenWithAllCompanionsAndRetainSharedSourceAssets() async throws {
    let (raw, records) = try await stage()
    let sourceAssets = try await LocalRemovalAssetStore(rawURL: raw).readAssets(records: records)
    let xml = try Data(contentsOf: SidecarPath.sidecarURL(for: raw))
    let copy = try await LocalFileOperations.relocate(
      raw, to: raw.deletingLastPathComponent().appendingPathComponent("copy"), mode: .copy)
    XCTAssertTrue(FileManager.default.fileExists(atPath: raw.path))
    let destination = URL(fileURLWithPath: copy.primaryPath)
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: destination)), xml)
    let reopened = try await LocalRemovalAssetStore(rawURL: destination).readAssets(
      records: records)
    XCTAssertEqual(reopened, sourceAssets)
    let move = try await LocalFileOperations.relocate(
      raw, to: raw.deletingLastPathComponent().appendingPathComponent("move"), mode: .move)
    XCTAssertFalse(FileManager.default.fileExists(atPath: raw.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: SidecarPath.sidecarURL(for: raw).path))
    let moved = try await LocalRemovalAssetStore(rawURL: URL(fileURLWithPath: move.primaryPath))
      .readAssets(records: records)
    XCTAssertEqual(moved, sourceAssets)
    let retained = try await LocalRemovalAssetStore(rawURL: raw).readAssets(records: records)
    XCTAssertEqual(retained, sourceAssets)
  }

  func testMissingCompanionCannotReplaceExistingPhotoAndSidecar() async throws {
    let (raw, records) = try await stage()
    let parent = raw.deletingLastPathComponent()
    let name = try XCTUnwrap(RemovalBridge.assetNames(records: records).first)
    try FileManager.default.removeItem(at: parent.appendingPathComponent(".maple/inpaint/" + name))
    let destination = parent.appendingPathComponent("album")
    try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
    let occupant = destination.appendingPathComponent("photo.dng")
    let prior = Data("existing photo".utf8)
    let sidecar = Data("foreign existing sidecar".utf8)
    try prior.write(to: occupant)
    try sidecar.write(to: SidecarPath.sidecarURL(for: occupant))
    do {
      _ = try await LocalFileOperations.planRelocate(
        raw, to: destination, mode: .move, collision: .replace)
      XCTFail("Missing accepted assets must refuse replacement")
    } catch RemovalError.missingCompanion {}
    XCTAssertEqual(try Data(contentsOf: occupant), prior)
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: occupant)), sidecar)
    XCTAssertEqual(try Data(contentsOf: raw), try fixture("source.dng"))
    XCTAssertFalse(
      try FileManager.default.contentsOfDirectory(atPath: destination.path).contains {
        $0.hasSuffix(".rollback")
      })
  }

  func testRevertReplacementRestoresPreviousPairAndRetainsCompanions() async throws {
    let (raw, records) = try await stage()
    let album = raw.deletingLastPathComponent().appendingPathComponent("album")
    try FileManager.default.createDirectory(at: album, withIntermediateDirectories: true)
    let occupant = album.appendingPathComponent("photo.dng")
    let priorRaw = Data("previous photo".utf8)
    let priorXMP = Data("<foreign original=\"untouched\"/>".utf8)
    try priorRaw.write(to: occupant)
    try priorXMP.write(to: SidecarPath.sidecarURL(for: occupant))
    let plan = try await LocalFileOperations.planRelocate(
      raw, to: album, mode: .move, collision: .replace)
    LocalFileOperations.revertPlan(plan)
    XCTAssertEqual(try Data(contentsOf: occupant), priorRaw)
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: occupant)), priorXMP)
    XCTAssertTrue(FileManager.default.fileExists(atPath: raw.path))
    let companions = try await LocalRemovalAssetStore(rawURL: occupant).readAssets(records: records)
    XCTAssertEqual(companions.count, 2)
    XCTAssertFalse(
      try FileManager.default.contentsOfDirectory(atPath: album.path).contains {
        $0.hasSuffix(".rollback")
      })
  }

  func testSourceSidecarChangedAfterPlanCannotBeDeletedByMove() async throws {
    let (raw, _) = try await stage()
    let plan = try await LocalFileOperations.planRelocate(
      raw, to: raw.deletingLastPathComponent().appendingPathComponent("album"), mode: .move)
    let sidecar = SidecarPath.sidecarURL(for: raw)
    var updated = try Data(contentsOf: sidecar)
    updated.append(Data("<!--new external edit-->".utf8))
    try updated.write(to: sidecar, options: .atomic)
    _ = await LocalFileOperations.finalizeRelocate(plan)
    XCTAssertEqual(try Data(contentsOf: sidecar), updated)
    XCTAssertTrue(FileManager.default.fileExists(atPath: raw.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: plan.finalPrimaryPath))
  }

  func testNewRemovalAfterOrdinarySnapshotCannotEnterCopyWithoutAssets() async throws {
    let (raw, records) = try await stage()
    let accepted = try Data(contentsOf: SidecarPath.sidecarURL(for: raw))
    let ordinary = try fixture("prior.xmp")
    try ordinary.write(to: SidecarPath.sidecarURL(for: raw))
    let plan = try await LocalFileOperations.planRelocate(
      raw, to: raw.deletingLastPathComponent().appendingPathComponent("album"), mode: .move)
    try accepted.write(to: SidecarPath.sidecarURL(for: raw), options: .atomic)
    _ = await LocalFileOperations.finalizeRelocate(plan)
    XCTAssertTrue(FileManager.default.fileExists(atPath: raw.path))
    XCTAssertEqual(
      try Data(contentsOf: URL(fileURLWithPath: try XCTUnwrap(plan.finalSidecarPath))), ordinary)
    let sourceAssets = try await LocalRemovalAssetStore(rawURL: raw).readAssets(records: records)
    XCTAssertEqual(sourceAssets.count, 2)
  }

  func testPrivateTrashAndRestoreCarryAcceptedAssets() async throws {
    let (raw, records) = try await stage()
    let root = raw.deletingLastPathComponent()
    let trash = try await LocalFileOperations.trashToMapleFolder(raw, libraryRoot: root)
    let trashed = URL(fileURLWithPath: trash.primaryPath)
    let assets = try await LocalRemovalAssetStore(rawURL: trashed).readAssets(records: records)
    XCTAssertEqual(assets.count, 2)
    let restored = try await LocalFileOperations.restoreFromMapleTrash(trashed, libraryRoot: root)
    XCTAssertEqual(restored.primaryPath, raw.path)
    let reopened = try await LocalRemovalAssetStore(rawURL: raw).readAssets(records: records)
    XCTAssertEqual(reopened, assets)
  }
  func testOSRecoveryFolderRestoresWholeAcceptedEditAndRefusesDamagedXMP() async throws {
    let (raw, records) = try await stage()
    let root = raw.deletingLastPathComponent()
    let folder = root.appendingPathComponent("os-trash-recovery-folder")
    let source = try LocalRemovalRelocation.open(rawURL: raw)
    _ = try await LocalFileOperations.prepareRemovalTrashPackage(
      source, raw: raw, directory: folder)
    let packaged = folder.appendingPathComponent(raw.lastPathComponent)
    let assets = try await LocalRemovalAssetStore(rawURL: packaged).readAssets(records: records)
    XCTAssertEqual(assets.count, 2)
    let xmlURL = SidecarPath.sidecarURL(for: packaged)
    let original = try Data(contentsOf: xmlURL)
    try Data("<lost edits/>".utf8).write(to: xmlURL, options: .atomic)
    do {
      _ = try await LocalFileOperations.restoreRemovalTrashPackage(folder, libraryRoot: root)
      XCTFail("Damaged recovery XMP must not silently restore an unedited photo")
    } catch RemovalError.invalid {}
    try original.write(to: xmlURL, options: .atomic)
    // A collision keeps both originals. Package restore uses the same verified
    // relocation contract and does not depend on Finder-specific Trash APIs.
    let restored = try await LocalFileOperations.restoreRemovalTrashPackage(
      folder, libraryRoot: root)
    XCTAssertTrue(restored.renamedDueToCollision)
    XCTAssertEqual(URL(fileURLWithPath: restored.primaryPath).lastPathComponent, "photo.1.dng")
    let reopened = try await LocalRemovalAssetStore(
      rawURL: URL(fileURLWithPath: restored.primaryPath)
    ).readAssets(records: records)
    XCTAssertEqual(reopened, assets)
    XCTAssertEqual(try Data(contentsOf: raw), try fixture("source.dng"))
  }

  func testRecoveryFolderCannotRestoreOutsideSuppliedLibraryRoot() async throws {
    let (raw, _) = try await stage()
    let root = raw.deletingLastPathComponent()
    let folder = root.appendingPathComponent("recovery")
    let source = try LocalRemovalRelocation.open(rawURL: raw)
    _ = try await LocalFileOperations.prepareRemovalTrashPackage(
      source, raw: raw, directory: folder)
    let otherRoot = root.appendingPathComponent("other-library")
    try FileManager.default.createDirectory(at: otherRoot, withIntermediateDirectories: true)
    do {
      _ = try await LocalFileOperations.restoreRemovalTrashPackage(folder, libraryRoot: otherRoot)
      XCTFail("Manifest paths cannot escape the selected library")
    } catch FileOperationError.invalidDestination {}
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: folder.appendingPathComponent("photo.dng").path))
  }

  func testSourceSnapshotLockRefusesConcurrentConfirmedWriter() async throws {
    let (raw, _) = try await stage()
    let source = try LocalRemovalRelocation.open(rawURL: raw)
    let before = try Data(contentsOf: source.sourceSidecar)
    do {
      try await XMPSidecarStore(rawURL: raw).writeConfirmed(
        model: .default, culling: CullingState())
      XCTFail("The relocation snapshot must serialize with every Maple XMP write")
    } catch RemovalError.saveConflict {}
    try source.verifySnapshot()
    XCTAssertEqual(try Data(contentsOf: source.sourceSidecar), before)
  }

  #if os(macOS)
    func testActualOSTrashAndRecoveryRetainAcceptedEdit() async throws {
      let (raw, records) = try await stage()
      let root = raw.deletingLastPathComponent()
      let trashed = try await LocalFileOperations.trash(raw, libraryRoot: root)
      let primary = URL(fileURLWithPath: trashed.primaryPath)
      let folder = primary.deletingLastPathComponent()
      let manifest = try JSONDecoder().decode(
        RemovalTrashManifest.self,
        from: Data(contentsOf: folder.appendingPathComponent("Maple Recovery.json")))
      XCTAssertEqual(manifest.originalPath, raw.path)
      // Cleanup only this test's generated recovery folder, verified by manifest.
      addTeardownBlock {
        if manifest.originalPath == raw.path {
          try? FileManager.default.removeItem(at: folder)
        }
      }
      XCTAssertFalse(FileManager.default.fileExists(atPath: raw.path))
      XCTAssertTrue(trashed.sidecarFollowed)
      let assets = try await LocalRemovalAssetStore(rawURL: primary).readAssets(records: records)
      XCTAssertEqual(assets.count, 2)
      let restored = try await LocalFileOperations.restoreRemovalTrashPackage(
        folder, libraryRoot: root)
      XCTAssertEqual(restored.primaryPath, raw.path)
      let reopened = try await LocalRemovalAssetStore(rawURL: raw).readAssets(records: records)
      XCTAssertEqual(reopened, assets)
    }
  #endif

  func testExtensionRenameKeepsSharedStemSidecarAndFinishesJournal() async throws {
    let (raw, records) = try await stage()
    let sidecar = SidecarPath.sidecarURL(for: raw)
    let before = try Data(contentsOf: sidecar)
    let outcome = try await LocalFileOperations.relocate(
      raw,
      to: raw.deletingLastPathComponent(), newBasename: "photo.nef", mode: .move)
    XCTAssertFalse(FileManager.default.fileExists(atPath: raw.path))
    XCTAssertEqual(try Data(contentsOf: sidecar), before)
    XCTAssertEqual(outcome.sidecarPath, sidecar.path)
    let target = URL(fileURLWithPath: outcome.primaryPath)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: LocalRelocationJournal.url(for: target).path))
    try RemovalBridge.verifySource(records: records, rawURL: target)
  }

}
