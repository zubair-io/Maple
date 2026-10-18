// EditSessionSidecarWriteGuardTests — a session never writes its sidecar
// before a successful load (#4708). Every case round-trips a REAL .xmp
// beside the committed synthetic DNG in a temp directory.

import XCTest

@testable import MapleCore

@MainActor
final class EditSessionSidecarWriteGuardTests: EditorTestCase {
  private static let syntheticDNG: URL = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url.appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
  }()

  private static let unreadableSidecar = Data([0xFF, 0xFE, 0xFD, 0x00, 0xC3])

  private func makeRaw() throws -> URL {
    let dir = try SidecarContractIO.makeTempDirectory(prefix: "write-guard")
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    let raw = dir.appendingPathComponent("grey.dng")
    try FileManager.default.copyItem(at: Self.syntheticDNG, to: raw)
    return raw
  }

  private func developModel(_ edit: (inout AdjustmentModel) -> Void) -> AdjustmentModel {
    var model = AdjustmentModel.default
    edit(&model)
    return model
  }

  private func saveDevelop(exposure: Double, stars: Int, beside raw: URL) async throws {
    let model = developModel { $0.exposure = exposure }
    try await XMPSidecarStore(rawURL: raw).writeConfirmed(
      model: model, culling: CullingState(stars: stars, keywords: ["kept"]))
  }

  private func reparse(_ raw: URL) throws -> (AdjustmentModel, CullingState) {
    try XMPParser.parse(data: Data(contentsOf: SidecarPath.sidecarURL(for: raw)))
  }

  private func settle(_ session: EditSession) async {
    for _ in 0..<5 { await Task.yield() }
    await session.flushPendingSidecarWrite()
  }

  func testRatingBeforeLoadMergesOverSavedDevelopSettings() async throws {
    let raw = try makeRaw()
    try await saveDevelop(exposure: 1.5, stars: 1, beside: raw)
    let session = EditSession(asset: AssetRef(url: raw))

    session.culling.stars = 4
    await session.loadSidecar()
    await settle(session)

    let (model, culling) = try reparse(raw)
    XCTAssertEqual(model.exposure, 1.5, accuracy: 1e-9)
    XCTAssertEqual(culling.stars, 4)
    XCTAssertEqual(culling.keywords, ["kept"])
    XCTAssertEqual(session.model.exposure, 1.5, accuracy: 1e-9)
    XCTAssertEqual(session.culling.stars, 4)
  }

  func testRatingBeforeLoadIsQueuedUntilFlushHydrates() async throws {
    let raw = try makeRaw()
    try await saveDevelop(exposure: 1.5, stars: 1, beside: raw)
    let session = EditSession(asset: AssetRef(url: raw))

    session.culling.flag = .pick
    await settle(session)

    let (model, culling) = try reparse(raw)
    XCTAssertEqual(model.exposure, 1.5, accuracy: 1e-9)
    XCTAssertEqual(culling.flag, .pick)
    XCTAssertEqual(culling.stars, 1)
  }

  func testSliderEditBeforeLoadNeverReachesDisk() async throws {
    let raw = try makeRaw()
    try await saveDevelop(exposure: 1.5, stars: 2, beside: raw)
    let session = EditSession(asset: AssetRef(url: raw))

    session.beginEdit()
    session.model.contrast = 40
    session.endEdit()
    await settle(session)

    let (model, culling) = try reparse(raw)
    XCTAssertEqual(model.exposure, 1.5, accuracy: 1e-9)
    XCTAssertEqual(model.contrast, 0, accuracy: 1e-9)
    XCTAssertEqual(culling.stars, 2)
  }

  func testLoadedSidecarWinsOverAnEditMadeWhileLoading() async throws {
    let raw = try makeRaw()
    try await saveDevelop(exposure: 1.5, stars: 2, beside: raw)
    let session = EditSession(asset: AssetRef(url: raw))

    session.model.contrast = 40
    await session.loadSidecar()

    XCTAssertTrue(session.hasLoadedSidecar)
    XCTAssertEqual(session.model.exposure, 1.5, accuracy: 1e-9)
    XCTAssertEqual(session.model.contrast, 0, accuracy: 1e-9)
    XCTAssertTrue(session.transactions.undoStack.isEmpty)
  }

  func testFailedLoadMakesTheSessionReadOnlyUntilAReloadSucceeds() async throws {
    let raw = try makeRaw()
    let sidecar = SidecarPath.sidecarURL(for: raw)
    try Self.unreadableSidecar.write(to: sidecar)
    let session = EditSession(asset: AssetRef(url: raw))

    await session.loadSidecar()
    XCTAssertFalse(session.hasLoadedSidecar)
    XCTAssertTrue(session.sidecarLoadFailed)
    XCTAssertNotNil(session.sidecarError)

    session.beginEdit()
    session.model.exposure = -2
    session.endEdit()
    session.culling.stars = 5
    await settle(session)
    XCTAssertEqual(try Data(contentsOf: sidecar), Self.unreadableSidecar)

    try FileManager.default.removeItem(at: sidecar)
    try await saveDevelop(exposure: 1.5, stars: 1, beside: raw)
    await session.loadSidecar()
    XCTAssertTrue(session.hasLoadedSidecar)
    XCTAssertFalse(session.sidecarLoadFailed)
    XCTAssertNil(session.sidecarError)
    XCTAssertEqual(session.model.exposure, 1.5, accuracy: 1e-9)
    XCTAssertEqual(session.culling.stars, 5)
  }

  func testSetCullingHydratesBeforeWriting() async throws {
    let raw = try makeRaw()
    try await saveDevelop(exposure: 1.5, stars: 1, beside: raw)
    let session = EditSession(asset: AssetRef(url: raw))

    try await session.setCulling { $0.stars = 3 }
    await settle(session)

    let (model, culling) = try reparse(raw)
    XCTAssertEqual(model.exposure, 1.5, accuracy: 1e-9)
    XCTAssertEqual(culling.stars, 3)
    XCTAssertEqual(culling.keywords, ["kept"])
  }

  func testSetCullingThrowsAndLeavesAnUnreadableSidecarUntouched() async throws {
    let raw = try makeRaw()
    let sidecar = SidecarPath.sidecarURL(for: raw)
    try Self.unreadableSidecar.write(to: sidecar)
    let session = EditSession(asset: AssetRef(url: raw))

    do {
      try await session.setCulling { $0.stars = 3 }
      XCTFail("a rating over an unreadable sidecar must not be accepted")
    } catch {}
    await settle(session)

    XCTAssertEqual(session.culling.stars, 0)
    XCTAssertEqual(try Data(contentsOf: sidecar), Self.unreadableSidecar)
  }

  func testPasteIntoAnUnloadedSessionKeepsUnpastedGroups() async throws {
    let raw = try makeRaw()
    let saved = developModel {
      $0.exposure = 1.5
      $0.vibrance = 30
    }
    try await XMPSidecarStore(rawURL: raw).writeConfirmed(
      model: saved, culling: CullingState(stars: 2))
    let session = EditSession(asset: AssetRef(url: raw))
    let source = developModel { $0.exposure = -1 }

    let written = await AdjustmentPasteApplier.apply(
      source: source, groups: [.tone], to: [session.asset], sessions: [session.asset.id: session])
    await settle(session)

    XCTAssertEqual(written, 1)
    let (model, culling) = try reparse(raw)
    XCTAssertEqual(model.exposure, -1, accuracy: 1e-9)
    XCTAssertEqual(model.vibrance, 30, accuracy: 1e-9)
    XCTAssertEqual(culling.stars, 2)
  }

  func testASlowFailedLoadCannotPauseASessionAnotherLoadHydrated() async throws {
    var saved = AdjustmentModel.default
    saved.exposure = 1.5
    let store = FirstLoadFailsLateStore(model: saved)
    let asset = AssetRef(displayName: "remote.dng", hintExtension: "dng", bytesProvider: { Data() })
    let session = EditSession(asset: asset, remoteSidecarStore: store)

    let slow = Task { await session.loadSidecar() }
    await store.waitUntilFirstLoadStarts()
    await session.loadSidecar()
    XCTAssertTrue(session.hasLoadedSidecar)
    await store.releaseFirstLoad()
    await slow.value

    XCTAssertFalse(session.sidecarLoadFailed, "a stale failure must not pause a loaded session")
    XCTAssertNil(session.sidecarError)
    XCTAssertEqual(session.model.exposure, 1.5, accuracy: 1e-9)
  }
}

extension EditSessionSidecarWriteGuardTests {
  /// Rapid shortcuts during a slow first read (BrowseGrid presses 3 then 4)
  /// each wait on hydration; they must apply in the order they were made,
  /// so the last one wins rather than whichever read resumed last.
  func testCullingShortcutsDuringHydrationApplyInOrder() async throws {
    let store = FirstLoadFailsLateStore(model: .default, firstReadFails: false)
    let asset = AssetRef(displayName: "remote.dng", hintExtension: "dng", bytesProvider: { Data() })
    let session = EditSession(asset: asset, remoteSidecarStore: store)

    let first = Task { try await session.setCulling { $0.stars = 3 } }
    await store.waitUntilFirstLoadStarts()
    let second = Task { try await session.setCulling { $0.stars = 4 } }
    for _ in 0..<20 { await Task.yield() }
    await store.releaseFirstLoad()
    try await first.value
    try await second.value
    await session.flushPendingSidecarWrite()

    XCTAssertEqual(session.culling.stars, 4)
    let written = await store.written
    XCTAssertEqual(written?.stars, 4)
  }
}

/// The first read suspends until released, then fails (or, with
/// `firstReadFails: false`, returns); later reads succeed at once. Stands in
/// for browse priming and the editor racing two Cloud reads.
private actor FirstLoadFailsLateStore: SidecarStoreProtocol {
  private let value: (AdjustmentModel, CullingState)
  private let firstReadFails: Bool
  private var reads = 0
  private var firstRead: CheckedContinuation<Void, Never>?
  private(set) var written: CullingState?

  init(model: AdjustmentModel, firstReadFails: Bool = true) {
    value = (model, CullingState())
    self.firstReadFails = firstReadFails
  }

  func load() async throws -> (AdjustmentModel, CullingState) { value }

  func loadIfPresent() async throws -> (AdjustmentModel, CullingState)? {
    reads += 1
    guard reads == 1 else { return value }
    await withCheckedContinuation { firstRead = $0 }
    guard !firstReadFails else { throw URLError(.timedOut) }
    return value
  }

  func waitUntilFirstLoadStarts() async {
    while firstRead == nil { await Task.yield() }
  }

  func releaseFirstLoad() {
    firstRead?.resume()
    firstRead = nil
  }

  func update(model: AdjustmentModel, culling: CullingState) { written = culling }
  func flush() async {}
  func writeConfirmed(model: AdjustmentModel, culling: CullingState) async throws {
    written = culling
  }
  func errors() -> AsyncStream<Error> { AsyncStream { $0.finish() } }
}
