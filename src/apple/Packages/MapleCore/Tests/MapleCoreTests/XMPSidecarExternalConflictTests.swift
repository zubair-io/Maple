import CoreImage
import Foundation
import XCTest

@testable import MapleCore

final class XMPSidecarExternalConflictTests: XCTestCase {
  private func fixture() throws -> (URL, URL) {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "external-xmp-conflict")
    let raw = directory.appendingPathComponent("photo.jpg")
    try Data("disposable original".utf8).write(to: raw)
    return (raw, SidecarPath.sidecarURL(for: raw))
  }

  private func xml(exposure: Double) -> String {
    XMPSerializer.serialize(model: AdjustmentModel(exposure: exposure), culling: CullingState())
  }

  private func xml(contrast: Double) -> String {
    var model = AdjustmentModel.default
    model.contrast = contrast
    return XMPSerializer.serialize(model: model, culling: CullingState())
  }

  private func published(_ sidecar: URL) throws -> (AdjustmentModel, [WorkflowHistoryEntry]) {
    let text = try String(contentsOf: sidecar, encoding: .utf8)
    return (
      try XMPParser.parse(text).0, try WorkflowSidecarCore.read(xmp: text)?.history ?? []
    )
  }

  func testConfirmedSaveMergesAndRecordsExternallyReplacedSidecar() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    try xml(exposure: 0).write(to: sidecar, atomically: true, encoding: .utf8)
    let store = XMPSidecarStore(rawURL: raw)
    _ = try await store.loadIfPresent()

    try xml(contrast: 30).write(to: sidecar, atomically: true, encoding: .utf8)
    try await store.writeConfirmed(model: AdjustmentModel(exposure: 0.01), culling: CullingState())

    let (model, history) = try published(sidecar)
    XCTAssertEqual(model.exposure, 0.01, accuracy: 1e-9, "the editor's change is kept")
    XCTAssertEqual(model.contrast, 30, accuracy: 1e-9, "the outside change is kept")
    XCTAssertEqual(history.map(\.action), ["external"])
    XCTAssertEqual(try XMPParser.parse(history[0].adjustmentXmp).0.contrast, 30)
    XCTAssertEqual(history[0].writer, "")
  }

  func testDebouncedSaveMergesOntoExternalBytesAndAdvancesTheObservedRevision() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    try xml(exposure: 0).write(to: sidecar, atomically: true, encoding: .utf8)
    let store = XMPSidecarStore(rawURL: raw)
    _ = try await store.loadIfPresent()

    try xml(contrast: 30).write(to: sidecar, atomically: true, encoding: .utf8)
    await store.update(model: AdjustmentModel(exposure: 0.01), culling: CullingState())
    await store.flush()
    XCTAssertEqual(try published(sidecar).0.contrast, 30, accuracy: 1e-9)
    try await store.writeConfirmed(model: AdjustmentModel(exposure: 0.02), culling: CullingState())
    let (model, history) = try published(sidecar)
    XCTAssertEqual(model.exposure, 0.02, accuracy: 1e-9)
    XCTAssertEqual(history.map(\.action), ["external"], "the merge is recorded once")
    try await store.requireObservedRevisionCurrent()
  }

  func testSidecarRemovalAfterLoadIsAConflict() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    try xml(exposure: 0).write(to: sidecar, atomically: true, encoding: .utf8)
    let store = XMPSidecarStore(rawURL: raw)
    _ = try await store.loadIfPresent()
    try FileManager.default.removeItem(at: sidecar)

    do {
      try await store.writeConfirmed(
        model: AdjustmentModel(exposure: 0.01), culling: CullingState())
      XCTFail("External removal must not be silently undone")
    } catch XMPStoreError.externalConflict {}
    XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))
  }

  func testSidecarCreationAfterAbsentLoadIsRecordedNotReplaced() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    let store = XMPSidecarStore(rawURL: raw)
    let loaded = try await store.loadIfPresent()
    XCTAssertNil(loaded)
    try xml(contrast: 30).write(to: sidecar, atomically: true, encoding: .utf8)

    try await store.writeConfirmed(model: AdjustmentModel(exposure: 0.01), culling: CullingState())

    let (model, history) = try published(sidecar)
    XCTAssertEqual(model.exposure, 0.01, accuracy: 1e-9)
    XCTAssertEqual(history.map(\.action), ["external"], "the created sidecar is recorded")
    XCTAssertEqual(try XMPParser.parse(history[0].adjustmentXmp).0.contrast, 30)
  }

  func testOwnSequentialWritesAdvanceObservedRevision() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    try xml(exposure: 0).write(to: sidecar, atomically: true, encoding: .utf8)
    let store = XMPSidecarStore(rawURL: raw)
    _ = try await store.loadIfPresent()
    try await store.writeConfirmed(
      model: AdjustmentModel(exposure: 0.5), culling: CullingState())
    try await store.writeConfirmed(
      model: AdjustmentModel(exposure: 1), culling: CullingState())
    XCTAssertEqual(try XMPParser.parse(String(contentsOf: sidecar, encoding: .utf8)).0.exposure, 1)
  }

  func testPrimaryBindingKeepsTheObservedWriter() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    try xml(exposure: 0).write(to: sidecar, atomically: true, encoding: .utf8)
    let store = XMPSidecarStore(rawURL: raw)
    _ = try await store.loadIfPresent()
    let binding = try await store.bindWorkflowVariant(WorkflowContract.primaryVariantID)
    XCTAssertTrue(binding.writer === store)
    try await store.requireObservedRevisionCurrent()
  }

  func testRenamedWriterInheritsObservedRevision() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    try xml(exposure: 0).write(to: sidecar, atomically: true, encoding: .utf8)
    let oldStore = XMPSidecarStore(rawURL: raw)
    _ = try await oldStore.loadIfPresent()
    let renamed = raw.deletingLastPathComponent().appendingPathComponent("renamed.jpg")
    let renamedSidecar = SidecarPath.sidecarURL(for: renamed)
    try FileManager.default.moveItem(at: raw, to: renamed)
    try FileManager.default.moveItem(at: sidecar, to: renamedSidecar)
    let newStore = XMPSidecarStore(rawURL: renamed)
    await newStore.adoptObservedRevision(from: oldStore)
    try await newStore.requireObservedRevisionCurrent()

    try xml(exposure: 2).write(to: renamedSidecar, atomically: true, encoding: .utf8)
    do {
      try await newStore.requireObservedRevisionCurrent()
      XCTFail("Renaming must not accept a later external replacement")
    } catch XMPStoreError.externalConflict {}
  }

  func testIdlePreviewCannotReplaceExternalRevision() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    try xml(exposure: 0).write(to: sidecar, atomically: true, encoding: .utf8)
    let store = XMPSidecarStore(rawURL: raw)
    _ = try await store.loadIfPresent()
    let preview = MapleSidecarPaths.previewURL(for: raw)
    let sink = LocalDisplayPreviewSink(previewURL: preview, sidecarStore: store)
    let external = xml(exposure: 2)
    try external.write(to: sidecar, atomically: true, encoding: .utf8)

    await sink.write(Data("stale preview".utf8))
    XCTAssertFalse(FileManager.default.fileExists(atPath: preview.path))
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), external)
  }

  func testDerivativeWriteChecksObservedRevisionInsideFileCoordination() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    try xml(exposure: 0).write(to: sidecar, atomically: true, encoding: .utf8)
    let store = XMPSidecarStore(rawURL: raw)
    _ = try await store.loadIfPresent()
    let derivative = raw.deletingLastPathComponent().appendingPathComponent("derivative.avif")
    try xml(exposure: 2).write(to: sidecar, atomically: true, encoding: .utf8)

    do {
      try await store.writeDerivativeIfCurrent {
        try Data("stale preview".utf8).write(to: derivative)
      }
      XCTFail("A changed XMP must stop derivative publication")
    } catch XMPStoreError.externalConflict {}
    XCTAssertFalse(FileManager.default.fileExists(atPath: derivative.path))
  }

  @MainActor
  func testExitWithoutLocalEditRejectsStalePreview() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    try xml(exposure: 0).write(to: sidecar, atomically: true, encoding: .utf8)
    let session = EditSession(asset: AssetRef(url: raw))
    await session.loadSidecar()
    session.scheduleDisplayPreviewPersist(
      CIImage(color: CIColor(red: 1, green: 0, blue: 0)).cropped(
        to: CGRect(x: 0, y: 0, width: 8, height: 8)))
    let external = xml(exposure: 2)
    try external.write(to: sidecar, atomically: true, encoding: .utf8)

    await session.persistDisplayPreviewOnExit()
    let preview = MapleSidecarPaths.previewURL(for: raw)
    XCTAssertFalse(FileManager.default.fileExists(atPath: preview.path))
    XCTAssertNotNil(session.sidecarError)
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), external)
  }

  @MainActor
  func testRefineCannotPublishDerivedPixelsAfterExternalReplacement() async throws {
    let (raw, sidecar) = try fixture()
    defer { try? FileManager.default.removeItem(at: raw.deletingLastPathComponent()) }
    try xml(exposure: 0).write(to: sidecar, atomically: true, encoding: .utf8)
    let session = EditSession(asset: AssetRef(url: raw))
    await session.loadSidecar()
    let initiallyCurrent = await session.canPublishDerivedPixels()
    XCTAssertTrue(initiallyCurrent)

    let external = xml(exposure: 2)
    try external.write(to: sidecar, atomically: true, encoding: .utf8)
    let currentAfterReplacement = await session.canPublishDerivedPixels()
    XCTAssertFalse(currentAfterReplacement)
    XCTAssertTrue(session.sidecarWritesDisabled)
    XCTAssertNotNil(session.sidecarError)
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), external)
  }
}
