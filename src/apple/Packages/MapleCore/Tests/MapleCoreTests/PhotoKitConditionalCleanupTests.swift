import MapleBackup
import XCTest

@testable import MapleCore

final class PhotoKitConditionalCleanupTests: XCTestCase {
  private actor CompletionFlag {
    private(set) var done = false
    func finish() { done = true }
  }

  func testQueuedPhotoKitSourceWriteSurvivesCoordinatedAcknowledgementRemoval() async throws {
    let (backing, root) = try freshBacking()
    defer { try? FileManager.default.removeItem(at: root) }
    let id = "PHOTO/L0/006"
    let source = PhotoKitSource(sidecarOverride: backing)
    let ref = ImageRef(id: id, displayName: id)
    var first = AdjustmentModel.default
    first.exposure = 1
    try await source.writeXMP(Sidecar(model: first, culling: CullingState()), for: ref)
    let sent = try XCTUnwrap(backing.read(phassetLocalId: id))

    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    let holderDone = DispatchSemaphore(value: 0)
    defer { release.signal() }
    DispatchQueue.global().async {
      let coordinator = NSFileCoordinator(filePresenter: nil)
      var coordinationError: NSError?
      coordinator.coordinate(
        writingItemAt: backing.sidecarURL(phassetLocalId: id), options: .forDeleting,
        error: &coordinationError
      ) { url in
        entered.signal()
        release.wait()
        XCTAssertEqual(try? Data(contentsOf: url), Data(sent.utf8))
        do {
          try FileManager.default.removeItem(at: url)
        } catch {
          XCTFail("Acknowledgement removal failed: \(error)")
        }
      }
      XCTAssertNil(coordinationError)
      holderDone.signal()
    }
    XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)

    var newer = AdjustmentModel.default
    newer.exposure = 2
    let attempted = root.appendingPathComponent("writer-attempt")
    let sidecar = Sidecar(model: newer, culling: CullingState())
    let completion = CompletionFlag()
    let writer = Task.detached {
      try Data().write(to: attempted)
      try await source.writeXMP(sidecar, for: ref)
      await completion.finish()
    }
    for _ in 0..<500 where !FileManager.default.fileExists(atPath: attempted.path) {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertTrue(FileManager.default.fileExists(atPath: attempted.path))
    try await Task.sleep(for: .milliseconds(300))
    let finishedWhileCleanupHeldFile = await completion.done
    XCTAssertFalse(finishedWhileCleanupHeldFile, "PhotoKitSource bypassed cleanup coordination")
    release.signal()
    try await writer.value
    XCTAssertEqual(holderDone.wait(timeout: .now() + 5), .success)
    let saved = try XCTUnwrap(backing.read(phassetLocalId: id))
    XCTAssertNotEqual(saved, sent)
    let (readModel, _) = try await source.readXMP(for: ref)
    XCTAssertEqual(readModel.exposure, 2, accuracy: 0.0001)
  }

  func testNewerProductionEditorXMPIsPreserved() async throws {
    let (backing, root) = try freshBacking()
    defer { try? FileManager.default.removeItem(at: root) }
    let id = "PHOTO/L0/002"
    let editor = PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing)
    var first = AdjustmentModel.default
    first.exposure = 1
    try await editor.writeConfirmed(model: first, culling: CullingState())
    let sent = try XCTUnwrap(backing.read(phassetLocalId: id))

    var newer = AdjustmentModel.default
    newer.exposure = 2
    try await editor.writeConfirmed(model: newer, culling: CullingState())
    let latest = try XCTUnwrap(backing.read(phassetLocalId: id))
    XCTAssertNotEqual(latest, sent)

    XCTAssertFalse(try backing.deleteIfUnchanged(phassetLocalId: id, matching: sent))
    XCTAssertEqual(try backing.read(phassetLocalId: id), latest)
  }

  func testAcknowledgedProductionEditorXMPIsRemovedWhenUnchanged() async throws {
    let (backing, root) = try freshBacking()
    defer { try? FileManager.default.removeItem(at: root) }
    let id = "PHOTO/L0/003"
    let editor = PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing)
    var model = AdjustmentModel.default
    model.exposure = 1
    try await editor.writeConfirmed(model: model, culling: CullingState())
    let sent = try XCTUnwrap(backing.read(phassetLocalId: id))

    XCTAssertTrue(try backing.deleteIfUnchanged(phassetLocalId: id, matching: sent))
    XCTAssertNil(try backing.read(phassetLocalId: id))
    XCTAssertFalse(try backing.deleteIfUnchanged(phassetLocalId: id, matching: sent))
  }

  private func freshBacking() throws -> (AppSupportSidecarStore, URL) {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent(
        "photokit-conditional-cleanup-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return (AppSupportSidecarStore(root: root), root)
  }
}
