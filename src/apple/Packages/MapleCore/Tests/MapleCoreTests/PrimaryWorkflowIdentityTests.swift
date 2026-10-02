import Foundation
import MapleBackup
import XCTest

@testable import MapleCore

final class PrimaryWorkflowIdentityTests: XCTestCase {
  private struct Fixture {
    let root: URL
    let raw: URL
    let sidecar: URL
    let store: any SidecarStoreProtocol
  }

  private func fixture(photoKit: Bool = false) throws -> Fixture {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    let raw = root.appendingPathComponent("photo.dng")
    try Data([1, 0, 255, 42]).write(to: raw)
    if photoKit {
      let backing = AppSupportSidecarStore(root: root.appendingPathComponent("sidecars"))
      let id = "PRIMARY-WORKFLOW/L0/001"
      let sidecar = backing.sidecarURL(phassetLocalId: id)
      try FileManager.default.createDirectory(
        at: sidecar.deletingLastPathComponent(), withIntermediateDirectories: true)
      return Fixture(
        root: root, raw: raw, sidecar: sidecar,
        store: PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing))
    }
    return Fixture(
      root: root, raw: raw, sidecar: SidecarPath.sidecarURL(for: raw),
      store: XMPSidecarStore(rawURL: raw))
  }

  private func source() -> String {
    XMPSerializer.serialize(model: .default, culling: CullingState())
  }

  private func record(id: String = "primary") -> SidecarWorkflow {
    SidecarWorkflow(
      schemaVersion: 1, variantId: id, variantName: "Study", snapshots: [], history: [])
  }

  private func invalidDocuments() throws -> [String] {
    let primary = try WorkflowSidecarCore.embed(record(), in: source())
    let named = try WorkflowSidecarCore.embed(
      record(id: UUID().uuidString.lowercased()), in: source())
    return [
      primary.replacingOccurrences(of: "<papp:SchemaVersion>1", with: "<papp:SchemaVersion>2"),
      named,
    ]
  }

  private func seed(_ xml: String, _ fixture: Fixture) throws {
    try Data(xml.utf8).write(to: fixture.sidecar, options: .atomic)
  }

  private func assertUnchanged(_ xml: String, _ fixture: Fixture) throws {
    XCTAssertEqual(try String(contentsOf: fixture.sidecar, encoding: .utf8), xml)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), Data([1, 0, 255, 42]))
  }

  func testFilesystemAndPhotoKitHydrationRejectInvalidPrimaryWithoutCachingIt() async throws {
    for photoKit in [false, true] {
      for xml in try invalidDocuments() {
        let fixture = try fixture(photoKit: photoKit)
        try seed(xml, fixture)
        do {
          _ = try await fixture.store.loadIfPresent()
          XCTFail("A primary editor must reject an unsupported or misplaced workflow")
        } catch {}
        try assertUnchanged(xml, fixture)
        var repaired = AdjustmentModel.default
        repaired.exposure = 0.75
        let valid = try WorkflowSidecarCore.embed(
          record(), in: XMPSerializer.serialize(model: repaired, culling: CullingState()))
        try seed(valid, fixture)
        let loaded = try await fixture.store.loadIfPresent()
        XCTAssertEqual(loaded?.0.exposure, 0.75, "A failed load must not cache invalid adjustments")
      }
    }
  }

  func testOrdinaryConfirmedSaveRejectsExternalIdentityChangeAfterValidLoad() async throws {
    for photoKit in [false, true] {
      for xml in try invalidDocuments() {
        let fixture = try fixture(photoKit: photoKit)
        try seed(source(), fixture)
        _ = try await fixture.store.load()
        try seed(xml, fixture)
        var edited = AdjustmentModel.default
        edited.exposure = 1.25
        do {
          try await fixture.store.writeConfirmed(model: edited, culling: CullingState())
          XCTFail(
            "An ordinary save must validate the current primary, including after a cached load")
        } catch {}
        try assertUnchanged(xml, fixture)
      }
    }
  }

  func testFailedDebouncedSaveRetainsIntentAndRetriesAfterIdentityRepair() async throws {
    for photoKit in [false, true] {
      for xml in try invalidDocuments() {
        let fixture = try fixture(photoKit: photoKit)
        try seed(xml, fixture)
        var edited = AdjustmentModel.default
        edited.exposure = 1.25
        await fixture.store.update(model: edited, culling: CullingState())
        await fixture.store.flush()
        try assertUnchanged(xml, fixture)
        try seed(WorkflowSidecarCore.embed(record(), in: source()), fixture)
        await fixture.store.flush()
        let saved = try String(contentsOf: fixture.sidecar, encoding: .utf8)
        XCTAssertEqual(try XMPParser.parse(saved).0.exposure, 1.25)
        XCTAssertEqual(try WorkflowSidecarCore.read(xmp: saved)?.variantId, "primary")
        XCTAssertEqual(try Data(contentsOf: fixture.raw), Data([1, 0, 255, 42]))
      }
    }
  }

  func testExplicitPrimaryWorkflowPublicationRejectsNamedIdentityAndKeepsPendingSave() async throws
  {
    let fixture = try fixture()
    try seed(source(), fixture)
    let store = try XCTUnwrap(fixture.store as? XMPSidecarStore)
    var edited = AdjustmentModel.default
    edited.exposure = 1.25
    await store.update(model: edited, culling: CullingState())
    do {
      try await store.writeWorkflowConfirmed(record(id: UUID().uuidString.lowercased()))
      XCTFail("A primary writer must never publish a named identity")
    } catch {}
    try assertUnchanged(source(), fixture)
    await store.flush()
    XCTAssertEqual(
      try XMPParser.parse(String(contentsOf: fixture.sidecar, encoding: .utf8)).0.exposure, 1.25)
  }

  func testPrimaryHistoryReadRejectsMisplacedNamedIdentity() async throws {
    let fixture = try fixture()
    let misplaced = try WorkflowSidecarCore.embed(
      record(id: UUID().uuidString.lowercased()), in: source())
    try seed(misplaced, fixture)
    let store = try XCTUnwrap(fixture.store as? XMPSidecarStore)
    do {
      _ = try await store.readWorkflow()
      XCTFail("Primary history must not expose a different branch as the current treatment")
    } catch {}
    try assertUnchanged(misplaced, fixture)
  }
}
