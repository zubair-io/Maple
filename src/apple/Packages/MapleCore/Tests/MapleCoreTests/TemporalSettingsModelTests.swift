// TemporalSettingsModelTests.swift
//
// Load/poll/save sequencing for the Workers page's Temporal section (#5826),
// driven through injected fetch, save and sleep so no network or real time is
// involved: the test decides when each sleep ends and each response lands.

import XCTest

@testable import MapleCloudKit
@testable import MapleCore

private func settings(
  address: String = "127.0.0.1:7233", namespace: String = "default",
  state: TemporalConnectionState = .connected
) -> TemporalSettings {
  TemporalSettings(
    address: address, namespace: namespace, connection: TemporalConnection(state: state))
}

@MainActor
private final class Harness {
  var nextFetch: Result<TemporalSettings, Error> = .success(settings())
  var holdFetches = false
  var nextSave: Result<TemporalSettings, Error> = .success(settings(state: .unknown))
  var holdSave = false

  private(set) var fetchCount = 0
  private(set) var sleeps: [Duration] = []
  private(set) var savedTargets: [TemporalTarget] = []

  private var heldFetches: [CheckedContinuation<TemporalSettings, Error>] = []
  private var heldSave: CheckedContinuation<TemporalSettings, Error>?
  private var pendingSleeps: [Int: CheckedContinuation<Void, Error>] = [:]
  private var cancelledSleeps: Set<Int> = []
  private var nextSleepID = 0

  var pendingSleepCount: Int { pendingSleeps.count }

  func model() -> TemporalSettingsModel {
    TemporalSettingsModel(
      fetch: { try await self.fetch() },
      save: { try await self.save($0) },
      sleep: { try await self.sleep($0) })
  }

  func fetch() async throws -> TemporalSettings {
    fetchCount += 1
    guard holdFetches else { return try nextFetch.get() }
    return try await withCheckedThrowingContinuation { heldFetches.append($0) }
  }

  func releaseFetches(_ result: Result<TemporalSettings, Error>) {
    let held = heldFetches
    heldFetches = []
    for continuation in held { continuation.resume(with: result) }
  }

  func save(_ target: TemporalTarget) async throws -> TemporalSettings {
    savedTargets.append(target)
    guard holdSave else { return try nextSave.get() }
    return try await withCheckedThrowingContinuation { heldSave = $0 }
  }

  func releaseSave(_ result: Result<TemporalSettings, Error>) {
    heldSave?.resume(with: result)
    heldSave = nil
  }

  func sleep(_ duration: Duration) async throws {
    let id = nextSleepID
    nextSleepID += 1
    sleeps.append(duration)
    try await withTaskCancellationHandler {
      try await self.suspendSleep(id)
    } onCancel: {
      Task { @MainActor in self.cancelSleep(id) }
    }
  }

  private func suspendSleep(_ id: Int) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      if cancelledSleeps.contains(id) {
        continuation.resume(throwing: CancellationError())
      } else {
        pendingSleeps[id] = continuation
      }
    }
  }

  func fireSleeps() {
    let pending = pendingSleeps
    pendingSleeps = [:]
    for continuation in pending.values { continuation.resume() }
  }

  private func cancelSleep(_ id: Int) {
    cancelledSleeps.insert(id)
    pendingSleeps.removeValue(forKey: id)?.resume(throwing: CancellationError())
  }
}

@MainActor
private func eventually(
  _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line
) async {
  for _ in 0..<2000 {
    if condition() { return }
    await Task.yield()
  }
  XCTFail("condition never became true", file: file, line: line)
}

@MainActor
private func settle() async {
  for _ in 0..<200 { await Task.yield() }
}

@MainActor
final class TemporalSettingsModelTests: XCTestCase {

  func test_firstLoadFailure_showsRetry_andRetryLoads() async {
    let h = Harness()
    h.nextFetch = .failure(ServerAdminError(statusCode: 500, message: "boom"))
    let model = h.model()
    model.start()
    await eventually { model.loadError == "boom" }
    XCTAssertNil(model.settings)
    await settle()
    XCTAssertEqual(h.pendingSleepCount, 0)

    h.nextFetch = .success(settings(address: "temporal:7233"))
    model.retry()
    await eventually { model.settings != nil }
    XCTAssertNil(model.loadError)
    XCTAssertEqual(model.address, "temporal:7233")
    model.stop()
  }

  func test_laterPollFailure_keepsLastStatusAndKeepsPolling() async {
    let h = Harness()
    let model = h.model()
    model.start()
    await eventually { h.pendingSleepCount == 1 }
    XCTAssertEqual(h.sleeps.last, .seconds(10))

    h.nextFetch = .failure(ServerAdminError(statusCode: 502, message: "bad gateway"))
    let before = h.fetchCount
    h.fireSleeps()
    await eventually { h.fetchCount == before + 1 && h.pendingSleepCount == 1 }
    XCTAssertEqual(model.settings?.connection.state, .connected)
    XCTAssertNil(model.loadError)
    model.stop()
  }

  func test_pollsFastWhileUnreported() async {
    let h = Harness()
    h.nextFetch = .success(settings(state: .unknown))
    let model = h.model()
    model.start()
    await eventually { h.pendingSleepCount == 1 }
    XCTAssertEqual(h.sleeps.last, .seconds(2))
    model.stop()
  }

  func test_exactlyOneLoop_oneReadPerInterval() async {
    let h = Harness()
    let model = h.model()
    model.start()
    model.start()
    model.retry()
    await eventually { model.settings != nil && h.pendingSleepCount == 1 }
    await settle()
    XCTAssertEqual(h.pendingSleepCount, 1)

    for _ in 0..<3 {
      let before = h.fetchCount
      h.fireSleeps()
      await eventually { h.pendingSleepCount == 1 && h.fetchCount > before }
      await settle()
      XCTAssertEqual(h.fetchCount, before + 1)
      XCTAssertEqual(h.pendingSleepCount, 1)
    }

    model.stop()
    await eventually { h.pendingSleepCount == 0 }
  }

  func test_noPollsWhileSaving_andSaveRestartsFastCadence() async {
    let h = Harness()
    let model = h.model()
    model.start()
    await eventually { h.pendingSleepCount == 1 }

    h.holdSave = true
    model.address = "new:7233"
    let saving = Task { await model.save() }
    await eventually { model.saveState == .running }
    await eventually { h.pendingSleepCount == 0 }
    let fetchesBeforeRelease = h.fetchCount
    h.fireSleeps()
    await settle()
    XCTAssertEqual(h.fetchCount, fetchesBeforeRelease)

    h.releaseSave(.success(settings(address: "new:7233", state: .unknown)))
    await saving.value
    XCTAssertEqual(model.saveState, .succeeded)
    XCTAssertEqual(h.savedTargets.map(\.address), ["new:7233"])
    await eventually { h.pendingSleepCount == 1 }
    XCTAssertEqual(h.sleeps.last, .seconds(2))
    model.stop()
  }

  func test_responseIssuedBeforeSaveIsDropped() async {
    let h = Harness()
    let model = h.model()
    model.start()
    await eventually { h.pendingSleepCount == 1 }

    h.holdFetches = true
    let before = h.fetchCount
    h.fireSleeps()
    await eventually { h.fetchCount == before + 1 }

    model.address = "new:7233"
    h.nextSave = .success(settings(address: "new:7233", state: .unknown))
    await model.save()
    XCTAssertEqual(model.settings?.address, "new:7233")

    h.releaseFetches(.success(settings(address: "old:7233", state: .connected)))
    await settle()
    XCTAssertEqual(model.settings?.address, "new:7233")
    XCTAssertEqual(model.settings?.connection.state, .unknown)
    model.stop()
  }

  func test_pollKeepsDraftEdits() async {
    let h = Harness()
    let model = h.model()
    model.start()
    await eventually { h.pendingSleepCount == 1 }
    model.namespace = "edited"
    h.nextFetch = .success(settings(namespace: "server", state: .unreachable))
    h.fireSleeps()
    await eventually { model.settings?.connection.state == .unreachable }
    XCTAssertEqual(model.namespace, "edited")
    model.stop()
  }

  func test_editingClearsSaveOutcome() async {
    let h = Harness()
    let model = h.model()
    model.start()
    await eventually { model.settings != nil }

    h.nextSave = .failure(ServerAdminError(statusCode: 400, message: "must be host:port"))
    model.address = "temporal"
    await model.save()
    XCTAssertEqual(model.saveState, .failed("must be host:port"))
    model.address = "temporal"
    XCTAssertEqual(model.saveState, .failed("must be host:port"))
    model.address = "temporal:7233"
    XCTAssertEqual(model.saveState, .idle)

    h.nextSave = .success(settings(address: "temporal:7233"))
    await model.save()
    XCTAssertEqual(model.saveState, .succeeded)
    model.namespace = "other"
    XCTAssertEqual(model.saveState, .idle)
    model.stop()
  }

  func test_editDuringSave_doesNotReportTheNewerDraftAsSaved() async {
    let h = Harness()
    let model = h.model()
    model.start()
    await eventually { model.settings != nil }

    h.holdSave = true
    model.address = "first:7233"
    let saving = Task { await model.save() }
    await eventually { h.savedTargets.count == 1 }
    model.address = "second:7233"

    h.releaseSave(.success(settings(address: "first:7233", state: .unknown)))
    await saving.value
    XCTAssertEqual(h.savedTargets.map(\.address), ["first:7233"])
    XCTAssertEqual(model.settings?.address, "first:7233")
    XCTAssertEqual(model.address, "second:7233")
    XCTAssertEqual(model.saveState, .idle)
    XCTAssertTrue(model.canSave)
    model.stop()
  }

  func test_blankFieldDisablesSave() async {
    let h = Harness()
    let model = h.model()
    model.start()
    await eventually { model.settings != nil }
    XCTAssertTrue(model.canSave)
    model.address = "  "
    XCTAssertFalse(model.canSave)
    await model.save()
    XCTAssertTrue(h.savedTargets.isEmpty)
    model.stop()
  }

  func test_saveAfterStopDoesNotRestartPolling() async {
    let h = Harness()
    let model = h.model()
    model.start()
    await eventually { h.pendingSleepCount == 1 }
    model.stop()
    await eventually { h.pendingSleepCount == 0 }
    await model.save()
    await settle()
    XCTAssertEqual(h.pendingSleepCount, 0)
  }
}
