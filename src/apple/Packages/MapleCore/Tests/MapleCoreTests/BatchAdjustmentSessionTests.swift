import XCTest

@testable import MapleCore

@MainActor
final class BatchAdjustmentSessionTests: XCTestCase {
  func testConfirmedTransferRetainsLiveUndoMetadataCullingAndUnknownXML() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "batch-live-session")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = root.appendingPathComponent("photo.png")
    let originalBytes = try SidecarContractIO.makeSyntheticOriginal(at: original)
    let sidecar = SidecarPath.sidecarURL(for: original)
    let xml = XMPPassthroughTests.lightroomSidecar
    try xml.write(to: sidecar, atomically: true, encoding: .utf8)
    let metadata = XMPParser.parseMetadata(xml)
    let passthrough = XMPParser.parsePassthrough(data: Data(xml.utf8))
    let asset = AssetRef(url: original)
    let session = EditSession(asset: asset)
    await session.loadSidecar()
    session.beginEdit(description: "Vibrance")
    session.model.vibrance = 42
    session.endEdit()
    let before = session.model
    let culling = session.culling
    let history = session.undoHistory.count
    var source = AdjustmentModel.default
    source.exposure = 1.6
    let patch = PreparedAdjustmentTransfer(
      model: source, groupIDs: [AdjustmentGroup.tone.rawValue], before: before)
    try await session.applyAdjustmentTransfer(patch)
    XCTAssertEqual(session.model.exposure, 1.6)
    XCTAssertEqual(session.model.vibrance, 42)
    XCTAssertEqual(session.undoHistory.count, history + 1)
    try await session.applyAdjustmentTransfer(patch)
    XCTAssertEqual(
      session.undoHistory.count, history + 1, "An already-written retry creates no duplicate undo")
    let savedXML = try String(contentsOf: sidecar, encoding: .utf8)
    XCTAssertEqual(XMPParser.parseMetadata(savedXML), metadata)
    XCTAssertEqual(XMPParser.parsePassthrough(data: Data(savedXML.utf8)), passthrough)
    let (_, savedCulling) = try await XMPSidecarStore(rawURL: original).load()
    XCTAssertEqual(savedCulling, culling)
    session.undo()
    XCTAssertEqual(session.model, before)
    session.redo()
    XCTAssertEqual(session.model.exposure, 1.6)
    XCTAssertEqual(session.model.vibrance, 42)
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try Data(contentsOf: original), originalBytes)
  }

  func testLoadedSessionCannotBeRehydratedOverPendingEdits() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "batch-hydration")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = root.appendingPathComponent("photo.png")
    try SidecarContractIO.makeSyntheticOriginal(at: original)
    let session = EditSession(asset: AssetRef(url: original))
    await session.loadSidecar()
    session.beginEdit(description: "Exposure")
    session.model.exposure = 2.25
    await session.loadSidecar()
    XCTAssertEqual(session.model.exposure, 2.25)
    XCTAssertTrue(session.canUndo)
    session.endEdit()
    XCTAssertEqual(session.undoHistory.count, 1)
    await session.flushPendingSidecarWrite()
  }

  func testLateInitialHydrationCannotReplayOverAnEditOnRetry() async throws {
    var persisted = AdjustmentModel.default
    persisted.exposure = -1.5
    let store = SuspendedHydrationStore(model: persisted)
    let asset = AssetRef(
      displayName: "remote.cr2", hintExtension: "cr2", bytesProvider: { Data() })
    let session = EditSession(asset: asset, remoteSidecarStore: store)
    let load = Task { await session.loadSidecar() }
    await store.waitUntilLoadStarts()

    session.beginEdit(description: "Exposure")
    session.model.exposure = 2.25
    session.endEdit()
    await store.releaseLoad()
    await load.value

    XCTAssertEqual(session.model.exposure, 2.25)
    XCTAssertTrue(session.hasLoadedSidecar)
    await session.loadSidecar()
    XCTAssertEqual(
      session.model.exposure, 2.25,
      "A retry must not replay the stale persisted snapshot over the winning edit")
  }
  func testLateCopyReadCannotReplaceTheLatestRequestedPhoto() {
    let clipboard = AdjustmentClipboard()
    let old = clipboard.beginCopyRequest()
    let latest = clipboard.beginCopyRequest()
    clipboard.copy(model: .default, sourceName: "Latest", scopeID: "library", requestID: latest)
    clipboard.copy(model: .default, sourceName: "Old", scopeID: "library", requestID: old)
    XCTAssertEqual(clipboard.contents?.sourceName, "Latest")
    clipboard.clear()
    clipboard.copy(model: .default, sourceName: "Late", scopeID: "library", requestID: latest)
    XCTAssertNil(clipboard.contents)
  }

}

private actor SuspendedHydrationStore: SidecarStoreProtocol {
  private let value: (AdjustmentModel, CullingState)
  private var loadStarted = false
  private var loadContinuation: CheckedContinuation<Void, Never>?

  init(model: AdjustmentModel) {
    value = (model, CullingState())
  }

  func load() async throws -> (AdjustmentModel, CullingState) { value }

  func loadIfPresent() async throws -> (AdjustmentModel, CullingState)? {
    loadStarted = true
    await withCheckedContinuation { loadContinuation = $0 }
    return value
  }

  func waitUntilLoadStarts() async {
    while !loadStarted { await Task.yield() }
  }

  func releaseLoad() {
    loadContinuation?.resume()
    loadContinuation = nil
  }

  func update(model: AdjustmentModel, culling: CullingState) {}
  func flush() async {}
  func writeConfirmed(model: AdjustmentModel, culling: CullingState) async throws {}
  func errors() -> AsyncStream<Error> { AsyncStream { $0.finish() } }
}
