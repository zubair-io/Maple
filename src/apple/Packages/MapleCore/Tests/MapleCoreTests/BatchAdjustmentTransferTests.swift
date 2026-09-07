import XCTest

@testable import MapleCore

final class BatchAdjustmentTransferTests: XCTestCase {
  private func directory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  private func targets(in directory: URL, count: Int) throws -> [BatchAdjustmentTarget] {
    try (0..<count).map { index in
      let original = directory.appendingPathComponent("photo-\(index).png")
      try Data("original-\(index)".utf8).write(to: original)
      return BatchAdjustmentTarget(
        id: original.absoluteString, name: original.lastPathComponent, url: original)
    }
  }

  private static func prepare(_ target: BatchAdjustmentTarget, _ request: BatchAdjustmentRequest)
    async throws -> PreparedAdjustmentTransfer
  {
    let (before, _) = try await XMPSidecarStore(rawURL: XCTUnwrap(target.url)).load()
    let patch = try AdjustmentTransfer.prepare(
      source: request.source, groups: request.groups, relativeWhiteBalance: false)
    return PreparedAdjustmentTransfer(model: patch.model, groupIDs: patch.groupIDs, before: before)
  }

  private static func apply(_ target: BatchAdjustmentTarget, _ patch: PreparedAdjustmentTransfer)
    async throws
  {
    let url = try XCTUnwrap(target.url)
    let store = XMPSidecarStore(rawURL: url)
    let (model, culling) = try await store.loadIfPresent() ?? (.default, CullingState())
    try patch.validate(current: model)
    try await store.writeConfirmed(model: patch.applying(to: model), culling: culling)
  }

  func testInterruptedFailedOnlyRetryNeverStartsUnrelatedPendingPhotos() async throws {
    let root = try directory()
    defer { try? FileManager.default.removeItem(at: root) }
    let targets = try targets(in: root, count: 3)
    let badSidecar = SidecarPath.sidecarURL(for: try XCTUnwrap(targets[0].url))
    try FileManager.default.createDirectory(at: badSidecar, withIntermediateDirectories: true)
    let ledgerURL = root.appendingPathComponent("ledger")
    let ledger = BatchAdjustmentTransfer(directory: ledgerURL)
    var source = AdjustmentModel.default
    source.exposure = 1.25
    let request = BatchAdjustmentRequest(
      source: source, groups: [.tone], relativeWhiteBalance: false, sourceBaseline: nil)
    let operation = try await ledger.create(scopeID: "library", request: request, targets: targets)
    let cancelled = try await ledger.run(
      operation.id, scopeID: "library", prepare: Self.prepare, apply: Self.apply,
      progress: { _ in try? await ledger.cancel(operation.id) })
    XCTAssertEqual(cancelled.summary.failed.map(\.id), [targets[0].id])
    XCTAssertEqual(cancelled.pendingCount, 2)
    try FileManager.default.removeItem(at: badSidecar)

    let gate = TransferWriteGate()
    let retry = Task {
      try await ledger.run(
        operation.id, scopeID: "library", retryFailed: true,
        prepare: Self.prepare,
        apply: { target, patch in
          await gate.arriveAndWait()
          try await Self.apply(target, patch)
        }, progress: { _ in })
    }
    try await gate.waitForArrival()
    // Copy the real durable bytes at the crash boundary: A is prepared,
    // and B/C have never been attempted. A fresh actor is a restarted app.
    let recoveredURL = root.appendingPathComponent("recovered-ledger")
    try FileManager.default.copyItem(at: ledgerURL, to: recoveredURL)
    try await ledger.cancel(operation.id)
    await gate.release()
    _ = try await retry.value
    let recovered = BatchAdjustmentTransfer(directory: recoveredURL)
    let saved = try await recovered.latest(in: "library")
    XCTAssertEqual(saved?.operation.status, .ready)
    let resumed = try await recovered.run(
      operation.id, scopeID: "library", prepare: Self.prepare, apply: Self.apply, progress: { _ in }
    )
    XCTAssertEqual(resumed.summary.applied, [targets[0].id])
    XCTAssertEqual(resumed.pendingCount, 2)
    XCTAssertTrue(resumed.summary.failed.isEmpty)
    let (written, _) = try await XMPSidecarStore(rawURL: XCTUnwrap(targets[0].url)).load()
    XCTAssertEqual(written.exposure, 1.25)
    for target in targets.dropFirst() {
      XCTAssertFalse(
        FileManager.default.fileExists(
          atPath: SidecarPath.sidecarURL(for: try XCTUnwrap(target.url)).path))
    }
    for (index, target) in targets.enumerated() {
      XCTAssertEqual(try Data(contentsOf: XCTUnwrap(target.url)), Data("original-\(index)".utf8))
    }
  }

  func testConfirmedFailuresPersistAndRetryOnlyFailedThenDismiss() async throws {
    let root = try directory()
    defer { try? FileManager.default.removeItem(at: root) }
    let targets = try targets(in: root, count: 2)
    let badSidecar = SidecarPath.sidecarURL(for: try XCTUnwrap(targets[1].url))
    try FileManager.default.createDirectory(at: badSidecar, withIntermediateDirectories: true)
    let ledger = BatchAdjustmentTransfer(directory: root.appendingPathComponent("ledger"))
    var model = AdjustmentModel.default
    model.vibrance = 21
    let request = BatchAdjustmentRequest(
      source: model, groups: [.color], relativeWhiteBalance: false, sourceBaseline: nil)
    let operation = try await ledger.create(scopeID: "library", request: request, targets: targets)
    let result = try await ledger.run(
      operation.id, scopeID: "library", prepare: Self.prepare, apply: Self.apply, progress: { _ in }
    )
    XCTAssertEqual(result.summary.applied, [targets[0].id])
    XCTAssertEqual(result.summary.failed.map(\.id), [targets[1].id])
    XCTAssertFalse(result.summary.failed[0].reason.isEmpty)
    let firstSidecar = SidecarPath.sidecarURL(for: try XCTUnwrap(targets[0].url))
    let firstBytes = try Data(contentsOf: firstSidecar)
    let firstDate = try firstSidecar.resourceValues(forKeys: [.contentModificationDateKey])
      .contentModificationDate
    try FileManager.default.removeItem(at: badSidecar)
    let retried = try await ledger.run(
      operation.id, scopeID: "library", retryFailed: true, prepare: Self.prepare, apply: Self.apply,
      progress: { _ in })
    XCTAssertEqual(retried.summary.applied.count, 2)
    XCTAssertTrue(retried.summary.failed.isEmpty)
    XCTAssertEqual(try Data(contentsOf: firstSidecar), firstBytes)
    XCTAssertEqual(
      try firstSidecar.resourceValues(forKeys: [.contentModificationDateKey])
        .contentModificationDate, firstDate)
    try await ledger.dismiss(operation.id)
    let visible = try await ledger.operations(in: "library")
    XCTAssertTrue(visible.isEmpty)
  }

  func testCrashAfterWriteDetectsSelectedEditsAndPreservesUnselectedEdits() async throws {
    let root = try directory()
    defer { try? FileManager.default.removeItem(at: root) }
    let targets = try targets(in: root, count: 1)
    let url = try XCTUnwrap(targets[0].url)
    let ledgerURL = root.appendingPathComponent("ledger")
    let ledger = BatchAdjustmentTransfer(directory: ledgerURL)
    var model = AdjustmentModel.default
    model.exposure = 1.5
    let request = BatchAdjustmentRequest(
      source: model, groups: [.tone], relativeWhiteBalance: false, sourceBaseline: nil)
    let operation = try await ledger.create(scopeID: "library", request: request, targets: targets)
    let gate = TransferWriteGate()
    let run = Task {
      try await ledger.run(
        operation.id, scopeID: "library", prepare: Self.prepare,
        apply: { target, patch in
          try await Self.apply(target, patch)
          await gate.arriveAndWait()
        }, progress: { _ in })
    }
    try await gate.waitForArrival()
    let conflictLedger = root.appendingPathComponent("conflict-ledger")
    let untouchedLedger = root.appendingPathComponent("untouched-ledger")
    try FileManager.default.copyItem(at: ledgerURL, to: conflictLedger)
    try FileManager.default.copyItem(at: ledgerURL, to: untouchedLedger)
    await gate.release()
    _ = try await run.value
    var later = model
    later.exposure = 3
    later.vibrance = 57
    try await XMPSidecarStore(rawURL: url).writeConfirmed(model: later, culling: CullingState())
    let conflicted = try await BatchAdjustmentTransfer(directory: conflictLedger).run(
      operation.id,
      scopeID: "library", prepare: Self.prepare, apply: Self.apply, progress: { _ in })
    XCTAssertEqual(conflicted.summary.failed.count, 1)
    XCTAssertTrue(conflicted.summary.applied.isEmpty)
    let (kept, _) = try await XMPSidecarStore(rawURL: url).load()
    XCTAssertEqual(kept.exposure, 3)
    XCTAssertEqual(kept.vibrance, 57)
    later.exposure = 1.5
    try await XMPSidecarStore(rawURL: url).writeConfirmed(model: later, culling: CullingState())
    let resumed = try await BatchAdjustmentTransfer(directory: untouchedLedger).run(
      operation.id,
      scopeID: "library", prepare: Self.prepare, apply: Self.apply, progress: { _ in })
    XCTAssertEqual(resumed.summary.applied.count, 1)
    let (preserved, _) = try await XMPSidecarStore(rawURL: url).load()
    XCTAssertEqual(preserved.vibrance, 57)
  }

  func testSharedStemOriginalsCannotShareOneSidecarInABatch() async throws {
    let root = try directory()
    defer { try? FileManager.default.removeItem(at: root) }
    let ledger = BatchAdjustmentTransfer(directory: root.appendingPathComponent("ledger"))
    let request = BatchAdjustmentRequest(
      source: .default, groups: [.tone], relativeWhiteBalance: false, sourceBaseline: nil)
    let targets = ["raw.dng", "raw.jpg"].map { name in
      BatchAdjustmentTarget(id: name, name: name, url: root.appendingPathComponent(name))
    }
    do {
      _ = try await ledger.create(scopeID: "library", request: request, targets: targets)
      XCTFail("Two originals must not overwrite the same sidecar")
    } catch { XCTAssertTrue(error is BatchAdjustmentError) }
  }

  func testWrongLibraryAndUnknownPreparedGroupsAreRejected() async throws {
    let root = try directory()
    defer { try? FileManager.default.removeItem(at: root) }
    let ledger = BatchAdjustmentTransfer(directory: root.appendingPathComponent("ledger"))
    let request = BatchAdjustmentRequest(
      source: .default, groups: [.tone], relativeWhiteBalance: false, sourceBaseline: nil)
    let operation = try await ledger.create(
      scopeID: "one", request: request, targets: targets(in: root, count: 1))
    do {
      _ = try await ledger.run(
        operation.id, scopeID: "two", prepare: Self.prepare, apply: Self.apply, progress: { _ in })
      XCTFail("A transfer cannot write another library")
    } catch { XCTAssertTrue(error is BatchAdjustmentError) }
    let invalid = PreparedAdjustmentTransfer(model: .default, groupIDs: ["future-unknown-group"])
    XCTAssertThrowsError(
      try JSONDecoder().decode(PreparedAdjustmentTransfer.self, from: JSONEncoder().encode(invalid))
    )
  }
}

private actor TransferWriteGate {
  private var arrived = false
  private var releaseContinuation: CheckedContinuation<Void, Never>?
  func arriveAndWait() async {
    arrived = true
    await withCheckedContinuation { releaseContinuation = $0 }
  }
  func waitForArrival() async throws {
    for _ in 0..<500 {
      if arrived { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw CocoaError(.fileReadUnknown)
  }
  func release() {
    releaseContinuation?.resume()
    releaseContinuation = nil
  }
}
