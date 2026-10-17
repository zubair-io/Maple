import Foundation
import XCTest

@testable import MapleCore

/// #4705: byte-identical RAWs at `/photo.dng` and `/Backup/photo.dng` share a
/// content id. Every mutation must address the listed file, never the id.
@MainActor
final class SMBDuplicateContentMutationTests: EditorTestCase {
  func testBrowsedCopyEditsRenamesMovesAndTrashesWithoutTouchingItsTwin() async throws {
    let fixture = try await openDuplicatePair()
    let twin = try snapshot(fixture.share, only: ["photo.dng", "photo.xmp"])
    XCTAssertEqual(twin.count, 2)
    let browse = BrowseViewModel()
    await browse.loadSource(fixture.source)
    let copies = browse.assets.filter { $0.displayName == "photo.dng" }
    XCTAssertEqual(copies.count, 2)
    XCTAssertEqual(Set(copies.map(\.stableID)).count, 1, "Identical copies share content identity")
    let backup = try XCTUnwrap(copies.first { $0.smbPath?.contains("Backup/") == true })
    let backupDir = fixture.share.appendingPathComponent("Backup", isDirectory: true)

    let store = SMBSidecarStore(source: fixture.source, ref: try XCTUnwrap(backup.smbMutationRef))
    let loaded = try await store.load()
    let loadedXML = try await store.readWorkflowXML()
    XCTAssertEqual(XMPParser.parseMetadata(try XCTUnwrap(loadedXML)).caption, "Caption B")
    var model = loaded.0
    model.exposure = 1.5
    try await store.writeConfirmed(model: model, culling: loaded.1)
    let edited = try String(
      contentsOf: backupDir.appendingPathComponent("photo.xmp"), encoding: .utf8)
    XCTAssertEqual(try XMPParser.parse(edited).0.exposure, 1.5)
    XCTAssertEqual(try snapshot(fixture.share, only: Array(twin.keys)), twin, "edit")

    let renamedPath = try await fixture.source.renameAsset(
      try XCTUnwrap(backup.smbMutationRef), to: "inline.dng")
    let renamed = try backup.renamedSMB(to: "inline.dng", at: renamedPath, source: fixture.source)
    XCTAssertTrue(exists(backupDir, "inline.dng"))
    XCTAssertTrue(exists(backupDir, "inline.xmp"))
    XCTAssertEqual(try snapshot(fixture.share, only: Array(twin.keys)), twin, "rename")

    let batch = BatchRenameViewModel(assets: [renamed], routing: .smb, smbSource: fixture.source)
    batch.template = "batch.{ext}"
    await batch.apply()
    XCTAssertEqual(batch.applyResults?.map(\.outcome), [.renamed(newFilename: "batch.dng")])
    XCTAssertTrue(exists(backupDir, "batch.dng"))
    XCTAssertEqual(try snapshot(fixture.share, only: Array(twin.keys)), twin, "batch rename")

    let moveRef = try XCTUnwrap(renamed.smbMutationRef)
    _ = try await fixture.source.relocateAsset(moveRef, to: "/", mode: .move, collision: .fail)
    XCTAssertFalse(exists(backupDir, "batch.dng"))
    XCTAssertTrue(exists(fixture.share, "batch.dng"))
    XCTAssertEqual(try snapshot(fixture.share, only: Array(twin.keys)), twin, "move")

    _ = try await fixture.source.trashAsset(moveRef)
    XCTAssertFalse(exists(fixture.share, "batch.dng"))
    XCTAssertFalse(exists(fixture.share, "batch.xmp"))
    XCTAssertEqual(try snapshot(fixture.share, only: Array(twin.keys)), twin, "trash")
  }

  func testLocationlessReferenceToDuplicatedContentRefusesEveryMutation() async throws {
    let fixture = try await openDuplicatePair()
    let before = try snapshot(fixture.share)
    let listed = try await fixture.source.images()
    let id = try XCTUnwrap(listed.first { $0.displayName == "photo.dng" }).id
    let legacy = ImageRef(id: id, displayName: "photo.dng")
    var model = AdjustmentModel.default
    model.exposure = 2

    try await assertRefused("writeXMP") {
      try await fixture.source.writeXMP(
        Sidecar(model: model, culling: CullingState()), for: legacy)
    }
    try await assertRefused("sidecar store") {
      try await SMBSidecarStore(source: fixture.source, ref: legacy)
        .writeConfirmed(model: model, culling: CullingState())
    }
    try await assertRefused("rename") {
      _ = try await fixture.source.renameAsset(legacy, to: "renamed.dng")
    }
    try await assertRefused("move") {
      _ = try await fixture.source.relocateAsset(
        legacy, to: "/Backup", mode: .move, collision: .autoSuffix)
    }
    try await assertRefused("trash") { _ = try await fixture.source.trashAsset(legacy) }
    XCTAssertEqual(try snapshot(fixture.share), before)

    let bytes = try await fixture.source.rawBytes(for: legacy)
    XCTAssertEqual(bytes, fixture.original, "Decoding keeps the content-id fallback (#4085)")
  }

  private func openDuplicatePair() async throws -> OwnedSMBWorkflowFixture {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let backupDir = fixture.share.appendingPathComponent("Backup", isDirectory: true)
    try FileManager.default.createDirectory(at: backupDir, withIntermediateDirectories: true)
    let copy = backupDir.appendingPathComponent("photo.dng")
    try fixture.original.write(to: copy)
    try Data(NativeWorkflowControlFixture.input(tag: "B").utf8)
      .write(to: SidecarPath.sidecarURL(for: copy))
    await fixture.source.disconnect()
    try await fixture.source.connect(credentials: fixture.credentials)
    return fixture
  }

  private func assertRefused(_ label: String, _ mutation: () async throws -> Void) async throws {
    do {
      try await mutation()
      XCTFail("\(label) mutated a copy chosen by content id alone")
    } catch SMBError.ambiguousLocation(let name) {
      XCTAssertEqual(name, "photo.dng", label)
    }
  }

  /// Share-relative path -> bytes, excluding Maple's own `.maple` caches.
  private func snapshot(_ share: URL, only: [String]? = nil) throws -> [String: Data] {
    let paths = try only ?? FileManager.default.subpathsOfDirectory(atPath: share.path)
    return try paths.filter { !$0.hasPrefix(".maple") }
      .reduce(into: [:]) { result, relative in
        let url = share.appendingPathComponent(relative)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
          !isDirectory.boolValue
        else { return }
        result[relative] = try Data(contentsOf: url)
      }
  }

  private func exists(_ directory: URL, _ name: String) -> Bool {
    FileManager.default.fileExists(atPath: directory.appendingPathComponent(name).path)
  }
}
