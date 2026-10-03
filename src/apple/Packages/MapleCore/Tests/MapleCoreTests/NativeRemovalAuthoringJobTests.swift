import Foundation
import XCTest

@testable import MapleCore

final class NativeRemovalAuthoringJobTests: XCTestCase {
  @MainActor
  func testNativePeopleGroupUsesSequentialActualModelJobsAndOneKeep() async throws {
    #if os(macOS)
      let root = (0..<7).reduce(URL(fileURLWithPath: #filePath)) { value, _ in
        value.deletingLastPathComponent()
      }.appendingPathComponent("test-fixtures/raws/removal-inference")
      guard
        FileManager.default.fileExists(atPath: root.appendingPathComponent("runtime.dylib").path),
        FileManager.default.fileExists(
          atPath: root.appendingPathComponent("lama-native-1024.onnx").path)
      else { throw XCTSkip("Install the native authoring qualification corpus (#3984)") }
      let fixture = try XCTUnwrap(
        Bundle.module.url(
          forResource: "source", withExtension: "dng",
          subdirectory: "removal/calibration"))
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
      let raw = directory.appendingPathComponent("photo.dng")
      try FileManager.default.copyItem(at: fixture, to: raw)
      let original = try Data(contentsOf: raw)
      let session = EditSession(asset: AssetRef(url: raw))
      let removal = RemovalSession(
        session: session,
        modelStore: MacRemovalModelStore(root: directory.appendingPathComponent("models")))
      await removal.open()
      await removal.chooseModelFolder(root)
      removal.setMode(.people)
      // This test starts at reviewed source masks; detector/segmenter quality
      // has separate gates. Reconstruction and durable Keep use the real model.
      let masks = try [0.25, 0.75].map { x in
        try RemovalBridge.selection(
          width: 16, height: 8,
          request:
            "{\"schema\":1,\"strokes\":[{\"subtract\":false,\"radius\":0.1,\"points\":[[\(x),0.5]]}]}"
        )
      }
      removal.personMasks = masks
      removal.selection = try RemovalBridge.combineMasks(masks[0], masks[1])
      await removal.remove()
      XCTAssertEqual(removal.phase, .review, removal.message)
      XCTAssertEqual(removal.proposals.count, 2)
      let sidecar = try XCTUnwrap(session.asset.sidecarURL)
      XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))
      let records = try removal.proposals.reduce("[]") { prior, proposal in
        try RemovalBridge.prepare(
          request: proposal.request, prior: prior,
          mask: proposal.mask, patch: proposal.patch)
      }
      let decoded = try XCTUnwrap(
        JSONSerialization.jsonObject(with: Data(records.utf8)) as? [[String: Any]])
      let accepted = try XCTUnwrap(decoded[1]["accepted"] as? [String: Any])
      XCTAssertEqual((accepted["dependencies"] as? [Any])?.count, 1)
      await removal.keep()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertEqual(session.model.inpaintRemovals?.json, records)
      XCTAssertEqual(session.undoHistory.count, 1)
      XCTAssertTrue(removal.personMasks.isEmpty)
      session.undo()
      await session.flushPendingSidecarWrite()
      XCTAssertNil(session.model.inpaintRemovals)
      session.redo()
      await session.flushPendingSidecarWrite()
      XCTAssertEqual(session.model.inpaintRemovals?.json, records)
      XCTAssertEqual(try Data(contentsOf: raw), original)
      removal.close()
      await session.releaseTransientMemory()
    #else
      throw XCTSkip("macOS native model corpus test")
    #endif
  }

  @MainActor
  func testEditorPaintReviewCancelKeepAndReopenUseActualLocalModel() async throws {
    #if os(macOS)
      let root = (0..<7).reduce(URL(fileURLWithPath: #filePath)) { value, _ in
        value.deletingLastPathComponent()
      }
      .appendingPathComponent("test-fixtures/raws/removal-inference")
      guard
        FileManager.default.fileExists(atPath: root.appendingPathComponent("runtime.dylib").path),
        FileManager.default.fileExists(
          atPath: root.appendingPathComponent("lama-native-1024.onnx").path)
      else { throw XCTSkip("Install the native authoring qualification corpus (#3984)") }
      let fixture = try XCTUnwrap(
        Bundle.module.url(
          forResource: "source", withExtension: "dng",
          subdirectory: "removal/calibration"))
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
      let raw = directory.appendingPathComponent("photo.dng")
      let original = try Data(contentsOf: fixture)
      try original.write(to: raw)
      let session = EditSession(asset: AssetRef(url: raw))
      let modelStore = MacRemovalModelStore(root: directory.appendingPathComponent("models"))
      let removal = RemovalSession(session: session, modelStore: modelStore)
      await removal.open()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      await removal.chooseModelFolder(root)
      removal.radius = 0.1
      await removal.paint([[0.4, 0.5]], cropInputSize: [16, 8])
      XCTAssertTrue(removal.canRemove)
      let sidecar = try XCTUnwrap(session.asset.sidecarURL)
      let before = try? Data(contentsOf: sidecar)
      await removal.remove()
      XCTAssertEqual(removal.phase, .review, removal.message)
      let preview = try XCTUnwrap(removal.preview)
      XCTAssertEqual(preview.bytes.count, Int(preview.width * preview.height * 3))
      XCTAssertEqual(try? Data(contentsOf: sidecar), before)
      removal.compare = true
      removal.cancel()
      XCTAssertEqual(removal.phase, .ready)
      XCTAssertNil(removal.preview)
      XCTAssertFalse(removal.compare)
      XCTAssertEqual(try? Data(contentsOf: sidecar), before)
      await removal.remove()
      XCTAssertEqual(removal.phase, .review, removal.message)
      await removal.keep()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertEqual(removal.message, "Removal saved.")
      XCTAssertNotNil(session.model.inpaintRemovals)
      XCTAssertEqual(session.undoHistory.count, 1)
      XCTAssertEqual(try XMPParser.parse(data: Data(contentsOf: sidecar)).0, session.model)
      XCTAssertEqual(try Data(contentsOf: raw), original)
      let accepted = session.model
      removal.close()
      await removal.open()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertEqual(removal.context?.model, accepted)
      XCTAssertTrue(removal.selection.isEmpty)
      removal.close()
      let reopened = RemovalSession(session: session, modelStore: modelStore)
      await reopened.open()
      XCTAssertEqual(reopened.modelFolderName, "Installed local models", reopened.message)
      reopened.radius = 0.1
      await reopened.paint([[0.8, 0.5]], cropInputSize: [16, 8])
      await reopened.remove()
      XCTAssertEqual(reopened.phase, .review, reopened.message)
      reopened.cancel()
      reopened.close()
      XCTAssertEqual(try XMPParser.parse(data: Data(contentsOf: sidecar)).0, accepted)
      XCTAssertEqual(try Data(contentsOf: raw), original)
      await session.releaseTransientMemory()
    #else
      throw XCTSkip("macOS native model corpus test")
    #endif
  }

  @MainActor
  func testActualGenerationReviewKeepReopenAndCancellationDoNotModifyOriginal() async throws {
    #if os(macOS)
      let root = (0..<7).reduce(URL(fileURLWithPath: #filePath)) { value, _ in
        value.deletingLastPathComponent()
      }.appendingPathComponent("test-fixtures/raws/removal-inference")
      guard
        FileManager.default.fileExists(atPath: root.appendingPathComponent("runtime.dylib").path),
        FileManager.default.fileExists(
          atPath: root.appendingPathComponent("lama-native-1024.onnx").path)
      else {
        throw XCTSkip("Native model corpus must be installed for authoring qualification (#3984)")
      }
      let fixture = try XCTUnwrap(
        Bundle.module.url(
          forResource: "source", withExtension: "dng", subdirectory: "removal/calibration"))
      let source = try Data(contentsOf: fixture)
      let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
      let raw = folder.appendingPathComponent("photo.dng")
      try source.write(to: raw)
      let model = try NativeRemovalReconstructor.open(
        directory: root, runtime: root.appendingPathComponent("runtime.dylib"))
      let handle = try PipelineRenderer.openRawHandle(rawPath: raw)
      let saved = NativeSavedRemovalSession(handle: handle)
      let initialXMP = XMPSerializer.serialize(model: .default, culling: CullingState())
      _ = try await saved.prepare(source: source, ext: "dng", xmp: initialXMP, assets: [:])
      let mask = try RemovalBridge.selection(
        width: 16, height: 8,
        request:
          "{\"schema\":1,\"strokes\":[{\"subtract\":false,\"radius\":0.06,\"points\":[[0.5,0.5]]}]}"
      )
      let job = try NativeRemovalAuthoringJob(model: model)
      let proposal = try await job.propose(
        handle: handle, saved: saved, xmp: initialXMP, intent: mask, holeRadius: 1, fringeRadius: 1)
      XCTAssertFalse(FileManager.default.fileExists(atPath: SidecarPath.sidecarURL(for: raw).path))
      XCTAssertFalse(
        FileManager.default.fileExists(atPath: folder.appendingPathComponent(".maple").path))
      let assets = LocalRemovalAssetStore(rawURL: raw)
      let session = EditSession(asset: AssetRef(url: raw))
      try await session.acceptRemoval(
        proposal, snapshot: session.removalAuthoringSnapshot())
      await session.flushPendingSidecarWrite()
      let records = try XCTUnwrap(session.model.inpaintRemovals).json
      XCTAssertEqual(session.undoHistory.count, 1)
      let sidecar = try Data(contentsOf: SidecarPath.sidecarURL(for: raw))
      let xmp = String(decoding: sidecar, as: UTF8.self)
      XCTAssertEqual(try RemovalXMPRecords.read(sidecar), records)
      let reopened = NativeSavedRemovalSession(handle: handle)
      _ = try await reopened.prepare(
        source: source, ext: "dng", xmp: xmp, assets: assets.readAssets(records: records))
      let preview = try await reopened.preview(xmp: xmp, maxLongEdge: 16)
      XCTAssertEqual(preview.bytes.count, 384)
      let next = try NativeRemovalAuthoringJob(model: model)
      let second = try await next.propose(
        handle: handle, saved: reopened, xmp: xmp, intent: mask, holeRadius: 1, fringeRadius: 1)
      let appended = try RemovalBridge.prepare(
        request: second.request, prior: records, mask: second.mask, patch: second.patch)
      let decoded = try XCTUnwrap(
        JSONSerialization.jsonObject(with: Data(appended.utf8)) as? [[String: Any]])
      XCTAssertEqual(decoded.count, 2)
      let accepted = try XCTUnwrap(decoded[1]["accepted"] as? [String: Any])
      XCTAssertEqual((accepted["dependencies"] as? [Any])?.count, 1)
      try await session.acceptRemoval(
        second, snapshot: session.removalAuthoringSnapshot())
      await session.flushPendingSidecarWrite()
      XCTAssertEqual(session.model.inpaintRemovals?.json, appended)
      XCTAssertEqual(session.undoHistory.count, 2)
      session.undo()
      await session.flushPendingSidecarWrite()
      XCTAssertEqual(session.model.inpaintRemovals?.json, records)
      XCTAssertEqual(
        try RemovalXMPRecords.read(Data(contentsOf: SidecarPath.sidecarURL(for: raw))), records)
      session.redo()
      await session.flushPendingSidecarWrite()
      XCTAssertEqual(session.model.inpaintRemovals?.json, appended)
      let committed = try Data(contentsOf: SidecarPath.sidecarURL(for: raw))
      let secondOwner = NativeSavedRemovalSession(handle: handle)
      _ = try await secondOwner.prepare(
        source: source, ext: "dng", xmp: String(decoding: committed, as: UTF8.self),
        assets: assets.readAssets(records: appended))
      let secondPreview = try await secondOwner.preview(
        xmp: String(decoding: committed, as: UTF8.self), maxLongEdge: 16)
      XCTAssertEqual(secondPreview.bytes.count, 384)
      let cancelled = try NativeRemovalAuthoringJob(model: model)
      cancelled.cancel()
      do {
        _ = try await cancelled.propose(
          handle: handle, saved: reopened, xmp: xmp, intent: mask, holeRadius: 1, fringeRadius: 1)
        XCTFail("Cancelled jobs must not produce a proposal")
      } catch {
        guard case PipelineError.cancelled = error else { return XCTFail("\(error)") }
      }
      do {
        _ = try await job.propose(
          handle: handle, saved: reopened, xmp: xmp, intent: mask, holeRadius: 1, fringeRadius: 1)
        XCTFail("Each generation must have its own cancellation owner")
      } catch { XCTAssertTrue(error is RemovalError) }
      XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: raw)), committed)
      XCTAssertEqual(try Data(contentsOf: raw), source)
      await session.releaseTransientMemory()
    #else
      throw XCTSkip("Physical iOS inference qualification is tracked by #3941")
    #endif
  }
}
