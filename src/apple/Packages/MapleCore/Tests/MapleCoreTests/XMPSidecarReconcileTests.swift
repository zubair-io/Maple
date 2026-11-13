import Foundation
import MapleBackup
import XCTest

@testable import MapleCore

/// Concurrent writers on a real `.xmp` in a temp directory keep every edit and a record of it (#4983).
final class XMPSidecarReconcileTests: XCTestCase {
  private func fixture() throws -> (raw: URL, sidecar: URL) {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "xmp-reconcile")
    let raw = directory.appendingPathComponent("photo.jpg")
    try Data("disposable original".utf8).write(to: raw)
    return (raw, SidecarPath.sidecarURL(for: raw))
  }

  private func baseline(_ sidecar: URL) throws {
    try XMPSerializer.serialize(model: .default, culling: CullingState())
      .write(to: sidecar, atomically: true, encoding: .utf8)
  }

  private func model(_ change: (inout AdjustmentModel) -> Void) -> AdjustmentModel {
    var model = AdjustmentModel.default
    change(&model)
    return model
  }

  /// What another editor that keeps the Workflow record verbatim but no history writes.
  private func outsideEdit(_ sidecar: URL, _ change: (inout AdjustmentModel) -> Void) throws {
    let existing = try String(contentsOf: sidecar, encoding: .utf8)
    try XMPSerializer.serialize(
      model: model(change), culling: CullingState(),
      passthrough: XMPParser.parsePassthrough(existing)
    ).write(to: sidecar, atomically: true, encoding: .utf8)
  }

  private func state(_ sidecar: URL) throws -> (AdjustmentModel, [WorkflowHistoryEntry], String) {
    let text = try String(contentsOf: sidecar, encoding: .utf8)
    return (
      try XMPParser.parse(text).0, try WorkflowSidecarCore.read(xmp: text)?.history ?? [], text
    )
  }

  func testTwoWritersFromOneBaseKeepBothEntriesAndBothEdits() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    try baseline(sidecar)
    let first = XMPSidecarStore(rawURL: raw)
    let second = XMPSidecarStore(rawURL: raw)
    _ = try await first.loadIfPresent()
    _ = try await second.loadIfPresent()

    try await first.commitSemantic(
      model: model { $0.exposure = 1 }, culling: CullingState(), action: "adjustment",
      label: "Exposure")
    try await second.commitSemantic(
      model: model { $0.contrast = 20 }, culling: CullingState(), action: "adjustment",
      label: "Contrast")

    var (merged, history, text) = try state(sidecar)
    XCTAssertEqual(merged.exposure, 1, accuracy: 1e-9)
    XCTAssertEqual(merged.contrast, 20, accuracy: 1e-9)
    XCTAssertEqual(history.map(\.label), ["Exposure", "Contrast"])
    XCTAssertEqual(history.map(\.writer), ["apple", "apple"])
    XCTAssertEqual(
      history.map(\.parentId), ["", ""], "both were based on the sidecar with no history")
    XCTAssertTrue(try WorkflowSidecarCore.cursor(xmp: text).synced)

    try await first.commitSemantic(
      model: model { $0.exposure = 2 }, culling: CullingState(), action: "adjustment",
      label: "Exposure again")
    (merged, history, text) = try state(sidecar)
    XCTAssertEqual(history.count, 3)
    XCTAssertEqual(history[2].parentId, history[0].id, "a writer is based on its own last entry")
    XCTAssertEqual(merged.exposure, 2, accuracy: 1e-9)
    XCTAssertEqual(merged.contrast, 20, accuracy: 1e-9)
  }

  func testOutsideEditBeforeAGestureIsCapturedAsExternalAndMerged() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    try baseline(sidecar)
    let store = XMPSidecarStore(rawURL: raw)
    _ = try await store.loadIfPresent()
    try outsideEdit(sidecar) { $0.contrast = 30 }

    try await store.commitSemantic(
      model: model { $0.exposure = 0.5 }, culling: CullingState(), action: "adjustment",
      label: "Exposure")

    let (merged, history, text) = try state(sidecar)
    XCTAssertEqual(merged.exposure, 0.5, accuracy: 1e-9)
    XCTAssertEqual(merged.contrast, 30, accuracy: 1e-9)
    XCTAssertEqual(history.map(\.action), ["external", "adjustment"])
    XCTAssertEqual(history.map(\.writer), ["", "apple"])
    XCTAssertEqual(try XMPParser.parse(history[0].adjustmentXmp).0.contrast, 30)
    XCTAssertEqual(try XMPParser.parse(history[0].adjustmentXmp).0.exposure, 0, accuracy: 1e-9)
    XCTAssertEqual(
      try WorkflowSidecarCore.checkpoint(xmp: text), history[1].adjustmentXmp,
      "the gesture's entry holds the merged document")
    let cursor = try WorkflowSidecarCore.cursor(xmp: text)
    XCTAssertTrue(cursor.synced)
    XCTAssertEqual(cursor.undo, [history[0].id])
  }

  func testUnknownAttributesAndChildrenSurviveAStoreWriteByteForByte() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    try baseline(sidecar)
    let store = XMPSidecarStore(rawURL: raw)
    _ = try await store.loadIfPresent()
    try XMPPassthroughTests.lightroomSidecar.write(to: sidecar, atomically: true, encoding: .utf8)

    try await store.writeConfirmed(
      model: model { $0.exposure = 1.75 }, culling: CullingState(stars: 4))

    let (merged, _, text) = try state(sidecar)
    XCTAssertEqual(merged.exposure, 1.75, accuracy: 1e-9)
    let written = XMPParser.parsePassthrough(text)
    let source = XMPParser.parsePassthrough(XMPPassthroughTests.lightroomSidecar)
    XCTAssertEqual(written.unknownAttributes, source.unknownAttributes)
    XCTAssertEqual(
      written.unknownNodes.filter { !$0.contains("papp:Workflow") }, source.unknownNodes)
    for node in source.unknownNodes { XCTAssertTrue(text.contains(node), node) }
    XCTAssertEqual(written.maskGroups, source.maskGroups)
    XCTAssertEqual(
      XMPParser.parseMetadata(text), XMPParser.parseMetadata(XMPPassthroughTests.lightroomSidecar))
  }

  func testMergeIsAnnouncedAndDerivativesWaitForTheEditorToAdoptIt() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    try baseline(sidecar)
    let store = XMPSidecarStore(rawURL: raw)
    _ = try await store.loadIfPresent()
    let stream = await store.reconciliations()
    var merges = stream.makeAsyncIterator()
    try outsideEdit(sidecar) { $0.contrast = 30 }

    let written = model { $0.exposure = 0.5 }
    try await store.writeConfirmed(model: written, culling: CullingState())

    let next = await merges.next()
    let announced = try XCTUnwrap(next)
    XCTAssertEqual(announced.xml, try String(contentsOf: sidecar, encoding: .utf8))
    XCTAssertEqual(announced.model, written)
    do {
      try await store.requireObservedRevisionCurrent()
      XCTFail("A derivative rendered from the stale model must not be certified")
    } catch is CancellationError {}
    await store.confirmAdoption(of: announced.xml)
    try await store.requireObservedRevisionCurrent()
    withExtendedLifetime(stream) {}
  }

  func testStaleModelNeverRevertsAMergeBeforeItIsAdopted() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    try baseline(sidecar)
    let store = XMPSidecarStore(rawURL: raw)
    _ = try await store.loadIfPresent()
    let stream = await store.reconciliations()
    try outsideEdit(sidecar) { $0.contrast = 30 }

    try await store.writeConfirmed(model: model { $0.exposure = 0.5 }, culling: CullingState())
    try await store.writeConfirmed(model: model { $0.exposure = 0.7 }, culling: CullingState())

    let (merged, _, _) = try state(sidecar)
    XCTAssertEqual(merged.exposure, 0.7, accuracy: 1e-9)
    XCTAssertEqual(merged.contrast, 30, accuracy: 1e-9, "the stale model never reverts the merge")
    withExtendedLifetime(stream) {}
  }

  func testPhotosCanonicalSidecarMergesThroughTheSameWriter() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "photos-reconcile")
    defer { try? FileManager.default.removeItem(at: root) }
    let backing = AppSupportSidecarStore(root: root)
    let id = "ABCD1234-5678-90AB-CDEF-1234567890AB/L0/001"
    let store = PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing)
    try await store.writeConfirmed(model: .default, culling: CullingState())
    _ = try await store.loadIfPresent()
    let sidecar = backing.sidecarURL(phassetLocalId: id)
    try outsideEdit(sidecar) { $0.contrast = 30 }

    try await store.commitSemantic(
      model: model { $0.exposure = 0.5 }, culling: CullingState(), action: "adjustment",
      label: "Exposure")

    let (merged, history, _) = try state(sidecar)
    XCTAssertEqual(merged.exposure, 0.5, accuracy: 1e-9)
    XCTAssertEqual(merged.contrast, 30, accuracy: 1e-9)
    XCTAssertEqual(history.map(\.action), ["external", "adjustment"])
  }
}
