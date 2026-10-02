import Foundation
import XCTest

@testable import MapleCore

final class WorkflowSidecarTests: XCTestCase {
  private func record() throws -> SidecarWorkflow {
    try JSONDecoder().decode(
      [SidecarWorkflow].self,
      from: Data(
        contentsOf: WorkflowFixture.root().appendingPathComponent("workflow/contract-v1.json")))[1]
  }
  private func xml() throws -> String {
    try String(
      contentsOf: WorkflowFixture.root().appendingPathComponent(
        "local-adjustments/lightroom-group-add.xmp"),
      encoding: .utf8)
  }
  func testForeignPartialAndCompleteWhiteBalanceIsUnchangedByWorkflowNamespace() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let original = dir.appendingPathComponent("photo.dng")
    let sidecar = dir.appendingPathComponent("photo.xmp")
    try Data([1, 0, 255, 42]).write(to: original)
    for attrs in [
      #"crs:Temperature="5100""#, #"crs:Tint="-7""#, #"crs:Temperature="5100" crs:Tint="-7""#,
    ] {
      let source =
        #"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" "#
        + attrs + #"/></rdf:RDF></x:xmpmeta>"#
      let before = try XMPParser.parse(source).0
      XCTAssertEqual(before.wbScaleVersion, 5)
      let embedded = try WorkflowSidecarCore.embed(record(), in: source)
      try Data(embedded.utf8).write(to: sidecar, options: .atomic)
      let reopened = try String(contentsOf: sidecar, encoding: .utf8)
      XCTAssertEqual(try XMPParser.parse(reopened).0, before)
      XCTAssertEqual(try WorkflowSidecarCore.read(xmp: reopened), try record())
    }
    XCTAssertEqual(try Data(contentsOf: original), Data([1, 0, 255, 42]))
  }
  func testSemanticCommitSnapshotRestoreAndRejectionUseRealSidecars() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let original = dir.appendingPathComponent("photo.dng")
    let sidecar = dir.appendingPathComponent("photo.xmp")
    try Data([1, 0, 255, 42]).write(to: original)
    func entry(_ xml: String, _ action: String = "adjustment") throws -> WorkflowHistoryEntry {
      WorkflowHistoryEntry(
        id: UUID().uuidString.lowercased(), createdAtMs: 1, action: action,
        label: "Committed exposure", adjustmentXmp: try WorkflowSidecarCore.checkpoint(xmp: xml))
    }
    let source = try xml()
    let first = try WorkflowSidecarCore.commit(entry(source), in: source)
    let captured = try WorkflowSidecarCore.checkpoint(xmp: first)
    let snapshot = WorkflowSnapshot(
      id: UUID().uuidString.lowercased(), name: "Warm study 🌅",
      createdAtMs: 1, adjustmentXmp: captured)
    let saved = try WorkflowSidecarCore.snapshot(snapshot, in: first)
    let edited = saved.replacingOccurrences(
      of: "crs:ProcessVersion=\"15.4\"",
      with: "crs:ProcessVersion=\"15.4\" crs:Exposure2012=\"1.25\"")
    let next = try WorkflowSidecarCore.commit(entry(edited), in: edited)
    try Data(next.utf8).write(to: sidecar, options: .atomic)
    let reopened = try String(contentsOf: sidecar, encoding: .utf8)
    let restore = try entry(captured, "snapshot-restore")
    let restored = try WorkflowSidecarCore.restore(restore, in: reopened)
    let record = try XCTUnwrap(WorkflowSidecarCore.read(xmp: restored))
    XCTAssertEqual(record.snapshots, [snapshot])
    XCTAssertEqual(record.history.last, restore)
    XCTAssertEqual(try WorkflowSidecarCore.checkpoint(xmp: restored), captured)
    XCTAssertEqual(try XMPParser.parse(restored).0, try XMPParser.parse(saved).0)
    XCTAssertThrowsError(try WorkflowSidecarCore.commit(entry(saved), in: edited))
    XCTAssertThrowsError(try WorkflowSidecarCore.snapshot(snapshot, in: saved))
    XCTAssertThrowsError(
      try WorkflowSidecarCore.restore(entry(edited, "snapshot-restore"), in: next))
    let future = next.replacingOccurrences(
      of: "<papp:SchemaVersion>1", with: "<papp:SchemaVersion>2")
    XCTAssertThrowsError(try WorkflowSidecarCore.commit(entry(edited), in: future))
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), next)
    XCTAssertEqual(try Data(contentsOf: original), Data([1, 0, 255, 42]))
  }
  func testConfirmedVariantActionsPersistAndRejectStaleOrForgedCheckpoints() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let raw = dir.appendingPathComponent("photo.dng")
    let original = Data([1, 0, 255, 42])
    try original.write(to: raw)
    let source = try xml()
    let primary = SidecarPath.sidecarURL(for: raw)
    try Data(source.utf8).write(to: primary)
    let store = WorkflowVariantStore(rawURL: raw)
    let branch = SidecarWorkflow(
      schemaVersion: 1, variantId: UUID().uuidString.lowercased(), variantName: "Alternate",
      snapshots: [], history: [])
    let destination = try await store.create(branch)
    let initial = try String(contentsOf: destination, encoding: .utf8)
    let checkpoint = try WorkflowSidecarCore.checkpoint(xmp: initial)
    let first = WorkflowHistoryEntry(
      id: UUID().uuidString.lowercased(), createdAtMs: 1, action: "adjustment", label: "Exposure",
      adjustmentXmp: checkpoint)
    let committed = try await store.commit(
      variantId: branch.variantId, expectedXmp: initial, xmp: initial, entry: first)
    let snapshot = WorkflowSnapshot(
      id: UUID().uuidString.lowercased(), name: "Before", createdAtMs: 2, adjustmentXmp: checkpoint)
    let snapped = try await store.saveSnapshot(
      variantId: branch.variantId, expectedXmp: committed, snapshot: snapshot)
    let changed = checkpoint.replacingOccurrences(
      of: "crs:ProcessVersion=\"15.4\"",
      with: "crs:ProcessVersion=\"15.4\" crs:Exposure2012=\"1.25\"")
    XCTAssertNotEqual(changed, checkpoint)
    let second = WorkflowHistoryEntry(
      id: UUID().uuidString.lowercased(), createdAtMs: 3, action: "adjustment", label: "Exposure",
      adjustmentXmp: changed)
    let latest = try await store.commit(
      variantId: branch.variantId, expectedXmp: snapped, xmp: changed, entry: second)
    let reopened = WorkflowVariantStore(rawURL: raw)
    let restore = WorkflowHistoryEntry(
      id: UUID().uuidString.lowercased(), createdAtMs: 4, action: "snapshot-restore",
      label: "Restore Before", adjustmentXmp: checkpoint)
    let restored = try await reopened.restore(
      variantId: branch.variantId, expectedXmp: latest, entry: restore)
    XCTAssertEqual(try WorkflowSidecarCore.checkpoint(xmp: restored), checkpoint)
    XCTAssertEqual(try WorkflowSidecarCore.read(xmp: restored)?.snapshots, [snapshot])
    XCTAssertEqual(try WorkflowSidecarCore.read(xmp: restored)?.history, [first, second, restore])
    XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), restored)
    do {
      _ = try await reopened.commit(
        variantId: branch.variantId, expectedXmp: latest, xmp: changed, entry: second)
      XCTFail("stale state published")
    } catch { XCTAssertTrue(error.localizedDescription.contains("changed")) }
    let forged = WorkflowHistoryEntry(
      id: UUID().uuidString.lowercased(), createdAtMs: 5, action: "snapshot-restore",
      label: "Forged", adjustmentXmp: checkpoint.replacingOccurrences(of: "15.4", with: "16.0"))
    do {
      _ = try await reopened.restore(
        variantId: branch.variantId, expectedXmp: restored, entry: forged)
      XCTFail("forged restore published")
    } catch {}
    XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), restored)
    XCTAssertEqual(try String(contentsOf: primary, encoding: .utf8), source)
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }

  func testExistingConfirmedWritesCoordinateAcrossStoreInstances() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let raw = dir.appendingPathComponent("photo.dng")
    let source = try xml()
    try Data([1, 0, 255, 42]).write(to: raw)
    try Data(source.utf8).write(to: SidecarPath.sidecarURL(for: raw))
    let wins = await withTaskGroup(of: Bool.self, returning: [Bool].self) { group in
      for _ in 0..<8 {
        group.addTask {
          do {
            let entry = WorkflowHistoryEntry(
              id: UUID().uuidString.lowercased(), createdAtMs: 1, action: "adjustment",
              label: "Exposure", adjustmentXmp: source)
            _ = try await WorkflowVariantStore(rawURL: raw).commit(
              variantId: "primary", expectedXmp: source, xmp: source, entry: entry)
            return true
          } catch { return false }
        }
      }
      var results: [Bool] = []
      for await result in group { results.append(result) }
      return results
    }
    XCTAssertEqual(wins.filter { $0 }.count, 1)
    let saved = try String(contentsOf: SidecarPath.sidecarURL(for: raw), encoding: .utf8)
    XCTAssertEqual(try WorkflowSidecarCore.read(xmp: saved)?.history.count, 1)
  }

  func testConfirmedPrimaryAbsenceHasOneExclusiveWinnerAcrossStoreInstances() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let raw = dir.appendingPathComponent("photo.dng")
    try Data([1, 0, 255, 42]).write(to: raw)
    let source = try xml()
    let wins = await withTaskGroup(of: Bool.self, returning: [Bool].self) { group in
      for _ in 0..<8 {
        group.addTask {
          do {
            let entry = WorkflowHistoryEntry(
              id: UUID().uuidString.lowercased(), createdAtMs: 1, action: "adjustment",
              label: "First edit", adjustmentXmp: source)
            _ = try await WorkflowVariantStore(rawURL: raw).commit(
              variantId: "primary", expectedXmp: nil, xmp: source, entry: entry)
            return true
          } catch { return false }
        }
      }
      var results: [Bool] = []
      for await result in group { results.append(result) }
      return results
    }
    XCTAssertEqual(wins.filter { $0 }.count, 1)
    let saved = try String(contentsOf: SidecarPath.sidecarURL(for: raw), encoding: .utf8)
    XCTAssertEqual(try WorkflowSidecarCore.read(xmp: saved)?.history.count, 1)
    XCTAssertEqual(try Data(contentsOf: raw), Data([1, 0, 255, 42]))
  }

  func testSharedSiblingPathsAndCapturedCheckpointsSurviveRealFiles() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let record = try record()
    let raw = dir.appendingPathComponent("photo.MOV")
    let original = Data([1, 0, 255, 42])
    try original.write(to: raw)
    XCTAssertEqual(
      try SidecarPath.variantURL(for: raw, variantId: "primary"), SidecarPath.sidecarURL(for: raw))
    let sibling = try SidecarPath.variantURL(for: raw, variantId: record.variantId)
    XCTAssertEqual(sibling.lastPathComponent, "photo.MOV.v\(record.variantId).xmp")
    XCTAssertThrowsError(try SidecarPath.variantURL(for: raw, variantId: "../primary"))
    let embedded = try WorkflowSidecarCore.embed(record, in: xml())
    let checkpoint = try WorkflowSidecarCore.checkpoint(xmp: embedded)
    XCTAssertNil(try WorkflowSidecarCore.read(xmp: checkpoint))
    XCTAssertTrue(checkpoint.contains("<crs:MaskGroupBasedCorrections>"))
    let before = try XMPParser.parse(embedded).0
    let after = try XMPParser.parse(checkpoint).0
    XCTAssertEqual(before, after)
    try Data(checkpoint.utf8).write(to: sibling, options: .atomic)
    XCTAssertEqual(try String(contentsOf: sibling, encoding: .utf8), checkpoint)
    let future = embedded.replacingOccurrences(
      of: "<papp:SchemaVersion>1", with: "<papp:SchemaVersion>2")
    XCTAssertThrowsError(try WorkflowSidecarCore.checkpoint(xmp: future))
    XCTAssertEqual(try Data(contentsOf: sibling), Data(checkpoint.utf8))
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }
  func testRustValidationAndEmbeddingPreserveCompleteAuthoredCheckpoints() throws {
    let workflow = try record()
    let input = try xml()
    try WorkflowSidecarCore.validate(workflow)
    XCTAssertNil(try WorkflowSidecarCore.read(xmp: input))
    let output = try WorkflowSidecarCore.embed(workflow, in: input)
    XCTAssertEqual(try WorkflowSidecarCore.read(xmp: output), workflow)
    XCTAssertEqual(try WorkflowSidecarCore.embed(workflow, in: output), output)
    XCTAssertTrue(output.contains("<crs:MaskGroupBasedCorrections>"))
  }
  func testActorPublishesWorkflowAndPendingAdjustmentsThenReopensRealSidecar() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let original = dir.appendingPathComponent("photo.dng")
    let sidecar = dir.appendingPathComponent("photo.xmp")
    let bytes = Data([1, 2, 0, 255])
    try bytes.write(to: original)
    try Data(try xml().utf8).write(to: sidecar)
    let store = XMPSidecarStore(rawURL: original)
    var model = try await store.load().0
    model.exposure = 1.25
    await store.update(model: model, culling: CullingState())
    let workflow = try record()
    try await store.writeWorkflowConfirmed(workflow)
    let reopened = XMPSidecarStore(rawURL: original)
    let loaded = try await reopened.readWorkflow()
    XCTAssertEqual(loaded, workflow)
    let persistedModel = try await reopened.load().0
    XCTAssertEqual(persistedModel.exposure, 1.25)
    model.exposure = 2.0
    try await reopened.writeConfirmed(model: model, culling: CullingState())
    let retained = try await XMPSidecarStore(rawURL: original).readWorkflow()
    XCTAssertEqual(retained, workflow)
    XCTAssertEqual(try Data(contentsOf: original), bytes)
  }
  func testUnsupportedExistingWorkflowRejectsBothWritersWithoutChangingDisk() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let original = dir.appendingPathComponent("photo.dng")
    let sidecar = dir.appendingPathComponent("photo.xmp")
    try Data([42]).write(to: original)
    let workflow = try record()
    let future = try WorkflowSidecarCore.embed(workflow, in: xml())
      .replacingOccurrences(of: "<papp:SchemaVersion>1", with: "<papp:SchemaVersion>2")
    try Data(future.utf8).write(to: sidecar)
    let store = XMPSidecarStore(rawURL: original)
    do {
      try await store.writeWorkflowConfirmed(workflow)
      XCTFail("future record replaced")
    } catch {}
    do {
      try await store.writeConfirmed(model: .default, culling: CullingState())
      XCTFail("future record overwritten")
    } catch {}
    XCTAssertEqual(try Data(contentsOf: sidecar), Data(future.utf8))
    XCTAssertEqual(try Data(contentsOf: original), Data([42]))
  }
  func testSiblingStorageCreatesIndependentBranchesAndRejectsMissingOrCollidingIdentities()
    async throws
  {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let raw = dir.appendingPathComponent("photo.dng")
    let primary = SidecarPath.sidecarURL(for: raw)
    let original = Data([1, 0, 255, 42])
    let source = try xml()
    try original.write(to: raw)
    try Data(source.utf8).write(to: primary)
    let store = WorkflowVariantStore(rawURL: raw)
    let first = try record()
    let firstURL = try await store.create(first)
    let edited = source.replacingOccurrences(
      of: "crs:ProcessVersion=\"15.4\"",
      with: "crs:ProcessVersion=\"15.4\" crs:Exposure2012=\"1.25\"")
    try await store.write(variantId: first.variantId, xmp: edited)
    let firstRead = try await store.read(variantId: first.variantId)
    let firstXML = try XCTUnwrap(firstRead)
    XCTAssertEqual(try WorkflowSidecarCore.read(xmp: firstXML), first)
    XCTAssertEqual(try XMPParser.parse(firstXML).0.exposure, 1.25)
    let second = SidecarWorkflow(
      schemaVersion: first.schemaVersion, variantId: UUID().uuidString.lowercased(),
      variantName: "Alternate", snapshots: [], history: [])
    _ = try await store.create(second, sourceVariantId: first.variantId)
    let secondRead = try await store.read(variantId: second.variantId)
    let secondXML = try XCTUnwrap(secondRead)
    XCTAssertEqual(try XMPParser.parse(secondXML).0.exposure, 1.25)
    XCTAssertEqual(try WorkflowSidecarCore.read(xmp: secondXML), second)
    let listed = try await WorkflowVariantStore(rawURL: raw).list()
    XCTAssertEqual(
      Set(listed.map(\.variantId)), Set(["primary", first.variantId, second.variantId]))
    XCTAssertTrue(listed.allSatisfy(\.exists))
    do {
      _ = try await WorkflowVariantStore(rawURL: raw).create(first)
      XCTFail("collision overwritten")
    } catch {}
    let missing = UUID().uuidString.lowercased()
    do {
      _ = try await store.read(variantId: missing)
      XCTFail("missing variant fell back")
    } catch { XCTAssertTrue(error.localizedDescription.contains("missing")) }
    do {
      try await store.write(variantId: missing, xmp: edited)
      XCTFail("missing variant recreated")
    } catch {}
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: try SidecarPath.variantURL(for: raw, variantId: missing).path))
    XCTAssertEqual(try String(contentsOf: firstURL, encoding: .utf8), firstXML)
    XCTAssertEqual(try String(contentsOf: primary, encoding: .utf8), source)
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }

  func testSiblingStorageRefusesFutureMetadataAndMismatchedIdentityWithoutPublishing() async throws
  {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let raw = dir.appendingPathComponent("photo.dng")
    try Data([42]).write(to: raw)
    let store = WorkflowVariantStore(rawURL: raw)
    let absent = try await store.read(variantId: "primary")
    XCTAssertNil(absent)
    let first = try record()
    do {
      _ = try await store.create(first)
      XCTFail("uncommitted source silently invented")
    } catch {}
    try await store.write(variantId: "primary", xmp: xml())
    let destination = try await store.create(first)
    let saved = try String(contentsOf: destination, encoding: .utf8)
    let future = saved.replacingOccurrences(
      of: "<papp:SchemaVersion>1", with: "<papp:SchemaVersion>2")
    try Data(future.utf8).write(to: destination)
    do {
      try await store.write(variantId: first.variantId, xmp: xml())
      XCTFail("future overwritten")
    } catch {}
    do {
      _ = try await store.list()
      XCTFail("future silently omitted")
    } catch {}
    XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), future)
    let mismatch = saved.replacingOccurrences(
      of: first.variantId, with: UUID().uuidString.lowercased())
    try Data(mismatch.utf8).write(to: destination)
    do {
      _ = try await store.read(variantId: first.variantId)
      XCTFail("identity mismatch accepted")
    } catch {}
    XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), mismatch)
    XCTAssertEqual(try Data(contentsOf: raw), Data([42]))
  }

}
